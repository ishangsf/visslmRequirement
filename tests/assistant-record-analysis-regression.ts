import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { DataCenterAgent, type DataCenterQueryPlan } from '../src/main/assistant/agents/data-center-agent'
import { executeRecordAnalysis } from '../src/main/assistant/record-analysis'
import { packRecordEvidence } from '../src/main/assistant/record-evidence'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { ModelClient } from '../src/main/model-client'
import { OllamaAgent } from '../src/main/ollama'

const directory = await mkdtemp(join(tmpdir(), 'assistant-analysis-regression-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))
const originalChat = ModelClient.prototype.chat
try {
  for (let index = 0; index < 60; index++) db.upsertRecord({
    uid: `record-${index}`, projectId: index < 40 ? 'a' : 'b', parentId: '', nodeType: 'Requirement',
    itemId: `REQ-${index}`, name: `统一认证 ${index}`, lastModifyTime: new Date(0).toISOString(),
    raw: { Description: '<p>SSO 令牌到期处理缺口</p>' + '说明'.repeat(600), Reason: '原因'.repeat(600), Status: '1' },
    normalizedText: '统一身份认证 SSO 令牌到期处理缺口。' + '正文'.repeat(600)
  })
  const agent = new DataCenterAgent(db)
  const plan: DataCenterQueryPlan = { sourceMode: 'records', needsClarification: false, resultMode: 'answer',
    groupEntities: [], intent: 'analyze_records', explanation: '', searchTerms: [], searchMode: 'any', filters: [], fields: [], limit: 50, scope: { projectIds: ['a'] } }
  const basic = await executeRecordAnalysis(db, agent, undefined, plan, '分析全部需求')
  const query = basic.result as any
  assert.equal(query.matchedCount, 40)
  assert.match(query.records[0].text, /令牌到期/)
  assert.deepEqual(query.records[0].values, {})
  const expanded = await executeRecordAnalysis(db, agent, undefined, { ...plan, fields: ['Description', 'Reason'] }, '分析全部需求')
  const packet = packRecordEvidence(expanded.result as any)
  assert.ok(packet.records.length > 0 && packet.records.length < 40)
  assert.ok(JSON.stringify(packet).length <= 24_000)
  assert.equal(packet.coverage.queryReturnedCount, 40)
  assert.equal(packet.coverage.omittedRecordCount, 40 - packet.records.length)
  assert.doesNotMatch(JSON.stringify(packet), /<p>/)
  let semanticCalls = 0
  const knowledge = { rankRecordMatches: async (_question: string, _limit: number, options?: { recordUids: readonly string[] }) => {
    semanticCalls++
    assert.ok(options?.recordUids.every((id) => Number(id.split('-')[1]) < 40))
    return ['record-39', 'record-59'].map((recordUid) => ({ recordUid, score: 90, recordName: '', nodeType: 'Requirement', itemId: '', chunkId: '', snippet: '' }))
  } }
  const semantic = await executeRecordAnalysis(db, agent, undefined, { ...plan, searchTerms: ['单点登录'] }, '分析单点登录风险', knowledge)
  assert.deepEqual((semantic.result as any).records.map((row: any) => row.source.uid), ['record-39'])
  assert.equal((semantic.result as any).retrieval.exhaustive, false)
  await executeRecordAnalysis(db, agent, undefined, { ...plan, intent: 'count_matching', searchTerms: ['单点登录'] }, '单点登录有多少条', knowledge)
  assert.equal(semanticCalls, 1, 'exact counts must not silently become semantic candidate counts')
  const empty = await executeRecordAnalysis(db, agent, undefined, { ...plan, searchTerms: ['单点登录'], scope: { recordUids: [] } }, '分析单点登录', knowledge)
  assert.equal((empty.result as any).matchedCount, 0)
  assert.equal(semanticCalls, 1)
  const engine = new QueryEngine(db)
  engine.profile({ projectIds: ['a'] })
  engine.updateFieldProfileSemantics({ projectIds: ['a'] }, 'Status', { displayName: '状态', businessMeaning: '评审后的需求状态', unit: '', valueLabels: { '1': '进行中' } })
  db.upsertRecord({ uid: 'new', projectId: 'a', nodeType: 'Requirement', itemId: 'REQ-new', name: '新数据', parentId: '', lastModifyTime: '', raw: { Status: '1' }, normalizedText: '' })
  assert.equal(engine.profile({ projectIds: ['a'] }).find((field) => field.field === 'Status')?.businessMeaning, '评审后的需求状态')
  assert.deepEqual(agent.inspectCatalog('a').fields.find((field) => field.field === 'Status')?.valueLabels, { '1': '进行中' })
  let finalInput = ''
  ModelClient.prototype.chat = async function (input) {
    if (input.format) return { message: { role: 'assistant', content: JSON.stringify({ ...plan, fields: [], filters: [{ field: 'Status', operator: 'equals', value: '1' }] }) } }
    finalInput = input.messages.at(-1)!.content
    return { message: { role: 'assistant', content: '记录说明令牌到期存在处理缺口。' } }
  }
  const response = await new OllamaAgent(db, { source: 'online', provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'mock', thinking: false }).ask({
    question: '分析状态为进行中的当前全部需求', projectId: 'a', dataScope: { projectIds: ['a'] },
    assistantIntent: { taskType: 'record_query', sourceMode: 'records', skillId: 'general', resultMode: 'answer', groupEntities: [], needsClarification: false, resolvedQuestion: '分析状态为进行中的当前全部需求', reason: 'test' }
  })
  const payload = JSON.parse(finalInput)
  assert.match(finalInput, /令牌到期/)
  assert.equal(payload.queryPlan.filters[0].value, '1')
  assert.ok(payload.queryResult.coverage.modelIncludedCount > 0)
  assert.ok(response.sources.length > 0)
  assert.ok(response.sources.every((source) => payload.queryResult.records.some((row: any) => row.source.itemId === source.itemId)))
  assert.match(response.answer, /分析范围/)
  console.log(JSON.stringify({ ok: true, checks: ['body enrichment', 'whole-record budget', 'semantic recall within scope', 'counts unchanged', 'empty scope', 'semantic metadata survives refresh', 'enum grounding', 'actual model payload and citation coverage'] }))
} finally {
  ModelClient.prototype.chat = originalChat
  db.close()
  await rm(directory, { recursive: true, force: true })
}
