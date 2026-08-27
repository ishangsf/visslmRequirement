import WebSocket from 'ws'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9339'
const screenshotDirectory = join(process.cwd(), 'tmp', 'knowledge-preview-e2e', 'screenshots')
mkdirSync(screenshotDirectory, { recursive: true })

const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
const target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
if (!target) throw new Error('VISSLM Agent CDP target not found')

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
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

const captureScreenshot = async (name) => {
  const response = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const outputPath = join(screenshotDirectory, `${name}.png`)
  writeFileSync(outputPath, Buffer.from(response.result.data, 'base64'))
  return outputPath
}

const appSource = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
const knowledgePageSource = appSource.slice(
  appSource.indexOf('function KnowledgeBasePage'),
  appSource.indexOf('function ChatPage')
)
const sourceContract = knowledgePageSource.includes('getKnowledgeDocumentPreview(id)')
  && knowledgePageSource.includes('<KnowledgeDocumentPreviewer')
  && knowledgePageSource.includes('在线预览')
  && knowledgePageSource.includes('解析与索引')
  && knowledgePageSource.includes('<Pagination')
  && !knowledgePageSource.includes('分块预览（')

await call('Emulation.clearDeviceMetricsOverride')
await call('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 920,
  deviceScaleFactor: 1,
  mobile: false
})
await call('Page.bringToFront')
await call('Page.reload')
const darkChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 60000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const isVisible = (node) => Boolean(node && getComputedStyle(node).display !== 'none'
    && getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length)
  const openDrawerOf = () => [...document.querySelectorAll('.knowledge-detail-preview-drawer')]
    .find((node) => {
      const drawer = node.closest('.ant-drawer') ?? node
      return drawer.classList.contains('ant-drawer-open') && isVisible(node)
    })

  await waitFor(() => document.querySelector('.ant-menu-item'), 'application navigation')
  if (document.documentElement.dataset.theme !== 'dark') {
    document.querySelector('button[aria-label="切换到暗色主题"]')?.click()
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme')
  }
  const uploadResult = await window.visslm.uploadKnowledgeDocuments()
  if (!uploadResult || (!uploadResult.ok && !uploadResult.canceled)) {
    throw new Error('Failed to seed knowledge fixture: ' + JSON.stringify(uploadResult))
  }

  const assetMenu = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('资产中心'))
  assetMenu?.click()
  await waitFor(() => [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('知识库')), 'knowledge tab')
  const knowledgeTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('知识库'))
  knowledgeTab?.click()
  await waitFor(() => document.querySelector('.knowledge-page'), 'knowledge page')
  const documentLink = await waitFor(() => [...document.querySelectorAll('.knowledge-name-button')]
    .find((button) => isVisible(button)), 'seeded knowledge document')
  const seededFileName = documentLink.textContent?.trim() ?? ''
  documentLink.click()

  const drawerNode = await waitFor(openDrawerOf, 'knowledge preview drawer')
  const drawer = drawerNode.closest('.ant-drawer') ?? drawerNode
  const canvas = await waitFor(() => drawer.querySelector('.knowledge-document-preview__pdf-page canvas'), 'PDF preview canvas')
  await waitFor(() => canvas.width > 0 && canvas.height > 0, 'rendered PDF page')
  const wrapper = await waitFor(() => drawer.querySelector('.ant-drawer-content-wrapper'), 'drawer content wrapper')
  await new Promise((resolve) => setTimeout(resolve, 500))
  if (wrapper.getBoundingClientRect().right > window.innerWidth + 1) {
    // Background Electron windows may freeze Ant Design's entrance motion at
    // its initial transform. Neutralize only that test-time transform so the
    // captured frame validates the settled drawer layout.
    wrapper.style.transition = 'none'
    wrapper.style.transform = 'none'
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  const viewport = drawer.querySelector('.knowledge-document-preview__viewport')
  const body = drawer.querySelector('.ant-drawer-body')
  const drawerRect = wrapper.getBoundingClientRect()
  const bodyStyle = body ? getComputedStyle(body) : null
  const viewportStyle = viewport ? getComputedStyle(viewport) : null
  const initialRendererVisible = canvas.width > 0 && canvas.height > 0 && canvas.getBoundingClientRect().height > 0
  const sixthPage = drawer.querySelector('[data-pdf-page="6"]')
  if (viewport && sixthPage) {
    const viewportRect = viewport.getBoundingClientRect()
    const sixthPageRect = sixthPage.getBoundingClientRect()
    viewport.scrollTop += (sixthPageRect.top + sixthPageRect.height / 2)
      - (viewportRect.top + viewportRect.height / 2)
    viewport.dispatchEvent(new Event('scroll'))
  }
  const sixthPageCanvas = await waitFor(() => sixthPage?.querySelector('canvas:not([hidden])'), 'lazy-rendered sixth PDF page')
  await waitFor(() => (drawer.textContent ?? '').includes('第 6 / 9 页'), 'current page indicator after continuous scroll')
  await waitFor(() => drawer.querySelector('[data-pdf-page="1"] canvas')?.hasAttribute('hidden'), 'released distant PDF page canvas')
  const renderedCanvasCountAfterScroll = drawer.querySelectorAll('.knowledge-document-preview__pdf-page canvas:not([hidden])').length
  return {
    theme: document.documentElement.dataset.theme,
    drawerNodeClass: drawerNode.className,
    drawerClass: drawer.className,
    wrapperClass: wrapper.className,
    wrapperInlineStyle: wrapper.getAttribute('style') ?? '',
    fileName: seededFileName,
    fileVisible: Boolean(seededFileName && drawer.textContent?.includes(seededFileName)),
    onlinePreviewHeading: drawer.textContent?.includes('在线预览') ?? false,
    oldChunkPreviewAbsent: !drawer.textContent?.includes('分块预览'),
    rendererVisible: initialRendererVisible,
    continuousPageIndicatorVisible: (drawer.textContent ?? '').includes('第 6 / 9 页'),
    continuousReadingHintVisible: drawer.textContent?.includes('向下滚动连续阅读') ?? false,
    manualPageButtonsAbsent: !drawer.textContent?.includes('上一页') && !drawer.textContent?.includes('下一页'),
    allPagePlaceholdersPresent: drawer.querySelectorAll('[data-pdf-page]').length === 9,
    continuousScrollLoadsLaterPage: Boolean(sixthPageCanvas),
    distantPageCanvasReleased: drawer.querySelector('[data-pdf-page="1"] canvas')?.hasAttribute('hidden') ?? false,
    renderedCanvasCountBounded: renderedCanvasCountAfterScroll <= 6,
    currentPageFollowsScroll: (drawer.textContent ?? '').includes('第 6 / 9 页'),
    drawerWithinViewport: drawerRect.left >= 0 && drawerRect.right <= window.innerWidth + 1
      && drawerRect.top >= 0 && drawerRect.bottom <= window.innerHeight + 1,
    drawerBodyClipsPageScroll: bodyStyle?.overflow === 'hidden',
    previewOwnsScroll: Boolean(viewport && ['auto', 'scroll'].includes(viewportStyle?.overflowY ?? '')),
    darkPreviewBackground: viewportStyle?.backgroundColor ?? '',
    noError: !drawer.querySelector('.ant-alert-error')
  }
})()`)

const darkScreenshot = await captureScreenshot('asset-knowledge-online-preview-dark')

const indexChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const drawer = document.querySelector('.knowledge-detail-preview-drawer')
  const indexTab = [...(drawer?.querySelectorAll('.knowledge-detail-tabs .ant-tabs-tab') ?? [])]
    .find((tab) => tab.textContent?.includes('解析与索引'))
  indexTab?.click()
  const panel = await waitFor(() => {
    const node = drawer?.querySelector('.knowledge-detail-index-panel')
    return node?.closest('.ant-tabs-content-active') && node.getClientRects().length ? node : null
  }, 'visible knowledge index panel')
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const summaryText = panel.querySelector('.knowledge-index-summary')?.textContent ?? ''
  const cards = [...panel.querySelectorAll('.knowledge-index-chunk-card')]
  const list = panel.querySelector('.knowledge-index-chunk-list')
  const listStyle = list ? getComputedStyle(list) : null
  return {
    tabActive: [...(drawer?.querySelectorAll('.knowledge-detail-tabs .ant-tabs-tab-active') ?? [])]
      .some((tab) => tab.textContent?.includes('解析与索引')),
    summaryVisible: ['解析状态', '索引分块', '向量模型', '处理完成', '最后更新']
      .every((label) => summaryText.includes(label)),
    chunkCountVisible: (drawer?.textContent ?? '').includes('解析与索引（11）')
      && (panel.textContent ?? '').includes('找到 11 个分块'),
    searchVisible: Boolean(panel.querySelector('input[placeholder="搜索页码、工作表、位置或正文"]')),
    chunkCardsVisible: cards.length === 11,
    readableChunkContent: cards.some((card) => (card.querySelector('.knowledge-index-chunk-content')?.textContent?.trim().length ?? 0) > 20),
    sourceLocationVisible: cards.some((card) => /第\\d+页/.test(card.textContent ?? '')),
    opaqueChunkIdsAbsent: cards.every((card) => !/[0-9a-f]{8}-[0-9a-f-]{27,}|chunk[-_:]/i.test(card.textContent ?? '')),
    listOwnsScroll: ['auto', 'scroll'].includes(listStyle?.overflowY ?? '')
  }
})()`)

const indexScreenshot = await captureScreenshot('asset-knowledge-index-dark')

await evaluate(`(async () => {
  const drawer = document.querySelector('.knowledge-detail-preview-drawer')
  const previewTab = [...(drawer?.querySelectorAll('.knowledge-detail-tabs .ant-tabs-tab') ?? [])]
    .find((tab) => tab.textContent?.trim() === '在线预览')
  previewTab?.click()
  const started = Date.now()
  while (!drawer?.querySelector('.knowledge-document-preview__viewport') && Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return Boolean(drawer?.querySelector('.knowledge-document-preview__viewport'))
})()`)

await call('Emulation.setDeviceMetricsOverride', {
  width: 660,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false
})

const responsiveChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  const drawerNode = await waitFor(() => document.querySelector('.knowledge-detail-preview-drawer'), 'responsive drawer')
  const drawer = drawerNode.closest('.ant-drawer') ?? drawerNode
  const wrapper = await waitFor(() => drawer.querySelector('.ant-drawer-content-wrapper'), 'responsive drawer wrapper')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const rect = wrapper.getBoundingClientRect()
  document.querySelector('button[aria-label="切换到亮色主题"]')?.click()
  await waitFor(() => document.documentElement.dataset.theme === 'light', 'light theme')
  const viewport = await waitFor(() => drawer.querySelector('.knowledge-document-preview__viewport'), 'light preview viewport')
  const previewStyle = getComputedStyle(viewport)
  const tagEditor = drawer.querySelector('.knowledge-tag-editor')
  const tagEditorStyle = tagEditor ? getComputedStyle(tagEditor) : null
  return {
    theme: document.documentElement.dataset.theme,
    width: rect.width,
    viewportWidth: window.innerWidth,
    withinViewport: rect.left >= 0 && rect.right <= window.innerWidth + 1,
    previewBackground: previewStyle.backgroundColor,
    previewColor: previewStyle.color,
    tagEditorSingleColumn: tagEditorStyle?.gridTemplateColumns?.trim().split(/\\s+/).length === 1,
    canvasVisible: Boolean(drawer.querySelector('.knowledge-document-preview__pdf-page canvas:not([hidden])'))
  }
})()`)

const lightScreenshot = await captureScreenshot('asset-knowledge-online-preview-light-660')
const failures = []
if (!sourceContract) failures.push('asset-center source contract is incomplete')
for (const [key, value] of Object.entries(darkChecks)) {
  if (!['darkPreviewBackground', 'theme', 'fileName', 'drawerNodeClass', 'drawerClass', 'wrapperClass', 'wrapperInlineStyle'].includes(key) && value !== true) {
    failures.push(`dark check failed: ${key}=${String(value)}`)
  }
}
for (const [key, value] of Object.entries(indexChecks)) {
  if (value !== true) failures.push(`index check failed: ${key}=${String(value)}`)
}
if (darkChecks.theme !== 'dark') failures.push(`expected dark theme, got ${darkChecks.theme}`)
if (/rgb\\(255,\\s*255,\\s*255\\)/i.test(darkChecks.darkPreviewBackground)) {
  failures.push('dark preview viewport uses a white background')
}
if (responsiveChecks.theme !== 'light') failures.push(`expected light theme, got ${responsiveChecks.theme}`)
if (!responsiveChecks.withinViewport || responsiveChecks.width > responsiveChecks.viewportWidth - 31) {
  failures.push(`responsive drawer overflow: ${JSON.stringify(responsiveChecks)}`)
}
if (!responsiveChecks.canvasVisible) failures.push('PDF canvas disappeared after responsive resize')
if (!responsiveChecks.tagEditorSingleColumn) failures.push('tag editor did not collapse to one column at 660px')

socket.close()
if (failures.length) {
  throw new Error(`Asset knowledge preview UI smoke failed: ${JSON.stringify({ failures, darkChecks, responsiveChecks })}`)
}

console.log(JSON.stringify({
  ok: true,
  sourceContract,
  darkChecks,
  indexChecks,
  responsiveChecks,
  screenshots: [darkScreenshot, indexScreenshot, lightScreenshot]
}, null, 2))
