import { strict as assert } from 'node:assert'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { compileDashboardDomainBlueprint } from '../src/main/experts/dashboard-domain-blueprint'

type PlannerInput = {
  request: string
  role: 'project-owner'
  scenario: 'project-overview'
  projectIds: readonly string[]
  tailoringBaselineId: string
  metricIds: readonly string[]
  processBindingIds: readonly string[]
  generatedAt: string
}

type ComponentPlan = {
  id: string
  type: string
  slotRole: string
  questionIds: readonly string[]
  metricIds: readonly string[]
  processBindingIds: readonly string[]
  layout: { x: number; y: number; w: number; h: number }
}

type CompiledBlueprint = {
  analysisBlueprint: {
    audience: string
    objective: string
    scopeDescription: string
    metrics: readonly { id: string; source: string }[]
    questions: readonly { id: string; metricIds: readonly string[] }[]
  }
  domainContext: {
    role: string
    scenario: string
    catalogVersion: string
    tailoringBaselineId: string
    artifactStatus: string
  }
  componentPlans: readonly ComponentPlan[]
  receipt: {
    adoptedMetricIds: readonly string[]
    missingMetricIds: readonly string[]
    evidenceMissing: readonly string[]
    evidenceInsufficient: readonly string[]
    confidence: number
    warnings: readonly string[]
    confirmations: readonly string[]
  }
}

const compile = compileDashboardDomainBlueprint as unknown as (
  input: PlannerInput
) => CompiledBlueprint

const projectOverview = dashboardDomainCatalog.scenarios.find(
  (scenario) => scenario.id === 'project-overview'
)
assert.ok(projectOverview, 'catalog 必须包含 project-overview')
const metricIds = projectOverview.metricIds
const processBindingIds = dashboardDomainCatalog.processBindings
  .filter((binding) => binding.metricIds.some((metricId) => metricIds.includes(metricId)))
  .map((binding) => binding.id)
const completeInput: PlannerInput = {
  request: '项目负责人生成项目综合态势大屏',
  role: 'project-owner',
  scenario: 'project-overview',
  projectIds: ['project-alpha'],
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  metricIds,
  processBindingIds,
  generatedAt: '2026-08-28T00:00:00.000Z'
}

const compiled = compile(completeInput)
const blueprint = compiled.analysisBlueprint
assert.ok(blueprint.audience.trim(), 'Blueprint audience 必须非空')
assert.ok(blueprint.objective.trim(), 'Blueprint objective 必须非空')
assert.ok(blueprint.scopeDescription.trim(), 'Blueprint scopeDescription 必须非空')
assert.deepEqual(new Set(blueprint.metrics.map((metric) => metric.id)), new Set(metricIds))
assert.ok(blueprint.metrics.every((metric) => metric.source === 'catalog'),
  'Blueprint 指标必须全部来自 catalog')
assert.ok(blueprint.questions.length > 0, 'Blueprint 必须包含业务问题')
const scenarioQuestionIds = new Set(projectOverview.questionIds)
const scenarioMetricIds = new Set(projectOverview.metricIds)
for (const question of blueprint.questions) {
  assert.ok(scenarioQuestionIds.has(question.id), `问题 ${question.id} 必须来自 project-overview 场景`)
  assert.ok(question.metricIds.length > 0)
  assert.ok(question.metricIds.every((metricId) => scenarioMetricIds.has(metricId)),
    `问题 ${question.id} 不得引用场景外指标`)
}

const assertNoExecutableArtifacts = (value: unknown, path: string): void => {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['query', 'sql', 'javascript', 'data', 'rows', 'records'].includes(key.toLowerCase()),
      `${path} 不得生成 QuerySpec/SQL/模拟 data: ${key}`)
    assertNoExecutableArtifacts(child, `${path}.${key}`)
  }
}
assertNoExecutableArtifacts(blueprint, 'analysisBlueprint')

assert.equal(compiled.domainContext.role, 'project-owner')
assert.equal(compiled.domainContext.scenario, 'project-overview')
assert.equal(compiled.domainContext.catalogVersion, '1.0')
assert.equal(compiled.domainContext.tailoringBaselineId, completeInput.tailoringBaselineId)
assert.equal(compiled.domainContext.artifactStatus, 'preview',
  '受控样例且没有真实数据适配器时不得标记 formal')

assert.deepEqual(
  new Set(compiled.componentPlans.map((component) => component.id)),
  new Set(projectOverview.componentIds),
  'componentPlans 必须精确覆盖场景组件'
)
const catalogComponentById = new Map(
  dashboardDomainCatalog.components.map((component) => [component.id, component])
)
const catalogQuestionById = new Map(
  dashboardDomainCatalog.questions.map((question) => [question.id, question])
)
const catalogProcessBindingById = new Map(
  dashboardDomainCatalog.processBindings.map((binding) => [binding.id, binding])
)
for (const component of compiled.componentPlans) {
  assert.ok(component.id.trim() && component.type.trim() && component.slotRole.trim())
  assert.ok(component.questionIds.length > 0)
  assert.ok(component.metricIds.length > 0)
  assert.ok(component.processBindingIds.length > 0)
  const catalogComponent = catalogComponentById.get(component.id)
  assert.ok(catalogComponent, `组件 ${component.id} 必须来自 catalog`)
  assert.equal(component.type, catalogComponent.type)
  assert.equal(component.slotRole, catalogComponent.slotRole)
  assert.ok(component.questionIds.every((questionId) =>
    catalogQuestionById.has(questionId) && projectOverview.questionIds.includes(questionId)
  ))
  assert.ok(component.metricIds.every((metricId) => scenarioMetricIds.has(metricId)))
  assert.ok(component.processBindingIds.every((bindingId) => catalogProcessBindingById.has(bindingId)))
  const { x, y, w, h } = component.layout
  assert.ok(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h))
  assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 24,
    `组件 ${component.id} 必须在 24 列布局内`)
  assertNoExecutableArtifacts(component, `componentPlans.${component.id}`)
}
for (let leftIndex = 0; leftIndex < compiled.componentPlans.length; leftIndex += 1) {
  const left = compiled.componentPlans[leftIndex]
  for (let rightIndex = leftIndex + 1; rightIndex < compiled.componentPlans.length; rightIndex += 1) {
    const right = compiled.componentPlans[rightIndex]
    const overlaps = left.layout.x < right.layout.x + right.layout.w &&
      left.layout.x + left.layout.w > right.layout.x &&
      left.layout.y < right.layout.y + right.layout.h &&
      left.layout.y + left.layout.h > right.layout.y
    assert.equal(overlaps, false, `组件布局重叠: ${left.id}/${right.id}`)
  }
}
const orderedPlans = [...compiled.componentPlans].sort((left, right) =>
  left.layout.y - right.layout.y || left.layout.x - right.layout.x
)
const slotRank: Record<string, number> = {
  headline: 0,
  trend: 1,
  breakdown: 1,
  diagnosis: 2,
  detail: 3,
  insight: 4
}
const orderedRanks = orderedPlans.map((component) => slotRank[component.slotRole] ?? 99)
assert.ok(orderedRanks.every((rank, index) => index === 0 || rank >= orderedRanks[index - 1]),
  '组件应遵循 headline → trend/breakdown → diagnosis 的业务顺序')

const receipt = compiled.receipt
assert.deepEqual(new Set(receipt.adoptedMetricIds), new Set(metricIds))
assert.deepEqual(receipt.missingMetricIds, [])
assert.ok(Array.isArray(receipt.evidenceMissing))
assert.ok(Array.isArray(receipt.evidenceInsufficient))
assert.ok(receipt.evidenceMissing.length > 0, '回执必须明确缺失证据')
assert.ok(receipt.evidenceInsufficient.length > 0, '回执必须明确证据不足')
assert.deepEqual(
  new Set(receipt.evidenceMissing),
  new Set(dashboardDomainCatalog.processBindings
    .filter((binding) => binding.evidenceStatus === 'missing' &&
      binding.metricIds.some((metricId) => metricIds.includes(metricId)))
    .map((binding) => binding.id))
)
assert.deepEqual(
  new Set(receipt.evidenceInsufficient),
  new Set(dashboardDomainCatalog.processBindings
    .filter((binding) => binding.evidenceStatus === 'insufficient' &&
      binding.metricIds.some((metricId) => metricIds.includes(metricId)))
    .map((binding) => binding.id))
)
assert.ok(Number.isFinite(receipt.confidence) && receipt.confidence >= 0 && receipt.confidence <= 1)
assert.ok(receipt.confidence < 1, '受控样例证据不完整时 confidence 不得伪装为满分')
assert.ok(receipt.warnings.length > 0)
assert.ok(receipt.warnings.some((warning) => /受控样例|非正式符合性结论/.test(warning)),
  '回执警告必须明确受控样例/非正式符合性结论')
assert.ok(receipt.confirmations.length > 0)

const assertRejected = (input: PlannerInput, message: RegExp): void => {
  assert.throws(() => compile(input), message)
}
assertRejected({ ...completeInput, projectIds: [] }, /ready|project|scope|范围/i)
assertRejected({ ...completeInput, scenario: 'gjb5000b-compliance' as 'project-overview' },
  /planned|active|scenario|场景/i)

console.log(JSON.stringify({
  ok: true,
  role: compiled.domainContext.role,
  scenario: compiled.domainContext.scenario,
  artifactStatus: compiled.domainContext.artifactStatus,
  metricCount: blueprint.metrics.length,
  questionCount: blueprint.questions.length,
  componentCount: compiled.componentPlans.length,
  receipt: {
    adoptedMetricCount: receipt.adoptedMetricIds.length,
    missingMetricCount: receipt.missingMetricIds.length,
    evidenceMissing: receipt.evidenceMissing,
    evidenceInsufficient: receipt.evidenceInsufficient,
    confidence: receipt.confidence
  }
}, null, 2))
