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

const result = await evaluate(`(async () => {
  const scope = {
    selectedTypes: ['TSIssue'],
    rules: [{
      nodeType: 'TSIssue',
      returnProperty: '_valm_Description',
      filters: [{
        id: crypto.randomUUID(),
        field: '_valm_Uid',
        operator: 'equals',
        value: '180668'
      }]
    }]
  };
  const sync = await window.visslm.startSync(scope);
  const preview = await window.visslm.previewSync();
  const detail = await window.visslm.getRecord('180668');
  return {
    sync,
    previewDescription: preview.samples[0]?.description ?? '',
    previewEndpoint: preview.requests[0]?.endpoint,
    previewReturnProperty: preview.requests[0]?.params.ReturnProperty,
    detailDescription: detail?.description ?? '',
    imageCount: detail?.images.length ?? 0,
    imageStoredAsBase64: Boolean(detail?.images[0]?.dataUri?.startsWith('data:image/'))
  };
})()`)

await evaluate(`(async () => {
  const item = [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '数据中心');
  item?.click();
  const started = Date.now();
  while (!document.querySelector('.table-link') && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  document.querySelector('.table-link')?.click();
  const drawerStarted = Date.now();
  while (!document.querySelector('.rich-description') && Date.now() - drawerStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})()`)
await call('Page.enable')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-description-smoke.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))

console.log(JSON.stringify({
  ...result,
  dataTableDescriptionColumn: await evaluate(`[
    ...document.querySelectorAll('.ant-table-thead th')
  ].some((element) => element.textContent?.trim() === '描述')`),
  drawerRichDescription: await evaluate(
    `Boolean(document.querySelector('.rich-description'))`
  ),
  drawerBase64Image: await evaluate(
    `Boolean(document.querySelector('.rich-description img[src^="data:image/"]'))`
  ),
  screenshot
}, null, 2))
socket.close()
