import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { organizationImprovementGoldenFixture } from '../src/main/experts/dashboard-organization-improvement'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(organizationImprovementGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === organizationImprovementGoldenFixture.scenario)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.deepEqual(scenario.metricIds, organizationImprovementGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, organizationImprovementGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('组织级度量领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: organizationImprovementGoldenFixture.request,
    scope: { projectIds: [organizationImprovementGoldenFixture.projectId] },
    generatedAt: organizationImprovementGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'organization-improvement')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '组织级度量与过程改进（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'model-org-manager')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.deepEqual(dashboard.analysisBlueprint?.metrics.map((metric) => metric.id), organizationImprovementGoldenFixture.metricIds)
  assert.deepEqual(dashboard.components.map((component) => component.id), organizationImprovementGoldenFixture.componentIds)
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'organization-improvement-productivity-card': ['name'],
    'organization-improvement-defect-escape-card': ['lastModifyTime'],
    'organization-improvement-baseline-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.query)
    assert.deepEqual(component.query?.scope.nodeTypes, ['OrganizationImprovementSample'])
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(component.semanticBinding?.dimensionFields ?? [], expectedDimensions[component.id] ?? [])
  }

  const dispersion = dashboard.components.find((item) => item.id === 'organization-improvement-quality-dispersion-card')
  const productivity = dashboard.components.find((item) => item.id === 'organization-improvement-productivity-card')
  assert.equal(dispersion?.query?.measures?.[0]?.field, 'qualityDispersionScore')
  assert.equal(productivity?.query?.measures?.[0]?.field, 'productivityIndex')
  assert.equal(dispersion?.query?.measures?.[0]?.aggregation, 'avg')
  assert.ok(/项目间质量差异评分/.test(dispersion?.title ?? ''))
  assert.ok(/交付生产率指数/.test(productivity?.title ?? ''))
  assert.match(
    dashboardDomainCatalog.metrics.find((metric) => metric.id === 'project-quality-dispersion-score')?.definition ?? '',
    /预计算|不得由普通平均值冒充方差计算/
  )

  const withoutEscapeEvidence = organizationImprovementGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'defectEscapeRate'))
  }))
  const missingEscapeEvidence = await runDashboardDomainChatRequest({
    question: organizationImprovementGoldenFixture.request,
    scope: { projectIds: [organizationImprovementGoldenFixture.projectId] },
    generatedAt: organizationImprovementGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(withoutEscapeEvidence)))
  assert.equal(missingEscapeEvidence.status, 'clarification')
  assert.equal(missingEscapeEvidence.reason, 'missing-metric-source')

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '研发负责人基于受控样例生成组织级度量与过程改进大屏',
    scope: { projectIds: [organizationImprovementGoldenFixture.projectId] },
    generatedAt: organizationImprovementGoldenFixture.generatedAt
  }, engine)
  assert.equal(roleMismatch.status, 'clarification')
  assert.equal(roleMismatch.reason, 'role-not-applicable')
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
      field: component.query?.measures?.[0]?.field,
      dimensions: component.semanticBinding?.dimensionFields
    })),
    receipt: dashboard.domainReceipt,
    semanticGuards: ['precomputed-quality-dispersion', 'versioned-productivity-index'],
    guards: [missingEscapeEvidence.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
