import type { AssistantExecutionSummary } from '../../shared/expert-types'
import type {
  AssistantIntentResultMode,
  AssistantPlanFilter,
  AssistantPlanPatch,
  AssistantPlanFilterOperator,
  ConfirmAgentPlanError,
  ConfirmAgentPlanWarning
} from '../../shared/types'
import type { DataScope, FilterSpec } from '../../shared/query-spec'

const MAX_SEARCH_TERMS = 10
const MAX_FIELDS = 20
const MAX_SCOPE_VALUES = 100
const MAX_FILTERS_PER_GROUP = 10
const MAX_FILTERS_TOTAL = 10
const MAX_VALUE_LENGTH = 240
const MAX_RECORD_LIMIT = 50
const MAX_KNOWLEDGE_LIMIT = 20

const assistantPlanOperators = new Set<AssistantPlanFilterOperator>([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'not_empty',
  'gt',
  'gte',
  'lt',
  'lte'
])

type SummaryResultMode = AssistantExecutionSummary['resultMode']

const resultModes = new Set<SummaryResultMode>([
  'answer',
  'list',
  'grouped_list',
  'table',
  'dashboard'
])

const controlCharacterPattern = /[\u0000-\u001F\u007F]/u

export interface AssistantPlanFieldMetadata {
  field: string
  displayName?: string
  /** Fields marked false are visible metadata but cannot be queried. */
  allowed?: boolean
  /** Data types in which this field is available. Empty means all types. */
  types?: readonly string[]
}

export interface AssistantPlanValidationMetadata {
  fields?: readonly AssistantPlanFieldMetadata[]
  projectIds?: readonly string[]
  nodeTypes?: readonly string[]
}

export interface AssistantPlanConfirmationInput {
  summary: AssistantExecutionSummary
  /** The precise scope used by the executor, including immutable recordUids. */
  dataScope?: DataScope
  metadata?: AssistantPlanValidationMetadata
}

export interface ConfirmedAssistantPlan {
  effectiveSummary: AssistantExecutionSummary
  effectiveDataScope: DataScope
  warnings: ConfirmAgentPlanWarning[]
}

export type AssistantPlanValidationResult =
  | { ok: true; plan: ConfirmedAssistantPlan }
  | { ok: false; errors: ConfirmAgentPlanError[]; warnings: ConfirmAgentPlanWarning[] }

type MutableRecord = Record<string, unknown>

const isRecord = (value: unknown): value is MutableRecord => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const text = (value: unknown): string => typeof value === 'string'
  ? value.normalize('NFKC').trim()
  : ''

const key = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase()

const error = (field: string, code: string, message: string): ConfirmAgentPlanError => ({
  field,
  code,
  message
})

const warning = (field: string, code: string, message: string): ConfirmAgentPlanWarning => ({
  field,
  code,
  message
})

const uniqueTextValues = (
  value: unknown,
  field: string,
  max: number,
  errors: ConfirmAgentPlanError[],
  invalidCode: string,
  emptyItemsAreInvalid = false
): string[] | undefined => {
  if (!Array.isArray(value)) {
    errors.push(error(field, invalidCode, `${field} 必须是数组`))
    return undefined
  }
  const values: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(error(field, invalidCode, `${field} 每项必须是字符串`))
      continue
    }
    const normalized = text(item)
    if (!normalized) {
      if (emptyItemsAreInvalid) errors.push(error(field, invalidCode, `${field} 不能包含空项`))
      continue
    }
    if (normalized.length > MAX_VALUE_LENGTH) {
      errors.push(error(field, invalidCode, `${field} 每项不能超过 ${MAX_VALUE_LENGTH} 个字符`))
      continue
    }
    if (controlCharacterPattern.test(normalized)) {
      errors.push(error(field, invalidCode, `${field} 不能包含控制字符`))
      continue
    }
    const normalizedKey = key(normalized)
    if (seen.has(normalizedKey)) continue
    seen.add(normalizedKey)
    values.push(normalized)
  }
  if (values.length > max) {
    errors.push(error(field, invalidCode, `${field} 最多允许 ${max} 项`))
  }
  return values.slice(0, max)
}

const canonicalValue = (
  value: unknown,
  allowed: readonly string[] | undefined,
  field: string,
  notFoundCode: string,
  errors: ConfirmAgentPlanError[]
): string | undefined => {
  const normalized = text(value)
  if (!normalized) return undefined
  if (!allowed?.length) return normalized
  const match = allowed.find((candidate) => key(candidate) === key(normalized))
  if (!match) {
    errors.push(error(field, notFoundCode, `${field} 不存在或当前用户无权使用`))
    return undefined
  }
  return text(match)
}

const fieldEntry = (
  value: unknown,
  metadata: AssistantPlanValidationMetadata | undefined,
  nodeTypes: readonly string[],
  field: string,
  errors: ConfirmAgentPlanError[],
  required = true
): string | undefined => {
  const requested = text(value)
  if (!requested) {
    if (required) errors.push(error(field, 'FIELD_NOT_FOUND', '字段不能为空'))
    return undefined
  }
  const fields = metadata?.fields
  if (!fields?.length) {
    errors.push(error(field, 'FIELD_NOT_ALLOWED', '当前数据范围没有可用字段目录，无法确认该字段'))
    return undefined
  }
  const match = fields.find((candidate) => (
    key(candidate.field) === key(requested) || key(candidate.displayName ?? '') === key(requested)
  ))
  if (!match) {
    errors.push(error(field, 'FIELD_NOT_FOUND', `字段不存在：${requested}`))
    return undefined
  }
  if (match.allowed === false) {
    errors.push(error(field, 'FIELD_NOT_ALLOWED', `字段不可用于当前任务：${match.field}`))
    return undefined
  }
  const supportedTypes = (match.types ?? []).map(text).filter(Boolean)
  if (
    nodeTypes.length &&
    supportedTypes.length &&
    !nodeTypes.some((nodeType) => supportedTypes.some((candidate) => key(candidate) === key(nodeType)))
  ) {
    errors.push(error(field, 'FIELD_NOT_ALLOWED', `字段 ${match.field} 与当前数据类型不兼容`))
    return undefined
  }
  return text(match.field)
}

const normalizeOperator = (value: unknown): AssistantPlanFilterOperator | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim()
  if (assistantPlanOperators.has(normalized as AssistantPlanFilterOperator)) {
    return normalized as AssistantPlanFilterOperator
  }
  return undefined
}

/** Map legacy DataScope FilterSpec operators without silently dropping them. */
export const normalizeLegacyFilterOperator = (value: unknown): AssistantPlanFilterOperator | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim()
  const aliases: Record<string, AssistantPlanFilterOperator> = {
    equals: 'equals',
    notEquals: 'not_equals',
    contains: 'contains',
    notContains: 'not_contains',
    empty: 'is_empty',
    notEmpty: 'not_empty',
    gt: 'gt',
    gte: 'gte',
    lt: 'lt',
    lte: 'lte'
  }
  return aliases[normalized]
}

const filterKey = (filter: AssistantPlanFilter): string => [
  key(filter.field),
  filter.operator,
  key(filter.value ?? '')
].join('\u0000')

const normalizeFilters = (
  value: unknown,
  field: string,
  metadata: AssistantPlanValidationMetadata | undefined,
  nodeTypes: readonly string[],
  errors: ConfirmAgentPlanError[],
  options: { legacy: boolean }
): AssistantPlanFilter[] | undefined => {
  if (!Array.isArray(value)) {
    errors.push(error(field, 'FILTER_INVALID', `${field} 必须是数组`))
    return undefined
  }
  if (value.length > MAX_FILTERS_PER_GROUP) {
    errors.push(error(field, 'FILTER_LIMIT_EXCEEDED', `${field} 最多允许 ${MAX_FILTERS_PER_GROUP} 条筛选条件`))
  }
  const normalized: AssistantPlanFilter[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    const itemField = `${field}[${index}]`
    if (!isRecord(item)) {
      errors.push(error(itemField, 'FILTER_INVALID', '筛选条件必须是对象'))
      continue
    }
    const unknownKeys = Object.keys(item).filter((name) => !['field', 'operator', 'value'].includes(name))
    if (unknownKeys.length) {
      errors.push(error(itemField, 'PLAN_PATCH_FIELD_NOT_ALLOWED', `筛选条件包含不允许的字段：${unknownKeys.join('、')}`))
      continue
    }
    const canonicalField = fieldEntry(item.field, metadata, nodeTypes, `${itemField}.field`, errors)
    const operator = options.legacy
      ? normalizeLegacyFilterOperator(item.operator)
      : normalizeOperator(item.operator)
    if (!operator) {
      errors.push(error(`${itemField}.operator`, 'FILTER_INVALID', '筛选操作符不受支持'))
      continue
    }
    const isEmptyOperator = operator === 'is_empty' || operator === 'not_empty'
    if (isEmptyOperator && item.value !== undefined) {
      errors.push(error(`${itemField}.value`, 'FILTER_INVALID', `${operator} 不允许 value`))
      continue
    }
    let filterValue: string | undefined
    if (!isEmptyOperator) {
      if (typeof item.value !== 'string') {
        errors.push(error(`${itemField}.value`, 'FILTER_INVALID', `${operator} 必须提供非空 value`))
        continue
      }
      filterValue = text(item.value)
      if (!filterValue) {
        errors.push(error(`${itemField}.value`, 'FILTER_INVALID', `${operator} 必须提供非空 value`))
        continue
      }
      if (filterValue.length > MAX_VALUE_LENGTH || controlCharacterPattern.test(filterValue)) {
        errors.push(error(`${itemField}.value`, 'FILTER_INVALID', `筛选值不能超过 ${MAX_VALUE_LENGTH} 个字符或包含控制字符`))
        continue
      }
    }
    if (!canonicalField) continue
    const filter: AssistantPlanFilter = {
      field: canonicalField,
      operator,
      ...(filterValue === undefined ? {} : { value: filterValue })
    }
    const dedupeKey = filterKey(filter)
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    normalized.push(filter)
  }
  return normalized.slice(0, MAX_FILTERS_PER_GROUP)
}

const dedupeFilters = (filters: readonly AssistantPlanFilter[]): AssistantPlanFilter[] => {
  const seen = new Set<string>()
  return filters.filter((filter) => {
    const filterKeyValue = filterKey(filter)
    if (seen.has(filterKeyValue)) return false
    seen.add(filterKeyValue)
    return true
  })
}

const toSummaryFilters = (filters: readonly AssistantPlanFilter[]) => filters.map((filter) => ({
  field: filter.field,
  operator: filter.operator,
  ...(filter.value === undefined ? {} : { value: filter.value })
}))

const toScopeFilter = (filter: AssistantPlanFilter): FilterSpec => ({
  field: filter.field,
  operator: filter.operator === 'not_equals'
    ? 'notEquals'
    : filter.operator === 'not_contains'
      ? 'notContains'
      : filter.operator === 'is_empty'
        ? 'empty'
        : filter.operator === 'not_empty'
          ? 'notEmpty'
          : filter.operator,
  ...(filter.value === undefined ? {} : { value: filter.value })
})

const allowedResultModesFor = (
  taskType: string,
  sourceMode: AssistantExecutionSummary['sourceMode']
): readonly SummaryResultMode[] => {
  if (taskType === 'record_query' && sourceMode === 'records') return ['answer', 'list', 'grouped_list', 'table']
  if (taskType === 'knowledge_qa' && sourceMode === 'knowledge') return ['answer']
  if (taskType === 'mixed_analysis' && sourceMode === 'mixed') return ['answer', 'list', 'grouped_list', 'table']
  if (taskType === 'visualization' && sourceMode === 'records') return ['dashboard']
  if (taskType === 'requirement_matching' && sourceMode === 'records') return ['answer']
  return []
}

const supportedPatchField = (
  field: keyof AssistantPlanPatch,
  summary: AssistantExecutionSummary
): boolean => {
  const records = summary.sourceMode === 'records' || summary.sourceMode === 'mixed'
  if (field === 'scope') return records
  if (field === 'resultMode') return true
  if (field === 'searchTerms') {
    return (records || summary.sourceMode === 'knowledge') &&
      summary.taskType !== 'visualization' &&
      summary.taskType !== 'requirement_matching'
  }
  if (field === 'fields' || field === 'filters') return records && summary.taskType !== 'visualization' && summary.taskType !== 'requirement_matching'
  if (field === 'limit') {
    return (records && summary.taskType !== 'visualization' && summary.taskType !== 'requirement_matching') ||
      summary.sourceMode === 'knowledge'
  }
  return false
}

const initialScope = (input: AssistantPlanConfirmationInput): DataScope => {
  const summaryScope = input.summary.scope ?? { projectIds: [], nodeTypes: [], baseFilters: [] }
  return {
    ...(input.dataScope ?? {}),
    projectIds: input.dataScope?.projectIds ?? [...summaryScope.projectIds],
    nodeTypes: input.dataScope?.nodeTypes ?? [...summaryScope.nodeTypes],
    ...(input.dataScope?.recordUids === undefined ? {} : { recordUids: [...input.dataScope.recordUids] }),
    baseFilters: input.dataScope?.baseFilters
      ? [...input.dataScope.baseFilters]
      : summaryScope.baseFilters.map((filter) => ({
          field: filter.field,
          operator: filter.operator as FilterSpec['operator'],
          ...(filter.value === undefined ? {} : { value: filter.value })
        })),
    ...(input.dataScope?.snapshotAt || summaryScope.snapshotAt
      ? { snapshotAt: input.dataScope?.snapshotAt ?? summaryScope.snapshotAt }
      : {})
  }
}

const canonicalScopeValues = (
  value: unknown,
  field: string,
  allowed: readonly string[] | undefined,
  max: number,
  notFoundCode: string,
  errors: ConfirmAgentPlanError[]
): string[] | undefined => {
  if (!Array.isArray(value)) {
    errors.push(error(field, notFoundCode, `${field} 必须是数组`))
    return undefined
  }
  // A scope edit is an authorization-sensitive choice.  Without a catalog
  // gathered in the main process, accepting arbitrary ids would turn the
  // confirmation boundary into an unchecked data-access selector.
  if (!allowed?.length) {
    errors.push(error(field, 'SCOPE_NOT_ALLOWED', `${field} 当前没有可校验的范围目录`))
    return undefined
  }
  const values: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(error(field, notFoundCode, `${field} 每项必须是字符串`))
      continue
    }
    const normalized = text(item)
    if (!normalized) continue
    const canonical = canonicalValue(normalized, allowed, field, notFoundCode, errors)
    if (!canonical || seen.has(key(canonical))) continue
    seen.add(key(canonical))
    values.push(canonical)
  }
  if (values.length > max) errors.push(error(field, notFoundCode, `${field} 最多允许 ${max} 项`))
  return values.slice(0, max)
}

const checkUnknownKeys = (
  value: MutableRecord,
  allowed: readonly string[],
  field: string,
  errors: ConfirmAgentPlanError[]
): void => {
  const unknown = Object.keys(value).filter((name) => !allowed.includes(name))
  if (unknown.length) {
    errors.push(error(field, 'PLAN_PATCH_FIELD_NOT_ALLOWED', `计划 patch 包含不允许的字段：${unknown.join('、')}`))
  }
}

const summaryGroupEntities = (summary: AssistantExecutionSummary): string[] => (
  Array.isArray(summary.groupEntities) ? summary.groupEntities.map(text).filter(Boolean) : []
)

const normalizeExistingSummaryFields = (
  summary: AssistantExecutionSummary,
  metadata: AssistantPlanValidationMetadata | undefined,
  nodeTypes: readonly string[],
  errors: ConfirmAgentPlanError[]
): string[] => {
  const fields: string[] = []
  for (const field of summary.fields ?? []) {
    const canonical = fieldEntry(field, metadata, nodeTypes, 'fields', errors)
    if (canonical && !fields.some((candidate) => key(candidate) === key(canonical))) fields.push(canonical)
  }
  return fields.slice(0, MAX_FIELDS)
}

const normalizeExistingFilters = (
  filters: unknown,
  field: string,
  metadata: AssistantPlanValidationMetadata | undefined,
  nodeTypes: readonly string[],
  errors: ConfirmAgentPlanError[]
): AssistantPlanFilter[] => {
  const normalized = normalizeFilters(filters, field, metadata, nodeTypes, errors, { legacy: true })
  return normalized ?? []
}

/**
 * Validate and freeze a renderer patch against the already trusted route.
 * This function performs no record or document reads; callers provide only
 * metadata gathered before the confirmation card is shown.
 */
export const validateAndApplyAssistantPlanPatch = (
  input: AssistantPlanConfirmationInput,
  patchValue?: unknown
): AssistantPlanValidationResult => {
  const errors: ConfirmAgentPlanError[] = []
  const warnings: ConfirmAgentPlanWarning[] = []
  const summary = input.summary
  const scope = initialScope(input)
  const metadata = input.metadata
  const projectCatalog = metadata?.projectIds?.map(text).filter(Boolean)
  const nodeTypeCatalog = metadata?.nodeTypes?.map(text).filter(Boolean)
  const existingProjectIds = [...new Set(scope.projectIds?.map(text).filter(Boolean) ?? [])]
  const existingNodeTypes = [...new Set(scope.nodeTypes?.map(text).filter(Boolean) ?? [])]
  const resultMode = summary.resultMode
  const allowedResultModes = allowedResultModesFor(summary.taskType, summary.sourceMode)
  if (!allowedResultModes.includes(resultMode)) {
    errors.push(error('resultMode', 'RESULT_MODE_NOT_COMPATIBLE', '当前任务与来源组合不支持该交付形式'))
  }

  const patch = patchValue === undefined ? {} : patchValue
  if (!isRecord(patch)) {
    errors.push(error('patch', 'PLAN_PATCH_FIELD_NOT_ALLOWED', '计划 patch 必须是对象'))
  }
  const patchRecord = isRecord(patch) ? patch : {}
  checkUnknownKeys(
    patchRecord,
    ['searchTerms', 'fields', 'scope', 'filters', 'limit', 'resultMode'],
    'patch',
    errors
  )

  const present = (name: string): boolean => Object.prototype.hasOwnProperty.call(patchRecord, name)
  for (const name of Object.keys(patchRecord)) {
    if (!['searchTerms', 'fields', 'scope', 'filters', 'limit', 'resultMode'].includes(name)) continue
    if (!supportedPatchField(name as keyof AssistantPlanPatch, summary)) {
      errors.push(error(name, 'PLAN_PATCH_FIELD_NOT_ALLOWED', `当前任务不支持编辑 ${name}`))
    }
  }

  const effectiveProjectIds = [...existingProjectIds]
  const effectiveNodeTypes = [...existingNodeTypes]
  let effectiveBaseFilters = normalizeExistingFilters(
    scope.baseFilters ?? summary.scope.baseFilters,
    'scope.baseFilters',
    metadata,
    existingNodeTypes,
    errors
  )
  let effectiveFilters = normalizeExistingFilters(summary.filters, 'filters', metadata, existingNodeTypes, errors)
  let effectiveFields = normalizeExistingSummaryFields(summary, metadata, existingNodeTypes, errors)
  let effectiveSearchTerms = (summary.searchTerms ?? []).map(text).filter(Boolean).slice(0, MAX_SEARCH_TERMS)
  let effectiveLimit = Number.isFinite(summary.limit)
    ? Math.trunc(summary.limit)
    : MAX_RECORD_LIMIT
  effectiveLimit = Math.min(MAX_RECORD_LIMIT, Math.max(1, effectiveLimit))
  let effectiveResultMode: SummaryResultMode = resultMode

  // Resolve scope ids before fields and filters.  A single patch may narrow
  // the node-type scope and select fields at the same time; field compatibility
  // must be checked against that final type scope rather than the old one.
  if (present('scope') && isRecord(patchRecord.scope)) {
    checkUnknownKeys(patchRecord.scope, ['projectIds', 'nodeTypes', 'baseFilters'], 'scope', errors)
    if (Object.prototype.hasOwnProperty.call(patchRecord.scope, 'projectIds')) {
      const values = canonicalScopeValues(
        patchRecord.scope.projectIds,
        'scope.projectIds',
        projectCatalog,
        MAX_SCOPE_VALUES,
        'PROJECT_NOT_FOUND',
        errors
      )
      if (values) effectiveProjectIds.splice(0, effectiveProjectIds.length, ...values)
    }
    if (Object.prototype.hasOwnProperty.call(patchRecord.scope, 'nodeTypes')) {
      const values = canonicalScopeValues(
        patchRecord.scope.nodeTypes,
        'scope.nodeTypes',
        nodeTypeCatalog,
        MAX_SCOPE_VALUES,
        'NODE_TYPE_NOT_FOUND',
        errors
      )
      if (values) effectiveNodeTypes.splice(0, effectiveNodeTypes.length, ...values)
    }
  }

  if (present('searchTerms')) {
    const values = uniqueTextValues(
      patchRecord.searchTerms,
      'searchTerms',
      MAX_SEARCH_TERMS,
      errors,
      'SEARCH_TERMS_INVALID'
    )
    if (values) effectiveSearchTerms = values
  }
  if (present('fields')) {
    if (!Array.isArray(patchRecord.fields)) {
      errors.push(error('fields', 'FIELD_NOT_ALLOWED', 'fields 必须是数组'))
    } else {
      const values: string[] = []
      const seen = new Set<string>()
      if (patchRecord.fields.length > MAX_FIELDS) {
        errors.push(error('fields', 'FIELD_LIMIT_EXCEEDED', `fields 最多允许 ${MAX_FIELDS} 项`))
      }
      for (const item of patchRecord.fields) {
        if (typeof item !== 'string') {
          errors.push(error('fields', 'FIELD_NOT_ALLOWED', 'fields 每项必须是字符串'))
          continue
        }
        const canonical = fieldEntry(item, metadata, effectiveNodeTypes, 'fields', errors, false)
        if (canonical && !seen.has(key(canonical))) {
          seen.add(key(canonical))
          values.push(canonical)
        }
      }
      effectiveFields = values.slice(0, MAX_FIELDS)
    }
  }

  if (present('scope')) {
    if (!isRecord(patchRecord.scope)) {
      errors.push(error('scope', 'PLAN_PATCH_FIELD_NOT_ALLOWED', 'scope 必须是对象'))
    } else {
      if (Object.prototype.hasOwnProperty.call(patchRecord.scope, 'baseFilters')) {
        effectiveBaseFilters = normalizeFilters(
          patchRecord.scope.baseFilters,
          'scope.baseFilters',
          metadata,
          effectiveNodeTypes,
          errors,
          { legacy: false }
        ) ?? []
      }
    }
  }

  if (present('filters')) {
    effectiveFilters = normalizeFilters(
      patchRecord.filters,
      'filters',
      metadata,
      effectiveNodeTypes,
      errors,
      { legacy: false }
    ) ?? []
  }

  if (present('limit')) {
    const candidate = typeof patchRecord.limit === 'number'
      ? patchRecord.limit
      : typeof patchRecord.limit === 'string' && patchRecord.limit.trim()
        ? Number(patchRecord.limit)
        : Number.NaN
    if (!Number.isFinite(candidate)) {
      errors.push(error('limit', 'LIMIT_INVALID', 'limit 必须是有限数'))
    } else {
      const clamped = Math.min(MAX_RECORD_LIMIT, Math.max(1, Math.trunc(candidate)))
      if (clamped !== candidate) {
        warnings.push(warning('limit', 'LIMIT_CLAMPED', `limit 已归一化为 ${clamped}`))
      }
      effectiveLimit = clamped
    }
  }

  if (present('resultMode')) {
    const requested = typeof patchRecord.resultMode === 'string'
      ? patchRecord.resultMode.normalize('NFKC').trim() as AssistantIntentResultMode
      : undefined
    if (!requested || !resultModes.has(requested as SummaryResultMode)) {
      errors.push(error('resultMode', 'RESULT_MODE_NOT_COMPATIBLE', 'resultMode 不受支持'))
    } else {
      effectiveResultMode = requested as SummaryResultMode
    }
  }

  if (effectiveResultMode === 'grouped_list' && summaryGroupEntities(summary).length === 0) {
    errors.push(error('resultMode', 'RESULT_MODE_REQUIRES_GROUP_ENTITIES', 'grouped_list 需要原计划已有有效分组实体'))
  }
  if (!allowedResultModes.includes(effectiveResultMode)) {
    errors.push(error('resultMode', 'RESULT_MODE_NOT_COMPATIBLE', '当前任务与来源组合不支持该交付形式'))
  }

  const combinedFilters = dedupeFilters([...effectiveBaseFilters, ...effectiveFilters])
  if (combinedFilters.length > MAX_FILTERS_TOTAL) {
    errors.push(error('filters', 'FILTER_LIMIT_EXCEEDED', `合并后的筛选条件最多允许 ${MAX_FILTERS_TOTAL} 条`))
  }
  if (summary.sourceMode === 'knowledge' && effectiveLimit > MAX_KNOWLEDGE_LIMIT) {
    warnings.push(warning('limit', 'LIMIT_CLAMPED_FOR_KNOWLEDGE', `知识库文档结果上限已归一化为 ${MAX_KNOWLEDGE_LIMIT}`))
    effectiveLimit = MAX_KNOWLEDGE_LIMIT
  }

  const isBroadRecordIntent = ['total', 'field_aggregate', 'schema_inspection'].includes(summary.intent)
  const hasExplicitRecordScope = Array.isArray(scope.recordUids)
  const hasRecordCriteria = effectiveSearchTerms.length || combinedFilters.length
  if (
    (summary.sourceMode === 'records' || summary.sourceMode === 'mixed') &&
    !isBroadRecordIntent &&
    !hasExplicitRecordScope &&
    !hasRecordCriteria
  ) {
    errors.push(error('scope', 'QUERY_SCOPE_REQUIRED', '记录查询至少需要检索词、筛选条件或明确记录范围'))
  }

  const effectiveBase = dedupeFilters(effectiveBaseFilters)
  const effectiveRoot = dedupeFilters(effectiveFilters.filter((filter) => (
    !effectiveBase.some((baseFilter) => filterKey(baseFilter) === filterKey(filter))
  )))
  if (effectiveBase.length + effectiveRoot.length > MAX_FILTERS_TOTAL) {
    errors.push(error('filters', 'FILTER_LIMIT_EXCEEDED', `合并后的筛选条件最多允许 ${MAX_FILTERS_TOTAL} 条`))
  }
  const effectiveScope: DataScope = {
    ...scope,
    projectIds: [...effectiveProjectIds],
    nodeTypes: [...effectiveNodeTypes],
    baseFilters: effectiveBase.map(toScopeFilter),
    ...(scope.recordUids === undefined ? {} : { recordUids: [...scope.recordUids] })
  }
  const effectiveSummary: AssistantExecutionSummary = {
    ...summary,
    searchTerms: [...effectiveSearchTerms],
    fields: [...effectiveFields],
    filters: toSummaryFilters(effectiveRoot),
    resultMode: effectiveResultMode,
    limit: effectiveLimit,
    scope: {
      ...summary.scope,
      projectIds: [...effectiveProjectIds],
      nodeTypes: [...effectiveNodeTypes],
      baseFilters: toSummaryFilters(effectiveBase),
      ...(scope.recordUids === undefined
        ? {}
        : { recordCount: scope.recordUids.length }),
      ...(scope.snapshotAt ? { snapshotAt: scope.snapshotAt } : {})
    }
  }

  if (errors.length) return { ok: false, errors, warnings }
  return {
    ok: true,
    plan: {
      effectiveSummary,
      effectiveDataScope: effectiveScope,
      warnings
    }
  }
}

export const applyAssistantPlanPatch = validateAndApplyAssistantPlanPatch
