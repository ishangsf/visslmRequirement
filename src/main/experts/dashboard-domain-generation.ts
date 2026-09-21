import type {
  DashboardAnalysisBlueprint,
  DashboardAnalysisQuestion,
  DashboardComponentSpec,
  DashboardDomainReceipt,
  DashboardGjb5000bPresentation,
  DashboardMetricDefinition,
  DashboardStatusTone,
  DashboardSpec
} from '../../shared/dashboard'
import type {
  DataScope,
  FieldProfile,
  QueryAggregation,
  QuerySpec
} from '../../shared/query-spec'
import type {
  DashboardDomainPlatformAdapter,
  DashboardDomainRole
} from '../../shared/dashboard-domain'
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
import {
  validateDashboardDomainAdapterAccess,
  scopeForDashboardDomainPlatformAdapter,
  validateDashboardDomainAdapterProfiles,
  validateDashboardDomainPlatformAdapter
} from './dashboard-domain-adapter'

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
  platformAdapter?: DashboardDomainPlatformAdapter
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
  dataMode?: 'controlled-sample' | 'platform-adapter'
  adapterId?: string
  sourceSystem?: string
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
  'reproducible-build-rate': ['reproducibleBuildRate'],
  'process-activity-execution-rate': ['activityExecutionRate'],
  'work-product-completeness-rate': ['workProductCompletenessRate'],
  'evidence-sufficiency-rate': ['evidenceSufficiencyRate'],
  'process-deviation-count': ['processDeviationCount'],
  'nonconformity-closure-rate': ['nonconformityClosureRate'],
  'project-quality-dispersion-score': ['qualityDispersionScore'],
  'estimation-deviation-rate': ['estimationDeviationRate'],
  'delivery-productivity-index': ['productivityIndex'],
  'defect-escape-rate': ['defectEscapeRate'],
  'process-improvement-completion-rate': ['improvementCompletionRate'],
  'organizational-baseline-stability-rate': ['baselineStabilityRate']
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
  'reproducible-build-rate': 'avg',
  'process-activity-execution-rate': 'avg',
  'work-product-completeness-rate': 'avg',
  'evidence-sufficiency-rate': 'avg',
  'process-deviation-count': 'avg',
  'nonconformity-closure-rate': 'avg',
  'project-quality-dispersion-score': 'avg',
  'estimation-deviation-rate': 'avg',
  'delivery-productivity-index': 'avg',
  'defect-escape-rate': 'avg',
  'process-improvement-completion-rate': 'avg',
  'organizational-baseline-stability-rate': 'avg'
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
  'configuration-change-reproducible-build-question': ['name'],
  'gjb5000b-compliance-evidence-question': ['name'],
  'gjb5000b-compliance-deviation-question': ['lastModifyTime'],
  'gjb5000b-compliance-nonconformity-question': ['name'],
  'organization-improvement-productivity-question': ['name'],
  'organization-improvement-defect-escape-question': ['lastModifyTime'],
  'organization-improvement-baseline-question': ['name']
}

const metricMeasureId = (metricId: string): string => `domain-${metricId}-measure`

const controlledScenarioNodeTypes: Record<string, readonly string[]> = {
  'project-overview': ['ProjectOverviewSample'],
  'requirements-delivery': ['RequirementsDeliverySample'],
  'plan-milestone': ['PlanMilestoneSample'],
  'software-quality': ['SoftwareQualitySample'],
  'test-validation': ['TestValidationSample'],
  'configuration-change': ['ConfigurationChangeSample'],
  'gjb5000b-compliance': ['Gjb5000bComplianceSample'],
  'organization-improvement': ['OrganizationImprovementSample']
}

const scopedInputForScenario = (
  input: DashboardDomainGenerationInput,
  scope: DataScope
): DataScope => {
  if (input.platformAdapter) return scopeForDashboardDomainPlatformAdapter(scope, input.platformAdapter)
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
  resolvedMetrics: ReadonlyMap<string, { field: string; aggregation: QueryAggregation }>,
  questionDimensions: Readonly<Record<string, readonly string[]>>,
  confidence: number
): DashboardAnalysisBlueprint => ({
  ...blueprint,
  metrics: blueprint.metrics.map((metric) => {
    const resolved = resolvedMetrics.get(metric.id)
    if (!resolved) throw new Error(`指标 ${metric.id} 缺少受控字段映射`)
    return {
      ...metric,
      measureId: metricMeasureId(metric.id),
      field: resolved.field,
      aggregation: resolved.aggregation,
      confidence
    }
  }),
  questions: blueprint.questions.map((question) => ({
    ...question,
    dimensionFields: [...(questionDimensions[question.id] ?? [])]
  }))
})

const dashboardIdFor = (scenario: string, generatedAt: string): string => {
  const suffix = generatedAt.trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `dashboard-domain-${scenario}${suffix ? `-${suffix}` : ''}`
}

const dashboardTitleFor = (scenario: string, dataMode: 'controlled-sample' | 'platform-adapter'): string => {
  const name = dashboardDomainCatalog.scenarios.find((candidate) => candidate.id === scenario)?.name
  return `${name ?? '领域大屏'}（${dataMode === 'platform-adapter' ? '平台数据预览' : '受控样例'}）`
}

const percentValue = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback
  const normalized = Number(value) <= 1 ? Number(value) * 100 : Number(value)
  return Math.max(0, Math.min(100, Math.round(normalized)))
}

const gjb5000bPresentationFor = (
  input: DashboardDomainGenerationInput,
  components: readonly DashboardComponentSpec[],
  dataMode: 'controlled-sample' | 'platform-adapter',
  baselineId: string,
  sourceSystem?: string
): DashboardGjb5000bPresentation => {
  const componentById = new Map(components.map((component) => [component.id, component]))
  const activity = componentById.get('gjb5000b-compliance-activity-card')?.data[0]?.value
  const workProduct = componentById.get('gjb5000b-compliance-work-product-card')?.data[0]?.value
  const evidence = componentById.get('gjb5000b-compliance-evidence-card')?.data ?? []
  const deviation = componentById.get('gjb5000b-compliance-deviation-card')?.data ?? []
  const domainDefaults = [
    { id: 'project-planning', label: '项目策划', requirementCount: 12, activityCount: 18, activityRate: 100, workProductCount: 18, workProductRate: 100, evidenceCount: 56, evidenceRate: 92 },
    { id: 'requirements-development', label: '需求开发', requirementCount: 18, activityCount: 27, activityRate: 89, workProductCount: 27, workProductRate: 85, evidenceCount: 48, evidenceRate: 81 },
    { id: 'technical-solution', label: '技术解决', requirementCount: 24, activityCount: 42, activityRate: 90, workProductCount: 42, workProductRate: 88, evidenceCount: 69, evidenceRate: 78 },
    { id: 'verification-validation', label: '验证确认', requirementCount: 20, activityCount: 35, activityRate: 94, workProductCount: 35, workProductRate: 91, evidenceCount: 60, evidenceRate: 84 },
    { id: 'configuration-management', label: '配置管理', requirementCount: 16, activityCount: 22, activityRate: 86, workProductCount: 22, workProductRate: 77, evidenceCount: 28, evidenceRate: 57 }
  ] as const
  const evidenceByLabel = new Map(evidence.map((point) => [
    point.name.replace(/过程域$/u, '').trim(),
    percentValue(point.value, 0)
  ]))
  const processDomains = domainDefaults.map((domain) => {
    const evidenceSufficiencyRate = evidenceByLabel.get(domain.label) ?? domain.evidenceRate
    return {
      id: domain.id,
      label: domain.label,
      requirementCount: domain.requirementCount,
      activityCount: domain.activityCount,
      activityExecutionRate: domain.activityRate,
      workProductCount: domain.workProductCount,
      workProductCompletenessRate: domain.workProductRate,
      evidenceCount: domain.evidenceCount,
      evidenceSufficiencyRate,
      status: evidenceSufficiencyRate >= 85
        ? 'sufficient' as const
        : evidenceSufficiencyRate < 60
          ? 'missing' as const
          : 'insufficient' as const
    }
  })
  const openDeviationCount = dataMode === 'controlled-sample'
    ? 4
    : Math.max(0, Math.round(deviation[deviation.length - 1]?.value ?? 0))
  const dataModeLabel = dataMode === 'controlled-sample'
    ? '预览数据（受控样例）'
    : `${sourceSystem ?? '平台数据'}（映射预览）`
  return {
    kind: 'gjb5000b-compliance',
    defaultMode: 'standard',
    projectLabel: dataMode === 'controlled-sample'
      ? 'Alpha'
      : input.scope.projectIds?.[0] ?? '当前项目',
    baselineLabel: dataMode === 'controlled-sample' ? 'GJB-BL-2026.3' : baselineId,
    auditPeriodLabel: '2026-Q3（内部审计）',
    dataModeLabel,
    conclusion: 'insufficient',
    selectedDomainId: 'configuration-management',
    processDomains,
    trace: [
      { id: 'cm-02-requirement', stage: 'requirement', label: 'CM-02', caption: '过程要求', status: 'sufficient' },
      { id: 'configuration-status-record', stage: 'activity', label: '配置状态记录', caption: '活动', status: 'sufficient' },
      { id: 'configuration-status-report', stage: 'work-product', label: '配置状态报告', caption: '工作产品', status: 'insufficient' },
      { id: 'evidence-validity', stage: 'evidence', label: '证据有效性', caption: '证据', status: 'missing' },
      { id: 'evidence-insufficient', stage: 'conclusion', label: '证据不足', caption: '检查结论', status: 'missing' }
    ],
    evidenceDetail: {
      domainId: 'configuration-management',
      title: 'CM-02 · 证据有效性',
      expectedEvidence: ['配置编制记录', '基线发布记录', '变更申请与批准记录'],
      currentEvidence: [],
      sourceSystem: dataMode === 'controlled-sample' ? 'VISSLM-Config（配置管理系统）' : sourceSystem ?? '平台适配器',
      owner: '张铄',
      dueDate: '2026-09-05',
      ruleId: 'CM-02 证据有效性规则 v2.1',
      relatedRequirements: ['GJB5000B CM-02.3', 'CM-02.4', 'CM-02.5'],
      summary: '缺少配置编制记录或基线发布记录，无法证明配置状态及变更控制的执行。'
    },
    trend: {
      labels: ['W2026-30', 'W2026-31', 'W2026-32', 'W2026-33', 'W2026-34', 'W2026-35'],
      overall: [68, 72, 74, 74, 74, 74],
      selectedDomain: [45, 48, 50, 53, 55, 57],
      target: 85
    },
    aging: [
      { id: 'overdue', label: '已逾期', count: Math.min(1, openDeviationCount), maximumDays: 12, tone: 'error' },
      { id: 'one-five', label: '1–5 天', count: Math.min(1, Math.max(0, openDeviationCount - 1)), maximumDays: 4, tone: 'warning' },
      { id: 'six-fifteen', label: '6–15 天', count: Math.min(1, Math.max(0, openDeviationCount - 2)), maximumDays: 9, tone: 'warning' },
      { id: 'over-fifteen', label: '>15 天', count: Math.max(0, openDeviationCount - 3), maximumDays: 18, tone: 'success' }
    ],
    scene: {
      kind: 'aerospace-situational',
      assetId: 'gjb5000b-aerospace-scene',
      assetVersion: '1.0',
      source: 'approved-generated-visual',
      classification: 'visual-theme',
      decorativeOnly: true,
      disclaimer: '视觉主题素材 · 非型号数据'
    }
  }
}

const gjbToneForRate = (value: number): DashboardStatusTone =>
  value >= 85 ? 'success' : value < 60 ? 'error' : 'warning'

const gjbEvidenceStatusLabel = (
  status: DashboardGjb5000bPresentation['processDomains'][number]['status']
): string => {
  if (status === 'sufficient') return '充分'
  if (status === 'missing') return '缺失'
  if (status === 'not-applicable') return '未适用'
  return '不足'
}

const gjbEvidenceTone = (
  status: DashboardGjb5000bPresentation['processDomains'][number]['status']
): DashboardStatusTone => {
  if (status === 'sufficient') return 'success'
  if (status === 'missing') return 'error'
  if (status === 'not-applicable') return 'neutral'
  return 'warning'
}

const scaledPercentData = (component: DashboardComponentSpec): DashboardComponentSpec['data'] =>
  component.data.map((point) => ({
    ...point,
    value: Number(point.value) <= 1 ? Number(point.value) * 100 : Number(point.value),
    ...(point.secondaryValue === undefined
      ? {}
      : {
          secondaryValue: Number(point.secondaryValue) <= 1
            ? Number(point.secondaryValue) * 100
            : Number(point.secondaryValue)
        })
  }))

const gjb5000bBlueprintForPublicPrimitives = (
  blueprint: DashboardAnalysisBlueprint
): DashboardAnalysisBlueprint => {
  const questions = blueprint.questions.map((question) => {
    const preferred = new Set(question.preferredComponentTypes)
    if (question.id === 'gjb5000b-compliance-activity-question' ||
        question.id === 'gjb5000b-compliance-work-product-question') {
      preferred.add('kpi')
    }
    if (question.id === 'gjb5000b-compliance-evidence-question') {
      preferred.add('data-matrix')
      preferred.add('description-list')
      preferred.add('ranking')
    }
    if (question.id === 'gjb5000b-compliance-nonconformity-question') {
      preferred.add('comparison-bars')
    }
    return { ...question, preferredComponentTypes: [...preferred] }
  })
  const syntheticQuestions: DashboardAnalysisQuestion[] = [
    {
      id: 'gjb5000b-compliance-evidence-headline-question',
      question: '当前范围的总体证据充分率是多少？',
      metricIds: ['evidence-sufficiency-rate'],
      dimensionFields: [],
      preferredComponentTypes: ['kpi'],
      slotRole: 'headline',
      priority: 93,
      required: false
    },
    {
      id: 'gjb5000b-compliance-nonconformity-headline-question',
      question: '当前范围的不符合项总体关闭率是多少？',
      metricIds: ['nonconformity-closure-rate'],
      dimensionFields: [],
      preferredComponentTypes: ['kpi'],
      slotRole: 'headline',
      priority: 88,
      required: false
    }
  ]
  for (const question of syntheticQuestions) {
    if (!questions.some((candidate) => candidate.id === question.id)) questions.push(question)
  }
  return { ...blueprint, questions }
}

const singleValueComponent = (
  source: DashboardComponentSpec,
  id: string,
  title: string,
  questionId: string,
  layout: DashboardComponentSpec['layout'],
  queryEngine: QueryEngine,
  accent: string
): DashboardComponentSpec => {
  const query: QuerySpec = {
    ...source.query!,
    dimensions: undefined,
    limit: 1
  }
  const dataset = queryEngine.execute(query)
  const valueField = source.encoding!.value!
  const value = Number(dataset.rows[0]?.[valueField] ?? 0)
  if (!Number.isFinite(value)) throw new Error(`组件 ${id} 查询返回非数值结果`)
  return {
    ...source,
    id,
    type: 'kpi',
    title,
    subtitle: '受控口径 · 当前范围',
    layout,
    data: [{ name: title, value: value <= 1 ? value * 100 : value }],
    query,
    encoding: { value: valueField, valueScale: 100 },
    unit: '%',
    accent,
    content: undefined,
    slotRole: 'headline',
    semanticBinding: {
      ...source.semanticBinding!,
      questionId,
      dimensionFields: [],
      titleMode: 'custom'
    }
  }
}

const gjb5000bComponentsForPublicPrimitives = (
  sourceComponents: readonly DashboardComponentSpec[],
  presentation: DashboardGjb5000bPresentation,
  queryEngine: QueryEngine
): DashboardComponentSpec[] => {
  const sourceById = new Map(sourceComponents.map((component) => [component.id, component]))
  const requireSource = (id: string): DashboardComponentSpec => {
    const source = sourceById.get(id)
    if (!source?.query || !source.encoding?.value || !source.semanticBinding) {
      throw new Error(`GJB5000B 公共组件组合缺少受控源组件 ${id}`)
    }
    return source
  }
  const activity = requireSource('gjb5000b-compliance-activity-card')
  const workProduct = requireSource('gjb5000b-compliance-work-product-card')
  const evidence = requireSource('gjb5000b-compliance-evidence-card')
  const deviation = requireSource('gjb5000b-compliance-deviation-card')
  const nonconformity = requireSource('gjb5000b-compliance-nonconformity-card')
  const selectedDomain = presentation.processDomains.find((domain) =>
    domain.id === presentation.selectedDomainId
  ) ?? presentation.processDomains[0]
  const selectedStatusTone = gjbEvidenceTone(selectedDomain.status)
  const topActivity: DashboardComponentSpec = {
    ...activity,
    type: 'kpi',
    title: '过程活动执行率',
    subtitle: '适用活动执行情况',
    layout: { x: 0, y: 0, w: 6, h: 3 },
    data: scaledPercentData(activity),
    encoding: { ...activity.encoding, valueScale: 100 },
    unit: '%',
    accent: '#50dda4',
    semanticBinding: { ...activity.semanticBinding!, titleMode: 'custom' }
  }
  const topWorkProduct: DashboardComponentSpec = {
    ...workProduct,
    type: 'kpi',
    title: '工作产品完整率',
    subtitle: '受控工作产品形成情况',
    layout: { x: 6, y: 0, w: 6, h: 3 },
    data: scaledPercentData(workProduct),
    encoding: { ...workProduct.encoding, valueScale: 100 },
    unit: '%',
    accent: '#64dbff',
    semanticBinding: { ...workProduct.semanticBinding!, titleMode: 'custom' }
  }
  const topEvidence = singleValueComponent(
    evidence,
    'gjb5000b-compliance-evidence-headline-card',
    '证据充分率',
    'gjb5000b-compliance-evidence-headline-question',
    { x: 12, y: 0, w: 6, h: 3 },
    queryEngine,
    '#ffc568'
  )
  const topClosure = singleValueComponent(
    nonconformity,
    'gjb5000b-compliance-nonconformity-headline-card',
    '不符合项关闭率',
    'gjb5000b-compliance-nonconformity-headline-question',
    { x: 18, y: 0, w: 6, h: 3 },
    queryEngine,
    '#8d7cff'
  )
  const matrix: DashboardComponentSpec = {
    ...evidence,
    type: 'data-matrix',
    title: '过程域证据充分率阶段矩阵',
    subtitle: '选择对象查看要求、活动、产物、证据与结论的追溯关系',
    layout: { x: 0, y: 3, w: 18, h: 11 },
    data: scaledPercentData(evidence),
    encoding: { ...evidence.encoding, valueScale: 100 },
    accent: '#8d7cff',
    semanticBinding: { ...evidence.semanticBinding!, titleMode: 'custom' },
    content: {
      kind: 'data-matrix',
      leadingLabel: '过程域',
      columns: ['过程要求', '活动', '工作产品', '证据', '检查结论'],
      selectedRowId: presentation.selectedDomainId,
      pageSize: 5,
      expansionMode: 'linked-detail',
      selectionChannel: 'gjb5000b-process-domain',
      legend: [
        { label: '充分', tone: 'success' },
        { label: '不足', tone: 'warning' },
        { label: '缺失 / 异常', tone: 'error' },
        { label: '未适用', tone: 'neutral' }
      ],
      rows: presentation.processDomains.map((domain) => ({
        id: domain.id,
        label: domain.label,
        caption: `${domain.requirementCount ?? 0} 项要求`,
        tone: gjbEvidenceTone(domain.status),
        cells: [
          {
            id: `${domain.id}-requirement`,
            label: `${domain.requirementCount ?? 0} 项要求`,
            tone: 'success'
          },
          {
            id: `${domain.id}-activity`,
            label: `${domain.activityCount ?? 0} 个活动`,
            value: `${domain.activityExecutionRate ?? 0}%`,
            tone: gjbToneForRate(domain.activityExecutionRate ?? 0)
          },
          {
            id: `${domain.id}-work-product`,
            label: `${domain.workProductCount ?? 0} 件产品`,
            value: `${domain.workProductCompletenessRate ?? 0}%`,
            tone: gjbToneForRate(domain.workProductCompletenessRate ?? 0)
          },
          {
            id: `${domain.id}-evidence`,
            label: `${domain.evidenceCount ?? 0} 条证据`,
            value: `${domain.evidenceSufficiencyRate}%`,
            tone: gjbEvidenceTone(domain.status)
          },
          {
            id: `${domain.id}-conclusion`,
            label: gjbEvidenceStatusLabel(domain.status),
            tone: gjbEvidenceTone(domain.status)
          }
        ],
        ...(domain.id === presentation.selectedDomainId ? {
          expanded: {
            label: `${domain.label}追溯链`,
            nodes: presentation.trace.map((node) => ({
              id: node.id,
              label: node.label,
              caption: node.caption,
              tone: gjbEvidenceTone(node.status)
            }))
          }
        } : {})
      }))
    }
  }
  const detail: DashboardComponentSpec = {
    ...evidence,
    id: 'gjb5000b-compliance-evidence-detail-card',
    type: 'description-list',
    title: '证据充分率所选对象详情',
    subtitle: selectedDomain.label,
    layout: { x: 18, y: 3, w: 6, h: 11 },
    data: scaledPercentData(evidence),
    encoding: { ...evidence.encoding, valueScale: 100 },
    accent: '#ff665e',
    semanticBinding: { ...evidence.semanticBinding!, titleMode: 'custom' },
    content: {
      kind: 'description-list',
      heading: presentation.evidenceDetail.title,
      status: {
        label: gjbEvidenceStatusLabel(selectedDomain.status),
        tone: selectedStatusTone
      },
      sections: [
        {
          id: 'expected',
          label: '期望证据（必需）',
          value: presentation.evidenceDetail.expectedEvidence.join('、'),
          help: '最少要求：≥ 1 条有效证据'
        },
        {
          id: 'current',
          label: '当前证据',
          value: presentation.evidenceDetail.currentEvidence.length
            ? presentation.evidenceDetail.currentEvidence.join('、')
            : '未找到有效证据',
          tone: presentation.evidenceDetail.currentEvidence.length ? 'success' : 'error'
        }
      ],
      fields: [
        { id: 'source', label: '来源系统', value: presentation.evidenceDetail.sourceSystem },
        { id: 'owner', label: '责任人', value: presentation.evidenceDetail.owner },
        { id: 'due-date', label: '截止日期', value: presentation.evidenceDetail.dueDate, tone: 'error' },
        { id: 'rule', label: '适用规则', value: presentation.evidenceDetail.ruleId },
        { id: 'requirements', label: '关联要求', value: presentation.evidenceDetail.relatedRequirements.join('、') }
      ],
      summary: {
        label: '整改摘要',
        value: presentation.evidenceDetail.summary,
        tone: 'warning'
      },
      selectionChannel: 'gjb5000b-process-domain',
      variants: presentation.processDomains.map((domain) => {
        const isEvidenceDetail = domain.id === presentation.evidenceDetail.domainId
        const tone = gjbEvidenceTone(domain.status)
        return {
          selectionId: domain.id,
          heading: isEvidenceDetail
            ? presentation.evidenceDetail.title
            : `${domain.label} · 证据充分性`,
          status: { label: gjbEvidenceStatusLabel(domain.status), tone },
          sections: isEvidenceDetail
            ? [
                {
                  id: 'expected',
                  label: '期望证据（必需）',
                  value: presentation.evidenceDetail.expectedEvidence.join('、'),
                  help: '最少要求：≥ 1 条有效证据'
                },
                {
                  id: 'current',
                  label: '当前证据',
                  value: presentation.evidenceDetail.currentEvidence.length
                    ? presentation.evidenceDetail.currentEvidence.join('、')
                    : '未找到有效证据',
                  tone: presentation.evidenceDetail.currentEvidence.length ? 'success' as const : 'error' as const
                }
              ]
            : [
                {
                  id: 'coverage',
                  label: '证据覆盖概况',
                  value: `${domain.evidenceCount ?? 0} 条证据覆盖 ${domain.requirementCount ?? 0} 项过程要求`,
                  help: `证据充分率 ${domain.evidenceSufficiencyRate}%`,
                  tone
                },
                {
                  id: 'execution',
                  label: '活动与工作产品',
                  value: `${domain.activityCount ?? 0} 个活动 / ${domain.workProductCount ?? 0} 件工作产品`,
                  help: `活动执行率 ${domain.activityExecutionRate ?? 0}%，工作产品完整率 ${domain.workProductCompletenessRate ?? 0}%`
                }
              ],
          fields: isEvidenceDetail
            ? [
                { id: 'source', label: '来源系统', value: presentation.evidenceDetail.sourceSystem },
                { id: 'owner', label: '责任人', value: presentation.evidenceDetail.owner },
                { id: 'due-date', label: '截止日期', value: presentation.evidenceDetail.dueDate, tone: 'error' as const },
                { id: 'rule', label: '适用规则', value: presentation.evidenceDetail.ruleId },
                { id: 'requirements', label: '关联要求', value: presentation.evidenceDetail.relatedRequirements.join('、') }
              ]
            : [
                { id: 'requirements', label: '过程要求', value: `${domain.requirementCount ?? 0} 项` },
                { id: 'activities', label: '活动执行', value: `${domain.activityExecutionRate ?? 0}%`, tone: gjbToneForRate(domain.activityExecutionRate ?? 0) },
                { id: 'work-products', label: '产品完整', value: `${domain.workProductCompletenessRate ?? 0}%`, tone: gjbToneForRate(domain.workProductCompletenessRate ?? 0) },
                { id: 'evidence', label: '证据充分', value: `${domain.evidenceSufficiencyRate}%`, tone }
              ],
          summary: {
            label: isEvidenceDetail ? '整改摘要' : '检查建议',
            value: isEvidenceDetail
              ? presentation.evidenceDetail.summary
              : domain.status === 'sufficient'
                ? '当前证据链满足受控样例的内部检查阈值，建议持续维护证据时效性。'
                : '建议优先补齐低充分率环节的过程证据，并明确责任人与整改期限。',
            tone: domain.status === 'sufficient' ? 'success' as const : 'warning' as const
          }
        }
      })
    }
  }
  const trend: DashboardComponentSpec = {
    ...deviation,
    type: 'line',
    title: '过程偏差数趋势',
    subtitle: '按检查快照观察开放偏差变化',
    layout: { x: 0, y: 14, w: 8, h: 6 },
    accent: '#8170f2',
    semanticBinding: { ...deviation.semanticBinding!, titleMode: 'custom' }
  }
  const ranking: DashboardComponentSpec = {
    ...evidence,
    id: 'gjb5000b-compliance-evidence-ranking-card',
    type: 'ranking',
    title: '过程域证据充分率差距排名',
    subtitle: '按充分率识别优先改进对象',
    layout: { x: 8, y: 14, w: 8, h: 6 },
    data: scaledPercentData(evidence),
    encoding: { ...evidence.encoding, valueScale: 100 },
    unit: '%',
    accent: '#ffc568',
    semanticBinding: { ...evidence.semanticBinding!, titleMode: 'custom' }
  }
  const closureData = scaledPercentData(nonconformity)
  const intervals: DashboardComponentSpec = {
    ...nonconformity,
    type: 'comparison-bars',
    title: '过程域不符合项关闭率分布',
    subtitle: '对照 85% 目标识别关闭差距',
    layout: { x: 16, y: 14, w: 8, h: 6 },
    data: closureData,
    encoding: { ...nonconformity.encoding, valueScale: 100 },
    unit: '%',
    accent: '#50dda4',
    semanticBinding: { ...nonconformity.semanticBinding!, titleMode: 'custom' },
    content: {
      kind: 'comparison-bars',
      valueLabel: '关闭率',
      secondaryLabel: '目标差距',
      items: closureData.map((point, index) => ({
        id: `${nonconformity.id}-interval-${index}`,
        label: point.name.replace(/过程域$/u, '').trim(),
        value: point.value,
        secondaryValue: point.value - 85,
        unit: '%',
        secondaryUnit: '%',
        tone: gjbToneForRate(point.value)
      }))
    }
  }
  return [
    topActivity,
    topWorkProduct,
    topEvidence,
    topClosure,
    matrix,
    detail,
    trend,
    ranking,
    intervals
  ]
}

const adapterReceipt = (
  compiled: CompiledDashboardDomainBlueprint,
  adapter: DashboardDomainPlatformAdapter
): DashboardDomainGenerationReceipt => {
  const evidenceMissing = adapter.evidenceBindings
    .filter((binding) => binding.evidenceStatus === 'missing')
    .map((binding) => binding.processBindingId)
  const evidenceInsufficient = adapter.evidenceBindings
    .filter((binding) => binding.evidenceStatus === 'insufficient')
    .map((binding) => binding.processBindingId)
  const confidence = evidenceMissing.length ? 0.75 : evidenceInsufficient.length ? 0.9 : 1
  return {
    ...compiled.receipt,
    evidenceMissing,
    evidenceInsufficient,
    confidence,
    warnings: [
      `当前结果使用平台适配器 ${adapter.id}（${adapter.sourceSystem}），仍处于预览状态。`,
      '字段映射和过程证据必须经业务负责人复核后，才能评估正式发布。'
    ],
    confirmations: [
      '请确认项目范围、数据快照时点和平台访问授权。',
      `请确认裁剪基线 ${adapter.tailoringBaselineId} 及适用过程活动。`,
      '请核验指标公式版本、字段映射、过程证据和下钻关系。'
    ],
    vetoCodes: []
  }
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
  domainReceipt: DashboardDomainGenerationReceipt,
  dataMode: 'controlled-sample' | 'platform-adapter',
  adapter?: DashboardDomainPlatformAdapter
): DashboardSpec => {
  const processBindingById = new Set(dashboardDomainCatalog.processBindings.map((binding) => binding.id))
  const metricById = new Map(concreteBlueprint.metrics.map((metric) => [metric.id, metric]))
  const questionById = new Map(concreteBlueprint.questions.map((question) => [question.id, question]))
  const sourceComponents: DashboardComponentSpec[] = compiled.componentPlans.map((plan) => {
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
      confidence: domainReceipt.confidence ?? 0
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
      filters: metricDefinitions.flatMap((metric) => metric.field
        ? [{ field: metric.field, operator: 'notEmpty' as const, source: 'component' as const }]
        : []),
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
  const isGjb5000b = compiled.domainContext.scenario === 'gjb5000b-compliance'
  const presentation = isGjb5000b
    ? gjb5000bPresentationFor(
        input,
        sourceComponents,
        dataMode,
        compiled.domainContext.tailoringBaselineId,
        adapter?.sourceSystem
      )
    : undefined
  const analysisBlueprint = isGjb5000b
    ? gjb5000bBlueprintForPublicPrimitives(concreteBlueprint)
    : concreteBlueprint
  const components = presentation
    ? gjb5000bComponentsForPublicPrimitives(sourceComponents, presentation, queryEngine)
    : sourceComponents
  const dashboard: DashboardSpec = {
    schemaVersion: '1.0',
    id: dashboardIdFor(compiled.domainContext.scenario, input.generatedAt),
    title: dashboardTitleFor(compiled.domainContext.scenario, dataMode),
    subtitle: presentation
      ? `项目：${presentation.projectLabel} · 基线：${presentation.baselineLabel} · 审计周期：${presentation.auditPeriodLabel} · ${presentation.dataModeLabel}`
      : dataMode === 'platform-adapter'
        ? `${adapter?.sourceSystem ?? 'platform'} · mapped data · preview`
        : 'controlled sample · preview',
    businessContext: {
      audience: concreteBlueprint.audience,
      objective: concreteBlueprint.objective,
      scopeDescription: concreteBlueprint.scopeDescription
    },
    domainContext: {
      ...compiled.domainContext,
      dataMode
    },
    domainReceipt,
    ...(presentation ? { presentation } : {}),
    viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 54 },
    theme: 'technology-dark',
    dataScope: JSON.parse(JSON.stringify(scope)) as DataScope,
    analysisBlueprint,
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
  const adapter = input.platformAdapter
  if (adapter) {
    const adapterErrors = validateDashboardDomainPlatformAdapter(adapter)
    if (adapterErrors.length || (input.scenario && adapter.scenarioId !== input.scenario)) {
      const reason = adapterErrors.length
        ? adapterErrors.join('；')
        : `平台适配器场景 ${adapter.scenarioId} 与请求场景 ${input.scenario} 不一致`
      return {
        status: 'rejected',
        reason: 'invalid-platform-adapter',
        receipt: rejectionReceipt(undefined, reason)
      }
    }
  }
  let effectivePermissions = input?.permissions
  let scope: DataScope
  try {
    if (adapter) {
      const access = validateDashboardDomainAdapterAccess(inputScope, input.permissions, adapter)
      if (!access.ok) {
        return {
          status: 'rejected',
          reason: access.reason,
          receipt: rejectionReceipt(undefined, access.message, [access.reason])
        }
      }
      effectivePermissions = access.permissions
      scope = scopedInputForScenario(input, access.scope)
    } else {
      scope = scopedInputForScenario(input, inputScope)
    }
  } catch (error) {
    return {
      status: 'rejected',
      reason: 'adapter-scope-violation',
      receipt: rejectionReceipt(undefined, error instanceof Error ? error.message : String(error))
    }
  }
  const profiles = queryEngine.profile(scope)
  if (adapter) {
    const profileErrors = validateDashboardDomainAdapterProfiles(adapter, profiles)
    if (profileErrors.length) {
      return {
        status: 'rejected',
        reason: 'invalid-adapter-field-mapping',
        receipt: rejectionReceipt(undefined, profileErrors.join('；'))
      }
    }
  }
  const resolvedMetrics = adapter
    ? new Map(adapter.metricBindings.map((binding) => [binding.metricId, {
        field: binding.field.trim(),
        aggregation: binding.aggregation
      }]))
    : resolveProfileMetricFields(profiles)
  const questionDimensions: Record<string, readonly string[]> = adapter
    ? Object.fromEntries(adapter.questionBindings.map((binding) => [
        binding.questionId,
        binding.dimensionFields.map((field) => field.trim()).filter(Boolean)
      ]))
    : controlledQuestionDimensions
  const effectiveBaselineId = adapter?.tailoringBaselineId.trim() ?? input?.tailoringBaselineId
  const plan = resolveDashboardDomainPlan({
    request: input?.request ?? '',
    role: input?.role,
    scenario: input?.scenario,
    projectIds: normalizedProjectIds(scope),
    tailoringBaselineId: effectiveBaselineId,
    permissions: effectivePermissions,
    dataQuality: input?.dataQuality,
    metricConflicts: input?.metricConflicts,
    availableMetricIds: [...resolvedMetrics.keys()]
  })
  if (plan.status !== 'ready') return plannerClarification(plan)

  const knownBaselineIds = new Set([
    ...dashboardDomainCatalog.processBindings.map((binding) => binding.tailoringBaselineId),
    ...(adapter ? [adapter.tailoringBaselineId.trim()] : [])
  ])
  const baselineId = effectiveBaselineId?.trim() ?? ''
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
      generatedAt: input.generatedAt,
      ...(adapter ? { platformAdapterId: adapter.id, sourceSystem: adapter.sourceSystem } : {})
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
    const domainReceipt: DashboardDomainGenerationReceipt = adapter
      ? adapterReceipt(compiled, adapter)
      : { ...compiled.receipt, vetoCodes: [] }
    const concreteBlueprint = blueprintWithConcreteMetrics(
      compiled.analysisBlueprint,
      resolvedMetrics,
      questionDimensions,
      domainReceipt.confidence ?? compiled.receipt.confidence
    )
    const dataMode = adapter ? 'platform-adapter' : 'controlled-sample'
    const dashboard = buildDashboard(
      input,
      scope,
      compiled,
      concreteBlueprint,
      queryEngine,
      domainReceipt,
      dataMode,
      adapter
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
      processBindingIds: plan.processBindingIds,
      dataMode,
      ...(adapter ? { adapterId: adapter.id, sourceSystem: adapter.sourceSystem } : {})
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
