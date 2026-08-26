import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  AssistantRunCancelledError,
  AssistantRunRegistry,
  runWithAssistantRunContext
} from '../src/main/assistant/run-controller'
import { AnswerStream } from '../src/main/assistant/answer-stream'
import { ModelClient, type ModelChatInput, type ModelResponse } from '../src/main/model-client'
import type { AgentProgressUpdate } from '../src/shared/expert-types'
import type { ModelSettings } from '../src/shared/types'

type StreamingInput = ModelChatInput & { stream: true }

type ProviderCase = {
  name: string
  settings: ModelSettings
  url: string
  contentType: string
  successBody: string
  missingEndBody: string
  malformedBody: string
  errorBody: string
}

type JsonFallbackCase = {
  name: string
  settings: ModelSettings
  url: string
  body: string
}

const visibleInput = (): StreamingInput => ({
  messages: [{ role: 'user', content: '请返回可验证的简短结果。' }],
  forceThinking: false,
  stream: true,
  numPredict: 128,
  timeoutMs: 5_000
})

const textBytes = new TextEncoder()

/** Deliberately split inside JSON, SSE fields, and UTF-8 sequences. */
const byteChunks = (value: string, sizes: number[] = [1, 2, 3, 5, 8, 13]): Uint8Array[] => {
  const encoded = textBytes.encode(value)
  const chunks: Uint8Array[] = []
  let offset = 0
  let index = 0
  while (offset < encoded.length) {
    const size = sizes[index % sizes.length]
    chunks.push(encoded.slice(offset, Math.min(encoded.length, offset + size)))
    offset += size
    index += 1
  }
  return chunks
}

const streamResponse = (
  body: string,
  contentType: string,
  sizes?: number[]
): Response => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of byteChunks(body, sizes)) controller.enqueue(chunk)
      controller.close()
    }
  }),
  { status: 200, headers: { 'Content-Type': contentType } }
)

const httpErrorResponse = (message: string): Response => new Response(
  JSON.stringify({ error: { message } }),
  { status: 502, headers: { 'Content-Type': 'application/json' } }
)

const withFetch = async <T>(
  mock: typeof globalThis.fetch,
  callback: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const sse = (...events: Array<{ event?: string; data: unknown }>): string => events.map(({ event, data }) => (
  `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
)).join('')

const providers: ProviderCase[] = [
  {
    name: 'Ollama NDJSON',
    settings: {
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'streaming-regression',
      thinking: false
    },
    url: 'http://127.0.0.1:11434/api/chat',
    contentType: 'application/x-ndjson',
    successBody: [
      JSON.stringify({ message: { role: 'assistant', content: '你', thinking: '隐藏思维一' }, done: false }),
      JSON.stringify({ message: { content: '好', reasoning_content: '隐藏推理二' }, done: false }),
      JSON.stringify({
        message: {
          content: '。',
          tool_calls: [{ id: 'call-ollama', function: { name: 'lookup', arguments: { secret: '工具 JSON' } } }]
        },
        done: false
      }),
      JSON.stringify({ done: true, done_reason: 'stop' })
    ].join('\n') + '\n',
    missingEndBody: `${JSON.stringify({ message: { content: '部分' }, done: false })}\n`,
    malformedBody: '{"message":{"content":"部分"}\n',
    errorBody: `${JSON.stringify({ message: { content: '前置' }, done: false })}\n${JSON.stringify({ error: 'provider stream failed' })}\n`
  },
  {
    name: 'OpenAI Chat Completions SSE',
    settings: {
      source: 'online',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'streaming-regression',
      thinking: true,
      apiKey: 'test-key'
    },
    url: 'https://api.openai.com/v1/chat/completions',
    contentType: 'text/event-stream',
    successBody: sse(
      { data: { choices: [{ delta: { role: 'assistant', content: '你', reasoning_content: '隐藏思维一' } }] } },
      { data: { choices: [{ delta: { reasoning_content: '隐藏推理二' } }] } },
      {
        data: {
          choices: [{ delta: {
            tool_calls: [{ index: 0, id: 'call-openai', function: { name: 'lookup', arguments: '{"secret":"工具 JSON"}' } }]
          } }]
        }
      },
      { data: { choices: [{ delta: { content: '好' } }] } },
      { data: { choices: [{ delta: { content: '。' }, finish_reason: 'stop' }] } },
      { data: '[DONE]' }
    ),
    missingEndBody: sse({ data: { choices: [{ delta: { content: '部分' } }] } }),
    malformedBody: 'data: {"choices":[}\n\n',
    errorBody: sse(
      { data: { choices: [{ delta: { content: '前置' } }] } },
      { data: { error: { message: 'provider stream failed' } } }
    )
  },
  {
    name: 'RawChat Responses SSE',
    settings: {
      source: 'online',
      provider: 'rawchat-codex',
      baseUrl: 'https://rawchat.cn/codex',
      model: 'streaming-regression',
      thinking: true,
      apiKey: 'test-key'
    },
    url: 'https://rawchat.cn/codex/responses',
    contentType: 'text/event-stream',
    successBody: sse(
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '你' } },
      { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: '隐藏摘要' } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', delta: '{"secret":"工具 JSON"}' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '好' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '。' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } }
    ),
    missingEndBody: sse({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '部分' } }),
    malformedBody: 'event: response.output_text.delta\ndata: {"type":}\n\n',
    errorBody: sse(
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '前置' } },
      { event: 'response.failed', data: { type: 'response.failed', error: { message: 'provider stream failed' } } }
    )
  },
  {
    name: 'Anthropic SSE',
    settings: {
      source: 'online',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'streaming-regression',
      thinking: true,
      apiKey: 'test-key'
    },
    url: 'https://api.anthropic.com/v1/messages',
    contentType: 'text/event-stream',
    successBody: sse(
      { event: 'message_start', data: { type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '隐藏思维一' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"secret":"工具 JSON"}' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '。' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      { event: 'message_stop', data: { type: 'message_stop' } }
    ),
    missingEndBody: sse({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部分' } } }),
    malformedBody: 'event: content_block_delta\ndata: {"type":}\n\n',
    errorBody: sse(
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '前置' } } },
      { event: 'error', data: { type: 'error', error: { message: 'provider stream failed' } } }
    )
  }
]

const openAiCompatibleJsonFallback: JsonFallbackCase = {
  name: 'OpenAI-compatible JSON fallback',
  settings: {
    source: 'online',
    provider: 'openai-compatible',
    baseUrl: 'https://compatible.example/v1',
    model: 'streaming-regression',
    thinking: true,
    apiKey: 'test-key'
  },
  url: 'https://compatible.example/v1/chat/completions',
  body: JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: '兼容回答',
        reasoning_content: '隐藏思维',
        tool_calls: [{
          id: 'call-compatible',
          function: { name: 'lookup', arguments: '{"secret":"工具 JSON"}' }
        }]
      },
      finish_reason: 'stop'
    }]
  })
}

const streamRequest = async (
  provider: ProviderCase,
  body: string,
  options: { expectedStatus?: number; abortAfterFirstDelta?: () => void } = {}
): Promise<{ response?: ModelResponse; deltas: string[]; requestBody?: Record<string, unknown> }> => {
  const deltas: string[] = []
  let requestBody: Record<string, unknown> | undefined
  return await withFetch(async (input, init) => {
    assert.equal(String(input), provider.url)
    assert.equal(init?.method, 'POST')
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return options.expectedStatus && options.expectedStatus !== 200
      ? httpErrorResponse('provider stream failed')
      : streamResponse(body, provider.contentType)
  }, async () => {
    const input: StreamingInput = {
      ...visibleInput(),
      onTextDelta: (delta) => {
        deltas.push(delta)
        if (deltas.length === 1) options.abortAfterFirstDelta?.()
      }
    }
    try {
      return { response: await new ModelClient(provider.settings).chat(input), deltas, requestBody }
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deltas, requestBody })
    }
  })
}

const testProviderSuccessAndRequestContract = async (provider: ProviderCase): Promise<void> => {
  const result = await streamRequest(provider, provider.successBody)
  assert.ok(result.response, `${provider.name} should resolve after its normal terminator`)
  assert.deepEqual(result.deltas, ['你', '好', '。'], `${provider.name} visible deltas preserve wire order`)
  assert.equal(result.response?.message?.content, '你好。', `${provider.name} final content is the visible aggregate`)
  assert.equal(result.requestBody?.stream, true, `${provider.name} request must opt into streaming`)
  const visible = result.deltas.join('')
  const serialized = result.response?.message?.content ?? ''
  assert.ok(!visible.includes('隐藏'), `${provider.name} reasoning must not enter onTextDelta`)
  assert.ok(!visible.includes('工具 JSON'), `${provider.name} tool JSON must not enter onTextDelta`)
  assert.ok(!serialized.includes('隐藏'), `${provider.name} reasoning must not enter final content`)
  assert.ok(!serialized.includes('工具 JSON'), `${provider.name} tool JSON must not enter final content`)
}

const testMissingEndAndMalformedFrame = async (provider: ProviderCase): Promise<void> => {
  for (const [label, body] of [
    ['missing terminator', provider.missingEndBody],
    ['malformed frame', provider.malformedBody]
  ] as const) {
    let thrown: unknown
    try {
      await streamRequest(provider, body)
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown, `${provider.name} ${label} must reject`)
    assert.match(errorMessage(thrown), /流|stream|响应|response|JSON|JSON|结束|完成|终止|SSE/i)
    const observedDeltas = (thrown as { deltas?: string[] }).deltas ?? []
    assert.ok(!observedDeltas.join('').includes('隐藏'), `${provider.name} ${label} must not leak reasoning`)
    assert.ok(!observedDeltas.join('').includes('工具 JSON'), `${provider.name} ${label} must not leak tool JSON`)
  }
}

const testNon2xxDoesNotEmit = async (provider: ProviderCase): Promise<void> => {
  const deltas: string[] = []
  let thrown: unknown
  await withFetch(async (input, init) => {
    assert.equal(String(input), provider.url)
    assert.equal(init?.method, 'POST')
    return httpErrorResponse('upstream rejected streaming request')
  }, async () => {
    try {
      await new ModelClient(provider.settings).chat({
        ...visibleInput(),
        onTextDelta: (delta) => deltas.push(delta)
      })
    } catch (error) {
      thrown = error
    }
  })
  assert.ok(thrown, `${provider.name} non-2xx must reject`)
  assert.equal(deltas.length, 0, `${provider.name} non-2xx must not emit deltas`)
  assert.match(errorMessage(thrown), /失败|错误|rejected|stream|模型|API/i)
}

const testProviderErrorEventDoesNotComplete = async (provider: ProviderCase): Promise<void> => {
  let thrown: unknown
  let deltas: string[] = []
  try {
    const result = await streamRequest(provider, provider.errorBody)
    deltas = result.deltas
  } catch (error) {
    thrown = error
    deltas = (error as { deltas?: string[] }).deltas ?? []
  }
  assert.ok(thrown, `${provider.name} provider error event must reject`)
  assert.deepEqual(deltas, ['前置'], `${provider.name} may retain only already received visible text`)
  assert.match(errorMessage(thrown), /provider stream failed|失败|错误|stream/i)
}

const jsonFallbackCases: JsonFallbackCase[] = [
  {
    name: 'Ollama JSON fallback',
    settings: providers[0].settings,
    url: providers[0].url,
    body: JSON.stringify({
      message: { role: 'assistant', content: '兼容回答', thinking: '隐藏思维' },
      done: true,
      done_reason: 'stop'
    })
  },
  {
    name: 'OpenAI JSON fallback',
    settings: providers[1].settings,
    url: providers[1].url,
    body: JSON.stringify({
      choices: [{
        message: {
          role: 'assistant',
          content: '兼容回答',
          reasoning_content: '隐藏思维',
          tool_calls: [{
            id: 'call-openai-json',
            function: { name: 'lookup', arguments: '{"secret":"工具 JSON"}' }
          }]
        },
        finish_reason: 'stop'
      }]
    })
  },
  {
    name: 'RawChat JSON fallback',
    settings: providers[2].settings,
    url: providers[2].url,
    body: JSON.stringify({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '兼容回答' }] },
        { type: 'function_call', id: 'call-raw-json', call_id: 'call-raw-json', name: 'lookup', arguments: '{"secret":"工具 JSON"}' }
      ]
    })
  },
  {
    name: 'Anthropic JSON fallback',
    settings: providers[3].settings,
    url: providers[3].url,
    body: JSON.stringify({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '隐藏思维' },
        { type: 'text', text: '兼容回答' },
        { type: 'tool_use', id: 'call-anthropic-json', name: 'lookup', input: { secret: '工具 JSON' } }
      ]
    })
  },
  openAiCompatibleJsonFallback
]

const testJsonContentTypeFallback = async (provider: JsonFallbackCase): Promise<void> => {
  const deltas: string[] = []
  let requestBody: Record<string, unknown> | undefined
  const response = await withFetch(async (input, init) => {
    assert.equal(String(input), provider.url)
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(provider.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }, async () => new ModelClient(provider.settings).chat({
    ...visibleInput(),
    onTextDelta: (delta) => deltas.push(delta)
  }))
  assert.equal(requestBody?.stream, true, `${provider.name} still requests stream:true`)
  assert.equal(response.message?.content, '兼容回答', `${provider.name} falls back to JSON content`)
  assert.ok(deltas.length <= 1, `${provider.name} JSON fallback emits at most one visible delta`)
  if (deltas.length === 1) assert.equal(deltas[0], '兼容回答')
  assert.ok(!deltas.join('').includes('隐藏'), `${provider.name} JSON reasoning does not reach onTextDelta`)
  assert.ok(!deltas.join('').includes('工具 JSON'), `${provider.name} JSON tool args do not reach onTextDelta`)
  assert.ok(!response.message?.content?.includes('隐藏'))
  assert.ok(!response.message?.content?.includes('工具 JSON'))
}

const testNetworkErrorClassification = async (): Promise<void> => {
  const provider = providers[1]
  const networkError = new Error('socket reset by peer')
  let thrown: unknown
  await withFetch(async () => {
    throw networkError
  }, async () => {
    try {
      await new ModelClient(provider.settings).chat(visibleInput())
    } catch (error) {
      thrown = error
    }
  })
  assert.ok(thrown)
  assert.match(errorMessage(thrown), /socket reset by peer|连接|网络|stream/i)
  assert.ok(!(thrown instanceof AssistantRunCancelledError), 'network failures are not user cancellation')
}

const testTimeoutClassification = async (): Promise<void> => {
  const provider = providers[1]
  const timeoutError = new DOMException('upstream request timed out', 'TimeoutError')
  let thrown: unknown
  await withFetch(async () => {
    throw timeoutError
  }, async () => {
    try {
      await new ModelClient(provider.settings).chat(visibleInput())
    } catch (error) {
      thrown = error
    }
  })
  assert.ok(thrown)
  assert.equal((thrown as DOMException).name, 'TimeoutError')
  assert.ok(!(thrown instanceof AssistantRunCancelledError), 'provider timeout is not user cancellation')
}

class FakeOwner {
  private destroyed = false
  private readonly listeners = new Set<() => void>()

  isDestroyed = (): boolean => this.destroyed

  once = (_event: 'destroyed', listener: () => void): void => {
    this.listeners.add(listener)
  }

  on = (_event: 'destroyed', listener: () => void): void => {
    this.listeners.add(listener)
  }

  removeListener = (_event: 'destroyed', listener: () => void): void => {
    this.listeners.delete(listener)
  }
}

const testCancellationStopsReaderAndLateEvents = async (): Promise<void> => {
  const provider = providers[0]
  const registry = new AssistantRunRegistry()
  const owner = new FakeOwner()
  const runId = '550e8400-e29b-41d4-a716-446655440099'
  const registration = registry.register(owner, runId)
  const firstFrame = `${JSON.stringify({ message: { content: '首段' }, done: false })}\n`
  const deltas: string[] = []
  let cancelledByFetch = false
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined
  const pendingResponse = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      controller.enqueue(textBytes.encode(firstFrame))
    },
    cancel() {
      cancelledByFetch = true
    }
  }), { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })

  const promise = withFetch(async () => pendingResponse, async () => runWithAssistantRunContext(
    registration.context,
    () => new ModelClient(provider.settings).chat({
      ...visibleInput(),
      onTextDelta: (delta) => deltas.push(delta)
    })
  ))

  for (let attempt = 0; attempt < 200 && deltas.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  }
  assert.deepEqual(deltas, ['首段'], 'cancel fixture must observe the first visible delta')
  const cancelResult = registry.cancel(owner, runId)
  assert.equal(cancelResult.ok, true)
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof AssistantRunCancelledError, 'user cancellation has a distinct error')
  assert.equal((thrown as AssistantRunCancelledError).runId, runId)
  assert.equal(cancelledByFetch, true, 'cancellation must cancel the provider reader/fetch')
  controllerRef?.error(new Error('late provider frame'))
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(deltas, ['首段'], 'cancelled streams emit no late delta')
  registry.finish(owner, runId)
}

const testAnswerStreamContract = (): void => {
  const events: Array<Extract<AgentProgressUpdate['event'], { type: 'text' }>> = []
  const stream = new AnswerStream({ emit: (event) => events.push(event) })
  stream.push('你好')
  stream.complete('你好。')
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3])
  assert.deepEqual(events.map((event) => event.content), ['你好', '。', ''])
  assert.equal(events.at(-1)?.done, true)
  assert.equal(events.some((event) => event.replace || event.reset), false)
  assert.equal(stream.text, '你好。')

  const replacementEvents: Array<Extract<AgentProgressUpdate['event'], { type: 'text' }>> = []
  const replacement = new AnswerStream({ emit: (event) => replacementEvents.push(event) })
  replacement.push('未经验证')
  replacement.complete('权威答案')
  assert.equal(replacementEvents[1]?.replace, true)
  assert.equal(replacementEvents[1]?.reset, true)
  assert.equal(replacementEvents.at(-1)?.done, true)
  assert.equal(replacement.text, '权威答案')

  const failedEvents: Array<Extract<AgentProgressUpdate['event'], { type: 'text' }>> = []
  const failed = new AnswerStream({ emit: (event) => failedEvents.push(event) })
  failed.push('尚未验证')
  failed.abandon()
  failed.complete('不应提交')
  assert.deepEqual(failedEvents.map((event) => event.content), ['尚未验证'])
  assert.equal(failedEvents.some((event) => event.done), false)

  const controller = new AbortController()
  const cancelledEvents: Array<Extract<AgentProgressUpdate['event'], { type: 'text' }>> = []
  const cancelled = new AnswerStream({ emit: (event) => cancelledEvents.push(event), signal: controller.signal })
  cancelled.push('首段')
  controller.abort()
  cancelled.push('迟到')
  cancelled.complete('最终答案')
  assert.deepEqual(cancelledEvents.map((event) => event.content), ['首段'])
  assert.equal(cancelledEvents.some((event) => event.done), false)
}

const testAgentAndRendererStreamingBoundaries = (): void => {
  const repositoryRoot = resolve(process.cwd())
  const ollamaSource = readFileSync(resolve(repositoryRoot, 'src/main/ollama.ts'), 'utf8')
  const indexSource = readFileSync(resolve(repositoryRoot, 'src/main/index.ts'), 'utf8')
  const rendererSource = readFileSync(resolve(repositoryRoot, 'src/renderer/src/App.tsx'), 'utf8')

  // The model client callback is wired to the plain conversation answer only.
  // Planner, data, and evidence calls remain non-streaming internal calls.
  const conversationStart = ollamaSource.indexOf("if (plan.intent === 'conversation')")
  const recordStart = ollamaSource.indexOf('let recordExecution', conversationStart)
  assert.ok(conversationStart >= 0 && recordStart > conversationStart)
  const conversationBlock = ollamaSource.slice(conversationStart, recordStart)
  assert.match(conversationBlock, /onTextDelta/)
  const planningStart = ollamaSource.indexOf('const planResponse = await this.callModel({')
  assert.ok(planningStart >= 0)
  assert.doesNotMatch(ollamaSource.slice(planningStart, ollamaSource.indexOf('raw = parsePlannerResponse', planningStart)), /onTextDelta/)
  const evidenceStart = ollamaSource.indexOf('const response = await this.callModel({', recordStart)
  const modelAnswerStart = ollamaSource.indexOf('const modelAnswer =', evidenceStart)
  assert.ok(evidenceStart >= 0 && modelAnswerStart > evidenceStart)
  assert.doesNotMatch(ollamaSource.slice(evidenceStart, modelAnswerStart), /onTextDelta/)
  for (const internalAgentPath of [
    'src/main/assistant/intent-router.ts',
    'src/main/experts/requirement-analysis-agent.ts',
    'src/main/experts/visualization-agent.ts',
    'src/main/assistant/agents/data-center-agent.ts',
    'src/main/assistant/agents/knowledge-base-agent.ts'
  ]) {
    const internalAgentSource = readFileSync(resolve(repositoryRoot, internalAgentPath), 'utf8')
    assert.doesNotMatch(internalAgentSource, /onTextDelta|stream\s*:\s*true/, `${internalAgentPath} must remain internal/non-streaming`)
  }

  // Main owns the outer run envelope and gates completion on verified output.
  assert.match(indexSource, /new AnswerStream\(/)
  assert.match(indexSource, /runId:\s*registration\.runId/)
  assert.match(indexSource, /answerStream\.complete\(response\.answer\)/)
  assert.match(indexSource, /answerStream\.abandon\(\)/)
  assert.match(indexSource, /response\.needsClarification\s*\|\|\s*response\.cancelled\s*\|\|\s*hasErrorEvent/)

  // Renderer accepts only the active run/session, rejects sequence gaps, keeps
  // partial text out of persisted messages, and clears it when a run stops.
  assert.match(rendererSource, /update\.runId\s*!==\s*activeRun\.runId/)
  assert.match(rendererSource, /activeRun\.sessionId\s*!==\s*conversationId/)
  assert.match(rendererSource, /sequence !== undefined/)
  assert.match(rendererSource, /sequence !== current\.lastSequence \+ 1/)
  assert.match(rendererSource, /answerStreamRef\.current\s*=\s*null/)
  assert.match(rendererSource, /clearAnswerStream\(runId\)/)
  assert.match(rendererSource, /const completedMessages: ChatMessage\[\] =/)
}

const main = async (): Promise<void> => {
  for (const provider of providers) {
    await testProviderSuccessAndRequestContract(provider)
    await testMissingEndAndMalformedFrame(provider)
    await testNon2xxDoesNotEmit(provider)
    await testProviderErrorEventDoesNotComplete(provider)
  }
  await testNetworkErrorClassification()
  await testTimeoutClassification()
  for (const provider of jsonFallbackCases) await testJsonContentTypeFallback(provider)
  await testCancellationStopsReaderAndLateEvents()
  testAnswerStreamContract()
  testAgentAndRendererStreamingBoundaries()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'fragmented Ollama NDJSON visible deltas and done:true aggregation',
      'fragmented OpenAI Chat Completions SSE visible deltas and [DONE] aggregation',
      'fragmented RawChat Responses SSE visible deltas and response.completed aggregation',
      'fragmented Anthropic SSE visible deltas and message_stop aggregation',
      'reasoning, thinking summaries, and tool JSON never enter visible content',
      'missing terminators and malformed frames fail closed for all providers',
      'provider error frames reject without a completion event',
      'non-2xx responses emit no text deltas',
      'network failure remains distinct from assistant cancellation',
      'timeout remains distinct from assistant cancellation',
      'stream:true JSON responses fall back to one complete visible answer for all providers',
      'assistant cancellation aborts the reader and suppresses late deltas',
      'AnswerStream sequences, replacement, abandon, done, and cancellation contract',
      'planner/evidence calls stay internal while only final conversation streams',
      'main run envelope and verified completion gate remain stable',
      'renderer filters active run/session, sequence gaps, partial persistence, and cleanup'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
