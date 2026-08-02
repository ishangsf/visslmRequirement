import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { repairDashboardComponent } from '../src/main/dashboards/component-repair'
import type { DashboardComponentSpec, DashboardSpec } from '../src/shared/dashboard'
import type { DataScope } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = Array.from({ length: 12 }, (_, index) => ({
  uid: String(index + 1),
  projectId: 'repair-project',
  nodeType: 'Metric',
  itemId: `M-${index + 1}`,
  name: `记录 ${index + 1}`,
  lastModifyTime: `2026-${String((index % 6) + 1).padStart(2, '0')}-01T10:00:00Z`,
  raw: {
    status: index % 2 ? '进行中' : '已完成',
    category: `分类 ${index % 3}`,
    amount: index + 10,
    cost: (index + 1) * 2
  }
}))

const fakeDb = {
  scanAnalyticsRecords(scope: DataScope): AnalyticsRecord[] {
    return records.filter((record) =>
      !scope.projectIds?.length || scope.projectIds.includes(record.projectId)
    )
  }
} as AppDatabase
const engine = new QueryEngine(fakeDb)
const scope = { projectIds: ['repair-project'] }

const component = (
  patch: Partial<DashboardComponentSpec> & Pick<DashboardComponentSpec, 'id' | 'type'>
): DashboardComponentSpec => ({
  id: patch.id,
  type: patch.type,
  title: patch.title ?? patch.id,
  layout: patch.layout ?? { x: 0, y: 0, w: 12, h: 5 },
  data: patch.data ?? [],
  query: patch.query ?? {
    source: 'records',
    scope,
    dimensions: [{ field: 'category' }],
    measures: [{ id: 'records', aggregation: 'count' }],
    limit: 20
  },
  encoding: patch.encoding ?? { label: 'category', value: 'records' }
})

const dashboard = (components: DashboardComponentSpec[]): DashboardSpec => ({
  schemaVersion: '1.0',
  id: 'repair-dashboard',
  title: '组件修复测试',
  subtitle: '确定性修复',
  theme: 'technology-dark',
  updatedAt: '2026-08-01T00:00:00.000Z',
  components
})

const missingDimension = dashboard([component({
  id: 'missing-dimension',
  type: 'bar',
  query: {
    source: 'records',
    scope,
    dimensions: [{ field: 'removedCategory' }],
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { label: 'removedCategory', value: 'records' }
})])
const repairedDimension = repairDashboardComponent(missingDimension, 'missing-dimension', engine)
assert.ok(['status', 'category'].includes(repairedDimension.spec.components[0].query!.dimensions![0].field))
assert.equal(
  repairedDimension.spec.components[0].encoding?.label,
  repairedDimension.spec.components[0].query!.dimensions![0].field
)
assert.notEqual(repairedDimension.spec.components[0].data.length, 0)

const invalidLine = dashboard([component({
  id: 'line',
  type: 'line',
  query: {
    source: 'records',
    scope,
    dimensions: [{ field: 'status' }],
    measures: [{ id: 'total', field: 'status', aggregation: 'sum' }]
  },
  encoding: { label: 'missing', value: 'missing-value' }
})])
const repairedLine = repairDashboardComponent(invalidLine, 'line', engine).spec.components[0]
assert.equal(repairedLine.query!.dimensions![0].field, 'lastModifyTime')
assert.equal(repairedLine.query!.dimensions![0].timeGrain, 'month')
assert.ok(['amount', 'cost'].includes(repairedLine.query!.measures[0].field!))
assert.equal(repairedLine.encoding?.value, repairedLine.query!.measures[0].id)
assert.equal(repairedLine.encoding?.label, 'lastModifyTime')

const scatter = dashboard([component({
  id: 'scatter',
  type: 'scatter',
  query: {
    source: 'records',
    scope,
    dimensions: [{ field: 'category' }],
    measures: [{ id: 'amount', field: 'amount', aggregation: 'sum' }]
  },
  encoding: { label: 'category', value: 'amount', secondaryValue: 'removed' }
})])
const repairedScatter = repairDashboardComponent(scatter, 'scatter', engine).spec.components[0]
assert.equal(repairedScatter.query!.measures.length, 2)
assert.ok(repairedScatter.encoding?.secondaryValue)
assert.notEqual(repairedScatter.encoding?.value, repairedScatter.encoding?.secondaryValue)
assert.ok(repairedScatter.data.every((item) => Number.isFinite(item.secondaryValue)))

const target = component({
  id: 'layout-target',
  type: 'bar',
  layout: { x: 0, y: 0, w: 3, h: 2 }
})
const blocker = component({
  id: 'layout-blocker',
  type: 'kpi',
  layout: { x: 3, y: 0, w: 6, h: 4 },
  query: {
    source: 'records',
    scope,
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { value: 'records' }
})
const layoutInput = dashboard([target, blocker])
const repairedLayout = repairDashboardComponent(layoutInput, target.id, engine).spec
assert.notDeepEqual(repairedLayout.components[0].layout, target.layout)
assert.deepEqual(repairedLayout.components[1], blocker)

const firstPartial = component({
  id: 'first-partial',
  type: 'bar',
  layout: { x: 0, y: 0, w: 12, h: 5 }
})
const secondPartial = component({
  id: 'second-partial',
  type: 'bar',
  layout: { x: 12, y: 0, w: 12, h: 5 }
})
delete firstPartial.query
delete firstPartial.encoding
delete secondPartial.query
delete secondPartial.encoding
const partialInput = dashboard([firstPartial, secondPartial])
const partialInputBefore = JSON.stringify(partialInput)
const firstPartialResult = repairDashboardComponent(partialInput, firstPartial.id, engine)
const repairedFirst = firstPartialResult.spec.components[0]
const untouchedSecond = firstPartialResult.spec.components[1]
assert.ok(repairedFirst.query)
assert.ok(repairedFirst.encoding?.value)
assert.ok(repairedFirst.data.length > 0)
assert.deepEqual(untouchedSecond, secondPartial)
assert.ok(firstPartialResult.report.issues.some((issue) => issue.componentId === secondPartial.id))
assert.ok(!firstPartialResult.report.issues.some((issue) =>
  issue.componentId === firstPartial.id && issue.code === 'spec-validation'
))
assert.equal(JSON.stringify(partialInput), partialInputBefore)

const secondPartialResult = repairDashboardComponent(
  firstPartialResult.spec,
  secondPartial.id,
  engine
)
assert.ok(secondPartialResult.spec.components[1].query)
assert.ok(secondPartialResult.spec.components[1].encoding?.value)
assert.ok(secondPartialResult.spec.components[1].data.length > 0)
assert.ok(!secondPartialResult.report.issues.some((issue) => issue.code === 'spec-validation'))

const fullGrid = component({
  id: 'full-grid',
  type: 'table',
  layout: { x: 0, y: 0, w: 24, h: 20 }
})
const trapped = component({
  id: 'trapped',
  type: 'bar',
  layout: { x: 0, y: 0, w: 3, h: 2 }
})
const noSlotInput = dashboard([fullGrid, trapped])
const noSlotBefore = JSON.stringify(noSlotInput)
assert.throws(
  () => repairDashboardComponent(noSlotInput, trapped.id, engine),
  /没有可用的无冲突布局位置/
)
assert.equal(JSON.stringify(noSlotInput), noSlotBefore)

const executionFailure = dashboard([component({ id: 'failure', type: 'bar' })])
const executionFailureBefore = JSON.stringify(executionFailure)
const failingEngine = {
  profile: (queryScope: DataScope) => engine.profile(queryScope),
  validate: (query: NonNullable<DashboardComponentSpec['query']>) => engine.validate(query),
  execute: () => { throw new Error('模拟查询执行失败') }
} as QueryEngine
assert.throws(
  () => repairDashboardComponent(executionFailure, 'failure', failingEngine),
  /模拟查询执行失败/
)
assert.equal(JSON.stringify(executionFailure), executionFailureBefore)

console.log(JSON.stringify({
  ok: true,
  repairedCases: [
    'dimension',
    'line',
    'aggregation',
    'encoding',
    'scatter',
    'layout',
    'partial-dashboard-sequential'
  ],
  rollbackCases: ['query-failure', 'no-layout-slot']
}, null, 2))
