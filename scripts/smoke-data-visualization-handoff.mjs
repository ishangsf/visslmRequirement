import WebSocket from 'ws'

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
    throw new Error(
      response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed'
    )
  }
  return response.result?.result?.value
}

await call('Page.enable')
await call('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 1000))
const result = await evaluate(`(async () => {
  document.querySelector('.ant-modal-close')?.click();
  document.querySelector('.ant-drawer-close')?.click();
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '数据中心')
    ?.click();
  const dataStarted = Date.now();
  while (!document.querySelector('.filter-bar') && Date.now() - dataStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rowStarted = Date.now();
  while (
    !document.querySelector('.ant-table-tbody .ant-checkbox-wrapper') &&
    Date.now() - rowStarted < 10000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const rowCheckbox = document.querySelector('.ant-table-tbody .ant-checkbox-input');
  const rowCheckboxControl = document.querySelector(
    '.ant-table-tbody .ant-checkbox-wrapper'
  );
  rowCheckboxControl?.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const handoffButton = [...document.querySelectorAll('.page-toolbar button')]
    .find((element) => element.textContent?.includes('交给可视化专家'));
  const enabled = handoffButton && !handoffButton.disabled;
  handoffButton?.click();
  const chatStarted = Date.now();
  while (!document.querySelector('.chat-data-scope') && Date.now() - chatStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const input = document.querySelector('.composer textarea');
  const scopeText = document.querySelector('.chat-data-scope')?.textContent?.trim();
  return {
    checkboxFound: Boolean(rowCheckboxControl),
    rowSelected: Boolean(rowCheckbox?.checked),
    buttonFound: Boolean(handoffButton),
    buttonEnabled: Boolean(enabled),
    chatOpened: document.querySelector('.content-page-title')?.textContent?.trim() === 'AI 助手',
    mentionPrefilled: input?.value?.startsWith('@数据可视化专家') ?? false,
    scopeVisible:
      (scopeText?.includes('已选') && scopeText.includes('条记录')) ?? false,
    scopeText
  };
})()`)

console.log(JSON.stringify(result, null, 2))
socket.close()

if (
  !result.checkboxFound ||
  !result.rowSelected ||
  !result.buttonFound ||
  !result.buttonEnabled ||
  !result.chatOpened ||
  !result.mentionPrefilled ||
  !result.scopeVisible
) process.exitCode = 1
