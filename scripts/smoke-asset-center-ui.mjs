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
  await waitForActiveTab('知识库')
  const knowledgePage = Boolean(await waitForVisible('.knowledge-page'))
  const uploadButton = Boolean(document.querySelector('.knowledge-toolbar button'))
  const metrics = document.querySelectorAll('.knowledge-metric-grid .ant-card').length
  const filters = Boolean(document.querySelector('.knowledge-filter-bar'))
  const table = Boolean(document.querySelector('.knowledge-list-card .ant-table'))

  const dataTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('数据中心'))
  dataTab?.click()
  await waitForActiveTab('数据中心')
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

  const semanticizationMenu = clickMenu('AI 语义化')
  const semanticizationPage = await waitForVisible('.semanticization-page')
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
  const semanticResultFieldMarkup = [
    ['需求动作', '创建'],
    ['功能对象', '需求语义化记录'],
    ['功能行为', '生成结构化语义结果']
  ].map(([label, value]) =>
    '<div class="asset-semantic-result-field" role="listitem"><div class="asset-semantic-result-field-heading"><span>' +
    label + '</span></div><div class="asset-semantic-result-value">' + value + '</div></div>'
  ).join('')
  fixture.innerHTML =
    '<div class="asset-semantic-audit-heading"><div><strong>可审计分析过程</strong></div></div>' +
    '<section class="asset-semantic-result-summary" aria-label="最终结构化语义结果">' +
    '<div class="asset-semantic-result-heading"><div><div class="asset-semantic-result-title"><span>最终语义化结果</span></div><span>基于最终裁决字段汇总</span></div><span class="asset-semantic-result-state is-completed">已完成 · 结构化结果</span></div>' +
    '<div class="asset-semantic-result-grid" role="list" aria-label="最终语义化核心字段">' + semanticResultFieldMarkup + '</div></section>' +
    '<div class="asset-semantic-audit-grid">' +
    '<section class="asset-semantic-audit-section"><div class="asset-semantic-audit-section-heading"><span>阶段时间线</span></div><ol class="asset-semantic-audit-timeline-list">' + stages + '</ol></section>' +
    '<section class="asset-semantic-audit-section"><div class="asset-semantic-audit-section-heading"><span>校验与重试事件</span></div><div class="asset-semantic-audit-event-list">' + events + '</div></section>' +
    '</div><div class="asset-semantic-audit-output-grid"><details class="asset-semantic-audit-output" open><summary><span>初步分析</span></summary><div class="asset-semantic-audit-output-body"><p>阶段输出</p></div></details></div>'
  document.body.appendChild(fixture)
  const resultSummary = fixture.querySelector('.asset-semantic-result-summary')
  const resultHeading = resultSummary?.querySelector('.asset-semantic-result-heading')
  const resultFieldNodes = [...(resultSummary?.querySelectorAll('.asset-semantic-result-field') ?? [])]
  const resultValueNodes = [...(resultSummary?.querySelectorAll('.asset-semantic-result-value') ?? [])]
  const resultLabels = [...(resultSummary?.querySelectorAll('.asset-semantic-result-field-heading') ?? [])]
    .map((item) => item.textContent?.trim() ?? '')
  const semanticResultHasFieldValue = resultFieldNodes.length > 0 &&
    resultValueNodes.length > 0 &&
    resultValueNodes.some((item) => Boolean(item.textContent?.trim()))
  const semanticResultRepresentativeFields = ['需求动作', '功能对象', '功能行为']
    .every((label) => resultLabels.some((value) => value.includes(label)))
  const auditGrid = fixture.querySelector('.asset-semantic-audit-grid')
  const auditOutput = fixture.querySelector('.asset-semantic-audit-output-grid')
  const resultRect = resultSummary?.getBoundingClientRect()
  const gridRect = auditGrid?.getBoundingClientRect()
  const outputRect = auditOutput?.getBoundingClientRect()
  const semanticResultBeforeAuditGrid = Boolean(resultSummary && auditGrid &&
    (resultSummary.compareDocumentPosition(auditGrid) & Node.DOCUMENT_POSITION_FOLLOWING))
  const semanticResultNoOverlap = Boolean(resultRect && gridRect && gridRect.top + 0.5 >= resultRect.bottom)
  const auditNoOverlap = Boolean(gridRect && outputRect && outputRect.top + 0.5 >= gridRect.bottom)
  const auditGridAutoRows = getComputedStyle(fixture).gridAutoRows
  fixture.remove()

  const actualAudit = semanticizationPage?.querySelector('.asset-semantic-audit')
  const actualResult = actualAudit?.querySelector('.asset-semantic-result-summary')
  const actualGridElement = actualAudit?.querySelector('.asset-semantic-audit-grid')
  const actualGrid = actualGridElement?.getBoundingClientRect()
  const actualOutput = actualAudit?.querySelector('.asset-semantic-audit-output-grid')?.getBoundingClientRect()
  const actualResultRect = actualResult?.getBoundingClientRect()
  const actualResultBeforeAuditGrid = !actualAudit || Boolean(actualResult && actualGridElement &&
    (actualResult.compareDocumentPosition(actualGridElement) & Node.DOCUMENT_POSITION_FOLLOWING))
  const actualResultNoOverlap = !actualAudit || Boolean(actualResultRect && actualGrid && actualGrid.top + 0.5 >= actualResultRect.bottom)
  const actualAuditNoOverlap = !actualAudit || Boolean(actualResultBeforeAuditGrid && actualResultNoOverlap &&
    actualGrid && actualOutput && actualOutput.top + 0.5 >= actualGrid.bottom)

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
    maintenanceEntryPresent,
    maintenancePreview,
    maintenanceActions,
    maintenanceScope,
    maintenanceApi,
    detailReadiness,
    detailOptimizeAction,
    detailMatchingText,
    detailRawCollapsed,
    semanticResultSummary: Boolean(resultSummary),
    semanticResultHeading: Boolean(resultHeading),
    semanticResultHasFieldValue,
    semanticResultRepresentativeFields,
    semanticResultBeforeAuditGrid,
    semanticResultNoOverlap,
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
const semanticAuditViewSource = appSource.slice(appSource.indexOf('const buildSemanticAuditView = ('), appSource.indexOf('const persistedSemanticAuditTask = ('))
const semanticAuditPanelSource = appSource.slice(appSource.indexOf('const buildSemanticAuditView = ('), appSource.indexOf('const featureNavigationItems'))
const semanticResultClassNames = [
  'asset-semantic-result-summary',
  'asset-semantic-result-heading',
  'asset-semantic-result-grid',
  'asset-semantic-result-field',
  'asset-semantic-result-value'
].every((className) => semanticAuditPanelSource.includes(className))
const semanticResultFieldPath = semanticAuditViewSource.includes('payload.finalAdjudication') &&
  semanticAuditViewSource.includes('semanticAuditFieldsOf(finalAdjudication)') &&
  semanticAuditViewSource.includes("semanticAuditStagePayloadOf(payload, 'adjudication')") &&
  semanticAuditViewSource.includes('semanticAuditFieldsOf(adjudicationPayload)') &&
  semanticAuditViewSource.includes('semanticResultFieldsOf(adjudicatedFields)') &&
  semanticAuditPanelSource.includes('view.finalFields.map')
const semanticResultSummarySource = semanticResultClassNames && semanticResultFieldPath &&
  semanticAuditPanelSource.includes('buildSemanticAuditView(task, records, history)')
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

if (!checks.assetMenu || !checks.assetCenter || !checks.dataPage || !checks.semanticFilter ||
    !checks.semanticColumn || !checks.assetCenterHasNoTaskOperations || !assetCenterSourceSeparated ||
    !checks.semanticizationMenu || !checks.semanticizationPage || !checks.semanticizationActions ||
    !checks.semanticizationTable || !checks.semanticizationSelection || !checks.modelSettingsAction ||
    !checks.modelSettingsDirect || !checks.deepThinkingControl || !checks.deepThinkingDefault ||
    !checks.noTaskSizeControl || !checks.fullBatchCopy ||
    !checks.maintenanceEntryPresent || !checks.maintenancePreview || !checks.maintenanceActions ||
    !checks.maintenanceScope || !checks.maintenanceApi || !checks.detailReadiness ||
    !checks.detailOptimizeAction || !checks.detailMatchingText || !checks.detailRawCollapsed ||
    !maintenanceSource || !maintenanceDetailSource ||
    !checks.taskApi || !taskControls || !auditHistorySupport || !semanticResultSummarySource ||
    !checks.semanticResultHasFieldValue || !checks.semanticResultRepresentativeFields ||
    !checks.semanticResultBeforeAuditGrid || !checks.semanticResultNoOverlap || !checks.auditNoOverlap ||
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
  semanticResultClassNames,
  semanticResultFieldPath,
  semanticResultSummarySource,
  maintenanceSource,
  maintenanceDetailSource,
  screenshot: screenshotPath,
  lightTheme: lightChecks,
  darkTheme: darkChecks,
  darkScreenshot: darkScreenshotPath
}, null, 2))
socket.close()
