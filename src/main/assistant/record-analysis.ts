import type { AppDatabase, FieldQueryResult } from '../database'
import type { KnowledgeService } from '../knowledge'
import { sanitizeContextText } from '../context-budget'
import { throwIfAssistantRunCancelled } from './run-controller'
import { DataCenterAgent, type DataCenterExecution, type DataCenterQueryPlan } from './agents/data-center-agent'

/** Analysis enriches evidence; exact counts and lists keep their existing query semantics. */
export const executeRecordAnalysis = async (
  db: AppDatabase,
  agent: DataCenterAgent,
  projectId: string | undefined,
  plan: DataCenterQueryPlan,
  question: string,
  knowledge?: Pick<KnowledgeService, 'rankRecordMatches'>
): Promise<DataCenterExecution> => {
  let execution = agent.executePlan(projectId, plan)
  if ((plan.intent !== 'analyze_records' && !plan.analysisRequired) || plan.recordGroups) return execution
  throwIfAssistantRunCancelled()
  let query = execution.result as FieldQueryResult
  let retrieval: Record<string, unknown> | undefined
  if (typeof knowledge?.rankRecordMatches === 'function' && plan.searchTerms.length && plan.resultMode === 'answer') {
    const eligible = agent.executePlan(projectId, { ...plan, searchTerms: [], fields: [] }).result as FieldQueryResult
    try {
      if (eligible.recordUids.length) {
        const ranked = await knowledge.rankRecordMatches(question, 50, { recordUids: eligible.recordUids })
        throwIfAssistantRunCancelled()
        const allowed = new Set(eligible.recordUids)
        const semanticIds = ranked.filter((hit) => hit.score >= 35 && allowed.has(hit.recordUid)).map((hit) => hit.recordUid)
        if (semanticIds.length) {
          const ids = [...new Set([...query.recordUids, ...semanticIds])]
          const order = [...new Set(semanticIds.flatMap((id, index) => [query.records[index]?.source.uid, id]).filter((id): id is string => Boolean(id)).concat(query.recordUids))]
          const combined = agent.executePlan(projectId, {
            ...plan,
            searchTerms: [],
            scope: { ...plan.scope, recordUids: order.slice(0, Math.min(50, plan.limit)) }
          })
          const combinedQuery = combined.result as FieldQueryResult
          // Use retrieval order rather than physical database insertion order.
          const byId = new Map(combinedQuery.records.map((row) => [row.source.uid, row]))
          const ordered = order.flatMap((id) => byId.has(id) ? [byId.get(id)!] : [])
          query = { ...combinedQuery, matchedCount: ids.length, recordUids: ids, records: [...ordered, ...combinedQuery.records.filter((row) => !order.includes(row.source.uid))] }
          retrieval = {
            mode: 'hybrid', scopeRecordCount: eligible.matchedCount,
            lexicalMatchedCount: (execution.result as FieldQueryResult).matchedCount,
            semanticCandidateCount: semanticIds.length,
            scopeIndexTruncated: eligible.recordUids.length < eligible.matchedCount,
            exhaustive: false
          }
          execution = { ...combined, args: { ...execution.args, retrieval: 'hybrid' } }
        }
      }
    } catch {
      throwIfAssistantRunCancelled()
      retrieval = { mode: 'lexical', exhaustive: false, warning: '语义索引不可用，本次仅使用字段与关键词查询证据。' }
    }
  }
  const records = query.records.map((row) => {
    const detail = db.getRecord(row.source.uid, false)
    return {
      ...row,
      text: sanitizeContextText([detail?.description, detail?.normalizedText].filter(Boolean).join('\n'), 2_400),
      ...(detail?.lastModifyTime ? { lastModifyTime: detail.lastModifyTime } : {})
    }
  })
  return { ...execution, result: { ...query, records, ...(retrieval ? { retrieval } : {}) } }
}
