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

const preview = await evaluate(`(async () => {
  const records = await window.visslm.listRecords({ page: 1, pageSize: 1 });
  if (!records.rows[0]) throw new Error('数据中心没有可用于预览的本地记录');
  return window.visslm.previewPush({
    recordUids: [records.rows[0].uid],
    nodeType: 'TargetType',
    projectId: 'target-project',
    componentId: 'target-component',
    parentId: 'target-parent',
    insertAfterId: '-1',
    fieldMappings: [{
      id: 'mapping-1',
      sourceField: '_valm_LastModifyTime',
      targetField: 'MappedLastModifyTime'
    }]
  });
})()`)
const request = preview.requests[0]

const ui = await evaluate(`(async () => {
  const menu = [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '数据推送');
  menu?.click();
  const started = Date.now();
  while (
    ![...document.querySelectorAll('h2')].some((element) => element.textContent?.trim() === '数据推送') &&
    Date.now() - started < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const setInput = (id, value) => {
    const input = document.querySelector('#' + id);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setInput('nodeType', 'TargetType');
  setInput('projectId', 'target-project');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const checkbox = document.querySelector('.ant-table-tbody .ant-checkbox-input');
  if (checkbox && !checkbox.checked) checkbox.click();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const previewButton = [...document.querySelectorAll('button')]
    .find((element) => element.textContent?.includes('测试预览'));
  previewButton?.click();
  const previewStarted = Date.now();
  while (!document.querySelector('.push-debug-card') && Date.now() - previewStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    collectionMenuRenamed: [...document.querySelectorAll('.ant-menu-item')]
      .some((element) => element.textContent?.trim() === '数据采集'),
    oldSyncMenuRemoved: ![...document.querySelectorAll('.ant-menu-item')]
      .some((element) => element.textContent?.trim() === '数据同步'),
    pushPage: Boolean(document.querySelector('.push-debug-card')),
    nodeTypeRequired: Boolean(document.querySelector('#nodeType')),
    projectIdRequired: Boolean(document.querySelector('#projectId')),
    requestPanels: document.querySelectorAll('.push-request-collapse .ant-collapse-item').length
  };
})()`)

await call('Page.enable')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-push-preview-smoke.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
await evaluate(`document.querySelector('.push-debug-card')?.scrollIntoView({ block: 'start' })`)
await new Promise((resolve) => setTimeout(resolve, 200))
const debugShot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const debugScreenshot = join(process.env.TEMP, 'visslm-push-debug-smoke.png')
writeFileSync(debugScreenshot, Buffer.from(debugShot.result.data, 'base64'))

console.log(JSON.stringify({
  previewOnly: preview.preview,
  previewResponse: request.response,
  method: request.method,
  endpoint: request.endpoint,
  params: request.params,
  body: request.body,
  endpointCorrect: request.endpoint.endsWith('/alm/rest/items'),
  requiredParamsCorrect:
    request.params.nodeType === 'TargetType' &&
    request.params.projectId === 'target-project',
  optionalParamsCorrect:
    request.params.componentId === 'target-component' &&
    request.params.parentId === 'target-parent' &&
    request.params.insertAfterId === '-1',
  tokenRedacted: request.params.ApiToken === '******',
  forbiddenBodyFieldsRemoved:
    !('_valm_Uid' in request.body) &&
    !('_valm_NodeType' in request.body) &&
    !('_valm_ItemID' in request.body),
  fieldMappingApplied:
    !('_valm_LastModifyTime' in request.body) &&
    'MappedLastModifyTime' in request.body,
  ui,
  screenshot,
  debugScreenshot
}, null, 2))
socket.close()
