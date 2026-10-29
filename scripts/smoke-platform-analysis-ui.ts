import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { AppDatabase } from '../src/main/database'

// Real Electron IPC + bundled stdio MCP, using only an isolated profile and synthetic HTTP data.
const userData = await mkdtemp(join(tmpdir(), 'visslm-platform-ui-'))
const fixtureDb = new AppDatabase(join(userData, 'visslm-agent.db'), join(userData, 'assets'))
fixtureDb.upsertRecord({ uid: 'ui-local', projectId: 'ui-project', parentId: '', nodeType: 'Requirement', itemId: 'LOCAL-1',
  name: '语义词典验收数据', lastModifyTime: '', raw: { Status: '1' }, normalizedText: '本地状态样例' })
fixtureDb.close()
const artifacts = resolve('tmp/platform-analysis-ui')
await mkdir(artifacts, { recursive: true })
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let queryCount = 0
let planIndex = 0
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const url = new URL(req.url!, 'http://localhost')
  if (url.pathname === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'mock' }] })); return }
  if (url.pathname === '/api/show') { res.end(JSON.stringify({ capabilities: ['completion'], model_info: {} })); return }
  if (url.pathname === '/api/chat') {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    const plans = [{ action: 'fields', nodeType: 'Requirement' }, { action: 'query', nodeType: 'Requirement', fields: ['Status'], filters: [] }, { action: 'answer' }]
    const content = input.format?.properties?.action ? JSON.stringify(plans[planIndex++]) : '认证需求存在令牌到期后的恢复缺口，需要补充异常处理。数据范围为本次查询返回记录。[UID:ui-remote]'
    res.end(JSON.stringify({ message: { role: 'assistant', content }, done: true })); return
  }
  if (url.pathname === '/alm/User/UPLogOn') {
    res.setHeader('Set-Cookie', 'JSESSIONID=ui-test; Path=/')
    res.end(JSON.stringify({ ErrorCode: 0, Data: {} })); return
  }
  if (!req.headers.cookie?.includes('JSESSIONID')) { res.statusCode = 401; res.end('{}'); return }
  if (url.pathname === '/alm/Admin/Virtualization_ReadMember') {
    res.end(JSON.stringify({ rows: [{ HideMember: 'Status', MemberName: '需求状态', MemberType: 'SINGLELINETEXT' }], total: 1 })); return
  }
  if (url.pathname === '/alm/rest/items') {
    queryCount++
    res.end(JSON.stringify({ propList: [{ _valm_Uid: 'ui-remote', _valm_Name: '统一认证需求', _valm_ItemID: 'REQ-UI-1', Status: '1',
      _valm_Description: '<p>令牌到期后无法恢复。</p>' + '<p>需要校验重新登录和刷新令牌的处理边界。</p>'.repeat(100) }] })); return
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const reservation = createServer()
await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done))
const cdpPort = (reservation.address() as { port: number }).port
await new Promise<void>((done) => reservation.close(() => done()))
const env: NodeJS.ProcessEnv = { ...process.env, VISSLM_E2E_ALLOW_MULTI_INSTANCE: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const electron = spawn(createRequire(import.meta.url)('electron'), ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, '--disable-gpu'], {
  cwd: process.cwd(), env, windowsHide: true, stdio: 'ignore'
})
let socket: WebSocket | undefined
const pending = new Map<number, { resolve: (response: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
let id = 0
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
  const current = ++id
  const timer = setTimeout(() => { pending.delete(current); reject(new Error(`CDP timeout: ${method}`)) }, 60_000)
  pending.set(current, { resolve, reject, timer })
  socket!.send(JSON.stringify({ id: current, method, params }))
})
const evaluate = async (expression: string) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || 'Renderer failed')
  return response.result?.result?.value
}
const waitFor = async (expression: string) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`UI state not reached: ${expression}`)
}
const capture = async (name: string) => {
  const response = await call('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(artifacts, `${name}.png`), Buffer.from(response.result.data, 'base64'))
}
try {
  let target: any
  for (let attempt = 0; attempt < 120; attempt++) {
    if (electron.exitCode !== null) throw new Error('Electron exited during launch')
    try {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as any[]
      target = targets.find((entry) => entry.type === 'page' && entry.url?.includes('/out/renderer/index.html'))
      if (target) break
    } catch { /* wait for the isolated app */ }
    await sleep(250)
  }
  assert.ok(target, 'main renderer target must open')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((done, reject) => { socket!.once('open', done); socket!.once('error', reject) })
  socket.on('message', (buffer) => {
    const response = JSON.parse(buffer.toString()); const request = pending.get(response.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(response.id)
    if (response.error) request.reject(new Error(response.error.message)); else request.resolve(response)
  })
  await waitFor('Boolean(window.visslm && document.querySelector(".ant-menu-item"))')
  const result = await evaluate(`(async () => {
    await window.visslm.savePlatformSettings({ baseUrl: 'http://127.0.0.1:${port}/alm', username: 'ui-test', token: 'ui-token', uploadPassword: 'ui-password', mcpServerPath: '' });
    await window.visslm.saveModelSettings({ source: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:${port}', model: 'mock', thinking: false });
    await window.visslm.saveSyncConfig({ selectedTypes: ['Requirement'], rules: [{ nodeType: 'Requirement', returnProperty: '', filters: [] }] });
    const response = await window.visslm.askAgent({ question: '@平台 分析认证需求的风险', chatMode: 'auto', entrypoint: 'chat', thinkingMode: 'off' });
    const createdAt = new Date().toISOString();
    await window.visslm.saveChatSession({ id: 'platform-ui-session', title: '平台分析验收', messages: [
      { id: 'question', role: 'user', content: '@平台 分析认证需求的风险', createdAt },
      { id: 'answer', role: 'assistant', content: response.answer, sources: response.sources, createdAt }
    ] });
    return response;
  })()`)
  assert.equal(result.sources.length, 1, result.answer)
  assert.ok(result.sources[0].platformSnapshot)
  assert.equal(queryCount, 1)
  assert.equal(result.taskTrace.primaryAgent, 'data-center')
  await call('Page.reload')
  await waitFor('Boolean(document.querySelector(".ant-menu-item"))')
  const checks: unknown[] = []
  for (const theme of ['dark', 'light']) {
    await evaluate(`document.querySelector('button[aria-label="切换到${theme === 'dark' ? '暗' : '亮'}色主题"]')?.click()`)
    await waitFor(`document.documentElement.dataset.theme === '${theme}'`)
    for (const [width, height] of [[1360, 900], [1000, 700]]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
      for (const title of ['数据概览', '资产中心', 'AI 助手', '数据采集', '项目管理', '系统配置']) {
        assert.ok(await evaluate(`Boolean([...document.querySelectorAll('.ant-menu-item')].find(item => item.textContent.includes('${title}')))`), title)
        await evaluate(`[...document.querySelectorAll('.ant-menu-item')].find(item => item.textContent.includes('${title}')).click()`)
        await sleep(200)
        assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), true, `${theme}/${width}/${title} overflows`)
      }
      await waitFor('Boolean(document.querySelector("input[id*=mcpServerPath]"))')
      assert.equal(await evaluate('document.querySelector("input[id*=mcpServerPath]").value'), '')
      await evaluate(`[...document.querySelectorAll('.ant-menu-item')].find(item => item.textContent.includes('AI 助手')).click()`)
      await waitFor(`[...document.querySelectorAll('.chat-history-item')].some(item => item.textContent.includes('平台分析验收'))`)
      await evaluate(`[...document.querySelectorAll('.chat-history-item')].find(item => item.textContent.includes('平台分析验收')).click()`)
      await waitFor('Boolean(document.querySelector("details.source-list"))')
      await evaluate(`(() => { const list = document.querySelector('details.source-list'); if (!list.open) list.querySelector('summary').click(); })()`)
      await waitFor('Boolean(document.querySelector(".source-reference"))')
      assert.match(await evaluate('document.querySelector(".source-list").textContent'), /平台实时记录/)
      await evaluate('document.querySelector(".source-reference").click()')
      await waitFor('Boolean(document.querySelector(".ant-modal-title")?.textContent.includes("平台实时记录"))')
      await sleep(350)
      const modalCheck = await evaluate(`(() => {
        const modal = document.querySelector('.ant-modal'); const body = modal.querySelector('.ant-modal-body');
        const rect = modal.getBoundingClientRect();
        return { title: modal.querySelector('.ant-modal-title').textContent,
          hasSnapshot: body.textContent.includes('令牌到期后无法恢复'),
          rawHtmlHidden: !body.textContent.includes('<p>'),
          jsonCollapsed: !modal.querySelector('.ant-collapse-item-active'),
          contained: rect.left >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
          scrollInside: getComputedStyle(body).overflowY === 'auto' && body.clientHeight < body.scrollHeight,
          background: getComputedStyle(modal.querySelector('.ant-modal-container') || modal).backgroundColor };
      })()`)
      for (const key of ['hasSnapshot', 'rawHtmlHidden', 'jsonCollapsed', 'contained', 'scrollInside']) assert.equal(modalCheck[key], true, `${theme}/${width}/${key}`)
      checks.push({ theme, width, height, ...modalCheck })
      await capture(`platform-evidence-${theme}-${width}`)
      await evaluate('document.querySelector(".ant-modal-close").click()')
      await sleep(300)
      await evaluate(`[...document.querySelectorAll('.ant-menu-item')].find(item => item.textContent.includes('资产中心')).click()`)
      await waitFor(`[...document.querySelectorAll('button')].some(item => item.textContent.includes('字段语义词典'))`)
      await evaluate(`[...document.querySelectorAll('button')].find(item => item.textContent.includes('字段语义词典')).click()`)
      await waitFor(`[...document.querySelectorAll('.semantic-dictionary-drawer tr')].some(row => row.textContent.includes('Status'))`)
      await evaluate(`[...document.querySelectorAll('.semantic-dictionary-drawer tr')].find(row => row.textContent.includes('Status')).querySelector('button').click()`)
      await waitFor('Boolean(document.querySelector("textarea[aria-label=枚举值释义]"))')
      await evaluate(`(() => {
        const set = (label, value) => { const input = document.querySelector('[aria-label="'+label+'"]');
          Object.getOwnPropertyDescriptor(input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true })); };
        set('业务定义与统计口径', '业务确认的需求处理状态'); set('单位', '阶段'); set('枚举值释义', '1=处理中');
      })()`)
      await sleep(350)
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".semantic-dictionary-form").closest(".ant-modal-body")).overflowX'), 'hidden')
      await capture(`field-semantics-${theme}-${width}`)
      await evaluate(`[...document.querySelectorAll('.ant-modal-footer button')].find(button => button.textContent.includes('保存语义')).click()`)
      await waitFor('!document.querySelector("textarea[aria-label=枚举值释义]")?.getClientRects().length')
      const semantics = await evaluate(`window.visslm.listFieldProfiles({}).then(fields => fields.find(field => field.field === 'Status'))`)
      assert.equal(semantics.businessMeaning, '业务确认的需求处理状态')
      assert.equal(semantics.unit, '阶段')
      assert.equal(semantics.valueLabels['1'], '处理中')
      await evaluate('document.querySelector(".semantic-dictionary-drawer .ant-drawer-close").click()')
      await sleep(300)
    }
  }
  await writeFile(join(artifacts, 'results.json'), JSON.stringify({ ok: true, queryCount, checks }, null, 2))
  console.log(JSON.stringify({ ok: true, artifacts, checks: ['Electron IPC', 'bundled MCP', 'snapshot persistence', 'source detail', 'field semantics UI save/readback', 'dark/light desktop themes', 'internal scroll', 'six page overflow checks'] }))
} finally {
  for (const value of pending.values()) clearTimeout(value.timer)
  socket?.close()
  electron.kill()
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
}
