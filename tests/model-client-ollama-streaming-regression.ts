import assert from 'node:assert/strict'

import { ModelClient, type ModelChatInput } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

type StreamingModelChatInput = ModelChatInput & { stream: true }

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'ollama-streaming-regression',
  thinking: false
}

const streamingInput = (): StreamingModelChatInput => ({
  messages: [{ role: 'user', content: '请返回一个简短结果。' }],
  think: false,
  stream: true,
  numCtx: 12_345,
  numPredict: 777
})

const byteChunks = (value: string, sizes: number[]): Uint8Array[] => {
  const encoded = new TextEncoder().encode(value)
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

const streamResponse = (chunks: Uint8Array[]): Response => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(chunk))
      controller.close()
    }
  }),
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
)

const interruptedResponse = (firstChunk: string, error: Error): Response => new Response(
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(firstChunk))
      controller.error(error)
    }
  }),
  { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
)

const withFetch = async <T>(
  mock: typeof globalThis.fetch,
  run: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

const testFragmentAggregationAndRequestContract = async (): Promise<void> => {
  const ndjson = [
    JSON.stringify({ message: { role: 'assistant', content: '第一段' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: '与第二段' }, done: false }),
    JSON.stringify({
      message: {
        role: 'assistant',
        content: '完成。',
        thinking: '这是隐藏思维链，不应进入 ModelResponse'
      },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 123,
      eval_count: 45,
      prompt_eval_duration: 2_000_000,
      eval_duration: 3_000_000,
      total_duration: 7_000_000,
      load_duration: 1_000_000
    })
  ].join('\n') + '\n'
  let requestBody: Record<string, unknown> | undefined

  await withFetch(async (input, init) => {
    assert.equal(String(input), `${settings.baseUrl}/api/chat`)
    assert.equal(init?.method, 'POST')
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return streamResponse(byteChunks(ndjson, [1, 2, 5, 3, 8]))
  }, async () => {
    const response = await new ModelClient(settings).chat(streamingInput())
    assert.equal(response.message?.role, 'assistant')
    assert.equal(response.message?.content, '第一段与第二段完成。')
    assert.deepEqual(response.usage, {
      promptTokens: 123,
      completionTokens: 45,
      promptDurationMs: 2,
      completionDurationMs: 3,
      totalDurationMs: 7,
      loadDurationMs: 1
    })
    assert.ok(!JSON.stringify(response).includes('隐藏思维链'))
    assert.equal(response.message?.reasoningContent, undefined)
    assert.equal(response.message?.providerContent, undefined)
  })

  assert.equal(requestBody?.stream, true, 'Ollama streaming requests must send stream:true')
  const options = requestBody?.options as Record<string, unknown> | undefined
  assert.equal(options?.num_ctx, 12_345, 'numCtx must map to Ollama options.num_ctx')
  assert.equal(options?.num_predict, 777, 'numPredict must map to Ollama options.num_predict')
}

const testMissingDoneFrame = async (): Promise<void> => {
  const ndjson = [
    JSON.stringify({ message: { role: 'assistant', content: '尚未完成' }, done: false }),
    JSON.stringify({ message: { role: 'assistant', content: '，连接已关闭' }, done: false })
  ].join('\n') + '\n'

  await withFetch(async () => streamResponse(byteChunks(ndjson, [4, 1, 7])), async () => {
    await assert.rejects(
      new ModelClient(settings).chat(streamingInput()),
      (error) => {
        const message = errorMessage(error)
        assert.match(message, /Ollama/i)
        assert.match(message, /done\s*[:=]?\s*true|完整|完成标记|结束|断流/i)
        return true
      }
    )
  })
}

const testInterruptedStream = async (): Promise<void> => {
  const streamError = new Error('socket closed before final done frame')
  const firstFrame = `${JSON.stringify({ message: { role: 'assistant', content: '部分结果' }, done: false })}\n`

  await withFetch(async () => interruptedResponse(firstFrame, streamError), async () => {
    await assert.rejects(
      new ModelClient(settings).chat(streamingInput()),
      (error) => {
        const message = errorMessage(error)
        assert.match(message, /Ollama|流/i)
        assert.match(message, /socket closed before final done frame/i)
        return true
      }
    )
  })
}

const testOllamaErrorFrame = async (): Promise<void> => {
  const serverMessage = 'model requires more system memory'
  const ndjson = `${JSON.stringify({ error: serverMessage })}\n`

  await withFetch(async () => streamResponse(byteChunks(ndjson, [2, 3, 1])), async () => {
    await assert.rejects(
      new ModelClient(settings).chat(streamingInput()),
      (error) => {
        const message = errorMessage(error)
        assert.match(message, /Ollama/i)
        assert.ok(message.includes(serverMessage))
        return true
      }
    )
  })
}

const testFetchCauseDiagnostics = async (): Promise<void> => {
  const cases = [
    { code: 'UND_ERR_HEADERS_TIMEOUT', detail: 'Headers Timeout Error' },
    { code: 'ECONNRESET', detail: 'socket hang up' }
  ]
  const failures: string[] = []

  for (const scenario of cases) {
    await withFetch(async () => {
      const cause = Object.assign(new Error(scenario.detail), { code: scenario.code })
      throw new TypeError('fetch failed', { cause })
    }, async () => {
      let thrown: unknown
      try {
        await new ModelClient(settings).chat(streamingInput())
      } catch (error) {
        thrown = error
      }
      if (thrown === undefined) {
        failures.push(`${scenario.code}: request unexpectedly succeeded`)
        return
      }
      const message = errorMessage(thrown)
      if (!message.includes(scenario.code)) failures.push(`${scenario.code}: missing cause code in "${message}"`)
      if (!message.includes(scenario.detail)) failures.push(`${scenario.code}: missing cause message in "${message}"`)
    })
  }

  assert.equal(failures.length, 0, failures.join('\n'))
}

const main = async (): Promise<void> => {
  await testFragmentAggregationAndRequestContract()
  await testMissingDoneFrame()
  await testInterruptedStream()
  await testOllamaErrorFrame()
  await testFetchCauseDiagnostics()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'fragmented Ollama NDJSON content aggregation',
      'Ollama request body uses stream:true',
      'Ollama request forwards numCtx and numPredict budgets',
      'Ollama usage telemetry is retained as safe numeric metrics',
      'Ollama hidden thinking content is excluded from ModelResponse',
      'missing done:true is rejected',
      'interrupted response stream remains diagnosable',
      'Ollama error frames are surfaced',
      'fetch cause codes and messages remain diagnosable'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
