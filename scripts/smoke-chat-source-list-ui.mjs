import WebSocket from 'ws'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9350'
const screenshotDirectory = join(process.cwd(), 'tmp', 'chat-source-list-e2e', 'screenshots')
mkdirSync(screenshotDirectory, { recursive: true })

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
  const response = JSON.parse(raw.toString('utf8'))
  if (!response.id || !pending.has(response.id)) return
  pending.get(response.id)(response)
  pending.delete(response.id)
})

const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++sequence
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.result?.exceptionDetails) {
    throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer evaluation failed')
  }
  return response.result?.result?.value
}

const capture = async (name) => {
  const response = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(screenshotDirectory, `${name}.png`)
  writeFileSync(path, Buffer.from(response.result.data, 'base64'))
  return path
}

await call('Emulation.setDeviceMetricsOverride', {
  width: 1360,
  height: 880,
  deviceScaleFactor: 1,
  mobile: false
})
await call('Page.bringToFront')
await call('Page.reload')

const collapsedChecks = await evaluate(`(async () => {
  const waitFor = async (predicate, label, timeout = 30000) => {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const value = predicate()
      if (value) return value
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for ' + label)
  }
  await waitFor(() => document.querySelector('.ant-menu-item'), 'application navigation')
  if (document.documentElement.dataset.theme !== 'dark') {
    document.querySelector('button[aria-label="切换到暗色主题"]')?.click()
    await waitFor(() => document.documentElement.dataset.theme === 'dark', 'dark theme')
  }
  [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('AI 助手'))?.click()
  const session = await waitFor(() => [...document.querySelectorAll('.chat-history-item')]
    .find((item) => item.textContent?.includes('回答依据折叠验收')), 'seeded chat session')
  session.click()
  const details = await waitFor(() => document.querySelector('details.source-list'), 'answer source list')
  const markdown = document.querySelector('.message-row.assistant .chat-markdown')
  const summary = details.querySelector('summary.source-list-title')
  const chips = details.querySelector('.source-chips')
  const openLabel = details.querySelector('.source-list-action-open')
  return {
    theme: document.documentElement.dataset.theme,
    answerVisible: markdown?.textContent?.includes('GJB5000B 采用分级成熟度模型') ?? false,
    repeatedSourceAbsent: !(markdown?.textContent ?? '').includes('来源：'),
    repeatedBasisAbsent: !(markdown?.textContent ?? '').includes('依据：'),
    collapsedByDefault: !details.open,
    chipsHiddenWhenCollapsed: chips?.getClientRects().length === 0,
    summaryVisible: Boolean(summary?.textContent?.includes('回答依据')),
    countVisible: Boolean(summary?.textContent?.includes('1 份文档')),
    viewListVisible: getComputedStyle(openLabel).display !== 'none'
  }
})()`)

const collapsedScreenshot = await capture('chat-answer-basis-collapsed-dark')

const expandedChecks = await evaluate(`(async () => {
  const details = document.querySelector('details.source-list')
  details?.querySelector('summary')?.click()
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const chips = details?.querySelector('.source-chips')
  const closeLabel = details?.querySelector('.source-list-action-close')
  const sourceButton = details?.querySelector('.source-chip')
  return {
    expanded: Boolean(details?.open),
    chipsVisible: (chips?.getClientRects().length ?? 0) > 0,
    closeListVisible: closeLabel ? getComputedStyle(closeLabel).display !== 'none' : false,
    sourceReadable: sourceButton?.textContent?.includes('GJB5000B实施指南.pdf') ?? false,
    locationReadable: sourceButton?.textContent?.includes('第3页') ?? false
  }
})()`)

const expandedScreenshot = await capture('chat-answer-basis-expanded-dark')
await call('Emulation.setDeviceMetricsOverride', {
  width: 660,
  height: 760,
  deviceScaleFactor: 1,
  mobile: false
})
const responsiveChecks = await evaluate(`(async () => {
  const details = document.querySelector('details.source-list')
  if (details?.open) details.querySelector('summary')?.click()
  document.querySelector('button[aria-label="切换到亮色主题"]')?.click()
  const started = Date.now()
  while (document.documentElement.dataset.theme !== 'light' && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const summary = details?.querySelector('summary.source-list-title')
  const rect = summary?.getBoundingClientRect()
  return {
    theme: document.documentElement.dataset.theme,
    collapsed: !details?.open,
    summaryWithinViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth + 1),
    viewListVisible: getComputedStyle(details.querySelector('.source-list-action-open')).display !== 'none'
  }
})()`)
const responsiveScreenshot = await capture('chat-answer-basis-collapsed-light-660')
const failures = []
for (const [key, value] of Object.entries(collapsedChecks)) {
  if (key !== 'theme' && value !== true) failures.push(`collapsed check failed: ${key}=${String(value)}`)
}
for (const [key, value] of Object.entries(expandedChecks)) {
  if (value !== true) failures.push(`expanded check failed: ${key}=${String(value)}`)
}
for (const [key, value] of Object.entries(responsiveChecks)) {
  if (key !== 'theme' && value !== true) failures.push(`responsive check failed: ${key}=${String(value)}`)
}
if (collapsedChecks.theme !== 'dark') failures.push(`expected dark theme, got ${collapsedChecks.theme}`)
if (responsiveChecks.theme !== 'light') failures.push(`expected light theme, got ${responsiveChecks.theme}`)

socket.close()
if (failures.length) {
  throw new Error(`Chat source-list UI smoke failed: ${JSON.stringify({ failures, collapsedChecks, expandedChecks })}`)
}
console.log(JSON.stringify({
  ok: true,
  collapsedChecks,
  expandedChecks,
  responsiveChecks,
  screenshots: [collapsedScreenshot, expandedScreenshot, responsiveScreenshot]
}, null, 2))
