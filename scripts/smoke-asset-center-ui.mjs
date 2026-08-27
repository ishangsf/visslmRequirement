import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Asset-center smoke coverage for data, knowledge, and maintenance workflows.
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

await call('Page.reload')
const checks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const isVisible = (node) => {
    if (!node) return false
    const style = getComputedStyle(node)
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0
  }
  const waitForVisible = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const node = [...document.querySelectorAll(selector)].find(isVisible)
      if (node) return node
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return [...document.querySelectorAll(selector)].find(isVisible) ?? null
  }
  const waitForActiveTab = async (label, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const active = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab-active')]
        .find((item) => item.textContent?.includes(label))
      if (active) return active
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab-active')]
      .find((item) => item.textContent?.includes(label)) ?? null
  }
  const isOpenDrawer = (node) => {
    const drawer = node?.closest('.ant-drawer') ?? node
    return Boolean(drawer?.classList.contains('ant-drawer-open'))
  }
  const waitForOpenDrawer = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const drawer = [...document.querySelectorAll(selector)].find(isOpenDrawer)
      if (drawer) return drawer
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return [...document.querySelectorAll(selector)].find(isOpenDrawer) ?? null
  }
  const waitForClosedDrawer = async (selector, timeout = 4000) => {
    const started = Date.now()
    while ([...document.querySelectorAll(selector)].some(isOpenDrawer) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return ![...document.querySelectorAll(selector)].some(isOpenDrawer)
  }
  const clickMenu = (label) => {
    const item = [...document.querySelectorAll('.ant-menu-item')]
      .find((candidate) => candidate.textContent?.includes(label))
    item?.click()
    return Boolean(item)
  }

  await waitFor('.ant-menu-item')
  const assetMenu = clickMenu('资产中心')
  const assetCenter = await waitForVisible('.asset-center-page')
  const tabs = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .map((item) => item.textContent?.trim())
  const dataPage = Boolean(document.querySelector('.asset-center-page .filter-bar'))
  const selectableRows = Boolean(document.querySelector('.asset-center-page .ant-table-selection-column'))

  const knowledgeTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('知识库'))
  knowledgeTab?.click()
  const knowledgeActiveTab = Boolean(await waitForActiveTab('知识库'))
  const knowledgePage = Boolean(await waitForVisible('.knowledge-page'))
  const uploadButton = Boolean(document.querySelector('.knowledge-toolbar button'))
  const metrics = document.querySelectorAll('.knowledge-metric-grid .ant-card').length
  const filters = Boolean(document.querySelector('.knowledge-filter-bar'))
  const table = Boolean(document.querySelector('.knowledge-list-card .ant-table'))

  const dataTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('数据中心'))
  dataTab?.click()
  const dataActiveTab = Boolean(await waitForActiveTab('数据中心'))
  const dataPageRestored = Boolean(await waitForVisible('.asset-center-page .data-workbench-card'))

  const maintenanceEntry = [...document.querySelectorAll('.asset-center-page .page-toolbar button')]
    .find((button) => button.textContent?.includes('数据维护'))
  const maintenanceEntryPresent = Boolean(maintenanceEntry)
  maintenanceEntry?.click()
  const maintenanceDrawer = await waitForOpenDrawer('.record-maintenance-drawer')
  const maintenanceDrawerText = maintenanceDrawer?.textContent ?? ''
  const maintenancePreview = Boolean(maintenanceDrawer?.querySelector('.record-maintenance-preview'))
  const maintenanceActions = ['一键优化匹配', '仅清理数据', '仅重建索引']
    .every((label) => maintenanceDrawerText.includes(label))
  const maintenanceScope = Boolean(maintenanceDrawer?.querySelector('[aria-label="数据维护范围"]'))
  const maintenanceApi = [
    'previewRecordMaintenance',
    'startRecordMaintenance',
    'getRecordMaintenanceTask',
    'stopRecordMaintenance',
    'onRecordMaintenanceProgress'
  ].every((name) => typeof window.visslm?.[name] === 'function')
  maintenanceDrawer?.querySelector('.ant-drawer-close')?.click()
  await waitForClosedDrawer('.record-maintenance-drawer')

  const firstRecordLink = document.querySelector('.asset-center-page .ant-table-tbody .table-link')
  firstRecordLink?.click()
  const recordDetailDrawer = await waitForOpenDrawer('.record-detail-drawer')
  const recordDetailText = recordDetailDrawer?.textContent ?? ''
  const detailReadiness = Boolean(recordDetailDrawer?.querySelector('.record-maintenance-readiness'))
  const detailOptimizeAction = recordDetailText.includes('优化此记录')
  const detailMatchingText = recordDetailText.includes('匹配文本')
  const detailRawCollapsed = Boolean(recordDetailDrawer?.querySelector('.record-detail-raw-collapse'))
  recordDetailDrawer?.querySelector('.ant-drawer-close')?.click()
  await waitForClosedDrawer('.record-detail-drawer')

  return {
    assetMenu,
    assetCenter: Boolean(assetCenter),
    tabs,
    dataPage,
    selectableRows,
    knowledgeActiveTab,
    knowledgePage,
    uploadButton,
    metrics,
    filters,
    table,
    dataActiveTab,
    dataPageRestored,
    maintenanceEntryPresent,
    maintenancePreview,
    maintenanceActions,
    maintenanceScope,
    maintenanceApi,
    detailReadiness,
    detailOptimizeAction,
    detailMatchingText,
    detailRawCollapsed
  }
})()`)

const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
const dataPageSource = appSource.slice(appSource.indexOf('function DataPage('), appSource.indexOf('const knowledgeStatusMeta'))
const maintenanceSource = [
  'previewRecordMaintenance',
  'startRecordMaintenance',
  'getRecordMaintenanceTask',
  'stopRecordMaintenance',
  'onRecordMaintenanceProgress',
  '重试失败项',
  '安全停止'
].every((value) => dataPageSource.includes(value))
const maintenanceDetailSource = [
  '匹配准备度',
  'matchingText',
  '优化此记录',
  'record-detail-raw-collapse'
].every((value) => dataPageSource.includes(value))

if (!checks.assetMenu || !checks.assetCenter || !checks.dataPage ||
    !checks.maintenanceEntryPresent || !checks.maintenancePreview ||
    !checks.maintenanceActions || !checks.maintenanceScope || !checks.maintenanceApi ||
    !checks.detailReadiness || !checks.detailOptimizeAction || !checks.detailMatchingText ||
    !checks.detailRawCollapsed || !maintenanceSource || !maintenanceDetailSource ||
    !checks.selectableRows || !checks.knowledgePage || !checks.uploadButton || !checks.filters ||
    !checks.table || !checks.knowledgeActiveTab || !checks.dataActiveTab || !checks.dataPageRestored) {
  throw new Error(`Asset center source-only smoke failed: ${JSON.stringify({ ...checks, staticGenerationEntrypointsAbsent, assetCenterSourceSeparated, maintenanceSource, maintenanceDetailSource })}`)
}

await call('Page.enable')
const lightChecks = await evaluate(`(async () => {
  const toggle = document.querySelector('.window-theme-toggle')
  if (!toggle) return { toggled: false }
  if (document.documentElement.dataset.theme !== 'light') toggle.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const page = document.querySelector('.asset-center-page')
  return {
    toggled: document.documentElement.dataset.theme === 'light',
    pageBackground: page ? getComputedStyle(page).backgroundColor : ''
  }
})()`)
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', 'visslm-asset-center-light.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))

const darkChecks = await evaluate(`(async () => {
  const toggle = document.querySelector('.window-theme-toggle')
  if (!toggle) return { toggled: false }
  if (document.documentElement.dataset.theme !== 'dark') toggle.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const page = document.querySelector('.asset-center-page')
  return {
    toggled: document.documentElement.dataset.theme === 'dark',
    pageBackground: page ? getComputedStyle(page).backgroundColor : ''
  }
})()`)
const darkScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const darkScreenshotPath = join(process.env.TEMP ?? '.', 'visslm-asset-center-dark.png')
writeFileSync(darkScreenshotPath, Buffer.from(darkScreenshot.result.data, 'base64'))

if (!lightChecks.toggled) throw new Error(`Asset center light-theme smoke failed: ${JSON.stringify(lightChecks)}`)
if (!darkChecks.toggled) throw new Error(`Asset center dark-theme smoke failed: ${JSON.stringify(darkChecks)}`)

console.log(JSON.stringify({
  ...checks,
  maintenanceSource,
  maintenanceDetailSource,
  screenshot: screenshotPath,
  lightTheme: lightChecks,
  darkTheme: darkChecks,
  darkScreenshot: darkScreenshotPath
}, null, 2))
socket.close()
