import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const token = process.env.VISSLM_TEST_TOKEN
const username = process.env.VISSLM_TEST_USER
if (!token || !username) throw new Error('VISSLM_TEST_USER and VISSLM_TEST_TOKEN are required')

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

const evaluate = async (expression, timeout = 240_000) => {
  const timer = setTimeout(() => {
    throw new Error(`CDP evaluation timed out after ${timeout} ms`)
  }, timeout)
  try {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
    }
    return response.result?.result?.value
  } finally {
    clearTimeout(timer)
  }
}

await call('Runtime.enable')

const config = await evaluate(`(async () => {
  const platform = await window.visslm.savePlatformSettings({
    baseUrl: 'http://visionmc.vicp.net:889/alm',
    username: ${JSON.stringify(username)},
    token: ${JSON.stringify(token)}
  });
  const model = await window.visslm.saveModelSettings({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:8b',
    thinking: false
  });
  return { platform: platform.platform, model: model.model };
})()`)

const connections = await evaluate(`(async () => ({
  platform: await window.visslm.testPlatform(),
  model: await window.visslm.testModel()
}))()`)

const initialSyncConfig = await evaluate('window.visslm.getSyncConfig()')
const testScope = {
  selectedTypes: ['Task'],
  rules: [{
    nodeType: 'Task',
    returnProperty: '_valm_Name,_valm_ItemID',
    filters: [{
      id: crypto.randomUUID(),
      field: '_valm_Name',
      operator: 'equals',
      value: '<新任务>'
    }]
  }]
}
const sync = await evaluate(`window.visslm.startSync(${JSON.stringify(testScope)})`, 300_000)
const previewCheck = await evaluate(`(async () => {
  const before = await window.visslm.getStats();
  const result = await window.visslm.previewSync();
  const after = await window.visslm.getStats();
  return {
    result,
    databaseUnchanged:
      before.recordCount === after.recordCount &&
      before.imageCount === after.imageCount &&
      before.recentSyncs[0]?.id === after.recentSyncs[0]?.id,
    requestTraceComplete:
      result.requests.length > 0 &&
      result.requests.every((request) =>
        request.endpoint &&
        request.params.ApiToken === '******' &&
        ('response' in request || request.error)
      ),
    itemsQueryOnly:
      result.requests.length === 1 &&
      result.requests.every((request) =>
        request.endpoint.endsWith('/rest/items') &&
        request.params.VSearch &&
        request.params.ReturnProperty
      ),
    tokenRedacted:
      !JSON.stringify(result.requests).includes(${JSON.stringify(token)})
  };
})()`, 300_000)
const data = await evaluate(`(async () => ({
  stats: await window.visslm.getStats(),
  projects: await window.visslm.listProjects(),
  records: await window.visslm.listRecords({ page: 1, pageSize: 20 })
}))()`)

const agent = await evaluate(
  `window.visslm.askAgent({ question: '当前知识库一共有多少条记录？请按类型统计。' })`,
  240_000
)

await call('Page.enable')

const openPage = async (label) => {
  await evaluate(`(() => {
    const item = [...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === ${JSON.stringify(label)});
    if (!item) throw new Error('Menu item not found: ${label}');
    item.click();
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 1200))
}

await openPage('数据概览')
const hoverPoint = await evaluate(`(() => {
  const content = document.querySelector('.app-content');
  if (content) content.scrollTop = 0;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const chart = document.querySelector('.dashboard-chart')?.getBoundingClientRect();
      if (chart) {
        resolve({
          x: chart.left + chart.width * 0.58,
          y: chart.top + chart.height * 0.46
        });
        return;
      }
      if (Date.now() - started >= 10000) {
        resolve(null);
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
})()`)
if (hoverPoint) {
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: hoverPoint.x,
    y: hoverPoint.y
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
}
const tooltipLayout = hoverPoint ? await evaluate(`(() => {
  const chart = document.querySelector('.dashboard-chart')?.getBoundingClientRect();
  const tooltip = [...document.querySelectorAll('.dashboard-chart div')]
    .find((element) =>
      getComputedStyle(element).position === 'absolute' &&
      element.textContent?.includes('条')
    )?.getBoundingClientRect();
  return {
    text: [...document.querySelectorAll('.dashboard-chart div')]
      .find((element) =>
        getComputedStyle(element).position === 'absolute' &&
        element.textContent?.includes('条')
      )?.textContent,
    withinChart: Boolean(
      chart && tooltip &&
      tooltip.left >= chart.left &&
      tooltip.right <= chart.right &&
      tooltip.top >= chart.top &&
      tooltip.bottom <= chart.bottom
    ),
    tooltip: tooltip?.toJSON(),
    chart: chart?.toJSON()
  };
})()`) : { skipped: true }
const tooltipShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const tooltipScreenshot = join(process.env.TEMP, 'visslm-chart-tooltip-smoke.png')
writeFileSync(tooltipScreenshot, Buffer.from(tooltipShot.result.data, 'base64'))

const dashboardLayout = await evaluate(`(() => {
  const content = document.querySelector('.app-content');
  const chart = document.querySelector('.dashboard-chart');
  const card = document.querySelector('.dashboard-chart-card .ant-card-body');
  const lastChild = content?.querySelector('.page-stack > :last-child');
  if (content) content.scrollTop = content.scrollHeight;
  const contentRect = content?.getBoundingClientRect();
  const lastRect = lastChild?.getBoundingClientRect();
  return {
    windowInnerHeight: window.innerHeight,
    rootHeight: document.querySelector('#root')?.clientHeight,
    mainLayoutHeight: document.querySelector('.app-main-layout')?.clientHeight,
    contentClientHeight: content?.clientHeight,
    contentScrollHeight: content?.scrollHeight,
    contentScrollTop: content?.scrollTop,
    maxScrollTop: content ? content.scrollHeight - content.clientHeight : 0,
    overflowY: content ? getComputedStyle(content).overflowY : '',
    bottomFullyVisible: Boolean(
      contentRect && lastRect && lastRect.bottom <= contentRect.bottom + 1
    ),
    chart: chart?.getBoundingClientRect().toJSON(),
    chartCard: card?.getBoundingClientRect().toJSON()
  };
})()`)
const dashboardShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const dashboardScreenshot = join(process.env.TEMP, 'visslm-dashboard-smoke.png')
writeFileSync(dashboardScreenshot, Buffer.from(dashboardShot.result.data, 'base64'))

await openPage('数据同步')
const previewLayout = await evaluate(`(async () => {
  const started = Date.now();
  while (!document.querySelector('.sync-scope-form') && Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const previewButton = [...document.querySelectorAll('button')]
    .find((element) => element.textContent?.includes('测试预览'));
  const previewInitiallyEnabled = Boolean(previewButton && !previewButton.disabled);
  previewButton?.click();
  const previewStarted = Date.now();
  while (!document.querySelector('.sync-preview-card') && Date.now() - previewStarted < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    previewButton: Boolean(previewButton),
    previewInitiallyEnabled,
    previewCard: Boolean(document.querySelector('.sync-preview-card')),
    requestDebugPanels: document.querySelectorAll('.preview-request-collapse .ant-collapse-item').length,
    requestDebugTitle: [...document.querySelectorAll('.scope-subheading')]
      .some((element) => element.textContent?.includes('请求调试信息'))
  };
})()`)
const previewShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const previewScreenshot = join(process.env.TEMP, 'visslm-sync-preview-smoke.png')
writeFileSync(previewScreenshot, Buffer.from(previewShot.result.data, 'base64'))

const manualConfigLayout = await evaluate(`(async () => {
  const addCondition = [...document.querySelectorAll('button')]
    .find((element) => element.textContent?.includes('添加条件'));
  addCondition?.click();
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const headers = [...document.querySelectorAll('.filter-config-table th')]
    .map((element) => element.textContent?.trim());
  return {
    manualTypeInput: Boolean(document.querySelector('input[placeholder="输入数据类型"]')),
    addTypeButton: Boolean(
      [...document.querySelectorAll('button')]
        .find((element) => element.textContent?.includes('新增类型'))
    ),
    typeSelectCount: document.querySelectorAll('.manual-type-entry .ant-select').length,
    returnPropertyInput: Boolean(document.querySelector('.return-property-config .ant-select')),
    fieldKeyInput: Boolean(document.querySelector('input[placeholder="例如：_valm_Name"]')),
    headers,
    removedColumnsAbsent: !headers.includes('字段名称') && !headers.includes('属性类型')
  };
})()`)
const manualConfigShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const manualConfigScreenshot = join(process.env.TEMP, 'visslm-sync-manual-smoke.png')
writeFileSync(manualConfigScreenshot, Buffer.from(manualConfigShot.result.data, 'base64'))

const syncLayout = await evaluate(`(async () => {
  const started = Date.now();
  while (!document.querySelector('.sync-scope-form') && Date.now() - started < 30000) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const content = document.querySelector('.app-content');
  const lastChild = content?.querySelector('.page-stack > :last-child');
  if (content) content.scrollTop = content.scrollHeight;
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const contentRect = content?.getBoundingClientRect();
  const lastRect = lastChild?.getBoundingClientRect();
  return {
    windowInnerHeight: window.innerHeight,
    rootHeight: document.querySelector('#root')?.clientHeight,
    mainLayoutHeight: document.querySelector('.app-main-layout')?.clientHeight,
    contentClientHeight: content?.clientHeight,
    contentScrollHeight: content?.scrollHeight,
    contentScrollTop: content?.scrollTop,
    maxScrollTop: content ? content.scrollHeight - content.clientHeight : 0,
    overflowY: content ? getComputedStyle(content).overflowY : '',
    typePanels: document.querySelectorAll('.sync-type-collapse .ant-collapse-item').length,
    visibleScrollbar: content ? content.scrollHeight > content.clientHeight : false,
    bottomFullyVisible: Boolean(
      contentRect && lastRect && lastRect.bottom <= contentRect.bottom + 1
    )
  };
})()`)
const syncShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const syncScreenshot = join(process.env.TEMP, 'visslm-sync-smoke.png')
writeFileSync(syncScreenshot, Buffer.from(syncShot.result.data, 'base64'))

console.log(JSON.stringify({
  config,
  connections,
  initialSyncConfig,
  sync,
  previewCheck: {
    result: {
      scannedCount: previewCheck.result.scannedCount,
      matchedCount: previewCheck.result.matchedCount,
      byType: previewCheck.result.byType,
      sampleCount: previewCheck.result.samples.length,
      requestCount: previewCheck.result.requests.length
    },
    databaseUnchanged: previewCheck.databaseUnchanged,
    requestTraceComplete: previewCheck.requestTraceComplete,
    itemsQueryOnly: previewCheck.itemsQueryOnly,
    tokenRedacted: previewCheck.tokenRedacted
  },
  data,
  agent,
  visual: {
    dashboardLayout,
    tooltipLayout,
    previewLayout,
    manualConfigLayout,
    syncLayout,
    dashboardScreenshot,
    tooltipScreenshot,
    previewScreenshot,
    manualConfigScreenshot,
    syncScreenshot
  }
}, null, 2))
socket.close()
