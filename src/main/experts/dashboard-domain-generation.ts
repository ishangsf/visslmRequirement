import type {
  DashboardAnalysisBlueprint,
  DashboardAnalysisQuestion,
  DashboardComponentSpec,
  DashboardDomainReceipt,
  DashboardMetricDefinition,
  DashboardSpec
} from '../../shared/dashboard'
import type {
  DataScope,
  FieldProfile,
  QueryAggregation,
  QuerySpec
} from '../../shared/query-spec'
import type { DashboardDomainRole } from '../../shared/dashboard-domain'
import type { DashboardDomainPlan } from './dashboard-domain-planner'
import { resolveDashboardDomainPlan } from './dashboard-domain-planner'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'
import {
  compileDashboardDomainBlueprint,
  type CompiledDashboardDomainBlueprint
} from './dashboard-domain-blueprint'
import type { QueryEngine } from '../analytics/query-engine'
import { validateDashboardSpec } from '../dashboards/validator'
import { automaticDashboardComponentTitle } from '../../shared/dashboard-semantics'

export interface DashboardDomainGenerationInput {
  request: string
  scope: DataScope
  role?: DashboardDomainRole
  scenario?: string
  tailoringBaselineId?: string
  permissions?: readonly string[]
  dataQuality?: 'reliable' | 'invalid'
  metricConflicts?: readonly string[]
  generatedAt: string
}

export interface DashboardDomainGenerationReceipt extends DashboardDomainReceipt {}

export interface DashboardDomainGenerationResult {
  status: 'ready' | 'clarification' | 'rejected'
  dashboard?: DashboardSpec
  receipt?: DashboardDomainGenerationReceipt
  reason?: string
  clarification?: {
    reason?: string
    options?: readonly { id: string; label: string; recommended: boolean }[]
  }
  scenario?: string
  metricIds?: readonly string[]
  processBindingIds?: readonly string[]
}

const controlledMetricFields: Record<string, readonly string[]> = {
  'project-health': ['healthScore', 'project-health'],
  'milestone-achievement': ['milestoneAchievement'],
  'requirement-completion': ['requirementCompletion'],
  'defect-density': ['defectDensity'],
  'high-risk-count': ['highRiskCount'],
  'process-compliance': ['processCompliance'],
  'requirement-stability': ['requirementStability'],
  'requirement-review-completion': ['reviewCompletion'],
  'requirement-change-rate': ['requirementChangeRate'],
  'development-completion': ['developmentCompletion'],
  'requirement-test-coverage': ['testCoverage'],
  'bidirectional-traceability': ['traceabilityCompleteness'],
  'plan-completion-rate': ['planCompletionRate'],
  'schedule-variance-days': ['scheduleVarianceDays'],
  'delayed-task-count': ['delayedTaskCount'],
  'critical-path-risk-score': ['criticalPathRiskScore'],
  'milestone-forecast-delay-days': ['milestoneForecastDelayDays'],
  'critical-defect-count': ['criticalDefectCount'],
  'open-defect-count': ['openDefectCount'],
  'defect-reopen-rate': ['defectReopenRate'],
  'mean-defect-repair-hours': ['meanRepairHours'],
  'residual-defect-risk-score': ['residualDefectRiskScore'],
  'test-case-execution-rate': ['testExecutionRate'],
  'test-pass-rate': ['testPassRate'],
  'code-coverage-rate': ['codeCoverageRate'],
  'test-automation-rate': ['testAutomationRate'],
  'blocked-test-case-count': ['blockedTestCaseCount'],
  'configuration-item-control-rate': ['configurationItemControlRate'],
  'baseline-completeness-rate': ['baselineCompletenessRate'],
  'change-approval-rate': ['changeApprovalRate'],
  'open-change-count': ['openChangeCount'],
  'reproducible-build-rate': ['reproducibleBuildRate']
}

const controlledMetricAggregations: Record<string, QueryAggregation> = {
  'project-health': 'avg',
  'milestone-achievement': 'avg',
  'requirement-completion': 'avg',
  'defect-density': 'avg',
  'high-risk-count': 'sum',
  'process-compliance': 'avg',
  'requirement-stability': 'avg',
  'requirement-review-completion': 'avg',
  'requirement-change-rate': 'avg',
  'development-completion': 'avg',
  'requirement-test-coverage': 'avg',
  'bidirectional-traceability': 'avg',
  'plan-completion-rate': 'avg',
  'schedule-variance-days': 'avg',
  'delayed-task-count': 'avg',
  'critical-path-risk-score': 'avg',
  'milestone-forecast-delay-days': 'avg',
  'critical-defect-count': 'sum',
  'open-defect-count': 'avg',
  'defect-reopen-rate': 'avg',
  'mean-defect-repair-hours': 'avg',
  'residual-defect-risk-score': 'avg',
  'test-case-execution-rate': 'avg',
  'test-pass-rate': 'avg',
  'code-coverage-rate': 'avg',
  'test-automation-rate': 'avg',
  'blocked-test-case-count': 'sum',
  'configuration-item-control-rate': 'avg',
  'baseline-completeness-rate': 'avg',
  'change-approval-rate': 'avg',
  'open-change-count': 'avg',
  'reproducible-build-rate': 'avg'
}

const controlledQuestionDimensions: Record<string, readonly string[]> = {
  'project-overview-defect-question': ['name'],
  'requirements-delivery-change-question': ['lastModifyTime'],
  'requirements-delivery-test-question': ['name'],
  'requirements-delivery-trace-question': ['name'],
  'plan-milestone-variance-question': ['lastModifyTime'],
  'plan-milestone-critical-path-question': ['name'],
  'plan-milestone-forecast-question': ['name'],
  'software-quality-density-question': ['name'],
  'software-quality-trend-question': ['lastModifyTime'],
  'software-quality-repair-question': ['name'],
  'software-quality-residual-risk-question': ['name'],
  'test-validation-requirement-coverage-question': ['name'],
  'test-validation-code-coverage-question': ['lastModifyTime'],
  'test-validation-blocked-question': ['name'],
  'configuration-change-approval-question': ['name'],
  'configuration-change-open-trend-question': ['lastModifyTime'],
  'configuration-change-reproducible-build-question': ['name']
}

const metricMeasureId = (metricId: string): string => `domain-${metricId}-measure`

const controlledScenarioNodeTypes: Record<string, readonly string[]> = {
  'project-overview': ['ProjectOverviewSample'],
  'requirements-delivery': ['RequirementsDeliverySample'],
  'plan-milestone': ['PlanMilestoneSample'],
  'software-quality': ['SoftwareQualitySample'],
  'test-validation': ['TestValidationSample'],
  'configuration-change': ['ConfigurationChangeSample']
}

const scopedInputForScenario = (
  input: DashboardDomainGenerationInput,
  scope: DataScope
): DataScope => {
  if (input.tailoringBaselineId?.trim() !== 'sample-tailoring-baseline-v1') return scope
  if (scope.nodeTypes?.length) return scope
  const nodeTypes = input.scenario ? controlledScenarioNodeTypes[input.scenario] : undefined
  return nodeTypes?.length ? { ...scope, nodeTypes: [...nodeTypes] } : scope
}

const normalizedProjectIds = (scope: DataScope): string[] => [
  ...new Set((scope.projectIds ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))
]

const profileByField = (profiles: readonly FieldProfile[]): Map<string, FieldProfile> =>
  new Map(profiles.map((profile) => [profile.field.toLocaleLowerCase(), profile]))

const resolveProfileMetricFields = (
  profiles: readonly FieldProfile[]
): Map<string, { field: string; aggregation: QueryAggregation }> => {
  const byField = profileByField(profiles)
  const resolved = new Map<string, { field: string; aggregation: QueryAggregation }>()
  for (const [metricId, candidates] of Object.entries(controlledMetricFields)) {
    const field = candidates.find((candidate) => {
      const profile = byField.get(candidate.toLocaleLowerCase())
      return profile?.inferredType === 'number' && profile.sensitivity !== 'sensitive'
    })
    if (field) {
      resolved.set(metricId, {
        field,
        aggregation: controlledMetricAggregations[metricId]
      })
    }
  }
  return resolved
}

const blueprintWithConcreteMetrics = (
  blueprint: DashboardAnalysisBlueprint,
  resolvedMetrics: ReadonlyMap<string, { field: string; aggregation: QueryAggregation }>
): DashboardAnalysisBlueprint => ({
  ...blueprint,
  metrics: blueprint.metrics.map((metric) => {
    const resolved = resolvedMetrics.get(metric.id)
    if (!resolved) throw new Error(`指标 ${metric.id} 缺少受控字段映射`)
    return {
      ...metric,
      measureId: metricMeasureId(metric.id),
      field: resolved.field,
      aggregation: resolved.aggregation
    }
  }),
  questions: blueprint.questions.map((question) => ({
    ...question,
    dimensionFields: [...(controlledQuestionDimensions[question.id] ?? [])]
  }))
})

const dashboardIdFor = (scenario: string, generatedAt: string): string => {
  const suffix = generatedAt.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `dashboard-domain-${scenario}${suffix ? `-${suffix}` : ''}`
}

const dashboardTitleFor = (scenario: string): string => {
  const name = dashboardDomainCatalog.scenarios.find((candidate) => candidate.id === scenario)?.name
  return `${name ?? '领域大屏'}（受控样例）`
}

const rejectionReceipt = (
  compiled: CompiledDashboardDomainBlueprint | undefined,
  reason: string,
  vetoCodes: readonly string[] = []
): DashboardDomainGenerationReceipt => ({
  ...(compiled?.receipt ?? {}),
  vetoCodes,
  warnings: [
    ...(compiled?.receipt.warnings ?? []),
    `领域生成未交付 dashboard：${reason}`
  ],
  confirmations: [
    ...(compiled?.receipt.confirmations ?? []),
    '请补齐阻断项后重新执行领域规划。'
  ]
})

const plannerClarification = (plan: DashboardDomainPlan): DashboardDomainGenerationResult => ({
  ...plan,
  status: 'clarification',
  ...(plan.reason ? { reason: plan.reason } : {}),
  ...(plan.clarification ? { clarification: plan.clarification } : {})
})

const buildDashboard = (
  input: DashboardDomainGenerationInput,
  scope: DataScope,
  compiled: CompiledDashboardDomainBlueprint,
  concreteBlueprint: DashboardAnalysisBlueprint,
  queryEngine: QueryEngine,
  domainReceipt: DashboardDomainGenerationReceipt
): DashboardSpec => {
  const processBindingById = new Set(dashboardDomainCatalog.processBindings.map((binding) => binding.id))
  const metricById = new Map(concreteBlueprint.metrics.map((metric) => [metric.id, metric]))
  const questionById = new Map(concreteBlueprint.questions.map((question) => [question.id, question]))
  const components: DashboardComponentSpec[] = compiled.componentPlans.map((plan) => {
    const question = questionById.get(plan.questionIds[0])
    if (!question) throw new Error(`组件 ${plan.id} 引用了未编译业务问题`)
    const dimensions = [...question.dimensionFields]
    const metricDefinitions = plan.metricIds.map((metricId) => {
      const metric = metricById.get(metricId)
      if (!metric) throw new Error(`组件 ${plan.id} 引用了未编译指标 ${metricId}`)
      return metric
    })
    const processBindingIds = plan.processBindingIds.filter((id) => processBindingById.has(id))
    if (!processBindingIds.length) throw new Error(`组件 ${plan.id} 缺少合法过程绑定`)
    const semanticBinding = {
      questionId: question.id,
      metricIds: [...plan.metricIds],
      dimensionFields: dimensions,
      processBindingIds,
      titleMode: 'auto' as const,
      confidence: compiled.receipt.confidence
    }
    const query: QuerySpec = {
      source: 'records',
      scope: { ...scope },
      dimensions: dimensions.map((field) => ({ field })),
      measures: metricDefinitions.map((metric) => ({
        id: metric.measureId,
        ...(metric.field ? { field: metric.field } : {}),
        aggregation: metric.aggregation,
        ...(metric.calculation ? { calculation: metric.calculation } : {})
      })),
      limit: 10
    }
    const errors = queryEngine.validate(query)
    if (errors.length) throw new Error(`组件 ${plan.id} QuerySpec 校验失败：${errors.join('；')}`)
    const dataset = queryEngine.execute(query)
    if (!dataset.rows.length) throw new Error(`组件 ${plan.id} 查询结果为空`)
    const valueMeasureId = metricDefinitions[0].measureId
    const encoding = {
      ...(dimensions.length ? { label: dimensions[0] } : {}),
      value: valueMeasureId
    }
    const component: DashboardComponentSpec = {
      id: plan.id,
      type: plan.type,
      title: '',
      layout: plan.layout,
      data: dataset.rows.map((row) => {
        const value = Number(row[valueMeasureId])
        if (!Number.isFinite(value)) throw new Error(`组件 ${plan.id} 查询返回非数值结果`)
        return {
          name: dimensions.length ? String(row[dimensions[0]] ?? '') : plan.id,
          value
        }
      }),
      query,
      encoding,
      accent: '#8d7cff',
      semanticBinding,
      slotRole: plan.slotRole
    }
    component.title = automaticDashboardComponentTitle(concreteBlueprint, component)
    return component
  })
  const dashboard: DashboardSpec = {
    schemaVersion: '1.0',
    id: dashboardIdFor(compiled.domainContext.scenario, input.generatedAt),
    title: dashboardTitleFor(compiled.domainContext.scenario),
    subtitle: 'controlled sample · preview',
    businessContext: {
      audience: concreteBlueprint.audience,
      objective: concreteBlueprint.objective,
      scopeDescription: concreteBlueprint.scopeDescription
    },
    domainContext: compiled.domainContext,
    domainReceipt,
    viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 54 },
    theme: 'technology-dark',
    analysisBlueprint: concreteBlueprint,
    updatedAt: input.generatedAt.trim(),
    components
  }
  return dashboard
}

/**
 * Generate a domain artifact from controlled field profiles and the safe
 * QueryEngine. This host-only path intentionally has no model, SQL or inline
 * data generation step.
 */
export const generateDashboardDomainArtifact = async (
  input: DashboardDomainGenerationInput,
  queryEngine: QueryEngine
): Promise<DashboardDomainGenerationResult> => {
  const inputScope: DataScope = input?.scope && typeof input.scope === 'object' ? { ...input.scope } : {}
  const scope = scopedInputForScenario(input, inputScope)
  const profiles = queryEngine.profile(scope)
  const resolvedMetrics = resolveProfileMetricFields(profiles)
  const plan = resolveDashboardDomainPlan({
    request: input?.request ?? '',
    role: input?.role,
    scenario: input?.scenario,
    projectIds: normalizedProjectIds(scope),
    tailoringBaselineId: input?.tailoringBaselineId,
    permissions: input?.permissions,
    dataQuality: input?.dataQuality,
    metricConflicts: input?.metricConflicts,
    availableMetricIds: [...resolvedMetrics.keys()]
  })
  if (plan.status !== 'ready') return plannerClarification(plan)

  const knownBaselineIds = new Set(
    dashboardDomainCatalog.processBindings.map((binding) => binding.tailoringBaselineId)
  )
  const baselineId = input.tailoringBaselineId?.trim() ?? ''
  if (!knownBaselineIds.has(baselineId)) {
    return {
      status: 'rejected',
      reason: 'invalid-tailoring-baseline',
      receipt: rejectionReceipt(undefined, 'invalid-tailoring-baseline', ['invalid-tailoring-baseline'])
    }
  }

  let compiled: CompiledDashboardDomainBlueprint
  try {
    compiled = compileDashboardDomainBlueprint({
      request: input.request,
      role: plan.role!,
      scenario: plan.scenario,
      projectIds: normalizedProjectIds(scope),
      tailoringBaselineId: baselineId,
      metricIds: plan.metricIds,
      processBindingIds: plan.processBindingIds,
      generatedAt: input.generatedAt
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'rejected',
      reason: 'blueprint-compilation-failed',
      receipt: rejectionReceipt(undefined, reason)
    }
  }

  try {
    const concreteBlueprint = blueprintWithConcreteMetrics(compiled.analysisBlueprint, resolvedMetrics)
    const domainReceipt: DashboardDomainGenerationReceipt = {
      ...compiled.receipt,
      vetoCodes: []
    }
    const dashboard = buildDashboard(
      input,
      scope,
      compiled,
      concreteBlueprint,
      queryEngine,
      domainReceipt
    )
    const validationErrors = validateDashboardSpec(dashboard, queryEngine)
    if (validationErrors.length) {
      return {
        status: 'rejected',
        reason: 'invalid-dashboard-spec',
        receipt: rejectionReceipt(compiled, validationErrors.join('；'))
      }
    }
    return {
      status: 'ready',
      dashboard,
      receipt: domainReceipt,
      scenario: plan.scenario,
      metricIds: plan.metricIds,
      processBindingIds: plan.processBindingIds
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      status: 'rejected',
      reason: 'query-or-validation-failed',
      receipt: rejectionReceipt(compiled, reason)
    }
  }
}

export default generateDashboardDomainArtifact
