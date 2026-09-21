import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import {
  configurationChangeGoldenFixture
} from '../src/main/experts/dashboard-configuration-change'
import {
  createDashboardDomainControlledScenarioContext,
  getDashboardDomainControlledFixture
} from '../src/main/experts/dashboard-domain-controlled-fixtures'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { generateDashboardDomainArtifact } from '../src/main/experts/dashboard-domain-generation'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { gjb5000bComplianceGoldenFixture } from '../src/main/experts/dashboard-gjb5000b-compliance'
import { organizationImprovementGoldenFixture } from '../src/main/experts/dashboard-organization-improvement'
import { planMilestoneGoldenFixture } from '../src/main/experts/dashboard-plan-milestone'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import { requirementsDeliveryGoldenFixture } from '../src/main/experts/dashboard-requirements-delivery'
import { softwareQualityGoldenFixture } from '../src/main/experts/dashboard-software-quality'
import { testValidationGoldenFixture } from '../src/main/experts/dashboard-test-validation'
import type {
  DashboardDomainPlatformAdapter,
  DashboardDomainRole
} from '../src/shared/dashboard-domain'
import type { DataScope } from '../src/shared/query-spec'

type ScenarioFixture = {
  role: DashboardDomainRole
  scenario: string
  projectId: string
  tailoringBaselineId: string
  generatedAt: string
  request: string
  metricIds: readonly string[]
  componentIds: readonly string[]
  records: readonly AnalyticsRecord[]
}

const projectOverviewFixture: ScenarioFixture = {
  role: 'project-owner',
  scenario: 'project-overview',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: '项目负责人基于受控样例生成项目综合态势大屏',
  metricIds: projectOverviewGoldenFixture.spec.analysisBlueprint?.metrics.map((metric) => metric.id) ?? [],
  componentIds: projectOverviewGoldenFixture.spec.components.map((component) => component.id),
  records: projectOverviewGoldenFixture.records
}

const scenarioFixtures: readonly ScenarioFixture[] = [
  projectOverviewFixture,
  requirementsDeliveryGoldenFixture,
  planMilestoneGoldenFixture,
  softwareQualityGoldenFixture,
  testValidationGoldenFixture,
  configurationChangeGoldenFixture,
  gjb5000bComplianceGoldenFixture,
  organizationImprovementGoldenFixture
]

const makeDb = (
  records: readonly AnalyticsRecord[],
  observedScopes: DataScope[] = []
): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    observedScopes.push({ ...scope })
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const permissions = ['project:read', 'process:evidence:read'] as const

const generateControlledScenario = async (fixture: ScenarioFixture) => {
  const context = createDashboardDomainControlledScenarioContext(fixture.scenario)
  assert.ok(context, `${fixture.scenario} must be registered as a controlled scenario`)
  const registeredFixture = getDashboardDomainControlledFixture(fixture.scenario)
  assert.ok(registeredFixture, `${fixture.scenario} must resolve from the controlled fixture registry`)
  assert.equal(context.fixture.projectId, fixture.projectId,
    `${fixture.scenario} context must use the fixture projectId`)
  assert.equal(context.fixture.projectId, registeredFixture.projectId,
    `${fixture.scenario} context and registry projectId must agree`)
  assert.deepEqual(context.fixture.records, fixture.records,
    `${fixture.scenario} context must use the expected fixture records`)
  assert.deepEqual(context.fixture.records, registeredFixture.records,
    `${fixture.scenario} context records must match the registry`)

  const staleRealProjectId = `real-project-for-${fixture.scenario}`
  assert.deepEqual(
    context.queryEngine.profile({ projectIds: [staleRealProjectId] }),
    [],
    `${fixture.scenario} controlled context must reject a stale real-project scope`
  )

  const engine = context.queryEngine
  const result = await generateDashboardDomainArtifact({
    request: fixture.request,
    scope: { projectIds: [fixture.projectId] },
    role: fixture.role,
    scenario: fixture.scenario,
    tailoringBaselineId: fixture.tailoringBaselineId,
    permissions,
    generatedAt: fixture.generatedAt
  }, engine)

  assert.equal(result.status, 'ready', `${fixture.scenario} must return a ready dashboard: ${JSON.stringify(result)}`)
  assert.equal(result.dataMode, 'controlled-sample', `${fixture.scenario} must use controlled-sample mode`)
  assert.ok(result.dashboard, `${fixture.scenario} must return DashboardSpec`)
  const dashboard = result.dashboard
  assert.equal(dashboard.domainContext?.scenario, fixture.scenario)
  assert.equal(dashboard.domainContext?.role, fixture.role)
  assert.equal(dashboard.domainContext?.tailoringBaselineId, fixture.tailoringBaselineId)
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.equal(dashboard.domainContext?.dataMode, 'controlled-sample')
  assert.equal(dashboard.title.endsWith('（受控样例）'), true)
  assert.deepEqual(
    new Set(dashboard.analysisBlueprint?.metrics.map((metric) => metric.id)),
    new Set(fixture.metricIds),
    `${fixture.scenario} must use the catalog metric set from its fixture`
  )
  const expectedComponentIds = fixture.scenario === 'gjb5000b-compliance'
    ? [
        'gjb5000b-compliance-activity-card',
        'gjb5000b-compliance-work-product-card',
        'gjb5000b-compliance-evidence-headline-card',
        'gjb5000b-compliance-nonconformity-headline-card',
        'gjb5000b-compliance-evidence-card',
        'gjb5000b-compliance-evidence-detail-card',
        'gjb5000b-compliance-deviation-card',
        'gjb5000b-compliance-evidence-ranking-card',
        'gjb5000b-compliance-nonconformity-card'
      ]
    : [...fixture.componentIds]
  assert.deepEqual(
    new Set(dashboard.components.map((component) => component.id)),
    new Set(expectedComponentIds),
    `${fixture.scenario} must use the expected public component set`
  )
  assert.equal(validateDashboardSpec(dashboard, engine).length, 0,
    `${fixture.scenario} dashboard must pass DashboardSpec validation`)

  const fixtureNodeTypes = new Set(fixture.records.map((record) => record.nodeType))
  assert.equal(fixtureNodeTypes.size, 1, `${fixture.scenario} fixture must have one controlled node type`)
  const nodeType = [...fixtureNodeTypes][0]
  assert.ok(nodeType)
  assert.ok(engine.profile({ projectIds: [fixture.projectId], nodeTypes: [nodeType] }).length > 0,
    `${fixture.scenario} must profile/query its fixture project and node type`)
  for (const component of dashboard.components) {
    assert.ok(component.query, `${fixture.scenario}/${component.id} must have a QuerySpec`)
    assert.deepEqual(component.query?.scope.projectIds, [fixture.projectId])
    assert.deepEqual(component.query?.scope.nodeTypes, [nodeType])
    assert.ok(component.data.length > 0, `${fixture.scenario}/${component.id} must have fixture-backed data`)
    const dataset = engine.execute(component.query!)
    const valueMeasureId = component.encoding?.value ?? component.query?.measures[0]?.id
    assert.ok(valueMeasureId)
    assert.deepEqual(
      component.data.map((point) => point.value).sort((left, right) => left - right),
      dataset.rows
        .map((row) => Number(row[valueMeasureId]) * (component.encoding?.valueScale ?? 1))
        .sort((left, right) => left - right),
      `${fixture.scenario}/${component.id} data must come from QueryEngine`
    )
  }

  return {
    scenario: fixture.scenario,
    role: fixture.role,
    metricCount: fixture.metricIds.length,
    componentCount: dashboard.components.length,
    nodeType,
    fixtureRecordCount: context.fixture.records.length
  }
}

const platformRecords: readonly AnalyticsRecord[] = [
  {
    uid: 'platform-project-overview-001',
    projectId: 'platform-project-001',
    nodeType: 'ProjectStatusRecord',
    itemId: 'PROJECT-OVERVIEW-001',
    name: '平台项目快照',
    lastModifyTime: '2026-08-28T00:00:00.000Z',
    raw: {
      health_indicator: 0.82,
      milestone_ratio: 0.88,
      requirement_ratio: 0.79,
      defect_per_size: 0.12,
      risk_total: 4,
      process_rate: 0.86
    }
  }
]

const platformMetricBindings: DashboardDomainPlatformAdapter['metricBindings'] = [
  { metricId: 'project-health', field: 'health_indicator', aggregation: 'avg' },
  { metricId: 'milestone-achievement', field: 'milestone_ratio', aggregation: 'avg' },
  { metricId: 'requirement-completion', field: 'requirement_ratio', aggregation: 'avg' },
  { metricId: 'defect-density', field: 'defect_per_size', aggregation: 'avg' },
  { metricId: 'high-risk-count', field: 'risk_total', aggregation: 'sum' },
  { metricId: 'process-compliance', field: 'process_rate', aggregation: 'avg' }
]
const platformScenario = dashboardDomainCatalog.scenarios.find((scenario) => scenario.id === 'project-overview')
assert.ok(platformScenario)
const platformProcessBindingIds = dashboardDomainCatalog.processBindings
  .filter((binding) => binding.metricIds.some((metricId) => platformScenario.metricIds.includes(metricId)))
  .map((binding) => binding.id)
const platformAdapter: DashboardDomainPlatformAdapter = {
  schemaVersion: '1.0',
  id: 'scenario-wizard-platform-v1',
  scenarioId: 'project-overview',
  sourceSystem: 'VISSLM lifecycle platform',
  allowedProjectIds: ['platform-project-001'],
  permissions: [...permissions],
  nodeTypes: ['ProjectStatusRecord'],
  tailoringBaselineId: 'BL-SCENARIO-WIZARD-2026-V1',
  metricBindings: platformMetricBindings,
  questionBindings: [
    { questionId: 'project-overview-defect-question', dimensionFields: ['name'] }
  ],
  evidenceBindings: platformProcessBindingIds.map((processBindingId) => ({
    processBindingId,
    evidenceStatus: 'sufficient' as const,
    sourceKey: `platform.process.${processBindingId}`
  })),
  updatedAt: '2026-08-28T00:00:00.000Z'
}

const run = async (): Promise<void> => {
  const originalFetch = globalThis.fetch
  let modelCalls = 0
  globalThis.fetch = (async () => {
    modelCalls += 1
    throw new Error('structured scenario generation must not call a model')
  }) as typeof globalThis.fetch

  try {
    const controlled = []
    for (const fixture of scenarioFixtures) controlled.push(await generateControlledScenario(fixture))

    const platformResult = await runDashboardDomainChatRequest({
      question: '项目负责人生成项目综合态势大屏',
      scope: { projectIds: ['platform-project-001'] },
      permissions,
      platformAdapter,
      generatedAt: '2026-08-28T00:00:00.000Z'
    }, new QueryEngine(makeDb(platformRecords)))
    assert.equal(platformResult.status, 'ready', JSON.stringify(platformResult))
    assert.ok(platformResult.dashboard)
    assert.equal(platformResult.dashboard.domainContext?.scenario, 'project-overview')
    assert.equal(platformResult.dashboard.domainContext?.tailoringBaselineId, platformAdapter.tailoringBaselineId)
    assert.equal(platformResult.dashboard.domainContext?.dataMode, 'platform-adapter')
    assert.equal(platformResult.dashboard.title, '项目综合态势（平台数据预览）')
    assert.deepEqual(platformResult.dashboard.components[0]?.query?.scope.nodeTypes, platformAdapter.nodeTypes)
    assert.equal(
      platformResult.dashboard.components.find((component) => component.id === 'project-overview-health-card')?.query?.measures[0]?.field,
      'health_indicator'
    )
    assert.equal(modelCalls, 0)

    console.log(JSON.stringify({
      ok: true,
      controlled,
      platformAdapter: {
        id: platformAdapter.id,
        scenario: platformResult.dashboard.domainContext?.scenario,
        title: platformResult.dashboard.title,
        nodeTypes: platformResult.dashboard.components[0]?.query?.scope.nodeTypes
      },
      modelCalls
    }, null, 2))
  } finally {
    globalThis.fetch = originalFetch
  }
}

await run()
