import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  DataScope,
  FieldProfile,
  FieldProfileRole,
  FieldProfileSemanticPatch,
  FieldSensitivity,
  FilterSpec,
  QueryDataset,
  QueryFieldType,
  QueryMeasure,
  QuerySpec,
  TimeGrain
} from '../../shared/query-spec'
import { validateQuerySpecShape } from '../../shared/query-spec'
import type { AnalyticsRecord } from '../database'
import { AppDatabase } from '../database'
import type { FieldDefinition } from '../../shared/types'

const metadataFields: Record<string, keyof Omit<AnalyticsRecord, 'raw'>> = {
  uid: 'uid',
  projectId: 'projectId',
  nodeType: 'nodeType',
  itemId: 'itemId',
  name: 'name',
  lastModifyTime: 'lastModifyTime'
}

type AnalyticsDatabase = Pick<AppDatabase, 'scanAnalyticsRecords'> & Partial<{
  getAnalyticsRevision(): number
  getFieldProfiles(scopeKey: string, dataRevision: number): FieldProfile[] | null
  getFieldDefinitions?(nodeType: string | string[], fields?: string[]): FieldDefinition[]
  getFieldDisplayNames?(nodeType: string | string[], fields?: string[]): Record<string, string>
  saveFieldProfiles(scopeKey: string, dataRevision: number, profiles: FieldProfile[]): void
  updateFieldProfileSemantics(
    scopeKey: string,
    field: string,
    patch: FieldProfileSemanticPatch
  ): FieldProfile | null
  getQueryCache(cacheKey: string, dataRevision: number): QueryDataset | null
  saveQueryCache(
    cacheKey: string,
    dataRevision: number,
    dataset: QueryDataset,
    ttlMs?: number
  ): void
}>

const fieldProfileRoles = new Set<FieldProfileRole>([
  'dimension',
  'measure',
  'time',
  'identifier'
])

const fieldSensitivities = new Set<FieldSensitivity>(['normal', 'internal', 'sensitive'])

const sensitiveFieldPattern =
  /(^|[._-])(token|password|secret|phone|mobile|email|idcard|身份证|手机号|邮箱)([._-]|$)/i

const inferSensitivity = (field: string): FieldSensitivity => {
  if (sensitiveFieldPattern.test(field)) return 'sensitive'
  if (/(^|[._-])(uid|uuid|itemid|projectid|owner|assignee)([._-]|$)/i.test(field)) {
    return 'internal'
  }
  return 'normal'
}

const stableValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .flatMap((key) => {
        const child = stableValue(object[key])
        return child === undefined ? [] : [[key, child]]
      })
  )
}

const stableSerialize = (value: unknown): string => JSON.stringify(stableValue(value))

const hashValue = (value: unknown): string =>
  createHash('sha256').update(stableSerialize(value)).digest('hex')

const scopeCacheKey = (scope: DataScope): string => `scope:${hashValue(scope)}`

const queryCacheKey = (spec: QuerySpec): string => `query:${hashValue(spec)}`

const safeRevision = (db: AnalyticsDatabase): number => {
  const revision = db.getAnalyticsRevision?.() ?? 0
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0
}

type RecordSnapshot = {
  revision: number
  createdAt: number
  records: AnalyticsRecord[]
}

// A single dashboard interaction can ask for field profiles and several
// component queries in quick succession. Reusing the short-lived snapshot
// avoids parsing the same raw_json payload once per IPC request while keeping
// the cache bounded and revision-aware.
const recordSnapshotCache = new WeakMap<AnalyticsDatabase, Map<string, RecordSnapshot>>()
const recordSnapshotTtlMs = 1_500
const recordSnapshotLimit = 8

const scanRecords = (db: AnalyticsDatabase, scope: DataScope): AnalyticsRecord[] => {
  const revision = safeRevision(db)
  const key = `${revision}:${scopeCacheKey(scope)}`
  const now = Date.now()
  const cache = recordSnapshotCache.get(db) ?? new Map<string, RecordSnapshot>()
  recordSnapshotCache.set(db, cache)
  const cached = cache.get(key)
  if (cached && now - cached.createdAt <= recordSnapshotTtlMs) return cached.records

  const records = db.scanAnalyticsRecords(scope)
  cache.set(key, { revision, createdAt: now, records })
  if (cache.size > recordSnapshotLimit) {
    const oldest = [...cache.entries()]
      .sort((left, right) => left[1].createdAt - right[1].createdAt)[0]?.[0]
    if (oldest) cache.delete(oldest)
  }
  return records
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
      if (path) paths.add(path)
      if (value.some((item) => item === null || typeof item !== 'object')) paths.add(path)
      for (const item of value) {
        if (item && typeof item === 'object') visit(item, path, depth + 1)
      }
      return
    }
    if (typeof value === 'object') {
      if (path) paths.add(path)
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

const inferType = (
  values: Array<string | number | boolean>,
  shape: 'scalar' | 'array' | 'object',
  distinctCount: number
): QueryFieldType => {
  if (shape === 'array') return 'array'
  if (shape === 'object') return 'object'
  if (values.some((value) => typeof value === 'number')) return 'number'
  if (values.some((value) => typeof value === 'boolean')) return 'boolean'
  if (values.length && values.every((value) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value)
  )) return 'date'
  if (values.length && values.every((value) =>
    typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
  )) return 'number'
  return values.length >= 1 && distinctCount <= 20 ? 'enum' : 'string'
}

const inferRole = (field: string, inferredType: QueryFieldType): FieldProfileRole => {
  const leaf = field.split('.').at(-1) ?? field
  if (
    /(^|[_-])(id|uid|uuid|code|key)$/i.test(leaf) ||
    /^(id|uid|uuid|code|key)$/i.test(leaf) ||
    /(Id|UID|UUID|Code|Key)$/.test(leaf)
  ) return 'identifier'
  if (inferredType === 'date' || /(date|time|year|month|quarter|week)/i.test(leaf)) {
    return 'time'
  }
  if (inferredType === 'number') return 'measure'
  return 'dimension'
}

const normalizeSemanticPatch = (patch: FieldProfileSemanticPatch): FieldProfileSemanticPatch => {
  const normalized: FieldProfileSemanticPatch = {}
  if (patch.displayName !== undefined) {
    if (typeof patch.displayName !== 'string') throw new Error('字段显示名必须是文本')
    normalized.displayName = patch.displayName.trim().slice(0, 80)
  }
  if (patch.role !== undefined) {
    if (!fieldProfileRoles.has(patch.role)) throw new Error('字段语义角色无效')
    normalized.role = patch.role
  }
  if (patch.synonyms !== undefined) {
    if (!Array.isArray(patch.synonyms)) throw new Error('字段语义别名必须是数组')
    normalized.synonyms = [...new Set(
      patch.synonyms
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )].slice(0, 12)
  }
  if (patch.sensitivity !== undefined) {
    if (!fieldSensitivities.has(patch.sensitivity)) throw new Error('字段敏感级别无效')
    normalized.sensitivity = patch.sensitivity
  }
  return normalized
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

const shiftPeriodBy = (value: string, grain: TimeGrain, offset: number): string | null => {
  if (!value || !Number.isInteger(offset) || offset < 1) return null
  if (grain === 'quarter') {
    const match = /^(\d{4})-Q([1-4])$/.exec(value)
    if (!match) return null
    const quarterIndex = Number(match[1]) * 4 + Number(match[2]) - 1 - offset
    return `${Math.floor(quarterIndex / 4)}-Q${(quarterIndex % 4) + 1}`
  }
  if (grain === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(value)
    if (!match) return null
    const monthIndex = Number(match[1]) * 12 + Number(match[2]) - 1 - offset
    return `${Math.floor(monthIndex / 12)}-${String((monthIndex % 12) + 1).padStart(2, '0')}`
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const date = new Date(timestamp)
  if (grain === 'day') date.setUTCDate(date.getUTCDate() - offset)
  else date.setUTCDate(date.getUTCDate() - 7 * offset)
  return date.toISOString().slice(0, 10)
}

const shiftPeriod = (value: string, grain: TimeGrain, calculation: 'yoy' | 'mom'): string | null =>
  shiftPeriodBy(value, grain, calculation === 'yoy'
    ? grain === 'day' ? 365 : grain === 'week' ? 52 : grain === 'quarter' ? 4 : 12
    : 1)

type FormulaToken = { type: 'number' | 'identifier' | 'operator' | 'open' | 'close'; value: string }

const tokenizeFormula = (expression: string): FormulaToken[] => {
  const tokens: FormulaToken[] = []
  let index = 0
  while (index < expression.length) {
    const character = expression[index]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    const number = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(expression.slice(index))
    if (number) {
      tokens.push({ type: 'number', value: number[0] })
      index += number[0].length
      continue
    }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(index))
    if (identifier) {
      tokens.push({ type: 'identifier', value: identifier[0] })
      index += identifier[0].length
      continue
    }
    if ('+-*/%'.includes(character)) {
      tokens.push({ type: 'operator', value: character })
      index += 1
      continue
    }
    if (character === '(' || character === ')') {
      tokens.push({ type: character === '(' ? 'open' : 'close', value: character })
      index += 1
      continue
    }
    throw new Error('公式包含不支持的字符')
  }
  return tokens
}

const evaluateFormula = (
  expression: string,
  values: Record<string, number>
): number => {
  const tokens = tokenizeFormula(expression)
  let cursor = 0
  const parseExpression = (): number => {
    let value = parseTerm()
    while (tokens[cursor]?.value === '+' || tokens[cursor]?.value === '-') {
      const operator = tokens[cursor++].value
      const right = parseTerm()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const parseTerm = (): number => {
    let value = parseFactor()
    while (['*', '/', '%'].includes(tokens[cursor]?.value ?? '')) {
      const operator = tokens[cursor++].value
      const right = parseFactor()
      if (operator === '*') value *= right
      else if (operator === '/') value = right === 0 ? 0 : value / right
      else value = right === 0 ? 0 : value % right
    }
    return value
  }
  const parseFactor = (): number => {
    const token = tokens[cursor++]
    if (!token) throw new Error('公式缺少操作数')
    if (token.type === 'operator' && (token.value === '+' || token.value === '-')) {
      const value = parseFactor()
      return token.value === '-' ? -value : value
    }
    if (token.type === 'number') return Number(token.value)
    if (token.type === 'identifier') {
      const value = values[token.value]
      if (value === undefined) throw new Error(`公式引用了不存在的指标: ${token.value}`)
      return value
    }
    if (token.type === 'open') {
      const value = parseExpression()
      if (tokens[cursor]?.type !== 'close') throw new Error('公式括号不匹配')
      cursor += 1
      return value
    }
    throw new Error('公式缺少操作数')
  }
  const result = parseExpression()
  if (cursor !== tokens.length || !Number.isFinite(result)) throw new Error('公式无法计算')
  return Number(result.toFixed(6))
}

const numericValue = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const dimensionKey = (
  row: Record<string, string | number | boolean | null>,
  dimensions: QuerySpec['dimensions']
): string => JSON.stringify((dimensions ?? []).map((dimension) => row[dimension.field] ?? null))

const calculatedRows = (
  rows: QueryDataset['rows'],
  dimensions: NonNullable<QuerySpec['dimensions']>,
  measures: QueryMeasure[]
): QueryDataset['rows'] => {
  const calculated = rows.map((row) => ({ ...row }))
  const timeIndex = dimensions.findIndex((dimension) => Boolean(dimension.timeGrain))
  const timeDimension = timeIndex >= 0 ? dimensions[timeIndex] : undefined
  const baseLookup = new Map<string, QueryDataset['rows'][number]>()
  rows.forEach((row) => baseLookup.set(dimensionKey(row, dimensions), row))

  for (const measure of measures) {
    if (measure.formula?.trim()) continue
    if (measure.comparison) {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]
        if (!timeDimension?.timeGrain) {
          calculated[index][measure.id] = null
          continue
        }
        const previousPeriod = shiftPeriodBy(
          String(row[timeDimension.field] ?? ''),
          timeDimension.timeGrain,
          measure.comparison.offset
        )
        if (!previousPeriod) {
          calculated[index][measure.id] = null
          continue
        }
        const previousValues = dimensions.map((dimension, dimensionIndex) =>
          dimensionIndex === timeIndex ? previousPeriod : row[dimension.field] ?? null
        )
        const previous = baseLookup.get(JSON.stringify(previousValues))
        const previousValue = Number(previous?.[measure.id])
        const currentValue = numericValue(row[measure.id])
        if (!Number.isFinite(previousValue)) {
          calculated[index][measure.id] = null
          continue
        }
        if (measure.comparison.mode === 'difference') {
          calculated[index][measure.id] = Number((currentValue - previousValue).toFixed(6))
        } else {
          calculated[index][measure.id] = previousValue === 0
            ? null
            : Number((((currentValue - previousValue) / previousValue) * 100).toFixed(6))
        }
      }
      continue
    }
    const calculation = measure.calculation
    if (!calculation) continue
    if (calculation === 'share') {
      const denominator = rows.reduce((sum, row) => sum + numericValue(row[measure.id]), 0)
      for (let index = 0; index < rows.length; index += 1) {
        calculated[index][measure.id] = denominator === 0
          ? 0
          : Number(((numericValue(rows[index][measure.id]) / denominator) * 100).toFixed(6))
      }
      continue
    }
    if (calculation === 'cumulative') {
      const running = new Map<string, number>()
      const order = rows
        .map((row, index) => ({ row, index }))
        .sort((left, right) => {
          if (!timeDimension) return left.index - right.index
          const a = comparable(String(left.row[timeDimension.field] ?? ''))
          const b = comparable(String(right.row[timeDimension.field] ?? ''))
          return a < b ? -1 : a > b ? 1 : left.index - right.index
        })
      for (const item of order) {
        const partition = dimensions
          .filter((_dimension, index) => index !== timeIndex)
          .map((dimension) => item.row[dimension.field] ?? null)
        const partitionKey = JSON.stringify(partition)
        const next = (running.get(partitionKey) ?? 0) + numericValue(item.row[measure.id])
        running.set(partitionKey, next)
        calculated[item.index][measure.id] = next
      }
      continue
    }
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (!timeDimension?.timeGrain) {
        calculated[index][measure.id] = null
        continue
      }
      const previousPeriod = shiftPeriod(
        String(row[timeDimension.field] ?? ''),
        timeDimension.timeGrain,
        calculation
      )
      if (!previousPeriod) {
        calculated[index][measure.id] = null
        continue
      }
      const previousValues = dimensions.map((dimension, dimensionIndex) =>
        dimensionIndex === timeIndex
          ? previousPeriod
          : row[dimension.field] ?? null
      )
      const previous = baseLookup.get(JSON.stringify(previousValues))
      const previousValue = Number(previous?.[measure.id])
      if (!Number.isFinite(previousValue) || previousValue === 0) {
        calculated[index][measure.id] = null
        continue
      }
      const currentValue = numericValue(row[measure.id])
      calculated[index][measure.id] = Number(
        (((currentValue - previousValue) / previousValue) * 100).toFixed(6)
      )
    }
  }
  return calculated
}

const calculatedFormulaRows = (
  rows: QueryDataset['rows'],
  measures: QueryMeasure[]
): QueryDataset['rows'] => {
  const measureMap = new Map(measures.map((measure) => [measure.id, measure]))
  return rows.map((row) => {
    const next = { ...row }
    const resolving = new Set<string>()
    const resolve = (id: string): number => {
      const measure = measureMap.get(id)
      if (!measure) throw new Error(`公式引用了不存在的指标: ${id}`)
      if (!measure.formula?.trim()) return numericValue(next[id])
      if (resolving.has(id)) throw new Error(`公式存在循环引用: ${id}`)
      resolving.add(id)
      const references = [...new Set(
        measure.formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
      )]
      const values = Object.fromEntries(
        references.map((reference) => [reference, resolve(reference)])
      )
      const result = evaluateFormula(measure.formula, values)
      resolving.delete(id)
      next[id] = result
      return result
    }
    for (const measure of measures) {
      if (measure.formula?.trim()) resolve(measure.id)
    }
    return next
  })
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
  constructor(private readonly db: AnalyticsDatabase) {}

  profile(scope: DataScope): FieldProfile[] {
    const dataRevision = safeRevision(this.db)
    const cacheKey = scopeCacheKey(scope)
    const fieldLabels = this.db.getFieldDisplayNames?.(scope.nodeTypes ?? [], []) ?? {}
    const fieldDefinitions = new Map<string, FieldDefinition>()
    for (const definition of this.db.getFieldDefinitions?.(scope.nodeTypes ?? [], []) ?? []) {
      if (!fieldDefinitions.has(definition.field)) fieldDefinitions.set(definition.field, definition)
    }
    const applyFieldMetadata = (profiles: FieldProfile[]): FieldProfile[] => profiles.map((profile) => {
      const definition = fieldDefinitions.get(profile.field)
      const displayName = profile.displayName?.trim() || fieldLabels[profile.field]
      return {
        ...profile,
        ...(displayName ? { displayName } : {}),
        ...(definition ? {
          declaredType: definition.normalizedType,
          ...(definition.sourceType ? { sourceType: definition.sourceType } : {}),
          ...(definition.attrType ? { attrType: definition.attrType } : {})
        } : {})
      }
    })
    const cached = this.db.getFieldProfiles?.(cacheKey, dataRevision)
    if (cached) return applyFieldMetadata(cached)

    const records = scanRecords(this.db, scope)
    const fields = new Map<string, {
      values: Array<string | number | boolean>
      nonNullRecords: number
      shape: 'scalar' | 'array' | 'object'
    }>()
    for (const record of records) {
      for (const field of new Set([
        ...Object.keys(metadataFields),
        ...collectFieldPaths(record.raw)
      ])) {
        const rawValues = readPath(record, field)
        const values = scalarValues(rawValues)
        const shape = rawValues.some((value) => Array.isArray(value))
          ? 'array'
          : rawValues.some((value) => value && typeof value === 'object')
            ? 'object'
            : 'scalar'
        const profile = fields.get(field) ?? { values: [], nonNullRecords: 0, shape: 'scalar' }
        profile.values.push(...values)
        if (rawValues.some((value) => value !== null && value !== undefined && value !== '')) {
          profile.nonNullRecords += 1
        }
        if (shape === 'array' || (shape === 'object' && profile.shape === 'scalar')) {
          profile.shape = shape
        }
        fields.set(field, profile)
      }
    }
    const profiles = [...fields.entries()]
      .map(([field, profile]) => {
        const distinctCount = new Set(profile.values.map(String)).size
        const inferredType = inferType(profile.values, profile.shape, distinctCount)
        return {
          field,
          inferredType,
          sensitivity: inferSensitivity(field),
          role: inferRole(field, inferredType),
          nonNullRate: records.length
            ? Number((profile.nonNullRecords / records.length).toFixed(4))
            : 0,
          distinctCount,
          samples: [...new Set(profile.values.map(String))].slice(0, 5),
          ...(fieldLabels[field] ? { displayName: fieldLabels[field] } : {}),
          profiledAt: new Date().toISOString()
        }
      })
      .sort((left, right) => right.nonNullRate - left.nonNullRate || left.field.localeCompare(right.field))
    this.db.saveFieldProfiles?.(cacheKey, dataRevision, profiles)
    return applyFieldMetadata(profiles)
  }

  updateFieldProfileSemantics(
    scope: DataScope,
    field: string,
    patch: FieldProfileSemanticPatch
  ): FieldProfile {
    const normalizedField = field.trim()
    if (!normalizedField) throw new Error('字段名不能为空')
    const update = this.db.updateFieldProfileSemantics
    if (!update) throw new Error('当前数据源不支持字段语义持久化')
    this.profile(scope)
    const result = update.call(
      this.db,
      scopeCacheKey(scope),
      normalizedField,
      normalizeSemanticPatch(patch)
    )
    if (!result) throw new Error(`字段不存在或尚未完成画像: ${normalizedField}`)
    return result
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
      const profile = measure.field ? requireField(measure.field, '指标') : undefined
      if (profile && ['sum', 'avg', 'min', 'max'].includes(measure.aggregation) &&
          profile.inferredType !== 'number') {
        errors.push(`字段 ${measure.field} 不是数值，不能执行 ${measure.aggregation}`)
      }
      if (measure.calculation && ['yoy', 'mom', 'cumulative'].includes(measure.calculation) &&
          !(spec.dimensions ?? []).some((dimension) => Boolean(dimension.timeGrain))) {
        errors.push(`指标 ${measure.id} 的 ${measure.calculation} 计算需要带时间粒度的维度`)
      }
      if (measure.comparison &&
          !(spec.dimensions ?? []).some((dimension) => Boolean(dimension.timeGrain))) {
        errors.push(`指标 ${measure.id} 的周期对比需要带时间粒度的维度`)
      }
    }
    const measureIds = new Set(spec.measures.map((measure) => measure.id))
    for (const measure of spec.measures) {
      if (!measure.formula?.trim()) continue
      const references = measure.formula.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
      for (const reference of references) {
        if (!measureIds.has(reference)) {
          errors.push(`指标 ${measure.id} 的公式引用了不存在的指标: ${reference}`)
        }
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
    const dataRevision = safeRevision(this.db)
    const cacheKey = queryCacheKey(spec)
    const cached = this.db.getQueryCache?.(cacheKey, dataRevision)
    if (cached) {
      return {
        ...cached,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2))
      }
    }
    const profiles = this.profile(spec.scope)
    const errors = this.validate(spec, profiles)
    if (errors.length) throw new Error(`QuerySpec 校验失败: ${errors.join('；')}`)
    const records = scanRecords(this.db, spec.scope)
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
    rows = calculatedRows(rows, dimensions, spec.measures)
    rows = calculatedFormulaRows(rows, spec.measures)
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
    const dataset: QueryDataset = {
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
    this.db.saveQueryCache?.(cacheKey, dataRevision, dataset)
    return dataset
  }
}
