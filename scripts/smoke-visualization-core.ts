import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { ExpertRouter } from '../src/main/experts/router'
import type { DashboardSpec } from '../src/shared/dashboard'
import {
  arrangeDashboardComponents,
  dashboardLayoutProfiles,
  dashboardRowCount
} from '../src/shared/dashboard-layout'
import type { DataScope, QuerySpec } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = [
  {
    uid: '1',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-1',
    name: '问题一',
    lastModifyTime: '2026-07-01T10:00:00Z',
    raw: { status: '开放', effort: 3, updatedAt: '2026-07-01T10:00:00Z' }
  },
  {
    uid: '2',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-2',
    name: '问题二',
    lastModifyTime: '2026-07-08T10:00:00Z',
    raw: { status: '关闭', effort: 5, updatedAt: '2026-07-08T10:00:00Z' }
  },
  {
    uid: '3',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-3',
    name: '问题三',
    lastModifyTime: '2026-07-09T10:00:00Z',
    raw: { status: '开放', effort: 2, updatedAt: '2026-07-09T10:00:00Z' }
  },
  {
    uid: '4',
    projectId: 'p2',
    nodeType: 'Task',
    itemId: 'T-1',
    name: '任务一',
    lastModifyTime: '2026-07-10T10:00:00Z',
    raw: { status: '进行中', effort: 8, updatedAt: '2026-07-10T10:00:00Z' }
  }
]

const fakeDb = {
  scanAnalyticsRecords(scope: DataScope): AnalyticsRecord[] {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase

const engine = new QueryEngine(fakeDb)
const distribution: QuerySpec = {
  source: 'records',
  scope: { projectIds: ['p1'] },
  dimensions: [{ field: 'status' }],
  measures: [{ id: 'records', aggregation: 'count' }],
  sort: [{ field: 'records', direction: 'desc' }],
  limit: 10
}
const distributionResult = engine.execute(distribution)
assert.equal(distributionResult.scannedRows, 3)
assert.deepEqual(distributionResult.rows, [
  { status: '开放', records: 2 },
  { status: '关闭', records: 1 }
])

const weekly = engine.execute({
  source: 'records',
  scope: { projectIds: ['p1'] },
  dimensions: [{ field: 'updatedAt', timeGrain: 'week' }],
  measures: [
    { id: 'totalEffort', field: 'effort', aggregation: 'sum' },
    { id: 'averageEffort', field: 'effort', aggregation: 'avg' }
  ],
  sort: [{ field: 'updatedAt', direction: 'asc' }]
})
assert.equal(weekly.rows.length, 2)
assert.equal(weekly.rows[1].totalEffort, 7)
assert.equal(weekly.rows[1].averageEffort, 3.5)

const invalidErrors = engine.validate({
  source: 'records',
  scope: {},
  measures: [{ id: 'bad', field: 'status', aggregation: 'sum' }]
})
assert.ok(invalidErrors.some((error) => error.includes('不是数值')))

const router = new ExpertRouter()
const explicit = router.route({
  conversationId: 'conversation-1',
  question: '@数据可视化专家 做一个缺陷趋势大屏'
})
assert.equal(explicit.expert.id, 'visualization')
assert.equal(explicit.reason, 'explicit-mention')
assert.equal(explicit.question, '做一个缺陷趋势大屏')
assert.equal(router.route({
  conversationId: 'conversation-1',
  question: '把趋势改成按周'
}).expert.id, 'visualization')
assert.equal(router.route({ question: '查找某条记录' }).expert.id, 'general')

const dashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'test-dashboard',
  title: '测试大屏',
  subtitle: 'QuerySpec smoke test',
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [{
    id: 'status',
    type: 'bar',
    title: '状态分布',
    layout: { x: 0, y: 0, w: 12, h: 5 },
    data: [],
    query: distribution,
    encoding: { label: 'status', value: 'records' }
  }]
}
assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

const arranged = arrangeDashboardComponents([
  { ...dashboard.components[0], id: 'kpi', type: 'kpi' },
  { ...dashboard.components[0], id: 'bar', type: 'bar' },
  { ...dashboard.components[0], id: 'line', type: 'line' },
  { ...dashboard.components[0], id: 'ranking', type: 'ranking' },
  { ...dashboard.components[0], id: 'table', type: 'table' },
  { ...dashboard.components[0], id: 'insight-a', type: 'insight' },
  { ...dashboard.components[0], id: 'insight-b', type: 'insight' }
])
const arrangedRows = new Map<number, typeof arranged>()
for (const component of arranged) {
  const row = arrangedRows.get(component.layout.y) ?? []
  row.push(component)
  arrangedRows.set(component.layout.y, row)
  const minimum = dashboardLayoutProfiles[component.type]
  assert.ok(component.layout.w >= minimum.minimumWidth)
  assert.ok(component.layout.h >= minimum.minimumHeight)
}
for (const row of arrangedRows.values()) {
  assert.equal(row.reduce((width, component) => width + component.layout.w, 0), 24)
  assert.equal(row[0].layout.x, 0)
  assert.equal(row.at(-1)!.layout.x + row.at(-1)!.layout.w, 24)
}
assert.equal(
  dashboardRowCount(arranged),
  Math.max(...arranged.map((component) => component.layout.y + component.layout.h))
)

console.log(JSON.stringify({
  ok: true,
  distribution: distributionResult.rows,
  weekly: weekly.rows,
  route: explicit.reason
}, null, 2))
