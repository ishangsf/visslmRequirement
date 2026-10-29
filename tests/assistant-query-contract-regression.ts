import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type FieldQueryResult } from '../src/main/database'
import { DataCenterAgent, type DataCenterQueryPlan } from '../src/main/assistant/agents/data-center-agent'
import { OllamaAgent } from '../src/main/ollama'
import { verifyQueryDelivery } from '../src/main/assistant/query-contract'
import type { ModelChatInput } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

const directory = await mkdtemp(join(tmpdir(), 'query-contract-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))
const settings: ModelSettings = { source: 'online', provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'mock', thinking: false }
const plan: DataCenterQueryPlan = { sourceMode: 'records', intent: 'filter_records', resultMode: 'grouped_list', needsClarification: false,
  groupByField: '成员', groupEntities: [], searchTerms: [], searchMode: 'any', fields: ['成员', '状态'], filters: [], limit: 50, explanation: '', scope: { projectIds: ['p'] } }
const checks: string[] = []
try {
  for (let index = 0; index < 75; index++) db.upsertRecord({ uid: `r${index}`, projectId: index < 70 ? 'p' : 'other', nodeType: 'Issue', parentId: '', itemId: `ISS-${index}`, name: `正文提到张三但不代表参与 ${index}`,
    raw: { 成员: index === 0 ? ['张三', '李四', '张三'] : index === 1 ? null : index < 60 ? '张三' : '李四', 状态: index % 2 ? '完成' : '进行中', 区域: index % 2 ? '南' : '北', Description: '权限检查存在风险' },
    normalizedText: `权限检查问题 ${index}`, lastModifyTime: '' })
  const data = new DataCenterAgent(db)
  const execution = data.executePlan(undefined, plan)
  const query = execution.result as FieldQueryResult
  assert.equal(query.matchedCount, 70)
  assert.equal(query.returnedCount, 50)
  assert.deepEqual(query.grouping?.groups.map((group) => [group.name, group.count]), [['张三', 59], ['李四', 11], ['未填写', 1]])
  assert.ok(query.grouping?.groups.every((group) => group.recordUids.every((uid) => Number(uid.slice(1)) < 70)))
  assert.ok(!query.grouping?.groups.find((group) => group.name === '张三')?.recordUids.includes('r60'), 'title mention cannot imply field membership')
  verifyQueryDelivery(plan, query)
  const view = data.createDataView(execution.toolName, execution.args, query)!
  assert.equal(view.groups.find((group) => group.name === '李四')?.recordUids?.length, 11)
  assert.match(data.renderVerifiedAnswer(plan, query, ''), /50\/70/)
  assert.throws(() => verifyQueryDelivery(plan, { ...query, grouping: undefined }), /分组/)
  assert.throws(() => verifyQueryDelivery(plan, { ...query, returnedCount: 49 }), /计数/)
  checks.push('full-set grouping, multi-value deduplication, empty values, scope isolation, preview coverage and delivery gate')
  for (const field of ['成员', '状态', '区域']) {
    const result = data.executePlan(undefined, { ...plan, groupByField: field, fields: [field] }).result as FieldQueryResult
    assert.equal(result.grouping?.field, field)
    assert.equal(result.matchedCount, 70)
  }
  const aggregate = data.executePlan(undefined, { ...plan, intent: 'field_aggregate', resultMode: 'table', groupByField: '区域', searchTerms: ['权限检查'], filters: [{ field: '状态', operator: 'equals', value: '进行中' }] }).result as { matchedRecords: number; totalRecords: number; emptyRecords: number }
  assert.equal(aggregate.matchedRecords, 35)
  assert.equal(aggregate.totalRecords, 35)
  assert.equal(aggregate.emptyRecords, 0)
  checks.push('same contract works for people, statuses and regions; aggregation retains all constraints')

  const ask = async (question: string, proposals: Record<string, unknown>[], answer = '已根据正文分析风险。') => {
    const agent = new OllamaAgent(db, settings)
    const calls: ModelChatInput[] = []
    let index = 0
    Object.defineProperty(agent, 'callModel', { value: async (input: ModelChatInput) => {
      calls.push(input)
      return { message: { role: 'assistant', content: input.format ? JSON.stringify(proposals[Math.min(index++, proposals.length - 1)]) : answer } }
    } })
    const response = await agent.ask({ question, dataScope: { projectIds: ['p'] }, assistantIntent: {
      taskType: 'record_query', skillId: 'general', sourceMode: 'records', resultMode: 'answer', groupEntities: [], needsClarification: false, resolvedQuestion: question, reason: 'test'
    } })
    return { response, calls }
  }
  const base = { ...plan, scope: undefined, fields: ['成员'], needsClarification: false }
  const fixed = await ask('按成员整理一个清单', [{ ...base, limit: 1 }])
  assert.equal(fixed.response.executionSummary?.limit, 50)
  const limited = await ask('按成员列出前五条记录', [{ ...base, limit: 5, limitEvidence: '前五条记录' }])
  assert.equal(limited.response.executionSummary?.limit, 5)
  const repaired = await ask('按成员列出所有记录', [{ ...base, groupByField: undefined, groupEntities: ['成员'], searchTerms: ['成员'] }, base])
  assert.equal(repaired.calls.length, 2)
  assert.match(repaired.calls[1].messages.at(-1)!.content, /validationErrors/)
  assert.equal(repaired.response.executionSummary?.groupByField, '成员')
  checks.push('artifact quantity is separate from record limits; invalid role assignments receive bounded repair')
  const originalQuery = db.queryRecordsByFields.bind(db)
  let actualQueries = 0
  db.queryRecordsByFields = (options) => { actualQueries++; return originalQuery(options) }
  await assert.rejects(ask('按成员列出记录', [{ ...base, filters: [{ field: '不存在', operator: 'equals', value: '张三' }] }]), /无法确定可验证/)
  assert.equal(actualQueries, 0, 'invalid filters must not be silently removed before execution')
  checks.push('unsupported fields/filters fail before database execution')
  const analysis = await ask('按成员列出记录并分析风险', [{ ...base, analysisRequired: true }])
  assert.equal(analysis.calls.length, 2)
  assert.match(analysis.response.answer, /实际字段值分组/)
  assert.match(analysis.response.answer, /分析风险/)
  assert.match(analysis.calls[1].messages.at(-1)!.content, /权限检查问题/)
  assert.match(analysis.response.answer, /分析范围/)
  await assert.rejects(ask('分析当前所有记录', [{ ...base, intent: 'analyze_records', resultMode: 'answer', groupByField: undefined }], ''), /未返回所需分析/)
  checks.push('list + analysis obligations survive rendering; empty model answers cannot complete a task')
  const schema = await ask('列出字段有哪些', [{ ...base, intent: 'schema_inspection', resultMode: 'table', groupByField: undefined }])
  assert.equal(schema.response.executionSummary?.intent, 'schema_inspection')
  const count = await ask('按区域统计每组多少条', [{ ...base, intent: 'field_aggregate', resultMode: 'table', groupByField: '区域' }])
  assert.equal(count.response.executionSummary?.intent, 'field_aggregate')
  const groupedCount = await ask('按区域分别统计问题数量', [{ ...base, intent: 'field_aggregate', resultMode: 'grouped_list', groupByField: '区域' }])
  assert.equal(groupedCount.response.executionSummary?.intent, 'field_aggregate')
  assert.match(groupedCount.response.answer, /35/)
  checks.push('list/count wording cannot override schema inspection or grouped aggregation')
  db.upsertRecord({ uid: 'release', projectId: 'p', nodeType: 'Release', itemId: 'REL-1', parentId: '', name: '发布', raw: {}, normalizedText: '发布', lastModifyTime: '' })
  const totalPlan: DataCenterQueryPlan = { ...plan, intent: 'total', resultMode: 'answer', groupByField: undefined, fields: [], metric: 'record_count', nodeType: 'Issue', scope: { projectIds: ['p'], nodeTypes: ['Issue', 'Release'] } }
  assert.equal((data.executePlan(undefined, totalPlan).result as { value: number }).value, 70, 'a selected broad scope must not erase the planned node type')
  assert.throws(() => data.executePlan(undefined, { ...totalPlan, scope: { projectIds: ['p'], nodeTypes: ['Release'] } }), /超出/)
  checks.push('planned type narrows UI scope for totals without crossing it')
  console.log(JSON.stringify({ ok: true, checks }))
} finally { db.close(); await rm(directory, { recursive: true, force: true }) }
