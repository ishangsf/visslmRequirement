import type { AppDatabase, FieldQueryResult, FieldQueryFilter, FieldQueryOptions } from '../database'
import type { DataScope } from '../../shared/query-spec'
import { sanitizeContextText } from '../context-budget'

export interface ExplicitRecordGroups {
  groups: Array<{ name: string; codes: string[] }>
}

export interface ExplicitRecordGroupResult extends FieldQueryResult {
  explicitGroups: Array<{ name: string; codes: string[]; missingCodes: string[]; recordUids: string[] }>
  requestedCodeCount: number
  matchedCodeCount: number
  records: Array<FieldQueryResult['records'][number] & { text: string }>
}

export const executeExplicitRecordGroups = (
  db: AppDatabase,
  request: ExplicitRecordGroups,
  projectId?: string,
  scope?: DataScope,
  baseFilters?: FieldQueryFilter[],
  options?: Pick<FieldQueryOptions, 'filters' | 'fields' | 'nodeType' | 'searchTerms' | 'searchMode'>
): ExplicitRecordGroupResult => {
  const groups = request.groups.map((group) => ({ ...group, codes: [...new Set(group.codes.map((code) => code.toUpperCase()))] }))
  const allCodes = [...new Set(groups.flatMap((group) => group.codes))]
  const records = new Map<string, ExplicitRecordGroupResult['records'][number]>()
  const uidsByCode = new Map<string, string[]>()
  const exactRecords = db.findRecordsByItemIds(allCodes)
  for (const code of allCodes) {
    const exact = exactRecords.filter((record) => record.itemId.toUpperCase() === code)
    const scopeUids = scope?.recordUids === undefined ? undefined : new Set(scope.recordUids)
    const candidates = exact.filter((detail) => !scopeUids || scopeUids.has(detail.uid))
    const query = db.queryRecordsByFields({
      ...options,
      ...(scope?.projectIds === undefined ? { projectId } : scope.projectIds.length ? { projectIds: scope.projectIds } : {}),
      ...(options?.nodeType ? { nodeTypes: [options.nodeType] } : scope?.nodeTypes?.length ? { nodeTypes: scope.nodeTypes } : {}),
      recordUids: candidates.map((detail) => detail.uid),
      baseFilters,
      limit: 50
    })
    const allowed = new Set(query.recordUids)
    const matched = candidates.filter((detail) => allowed.has(detail.uid))
    uidsByCode.set(code, matched.map((detail) => detail.uid))
    for (const row of matched) {
      const detail = db.getRecord(row.uid, false)
      if (!detail) continue
      records.set(detail.uid, {
        source: { uid: detail.uid, itemId: detail.itemId, name: detail.name, nodeType: detail.nodeType, sourceType: 'record' },
        values: query.records.find((record) => record.source.uid === row.uid)?.values ?? {},
        text: sanitizeContextText(detail.normalizedText || detail.matchingText || detail.name, 600)
      })
    }
  }
  const explicitGroups = groups.map((group) => ({
    ...group,
    missingCodes: group.codes.filter((code) => !uidsByCode.get(code)?.length),
    recordUids: [...new Set(group.codes.flatMap((code) => uidsByCode.get(code) ?? []))]
  }))
  return {
    totalScanned: allCodes.length, matchedCount: records.size, returnedCount: records.size,
    requestedCodeCount: allCodes.length,
    matchedCodeCount: allCodes.filter((code) => uidsByCode.get(code)?.length).length,
    fields: options?.fields ?? [], recordUids: [...records.keys()], records: [...records.values()], explicitGroups,
    recordUidsByTerm: Object.fromEntries(explicitGroups.map((group) => [group.name, group.recordUids]))
  }
}

export const renderExplicitRecordGroups = (result: ExplicitRecordGroupResult, analysis: string): string => {
  const lines = [`已按你提供的分组归属核对 ${result.requestedCodeCount} 个记录编号，找到 ${result.matchedCodeCount} 个编号、${result.matchedCount} 条记录。分组归属来自本次输入。`]
  for (const group of result.explicitGroups) {
    lines.push(`\n### ${group.name}\n\n请求 ${group.codes.length} 个编号，找到 ${group.codes.length - group.missingCodes.length} 个。`)
    for (const uid of group.recordUids) {
      const record = result.records.find((item) => item.source.uid === uid)!
      const name = sanitizeContextText(record.source.name, 160).replace(/[\r\n]/gu, ' ')
      const text = record.text.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').slice(0, 220)
      lines.push(`- ${record.source.itemId} · ${name}：${text} [UID:${uid}]`)
    }
    if (group.missingCodes.length) lines.push(`\n当前范围未找到：${group.missingCodes.join('、')}。`)
  }
  if (analysis.trim()) lines.push(`\n### 基于已查到记录的分析\n\n${analysis.trim()}`)
  return lines.join('\n')
}
