import type { AppDatabase, FieldQueryResult, FieldQueryFilter } from '../database'
import type { DataScope } from '../../shared/query-spec'
import { sanitizeContextText } from '../context-budget'

export interface RegionalRequirementRequest {
  groups: Array<{ name: string; codes: string[] }>
}

/** Only explicit region lists and an explicit prefix authorize suffix expansion. */
export const parseRegionalRequirementRequest = (question: string): RegionalRequirementRequest | undefined => {
  const text = question.normalize('NFKC')
  const prefixes = [...text.matchAll(/前缀\s*(?:是|为|[:：])?\s*[`“"']?([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-)/gu)]
  if (new Set(prefixes.map((match) => match[1].toUpperCase())).size > 1) return undefined
  const prefix = prefixes[0]?.[1].toUpperCase()
  const headers = [...text.matchAll(/(?:^|[\s,，;；。:：])([\p{Script=Han}]{1,8}区)(?:需求)?\s*[:：]/gu)]
  if (!headers.length) return undefined
  const groups: RegionalRequirementRequest['groups'] = []
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    const segment = text.slice(header.index! + header[0].length, headers[index + 1]?.index)
    const list = segment.match(/^\s*((?:(?:[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-)?\d+)(?:[\s、,，;；]+(?:(?:[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*-)?\d+))*)/u)?.[1]
    if (!list) return undefined
    const tokens = list.split(/[\s、,，;；]+/u).filter(Boolean)
    if (tokens.some((token) => /^\d+$/u.test(token) && !prefix)) return undefined
    const codes = tokens.map((token) => /^\d+$/u.test(token) ? `${prefix}${token}` : token.toUpperCase())
    const existing = groups.find((group) => group.name === header[1])
    if (existing) existing.codes = [...new Set([...existing.codes, ...codes])]
    else groups.push({ name: header[1], codes: [...new Set(codes)] })
  }
  if (groups.length > 12 || groups.reduce((sum, group) => sum + group.codes.length, 0) > 200) return undefined
  return { groups }
}

export interface RegionalRequirementResult extends FieldQueryResult {
  regionalGroups: Array<{ name: string; codes: string[]; missingCodes: string[]; recordUids: string[] }>
  requestedCodeCount: number
  matchedCodeCount: number
  records: Array<FieldQueryResult['records'][number] & { text: string }>
}

export const executeRegionalRequirements = (
  db: AppDatabase,
  request: RegionalRequirementRequest,
  projectId?: string,
  scope?: DataScope,
  baseFilters?: FieldQueryFilter[]
): RegionalRequirementResult => {
  const allCodes = [...new Set(request.groups.flatMap((group) => group.codes))]
  const records = new Map<string, RegionalRequirementResult['records'][number]>()
  const uidsByCode = new Map<string, string[]>()
  const exactRecords = db.findRecordsByItemIds(allCodes)
  for (const code of allCodes) {
    const exact = exactRecords.filter((record) => record.itemId.toUpperCase() === code)
    const scopeUids = scope?.recordUids === undefined ? undefined : new Set(scope.recordUids)
    const candidates = exact.filter((detail) => !scopeUids || scopeUids.has(detail.uid))
    const query = db.queryRecordsByFields({
      ...(scope?.projectIds === undefined ? { projectId } : scope.projectIds.length ? { projectIds: scope.projectIds } : {}),
      ...(scope?.nodeTypes?.length ? { nodeTypes: scope.nodeTypes } : {}),
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
        values: {},
        text: sanitizeContextText(detail.normalizedText || detail.matchingText || detail.name, 600)
      })
    }
  }
  const regionalGroups = request.groups.map((group) => ({
    ...group,
    missingCodes: group.codes.filter((code) => !uidsByCode.get(code)?.length),
    recordUids: [...new Set(group.codes.flatMap((code) => uidsByCode.get(code) ?? []))]
  }))
  return {
    totalScanned: allCodes.length, matchedCount: records.size, returnedCount: records.size,
    requestedCodeCount: allCodes.length,
    matchedCodeCount: allCodes.filter((code) => uidsByCode.get(code)?.length).length,
    fields: [], recordUids: [...records.keys()], records: [...records.values()], regionalGroups,
    recordUidsByTerm: Object.fromEntries(regionalGroups.map((group) => [group.name, group.recordUids]))
  }
}

export const renderRegionalRequirements = (result: RegionalRequirementResult, analysis: string): string => {
  const lines = [`已按你提供的区域归属核对 ${result.requestedCodeCount} 个需求编号，找到 ${result.matchedCodeCount} 个编号、${result.matchedCount} 条记录。区域归属来自本次输入。`]
  for (const group of result.regionalGroups) {
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
  else if (result.matchedCount) lines.push('\n本次未获得可用的模型分析，以上为已核验的分区域需求内容；未生成归纳或建议。')
  return lines.join('\n')
}
