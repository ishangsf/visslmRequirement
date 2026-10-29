import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import {
  adaptDashboardComponentQuery,
  repairDashboardComponent
} from '../src/main/dashboards/component-repair'
import { diagnoseDashboard } from '../src/main/dashboards/diagnostics'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import {
  createDashboardDomainControlledScenarioContext,
  createDashboardQueryEngineForSpec
} from '../src/main/experts/dashboard-domain-controlled-fixtures'
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
assert.throws(() => repairDashboardComponent(missingDimension, 'missing-dimension', engine), /不能删除或替换/)

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
assert.throws(() => repairDashboardComponent(invalidLine, 'line', engine), /数值字段|指标口径/)

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
assert.throws(() => adaptDashboardComponentQuery(scatter, 'scatter', engine), /两个指标/)

const treemap = dashboard([component({
  id: 'treemap',
  type: 'treemap',
  query: {
    source: 'records',
    scope,
    dimensions: [{ field: 'removedCategory' }],
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { label: 'removedCategory', value: 'records' }
})])
assert.throws(() => repairDashboardComponent(treemap, 'treemap', engine), /不能删除或替换/)

const combo = dashboard([component({
  id: 'combo',
  type: 'combo',
  query: {
    source: 'records',
    scope,
    dimensions: [{ field: 'lastModifyTime', timeGrain: 'month' }],
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { label: 'lastModifyTime', value: 'records' }
})])
assert.throws(() => repairDashboardComponent(combo, 'combo', engine), /两个指标/)

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
assert.throws(() => repairDashboardComponent(partialInput, firstPartial.id, engine), /缺少查询/)
assert.equal(JSON.stringify(partialInput), partialInputBefore)

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

const controlledContext = createDashboardDomainControlledScenarioContext('gjb5000b-compliance')
assert.ok(controlledContext)
const controlledActivity = dashboard([component({
  id: 'controlled-activity',
  type: 'kpi',
  query: {
    source: 'records',
    scope: { projectIds: [controlledContext.fixture.projectId] },
    measures: [{
      id: 'activity-execution-rate',
      field: 'activityExecutionRate',
      aggregation: 'avg'
    }],
    limit: 1
  },
  encoding: { value: 'activity-execution-rate' }
})])
controlledActivity.title = 'GJB5000B 过程符合度与证据审计（受控样例）'
controlledActivity.subtitle = 'controlled sample · preview'
controlledActivity.domainContext = {
  role: 'qa-epg',
  scenario: 'gjb5000b-compliance',
  catalogVersion: 'test',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  artifactStatus: 'preview',
  dataMode: 'controlled-sample'
}
assert.ok(validateDashboardSpec(controlledActivity, engine).some((error) =>
  error.includes('activityExecutionRate')
))
const resolvedControlledEngine = createDashboardQueryEngineForSpec(controlledActivity, fakeDb)
assert.deepEqual(validateDashboardSpec(controlledActivity, resolvedControlledEngine), [])
const controlledReport = diagnoseDashboard(controlledActivity, resolvedControlledEngine)
assert.equal(controlledReport.components[0].status, 'ok')
assert.ok(!controlledReport.issues.some((issue) => issue.code === 'query-error'))
const controlledRepair = repairDashboardComponent(
  controlledActivity,
  'controlled-activity',
  resolvedControlledEngine
)
assert.equal(controlledRepair.report.components[0].status, 'ok')
assert.ok(controlledRepair.spec.components[0].data.length > 0)

const legacyControlled = JSON.parse(JSON.stringify(controlledActivity)) as DashboardSpec
delete legacyControlled.domainContext!.dataMode
const legacyControlledEngine = createDashboardQueryEngineForSpec(legacyControlled, fakeDb)
assert.deepEqual(validateDashboardSpec(legacyControlled, legacyControlledEngine), [])

console.log(JSON.stringify({
  ok: true,
  repairedCases: [
    'encoding',
    'stable-domain-measure-id',
    'layout',
    'controlled-sample-source-context',
    'legacy-controlled-sample-source-context'
  ],
  rollbackCases: ['missing-dimension', 'wrong-measure', 'missing-second-measure', 'missing-query', 'query-failure', 'no-layout-slot']
}, null, 2))
