import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import WebSocket from 'ws'

const port = process.env.VISSLM_CDP_PORT ?? '9225'
const mockPort = 19325
const savedOnlineBaseUrl = `http://127.0.0.1:${mockPort}/openai`
const savedOnlineModel = 'settings-smoke-saved-model'
const savedOnlineApiKey = 'settings-smoke-key-after-reveal'
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
await evaluate(`window.visslm.saveModelSettings(${JSON.stringify({
  source: 'online',
  provider: 'openai',
  baseUrl: savedOnlineBaseUrl,
  model: savedOnlineModel,
  thinking: true,
  apiKey: savedOnlineApiKey
})})`)
await call('Page.reload')
await new Promise((resolve) => setTimeout(resolve, 500))
const navigationChecks = await evaluate(`(async () => {
  const waitFor = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const isVisible = (node) => {
    if (!node || node.getAttribute('aria-hidden') === 'true') return false
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' &&
      rect.width > 0 && rect.height > 0
  }
  const waitForVisible = async (selector, timeout = 10000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const node = [...document.querySelectorAll(selector)].find(isVisible)
      if (node) return node
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return [...document.querySelectorAll(selector)].find(isVisible) ?? null
  }
  const sourceItems = () => [...document.querySelectorAll('.model-settings-heading .ant-segmented-item')]
  const sourceKeyOf = (item) => {
    const input = item.querySelector('input[type="radio"]')
    const labelledSource = item.querySelector('[data-model-source]')?.dataset.modelSource
    const candidates = [
      labelledSource,
      item.getAttribute('data-segmented-item-key'),
      item.getAttribute('data-value'),
      input?.getAttribute('value'),
      input?.value
    ]
    return candidates.find((value) => value === 'local' || value === 'online') ?? null
  }
  const sourceItem = (key) => sourceItems()
    .find((item) => sourceKeyOf(item) === key && isVisible(item))
  const modelPanel = () => document.querySelector('.model-settings-heading')?.closest('.settings-panel')
  const labelTextOf = (item) => (item.querySelector('.ant-form-item-label')?.textContent ?? '')
    .replace(/\\s+/g, ' ')
    .trim()
  const formItem = (label) => [...(modelPanel()?.querySelectorAll('.ant-form-item') ?? [])]
    .find((item) => isVisible(item) && labelTextOf(item).startsWith(label))
  const fieldInput = (label) => formItem(label)?.querySelector('input:not([type="hidden"])') ?? null
  const sourceSnapshot = () => {
    const items = sourceItems().map((item) => ({
      key: sourceKeyOf(item),
      visible: isVisible(item),
      selected: item.classList.contains('ant-segmented-item-selected') || Boolean(item.querySelector('input:checked'))
    }))
    const selected = items.find((item) => item.visible && item.selected)?.key ?? null
    return {
      all: items,
      visible: items.filter((item) => item.visible && item.key).map((item) => item.key),
      active: selected
    }
  }
  const fieldSnapshot = () => ({
    localAddressVisible: Boolean(formItem('Ollama 地址')),
    onlineAddressVisible: Boolean(formItem('API 地址')),
    providerVisible: Boolean(formItem('模型服务商')),
    apiKeyVisible: Boolean(formItem('API Key')),
    modelName: fieldInput('模型名称')?.value ?? null,
    baseUrl: fieldInput('Ollama 地址')?.value ?? fieldInput('API 地址')?.value ?? null
  })

  await waitFor('.ant-menu-item')
  const settingsMenuItem = [...document.querySelectorAll('.ant-menu-item')]
    .find((element) => element.textContent?.trim() === '系统配置')
  settingsMenuItem?.click()
  const settingsTabs = await waitFor('.settings-tabs')
  const modelTab = [...document.querySelectorAll('.settings-tabs > .ant-tabs-nav .ant-tabs-tab')]
    .find((element) => element.textContent?.trim() === '大模型配置')
  modelTab?.click()
  const modelHeading = await waitForVisible('.model-settings-heading')

  const initialSettings = await window.visslm.getSettings()
  const initialSources = sourceSnapshot()
  const initialFields = fieldSnapshot()
  let localClicks = 0
  for (let index = 0; index < 4; index += 1) {
    const local = sourceItem('local')
    if (!local) break
    local.click()
    localClicks += 1
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const afterFourSources = sourceSnapshot()
  const afterFourFields = fieldSnapshot()

  const fifthLocal = sourceItem('local')
  if (fifthLocal) {
    fifthLocal.click()
    localClicks += 1
  }
  const revealStarted = Date.now()
  while (!sourceItem('online') && Date.now() - revealStarted < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const afterFiveSources = sourceSnapshot()
  const afterFiveFields = fieldSnapshot()

  const online = sourceItem('online')
  online?.click()
  const onlineStarted = Date.now()
  while (
    (sourceSnapshot().active !== 'online' || !fieldSnapshot().apiKeyVisible) &&
    Date.now() - onlineStarted < 3000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const onlineSources = sourceSnapshot()
  const onlineFields = fieldSnapshot()
  const panel = document.querySelector('.settings-card')?.getBoundingClientRect()
  const content = document.querySelector('.app-content')?.getBoundingClientRect()
  return {
    settingsTabOpened: Boolean(settingsTabs),
    modelHeadingVisible: Boolean(modelHeading),
    initialSettingsSource: initialSettings?.model?.source ?? null,
    initialSources,
    initialFields,
    localClicks,
    afterFourSources,
    afterFourFields,
    afterFiveSources,
    afterFiveFields,
    onlineSources,
    onlineFields,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    panelFitsContent: Boolean(panel && content && panel.right <= content.right + 1),
    viewport: { width: window.innerWidth, height: window.innerHeight }
  }
})()`)

const providerPoint = await evaluate(`(() => {
  const panel = document.querySelector('.model-settings-heading')?.closest('.settings-panel')
  const item = [...(panel?.querySelectorAll('.ant-form-item') ?? [])]
    .find((candidate) => (candidate.querySelector('.ant-form-item-label')?.textContent ?? '').includes('模型服务商'))
  const control = item?.querySelector('.ant-select-content, .ant-select-selector')
  const rect = control?.getBoundingClientRect()
  return rect && rect.width > 0 && rect.height > 0
    ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    : null
})()`)
if (providerPoint) {
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...providerPoint })
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...providerPoint })
}
await new Promise((resolve) => setTimeout(resolve, 150))
const providerOptions = await evaluate(`(() => {
  const isVisible = (node) => {
    const style = getComputedStyle(node)
    const rect = node.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
  }
  return [...document.querySelectorAll('.ant-select-dropdown')]
    .filter(isVisible)
    .flatMap((dropdown) => [...dropdown.querySelectorAll('.ant-select-item-option')]
      .filter(isVisible)
      .map((element) => element.textContent?.trim()))
})()`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' })

const editedFields = await evaluate(`(() => {
  const panel = document.querySelector('.model-settings-heading')?.closest('.settings-panel')
  const labelTextOf = (item) => (item.querySelector('.ant-form-item-label')?.textContent ?? '')
    .replace(/\\s+/g, ' ')
    .trim()
  const formItem = (label) => [...(panel?.querySelectorAll('.ant-form-item') ?? [])]
    .find((item) => labelTextOf(item).startsWith(label))
  const setInput = (label, value) => {
    const input = formItem(label)?.querySelector('input:not([type="hidden"])')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!input || !setter) return false
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return input.value === value
  }
  return {
    baseUrl: setInput('API 地址', ${JSON.stringify(savedOnlineBaseUrl)}),
    modelName: setInput('模型名称', ${JSON.stringify(savedOnlineModel)}),
    apiKey: setInput('API Key', ${JSON.stringify(savedOnlineApiKey)})
  }
})()`)
await new Promise((resolve) => setTimeout(resolve, 100))
const saveClicked = await evaluate(`(() => {
  const panel = document.querySelector('.model-settings-heading')?.closest('.settings-panel')
  const button = [...(panel?.querySelectorAll('button[type="submit"]') ?? [])]
    .find((candidate) => !candidate.disabled)
  button?.click()
  return Boolean(button)
})()`)
const persistedSettings = await evaluate(`(async () => {
  const started = Date.now()
  let settings = await window.visslm.getSettings()
  while (
    (settings?.model?.source !== 'online' ||
      settings?.model?.provider !== 'openai' ||
      settings?.model?.model !== ${JSON.stringify(savedOnlineModel)} ||
      settings?.modelProfiles?.online?.hasApiKey !== true) &&
    Date.now() - started < 3000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    settings = await window.visslm.getSettings()
  }
  return {
    source: settings?.model?.source ?? null,
    provider: settings?.model?.provider ?? null,
    baseUrl: settings?.model?.baseUrl ?? null,
    model: settings?.model?.model ?? null,
    thinking: settings?.model?.thinking ?? null,
    onlineProfile: settings?.modelProfiles?.online
      ? {
          source: settings.modelProfiles.online.source,
          provider: settings.modelProfiles.online.provider,
          baseUrl: settings.modelProfiles.online.baseUrl,
          model: settings.modelProfiles.online.model,
          thinking: settings.modelProfiles.online.thinking,
          hasApiKey: settings.modelProfiles.online.hasApiKey
        }
      : null
  }
})()`)

const checks = {
  settingsTabOpened: navigationChecks.settingsTabOpened,
  modelHeadingVisible: navigationChecks.modelHeadingVisible,
  seededOnlineSource: navigationChecks.initialSettingsSource === 'online',
  defaultShowsOnlyLocal: navigationChecks.initialSources.visible.length === 1 &&
    navigationChecks.initialSources.visible[0] === 'local' &&
    navigationChecks.initialSources.active === 'local' &&
    navigationChecks.initialFields.localAddressVisible &&
    !navigationChecks.initialFields.onlineAddressVisible &&
    !navigationChecks.initialFields.providerVisible &&
    !navigationChecks.initialFields.apiKeyVisible,
  fourLocalClicksKeepOnlineHidden: navigationChecks.localClicks >= 4 &&
    navigationChecks.afterFourSources.visible.length === 1 &&
    navigationChecks.afterFourSources.visible[0] === 'local',
  fifthLocalClickRevealsOnline: navigationChecks.localClicks === 5 &&
    navigationChecks.afterFiveSources.visible.includes('local') &&
    navigationChecks.afterFiveSources.visible.includes('online'),
  onlineSourceCanBeSelected: navigationChecks.onlineSources.active === 'online',
  onlineFieldsVisible: navigationChecks.onlineFields.onlineAddressVisible &&
    navigationChecks.onlineFields.providerVisible &&
    navigationChecks.onlineFields.apiKeyVisible &&
    !navigationChecks.onlineFields.localAddressVisible,
  providerOptionsAvailable: providerPoint !== null && providerOptions.includes('OpenAI') && providerOptions.includes('Anthropic'),
  onlineFieldsEdited: editedFields.baseUrl && editedFields.modelName && editedFields.apiKey,
  onlineSettingsSaved: saveClicked &&
    persistedSettings.source === 'online' &&
    persistedSettings.provider === 'openai' &&
    persistedSettings.baseUrl === savedOnlineBaseUrl &&
    persistedSettings.model === savedOnlineModel &&
    persistedSettings.onlineProfile?.model === savedOnlineModel &&
    persistedSettings.onlineProfile?.hasApiKey === true
}
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
const failed = Object.entries(checks).filter(([, value]) => value !== true)
console.log(JSON.stringify({
  ok: failed.length === 0,
  checks,
  diagnostics: { navigationChecks, providerPoint, providerOptions },
  protocolChecks,
  screenshot,
  failed: failed.map(([key]) => key)
}, null, 2))
socket.close()
await new Promise((resolve) => mockServer.close(resolve))
if (failed.length) throw new Error(`Settings model UI checks failed: ${failed.map(([key]) => key).join(', ')}`)
