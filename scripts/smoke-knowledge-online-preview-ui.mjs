import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9335'
const screenshotRoot = process.env.VISSLM_KNOWLEDGE_PREVIEW_SCREENSHOT_DIR
  ?? join(process.cwd(), 'tmp', 'knowledge-preview-e2e', 'screenshots')
mkdirSync(screenshotRoot, { recursive: true })

const mainSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const rendererSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/knowledge/KnowledgeDocumentPreviewer.tsx'),
  'utf8'
)
const isolatedContract = mainSource.includes('VISSLM_E2E_ALLOW_MULTI_INSTANCE')
  && mainSource.includes('VISSLM_E2E_KNOWLEDGE_FILES')
  && mainSource.includes('!app.isPackaged')
const lazyRendererContract = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  .includes("const KnowledgeDocumentPreviewer = lazy(")
const formatContract = ['pdf', 'docx', 'xlsx', 'text']
  .every((format) => rendererSource.includes(`format === '${format}'`))

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
if (!target) throw new Error(`VISSLM Agent CDP target not found on port ${cdpPort}`)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

let sequence = 0
const pending = new Map()
socket.on('message', (raw) => {
  const response = JSON.parse(raw.toString('utf8'))
  if (!response.id || !pending.has(response.id)) return
  pending.get(response.id)(response)
  pending.delete(response.id)
})

const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.error) throw new Error(response.error.message || 'Renderer protocol evaluation failed')
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

const captureScreenshot = async (name) => {
  const response = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(screenshotRoot, `${name}.png`)
  writeFileSync(path, Buffer.from(response.result.data, 'base64'))
  return path
}

await call('Runtime.enable')
await call('Page.enable')
await call('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false
})

const seeded = await evaluate(`(async () => {
  const upload = await window.visslm.uploadKnowledgeDocuments()
  if (!upload?.documents?.length) {
    throw new Error('No E2E knowledge documents were injected: ' + JSON.stringify(upload))
  }
  const failed = upload.documents.filter((document) => document.status !== 'ready')
  if (failed.length) {
    throw new Error('Knowledge fixtures did not finish indexing: ' + JSON.stringify(failed.map((item) => ({
      fileName: item.fileName,
      status: item.status,
      errorMessage: item.errorMessage
    }))))
  }

  const details = (await Promise.all(upload.documents.map((document) => window.visslm.getKnowledgeDocument(document.id))))
    .filter(Boolean)
  const byExtension = Object.fromEntries(details.map((detail) => [detail.extension.toLowerCase(), detail]))
  for (const extension of ['.pdf', '.docx', '.xlsx', '.txt']) {
    if (!byExtension[extension]) throw new Error('Missing indexed fixture ' + extension)
  }

  const targetChunkFor = (detail) => {
    if (detail.extension === '.pdf') {
      return detail.chunks.find((chunk) => (chunk.pageNumber ?? 0) >= 2)
        ?? detail.chunks[detail.chunks.length - 1]
    }
    if (detail.extension === '.xlsx' || detail.extension === '.xls') {
      return [...detail.chunks].reverse().find((chunk) => chunk.sheetName && /第\\s*\\d+\\s*行/.test(chunk.content))
        ?? detail.chunks[detail.chunks.length - 1]
    }
    if (detail.extension === '.txt') {
      return detail.chunks.find((chunk) => chunk.content.includes('VISSLM-TXT-ANCHOR-20260827'))
        ?? detail.chunks[0]
    }
    return detail.chunks[Math.max(0, Math.floor(detail.chunks.length / 2))] ?? detail.chunks[0]
  }
  const humanLocation = (chunk) => {
    if (Number.isFinite(chunk.pageNumber) && chunk.pageNumber > 0) return '第 ' + chunk.pageNumber + ' 页'
    if (chunk.sheetName) return '工作表「' + chunk.sheetName + '」'
    const location = String(chunk.location ?? '').trim()
    if (location && !/^(?:文档)?正文(?:内容)?$|^(?:分块|chunk)/i.test(location)) return location
    const text = String(chunk.content ?? '').replace(/\\s+/g, ' ').trim()
    return '正文「' + text.slice(0, 24) + (text.length > 24 ? '…' : '') + '」'
  }
  const fixtures = []
  for (const extension of ['.pdf', '.docx', '.xlsx', '.txt']) {
    const detail = byExtension[extension]
    const chunk = targetChunkFor(detail)
    if (!chunk) throw new Error('No target chunk for ' + detail.fileName)
    const preview = await window.visslm.getKnowledgeDocumentPreview(detail.id)
    if (!preview?.contentUrl || !preview.renderFormat) {
      throw new Error('No online preview for ' + detail.fileName + ': ' + JSON.stringify(preview))
    }
    fixtures.push({
      extension,
      documentId: detail.id,
      chunkId: chunk.id,
      fileName: detail.fileName,
      location: humanLocation(chunk),
      renderFormat: preview.renderFormat,
      pageNumber: chunk.pageNumber,
      sheetName: chunk.sheetName,
      content: chunk.content
    })
  }

  const now = new Date().toISOString()
  const assistantContent = fixtures.map((fixture) =>
    '[' + fixture.fileName + ' · ' + fixture.location + '](#knowledge-document='
      + encodeURIComponent(fixture.documentId) + '&chunk=' + encodeURIComponent(fixture.chunkId) + ')'
  ).join('\\n\\n')
  await window.visslm.saveChatSession({
    id: 'knowledge-online-preview-e2e',
    title: '知识库在线预览 E2E',
    messages: [
      {
        id: 'knowledge-online-preview-user',
        role: 'user',
        content: '验证四种知识库引用在线预览与位置跳转',
        createdAt: now
      },
      {
        id: 'knowledge-online-preview-assistant',
        role: 'assistant',
        content: assistantContent,
        createdAt: now,
        contextOutcome: 'success',
        sources: fixtures.map((fixture) => ({
          uid: 'document:' + fixture.documentId + ':' + fixture.chunkId,
          name: fixture.fileName,
          nodeType: 'knowledge_document',
          itemId: fixture.documentId,
          sourceType: 'document',
          documentId: fixture.documentId,
          chunkId: fixture.chunkId,
          fileName: fixture.fileName,
          location: fixture.location,
          pageNumber: fixture.pageNumber,
          sheetName: fixture.sheetName,
          snippet: fixture.content.slice(0, 320)
        }))
      }
    ]
  })
  return { upload, fixtures }
})()`)

await call('Page.reload')

const uiChecks = await evaluate(`(async () => {
  const fixtures = ${JSON.stringify(seeded.fixtures)}
  const waitFor = async (predicate, label, timeout = 120000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const waitForGone = async (selector, timeout = 30000) => {
    const started = Date.now()
    while (document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (document.querySelector(selector)) throw new Error('Timed out closing ' + selector)
  }

  await waitFor(() => [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('AI 助手')), 'AI assistant menu').then((item) => item.click())
  const historyItem = await waitFor(() => document.querySelector('[aria-label="打开历史会话：知识库在线预览 E2E"]'), 'E2E history session')
  historyItem.click()
  await waitFor(() => document.querySelector('[data-chat-session-title="知识库在线预览 E2E"]'), 'loaded E2E session')
  const citationButtons = await waitFor(() => {
    const buttons = [...document.querySelectorAll('.chat-knowledge-citation-link')]
    return buttons.length === fixtures.length ? buttons : null
  }, 'four readable citations')

  const results = []
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]
    citationButtons[index].click()
    const drawer = await waitFor(() => document.querySelector('.knowledge-document-preview-drawer'), fixture.extension + ' drawer')
    await waitFor(() => !drawer.querySelector('.knowledge-document-preview__loading'), fixture.extension + ' preview load')
    const targetBanner = drawer.querySelector('.knowledge-document-preview__target')?.textContent?.trim() ?? ''
    const viewport = drawer.querySelector('.knowledge-document-preview__viewport')
    const drawerRect = drawer.getBoundingClientRect()
    const computedBackground = viewport ? getComputedStyle(viewport).backgroundColor : ''
    const base = {
      extension: fixture.extension,
      fileName: fixture.fileName,
      renderFormat: fixture.renderFormat,
      citationText: citationButtons[index].textContent?.trim() ?? '',
      targetBanner,
      targetLocated: targetBanner.startsWith('已定位到'),
      internalScroll: Boolean(viewport && viewport.scrollHeight > viewport.clientHeight),
      drawerWithinViewport: drawerRect.left >= 0 && drawerRect.right <= window.innerWidth + 1
        && drawerRect.top >= 0 && drawerRect.bottom <= window.innerHeight + 1,
      darkViewportBackground: computedBackground,
      opaqueIdentifierVisible: /UID:document|chunk[-_:]?\\w+|分块\\s*\\d+/i.test(drawer.textContent ?? '')
        || /UID:document|chunk[-_:]?\\w+|分块\\s*\\d+/i.test(citationButtons[index].textContent ?? '')
    }
    if (fixture.extension === '.pdf') {
      const canvas = await waitFor(() => drawer.querySelector('.knowledge-document-preview__pdf-page canvas'), 'PDF canvas')
      results.push({ ...base, rendererVisible: canvas.width > 0 && canvas.height > 0, targetVisual: targetBanner.startsWith('已定位到') })
    } else if (fixture.extension === '.docx') {
      const renderer = await waitFor(() => drawer.querySelector(
        '.knowledge-document-preview__pdf-page canvas, .knowledge-document-preview__docx-viewport .docx'
      ), 'DOCX renderer')
      const highlight = drawer.querySelector('.knowledge-document-preview__highlight, .knowledge-document-preview__block-target')
      results.push({
        ...base,
        rendererVisible: renderer.getBoundingClientRect().height > 0,
        targetVisual: fixture.renderFormat === 'pdf' ? targetBanner.startsWith('已定位到') : Boolean(highlight)
      })
    } else if (fixture.extension === '.xlsx') {
      const table = await waitFor(() => drawer.querySelector('.knowledge-document-preview__sheet-table'), 'XLSX table')
      const targetRow = table.querySelector('tr.is-target')
      results.push({ ...base, rendererVisible: table.getBoundingClientRect().height > 0, targetVisual: Boolean(targetRow) })
    } else {
      const text = await waitFor(() => drawer.querySelector('.knowledge-document-preview__text-content'), 'TXT content')
      const highlight = text.querySelector('.knowledge-document-preview__highlight')
      results.push({
        ...base,
        rendererVisible: text.getBoundingClientRect().height > 0,
        targetVisual: Boolean(highlight?.textContent?.includes('VISSLM-TXT-ANCHOR-20260827'))
      })
    }
    drawer.querySelector('.ant-drawer-close')?.click()
    await waitForGone('.knowledge-document-preview-drawer')
  }

  return {
    theme: document.documentElement.dataset.theme,
    citationCount: citationButtons.length,
    results
  }
})()`)

const darkScreenshot = await captureScreenshot('knowledge-online-preview-dark')

await call('Emulation.setDeviceMetricsOverride', {
  width: 760,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false
})

const responsiveChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 60000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const citations = [...document.querySelectorAll('.chat-knowledge-citation-link')]
  citations[citations.length - 1]?.click()
  const drawer = await waitFor(() => document.querySelector('.knowledge-document-preview-drawer'), 'responsive drawer')
  await waitFor(() => drawer.querySelector('.knowledge-document-preview__text-content'), 'responsive TXT preview')
  const rect = drawer.getBoundingClientRect()
  const darkWidth = rect.width
  const darkWithinViewport = rect.left >= 0 && rect.right <= window.innerWidth + 1
  drawer.querySelector('.ant-drawer-close')?.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  document.querySelector('button[aria-label="切换到亮色主题"]')?.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  citations[citations.length - 1]?.click()
  const lightDrawer = await waitFor(() => document.querySelector('.knowledge-document-preview-drawer'), 'light drawer')
  const viewport = await waitFor(() => lightDrawer.querySelector('.knowledge-document-preview__text-viewport'), 'light TXT viewport')
  const lightBackground = getComputedStyle(viewport).backgroundColor
  const lightColor = getComputedStyle(viewport).color
  return {
    width: darkWidth,
    withinViewport: darkWithinViewport,
    viewportWidth: window.innerWidth,
    theme: document.documentElement.dataset.theme,
    lightBackground,
    lightColor,
    highlighted: Boolean(lightDrawer.querySelector('.knowledge-document-preview__highlight'))
  }
})()`)

const lightScreenshot = await captureScreenshot('knowledge-online-preview-light-760')

const failures = []
if (!isolatedContract) failures.push('isolated E2E launch contract missing')
if (!lazyRendererContract) failures.push('previewer is not lazy-loaded')
if (!formatContract) failures.push('one or more preview formats are not wired')
if (uiChecks.theme !== 'dark') failures.push(`expected dark theme, got ${uiChecks.theme}`)
if (uiChecks.citationCount !== 4) failures.push(`expected four citations, got ${uiChecks.citationCount}`)
for (const result of uiChecks.results) {
  if (!result.rendererVisible) failures.push(`${result.extension} renderer is not visible`)
  if (!result.targetLocated) failures.push(`${result.extension} did not report a located target: ${result.targetBanner}`)
  if (!result.targetVisual) failures.push(`${result.extension} target is not visually selected/highlighted`)
  if (!result.drawerWithinViewport) failures.push(`${result.extension} drawer exceeds viewport`)
  if (result.opaqueIdentifierVisible) failures.push(`${result.extension} exposes an opaque identifier`)
  if (/rgb\\(255,\\s*255,\\s*255\\)/i.test(result.darkViewportBackground)) {
    failures.push(`${result.extension} uses a white preview viewport in dark theme`)
  }
}
if (!responsiveChecks.withinViewport || responsiveChecks.width > responsiveChecks.viewportWidth) {
  failures.push(`responsive drawer overflow: ${JSON.stringify(responsiveChecks)}`)
}
if (responsiveChecks.theme !== 'light') failures.push(`light theme toggle failed: ${JSON.stringify(responsiveChecks)}`)
if (!responsiveChecks.highlighted) failures.push('TXT target highlight disappeared in light theme')

if (failures.length) {
  throw new Error(`Knowledge online preview UI smoke failed: ${JSON.stringify({ failures, uiChecks, responsiveChecks })}`)
}

console.log(JSON.stringify({
  ok: true,
  isolatedContract,
  lazyRendererContract,
  formatContract,
  fixtures: seeded.fixtures.map(({ content, ...fixture }) => fixture),
  uiChecks,
  responsiveChecks,
  screenshots: [darkScreenshot, lightScreenshot]
}, null, 2))

socket.close()
