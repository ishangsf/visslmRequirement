import assert from 'node:assert/strict'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import { OllamaAgent } from '../src/main/ollama'
import { AppDatabase } from '../src/main/database'
import type { AssistantIntentDecision, ModelSettings } from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const settings: ModelSettings = { source: 'online', provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'mock', thinking: false }
const response = (content: unknown): ModelResponse => ({ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) } })
const decision = (question: string, extra: Partial<AssistantIntentDecision> = {}): AssistantIntentDecision => ({
  taskType: 'record_query', skillId: 'general', sourceMode: 'records', resultMode: 'list',
  groupEntities: [], needsClarification: false, reason: 'semantic fixture', resolvedQuestion: question, ...extra
})
const checks: string[] = []
// Same word, different purpose; output follows semantic decisions, never vocabulary.
for (const question of ['解释需求编号 REQ-17 是什么，不要匹配', '不要画图，讲讲柱状图与看板的区别', 'How would I configure platform queries?', 'Excel 文件评审是什么']) {
  let calls = 0
  const expected = decision(question, { taskType: 'conversation', sourceMode: 'conversation', resultMode: 'answer' })
  const router = new AssistantIntentRouter(settings, { chat: async () => { calls++; return response(expected) } })
  const actual = await router.resolve({ question })
  assert.equal(actual.taskType, 'conversation')
  assert.equal(calls, 1, 'IDs and chart/format words cannot bypass the model')
}
checks.push('keyword decoys, negation and English requests do not override semantic routing')
for (const question of ['按不同人员整理事项', '列出每个分析人的记录', 'Group every category separately']) {
  const router = new AssistantIntentRouter(settings, { chat: async () => response(decision(question, { resultMode: 'grouped_list' })) })
  const actual = await router.resolve({ question })
  assert.equal(actual.needsClarification, false, 'unknown field values are discovered after routing')
}
checks.push('field grouping requires no hardcoded field names or pre-enumerated entities')
let failedCalls = 0
await assert.rejects(new AssistantIntentRouter(settings, { chat: async () => { failedCalls++; return response('not json') } }).resolve({ question: '统计记录' }), /语义路由失败/)
assert.equal(failedCalls, 2)
let repairCalls = 0
const repaired = await new AssistantIntentRouter(settings, { chat: async (input) => {
  repairCalls++
  if (repairCalls === 1) return response(decision('统计记录', { sourceMode: 'knowledge' }))
  assert.match(input.messages.at(-1)!.content, /validationError/)
  return response(decision('统计记录'))
} }).resolve({ question: '统计记录' })
assert.equal(repaired.sourceMode, 'records')
checks.push('invalid routing retries with feedback then fails closed, without keyword fallback')
await assert.rejects(new AssistantIntentRouter(settings, { chat: async () => response(decision('列出甲的记录', { groupEntities: ['乙'] })) }).resolve({ question: '列出甲的记录' }), /语义路由失败/)
const historical = await new AssistantIntentRouter(settings, { chat: async () => response(decision('分别列出', { resultMode: 'grouped_list', groupEntities: ['张三', '李四'] })) }).resolve({
  question: '分别列出', history: [{ role: 'user', content: '张三和李四的记录' }, { role: 'assistant', content: '还有王五' }]
})
assert.deepEqual(historical.groupEntities, ['张三', '李四'])
checks.push('only user history grounds entities')
const directory = await mkdtemp(join(tmpdir(), 'semantic-intent-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))
try {
  db.upsertRecord({ uid: 'a', projectId: 'p', nodeType: 'Issue', itemId: 'I-1', parentId: '', name: '任务A', raw: { Owner: '张三' }, normalizedText: '张三任务', lastModifyTime: '' })
  const agent = new OllamaAgent(db, settings)
  const calls: ModelChatInput[] = []
  Object.defineProperty(agent, 'callModel', { value: async (input: ModelChatInput) => {
    calls.push(input)
    const context = JSON.parse(input.messages.at(-1)!.content)
    assert.equal(context.currentQuestion, '按Owner列出全部记录')
    assert.ok(context.fieldCatalog.some((entry: { field: string }) => entry.field === 'Owner'))
    return response({ intent: 'filter_records', resultMode: 'grouped_list', groupByField: 'Owner', groupEntities: [], searchTerms: [], fields: ['Owner'], filters: [], limit: 50 })
  } })
  const result = await agent.ask({ question: '按Owner列出全部记录', assistantIntent: decision('搜索其他内容', { resultMode: 'grouped_list', groupEntities: ['Owner'] }) })
  assert.equal(calls.length, 1)
  assert.equal(result.dataViews[0].groups[0].name, '张三')
  assert.equal(result.executionSummary?.searchTerms.length, 0)
  checks.push('router hints cannot become query terms; original question reaches catalog planner')
  let queryCalls = 0
  Object.defineProperty(db, 'queryRecordsByFields', { value: () => { queryCalls++; throw new Error('must not query') } })
  const conversation = new OllamaAgent(db, settings)
  Object.defineProperty(conversation, 'callModel', { value: async () => response('你好') })
  await conversation.ask({ question: '你好', assistantIntent: decision('你好', { taskType: 'conversation', sourceMode: 'conversation', resultMode: 'answer' }) })
  assert.equal(queryCalls, 0)
  checks.push('conversation does not access record tools')
} finally { db.close(); await rm(directory, { recursive: true, force: true }) }
console.log(JSON.stringify({ ok: true, checks }))
