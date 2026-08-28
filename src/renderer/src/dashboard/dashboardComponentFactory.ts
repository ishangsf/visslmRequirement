import type {
  DashboardAnalysisBlueprint,
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardMetricDefinition,
  DashboardSemanticBinding,
  DashboardSlotRole,
  DashboardSpec
} from '../../../shared/dashboard'
import {
  automaticDashboardComponentTitle,
  dashboardFieldDisplayLabel
} from '../../../shared/dashboard-semantics'
import {
  findFirstAvailableDashboardLayout
} from '../../../shared/dashboard-layout'
import type {
  DataScope,
  FieldProfile,
  QueryDimension,
  QueryMeasure,
  QuerySpec
} from '../../../shared/query-spec'
import { componentDefinitionByType } from './componentRegistry'

export type ManualDashboardComponentPlan = {
  component: DashboardComponentSpec
  analysisBlueprint?: DashboardAnalysisBlueprint
  /** Populated when a legacy query-backed dashboard is upgraded atomically. */
  components?: DashboardComponentSpec[]
}

export type ManualDashboardComponentRemovalPlan = {
  components: DashboardComponentSpec[]
  analysisBlueprint?: DashboardAnalysisBlueprint
}

type FactoryResult = ManualDashboardComponentPlan | { error: string }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export const planDashboardComponentRemoval = (
  dashboard: DashboardSpec,
  componentId: string
): ManualDashboardComponentRemovalPlan | { error: string } => {
  if (dashboard.components.length <= 1) return { error: '大屏至少保留一个组件。' }
  const removed = dashboard.components.find((component) => component.id === componentId)
  if (!removed) return { error: `组件 ${componentId} 不存在。` }
  const components = dashboard.components
    .filter((component) => component.id !== componentId)
    .map((component) => clone(component))
  if (!dashboard.analysisBlueprint) return { components }
  const analysisBlueprint = clone(dashboard.analysisBlueprint)
  const removedQuestionId = removed.semanticBinding?.questionId
  if (removedQuestionId && !components.some((component) =>
    component.semanticBinding?.questionId === removedQuestionId
  )) {
    analysisBlueprint.questions = analysisBlueprint.questions.map((question) =>
      question.id === removedQuestionId && question.required
        ? { ...question, required: false }
        : question
    )
  }
  return { components, analysisBlueprint }
}

const fieldLabel = (profile?: FieldProfile, fallback = ''): string =>
  profile ? dashboardFieldDisplayLabel(profile.field, profile.displayName) : fallback

const slug = (value: string): string =>
  value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'component'

type LegacySemanticUpgrade = {
  components: DashboardComponentSpec[]
  blueprint: DashboardAnalysisBlueprint
}

const nextStableId = (base: string, used: Set<string>): string => {
  let candidate = base
  let index = 2
  while (used.has(candidate)) {
    candidate = `${base}-${index}`
    index += 1
  }
  used.add(candidate)
  return candidate
}

/**
 * v1 dashboards generated before the semantic sidecar still carry enough
 * information in their QuerySpecs to build a conservative blueprint. The
 * upgrade is clone-on-write and rejects mixed inline/query dashboards so a
 * newly created semantic binding can never be persisted without its sidecar.
 */
const deriveLegacySemanticBlueprint = (
  dashboard: DashboardSpec,
  profiles: FieldProfile[]
): LegacySemanticUpgrade | { error: string } => {
  const queryComponents = dashboard.components.filter((component) => component.query)
  if (!queryComponents.length) {
    return { error: '当前大屏没有 QuerySpec 数据范围；纯 inline 组件无法安全新增语义组件。' }
  }
  if (queryComponents.length !== dashboard.components.length) {
    return { error: '当前大屏同时包含 QuerySpec 与 inline 组件，无法为所有组件建立完整业务蓝图；请先为 inline 组件绑定查询。' }
  }
  if (queryComponents.some((component) => !component.query?.scope)) {
    return { error: '当前大屏的 QuerySpec 缺少数据范围，无法建立业务蓝图。' }
  }

  const metrics: DashboardMetricDefinition[] = []
  const questions: DashboardAnalysisBlueprint['questions'] = []
  const usedMetricIds = new Set<string>()
  const usedQuestionIds = new Set<string>()
  const components: DashboardComponentSpec[] = []

  for (const sourceComponent of dashboard.components) {
    const component = clone(sourceComponent)
    const query = component.query!
    if (!query.measures.length) {
      return { error: `组件 ${component.title} 的 QuerySpec 没有指标，无法建立业务蓝图。` }
    }
    const metricIds = query.measures.map((measure) => {
      const metricId = nextStableId(
        `legacy-metric-${slug(component.id)}-${slug(measure.id)}`,
        usedMetricIds
      )
      const profile = measure.field
        ? profiles.find((item) => item.field === measure.field)
        : undefined
      metrics.push({
        id: metricId,
        label: profile
          ? dashboardFieldDisplayLabel(profile.field, profile.displayName)
          : measure.id === 'record_count' ? '记录数' : measure.id,
        description: '从历史组件 QuerySpec 推断的指标',
        measureId: measure.id,
        ...(measure.field ? { field: measure.field } : {}),
        aggregation: measure.aggregation,
        ...(measure.calculation ? { calculation: measure.calculation } : {}),
        source: 'inferred',
        confidence: 0.5
      })
      return metricId
    })
    const dimensionFields = query.dimensions?.map((dimension) => dimension.field) ?? []
    const slotRole = component.slotRole
      ?? componentDefinitionByType.get(component.type)?.compatibleSlotRoles[0]
      ?? 'diagnosis'
    const questionId = nextStableId(`legacy-question-${slug(component.id)}`, usedQuestionIds)
    questions.push({
      id: questionId,
      question: `${component.title}表达了什么？`,
      metricIds,
      dimensionFields,
      ...(query.dimensions?.[0]?.timeGrain ? { timeGrain: query.dimensions[0].timeGrain } : {}),
      preferredComponentTypes: [component.type],
      slotRole,
      priority: questions.length + 1,
      required: false
    })
    const primaryMeasure = query.measures.find((measure) => measure.id === component.encoding?.value)
      ?? query.measures[0]
    const encodingLabel = component.encoding?.label && dimensionFields.includes(component.encoding.label)
      ? component.encoding.label
      : dimensionFields[0]
    component.encoding = {
      ...(component.encoding ?? {}),
      value: primaryMeasure.id,
      ...(encodingLabel ? { label: encodingLabel } : {})
    }
    component.slotRole = slotRole
    component.semanticBinding = {
      questionId,
      metricIds,
      dimensionFields,
      titleMode: 'auto',
      confidence: 0.5
    }
    components.push(component)
  }

  const blueprint: DashboardAnalysisBlueprint = {
    version: '1.0',
    request: dashboard.title,
    audience: dashboard.businessContext?.audience ?? '大屏使用者',
    objective: dashboard.businessContext?.objective ?? dashboard.subtitle,
    scopeDescription: dashboard.businessContext?.scopeDescription ?? '按历史 QuerySpec 推断的数据范围',
    metrics,
    questions,
    assumptions: ['该蓝图由历史 QuerySpec 自动推断，建议后续由业务人员确认。'],
    unresolvedAmbiguities: [],
    generatedAt: dashboard.updatedAt
  }
  for (const component of components) {
    const automaticTitle = automaticDashboardComponentTitle(blueprint, component)
    if (automaticTitle) component.title = automaticTitle
  }
  return { components, blueprint }
}

export const createDashboardComponentId = (prefix: string, existing: Set<string>): string => {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10)
  let candidate = `${prefix}-${random}`
  let index = 2
  while (existing.has(candidate)) {
    candidate = `${prefix}-${random}-${index}`
    index += 1
  }
  return candidate
}

const usableProfile = (profile: FieldProfile): boolean =>
  profile.sensitivity !== 'sensitive' && profile.field.trim().length > 0

const isCategoryProfile = (profile: FieldProfile): boolean =>
  usableProfile(profile) && (
    profile.role === 'dimension' ||
    profile.inferredType === 'string' ||
    profile.inferredType === 'enum' ||
    profile.inferredType === 'boolean'
  )

const isTimeProfile = (profile: FieldProfile): boolean =>
  usableProfile(profile) && (profile.role === 'time' || profile.inferredType === 'date')

const isNumericProfile = (profile: FieldProfile): boolean =>
  usableProfile(profile) && profile.inferredType === 'number'

const profileForDimension = (
  profiles: FieldProfile[],
  type: DashboardComponentType
): FieldProfile | undefined => {
  if (type === 'treemap') return profiles.find(isCategoryProfile)
  if (type === 'line' || type === 'combo') {
    return profiles.find(isTimeProfile) ?? profiles.find(isCategoryProfile)
  }
  return profiles.find(isCategoryProfile) ?? profiles.find(isTimeProfile)
}

const dashboardFilterSpecs = (dashboard: DashboardSpec) =>
  (dashboard.globalFilters ?? []).flatMap((filter) => {
    if (filter.value === undefined || (Array.isArray(filter.value) && !filter.value.length)) return []
    return [{
      field: filter.field,
      operator: filter.operator,
      value: clone(filter.value),
      source: 'dashboard' as const
    }]
  })

const createMeasure = (field?: FieldProfile, id = 'record_count'): QueryMeasure =>
  field
    ? { id, field: field.field, aggregation: 'sum' }
    : { id, aggregation: 'count' }

const metricMatchesMeasure = (
  metric: DashboardMetricDefinition,
  measure: QueryMeasure
): boolean => metric.measureId === measure.id &&
  metric.aggregation === measure.aggregation &&
  (metric.field ?? '') === (measure.field ?? '') &&
  (metric.calculation ?? '') === (measure.calculation ?? '')

const buildQuery = (
  dashboard: DashboardSpec,
  type: DashboardComponentType,
  profiles: FieldProfile[]
): { query: QuerySpec; encoding: NonNullable<DashboardComponentSpec['encoding']>; dimensionProfile?: FieldProfile } | { error: string } => {
  const template = dashboard.components.find((component) => component.query)?.query
  const scope: DataScope | undefined = template?.scope
  if (!scope) return { error: '当前大屏没有可用的数据范围，无法新增绑定查询的组件。' }

  const primary = createMeasure(undefined)
  const measures: QueryMeasure[] = [primary]
  const dimensionProfile = profileForDimension(profiles, type)
  const needsDimension = [
    'bar',
    'line',
    'pie',
    'ranking',
    'funnel',
    'radar',
    'scatter',
    'table',
    'treemap',
    'combo'
  ].includes(type)
  if (needsDimension && !dimensionProfile && type !== 'table') {
    return { error: `${componentDefinitionByType.get(type)?.name ?? '该组件'}需要一个可用的分类或时间字段，请先完成字段画像。` }
  }

  if (type === 'scatter' || type === 'combo') {
    const numeric = profiles.find(isNumericProfile)
    if (!numeric) {
      return {
        error: type === 'combo'
          ? '组合图需要至少一个非敏感数值字段作为第二指标，当前数据范围没有可用字段。'
          : '散点图需要至少一个非敏感数值字段，当前数据范围没有可用字段。'
      }
    }
    measures.push(createMeasure(numeric, `sum_${slug(numeric.field)}`))
  }

  const dimensions: QueryDimension[] = dimensionProfile
    ? [{
        field: dimensionProfile.field,
        ...(isTimeProfile(dimensionProfile) ? { timeGrain: 'month' as const } : {})
      }]
    : []
  const singleValue = ['kpi', 'progress', 'gauge', 'insight'].includes(type)
  const query: QuerySpec = {
    source: 'records',
    scope: clone(scope),
    ...(dimensions.length && !singleValue ? { dimensions } : {}),
    measures,
    filters: dashboardFilterSpecs(dashboard),
    sort: [{ field: primary.id, direction: 'desc' }],
    limit: ['kpi', 'progress', 'gauge', 'insight'].includes(type)
      ? 1
      : type === 'line' || type === 'combo' ? 60 : type === 'table' ? 100 : 20
  }
  const encoding: NonNullable<DashboardComponentSpec['encoding']> = {
    ...(dimensions.length && !singleValue ? { label: dimensions[0].field } : {}),
    value: primary.id,
    ...(type === 'scatter' || type === 'combo' ? { secondaryValue: measures[1].id } : {})
  }
  return { query, encoding, dimensionProfile }
}

const metricForMeasure = (
  measure: QueryMeasure,
  profiles: FieldProfile[],
  blueprint: DashboardAnalysisBlueprint,
  usedIds: Set<string>
): DashboardMetricDefinition => {
  const existing = blueprint.metrics.find((metric) => metricMatchesMeasure(metric, measure))
  if (existing) {
    usedIds.add(existing.id)
    return existing
  }
  const profile = measure.field ? profiles.find((item) => item.field === measure.field) : undefined
  const baseId = `manual-${slug(measure.id)}`
  let id = baseId
  let index = 2
  while (usedIds.has(id) || blueprint.metrics.some((metric) => metric.id === id)) {
    id = `${baseId}-${index}`
    index += 1
  }
  usedIds.add(id)
  return {
    id,
    label: profile ? fieldLabel(profile, measure.id) : measure.id === 'record_count' ? '记录数' : measure.id,
    description: '由组件库手工添加并绑定当前数据范围',
    measureId: measure.id,
    ...(measure.field ? { field: measure.field } : {}),
    aggregation: measure.aggregation,
    ...(measure.calculation ? { calculation: measure.calculation } : {}),
    source: 'user',
    confidence: 0.65
  }
}

const ensureBlueprintBinding = (
  dashboard: DashboardSpec,
  componentId: string,
  type: DashboardComponentType,
  slotRole: DashboardSlotRole,
  query: QuerySpec,
  dimensionProfile: FieldProfile | undefined,
  profiles: FieldProfile[]
): { blueprint: DashboardAnalysisBlueprint; binding: DashboardSemanticBinding; title: string } => {
  const blueprint = clone(dashboard.analysisBlueprint!)
  const usedMetricIds = new Set(blueprint.metrics.map((metric) => metric.id))
  const metrics = query.measures.map((measure) => metricForMeasure(measure, profiles, blueprint, usedMetricIds))
  for (const metric of metrics) {
    if (!blueprint.metrics.some((item) => item.id === metric.id)) blueprint.metrics.push(metric)
  }
  const metricIds = metrics.map((metric) => metric.id)
  const dimensionFields = query.dimensions?.map((dimension) => dimension.field) ?? []
  const sameMetricIds = (left: string[], right: string[]): boolean =>
    left.length === right.length && left.every((metricId) => right.includes(metricId))
  const question = blueprint.questions.find((item) =>
    item.slotRole === slotRole &&
    item.preferredComponentTypes.includes(type) &&
    sameMetricIds(item.metricIds, metricIds) &&
    JSON.stringify(item.dimensionFields) === JSON.stringify(dimensionFields)
  )
  const questionId = question?.id ?? createDashboardComponentId(`manual-question-${slug(type)}`, new Set(blueprint.questions.map((item) => item.id)))
  if (!question) {
    blueprint.questions.push({
      id: questionId,
      question: `${dimensionProfile ? fieldLabel(dimensionProfile) : '当前范围'}的${metrics.map((metric) => metric.label).join('与')}表现如何？`,
      metricIds,
      dimensionFields,
      ...(dimensionProfile && isTimeProfile(dimensionProfile) ? { timeGrain: 'month' as const } : {}),
      preferredComponentTypes: [type],
      slotRole,
      priority: 50,
      required: false
    })
  }
  const binding: DashboardSemanticBinding = {
    questionId,
    metricIds,
    dimensionFields,
    titleMode: 'auto',
    confidence: 0.65
  }
  const title = automaticDashboardComponentTitle(blueprint, { type, semanticBinding: binding })
  return { blueprint, binding, title }
}

export const createManualDashboardComponent = (
  dashboard: DashboardSpec,
  type: DashboardComponentType,
  profiles: FieldProfile[]
): FactoryResult => {
  if (dashboard.components.length >= 10) return { error: '大屏最多保留 10 个组件，请先删除或复制整理现有组件。' }
  const definition = componentDefinitionByType.get(type)
  if (!definition?.supportsManualAdd || !definition.requiresQuery) {
    return { error: '该组件暂不支持手工添加。' }
  }
  const queryResult = buildQuery(dashboard, type, profiles)
  if ('error' in queryResult) return queryResult
  const { query, encoding, dimensionProfile } = queryResult
  const legacyUpgrade = dashboard.analysisBlueprint
    ? undefined
    : deriveLegacySemanticBlueprint(dashboard, profiles)
  if (legacyUpgrade && 'error' in legacyUpgrade) return legacyUpgrade
  const semanticDashboard: DashboardSpec = legacyUpgrade
    ? {
        ...dashboard,
        components: legacyUpgrade.components,
        analysisBlueprint: legacyUpgrade.blueprint
      }
    : dashboard
  const layout = findFirstAvailableDashboardLayout(semanticDashboard.components, type)
  if (!layout) return { error: '画布没有满足该组件最小尺寸的空位，请先调整或删除一个组件。' }
  const id = createDashboardComponentId(`manual-${slug(type)}`, new Set(semanticDashboard.components.map((item) => item.id)))
  const slotRole = definition.compatibleSlotRoles[0]
  const metricLabel = query.measures[0].id === 'record_count'
    ? '记录数'
    : fieldLabel(profiles.find((profile) => profile.field === query.measures[0].field), query.measures[0].id)
  const dimensionLabel = dimensionProfile ? fieldLabel(dimensionProfile) : ''
  const fallbackTitle = [dimensionLabel, metricLabel].filter(Boolean).join(' · ') || definition.name
  const component: DashboardComponentSpec = {
    id,
    type,
    title: fallbackTitle,
    subtitle: `${definition.name} · 已绑定当前数据范围`,
    layout,
    data: [],
    query,
    encoding,
    slotRole,
    semanticBinding: undefined
  }

  const semantic = ensureBlueprintBinding(
    semanticDashboard,
    id,
    type,
    slotRole,
    query,
    dimensionProfile,
    profiles
  )
  component.semanticBinding = semantic.binding
  component.title = semantic.title || fallbackTitle
  return {
    component,
    analysisBlueprint: semantic.blueprint,
    ...(legacyUpgrade ? {
      components: [...semanticDashboard.components, component]
    } : {})
  }
}
