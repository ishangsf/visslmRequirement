import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9225'
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
await call('Page.reload')

const checks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }

  await waitFor('.ant-menu-item')
  const dashboardMenuItem = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.querySelector('.anticon-fund-projection-screen') || item.textContent?.includes('可视化'))
  dashboardMenuItem?.click()
  await waitFor('.dashboard-studio')
  const selectorRoot = document.querySelector('.dashboard-selector')
  const selector = selectorRoot?.querySelector('.ant-select-selector')
  const selectorInput = selectorRoot?.querySelector('input')
  selector?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  selector?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
  selectorInput?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
  selectorInput?.click()
  selectorInput?.focus()
  selectorInput?.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true
  }))
  const dropdown = await waitFor('.ant-select-dropdown')
  const option = [...document.querySelectorAll('.ant-select-item')]
    .find((item) => item.textContent?.includes('UI Version Dashboard'))
  option?.click()
  const readVersion = () => Number(
    (document.querySelector('.dashboard-studio-heading .ant-tag')?.textContent ?? '').match(/V(\\d+)/)?.[1] ?? 0
  )
  const beforeStarted = Date.now()
  let beforeVersion = readVersion()
  while (!beforeVersion && Date.now() - beforeStarted < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    beforeVersion = readVersion()
  }
  const historyButton = [...document.querySelectorAll('.dashboard-studio-toolbar button')]
    .find((button) => button.querySelector('.anticon-history'))
  const historyButtonEnabled = Boolean(historyButton && !historyButton.disabled)
  historyButton?.click()
  const drawer = await waitFor('.ant-drawer')
  const restoreButton = [...(drawer?.querySelectorAll('.ant-list-item-action button') ?? [])]
    .filter((button) => !button.disabled)
    .at(-1)
  const restoreButtonEnabled = Boolean(restoreButton)
  restoreButton?.click()
  const confirm = await waitFor('.ant-popconfirm')
  const confirmationVisible = Boolean(confirm)
  const confirmButton = confirm?.querySelector('.ant-popconfirm-buttons .ant-btn-primary')
  confirmButton?.click()
  const afterStarted = Date.now()
  let afterVersion = readVersion()
  while (afterVersion <= beforeVersion && Date.now() - afterStarted < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    afterVersion = readVersion()
  }
  const restoreCreatedNewVersion = beforeVersion > 0 && afterVersion === beforeVersion + 1
  return {
    selectorExists: Boolean(selectorRoot),
    selectorInputExists: Boolean(selectorInput),
    dashboardOpened: Boolean(option),
    dropdownVisible: Boolean(dropdown),
    beforeVersion,
    historyButtonEnabled,
    restoreButtonEnabled,
    confirmationVisible,
    restoreCreatedNewVersion,
    afterVersion
  }
})()`)

const failed = Object.entries(checks).filter(([, value]) => !value)
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const screenshotPath = join(tmpdir(), 'visslm-dashboard-version-ui-smoke.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
socket.close()

console.log(JSON.stringify({ ok: failed.length === 0, checks, screenshotPath }, null, 2))
if (failed.length) throw new Error(`Dashboard version UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
