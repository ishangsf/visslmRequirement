import { strict as assert } from 'node:assert'
import type { DashboardDomainRole } from '../src/shared/dashboard-domain'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { resolveDashboardDomainPlan } from '../src/main/experts/dashboard-domain-planner'

type PlannerInput = {
  request: string
  role?: DashboardDomainRole
  scenario?: string
  projectIds?: readonly string[]
  tailoringBaselineId?: string
  permissions?: readonly string[]
  availableMetricIds?: readonly string[]
  dataQuality?: 'reliable' | 'invalid'
  metricConflicts?: readonly string[]
}

type ClarificationReason =
  | 'missing-role'
  | 'missing-project-scope'
  | 'metric-definition-conflict'
  | 'missing-metric-source'
  | 'missing-tailoring-baseline'
  | 'insufficient-permission'
  | 'invalid-data-quality'
  | 'scenario-not-active'

type PlannerPlan = {
  status: 'ready' | 'clarification'
  role?: DashboardDomainRole
  scenario?: string
  metricIds?: readonly string[]
  processBindingIds?: readonly string[]
  reason?: ClarificationReason
  clarification?: {
    reason: ClarificationReason
    options: readonly { id: string; label: string; recommended: boolean }[]
  }
}

const resolve = resolveDashboardDomainPlan as unknown as (
  input: PlannerInput
) => PlannerPlan

const expectedMetricIds = [
  'project-health',
  'milestone-achievement',
  'requirement-completion',
  'defect-density',
  'high-risk-count',
  'process-compliance'
] as const

const completeInput: PlannerInput = {
  request: '项目负责人要生成项目综合态势大屏',
  role: 'project-owner',
  scenario: 'project-overview',
  projectIds: ['project-alpha'],
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  permissions: ['project:read', 'process:evidence:read'],
  availableMetricIds: expectedMetricIds,
  dataQuality: 'reliable'
}

const assertCatalogIdsOnly = (plan: PlannerPlan): void => {
  const metricIds = plan.metricIds ?? []
  const processBindingIds = plan.processBindingIds ?? []
  const catalogMetricIds = new Set(dashboardDomainCatalog.metrics.map((metric) => metric.id))
  const catalogProcessBindingIds = new Set(
    dashboardDomainCatalog.processBindings.map((binding) => binding.id)
  )
  assert.ok(metricIds.length > 0, '规划结果必须返回 metric IDs')
  assert.ok(processBindingIds.length > 0, '规划结果必须返回 process binding IDs')
  assert.ok(metricIds.every((id) => catalogMetricIds.has(id)),
    '规划结果只能引用目录中的 metric IDs')
  assert.ok(processBindingIds.every((id) => catalogProcessBindingIds.has(id)),
    '规划结果只能引用目录中的 process binding IDs')
  assert.equal('query' in plan, false, '规划阶段不得生成 QuerySpec')
  assert.equal('sql' in plan, false, '规划阶段不得生成 SQL')
  assert.equal('javascript' in plan, false, '规划阶段不得生成 JavaScript')
  assert.equal('records' in plan, false, '规划阶段不得生成模拟正式数据')
  assert.equal('data' in plan, false, '规划阶段不得生成模拟正式数据')
}

const assertReady = (plan: PlannerPlan, scenario: string): PlannerPlan => {
  assert.equal(plan.status, 'ready')
  assert.equal(plan.role, 'project-owner')
  assert.equal(plan.scenario, scenario)
  assertCatalogIdsOnly(plan)
  return plan
}

const assertClarification = (
  input: PlannerInput,
  reason: ClarificationReason,
  expectedScenario?: string
): void => {
  const plan = resolve(input)
  assert.equal(plan.status, 'clarification', `${reason} 必须阻断为 clarification`)
  assert.equal(plan.reason, reason, `${reason} reason 必须稳定`)
  if (expectedScenario) {
    assert.equal(plan.scenario, expectedScenario,
      `${reason} 必须保留原始 planned scenario ID`)
    assert.notEqual(plan.scenario, 'project-overview',
      `${reason} 不得静默回退到 project-overview`)
  }
  assert.ok(plan.clarification, `${reason} 必须返回 clarification 详情`)
  assert.equal(plan.clarification?.reason, reason, `${reason} clarification reason 必须稳定`)
  const options = plan.clarification?.options ?? []
  assert.ok(options.length >= 2 && options.length <= 3,
    `${reason} 必须提供 2-3 个业务选项`)
  assert.equal(options.filter((option) => option.recommended).length, 1,
    `${reason} 必须恰好有一个 recommended 选项`)
  assert.ok(options.every((option) => option.id.trim() && option.label.trim()),
    `${reason} 业务选项必须有稳定 id 与可读 label`)
  assertCatalogIdsOnly(plan)
}

const readyPlan = assertReady(resolve(completeInput), 'project-overview')
assert.deepEqual(new Set(readyPlan.metricIds), new Set(expectedMetricIds),
  '完整上下文必须规划项目综合态势六项指标')
assert.equal(readyPlan.processBindingIds?.length, expectedMetricIds.length,
  '完整上下文必须规划六项过程绑定')

const missingRole = { ...completeInput }
delete missingRole.role
assertClarification(missingRole, 'missing-role')

const missingProjectScope = { ...completeInput }
delete missingProjectScope.projectIds
assertClarification(missingProjectScope, 'missing-project-scope')

assertClarification({
  ...completeInput,
  metricConflicts: ['project-health']
}, 'metric-definition-conflict')

assertClarification({
  ...completeInput,
  availableMetricIds: expectedMetricIds.filter((id) => id !== 'defect-density')
}, 'missing-metric-source')

const missingTailoringBaseline = { ...completeInput }
delete missingTailoringBaseline.tailoringBaselineId
assertClarification(missingTailoringBaseline, 'missing-tailoring-baseline')

assertClarification({
  ...completeInput,
  permissions: ['project:read']
}, 'insufficient-permission')

assertClarification({
  ...completeInput,
  dataQuality: 'invalid'
}, 'invalid-data-quality')

assertClarification({
  ...completeInput,
  request: 'QA/EPG 生成 GJB5000B 过程证据符合度大屏',
  scenario: 'gjb5000b-compliance'
}, 'scenario-not-active', 'gjb5000b-compliance')

const generalizedPlan = assertReady(resolve({
  ...completeInput,
  request: '生成一个项目管理大屏',
  scenario: undefined
}), 'project-overview')
const selectedScenario = dashboardDomainCatalog.scenarios.find(
  (scenario) => scenario.id === generalizedPlan.scenario
)
assert.equal(selectedScenario?.status, 'active',
  '泛化请求只能推荐当前 active 场景')
assert.ok(dashboardDomainCatalog.scenarios
  .filter((scenario) => scenario.status === 'planned')
  .every((scenario) => scenario.id !== generalizedPlan.scenario),
  '泛化请求不得激活 planned 场景')

console.log(JSON.stringify({
  ok: true,
  ready: {
    role: readyPlan.role,
    scenario: readyPlan.scenario,
    metricIds: readyPlan.metricIds,
    processBindingIds: readyPlan.processBindingIds
  },
  clarificationReasons: [
    'missing-role',
    'missing-project-scope',
    'metric-definition-conflict',
    'missing-metric-source',
    'missing-tailoring-baseline',
    'insufficient-permission',
    'invalid-data-quality',
    'scenario-not-active'
  ],
  generalizedScenario: generalizedPlan.scenario
}, null, 2))
