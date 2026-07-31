import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import WebSocket from 'ws'

const port = process.env.VISSLM_CDP_PORT ?? '9225'
const mockPort = 19325
const mockServer = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url?.endsWith('/api/tags')) {
    response.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }))
    return
  }
  if (request.url?.endsWith('/models')) {
    response.end(JSON.stringify({ data: [{ id: 'test-model' }] }))
    return
  }
  response.statusCode = 404
  response.end(JSON.stringify({ error: 'not found' }))
})
await new Promise((resolve) => mockServer.listen(mockPort, '127.0.0.1', resolve))
let target
for (let attempt = 0; attempt < 50 && !target; attempt += 1) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
  } catch {
    // Electron may still be starting.
  }
  if (!target) await new Promise((resolve) => setTimeout(resolve, 200))
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

await call('Runtime.enable')
await call('Page.enable')
await evaluate(`window.visslm.saveModelSettings({
  source: 'online',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.2',
  thinking: true,
  apiKey: 'settings-smoke-key'
})`)
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 500))
const selectPoint = await evaluate(`(async () => {
  [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '系统配置')?.click();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const topTabs = [...document.querySelectorAll('.settings-tabs > .ant-tabs-nav .ant-tabs-tab')];
  topTabs.find((element) => element.textContent?.trim() === '大模型配置')?.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const modelSources = [...document.querySelectorAll('.model-settings-heading .ant-segmented-item')];
  const selects = [...document.querySelectorAll('.settings-panel .ant-select-content')];
  const rect = selects.find((element) => element.getBoundingClientRect().width > 0)?.getBoundingClientRect();
  return {
    point: rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null,
    selectCount: selects.length,
    sources: modelSources.map((element) => element.textContent?.trim())
  };
})()`)
if (selectPoint.point) {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...selectPoint.point })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...selectPoint.point })
}
await new Promise((resolve) => setTimeout(resolve, 150))
const checks = await evaluate(`(async () => {
  const topTabs = [...document.querySelectorAll('.settings-tabs > .ant-tabs-nav .ant-tabs-tab')];
  const modelSources = [...document.querySelectorAll('.model-settings-heading .ant-segmented-item')];
  const providerOptions = [...document.querySelectorAll('.ant-select-item-option')]
    .map((element) => element.textContent?.trim());
  const panel = document.querySelector('.settings-card')?.getBoundingClientRect();
  const content = document.querySelector('.app-content')?.getBoundingClientRect();
  return {
    topTabs: topTabs.map((element) => element.textContent?.trim()),
    modelSources: modelSources.map((element) => element.textContent?.trim()),
    providerOptions,
    selectDiagnostics: ${JSON.stringify(selectPoint)},
    settings: await window.visslm.getSettings(),
    selectedSource: document.querySelector('.model-settings-heading .ant-segmented-item-selected')?.textContent?.trim(),
    selectMarkup: document.querySelector('.settings-panel .ant-select')?.outerHTML?.slice(0, 800),
    onlineFields: [...document.querySelectorAll('.settings-panel .ant-form-item-label')]
      .map((element) => element.textContent?.trim()),
    thinkingVisible: [...document.querySelectorAll('.settings-panel .ant-form-item-label')]
      .some((element) => element.textContent?.trim() === '思考模式'),
    thinkingPersisted: (await window.visslm.getSettings()).model.thinking === true,
    apiKeyMasked: Boolean(document.querySelector('input[type="password"]')),
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    panelFitsContent: Boolean(panel && content && panel.right <= content.right + 1),
    viewport: { width: window.innerWidth, height: window.innerHeight }
  };
})()`)
const protocolChecks = await evaluate(`Promise.all([
  window.visslm.testModel({
    source: 'local', provider: 'ollama',
    baseUrl: 'http://127.0.0.1:${mockPort}/ollama', model: 'qwen3:8b', thinking: false
  }),
  window.visslm.testModel({
    source: 'online', provider: 'openai', apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:${mockPort}/openai', model: 'test-model', thinking: false
  }),
  window.visslm.testModel({
    source: 'online', provider: 'anthropic', apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:${mockPort}/anthropic', model: 'test-model', thinking: false
  })
])`)
const screenshot = join(process.env.TEMP, 'visslm-settings-online-models.png')
const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
writeFileSync(screenshot, Buffer.from(shot.result.data, 'base64'))
console.log(JSON.stringify({ checks, protocolChecks, screenshot }, null, 2))
socket.close()
await new Promise((resolve) => mockServer.close(resolve))
