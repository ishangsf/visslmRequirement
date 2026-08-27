import type {
  DashboardComponentDataShape,
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardLayout
} from '../../../shared/dashboard'
import type { FieldProfile, QueryDimension, QueryMeasure, QuerySpec } from '../../../shared/query-spec'
import {
  dashboardGridColumns,
  dashboardGridRows,
  dashboardLayoutProfiles,
  validateDashboardLayout
} from '../../../shared/dashboard-layout'

export type { DashboardComponentDataShape } from '../../../shared/dashboard'

const categoryTypes = new Set<DashboardComponentType>([
  'bar',
  'pie',
  'ranking',
  'funnel',
  'radar',
  'treemap'
])

export const dashboardComponentDataShape = (
  type: DashboardComponentType
): DashboardComponentDataShape => {
  if (['kpi', 'progress', 'gauge'].includes(type)) return 'single-value'
  if (categoryTypes.has(type)) return 'category-value'
  if (type === 'line') return 'time-series'
  if (type === 'scatter' || type === 'combo') return 'dual-measure'
  if (type === 'table') return 'detail'
  return 'text'
}

const cloneQuery = (query: QuerySpec): QuerySpec =>
  JSON.parse(JSON.stringify(query)) as QuerySpec

const isCategoryProfile = (profile: FieldProfile): boolean =>
  profile.sensitivity !== 'sensitive' && (
    profile.role === 'dimension' ||
    profile.inferredType === 'string' ||
    profile.inferredType === 'enum' ||
    profile.inferredType === 'boolean'
  )

const profileMap = (profiles: FieldProfile[]): Map<string, FieldProfile> =>
  new Map(profiles.map((profile) => [profile.field, profile]))

const findCategoryDimension = (
  query: QuerySpec,
  profiles: FieldProfile[],
  strictCategory = false
): QueryDimension | undefined => {
  const byField = profileMap(profiles)
  const dimensions = query.dimensions ?? []
  const existingCategory = dimensions.find((dimension) => {
    const profile = byField.get(dimension.field)
    return Boolean(profile && isCategoryProfile(profile))
  })
  if (existingCategory) return { ...existingCategory }
  if (!strictCategory && dimensions[0]) return { ...dimensions[0] }
  const profile = profiles.find(isCategoryProfile)
  return profile ? { field: profile.field } : undefined
}

const findTimeDimension = (
  query: QuerySpec,
  profiles: FieldProfile[]
): QueryDimension | undefined => {
  const byField = profileMap(profiles)
  const dimensions = query.dimensions ?? []
  const existingDate = dimensions.find((dimension) =>
    byField.get(dimension.field)?.inferredType === 'date' || dimension.timeGrain
  )
  if (existingDate) {
    return { ...existingDate, timeGrain: existingDate.timeGrain ?? 'month' }
  }
  const profile = profiles.find((item) => item.role === 'time' || item.inferredType === 'date')
  if (profile) return { field: profile.field, timeGrain: 'month' }
  return dimensions[0] ? { ...dimensions[0] } : undefined
}

const uniqueMeasureId = (measures: QueryMeasure[]): string => {
  const ids = new Set(measures.map((measure) => measure.id))
  let index = measures.length + 1
  while (ids.has(`metric${index}`)) index += 1
  return `metric${index}`
}

const validSort = (query: QuerySpec): QuerySpec['sort'] => {
  const fields = new Set([
    ...(query.dimensions ?? []).map((dimension) => dimension.field),
    ...query.measures.map((measure) => measure.id)
  ])
  const sort = query.sort?.filter((item) => fields.has(item.field))
  return sort?.length ? sort : undefined
}

type QueryAdaptation = {
  query: QuerySpec
  encoding: NonNullable<DashboardComponentSpec['encoding']>
}

const adaptQuery = (
  component: DashboardComponentSpec,
  targetType: DashboardComponentType,
  profiles: FieldProfile[]
): QueryAdaptation | { error: string } => {
  const query = cloneQuery(component.query!)
  const primary = query.measures.find((measure) => measure.id === component.encoding?.value)
    ?? query.measures[0]
  if (!primary) return { error: '当前组件没有可用指标，无法切换图表类型。' }

  const shape = dashboardComponentDataShape(targetType)
  if (shape === 'text') {
    const label = component.encoding?.label
    const dimensionFields = new Set((query.dimensions ?? []).map((dimension) => dimension.field))
    return {
      query,
      encoding: {
        ...(label && dimensionFields.has(label) ? { label } : {}),
        value: primary.id,
        ...(component.encoding?.secondaryValue ? { secondaryValue: component.encoding.secondaryValue } : {})
      }
    }
  }

  if (shape === 'single-value') {
    const nextQuery: QuerySpec = {
      ...query,
      dimensions: undefined,
      limit: 1
    }
    nextQuery.sort = validSort(nextQuery)
    return { query: nextQuery, encoding: { value: primary.id } }
  }

  if (targetType === 'combo') {
    const dimension = findTimeDimension(query, profiles)
    if (!dimension) {
      return { error: '组合图需要一个时间或分类维度，但当前数据范围没有可用维度。' }
    }
    query.dimensions = [dimension]
    let secondary = query.measures.find((measure) =>
      measure.id === component.encoding?.secondaryValue && measure.id !== primary.id
    ) ?? query.measures.find((measure) => measure.id !== primary.id)
    if (!secondary) {
      const numericProfile = profiles.find((profile) =>
        profile.sensitivity !== 'sensitive' &&
        profile.inferredType === 'number' &&
        profile.field !== primary.field
      )
      if (!numericProfile) {
        return { error: '组合图需要两个不同指标，当前数据范围没有可用的第二个数值字段。' }
      }
      secondary = {
        id: uniqueMeasureId(query.measures),
        field: numericProfile.field,
        aggregation: 'sum'
      }
      query.measures = [...query.measures, secondary]
    }
    query.limit = Math.min(query.limit ?? 60, 60)
    query.sort = validSort(query)
    return {
      query,
      encoding: {
        label: dimension.field,
        value: primary.id,
        secondaryValue: secondary.id
      }
    }
  }

  if (shape === 'category-value' || shape === 'dual-measure') {
    const dimension = findCategoryDimension(query, profiles, targetType === 'treemap')
    if (!dimension) {
      return { error: '目标图表需要分类维度，但当前数据范围没有可用维度。请先在高级查询中添加维度。' }
    }
    query.dimensions = [dimension]
  }

  if (shape === 'time-series') {
    const dimension = findTimeDimension(query, profiles)
    if (!dimension) {
      return { error: '折线图需要时间或分类维度，但当前数据范围没有可用维度。' }
    }
    query.dimensions = [dimension]
  }

  if (shape === 'dual-measure') {
    let secondary = query.measures.find((measure) =>
      measure.id === component.encoding?.secondaryValue && measure.id !== primary.id
    ) ?? query.measures.find((measure) => measure.id !== primary.id)
    if (!secondary) {
      const numericProfile = profiles.find((profile) =>
        profile.sensitivity !== 'sensitive' &&
        profile.inferredType === 'number' &&
        profile.field !== primary.field
      )
      if (!numericProfile) {
        return { error: '散点图需要两个不同指标，但当前数据范围只有一个可用指标。' }
      }
      secondary = {
        id: uniqueMeasureId(query.measures),
        field: numericProfile.field,
        aggregation: 'sum'
      }
      query.measures = [...query.measures, secondary]
    }
    query.limit = Math.min(query.limit ?? 100, 100)
    query.sort = validSort(query)
    return {
      query,
      encoding: {
        label: query.dimensions![0].field,
        value: primary.id,
        secondaryValue: secondary.id
      }
    }
  }

  if (shape === 'detail') {
    query.limit = Math.min(query.limit ?? 100, 100)
    query.sort = validSort(query)
    const secondary = query.measures.find((measure) =>
      measure.id === component.encoding?.secondaryValue && measure.id !== primary.id
    ) ?? query.measures.find((measure) => measure.id !== primary.id)
    return {
      query,
      encoding: {
        ...((query.dimensions?.[0]) ? { label: query.dimensions[0].field } : {}),
        value: primary.id,
        ...(secondary ? { secondaryValue: secondary.id } : {})
      }
    }
  }

  const limits: Partial<Record<DashboardComponentType, number>> = {
    bar: 20,
    pie: 12,
    ranking: 20,
    funnel: 12,
    radar: 10,
    line: 60,
    treemap: 20,
    combo: 60
  }
  query.limit = limits[targetType] ?? query.limit
  query.sort = validSort(query)
  const supportsComparison = targetType === 'bar' || targetType === 'line'
  const secondary = supportsComparison
    ? query.measures.find((measure) =>
        measure.id === component.encoding?.secondaryValue && measure.id !== primary.id
      ) ?? query.measures.find((measure) => measure.id !== primary.id)
    : undefined
  return {
    query,
    encoding: {
      label: query.dimensions![0].field,
      value: primary.id,
      ...(secondary ? { secondaryValue: secondary.id } : {})
    }
  }
}

const fitLayout = (
  layout: DashboardLayout,
  targetType: DashboardComponentType
): DashboardLayout => {
  const profile = dashboardLayoutProfiles[targetType]
  const w = Math.max(layout.w, profile.minimumWidth)
  const h = Math.max(layout.h, profile.minimumHeight)
  return {
    x: Math.min(layout.x, dashboardGridColumns - w),
    y: Math.min(layout.y, dashboardGridRows - h),
    w,
    h
  }
}

export type DashboardComponentTypeChangePlan =
  | { component: DashboardComponentSpec; refreshData: boolean }
  | { error: string }

export const planDashboardComponentTypeChange = (
  components: DashboardComponentSpec[],
  componentId: string,
  targetType: DashboardComponentType,
  profiles: FieldProfile[]
): DashboardComponentTypeChangePlan => {
  const component = components.find((item) => item.id === componentId)
  if (!component) return { error: `组件 ${componentId} 不存在。` }
  if (component.type === targetType) return { component, refreshData: false }

  const layout = fitLayout(component.layout, targetType)
  const queryAdaptation = component.query
    ? adaptQuery(component, targetType, profiles)
    : undefined
  if (queryAdaptation && 'error' in queryAdaptation) return queryAdaptation

  const nextComponent: DashboardComponentSpec = {
    ...component,
    type: targetType,
    layout,
    ...(queryAdaptation ? {
      query: queryAdaptation.query,
      encoding: queryAdaptation.encoding
    } : {})
  }
  const nextComponents = components.map((item) => item.id === componentId ? nextComponent : item)
  const layoutErrors = validateDashboardLayout(nextComponents, componentId, layout)
  if (layoutErrors.length) {
    return {
      error: `目标图表至少需要 ${layout.w}×${layout.h} 的空间，当前区域无法自动扩展：${layoutErrors[0]}`
    }
  }
  return { component: nextComponent, refreshData: Boolean(queryAdaptation) }
}
