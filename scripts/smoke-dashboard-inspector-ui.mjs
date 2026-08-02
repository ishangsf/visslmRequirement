import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9223'
const expectToolAudit = process.env.VISSLM_EXPECT_TOOL_AUDIT === '1'
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
const localOverviewDraftKey = 'visslm:dashboard-draft:local-overview'
const originalLocalOverviewDraft = await evaluate(
  `localStorage.getItem(${JSON.stringify(localOverviewDraftKey)})`
)
await evaluate(`localStorage.removeItem(${JSON.stringify(localOverviewDraftKey)})`)
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 700))

const checks = await evaluate(`(async () => {
  const expectToolAudit = ${JSON.stringify(expectToolAudit)}
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const isVisibleInViewport = (element) => {
    if (!element) return false
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.top < window.innerHeight
  }
  const waitForVisible = async (selector, timeout = 10000) => {
    const started = Date.now()
    let element = null
    while (!element && Date.now() - started < timeout) {
      element = [...document.querySelectorAll(selector)].find(isVisibleInViewport) ?? null
      if (!element) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return element
  }

  await waitFor('.ant-menu-item')
  const dashboardMenuItem = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('可视化大屏'))
  dashboardMenuItem?.click()
  await waitFor('.dashboard-studio')
  await waitFor('.dashboard-widget')

  const rectOf = (element) => {
    const rect = element?.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null
  }
  const rectsMatch = (first, second, tolerance = 1.5) => Boolean(first && second &&
    Math.abs(first.left - second.left) <= tolerance &&
    Math.abs(first.top - second.top) <= tolerance &&
    Math.abs(first.width - second.width) <= tolerance &&
    Math.abs(first.height - second.height) <= tolerance)
  const inspector = document.querySelector('.dashboard-inspector')
  const inspectorResizer = document.querySelector('.dashboard-inspector-resizer')
  const initialInspectorWidth = inspector?.getBoundingClientRect().width ?? 0
  const resizerAccessible = Boolean(
    inspectorResizer?.getAttribute('role') === 'separator' &&
    inspectorResizer?.getAttribute('aria-orientation') === 'vertical' &&
    inspectorResizer?.getAttribute('aria-label') &&
    inspectorResizer?.tabIndex === 0
  )
  const resizeStartX = inspector?.getBoundingClientRect().left ?? 0
  const resizeDelta = initialInspectorWidth < 360 ? -48 : 48
  inspectorResizer?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    pointerId: 41,
    pointerType: 'mouse',
    clientX: resizeStartX
  }))
  window.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 41,
    pointerType: 'mouse',
    clientX: resizeStartX + resizeDelta
  }))
  window.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 41,
    pointerType: 'mouse',
    clientX: resizeStartX + resizeDelta
  }))
  await new Promise((resolve) => setTimeout(resolve, 220))
  const draggedInspectorWidth = inspector?.getBoundingClientRect().width ?? 0
  const inspectorDragResizeWorks = Math.abs(draggedInspectorWidth - initialInspectorWidth) >= 30
  const keyboardKey = draggedInspectorWidth < 408 ? 'ArrowLeft' : 'ArrowRight'
  inspectorResizer?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: keyboardKey }))
  await new Promise((resolve) => setTimeout(resolve, 260))
  const keyboardInspectorWidth = inspector?.getBoundingClientRect().width ?? 0
  const inspectorKeyboardResizeWorks = Math.abs(keyboardInspectorWidth - draggedInspectorWidth) >= 10
  const storedInspectorWidth = Number(localStorage.getItem('visslm:dashboard-inspector-width:v1'))
  const inspectorWidthPersisted = Math.abs(storedInspectorWidth - keyboardInspectorWidth) <= 1

  const inspectorTitle = () => document.querySelector('.dashboard-inspector .dashboard-panel-title')?.textContent ?? ''
  const initiallySelected = inspectorTitle().includes('组件属性')
  const dashboardInfoHiddenWhenSelected = !document.querySelector('.dashboard-dashboard-info-editor')
  const componentDataVisible = Boolean(document.querySelector('.dashboard-component-data-editor'))
  const dataEditor = document.querySelector('.dashboard-component-data-editor')
  const dataEditorBackground = dataEditor
    ? getComputedStyle(dataEditor).backgroundColor
    : ''
  const themeProbe = document.createElement('span')
  themeProbe.style.background = 'var(--surface-soft)'
  dataEditor?.append(themeProbe)
  const expectedPanelBackground = getComputedStyle(themeProbe).backgroundColor
  themeProbe.remove()
  const selectedWidgetRectBeforeBlur = rectOf(document.querySelector('.dashboard-widget'))
  const studioBodyHeightBeforeBlur = document.querySelector('.dashboard-studio-body')?.getBoundingClientRect().height ?? 0

  document.querySelector('.dashboard-preview-header')?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    pointerId: 1,
    pointerType: 'mouse'
  }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const dashboardInspectorVisible = inspectorTitle().includes('大屏属性')
  const dashboardInfoVisible = Boolean(document.querySelector('.dashboard-dashboard-info-editor'))
  const globalFilterEditorVisible = Boolean(document.querySelector('.dashboard-global-filter-editor'))
  const componentDataHiddenOnBlur = !document.querySelector('.dashboard-component-data-editor')
  const titleInputVisible = Boolean(document.querySelector('#dashboard-title-editor'))
  const blurredWidgetRect = rectOf(document.querySelector('.dashboard-widget'))
  const studioBodyHeightAfterBlur = document.querySelector('.dashboard-studio-body')?.getBoundingClientRect().height ?? 0

  document.querySelector('.dashboard-widget')?.click()
  await new Promise((resolve) => setTimeout(resolve, 240))
  const componentInspectorRestored = inspectorTitle().includes('组件属性')
  const componentDataRestored = Boolean(document.querySelector('.dashboard-component-data-editor'))
  const dashboardInfoHiddenAgain = !document.querySelector('.dashboard-dashboard-info-editor')
  const restoredWidgetRect = rectOf(document.querySelector('.dashboard-widget'))
  const studioBodyHeightAfterRestore = document.querySelector('.dashboard-studio-body')?.getBoundingClientRect().height ?? 0
  const selectionKeepsCanvasLayout = rectsMatch(selectedWidgetRectBeforeBlur, blurredWidgetRect) &&
    rectsMatch(blurredWidgetRect, restoredWidgetRect)
  const selectionKeepsStudioHeight = Math.abs(studioBodyHeightBeforeBlur - studioBodyHeightAfterBlur) <= 1 &&
    Math.abs(studioBodyHeightAfterBlur - studioBodyHeightAfterRestore) <= 1

  const qualityButton = [...document.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '质量' && isVisibleInViewport(button))
  qualityButton?.click()
  const qualityScore = await waitForVisible('.dashboard-quality-score')
  const qualityDrawer = qualityScore?.closest('.ant-drawer')
  await new Promise((resolve) => setTimeout(resolve, 350))
  const qualityProbe = document.createElement('span')
  qualityProbe.style.background = 'var(--surface-soft)'
  qualityScore?.append(qualityProbe)
  const expectedQualityBackground = getComputedStyle(qualityProbe).backgroundColor
  qualityProbe.remove()
  const qualityScoreStyle = qualityScore ? getComputedStyle(qualityScore) : null
  const qualityDrawerVisible = Boolean(qualityScore)
  const qualityScoreUsesThemeSurface = qualityScoreStyle?.backgroundColor === expectedQualityBackground
  const qualityScoreAvoidsLightBackground = !['rgb(248, 250, 252)', 'rgb(255, 255, 255)']
    .includes(qualityScoreStyle?.backgroundColor ?? '')
  const repairButton = qualityDrawer?.querySelector(
    '.dashboard-quality .ant-list-item-action button'
  )
  const repairButtonAccessible = Boolean(repairButton?.getAttribute('aria-label')?.includes('修复组件'))
  const repairedComponentId = repairButton?.getAttribute('aria-label')?.replace('修复组件 ', '') ?? ''
  const widgetCountBeforeRepair = document.querySelectorAll('.dashboard-widget').length
  repairButton?.click()
  if (repairButton) {
    const started = Date.now()
    while (Date.now() - started < 10000) {
      const quality = qualityDrawer?.querySelector('.dashboard-quality')
      const targetRepairButton = [...(qualityDrawer?.querySelectorAll(
        '.dashboard-quality .ant-list-item-action button'
      ) ?? [])].find((button) => button.getAttribute('aria-label') === '修复组件 ' + repairedComponentId)
      if (quality?.getAttribute('aria-busy') === 'false' && !targetRepairButton) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const remainingRepairButtons = [...(qualityDrawer?.querySelectorAll(
    '.dashboard-quality .ant-list-item-action button'
  ) ?? [])]
  const repairedComponentIssueRemoved = Boolean(repairedComponentId) && !remainingRepairButtons.some(
    (button) => button.getAttribute('aria-label') === '修复组件 ' + repairedComponentId
  )
  const anotherInvalidComponentRemains = remainingRepairButtons.some(
    (button) => button.getAttribute('aria-label') !== '修复组件 ' + repairedComponentId
  )
  const repairSuccessPreservesDashboard = document.querySelectorAll('.dashboard-widget').length === widgetCountBeforeRepair
  const repairHasNoFailureAlert = !document.querySelector('.dashboard-quality-repair-alert')
  const toolAuditToggle = [...(qualityDrawer?.querySelectorAll(
    '.dashboard-run-detail .ant-collapse-header'
  ) ?? [])]
    .find((element) => /[1-9]\d* 次受控工具调用/.test(element.textContent ?? ''))
  if (expectToolAudit) {
    toolAuditToggle?.scrollIntoView({ block: 'center' })
    toolAuditToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    qualityDrawer?.querySelector('.dashboard-tool-audit')?.scrollIntoView({ block: 'center' })
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const toolAuditRows = qualityDrawer?.querySelectorAll('.dashboard-tool-audit > div') ?? []
  const toolAuditDisclosureVisible = !expectToolAudit || Boolean(toolAuditToggle)
  const toolAuditExpanded = !expectToolAudit || toolAuditRows.length >= 4
  const toolAuditShowsSafeMetadata = !expectToolAudit || [...toolAuditRows]
    .some((row) => row.textContent?.includes('扫描 50000') && row.textContent?.includes('截断 否'))
  const qualityDrawerWrapper = qualityDrawer?.querySelector('.ant-drawer-content-wrapper')
  qualityDrawer?.querySelector('.ant-drawer-close')?.click()
  if (qualityDrawerWrapper) {
    const started = Date.now()
    while (Date.now() - started < 3000) {
      const rect = qualityDrawerWrapper.getBoundingClientRect()
      const style = getComputedStyle(qualityDrawerWrapper)
      if (style.visibility === 'hidden' || style.display === 'none' || rect.left >= window.innerWidth - 1) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
  const qualityDrawerClosedBeforeProvenance = !qualityDrawerWrapper ||
    getComputedStyle(qualityDrawerWrapper).visibility === 'hidden' ||
    getComputedStyle(qualityDrawerWrapper).display === 'none' ||
    qualityDrawerWrapper.getBoundingClientRect().left >= window.innerWidth - 1

  const provenanceButton = [...document.querySelectorAll(
    '.dashboard-widget.selected .dashboard-provenance-button'
  )].find(isVisibleInViewport)
  provenanceButton?.click()
  const provenancePanel = provenanceButton
    ? await waitForVisible('.dashboard-provenance-drawer.ant-drawer-open .dashboard-provenance', 5000)
    : null
  await new Promise((resolve) => setTimeout(resolve, 180))
  const provenanceProbe = document.createElement('span')
  provenancePanel?.append(provenanceProbe)
  provenanceProbe.style.background = 'var(--surface-soft)'
  const expectedProvenanceSoft = getComputedStyle(provenanceProbe).backgroundColor
  provenanceProbe.style.background = 'var(--surface-raised)'
  const expectedProvenanceRaised = getComputedStyle(provenanceProbe).backgroundColor
  provenanceProbe.style.color = 'var(--accent)'
  const expectedProvenanceAccent = getComputedStyle(provenanceProbe).color
  provenanceProbe.remove()
  const provenanceHeading = provenancePanel?.querySelector('.dashboard-provenance-heading')
  const provenanceLabel = provenancePanel?.querySelector('.ant-descriptions-item-label')
  const provenanceContent = provenancePanel?.querySelector('.ant-descriptions-item-content')
  const provenanceTag = provenancePanel?.querySelector('.ant-tag')
  const provenanceCollapse = provenancePanel?.querySelector('.dashboard-provenance-query-collapse')
  const provenanceCollapseHeader = provenanceCollapse?.querySelector('.ant-collapse-header')
  const provenanceDrawerBody = document.querySelector('.dashboard-provenance-drawer .ant-drawer-body')
  const provenanceDrawerWrapper = document.querySelector(
    '.dashboard-provenance-drawer .ant-drawer-content-wrapper'
  )
  const provenanceLightBackgrounds = ['rgb(246, 249, 252)', 'rgb(248, 250, 252)', 'rgb(255, 255, 255)']
  const provenanceDrawerVisible = isVisibleInViewport(provenancePanel)
  const provenanceUsesThemeSurfaces = Boolean(
    provenanceHeading && provenanceLabel && provenanceContent && provenanceCollapse &&
    getComputedStyle(provenanceHeading).backgroundColor === expectedProvenanceSoft &&
    getComputedStyle(provenanceLabel).backgroundColor === expectedProvenanceSoft &&
    getComputedStyle(provenanceContent).backgroundColor === expectedProvenanceRaised &&
    getComputedStyle(provenanceCollapse).backgroundColor === expectedProvenanceSoft
  )
  const provenanceUsesAccent = Boolean(
    provenanceHeading &&
    getComputedStyle(provenanceHeading.querySelector('.anticon')).color === expectedProvenanceAccent
  )
  const provenanceAvoidsLightBackgrounds = Boolean(provenancePanel) && [
    provenanceHeading,
    provenanceLabel,
    provenanceContent,
    provenanceTag,
    provenanceCollapse
  ].every((element) => element && !provenanceLightBackgrounds.includes(
    getComputedStyle(element).backgroundColor
  ))
  const provenanceQueryCollapsedByDefault = provenanceCollapseHeader?.getAttribute('aria-expanded') === 'false'
  const provenanceDrawerResponsive = Boolean(provenanceDrawerWrapper) &&
    provenanceDrawerWrapper.getBoundingClientRect().width <= Math.min(500, window.innerWidth - 32) + 1
  const provenanceDrawerScrollsInternally = Boolean(provenanceDrawerBody) &&
    ['auto', 'scroll'].includes(getComputedStyle(provenanceDrawerBody).overflowY)

  return {
    resizerAccessible,
    inspectorDragResizeWorks,
    inspectorKeyboardResizeWorks,
    inspectorWidthPersisted,
    selectionKeepsCanvasLayout,
    selectionKeepsStudioHeight,
    initiallySelected,
    dashboardInfoHiddenWhenSelected,
    componentDataVisible,
    dataEditorUsesThemeSurface: dataEditorBackground === expectedPanelBackground,
    dashboardInspectorVisible,
    dashboardInfoVisible,
    globalFilterEditorVisible,
    componentDataHiddenOnBlur,
    titleInputVisible,
    componentInspectorRestored,
    componentDataRestored,
    dashboardInfoHiddenAgain,
    qualityDrawerVisible,
    qualityScoreUsesThemeSurface,
    qualityScoreAvoidsLightBackground,
    repairButtonAccessible,
    repairedComponentIssueRemoved,
    anotherInvalidComponentRemains,
    repairSuccessPreservesDashboard,
    repairHasNoFailureAlert,
    toolAuditDisclosureVisible,
    toolAuditExpanded,
    toolAuditShowsSafeMetadata,
    qualityDrawerClosedBeforeProvenance,
    provenanceDrawerVisible,
    provenanceUsesThemeSurfaces,
    provenanceUsesAccent,
    provenanceAvoidsLightBackgrounds,
    provenanceQueryCollapsedByDefault,
    provenanceDrawerResponsive,
    provenanceDrawerScrollsInternally
  }
})()`)

const failed = Object.entries(checks).filter(([, value]) => !value)
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const screenshotPath = join(tmpdir(), 'visslm-dashboard-inspector-smoke.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
await evaluate(`(() => {
  const key = ${JSON.stringify(localOverviewDraftKey)}
  const draft = ${JSON.stringify(originalLocalOverviewDraft)}
  if (draft === null) localStorage.removeItem(key)
  else localStorage.setItem(key, draft)
  return true
})()`)
await call('Page.reload')
socket.close()

console.log(JSON.stringify({ ok: failed.length === 0, checks, screenshotPath }, null, 2))
if (failed.length) throw new Error(`Dashboard inspector UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
