import { strict as assert } from 'node:assert'
import {
  analyzeComponentProvenance,
  analyzeDashboardExport,
  describeMeasure,
  describeDataScope,
  listQueryFields,
  listSensitiveFields
} from '../src/shared/dashboard-governance'
import type { DashboardComponentSpec, DashboardSpec } from '../src/shared/dashboard'

const statusComponent: DashboardComponentSpec = {
  id: 'status-distribution',
  type: 'pie',
  title: '问题状态分布',
  layout: { x: 0, y: 0, w: 12, h: 5 },
  data: [],
  query: {
    source: 'records',
    scope: {
      projectIds: ['project-a', 'project-b'],
      nodeTypes: ['Issue'],
      baseFilters: [{ field: 'visibility', operator: 'equals', value: 'internal' }],
      snapshotAt: '2026-07-31T08:00:00.000Z'
    },
    dimensions: [{ field: 'status' }],
    measures: [{ id: 'records', aggregation: 'count' }],
    filters: [{ field: 'priority', operator: 'in', value: ['P0', 'P1'] }],
    limit: 20
  }
}

const ownerComponent: DashboardComponentSpec = {
  id: 'owner-ranking',
  type: 'ranking',
  title: '负责人排行',
  layout: { x: 12, y: 0, w: 12, h: 5 },
  data: [],
  query: {
    source: 'records',
    scope: { recordUids: ['record-1', 'record-2'] },
    dimensions: [{ field: 'owner_email' }],
    measures: [{ id: 'total_cost', field: 'cost', aggregation: 'sum' }]
  }
}

const dashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'governance-dashboard',
  title: '治理测试大屏',
  subtitle: '导出范围检查',
  theme: 'technology-dark',
  updatedAt: '2026-07-31T08:30:00.000Z',
  components: [
    statusComponent,
    ownerComponent,
    {
      id: 'insight',
      type: 'insight',
      title: '结论',
      layout: { x: 0, y: 5, w: 24, h: 3 },
      data: []
    }
  ]
}

assert.deepEqual(listQueryFields(statusComponent.query), [
  'status',
  'visibility',
  'priority'
])
assert.deepEqual(listSensitiveFields(dashboard), ['owner_email'])
assert.deepEqual(describeDataScope({}), ['全部本地记录'])

const review = analyzeDashboardExport(dashboard)
assert.equal(review.componentCount, 3)
assert.equal(review.queryCount, 2)
assert.equal(review.uncontrolledComponentCount, 1)
assert.deepEqual(review.sensitiveFields, ['owner_email'])
assert.ok(review.scopeDescriptions.includes('2 个项目'))
assert.ok(review.scopeDescriptions.includes('类型：Issue'))
assert.ok(review.scopeDescriptions.includes('2 条指定记录'))
assert.ok(!review.scopeDescriptions.includes('未声明数据范围'))

const provenance = analyzeComponentProvenance(statusComponent)
assert.deepEqual(provenance.dimensions, ['status'])
assert.deepEqual(provenance.measures, ['records = count(记录)'])
assert.deepEqual(provenance.filters, [
  'visibility equals internal',
  'priority in P0、P1'
])
assert.equal(provenance.limit, 20)
assert.ok(describeMeasure({
  id: 'completionRate',
  aggregation: 'sum',
  formula: 'completed / planned * 100'
}).includes('公式'))
assert.ok(provenance.scopes.some((item) => item.startsWith('快照：')))

console.log(JSON.stringify({
  ok: true,
  componentCount: review.componentCount,
  queryCount: review.queryCount,
  uncontrolledComponentCount: review.uncontrolledComponentCount,
  sensitiveFields: review.sensitiveFields,
  scopeDescriptions: review.scopeDescriptions
}, null, 2))
