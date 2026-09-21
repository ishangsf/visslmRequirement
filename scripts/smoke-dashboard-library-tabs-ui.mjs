import WebSocket from 'ws'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9223'
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

await call('Page.enable')
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 700))

const response = await call('Runtime.evaluate', {
  expression: `(async () => {
    const waitFor = async (predicate, timeout = 5000) => {
      const started = Date.now()
      while (!predicate() && Date.now() - started < timeout) {
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return predicate()
    }
    const visible = (element) => {
      if (!element) return false
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        rect.width > 0 && rect.height > 0
    }
    const displayedTabContent = (element) => {
      const panel = element?.closest('[role="tabpanel"]')
      return Boolean(element && panel) && panel.getAttribute('aria-hidden') !== 'true' &&
        getComputedStyle(panel).display !== 'none'
    }
    const dashboardMenuItem = [...document.querySelectorAll('.ant-menu-item')]
      .find((item) => item.textContent?.includes('可视化大屏'))
    dashboardMenuItem?.click()
    await waitFor(() => [...document.querySelectorAll('.dashboard-studio')].some(visible))
    const studio = [...document.querySelectorAll('.dashboard-studio')].find(visible)

    const componentButton = studio?.querySelector('button[aria-label="打开组件库"]')
    const outlineButton = studio?.querySelector('button[aria-label="打开页面大纲"]')
    const original = componentButton?.getAttribute('aria-pressed') === 'true'
      ? 'library'
      : outlineButton?.getAttribute('aria-pressed') === 'true' ? 'outline' : 'closed'

    if (componentButton?.getAttribute('aria-pressed') !== 'true') componentButton?.click()
    await waitFor(() => componentButton?.getAttribute('aria-pressed') === 'true')
    await new Promise((resolve) => setTimeout(resolve, 240))
    const library = studio?.querySelector('.dashboard-component-library')
    const libraryOnly = displayedTabContent(library) && !displayedTabContent(
      studio?.querySelector('.dashboard-component-outline')
    )
    const activeLibraryContent = studio?.querySelector(
      '.dashboard-library-tabs .ant-tabs-content-active .dashboard-component-library'
    ) === library

    outlineButton?.click()
    await waitFor(() => outlineButton?.getAttribute('aria-pressed') === 'true')
    await new Promise((resolve) => setTimeout(resolve, 180))
    const outline = studio?.querySelector('.dashboard-component-outline')
    const outlineOnly = displayedTabContent(outline) && !displayedTabContent(
      studio?.querySelector('.dashboard-component-library')
    )
    const activeOutlineContent = studio?.querySelector(
      '.dashboard-library-tabs .ant-tabs-content-active .dashboard-component-outline'
    ) === outline

    componentButton?.click()
    await waitFor(() => componentButton?.getAttribute('aria-pressed') === 'true')
    await new Promise((resolve) => setTimeout(resolve, 180))
    const roundTripLibraryOnly = displayedTabContent(
      studio?.querySelector('.dashboard-component-library')
    ) && !displayedTabContent(studio?.querySelector('.dashboard-component-outline'))

    if (original === 'outline') {
      outlineButton?.click()
      await waitFor(() => outlineButton?.getAttribute('aria-pressed') === 'true')
    } else if (original === 'closed') {
      componentButton?.click()
      await waitFor(() => componentButton?.getAttribute('aria-pressed') === 'false')
    }

    return {
      libraryOnly,
      outlineOnly,
      activeLibraryContent,
      activeOutlineContent,
      roundTripLibraryOnly
    }
  })()`,
  awaitPromise: true,
  returnByValue: true
})

socket.close()
if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
}
const checks = response.result?.result?.value ?? {}
const failed = Object.entries(checks).filter(([, value]) => !value)
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2))
if (failed.length) {
  throw new Error(`Dashboard library tabs UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
}
