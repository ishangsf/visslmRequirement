import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { planMilestoneGoldenFixture } from '../src/main/experts/dashboard-plan-milestone'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(planMilestoneGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) =>
  item.id === planMilestoneGoldenFixture.scenario
)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.deepEqual(scenario.metricIds, planMilestoneGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, planMilestoneGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('计划与里程碑领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: planMilestoneGoldenFixture.request,
    scope: { projectIds: [planMilestoneGoldenFixture.projectId] },
    generatedAt: planMilestoneGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'plan-milestone')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, '计划与里程碑执行（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'project-owner')
  assert.equal(dashboard.domainContext?.scenario, 'plan-milestone')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.match(result.answer ?? '', /计划与里程碑执行/)
  assert.deepEqual(
    dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    planMilestoneGoldenFixture.metricIds
  )
  assert.deepEqual(
    dashboard.components.map((component) => component.id),
    planMilestoneGoldenFixture.componentIds
  )
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])

  const expectedDimensions: Record<string, readonly string[]> = {
    'plan-milestone-variance-card': ['lastModifyTime'],
    'plan-milestone-critical-path-card': ['name'],
    'plan-milestone-forecast-card': ['name']
  }
  for (const component of dashboard.components) {
    assert.ok(component.title.trim())
    assert.ok(!/需求稳定|需求评审|测试覆盖|双向追溯|项目健康|缺陷密度/.test(component.title),
      `${component.id} 不得复用其他场景标题`)
    assert.ok(component.query)
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(
      component.semanticBinding?.dimensionFields ?? [],
      expectedDimensions[component.id] ?? []
    )
  }
  assert.equal(dashboard.components.find((item) => item.id === 'plan-milestone-forecast-card')?.type, 'table',
    '预测延期必须使用明细，不得伪装成精确甘特图')
  assert.ok(dashboard.analysisBlueprint?.metrics.some((metric) =>
    metric.id === 'delayed-task-count' &&
      /统计周期.*平均值|不得把结果标注为当前/.test(metric.description ?? '')
  ), 'QuerySpec 不支持 latest 时必须在指标口径中声明周期平均，不能冒充当前值')
  assert.match(
    dashboard.components.find((item) => item.id === 'plan-milestone-delayed-card')?.title ?? '',
    /平均值/,
    '延期任务组件标题必须显示聚合语义'
  )
  assert.ok((dashboard.domainReceipt?.evidenceMissing?.length ?? 0) > 0)
  assert.ok((dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0) > 0)

  const incompleteRecords = planMilestoneGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(
      Object.entries(record.raw).filter(([field]) => field !== 'criticalPathRiskScore')
    )
  }))
  const incomplete = await runDashboardDomainChatRequest({
    question: planMilestoneGoldenFixture.request,
    scope: { projectIds: [planMilestoneGoldenFixture.projectId] },
    generatedAt: planMilestoneGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(incompleteRecords)))
  assert.equal(incomplete.status, 'clarification')
  assert.equal(incomplete.reason, 'missing-metric-source')
  assert.equal(incomplete.dashboard, undefined)

  const roleMismatch = await runDashboardDomainChatRequest({
    question: 'QA/EPG 基于受控样例生成计划与里程碑执行大屏',
    scope: { projectIds: [planMilestoneGoldenFixture.projectId] },
    generatedAt: planMilestoneGoldenFixture.generatedAt
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
    guards: [incomplete.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
