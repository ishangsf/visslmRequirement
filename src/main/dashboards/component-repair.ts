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
  const base = preferred.trim().replace(/[^A-Za-z0-9_]/g, '_') || 'metric'
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
    : [{ id: 'records', aggregation: 'count' as const }]
  const assigned = input.slice(0, 8).map((measure, index) => {
    const originalId = measure.id?.trim() || `metric${index + 1}`
    const id = uniqueId(originalId, used)
    if (!idMap.has(originalId)) idMap.set(originalId, id)
    if (id !== originalId) actions.push(`将重复或无效指标标识调整为 ${id}`)
    return { measure, id }
  })

  const measures = assigned.map(({ measure, id }): QueryMeasure => {

    const currentProfile = measure.field
      ? catalog.get(measure.field.toLocaleLowerCase())
      : undefined
    let aggregation = supportedAggregations.has(measure.aggregation)
      ? measure.aggregation
      : 'count'
    let field = currentProfile?.field

    if (['sum', 'avg', 'min', 'max'].includes(aggregation)) {
      const selected = currentProfile?.inferredType === 'number'
        ? currentProfile
        : numeric[0]
      if (selected) {
        field = selected.field
        if (field !== measure.field) actions.push(`指标 ${id} 改用数值字段 ${field}`)
      } else {
        aggregation = 'count'
        field = undefined
        actions.push(`指标 ${id} 无可用数值字段，已回退为记录数`)
      }
    } else if (aggregation === 'countDistinct' && !currentProfile) {
      const selected = profiles.find((profile) => profile.role !== 'identifier') ?? profiles[0]
      if (selected) {
        field = selected.field
        actions.push(`指标 ${id} 的去重字段改为 ${field}`)
      } else {
        aggregation = 'count'
        field = undefined
        actions.push(`指标 ${id} 无可用去重字段，已回退为记录数`)
      }
    } else if (aggregation === 'count') {
      field = currentProfile?.field
    }

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
  actions: string[]
): QueryDimension[] | undefined => {
  if (singleValueTypes.has(component.type)) {
    if (query.dimensions?.length) actions.push('移除单值组件不支持的分组维度')
    return undefined
  }
  const catalog = profileCatalog(profiles)
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
  actions: string[]
): { query: QuerySpec; encoding: NonNullable<DashboardComponentSpec['encoding']> } => {
  const fallbackScope = spec.components.find((item) => item.query)?.query?.scope ?? {}
  const sourceQuery: QuerySpec = component.query
    ? cloneSpec({ ...spec, components: [component] }).components[0].query!
    : { source: 'records', scope: fallbackScope, measures: [{ id: 'records', aggregation: 'count' }] }
  if (!component.query) actions.push('依据当前大屏数据范围补建受控查询')

  const profiles = queryEngine.profile(sourceQuery.scope)
  const catalog = profileCatalog(profiles)
  const { measures, idMap } = repairMeasures(sourceQuery, profiles, actions)
  const dimensions = repairDimensions(component, sourceQuery, profiles, actions)
  const hasTimeDimension = Boolean(dimensions?.some((dimension) => dimension.timeGrain))
  const safeMeasures = measures.map((measure) => {
    if (hasTimeDimension || (!measure.calculation && !measure.comparison)) return measure
    actions.push(`移除指标 ${measure.id} 中缺少时间维度的派生计算`)
    const { calculation: _calculation, comparison: _comparison, ...safe } = measure
    return safe
  })
  let resultMeasures = safeMeasures
  if (component.type === 'scatter') {
    const numeric = numericProfiles(profiles)
    const numericFields = new Set(numeric.map((profile) => profile.field))
    const selected: QueryMeasure[] = []
    const usedFields = new Set<string>()
    for (const measure of safeMeasures) {
      if (!measure.field || !numericFields.has(measure.field) || usedFields.has(measure.field)) continue
      selected.push(measure)
      usedFields.add(measure.field)
      if (selected.length === 2) break
    }
    for (const profile of numeric) {
      if (selected.length === 2) break
      if (usedFields.has(profile.field)) continue
      selected.push({
        id: uniqueId(profile.field, new Set(selected.map((measure) => measure.id))),
        field: profile.field,
        aggregation: 'sum'
      })
      usedFields.add(profile.field)
      actions.push(`为散点图补充数值指标 ${profile.field}`)
    }
    if (selected.length !== 2) {
      throw new Error('散点图需要两个不同的安全数值字段，但当前数据范围不足')
    }
    resultMeasures = selected
  } else if (component.type === 'combo') {
    const signatures = new Set<string>()
    const selected = safeMeasures.filter((measure) => {
      const signature = `${measure.field ?? ''}:${measure.aggregation}`
      if (signatures.has(signature)) return false
      signatures.add(signature)
      return true
    }).slice(0, 2)
    const usedFields = new Set(selected.flatMap((measure) => measure.field ? [measure.field] : []))
    const usedIds = new Set(selected.map((measure) => measure.id))
    for (const profile of numericProfiles(profiles)) {
      if (selected.length === 2) break
      if (usedFields.has(profile.field)) continue
      selected.push({
        id: uniqueId(profile.field, usedIds),
        field: profile.field,
        aggregation: 'sum'
      })
      usedFields.add(profile.field)
      actions.push(`为组合图补充第二指标 ${profile.field}`)
    }
    if (selected.length !== 2) {
      throw new Error('组合图需要两个不同的指标，但当前数据范围不足')
    }
    resultMeasures = selected
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
    limit: component.type === 'pie'
      ? Math.min(sourceQuery.limit ?? 6, 6)
      : singleValueTypes.has(component.type)
        ? 1
        : Math.min(sourceQuery.limit ?? 100, 100)
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
  if (!valueField) return []
  return dataset.rows.map((row, index) => ({
    name: String(labelField ? row[labelField] ?? `数据 ${index + 1}` : component.title),
    value: Number(row[valueField] ?? 0),
    ...(secondaryField ? { secondaryValue: Number(row[secondaryField] ?? 0) } : {})
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
  queryEngine: QueryEngine
): { component: DashboardComponentSpec; actions: string[] } => {
  const component = input.components.find((item) => item.id === componentId)
  if (!component) throw new Error(`组件 ${componentId} 不存在`)
  const actions: string[] = []
  const repairedQuery = repairQuery(input, component, queryEngine, actions)
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
