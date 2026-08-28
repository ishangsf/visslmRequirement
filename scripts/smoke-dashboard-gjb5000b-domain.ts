import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { DashboardComponentSpec, DashboardSpec } from '../src/shared/dashboard'
import type {
  DashboardDomainCatalog,
  DashboardDomainRole,
  DashboardGoldenScenario,
  MetricCatalogEntry,
  ProcessBinding,
  DashboardQualityPolicy
} from '../src/shared/dashboard-domain'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import { evaluateDashboardDomainQualityGate } from '../src/main/dashboards/dashboard-domain-quality'

const expectedRoles: readonly DashboardDomainRole[] = [
  'project-owner',
  'qa-epg',
  'rd-lead',
  'model-org-manager'
]

const expectedScenarioIds = [
  'project-overview',
  'requirements-delivery',
  'plan-milestone',
  'software-quality',
  'test-validation',
  'configuration-change',
  'gjb5000b-compliance',
  'organization-improvement'
] as const

const expectedProjectOverviewMetricIds = [
  'project-health',
  'milestone-achievement',
  'requirement-completion',
  'defect-density',
  'high-risk-count',
  'process-compliance'
] as const

const expectedWeights = {
  businessMetric: 30,
  processCompliance: 20,
  semanticConsistency: 20,
  layoutReadability: 15,
  dataTrust: 10,
  accessibilityInteraction: 5
} as const

const catalog = dashboardDomainCatalog as DashboardDomainCatalog

assert.deepEqual(catalog.roles, expectedRoles, 'GJB 必须固定四类角色枚举')
assert.deepEqual(
  catalog.scenarios.map((scenario) => scenario.id),
  expectedScenarioIds,
  'GJB 必须固定八个黄金场景 ID'
)
assert.equal(catalog.scenarios.filter((scenario) => scenario.status === 'active').length, 6)
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'project-overview')?.status, 'active')
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'requirements-delivery')?.status, 'active')
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'plan-milestone')?.status, 'active')
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'software-quality')?.status, 'active')
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'test-validation')?.status, 'active')
assert.equal(catalog.scenarios.find((scenario) => scenario.id === 'configuration-change')?.status, 'active')
assert.ok(
  catalog.scenarios
    .filter((scenario) => ![
      'project-overview',
      'requirements-delivery',
      'plan-milestone',
      'software-quality',
      'test-validation',
      'configuration-change'
    ].includes(scenario.id))
    .every((scenario) => scenario.status === 'planned'),
  '第二期当前只能激活前六个场景，其余场景必须 planned'
)

const requiredMetricFields: Array<keyof MetricCatalogEntry> = [
  'id',
  'label',
  'definition',
  'formulaVersion',
  'sourceFields',
  'timeSemantics',
  'applicableScopes',
  'thresholds',
  'ownerRoles',
  'processRequirementIds'
]
for (const metric of catalog.metrics) {
  for (const field of requiredMetricFields) {
    const value = metric[field]
    assert.ok(
      value !== undefined && value !== null && value !== '',
      `MetricCatalogEntry ${metric.id} 缺少 ${String(field)}`
    )
  }
  assert.ok(metric.sourceFields.length > 0, `MetricCatalogEntry ${metric.id} 必须声明 sourceFields`)
  assert.ok(metric.applicableScopes.length > 0, `MetricCatalogEntry ${metric.id} 必须声明 applicableScopes`)
  assert.ok(metric.ownerRoles.length > 0, `MetricCatalogEntry ${metric.id} 必须声明 ownerRoles`)
  assert.ok(metric.processRequirementIds.length > 0,
    `MetricCatalogEntry ${metric.id} 必须声明 processRequirementIds`)
}

const processBindings = catalog.processBindings as readonly ProcessBinding[]
assert.ok(processBindings.length > 0, 'GJB 必须提供过程绑定目录')
for (const binding of processBindings) {
  assert.ok(['missing', 'insufficient', 'sufficient'].includes(binding.evidenceStatus),
    `过程证据状态必须区分 missing/insufficient/sufficient: ${binding.id}`)
  assert.ok(binding.tailoringBaselineId,
    `过程绑定 ${binding.id} 必须携带 tailoringBaselineId`)
  assert.ok(binding.activityId, `过程绑定 ${binding.id} 必须可下钻到 activity`)
  assert.ok(binding.workProductId, `过程绑定 ${binding.id} 必须可下钻到 workProduct`)
  assert.ok(binding.evidenceId, `过程绑定 ${binding.id} 必须可下钻到 evidence`)
}
const evidenceStatuses = new Set(processBindings.map((binding) => binding.evidenceStatus))
assert.ok(evidenceStatuses.has('missing'), '过程目录必须有 missing 证据状态')
assert.ok(evidenceStatuses.has('insufficient'), '过程目录必须有 insufficient 证据状态')

const policy = catalog.qualityPolicy as DashboardQualityPolicy
assert.deepEqual(policy.weights, expectedWeights, '质量策略必须锁定 30/20/20/15/10/5 权重')
assert.equal(Object.values(policy.weights).reduce((total, value) => total + value, 0), 100)
assert.equal(policy.formalAcceptanceThreshold, 90)
assert.equal(policy.previewThreshold, 80)
assert.deepEqual(
  new Set(policy.vetoCodes),
  new Set([
    'metric-definition-error',
    'fabricated-data',
    'permission-violation',
    'invalid-tailoring-baseline'
  ])
)

const projectOverview = catalog.scenarios.find(
  (scenario): scenario is DashboardGoldenScenario => scenario.id === 'project-overview'
)
assert.ok(projectOverview, '必须提供第一期 project-overview 场景')
assert.deepEqual(
  projectOverview.metricIds,
  expectedProjectOverviewMetricIds,
  '项目综合态势必须覆盖六项核心指标'
)
assert.ok(projectOverview.lines.includes('execution'), '项目综合态势必须覆盖执行线')
assert.ok(projectOverview.lines.includes('process'), '项目综合态势必须覆盖过程线')
for (const metricId of expectedProjectOverviewMetricIds) {
  assert.ok(projectOverview.questionIds.some((questionId) =>
    catalog.questions.some((question) => question.id === questionId && question.metricIds.includes(metricId))
  ), `项目综合态势指标 ${metricId} 必须映射到业务问题`)
  assert.ok(projectOverview.componentIds.some((componentId) =>
    catalog.components.some((component) => component.id === componentId && component.metricIds.includes(metricId))
  ), `项目综合态势指标 ${metricId} 必须映射到组件`)
}

type DomainContext = {
  role: 'project-owner'
  scenario: 'project-overview'
  catalogVersion: '1.0'
  tailoringBaselineId: string
  artifactStatus: 'preview' | 'formal'
}

type DomainSemanticBinding = NonNullable<DashboardComponentSpec['semanticBinding']> & {
  processBindingIds: readonly string[]
}

type DomainComponent = Omit<DashboardComponentSpec, 'semanticBinding'> & {
  semanticBinding: DomainSemanticBinding
}

type ProjectOverviewSpec = Omit<DashboardSpec, 'analysisBlueprint' | 'components'> & {
  domainContext: DomainContext
  analysisBlueprint: NonNullable<DashboardSpec['analysisBlueprint']>
  components: readonly DomainComponent[]
}

type ProjectOverviewFixture = {
  records: readonly AnalyticsRecord[]
  spec: ProjectOverviewSpec
}

const fixture = projectOverviewGoldenFixture as unknown as ProjectOverviewFixture
const projectSpec = fixture.spec
assert.equal(projectSpec.domainContext.role, 'project-owner')
assert.equal(projectSpec.domainContext.scenario, 'project-overview')
assert.equal(projectSpec.domainContext.catalogVersion, '1.0')
assert.ok(projectSpec.domainContext.tailoringBaselineId)
assert.equal(projectSpec.domainContext.artifactStatus, 'preview',
  '受控样例只能作为 preview，不能伪装为 formal')

assert.equal(projectSpec.components.length, expectedProjectOverviewMetricIds.length)
const fixtureMetricIds = projectSpec.components.flatMap((component) => {
  assert.ok(component.semanticBinding.processBindingIds.length > 0,
    `组件 ${component.id} 必须携带 processBindingIds`)
  return component.semanticBinding.metricIds
})
assert.deepEqual(
  new Set(fixtureMetricIds),
  new Set(expectedProjectOverviewMetricIds),
  '项目综合态势六个组件必须一一对应六项核心指标'
)
assert.ok(projectSpec.analysisBlueprint.metrics.every((metric) => metric.source === 'catalog'),
  '项目综合态势 Blueprint 的指标必须全部来自受控 catalog')
for (const metricId of expectedProjectOverviewMetricIds) {
  assert.ok(projectSpec.analysisBlueprint.metrics.some((metric) => metric.id === metricId),
    `项目综合态势 Blueprint 缺少指标 ${metricId}`)
}

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(fixture.records))
assert.deepEqual(validateDashboardSpec(projectSpec, engine), [],
  '项目综合态势 fixture 必须通过 DashboardSpec 校验')
for (const component of projectSpec.components) {
  assert.ok(component.query, `项目综合态势组件 ${component.id} 必须有 QuerySpec`)
  const dataset = engine.execute(component.query!)
  assert.ok(dataset.rows.length > 0, `项目综合态势组件 ${component.id} 查询不得为空`)
}
for (let leftIndex = 0; leftIndex < projectSpec.components.length; leftIndex += 1) {
  const left = projectSpec.components[leftIndex]
  for (let rightIndex = leftIndex + 1; rightIndex < projectSpec.components.length; rightIndex += 1) {
    const right = projectSpec.components[rightIndex]
    const overlaps = left.layout.x < right.layout.x + right.layout.w &&
      left.layout.x + left.layout.w > right.layout.x &&
      left.layout.y < right.layout.y + right.layout.h &&
      left.layout.y + left.layout.h > right.layout.y
    assert.equal(overlaps, false, `项目综合态势布局重叠: ${left.id}/${right.id}`)
  }
}

type QualityGateResult = { status: 'formal' | 'preview' | 'rejected' }
type QualityGateInput = { score: number; vetoCodes: readonly string[] }
const evaluateQualityGate = evaluateDashboardDomainQualityGate as unknown as (
  input: QualityGateInput
) => QualityGateResult
const gateStatus = (score: number, vetoCodes: readonly string[] = []): QualityGateResult['status'] =>
  evaluateQualityGate({ score, vetoCodes }).status
assert.equal(gateStatus(95), 'formal')
assert.equal(gateStatus(85), 'preview')
assert.equal(gateStatus(79), 'rejected')
assert.equal(gateStatus(100, ['metric-definition-error']), 'rejected')

console.log(JSON.stringify({
  ok: true,
  roles: catalog.roles,
  scenarios: catalog.scenarios.map(({ id, status }) => ({ id, status })),
  projectOverviewMetrics: projectOverview.metricIds,
  qualityWeights: policy.weights,
  formalAcceptanceThreshold: policy.formalAcceptanceThreshold,
  previewThreshold: policy.previewThreshold,
  vetoCodes: policy.vetoCodes,
  projectOverviewFixture: {
    role: projectSpec.domainContext.role,
    scenario: projectSpec.domainContext.scenario,
    artifactStatus: projectSpec.domainContext.artifactStatus,
    componentCount: projectSpec.components.length,
    queryValidated: true,
    qualityStatuses: {
      score95: gateStatus(95),
      score85: gateStatus(85),
      score79: gateStatus(79),
      veto: gateStatus(100, ['metric-definition-error'])
    }
  }
}, null, 2))
