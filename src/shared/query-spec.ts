export type QueryFieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'array' | 'object'

export type FieldSensitivity = 'normal' | 'internal' | 'sensitive'

export type FieldProfileRole = 'dimension' | 'measure' | 'time' | 'identifier'

export type FilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'in'
  | 'notIn'
  | 'empty'
  | 'notEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export interface FilterSpec {
  field: string
  operator: FilterOperator
  value?: string | number | boolean | Array<string | number | boolean>
  /** Marks filters injected by the dashboard-level filter bar. */
  source?: 'component' | 'dashboard'
}

export interface DataScope {
  projectIds?: string[]
  nodeTypes?: string[]
  recordUids?: string[]
  baseFilters?: FilterSpec[]
  snapshotAt?: string
}

export type QueryAggregation = 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'
export type TimeGrain = 'day' | 'week' | 'month' | 'quarter'
export type QueryCalculation = 'yoy' | 'mom' | 'share' | 'cumulative'
export type QueryComparisonMode = 'percent' | 'difference'

export interface QueryPeriodComparison {
  /** Number of periods to move backwards at the selected time grain. */
  offset: number
  mode: QueryComparisonMode
}

export interface QueryDimension {
  field: string
  timeGrain?: TimeGrain
}

export interface QueryMeasure {
  id: string
  field?: string
  aggregation: QueryAggregation
  calculation?: QueryCalculation
  comparison?: QueryPeriodComparison
  /** A restricted arithmetic expression referencing other measure ids. */
  formula?: string
}

export interface QuerySpec {
  source: 'records'
  scope: DataScope
  dimensions?: QueryDimension[]
  measures: QueryMeasure[]
  filters?: FilterSpec[]
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>
  limit?: number
}

export interface FieldProfile {
  field: string
  inferredType: QueryFieldType
  sensitivity: FieldSensitivity
  nonNullRate: number
  distinctCount: number
  samples: string[]
  displayName?: string
  role?: FieldProfileRole
  synonyms?: string[]
  profiledAt?: string
}

export interface FieldProfileSemanticPatch {
  displayName?: string
  role?: FieldProfileRole
  synonyms?: string[]
  sensitivity?: FieldSensitivity
}

export interface QueryDataset {
  columns: Array<{ name: string; type: QueryFieldType | 'unknown' }>
  rows: Array<Record<string, string | number | boolean | null>>
  scannedRows: number
  matchedRows: number
  truncated: boolean
  elapsedMs: number
}

export interface QueryValidationResult {
  valid: boolean
  errors: string[]
}

const filterOperators = new Set<FilterOperator>([
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'in',
  'notIn',
  'empty',
  'notEmpty',
  'gt',
  'gte',
  'lt',
  'lte'
])

const aggregations = new Set<QueryAggregation>([
  'count',
  'countDistinct',
  'sum',
  'avg',
  'min',
  'max'
])

const calculations = new Set<QueryCalculation>([
  'yoy',
  'mom',
  'share',
  'cumulative'
])

const comparisonModes = new Set<QueryComparisonMode>(['percent', 'difference'])
const formulaPattern = /^[A-Za-z0-9_+\-*/%().\s]+$/

export const validateQuerySpecShape = (input: unknown): QueryValidationResult => {
  const errors: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['QuerySpec 必须是对象'] }
  }
  const spec = input as Partial<QuerySpec>
  if (spec.source !== 'records') errors.push('source 只允许 records')
  if (!spec.scope || typeof spec.scope !== 'object') errors.push('scope 必填')
  if (!Array.isArray(spec.measures) || spec.measures.length === 0) {
    errors.push('measures 至少包含一个指标')
  } else if (spec.measures.length > 8) {
    errors.push('单次查询最多包含 8 个指标')
  } else {
    const ids = new Set<string>()
    for (const measure of spec.measures) {
      if (!measure?.id?.trim()) errors.push('指标 id 不能为空')
      if (ids.has(measure?.id)) errors.push(`指标 id 重复: ${measure?.id}`)
      ids.add(measure?.id)
      if (!aggregations.has(measure?.aggregation)) {
        errors.push(`不支持的聚合方式: ${String(measure?.aggregation)}`)
      }
      if (measure?.calculation !== undefined && !calculations.has(measure.calculation)) {
        errors.push(`不支持的指标计算: ${String(measure?.calculation)}`)
      }
      if (measure?.comparison !== undefined) {
        const comparison = measure.comparison
        if (!comparison || !Number.isInteger(comparison.offset) || comparison.offset < 1 || comparison.offset > 24) {
          errors.push(`指标 ${measure?.id || '(未命名)'} 的周期对比 offset 必须是 1 到 24`)
        }
        if (!comparisonModes.has(comparison?.mode)) {
          errors.push(`指标 ${measure?.id || '(未命名)'} 的周期对比模式无效`)
        }
      }
      if (measure?.formula !== undefined) {
        if (
          typeof measure.formula !== 'string' ||
          measure.formula.length > 200 ||
          !measure.formula.trim() ||
          !formulaPattern.test(measure.formula)
        ) {
          errors.push(`指标 ${measure?.id || '(未命名)'} 的自定义公式格式无效`)
        }
      }
      if (measure?.formula?.trim() && (measure?.calculation || measure?.comparison)) {
        errors.push(`指标 ${measure?.id || '(未命名)'} 的公式不能同时设置指标计算或周期对比`)
      }
      if (measure?.calculation && measure?.comparison) {
        errors.push(`指标 ${measure?.id || '(未命名)'} 不能同时设置指标计算和周期对比`)
      }
      if (measure?.aggregation !== 'count' && !measure?.field?.trim() && !measure?.formula?.trim()) {
        errors.push(`指标 ${measure?.id || '(未命名)'} 必须指定 field`)
      }
    }
  }
  if ((spec.dimensions?.length ?? 0) > 2) errors.push('最多支持两个分组维度')
  if ((spec.filters?.length ?? 0) > 12) errors.push('最多支持 12 个查询筛选条件')
  for (const filter of spec.filters ?? []) {
    if (!filter?.field?.trim()) errors.push('筛选字段不能为空')
    if (!filterOperators.has(filter?.operator)) {
      errors.push(`不支持的筛选操作符: ${String(filter?.operator)}`)
    }
  }
  if (spec.limit !== undefined && (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 500)) {
    errors.push('limit 必须是 1 到 500 的整数')
  }
  return { valid: errors.length === 0, errors }
}
