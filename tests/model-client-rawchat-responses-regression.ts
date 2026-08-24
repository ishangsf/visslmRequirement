import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage } from 'node:http'
import { isRawChatResponsesBaseUrl, ModelClient, type ModelMessage } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

type CapturedRequest = {
  method: string
  path: string
  body?: Record<string, unknown>
}

const captured: CapturedRequest[] = []

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (request, response) => {
  const path = request.url ?? ''
  if (request.method === 'GET' && path === '/raw/invalid/models') {
    captured.push({ method: 'GET', path })
    response.statusCode = 401
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ error: { message: 'Invalid API key.', type: 'authentication_error' } }))
    return
  }
  if (request.method === 'GET' && path === '/raw/models') {
    captured.push({ method: 'GET', path })
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }))
    return
  }

  if (request.method !== 'POST' || path !== '/raw/responses') {
    response.statusCode = 404
    response.end(JSON.stringify({ error: 'not found' }))
    return
  }

  const body = JSON.parse(await readBody(request)) as Record<string, unknown>
  captured.push({ method: 'POST', path, body })
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  const hasFunctionOutput = Array.isArray(body.input) && body.input.some((item) => (
    typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'function_call_output'
  ))
  response.setHeader('Content-Type', 'application/json')
  if (hasTools && !hasFunctionOutput) {
    response.end(JSON.stringify({
      id: 'resp_tool',
      status: 'completed',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'probe_tool',
        arguments: '{"value":"hello"}'
      }],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }
    }))
    return
  }
  response.end(JSON.stringify({
    id: 'resp_text',
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: hasFunctionOutput ? '{"answer":"OK"}' : 'OK' }]
    }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 }
  }))
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const origin = `http://127.0.0.1:${address.port}`

try {
  assert.equal(isRawChatResponsesBaseUrl('https://rawchat.cn/codex'), true)
  assert.equal(isRawChatResponsesBaseUrl('https://rawchat.cn/codex/'), true)
  assert.equal(isRawChatResponsesBaseUrl('https://rawchat.cn/codex/v1'), true)
  assert.equal(isRawChatResponsesBaseUrl('https://example.com/codex'), false)

  const settings: ModelSettings = {
    source: 'online',
    provider: 'rawchat-codex',
    baseUrl: `${origin}/raw`,
    model: 'gpt-5.6-sol',
    thinking: true,
    apiKey: 'rawchat-test-key'
  }
  const client = new ModelClient(settings)
  const probe = await client.test(true)
  assert.equal(probe.ok, true)
  assert.ok(probe.message.includes('最小问答测试通过'))

  const invalidProbe = await new ModelClient({
    ...settings,
    baseUrl: `${origin}/raw/invalid`,
    apiKey: 'invalid-key'
  }).test()
  assert.equal(invalidProbe.ok, false)
  assert.ok(invalidProbe.message.includes('API Key 无效'))

  const tool: Record<string, unknown> = {
    type: 'function',
    function: {
      name: 'probe_tool',
      description: 'A probe tool',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      }
    }
  }
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Use tools when asked.' },
    { role: 'user', content: 'Call the probe tool.' }
  ]
  const first = await client.chat({
    messages,
    tools: [tool],
    format: {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'string' } },
      required: ['answer']
    },
    forceThinking: false,
    numPredict: 64
  })
  assert.equal(first.message?.tool_calls?.[0]?.function.name, 'probe_tool')
  assert.deepEqual(first.message?.tool_calls?.[0]?.function.arguments, { value: 'hello' })
  assert.equal(first.usage?.promptTokens, 11)
  assert.equal(first.usage?.completionTokens, 7)
  messages.push(first.message!)
  messages.push({ role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' })

  const second = await client.chat({ messages, forceThinking: true, format: 'json', numPredict: 32 })
  assert.equal(second.message?.content, '{"answer":"OK"}')

  const historicalAssistant = await client.chat({
    messages: [
      { role: 'system', content: 'Keep the answer concise.' },
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up question' }
    ],
    numPredict: 8
  })
  assert.equal(historicalAssistant.message?.content, 'OK')

  const probeRequest = captured.find((request) => request.method === 'POST' && request.body?.id === undefined && (
    Array.isArray(request.body?.input) && request.body.input.some((item) => (
      typeof item === 'object' && item !== null && (item as Record<string, unknown>).role === 'user'
    ))
  ))
  assert.ok(probeRequest)
  const toolRequest = captured.find((request) => Array.isArray(request.body?.tools))
  assert.ok(toolRequest)
  assert.deepEqual(toolRequest.body?.tools, [{
    type: 'function',
    name: 'probe_tool',
    description: 'A probe tool',
    parameters: tool.function && (tool.function as Record<string, unknown>).parameters
  }])
  assert.deepEqual((toolRequest.body?.text as Record<string, unknown>).format, {
    type: 'json_schema',
    name: 'response',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { answer: { type: 'string' } },
      required: ['answer']
    }
  })
  assert.deepEqual(toolRequest.body?.reasoning, { effort: 'none' })
  assert.equal(toolRequest.body?.max_output_tokens, 64)

  const continuation = captured.find((request) => {
    if (request.method !== 'POST' || !Array.isArray(request.body?.input)) return false
    return request.body.input.some((item) => (
      typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'function_call'
    ))
  })
  assert.ok(continuation)
  assert.ok(continuation.body?.input?.some((item) => (
    typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'function_call_output'
  )))
  const historicalRequest = captured.find((request) => (
    request.method === 'POST' && Array.isArray(request.body?.input) && request.body.input.some((item) => (
      typeof item === 'object' && item !== null &&
      (item as Record<string, unknown>).role === 'assistant'
    ))
  ))
  assert.ok(historicalRequest)
  const historicalMessage = historicalRequest.body?.input?.find((item) => (
    typeof item === 'object' && item !== null &&
    (item as Record<string, unknown>).role === 'assistant'
  )) as Record<string, unknown> | undefined
  assert.deepEqual(historicalMessage?.content, [{ type: 'input_text', text: 'First answer' }])
  assert.equal(historicalRequest.body?.max_output_tokens, 16)

  console.log(JSON.stringify({
    ok: true,
    requests: captured.length,
    verified: [
      'RawChat URL detection',
      'Responses models probe',
      'Responses text format',
      'flattened function tools',
      'function_call parsing',
      'function_call_output continuation',
      'usage normalization',
      'historical assistant input_text normalization',
      'minimum output token clamp',
      'actionable invalid-key error'
    ]
  }, null, 2))
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
