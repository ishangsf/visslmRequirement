import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'

const projectPageSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/project-management/ProjectManagementPage.tsx'),
  'utf8'
)
const mainSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
const sourcePreviewContract = mainSource.includes("const sourcePreviewExtensions = new Set(['.docx', '.pdf'])")
  && mainSource.includes('renderDocxSourceWithWord')
  && mainSource.includes("renderFormat: 'pdf'")
  && projectPageSource.includes("await import('docx-preview')")
  && projectPageSource.includes('renderAltChunks: false')
  && projectPageSource.includes('<DocxDocumentPreview')
  && projectPageSource.includes('<WordDocumentPreview')

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9334'
const previewTheme = process.env.VISSLM_PREVIEW_THEME === 'light' ? 'light' : 'dark'
const requestedWidth = Number.parseInt(process.env.VISSLM_PREVIEW_WIDTH ?? '1440', 10)
const requestedHeight = Number.parseInt(process.env.VISSLM_PREVIEW_HEIGHT ?? '900', 10)
const previewWidth = Number.isFinite(requestedWidth) ? Math.max(680, requestedWidth) : 1440
const previewHeight = Number.isFinite(requestedHeight) ? Math.max(640, requestedHeight) : 900
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
  if (response.id && pending.has(response.id)) {
    pending.get(response.id)(response)
    pending.delete(response.id)
  }
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

await call('Runtime.enable')
await call('Page.enable')
await call('Emulation.setDeviceMetricsOverride', {
  width: previewWidth,
  height: previewHeight,
  deviceScaleFactor: 1,
  mobile: false
})
await call('Page.reload')

const checks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 30000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const waitForGone = async (selector, timeout = 60000) => {
    const started = Date.now()
    while (document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !document.querySelector(selector)
  }

  await waitFor('.ant-menu-item')
  const requestedTheme = ${JSON.stringify(previewTheme)}
  if (document.documentElement.dataset.theme !== requestedTheme) {
    const themeToggle = document.querySelector(requestedTheme === 'light'
      ? 'button[aria-label="\u5207\u6362\u5230\u4eae\u8272\u4e3b\u9898"]'
      : 'button[aria-label="\u5207\u6362\u5230\u6697\u8272\u4e3b\u9898"]')
    themeToggle?.click()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const projects = await window.visslm.listManagedProjects({ page: 1, pageSize: 200, search: '' })
  const sourceProject = projects.rows.find((project) => project.currentDocumentName?.toLowerCase().endsWith('.docx'))
  if (!sourceProject) throw new Error('No project with a DOCX source attachment was found')

  const projectMenu = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('\u9879\u76ee\u7ba1\u7406'))
  projectMenu?.click()
  await waitFor('.project-management-page')

  const projectLink = [...document.querySelectorAll('.project-name-link')]
    .find((item) => item.textContent?.trim() === sourceProject.projectName)
  if (!projectLink) throw new Error('DOCX project is not visible in the project list')
  projectLink.click()
  await waitFor('.project-detail-page')

  const previewButton = document.querySelector('.project-document-chip')
  if (!previewButton) throw new Error('Source document preview entry is missing')
  previewButton.click()
  await waitFor('.project-document-preview-modal')
  const firstPage = await waitFor('.project-document-word-preview .project-document-pdf-page, .project-document-docx-renderer section.visslm-docx', 90000)
  await waitForGone('.project-document-word-preview .project-document-preview-state')

  const modal = document.querySelector('.project-document-preview-modal')
  const wordRendered = Boolean(modal?.querySelector('.project-document-word-preview'))
  const renderer = modal?.querySelector(wordRendered ? '.project-document-pdf-preview' : '.project-document-docx-renderer')
  const viewport = modal?.querySelector(wordRendered ? '.project-document-pdf-preview' : '.project-document-docx-viewport')
  const pages = [...(renderer?.querySelectorAll(wordRendered ? '.project-document-pdf-page' : 'section.visslm-docx') ?? [])]
  const pageElement = wordRendered ? firstPage?.querySelector('canvas') : firstPage
  const pageRect = pageElement?.getBoundingClientRect()
  const initialWidth = pageRect?.width ?? 0
  const zoomIn = document.querySelector('button[aria-label="\u653e\u5927\u6587\u6863"]')
  zoomIn?.click()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const zoomedWidth = pageElement?.getBoundingClientRect().width ?? 0

  return {
    sourcePreviewContract: ${sourcePreviewContract},
    fileName: sourceProject.currentDocumentName,
    sourceTag: Boolean(modal?.textContent?.includes('DOCX \u6e90\u6587\u4ef6')),
    sourceRenderer: Boolean(renderer && pageElement),
    wordRendered,
    noTextFallback: !modal?.querySelector('.project-document-text-preview > pre'),
    pageCount: pages.length,
    pageWidth: Math.round(initialWidth),
    pageHeight: Math.round(pageRect?.height ?? 0),
    internalScroll: Boolean(viewport && viewport.scrollHeight > viewport.clientHeight),
    zoomChanged: wordRendered || zoomedWidth > initialWidth,
    unsafeElementCount: renderer?.querySelectorAll('script, iframe, object, embed, form').length ?? -1,
    modalWithinViewport: Boolean(modal && modal.getBoundingClientRect().height <= window.innerHeight),
    theme: document.documentElement.dataset.theme ?? 'unknown'
  }
})()`)

if (!checks.sourcePreviewContract || !checks.sourceTag || !checks.sourceRenderer || !checks.noTextFallback
  || checks.pageCount < (checks.wordRendered ? 2 : 1) || checks.pageWidth < 500 || checks.pageHeight < 600 || !checks.internalScroll
  || !checks.zoomChanged || checks.unsafeElementCount !== 0 || !checks.modalWithinViewport) {
  throw new Error(`Project document preview smoke failed: ${JSON.stringify(checks)}`)
}

const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', `visslm-docx-source-preview-${previewTheme}-${previewWidth}.png`)
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
console.log(JSON.stringify({ ...checks, screenshot: screenshotPath }, null, 2))
socket.close()
