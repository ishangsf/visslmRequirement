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

const layout = await evaluate(`(async () => {
  const item = [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '数据中心');
  item?.click();
  const started = Date.now();
  while (
    ![...document.querySelectorAll('h2')].some((element) => element.textContent?.trim() === '数据中心') &&
    Date.now() - started < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.querySelector('.ant-table-tbody .ant-checkbox-input')?.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const buttons = [...document.querySelectorAll('button')];
  const deleteSelected = buttons.find((button) => button.textContent?.includes('删除所选'));
  return {
    configSyncRemoved: !buttons.some((button) => button.textContent?.includes('配置同步')),
    importButton: buttons.some((button) => button.textContent?.includes('导入数据')),
    exportButton: buttons.some((button) => button.textContent?.includes('导出数据')),
    oldExportRemoved: !buttons.some((button) => button.textContent?.includes('导出知识库')),
    deleteSelectedButton: Boolean(deleteSelected),
    deleteSelectedEnabled: Boolean(deleteSelected && !deleteSelected.disabled),
    deleteAllButton: buttons.some((button) => button.textContent?.includes('全部删除')),
    rowSelection: document.querySelectorAll('.ant-table-selection-column').length > 0,
    pushStatusColumn: [...document.querySelectorAll('.ant-table-thead th')]
      .some((element) => element.textContent?.trim() === '数据状态')
  };
})()`)
const overviewAndLogs = await evaluate(`(async () => {
  const openPage = async (label, heading) => {
    [...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === label)
      ?.click();
    const started = Date.now();
    while (
      ![...document.querySelectorAll('h2')]
        .some((element) => element.textContent?.trim() === heading) &&
      Date.now() - started < 10000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  };
  await openPage('数据概览', '数据概览');
  const metricTitles = [...document.querySelectorAll('.ant-statistic-title')]
    .map((element) => element.textContent?.trim());
  await openPage('数据采集', '数据采集');
  const collectionTabs = [...document.querySelectorAll('.ant-tabs-tab')]
    .map((element) => element.textContent?.trim() || '');
  [...document.querySelectorAll('.ant-tabs-tab')]
    .find((element) => element.textContent?.includes('请求日志'))
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const collectionRealLogCard = [...document.querySelectorAll('.ant-card-head-title')]
    .some((element) => element.textContent?.trim() === '真实采集请求日志');
  const collectionRealLogNotice = document.body.textContent
    ?.includes('测试预览不会写入日志');
  const previewRemovedFromLogTab = ![...document.querySelectorAll('.ant-card-head-title')]
    .some((element) => element.textContent?.trim() === '测试预览');
  const collectionLogColumns = ['请求时间', '数据类型', '请求接口', 'HTTP', '返回记录', '请求状态']
    .every((title) => [...document.querySelectorAll('.ant-table-thead th')]
      .some((element) => element.textContent?.trim() === title));
  await openPage('数据推送', '数据推送');
  const pushTabs = [...document.querySelectorAll('.ant-tabs-tab')]
    .map((element) => element.textContent?.trim() || '');
  const pushLogHiddenOnConfig = ![...document.querySelectorAll('.ant-card-head-title')]
    .some((element) => element.textContent?.trim() === '推送请求日志');
  [...document.querySelectorAll('.ant-tabs-tab')]
    .find((element) => element.textContent?.includes('请求日志'))
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    collectedMetric: metricTitles.includes('已采集数据'),
    pushedMetric: metricTitles.includes('已推送数据'),
    collectionTabs:
      collectionTabs.includes('采集配置') &&
      collectionTabs.some((label) => label.startsWith('请求日志')),
    collectionRealLogCard,
    collectionRealLogNotice,
    previewRemovedFromLogTab,
    collectionLogColumns,
    pushTabs:
      pushTabs.includes('推送配置') &&
      pushTabs.some((label) => label.startsWith('请求日志')),
    pushLogHiddenOnConfig,
    pushLogCard: [...document.querySelectorAll('.ant-card-head-title')]
      .some((element) => element.textContent?.trim() === '推送请求日志'),
    descriptionLogNotice: document.body.textContent?.includes('请求日志不保存 _valm_Description 字段'),
    pushLogColumns: ['请求时间', '数据', '目标类型', '项目 UID', 'HTTP', '请求状态', '远端 UID']
      .every((title) => [...document.querySelectorAll('.ant-table-thead th')]
        .some((element) => element.textContent?.trim() === title))
  };
})()`)
await call('Page.enable')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-data-actions-smoke.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
console.log(JSON.stringify({ ...layout, ...overviewAndLogs, screenshot }, null, 2))
socket.close()
