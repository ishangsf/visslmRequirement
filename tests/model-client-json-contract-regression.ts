import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { AssistantIntentRouter, assistantIntentDecisionFormat } from '../src/main/assistant/intent-router'
import { ModelClient, type ModelChatInput, type ModelMessage } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

type WireRequest = {
  messages: ModelMessage[]
  response_format?: unknown
  enable_thinking?: boolean
}

const question = '今年我一共有多少缺陷?'
const validDecision = {
  taskType: 'record_query', skillId: 'general', sourceMode: 'records',
  resolvedQuestion: question, resultMode: 'answer', groupEntities: [],
  needsClarification: false, reason: '统计记录；人员和日期范围由后续查询规划解析'
}
const captured: WireRequest[] = []
let replies: unknown[] = []
const checks: string[] = []
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/chat/completions') {
    response.writeHead(404).end()
    return
  }
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRequest)
  const reply = replies.length ? replies.shift() : validDecision
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ choices: [{
    finish_reason: 'stop',
    message: { role: 'assistant', content: typeof reply === 'string' ? reply : JSON.stringify(reply) }
  }] }))
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const settings: ModelSettings = {
  source: 'online', provider: 'openai-compatible', model: 'Qwen3.8-27B',
  baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test-only', thinking: true
}

const assertSchemaDelivered = (request: WireRequest, schema: Record<string, unknown>): void => {
  assert.deepEqual(request.response_format, { type: 'json_object' })
  const serialized = JSON.stringify(schema)
  assert.equal(request.messages.filter((message) =>
    message.role === 'system' && message.content.includes(serialized)).length, 1,
  'JSON-object providers must receive the complete schema exactly once in system instructions')
}

try {
  for (const provider of ['openai-compatible', 'qwen', 'deepseek', 'zhipu'] as const) {
    const start = captured.length
    const decision = await new AssistantIntentRouter({ ...settings, provider }).resolve({ question })
    assert.equal(decision.taskType, 'record_query')
    assert.equal(decision.resolvedQuestion, question)
    assert.equal(captured.length - start, 1)
    const sent = captured[start]
    assertSchemaDelivered(sent, assistantIntentDecisionFormat)
    assert.equal(sent.messages.filter((message) => message.role === 'system').length, 1)
    assert.equal(JSON.parse(sent.messages.at(-1)!.content).currentQuestion, question)
    if (provider === 'qwen' || provider === 'openai-compatible') {
      assert.equal(sent.enable_thinking, false, 'classification must preserve its no-thinking override')
    }
  }
  checks.push('online intent classification delivers required fields and enums through all JSON-object transports')

  const querySchema = {
    type: 'object', additionalProperties: false, required: ['filters'],
    properties: { filters: { type: 'array', items: {
      type: 'object', required: ['field', 'op', 'value'], additionalProperties: false,
      properties: {
        field: { type: 'string', enum: ['Owner', 'CreatedAt'] },
        op: { type: 'string', enum: ['eq', 'gte'] },
        value: { type: 'string' }
      }
    } } }
  }
  const input: ModelChatInput = {
    messages: [{ role: 'system', content: '仅规划查询，保留用户的完整筛选条件。' }, { role: 'user', content: question }],
    format: querySchema
  }
  const original = structuredClone(input)
  const client = new ModelClient(settings)
  for (let attempt = 0; attempt < 2; attempt++) {
    replies = [{ filters: [] }]
    await client.chat(input)
    assertSchemaDelivered(captured.at(-1)!, querySchema)
    assert.ok(captured.at(-1)!.messages.some((message) => message.content.startsWith(original.messages[0].content)))
    assert.deepEqual(input, original, 'transport must not mutate reusable caller messages or schemas')
  }
  const userOnly: ModelChatInput = { messages: [{ role: 'user', content: question }], format: querySchema }
  const userOnlyOriginal = structuredClone(userOnly)
  await client.chat(userOnly)
  assertSchemaDelivered(captured.at(-1)!, querySchema)
  assert.deepEqual(captured.at(-1)!.messages.at(-1), userOnly.messages[0])
  assert.deepEqual(userOnly, userOnlyOriginal)
  checks.push('dynamic nested query schemas survive transport and repeated calls do not mutate input')

  for (const format of [undefined, 'json'] as const) {
    const messages: ModelMessage[] = [{ role: 'user', content: '请返回一个 JSON 对象。' }]
    await client.chat({ messages, format })
    assert.deepEqual(captured.at(-1)!.messages, messages)
    assert.deepEqual(captured.at(-1)!.response_format, format ? { type: 'json_object' } : undefined)
  }
  const nativeInput = { ...original, messages: structuredClone(original.messages) }
  await new ModelClient({ ...settings, provider: 'openai', model: 'native-schema-model' }).chat(nativeInput)
  assert.deepEqual(captured.at(-1)!.response_format, {
    type: 'json_schema', json_schema: { name: 'response', strict: true, schema: querySchema }
  })
  assert.deepEqual(captured.at(-1)!.messages, nativeInput.messages)
  checks.push('plain chat, untyped JSON and native schema transport retain their existing contracts')

  const repairStart = captured.length
  replies = [{ taskType: 'record_query' }, validDecision]
  assert.equal((await new AssistantIntentRouter(settings).resolve({ question })).taskType, 'record_query')
  const repairRequests = captured.slice(repairStart)
  assert.equal(repairRequests.length, 2)
  for (const request of repairRequests) assertSchemaDelivered(request, assistantIntentDecisionFormat)
  assert.match(repairRequests[1].messages.at(-1)!.content, /validationError/)
  checks.push('validation repair retains the full schema and original question')

  replies = [{ ...validDecision, sourceMode: 'knowledge' }, { ...validDecision, sourceMode: 'knowledge' }]
  await assert.rejects(new AssistantIntentRouter(settings).resolve({ question }), /任务、来源和技能组合不一致/)
  replies = ['not JSON', 'not JSON']
  await assert.rejects(new AssistantIntentRouter(settings).resolve({ question }), /路由未返回 JSON 对象/)
  checks.push('malformed or inconsistent decisions still fail closed instead of executing a guessed query')
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

console.log(JSON.stringify({ ok: true, checks }))
