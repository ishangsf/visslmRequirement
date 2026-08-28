import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { requirementsDeliveryGoldenFixture } from '../src/main/experts/dashboard-requirements-delivery'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(requirementsDeliveryGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) =>
  item.id === requirementsDeliveryGoldenFixture.scenario
)
assert.ok(scenario, '需求到交付全链路场景必须登记')
assert.equal(scenario.status, 'active', '第二期必须激活 requirements-delivery')
assert.deepEqual(scenario.metricIds, requirementsDeliveryGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, requirementsDeliveryGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('需求交付领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: requirementsDeliveryGoldenFixture.request,
    scope: { projectIds: [requirementsDeliveryGoldenFixture.projectId] },
    generatedAt: requirementsDeliveryGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.recognized, true)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, requirementsDeliveryGoldenFixture.scenario)
  assert.ok(result.dashboard, '需求到交付全链路必须生成 dashboard')
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '需求到交付全链路（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'project-owner')
  assert.equal(dashboard.domainContext?.scenario, 'requirements-delivery')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.match(result.answer ?? '', /需求到交付全链路/)
  assert.match(result.answer ?? '', /受控样例/)
  assert.deepEqual(
    dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    requirementsDeliveryGoldenFixture.metricIds
  )
  assert.deepEqual(
    dashboard.components.map((component) => component.id),
    requirementsDeliveryGoldenFixture.componentIds
  )
  assert.equal(dashboard.components.length, 6)
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'requirements-delivery-change-card': ['lastModifyTime'],
    'requirements-delivery-test-card': ['name'],
    'requirements-delivery-trace-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.title.trim(), `${component.id} 必须生成业务语义标题`)
    assert.ok(!/项目健康|里程碑|缺陷密度|高风险|过程合规/.test(component.title),
      `${component.id} 标题不得复用项目综合态势语义`)
    assert.ok(component.query, `${component.id} 必须有 QuerySpec`)
    assert.ok(component.data.length > 0, `${component.id} 必须有本地查询结果`)
    assert.ok(component.semanticBinding?.processBindingIds?.length,
      `${component.id} 必须有过程绑定`)
    assert.deepEqual(
      component.semanticBinding?.dimensionFields ?? [],
      expectedDimensions[component.id] ?? [],
      `${component.id} 维度必须与业务问题一致`
    )
  }
  assert.ok((dashboard.domainReceipt?.evidenceMissing?.length ?? 0) > 0)
  assert.ok((dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0) > 0)

  const incompleteRecords = requirementsDeliveryGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(
      Object.entries(record.raw).filter(([field]) => field !== 'traceabilityCompleteness')
    )
  }))
  const incomplete = await runDashboardDomainChatRequest({
    question: requirementsDeliveryGoldenFixture.request,
    scope: { projectIds: [requirementsDeliveryGoldenFixture.projectId] },
    generatedAt: requirementsDeliveryGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(incompleteRecords)))
  assert.equal(incomplete.status, 'clarification')
  assert.equal(incomplete.reason, 'missing-metric-source')
  assert.equal(incomplete.dashboard, undefined)

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '型号组织管理负责人基于受控样例生成需求到交付全链路大屏',
    scope: { projectIds: [requirementsDeliveryGoldenFixture.projectId] },
    generatedAt: requirementsDeliveryGoldenFixture.generatedAt
  }, engine)
  assert.equal(roleMismatch.status, 'clarification')
  assert.equal(roleMismatch.reason, 'role-not-applicable')
  assert.equal(roleMismatch.dashboard, undefined)
  assert.ok((roleMismatch.clarificationOptions?.length ?? 0) >= 2)
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
      dimensions: component.semanticBinding?.dimensionFields,
      processBindingIds: component.semanticBinding?.processBindingIds
    })),
    receipt: dashboard.domainReceipt,
    missingMetricGuard: incomplete.reason,
    roleGuard: roleMismatch.reason,
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
