import { performance } from 'node:perf_hooks'
import type {
  DataScope,
  FieldProfile,
  FilterSpec,
  QueryDataset,
  QueryFieldType,
  QueryMeasure,
  QuerySpec
} from '../../shared/query-spec'
import { validateQuerySpecShape } from '../../shared/query-spec'
import type { AnalyticsRecord } from '../database'
import { AppDatabase } from '../database'

const metadataFields: Record<string, keyof Omit<AnalyticsRecord, 'raw'>> = {
  uid: 'uid',
  projectId: 'projectId',
  nodeType: 'nodeType',
  itemId: 'itemId',
  name: 'name',
  lastModifyTime: 'lastModifyTime'
}

const readPath = (record: AnalyticsRecord, path: string): unknown[] => {
  const metadata = metadataFields[path]
  if (metadata) return [record[metadata]]
  if (Object.prototype.hasOwnProperty.call(record.raw, path)) return [record.raw[path]]
  const segments = path.split('.').filter(Boolean)
  const descend = (value: unknown, index: number): unknown[] => {
    if (index >= segments.length) return [value]
    if (Array.isArray(value)) return value.flatMap((item) => descend(item, index))
    if (!value || typeof value !== 'object') return []
    const object = value as Record<string, unknown>
    const expected = segments[index].toLocaleLowerCase()
    const key = Object.keys(object).find((candidate) => candidate.toLocaleLowerCase() === expected)
    return key ? descend(object[key], index + 1) : []
  }
  return descend(record.raw, 0)
}

const scalarValues = (values: unknown[]): Array<string | number | boolean> =>
  values.flatMap((value): Array<string | number | boolean> => {
    if (value === null || value === undefined || value === '') return []
    if (Array.isArray(value)) return scalarValues(value)
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return [value]
    }
    if (typeof value === 'object') {
      const object = value as Record<string, unknown>
      for (const key of ['name', 'Name', 'label', 'Label', 'value', 'Value']) {
        if (object[key] !== undefined) return scalarValues([object[key]])
      }
    }
    return []
  })

const collectFieldPaths = (input: Record<string, unknown>, maximumDepth = 3): string[] => {
  const paths = new Set<string>()
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined || depth > maximumDepth) return
    if (Array.isArray(value)) {
      if (value.some((item) => item === null || typeof item !== 'object')) paths.add(path)
      for (const item of value) {
        if (item && typeof item === 'object') visit(item, path, depth + 1)
      }
      return
    }
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1)
      }
      return
    }
    if (path) paths.add(path)
  }
  visit(input, '', 0)
  return [...paths]
}

const comparable = (value: string | number | boolean): string | number => {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  const number = Number(value)
  if (value.trim() && Number.isFinite(number)) return number
  const date = Date.parse(value)
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value) && Number.isFinite(date)) return date
  return value.toLocaleLowerCase()
}

const matchesFilter = (record: AnalyticsRecord, filter: FilterSpec): boolean => {
  const values = scalarValues(readPath(record, filter.field))
  if (filter.operator === 'empty') return values.length === 0
  if (filter.operator === 'notEmpty') return values.length > 0
  if (!values.length) return false
  const expectedList = Array.isArray(filter.value) ? filter.value : [filter.value]
  const expected = expectedList.filter(
    (value): value is string | number | boolean => value !== undefined
  )
  const equals = (left: string | number | boolean, right: string | number | boolean): boolean =>
    comparable(left) === comparable(right)
  if (filter.operator === 'equals') return expected.some((right) => values.some((left) => equals(left, right)))
  if (filter.operator === 'notEquals') return expected.every((right) => values.every((left) => !equals(left, right)))
  if (filter.operator === 'in') return values.some((left) => expected.some((right) => equals(left, right)))
  if (filter.operator === 'notIn') return values.every((left) => expected.every((right) => !equals(left, right)))
  const text = String(expected[0] ?? '').toLocaleLowerCase()
  if (filter.operator === 'contains') return values.some((value) => String(value).toLocaleLowerCase().includes(text))
  if (filter.operator === 'notContains') return values.every((value) => !String(value).toLocaleLowerCase().includes(text))
  const right = comparable(expected[0] ?? '')
  return values.some((value) => {
    const left = comparable(value)
    if (typeof left !== typeof right) return false
    if (filter.operator === 'gt') return left > right
    if (filter.operator === 'gte') return left >= right
    if (filter.operator === 'lt') return left < right
    return left <= right
  })
}

const inferType = (values: Array<string | number | boolean>): QueryFieldType => {
  if (values.some((value) => typeof value === 'number')) return 'number'
  if (values.some((value) => typeof value === 'boolean')) return 'boolean'
  if (values.length && values.every((value) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value)
  )) return 'date'
  if (values.length && values.every((value) =>
    typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
  )) return 'number'
  return 'string'
}

const timeBucket = (value: unknown, grain?: string): string => {
  const timestamp = Date.parse(String(value ?? ''))
  if (!Number.isFinite(timestamp) || !grain) return String(value ?? '')
  const date = new Date(timestamp)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth()
  if (grain === 'day') return date.toISOString().slice(0, 10)
  if (grain === 'month') return `${year}-${String(month + 1).padStart(2, '0')}`
  if (grain === 'quarter') return `${year}-Q${Math.floor(month / 3) + 1}`
  const start = new Date(Date.UTC(year, month, date.getUTCDate()))
  const weekday = start.getUTCDay() || 7
  start.setUTCDate(start.getUTCDate() - weekday + 1)
  return start.toISOString().slice(0, 10)
}

const aggregate = (records: AnalyticsRecord[], measure: QueryMeasure): number => {
  if (measure.aggregation === 'count' && !measure.field) return records.length
  const values = records.flatMap((record) => scalarValues(readPath(record, measure.field ?? '')))
  if (measure.aggregation === 'count') return values.length
  if (measure.aggregation === 'countDistinct') {
    return new Set(values.map((value) => String(value).toLocaleLowerCase())).size
  }
  const numbers = values.map(Number).filter(Number.isFinite)
  if (!numbers.length) return 0
  if (measure.aggregation === 'sum') return numbers.reduce((sum, value) => sum + value, 0)
  if (measure.aggregation === 'avg') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
  if (measure.aggregation === 'min') return Math.min(...numbers)
  return Math.max(...numbers)
}

export class QueryEngine {
  constructor(private readonly db: AppDatabase) {}

  profile(scope: DataScope): FieldProfile[] {
    const records = this.db.scanAnalyticsRecords(scope)
    const fields = new Map<string, {
      values: Array<string | number | boolean>
      nonNullRecords: number
    }>()
    for (const record of records) {
      for (const field of new Set([
        ...Object.keys(metadataFields),
        ...collectFieldPaths(record.raw)
      ])) {
        const values = scalarValues(readPath(record, field))
        const profile = fields.get(field) ?? { values: [], nonNullRecords: 0 }
        profile.values.push(...values)
        if (values.length) profile.nonNullRecords += 1
        fields.set(field, profile)
      }
    }
    return [...fields.entries()]
      .map(([field, profile]) => ({
        field,
        inferredType: inferType(profile.values),
        nonNullRate: records.length
          ? Number((profile.nonNullRecords / records.length).toFixed(4))
          : 0,
        distinctCount: new Set(profile.values.map(String)).size,
        samples: [...new Set(profile.values.map(String))].slice(0, 5)
      }))
      .sort((left, right) => right.nonNullRate - left.nonNullRate || left.field.localeCompare(right.field))
  }

  validate(spec: QuerySpec, profiles = this.profile(spec.scope)): string[] {
    const shape = validateQuerySpecShape(spec)
    const errors = [...shape.errors]
    const catalog = new Map(profiles.map((profile) => [profile.field.toLocaleLowerCase(), profile]))
    const requireField = (field: string, usage: string): FieldProfile | undefined => {
      const profile = catalog.get(field.toLocaleLowerCase())
      if (!profile) errors.push(`${usage}引用了不存在的字段: ${field}`)
      return profile
    }
    for (const dimension of spec.dimensions ?? []) {
      const profile = requireField(dimension.field, '维度')
      if (dimension.timeGrain && profile && profile.inferredType !== 'date') {
        errors.push(`字段 ${dimension.field} 不是日期，不能使用 timeGrain`)
      }
    }
    for (const measure of spec.measures ?? []) {
      if (!measure.field) continue
      const profile = requireField(measure.field, '指标')
      if (profile && ['sum', 'avg', 'min', 'max'].includes(measure.aggregation) &&
          profile.inferredType !== 'number') {
        errors.push(`字段 ${measure.field} 不是数值，不能执行 ${measure.aggregation}`)
      }
    }
    for (const filter of [...(spec.scope.baseFilters ?? []), ...(spec.filters ?? [])]) {
      requireField(filter.field, '筛选条件')
    }
    for (const sort of spec.sort ?? []) {
      const resultFields = new Set([
        ...(spec.dimensions ?? []).map((dimension) => dimension.field),
        ...spec.measures.map((measure) => measure.id)
      ])
      if (!resultFields.has(sort.field)) errors.push(`排序字段不在查询结果中: ${sort.field}`)
    }
    return [...new Set(errors)]
  }

  execute(spec: QuerySpec): QueryDataset {
    const startedAt = performance.now()
    const profiles = this.profile(spec.scope)
    const errors = this.validate(spec, profiles)
    if (errors.length) throw new Error(`QuerySpec 校验失败: ${errors.join('；')}`)
    const records = this.db.scanAnalyticsRecords(spec.scope)
    const filters = [...(spec.scope.baseFilters ?? []), ...(spec.filters ?? [])]
    const filtered = records.filter((record) => filters.every((filter) => matchesFilter(record, filter)))
    const dimensions = spec.dimensions ?? []
    const groups = new Map<string, { values: Record<string, string>; records: AnalyticsRecord[] }>()
    for (const record of filtered) {
      const values = Object.fromEntries(dimensions.map((dimension) => [
        dimension.field,
        timeBucket(scalarValues(readPath(record, dimension.field))[0], dimension.timeGrain)
      ]))
      const key = JSON.stringify(values)
      const group = groups.get(key) ?? { values, records: [] }
      group.records.push(record)
      groups.set(key, group)
    }
    if (!dimensions.length) groups.set('{}', { values: {}, records: filtered })
    let rows: QueryDataset['rows'] = [...groups.values()].map((group) => ({
      ...group.values,
      ...Object.fromEntries(spec.measures.map((measure) => [measure.id, aggregate(group.records, measure)]))
    }))
    for (const sort of [...(spec.sort ?? [])].reverse()) {
      const direction = sort.direction === 'desc' ? -1 : 1
      rows.sort((left, right) => {
        const a = comparable(left[sort.field] ?? '')
        const b = comparable(right[sort.field] ?? '')
        return a < b ? -direction : a > b ? direction : 0
      })
    }
    const limit = Math.min(500, Math.max(1, spec.limit ?? 100))
    const truncated = rows.length > limit
    rows = rows.slice(0, limit)
    const profileMap = new Map(profiles.map((profile) => [profile.field, profile.inferredType]))
    return {
      columns: [
        ...dimensions.map((dimension) => ({
          name: dimension.field,
          type: dimension.timeGrain ? 'date' as const : profileMap.get(dimension.field) ?? 'unknown' as const
        })),
        ...spec.measures.map((measure) => ({ name: measure.id, type: 'number' as const }))
      ],
      rows,
      scannedRows: records.length,
      matchedRows: filtered.length,
      truncated,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2))
    }
  }
}
