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
await new Promise((resolve) => setTimeout(resolve, 800))

const response = await call('Runtime.evaluate', {
  expression: `(async () => {
    const waitFor = async (predicate, timeout = 6000) => {
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
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
    }
    const dashboardMenuItem = [...document.querySelectorAll('.ant-menu-item')]
      .find((item) => item.textContent?.includes('可视化大屏'))
    dashboardMenuItem?.click()
    await waitFor(() => [...document.querySelectorAll('.dashboard-studio')].some(visible))
    const studio = [...document.querySelectorAll('.dashboard-studio')].find(visible)
    const kpiWidget = [...(studio?.querySelectorAll('.dashboard-widget.widget-kpi') ?? [])].find(visible)
    kpiWidget?.click()

    const inspectorButton = studio?.querySelector('button[aria-label="切换属性面板"]')
    const inspectorWasOpen = inspectorButton?.getAttribute('aria-pressed') === 'true'
    if (!inspectorWasOpen) inspectorButton?.click()
    await waitFor(() => inspectorButton?.getAttribute('aria-pressed') === 'true')
    await waitFor(() => Boolean(studio?.querySelector(
      '.dashboard-component-option-editor[data-component-type="kpi"] [data-component-option="showStatus"]'
    )))

    const editor = studio?.querySelector('.dashboard-component-option-editor[data-component-type="kpi"]')
    const editorWasVisible = visible(editor)
    const switchControl = editor?.querySelector('[data-component-option="showStatus"]')
    const selectedKpi = studio?.querySelector('.dashboard-widget.widget-kpi.selected')
    const originalChecked = switchControl?.getAttribute('aria-checked') === 'true'
    const originalStatusVisible = Boolean(selectedKpi?.querySelector('.viz-kpi-meta'))
    switchControl?.click()
    await waitFor(() => (switchControl?.getAttribute('aria-checked') === 'true') !== originalChecked)
    await new Promise((resolve) => setTimeout(resolve, 160))
    const changedStatusVisible = Boolean(
      studio?.querySelector('.dashboard-widget.widget-kpi.selected .viz-kpi-meta')
    )
    const canvasUpdatesImmediately = changedStatusVisible !== originalStatusVisible

    const currentSwitch = studio?.querySelector(
      '.dashboard-component-option-editor[data-component-type="kpi"] [data-component-option="showStatus"]'
    )
    currentSwitch?.click()
    await waitFor(() => (
      studio?.querySelector(
        '.dashboard-component-option-editor[data-component-type="kpi"] [data-component-option="showStatus"]'
      )?.getAttribute('aria-checked') === 'true'
    ) === originalChecked)
    await new Promise((resolve) => setTimeout(resolve, 160))
    const restoredStatusVisible = Boolean(
      studio?.querySelector('.dashboard-widget.widget-kpi.selected .viz-kpi-meta')
    )

    if (!inspectorWasOpen) inspectorButton?.click()
    return {
      kpiFound: Boolean(kpiWidget || editor),
      dedicatedEditorVisible: editorWasVisible,
      optionControlAccessible: Boolean(switchControl?.getAttribute('aria-label')),
      canvasUpdatesImmediately,
      originalStateRestored: restoredStatusVisible === originalStatusVisible
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
  throw new Error(`Dashboard component option UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
}
