import type { DashboardComponentSpec, DashboardSpec } from './dashboard'
import type { DataScope, FilterSpec, QueryMeasure, QuerySpec } from './query-spec'

const sensitiveFieldPattern =
  /(^|[._-])(token|password|secret|phone|mobile|email|idcard|name|姓名|身份证|手机号|邮箱)([._-]|$)/i

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))]

export const listQueryFields = (query?: QuerySpec): string[] => query
  ? unique([
      ...(query.dimensions ?? []).map((dimension) => dimension.field),
      ...query.measures.flatMap((measure) => measure.field ? [measure.field] : []),
      ...(query.scope.baseFilters ?? []).map((filter) => filter.field),
      ...(query.filters ?? []).map((filter) => filter.field)
    ])
  : []

export const listSensitiveFields = (spec: DashboardSpec): string[] => unique(
  spec.components.flatMap((component) => listQueryFields(component.query))
    .concat((spec.globalFilters ?? []).map((filter) => filter.field))
    .filter((field) => sensitiveFieldPattern.test(field))
)

export const describeDataScope = (scope?: DataScope): string[] => {
  if (!scope) return ['未声明数据范围']
  const descriptions = [
    scope.recordUids?.length ? `${scope.recordUids.length} 条指定记录` : '',
    scope.projectIds?.length ? `${scope.projectIds.length} 个项目` : '',
    scope.nodeTypes?.length ? `类型：${scope.nodeTypes.join('、')}` : '',
    scope.baseFilters?.length ? `${scope.baseFilters.length} 个基础筛选` : '',
    scope.snapshotAt ? `快照：${new Date(scope.snapshotAt).toLocaleString('zh-CN')}` : ''
  ].filter(Boolean)
  return descriptions.length ? descriptions : ['全部本地记录']
}

export const describeFilter = (filter: FilterSpec): string => {
  const value = Array.isArray(filter.value) ? filter.value.join('、') : filter.value
  return `${filter.field} ${filter.operator}${value === undefined ? '' : ` ${String(value)}`}`
}

export const describeMeasure = (measure: QueryMeasure): string =>
  `${measure.id} = ${measure.formula?.trim()
    ? `公式(${measure.formula.trim()})`
    : `${measure.aggregation}${measure.field ? `(${measure.field})` : '(记录)'}`}` +
  (measure.calculation ? ` [${measure.calculation}]` : '') +
  (measure.comparison
    ? ` [前${measure.comparison.offset}周期${measure.comparison.mode === 'difference' ? '差值' : '百分比'}]`
    : '')

export interface DashboardExportReview {
  componentCount: number
  queryCount: number
  uncontrolledComponentCount: number
  scopeDescriptions: string[]
  sensitiveFields: string[]
}

export const analyzeDashboardExport = (spec: DashboardSpec): DashboardExportReview => {
  const queryComponents = spec.components.filter((component) => component.query)
  const scopeDescriptions = unique(queryComponents
    .filter((component) => component.query)
    .flatMap((component) => describeDataScope(component.query?.scope)))
  return {
    componentCount: spec.components.length,
    queryCount: queryComponents.length,
    uncontrolledComponentCount: spec.components.length - queryComponents.length,
    scopeDescriptions: scopeDescriptions.length ? scopeDescriptions : ['未发现受控查询'],
    sensitiveFields: listSensitiveFields(spec)
  }
}

export interface ComponentProvenance {
  scopes: string[]
  dimensions: string[]
  measures: string[]
  filters: string[]
  limit?: number
}

export const analyzeComponentProvenance = (
  component: DashboardComponentSpec
): ComponentProvenance => ({
  scopes: describeDataScope(component.query?.scope),
  dimensions: (component.query?.dimensions ?? []).map((dimension) =>
    `${dimension.field}${dimension.timeGrain ? `（按${dimension.timeGrain}）` : ''}`
  ),
  measures: (component.query?.measures ?? []).map(describeMeasure),
  filters: [
    ...(component.query?.scope.baseFilters ?? []),
    ...(component.query?.filters ?? [])
  ].map(describeFilter),
  limit: component.query?.limit
})
