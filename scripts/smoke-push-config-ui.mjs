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

const checks = await evaluate(`(async () => {
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '数据推送')
    ?.click();
  const started = Date.now();
  while (
    ![...document.querySelectorAll('h2')]
      .some((element) => element.textContent?.trim() === '数据推送') &&
    Date.now() - started < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  [...document.querySelectorAll('.ant-tabs-tab')]
    .find((element) => element.textContent?.trim() === '推送配置')
    ?.click();
  const configStarted = Date.now();
  while (!document.querySelector('.compact-push-config-card') && Date.now() - configStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  [...document.querySelectorAll('button')]
    .find((element) => element.textContent?.includes('新增映射'))
    ?.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const inputs = [...document.querySelectorAll('.push-mapping-table input')];
  const setInput = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  if (inputs[0]) setInput(inputs[0], '_valm_LastModifyTime');
  if (inputs[1]) setInput(inputs[1], 'MappedLastModifyTime');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const card = document.querySelector('.compact-push-config-card');
  return {
    requiredFields: Boolean(document.querySelector('#nodeType') && document.querySelector('#projectId')),
    advancedCollapsed: !document.querySelector('.push-advanced-collapse .ant-collapse-item-active'),
    mappingRows: document.querySelectorAll('.push-mapping-table .ant-table-tbody tr').length,
    mappingInputs: document.querySelectorAll('.push-mapping-table input').length,
    mappingValues: [...document.querySelectorAll('.push-mapping-table input')].map((input) => input.value),
    compactCardHeight: card ? Math.round(card.getBoundingClientRect().height) : 0,
    dataTableVisible: Boolean(document.querySelector('.ant-table-tbody'))
  };
})()`)

await call('Page.enable')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-push-compact-config.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
console.log(JSON.stringify({ ...checks, screenshot }, null, 2))
socket.close()
