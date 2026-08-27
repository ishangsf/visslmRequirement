import {
  Alert,
  Button,
  Empty,
  Select,
  Space,
  Spin,
  Tag,
  Typography
} from 'antd'
import {
  FileExcelOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  ReloadOutlined
} from '@ant-design/icons'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'
import * as XLSX from 'xlsx'
import type { KnowledgeChunk, KnowledgeDocumentDetail } from '../../../shared/types'

const { Text } = Typography

/**
 * The preview endpoint has gained formats over time.  Keeping this small
 * renderer contract local lets the chat UI remain compatible with an older
 * shared declaration while the main process rolls out xlsx/text previews.
 */
export type KnowledgeDocumentPreviewValue = {
  document: KnowledgeDocumentDetail
  contentUrl?: string
  contentBase64?: string
  contentByteSize?: number
  renderFormat?: string
  errorMessage?: string
}

export type KnowledgeDocumentPreviewerProps = {
  preview?: KnowledgeDocumentPreviewValue | null
  fallbackDocument?: KnowledgeDocumentDetail | null
  targetChunkId?: string | null
  loading?: boolean
  error?: string | null
  showHeader?: boolean
}

type PreviewFormat = 'pdf' | 'docx' | 'xlsx' | 'text' | 'unknown'

type PdfPreviewPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number }
  getTextContent?: () => Promise<{ items: Array<{ str?: string }> }>
  render: (options: {
    canvasContext: CanvasRenderingContext2D
    viewport: { width: number; height: number }
  }) => { promise: Promise<void>; cancel?: () => void }
}

type PdfPreviewDocument = {
  numPages: number
  getPage: (pageNumber: number) => Promise<PdfPreviewPage>
  destroy?: () => Promise<void> | void
}

type PdfJsModule = {
  GlobalWorkerOptions: { workerSrc: string }
  getDocument: (options: { data: Uint8Array; isEvalSupported?: boolean }) => {
    promise: Promise<PdfPreviewDocument>
  }
}

const formatLabels: Record<PreviewFormat, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
  text: 'TXT',
  unknown: '索引'
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const genericKnowledgeLocationPattern = /^(?:文档)?正文(?:内容)?$|^(?:分块|chunk)(?:\s*[#：:.-]?\s*\d+)?$/i

const trimSnippet = (value: string, maxLength = 44): string => {
  const normalized = normalizeWhitespace(value)
  if (!normalized) return ''
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized
}

/** Prefer a human-readable source position over an opaque chunk number. */
export const knowledgeReferenceLabelOf = (reference: Pick<KnowledgeChunk, 'pageNumber' | 'sheetName' | 'location' | 'content'>): string => {
  if (typeof reference.pageNumber === 'number' && Number.isFinite(reference.pageNumber) && reference.pageNumber > 0) {
    return `第${reference.pageNumber}页`
  }
  const sheetName = reference.sheetName?.trim()
  if (sheetName) return `工作表「${sheetName}」`
  const location = reference.location?.trim()
  if (location && !genericKnowledgeLocationPattern.test(location)) return location
  const snippet = trimSnippet(reference.content)
  return snippet ? `正文「${snippet}」` : ''
}

const formatOf = (preview: KnowledgeDocumentPreviewValue | null | undefined, document: KnowledgeDocumentDetail | null): PreviewFormat => {
  const explicit = preview?.renderFormat?.trim().toLocaleLowerCase()
  if (explicit === 'pdf') return 'pdf'
  if (explicit === 'docx') return 'docx'
  if (explicit === 'xlsx' || explicit === 'xls') return 'xlsx'
  if (explicit === 'text' || explicit === 'txt') return 'text'

  const extension = document?.extension?.trim().toLocaleLowerCase().replace(/^\./, '')
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return 'docx'
  if (extension === 'xlsx' || extension === 'xls' || extension === 'csv') return 'xlsx'
  if (extension) return 'text'
  return 'unknown'
}

const decodeBase64Bytes = (contentBase64: string): Uint8Array => {
  const binary = window.atob(contentBase64)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const loadPreviewBytes = async (contentBase64?: string, contentUrl?: string): Promise<Uint8Array> => {
  if (contentBase64) return decodeBase64Bytes(contentBase64)
  if (!contentUrl) throw new Error('预览内容地址缺失')
  const response = await fetch(contentUrl)
  if (!response.ok) throw new Error(`预览内容加载失败（HTTP ${response.status}）`)
  return new Uint8Array(await response.arrayBuffer())
}

const decodeTextBytes = (bytes: Uint8Array): string => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.slice(2)).replace(/^\uFEFF/, '')
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.slice(2)).replace(/^\uFEFF/, '')
  }

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
  const replacementCount = (utf8.match(/\uFFFD/g) ?? []).length
  const replacementRatio = replacementCount / Math.max(1, utf8.length)
  if (replacementCount >= 2 && replacementRatio >= 0.01) {
    try {
      const legacy = new TextDecoder('gb18030', { fatal: false }).decode(bytes).replace(/^\uFEFF/, '')
      const legacyReplacementCount = (legacy.match(/\uFFFD/g) ?? []).length
      if (legacyReplacementCount < replacementCount) return legacy
    } catch {
      // Older Chromium builds may not expose the GB18030 decoder. UTF-8 is
      // still the safest deterministic fallback in that environment.
    }
  }
  return utf8
}

const clampPage = (page: number, pageCount: number): number => Math.max(1, Math.min(pageCount || 1, page))

const findPdfPageByText = async (pdf: PdfPreviewDocument, targetChunk?: KnowledgeChunk): Promise<number | undefined> => {
  const targetText = normalizeWhitespace(targetChunk?.content ?? '')
  if (!targetText) return undefined
  const candidates = [...new Set([
    targetText.slice(0, 160),
    targetText.slice(0, 84),
    targetText.slice(0, 44)
  ].map((value) => value.trim()).filter((value) => value.length >= 8))]
  if (!candidates.length) return undefined
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    if (!page.getTextContent) continue
    try {
      const textContent = await page.getTextContent()
      const pageText = normalizeWhitespace(textContent.items.map((item) => item.str ?? '').join(' '))
      if (candidates.some((candidate) => pageText.includes(candidate))) return pageNumber
    } catch {
      // Scanned/image-only pages may not expose a text layer. Continue to the
      // next page and let the normal first-page fallback remain available.
    }
  }
  return undefined
}

function PdfPageCanvas({
  pdf,
  pageNumber,
  active,
  current,
  target,
  viewportWidth,
  fileName,
  onError
}: {
  pdf: PdfPreviewDocument
  pageNumber: number
  active: boolean
  current: boolean
  target: boolean
  viewportWidth: number
  fileName: string
  onError: (error: string) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [rendering, setRendering] = useState(active)
  const [rendered, setRendered] = useState(false)
  const estimatedHeight = Math.max(396, Math.round(Math.max(280, viewportWidth - 32) * 1.414))

  useEffect(() => {
    if (!active) {
      setRendering(false)
      setRendered(false)
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
      return
    }
    let disposed = false
    let renderTask: ReturnType<PdfPreviewPage['render']> | null = null
    const renderPage = async (): Promise<void> => {
      const canvas = canvasRef.current
      if (!canvas) return
      setRendering(true)
      setRendered(false)
      try {
        const page = await pdf.getPage(pageNumber)
        if (disposed) return
        const baseViewport = page.getViewport({ scale: 1 })
        const availableWidth = Math.max(280, viewportWidth - 32)
        const scale = Math.max(0.6, Math.min(1.8, availableWidth / baseViewport.width))
        const renderedViewport = page.getViewport({ scale })
        canvas.width = Math.ceil(renderedViewport.width)
        canvas.height = Math.ceil(renderedViewport.height)
        canvas.style.width = `${Math.ceil(renderedViewport.width)}px`
        canvas.style.height = `${Math.ceil(renderedViewport.height)}px`
        const context = canvas.getContext('2d')
        if (!context) throw new Error('当前环境无法创建 PDF 预览画布')
        renderTask = page.render({ canvasContext: context, viewport: renderedViewport })
        await renderTask.promise
        if (!disposed) {
          setRendered(true)
          setRendering(false)
        }
      } catch (renderError) {
        if (disposed || (renderError instanceof Error && renderError.name === 'RenderingCancelledException')) return
        const message = renderError instanceof Error ? renderError.message : `PDF 第 ${pageNumber} 页渲染失败`
        setRendering(false)
        onError(message)
      }
    }

    void renderPage()
    return () => {
      disposed = true
      renderTask?.cancel?.()
    }
  }, [active, onError, pageNumber, pdf, viewportWidth])

  return (
    <article
      className={`knowledge-document-preview__pdf-page${current ? ' is-current' : ''}${target ? ' is-target' : ''}`}
      data-pdf-page={pageNumber}
      aria-label={`${fileName} 第 ${pageNumber} 页`}
      style={{ minHeight: estimatedHeight }}
    >
      <span className="knowledge-document-preview__pdf-page-label">第 {pageNumber} 页</span>
      <canvas ref={canvasRef} role="img" aria-label={`${fileName} 第 ${pageNumber} 页`} hidden={!rendered} />
      {rendering && <Spin size="small" className="knowledge-document-preview__page-spinner" />}
    </article>
  )
}

function PdfPreview({
  contentBase64,
  contentUrl,
  fileName,
  targetChunk,
  onError
}: {
  contentBase64?: string
  contentUrl?: string
  fileName: string
  targetChunk?: KnowledgeChunk
  onError: (error: string) => void
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pdfRef = useRef<PdfPreviewDocument | null>(null)
  const [pdfDocument, setPdfDocument] = useState<PdfPreviewDocument | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [targetLocated, setTargetLocated] = useState(false)
  const [targetPageNumber, setTargetPageNumber] = useState<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(800)
  const [renderedPages, setRenderedPages] = useState<Set<number>>(() => new Set([1, 2]))

  useEffect(() => {
    let disposed = false
    const loadPdf = async (): Promise<void> => {
      setLoading(true)
      setError('')
      setPdfDocument(null)
      setPageCount(0)
      setCurrentPage(1)
      setTargetLocated(false)
      setTargetPageNumber(null)
      setRenderedPages(new Set([1, 2]))
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as PdfJsModule
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
        const pdf = await pdfjs.getDocument({
          data: await loadPreviewBytes(contentBase64, contentUrl),
          isEvalSupported: false
        }).promise
        if (disposed) {
          await pdf.destroy?.()
          return
        }
        pdfRef.current = pdf
        setPdfDocument(pdf)
        setPageCount(pdf.numPages)
        const requestedPage = targetChunk?.pageNumber
        const hasExplicitPage = typeof requestedPage === 'number' && Number.isFinite(requestedPage) && requestedPage > 0
        const hasUsableExplicitPage = hasExplicitPage && requestedPage <= pdf.numPages
        const locatedPage = hasUsableExplicitPage ? requestedPage : await findPdfPageByText(pdf, targetChunk)
        if (disposed) {
          await pdf.destroy?.()
          return
        }
        if (targetChunk) setTargetLocated(Boolean(locatedPage))
        const initialPage = clampPage(locatedPage ?? 1, pdf.numPages)
        setTargetPageNumber(locatedPage ? initialPage : null)
        setCurrentPage(initialPage)
        setRenderedPages(new Set([1, 2, initialPage].filter((page) => page <= pdf.numPages)))
        setLoading(false)
      } catch (loadError) {
        if (disposed) return
        const message = loadError instanceof Error ? loadError.message : 'PDF 内容加载失败'
        setLoading(false)
        setError(message)
        onError(message)
      }
    }

    void loadPdf()
    return () => {
      disposed = true
      const pdf = pdfRef.current
      pdfRef.current = null
      if (pdf) void pdf.destroy?.()
      setPdfDocument(null)
    }
  }, [contentBase64, contentUrl, onError, targetChunk?.content, targetChunk?.pageNumber])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const updateWidth = (): void => setViewportWidth(Math.max(320, viewport.clientWidth || 800))
    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || loading || !pageCount) return
    const pages = [...viewport.querySelectorAll<HTMLElement>('[data-pdf-page]')]
    const observer = new IntersectionObserver((entries) => {
      setRenderedPages((current) => {
        const next = new Set(current)
        entries.forEach((entry) => {
          const page = Number((entry.target as HTMLElement).dataset.pdfPage)
          if (!Number.isInteger(page) || page <= 0) return
          if (entry.isIntersecting) next.add(page)
          else next.delete(page)
        })
        if (next.size === current.size && [...next].every((page) => current.has(page))) return current
        return next
      })
    }, { root: viewport, rootMargin: '120% 0px', threshold: 0.01 })
    pages.forEach((page) => observer.observe(page))
    return () => observer.disconnect()
  }, [loading, pageCount])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || loading || !pageCount) return
    let frame = 0
    const updateCurrentPage = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const viewportRect = viewport.getBoundingClientRect()
        const viewportCenter = viewportRect.top + viewportRect.height / 2
        let closestPage = 1
        let closestDistance = Number.POSITIVE_INFINITY
        viewport.querySelectorAll<HTMLElement>('[data-pdf-page]').forEach((page) => {
          const rect = page.getBoundingClientRect()
          const pageCenter = rect.top + rect.height / 2
          const distance = Math.abs(pageCenter - viewportCenter)
          if (distance < closestDistance) {
            closestDistance = distance
            closestPage = Number(page.dataset.pdfPage) || 1
          }
        })
        setCurrentPage((current) => current === closestPage ? current : closestPage)
      })
    }
    updateCurrentPage()
    viewport.addEventListener('scroll', updateCurrentPage, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('scroll', updateCurrentPage)
    }
  }, [loading, pageCount])

  useEffect(() => {
    if (!targetPageNumber || !pageCount) return
    const frame = requestAnimationFrame(() => {
      viewportRef.current
        ?.querySelector<HTMLElement>(`[data-pdf-page="${targetPageNumber}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => cancelAnimationFrame(frame)
  }, [pageCount, targetPageNumber])

  const handlePageError = useCallback((message: string): void => {
    setError(message)
    onError(message)
  }, [onError])

  const location = targetChunk ? knowledgeReferenceLabelOf(targetChunk) : ''
  const pages = useMemo(() => Array.from({ length: pageCount }, (_value, index) => index + 1), [pageCount])
  return (
    <section className="knowledge-document-preview__format" aria-label={`预览 PDF：${fileName}`}>
      <div className="knowledge-document-preview__format-toolbar">
        <div className="knowledge-document-preview__format-label">
          <FilePdfOutlined aria-hidden="true" />
          <Tag color="purple">PDF</Tag>
          <Text type="secondary" aria-live="polite">
            {loading ? '正在读取文件…' : pageCount ? `第 ${currentPage} / ${pageCount} 页` : '等待渲染'}
          </Text>
        </div>
        <Text className="knowledge-document-preview__continuous-hint" type="secondary">向下滚动连续阅读</Text>
      </div>
      {location && (
        <div className="knowledge-document-preview__target" role="status" aria-live="polite">
          {targetLocated ? `已定位到 ${location}` : `定位提示：${location}，未找到对应页面`}
        </div>
      )}
      {error && <Alert type="error" showIcon title="PDF 预览失败" description={error} />}
      <div ref={viewportRef} className="knowledge-document-preview__viewport knowledge-document-preview__pdf-viewport">
        {loading && (
          <div className="knowledge-document-preview__state">
            <Spin size="small" />
            <Text type="secondary">正在加载 PDF…</Text>
          </div>
        )}
        {!loading && !error && pdfDocument && (
          <div className="knowledge-document-preview__pdf-page-list">
            {pages.map((pageNumber) => (
              <PdfPageCanvas
                key={pageNumber}
                pdf={pdfDocument}
                pageNumber={pageNumber}
                active={renderedPages.has(pageNumber)}
                current={currentPage === pageNumber}
                target={targetPageNumber === pageNumber}
                viewportWidth={viewportWidth}
                fileName={fileName}
                onError={handlePageError}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

const sanitizeRenderedDocx = (renderer: HTMLElement): void => {
  renderer.querySelectorAll('script, iframe, object, embed, form').forEach((element) => element.remove())
  renderer.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLocaleLowerCase().startsWith('on')) element.removeAttribute(attribute.name)
    }
  })
  renderer.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href')?.trim() ?? ''
    if (!/^(https?:|mailto:|#)/i.test(href)) anchor.removeAttribute('href')
    anchor.target = '_blank'
    anchor.rel = 'noopener noreferrer'
  })
}

const highlightDocxChunk = (renderer: HTMLElement, targetChunk?: KnowledgeChunk): boolean => {
  const rawTarget = targetChunk?.content?.trim()
  if (!rawTarget) return false
  const candidates = [...new Set([
    rawTarget,
    rawTarget.slice(0, 160),
    rawTarget.split(/\s+/).slice(0, 16).join(' ')
  ].map((value) => value.trim()).filter(Boolean))]
  // docx-preview commonly splits a paragraph into several runs.  Resolve the
  // target against a block's complete text first, then highlight the first
  // matching run (or the first run as a visual fallback) and scroll that block
  // into view.  This is more reliable than requiring the whole chunk in one
  // text node.
  const blocks = Array.from(renderer.querySelectorAll<HTMLElement>('p, td, th, li, h1, h2, h3, h4, h5, h6'))
  for (const block of blocks) {
    const blockText = normalizeWhitespace(block.textContent ?? '')
    const candidate = candidates.find((value) => blockText.includes(normalizeWhitespace(value)))
    if (!candidate) continue
    block.classList.add('knowledge-document-preview__block-target')
    const normalizedCandidate = normalizeWhitespace(candidate)
    const firstToken = normalizedCandidate.split(' ')[0] || normalizedCandidate.slice(0, 24)
    const walker = window.document.createTreeWalker(block, window.NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let current = walker.nextNode()
    while (current) {
      if (current.nodeValue?.trim()) textNodes.push(current as Text)
      current = walker.nextNode()
    }
    let highlighted = false
    for (const textNode of textNodes) {
      const textValue = textNode.nodeValue ?? ''
      const start = textValue.indexOf(candidate)
      const tokenStart = start >= 0 ? start : firstToken ? textValue.indexOf(firstToken) : -1
      if (tokenStart < 0) continue
      const length = start >= 0 ? candidate.length : Math.max(firstToken.length, Math.min(textValue.length - tokenStart, 48))
      const mark = window.document.createElement('mark')
      mark.className = 'knowledge-document-preview__highlight'
      const range = window.document.createRange()
      range.setStart(textNode, tokenStart)
      range.setEnd(textNode, tokenStart + length)
      try {
        range.surroundContents(mark)
      } catch {
        continue
      }
      highlighted = true
      mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
      break
    }
    if (!highlighted) block.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  }

  // Some source documents have no paragraph tags after conversion.  Keep the
  // previous exact text-node search as a final compatibility path.
  const walker = window.document.createTreeWalker(renderer, window.NodeFilter.SHOW_TEXT)
  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    const textValue = textNode.nodeValue ?? ''
    const candidate = candidates.find((value) => textValue.includes(value))
    if (candidate) {
      const start = textValue.indexOf(candidate)
      const mark = window.document.createElement('mark')
      mark.className = 'knowledge-document-preview__highlight'
      const range = window.document.createRange()
      range.setStart(textNode, start)
      range.setEnd(textNode, start + candidate.length)
      try {
        range.surroundContents(mark)
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
        return true
      } catch {
        return false
      }
    }
    current = walker.nextNode()
  }
  return false
}

function DocxPreview({
  contentBase64,
  contentUrl,
  fileName,
  targetChunk,
  onError
}: {
  contentBase64?: string
  contentUrl?: string
  fileName: string
  targetChunk?: KnowledgeChunk
  onError: (error: string) => void
}): React.JSX.Element {
  const rendererRef = useRef<HTMLDivElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [targetFound, setTargetFound] = useState(false)
  const [renderKey, setRenderKey] = useState(0)

  useEffect(() => {
    let disposed = false
    const renderDocx = async (): Promise<void> => {
      const renderer = rendererRef.current
      if (!renderer) return
      renderer.replaceChildren()
      setLoading(true)
      setError('')
      setTargetFound(false)
      try {
        const { renderAsync } = await import('docx-preview')
        await renderAsync(await loadPreviewBytes(contentBase64, contentUrl), renderer, renderer, {
          className: 'visslm-docx',
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderChanges: false,
          renderComments: false,
          renderAltChunks: false,
          debug: false
        })
        if (disposed) return
        sanitizeRenderedDocx(renderer)
        setTargetFound(highlightDocxChunk(renderer, targetChunk))
        setLoading(false)
      } catch (renderError) {
        if (disposed) return
        renderer.replaceChildren()
        const message = renderError instanceof Error ? renderError.message : 'DOCX 内容渲染失败'
        setLoading(false)
        setError(message)
        onError(message)
      }
    }

    void renderDocx()
    return () => {
      disposed = true
      rendererRef.current?.replaceChildren()
    }
  }, [contentBase64, contentUrl, onError, renderKey, targetChunk?.content])

  const location = targetChunk ? knowledgeReferenceLabelOf(targetChunk) : ''
  return (
    <section className="knowledge-document-preview__format" aria-label={`预览 DOCX：${fileName}`}>
      <div className="knowledge-document-preview__format-toolbar">
        <div className="knowledge-document-preview__format-label">
          <FileTextOutlined aria-hidden="true" />
          <Tag color="purple">DOCX</Tag>
          <Text type="secondary" aria-live="polite">
            {loading ? '正在读取源文件…' : targetChunk && !targetFound ? '已打开源文件，未找到对应片段' : '已按源文件样式渲染'}
          </Text>
        </div>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined aria-hidden="true" />}
          aria-label="重新渲染 DOCX"
          title="重新渲染 DOCX"
          disabled={loading}
          onClick={() => setRenderKey((current) => current + 1)}
        />
      </div>
      {location && (
        <div className="knowledge-document-preview__target" role="status" aria-live="polite">
          {targetFound ? `已定位到 ${location}` : `定位提示：${location}`}
        </div>
      )}
      {error && <Alert type="error" showIcon title="DOCX 预览失败" description={error} />}
      <div ref={rendererRef} className="knowledge-document-preview__viewport knowledge-document-preview__docx-viewport" />
    </section>
  )
}

type SpreadsheetRow = unknown[]

const spreadsheetCellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toLocaleString()
  return String(value)
}

const spreadsheetRowText = (row: SpreadsheetRow): string => normalizeWhitespace(row.map(spreadsheetCellText).join(' '))

const spreadsheetTargetRowOf = (rows: SpreadsheetRow[], targetChunk?: KnowledgeChunk): number => {
  const targetText = normalizeWhitespace(targetChunk?.content ?? '')
  if (!targetText) return -1
  const rowHint = targetText.match(/第\s*(\d+)\s*行/)
  if (rowHint) {
    const hintedIndex = Number(rowHint[1]) - 1
    if (Number.isInteger(hintedIndex) && hintedIndex >= 0 && hintedIndex < rows.length) return hintedIndex
  }
  const strippedTargetText = normalizeWhitespace(
    targetText
      .replace(/第\s*\d+\s*行\s*[:：]?/g, '')
      .replace(/(?:[A-Za-zＡ-Ｚ\u4e00-\u9fff]+\s*列)\s*[:：=]\s*/g, '')
      .replace(/\b[A-Z]+\s*[:：=]\s*/gi, '')
  )
  const candidates = [...new Set([
    targetText,
    strippedTargetText,
    targetText.slice(0, 120),
    strippedTargetText.slice(0, 120),
    targetText.slice(0, 56),
    strippedTargetText.slice(0, 56)
  ].map((value) => value.trim()).filter(Boolean))]
  return rows.findIndex((row) => {
    const rowText = spreadsheetRowText(row)
    return candidates.some((candidate) => rowText.includes(candidate))
  })
}

function XlsxPreview({
  contentBase64,
  contentUrl,
  fileName,
  targetChunk,
  onError
}: {
  contentBase64?: string
  contentUrl?: string
  fileName: string
  targetChunk?: KnowledgeChunk
  onError: (error: string) => void
}): React.JSX.Element {
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null)
  const [sheetNames, setSheetNames] = useState<string[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [rows, setRows] = useState<SpreadsheetRow[]>([])
  const [targetRow, setTargetRow] = useState(-1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>())

  useEffect(() => {
    let disposed = false
    const loadWorkbook = async (): Promise<void> => {
      setLoading(true)
      setError('')
      setWorkbook(null)
      setSheetNames([])
      setSelectedSheet('')
      setRows([])
      setTargetRow(-1)
      try {
        const bytes = await loadPreviewBytes(contentBase64, contentUrl)
        const nextWorkbook = XLSX.read(bytes, { type: 'array', cellDates: true })
        if (disposed) return
        const names = nextWorkbook.SheetNames ?? []
        setWorkbook(nextWorkbook)
        setSheetNames(names)
        setSelectedSheet(targetChunk?.sheetName && names.includes(targetChunk.sheetName) ? targetChunk.sheetName : names[0] ?? '')
        setLoading(false)
      } catch (loadError) {
        if (disposed) return
        const message = loadError instanceof Error ? loadError.message : 'XLSX 内容加载失败'
        setLoading(false)
        setError(message)
        onError(message)
      }
    }

    void loadWorkbook()
    return () => {
      disposed = true
    }
  }, [contentBase64, contentUrl, onError, targetChunk?.sheetName])

  useEffect(() => {
    if (!workbook || !selectedSheet) {
      setRows([])
      setTargetRow(-1)
      return
    }
    const sheet = workbook.Sheets[selectedSheet]
    if (!sheet) {
      setRows([])
      setTargetRow(-1)
      return
    }
    const nextRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: ''
    }) as SpreadsheetRow[]
    setRows(nextRows)
    setTargetRow(spreadsheetTargetRowOf(nextRows, targetChunk))
  }, [selectedSheet, targetChunk?.content, workbook])

  useEffect(() => {
    if (targetRow < 0) return
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(targetRow)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [targetRow])

  const displayedRowIndices = useMemo(() => {
    const dataRowCount = Math.max(0, rows.length - 1)
    if (dataRowCount <= 500) return Array.from({ length: dataRowCount }, (_, index) => index + 1)
    const targetDataIndex = targetRow > 0 ? targetRow : 1
    const windowSize = 500
    const start = Math.max(1, Math.min(targetDataIndex - Math.floor(windowSize / 2), rows.length - windowSize))
    return Array.from({ length: windowSize }, (_, index) => start + index)
  }, [rows.length, targetRow])

  const hasPartialRows = displayedRowIndices.length < Math.max(0, rows.length - 1)
  const location = targetChunk ? knowledgeReferenceLabelOf(targetChunk) : ''
  return (
    <section className="knowledge-document-preview__format" aria-label={`预览表格：${fileName}`}>
      <div className="knowledge-document-preview__format-toolbar">
        <div className="knowledge-document-preview__format-label">
          <FileExcelOutlined aria-hidden="true" />
          <Tag color="purple">XLSX</Tag>
          <Text type="secondary" aria-live="polite">
            {loading ? '正在读取表格…' : rows.length ? `${rows.length} 行` : '当前工作表为空'}
          </Text>
        </div>
        {sheetNames.length > 1 && (
          <Select
            size="small"
            value={selectedSheet || undefined}
            options={sheetNames.map((name) => ({ value: name, label: `工作表「${name}」` }))}
            aria-label="选择工作表"
            onChange={setSelectedSheet}
          />
        )}
      </div>
        {location && (
          <div className="knowledge-document-preview__target" role="status" aria-live="polite">
            {targetRow >= 0 ? `已定位到 ${location}` : `定位提示：${location}，当前表格未找到对应行`}
          </div>
        )}
      {hasPartialRows && (
        <Text className="knowledge-document-preview__partial-note" type="secondary">
          当前工作表共 {rows.length} 行，仅预览约 500 行{targetRow > 500 ? '（已包含引用目标附近行）' : ''}
        </Text>
      )}
      {error && <Alert type="error" showIcon title="XLSX 预览失败" description={error} />}
      <div className="knowledge-document-preview__viewport knowledge-document-preview__sheet-viewport">
        {loading && (
          <div className="knowledge-document-preview__state">
            <Spin size="small" />
            <Text type="secondary">正在读取表格…</Text>
          </div>
        )}
        {!loading && !error && rows.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前工作表没有可展示的行" />}
        {!loading && !error && rows.length > 0 && (
          <table className="knowledge-document-preview__sheet-table">
            {rows[0] && (
              <thead>
                <tr
                  className={targetRow === 0 ? 'is-target' : undefined}
                  ref={(element) => {
                    if (element) rowRefs.current.set(0, element)
                    else rowRefs.current.delete(0)
                  }}
                >
                  <th className="knowledge-document-preview__sheet-row-number" scope="col">行号</th>
                  {rows[0].map((cell, index) => <th key={`header-${index}`}>{spreadsheetCellText(cell) || '—'}</th>)}
                </tr>
              </thead>
            )}
            <tbody>
              {displayedRowIndices.map((rowIndex) => {
                const row = rows[rowIndex] ?? []
                return (
                  <tr
                    className={targetRow === rowIndex ? 'is-target' : undefined}
                    key={`row-${rowIndex}`}
                    ref={(element) => {
                      if (element) rowRefs.current.set(rowIndex, element)
                      else rowRefs.current.delete(rowIndex)
                    }}
                    aria-current={targetRow === rowIndex ? 'true' : undefined}
                  >
                    <td className="knowledge-document-preview__sheet-row-number">{rowIndex + 1}</td>
                    {row.map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{spreadsheetCellText(cell) || '—'}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

const textRangeOf = (value: string, targetChunk?: KnowledgeChunk): { start: number; end: number } | null => {
  const targetText = targetChunk?.content?.trim()
  if (!targetText || !value) return null
  const charStart = targetChunk?.charStart
  const charEnd = targetChunk?.charEnd
  if (
    typeof charStart === 'number' && Number.isFinite(charStart) && charStart >= 0 &&
    typeof charEnd === 'number' && Number.isFinite(charEnd) && charEnd > charStart && charEnd <= value.length
  ) {
    const candidate = value.slice(charStart, charEnd)
    if (normalizeWhitespace(candidate).includes(normalizeWhitespace(targetText).slice(0, 80))) {
      return { start: charStart, end: charEnd }
    }
  }
  const start = value.indexOf(targetText)
  if (start >= 0) return { start, end: start + targetText.length }
  const compactTarget = normalizeWhitespace(targetText)
  const firstPart = compactTarget.slice(0, 100)
  if (firstPart) {
    const compactCharacters: string[] = []
    const sourceOffsets: number[] = []
    let pendingSpace = false
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index]
      if (/\s/.test(character)) {
        pendingSpace = compactCharacters.length > 0
        continue
      }
      if (pendingSpace && compactCharacters[compactCharacters.length - 1] !== ' ') {
        compactCharacters.push(' ')
        sourceOffsets.push(index)
      }
      compactCharacters.push(character)
      sourceOffsets.push(index)
      pendingSpace = false
    }
    const compactValue = compactCharacters.join(' ')
    const compactStart = compactValue.indexOf(firstPart)
    if (compactStart >= 0) {
      const compactEnd = Math.min(sourceOffsets.length, compactStart + firstPart.length)
      const startOffset = sourceOffsets[compactStart]
      const endOffset = sourceOffsets[Math.max(compactStart, compactEnd - 1)]
      if (typeof startOffset === 'number' && typeof endOffset === 'number') {
        return { start: startOffset, end: endOffset + 1 }
      }
    }
  }
  return null
}

function TextPreview({
  contentBase64,
  contentUrl,
  fileName,
  targetChunk,
  onError
}: {
  contentBase64?: string
  contentUrl?: string
  fileName: string
  targetChunk?: KnowledgeChunk
  onError: (error: string) => void
}): React.JSX.Element {
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const markRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let disposed = false
    const loadText = async (): Promise<void> => {
      setLoading(true)
      setError('')
      setContent('')
      try {
        const bytes = await loadPreviewBytes(contentBase64, contentUrl)
        const decoded = decodeTextBytes(bytes)
        if (disposed) return
        setContent(decoded)
        setLoading(false)
      } catch (loadError) {
        if (disposed) return
        const message = loadError instanceof Error ? loadError.message : '文本内容加载失败'
        setLoading(false)
        setError(message)
        onError(message)
      }
    }

    void loadText()
    return () => {
      disposed = true
    }
  }, [contentBase64, contentUrl, onError])

  const range = useMemo(() => textRangeOf(content, targetChunk), [content, targetChunk?.charEnd, targetChunk?.charStart, targetChunk?.content])
  useEffect(() => {
    if (!range || !markRef.current) return
    const frame = requestAnimationFrame(() => markRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [range])

  const location = targetChunk ? knowledgeReferenceLabelOf(targetChunk) : ''
  return (
    <section className="knowledge-document-preview__format" aria-label={`预览文本：${fileName}`}>
      <div className="knowledge-document-preview__format-toolbar">
        <div className="knowledge-document-preview__format-label">
          <FileTextOutlined aria-hidden="true" />
          <Tag color="purple">TXT</Tag>
          <Text type="secondary" aria-live="polite">{loading ? '正在读取文本…' : `${content.length} 个字符`}</Text>
        </div>
      </div>
      {location && (
        <div className="knowledge-document-preview__target" role="status" aria-live="polite">
          {range ? `已定位到 ${location}` : `定位提示：${location}，原文中未找到对应片段`}
        </div>
      )}
      {error && <Alert type="error" showIcon title="文本预览失败" description={error} />}
      <div className="knowledge-document-preview__viewport knowledge-document-preview__text-viewport">
        {loading && (
          <div className="knowledge-document-preview__state">
            <Spin size="small" />
            <Text type="secondary">正在读取文本…</Text>
          </div>
        )}
        {!loading && !error && (
          range ? (
            <pre className="knowledge-document-preview__text-content">
              <span>{content.slice(0, range.start)}</span>
              <mark ref={markRef} className="knowledge-document-preview__highlight">{content.slice(range.start, range.end)}</mark>
              <span>{content.slice(range.end)}</span>
            </pre>
          ) : (
            <pre className="knowledge-document-preview__text-content">{content || '当前文本没有可展示内容'}</pre>
          )
        )}
      </div>
    </section>
  )
}

const fallbackChunksOf = (document: KnowledgeDocumentDetail | null, targetChunkId?: string | null): KnowledgeChunk[] => {
  if (!document) return []
  const firstChunks = document.chunks.slice(0, 20)
  const target = targetChunkId ? document.chunks.find((chunk) => chunk.id === targetChunkId) : undefined
  if (target && !firstChunks.some((chunk) => chunk.id === target.id)) return [target, ...firstChunks]
  return firstChunks
}

function IndexFallback({ document, targetChunkId, reason }: { document: KnowledgeDocumentDetail | null; targetChunkId?: string | null; reason: string }): React.JSX.Element {
  const chunks = fallbackChunksOf(document, targetChunkId)
  const targetFound = Boolean(targetChunkId && chunks.some((chunk) => chunk.id === targetChunkId))
  return (
    <section className="knowledge-document-preview__fallback" aria-label="知识库索引回退内容">
      <div className="knowledge-document-preview__fallback-heading">
        <FileTextOutlined aria-hidden="true" />
        <div>
          <Text strong>原始文件暂不可预览</Text>
          <Text type="secondary">已保留知识库索引内容，便于继续核对依据</Text>
        </div>
      </div>
      <Alert type="warning" showIcon title="无法打开原始文档" description={reason} />
      {!targetFound && targetChunkId && (
        <Text className="knowledge-document-preview__fallback-technical" type="secondary">
          引用位置暂未匹配，已展示可用的索引正文
        </Text>
      )}
      {chunks.length ? (
        <div className="knowledge-document-preview__fallback-list">
          {chunks.map((chunk) => {
            const isTarget = chunk.id === targetChunkId
            const label = knowledgeReferenceLabelOf(chunk) || '正文位置'
            return (
              <article className={`knowledge-document-preview__fallback-item${isTarget ? ' is-target' : ''}`} key={chunk.id}>
                <div className="knowledge-document-preview__fallback-meta">
                  <Tag>{label}</Tag>
                  {isTarget && <Tag color="processing">引用目标</Tag>}
                </div>
                <p>{chunk.content || '当前正文片段没有文本内容'}</p>
              </article>
            )
          })}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前文档没有可用索引内容" />
      )}
    </section>
  )
}

export function KnowledgeDocumentPreviewer({
  preview = null,
  fallbackDocument = null,
  targetChunkId = null,
  loading = false,
  error = null,
  showHeader = true
}: KnowledgeDocumentPreviewerProps): React.JSX.Element {
  const document = preview?.document ?? fallbackDocument
  const targetChunk = useMemo(
    () => document && targetChunkId ? document.chunks.find((chunk) => chunk.id === targetChunkId) : undefined,
    [document, targetChunkId]
  )
  const format = formatOf(preview, document)
  const hasContent = Boolean(preview?.contentUrl || preview?.contentBase64)
  const [rendererError, setRendererError] = useState('')
  const fileName = document?.fileName || '知识库文档'
  const displayError = error || preview?.errorMessage || rendererError

  useEffect(() => {
    setRendererError('')
  }, [preview?.contentBase64, preview?.contentUrl, preview?.renderFormat, targetChunkId])

  const onRendererError = useCallback((nextError: string): void => {
    setRendererError(nextError)
  }, [])

  return (
    <div className="knowledge-document-preview">
      {showHeader && (
        <div className="knowledge-document-preview__header">
          <div className="knowledge-document-preview__header-title">
            <FileTextOutlined aria-hidden="true" />
            <div>
              <Text strong title={fileName}>{fileName}</Text>
              <Text type="secondary">原始文件预览</Text>
            </div>
          </div>
          <Tag color="purple">{formatLabels[format]}</Tag>
        </div>
      )}

      {loading && (
        <div className="knowledge-document-preview__loading" role="status" aria-live="polite">
          <Spin size="small" />
          <Text type="secondary">正在加载原始文档…</Text>
        </div>
      )}

      {!loading && displayError && !rendererError && (
        <Alert type="warning" showIcon title="原始文档预览暂不可用" description={displayError} />
      )}

      {!loading && (!preview || !hasContent || format === 'unknown' || rendererError) && (
        <IndexFallback
          document={document}
          targetChunkId={targetChunkId}
          reason={displayError || '预览内容地址缺失，当前仅能查看索引正文'}
        />
      )}

      {!loading && !displayError && preview && hasContent && format === 'pdf' && (
        <PdfPreview
          contentBase64={preview.contentBase64}
          contentUrl={preview.contentUrl}
          fileName={fileName}
          targetChunk={targetChunk}
          onError={onRendererError}
        />
      )}
      {!loading && !displayError && preview && hasContent && format === 'docx' && (
        <DocxPreview
          contentBase64={preview.contentBase64}
          contentUrl={preview.contentUrl}
          fileName={fileName}
          targetChunk={targetChunk}
          onError={onRendererError}
        />
      )}
      {!loading && !displayError && preview && hasContent && format === 'xlsx' && (
        <XlsxPreview
          contentBase64={preview.contentBase64}
          contentUrl={preview.contentUrl}
          fileName={fileName}
          targetChunk={targetChunk}
          onError={onRendererError}
        />
      )}
      {!loading && !displayError && preview && hasContent && format === 'text' && (
        <TextPreview
          contentBase64={preview.contentBase64}
          contentUrl={preview.contentUrl}
          fileName={fileName}
          targetChunk={targetChunk}
          onError={onRendererError}
        />
      )}
    </div>
  )
}
