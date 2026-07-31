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
  const response = JSON.parse(raw.toString('utf8'))
  if (response.id && pending.has(response.id)) {
    pending.get(response.id)(response)
    pending.delete(response.id)
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

await call('Page.reload')
const checks = await evaluate(`(async () => {
  const menuStarted = Date.now()
  while (!document.querySelector('.ant-menu-item') && Date.now() - menuStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const clickMenu = () => [...document.querySelectorAll('.ant-menu-item')]
    .find((item) => item.textContent?.includes('资产中心'))
    ?.click()
  clickMenu()
  const started = Date.now()
  while (!document.querySelector('.asset-center-page') && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const tabs = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .map((item) => item.textContent?.trim())
  const dataPage = Boolean(document.querySelector('.asset-center-page .filter-bar'))
  const knowledgeTab = [...document.querySelectorAll('.asset-center-tabs .ant-tabs-tab')]
    .find((item) => item.textContent?.includes('知识库'))
  knowledgeTab?.click()
  const knowledgeStarted = Date.now()
  while (!document.querySelector('.knowledge-page') && Date.now() - knowledgeStarted < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    assetCenter: Boolean(document.querySelector('.asset-center-page')),
    tabs,
    dataPage,
    knowledgePage: Boolean(document.querySelector('.knowledge-page')),
    uploadButton: Boolean(document.querySelector('.knowledge-toolbar button')),
    metrics: document.querySelectorAll('.knowledge-metric-grid .ant-card').length,
    filters: Boolean(document.querySelector('.knowledge-filter-bar')),
    table: Boolean(document.querySelector('.knowledge-list-card .ant-table'))
  }
})()`)

if (!checks.assetCenter || !checks.dataPage || !checks.knowledgePage || !checks.uploadButton || !checks.filters || !checks.table) {
  throw new Error(`Asset center UI smoke failed: ${JSON.stringify(checks)}`)
}

await call('Page.enable')
const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
const screenshotPath = join(process.env.TEMP ?? '.', 'visslm-asset-center.png')
writeFileSync(screenshotPath, Buffer.from(screenshot.result.data, 'base64'))
console.log(JSON.stringify({ ...checks, screenshot: screenshotPath }, null, 2))
socket.close()
