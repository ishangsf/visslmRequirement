import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
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

await call('Runtime.enable')
await call('Page.enable')
await call('Page.reload')
const checks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return Boolean(document.querySelector(selector))
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
    requirementDelete: true,
    requirementModuleColumn: true,
    technicalIndicatorMatch: true,
    agreementStatus: true,
    matchStatus: true,
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
    const moreActionsReady = await waitFor('.ant-dropdown .ant-menu')
    taskListFeatures.projectDelete = moreActionsReady && Boolean([...document.querySelectorAll('.ant-dropdown .ant-menu-item')]
      .find((item) => item.textContent?.includes('删除项目')))
    document.body.click()
    const requirementsTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('功能需求'))
    requirementsTab?.click()
    const requirementsReady = await waitFor('.project-requirements-stack')
    const requirementRows = document.querySelectorAll('.project-requirements-stack .ant-table-tbody tr.ant-table-row')
    const requirementModuleColumn = [...document.querySelectorAll('.project-requirements-stack .ant-table-thead th')]
      .some((header) => header.textContent?.includes('模块'))
    const requirementDeleteButton = document.querySelector('.project-requirements-stack button[aria-label^="删除功能需求："]')
    taskListFeatures.requirementDelete = requirementsReady && (!requirementRows.length || Boolean(requirementDeleteButton))
    taskListFeatures.requirementModuleColumn = requirementsReady && (!requirementRows.length || requirementModuleColumn)
    const technicalIndicatorSummary = document.querySelector('.project-heading-title-row .project-technical-match-capsule')
    const technicalIndicatorValue = technicalIndicatorSummary?.querySelector('strong')
    const technicalIndicatorValueStyle = technicalIndicatorValue ? getComputedStyle(technicalIndicatorValue) : null
    taskListFeatures.technicalIndicatorMatch = Boolean(technicalIndicatorSummary?.textContent?.includes('技术指标匹配度'))
      && Number.parseFloat(technicalIndicatorValueStyle?.fontSize ?? '0') >= 16
      && !document.querySelector('.project-health-match-summary')
    const agreementStatusCapsule = document.querySelector('.project-heading-title-row .project-agreement-status-capsule')
    taskListFeatures.agreementStatus = Boolean(agreementStatusCapsule?.textContent?.includes('协议识别完成'))
      && !document.querySelector('.project-inline-notice-success')
    const matchStatusCapsule = document.querySelector('.project-heading-title-row .project-match-status-capsule')
    taskListFeatures.matchStatus = Boolean(matchStatusCapsule?.textContent?.includes('匹配已完成'))
      && !document.querySelector('.project-heading-meta .project-heading-divider')
      && !document.querySelector('.project-heading-meta')?.textContent?.includes('分析状态')
    const planTab = [...document.querySelectorAll('.project-detail-page .ant-tabs-tab-btn')]
      .find((item) => item.textContent?.includes('项目计划'))
    planTab?.click()
    const planReady = await waitFor('.project-plan-table-card')
    const taskGanttReady = await waitFor('.project-task-gantt')
    const resourceGanttReady = await waitFor('.project-resource-gantt')
    const taskRow = [...document.querySelectorAll('.project-plan-table-card .ant-table-tbody tr')]
      .find((row) => row.classList.contains('ant-table-row'))
    const taskButtons = Array.from(taskRow?.querySelectorAll('button') ?? [])
    const taskDragHandle = taskRow?.querySelector('.project-task-drag-handle')
    const taskDragHandleStyle = taskDragHandle ? getComputedStyle(taskDragHandle) : null
    const parentColumn = [...document.querySelectorAll('.project-plan-table-card .ant-table-thead th')]
      .some((header) => header.textContent?.includes('父任务'))
    taskListFeatures = {
      taskPlanReady: detailReady && planReady,
      taskGanttReady: taskGanttReady && Boolean(document.querySelector('.project-task-gantt')?.textContent?.includes('任务甘特图')),
      resourceGanttReady: resourceGanttReady && Boolean(document.querySelector('.project-resource-gantt')?.textContent?.includes('人力资源甘特图')),
      inlineEdit: !taskRow || taskButtons.some((button) => button.textContent?.trim() === '编辑'),
      subtaskEntry: !taskRow || taskButtons.some((button) => button.textContent?.trim() === '子任务'),
      inlineCreate: true,
      parentColumnRemoved: !parentColumn,
      dragReady: !taskRow || Boolean(taskDragHandle && taskDragHandle.getAttribute('draggable') === 'false' && taskDragHandleStyle?.touchAction === 'none'),
      costResponsibleField: true,
      requirementDelete: taskListFeatures.requirementDelete,
      requirementModuleColumn: taskListFeatures.requirementModuleColumn,
      technicalIndicatorMatch: taskListFeatures.technicalIndicatorMatch,
      agreementStatus: taskListFeatures.agreementStatus,
      matchStatus: taskListFeatures.matchStatus,
      projectExport: taskListFeatures.projectExport,
      projectDelete: taskListFeatures.projectDelete
    }
    const quickEdit = taskButtons.find((button) => button.textContent?.trim() === '编辑')
    quickEdit?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    taskListFeatures.inlineEdit = taskListFeatures.inlineEdit
      && Boolean(taskRow?.querySelector('input, .ant-select'))
      && Boolean(Array.from(taskRow?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '保存'))
    Array.from(taskRow?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === '取消')?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const subtaskButton = Array.from(taskRow?.querySelectorAll('button') ?? [])
      .find((button) => button.textContent?.trim() === '子任务')
    subtaskButton?.click()
    const subtaskRowReady = await waitFor('.project-plan-new-row')
    taskListFeatures.subtaskEntry = taskListFeatures.subtaskEntry
      && subtaskRowReady
      && Boolean(document.querySelector('.project-plan-new-row input'))
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

  if (!checks.pageReady || !checks.listTable || !checks.organizationPeoplePage || !checks.createButton || !checks.importProjectButton || !checks.formReady || !checks.projectNameField || !checks.contractAmountField || !checks.projectOwnerSelects || !checks.taskPlanReady || !checks.taskGanttReady || !checks.resourceGanttReady || !checks.inlineEdit || !checks.subtaskEntry || !checks.inlineCreate || !checks.parentColumnRemoved || !checks.dragReady || !checks.costResponsibleField || !checks.requirementDelete || !checks.requirementModuleColumn || !checks.technicalIndicatorMatch || !checks.agreementStatus || !checks.matchStatus || !checks.projectExport || !checks.projectDelete) {
  throw new Error(`Project management UI smoke failed: ${JSON.stringify(checks)}`)
}

await call('Page.enable')
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', 'visslm-project-management.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
console.log(JSON.stringify({ ...checks, screenshot: screenshotPath }, null, 2))
socket.close()
