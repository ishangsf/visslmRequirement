import assert from 'node:assert/strict'
import { PlainChatAgent, type PlainChatClient } from '../src/main/plain-chat'
import { autoRequirementIds, autoRequirementQuestion, resolveAutoChatRoute } from '../src/main/experts/auto-routing'
import { DirectRequirementDataAnalysisAgent } from '../src/main/direct-data-analysis'
import type { AppDatabase } from '../src/main/database'
import type { RecordDetail } from '../src/shared/types'
import type { ChatRequest, ModelSettings } from '../src/shared/types'
import type { ModelMessage } from '../src/main/model-client'

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'smoke-model',
  thinking: true,
  apiKey: 'smoke-key'
}

let captured: {
  messages: ModelMessage[]
  think?: boolean
  forceThinking?: boolean
} | undefined

const client: PlainChatClient = {
  async chat(input) {
    captured = input
    return { message: { role: 'assistant', content: '这是普通对话回答。' } }
  }
}

const request: ChatRequest = {
  question: '详细分析需求编号为：4101、4095',
  entrypoint: 'chat',
  chatMode: 'plain',
  history: [{ role: 'user', content: '上一轮问题' }]
}
const response = await new PlainChatAgent(settings, client).ask(request)

assert.equal(response.answer, '这是普通对话回答。')
assert.deepEqual(response.sources, [])
assert.deepEqual(response.dataViews, [])
assert.equal(captured?.think, false)
assert.equal(captured?.forceThinking, false)
assert.equal(captured?.messages.at(-1)?.content, request.question)
assert.match(captured?.messages[0]?.content ?? '', /不要自动检索本地知识库/u)
assert.match(captured?.messages[0]?.content ?? '', /@需求分析专家/u)

const requirementQuestion = '详细分析需求编号为：4101、4095、4085'
assert.equal(resolveAutoChatRoute(requirementQuestion), 'requirement-analysis')
assert.equal(
  autoRequirementQuestion('你自己取出这些编号的相关信息提供给AI分析', [
    { role: 'user', content: requirementQuestion },
    { role: 'assistant', content: '请提供需求编号' }
  ]),
  '你自己取出这些编号的相关信息提供给AI分析'
)
assert.deepEqual(
  autoRequirementIds('你自己取出这些编号的相关信息提供给AI分析', [
    { role: 'user', content: requirementQuestion },
    { role: 'assistant', content: '请提供需求编号' }
  ]),
  ['4101', '4095', '4085']
)
assert.equal(resolveAutoChatRoute('你好'), 'plain')
assert.equal(resolveAutoChatRoute('当前数据有多少条记录？'), 'general')

let directPrompt = ''
const directClient: PlainChatClient = {
  async chat(input) {
    directPrompt = input.messages.map((message) => message.content).join('\n')
    return { message: { role: 'assistant', content: '已根据提取的记录完成直接分析。' } }
  }
}
const detail = {
  uid: 'uid-4101',
  itemId: 'VISSLM-TSIS-4101',
  nodeType: 'TSIssue',
  name: '测试需求 4101',
  description: '需要支持直接分析',
  normalizedText: '测试需求 4101 需要支持直接分析',
  raw: { _valm_Description: '需要支持直接分析', _valm_Module: '需求管理' },
  lastModifyTime: '2026-08-23T00:00:00.000Z'
} as unknown as RecordDetail
const directDb = {
  findRecordByItemId: () => null,
  findRecordsByItemIdSuffix: () => [{ uid: detail.uid, itemId: detail.itemId }],
  getRecord: () => detail
} as unknown as AppDatabase
const directResponse = await new DirectRequirementDataAnalysisAgent(directDb, settings, directClient).ask({
  question: '你自己取出这些编号的相关信息提供给AI分析',
  chatMode: 'auto',
  extractedRequirementIds: ['4101']
})
assert.equal(directResponse.answer, '已根据提取的记录完成直接分析。')
assert.equal(directResponse.sources[0]?.itemId, detail.itemId)
assert.equal(directResponse.dataViews[0]?.title, '自动提取的需求数据')
assert.match(directPrompt, /当前问题：你自己取出这些编号的相关信息提供给AI分析/u)
assert.match(directPrompt, /禁止执行 Dense、BM25/u)

console.log(JSON.stringify({ ok: true, answer: response.answer, messageCount: captured?.messages.length }))
