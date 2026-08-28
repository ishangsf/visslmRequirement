import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { softwareQualityGoldenFixture } from '../src/main/experts/dashboard-software-quality'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(softwareQualityGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) =>
  item.id === softwareQualityGoldenFixture.scenario
)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.deepEqual(scenario.metricIds, softwareQualityGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, softwareQualityGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('软件质量领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: softwareQualityGoldenFixture.request,
    scope: { projectIds: [softwareQualityGoldenFixture.projectId] },
    generatedAt: softwareQualityGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'software-quality')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '软件质量与缺陷闭环（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'qa-epg')
  assert.equal(dashboard.domainContext?.scenario, 'software-quality')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.match(result.answer ?? '', /软件质量与缺陷闭环/)
  assert.deepEqual(
    dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    softwareQualityGoldenFixture.metricIds
  )
  assert.deepEqual(
    dashboard.components.map((component) => component.id),
    softwareQualityGoldenFixture.componentIds
  )
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'software-quality-density-card': ['name'],
    'software-quality-trend-card': ['lastModifyTime'],
    'software-quality-repair-card': ['name'],
    'software-quality-residual-risk-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.title.trim())
    assert.ok(!/需求稳定|里程碑|计划完成|项目健康/.test(component.title),
      `${component.id} 不得复用其他场景标题`)
    assert.ok(component.query)
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(
      component.semanticBinding?.dimensionFields ?? [],
      expectedDimensions[component.id] ?? []
    )
  }
  const density = dashboard.components.find((item) => item.id === 'software-quality-density-card')
  assert.equal(density?.query?.measures?.[0]?.field, 'defectDensity',
    '缺陷密度必须绑定 defectDensity，不能降级成缺陷数量')
  assert.ok(/缺陷密度/.test(density?.title ?? ''))
  assert.ok(!/缺陷总数/.test(density?.title ?? ''))
  assert.ok((dashboard.domainReceipt?.evidenceMissing?.length ?? 0) > 0)
  assert.ok((dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0) > 0)

  const withoutDensity = softwareQualityGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'defectDensity'))
  }))
  const missingDensity = await runDashboardDomainChatRequest({
    question: softwareQualityGoldenFixture.request,
    scope: { projectIds: [softwareQualityGoldenFixture.projectId] },
    generatedAt: softwareQualityGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(withoutDensity)))
  assert.equal(missingDensity.status, 'clarification')
  assert.equal(missingDensity.reason, 'missing-metric-source')
  assert.equal(missingDensity.dashboard, undefined)
  assert.ok(!JSON.stringify(missingDensity).includes('缺陷总数'))

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '型号组织管理负责人基于受控样例生成软件质量与缺陷闭环大屏',
    scope: { projectIds: [softwareQualityGoldenFixture.projectId] },
    generatedAt: softwareQualityGoldenFixture.generatedAt
  }, engine)
  assert.equal(roleMismatch.status, 'clarification')
  assert.equal(roleMismatch.reason, 'role-not-applicable')
  assert.equal(roleMismatch.dashboard, undefined)
  assert.equal(modelCalls, 0)

  console.log(JSON.stringify({
    ok: true,
    scenario: dashboard.domainContext?.scenario,
    title: dashboard.title,
    metricIds: dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    components: dashboard.components.map((component) => ({
      id: component.id,
      title: component.title,
      type: component.type,
      dimensions: component.semanticBinding?.dimensionFields
    })),
    receipt: dashboard.domainReceipt,
    guards: [missingDensity.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
