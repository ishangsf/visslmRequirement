import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PlatformMcpClient } from '../src/main/assistant/platform-mcp'
import { PlatformAnalysisAgent, isPlatformAnalysisRequest } from '../src/main/assistant/platform-analysis'
import { capturePlatformDashboardSnapshot, platformSnapshotQueryEngine } from '../src/main/dashboards/platform-snapshot'
import type { ModelChatInput } from '../src/main/model-client'

const token = 'isolated-token-never-in-model'
const password = 'isolated-password-never-in-model'
const calls: string[] = []
let oversized = false
let slow = false
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost')
  calls.push(url.pathname)
  res.setHeader('Content-Type', 'application/json')
  if (url.pathname === '/alm/User/UPLogOn') {
    res.setHeader('Set-Cookie', 'JSESSIONID=isolated-session; Path=/')
    res.end(JSON.stringify({ ErrorCode: 0, Data: { name: 'tester' } })); return
  }
  if (!req.headers.cookie?.includes('JSESSIONID=')) { res.statusCode = 401; res.end('{}'); return }
  if (url.pathname === '/alm/Admin/Virtualization_ReadMember') {
    res.end(JSON.stringify({ rows: [{ NodeType: 'Requirement', HideMember: 'Status', MemberName: '状态', MemberType: 'SINGLELINETEXT' },
      { NodeType: 'Requirement', HideMember: 'Priority', MemberName: '优先级', MemberType: 'SINGLELINETEXT' },
      { NodeType: 'Requirement', HideMember: '_valm_ProjectId', MemberName: '项目', MemberType: 'SINGLELINETEXT' }], total: 0 })); return
  }
  if (url.pathname === '/alm/rest/items') {
    assert.equal(url.searchParams.get('ApiToken'), token)
    assert.match(url.searchParams.get('VSearch')!, /from Requirement/)
    if (slow) await new Promise((done) => setTimeout(done, 200))
    res.end(JSON.stringify({ propList: [{ _valm_Uid: 'remote-1', _valm_ProjectId: 'project-1', _valm_ItemID: 'REQ-1', _valm_Name: '认证需求', _valm_NodeType: 'Requirement', Status: '1', Priority: 'P1',
      _valm_Description: oversized ? '正文'.repeat(250_000) : '<p>令牌过期后无法重新认证</p><script>bad()</script>' }] })); return
  }
  res.statusCode = 404; res.end('{}')
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const credentials = { baseUrl: `http://127.0.0.1:${port}/alm`, username: 'tester', token, uploadPassword: password }
const serverPath = resolve('resources/visslm-mcp/server.js')
const inputs: ModelChatInput[] = []
const plans = [{ action: 'fields', nodeType: 'Requirement' }, { action: 'query', nodeType: 'Requirement', fields: ['Status'], filters: [{ field: 'Status', operator: 'equals', value: '1' }] },
  { action: 'query', nodeType: 'Requirement', fields: ['Priority'], filters: [] }, { action: 'answer' }]
try {
  const agent = new PlatformAnalysisAgent({ serverPath, credentials, nodeTypes: ['Requirement'], model: { source: 'online', provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'mock', thinking: false },
    fieldSemantics: () => [{ field: 'Status', inferredType: 'enum', nonNullRate: 1, distinctCount: 1, samples: ['1'], profiledAt: '',
      businessMeaning: '业务确认的需求处理状态', valueLabels: { '1': '处理中' } }],
    client: { chat: async (input) => { inputs.push(input); return { message: { role: 'assistant', content: input.format ? JSON.stringify(plans.shift()) : '已查询到认证失败的描述。[UID:remote-1] [UID:invented]' } } } }
  })
  const result = await agent.ask({ question: '@平台 分析需求中的认证问题' })
  assert.equal(result.sources.length, 1)
  assert.match(result.sources[0].platformSnapshot!.text, /令牌过期/)
  assert.doesNotMatch(result.sources[0].platformSnapshot!.text, /<p>|bad\(\)/)
  assert.doesNotMatch(result.answer, /invented/)
  assert.equal(result.sources[0].platformSnapshot!.fields.Status, '1', 'later queries must retain earlier requested fields for the same record')
  assert.equal(result.sources[0].platformSnapshot!.fields.Priority, 'P1')
  assert.match(JSON.stringify(inputs.at(-1)), /业务确认的需求处理状态/)
  assert.match(JSON.stringify(inputs.at(-1)), /处理中/)
  assert.match(result.answer, /接口实际返回数据/)
  assert.ok(calls.includes('/alm/User/UPLogOn'))
  assert.ok(calls.filter((path) => path === '/alm/rest/items').length >= 2)
  assert.doesNotMatch(JSON.stringify(inputs), new RegExp(`${token}|${password}|isolated-session`))
  assert.equal(isPlatformAnalysisRequest({ question: '从VISSLM平台查询本月需求' }), false, 'natural language must first pass semantic routing')
  assert.ok(isPlatformAnalysisRequest({ question: '获取最新数据', assistantIntent: { taskType: 'record_query', sourceMode: 'records', skillId: 'general', resultMode: 'answer', groupEntities: [], resolvedQuestion: '获取最新数据', needsClarification: false, reason: 'test', recordOrigin: 'platform' } }))
  assert.equal(isPlatformAnalysisRequest({ question: '如何配置VISSLM平台' }), false)
  assert.equal(isPlatformAnalysisRequest({ question: '分析本地数据' }), false)
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'visslm-mcp-dashboard-test-'))
  const dashboardScope = { projectIds: ['project-1'], nodeTypes: ['Requirement'] }
  const snapshot = await capturePlatformDashboardSnapshot({ reader: new PlatformMcpClient(serverPath, credentials), credentials, nodeTypes: ['Requirement'], scope: dashboardScope, root: snapshotRoot })
  assert.equal(platformSnapshotQueryEngine(snapshotRoot, snapshot).execute({ source: 'records', scope: dashboardScope, measures: [{ id: 'n', aggregation: 'count' }] }).rows[0].n, 1)
  assert.equal(snapshot.completePopulation, false)
  await assert.rejects(() => agent.ask({ question: '@平台 查询', dataScope: { projectIds: ['a', 'b'] } }), /单项目范围/)
  await assert.rejects(() => agent.ask({ question: '@平台 查询', dataScope: { recordUids: [] } }), /单项目范围/)
  const reader = new PlatformMcpClient(serverPath, credentials)
  try {
    await reader.connect()
    await assert.rejects(() => reader.read('/Account/Delete' as never, {}), /白名单/)
    oversized = true
    await assert.rejects(() => reader.read('/rest/items', { VSearch: 'select _valm_Uid from Requirement', ReturnProperty: '_valm_Uid' }), /超出 MCP 返回上限/)
  } finally { await reader.close(); oversized = false }
  const controller = new AbortController()
  const cancellable = new PlatformMcpClient(serverPath, credentials, controller.signal)
  try {
    await cancellable.connect()
    slow = true
    const pending = cancellable.read('/rest/items', { VSearch: 'select _valm_Uid from Requirement' })
    setTimeout(() => controller.abort(new Error('cancelled-test')), 30)
    await assert.rejects(() => pending, /cancelled-test/)
  } finally { await cancellable.close() }
  console.log(JSON.stringify({ ok: true, checks: ['bundled MCP handshake', 'real child process and HTTP authentication', 'multi-step queries', 'credential isolation', 'clean evidence snapshots', 'citation validation', 'read-only endpoint guard', 'truncation rejection', 'cancellation', 'natural-language route'] }))
} finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())) }
