import type { DataCenterFieldCatalogEntry, DataCenterQueryPlan } from './agents/data-center-agent'
import type { FieldQueryResult } from '../database'

export class QueryContractError extends Error {
  constructor(readonly issues: string[], readonly proposedPlan?: unknown) {
    super(`查询计划未通过语义校验：${issues.join('；')}`)
    this.name = 'QueryContractError'
  }
}

const normalize = (value: string): string => value.normalize('NFKC').trim().toLocaleLowerCase()

/** Validation never repairs a query by dropping constraints or broadening its scope. */
export const validateQueryContract = (
  plan: DataCenterQueryPlan,
  catalog: DataCenterFieldCatalogEntry[],
  question: string
): string[] => {
  if (!['records', 'mixed'].includes(plan.sourceMode) || plan.needsClarification) return []
  const issues: string[] = []
  const aliases = (entry: DataCenterFieldCatalogEntry) => [entry.field, entry.displayName ?? '', ...entry.synonyms].filter(Boolean).map(normalize)
  const isField = (value: string) => catalog.some((entry) => aliases(entry).includes(normalize(value)))
  for (const term of [...plan.searchTerms, ...plan.groupEntities]) {
    if (isField(term)) issues.push(`“${term}”是字段名称，不是记录搜索值或具体分组实体；请使用 fields、filters 或 groupByField 表达其角色`)
  }
  if (plan.groupByField) {
    const entry = catalog.find((field) => field.field === plan.groupByField)
    if (!entry) {
      issues.push('分组字段必须来自真实字段目录')
    }
    if (plan.groupEntities.length) issues.push('字段取值分组与指定实体分组不可混用；实体筛选应作为字段过滤条件')
    if (!['field_aggregate', 'filter_records', 'analyze_records'].includes(plan.intent)) issues.push('所选执行操作不支持按字段分组')
    if (plan.intent !== 'field_aggregate' && plan.resultMode !== 'grouped_list') issues.push('按字段列明细必须使用 grouped_list，不能退化为普通列表')
  }
  if (plan.recordGroups && (plan.groupByField || !['filter_records', 'analyze_records', 'record_lookup'].includes(plan.intent))) issues.push('显式编号分组只支持记录清单或分析，不能混用字段分组')
  if (plan.resultMode === 'grouped_list' && !plan.groupByField && !plan.groupEntities.length && !plan.recordGroups) issues.push('分组清单缺少分组字段或具体实体')
  if (plan.intent === 'field_aggregate' && !plan.groupByField) issues.push('字段统计缺少已验证的分组字段')
  if (plan.intent === 'total' && (plan.filters.length || plan.searchTerms.length)) issues.push('有限定条件的查询不能执行无条件总量统计')
  if (!Number.isInteger(plan.limit) || plan.limit < 1 || plan.limit > 50) issues.push('记录预览数量必须在 1 到 50 之间')
  return [...new Set(issues)]
}

/** A successful tool call is not sufficient: verify the requested result shape. */
export const verifyQueryDelivery = (plan: DataCenterQueryPlan, result: unknown): void => {
  if (!['filter_records', 'record_lookup', 'search_content', 'analyze_records', 'count_matching'].includes(plan.intent)) return
  const query = result as FieldQueryResult | undefined
  const issues: string[] = []
  if (!query || !Array.isArray(query.records) || !Number.isFinite(query.matchedCount)) {
    // Unconstrained legacy counts are normalized to aggregate_records by the executor.
    if (plan.intent === 'count_matching' && Number.isFinite((result as { value?: number })?.value)) return
    throw new QueryContractError(['执行器未返回可核验的记录查询结果'])
  }
  if (query.returnedCount !== query.records.length || query.returnedCount > query.matchedCount) issues.push('查询计数与实际返回记录不一致')
  if (query.records.some((row) => plan.fields.some((field) => !(field in row.values)))) issues.push('查询结果遗漏了用户要求的字段')
  if (plan.groupByField && plan.intent !== 'field_aggregate') {
    if (query.grouping?.field !== plan.groupByField) issues.push('执行器没有按计划中的真实字段分组')
    const groups = query.grouping?.groups ?? []
    for (const row of query.records) {
      if (!groups.some((group) => group.recordUids.includes(row.source.uid))) issues.push('返回记录没有可验证的字段分组归属')
    }
  }
  if (issues.length) throw new QueryContractError([...new Set(issues)])
}
