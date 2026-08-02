import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9230'
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
await new Promise((resolve) => setTimeout(resolve, 700))

const dashboardSetup = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now();
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return document.querySelector(selector);
  };
  await waitFor('.ant-menu-item');
  [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('可视化大屏'))?.click();
  await waitFor('.dashboard-studio');
  await waitFor('.dashboard-widget');
  [...document.querySelectorAll('.dashboard-studio-actions button')]
    .find((button) => button.textContent?.trim() === 'AI 修改')?.click();
  const snapshotDrawer = await waitFor('.dashboard-ai-drawer');
  const snapshotContext = snapshotDrawer?.querySelector('.dashboard-ai-context')?.textContent ?? '';
  const snapshotComposer = snapshotDrawer?.querySelector('textarea');
  const snapshotPlaceholder = snapshotComposer?.getAttribute('placeholder') ?? '';
  const snapshotOriginalTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? '';
  const snapshotValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  snapshotValueSetter?.call(snapshotComposer, '只把当前快照组件的标题改为“快照AI测试”');
  snapshotComposer?.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  [...(snapshotDrawer?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '发送')?.click();
  const snapshotChange = await waitFor('.dashboard-ai-change-summary', 30000);
  const snapshotChangedTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? '';
  const snapshotChangeText = snapshotChange?.textContent ?? '';
  [...(snapshotChange?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '撤销')?.click();
  const snapshotUndoStartedAt = Date.now();
  while (!snapshotChange?.textContent?.includes('修改已撤销') &&
      Date.now() - snapshotUndoStartedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const snapshotRestoredTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? '';
  snapshotDrawer?.querySelector('.ant-drawer-close')?.click();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const selector = document.querySelector('.dashboard-selector')?.getBoundingClientRect();
  return {
    point: selector ? { x: selector.left + selector.width / 2, y: selector.top + selector.height / 2 } : null,
    snapshotModeContext: snapshotContext.includes('展示快照'),
    snapshotModePlaceholder: snapshotPlaceholder.includes('更简洁的标题'),
    snapshotPatchApplied: snapshotChangedTitle !== snapshotOriginalTitle,
    snapshotQueryImpact: snapshotChangeText.includes('重算 0 个查询'),
    snapshotUndoRestored: snapshotRestoredTitle === snapshotOriginalTitle
  };
})()`)
if (dashboardSetup?.point) {
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', clickCount: 1, ...dashboardSetup.point
  })
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', clickCount: 1, ...dashboardSetup.point
  })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const optionPoint = await evaluate(`(() => {
    const option = [...document.querySelectorAll('.ant-select-item-option')]
      .find((item) => item.getBoundingClientRect().width > 0)?.getBoundingClientRect();
    return option ? { x: option.left + option.width / 2, y: option.top + option.height / 2 } : null;
  })()`)
  if (optionPoint) {
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...optionPoint })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...optionPoint })
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}
const interactionChecks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }

  await waitFor('.ant-menu-item')
  const dashboardMenuItem = [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('可视化大屏'))
  await waitFor('.dashboard-studio')
  await waitFor('.dashboard-widget')

  const aiButton = [...document.querySelectorAll('.dashboard-studio-actions button')]
    .find((button) => button.textContent?.trim() === 'AI 修改')
  aiButton?.click()
  const drawer = await waitFor('.dashboard-ai-drawer')
  const context = await waitFor('.dashboard-ai-context')
  const composer = await waitFor('.dashboard-ai-composer textarea')
  const selectedContext = context?.textContent ?? ''
  const selectedPlaceholder = composer?.getAttribute('placeholder') ?? ''

  document.querySelector('.dashboard-preview-header')?.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    pointerId: 1,
    pointerType: 'mouse'
  }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const wholeDashboardContext = context?.textContent ?? ''
  const wholeDashboardPlaceholder = composer?.getAttribute('placeholder') ?? ''

  document.querySelector('.dashboard-widget')?.click()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const restoredComponentContext = context?.textContent ?? ''
  const sendButton = [...(drawer?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '发送')
  const emptySendDisabled = Boolean(sendButton?.disabled)
  const originalComponentTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? ''
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  valueSetter?.call(composer, '只把当前选中组件的标题改为“AI回执测试一”')
  composer?.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const enabledSendButton = [...(drawer?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '发送')
  enabledSendButton?.click()
  const firstChangeSummary = await waitFor('.dashboard-ai-change-summary', 30000)
  const firstChangedComponentTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? ''
  const firstChangeSummaryText = firstChangeSummary?.textContent ?? ''

  valueSetter?.call(composer, '只把当前选中组件的标题改为“AI回执测试二”')
  composer?.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 80))
  const secondSendButton = [...(drawer?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '发送')
  secondSendButton?.click()
  const secondStartedAt = Date.now()
  while (document.querySelectorAll('.dashboard-ai-change-summary').length < 2 &&
      Date.now() - secondStartedAt < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const changeSummaries = [...document.querySelectorAll('.dashboard-ai-change-summary')]
  const secondChangeSummary = changeSummaries[1]
  const secondChangedComponentTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? ''
  const secondUndoButton = [...(secondChangeSummary?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '撤销')
  secondUndoButton?.click()
  const secondUndoStartedAt = Date.now()
  while (!secondChangeSummary?.textContent?.includes('修改已撤销') &&
      Date.now() - secondUndoStartedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const titleAfterSecondUndo = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? ''
  const firstUndoStartedAt = Date.now()
  let firstUndoButton = [...(firstChangeSummary?.querySelectorAll('button') ?? [])]
    .find((button) => button.textContent?.trim() === '撤销')
  while (!firstUndoButton && Date.now() - firstUndoStartedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    firstUndoButton = [...(firstChangeSummary?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === '撤销')
  }
  firstUndoButton?.click()
  const finalUndoStartedAt = Date.now()
  while (!firstChangeSummary?.textContent?.includes('修改已撤销') &&
      Date.now() - finalUndoStartedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const restoredComponentTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent ?? ''

  return {
    dashboardOpened: Boolean(dashboardMenuItem),
    aiButtonEnabled: Boolean(aiButton && !aiButton.disabled),
    drawerVisible: Boolean(drawer),
    drawerKeepsCanvasContext: !document.querySelector('.ant-drawer-mask'),
    selectedComponentContext: selectedContext.includes('仅修改组件：'),
    selectedComponentPlaceholder: selectedPlaceholder.includes('改为折线图并按月展示'),
    wholeDashboardContext: wholeDashboardContext.includes('未选中组件，可修改大屏标题、主题或组件'),
    wholeDashboardPlaceholder: wholeDashboardPlaceholder.includes('大屏主标题'),
    componentContextRestored: restoredComponentContext.includes('仅修改组件：'),
    messageLogAccessible: document.querySelector('.dashboard-ai-message-list')?.getAttribute('role') === 'log',
    composerEnabled: Boolean(composer && !composer.disabled),
    emptySendDisabled,
    firstPatchApplied: Boolean(firstChangeSummary && firstChangedComponentTitle !== originalComponentTitle),
    secondPatchApplied: Boolean(secondChangeSummary && secondChangedComponentTitle !== firstChangedComponentTitle),
    changeReceiptVisible: firstChangeSummaryText.includes('已应用到当前草稿'),
    queryImpactVisible: firstChangeSummaryText.includes('重算 1 个查询'),
    secondUndoEnabled: Boolean(secondUndoButton && !secondUndoButton.disabled),
    secondUndoRestoredFirstPatch: titleAfterSecondUndo === firstChangedComponentTitle,
    firstUndoEnabledAfterSecondUndo: Boolean(firstUndoButton && !firstUndoButton.disabled),
    bothUndosConfirmed: Boolean(
      firstChangeSummary?.textContent?.includes('修改已撤销') &&
      secondChangeSummary?.textContent?.includes('修改已撤销')
    ),
    allAiChangesRestored: restoredComponentTitle === originalComponentTitle
  }
})()`)
const checks = {
  snapshotModeContext: Boolean(dashboardSetup?.snapshotModeContext),
  snapshotModePlaceholder: Boolean(dashboardSetup?.snapshotModePlaceholder),
  snapshotPatchApplied: Boolean(dashboardSetup?.snapshotPatchApplied),
  snapshotQueryImpact: Boolean(dashboardSetup?.snapshotQueryImpact),
  snapshotUndoRestored: Boolean(dashboardSetup?.snapshotUndoRestored),
  ...interactionChecks
}

const failed = Object.entries(checks).filter(([, value]) => !value)
const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const screenshotPath = join(tmpdir(), 'visslm-dashboard-ai-drawer-smoke.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
socket.close()

console.log(JSON.stringify({ ok: failed.length === 0, checks, screenshotPath }, null, 2))
if (failed.length) {
  throw new Error(`Dashboard AI drawer UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
}
