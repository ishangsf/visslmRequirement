import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const clickMenu = (label) => {
    const item = [...document.querySelectorAll('.ant-menu-item')]
      .find((candidate) => candidate.textContent?.includes(label))
    item?.click()
    return Boolean(item)
  }

  await waitFor('.ant-menu-item')
  const assetMenu = clickMenu('资产中心')
  const assetCenter = await waitFor('.asset-center-page')
  const tabs = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .map((item) => item.textContent?.trim())
  const dataPage = Boolean(document.querySelector('.asset-center-page .filter-bar'))
  const dataPageText = assetCenter?.textContent ?? ''
  const semanticFilter = [...document.querySelectorAll('.asset-center-page .filter-bar .ant-select')]
    .some((item) => item.textContent?.includes('全部') || item.textContent?.includes('语义'))
  const semanticColumn = dataPageText.includes('AI 语义化')
  const assetCenterHasNoTaskOperations = !document.querySelector('.asset-center-page .asset-semantic-task-config') &&
    !document.querySelector('.asset-center-page .asset-semantic-task-panel') &&
    !document.querySelector('.asset-center-page .asset-semantic-audit') &&
    !dataPageText.includes('处理全部未语义化数据') &&
    !dataPageText.includes('生成语义卡片') &&
    !dataPageText.includes('重新生成')
  const taskApi = ['startRequirementSemanticization', 'getRequirementSemanticizationTask', 'controlRequirementSemanticization']
    .every((name) => typeof window.visslm?.[name] === 'function')
  const selectableRows = Boolean(document.querySelector('.asset-center-page .ant-table-selection-column'))

  const knowledgeTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('知识库'))
  knowledgeTab?.click()
  const knowledgePage = Boolean(await waitFor('.knowledge-page'))
  const uploadButton = Boolean(document.querySelector('.knowledge-toolbar button'))
  const metrics = document.querySelectorAll('.knowledge-metric-grid .ant-card').length
  const filters = Boolean(document.querySelector('.knowledge-filter-bar'))
  const table = Boolean(document.querySelector('.knowledge-list-card .ant-table'))

  const dataTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('数据中心'))
  dataTab?.click()
  const dataPageRestored = Boolean(await waitFor('.asset-center-page .data-workbench-card'))

  const semanticizationMenu = clickMenu('AI 语义化')
  const semanticizationPage = await waitFor('.semanticization-page')
  const semanticizationText = semanticizationPage?.textContent ?? ''
  const noTaskSizeControl = !semanticizationPage?.querySelector('.asset-semantic-task-config') &&
    !semanticizationText.includes('单任务条数') &&
    !semanticizationText.includes('1–5')
  const fullBatchCopy = semanticizationText.includes('全部未就绪记录')
  const semanticizationActions = ['处理所选', '当前页待处理', '处理全部未语义化数据']
    .every((label) => semanticizationText.includes(label))
  const semanticizationTable = Boolean(semanticizationPage?.querySelector('.semanticization-records-card .ant-table'))
  const semanticizationSelection = Boolean(semanticizationPage?.querySelector('.ant-table-selection-column'))
  const modelSettingsAction = semanticizationText.includes('模型设置')
  const thinkingSwitch = semanticizationPage?.querySelector('[aria-label="语义化深度思考模式"]')
  const deepThinkingControl = Boolean(thinkingSwitch)
  const deepThinkingDefault = thinkingSwitch?.getAttribute('aria-checked') === 'true'

  const fixture = document.createElement('section')
  fixture.className = 'asset-semantic-audit'
  fixture.style.position = 'fixed'
  fixture.style.left = '-2400px'
  fixture.style.top = '0'
  fixture.style.width = '1000px'
  fixture.style.maxHeight = 'none'
  const stages = Array.from({ length: 8 }, (_, index) =>
    '<li><span class="asset-semantic-audit-timeline-marker"></span><div><div class="asset-semantic-audit-line"><strong>阶段 ' +
    (index + 1) + '</strong></div><span>用于验证较长阶段内容不会覆盖下一区域。</span></div></li>'
  ).join('')
  const events = Array.from({ length: 8 }, (_, index) =>
    '<div class="asset-semantic-audit-event"><span class="asset-semantic-audit-event-dot"></span><div><strong>事件 ' +
    (index + 1) + '</strong><p>结构化校验事件详情</p></div></div>'
  ).join('')
  fixture.innerHTML =
    '<div class="asset-semantic-audit-heading"><div><strong>可审计分析过程</strong></div></div>' +
    '<div class="asset-semantic-audit-grid">' +
    '<section class="asset-semantic-audit-section"><div class="asset-semantic-audit-section-heading"><span>阶段时间线</span></div><ol class="asset-semantic-audit-timeline-list">' + stages + '</ol></section>' +
    '<section class="asset-semantic-audit-section"><div class="asset-semantic-audit-section-heading"><span>校验与重试事件</span></div><div class="asset-semantic-audit-event-list">' + events + '</div></section>' +
    '</div><div class="asset-semantic-audit-output-grid"><details class="asset-semantic-audit-output" open><summary><span>初步分析</span></summary><div class="asset-semantic-audit-output-body"><p>阶段输出</p></div></details></div>'
  document.body.appendChild(fixture)
  const auditGrid = fixture.querySelector('.asset-semantic-audit-grid')
  const auditOutput = fixture.querySelector('.asset-semantic-audit-output-grid')
  const gridRect = auditGrid?.getBoundingClientRect()
  const outputRect = auditOutput?.getBoundingClientRect()
  const auditNoOverlap = Boolean(gridRect && outputRect && outputRect.top + 0.5 >= gridRect.bottom)
  const auditGridAutoRows = getComputedStyle(fixture).gridAutoRows
  fixture.remove()

  const actualAudit = semanticizationPage?.querySelector('.asset-semantic-audit')
  const actualGrid = actualAudit?.querySelector('.asset-semantic-audit-grid')?.getBoundingClientRect()
  const actualOutput = actualAudit?.querySelector('.asset-semantic-audit-output-grid')?.getBoundingClientRect()
  const actualAuditNoOverlap = !actualAudit || Boolean(actualGrid && actualOutput && actualOutput.top + 0.5 >= actualGrid.bottom)

  const modelSettingsButton = [...(semanticizationPage?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.includes('模型设置'))
  modelSettingsButton?.click()
  await waitFor('.settings-tabs')
  const activeSettingsTab = document.querySelector('.settings-tabs .ant-tabs-tab-active')?.textContent?.trim() ?? ''
  const modelSettingsDirect = activeSettingsTab.includes('大模型配置')
  clickMenu('AI 语义化')
  await waitFor('.semanticization-page')

  return {
    assetMenu,
    assetCenter: Boolean(assetCenter),
    tabs,
    dataPage,
    semanticFilter,
    semanticColumn,
    assetCenterHasNoTaskOperations,
    taskApi,
    selectableRows,
    knowledgePage,
    uploadButton,
    metrics,
    filters,
    table,
    dataPageRestored,
    semanticizationMenu,
    semanticizationPage: Boolean(semanticizationPage),
    semanticizationActions,
    semanticizationTable,
    semanticizationSelection,
    modelSettingsAction,
    deepThinkingControl,
    deepThinkingDefault,
    modelSettingsDirect,
    noTaskSizeControl,
    fullBatchCopy,
    auditNoOverlap,
    auditGridAutoRows,
    actualAuditNoOverlap
  }
})()`)

const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
const dataPageSource = appSource.slice(appSource.indexOf('function DataPage('), appSource.indexOf('function SemanticizationPage('))
const semanticizationPageSource = appSource.slice(appSource.indexOf('function SemanticizationPage('), appSource.indexOf('const knowledgeStatusMeta'))
const taskControls = ['暂停', '恢复', '停止'].every((label) => semanticizationPageSource.includes(`>${label}<`)) &&
  semanticizationPageSource.includes("controlSemanticization('pause')") &&
  semanticizationPageSource.includes("controlSemanticization('resume')") &&
  semanticizationPageSource.includes("controlSemanticization('stop')")
const assetCenterSourceSeparated = !dataPageSource.includes('startRequirementSemanticization') &&
  !dataPageSource.includes('SemanticAuditPanel') &&
  !dataPageSource.includes('asset-semantic-task-config')
const auditHistorySupport = semanticizationPageSource.includes('semanticAnalysisTrace') &&
  semanticizationPageSource.includes('persistedSemanticAuditTask(detail)') &&
  semanticizationPageSource.includes('<SemanticAuditPanel task={semanticTask')

if (!checks.assetMenu || !checks.assetCenter || !checks.dataPage || !checks.semanticFilter ||
    !checks.semanticColumn || !checks.assetCenterHasNoTaskOperations || !assetCenterSourceSeparated ||
    !checks.semanticizationMenu || !checks.semanticizationPage || !checks.semanticizationActions ||
    !checks.semanticizationTable || !checks.semanticizationSelection || !checks.modelSettingsAction ||
    !checks.modelSettingsDirect || !checks.deepThinkingControl || !checks.deepThinkingDefault ||
    !checks.noTaskSizeControl || !checks.fullBatchCopy ||
    !checks.taskApi || !taskControls || !auditHistorySupport || !checks.auditNoOverlap ||
    checks.auditGridAutoRows !== 'max-content' || !checks.actualAuditNoOverlap || !checks.selectableRows ||
    !checks.knowledgePage || !checks.uploadButton || !checks.filters || !checks.table ||
    !checks.dataPageRestored) {
  throw new Error(`Asset center and semanticization UI smoke failed: ${JSON.stringify(checks)}`)
}

await call('Page.enable')
const lightChecks = await evaluate(`(async () => {
  const toggle = document.querySelector('.window-theme-toggle')
  if (!toggle) return { toggled: false }
  if (document.documentElement.dataset.theme !== 'light') toggle.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const card = document.querySelector('.semanticization-launch-card')
  return {
    toggled: document.documentElement.dataset.theme === 'light',
    cardBackground: card ? getComputedStyle(card).backgroundColor : ''
  }
})()`)
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', 'visslm-semanticization.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))

const darkChecks = await evaluate(`(async () => {
  const toggle = document.querySelector('.window-theme-toggle')
  if (!toggle) return { toggled: false }
  if (document.documentElement.dataset.theme !== 'dark') toggle.click()
  await new Promise((resolve) => setTimeout(resolve, 250))
  const card = document.querySelector('.semanticization-launch-card')
  return {
    toggled: document.documentElement.dataset.theme === 'dark',
    cardBackground: card ? getComputedStyle(card).backgroundColor : ''
  }
})()`)
const darkScreenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const darkScreenshotPath = join(process.env.TEMP ?? '.', 'visslm-semanticization-dark.png')
writeFileSync(darkScreenshotPath, Buffer.from(darkScreenshot.result.data, 'base64'))

if (!lightChecks.toggled) throw new Error(`Semanticization light-theme smoke failed: ${JSON.stringify(lightChecks)}`)
if (!darkChecks.toggled) throw new Error(`Semanticization dark-theme smoke failed: ${JSON.stringify(darkChecks)}`)

console.log(JSON.stringify({
  ...checks,
  taskControls,
  assetCenterSourceSeparated,
  auditHistorySupport,
  screenshot: screenshotPath,
  lightTheme: lightChecks,
  darkTheme: darkChecks,
  darkScreenshot: darkScreenshotPath
}, null, 2))
socket.close()
