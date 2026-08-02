import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import type {
  DashboardComponentSpec,
  DashboardSpec,
  VisualizationRunInput
} from '../src/shared/dashboard'

const model = process.env.VISSLM_LIVE_AI_MODEL?.trim() || 'qwen3:8b'
const baseUrl = process.env.VISSLM_LIVE_AI_BASE_URL?.trim() || 'http://127.0.0.1:11434'
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const response = await nativeFetch(input, init)
  if (String(input).includes('/api/chat')) {
    try {
      const payload = await response.clone().json() as { message?: { content?: string } }
      const patch = JSON.parse(payload.message?.content ?? '{}') as { operations?: unknown[] }
      process.stderr.write(`[model-operations] ${JSON.stringify(patch.operations ?? [])}\n`)
    } catch {
      process.stderr.write('[model-operations] unable to parse response\n')
    }
  }
  return response
}

const records: AnalyticsRecord[] = [
  {
    uid: 'live-1',
    projectId: 'live-project',
    nodeType: 'Issue',
    itemId: 'ISSUE-1',
    name: 'Login failure',
    lastModifyTime: '2026-05-03T10:00:00Z',
    raw: { status: 'open', effort: 3, priority: 'high' }
  },
  {
    uid: 'live-2',
    projectId: 'live-project',
    nodeType: 'Issue',
    itemId: 'ISSUE-2',
    name: 'Export delay',
    lastModifyTime: '2026-06-11T10:00:00Z',
    raw: { status: 'closed', effort: 5, priority: 'medium' }
  },
  {
    uid: 'live-3',
    projectId: 'live-project',
    nodeType: 'Task',
    itemId: 'TASK-1',
    name: 'Improve dashboard',
    lastModifyTime: '2026-07-08T10:00:00Z',
    raw: { status: 'in-progress', effort: 8, priority: 'high' }
  }
]

const fakeDb = {
  scanAnalyticsRecords: (scope) => records.filter((record) =>
    !scope.projectIds?.length || scope.projectIds.includes(record.projectId)
  )
} as AppDatabase

const scope = { projectIds: ['live-project'] }
const queryEngine = new QueryEngine(fakeDb)

const component = (
  input: Omit<DashboardComponentSpec, 'data'>
): DashboardComponentSpec => {
  const dataset = queryEngine.execute(input.query!)
  const labelField = input.encoding?.label
  const valueField = input.encoding?.value
  return {
    ...input,
    data: dataset.rows.map((row) => ({
      name: String(labelField ? row[labelField] : input.title),
      value: Number(row[valueField!] ?? 0)
    }))
  }
}

const baseDashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'dashboard-ai-live-smoke',
  title: '项目运营大屏',
  subtitle: '真实模型连续修改测试',
  businessContext: {
    audience: '项目经理',
    objective: '跟踪项目问题、投入和活跃度',
    scopeDescription: 'live-project'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    component({
      id: 'kpi-total',
      type: 'kpi',
      title: '记录总数',
      layout: { x: 0, y: 0, w: 6, h: 3 },
      query: {
        source: 'records', scope, dimensions: [],
        measures: [{ id: 'records', aggregation: 'count' }], limit: 1
      },
      encoding: { value: 'records' }
    }),
    component({
      id: 'kpi-effort',
      type: 'kpi',
      title: '总投入',
      layout: { x: 6, y: 0, w: 6, h: 3 },
      unit: '小时',
      query: {
        source: 'records', scope, dimensions: [],
        measures: [{ id: 'effortTotal', field: 'effort', aggregation: 'sum' }], limit: 1
      },
      encoding: { value: 'effortTotal' }
    }),
    component({
      id: 'status-distribution',
      type: 'bar',
      title: '状态分布',
      layout: { x: 12, y: 0, w: 12, h: 6 },
      query: {
        source: 'records', scope, dimensions: [{ field: 'status' }],
        measures: [{ id: 'records', aggregation: 'count' }], limit: 10
      },
      encoding: { label: 'status', value: 'records' }
    }),
    component({
      id: 'activity-trend',
      type: 'line',
      title: '修改趋势',
      layout: { x: 0, y: 3, w: 12, h: 6 },
      query: {
        source: 'records', scope,
        dimensions: [{ field: 'lastModifyTime', timeGrain: 'month' }],
        measures: [{ id: 'records', aggregation: 'count' }], limit: 24
      },
      encoding: { label: 'lastModifyTime', value: 'records' }
    })
  ]
}

assert.deepEqual(validateDashboardSpec(baseDashboard, queryEngine), [])

const runs: VisualizationRunInput[] = []
const agent = new VisualizationAgent(
  queryEngine,
  { source: 'local', provider: 'ollama', baseUrl, model, thinking: false },
  (run) => runs.push(run),
  (event) => process.stderr.write(`[${event.stage}] ${event.message}\n`)
)
const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = []
const durations: Array<{ step: string; durationMs: number }> = []
let dashboard = baseDashboard

const patch = async (
  step: string,
  question: string,
  focusComponentId?: string
): Promise<void> => {
  const startedAt = performance.now()
  dashboard = await agent.patch(question, dashboard, scope, focusComponentId, conversation)
  durations.push({ step, durationMs: Number((performance.now() - startedAt).toFixed(1)) })
  conversation.push(
    { role: 'user', content: question },
    { role: 'assistant', content: `已完成 ${step}` }
  )
  assert.equal(dashboard.id, baseDashboard.id)
  assert.deepEqual(validateDashboardSpec(dashboard, queryEngine), [])
}

await patch('dashboard-title', '只把大屏主标题改成“研发效能驾驶舱”，其他内容保持不变。')
assert.equal(dashboard.title, '研发效能驾驶舱')

await patch('follow-up-theme', '继续修改，改成明亮商务风格，其他内容不变。')
assert.equal(dashboard.theme, 'business-light')

await patch(
  'focused-top-sort',
  '把这个状态分布组件限制为 Top 5，并按记录数从高到低排序。',
  'status-distribution'
)
const statusComponent = dashboard.components.find((item) => item.id === 'status-distribution')
assert.equal(statusComponent?.query?.limit, 5)
assert.deepEqual(statusComponent?.query?.sort, [{ field: 'records', direction: 'desc' }])

await patch(
  'focused-type-and-grain',
  '把这个指标改成按月展示的折线图，保留原来的记录数口径。',
  'kpi-total'
)
const trendComponent = dashboard.components.find((item) => item.id === 'kpi-total')
assert.equal(trendComponent?.type, 'line')
assert.equal(trendComponent?.query?.dimensions?.[0]?.timeGrain, 'month')

await patch('follow-up-component-title', '标题再简洁一点，改成“月度趋势”。', 'kpi-total')
assert.equal(dashboard.components.find((item) => item.id === 'kpi-total')?.title, '月度趋势')

const queryExecutions = runs.map((run) =>
  run.toolCalls.filter((call) => call.tool === 'execute-query').length
)
assert.deepEqual(queryExecutions, [0, 0, 1, 1, 1])

console.log(JSON.stringify({
  ok: true,
  provider: 'ollama',
  model,
  successfulPatches: runs.filter((run) => run.status === 'success').length,
  attempts: runs.map((run) => run.attemptCount),
  queryExecutions,
  durations,
  final: {
    title: dashboard.title,
    theme: dashboard.theme,
    focusedComponentTitle: dashboard.components.find((item) => item.id === 'kpi-total')?.title,
    focusedComponentType: dashboard.components.find((item) => item.id === 'kpi-total')?.type
  }
}, null, 2))
