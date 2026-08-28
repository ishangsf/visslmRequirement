import type {
  DashboardAnalysisBlueprint,
  DashboardAnalysisQuestion,
  DashboardComponentSpec,
  DashboardMetricDefinition,
  DashboardSpec
} from '../../shared/dashboard'
import {
  automaticDashboardComponentTitle
} from '../../shared/dashboard-semantics'
import type { QueryAggregation } from '../../shared/query-spec'
import type { AnalyticsRecord } from '../database'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

/**
 * Controlled sample data for the first project-overview slice.
 *
 * The records are intentionally local and synthetic. They exercise the
 * existing records QueryEngine and are not evidence of a real platform or
 * an official conformity assessment. A production adapter must replace the
 * sample source with authorized project snapshots before changing preview to
 * formal.
 */
const controlledSampleRecords: AnalyticsRecord[] = [
  {
    uid: 'sample-project-overview-001',
    projectId: 'sample-project-001',
    nodeType: 'ProjectOverviewSample',
    itemId: 'SAMPLE-PO-001',
    name: '受控样例项目·基线',
    lastModifyTime: '2026-08-01T00:00:00.000Z',
    raw: {
      healthScore: 78,
      milestoneAchievement: 0.72,
      requirementCompletion: 0.68,
      defectDensity: 0.12,
      highRiskCount: 2,
      processCompliance: 0.71
    }
  },
  {
    uid: 'sample-project-overview-002',
    projectId: 'sample-project-001',
    nodeType: 'ProjectOverviewSample',
    itemId: 'SAMPLE-PO-002',
    name: '受控样例项目·阶段二',
    lastModifyTime: '2026-08-08T00:00:00.000Z',
    raw: {
      healthScore: 82,
      milestoneAchievement: 0.86,
      requirementCompletion: 0.74,
      defectDensity: 0.09,
      highRiskCount: 1,
      processCompliance: 0.77
    }
  },
  {
    uid: 'sample-project-overview-003',
    projectId: 'sample-project-001',
    nodeType: 'ProjectOverviewSample',
    itemId: 'SAMPLE-PO-003',
    name: '受控样例项目·阶段三',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      healthScore: 75,
      milestoneAchievement: 0.8,
      requirementCompletion: 0.8,
      defectDensity: 0.15,
      highRiskCount: 1,
      processCompliance: 0.74
    }
  }
]

const sampleMetricConfig: Record<string, {
  field: string
  aggregation: QueryAggregation
}> = {
  'project-health': { field: 'healthScore', aggregation: 'avg' },
  'milestone-achievement': { field: 'milestoneAchievement', aggregation: 'avg' },
  'requirement-completion': { field: 'requirementCompletion', aggregation: 'avg' },
  'defect-density': { field: 'defectDensity', aggregation: 'avg' },
  'high-risk-count': { field: 'highRiskCount', aggregation: 'sum' },
  'process-compliance': { field: 'processCompliance', aggregation: 'avg' }
}

const sampleMeasureId = (metricId: string): string => `${metricId}-sample-measure`

const projectOverviewMetricIds = [
  'project-health',
  'milestone-achievement',
  'requirement-completion',
  'defect-density',
  'high-risk-count',
  'process-compliance'
] as const

const blueprintMetrics: DashboardMetricDefinition[] = dashboardDomainCatalog.metrics
  .filter((metric) => projectOverviewMetricIds.includes(metric.id as typeof projectOverviewMetricIds[number]))
  .map((metric) => {
    const config = sampleMetricConfig[metric.id]
    if (!config) throw new Error(`受控样例缺少指标映射: ${metric.id}`)
    return {
      id: metric.id,
      label: metric.label,
      description: metric.definition,
      measureId: sampleMeasureId(metric.id),
      field: config.field,
      aggregation: config.aggregation,
      ...(metric.format ? { format: metric.format } : {}),
      ...(metric.unit ? { unit: metric.unit } : {}),
      source: 'catalog',
      confidence: 1
    }
  })

const dimensionFieldsByQuestionId: Record<string, string[]> = {
  'project-overview-defect-question': ['name']
}

const projectOverviewQuestions = dashboardDomainCatalog.questions.filter((question) =>
  question.id.startsWith('project-overview-')
)

const blueprintQuestions: DashboardAnalysisQuestion[] = projectOverviewQuestions.map((question) => ({
  id: question.id,
  question: question.question,
  metricIds: [...question.metricIds],
  dimensionFields: [...(dimensionFieldsByQuestionId[question.id] ?? [])],
  preferredComponentTypes: [...question.preferredComponentTypes],
  slotRole: question.slotRole,
  priority: question.priority,
  required: question.required
}))

const semanticBinding = (
  questionId: string,
  metricId: string
): NonNullable<DashboardComponentSpec['semanticBinding']> => ({
  questionId,
  metricIds: [metricId],
  dimensionFields: [...(dimensionFieldsByQuestionId[questionId] ?? [])],
  processBindingIds: [...(
    dashboardDomainCatalog.metrics.find((metric) => metric.id === metricId)?.processRequirementIds ?? []
  )],
  titleMode: 'auto',
  confidence: 0.75
})

const queryFor = (metricId: string, questionId: string) => {
  const config = sampleMetricConfig[metricId]
  if (!config) throw new Error(`受控样例缺少查询映射: ${metricId}`)
  const dimensions = dimensionFieldsByQuestionId[questionId] ?? []
  return {
    source: 'records' as const,
    scope: {
      projectIds: ['sample-project-001'],
      nodeTypes: ['ProjectOverviewSample']
    },
    ...(dimensions.length ? {
      dimensions: dimensions.map((field) => ({ field }))
    } : {}),
    measures: [{
      id: sampleMeasureId(metricId),
      field: config.field,
      aggregation: config.aggregation
    }],
    limit: 10
  }
}

const componentDefinitions: Array<{
  id: string
  type: DashboardComponentSpec['type']
  metricId: string
  questionId: string
  layout: DashboardComponentSpec['layout']
  accent: string
}> = [
  {
    id: 'project-overview-health-card',
    type: 'kpi',
    metricId: 'project-health',
    questionId: 'project-overview-health-question',
    layout: { x: 0, y: 0, w: 12, h: 3 },
    accent: '#8d7cff'
  },
  {
    id: 'project-overview-risk-card',
    type: 'kpi',
    metricId: 'high-risk-count',
    questionId: 'project-overview-risk-question',
    layout: { x: 12, y: 0, w: 12, h: 3 },
    accent: '#ff7f9d'
  },
  {
    id: 'project-overview-milestone-card',
    type: 'progress',
    metricId: 'milestone-achievement',
    questionId: 'project-overview-milestone-question',
    layout: { x: 0, y: 3, w: 12, h: 5 },
    accent: '#50dda4'
  },
  {
    id: 'project-overview-requirement-card',
    type: 'gauge',
    metricId: 'requirement-completion',
    questionId: 'project-overview-requirement-question',
    layout: { x: 12, y: 3, w: 12, h: 5 },
    accent: '#64dbff'
  },
  {
    id: 'project-overview-defect-card',
    type: 'bar',
    metricId: 'defect-density',
    questionId: 'project-overview-defect-question',
    layout: { x: 0, y: 8, w: 12, h: 5 },
    accent: '#ffc568'
  },
  {
    id: 'project-overview-process-card',
    type: 'progress',
    metricId: 'process-compliance',
    questionId: 'project-overview-process-question',
    layout: { x: 12, y: 8, w: 12, h: 5 },
    accent: '#d7a45f'
  }
]

const blueprint: DashboardAnalysisBlueprint = {
  version: '1.0',
  request: '受控样例：生成项目综合态势大屏',
  audience: '项目负责人',
  objective: '在同一项目快照中查看执行、质量和过程证据线索。',
  scopeDescription: 'controlled sample project-overview；仅用于 QueryEngine 契约验证。',
  metrics: blueprintMetrics,
  questions: blueprintQuestions,
  assumptions: [
    '本 fixture 使用受控样例 records，不代表真实平台数据。',
    '过程绑定使用内部 sample 标识，真实适配器接入前保持 preview。'
  ],
  unresolvedAmbiguities: [],
  generatedAt: '2026-08-28T00:00:00.000Z'
}

const components: DashboardComponentSpec[] = componentDefinitions.map((definition) => {
  const binding = semanticBinding(definition.questionId, definition.metricId)
  const component: DashboardComponentSpec = {
    id: definition.id,
    type: definition.type,
    title: '',
    layout: definition.layout,
    data: [],
    query: queryFor(definition.metricId, definition.questionId),
    encoding: {
      ...(dimensionFieldsByQuestionId[definition.questionId]?.length
        ? { label: dimensionFieldsByQuestionId[definition.questionId][0] }
        : {}),
      value: sampleMeasureId(definition.metricId)
    },
    accent: definition.accent,
    semanticBinding: binding,
    slotRole: blueprintQuestions.find((question) => question.id === definition.questionId)?.slotRole
  }
  component.title = automaticDashboardComponentTitle(blueprint, component)
  return component
})

const projectOverviewProcessBindings = dashboardDomainCatalog.processBindings.filter((binding) =>
  binding.metricIds.some((metricId) => projectOverviewMetricIds.includes(
    metricId as typeof projectOverviewMetricIds[number]
  ))
)

const projectOverviewSpec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'controlled-project-overview',
  title: '项目综合态势（受控样例）',
  subtitle: 'controlled sample · preview',
  businessContext: {
    audience: blueprint.audience,
    objective: blueprint.objective,
    scopeDescription: blueprint.scopeDescription
  },
  domainContext: {
    role: 'project-owner',
    scenario: 'project-overview',
    catalogVersion: dashboardDomainCatalog.version,
    tailoringBaselineId: 'sample-tailoring-baseline-v1',
    artifactStatus: 'preview'
  },
  domainReceipt: {
    adoptedMetricIds: [...projectOverviewMetricIds],
    missingMetricIds: [],
    evidenceMissing: projectOverviewProcessBindings
      .filter((binding) => binding.evidenceStatus === 'missing')
      .map((binding) => binding.id),
    evidenceInsufficient: projectOverviewProcessBindings
      .filter((binding) => binding.evidenceStatus === 'insufficient')
      .map((binding) => binding.id),
    confidence: 0.75,
    warnings: ['受控样例只允许作为 preview，不构成正式符合性结论。'],
    confirmations: ['请接入真实项目范围、裁剪基线和过程证据后重新评估。'],
    vetoCodes: []
  },
  theme: 'technology-dark',
  analysisBlueprint: blueprint,
  updatedAt: '2026-08-28T00:00:00.000Z',
  components
}

export const projectOverviewGoldenFixture = {
  records: controlledSampleRecords,
  spec: projectOverviewSpec
}

export default projectOverviewGoldenFixture
