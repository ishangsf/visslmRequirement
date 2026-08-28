import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

/**
 * Clean-room phase-1 contract:
 * AI 助手 -> 数据可视化专家 -> 生成大屏 -> 打开工作台.
 *
 * The test owns a temporary Ollama-compatible service, Electron profile and
 * analytics database, and uses the real preload bridge/renderer controls.
 */

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const modelName = 'smoke-model'
const dashboardTitle = '项目质量大屏'
const smokeName = 'dashboard-ai-drawer-ui'
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const parseJson = (value) => {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const readRequestBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const componentTypes = new Set([
  'kpi', 'bar', 'line', 'pie', 'ranking', 'table', 'progress', 'insight',
  'gauge', 'funnel', 'radar', 'scatter', 'treemap', 'combo'
])

const fakeDashboardFromBlueprint = (input) => {
  const blueprint = input?.analysisBlueprint
  if (!blueprint || !Array.isArray(blueprint.questions) || !Array.isArray(blueprint.metrics)) {
    return {
      schemaVersion: '1.0',
      id: 'dashboard-ai-drawer-ui',
      title: dashboardTitle,
      subtitle: '缺少主机 AnalysisBlueprint',
      businessContext: { audience: '项目经理', objective: '验证项目质量', scopeDescription: '当前数据范围' },
      viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
      theme: 'technology-dark',
      updatedAt: new Date().toISOString(),
      components: []
    }
  }
  const metricsById = new Map(blueprint.metrics.map((metric) => [metric.id, metric]))
  const components = blueprint.questions.map((question, index) => {
    const metrics = (question.metricIds || []).map((metricId) => metricsById.get(metricId)).filter(Boolean)
    const measures = metrics.map((metric) => ({
      id: metric.measureId,
      ...(metric.field ? { field: metric.field } : {}),
      aggregation: metric.aggregation,
      ...(metric.calculation ? { calculation: metric.calculation } : {})
    }))
    const dimensions = (question.dimensionFields || []).map((field) => ({
      field,
      ...(question.timeGrain ? { timeGrain: question.timeGrain } : {})
    }))
    const type = (question.preferredComponentTypes || [])
      .find((candidate) => componentTypes.has(candidate)) || 'table'
    return {
      id: `smoke-${question.id || `question-${index + 1}`}`,
      type,
      title: question.question || `业务问题 ${index + 1}`,
      subtitle: '由 AnalysisBlueprint 驱动的受控组件',
      layout: { x: 0, y: Math.min(18, index * 3), w: 6, h: 3 },
      data: [],
      query: {
        source: 'records',
        scope: input.scope && typeof input.scope === 'object' ? input.scope : {},
        ...(dimensions.length ? { dimensions } : {}),
        measures,
        limit: ['kpi', 'progress', 'gauge'].includes(type) ? 1 : 50
      },
      encoding: {
        ...(measures[0] ? { value: measures[0].id } : {}),
        ...(measures[1] ? { secondaryValue: measures[1].id } : {}),
        ...(dimensions[0] ? { label: dimensions[0].field } : {})
      }
    }
  })
  return {
    schemaVersion: '1.0',
    id: 'dashboard-ai-drawer-ui',
    title: dashboardTitle,
    subtitle: '受控查询驱动的项目质量指标',
    businessContext: {
      audience: blueprint.audience || '项目经理',
      objective: blueprint.objective || '验证项目质量',
      scopeDescription: blueprint.scopeDescription || '当前数据范围'
    },
    viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
    theme: 'technology-dark',
    updatedAt: new Date().toISOString(),
    components
  }
}

const fakePatchFromDashboard = (input) => {
  const componentId = input?.focusComponent?.id ||
    input?.focusComponentId ||
    input?.currentDashboard?.components?.[0]?.id
  return {
    operations: componentId
      ? [{ op: 'set-component-title', componentId, value: 'AI回执测试' }]
      : []
  }
}

const createFakeOllama = async () => {
  const requests = []
  const server = createHttpServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Connection', 'close')
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ models: [{ name: modelName }] }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/show') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { parameter_size: '7B', context_length: 32768 },
          details: { family: 'llama', parameter_size: '7B' }
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/chat') {
        const body = parseJson(await readRequestBody(request)) || {}
        const messages = Array.isArray(body.messages) ? body.messages : []
        const system = String(messages.find((message) => message?.role === 'system')?.content || '')
        const input = parseJson(messages.at(-1)?.content) || {}
        const patch = system.includes('VISSLM visualization editor') ||
          Boolean(input.currentDashboard) || Boolean(input.focusComponentId)
        const generation = !patch && (system.includes('VISSLM 数据可视化专家') || Boolean(input.analysisBlueprint))
        requests.push({ stage: patch ? 'patch' : generation ? 'generation' : 'probe', body, input })
        const content = JSON.stringify(patch
          ? fakePatchFromDashboard(input)
          : generation
            ? fakeDashboardFromBlueprint(input)
            : { ok: true })
        response.writeHead(200, { 'Content-Type': body.stream === true ? 'application/x-ndjson' : 'application/json' })
        if (body.stream === true) {
          response.end([
            JSON.stringify({ model: modelName, message: { role: 'assistant', content }, done: false }),
            JSON.stringify({ model: modelName, message: { role: 'assistant', content: '' }, done: true })
          ].join('\n') + '\n')
        } else {
          response.end(JSON.stringify({
            model: modelName,
            created_at: new Date().toISOString(),
            message: { role: 'assistant', content },
            done: true
          }))
        }
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'not found' }))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fake Ollama did not receive a TCP port')
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      requests,
      close: async () => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
        await new Promise((resolvePromise) => {
          let done = false
          const finish = () => {
            if (done) return
            done = true
            resolvePromise()
          }
          if (!server.listening) {
            finish()
            return
          }
          server.close(finish)
          setTimeout(() => {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
            finish()
          }, 1500)
        })
      }
    }
  } catch (error) {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    if (server.listening) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    }
    throw error
  }
}

const reservePort = async () => {
  const server = createTcpServer()
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unable to reserve a local port')
    const port = address.port
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    return port
  } catch (error) {
    if (server.listening) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    }
    throw error
  }
}

const loadAppDatabase = async () => {
  const chunkDirectory = join(repoRoot, 'out', 'main', 'chunks')
  const chunkName = (await readdir(chunkDirectory)).find((name) => /^database-.*\.js$/.test(name))
  if (!chunkName) throw new Error(`Built AppDatabase chunk not found under ${chunkDirectory}`)
  const module = await import(pathToFileURL(join(chunkDirectory, chunkName)).href)
  const AppDatabase = Object.values(module).find((value) => (
    typeof value === 'function' && value.name === 'AppDatabase'
  ))
  if (typeof AppDatabase !== 'function') throw new Error('Built AppDatabase export not found')
  return AppDatabase
}

const seedDatabase = async (userDataDirectory, baseUrl) => {
  const AppDatabase = await loadAppDatabase()
  const database = new AppDatabase(join(userDataDirectory, 'visslm-agent.db'), join(userDataDirectory, 'assets'))
  try {
    const settings = {
      'model.source': 'local',
      'model.provider': 'ollama',
      'model.baseUrl': baseUrl,
      'model.model': modelName,
      'model.thinking': 'false',
      'model.profile.local.provider': 'ollama',
      'model.profile.local.baseUrl': baseUrl,
      'model.profile.local.model': modelName,
      'model.profile.local.thinking': 'false'
    }
    for (const [key, value] of Object.entries(settings)) database.setSetting(key, value)
    const dates = [
      '2026-08-01T08:00:00.000Z',
      '2026-08-08T08:00:00.000Z',
      '2026-08-15T08:00:00.000Z',
      '2026-08-22T08:00:00.000Z'
    ]
    const statuses = ['open', 'closed', 'open', 'blocked']
    const rows = dates.map((date, index) => {
      const uid = `ui-quality-${index + 1}`
      return {
        documentId: `Issue:${uid}`,
        title: `项目质量问题 ${index + 1}`,
        content: `project quality fixture ${index + 1}`,
        metadata: {
          projectId: 'ui-project',
          recordType: 'Issue',
          sourceId: uid,
          itemId: `UI-${index + 1}`,
          updatedAt: date
        },
        raw: {
          _valm_Uid: uid,
          _valm_NodeType: 'Issue',
          _valm_Name: `项目质量问题 ${index + 1}`,
          _valm_ItemID: `UI-${index + 1}`,
          _valm_ProjectId: 'ui-project',
          _valm_LastModifyTime: date,
          status: statuses[index],
          effort: [3, 5, 4, 7][index],
          score: [9, 7, 8, 6][index],
          dueDate: date.slice(0, 10)
        }
      }
    })
    const imported = database.importRows(rows)
    if (imported.recordCount !== rows.length) {
      throw new Error(`Fixture import count mismatch: ${imported.recordCount}/${rows.length}`)
    }
    return { recordCount: imported.recordCount }
  } finally {
    database.close()
  }
}

const waitForTargets = async (electron, port, timeoutMs = 60_000) => {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (electron.exitCode !== null) throw new Error(`Electron exited before CDP started (${electron.exitCode}): ${lastError}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        if (targets.some((target) => (
          target.type === 'page' && target.webSocketDebuggerUrl && target.url && target.url !== 'about:blank'
        ))) return targets
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for Electron CDP: ${lastError}`)
}

const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })
  let sequence = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'))
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    request.resolve(message)
  })
  socket.on('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP WebSocket closed'))
    }
    pending.clear()
  })
  const call = (method, params = {}, timeoutMs = 30_000) => new Promise((resolvePromise, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP call timed out: ${method}`))
    }, timeoutMs)
    pending.set(id, { resolve: resolvePromise, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, timeoutMs = 90_000) => {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs)
    if (response.error) throw new Error(response.error.message || 'CDP evaluation failed')
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text || 'Renderer evaluation failed')
    }
    return response.result?.result?.value
  }
  return {
    call,
    evaluate,
    close: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
  }
}

const connectStableCdp = async (electron, port, timeoutMs = 60_000) => {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (electron.exitCode !== null) {
      throw new Error(`Electron exited before renderer became ready (${electron.exitCode}): ${lastError}`)
    }
    try {
      const targets = await waitForTargets(electron, port, 2_000)
      const target = targets.find((item) => (
        item.type === 'page' && item.webSocketDebuggerUrl && item.url !== 'about:blank'
      ))
      if (!target?.webSocketDebuggerUrl) throw new Error('No non-blank Electron page target')
      const candidate = await connectCdp(target.webSocketDebuggerUrl)
      try {
        await candidate.call('Runtime.enable', {}, 5_000)
        await candidate.call('Page.enable', {}, 5_000)
        const appReady = await candidate.evaluate(
          'Boolean(window.visslm && document.querySelector(\'.ant-menu-item\'))',
          5_000
        )
        if (appReady) return candidate
        lastError = 'Electron application shell is not mounted yet'
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      candidate.close()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250)
  }
  throw new Error(`Timed out waiting for a stable Electron renderer target: ${lastError}`)
}

const evaluateUi = (cdp, source, timeoutMs = 90_000) => cdp.evaluate(`(${source})()`, timeoutMs)

const waitForApplication = async (cdp) => evaluateUi(cdp, `async function () {
  const waitFor = async (selector, timeout = 60000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  await waitFor('.ant-menu-item')
  const menu = [...document.querySelectorAll('.ant-menu-item')].find((item) => item.textContent?.includes('AI 助手'))
  menu?.click()
  await waitFor('.chat-page')
  const started = Date.now()
  while (!document.querySelector('.composer-model-state.online') && Date.now() - started < 60000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    menuFound: Boolean(menu),
    chatVisible: Boolean(document.querySelector('.chat-page')),
    modelOnline: Boolean(document.querySelector('.composer-model-state.online')),
    modelState: document.querySelector('.composer-model-state')?.textContent?.trim() || '',
    dataState: document.querySelector('.chat-minimal-status')?.textContent?.trim() || ''
  }
}`)

const submitGeneration = async (cdp) => evaluateUi(cdp, `async function () {
  const waitFor = async (selector, timeout = 90000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const input = await waitFor('.composer textarea', 30000)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(input, '@数据可视化专家 生成一个项目质量大屏')
  input?.dispatchEvent(new Event('input', { bubbles: true }))
  input?.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const send = document.querySelector('.chat-send-button[aria-label="发送"]')
  if (!send || send.disabled) throw new Error('Chat send control is unavailable')
  send.click()
  const action = await waitFor('.chat-data-action button', 90000)
  const assistantRows = [...document.querySelectorAll('.message-row.assistant')]
  const lastAssistant = assistantRows.at(-1)
  const taskSummary = document.querySelector('.chat-answer-task-summary')
  const routeText = [taskSummary?.textContent || '', lastAssistant?.textContent || '',
    ...document.querySelectorAll('.chat-answer-meta')].join(' ')
  const actionText = action?.closest('.chat-data-action')?.textContent?.trim() || ''
  return {
    actionVisible: Boolean(action),
    artifactComponentCount: Number(actionText.match(/([0-9]+)[ ]*个组件/)?.[1] || 0),
    routeToVisualization: routeText.includes('数据可视化专家') || routeText.includes('可视化 Agent'),
    taskText: taskSummary?.textContent?.trim() || '',
    assistantText: lastAssistant?.textContent?.trim() || '',
    actionText
  }
}`)

const openDashboard = async (cdp) => evaluateUi(cdp, `async function () {
  const waitFor = async (selector, timeout = 60000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const action = [...document.querySelectorAll('.chat-data-action button')]
    .find((item) => item.textContent?.trim() === '打开可视化大屏')
  if (!action) throw new Error('Generated dashboard action is missing')
  action.click()
  await waitFor('.dashboard-studio', 60000)
  const started = Date.now()
  while (document.querySelectorAll('.dashboard-widget').length < 4 && Date.now() - started < 60000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const widgets = [...document.querySelectorAll('.dashboard-widget')]
  return {
    workbenchVisible: Boolean(document.querySelector('.dashboard-studio')),
    dashboardTitle: document.querySelector('.dashboard-preview-header h2')?.textContent?.trim() || '',
    widgetCount: widgets.length,
    widgetTitles: widgets.map((widget) => widget.querySelector('h3')?.textContent?.trim() || ''),
    widgetLabels: widgets.map((widget) => widget.getAttribute('aria-label') || '')
  }
}`)

const modifyAndUndoDashboard = async (cdp) => evaluateUi(cdp, `async function () {
  const waitFor = async (selector, timeout = 30000) => {
    const started = Date.now()
    while (!document.querySelector(selector) && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.querySelector(selector)
  }
  const firstWidget = document.querySelector('.dashboard-widget')
  firstWidget?.click()
  await waitFor('.dashboard-inspector', 15000)
  const originalTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent?.trim() ||
    firstWidget?.querySelector('h3')?.textContent?.trim() || ''
  const aiButton = [...document.querySelectorAll('.dashboard-studio-actions button')]
    .find((button) => button.textContent?.trim() === 'AI 修改')
  if (!aiButton || aiButton.disabled) throw new Error('Dashboard AI edit button is unavailable')
  aiButton.click()
  const drawer = await waitFor('.dashboard-ai-drawer', 15000)
  const context = await waitFor('.dashboard-ai-context', 15000)
  const composer = await waitFor('.dashboard-ai-composer textarea', 15000)
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(composer, '只把当前选中组件的标题改为“AI回执测试”')
  composer?.dispatchEvent(new Event('input', { bubbles: true }))
  composer?.dispatchEvent(new Event('change', { bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 100))
  const send = [...(drawer?.querySelectorAll('button') || [])]
    .find((button) => button.textContent?.trim() === '发送')
  if (!send || send.disabled) throw new Error('Dashboard AI drawer send button is unavailable')
  send.click()
  const started = Date.now()
  let summary = null
  let failureAlert = null
  while (Date.now() - started < 15000 && !summary && !failureAlert) {
    summary = document.querySelector('.dashboard-ai-change-summary')
    failureAlert = drawer?.querySelector('.ant-alert') || document.querySelector('.dashboard-ai-drawer .ant-alert')
    if (!summary && !failureAlert) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!summary) {
    return {
      drawerVisible: Boolean(drawer),
      drawerNoMask: !document.querySelector('.ant-drawer-mask'),
      focusContext: context?.textContent?.includes('仅修改组件：') || false,
      originalTitle,
      changeSummaryVisible: false,
      failureText: failureAlert?.textContent?.trim() || 'Dashboard AI change summary did not appear'
    }
  }
  const summaryText = summary.textContent?.trim() || ''
  const changedTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent?.trim() || ''
  const undo = [...summary.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === '撤销')
  if (!undo || undo.disabled) throw new Error('Dashboard AI undo button is unavailable')
  undo.click()
  const undoStarted = Date.now()
  while (!summary.textContent?.includes('修改已撤销') && Date.now() - undoStarted < 15000) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const restoredTitle = document.querySelector('.dashboard-widget.selected h3')?.textContent?.trim() || ''
  return {
    drawerVisible: Boolean(drawer),
    drawerNoMask: !document.querySelector('.ant-drawer-mask'),
    focusContext: context?.textContent?.includes('仅修改组件：') || false,
    originalTitle,
    changeSummaryVisible: true,
    changedTitle,
    changedTitleMatches: changedTitle === 'AI回执测试',
    receiptVisible: summaryText.includes('已应用到当前草稿'),
    queryImpactVisible: summaryText.includes('重算 0 个查询'),
    undoReceiptVisible: summary.textContent?.includes('修改已撤销') || false,
    restoredTitle,
    canvasRestored: restoredTitle === originalTitle
  }
}`)

const diagnostics = async (cdp) => {
  try {
    return await evaluateUi(cdp, `function () {
      return {
        url: location.href,
        bodyText: document.body?.innerText?.slice(-6000) || '',
        alerts: [...document.querySelectorAll('.ant-alert, .ant-message-notice, [role="alert"]')]
          .map((item) => item.textContent?.trim() || '').filter(Boolean)
      }
    }`, 10_000)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

const stopElectron = async (electron) => {
  if (!electron || electron.exitCode !== null) return
  if (process.platform === 'win32' && electron.pid) {
    await new Promise((resolvePromise) => {
      execFile('taskkill', ['/PID', String(electron.pid), '/T', '/F'], () => resolvePromise())
    })
  } else {
    electron.kill('SIGTERM')
  }
  await Promise.race([
    new Promise((resolvePromise) => electron.once('exit', resolvePromise)),
    sleep(5000)
  ])
}

const run = async () => {
  const checks = {}
  let userDataDirectory
  let fakeOllama
  let cdpPort
  let electron
  let cdp
  let electronLogs = ''
  let failure
  let fixture
  let ready
  let generation
  let dashboard
  try {
    userDataDirectory = await mkdtemp(join(tmpdir(), 'visslm-dashboard-ai-ui-'))
    fakeOllama = await createFakeOllama()
    cdpPort = await reservePort()
    fixture = await seedDatabase(userDataDirectory, fakeOllama.baseUrl)
    electron = spawn(electronPath, [
      '.',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDirectory}`,
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    electron.stdout?.on('data', (chunk) => { electronLogs += chunk.toString() })
    electron.stderr?.on('data', (chunk) => { electronLogs += chunk.toString() })
    cdp = await connectStableCdp(electron, cdpPort)
    ready = await waitForApplication(cdp)
    checks.fixtureRecordsSeeded = fixture.recordCount === 4
    checks.chatReady = Boolean(ready.menuFound && ready.chatVisible)
    checks.fakeModelOnline = Boolean(ready.modelOnline)
    if (!checks.fixtureRecordsSeeded || !checks.chatReady || !checks.fakeModelOnline) {
      throw new Error(`Application readiness failed: ${JSON.stringify(ready)}`)
    }
    generation = await submitGeneration(cdp)
    checks.visualizationExpertRouted = Boolean(generation.routeToVisualization)
    checks.dashboardArtifactActionVisible = Boolean(generation.actionVisible)
    checks.generatedArtifactHasAtLeastFourComponents = generation.artifactComponentCount >= 4
    if (!checks.visualizationExpertRouted || !checks.dashboardArtifactActionVisible || !checks.generatedArtifactHasAtLeastFourComponents) {
      throw new Error(`Generation UI contract failed: ${JSON.stringify(generation)}`)
    }
    const generationRequest = fakeOllama.requests.find((request) => request.stage === 'generation')
    checks.hostSentAnalysisBlueprint = Boolean(
      generationRequest?.input?.analysisBlueprint?.metrics?.length &&
      generationRequest?.input?.analysisBlueprint?.questions?.length
    )
    if (!checks.hostSentAnalysisBlueprint) throw new Error('Generation request did not contain AnalysisBlueprint')
    const canonicalTransportAliases = new Set([
      '_valm_uid', '_valm_nodetype', '_valm_name', '_valm_itemid',
      '_valm_projectid', '_valm_lastmodifytime'
    ])
    checks.hostFieldCatalogExcludesCanonicalTransportAliases = Boolean(
      Array.isArray(generationRequest?.input?.fieldCatalog) &&
      generationRequest.input.fieldCatalog.every((entry) =>
        !canonicalTransportAliases.has(String(entry?.field || '').toLocaleLowerCase())
      )
    )
    dashboard = await openDashboard(cdp)
    checks.workbenchOpened = Boolean(dashboard.workbenchVisible)
    checks.dashboardTitleRendered = dashboard.dashboardTitle === dashboardTitle
    checks.atLeastFourComponentsRendered = dashboard.widgetCount >= 4
    checks.componentTitlesRendered = dashboard.widgetTitles.every((title) => Boolean(title))
    checks.componentAriaContractsRendered = dashboard.widgetLabels.every((label) => /组件$/.test(label))
    const internalFieldNamePattern = /_valm_|\b(?:ItemID|LastModifyTime|dueDate|due Date|effort|score)\b/i
    checks.businessFriendlyComponentTitlesRendered =
      dashboard.widgetTitles.every((title) => !internalFieldNamePattern.test(title)) &&
      dashboard.widgetLabels.every((label) => !internalFieldNamePattern.test(label))
    if (!checks.workbenchOpened || !checks.dashboardTitleRendered || !checks.atLeastFourComponentsRendered ||
        !checks.componentTitlesRendered || !checks.componentAriaContractsRendered ||
        !checks.businessFriendlyComponentTitlesRendered) {
      throw new Error(`Workbench UI contract failed: ${JSON.stringify(dashboard)}`)
    }
    const aiResult = await modifyAndUndoDashboard(cdp)
    dashboard = { ...dashboard, aiResult }
    checks.aiDrawerAvailable = Boolean(aiResult.drawerVisible)
    checks.aiDrawerNoMask = Boolean(aiResult.drawerNoMask)
    checks.aiFocusContext = Boolean(aiResult.focusContext)
    checks.aiPatchChangeSummaryVisible = Boolean(aiResult.changeSummaryVisible)
    checks.aiPatchChangedTitle = Boolean(aiResult.changedTitleMatches)
    checks.aiPatchReceiptVisible = Boolean(aiResult.receiptVisible)
    checks.aiPatchQueryImpactVisible = Boolean(aiResult.queryImpactVisible)
    checks.aiUndoReceiptVisible = Boolean(aiResult.undoReceiptVisible)
    checks.aiUndoRestoredTitle = Boolean(aiResult.canvasRestored)
    const patchRequest = fakeOllama.requests.find((request) => request.stage === 'patch')
    const patchDashboard = patchRequest?.input?.currentDashboard
    const patchBlueprint = patchDashboard?.analysisBlueprint
    const patchComponents = patchDashboard?.components
    checks.patchHostReceivedSemanticArtifact = Boolean(
      patchBlueprint &&
      Array.isArray(patchBlueprint.metrics) &&
      Array.isArray(patchBlueprint.questions) &&
      Array.isArray(patchComponents) &&
      patchComponents.length > 0 &&
      patchComponents.every((component) => (
        component && component.query && component.layout && component.semanticBinding && component.slotRole
      ))
    )
    checks.patchHostPayloadScoped = Boolean(
      patchDashboard &&
      (patchRequest.input.focusComponentId || patchRequest.input.focusComponent?.id)
    )
    const focusComponentId = patchRequest?.input?.focusComponentId || patchRequest?.input?.focusComponent?.id
    const focusedPatchComponent = patchComponents?.find((component) => component?.id === focusComponentId)
    const focusedPatchBinding = focusedPatchComponent?.semanticBinding
    const focusedPatchQuestion = patchBlueprint?.questions?.find((question) => question?.id === focusedPatchBinding?.questionId)
    checks.patchHostFocusSemanticBindingMatchesBlueprint = Boolean(
      focusedPatchComponent && focusedPatchBinding && focusedPatchQuestion &&
      JSON.stringify(focusedPatchBinding.metricIds) === JSON.stringify(focusedPatchQuestion.metricIds) &&
      JSON.stringify(focusedPatchBinding.dimensionFields) === JSON.stringify(focusedPatchQuestion.dimensionFields)
    )
    checks.generationAndPatchRequestsObserved = fakeOllama.requests.some((request) => request.stage === 'generation') &&
      fakeOllama.requests.some((request) => request.stage === 'patch')
    if (!checks.hostFieldCatalogExcludesCanonicalTransportAliases ||
        !checks.businessFriendlyComponentTitlesRendered || !checks.aiDrawerAvailable || !checks.aiDrawerNoMask ||
        !checks.aiFocusContext || !checks.aiPatchChangeSummaryVisible || !checks.aiPatchChangedTitle ||
        !checks.aiPatchReceiptVisible || !checks.aiPatchQueryImpactVisible || !checks.aiUndoReceiptVisible ||
        !checks.aiUndoRestoredTitle || !checks.patchHostReceivedSemanticArtifact ||
        !checks.patchHostPayloadScoped || !checks.patchHostFocusSemanticBindingMatchesBlueprint ||
        !checks.generationAndPatchRequestsObserved) {
      throw new Error(`Dashboard AI patch/undo UI contract failed: ${JSON.stringify(aiResult)}`)
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    if (cdp && failure) {
      // Best-effort diagnostics are collected before closing the renderer.
      try { dashboard = { ...(dashboard || {}), diagnostics: await diagnostics(cdp) } } catch { /* best effort */ }
    }
    try { cdp?.close() } catch { /* best effort */ }
    try { await stopElectron(electron) } catch { /* best effort */ }
    try { await fakeOllama?.close() } catch { /* best effort */ }
    try {
      if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
  const result = {
    ok: !failure,
    smoke: smokeName,
    checks,
    fixture,
    fakeOllama: {
      baseUrl: fakeOllama?.baseUrl ?? '',
      requestStages: fakeOllama?.requests.map((request) => request.stage) ?? [],
      requestCount: fakeOllama?.requests.length ?? 0
    },
    generation,
    dashboard,
    ...(failure ? { failure } : {}),
    ...(electronLogs ? { electronLogs: electronLogs.slice(-8000) } : {})
  }
  console.log(JSON.stringify(result, null, 2))
  if (failure) process.exitCode = 1
}

await run()
