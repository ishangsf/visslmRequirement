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
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.includes('AI'))
    ?.click();
  const navigationStarted = Date.now();
  while (
    !document.querySelector('.composer textarea') &&
    Date.now() - navigationStarted < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!document.querySelector('.composer textarea')) {
    throw new Error('AI 助手输入框未出现');
  }
  const input = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, '帮我统计 Source 前3名的单位');
  input?.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.querySelector('.chat-send-button')?.click();
  const started = Date.now();
  while (!document.querySelector('.chat-data-action button') && Date.now() - started < 180000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const button = document.querySelector('.chat-data-action button');
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const modalOpen = Boolean(document.querySelector('.chat-data-modal'));
  const groupPicker = Boolean(document.querySelector('.chat-data-group-picker .ant-select'));
  const dataRows = document.querySelectorAll('.chat-data-modal .ant-table-tbody tr').length;
  const summary = document.querySelector('.chat-data-summary')?.textContent?.trim();
  document.querySelector('.chat-data-name-button')?.click();
  const detailStarted = Date.now();
  while (!document.querySelector('.chat-record-detail') && Date.now() - detailStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detailVisible = Boolean(document.querySelector('.chat-record-detail'));
  document.querySelector('.chat-record-back')?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  document.querySelector('.chat-data-modal .ant-modal-close')?.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const closeWorks = !document.querySelector('.chat-data-modal');
  button?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  document.querySelector('.chat-data-name-button')?.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    oldAnswerSourcesRemoved: !document.querySelector('.source-list'),
    viewButton: button?.textContent?.includes('查看查询数据'),
    modalOpen,
    modalTitle: document.querySelector('.chat-data-modal-title')?.textContent?.trim(),
    groupPicker,
    dataRows,
    summary,
    detailVisible,
    closeWorks,
    reopenedInDetail: Boolean(document.querySelector('.chat-record-detail'))
  };
})()`)

await call('Page.enable')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-chat-data-drawer.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
console.log(JSON.stringify({ ...result, screenshot }, null, 2))
socket.close()

if (
  !result.oldAnswerSourcesRemoved ||
  !result.viewButton ||
  !result.modalOpen ||
  !result.groupPicker ||
  result.dataRows < 1 ||
  !result.detailVisible ||
  !result.closeWorks ||
  !result.reopenedInDetail
) process.exitCode = 1
