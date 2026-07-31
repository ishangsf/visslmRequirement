import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { dashboardGoldenScenarios } from '../src/main/experts/dashboard-golden'
import type { DataScope } from '../src/shared/query-spec'
import { validateDashboardSpec } from '../src/main/dashboards/validator'

const makeDb = (records: AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope: DataScope): AnalyticsRecord[] {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const results = dashboardGoldenScenarios.map((scenario) => {
  const engine = new QueryEngine(makeDb(scenario.records))
  const errors = validateDashboardSpec(scenario.spec, engine)
  assert.deepEqual(errors, [], `${scenario.id} DashboardSpec 校验失败: ${errors.join('；')}`)
  const datasets = scenario.spec.components.map((component) => {
    assert.ok(component.query, `${scenario.id}/${component.id} 缺少 QuerySpec`)
    const dataset = engine.execute(component.query!)
    assert.ok(dataset.rows.length > 0, `${scenario.id}/${component.id} 返回空数据`)
    return { componentId: component.id, rows: dataset.rows.length, elapsedMs: dataset.elapsedMs }
  })
  return {
    id: scenario.id,
    name: scenario.name,
    theme: scenario.spec.theme,
    recordCount: scenario.records.length,
    componentCount: scenario.spec.components.length,
    datasets
  }
})

assert.equal(results.length, 3)
assert.equal(new Set(results.map((item) => item.theme)).size, 3)
console.log(JSON.stringify({ ok: true, scenarios: results }, null, 2))
