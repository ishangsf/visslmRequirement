import type {
  ChatDataRow,
  ChatDataView,
  ChatSource,
  FieldDefinitionNormalizedType,
  AssistantPlanFilter
} from '../../../shared/types'
import type { DataScope, FilterSpec } from '../../../shared/query-spec'
import { AppDatabase, type FieldQueryFilter, type FieldQueryResult } from '../../database'
import { QueryEngine } from '../../analytics/query-engine'
import {
  compactContextValue,
  compactEvidenceJson,
  compactRecordUids,
  sanitizeContextText
} from '../../context-budget'
import { assertAssistantAgentToolAllowed } from '../agent-registry'

const MODEL_TOOL_TEXT_LIMIT = 4_096
const MODEL_TOOL_FIELD_LIMIT = 512

export type DataCenterPlanIntent =
  | 'conversation'
  | 'schema_inspection'
  | 'total'
  | 'field_aggregate'
  | 'count_matching'
  | 'record_lookup'
  | 'filter_records'
  | 'analyze_records'
  | 'search_content'

export interface DataCenterQueryPlan {
  sourceMode: 'conversation' | 'records' | 'knowledge' | 'mixed'
  needsClarification: boolean
  clarificationQuestion?: string
  evidenceLimit?: number
  resultMode: 'answer' | 'list' | 'grouped_list' | 'table' | 'dashboard'
  groupEntities: string[]
  intent: DataCenterPlanIntent
  explanation: string
  nodeType?: string
  searchTerms: string[]
  searchMode: 'any' | 'all'
  filters: Array<{
    field: string
    operator:
      | 'equals'
      | 'not_equals'
      | 'contains'
      | 'not_contains'
      | 'is_empty'
      | 'not_empty'
      | 'gt'
      | 'gte'
      | 'lt'
      | 'lte'
    value?: string
  }>
  fields: string[]
  groupByField?: string
  metric?: 'record_count' | 'image_count' | 'count_by_type' | 'count_by_project'
  sort?: { field: string; direction: 'asc' | 'desc' }
  limit: number
  /** Effective scope after plan confirmation.  Omitted for legacy callers. */
  scope?: DataScope
}

export interface DataCenterFieldCatalogEntry {
  field: string
  displayName?: string
  role?: 'dimension' | 'measure' | 'time' | 'identifier'
  synonyms: string[]
  kind: 'technical' | 'business'
  declaredType?: FieldDefinitionNormalizedType
  sourceType?: string
  attrType?: string
  types: string[]
  coverageRate: number
  samples: string[]
}

export interface DataCenterFieldCatalog {
  nodeTypes: string[]
  fields: DataCenterFieldCatalogEntry[]
}

export interface AmbiguousSemanticAlias {
  alias: string
  fields: string[]
}

const normalizeSemanticAlias = (value: string): string => value
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase()

/**
 * Resolve only user-maintained aliases. When one mentioned alias points to
 * multiple real fields the planner must stop instead of choosing a field.
 */
export const findAmbiguousSemanticAliases = (
  question: string,
  catalog: DataCenterFieldCatalogEntry[]
): AmbiguousSemanticAlias[] => {
  const normalizedQuestion = normalizeSemanticAlias(question)
  const fieldsByAlias = new Map<string, Set<string>>()
  for (const field of catalog) {
    for (const synonym of field.synonyms) {
      const alias = normalizeSemanticAlias(synonym)
      if (!alias) continue
      const fields = fieldsByAlias.get(alias) ?? new Set<string>()
      fields.add(field.field)
      fieldsByAlias.set(alias, fields)
    }
  }
  return [...fieldsByAlias.entries()]
    .filter(([alias, fields]) => fields.size > 1 && normalizedQuestion.includes(alias))
    .map(([alias, fields]) => ({ alias, fields: [...fields].sort() }))
    .sort((left, right) => left.alias.localeCompare(right.alias))
}

export interface DataCenterExecution {
  toolName: string
  args: Record<string, unknown>
  result: unknown
}

const compactModelToolRaw = (value: unknown): Record<string, unknown> => {
  const compacted = compactContextValue(value, {
    maxStringChars: MODEL_TOOL_FIELD_LIMIT,
    maxArrayItems: 12,
    maxObjectEntries: 40,
    maxDepth: 3
  })
  return compacted && typeof compacted === 'object' && !Array.isArray(compacted)
    ? compacted as Record<string, unknown>
    : {}
}

const compactModelToolFieldValue = (value: string | string[]): string | string[] => {
  const compacted = compactContextValue(value, {
    maxStringChars: MODEL_TOOL_FIELD_LIMIT,
    maxArrayItems: 12,
    maxObjectEntries: 12,
    maxDepth: 2
  })
  if (Array.isArray(compacted)) return compacted.map((item) => String(item))
  return String(compacted ?? '')
}

const scopeFilterToDatabaseFilter = (filter: FilterSpec | AssistantPlanFilter): {
  field: string
  operator:
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'not_contains'
    | 'is_empty'
    | 'not_empty'
    | 'gt'
    | 'gte'
    | 'lt'
    | 'lte'
  value?: string
} => ({
  field: String(filter.field ?? '').trim(),
  operator: filter.operator === 'notEquals'
    ? 'not_equals'
    : filter.operator === 'notContains'
      ? 'not_contains'
      : filter.operator === 'empty'
        ? 'is_empty'
        : filter.operator === 'notEmpty'
          ? 'not_empty'
          : filter.operator as ReturnType<typeof scopeFilterToDatabaseFilter>['operator'],
  ...(filter.value === undefined ? {} : { value: String(filter.value) })
})

const normalizedStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

const normalizeGroupValue = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')

/** Keep the UID index key in the same form used by database search terms. */
const normalizeGroupTerm = (value: string): string => value
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase()

export class DataCenterAgent {
  constructor(private readonly db: AppDatabase) {}

  inspectCatalog(projectId?: string): DataCenterFieldCatalog {
    assertAssistantAgentToolAllowed('data-center', 'inspect_fields')
    const profile = this.db.inspectFields({ projectId, limit: 100 })
    const semanticProfiles = (() => {
      try {
        return new QueryEngine(this.db).profile(projectId ? { projectIds: [projectId] } : {})
      } catch {
        return []
      }
    })()
    const semanticsByField = new Map(semanticProfiles.map((field) => [field.field, field]))
    return {
      nodeTypes: this.db.listNodeTypes(),
      fields: profile.fields.map((field) => {
        const semantics = semanticsByField.get(field.field)
        return {
          field: field.field,
          ...(semantics?.displayName || field.displayName
            ? { displayName: semantics?.displayName || field.displayName }
            : {}),
          ...(semantics?.role ? { role: semantics.role } : {}),
          synonyms: [...new Set(semantics?.synonyms ?? [])],
          kind: /^_valm_|^(Record|uid|parentId|projectId|nodeType)$/i.test(field.field)
            ? 'technical' as const
            : 'business' as const,
          ...(field.declaredType ? { declaredType: field.declaredType } : {}),
          ...(field.sourceType ? { sourceType: field.sourceType } : {}),
          ...(field.attrType ? { attrType: field.attrType } : {}),
          types: field.types,
          coverageRate: field.coverageRate,
          samples: field.samples.slice(0, 3)
        }
      })
    }
  }

  executePlan(projectId: string | undefined, plan: DataCenterQueryPlan): DataCenterExecution {
    let toolName: string
    let args: Record<string, unknown>
    let result: unknown
    const scope = plan.scope
    const scopeProjectIds = scope?.projectIds
    const scopeNodeTypes = scope?.nodeTypes
    const scopeRecordUids = scope?.recordUids
    const scopeBaseFilters = scope?.baseFilters?.map(scopeFilterToDatabaseFilter)
    const scopeArguments = {
      ...(scopeProjectIds === undefined ? {} : { project_ids: scopeProjectIds }),
      ...(scopeNodeTypes === undefined ? {} : { node_types: scopeNodeTypes }),
      ...(scopeRecordUids === undefined ? {} : { record_uids: scopeRecordUids }),
      ...(scopeBaseFilters === undefined ? {} : { base_filters: scopeBaseFilters }),
      ...(scopeProjectIds !== undefined && scopeProjectIds.length === 0 ? { scope_all_projects: true } : {}),
      ...(scopeNodeTypes !== undefined && scopeNodeTypes.length === 0 ? { scope_all_node_types: true } : {})
    }
    if (plan.intent === 'schema_inspection') {
      toolName = 'inspect_fields'
      args = {
        project_id: projectId,
        node_type: plan.nodeType,
        limit: plan.limit,
        ...scopeArguments
      }
      result = this.executeTool(toolName, args, projectId)
    } else if (plan.intent === 'total') {
      toolName = 'aggregate_records'
      args = {
        metric: plan.metric ?? 'record_count',
        project_id: projectId,
        filters: plan.filters,
        ...scopeArguments
      }
      result = this.executeTool(toolName, args, projectId)
    } else if (plan.intent === 'field_aggregate') {
      toolName = 'aggregate_by_field'
      args = {
        field: plan.groupByField,
        project_id: projectId,
        node_type: plan.nodeType,
        limit: plan.limit,
        split_multi_value: true,
        filters: plan.filters,
        ...scopeArguments
      }
      result = this.executeTool(toolName, args, projectId)
    } else {
      toolName = 'query_records_by_fields'
      assertAssistantAgentToolAllowed('data-center', toolName)
      const effectiveSearchTerms = plan.resultMode === 'grouped_list'
        ? [...plan.searchTerms, ...plan.groupEntities]
            .map((term) => String(term).trim())
            .filter(Boolean)
            .filter((term, index, terms) => (
              terms.findIndex((candidate) => normalizeGroupTerm(candidate) === normalizeGroupTerm(term)) === index
            ))
            .slice(0, 12)
        : plan.searchTerms
      args = {
        project_id: projectId,
        node_type: plan.nodeType,
        ...scopeArguments,
        search_terms: effectiveSearchTerms,
        search_mode: plan.searchMode,
        filters: plan.filters,
        fields: plan.fields,
        sort: plan.sort,
        limit: plan.limit,
        result_mode: plan.resultMode,
        group_entities: plan.groupEntities
      }
      result = this.db.queryRecordsByFields({
        ...(scopeProjectIds === undefined
          ? { projectId }
          : scopeProjectIds.length ? { projectIds: scopeProjectIds } : {}),
        ...(scopeNodeTypes === undefined
          ? { nodeType: plan.nodeType }
          : scopeNodeTypes.length ? { nodeTypes: scopeNodeTypes } : {}),
        ...(scopeRecordUids === undefined ? {} : { recordUids: scopeRecordUids }),
        searchTerms: effectiveSearchTerms,
        searchMode: plan.searchMode,
        baseFilters: scopeBaseFilters,
        filters: plan.filters,
        fields: plan.fields,
        sort: plan.sort,
        limit: plan.limit
      })
    }
    assertAssistantAgentToolAllowed('data-center', toolName)
    return { toolName, args, result }
  }

  hasEvidence(toolName: string, result: unknown): boolean {
    if (toolName === 'search_records' && Array.isArray(result)) return result.length > 0
    if (!result || typeof result !== 'object' || Array.isArray(result)) return false
    const value = result as Record<string, unknown>
    if (toolName === 'get_record_detail') return Boolean((value.source as ChatSource | undefined)?.uid)
    if (toolName === 'query_records_by_fields') {
      return Number(value.matchedCount ?? 0) > 0 && Array.isArray(value.records) && value.records.length > 0
    }
    if (toolName === 'inspect_fields') {
      return Number(value.totalRecords ?? 0) > 0 || (Array.isArray(value.fields) && value.fields.length > 0)
    }
    if (toolName === 'aggregate_records') return Number.isFinite(Number(value.value))
    if (toolName === 'aggregate_by_field') {
      return Number(value.totalRecords ?? 0) > 0 || (Array.isArray(value.items) && value.items.length > 0)
    }
    return false
  }

  /** Compatibility surface for the old tool loop; all record tools stay here. */
  executeTool(
    name: string,
    args: Record<string, unknown>,
    selectedProjectId?: string
  ): unknown {
    assertAssistantAgentToolAllowed('data-center', name)
    const projectIds = normalizedStringArray(args.project_ids)
    const nodeTypes = normalizedStringArray(args.node_types)
    const recordUids = normalizedStringArray(args.record_uids)
    const fallbackProjectId = args.scope_all_projects === true
      ? undefined
      : String(args.project_id ?? selectedProjectId ?? '') || undefined
    if (name === 'search_records') {
      const results = this.db.searchForAgent(
        String(args.query ?? ''),
        fallbackProjectId,
        Math.min(20, Math.max(1, Number(args.limit ?? 8)))
      )
      return results.map((item) => ({
        ...item,
        text: sanitizeContextText(item.text, MODEL_TOOL_TEXT_LIMIT),
        raw: compactModelToolRaw(item.raw)
      }))
    }
    if (name === 'inspect_fields') {
      const result = this.db.inspectFields({
        ...(projectIds === undefined
          ? { projectId: fallbackProjectId }
          : { projectIds: args.scope_all_projects === true ? undefined : projectIds }),
        ...(nodeTypes === undefined
          ? { nodeType: String(args.node_type ?? '') || undefined }
          : { nodeTypes: args.scope_all_node_types === true ? undefined : nodeTypes }),
        ...(recordUids === undefined
          ? {}
          : { recordUids }),
        search: String(args.search ?? '') || undefined,
        limit: Math.min(100, Math.max(1, Number(args.limit ?? 40)))
      })
      return {
        ...result,
        usage: '字段画像只用于确认真实字段名，不能代表目标记录的属性值。若用户询问记录属性，请继续调用 query_records_by_fields，并在 fields 中列出所需真实字段。'
      }
    }
    if (name === 'query_records_by_fields') {
      const filters = Array.isArray(args.filters)
        ? args.filters
            .filter((filter): filter is Record<string, unknown> =>
              Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter)
            )
            .map((filter) => ({
              field: String(filter.field ?? ''),
              operator: String(filter.operator ?? 'equals') as
                | 'equals'
                | 'not_equals'
                | 'contains'
                | 'not_contains'
                | 'is_empty'
                | 'not_empty'
                | 'gt'
                | 'gte'
                | 'lt'
                | 'lte',
              value: filter.value === undefined ? undefined : String(filter.value)
            }))
        : []
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => String(field))
        : []
      const searchTerms = Array.isArray(args.search_terms)
        ? args.search_terms.map((term) => String(term))
        : String(args.search ?? '').trim()
          ? [String(args.search)]
          : []
      const sortInput =
        args.sort && typeof args.sort === 'object' && !Array.isArray(args.sort)
          ? args.sort as Record<string, unknown>
          : null
      const result = this.db.queryRecordsByFields({
        ...(projectIds === undefined
          ? { projectId: fallbackProjectId }
          : { projectIds: args.scope_all_projects === true ? undefined : projectIds }),
        ...(nodeTypes === undefined
          ? { nodeType: String(args.node_type ?? '') || undefined }
          : { nodeTypes: args.scope_all_node_types === true ? undefined : nodeTypes }),
        ...(recordUids === undefined
          ? {}
          : { recordUids }),
        search: String(args.search ?? '') || undefined,
        searchTerms,
        searchMode: args.search_mode === 'all' ? 'all' : 'any',
        baseFilters: Array.isArray(args.base_filters)
          ? args.base_filters
              .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
              .map((filter) => ({
                field: String(filter.field ?? ''),
                operator: String(filter.operator ?? 'equals') as FieldQueryFilter['operator'],
                value: filter.value === undefined ? undefined : String(filter.value)
              }))
          : [],
        filters,
        fields,
        sort: sortInput?.field
          ? {
              field: String(sortInput.field),
              direction: sortInput.direction === 'asc' ? 'asc' : 'desc'
            }
          : undefined,
        limit: Math.min(50, Math.max(1, Number(args.limit ?? 10)))
      })
      return {
        ...result,
        records: result.records.map((record) => ({
          ...record,
          values: Object.fromEntries(
            Object.entries(record.values).map(([field, value]) => [
              field,
              compactModelToolFieldValue(value)
            ])
          )
        }))
      }
    }
    if (name === 'get_record_detail') {
      const detail = this.db.getRecord(String(args.uid ?? ''), false)
      if (!detail) return { error: '记录不存在' }
      return {
        source: {
          uid: detail.uid,
          name: detail.name,
          nodeType: detail.nodeType,
          itemId: detail.itemId,
          sourceType: 'record' as const
        },
        text: sanitizeContextText(detail.normalizedText, MODEL_TOOL_TEXT_LIMIT),
        raw: compactModelToolRaw(detail.raw),
        ...(detail.fieldLabels && Object.keys(detail.fieldLabels).length
          ? {
              fieldLabels: Object.fromEntries(
                Object.entries(detail.fieldLabels).map(([field, label]) => [
                  field,
                  sanitizeContextText(label, 160)
                ])
              )
            }
          : {})
      }
    }
    if (name === 'aggregate_records') {
      return this.db.aggregate(
        String(args.metric ?? 'count_by_type'),
        fallbackProjectId,
        {
          ...(projectIds === undefined || args.scope_all_projects === true ? {} : { projectIds }),
          ...(nodeTypes === undefined || args.scope_all_node_types === true ? {} : { nodeTypes }),
          ...(recordUids === undefined ? {} : { recordUids }),
          filters: Array.isArray(args.filters)
            ? args.filters
                .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
                .map((filter) => ({
                  field: String(filter.field ?? ''),
                  operator: String(filter.operator ?? 'equals') as FieldQueryFilter['operator'],
                  value: filter.value === undefined ? undefined : String(filter.value)
                }))
            : [],
          baseFilters: Array.isArray(args.base_filters)
            ? args.base_filters
                .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
                .map((filter) => ({
                  field: String(filter.field ?? ''),
                  operator: String(filter.operator ?? 'equals') as FieldQueryFilter['operator'],
                  value: filter.value === undefined ? undefined : String(filter.value)
                }))
            : []
        }
      )
    }
    if (name === 'aggregate_by_field') {
      return this.db.aggregateByField({
        field: String(args.field ?? ''),
        ...(projectIds === undefined
          ? { projectId: fallbackProjectId }
          : { projectIds: args.scope_all_projects === true ? undefined : projectIds }),
        ...(nodeTypes === undefined
          ? { nodeType: String(args.node_type ?? '') || undefined }
          : { nodeTypes: args.scope_all_node_types === true ? undefined : nodeTypes }),
        ...(recordUids === undefined
          ? {}
          : { recordUids }),
        filters: Array.isArray(args.filters)
          ? args.filters
              .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
              .map((filter) => ({
                field: String(filter.field ?? ''),
                operator: String(filter.operator ?? 'equals') as
                  | 'equals'
                  | 'not_equals'
                  | 'contains'
                  | 'not_contains'
                  | 'is_empty'
                  | 'not_empty'
                  | 'gt'
                  | 'gte'
                  | 'lt'
                  | 'lte',
                value: filter.value === undefined ? undefined : String(filter.value)
              }))
          : [],
        baseFilters: Array.isArray(args.base_filters)
          ? args.base_filters
              .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
              .map((filter) => ({
                field: String(filter.field ?? ''),
                operator: String(filter.operator ?? 'equals') as
                  | 'equals'
                  | 'not_equals'
                  | 'contains'
                  | 'not_contains'
                  | 'is_empty'
                  | 'not_empty'
                  | 'gt'
                  | 'gte'
                  | 'lt'
                  | 'lte',
                value: filter.value === undefined ? undefined : String(filter.value)
              }))
          : [],
        limit: Math.min(50, Math.max(1, Number(args.limit ?? 10))),
        splitMultiValue: args.split_multi_value !== false
      })
    }
    return { error: `未知数据中心工具 ${name}` }
  }

  createDataView(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    selectedProjectId?: string
  ): ChatDataView | null {
    assertAssistantAgentToolAllowed('data-center', toolName)
    const toRow = (record: {
      source: ChatSource
      values?: Record<string, string | string[]>
    }): ChatDataRow => ({
      uid: record.source.uid,
      name: record.source.name,
      nodeType: record.source.nodeType,
      itemId: record.source.itemId,
      values: record.values ?? {}
    })

    if (toolName === 'aggregate_by_field' && result && typeof result === 'object') {
      const aggregate = result as {
        field?: string
        totalRecords?: number
        matchedRecords?: number
        emptyRecords?: number
        splitMultiValue?: boolean
        items?: Array<{ name?: string; value?: number }>
      }
      const field = String(aggregate.field ?? args.field ?? '').trim()
      if (!field || !aggregate.items?.length) return null
      const projectIds = normalizedStringArray(args.project_ids)
      const nodeTypes = normalizedStringArray(args.node_types)
      const recordUids = normalizedStringArray(args.record_uids)
      const baseFilters: FieldQueryFilter[] = Array.isArray(args.base_filters)
        ? args.base_filters
            .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter))
            .map((filter) => ({
              field: String(filter.field ?? ''),
              operator: String(filter.operator ?? 'equals') as FieldQueryFilter['operator'],
              value: filter.value === undefined ? undefined : String(filter.value)
            }))
        : []
      const fieldLabels = this.db.getFieldDisplayNames(
        nodeTypes?.length ? nodeTypes : String(args.node_type ?? '').trim(),
        [field]
      )
      const groups = aggregate.items.slice(0, 5).map((item) => {
        const groupName = String(item.name ?? '')
        const query = this.db.queryRecordsByFields({
          ...(projectIds === undefined
            ? { projectId: args.scope_all_projects === true ? undefined : String(args.project_id ?? selectedProjectId ?? '') || undefined }
            : { projectIds: args.scope_all_projects === true ? undefined : projectIds }),
          ...(nodeTypes === undefined
            ? { nodeType: String(args.node_type ?? '') || undefined }
            : { nodeTypes: args.scope_all_node_types === true ? undefined : nodeTypes }),
          ...(recordUids === undefined ? {} : { recordUids }),
          filters: [...baseFilters, { field, operator: 'contains', value: groupName }],
          fields: [field],
          limit: 100
        })
        return {
          name: groupName,
          count: Number(item.value ?? query.matchedCount),
          rows: query.records.map(toRow)
        }
      })
      return {
        id: `aggregate-by-field:${field}`,
        title: `${fieldLabels[field] ?? field} 查询数据`,
        description: [
          `统计范围 ${Number(aggregate.totalRecords ?? 0)} 条`,
          `字段非空 ${Number(aggregate.matchedRecords ?? 0)} 条`,
          `空值 ${Number(aggregate.emptyRecords ?? 0)} 条`,
          aggregate.splitMultiValue ? '多值字段已拆分' : '',
          '每个分组最多展示 50 条'
        ].filter(Boolean).join(' · '),
        total: Number(aggregate.matchedRecords ?? 0),
        fields: [field],
        ...(Object.keys(fieldLabels).length ? { fieldLabels } : {}),
        groups
      }
    }

    if (toolName === 'query_records_by_fields' && result && typeof result === 'object') {
      const query = result as FieldQueryResult & {
        records?: Array<{
          source: ChatSource
          values: Record<string, string | string[]>
          matchedTerms?: string[]
        }>
      }
      if (!query.records?.length) return null
      const fields = query.fields ?? []
      const matchedCount = Number(query.matchedCount ?? query.records.length)
      const returnedCountValue = Number(query.returnedCount ?? query.records.length)
      const returnedCount = Math.min(
        matchedCount,
        query.records.length,
        Number.isFinite(returnedCountValue) ? Math.max(0, returnedCountValue) : query.records.length
      )
      const recordUids = compactRecordUids(
        query.recordUids ?? query.records.map((record) => record.source.uid)
      )
      const fieldLabels = query.fieldLabels ?? this.db.getFieldDisplayNames(
        String(args.node_type ?? '').trim(),
        fields
      )
      const groupEntities = Array.isArray(args.group_entities)
        ? args.group_entities.map((entity) => String(entity).trim()).filter(Boolean).slice(0, 12)
        : []
      const recordUidsByTerm = query.recordUidsByTerm && typeof query.recordUidsByTerm === 'object'
        ? query.recordUidsByTerm
        : undefined
      const groupUidSnapshot = (entity: string): string[] | undefined => {
        if (!recordUidsByTerm) return undefined
        const normalizedEntity = normalizeGroupTerm(entity)
        const matchingEntry = Object.entries(recordUidsByTerm).find(([term]) => (
          normalizeGroupTerm(term) === normalizedEntity
        ))
        if (!matchingEntry) return undefined
        return compactRecordUids(matchingEntry[1])
      }
      const grouped = args.result_mode === 'grouped_list' && groupEntities.length
        ? groupEntities.map((entity) => {
            const key = normalizeGroupValue(entity)
            const rows = query.records!.filter((record) => {
              const searchable = [
                record.source.name,
                record.source.itemId,
                ...(record.matchedTerms ?? []),
                ...Object.values(record.values).flatMap((value) => Array.isArray(value) ? value : [value])
              ].join(' ')
              return normalizeGroupValue(searchable).includes(key)
              })
            const mappedUids = groupUidSnapshot(entity)
            const visibleUids = mappedUids ? new Set(mappedUids) : undefined
            const groupRecordUids = mappedUids ?? compactRecordUids(rows.map((row) => row.source.uid))
            const groupRows = visibleUids
              ? query.records!.filter((record) => visibleUids.has(record.source.uid))
              : rows
            return {
              name: entity,
              count: groupRecordUids.length,
              recordUids: groupRecordUids,
              rows: groupRows.map(toRow)
            }
          })
        : [{ name: '查询结果', count: matchedCount, rows: query.records.map(toRow) }]
      return {
        id: `field-query:${fields.join(',') || 'records'}`,
        title: args.result_mode === 'grouped_list' && groupEntities.length ? '分组属性查询数据' : '属性查询数据',
        description: `共命中 ${matchedCount} 条，当前展示 ${returnedCount} 条${matchedCount > returnedCount ? '，可分页查看其余记录' : ''}`,
        total: matchedCount,
        recordUids,
        loadedRows: returnedCount,
        isPreview: matchedCount > returnedCount,
        fields,
        ...(Object.keys(fieldLabels).length ? { fieldLabels } : {}),
        groups: grouped
      }
    }

    if (toolName === 'search_records' && Array.isArray(result) && result.length) {
      const records = result.filter(
        (item): item is { source: ChatSource } =>
          Boolean(item) && typeof item === 'object' && Boolean((item as { source?: unknown }).source)
      )
      return {
        id: 'record-search',
        title: '检索到的记录',
        description: `当前展示检索返回的 ${records.length} 条记录`,
        total: records.length,
        fields: [],
        groups: [{ name: '检索结果', count: records.length, rows: records.map(toRow) }]
      }
    }

    if (toolName === 'get_record_detail' && result && typeof result === 'object') {
      const detail = result as {
        source?: ChatSource
        raw?: Record<string, unknown>
        fieldLabels?: Record<string, string>
      }
      if (!detail.source) return null
      const values: Record<string, string | string[]> = {}
      for (const field of ['Source', '_valm_AssignedTo', '_valm_State', '_valm_LastModifyTime']) {
        const value = detail.raw?.[field]
        if (value !== undefined && value !== null) {
          values[field] = typeof value === 'object' ? JSON.stringify(value) : String(value)
        }
      }
      return {
        id: `record-detail:${detail.source.uid}`,
        title: '记录详情',
        description: '当前回答读取的具体记录',
        total: 1,
        fields: Object.keys(values),
        ...(detail.fieldLabels && Object.keys(detail.fieldLabels).length
          ? { fieldLabels: detail.fieldLabels }
          : {}),
        groups: [{ name: '记录', count: 1, rows: [toRow({ source: detail.source, values })] }]
      }
    }
    return null
  }

  renderVerifiedAnswer(
    plan: DataCenterQueryPlan,
    result: unknown,
    modelAnswer: string
  ): string {
    if (plan.intent === 'count_matching' && result && typeof result === 'object') {
      const query = result as { matchedCount?: number }
      const matchedCount = Number(query.matchedCount ?? 0)
      const terms = plan.searchTerms.length ? `检索词：${plan.searchTerms.join('、')}` : ''
      const filters = plan.filters.length
        ? `字段过滤：${plan.filters.map((filter) =>
            `${filter.field} ${filter.operator}${filter.value === undefined ? '' : ` ${filter.value}`}`
          ).join('；')}`
        : ''
      return [
        `根据本轮查询条件，共命中 **${matchedCount}** 条记录。`,
        [terms, filters].filter(Boolean).join('；')
      ].filter(Boolean).join('\n\n')
    }

    if (plan.intent === 'record_lookup' && result && typeof result === 'object') {
      const query = result as {
        records?: Array<{ source: ChatSource; values: Record<string, string | string[]> }>
      }
      const records = query.records ?? []
      if (!records.length) return '本轮查询没有定位到符合条件的记录。'
      const exact = records.find((record) => plan.searchTerms.some((term) =>
        record.source.name.localeCompare(term, undefined, { sensitivity: 'accent' }) === 0 ||
        record.source.itemId.localeCompare(term, undefined, { sensitivity: 'accent' }) === 0
      ))
      if (exact && (plan.fields.length > 0 || records.length === 1)) {
        const properties = plan.fields.map((field) => {
          const value = exact.values[field]
          const display = Array.isArray(value) ? value.join('、') : value || '未设置'
          return `- ${field}：${display}`
        })
        return [`记录“${exact.source.name}”的查询结果：`, ...properties, `[UID:${exact.source.uid}]`].join('\n')
      }
    }

    if (
      ['record_lookup', 'filter_records', 'search_content'].includes(plan.intent) &&
      result && typeof result === 'object'
    ) {
      const query = result as {
        matchedCount?: number
        returnedCount?: number
        recordUidsByTerm?: Record<string, string[]>
        records?: Array<{ source: ChatSource; matchedTerms?: string[] }>
      }
      const records = query.records ?? []
      const matchedCount = Number(query.matchedCount ?? records.length)
      if (!records.length) return '本轮查询条件下没有找到相关记录。'
      const visibleLimit = Number.isFinite(plan.limit) ? Math.min(50, Math.max(1, plan.limit)) : 50
      const visibleRecords = records.slice(0, visibleLimit)
      const returnedCountValue = Number(query.returnedCount ?? records.length)
      const returnedCount = Math.min(
        matchedCount,
        records.length,
        Number.isFinite(returnedCountValue) ? Math.max(0, returnedCountValue) : records.length
      )
      const criteria = plan.searchTerms.length ? `与“${plan.searchTerms.join('、')}”相关` : '符合筛选条件'
      if (plan.resultMode === 'grouped_list' && plan.groupEntities.length) {
        const completeGroupCount = (entity: string, fallback: number): number => {
          const normalizedEntity = normalizeGroupTerm(entity)
          const entry = Object.entries(query.recordUidsByTerm ?? {}).find(([term]) => (
            normalizeGroupTerm(term) === normalizedEntity
          ))
          return entry ? compactRecordUids(entry[1]).length : fallback
        }
        const groups = plan.groupEntities.map((entity) => {
          const key = normalizeGroupValue(entity)
          const groupRecords = visibleRecords.filter((record) => {
            const searchable = [
              record.source.name,
              record.source.itemId,
              ...((record as { matchedTerms?: string[] }).matchedTerms ?? [])
            ].join(' ')
            return normalizeGroupValue(searchable).includes(key)
          })
          const lines = groupRecords.map((record, index) => {
            const source = record.source
            const metadata = [source.nodeType, source.itemId].filter(Boolean).join(' · ')
            const citation = source.uid ? ` [UID:${source.uid}]` : ''
            return `${index + 1}. ${source.name || '未命名记录'}${metadata ? `（${metadata}）` : ''}${citation}`
          })
          const groupCount = completeGroupCount(entity, groupRecords.length)
          const countLabel = groupRecords.length < groupCount
            ? `共 ${groupCount} 条，当前列出 ${groupRecords.length} 条`
            : `${groupCount} 条`
          return [`### ${entity}（${countLabel}）`, ...(lines.length ? lines : ['暂无匹配记录。'])].join('\n')
        })
        const remainder = Math.max(0, matchedCount - returnedCount)
        return [
          `按用户指定实体分别列出，共命中 **${matchedCount}** 条${criteria}的记录：`,
          '',
          ...groups,
          '',
          remainder > 0
            ? `本次返回 **${returnedCount}** 条，另有 ${remainder} 条超过返回上限未展开；请点击“查看查询数据”或分页查看。`
            : `本次返回 **${returnedCount}** 条，可点击“查看查询数据”查看每条记录的完整属性。`
        ].join('\n')
      }
      const list = visibleRecords.map((record, index) => {
        const source = record.source
        const metadata = [source.nodeType, source.itemId].filter(Boolean).join(' · ')
        const citation = source.uid ? ` [UID:${source.uid}]` : ''
        return `${index + 1}. ${source.name || '未命名记录'}${metadata ? `（${metadata}）` : ''}${citation}`
      })
      const remainder = Math.max(0, matchedCount - returnedCount)
      return [
        `共找到 **${matchedCount}** 条${criteria}的记录：`,
        '',
        ...list,
        ...(remainder > 0
          ? ['', `本次返回 **${returnedCount}** 条，另有 ${remainder} 条超过返回上限未展开；请点击“查看查询数据”或缩小范围后分页查看。`]
          : ['', `本次返回 **${returnedCount}** 条，可点击“查看查询数据”查看每条记录的完整属性。`])
      ].join('\n')
    }

    if (plan.intent === 'field_aggregate' && result && typeof result === 'object') {
      const aggregate = result as {
        field?: string
        items?: Array<{ name: string; value: number }>
        matchedRecords?: number
        totalRecords?: number
        splitMultiValue?: boolean
      }
      if (aggregate.items?.length) {
        return [
          `按 ${aggregate.field ?? plan.groupByField ?? '指定字段'} 统计结果：`,
          ...aggregate.items.map((item, index) => `${index + 1}. ${item.name}：${item.value} 条`),
          `统计口径：${aggregate.matchedRecords ?? 0}/${aggregate.totalRecords ?? 0} 条记录字段非空${aggregate.splitMultiValue ? '，多值已拆分计数' : ''}。`
        ].join('\n')
      }
    }

    if (plan.intent === 'total' && result && typeof result === 'object' && !Array.isArray(result)) {
      const total = result as { metric?: string; value?: number }
      if (Number.isFinite(Number(total.value))) {
        return `查询结果：${Number(total.value)}。统计指标：${total.metric ?? plan.metric ?? '总量'}。`
      }
    }
    return modelAnswer
  }
}
