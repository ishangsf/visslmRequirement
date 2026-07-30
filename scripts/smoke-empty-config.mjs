import WebSocket from 'ws'

const port = process.env.VISSLM_CDP_PORT ?? '9224'
let target
for (let attempt = 0; attempt < 40 && !target; attempt += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
  } catch {
    // The Electron renderer may still be starting.
  }
  if (!target) await new Promise((resolve) => setTimeout(resolve, 250))
}
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

const response = await call('Runtime.evaluate', {
  expression: `(async () => {
    const savedConfig = await window.visslm.getSyncConfig();
    const menuItem = [...document.querySelectorAll('.ant-menu-item')]
      .find((element) => element.textContent?.trim() === '数据同步');
    menuItem?.click();
    const started = Date.now();
    while (!document.querySelector('.sync-scope-form') && Date.now() - started < 10000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const previewButton = [...document.querySelectorAll('button')]
      .find((element) => element.textContent?.includes('测试预览'));
    return {
      savedConfig,
      typePanels: document.querySelectorAll('.sync-type-collapse .ant-collapse-item').length,
      emptyPrompt: document.body.textContent?.includes('尚未配置数据类型，请先手动新增'),
      previewDisabled: Boolean(previewButton?.disabled)
    };
  })()`,
  awaitPromise: true,
  returnByValue: true
})

if (response.result?.exceptionDetails) {
  throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
}
console.log(JSON.stringify(response.result?.result?.value, null, 2))
socket.close()
