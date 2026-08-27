import type {
  DashboardAnalysisBlueprint,
  DashboardComponentSpec,
  DashboardMetricDefinition,
  DashboardSemanticBinding,
  DashboardSpec
} from './dashboard'

export type DashboardSemanticSeverity = 'error' | 'warning'

export interface DashboardSemanticIssue {
  code: string
  severity: DashboardSemanticSeverity
  message: string
  componentId?: string
  questionId?: string
}

const aggregationLabels: Record<DashboardMetricDefinition['aggregation'], string> = {
  count: '数量',
  countDistinct: '去重数量',
  sum: '总量',
  avg: '平均值',
  min: '最小值',
  max: '最大值'
}

const calculationLabels: Record<NonNullable<DashboardMetricDefinition['calculation']>, string> = {
  yoy: '同比',
  mom: '环比',
  share: '占比',
  cumulative: '累计'
}

const componentTitleSuffix: Partial<Record<DashboardComponentSpec['type'], string>> = {
  line: '趋势',
  bar: '对比',
  pie: '构成',
  ranking: '排行',
  table: '明细',
  progress: '进度',
  gauge: '达成情况',
  funnel: '转化漏斗',
  radar: '多维对比',
  scatter: '相关性分布',
  treemap: '层级构成',
  combo: '组合趋势'
}

const normalizeSemanticText = (value: string): string =>
  value.toLocaleLowerCase().replace(/[\s，。；：、·_\-—（）()\[\]【】]/g, '')

const fieldLabel = (field: string): string => {
  const parts = field.split('.').filter(Boolean)
  return parts[parts.length - 1] ?? field
}

export const metricDisplayLabel = (metric: DashboardMetricDefinition): string => {
  const base = metric.label.trim() || (metric.field ? fieldLabel(metric.field) : metric.measureId)
  if (metric.calculation) return `${base}${calculationLabels[metric.calculation]}`
  if (metric.aggregation === 'count' && /数|量|count/i.test(base)) return base
  return `${base}${aggregationLabels[metric.aggregation]}`
}

export const automaticDashboardComponentTitle = (
  blueprint: DashboardAnalysisBlueprint,
  component: Pick<DashboardComponentSpec, 'type' | 'semanticBinding'>
): string => {
  const binding = component.semanticBinding
  if (!binding) return ''
  const metrics = binding.metricIds
    .map((metricId) => blueprint.metrics.find((metric) => metric.id === metricId))
    .filter((metric): metric is DashboardMetricDefinition => Boolean(metric))
  if (!metrics.length) return ''
  const metricLabel = metrics.map(metricDisplayLabel).join(' / ')
  const dimensionLabel = binding.dimensionFields.map(fieldLabel).join(' / ')
  const suffix = componentTitleSuffix[component.type]
  const base = [dimensionLabel, metricLabel].filter(Boolean).join(' · ')
  return suffix && !normalizeSemanticText(base).endsWith(normalizeSemanticText(suffix))
    ? `${base}${suffix}`
    : base
}

const bindingIssues = (
  blueprint: DashboardAnalysisBlueprint,
  component: DashboardComponentSpec,
  binding: DashboardSemanticBinding
): DashboardSemanticIssue[] => {
  const issues: DashboardSemanticIssue[] = []
  if (!binding.metricIds.length) {
    issues.push({
      code: 'missing-bound-metric',
      severity: 'error',
      componentId: component.id,
      questionId: binding.questionId,
      message: `组件 ${component.title} 没有绑定任何受控指标`
    })
  }
  const question = blueprint.questions.find((item) => item.id === binding.questionId)
  if (!question) {
    issues.push({
      code: 'unknown-question',
      severity: 'error',
      componentId: component.id,
      questionId: binding.questionId,
      message: `组件 ${component.title} 引用了不存在的业务问题 ${binding.questionId}`
    })
  } else {
    const boundMetricIds = new Set(binding.metricIds)
    const missingQuestionMetrics = question.metricIds.filter((metricId) => !boundMetricIds.has(metricId))
    const questionMetricIds = new Set(question.metricIds)
    const unexpectedBoundMetrics = binding.metricIds.filter((metricId) => !questionMetricIds.has(metricId))
    if (missingQuestionMetrics.length || unexpectedBoundMetrics.length) {
      issues.push({
        code: 'question-metric-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的指标绑定与业务问题不一致`
      })
    }
    if (JSON.stringify(binding.dimensionFields) !== JSON.stringify(question.dimensionFields)) {
      issues.push({
        code: 'question-dimension-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的维度与业务问题定义不一致`
      })
    }
    const queryTimeGrains = Array.from(new Set(
      (component.query?.dimensions ?? [])
        .filter((dimension) => binding.dimensionFields.includes(dimension.field))
        .flatMap((dimension) => dimension.timeGrain ? [dimension.timeGrain] : [])
    ))
    const questionTimeGrains = question.timeGrain ? [question.timeGrain] : []
    if (JSON.stringify(queryTimeGrains) !== JSON.stringify(questionTimeGrains)) {
      issues.push({
        code: 'question-time-grain-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的时间粒度与业务问题定义不一致`
      })
    }
    if (component.slotRole !== question.slotRole) {
      issues.push({
        code: 'question-slot-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的语义槽位应为 ${question.slotRole}`
      })
    }
    if (!question.preferredComponentTypes.includes(component.type)) {
      issues.push({
        code: 'question-component-type-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件类型 ${component.type} 不能回答业务问题“${question.question}”`
      })
    }
  }
  const metricById = new Map(blueprint.metrics.map((metric) => [metric.id, metric]))
  const queryMeasureById = new Map(component.query?.measures.map((measure) => [measure.id, measure]) ?? [])
  const boundMeasureIds = new Set<string>()
  for (const metricId of binding.metricIds) {
    const metric = metricById.get(metricId)
    if (!metric) {
      issues.push({
        code: 'unknown-metric',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 引用了不存在的指标 ${metricId}`
      })
      continue
    }
    const measure = queryMeasureById.get(metric.measureId)
    if (!measure) {
      issues.push({
        code: 'metric-query-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的查询没有实现指标 ${metric.label}`
      })
      continue
    }
    boundMeasureIds.add(metric.measureId)
    if (
      measure.aggregation !== metric.aggregation ||
      (measure.field ?? '') !== (metric.field ?? '') ||
      (measure.calculation ?? '') !== (metric.calculation ?? '')
    ) {
      issues.push({
        code: 'metric-definition-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的字段、聚合或计算方式与指标 ${metric.label} 不一致`
      })
    }
  }
  for (const measure of component.query?.measures ?? []) {
    if (!boundMeasureIds.has(measure.id)) {
      issues.push({
        code: 'unbound-query-measure',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的查询指标 ${measure.id} 没有纳入业务语义绑定`
      })
    }
  }
  const queryDimensions = new Set(component.query?.dimensions?.map((dimension) => dimension.field) ?? [])
  for (const dimensionField of binding.dimensionFields) {
    if (!queryDimensions.has(dimensionField)) {
      issues.push({
        code: 'dimension-query-mismatch',
        severity: 'error',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的查询没有实现维度 ${dimensionField}`
      })
    }
  }
  const automaticTitle = automaticDashboardComponentTitle(blueprint, component)
  if (binding.titleMode === 'auto' && automaticTitle && component.title !== automaticTitle) {
    issues.push({
      code: 'automatic-title-mismatch',
      severity: 'error',
      componentId: component.id,
      questionId: binding.questionId,
      message: `组件 ${component.id} 的自动标题应为“${automaticTitle}”`
    })
  }
  if (binding.titleMode === 'custom') {
    const terms = binding.metricIds
      .map((metricId) => metricById.get(metricId))
      .filter((metric): metric is DashboardMetricDefinition => Boolean(metric))
      .flatMap((metric) => [metric.label, metric.field ? fieldLabel(metric.field) : ''])
      .filter(Boolean)
      .map(normalizeSemanticText)
    const normalizedTitle = normalizeSemanticText(component.title)
    if (terms.length && !terms.some((term) => normalizedTitle.includes(term))) {
      issues.push({
        code: 'custom-title-weak-match',
        severity: 'warning',
        componentId: component.id,
        questionId: binding.questionId,
        message: `组件 ${component.title} 的自定义标题未体现已绑定指标`
      })
    }
  }
  return issues
}

export const validateDashboardSemanticConsistency = (
  spec: DashboardSpec
): DashboardSemanticIssue[] => {
  const blueprint = spec.analysisBlueprint
  if (!blueprint) return []
  const issues: DashboardSemanticIssue[] = []
  const componentQuestionIds = new Set<string>()
  for (const component of spec.components) {
    if (!component.semanticBinding) {
      issues.push({
        code: 'missing-semantic-binding',
        severity: 'error',
        componentId: component.id,
        message: `组件 ${component.title} 缺少业务语义绑定`
      })
      continue
    }
    componentQuestionIds.add(component.semanticBinding.questionId)
    issues.push(...bindingIssues(blueprint, component, component.semanticBinding))
  }
  for (const question of blueprint.questions.filter((item) => item.required)) {
    if (!componentQuestionIds.has(question.id)) {
      issues.push({
        code: 'unanswered-required-question',
        severity: 'error',
        questionId: question.id,
        message: `必答业务问题“${question.question}”没有对应组件`
      })
    }
  }
  return issues
}
