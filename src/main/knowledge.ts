import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import iconv from 'iconv-lite'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import type {
  ChatSource,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeIndexProgress,
  KnowledgeRebuildResult,
  KnowledgeUploadResult,
  RecordDetail
} from '../shared/types'
import { AppDatabase, type KnowledgeChunkInput, type KnowledgeVectorInput } from './database'

export const MAX_KNOWLEDGE_FILE_BYTES = 100 * 1024 * 1024
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-zh-v1.5'
export const EMBEDDING_MODEL_VERSION = 'bge-small-zh-v1.5-local-v1'
const FALLBACK_MODEL_VERSION = 'local-hash-v1'
const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 20
const EMBEDDING_DIMENSION = 384
const OCR_RENDER_SCALE = 2.5
const OCR_PAGE_SEGMENTATION_MODE = '3'
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.txt'])

export interface KnowledgeSearchHit {
  source: ChatSource
  chunk: KnowledgeChunk
  score: number
}

export interface KnowledgeRecordMatch {
  recordUid: string
  recordName: string
  nodeType: string
  itemId: string
  score: number
  chunkId: string
  snippet: string
}

interface ParsedPage {
  text: string
  pageNumber?: number
  sheetName?: string
  location: string
}

interface ParsedDocument {
  pages: ParsedPage[]
  pageCount: number
}

interface TransformerRuntime {
  env: {
    allowRemoteModels?: boolean
    allowLocalModels?: boolean
    localModelPath?: string
    cacheDir?: string
  }
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
}

const extensionFor = (filePath: string): string => extname(filePath).toLocaleLowerCase()

const mimeFor = (extension: string): string => ({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain'
}[extension] ?? 'application/octet-stream')

const fileHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const validateDocumentSignature = (bytes: Buffer, extension: string): void => {
  const startsWith = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('文件内容不是有效的 PDF')
  }
  if ((extension === '.docx' || extension === '.xlsx') && !startsWith(0x50, 0x4b)) {
    throw new Error(`文件内容不是有效的 ${extension.slice(1).toUpperCase()} 压缩文档`)
  }
  if (extension === '.xls' && !startsWith(0xd0, 0xcf, 0x11, 0xe0)) {
    throw new Error('文件内容不是有效的 XLS 文档')
  }
  if (extension === '.txt') {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
    const nullCount = [...sample].filter((value) => value === 0).length
    if (sample.length && nullCount > sample.length / 10) throw new Error('文本文件包含过多二进制内容')
  }
}

const cleanText = (value: string): string => value
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const decodeText = (bytes: Buffer): string => {
  if (bytes.length === 0) return ''
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return cleanText(bytes.subarray(3).toString('utf8'))
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return cleanText(new TextDecoder('utf-16le').decode(bytes.subarray(2)))
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return cleanText(new TextDecoder('utf-16be').decode(bytes.subarray(2)))
  }
  const utf8 = bytes.toString('utf8')
  const replacementCount = (utf8.match(/\ufffd/g) ?? []).length
  if (replacementCount > 2 && replacementCount > utf8.length / 80) {
    return cleanText(iconv.decode(bytes, 'gb18030'))
  }
  return cleanText(utf8)
}

const pageText = (text: string, pageNumber?: number, sheetName?: string): ParsedPage[] => {
  const pieces = text.split('\f').map(cleanText).filter(Boolean)
  if (!pieces.length) return []
  return pieces.map((piece, index) => ({
    text: piece,
    ...(pageNumber === undefined ? {} : { pageNumber: pageNumber + index }),
    ...(sheetName ? { sheetName } : {}),
    location: sheetName
      ? `工作表: ${sheetName}`
      : pageNumber === undefined
        ? '文档正文'
        : `第 ${pageNumber + index} 页`
  }))
}

export const chunkKnowledgePages = (
  pages: ParsedPage[],
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): Array<ParsedPage & { chunkIndex: number; charStart: number; charEnd: number }> => {
  const chunks: Array<ParsedPage & { chunkIndex: number; charStart: number; charEnd: number }> = []
  const safeSize = Math.max(100, Math.floor(chunkSize))
  const safeOverlap = Math.min(Math.floor(overlap), safeSize - 1)
  let chunkIndex = 0
  for (const page of pages) {
    const text = cleanText(page.text)
    if (!text) continue
    if (text.length <= safeSize) {
      chunks.push({ ...page, text, chunkIndex, charStart: 0, charEnd: text.length })
      chunkIndex += 1
      continue
    }
    let offset = 0
    while (offset < text.length) {
      const end = Math.min(text.length, offset + safeSize)
      const content = cleanText(text.slice(offset, end))
      if (content) {
        const contentStart = text.indexOf(content, offset)
        chunks.push({
          ...page,
          text: content,
          chunkIndex,
          charStart: contentStart >= 0 ? contentStart : offset,
          charEnd: Math.min(text.length, (contentStart >= 0 ? contentStart : offset) + content.length)
        })
        chunkIndex += 1
      }
      if (end >= text.length) break
      offset = Math.max(offset + 1, end - safeOverlap)
    }
  }
  return chunks
}

const locateResource = (...parts: string[]): string | null => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.VISSLM_RESOURCE_ROOT,
    process.resourcesPath,
    join(process.cwd(), 'buildResources'),
    join(moduleDir, '..', '..', 'buildResources')
  ].filter((value): value is string => Boolean(value))
  for (const root of candidates) {
    const path = join(root, ...parts)
    if (existsSync(path)) return path
  }
  return null
}

const modelRoot = (): string | null => {
  const explicit = process.env.VISSLM_EMBEDDING_MODEL_PATH
  const candidates = [
    ...(explicit ? [explicit] : []),
    locateResource('models')
  ].filter((value): value is string => Boolean(value))
  const modelParts = EMBEDDING_MODEL_ID.split('/')
  return candidates.find((candidate) =>
    existsSync(join(candidate, 'config.json')) ||
    existsSync(join(candidate, ...modelParts, 'config.json'))
  ) ?? null
}

class DocumentParser {
  async parse(filePath: string): Promise<ParsedDocument> {
    const extension = extensionFor(filePath)
    const bytes = readFileSync(filePath)
    if (!bytes.length) throw new Error('文件内容为空，无法建立知识索引')
    if (extension === '.txt') return this.parseText(bytes)
    if (extension === '.docx') return this.parseDocx(bytes)
    if (extension === '.xlsx' || extension === '.xls') return this.parseSpreadsheet(bytes)
    if (extension === '.pdf') return this.parsePdf(bytes)
    throw new Error(`不支持的文件格式: ${extension || '无扩展名'}`)
  }

  private parseText(bytes: Buffer): ParsedDocument {
    const text = decodeText(bytes)
    if (!text) throw new Error('文本文件为空，无法建立知识索引')
    const pages = pageText(text)
    return { pages, pageCount: pages.length || 1 }
  }

  private async parseDocx(bytes: Buffer): Promise<ParsedDocument> {
    const result = await mammoth.extractRawText({ buffer: bytes })
    const text = cleanText(result.value)
    if (!text) throw new Error('Word 文档未解析出正文内容')
    const pages = pageText(text)
    return { pages, pageCount: pages.length || 1 }
  }

  private parseSpreadsheet(bytes: Buffer): ParsedDocument {
    const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true })
    const pages: ParsedPage[] = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: ''
      })
      const text = rows
        .map((row, rowIndex) => {
          const cells = Array.isArray(row) ? row : []
          return `第 ${rowIndex + 1} 行: ${cells.map((cell, columnIndex) =>
            `${String.fromCharCode(65 + Math.min(columnIndex, 25))}列=${String(cell ?? '').trim()}`
          ).filter((cell) => !cell.endsWith('=')).join(' | ')}`
        })
        .filter((row) => !row.endsWith(': '))
        .join('\n')
      if (cleanText(text)) {
        pages.push({
          text: cleanText(text),
          sheetName,
          location: `工作表: ${sheetName}`
        })
      }
    }
    if (!pages.length) throw new Error('Excel 文件没有可解析的工作表内容')
    return { pages, pageCount: pages.length }
  }

  private async parsePdf(bytes: Buffer): Promise<ParsedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      getDocument: (options: Record<string, unknown>) => { promise: Promise<any> }
    }
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false
    }).promise
    const pagesByNumber = new Map<number, ParsedPage>()
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = cleanText((content.items as Array<{ str?: string }>)
        .map((item) => item.str ?? '')
        .join(' '))
      if (text) pagesByNumber.set(pageNumber, { text, pageNumber, location: `第 ${pageNumber} 页` })
    }
    const missingPageNumbers = Array.from({ length: pdf.numPages }, (_value, index) => index + 1)
      .filter((pageNumber) => !pagesByNumber.has(pageNumber))
    if (missingPageNumbers.length) {
      const ocrPages = await this.ocrPdf(pdf, missingPageNumbers)
      ocrPages.forEach((page) => pagesByNumber.set(page.pageNumber!, page))
    }
    const pages = [...pagesByNumber.values()].sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0))
    if (!pages.length) throw new Error('扫描 PDF OCR 未识别出正文内容')
    return { pages, pageCount: pdf.numPages }
  }

  private async ocrPdf(pdf: any, pageNumbers: number[]): Promise<ParsedPage[]> {
    const canvasModule = await import('@napi-rs/canvas') as unknown as {
      createCanvas: (width: number, height: number) => {
        getContext: (type: '2d') => unknown
        toBuffer: (mime: string) => Buffer
      }
    }
    const tesseract = await import('tesseract.js') as unknown as {
      createWorker: (...args: unknown[]) => Promise<any>
    }
    const tessdata = locateResource('ocr', 'tessdata')
    if (!tessdata) throw new Error('扫描 PDF 未找到 OCR 语言资源，请重新安装完整资源包')
    const worker = await tesseract.createWorker(['chi_sim', 'eng'], 1, {
      langPath: tessdata,
      cachePath: this.ocrCachePath(),
      gzip: true
    })
    await worker.setParameters({
      tessedit_pageseg_mode: OCR_PAGE_SEGMENTATION_MODE,
      preserve_interword_spaces: '1',
      user_defined_dpi: String(Math.round(OCR_RENDER_SCALE * 72))
    })
    const pages: ParsedPage[] = []
    try {
      for (const pageNumber of pageNumbers) {
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: OCR_RENDER_SCALE })
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          intent: 'print'
        }).promise
        const result = await worker.recognize(canvas.toBuffer('image/png'))
        const text = cleanText(String(result?.data?.text ?? ''))
        if (text) pages.push({ text, pageNumber, location: `第 ${pageNumber} 页（OCR）` })
      }
    } finally {
      await worker.terminate()
    }
    return pages
  }

  private ocrCachePath(): string {
    const root = process.env.LOCALAPPDATA || tmpdir()
    const cachePath = join(root, 'VISSLM Agent', 'ocr-cache')
    mkdirSync(cachePath, { recursive: true })
    return cachePath
  }
}

class EmbeddingService {
  private extractor: ((texts: string[], options?: Record<string, unknown>) => Promise<any>) | null = null
  private attempted = false
  private preparationPromise: Promise<void> | null = null
  private actualModelVersion = FALLBACK_MODEL_VERSION
  private failureReason = '本地 embedding 模型尚未加载'

  get modelVersion(): string {
    return this.actualModelVersion
  }

  get available(): boolean {
    return Boolean(this.extractor) || this.allowFallback()
  }

  get unavailableReason(): string {
    return this.failureReason
  }

  async prepare(): Promise<void> {
    await this.ensureExtractor()
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return []
    await this.ensureExtractor()
    if (this.extractor) {
      try {
        const result = await this.extractor(texts, { pooling: 'mean', normalize: true })
        const rows = this.toRows(result, texts.length)
        if (rows.length === texts.length) return rows
        throw new Error('本地 embedding 模型返回的向量数量无效')
      } catch (error) {
        console.warn('[knowledge] local embedding failed:', error)
        this.extractor = null
        this.actualModelVersion = FALLBACK_MODEL_VERSION
        this.failureReason = error instanceof Error ? error.message : String(error)
      }
    }
    if (this.allowFallback()) return texts.map((text) => this.hashEmbedding(text))
    return []
  }

  private async ensureExtractor(): Promise<void> {
    if (this.extractor || (this.attempted && !this.preparationPromise)) return
    if (this.preparationPromise) return this.preparationPromise
    this.attempted = true
    this.preparationPromise = this.loadExtractor().finally(() => {
      this.preparationPromise = null
    })
    return this.preparationPromise
  }

  private async loadExtractor(): Promise<void> {
    const root = modelRoot()
    if (!root) {
      this.failureReason = '本地 embedding 模型资源未找到，请先执行 npm run prepare:model 完成资源准备'
      return
    }
    try {
      const runtime = await import('@huggingface/transformers') as unknown as TransformerRuntime
      runtime.env.allowRemoteModels = false
      runtime.env.allowLocalModels = true
      runtime.env.localModelPath = root
      runtime.env.cacheDir = join(root, 'cache')
      const loaded = await runtime.pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        dtype: 'q8',
        local_files_only: true
      })
      if (typeof loaded !== 'function') throw new Error('embedding pipeline 不可用')
      this.extractor = loaded as (texts: string[], options?: Record<string, unknown>) => Promise<any>
      this.actualModelVersion = EMBEDDING_MODEL_VERSION
      this.failureReason = ''
    } catch (error) {
      console.warn('[knowledge] local embedding model unavailable:', error)
      this.failureReason = error instanceof Error ? error.message : String(error)
    }
  }

  private allowFallback(): boolean {
    return process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK === '1'
  }

  private toRows(result: any, expected: number): Float32Array[] {
    if (typeof result?.tolist === 'function') {
      const values = result.tolist() as unknown
      if (Array.isArray(values)) {
        const rows = Array.isArray(values[0]) ? values : [values]
        return rows.map((row) => this.normalizeRow(row as unknown[]))
      }
    }
    const data = result?.data as ArrayLike<number> | undefined
    const dims = result?.dims as number[] | undefined
    if (!data || !dims?.length) return []
    const dimension = Number(dims[dims.length - 1])
    if (!dimension || data.length !== expected * dimension) return []
    return Array.from({ length: expected }, (_, index) =>
      this.normalizeRow(Array.from(data).slice(index * dimension, (index + 1) * dimension))
    )
  }

  private normalizeRow(values: unknown[]): Float32Array {
    const vector = new Float32Array(values.map((value) => Number(value) || 0))
    let norm = 0
    for (const value of vector) norm += value * value
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1
    for (let index = 0; index < vector.length; index += 1) vector[index] *= scale
    return vector
  }

  private hashEmbedding(text: string): Float32Array {
    const vector = new Float32Array(EMBEDDING_DIMENSION)
    const normalized = text.toLocaleLowerCase().replace(/\s+/g, ' ')
    const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
    const units = tokens.length ? tokens : Array.from(normalized)
    for (const token of units) {
      let hash = 2166136261
      for (const char of token) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
      }
      vector[Math.abs(hash) % vector.length] += 1
    }
    for (let index = 0; index + 1 < normalized.length; index += 1) {
      const pair = normalized.slice(index, index + 2)
      let hash = 2166136261
      for (const char of pair) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
      }
      vector[Math.abs(hash) % vector.length] += 0.35
    }
    return this.normalizeRow(Array.from(vector))
  }
}

export class KnowledgeService {
  private readonly parser = new DocumentParser()
  private readonly embeddings = new EmbeddingService()
  private initializationPromise: Promise<void> | null = null
  private indexingPromise: Promise<void> | null = null

  constructor(
    private readonly db: AppDatabase,
    private readonly progress?: (progress: KnowledgeIndexProgress) => void
  ) {}

  get modelVersion(): string {
    return this.embeddings.modelVersion
  }

  async initialize(): Promise<void> {
    if (!this.initializationPromise) this.initializationPromise = this.initializeInternal()
    return this.initializationPromise
  }

  private async initializeInternal(): Promise<void> {
    await this.embeddings.prepare()
    if (!this.embeddings.available) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: this.embeddings.unavailableReason,
        current: 0,
        total: 0,
        status: 'failed'
      })
      return
    }
    try {
      if (this.db.knowledgeDocumentsNeedReindex(this.modelVersion)) await this.rebuildIndex()
      await this.syncRecordIndex()
    } catch (error) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        current: 0,
        total: 0,
        status: 'failed'
      })
    }
  }

  async processFiles(
    filePaths: string[],
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeUploadResult> {
    const taskId = randomUUID()
    const documents: KnowledgeDocument[] = []
    const skipped: Array<{ fileName: string; reason: string }> = []
    let failedCount = 0
    let acceptedCount = 0
    let reusedCount = 0
    for (const filePath of [...new Set(filePaths)]) {
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath
      const extension = extensionFor(filePath)
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        skipped.push({ fileName, reason: `不支持 ${extension || '无扩展名'} 文件` })
        continue
      }
      let bytes: Buffer
      let byteSize: number
      try {
        const stats = statSync(filePath)
        byteSize = stats.size
        if (!stats.isFile()) throw new Error('路径不是文件')
        if (byteSize > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('文件超过 100 MB 限制')
        bytes = readFileSync(filePath)
      } catch (error) {
        skipped.push({ fileName, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const sha256 = fileHash(bytes)
      const existing = this.db.findKnowledgeDocumentByHash(sha256)
      if (existing) {
        const managedPath = this.db.storeKnowledgeDocumentFile(bytes, sha256, extension)
        this.db.updateKnowledgeDocumentFilePath(existing.id, managedPath)
        const managedDocument = { ...existing, filePath: managedPath }
        const reused = existing.status === 'ready'
          ? managedDocument
          : await this.processDocument(managedDocument, taskId, documents.length + 1, filePaths.length, onProgress)
        documents.push(reused)
        reusedCount += 1
        if (reused.status === 'failed') failedCount += 1
        if (existing.status === 'ready') {
          this.emitAndNotify(onProgress, {
            taskId,
            phase: 'done',
            documentId: reused.id,
            fileName: reused.fileName,
            message: `${reused.fileName} 已复用现有知识库索引`,
            current: documents.length,
            total: filePaths.length,
            status: 'success'
          })
        }
        skipped.push({ fileName, reason: `重复文件，已复用知识库索引（${existing.fileName}）` })
        continue
      }
      const managedPath = this.db.storeKnowledgeDocumentFile(bytes, sha256, extension)
      const document = this.db.insertKnowledgeDocument({
        id: randomUUID(),
        fileName,
        filePath: managedPath,
        extension,
        mimeType: mimeFor(extension),
        byteSize,
        sha256,
        modelVersion: this.modelVersion
      })
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'queued',
        documentId: document.id,
        fileName,
        message: `已加入解析队列: ${fileName}`,
        current: documents.length,
        total: filePaths.length,
        status: 'running'
      })
      documents.push(document)
      acceptedCount += 1
      let processed: KnowledgeDocument
      try {
        if (!bytes.length) throw new Error('文件内容为空')
        validateDocumentSignature(bytes, extension)
        processed = await this.processDocument(document, taskId, documents.length, filePaths.length, onProgress)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        processed = this.db.updateKnowledgeDocument(document.id, {
          status: 'failed',
          errorMessage: message,
          processedAt: ''
        }) ?? { ...document, status: 'failed', errorMessage: message }
        this.emitAndNotify(onProgress, {
          taskId,
          phase: 'error',
          documentId: document.id,
          fileName,
          message: `${fileName}: ${message}`,
          current: documents.length,
          total: filePaths.length,
          status: 'failed'
        })
      }
      if (processed.status === 'failed') failedCount += 1
    }
    return {
      ok: documents.length > failedCount || skipped.length === 0,
      acceptedCount,
      reusedCount,
      skippedCount: skipped.length,
      failedCount,
      documents: documents.map((document) => this.db.getKnowledgeDocument(document.id) as KnowledgeDocument),
      skipped,
      message: `知识库处理完成：${acceptedCount} 个新增，${reusedCount} 个复用，${failedCount} 个失败，${skipped.length - reusedCount} 个跳过`
    }
  }

  async retryDocument(id: string): Promise<KnowledgeDocument | null> {
    const document = this.db.getKnowledgeDocument(id)
    if (!document) return null
    return this.processDocument(document, randomUUID(), 1, 1)
  }

  updateDocumentTags(id: string, tags: string[]): KnowledgeDocument | null {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20)
    return this.db.updateKnowledgeDocument(id, { tags: normalized })
  }

  deleteDocument(id: string): { ok: boolean; message: string } {
    const result = this.db.deleteKnowledgeDocument(id)
    return result.deleted
      ? { ok: true, message: `已从知识库删除 ${id}` }
      : { ok: false, message: '文档不存在或已经删除' }
  }

  async rebuildIndex(): Promise<KnowledgeRebuildResult> {
    await this.embeddings.prepare()
    if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
    const taskId = randomUUID()
    const chunks = this.db.listKnowledgeChunksForRebuild()
    this.db.deleteKnowledgeVectors()
    const vectors: KnowledgeVectorInput[] = []
      for (let index = 0; index < chunks.length; index += 32) {
        const batch = chunks.slice(index, index + 32)
        const embeddings = await this.embeddings.embedMany(batch.map((chunk) => chunk.content))
        if (embeddings.length !== batch.length) throw new Error(this.embeddings.unavailableReason)
      vectors.push(...batch.map((chunk, batchIndex) => ({
        chunkId: chunk.id,
        vector: embeddings[batchIndex],
        modelVersion: this.modelVersion
      })))
      this.emit({
        taskId,
        phase: 'embedding',
        message: `正在重建向量索引（${Math.min(index + batch.length, chunks.length)}/${chunks.length}）`,
        current: Math.min(index + batch.length, chunks.length),
        total: chunks.length,
        status: 'running'
      })
    }
    this.db.saveKnowledgeVectors(vectors)
    this.db.markKnowledgeDocumentsModelVersion(this.modelVersion)
    const stats = this.db.getKnowledgeStats(this.modelVersion)
    this.emit({
      taskId,
      phase: 'done',
      message: '知识库向量索引已重建',
      current: chunks.length,
      total: chunks.length,
      status: 'success'
    })
    return {
      ok: true,
      taskId,
      documentCount: stats.documentCount,
      recordCount: stats.recordCount,
      chunkCount: chunks.length,
      message: '知识库向量索引已重建'
    }
  }

  async syncRecordIndex(): Promise<void> {
    if (this.indexingPromise) return this.indexingPromise
    this.indexingPromise = this.syncRecordIndexInternal().finally(() => {
      this.indexingPromise = null
    })
    return this.indexingPromise
  }

  async search(question: string, limit = 8): Promise<KnowledgeSearchHit[]> {
    const query = question.trim()
    if (!query) return []
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) return []
    const [queryVector] = await this.embeddings.embedMany([query])
    await this.waitForIndexReady()
    const candidates = this.db.listKnowledgeVectorRows(this.modelVersion)
    if (!queryVector || !candidates.length) return []
    const terms = new Set((query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => term.length > 1))
    const ranked = candidates.map(({ chunk, vector }) => {
      const cosine = this.cosine(queryVector, vector)
      const haystack = chunk.content.toLocaleLowerCase()
      const lexical = [...terms].filter((term) => haystack.includes(term)).length / Math.max(terms.size, 1)
      const score = cosine * 0.75 + lexical * 0.25
      const source: ChatSource = chunk.sourceType === 'document'
        ? {
            uid: `document:${chunk.documentId ?? chunk.id}`,
            name: chunk.sourceName,
            nodeType: 'knowledge_document',
            itemId: chunk.documentId ?? chunk.id,
            sourceType: 'document',
            documentId: chunk.documentId,
            chunkId: chunk.id,
            fileName: chunk.sourceName,
            location: chunk.location,
            pageNumber: chunk.pageNumber,
            sheetName: chunk.sheetName,
            snippet: chunk.content.slice(0, 320),
            score
          }
        : {
            uid: chunk.recordUid ?? chunk.id,
            name: chunk.sourceName,
            nodeType: 'record',
            itemId: chunk.recordUid ?? chunk.id,
            sourceType: 'record',
            chunkId: chunk.id,
            location: chunk.location,
            snippet: chunk.content.slice(0, 320),
            score
          }
      return { source, chunk, score }
    })
      .filter((item) => item.score >= 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(20, Math.max(1, limit)))
    return ranked
  }

  private async waitForIndexReady(): Promise<void> {
    if (this.initializationPromise) {
      try {
        await this.initializationPromise
      } catch {
        // A failed startup index should not prevent structured record queries.
      }
    }
    if (this.indexingPromise) {
      try {
        await this.indexingPromise
      } catch {
        // A failed incremental index should fall back to the records table.
      }
    }
  }

  async rankRecordMatches(question: string, limit = 100_000): Promise<KnowledgeRecordMatch[]> {
    const query = question.trim()
    if (!query) return []
    await this.embeddings.prepare()
    if (!this.embeddings.available) return []
    const [queryVector] = await this.embeddings.embedMany([query])
    const candidates = this.db.listKnowledgeVectorRows(this.modelVersion)
      .filter(({ chunk }) => chunk.sourceType === 'record' && Boolean(chunk.recordUid))
    if (!queryVector || !candidates.length) return []

    const terms = new Set(
      (query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((term) => term.length > 1)
    )
    const bestByRecord = new Map<string, KnowledgeRecordMatch>()
    for (const { chunk, vector } of candidates) {
      const recordUid = chunk.recordUid as string
      const cosine = Math.max(0, this.cosine(queryVector, vector))
      const haystack = chunk.content.toLocaleLowerCase()
      const lexical = [...terms].filter((term) => haystack.includes(term)).length / Math.max(terms.size, 1)
      // Full-requirement semantics drive recall; literal overlap is only a small supporting signal.
      const score = Math.max(0, Math.min(1, cosine * 0.85 + lexical * 0.15)) * 100
      const existing = bestByRecord.get(recordUid)
      if (existing && existing.score >= score) continue
      bestByRecord.set(recordUid, {
        recordUid,
        recordName: chunk.sourceName,
        nodeType: 'record',
        itemId: recordUid,
        score,
        chunkId: chunk.id,
        snippet: chunk.content.slice(0, 600)
      })
    }
    return [...bestByRecord.values()]
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
      .slice(0, Math.max(1, Math.trunc(limit)))
  }

  async rankRequirementRecordMatches(
    question: string,
    limit = 100,
    allowedRecordUids?: ReadonlySet<string>
  ): Promise<KnowledgeRecordMatch[]> {
    const query = question.trim()
    if (!query) return []
    await this.initialize()
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
    const [queryVector] = await this.embeddings.embedMany([query])
    if (!queryVector) throw new Error(this.embeddings.unavailableReason || '本地 embedding 未返回查询向量')
    const candidates = this.db.listKnowledgeVectorRows(this.modelVersion)
      .filter(({ chunk }) => chunk.sourceType === 'record' && Boolean(chunk.recordUid))
    if (!candidates.length) {
      throw new Error(`数据中心记录向量索引不可用或尚未使用模型 ${this.modelVersion} 建立`)
    }
    const bestByRecord = new Map<string, KnowledgeRecordMatch>()
    for (const { chunk, vector } of candidates) {
      const recordUid = chunk.recordUid as string
      if (allowedRecordUids && !allowedRecordUids.has(recordUid)) continue
      const score = Math.max(0, Math.min(1, this.cosine(queryVector, vector))) * 100
      const existing = bestByRecord.get(recordUid)
      if (existing && existing.score >= score) continue
      bestByRecord.set(recordUid, {
        recordUid,
        recordName: chunk.sourceName,
        nodeType: 'record',
        itemId: recordUid,
        score,
        chunkId: chunk.id,
        snippet: chunk.content.slice(0, 600)
      })
    }
    return [...bestByRecord.values()]
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
      .slice(0, Math.min(100, Math.max(1, Math.trunc(limit))))
  }

  async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
    await this.initialize()
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
    const records = this.db.listKnowledgeIndexedRecordDetails(this.modelVersion)
    if (!records.length) {
      throw new Error(`数据中心记录向量索引不可用或尚未使用模型 ${this.modelVersion} 建立`)
    }
    return records
  }

  private async processDocument(
    document: KnowledgeDocument,
    taskId: string,
    current: number,
    total: number,
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeDocument> {
    this.db.updateKnowledgeDocument(document.id, {
      status: 'processing',
      errorMessage: '',
      processedAt: ''
    })
    this.db.clearKnowledgeDocumentChunks(document.id)
    try {
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'parsing',
        documentId: document.id,
        fileName: document.fileName,
        message: `正在解析 ${document.fileName}`,
        current,
        total,
        status: 'running'
      })
      const parsed = await this.parser.parse(document.filePath)
      const chunks = chunkKnowledgePages(parsed.pages)
      if (!chunks.length) throw new Error('解析结果没有可索引的正文分块')
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'embedding',
        documentId: document.id,
        fileName: document.fileName,
        message: `正在生成 ${chunks.length} 个本地向量分块`,
        current: 0,
        total: chunks.length,
        status: 'running'
      })
      const vectors: KnowledgeVectorInput[] = []
      const inputs: KnowledgeChunkInput[] = []
      for (let index = 0; index < chunks.length; index += 32) {
        const batch = chunks.slice(index, index + 32)
        const embeddings = await this.embeddings.embedMany(batch.map((chunk) => chunk.text))
        if (embeddings.length !== batch.length) throw new Error(this.embeddings.unavailableReason)
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const chunk = batch[batchIndex]
          const chunkId = randomUUID()
          inputs.push({
            id: chunkId,
            documentId: document.id,
            sourceType: 'document',
            sourceName: document.fileName,
            sourceHash: document.sha256,
            content: chunk.text,
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            sheetName: chunk.sheetName,
            location: chunk.location,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd
          })
          vectors.push({ chunkId, vector: embeddings[batchIndex], modelVersion: this.modelVersion })
        }
        this.emitAndNotify(onProgress, {
          taskId,
          phase: 'embedding',
          documentId: document.id,
          fileName: document.fileName,
          message: `已生成 ${Math.min(index + batch.length, chunks.length)}/${chunks.length} 个向量`,
          current: Math.min(index + batch.length, chunks.length),
          total: chunks.length,
          status: 'running'
        })
      }
      this.db.replaceKnowledgeDocumentChunks(document.id, inputs, vectors)
      const updated = this.db.updateKnowledgeDocument(document.id, {
        status: 'ready',
        errorMessage: '',
        chunkCount: inputs.length,
        pageCount: parsed.pageCount,
        modelVersion: this.modelVersion,
        processedAt: new Date().toISOString()
      })
      const result = updated ?? document
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'done',
        documentId: document.id,
        fileName: document.fileName,
        message: `${document.fileName} 已完成解析和索引`,
        current,
        total,
        status: 'success'
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const updated = this.db.updateKnowledgeDocument(document.id, {
        status: 'failed',
        errorMessage: message,
        processedAt: ''
      })
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'error',
        documentId: document.id,
        fileName: document.fileName,
        message: `${document.fileName}: ${message}`,
        current,
        total,
        status: 'failed'
      })
      return updated ?? { ...document, status: 'failed', errorMessage: message }
    }
  }

  private async syncRecordIndexInternal(): Promise<void> {
    await this.embeddings.prepare()
    if (!this.embeddings.available) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: this.embeddings.unavailableReason,
        current: 0,
        total: 0,
        status: 'failed'
      })
      return
    }
    const taskId = randomUUID()
    const rows = this.db.listKnowledgeRecordIndexRows()
    const known = new Set(rows.map((row) => row.uid))
    for (const uid of this.db.listKnowledgeIndexedRecordUids()) {
      if (!known.has(uid)) this.db.deleteKnowledgeRecordIndex(uid)
    }
    if (!rows.length) return
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (
        this.db.getKnowledgeRecordIndexHash(row.uid) === row.contentHash &&
        this.db.getKnowledgeRecordIndexModelVersion(row.uid) === this.modelVersion
      ) continue
      const pages: ParsedPage[] = [{
        // row.content is already restricted to business evidence. Keep
        // identity and audit metadata out of embedding input.
        text: row.content,
        location: '采集记录'
      }]
      const chunks = chunkKnowledgePages(pages)
      const embeddings = await this.embeddings.embedMany(chunks.map((chunk) => chunk.text))
      if (embeddings.length !== chunks.length) throw new Error(this.embeddings.unavailableReason)
      const inputs: KnowledgeChunkInput[] = []
      const vectors: KnowledgeVectorInput[] = []
      chunks.forEach((chunk, chunkIndex) => {
        const chunkId = randomUUID()
        inputs.push({
          id: chunkId,
          recordUid: row.uid,
          sourceType: 'record',
          sourceName: row.name,
          sourceHash: row.contentHash,
          content: chunk.text,
          chunkIndex,
          location: chunk.location,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd
        })
        vectors.push({ chunkId, vector: embeddings[chunkIndex], modelVersion: this.modelVersion })
      })
      this.db.replaceKnowledgeRecordChunks(row.uid, inputs, vectors)
      this.emit({
        taskId,
        phase: 'records',
        message: `采集记录向量索引 ${index + 1}/${rows.length}`,
        current: index + 1,
        total: rows.length,
        status: 'running'
      })
    }
    this.emit({
      taskId,
      phase: 'done',
      message: '采集记录向量索引已同步',
      current: rows.length,
      total: rows.length,
      status: 'success'
    })
  }

  private cosine(left: Float32Array, right: Float32Array): number {
    const length = Math.min(left.length, right.length)
    let dot = 0
    let leftNorm = 0
    let rightNorm = 0
    for (let index = 0; index < length; index += 1) {
      dot += left[index] * right[index]
      leftNorm += left[index] * left[index]
      rightNorm += right[index] * right[index]
    }
    return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
  }

  private emit(progress: KnowledgeIndexProgress): void {
    this.db.saveKnowledgeIndexProgress(progress)
    this.progress?.(progress)
  }

  private emitAndNotify(
    onProgress: ((progress: KnowledgeIndexProgress) => void) | undefined,
    progress: KnowledgeIndexProgress
  ): void {
    this.emit(progress)
    onProgress?.(progress)
  }
}
