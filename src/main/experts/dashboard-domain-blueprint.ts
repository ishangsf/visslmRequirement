import type {
  DashboardAnalysisBlueprint,
  DashboardAnalysisQuestion,
  DashboardComponentType,
  DashboardSlotRole
} from '../../shared/dashboard'
import type {
  DashboardDomainRole,
  DashboardGoldenScenario,
  DashboardQualityVetoCode
} from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

export interface DashboardDomainBlueprintInput {
  request: string
  role: DashboardDomainRole
  scenario: string
  projectIds: readonly string[]
  tailoringBaselineId: string
  metricIds: readonly string[]
  processBindingIds: readonly string[]
  generatedAt: string
}

export interface DashboardDomainComponentPlan {
  id: string
  type: DashboardComponentType
  slotRole: DashboardSlotRole
  questionIds: readonly string[]
  metricIds: readonly string[]
  processBindingIds: readonly string[]
  layout: { x: number; y: number; w: number; h: number }
}

export interface DashboardDomainBlueprintReceipt {
  adoptedMetricIds: readonly string[]
  missingMetricIds: readonly string[]
  evidenceMissing: readonly string[]
  evidenceInsufficient: readonly string[]
  confidence: number
  warnings: readonly string[]
  confirmations: readonly string[]
}

export interface CompiledDashboardDomainBlueprint {
  analysisBlueprint: DashboardAnalysisBlueprint
  domainContext: {
    role: DashboardDomainRole
    scenario: string
    catalogVersion: '1.0'
    tailoringBaselineId: string
    artifactStatus: 'preview'
  }
  componentPlans: readonly DashboardDomainComponentPlan[]
  receipt: DashboardDomainBlueprintReceipt
}

const roleAudience: Record<DashboardDomainRole, string> = {
  'project-owner': '项目负责人',
  'qa-epg': '质量与过程负责人',
  'rd-lead': '研发负责人',
  'model-org-manager': '型号/组织管理负责人'
}

const uniqueStrings = (values: readonly string[] | undefined): string[] => [
  ...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))
]

const fail = (message: string): never => {
  throw new Error(`领域 Blueprint 编译失败：${message}`)
}

const metricIdsForScenario = (scenario: DashboardGoldenScenario): string[] => {
  const catalogMetricIds = new Set(dashboardDomainCatalog.metrics.map((metric) => metric.id))
  const metricIds = uniqueStrings(scenario.metricIds)
    .filter((metricId) => catalogMetricIds.has(metricId))
  if (metricIds.length !== scenario.metricIds.length) {
    return fail('场景包含未登记的 metric ID')
  }
  return metricIds
}

const processBindingIdsForScenario = (scenario: DashboardGoldenScenario): string[] => {
  const metricIds = new Set(scenario.metricIds)
  const bindingIds = dashboardDomainCatalog.processBindings
    .filter((binding) => binding.metricIds.some((metricId) => metricIds.has(metricId)))
    .map((binding) => binding.id)
  if (!bindingIds.length) return fail('场景没有可用的过程绑定')
  return [...new Set(bindingIds)]
}

const assertSetExactly = (
  received: readonly string[] | undefined,
  expected: readonly string[],
  label: string
): string[] => {
  const normalized = uniqueStrings(received)
  const expectedSet = new Set(expected)
  const unexpected = normalized.filter((value) => !expectedSet.has(value))
  const missing = expected.filter((value) => !normalized.includes(value))
  if (unexpected.length || missing.length || normalized.length !== expected.length) {
    return fail(`${label} 不完整或包含场景外 ID（missing=${missing.join(',')}; unexpected=${unexpected.join(',')})`)
  }
  return expected.filter((value) => normalized.includes(value))
}

const componentLayout = (
  componentId: string
): { x: number; y: number; w: number; h: number } => {
  const layouts: Record<string, { x: number; y: number; w: number; h: number }> = {
    'project-overview-health-card': { x: 0, y: 0, w: 12, h: 3 },
    'project-overview-risk-card': { x: 12, y: 0, w: 12, h: 3 },
    'project-overview-milestone-card': { x: 0, y: 3, w: 12, h: 5 },
    'project-overview-requirement-card': { x: 12, y: 3, w: 12, h: 5 },
    'project-overview-defect-card': { x: 0, y: 8, w: 12, h: 5 },
    'project-overview-process-card': { x: 12, y: 8, w: 12, h: 5 },
    'requirements-delivery-stability-card': { x: 0, y: 0, w: 12, h: 3 },
    'requirements-delivery-review-card': { x: 12, y: 0, w: 12, h: 3 },
    'requirements-delivery-change-card': { x: 0, y: 3, w: 12, h: 5 },
    'requirements-delivery-development-card': { x: 12, y: 3, w: 12, h: 5 },
    'requirements-delivery-test-card': { x: 0, y: 8, w: 12, h: 5 },
    'requirements-delivery-trace-card': { x: 12, y: 8, w: 12, h: 5 },
    'plan-milestone-completion-card': { x: 0, y: 0, w: 12, h: 3 },
    'plan-milestone-delayed-card': { x: 12, y: 0, w: 12, h: 3 },
    'plan-milestone-variance-card': { x: 0, y: 3, w: 12, h: 5 },
    'plan-milestone-critical-path-card': { x: 12, y: 3, w: 12, h: 5 },
    'plan-milestone-forecast-card': { x: 0, y: 8, w: 24, h: 5 },
    'software-quality-critical-card': { x: 0, y: 0, w: 12, h: 4 },
    'software-quality-reopen-card': { x: 12, y: 0, w: 12, h: 4 },
    'software-quality-density-card': { x: 0, y: 4, w: 12, h: 5 },
    'software-quality-trend-card': { x: 12, y: 4, w: 12, h: 5 },
    'software-quality-repair-card': { x: 0, y: 9, w: 12, h: 5 },
    'software-quality-residual-risk-card': { x: 12, y: 9, w: 12, h: 5 },
    'test-validation-execution-card': { x: 0, y: 0, w: 12, h: 4 },
    'test-validation-pass-card': { x: 12, y: 0, w: 12, h: 4 },
    'test-validation-requirement-coverage-card': { x: 0, y: 4, w: 12, h: 5 },
    'test-validation-code-coverage-card': { x: 12, y: 4, w: 12, h: 5 },
    'test-validation-automation-card': { x: 0, y: 9, w: 12, h: 5 },
    'test-validation-blocked-card': { x: 12, y: 9, w: 12, h: 5 },
    'configuration-change-item-control-card': { x: 0, y: 0, w: 12, h: 4 },
    'configuration-change-baseline-card': { x: 12, y: 0, w: 12, h: 4 },
    'configuration-change-approval-card': { x: 0, y: 4, w: 12, h: 5 },
    'configuration-change-open-trend-card': { x: 12, y: 4, w: 12, h: 5 },
    'configuration-change-reproducible-build-card': { x: 0, y: 9, w: 24, h: 5 }
  }
  const layout = layouts[componentId]
  if (!layout) return fail(`场景组件 ${componentId} 没有受控布局`)
  return layout
}

const componentPlansFor = (
  scenario: DashboardGoldenScenario,
  processBindingIds: readonly string[]
): DashboardDomainComponentPlan[] => {
  const scenarioQuestionIds = new Set(scenario.questionIds)
  const scenarioMetricIds = new Set(scenario.metricIds)
  const catalogQuestionIds = new Set(dashboardDomainCatalog.questions.map((question) => question.id))
  const catalogBindingIds = new Set(dashboardDomainCatalog.processBindings.map((binding) => binding.id))
  const bindingSet = new Set(processBindingIds)
  return scenario.componentIds
    .map((componentId) => {
      const component = dashboardDomainCatalog.components.find((candidate) => candidate.id === componentId)
      if (!component) return fail(`场景组件不存在: ${componentId}`)
      const questionIds = uniqueStrings(component.questionIds)
      const metricIds = uniqueStrings(component.metricIds)
      if (!questionIds.length || questionIds.some((id) => !scenarioQuestionIds.has(id) || !catalogQuestionIds.has(id))) {
        return fail(`组件 ${componentId} 的业务问题不属于当前场景`)
      }
      if (!metricIds.length || metricIds.some((id) => !scenarioMetricIds.has(id))) {
        return fail(`组件 ${componentId} 的指标不属于当前场景`)
      }
      const componentBindingIds = dashboardDomainCatalog.processBindings
        .filter((binding) => binding.metricIds.some((metricId) => metricIds.includes(metricId)))
        .map((binding) => binding.id)
        .filter((id) => bindingSet.has(id) && catalogBindingIds.has(id))
      if (!componentBindingIds.length) return fail(`组件 ${componentId} 缺少过程绑定`)
      return {
        id: component.id,
        type: component.type,
        slotRole: component.slotRole,
        questionIds,
        metricIds,
        processBindingIds: [...new Set(componentBindingIds)],
        layout: componentLayout(component.id)
      }
    })
    .sort((left, right) => left.layout.y - right.layout.y || left.layout.x - right.layout.x)
}

const blueprintFor = (
  input: DashboardDomainBlueprintInput,
  scenario: DashboardGoldenScenario,
  metricIds: readonly string[]
): DashboardAnalysisBlueprint => {
  const metricSet = new Set(metricIds)
  const metrics = metricIds.map((metricId) => {
    const metric = dashboardDomainCatalog.metrics.find((candidate) => candidate.id === metricId)
    if (!metric) return fail(`指标不存在: ${metricId}`)
    // These are semantic placeholders only. No executable QuerySpec is
    // emitted; a later platform adapter must resolve real field/measure IDs.
    return {
      id: metric.id,
      label: metric.label,
      description: metric.definition,
      measureId: `domain-metric-${metric.id}`,
      field: `domain.${metric.id}`,
      aggregation: 'avg' as const,
      ...(metric.format ? { format: metric.format } : {}),
      source: 'catalog' as const,
      confidence: 0.75
    }
  })
  const questions: DashboardAnalysisQuestion[] = scenario.questionIds.map((questionId) => {
    const question = dashboardDomainCatalog.questions.find((candidate) => candidate.id === questionId)
    if (!question) return fail(`业务问题不存在: ${questionId}`)
    const questionMetricIds = uniqueStrings(question.metricIds)
    if (!questionMetricIds.length || questionMetricIds.some((metricId) => !metricSet.has(metricId))) {
      return fail(`业务问题 ${questionId} 引用了场景外指标`)
    }
    return {
      id: question.id,
      question: question.question,
      metricIds: questionMetricIds,
      dimensionFields: [],
      preferredComponentTypes: [...question.preferredComponentTypes],
      slotRole: question.slotRole,
      priority: question.priority,
      required: question.required
    }
  })
  return {
    version: '1.0',
    request: input.request.trim(),
    audience: roleAudience[input.role],
    objective: `围绕${scenario.name}回答${scenario.lines.map((line) => ({
      execution: '执行',
      process: '过程',
      quality: '质量',
      organization: '组织',
      configuration: '配置'
    }[line])).join('、')}问题。`,
    scopeDescription: `受控项目范围（${input.projectIds.length} 个项目）；仅编译语义方案，不读取业务数据。`,
    metrics,
    questions,
    assumptions: [
      '本方案来自受控领域目录，尚未接入真实平台数据适配器。',
      '指标 field/measureId 是语义占位符，后续必须由受控适配器绑定并保留证据链。'
    ],
    unresolvedAmbiguities: [],
    generatedAt: input.generatedAt.trim()
  }
}

/**
 * Compile a validated ready domain plan into semantic intent only.
 * QuerySpec, SQL, records and component data are deliberately outside this
 * boundary and must be produced by a later, separately validated stage.
 */
export const compileDashboardDomainBlueprint = (
  input: DashboardDomainBlueprintInput
): CompiledDashboardDomainBlueprint => {
  if (!input || typeof input !== 'object') return fail('缺少规划上下文')
  if (!input.request?.trim()) return fail('request 不能为空')
  if (!input.generatedAt?.trim()) return fail('generatedAt 不能为空')
  if (!dashboardDomainCatalog.roles.includes(input.role)) return fail('role 不在领域目录中')
  if (!input.scenario?.trim()) return fail('scenario 不能为空')

  const scenario = dashboardDomainCatalog.scenarios.find((candidate) => candidate.id === input.scenario)
  if (!scenario) return fail(`未知场景 ${input.scenario}`)
  if (scenario.status !== 'active') return fail(`场景 ${scenario.id} 当前为 planned，不能编译`)
  if (!scenario.roleIds.includes(input.role)) return fail(`角色 ${input.role} 不适用场景 ${scenario.id}`)

  const projectIds = uniqueStrings(input.projectIds)
  if (!projectIds.length) return fail('缺少 project scope，projectIds 不能为空')
  if (!input.tailoringBaselineId?.trim()) return fail('缺少 tailoring baseline')

  const scenarioMetricIds = metricIdsForScenario(scenario)
  const scenarioProcessBindingIds = processBindingIdsForScenario(scenario)
  const metricIds = assertSetExactly(input.metricIds, scenarioMetricIds, 'metricIds')
  const processBindingIds = assertSetExactly(
    input.processBindingIds,
    scenarioProcessBindingIds,
    'processBindingIds'
  )
  const plannedBindings = dashboardDomainCatalog.processBindings.filter((binding) =>
    processBindingIds.includes(binding.id)
  )
  const expectedBaselineIds = [...new Set(plannedBindings.map((binding) => binding.tailoringBaselineId))]
  if (expectedBaselineIds.length !== 1 || expectedBaselineIds[0] !== input.tailoringBaselineId.trim()) {
    return fail(
      `invalid tailoring baseline：期望 ${expectedBaselineIds.join(',') || '未配置'}，实际 ${input.tailoringBaselineId.trim()}`
    )
  }
  const blueprint = blueprintFor({ ...input, projectIds }, scenario, metricIds)
  const plans = componentPlansFor(scenario, processBindingIds)
  const catalogBindingById = new Map(
    dashboardDomainCatalog.processBindings.map((binding) => [binding.id, binding])
  )
  const evidenceMissing = processBindingIds.filter((id) =>
    catalogBindingById.get(id)?.evidenceStatus === 'missing'
  )
  const evidenceInsufficient = processBindingIds.filter((id) =>
    catalogBindingById.get(id)?.evidenceStatus === 'insufficient'
  )

  return {
    analysisBlueprint: blueprint,
    domainContext: {
      role: input.role,
      scenario: scenario.id,
      catalogVersion: dashboardDomainCatalog.version,
      tailoringBaselineId: input.tailoringBaselineId.trim(),
      artifactStatus: 'preview'
    },
    componentPlans: plans,
    receipt: {
      adoptedMetricIds: metricIds,
      missingMetricIds: [],
      evidenceMissing,
      evidenceInsufficient,
      confidence: evidenceMissing.length || evidenceInsufficient.length ? 0.75 : 1,
      warnings: [
        '当前结果来自受控样例目录，真实平台适配器接入前仅允许 preview。',
        '过程证据仍可能缺失或不足，本回执不构成正式符合性结论。'
      ],
      confirmations: [
        '请确认项目范围、快照时点与数据访问授权。',
        '请确认裁剪基线版本及其适用过程活动。',
        '请补充并核验活动、工作产品和证据记录后再评估正式门禁。'
      ]
    }
  }
}

export default compileDashboardDomainBlueprint
