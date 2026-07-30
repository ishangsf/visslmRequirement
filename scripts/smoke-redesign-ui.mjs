import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const targets = await (await fetch('http://127.0.0.1:9223/json/list')).json()
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
  const message = JSON.parse(raw.toString('utf8'))
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const call = (method, params = {}) =>
  new Promise((resolve) => {
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
const capture = async (name) => {
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(process.env.TEMP, name)
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
  return path
}
const openPage = async (label, selector) =>
  evaluate(`(async () => {
    [...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === ${JSON.stringify(label)})
      ?.click();
    const started = Date.now();
    while (!document.querySelector(${JSON.stringify(selector)}) && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  })()`)

await openPage('数据概览', '.metric-card')
const checks = await evaluate(`(async () => ({
  titlebar: Boolean(document.querySelector('.window-titlebar')),
  titlebarHeight: Math.round(document.querySelector('.window-titlebar')?.getBoundingClientRect().height || 0),
  windowControls: document.querySelectorAll('.window-control-button').length,
  windowApi: typeof window.visslm.minimizeWindow === 'function' &&
    typeof window.visslm.toggleMaximizeWindow === 'function' &&
    typeof window.visslm.closeWindow === 'function',
  brandImage: Boolean(document.querySelector('.brand-mark img')),
  modelStatus: Boolean(document.querySelector('.model-status .model-status-light')),
  oldHeaderRemoved: !document.querySelector('.app-header'),
  pageHeadingRemoved: !document.querySelector('.page-heading'),
  pageTitleInContent: document.querySelector('.content-page-title')?.textContent?.trim() === '数据概览',
  pageTitleRemovedFromWindowBar: !document.querySelector('.window-drag-region')?.textContent?.includes('数据概览'),
  metricCards: document.querySelectorAll('.metric-card').length,
  glassSidebar: getComputedStyle(document.querySelector('.app-sider')).backdropFilter.includes('blur'),
  darkSurface: getComputedStyle(document.querySelector('.app-content')).backgroundColor === 'rgb(9, 11, 16)',
  dashboardBento: Boolean(document.querySelector('.dashboard-insights-card')),
  typeComposition: Boolean(document.querySelector('.type-composition-list')),
  releaseChart: Boolean(document.querySelector('.release-donut')),
  releaseStatsVisible: document.querySelector('.release-insight')?.textContent?.includes('_valm_Release'),
  collectionActivityRemoved: ![...document.querySelectorAll('.ant-card-head-title')]
    .some((element) => element.textContent?.includes('采集活动')),
  viewportFits: document.querySelector('.app-layout').getBoundingClientRect().bottom <= window.innerHeight
}))()`)
await call('Page.enable')
const dashboardScreenshot = await capture('visslm-redesign-dashboard.png')

await openPage('数据中心', '.filter-bar')
const dataChecks = await evaluate(`({
  toolbar: Boolean(document.querySelector('.page-toolbar')),
  table: Boolean(document.querySelector('.ant-table')),
  title: document.querySelector('.content-page-title')?.textContent?.trim(),
  titleAlignedWithToolbar: Math.abs(
    document.querySelector('.content-page-title')?.getBoundingClientRect().top -
    document.querySelector('.page-toolbar')?.getBoundingClientRect().top
  ) <= 4
})`)
const dataScreenshot = await capture('visslm-redesign-data.png')

await openPage('AI 助手', '.chat-card')
const chatChecks = await evaluate(`({
  chatCard: Boolean(document.querySelector('.chat-card')),
  title: document.querySelector('.content-page-title')?.textContent?.trim(),
  brandedAssistantIcon: Boolean(document.querySelector('.assistant-orb img')),
  composerVisible: document.querySelector('.composer')?.getBoundingClientRect().bottom <= window.innerHeight
})`)
const chatScreenshot = await capture('visslm-redesign-chat.png')

await openPage('数据采集', '.page-inner-tabs')
const syncChecks = await evaluate(`({
  toolbar: Boolean(document.querySelector('.page-toolbar')),
  tabs: document.querySelectorAll('.page-inner-tabs .ant-tabs-tab').length === 2,
  title: document.querySelector('.content-page-title')?.textContent?.trim()
})`)
const syncScreenshot = await capture('visslm-redesign-sync.png')

await openPage('数据推送', '.compact-push-config-card')
await evaluate(`(async () => {
  const header = document.querySelector('.push-advanced-collapse .ant-collapse-header');
  if (header?.getAttribute('aria-expanded') !== 'true') header?.click();
  await new Promise((resolve) => setTimeout(resolve, 250));
})()`)
const pushChecks = await evaluate(`(() => {
  const headerText = document.querySelector('.push-advanced-collapse .ant-collapse-header-text')
    || document.querySelector('.push-advanced-collapse .ant-collapse-header');
  return {
    title: document.querySelector('.content-page-title')?.textContent?.trim(),
    advancedPanel: Boolean(document.querySelector('.push-advanced-collapse')),
    advancedPanelExpanded: [...document.querySelectorAll('.push-advanced-collapse input')]
      .some((input) => input.getBoundingClientRect().height > 0),
    advancedTextColor: headerText ? getComputedStyle(headerText).color : null
  };
})()`)
const pushScreenshot = await capture('visslm-redesign-push.png')

await openPage('连接设置', '.settings-width .ant-card')
const settingsChecks = await evaluate(`({
  cards: document.querySelectorAll('.settings-width .ant-card').length,
  title: document.querySelector('.content-page-title')?.textContent?.trim()
})`)
const settingsScreenshot = await capture('visslm-redesign-settings.png')

const windowStateChecks = await evaluate(`(async () => {
  const before = await window.visslm.isWindowMaximized();
  const maximized = await window.visslm.toggleMaximizeWindow();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const restored = await window.visslm.toggleMaximizeWindow();
  return { before, maximized, restored };
})()`)

console.log(JSON.stringify({
  ...checks,
  dataChecks,
  chatChecks,
  syncChecks,
  pushChecks,
  settingsChecks,
  windowStateChecks,
  dashboardScreenshot,
  dataScreenshot,
  chatScreenshot,
  syncScreenshot,
  pushScreenshot,
  settingsScreenshot
}, null, 2))
socket.close()
