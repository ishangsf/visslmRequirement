import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { DashboardComponentSpec, DashboardSpec } from '../src/shared/dashboard'
import { automaticDashboardComponentTitle } from '../src/shared/dashboard-semantics'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import { generateDashboardDomainArtifact } from '../src/main/experts/dashboard-domain-generation'

type GenerationInput = {
  request: string
  scope: { projectIds: readonly string[] }
  role?: 'project-owner'
  scenario?: 'project-overview'
  tailoringBaselineId?: string
  permissions?: readonly string[]
  dataQuality?: 'reliable' | 'invalid'
  metricConflicts?: readonly string[]
  generatedAt: string
}

type DomainBinding = NonNullable<DashboardComponentSpec['semanticBinding']> & {
  processBindingIds: readonly string[]
}

type DomainComponent = Omit<DashboardComponentSpec, 'semanticBinding'> & {
  semanticBinding: DomainBinding
}

type DomainDashboard = Omit<DashboardSpec, 'components'> & {
  components: readonly DomainComponent[]
  domainContext: NonNullable<DashboardSpec['domainContext']>
}

type GenerationReceipt = {
  adoptedMetricIds?: readonly string[]
  missingMetricIds?: readonly string[]
  evidenceMissing?: readonly string[]
  evidenceInsufficient?: readonly string[]
  confidence?: number
  warnings?: readonly string[]
  confirmations?: readonly string[]
  vetoCodes?: readonly string[]
}

type GenerationResult = {
  status: 'ready' | 'clarification' | 'rejected'
  dashboard?: DomainDashboard
  receipt?: GenerationReceipt
  reason?: string
  clarification?: { reason?: string }
}

const generate = generateDashboardDomainArtifact as unknown as (
  input: GenerationInput,
  queryEngine: QueryEngine
) => GenerationResult | Promise<GenerationResult>

const runGenerate = async (
  input: GenerationInput,
  queryEngine: QueryEngine
): Promise<GenerationResult> => generate(input, queryEngine)

const makeDb = (records: readonly AnalyticsRecord[], onScan: () => void): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    onScan()
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === 'project-overview')
assert.ok(scenario, 'catalog 必须包含 project-overview')
const metricIds = [...scenario.metricIds]
const processBindingIds = dashboardDomainCatalog.processBindings
  .filter((binding) => binding.metricIds.some((metricId) => metricIds.includes(metricId)))
  .map((binding) => binding.id)
const scope = { projectIds: ['sample-project-001'] as const }
const input: GenerationInput = {
  request: '项目负责人生成项目综合态势大屏',
  scope,
  role: 'project-owner',
  scenario: 'project-overview',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  permissions: ['project:read', 'process:evidence:read'],
  dataQuality: 'reliable',
  generatedAt: '2026-08-28T00:00:00.000Z'
}

let scanCount = 0
const queryEngine = new QueryEngine(makeDb(projectOverviewGoldenFixture.records, () => {
  scanCount += 1
}))
const originalFetch = globalThis.fetch
let fetchCount = 0
globalThis.fetch = (async () => {
  fetchCount += 1
  throw new Error('领域生成阶段不得调用模型')
}) as typeof globalThis.fetch

try {
  const generated = await runGenerate(input, queryEngine)
  assert.equal(generated.status, 'ready')
  assert.ok(generated.dashboard, '完整上下文必须返回 DashboardSpec')
  const dashboard = generated.dashboard
  assert.ok(dashboard.analysisBlueprint)
  assert.equal(dashboard.domainContext.role, 'project-owner')
  assert.equal(dashboard.domainContext.scenario, 'project-overview')
  assert.equal(dashboard.domainContext.catalogVersion, '1.0')
  assert.equal(dashboard.domainContext.tailoringBaselineId, input.tailoringBaselineId)
  assert.equal(dashboard.domainContext.artifactStatus, 'preview')
  assert.deepEqual(new Set(dashboard.analysisBlueprint.metrics.map((metric) => metric.id)), new Set(metricIds))
  assert.ok(dashboard.analysisBlueprint.metrics.every((metric) => metric.source === 'catalog'))
  assert.equal(dashboard.components.length, scenario.componentIds.length)
  assert.deepEqual(
    new Set(dashboard.components.map((component) => component.id)),
    new Set(scenario.componentIds)
  )

  const profileFields = new Set(queryEngine.profile(input.scope).map((profile) => profile.field))
  const processBindingSet = new Set(dashboardDomainCatalog.processBindings.map((binding) => binding.id))
  for (const component of dashboard.components) {
    assert.ok(component.semanticBinding, `组件 ${component.id} 必须有 semanticBinding`)
    assert.ok(component.semanticBinding.processBindingIds.length > 0,
      `组件 ${component.id} 必须有 processBindingIds`)
    assert.ok(component.semanticBinding.processBindingIds.every((id) => processBindingSet.has(id)))
    assert.ok(component.query, `组件 ${component.id} 必须有受控 QuerySpec`)
    assert.deepEqual(component.query.scope.projectIds, [...scope.projectIds],
      `组件 ${component.id} 必须保留输入 projectIds`)
    assert.ok(component.query.dimensions?.every((dimension) => profileFields.has(dimension.field)))
    assert.ok(component.query.measures.every((measure) => !measure.field || profileFields.has(measure.field)))
    assert.equal(component.title, automaticDashboardComponentTitle(dashboard.analysisBlueprint, component),
      `组件 ${component.id} 标题必须与 Blueprint 语义一致`)
    assert.ok(component.data.length > 0, `组件 ${component.id} data 不得为空`)
    assert.ok(component.data.every((point) => Number.isFinite(point.value)))

    const dataset = queryEngine.execute(component.query)
    const valueField = component.encoding?.value ?? component.query.measures[0]?.id
    assert.ok(valueField)
    const expectedValues = dataset.rows.map((row) => Number(row[valueField]))
    const actualValues = component.data.map((point) => point.value)
    assert.deepEqual([...actualValues].sort((left, right) => left - right),
      [...expectedValues].sort((left, right) => left - right),
      `组件 ${component.id} data 必须来自 QueryEngine 结果`)
  }
  assert.deepEqual(validateDashboardSpec(dashboard, queryEngine), [],
    '领域生成结果必须通过 DashboardSpec 与语义校验')
  assert.ok(scanCount > 0, '领域生成必须实际使用 QueryEngine，而非硬编码 fixture 结果')
  assert.equal('sql' in generated, false)
  assert.equal('javascript' in generated, false)
  assert.equal(fetchCount, 0, '领域生成阶段不得调用模型')

  const missingDefectRecords = projectOverviewGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'defectDensity'))
  }))
  const missingDefectEngine = new QueryEngine(makeDb(missingDefectRecords, () => undefined))
  const missingMetric = await runGenerate(input, missingDefectEngine)
  assert.equal(missingMetric.status, 'clarification')
  assert.equal(missingMetric.reason, 'missing-metric-source')
  assert.equal(missingMetric.dashboard, undefined)
  assert.ok(!JSON.stringify(missingMetric).includes('缺陷总数'),
    '缺失 defectDensity 时不得降级成“缺陷总数”伪结论')

  const invalidBaseline = await runGenerate({
    ...input,
    tailoringBaselineId: 'unknown-tailoring-baseline'
  }, queryEngine)
  assert.ok(['clarification', 'rejected'].includes(invalidBaseline.status))
  assert.equal(invalidBaseline.reason, 'invalid-tailoring-baseline')
  assert.equal(invalidBaseline.dashboard, undefined)
  assert.ok(
    invalidBaseline.receipt?.vetoCodes?.includes('invalid-tailoring-baseline') ||
      invalidBaseline.reason === 'invalid-tailoring-baseline',
    '错误裁剪基线必须以 invalid-tailoring-baseline 拒绝或追问'
  )

  console.log(JSON.stringify({
    ok: true,
    status: generated.status,
    role: dashboard.domainContext.role,
    scenario: dashboard.domainContext.scenario,
    artifactStatus: dashboard.domainContext.artifactStatus,
    metricCount: dashboard.analysisBlueprint.metrics.length,
    componentCount: dashboard.components.length,
    processBindingCount: processBindingIds.length,
    queryEngineScans: scanCount,
    modelCalls: fetchCount,
    rejectedCases: ['missing-metric-source', 'invalid-tailoring-baseline']
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
