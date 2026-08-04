import WebSocket from 'ws'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const projectPageSource = readFileSync(join(process.cwd(), 'src/renderer/src/project-management/ProjectManagementPage.tsx'), 'utf8')
const relationshipGraphSource = readFileSync(join(process.cwd(), 'src/renderer/src/project-management/ProjectRelationshipGraph.tsx'), 'utf8')
const projectStylesSource = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
const detailTabsSource = projectPageSource.slice(projectPageSource.indexOf('className="project-detail-tabs"'))
const relationshipTabOrderContract = detailTabsSource.lastIndexOf("key: 'relationships'") > detailTabsSource.lastIndexOf("key: 'knowledge'")
const analysisLogCollapseContract = projectPageSource.includes('aria-expanded={analysisLogsExpanded}')
  && projectPageSource.includes('aria-controls={`project-analysis-log-list-${current.id}`}')
  && projectPageSource.includes("setAnalysisLogsExpanded((expanded) => !expanded)")
  && projectPageSource.includes('const [analysisLogsExpanded, setAnalysisLogsExpanded] = useState(false)')
  && projectPageSource.includes('const matchingTaskIds = new Set(nextLogs')
  && projectPageSource.includes('const latestIsAgreementLog = nextLogs[0]?.taskType === \'agreement\'')
  && projectPageSource.includes('if (hasNewAgreementLog) setAnalysisLogsExpanded(true)')
  && projectPageSource.includes('const agreementAnalysisLogs = analysisLogs.filter((log) => !matchingTaskIds.has(log.taskId))')
  && projectPageSource.includes('project-match-progress')
  && projectPageSource.includes('progress={projectProgress}')
  && projectStylesSource.includes('.project-analysis-log-panel.is-collapsed')
  && projectStylesSource.includes('.project-match-progress')
const projectMatchingSettingsContract = appSource.includes("key: 'general'")
  && appSource.includes('saveProjectMatchingSettings')
  && appSource.includes('name="minScore"')
  && appSource.includes('默认 40%')
  && appSource.includes('settings-matching-section')
  && !appSource.includes("key: 'matching'")
const requirementStatusFilterContract = projectPageSource.includes('requirementStatusFilter')
  && projectPageSource.includes('status: requirementStatusFilter')
  && projectPageSource.includes('clearRequirementStatusFilter')
  && projectPageSource.includes('data-status="unmarked"')
  && projectPageSource.includes('data-status="satisfied"')
  && projectPageSource.includes('data-status="to_develop"')
  && projectPageSource.includes('data-status="to_negotiate"')
  && projectStylesSource.includes('.project-requirement-filter-bar')
const linkedAssetListContract = projectPageSource.includes('project-linked-assets-card')
  && projectPageSource.includes('hiddenLinkedAssetUids')
  && projectPageSource.includes('onUnlinkAssetRequirement')
  && projectPageSource.includes('window.visslm.unlinkProjectAssetRequirement')
  && projectPageSource.includes('project-linked-asset-score')
  && projectPageSource.includes('matchScore.toFixed(1)')
  && projectPageSource.includes('excludeProjectAssetProjectId')
  && projectStylesSource.includes('.project-linked-assets-list')
const relationshipGraphContract = projectPageSource.includes("import { ProjectRelationshipGraph } from './ProjectRelationshipGraph'")
  && projectPageSource.includes('const [allRequirements, setAllRequirements] = useState<ProjectRequirement[]>([])')
  && projectPageSource.includes('window.visslm.listAllProjectRequirements(project.id)')
  && projectPageSource.includes("key: 'relationships'")
  && projectPageSource.includes("setActiveTab('relationships')")
  && relationshipTabOrderContract
  && relationshipGraphSource.includes('project-relationship-page')
  && projectStylesSource.includes('.project-relationship-chart')
  && projectStylesSource.includes('.project-relationship-node-index')
  && relationshipGraphSource.includes("const [viewMode, setViewMode] = useState<RelationshipGraphMode>('flow')")
  && relationshipGraphSource.includes("layout: viewMode === 'flow' ? 'none' : 'force'")
  && relationshipGraphSource.includes('上游路径')
  && relationshipGraphSource.includes('下游路径')
  && relationshipGraphSource.includes('const laneOffset')
  && relationshipGraphSource.includes('const buildFlowDisplayGraph')
  && relationshipGraphSource.includes('flow-group:')
  && relationshipGraphSource.includes('expandedFlowKinds')
  && relationshipGraphSource.includes('收起展开节点')
  && relationshipGraphSource.includes('UpOutlined')
  && relationshipGraphSource.includes('disabled={expandedFlowKinds.size === 0}')
  && relationshipGraphSource.includes('const nodeKindCounts')
  && relationshipGraphSource.includes('selectedNodeLinks.length > 16')
  && relationshipGraphSource.includes('columnGap = dense ? 48 : 72')
  && relationshipGraphSource.includes('isCanvasFullscreen')
  && relationshipGraphSource.includes('退出画布全屏')
  && projectStylesSource.includes('.project-relationship-canvas-heading-actions')
  && projectStylesSource.includes('.project-relationship-flow-guide')
  && projectStylesSource.includes('.project-relationship-path-summary')
  && projectStylesSource.includes('.project-relationship-page.is-canvas-fullscreen')

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
  if (response.error) {
    throw new Error(response.error.message || 'Renderer protocol evaluation failed')
  }
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

await call('Runtime.enable')
await call('Page.enable')
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 1000))
await evaluate(`(async () => {
  const projects = await window.visslm.listManagedProjects({ page: 1, pageSize: 20, search: '' })
  if (projects.rows.length) return false
  const project = await window.visslm.createManagedProject({
    projectName: 'Project relationship UI smoke',
    customerName: 'Smoke customer',
    contractAmount: 100000,
    estimatedCost: 24000,
    estimatedDurationDays: 30
  })
  // Requirement creation requires an active review set; the backend smoke covers published requirements.
  return true
})()`)
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 1000))
const checks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return Boolean(document.querySelector(selector))
  }
  const waitForGone = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return !document.querySelector(selector)
  }

  await waitFor('.ant-menu-item')
  const menuItem = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('项目管理'))
  menuItem?.click()
  const pageReady = await waitFor('.project-management-page')
  const listTable = Boolean(document.querySelector('.project-management-page .ant-table'))
  const peopleTab = [...document.querySelectorAll('.project-module-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('组织人员'))
  peopleTab?.click()
  const organizationPeoplePage = await waitFor('.organization-people-page')
  const projectTab = [...document.querySelectorAll('.project-module-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('项目列表'))
  projectTab?.click()
  await waitFor('.project-management-page')
  const createButton = [...document.querySelectorAll('.project-management-page button')]
    .find((item) => item.textContent?.includes('手动创建项目'))
  const importProjectButton = [...document.querySelectorAll('.project-management-page button')]
    .find((item) => item.textContent?.includes('导入项目数据'))
  createButton?.click()
  const formReady = await waitFor('.ant-modal .project-form-grid')
  const formLabels = [...document.querySelectorAll('.ant-modal .ant-form-item-label')]
    .map((item) => item.textContent?.trim())
  const projectOwnerSelects = document.querySelectorAll('.ant-modal .project-form-grid .ant-select').length >= 3

  document.querySelector('.ant-modal-close')?.click()
  await new Promise((resolve) => setTimeout(resolve, 200))
  let taskListFeatures = {
    taskPlanReady: true,
    taskGanttReady: true,
    resourceGanttReady: true,
    inlineEdit: true,
    subtaskEntry: true,
    inlineCreate: true,
    parentColumnRemoved: true,
    dragReady: true,
    costResponsibleField: true,
    requirementReviewPolicy: true,
    requirementModuleColumn: true,
    technicalIndicatorMatch: true,
    agreementStatus: true,
    matchStatus: true,
    analysisLogCollapse: ${analysisLogCollapseContract},
    projectMatchingSettings: ${projectMatchingSettingsContract},
    requirementStatusFilter: ${requirementStatusFilterContract},
    linkedAssetList: ${linkedAssetListContract},
    relationshipGraph: ${relationshipGraphContract},
    projectExport: true,
    projectDelete: true
  }
  const projectLink = document.querySelector('.project-management-page .project-name-link')
  if (projectLink) {
    projectLink.click()
    const detailReady = await waitFor('.project-detail-page')
    taskListFeatures.projectExport = Boolean([...document.querySelectorAll('.project-detail-page button')]
      .find((button) => button.textContent?.includes('导出完整数据')))
    const moreActionsButton = [...document.querySelectorAll('.project-detail-page button')]
      .find((button) => button.textContent?.includes('更多操作'))
    moreActionsButton?.click()
    const moreActionsReady = await waitFor('.ant-dropdown .ant-dropdown-menu')
    taskListFeatures.projectDelete = moreActionsReady && Boolean([...document.querySelectorAll('.ant-dropdown .ant-dropdown-menu-item')]
      .find((item) => item.textContent?.includes('删除项目')))
    document.body.click()
    const requirementsTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('需求清单'))
    requirementsTab?.click()
    const requirementsReady = await waitFor('.project-requirements-stack')
    const requirementRows = document.querySelectorAll('.project-requirements-stack .ant-table-tbody tr.ant-table-row')
    const requirementModuleColumn = [...document.querySelectorAll('.project-requirements-stack .ant-table-thead th')]
      .some((header) => header.textContent?.includes('模块'))
    const requirementDeleteButton = document.querySelector('.project-requirements-stack button[aria-label^="删除功能需求："]')
    const requirementReviewGate = document.querySelector('.project-requirements-stack .project-review-gate')
    const requirementStatusCards = [...document.querySelectorAll('.project-requirements-stack .project-requirement-stat')]
    const requirementStatusCardKeys = new Set(requirementStatusCards.map((card) => card.getAttribute('data-status')))
    const requirementStatusCardsReady = requirementStatusCardKeys.size === 4
    let requirementStatusFilterReady = requirementStatusCardsReady
    if (requirementStatusCardsReady) {
      const satisfiedStatusCard = requirementStatusCards.find((card) => card.getAttribute('data-status') === 'satisfied')
      const satisfiedCount = Number.parseInt(satisfiedStatusCard?.getAttribute('aria-label')?.match(/共 ([0-9]+) 条/)?.[1] ?? '', 10)
      satisfiedStatusCard?.click()
      requirementStatusFilterReady = await waitFor('.project-requirements-stack .project-requirement-filter-bar')
      const filterBar = document.querySelector('.project-requirements-stack .project-requirement-filter-bar')
      const filteredRows = [...document.querySelectorAll('.project-requirements-stack .ant-table-tbody tr.ant-table-row')]
      const filteredRowsMatchStatus = filteredRows.every((row) => row.querySelector('.ant-select-selection-item')?.textContent?.trim() === '已满足')
      const filteredCountMatches = Number.isFinite(satisfiedCount) && filterBar?.textContent?.includes('共 ' + satisfiedCount + ' 条需求')
      requirementStatusFilterReady = requirementStatusFilterReady && Boolean(filteredCountMatches) && filteredRowsMatchStatus
      const clearFilterButton = [...document.querySelectorAll('.project-requirements-stack .project-requirement-filter-bar button')]
        .find((button) => button.textContent?.includes('清除过滤'))
      requirementStatusFilterReady = requirementStatusFilterReady && Boolean(clearFilterButton)
      clearFilterButton?.click()
      requirementStatusFilterReady = requirementStatusFilterReady && await waitForGone('.project-requirements-stack .project-requirement-filter-bar')
    }
    const reviewGateButtons = [...(requirementReviewGate?.querySelectorAll('button') ?? [])]
    const hasBulkReview = reviewGateButtons.some((button) => button.textContent?.includes('批量通过'))
      && reviewGateButtons.some((button) => button.textContent?.includes('批量驳回'))
    const hasPublishGate = reviewGateButtons.some((button) => button.textContent?.includes('发布并开始匹配'))
    taskListFeatures.requirementReviewPolicy = requirementsReady && (!requirementRows.length || (
      requirementReviewGate
        ? Boolean(requirementDeleteButton && hasBulkReview && hasPublishGate)
        : !requirementDeleteButton
    ))
    taskListFeatures.requirementModuleColumn = requirementsReady && (!requirementRows.length || requirementModuleColumn)
    const technicalIndicatorSummary = document.querySelector('.project-heading-title-row .project-technical-match-capsule')
    const technicalIndicatorValue = technicalIndicatorSummary?.querySelector('strong')
    const technicalIndicatorValueStyle = technicalIndicatorValue ? getComputedStyle(technicalIndicatorValue) : null
    taskListFeatures.technicalIndicatorMatch = Boolean(technicalIndicatorSummary?.textContent?.includes('技术指标匹配度'))
      && Number.parseFloat(technicalIndicatorValueStyle?.fontSize ?? '0') >= 16
      && !document.querySelector('.project-health-match-summary')
    const agreementStatusCapsule = document.querySelector('.project-heading-title-row .project-agreement-status-capsule')
    const agreementDocumentChip = document.querySelector('.project-document-chip')
    taskListFeatures.agreementStatus = agreementDocumentChip
      ? Boolean(agreementStatusCapsule?.textContent?.includes('协议识别完成'))
        && !document.querySelector('.project-inline-notice-success')
      : !agreementStatusCapsule
    const matchStatusCapsule = document.querySelector('.project-heading-title-row .project-match-status-capsule')
    taskListFeatures.matchStatus = (!matchStatusCapsule || Boolean(matchStatusCapsule.textContent?.includes('匹配已完成')))
      && !document.querySelector('.project-heading-meta .project-heading-divider')
      && !document.querySelector('.project-heading-meta')?.textContent?.includes('分析状态')
    taskListFeatures.requirementStatusFilter = requirementStatusFilterReady || Boolean(requirementReviewGate)
    const relationshipTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('关系图谱'))
    relationshipTab?.click()
    const relationshipReady = await waitFor('.project-relationship-page')
    const relationshipCanvas = await waitFor('.project-relationship-chart canvas, .project-relationship-chart svg, .project-relationship-chart .ant-empty')
    const relationshipStats = document.querySelectorAll('.project-relationship-stat').length >= 4
    const relationshipNodeIndex = Boolean(document.querySelector('.project-relationship-node-index'))
    taskListFeatures.relationshipGraph = ${relationshipGraphContract}
      && Boolean(relationshipTab)
      && relationshipReady
      && relationshipCanvas
      && relationshipStats
      && relationshipNodeIndex
    const planTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('项目计划'))
    planTab?.click()
    const planReady = await waitFor('.project-plan-table-card')
    const taskGanttReady = await waitFor('.project-task-gantt')
    const resourceGanttReady = await waitFor('.project-resource-gantt')
    await waitFor('.project-plan-table-card .project-task-title-cell, .project-plan-table-card .ant-table-placeholder')
    const taskRow = [...document.querySelectorAll('.project-plan-table-card .ant-table-tbody tr')]
      .find((row) => row.classList.contains('ant-table-row') && row.querySelector('.project-task-title-cell'))
    const taskButtons = Array.from(taskRow?.querySelectorAll('button') ?? [])
    const taskDragHandle = taskRow?.querySelector('.project-task-drag-handle')
    const taskDragHandleStyle = taskDragHandle ? getComputedStyle(taskDragHandle) : null
    const parentColumn = [...document.querySelectorAll('.project-plan-table-card .ant-table-thead th')]
      .some((header) => header.textContent?.includes('父任务'))
    taskListFeatures = {
      taskPlanReady: detailReady && planReady,
      taskGanttReady: taskGanttReady && Boolean(document.querySelector('.project-task-gantt')?.textContent?.includes('任务甘特图')),
      resourceGanttReady: resourceGanttReady && Boolean(document.querySelector('.project-resource-gantt')?.textContent?.includes('人力资源甘特图')),
      inlineEdit: !taskRow || taskButtons.some((button) => button.textContent?.trim() === '编辑' || button.getAttribute('aria-label')?.startsWith('编辑任务：')),
      subtaskEntry: !taskRow || taskButtons.some((button) => button.textContent?.trim() === '子任务' || button.getAttribute('aria-label')?.includes('新增子任务')),
      inlineCreate: true,
      parentColumnRemoved: !parentColumn,
      dragReady: !taskRow || Boolean(taskDragHandle && taskDragHandle.getAttribute('draggable') === 'false' && taskDragHandleStyle?.touchAction === 'none'),
      costResponsibleField: true,
      requirementReviewPolicy: taskListFeatures.requirementReviewPolicy,
      requirementModuleColumn: taskListFeatures.requirementModuleColumn,
      technicalIndicatorMatch: taskListFeatures.technicalIndicatorMatch,
      agreementStatus: taskListFeatures.agreementStatus,
      matchStatus: taskListFeatures.matchStatus,
       analysisLogCollapse: taskListFeatures.analysisLogCollapse,
       projectMatchingSettings: taskListFeatures.projectMatchingSettings,
       requirementStatusFilter: taskListFeatures.requirementStatusFilter,
       linkedAssetList: taskListFeatures.linkedAssetList,
       relationshipGraph: taskListFeatures.relationshipGraph,
       projectExport: taskListFeatures.projectExport,
      projectDelete: taskListFeatures.projectDelete
    }
    const quickEdit = taskButtons.find((button) => button.textContent?.trim() === '编辑' || button.getAttribute('aria-label')?.startsWith('编辑任务：'))
    quickEdit?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    taskListFeatures.inlineEdit = !taskRow || (taskListFeatures.inlineEdit
      && Boolean(taskRow.querySelector('input, .ant-select'))
      && Boolean(Array.from(taskRow.querySelectorAll('button')).find((button) => button.textContent?.trim() === '保存')))
    Array.from(taskRow?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '取消')?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const subtaskButton = Array.from(taskRow?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.trim() === '子任务' || button.getAttribute('aria-label')?.includes('新增子任务'))
    subtaskButton?.click()
    const subtaskRowReady = subtaskButton ? await waitFor('.project-plan-new-row') : true
    taskListFeatures.subtaskEntry = !taskRow || (taskListFeatures.subtaskEntry
      && subtaskRowReady
      && Boolean(document.querySelector('.project-plan-new-row input')))
    document.querySelector('.project-plan-new-row button')?.textContent?.trim() === '取消'
      ? [...document.querySelectorAll('.project-plan-new-row button')].find((button) => button.textContent?.trim() === '取消')?.click()
      : undefined
    const addPlanButton = [...document.querySelectorAll('.project-plan-summary button')]
      .find((button) => button.textContent?.includes('新增计划项'))
    addPlanButton?.click()
    taskListFeatures.inlineCreate = (await waitFor('.project-plan-new-row'))
      && Boolean(document.querySelector('.project-plan-new-row input'))
    ;[...document.querySelectorAll('.project-plan-new-row button')].find((button) => button.textContent?.trim() === '取消')?.click()

    const costTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('成本台账'))
    costTab?.click()
    const costReady = await waitFor('.project-detail-page .ant-table')
    const costAddButton = [...document.querySelectorAll('.project-detail-page button')]
      .find((button) => button.textContent?.includes('新增成本'))
    costAddButton?.click()
    const costModalReady = await waitFor('.ant-modal .ant-form')
    const costLabels = [...document.querySelectorAll('.ant-modal .ant-form-item-label')]
      .map((item) => item.textContent?.trim())
    taskListFeatures.costResponsibleField = costReady && costModalReady && costLabels.some((label) => label?.includes('责任人'))
    document.querySelector('.ant-modal-close')?.click()
  }

  return {
    pageReady,
    listTable,
    organizationPeoplePage,
    createButton: Boolean(createButton),
    formReady,
    projectNameField: formLabels.some((label) => label?.includes('项目名称')),
    contractAmountField: formLabels.some((label) => label?.includes('合同金额')),
    projectOwnerSelects,
    importProjectButton: Boolean(importProjectButton),
    ...taskListFeatures
  }
})()`)

  if (!checks.pageReady || !checks.listTable || !checks.organizationPeoplePage || !checks.createButton || !checks.importProjectButton || !checks.formReady || !checks.projectNameField || !checks.contractAmountField || !checks.projectOwnerSelects || !checks.taskPlanReady || !checks.taskGanttReady || !checks.resourceGanttReady || !checks.inlineEdit || !checks.subtaskEntry || !checks.inlineCreate || !checks.parentColumnRemoved || !checks.dragReady || !checks.costResponsibleField || !checks.requirementReviewPolicy || !checks.requirementModuleColumn || !checks.technicalIndicatorMatch || !checks.agreementStatus || !checks.matchStatus || !checks.analysisLogCollapse || !checks.projectMatchingSettings || !checks.requirementStatusFilter || !checks.linkedAssetList || !checks.relationshipGraph || !checks.projectExport || !checks.projectDelete) {
  throw new Error(`Project management UI smoke failed: ${JSON.stringify(checks)}`)
}

await call('Page.enable')
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', 'visslm-project-management.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
console.log(JSON.stringify({ ...checks, screenshot: screenshotPath }, null, 2))
socket.close()
