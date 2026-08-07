import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { ExpertRouter } from '../src/main/experts/router'
import type { AgentEvent } from '../src/shared/expert-types'
import type { VisualizationRunInput } from '../src/shared/dashboard'

const records: AnalyticsRecord[] = [{
  uid: '1',
  projectId: 'p1',
  nodeType: 'Issue',
  itemId: 'I-1',
  name: '测试问题',
  lastModifyTime: '2026-07-31T10:00:00Z',
  raw: { status: '开放' }
}]

const fakeDb = {
  scanAnalyticsRecords: () => records
} as AppDatabase

const component = (index: number) => ({
  id: `kpi-${index}`,
  type: 'kpi',
  title: `指标 ${index}`,
  layout: { x: (index - 1) * 6, y: 0, w: 6, h: 3 },
  data: [],
  query: {
    source: 'records',
    scope: { projectIds: ['p1'] },
    dimensions: [],
    measures: [{ id: 'records', aggregation: 'count' }],
    limit: 1
  },
  encoding: { value: 'records' }
})

const generated = {
  schemaVersion: '1.0',
  id: 'progress-dashboard',
  title: '进度测试大屏',
  subtitle: '阶段事件',
  businessContext: {
    audience: '测试负责人',
    objective: '验证生成进度',
    scopeDescription: '项目 p1'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [component(1), component(2), component(3), component(4)]
}

const originalFetch = globalThis.fetch
const progress: Array<Extract<AgentEvent, { type: 'status' }>> = []
const runs: VisualizationRunInput[] = []
globalThis.fetch = async () => new Response(JSON.stringify({
  message: { content: JSON.stringify(generated) }
}), { status: 200, headers: { 'Content-Type': 'application/json' } })

try {
  const agent = new VisualizationAgent(
    new QueryEngine(fakeDb),
    {
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-model',
      thinking: false
    },
    (run) => runs.push(run),
    (event) => progress.push(event)
  )
  const dashboard = await agent.generate('生成测试大屏', { projectIds: ['p1'] })
  assert.equal(dashboard.components.length, 4)
  const stages = progress.map((event) => event.stage)
  assert.deepEqual(stages, [
    'intent',
    'profile',
    'plan',
    'query',
    'execute',
    'compose',
    'validate',
    'persist'
  ])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].mode, 'generate')
  assert.equal(runs[0].status, 'success')
  assert.deepEqual(
    [...new Set(runs[0].toolCalls.map((call) => call.tool))],
    ['profile-fields', 'model-compose', 'validate-dashboard', 'execute-query']
  )
  assert.equal(runs[0].toolCalls.filter((call) => call.tool === 'execute-query').length, 4)
  assert.ok(runs[0].toolCalls.every((call, index) => call.sequence === index + 1))
  const route = new ExpertRouter().route({ question: '@通用数据助手 汇总当前数据' })
  assert.equal(route.expert.id, 'general')
  assert.equal(route.reason, 'explicit-mention')
  assert.equal(route.question, '汇总当前数据')
  const requirementRoute = new ExpertRouter().route({
    question: '@需求分析专家 分析需求编号 REQ-1、REQ-2',
    conversationId: 'requirement-routing-smoke',
    entrypoint: 'chat',
    expertId: 'general'
  })
  assert.equal(requirementRoute.expert.id, 'requirement-analysis')
  assert.equal(requirementRoute.question, '分析需求编号 REQ-1、REQ-2')
  console.log(JSON.stringify({
    ok: true,
    stages,
    toolCalls: runs[0].toolCalls.map((call) => call.tool),
    generalRoute: route.reason,
    requirementRoute: requirementRoute.reason
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
