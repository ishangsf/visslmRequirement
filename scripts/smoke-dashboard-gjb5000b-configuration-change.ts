import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { configurationChangeGoldenFixture } from '../src/main/experts/dashboard-configuration-change'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(configurationChangeGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) =>
  item.id === configurationChangeGoldenFixture.scenario
)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.deepEqual(scenario.metricIds, configurationChangeGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, configurationChangeGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('配置与变更领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: configurationChangeGoldenFixture.request,
    scope: { projectIds: [configurationChangeGoldenFixture.projectId] },
    generatedAt: configurationChangeGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'configuration-change')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '配置管理与变更控制（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'rd-lead')
  assert.equal(dashboard.domainContext?.scenario, 'configuration-change')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.match(result.answer ?? '', /配置管理与变更控制/)
  assert.deepEqual(dashboard.analysisBlueprint?.metrics.map((metric) => metric.id), configurationChangeGoldenFixture.metricIds)
  assert.deepEqual(dashboard.components.map((component) => component.id), configurationChangeGoldenFixture.componentIds)
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'configuration-change-approval-card': ['name'],
    'configuration-change-open-trend-card': ['lastModifyTime'],
    'configuration-change-reproducible-build-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.title.trim())
    assert.ok(component.query)
    assert.deepEqual(component.query?.scope.nodeTypes, ['ConfigurationChangeSample'])
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(component.semanticBinding?.dimensionFields ?? [], expectedDimensions[component.id] ?? [])
  }

  const approval = dashboard.components.find((item) => item.id === 'configuration-change-approval-card')
  const openChanges = dashboard.components.find((item) => item.id === 'configuration-change-open-trend-card')
  assert.equal(approval?.query?.measures?.[0]?.field, 'changeApprovalRate')
  assert.equal(openChanges?.query?.measures?.[0]?.field, 'openChangeCount')
  assert.notEqual(approval?.query?.measures?.[0]?.field, openChanges?.query?.measures?.[0]?.field,
    '变更审批率和未关闭变更数不得复用同一字段口径')
  assert.ok(/变更审批率/.test(approval?.title ?? ''))
  assert.ok(/未关闭变更数/.test(openChanges?.title ?? ''))
  assert.ok((dashboard.domainReceipt?.evidenceMissing?.length ?? 0) > 0)
  assert.ok((dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0) > 0)

  const withoutBuildEvidence = configurationChangeGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'reproducibleBuildRate'))
  }))
  const missingBuildEvidence = await runDashboardDomainChatRequest({
    question: configurationChangeGoldenFixture.request,
    scope: { projectIds: [configurationChangeGoldenFixture.projectId] },
    generatedAt: configurationChangeGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(withoutBuildEvidence)))
  assert.equal(missingBuildEvidence.status, 'clarification')
  assert.equal(missingBuildEvidence.reason, 'missing-metric-source')
  assert.equal(missingBuildEvidence.dashboard, undefined)

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '型号组织管理负责人基于受控样例生成配置管理与变更控制大屏',
    scope: { projectIds: [configurationChangeGoldenFixture.projectId] },
    generatedAt: configurationChangeGoldenFixture.generatedAt
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
    guards: [missingBuildEvidence.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
