import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { testValidationGoldenFixture } from '../src/main/experts/dashboard-test-validation'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(testValidationGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) =>
  item.id === testValidationGoldenFixture.scenario
)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.deepEqual(scenario.metricIds, testValidationGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, testValidationGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('测试验证领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: testValidationGoldenFixture.request,
    scope: { projectIds: [testValidationGoldenFixture.projectId] },
    generatedAt: testValidationGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'test-validation')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '测试与验证充分性（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'qa-epg')
  assert.equal(dashboard.domainContext?.scenario, 'test-validation')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.match(result.answer ?? '', /测试与验证充分性/)
  assert.deepEqual(
    dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    testValidationGoldenFixture.metricIds
  )
  assert.deepEqual(
    dashboard.components.map((component) => component.id),
    testValidationGoldenFixture.componentIds
  )
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'test-validation-requirement-coverage-card': ['name'],
    'test-validation-code-coverage-card': ['lastModifyTime'],
    'test-validation-blocked-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.title.trim())
    assert.ok(component.query)
    assert.deepEqual(component.query?.scope.nodeTypes, ['TestValidationSample'])
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(
      component.semanticBinding?.dimensionFields ?? [],
      expectedDimensions[component.id] ?? []
    )
  }
  const requirementCoverage = dashboard.components.find((item) =>
    item.id === 'test-validation-requirement-coverage-card'
  )
  const codeCoverage = dashboard.components.find((item) =>
    item.id === 'test-validation-code-coverage-card'
  )
  assert.equal(requirementCoverage?.query?.measures?.[0]?.field, 'testCoverage')
  assert.equal(codeCoverage?.query?.measures?.[0]?.field, 'codeCoverageRate')
  assert.notEqual(
    requirementCoverage?.query?.measures?.[0]?.field,
    codeCoverage?.query?.measures?.[0]?.field,
    '需求覆盖率和代码覆盖率不得复用同一字段口径'
  )
  assert.ok(/需求测试覆盖率/.test(requirementCoverage?.title ?? ''))
  assert.ok(/代码覆盖率/.test(codeCoverage?.title ?? ''))
  assert.ok((dashboard.domainReceipt?.evidenceMissing?.length ?? 0) > 0)
  assert.ok((dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0) > 0)

  const withoutCodeCoverage = testValidationGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'codeCoverageRate'))
  }))
  const missingCoverage = await runDashboardDomainChatRequest({
    question: testValidationGoldenFixture.request,
    scope: { projectIds: [testValidationGoldenFixture.projectId] },
    generatedAt: testValidationGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(withoutCodeCoverage)))
  assert.equal(missingCoverage.status, 'clarification')
  assert.equal(missingCoverage.reason, 'missing-metric-source')
  assert.equal(missingCoverage.dashboard, undefined)

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '型号组织管理负责人基于受控样例生成测试与验证充分性大屏',
    scope: { projectIds: [testValidationGoldenFixture.projectId] },
    generatedAt: testValidationGoldenFixture.generatedAt
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
      field: component.query?.measures?.[0]?.field,
      dimensions: component.semanticBinding?.dimensionFields
    })),
    receipt: dashboard.domainReceipt,
    guards: [missingCoverage.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
