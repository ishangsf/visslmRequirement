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
  const message = JSON.parse(raw.toString('utf8'))
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
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

await call('Page.enable')
await call('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 1000))
const menuState = await evaluate(`(async () => {
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === 'AI 助手')
    ?.click();
  const started = Date.now();
  while (!document.querySelector('.composer textarea') && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const input = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, '@');
  input?.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const allCandidates = document.querySelectorAll('.expert-mention-menu [role="option"]').length;
  return { inputPresent: Boolean(input), allCandidates };
})()`)
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshot = join(process.env.TEMP, 'visslm-chat-mention.png')
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
const result = await evaluate(`(async () => {
  const input = document.querySelector('.composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  const allCandidates = document.querySelectorAll('.expert-mention-menu [role="option"]').length;
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const keyboardSelection = document.querySelector('.composer textarea')?.value;

  const filteredInput = document.querySelector('.composer textarea');
  setter?.call(filteredInput, '@可视');
  filteredInput?.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const filteredCandidates = document.querySelectorAll('.expert-mention-menu [role="option"]').length;
  filteredInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  return {
    allCandidates,
    keyboardSelection,
    filteredCandidates,
    visualizationSelection: document.querySelector('.composer textarea')?.value,
    menuClosed: !document.querySelector('.expert-mention-menu')
  };
})()`)

console.log(JSON.stringify({ ...menuState, ...result, screenshot }, null, 2))
socket.close()

if (
  !menuState.inputPresent ||
  result.allCandidates !== 3 ||
  !result.keyboardSelection?.startsWith('@通用数据助手') ||
  result.filteredCandidates !== 1 ||
  !result.visualizationSelection?.startsWith('@数据可视化专家') ||
  !result.menuClosed
) process.exitCode = 1
