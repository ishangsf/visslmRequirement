import type {
  DashboardComponentRepairResult,
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardDataPoint,
  DashboardLayout,
  DashboardSpec
} from '../../shared/dashboard'
import {
  dashboardGridColumns,
  dashboardGridRows,
  dashboardLayoutProfiles,
  validateDashboardLayout
} from '../../shared/dashboard-layout'
import type {
  FieldProfile,
  QueryAggregation,
  QueryDataset,
  QueryDimension,
  QueryMeasure,
  QuerySpec
} from '../../shared/query-spec'
import type { QueryEngine } from '../analytics/query-engine'
import { diagnoseDashboard } from './diagnostics'
import { validateDashboardSpec } from './validator'

const cloneSpec = (spec: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(spec)) as DashboardSpec

const supportedAggregations = new Set<QueryAggregation>([
  'count',
  'countDistinct',
  'sum',
  'avg',
  'min',
  'max'
])

const singleValueTypes = new Set<DashboardComponentType>(['kpi', 'progress', 'gauge'])
const categoryTypes = new Set<DashboardComponentType>([
  'bar',
  'pie',
  'ranking',
  'funnel',
  'radar',
  'scatter',
  'treemap'
])

const profileCatalog = (profiles: FieldProfile[]): Map<string, FieldProfile> =>
  new Map(profiles.map((profile) => [profile.field.toLocaleLowerCase(), profile]))

const findTimeProfile = (profiles: FieldProfile[]): FieldProfile | undefined =>
  profiles.find((profile) => profile.role === 'time' && profile.inferredType === 'date')
  ?? profiles.find((profile) => profile.inferredType === 'date')

const findCategoryProfile = (profiles: FieldProfile[]): FieldProfile | undefined =>
  profiles.find((profile) => profile.role === 'dimension')
  ?? profiles.find((profile) =>
    ['string', 'enum', 'boolean'].includes(profile.inferredType) && profile.role !== 'identifier'
  )

const numericProfiles = (profiles: FieldProfile[]): FieldProfile[] =>
  profiles.filter((profile) =>
    profile.inferredType === 'number' &&
    profile.role !== 'identifier' &&
    profile.sensitivity !== 'sensitive'
  )

const uniqueId = (preferred: string, used: Set<string>): string => {
  // QuerySpec accepts any non-empty measure id. Preserve stable domain ids
  // (which commonly contain dots and hyphens) because analysisBlueprint and
  // semanticBinding refer to the exact id. Repair only emptiness/duplicates.
  const base = preferred.trim() || 'metric'
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}_${suffix++}`
  used.add(candidate)
  return candidate
}

const repairMeasures = (
  query: QuerySpec,
  profiles: FieldProfile[],
  actions: string[]
): { measures: QueryMeasure[]; idMap: Map<string, string> } => {
  const catalog = profileCatalog(profiles)
  const numeric = numericProfiles(profiles)
  const used = new Set<string>()
  const idMap = new Map<string, string>()
  const input = query.measures?.length
    ? query.measures
    : (() => { throw new Error('缺少指标定义，不能自动补成记录数') })()
  const assigned = input.slice(0, 8).map((measure, index) => {
    const originalId = measure.id?.trim() || `metric${index + 1}`
    const id = uniqueId(originalId, used)
    if (!idMap.has(originalId)) idMap.set(originalId, id)
    if (id !== originalId) actions.push(`将重复或空指标标识调整为 ${id}`)
    return { measure, id }
  })

  const measures = assigned.map(({ measure, id }): QueryMeasure => {

    const currentProfile = measure.field
      ? catalog.get(measure.field.toLocaleLowerCase())
      : undefined
    if (!supportedAggregations.has(measure.aggregation)) throw new Error('不支持的聚合，不能更改指标口径')
    const aggregation = measure.aggregation
    const field = currentProfile?.field
    if (measure.field && !currentProfile) throw new Error('指标字段不存在，不能替换为其他业务字段：' + measure.field)
    if (currentProfile?.sensitivity === 'sensitive') throw new Error('指标字段不可用于自动修正')
    if (!measure.formula && ['sum', 'avg', 'min', 'max'].includes(aggregation) && currentProfile?.inferredType !== 'number') throw new Error('指标需要原定义中的数值字段，不能回退为其他指标')
    if (aggregation === 'countDistinct' && !currentProfile) throw new Error('去重统计缺少原字段，不能猜测替换')
    const repaired: QueryMeasure = {
      id,
      aggregation,
      ...(field ? { field } : {})
    }
    if (measure.formula?.trim()) {
      const references = measure.formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
      if (references.every((reference) => idMap.has(reference))) {
        repaired.formula = measure.formula.replace(
          /[A-Za-z_][A-Za-z0-9_]*/g,
          (reference) => idMap.get(reference) ?? reference
        )
      } else {
        actions.push(`移除指标 ${id} 中引用失效指标的公式`)
      }
    } else {
      if (measure.calculation) repaired.calculation = measure.calculation
      if (measure.comparison) repaired.comparison = measure.comparison
    }
    return repaired
  })
  return { measures, idMap }
}

const repairDimensions = (
  component: DashboardComponentSpec,
  query: QuerySpec,
  profiles: FieldProfile[],
  actions: string[],
  allowDimensionInference = false
): QueryDimension[] | undefined => {
  if (singleValueTypes.has(component.type)) {
    if (!allowDimensionInference && query.dimensions?.length) throw new Error('不能在修正时删除业务分组维度')
    if (query.dimensions?.length) actions.push('移除单值组件不支持的分组维度')
    return undefined
  }
  const catalog = profileCatalog(profiles)
  for (const dimension of query.dimensions ?? []) if (!catalog.has(dimension.field.toLocaleLowerCase())) throw new Error('分组字段不存在，不能删除或替换：' + dimension.field)
  if (!allowDimensionInference) {
    const dimensions = query.dimensions ?? []
    if (singleValueTypes.has(component.type) && dimensions.length) throw new Error('单值组件不能在修正时静默删除业务维度')
    if ((categoryTypes.has(component.type) || component.type === 'line' || component.type === 'combo') && !dimensions.length) throw new Error('组件缺少业务维度，不能自动猜测')
    return dimensions.length ? structuredClone(dimensions) : undefined
  }
  const valid = (query.dimensions ?? []).flatMap((dimension) => {
    const profile = catalog.get(dimension.field.toLocaleLowerCase())
    if (!profile) return []
    return [{
      field: profile.field,
      ...(dimension.timeGrain && profile.inferredType === 'date'
        ? { timeGrain: dimension.timeGrain }
        : {})
    } as QueryDimension]
  })

  if (component.type === 'line') {
    const existing = valid.find((dimension) =>
      catalog.get(dimension.field.toLocaleLowerCase())?.inferredType === 'date'
    )
    const time = existing
      ? { ...existing, timeGrain: existing.timeGrain ?? 'month' as const }
      : findTimeProfile(profiles)
        ? { field: findTimeProfile(profiles)!.field, timeGrain: 'month' as const }
        : undefined
    if (!time) throw new Error('折线图需要日期字段，但当前数据范围没有可用日期维度')
    if (!existing || !existing.timeGrain) actions.push(`折线图时间维度调整为 ${time.field}（按月）`)
    return [time]
  }

  if (component.type === 'combo') {
    const existingTime = valid.find((dimension) =>
      catalog.get(dimension.field.toLocaleLowerCase())?.inferredType === 'date'
    )
    if (existingTime) {
      const time = { ...existingTime, timeGrain: existingTime.timeGrain ?? 'month' as const }
      if (!existingTime.timeGrain) actions.push(`组合图时间维度调整为 ${time.field}（按月）`)
      return [time]
    }
    const existingCategory = valid.find((dimension) => {
      const profile = catalog.get(dimension.field.toLocaleLowerCase())
      return profile?.role === 'dimension' ||
        Boolean(profile && ['string', 'enum', 'boolean'].includes(profile.inferredType))
    })
    if (existingCategory) return [{ field: existingCategory.field }]
    const time = findTimeProfile(profiles)
    if (time) {
      actions.push(`为组合图补充时间维度 ${time.field}（按月）`)
      return [{ field: time.field, timeGrain: 'month' }]
    }
    const category = findCategoryProfile(profiles)
    if (!category) throw new Error('组合图需要日期或分类字段，但当前数据范围没有可用维度')
    actions.push(`为组合图补充分组维度 ${category.field}`)
    return [{ field: category.field }]
  }

  if (categoryTypes.has(component.type)) {
    const existing = valid.find((dimension) => {
      const profile = catalog.get(dimension.field.toLocaleLowerCase())
      return profile?.role === 'dimension' ||
        Boolean(profile && ['string', 'enum', 'boolean'].includes(profile.inferredType))
    })
    const category = existing ?? findCategoryProfile(profiles)
    if (!category) throw new Error(`${component.title} 需要分类字段，但当前数据范围没有可用维度`)
    const dimension = 'field' in category ? { field: category.field } : category
    if (!existing) actions.push(`补充分组维度 ${dimension.field}`)
    return [dimension]
  }

  if (component.type === 'table') return valid.slice(0, 2)
  return valid.slice(0, 2).length ? valid.slice(0, 2) : undefined
}

const validSort = (query: QuerySpec): QuerySpec['sort'] => {
  const resultFields = new Set([
    ...(query.dimensions ?? []).map((dimension) => dimension.field),
    ...query.measures.map((measure) => measure.id)
  ])
  const sort = query.sort?.filter((item) => resultFields.has(item.field))
  return sort?.length ? sort : undefined
}

const repairQuery = (
  spec: DashboardSpec,
  component: DashboardComponentSpec,
  queryEngine: QueryEngine,
  actions: string[],
  allowDimensionInference = false
): { query: QuerySpec; encoding: NonNullable<DashboardComponentSpec['encoding']> } => {
  const fallbackScope = spec.components.find((item) => item.query)?.query?.scope ?? {}
  const sourceQuery: QuerySpec = component.query
    ? cloneSpec({ ...spec, components: [component] }).components[0].query!
    : (() => { throw new Error('组件缺少查询，必须先选择业务指标') })()
  if (!component.query) actions.push('依据当前大屏数据范围补建受控查询')

  const profiles = queryEngine.profile(sourceQuery.scope)
  const catalog = profileCatalog(profiles)
  const { measures, idMap } = repairMeasures(sourceQuery, profiles, actions)
  const dimensions = repairDimensions(component, sourceQuery, profiles, actions, allowDimensionInference)
  const hasTimeDimension = Boolean(dimensions?.some((dimension) => dimension.timeGrain))
  const safeMeasures = measures.map((measure) => {
    if (hasTimeDimension || (!measure.calculation && !measure.comparison)) return measure
    if (measure.calculation === 'share' && !measure.comparison) return measure
    throw new Error('派生指标缺少时间维度，不能删除计算或对比口径')
  })
  let resultMeasures = safeMeasures
  if (component.type === 'scatter' || component.type === 'combo') {
    if (safeMeasures.length !== 2) throw new Error('双指标组件必须明确提供两个指标，不能自动选择其他业务字段')
    if (component.type === 'scatter' && (safeMeasures.some(item => !item.field) || new Set(safeMeasures.map(item => item.field)).size !== 2)) throw new Error('散点图必须明确提供两个不同的安全数值字段')
  }
  for (const filter of [...(sourceQuery.filters ?? []), ...(sourceQuery.scope.baseFilters ?? [])]) {
    if (!catalog.has(filter.field.toLocaleLowerCase())) throw new Error('筛选字段不存在，不能删除用户约束：' + filter.field)
  }
  const filters = sourceQuery.filters?.filter((filter) =>
    catalog.has(filter.field.toLocaleLowerCase())
  )
  if ((filters?.length ?? 0) !== (sourceQuery.filters?.length ?? 0)) {
    actions.push('移除引用失效字段的组件筛选条件')
  }
  const baseFilters = sourceQuery.scope.baseFilters?.filter((filter) =>
    catalog.has(filter.field.toLocaleLowerCase())
  )
  if ((baseFilters?.length ?? 0) !== (sourceQuery.scope.baseFilters?.length ?? 0)) {
    actions.push('移除引用失效字段的数据范围筛选条件')
  }

  const query: QuerySpec = {
    source: 'records',
    scope: {
      ...sourceQuery.scope,
      ...(baseFilters?.length ? { baseFilters } : { baseFilters: undefined })
    },
    ...(dimensions?.length ? { dimensions } : {}),
    measures: resultMeasures,
    ...(filters?.length ? { filters } : {}),
    limit: singleValueTypes.has(component.type) ? 1 : Math.min(sourceQuery.limit ?? 100, 500)
  }
  query.sort = validSort({ ...query, sort: sourceQuery.sort })

  const preferredPrimary = component.encoding?.value
    ? idMap.get(component.encoding.value)
    : undefined
  const primary = resultMeasures.find((measure) => measure.id === preferredPrimary) ?? resultMeasures[0]
  if (!primary) throw new Error('当前数据范围无法构建可用指标')

  const preferredSecondary = component.encoding?.secondaryValue
  let secondary = preferredSecondary
    ? resultMeasures.find((measure) => measure.id === idMap.get(preferredSecondary))
    : undefined
  secondary = secondary && secondary.id !== primary.id
    ? secondary
    : resultMeasures.find((measure) => measure.id !== primary.id)

  const label = query.dimensions?.[0]?.field
  const encoding = {
    ...(label ? { label } : {}),
    value: primary.id,
    ...((component.type === 'scatter' || component.type === 'combo' || component.type === 'bar' || component.type === 'line') && secondary
      ? { secondaryValue: secondary.id }
      : {})
  }
  if (JSON.stringify(encoding) !== JSON.stringify(component.encoding)) {
    actions.push('同步修复图表数据映射')
  }
  return { query, encoding }
}

const toDataPoints = (
  component: DashboardComponentSpec,
  dataset: QueryDataset
): DashboardDataPoint[] => {
  const labelField = component.encoding?.label
  const valueField = component.encoding?.value
  const secondaryField = component.encoding?.secondaryValue
  const valueScale = component.encoding?.valueScale ?? 1
  const secondaryValueScale = component.encoding?.secondaryValueScale ?? 1
  if (!valueField) return []
  return dataset.rows.map((row, index) => ({
    name: String(labelField ? row[labelField] ?? `数据 ${index + 1}` : component.title),
    value: Number(row[valueField] ?? 0) * valueScale,
    ...(secondaryField ? { secondaryValue: Number(row[secondaryField] ?? 0) * secondaryValueScale } : {})
  }))
}

const fitTargetLayout = (
  components: DashboardComponentSpec[],
  componentId: string
): DashboardLayout => {
  const component = components.find((item) => item.id === componentId)
  if (!component) throw new Error(`组件 ${componentId} 不存在`)
  if (!validateDashboardLayout(components, componentId, component.layout).length) {
    return component.layout
  }
  const profile = dashboardLayoutProfiles[component.type]
  const widths = [...new Set([Math.max(component.layout.w, profile.minimumWidth), profile.minimumWidth])]
  const heights = [...new Set([Math.max(component.layout.h, profile.minimumHeight), profile.minimumHeight])]
  for (const h of heights) {
    for (const w of widths) {
      if (w > dashboardGridColumns || h > dashboardGridRows) continue
      for (let y = 0; y <= dashboardGridRows - h; y += 1) {
        for (let x = 0; x <= dashboardGridColumns - w; x += 1) {
          const candidate = { x, y, w, h }
          if (!validateDashboardLayout(components, componentId, candidate).length) return candidate
        }
      }
    }
  }
  throw new Error(`组件 ${component.title} 没有可用的无冲突布局位置`)
}

export const adaptDashboardComponentQuery = (
  input: DashboardSpec,
  componentId: string,
  queryEngine: QueryEngine,
  options: { allowDimensionInference?: boolean } = {}
): { component: DashboardComponentSpec; actions: string[] } => {
  const component = input.components.find((item) => item.id === componentId)
  if (!component) throw new Error(`组件 ${componentId} 不存在`)
  const actions: string[] = []
  const repairedQuery = repairQuery(input, component, queryEngine, actions, options.allowDimensionInference)
  return {
    component: {
      ...component,
      query: repairedQuery.query,
      encoding: repairedQuery.encoding
    },
    actions
  }
}

export const repairDashboardComponent = (
  input: DashboardSpec,
  componentId: string,
  queryEngine: QueryEngine
): DashboardComponentRepairResult => {
  const spec = cloneSpec(input)
  const index = spec.components.findIndex((component) => component.id === componentId)
  if (index < 0) throw new Error(`组件 ${componentId} 不存在`)
  const baselineErrors = validateDashboardSpec(input, queryEngine)
  const current = spec.components[index]
  const adaptation = adaptDashboardComponentQuery(spec, componentId, queryEngine)
  const actions = adaptation.actions
  const nextComponent = adaptation.component
  nextComponent.data = toDataPoints(nextComponent, queryEngine.execute(nextComponent.query!))
  spec.components[index] = nextComponent

  const layout = fitTargetLayout(spec.components, componentId)
  if (JSON.stringify(layout) !== JSON.stringify(current.layout)) {
    spec.components[index] = { ...spec.components[index], layout }
    actions.push(`调整组件布局至 ${layout.x},${layout.y} ${layout.w}×${layout.h}`)
  }
  spec.updatedAt = new Date().toISOString()

  const repairedErrors = validateDashboardSpec(spec, queryEngine)
  const baselineErrorSet = new Set(baselineErrors)
  const targetErrors = repairedErrors.filter((error) =>
    error.includes(`组件 ${componentId}`)
  )
  const introducedErrors = repairedErrors.filter((error) => !baselineErrorSet.has(error))
  const blockingErrors = [...new Set([...targetErrors, ...introducedErrors])]
  if (blockingErrors.length) {
    throw new Error(`修复后校验失败：${blockingErrors.join('；')}`)
  }
  if (!actions.length) actions.push('重新执行查询并校验组件数据')
  return {
    spec,
    componentId,
    actions,
    report: diagnoseDashboard(spec, queryEngine)
  }
}
