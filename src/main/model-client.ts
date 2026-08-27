import type {
  ConnectionResult,
  ModelCapabilityEvidence,
  ModelCapabilityItem,
  ModelCapabilityReport,
  ModelCapabilityStatus,
  ModelSettings,
  ModelUsage
} from '../shared/types'
import {
  AssistantRunCancelledError,
  getAssistantRunContext,
  isAssistantRunCancellation,
  recordAssistantRunUsage,
  throwIfAssistantRunCancelled
} from './assistant/run-controller'

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  reasoningContent?: string
  providerContent?: Array<Record<string, unknown>>
  tool_calls?: Array<{
    id?: string
    function: { name: string; arguments: Record<string, unknown> }
  }>
}

export interface ModelResponse {
  message?: ModelMessage
  done_reason?: string
  usage?: ModelUsage
}

/**
 * Optional provider-facing reasoning budget.  Existing think/forceThinking
 * callers remain valid; when this field is omitted, providers keep their
 * historical boolean-based behavior.
 */
export type ModelReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

type ProviderReasoningEffort = Exclude<ModelReasoningEffort, 'xhigh'>

// Keep the public route expressive while degrading xhigh to the highest
// broadly supported provider value. Providers that do not expose a numeric
// effort simply use the boolean thinking switch below.
const providerReasoningEffort = (effort: ModelReasoningEffort): ProviderReasoningEffort =>
  effort === 'xhigh' ? 'high' : effort

export interface ModelChatRetryInfo {
  attempt: number
  maxAttempts: number
  delayMs: number
  status?: number
  requestId?: string
}

export interface ModelChatInput {
  messages: ModelMessage[]
  tools?: unknown[]
  think?: boolean
  forceThinking?: boolean
  reasoningEffort?: ModelReasoningEffort
  stream?: boolean
  numCtx?: number
  format?: 'json' | Record<string, unknown>
  temperature?: number
  numPredict?: number
  timeoutMs?: number
  /** Opt-in transient transport retries. Defaults to 0 for legacy callers. */
  maxTransportRetries?: number
  /** Optional direct caller signal; assistant runs also contribute their ALS signal. */
  signal?: AbortSignal
  /** Receives only visible final-answer text when this request is streamed. */
  onTextDelta?: (content: string) => void
  /** Safe transport-retry telemetry; never receives response text or secrets. */
  onRetry?: (info: ModelChatRetryInfo) => void
}

const trimBaseUrl = (value: string): string => value.replace(/\/+$/, '')
const defaultChatTimeoutMs = 180_000

/**
 * RawChat's Codex channel speaks the Responses API rather than the
 * OpenAI-compatible Chat Completions API used by the other online providers.
 * Keep this URL check deliberately narrow so an arbitrary compatible endpoint
 * is never sent a different wire format by accident.
 */
export const isRawChatResponsesBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value.trim())
    const pathname = url.pathname.replace(/\/+$/, '')
    return /(?:^|\.)rawchat\.cn$/i.test(url.hostname) && /^\/codex(?:\/v1)?(?:\/responses)?$/i.test(pathname)
  } catch {
    return false
  }
}

const rawChatBaseUrl = (value: string): string => trimBaseUrl(value).replace(/\/responses$/i, '')

const rawChatModelsUrl = (value: string): string => `${rawChatBaseUrl(value)}/models`

const rawChatResponsesUrl = (value: string): string => `${rawChatBaseUrl(value)}/responses`

interface ManagedRequestSignal {
  signal: AbortSignal
  cleanup: () => void
}

const requestSignal = (timeoutMs: number, callerSignal?: AbortSignal): ManagedRequestSignal => {
  throwIfAssistantRunCancelled()
  const timeoutSignal = AbortSignal.timeout(Math.max(1_000, Math.round(timeoutMs)))
  const runSignal = getAssistantRunContext()?.signal
  const signals = [timeoutSignal, callerSignal, runSignal].filter(
    (signal): signal is AbortSignal => Boolean(signal)
  )
  const controller = new AbortController()
  const listeners = signals.map((signal) => {
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    if (signal.aborted) listener()
    else signal.addEventListener('abort', listener, { once: true })
    return { signal, listener }
  })
  return {
    signal: controller.signal,
    cleanup: () => listeners.forEach(({ signal, listener }) => signal.removeEventListener('abort', listener))
  }
}

export class ModelHttpError extends Error {
  readonly status: number
  readonly retryAfterMs: number | undefined
  readonly requestId: string | undefined
  /** Response text after secret masking and a hard length cap. */
  readonly body: string
  readonly retryable: boolean

  constructor(
    message: string,
    details: {
      status: number
      retryAfterMs?: number
      requestId?: string
      body?: string
    }
  ) {
    super(message)
    this.name = 'ModelHttpError'
    this.status = details.status
    this.retryAfterMs = details.retryAfterMs
    this.requestId = details.requestId
    this.body = details.body ?? ''
    this.retryable = details.status === 408 || details.status === 409 || details.status === 429 ||
      (details.status >= 500 && details.status <= 599)
  }
}

const modelErrorBodyLimit = 500

const safeModelErrorBody = (value: string, apiKey?: string): string => {
  let safe = value
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [已隐藏]')
    .replace(/(api[-_ ]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .trim()
  const configuredApiKey = apiKey?.trim()
  if (configuredApiKey) safe = safe.split(configuredApiKey).join('[已隐藏]')
  return safe.slice(0, modelErrorBodyLimit)
}

const retryAfterMsFromHeader = (value: string | null): number | undefined => {
  const normalized = value?.trim()
  if (!normalized) return undefined
  const seconds = Number(normalized)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(normalized)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined
}

type SemaphoreWaiter = {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
  signals: AbortSignal[]
  cleanup: () => void
  settled: boolean
}

/**
 * A process-local, cancellation-aware semaphore shared by all ModelClient
 * instances that point at the same provider endpoint. It bounds both normal
 * calls and capability probes without holding a slot while a queued call is
 * paused or cancelled.
 */
class ModelRequestSemaphore {
  private active = 0
  private readonly queue: SemaphoreWaiter[] = []

  constructor(private readonly limit: number) {}

  acquire(signals: readonly AbortSignal[]): Promise<() => void> {
    const uniqueSignals = [...new Set(signals)]
    const alreadyAborted = uniqueSignals.find((signal) => signal.aborted)
    if (alreadyAborted) return Promise.reject(alreadyAborted.reason ?? new DOMException('请求已取消', 'AbortError'))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve(this.releaseHandle())
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve,
        reject,
        signals: uniqueSignals,
        cleanup: () => undefined,
        settled: false
      }
      const remove = (): void => {
        const index = this.queue.indexOf(waiter)
        if (index >= 0) this.queue.splice(index, 1)
      }
      const abort = (signal: AbortSignal): void => {
        if (waiter.settled) return
        waiter.settled = true
        remove()
        waiter.cleanup()
        waiter.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'))
        this.pump()
      }
      waiter.cleanup = (): void => waiter.signals.forEach((signal) => signal.removeEventListener('abort', () => abort(signal)))
      // Keep the exact listener per signal so cleanup can remove it reliably.
      const listeners = uniqueSignals.map((signal) => {
        const listener = (): void => abort(signal)
        signal.addEventListener('abort', listener, { once: true })
        return { signal, listener }
      })
      waiter.cleanup = (): void => listeners.forEach(({ signal, listener }) => signal.removeEventListener('abort', listener))
      this.queue.push(waiter)
      this.pump()
    })
  }

  private releaseHandle(): () => void {
    let released = false
    return (): void => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.pump()
    }
  }

  private pump(): void {
    while (this.active < this.limit && this.queue.length) {
      const waiter = this.queue.shift()!
      if (waiter.settled) continue
      const aborted = waiter.signals.find((signal) => signal.aborted)
      if (aborted) {
        waiter.settled = true
        waiter.cleanup()
        waiter.reject(aborted.reason ?? new DOMException('请求已取消', 'AbortError'))
        continue
      }
      waiter.settled = true
      waiter.cleanup()
      this.active += 1
      waiter.resolve(this.releaseHandle())
    }
  }
}

const modelRequestSemaphores = new Map<string, ModelRequestSemaphore>()

const modelRequestSemaphoreFor = (settings: Pick<ModelSettings, 'source' | 'provider' | 'baseUrl'>): ModelRequestSemaphore => {
  const key = `${settings.source}\u0000${settings.provider}\u0000${trimBaseUrl(settings.baseUrl)}`
  const existing = modelRequestSemaphores.get(key)
  if (existing) return existing
  // Project agreement extraction has a tested two-request local pipeline;
  // retain that endpoint-wide concurrency contract for all model clients.
  const limit = settings.source === 'local' || settings.provider === 'ollama' ? 2 : 4
  const semaphore = new ModelRequestSemaphore(limit)
  modelRequestSemaphores.set(key, semaphore)
  return semaphore
}

const cancellationSignals = (callerSignal?: AbortSignal): AbortSignal[] => {
  const runSignal = getAssistantRunContext()?.signal
  return [callerSignal, runSignal].filter((signal, index, values): signal is AbortSignal => Boolean(signal) && values.indexOf(signal) === index)
}

const throwIfRunWasCancelled = (error: unknown): void => {
  const context = getAssistantRunContext()
  if (context?.signal.aborted) throw new AssistantRunCancelledError(context.runId)
  if (isAssistantRunCancellation(error)) throw error
}

class OllamaProtocolError extends Error {}

const errorCause = (error: unknown): unknown => (
  typeof error === 'object' && error !== null && 'cause' in error
    ? (error as { cause?: unknown }).cause
    : undefined
)

const errorCode = (error: unknown): string | undefined => {
  let current: unknown = error
  const visited = new Set<unknown>()
  while (typeof current === 'object' && current !== null && !visited.has(current)) {
    visited.add(current)
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && code.trim()) return code.trim()
    current = errorCause(current)
  }
  return undefined
}

const errorMessages = (error: unknown): string[] => {
  const messages: string[] = []
  let current: unknown = error
  const visited = new Set<unknown>()
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current)
    const message = current instanceof Error
      ? current.message
      : typeof current === 'string'
        ? current
        : undefined
    if (message && !messages.includes(message)) messages.push(message)
    current = errorCause(current)
  }
  return messages
}

const modelTransportRetryLimit = 2
const modelTransportBackoffBaseMs = 250
const modelTransportBackoffMaxMs = 8_000
const modelRetryAfterLimitMs = 10_000

const errorChain = (error: unknown): unknown[] => {
  const chain: unknown[] = []
  const visited = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current)
    chain.push(current)
    current = errorCause(current)
  }
  return chain
}

const modelHttpErrorFrom = (error: unknown): ModelHttpError | undefined =>
  errorChain(error).find((item): item is ModelHttpError => item instanceof ModelHttpError)

const isTransientModelNetworkError = (error: unknown): boolean => errorChain(error).some((item) => {
  if (item instanceof ModelHttpError) return false
  if (!(item instanceof Error)) return false
  const rawCode = (item as Error & { code?: unknown }).code
  const code = typeof rawCode === 'string'
    ? rawCode.toUpperCase()
    : ''
  if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return true
  if (item.name === 'TimeoutError') return true
  return /fetch failed|network|socket|connect|timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(item.message)
})

const isModelRequestCancelled = (error: unknown, input: ModelChatInput): boolean => (
  Boolean(input.signal?.aborted) || Boolean(getAssistantRunContext()?.signal.aborted) || isAssistantRunCancellation(error)
)

const modelRetryDelayMs = (error: unknown, retryIndex: number): number => {
  const retryAfterMs = modelHttpErrorFrom(error)?.retryAfterMs
  const exponential = Math.min(
    modelTransportBackoffMaxMs,
    modelTransportBackoffBaseMs * 2 ** Math.max(0, retryIndex)
  )
  const jitter = Math.floor(Math.random() * Math.max(1, Math.min(250, Math.round(exponential * 0.25))))
  const requested = retryAfterMs === undefined
    ? exponential + jitter
    : Math.max(exponential + jitter, Math.max(0, retryAfterMs))
  return Math.min(modelRetryAfterLimitMs, requested)
}

const waitForModelRetry = (delayMs: number, signals: readonly AbortSignal[]): Promise<void> => {
  const uniqueSignals = [...new Set(signals)]
  const alreadyAborted = uniqueSignals.find((signal) => signal.aborted)
  if (alreadyAborted) return Promise.reject(alreadyAborted.reason ?? new DOMException('请求已取消', 'AbortError'))
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => uniqueSignals.forEach((signal) => {
      const listener = listeners.get(signal)
      if (listener) signal.removeEventListener('abort', listener)
    })
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      callback()
    }
    const listeners = new Map<AbortSignal, () => void>()
    const timer = setTimeout(() => finish(resolve), delayMs)
    uniqueSignals.forEach((signal) => {
      const listener = (): void => finish(() => reject(signal.reason ?? new DOMException('请求已取消', 'AbortError')))
      listeners.set(signal, listener)
      signal.addEventListener('abort', listener, { once: true })
    })
  })
}

const ollamaConnectionError = (error: unknown): Error => {
  if (error instanceof DOMException && error.name === 'TimeoutError') return error
  if (error instanceof Error && error.name === 'TimeoutError') return error

  const code = errorCode(error)
  const combinedMessage = errorMessages(error).join(' / ')
  const classification = code === 'UND_ERR_HEADERS_TIMEOUT'
    ? `响应头等待超时（${code}）`
    : code === 'UND_ERR_BODY_TIMEOUT'
      ? `响应数据等待超时（${code}）`
      : code === 'ECONNREFUSED'
        ? `连接被拒绝（${code}）`
        : code === 'ECONNRESET'
          ? `连接被重置（${code}）`
          : code === 'UND_ERR_SOCKET'
            ? `模型连接意外关闭（${code}）`
            : [combinedMessage || '未知网络错误', code ? `（${code}）` : ''].join('')
  const detail = code && combinedMessage
    ? `${classification}：${combinedMessage}`
    : classification
  return new Error(`Ollama 模型连接失败：${detail}`, { cause: error })
}

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

const ollamaUsage = (chunk: Record<string, unknown>): ModelUsage | undefined => {
  const usage: ModelUsage = {
    promptTokens: finiteNumber(chunk.prompt_eval_count),
    completionTokens: finiteNumber(chunk.eval_count),
    promptDurationMs: finiteNumber(chunk.prompt_eval_duration)
      ? Number(chunk.prompt_eval_duration) / 1_000_000
      : undefined,
    completionDurationMs: finiteNumber(chunk.eval_duration)
      ? Number(chunk.eval_duration) / 1_000_000
      : undefined,
    totalDurationMs: finiteNumber(chunk.total_duration)
      ? Number(chunk.total_duration) / 1_000_000
      : undefined,
    loadDurationMs: finiteNumber(chunk.load_duration)
      ? Number(chunk.load_duration) / 1_000_000
      : undefined
  }
  return Object.values(usage).some((value) => value !== undefined) ? usage : undefined
}

const rawChatUsage = (value: unknown): ModelUsage | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const usage = value as Record<string, unknown>
  const normalized: ModelUsage = {
    promptTokens: finiteNumber(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: finiteNumber(usage.completion_tokens ?? usage.output_tokens)
  }
  return Object.values(normalized).some((item) => item !== undefined) ? normalized : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
)

const asString = (value: unknown): string | undefined => (
  typeof value === 'string' ? value : undefined
)

const parseToolArguments = (value: unknown): Record<string, unknown> => {
  if (asRecord(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return asRecord(parsed) ?? {}
  } catch {
    return {}
  }
}

const responseInputForMessage = (message: ModelMessage): Array<Record<string, unknown>> => {
  if (message.role === 'tool') {
    if (!message.tool_call_id) return []
    return [{
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: message.content
    }]
  }

  if (message.role === 'assistant' && message.tool_calls?.length) {
    const items: Array<Record<string, unknown>> = []
    if (message.content.trim()) {
      items.push({
        role: 'assistant',
        // This is a historical input message, not a raw response item. The
        // Responses API expects input_text even when the role is assistant.
        content: [{ type: 'input_text', text: message.content }]
      })
    }
    for (const call of message.tool_calls) {
      if (!call.id || !call.function.name) continue
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: JSON.stringify(call.function.arguments ?? {})
      })
    }
    return items
  }

  if (!message.content.trim()) return []
  return [{
    role: message.role,
    // All messages in `input` are inputs. `output_text` is reserved for
    // response output items returned by the model.
    content: [{ type: 'input_text', text: message.content }]
  }]
}

const rawChatInput = (messages: ModelMessage[]): Array<Record<string, unknown>> => messages.flatMap(responseInputForMessage)

const rawChatTools = (tools: unknown[] | undefined): Array<Record<string, unknown>> | undefined => {
  if (!tools?.length) return undefined
  const mapped = tools.flatMap((tool) => {
    const record = asRecord(tool)
    if (!record) return []
    const nested = asRecord(record.function)
    const source = nested ?? record
    const name = asString(source.name)?.trim()
    if (!name) return []
    return [{
      type: 'function',
      name,
      ...(asString(source.description) ? { description: source.description } : {}),
      ...(source.parameters !== undefined ? { parameters: source.parameters } : {})
    }]
  })
  return mapped.length ? mapped : undefined
}

const rawChatTextFormat = (format: ModelChatInput['format']): Record<string, unknown> | undefined => {
  if (!format) return undefined
  if (format === 'json') return { type: 'json_object' }
  return {
    type: 'json_schema',
    name: 'response',
    // RawChat's Codex models can spend the entire budget trying to satisfy
    // OpenAI strict-schema's "all properties required" rule.  VISSLM's
    // schemas intentionally contain optional presentation/query fields, so
    // use the Responses schema guidance without strict constrained decoding.
    strict: false,
    schema: format
  }
}

type TextDeltaCallback = (content: string) => void

const emitVisibleTextDelta = (
  callback: TextDeltaCallback | undefined,
  signal: AbortSignal,
  content: unknown
): void => {
  if (!callback || typeof content !== 'string' || !content || signal.aborted) return
  throwIfAssistantRunCancelled()
  if (signal.aborted) return
  callback(content)
}

interface SseFrame {
  event?: string
  data: string
}

/**
 * Consume an SSE response without assuming network chunk boundaries. The
 * provider specific handlers decide which fields are visible answer text.
 */
const readSseStream = async (
  response: Response,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void
): Promise<void> => {
  if (!response.body) throw new ModelStreamProtocolError('流式响应缺少响应体')
  const reader = response.body.getReader()
  const cancelReader = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  if (signal.aborted) {
    cancelReader()
    throwIfAssistantRunCancelled()
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  }
  signal.addEventListener('abort', cancelReader, { once: true })

  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  const dispatch = (): void => {
    if (!eventName && !dataLines.length) return
    onFrame({
      ...(eventName ? { event: eventName } : {}),
      data: dataLines.join('\n')
    })
    eventName = ''
    dataLines = []
  }
  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) {
      dispatch()
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0
      ? ''
      : line.slice(separator + 1).startsWith(' ')
        ? line.slice(separator + 2)
        : line.slice(separator + 1)
    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
    // id/retry and unknown SSE fields are intentionally ignored.
  }

  try {
    const decoder = new TextDecoder()
    while (true) {
      throwIfAssistantRunCancelled()
      const result = await reader.read()
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer) consumeLine(buffer)
    // A final event may legally end at EOF without an extra blank line.
    dispatch()
  } catch (error) {
    throwIfRunWasCancelled(error)
    throw error
  } finally {
    signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
  }
}

class ModelStreamProtocolError extends Error {}

interface OpenAiStreamState {
  content: string
  toolCalls: Map<number, { id?: string; name: string; arguments: string }>
  done: boolean
  doneReason?: string
  usage?: ModelUsage
}

const parseStreamJson = (data: string, provider: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(data)
    const record = asRecord(parsed)
    if (!record) throw new Error('not an object')
    return record
  } catch {
    throw new ModelStreamProtocolError(`${provider} 流式响应包含无效 JSON 分片`)
  }
}

const isEventStreamResponse = (response: Response): boolean => (
  response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
)

const capabilityItem = (
  status: ModelCapabilityStatus,
  summary: string,
  evidence: ModelCapabilityEvidence,
  value?: number | boolean | string
): ModelCapabilityItem => ({
  status,
  summary,
  evidence,
  ...(value === undefined ? {} : { value })
})

const unknownCapability = (evidence: ModelCapabilityEvidence = 'metadata'): ModelCapabilityItem =>
  capabilityItem('unknown', '尚未完成可验证探测', evidence)

const probeErrorSummary = (error: unknown, apiKey?: string): string => {
  const message = error instanceof Error ? error.message : String(error)
  let sanitized = message
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [已隐藏]')
    .replace(/(api[-_ ]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]')
    .trim()
  const configuredApiKey = apiKey?.trim()
  if (configuredApiKey) sanitized = sanitized.split(configuredApiKey).join('[已隐藏]')
  return (sanitized || '探测请求失败').slice(0, 240)
}

const parseProbeObject = (content: string | undefined): Record<string, unknown> | undefined => {
  if (!content) return undefined
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

const capabilityProbeMessages = (instruction: string): ModelMessage[] => [
  {
    role: 'system',
    content: '这是模型能力探测，不涉及任何本地业务数据。请严格按用户要求返回结果，不要输出解释。'
  },
  { role: 'user', content: instruction }
]

const structuredProbeFormat: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: { ok: { type: 'boolean' } },
  required: ['ok']
}

const toolProbe = {
  type: 'function',
  function: {
    name: 'capability_probe',
    description: '能力探测工具。只用于验证工具调用协议。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
      required: ['ok']
    }
  }
}

const normalizeContextLength = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

const metadataStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(metadataStrings)
  if (typeof value === 'string') return [value.trim().toLowerCase()]
  return []
}

interface OllamaShowMetadata {
  capabilities: string[]
  contextLength?: number
  toolCalling?: boolean
  thinking?: boolean
}

const ollamaShowMetadata = (payload: Record<string, unknown>): OllamaShowMetadata => {
  const capabilities = metadataStrings(payload.capabilities)
  const hasCapabilityList = Array.isArray(payload.capabilities)
  const modelInfo = asRecord(payload.model_info) ?? {}
  const parameters = typeof payload.parameters === 'string' ? payload.parameters : ''
  const contextCandidates: unknown[] = [
    payload.context_length,
    payload.contextWindow,
    payload.num_ctx,
    payload.n_ctx
  ]
  for (const [key, value] of Object.entries(modelInfo)) {
    if (/(?:context(?:_length|\.length)?|num_ctx|n_ctx)/i.test(key)) contextCandidates.push(value)
  }
  const parameterContext = parameters.match(/(?:num_ctx|n_ctx|context_length)\s*[:= ]\s*(\d+)/i)
  if (parameterContext) contextCandidates.push(Number(parameterContext[1]))
  const contextLength = contextCandidates.map(normalizeContextLength).find((value) => value !== undefined)
  const capabilityText = capabilities.join(' ')
  const toolCalling = hasCapabilityList
    ? /\b(?:tool|tools|function(?:_?calling)?|completion_tool)\b/i.test(capabilityText)
    : undefined
  const thinking = hasCapabilityList
    ? /\b(?:thinking|reasoning)\b/i.test(capabilityText)
    : undefined
  return { capabilities, contextLength, toolCalling, thinking }
}

const openAiStreamResponse = (
  state: OpenAiStreamState,
  onTextDelta: TextDeltaCallback | undefined,
  signal: AbortSignal
): ModelResponse => ({
  done_reason: state.doneReason,
  message: {
    role: 'assistant',
    content: state.content,
    ...(state.toolCalls.size
      ? {
          tool_calls: [...state.toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, call]) => ({
              id: call.id,
              function: {
                name: call.name,
                arguments: parseToolArguments(call.arguments)
              }
            }))
        }
      : {})
  },
  ...(state.usage ? { usage: state.usage } : {})
})

const readOpenAiStream = async (
  response: Response,
  signal: AbortSignal,
  onTextDelta?: TextDeltaCallback
): Promise<ModelResponse> => {
  const state: OpenAiStreamState = { content: '', toolCalls: new Map(), done: false }
  await readSseStream(response, signal, (frame) => {
    if (signal.aborted) return
    const data = frame.data.trim()
    if (!data) return
    if (data === '[DONE]') {
      state.done = true
      return
    }
    const payload = parseStreamJson(data, 'OpenAI')
    if (asRecord(payload.error)) {
      const message = asString(asRecord(payload.error)?.message) ?? '模型流式响应失败'
      throw new ModelStreamProtocolError(`OpenAI 模型生成失败：${message}`)
    }
    const choices = Array.isArray(payload.choices) ? payload.choices : []
    for (const item of choices) {
      const choice = asRecord(item)
      if (!choice) continue
      const delta = asRecord(choice.delta)
      const content = asString(delta?.content)
      if (content) {
        state.content += content
        emitVisibleTextDelta(onTextDelta, signal, content)
      }
      // Reasoning content is deliberately not copied into ModelResponse or
      // exposed through onTextDelta.
      const toolDeltas = Array.isArray(delta?.tool_calls) ? delta.tool_calls : []
      for (const rawTool of toolDeltas) {
        const tool = asRecord(rawTool)
        if (!tool) continue
        const index = typeof tool.index === 'number' && Number.isInteger(tool.index) ? tool.index : 0
        const current = state.toolCalls.get(index) ?? { arguments: '', name: '' }
        const functionPart = asRecord(tool.function)
        const name = asString(functionPart?.name)
        const args = asString(functionPart?.arguments)
        if (name) current.name = name
        if (args) current.arguments += args
        if (asString(tool.id)) current.id = asString(tool.id)
        state.toolCalls.set(index, current)
      }
      const legacyFunction = asRecord(delta?.function_call)
      if (legacyFunction) {
        const current = state.toolCalls.get(0) ?? { arguments: '', name: '' }
        const name = asString(legacyFunction.name)
        const args = asString(legacyFunction.arguments)
        if (name) current.name = name
        if (args) current.arguments += args
        state.toolCalls.set(0, current)
      }
      const finishReason = asString(choice.finish_reason)
      if (finishReason) state.doneReason = finishReason
      const usage = asRecord(choice.usage) ?? asRecord(payload.usage)
      if (usage) {
        const normalized: ModelUsage = {
          promptTokens: finiteNumber(usage.prompt_tokens ?? usage.input_tokens),
          completionTokens: finiteNumber(usage.completion_tokens ?? usage.output_tokens)
        }
        if (Object.values(normalized).some((value) => value !== undefined)) state.usage = normalized
      }
    }
    const topLevelUsage = asRecord(payload.usage)
    if (topLevelUsage) {
      const normalized: ModelUsage = {
        promptTokens: finiteNumber(topLevelUsage.prompt_tokens ?? topLevelUsage.input_tokens),
        completionTokens: finiteNumber(topLevelUsage.completion_tokens ?? topLevelUsage.output_tokens)
      }
      if (Object.values(normalized).some((value) => value !== undefined)) state.usage = normalized
    }
  })
  if (!state.done) throw new ModelStreamProtocolError('OpenAI 流式响应未收到 [DONE] 结束帧')
  throwIfAssistantRunCancelled()
  return openAiStreamResponse(state, onTextDelta, signal)
}

interface RawChatStreamState {
  content: string
  toolCalls: Map<string, { id?: string; name: string; arguments: string }>
  done: boolean
  doneReason?: string
  usage?: ModelUsage
}

const rawChatStreamResponse = (state: RawChatStreamState): ModelResponse => ({
  done_reason: state.doneReason,
  message: {
    role: 'assistant',
    content: state.content,
    ...(state.toolCalls.size
      ? {
          tool_calls: [...state.toolCalls.values()].map((call) => ({
            id: call.id,
            function: {
              name: call.name,
              arguments: parseToolArguments(call.arguments)
            }
          }))
        }
      : {})
  },
  ...(state.usage ? { usage: state.usage } : {})
})

const readRawChatStream = async (
  response: Response,
  signal: AbortSignal,
  onTextDelta?: TextDeltaCallback
): Promise<ModelResponse> => {
  const state: RawChatStreamState = { content: '', toolCalls: new Map(), done: false }
  await readSseStream(response, signal, (frame) => {
    if (signal.aborted) return
    const data = frame.data.trim()
    if (!data) return
    if (data === '[DONE]') {
      state.done = true
      return
    }
    const payload = parseStreamJson(data, 'RawChat Codex')
    const eventType = asString(frame.event) ?? asString(payload.type) ?? ''
    if (eventType === 'error' || eventType === 'response.failed') {
      const errorRecord = asRecord(payload.error)
      throw new ModelStreamProtocolError(
        `RawChat Codex 模型生成失败：${asString(errorRecord?.message) ?? asString(payload.message) ?? '未知错误'}`
      )
    }
    if (eventType === 'response.output_text.delta') {
      const delta = asString(payload.delta)
      if (delta) {
        state.content += delta
        emitVisibleTextDelta(onTextDelta, signal, delta)
      }
    } else if (eventType === 'response.function_call_arguments.delta') {
      const key = asString(payload.item_id) ?? asString(payload.call_id) ?? String(payload.output_index ?? 0)
      const current = state.toolCalls.get(key) ?? { arguments: '', name: '' }
      const delta = asString(payload.delta)
      if (delta) current.arguments += delta
      if (asString(payload.call_id)) current.id = asString(payload.call_id)
      state.toolCalls.set(key, current)
    } else if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
      const item = asRecord(payload.item)
      if (item?.type === 'function_call') {
        const key = asString(item.id) ?? asString(item.call_id) ?? String(payload.output_index ?? state.toolCalls.size)
        const current = state.toolCalls.get(key) ?? { arguments: '', name: '' }
        current.id = asString(item.call_id) ?? asString(item.id) ?? current.id
        current.name = asString(item.name) ?? current.name
        const args = asString(item.arguments)
        if (args) current.arguments = args
        state.toolCalls.set(key, current)
      }
    } else if (eventType === 'response.completed') {
      const completed = asRecord(payload.response) ?? payload
      const status = asString(completed.status)
      state.doneReason = status === 'completed' ? 'stop' : status
      const usage = asRecord(completed.usage)
      if (usage) state.usage = rawChatUsage(usage)
      state.done = true
    } else if (eventType === 'response.incomplete') {
      const incomplete = asRecord(payload.response) ?? payload
      state.doneReason = asString(asRecord(incomplete.incomplete_details)?.reason) ?? 'length'
      state.done = true
    }
  })
  if (!state.done) throw new ModelStreamProtocolError('RawChat Codex 流式响应未收到结束帧')
  throwIfAssistantRunCancelled()
  return rawChatStreamResponse(state)
}

interface AnthropicStreamState {
  content: string
  toolCalls: Map<number, { id?: string; name: string; arguments: string }>
  done: boolean
  doneReason?: string
  usage?: ModelUsage
}

const anthropicStreamResponse = (state: AnthropicStreamState): ModelResponse => ({
  done_reason: state.doneReason,
  message: {
    role: 'assistant',
    content: state.content,
    ...(state.toolCalls.size
      ? {
          tool_calls: [...state.toolCalls.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, call]) => ({
              id: call.id,
              function: {
                name: call.name,
                arguments: parseToolArguments(call.arguments)
              }
            }))
        }
      : {})
  },
  ...(state.usage ? { usage: state.usage } : {})
})

const readAnthropicStream = async (
  response: Response,
  signal: AbortSignal,
  onTextDelta?: TextDeltaCallback
): Promise<ModelResponse> => {
  const state: AnthropicStreamState = { content: '', toolCalls: new Map(), done: false }
  await readSseStream(response, signal, (frame) => {
    if (signal.aborted) return
    const data = frame.data.trim()
    if (!data) return
    if (data === '[DONE]') {
      state.done = true
      return
    }
    const payload = parseStreamJson(data, 'Anthropic')
    const eventType = asString(frame.event) ?? asString(payload.type) ?? ''
    if (eventType === 'error') {
      const errorRecord = asRecord(payload.error)
      throw new ModelStreamProtocolError(
        `Anthropic 模型生成失败：${asString(errorRecord?.message) ?? '未知错误'}`
      )
    }
    if (eventType === 'message_start') {
      const message = asRecord(payload.message)
      const usage = asRecord(message?.usage)
      if (usage) {
        state.usage = {
          promptTokens: finiteNumber(usage.input_tokens),
          completionTokens: finiteNumber(usage.output_tokens)
        }
      }
    } else if (eventType === 'content_block_start') {
      const block = asRecord(payload.content_block)
      if (block?.type === 'tool_use') {
        const index = typeof payload.index === 'number' ? payload.index : state.toolCalls.size
        state.toolCalls.set(index, {
          id: asString(block.id),
          name: asString(block.name) ?? '',
          arguments: block.input ? JSON.stringify(block.input) : ''
        })
      }
    } else if (eventType === 'content_block_delta') {
      const delta = asRecord(payload.delta)
      if (delta?.type === 'text_delta') {
        const text = asString(delta.text)
        if (text) {
          state.content += text
          emitVisibleTextDelta(onTextDelta, signal, text)
        }
      } else if (delta?.type === 'input_json_delta') {
        const index = typeof payload.index === 'number' ? payload.index : 0
        const current = state.toolCalls.get(index) ?? { arguments: '', name: '' }
        const partial = asString(delta.partial_json)
        if (partial) current.arguments += partial
        state.toolCalls.set(index, current)
      }
      // thinking_delta, signature_delta and redacted thinking are ignored.
    } else if (eventType === 'message_delta') {
      const delta = asRecord(payload.delta)
      state.doneReason = asString(delta?.stop_reason) ?? state.doneReason
      const usage = asRecord(payload.usage)
      if (usage) {
        state.usage = {
          ...(state.usage ?? {}),
          completionTokens: finiteNumber(usage.output_tokens)
        }
      }
    } else if (eventType === 'message_stop') {
      state.done = true
    }
  })
  if (!state.done) throw new ModelStreamProtocolError('Anthropic 流式响应未收到 message_stop 结束帧')
  throwIfAssistantRunCancelled()
  return anthropicStreamResponse(state)
}

export class ModelClient {
  constructor(private readonly settings: ModelSettings) {}

  private usesRawChatResponses(): boolean {
    return this.settings.source === 'online' && (
      this.settings.provider === 'rawchat-codex' ||
      isRawChatResponsesBaseUrl(this.settings.baseUrl)
    )
  }

  async test(probeChat = false, probeCapabilities = false): Promise<ConnectionResult> {
    try {
      if (this.settings.source === 'local') {
        const connection = await this.testOllama()
        if (!connection.ok) {
          return probeCapabilities
            ? { ...connection, capabilityReport: this.capabilityReportForConnection(connection) }
            : connection
        }

        let report: ModelCapabilityReport | undefined
        if (probeCapabilities) {
          let metadata: OllamaShowMetadata | undefined
          let metadataError: string | undefined
          try {
            metadata = ollamaShowMetadata(await this.fetchOllamaShow())
          } catch (error) {
            if (isAssistantRunCancellation(error)) throw error
            metadataError = probeErrorSummary(error, this.settings.apiKey)
          }
          report = this.localCapabilityReport(connection, metadata, metadataError, probeChat)
        }

        const minimal = probeChat ? await this.probeMinimalChat() : undefined
        if (minimal && report) report.checks.minimalChat = minimal
        if (probeChat && probeCapabilities && report) {
          report.checks.structuredOutput = await this.probeStructuredOutput()
          report.checks.toolCalling = await this.probeToolCalling()
        }
        if (probeChat && !probeCapabilities && minimal?.status !== 'supported') {
          return {
            ...connection,
            ok: false,
            message: `${this.providerName()} 模型服务可访问，但最小问答测试失败：${minimal?.summary ?? '未知错误'}`
          }
        }
        return {
          ...connection,
          ...(report ? { capabilityReport: report } : {}),
          message: `${connection.message}${probeChat && minimal?.status === 'supported' ? '，最小问答测试通过' : ''}`
        }
      }

      if (!this.settings.apiKey) throw new Error('请输入 API Key')
      const request = requestSignal(15_000)
      let response: Response
      try {
        response = await fetch(
          this.usesRawChatResponses()
            ? rawChatModelsUrl(this.settings.baseUrl)
            : `${trimBaseUrl(this.settings.baseUrl)}/models`,
          {
            headers: this.onlineHeaders(),
            signal: request.signal
          }
        )
      } finally {
        request.cleanup()
      }
      if (!response.ok) throw await this.httpError(response)
      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>
        models?: Array<{ id?: string }>
      }
      const models = (payload.data ?? payload.models ?? []).map((item) => item.id).filter(Boolean)
      const connection: ConnectionResult = models.length && !models.includes(this.settings.model)
        ? {
            ok: false,
            message: `${this.providerName()} 已连接，但未找到模型 ${this.settings.model}`,
            details: { models }
          }
        : {
            ok: true,
            message: `${this.providerName()} 连接成功${models.includes(this.settings.model) ? `，模型 ${this.settings.model} 可用` : ''}`,
            details: { models }
          }
      if (!connection.ok) {
        return probeCapabilities
          ? { ...connection, capabilityReport: this.capabilityReportForConnection(connection) }
          : connection
      }

      let report = probeCapabilities ? this.onlineCapabilityReport(connection, probeChat) : undefined
      const minimal = probeChat ? await this.probeMinimalChat() : undefined
      if (minimal && report) report.checks.minimalChat = minimal
      if (probeChat && probeCapabilities && report) {
        report.checks.structuredOutput = await this.probeStructuredOutput()
        report.checks.toolCalling = await this.probeToolCalling()
      }
      if (probeChat && !probeCapabilities && minimal?.status !== 'supported') {
        return {
          ...connection,
          ok: false,
          message: `${this.providerName()} 模型列表可访问，但最小问答测试失败：${minimal?.summary ?? '未知错误'}`
        }
      }
      return {
        ...connection,
        ...(report ? { capabilityReport: report } : {}),
        message: `${connection.message}${probeChat && minimal?.status === 'supported' ? '，最小问答测试通过' : ''}`
      }
    } catch (error) {
      if (isAssistantRunCancellation(error)) throw error
      const message = probeErrorSummary(error, this.settings.apiKey)
      return {
        ok: false,
        message,
        ...(probeCapabilities ? { capabilityReport: this.capabilityReportForError(error) } : {})
      }
    }
  }

  async chat(input: ModelChatInput): Promise<ModelResponse> {
    const semaphore = modelRequestSemaphoreFor(this.settings)
    const signals = cancellationSignals(input.signal)
    const transportRetryLimit = Math.max(0, Math.min(
      modelTransportRetryLimit,
      Math.trunc(input.maxTransportRetries ?? 0)
    ))
    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        const release = await semaphore.acquire(signals)
        try {
          const response = await (this.settings.source === 'local'
            ? this.chatOllama(input)
            : this.usesRawChatResponses()
              ? this.chatRawChatResponses(input)
              : this.settings.provider === 'anthropic'
                ? this.chatAnthropic(input)
              : this.chatOpenAi(input))
          recordAssistantRunUsage(response.usage)
          return response
        } finally {
          release()
        }
      } catch (error) {
        if (isModelRequestCancelled(error, input)) {
          if (getAssistantRunContext()?.signal.aborted) throwIfRunWasCancelled(error)
          throw input.signal?.reason ?? error
        }
        const httpError = modelHttpErrorFrom(error)
        // An HTTP rejection happens before any streamed content is emitted and
        // is safe to retry. A transport failure during an active stream may
        // already have delivered visible deltas, so retrying it would duplicate
        // assistant output. Structured non-streaming callers keep the full
        // transient-network retry path.
        const retryable = httpError?.retryable ?? (!input.stream && isTransientModelNetworkError(error))
        if (!retryable || retryIndex >= transportRetryLimit) throw error
        const delayMs = modelRetryDelayMs(error, retryIndex)
        try {
          input.onRetry?.({
            attempt: retryIndex + 2,
            maxAttempts: transportRetryLimit + 1,
            delayMs,
            ...(httpError?.status !== undefined ? { status: httpError.status } : {}),
            ...(httpError?.requestId ? { requestId: httpError.requestId } : {})
          })
        } catch {
          // Retry telemetry must never turn a recoverable model response into
          // a failed chat request.
        }
        await waitForModelRetry(delayMs, signals)
      }
    }
  }

  private resolveThinking(input: ModelChatInput): boolean {
    if (input.reasoningEffort !== undefined) return input.reasoningEffort !== 'none'
    if (input.forceThinking !== undefined) return input.forceThinking
    // The online switch is a persisted model preference. Local Ollama keeps
    // the existing per-request override used by the agent's tool workflow.
    return this.settings.source === 'online'
      ? this.settings.thinking
      : input.think ?? this.settings.thinking
  }

  private async fetchOllamaShow(): Promise<Record<string, unknown>> {
    const request = requestSignal(10_000)
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.settings.model, verbose: false }),
        signal: request.signal
      })
    } catch (error) {
      try {
        throwIfRunWasCancelled(error)
      } finally {
        request.cleanup()
      }
      throw error
    }
    try {
      if (!response.ok) throw await this.httpError(response)
      const payload = asRecord(await response.json())
      if (!payload) throw new Error('Ollama /api/show 返回的元数据不是有效对象')
      return payload
    } catch (error) {
      throwIfRunWasCancelled(error)
      throw error
    } finally {
      request.cleanup()
    }
  }

  private async probeMinimalChat(): Promise<ModelCapabilityItem> {
    try {
      const response = await this.chat({
        messages: capabilityProbeMessages('请只回复 OK。'),
        forceThinking: false,
        think: false,
        temperature: 0,
        numPredict: 32,
        timeoutMs: this.usesRawChatResponses() ? defaultChatTimeoutMs : 15_000
      })
      const content = response.message?.content?.trim()
      return content
        ? capabilityItem('supported', '最小问答主动探测成功', 'active-probe', true)
        : capabilityItem('unsupported', '模型未返回可见文本', 'active-probe', false)
    } catch (error) {
      if (isAssistantRunCancellation(error)) throw error
      return capabilityItem('error', `最小问答主动探测失败：${probeErrorSummary(error, this.settings.apiKey)}`, 'active-probe', false)
    }
  }

  private async probeStructuredOutput(): Promise<ModelCapabilityItem> {
    try {
      const response = await this.chat({
        messages: capabilityProbeMessages('请返回 JSON 对象 {"ok":true}，只允许这一对象。'),
        forceThinking: false,
        think: false,
        temperature: 0,
        numPredict: 64,
        timeoutMs: this.usesRawChatResponses() ? defaultChatTimeoutMs : 15_000,
        format: structuredProbeFormat
      })
      const parsed = parseProbeObject(response.message?.content)
      if (parsed?.ok === true) {
        return capabilityItem('supported', 'JSON Schema 主动探测成功', 'active-probe', true)
      }
      return capabilityItem('unsupported', '模型未返回符合要求的 JSON Schema 对象', 'active-probe', false)
    } catch (error) {
      if (isAssistantRunCancellation(error)) throw error
      return capabilityItem('error', `JSON Schema 主动探测失败：${probeErrorSummary(error, this.settings.apiKey)}`, 'active-probe', false)
    }
  }

  private async probeToolCalling(): Promise<ModelCapabilityItem> {
    try {
      const response = await this.chat({
        messages: capabilityProbeMessages('请调用唯一可用的 capability_probe 工具，并传入 {"ok":true}。不要输出普通文本。'),
        tools: [toolProbe],
        forceThinking: false,
        think: false,
        temperature: 0,
        numPredict: 96,
        // RawChat Codex reasoning models can take tens of seconds even for
        // this tiny tool probe. Keep the short guard for other providers,
        // while matching the normal chat ceiling for this endpoint only.
        timeoutMs: this.usesRawChatResponses() ? defaultChatTimeoutMs : 15_000
      })
      const call = response.message?.tool_calls?.find((item) => item.function.name === 'capability_probe')
      if (call?.function.arguments.ok === true) {
        return capabilityItem('supported', '工具调用主动探测成功', 'active-probe', true)
      }
      return capabilityItem('unsupported', '模型未返回指定工具调用及有效参数', 'active-probe', false)
    } catch (error) {
      if (isAssistantRunCancellation(error)) throw error
      return capabilityItem('error', `工具调用主动探测失败：${probeErrorSummary(error, this.settings.apiKey)}`, 'active-probe', false)
    }
  }

  private capabilityReportForConnection(connection: ConnectionResult): ModelCapabilityReport {
    const evidence: ModelCapabilityEvidence = this.settings.source === 'local'
      ? 'metadata'
      : 'provider-contract'
    const connectionStatus: ModelCapabilityStatus = connection.ok
      ? 'supported'
      : /未找到模型/u.test(connection.message)
        ? 'unsupported'
        : 'error'
    return this.createCapabilityReport(
      capabilityItem(connectionStatus, connection.message, evidence, connection.ok),
      evidence,
      'metadata'
    )
  }

  private capabilityReportForError(error: unknown): ModelCapabilityReport {
    const evidence: ModelCapabilityEvidence = this.settings.source === 'local'
      ? 'metadata'
      : 'provider-contract'
    return this.createCapabilityReport(
      capabilityItem('error', probeErrorSummary(error, this.settings.apiKey), evidence, false),
      evidence,
      'metadata'
    )
  }

  private createCapabilityReport(
    connection: ModelCapabilityItem,
    unknownEvidence: ModelCapabilityEvidence,
    probeMode: 'metadata' | 'active'
  ): ModelCapabilityReport {
    return {
      checkedAt: new Date().toISOString(),
      probeMode,
      source: this.settings.source,
      provider: this.settings.provider,
      model: this.settings.model,
      checks: {
        connection,
        minimalChat: unknownCapability(unknownEvidence),
        structuredOutput: unknownCapability(unknownEvidence),
        toolCalling: unknownCapability(unknownEvidence),
        contextWindow: unknownCapability(unknownEvidence),
        thinking: unknownCapability(unknownEvidence)
      }
    }
  }

  private localCapabilityReport(
    connection: ConnectionResult,
    metadata: OllamaShowMetadata | undefined,
    metadataError: string | undefined,
    probeChat: boolean
  ): ModelCapabilityReport {
    const report = this.createCapabilityReport(
      capabilityItem('supported', connection.message, 'metadata', true),
      'metadata',
      probeChat ? 'active' : 'metadata'
    )
    if (metadataError) {
      const error = capabilityItem('error', `Ollama 模型元数据探测失败：${metadataError}`, 'metadata', false)
      report.checks.toolCalling = error
      report.checks.contextWindow = error
      report.checks.thinking = error
      return report
    }
    if (!metadata) return report
    if (metadata.contextLength !== undefined) {
      report.checks.contextWindow = capabilityItem(
        metadata.contextLength < 32_768 ? 'limited' : 'supported',
        `上下文窗口约 ${metadata.contextLength.toLocaleString()} tokens`,
        'metadata',
        metadata.contextLength
      )
    }
    if (metadata.toolCalling !== undefined) {
      report.checks.toolCalling = capabilityItem(
        metadata.toolCalling ? 'supported' : 'unsupported',
        metadata.toolCalling ? '模型元数据声明支持工具调用' : '模型元数据未声明工具调用能力',
        'metadata',
        metadata.toolCalling
      )
    }
    if (metadata.thinking !== undefined) {
      report.checks.thinking = capabilityItem(
        metadata.thinking ? 'supported' : 'unsupported',
        metadata.thinking ? '模型元数据声明支持 thinking' : '模型元数据未声明 thinking 能力',
        'metadata',
        metadata.thinking
      )
    }
    return report
  }

  private onlineCapabilityReport(connection: ConnectionResult, probeChat: boolean): ModelCapabilityReport {
    return this.createCapabilityReport(
      capabilityItem('supported', connection.message, 'provider-contract', true),
      'provider-contract',
      probeChat ? 'active' : 'metadata'
    )
  }

  private async testOllama(): Promise<ConnectionResult> {
    const request = requestSignal(10_000)
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/api/tags`, {
        signal: request.signal
      })
    } finally {
      request.cleanup()
    }
    if (!response.ok) throw await this.httpError(response)
    const payload = (await response.json()) as { models?: Array<{ name?: string }> }
    const models = (payload.models ?? []).map((item) => item.name).filter(Boolean)
    if (!models.includes(this.settings.model)) {
      return {
        ok: false,
        message: `Ollama 已连接，但未找到模型 ${this.settings.model}`,
        details: { models }
      }
    }
    return { ok: true, message: `Ollama 连接成功，模型 ${this.settings.model} 可用` }
  }

  private async chatOllama(input: ModelChatInput): Promise<ModelResponse> {
    const request = requestSignal(input.timeoutMs ?? defaultChatTimeoutMs, input.signal)
    let response: Response
    try {
      response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.settings.model,
          messages: input.messages,
          tools: input.tools,
          think: this.resolveThinking(input),
          stream: input.stream === true,
          ...(input.format ? { format: input.format } : {}),
          options: {
            temperature: input.temperature ?? 0.1,
            num_ctx: Math.max(1_024, Math.round(input.numCtx ?? 32768)),
            num_predict: input.numPredict ?? 2048
          }
        }),
        signal: request.signal
      })
    } catch (error) {
      try {
        throwIfRunWasCancelled(error)
      } finally {
        request.cleanup()
      }
      throw ollamaConnectionError(error)
    }
    try {
      if (!response.ok) throw await this.httpError(response)
      if (!input.stream) {
        const payload = (await response.json()) as ModelResponse & Record<string, unknown>
        const usage = ollamaUsage(payload)
        throwIfAssistantRunCancelled()
        return usage ? { ...payload, usage } : payload
      }
      return await this.readOllamaStream(response, request.signal, input.onTextDelta)
    } catch (error) {
      throwIfRunWasCancelled(error)
      if (error instanceof OllamaProtocolError || error instanceof ModelHttpError) throw error
      throw ollamaConnectionError(error)
    } finally {
      request.cleanup()
    }
  }

  private async readOllamaStream(
    response: Response,
    signal: AbortSignal,
    onTextDelta?: TextDeltaCallback
  ): Promise<ModelResponse> {
    if (!response.body) throw new OllamaProtocolError('Ollama 流式响应缺少响应体')

    const reader = response.body.getReader()
    const cancelReader = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined)
    }
    if (signal.aborted) {
      cancelReader()
      throwIfAssistantRunCancelled()
      throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    }
    signal.addEventListener('abort', cancelReader, { once: true })
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let done = false
    let doneReason: string | undefined
    let usage: ModelUsage | undefined
    let lineNumber = 0
    const toolCalls: NonNullable<ModelMessage['tool_calls']> = []

    const consumeLine = (rawLine: string): void => {
      const line = rawLine.trim()
      if (!line) return
      lineNumber += 1
      let chunk: {
        error?: string
        done?: boolean
        done_reason?: string
        message?: {
          content?: string
          tool_calls?: ModelMessage['tool_calls']
        }
      }
      try {
        chunk = JSON.parse(line) as typeof chunk
      } catch {
        throw new OllamaProtocolError(`Ollama 流式响应第 ${lineNumber} 个分片不是有效 JSON`)
      }
      if (chunk.error) throw new OllamaProtocolError(`Ollama 模型生成失败：${chunk.error}`)
      if (typeof chunk.message?.content === 'string') {
        content += chunk.message.content
        emitVisibleTextDelta(onTextDelta, signal, chunk.message.content)
      }
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls)
      usage = ollamaUsage(chunk as unknown as Record<string, unknown>) ?? usage
      if (chunk.done === true) {
        done = true
        doneReason = chunk.done_reason
      }
    }

    try {
      while (true) {
        throwIfAssistantRunCancelled()
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach(consumeLine)
      }
      buffer += decoder.decode()
      if (buffer.trim()) consumeLine(buffer)

      if (!done) {
        throw new OllamaProtocolError('Ollama 流式响应意外中断：未收到完成标记')
      }
      throwIfAssistantRunCancelled()
      return {
        done_reason: doneReason,
        message: {
          role: 'assistant',
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        ...(usage ? { usage } : {})
      }
    } catch (error) {
      throwIfRunWasCancelled(error)
      throw error
    } finally {
      signal.removeEventListener('abort', cancelReader)
      reader.releaseLock()
    }
  }

  private async chatOpenAi(input: ModelChatInput): Promise<ModelResponse> {
    if (!this.settings.apiKey) throw new Error('未配置 API Key')
    const thinking = this.resolveThinking(input)
    const reasoningEffort = input.reasoningEffort
    const reasoningModel = this.settings.provider === 'openai' && this.isOpenAiReasoningModel()
    const messages = input.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls?.length
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: {
                name: call.function.name,
                arguments: JSON.stringify(call.function.arguments)
              }
            }))
          }
        : {})
    }))
    const body: Record<string, unknown> = {
      model: this.settings.model,
      messages,
      tools: input.tools,
      ...(input.stream ? { stream: true } : {}),
      ...(reasoningModel
        ? { max_completion_tokens: input.numPredict ?? 2048 }
        : {
            ...(this.settings.provider === 'deepseek' && thinking
              ? {}
              : { temperature: input.temperature ?? 0.1 }),
            max_tokens: input.numPredict ?? 2048
          }),
      ...this.openAiThinkingParams(thinking, reasoningEffort),
      ...(input.format
        ? {
            response_format:
              input.format === 'json'
                ? { type: 'json_object' }
                : this.settings.provider === 'openai'
                  ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: input.format } }
                  : { type: 'json_object' }
          }
        : {})
    }
    const request = requestSignal(input.timeoutMs ?? defaultChatTimeoutMs, input.signal)
    try {
      const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: this.onlineHeaders(),
        body: JSON.stringify(body),
        signal: request.signal
      })
      if (!response.ok) throw await this.httpError(response)
      if (input.stream && isEventStreamResponse(response)) {
        return await readOpenAiStream(response, request.signal, input.onTextDelta)
      }
      const payload = (await response.json()) as {
      usage?: Record<string, unknown>
      choices?: Array<{
        finish_reason?: string
        message?: {
          content?: string | null
          reasoning_content?: string | null
          tool_calls?: Array<{
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
      }>
      }
      const choice = payload.choices?.[0]
      const reasoningContent = choice?.message?.reasoning_content
      const usage = rawChatUsage(payload.usage)
      throwIfAssistantRunCancelled()
      const result: ModelResponse = {
      done_reason: choice?.finish_reason,
      message: choice?.message
          ? {
            role: 'assistant',
            content: choice.message.content ?? '',
            ...(reasoningContent !== undefined && reasoningContent !== null
              ? { reasoningContent }
              : {}),
            tool_calls: choice.message.tool_calls?.flatMap((call) => {
              if (!call.function?.name) return []
              let args: Record<string, unknown> = {}
              try {
                args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
              } catch {
                args = {}
              }
              return [{ id: call.id, function: { name: call.function.name, arguments: args } }]
            })
          }
        : undefined,
      ...(usage ? { usage } : {})
      }
      if (input.stream) {
        emitVisibleTextDelta(input.onTextDelta, request.signal, result.message?.content)
      }
      return result
    } catch (error) {
      throwIfRunWasCancelled(error)
      throw error
    } finally {
      request.cleanup()
    }
  }

  private async chatRawChatResponses(input: ModelChatInput): Promise<ModelResponse> {
    if (!this.settings.apiKey) throw new Error('未配置 API Key')
    const thinking = this.resolveThinking(input)
    const reasoningEffort = input.reasoningEffort
    const format = rawChatTextFormat(input.format)
    const tools = rawChatTools(input.tools)
    const body: Record<string, unknown> = {
      model: this.settings.model,
      input: rawChatInput(input.messages),
      ...(tools ? { tools } : {}),
      ...(input.stream ? { stream: true } : {}),
      ...(format ? { text: { format } } : {}),
      // RawChat's Codex channel is backed by reasoning models.  Temperature
      // and Chat Completions-only token fields are intentionally omitted.
      reasoning: { effort: reasoningEffort ? providerReasoningEffort(reasoningEffort) : (thinking ? 'high' : 'none') },
      // Responses API requires at least 16 output tokens (including any
      // reasoning tokens counted against the budget).
      max_output_tokens: Math.max(16, Math.round(input.numPredict ?? 2048))
    }
    const request = requestSignal(input.timeoutMs ?? defaultChatTimeoutMs, input.signal)
    let response: Response
    try {
      response = await fetch(rawChatResponsesUrl(this.settings.baseUrl), {
        method: 'POST',
        headers: this.onlineHeaders(),
        body: JSON.stringify(body),
        signal: request.signal
      })
    } catch (error) {
      try {
        throwIfRunWasCancelled(error)
      } finally {
        request.cleanup()
      }
      throw new Error(`RawChat Codex 连接失败：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    try {
      if (!response.ok) throw await this.httpError(response)
      if (input.stream && isEventStreamResponse(response)) {
        return await readRawChatStream(response, request.signal, input.onTextDelta)
      }

    const payload = asRecord(await response.json())
    if (!payload) throw new Error('RawChat Codex 返回的响应不是有效对象')
    const output = Array.isArray(payload.output) ? payload.output.flatMap((item) => {
      const record = asRecord(item)
      return record ? [record] : []
    }) : []
    const textParts: string[] = []
    const toolCalls: NonNullable<ModelMessage['tool_calls']> = []
    for (const item of output) {
      if (item.type === 'output_text' && typeof item.text === 'string') {
        textParts.push(item.text)
      }
      if (item.type === 'message') {
        const content = Array.isArray(item.content) ? item.content : []
        for (const part of content) {
          const block = asRecord(part)
          if (!block) continue
          if ((block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
            textParts.push(block.text)
          }
        }
        if (typeof item.content === 'string') textParts.push(item.content)
      }
      if (item.type === 'function_call') {
        const name = asString(item.name)?.trim()
        if (!name) continue
        const id = asString(item.call_id) ?? asString(item.id)
        toolCalls.push({
          id,
          function: {
            name,
            arguments: parseToolArguments(item.arguments)
          }
        })
      }
    }
    if (!textParts.length && typeof payload.output_text === 'string') {
      textParts.push(payload.output_text)
    }
    if (!textParts.length && !toolCalls.length) {
      throw new Error('RawChat Codex 响应中没有可用的文本或工具调用')
    }
    const incompleteReason = asString(asRecord(payload.incomplete_details)?.reason)
    const status = asString(payload.status)
    const doneReason = status === 'incomplete' && incompleteReason === 'max_output_tokens'
      ? 'length'
      : incompleteReason ?? (status === 'completed' ? 'stop' : status)
    const usage = rawChatUsage(payload.usage)
    throwIfAssistantRunCancelled()
    const result: ModelResponse = {
      done_reason: doneReason,
      message: {
        role: 'assistant',
        content: textParts.join('\n'),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      ...(usage ? { usage } : {})
    }
    if (input.stream) {
      emitVisibleTextDelta(input.onTextDelta, request.signal, result.message?.content)
    }
    return result
    } catch (error) {
      throwIfRunWasCancelled(error)
      throw error
    } finally {
      request.cleanup()
    }
  }

  private async chatAnthropic(input: ModelChatInput): Promise<ModelResponse> {
    if (!this.settings.apiKey) throw new Error('未配置 API Key')
    const thinking = this.resolveThinking(input)
    const system = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n')
    const messages = input.messages
      .filter((message) => message.role !== 'system')
      .map((message) => {
        if (message.role === 'tool') {
          return {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }]
          }
        }
        if (message.role === 'assistant' && message.providerContent?.length) {
          return {
            role: 'assistant',
            content: thinking
              ? message.providerContent
              : message.providerContent.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking')
          }
        }
        if (message.role === 'assistant' && message.tool_calls?.length) {
          return {
            role: 'assistant',
            content: [
              ...(message.content ? [{ type: 'text', text: message.content }] : []),
              ...message.tool_calls.map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: call.function.arguments
              }))
            ]
          }
        }
        return { role: message.role, content: message.content }
      })
    const anthropicTools = (input.tools as Array<{ function?: Record<string, unknown> }> | undefined)
      ?.flatMap((tool) => tool.function
        ? [{
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters
          }]
        : [])
    const anthropicThinking = thinking ? this.anthropicThinkingParams(input.reasoningEffort) : {}
    const anthropicOutputConfig = input.format && input.format !== 'json'
      ? {
          ...(asRecord(anthropicThinking.output_config) ?? {}),
          format: { type: 'json_schema', schema: input.format }
        }
      : asRecord(anthropicThinking.output_config)
    const request = requestSignal(input.timeoutMs ?? defaultChatTimeoutMs, input.signal)
    try {
    const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/messages`, {
      method: 'POST',
      headers: this.onlineHeaders(),
      body: JSON.stringify({
        model: this.settings.model,
        system: [system, input.format ? '只输出符合要求的 JSON 对象，不要输出 Markdown。' : ''].filter(Boolean).join('\n'),
        messages,
        tools: anthropicTools,
        ...(input.stream ? { stream: true } : {}),
        ...(thinking
          ? {
              max_tokens: Math.max(input.numPredict ?? 2048, 2048),
              ...anthropicThinking,
              ...(anthropicOutputConfig ? { output_config: anthropicOutputConfig } : {})
            }
          : {
              temperature: input.temperature ?? 0.1,
              max_tokens: input.numPredict ?? 2048,
              ...(anthropicOutputConfig ? { output_config: anthropicOutputConfig } : {})
            })
      }),
      signal: request.signal
    })
    if (!response.ok) throw await this.httpError(response)
    if (input.stream && isEventStreamResponse(response)) {
      return await readAnthropicStream(response, request.signal, input.onTextDelta)
    }
    const payload = (await response.json()) as {
      stop_reason?: string
      usage?: Record<string, unknown>
      content?: Array<{
        [key: string]: unknown
        type?: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
    }
    throwIfAssistantRunCancelled()
    const usage = rawChatUsage(payload.usage)
    const result: ModelResponse = {
      done_reason: payload.stop_reason,
      message: {
        role: 'assistant',
        content: (payload.content ?? []).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n'),
        ...(payload.content?.length ? { providerContent: payload.content } : {}),
        tool_calls: (payload.content ?? []).flatMap((item) =>
          item.type === 'tool_use' && item.name
            ? [{ id: item.id, function: { name: item.name, arguments: item.input ?? {} } }]
            : []
        )
      },
      ...(usage ? { usage } : {})
    }
    if (input.stream) {
      emitVisibleTextDelta(input.onTextDelta, request.signal, result.message?.content)
    }
    return result
    } catch (error) {
      throwIfRunWasCancelled(error)
      throw error
    } finally {
      request.cleanup()
    }
  }

  private openAiThinkingParams(
    thinking: boolean,
    reasoningEffort?: ModelReasoningEffort
  ): Record<string, unknown> {
    if (this.settings.provider === 'deepseek' || this.settings.provider === 'zhipu') {
      return { thinking: { type: thinking ? 'enabled' : 'disabled' } }
    }
    if (this.settings.provider === 'qwen') {
      return { enable_thinking: thinking }
    }
    if (this.settings.provider === 'openai' && this.isOpenAiReasoningModel()) {
      if (reasoningEffort !== undefined) {
        return { reasoning_effort: providerReasoningEffort(reasoningEffort) }
      }
      if (!thinking && !this.supportsOpenAiNoReasoning()) return {}
      return { reasoning_effort: thinking ? 'medium' : 'none' }
    }
    return {}
  }

  private isOpenAiReasoningModel(): boolean {
    return /^(?:o\d|gpt-5(?:[.-]|$))/i.test(this.settings.model.trim())
  }

  private supportsOpenAiNoReasoning(): boolean {
    return /^gpt-5\.(?:1|2)(?:[.-]|$)/i.test(this.settings.model.trim())
  }

  private anthropicThinkingParams(reasoningEffort?: ModelReasoningEffort): Record<string, unknown> {
    if (this.supportsAnthropicAdaptiveThinking()) {
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort: reasoningEffort ? providerReasoningEffort(reasoningEffort) : 'high' }
      }
    }
    return {
      thinking: { type: 'enabled', budget_tokens: 1024 }
    }
  }

  private supportsAnthropicAdaptiveThinking(): boolean {
    const match = this.settings.model.trim().toLowerCase().match(
      /^claude-(?:opus|sonnet|haiku)-(\d+)[.-](\d+)/
    )
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2])
    return major > 4 || (major === 4 && minor >= 6)
  }

  private onlineHeaders(): Record<string, string> {
    if (this.settings.provider === 'anthropic') {
      return {
        'Content-Type': 'application/json',
        'x-api-key': this.settings.apiKey ?? '',
        'anthropic-version': '2023-06-01'
      }
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.settings.apiKey ?? ''}`
    }
  }

  private providerName(): string {
    const names: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      deepseek: 'DeepSeek',
      qwen: '通义千问',
      zhipu: '智谱 AI',
      moonshot: 'Moonshot',
      minimax: 'MiniMax',
      'rawchat-codex': 'RawChat Codex',
      'openai-compatible': 'OpenAI 兼容服务'
    }
    return this.usesRawChatResponses() ? 'RawChat Codex' : (names[this.settings.provider] ?? this.settings.provider)
  }

  private async httpError(response: Response): Promise<ModelHttpError> {
    let rawBody = ''
    try {
      rawBody = await response.text()
    } catch {
      // Keep the structured status/headers even when an upstream closes the
      // body before it can be read.
    }
    const body = safeModelErrorBody(rawBody, this.settings.apiKey)
    const requestId = response.headers.get('x-request-id')?.trim() || response.headers.get('request-id')?.trim() || undefined
    const retryAfterMs = retryAfterMsFromHeader(response.headers.get('retry-after'))
    const details = { status: response.status, retryAfterMs, requestId, body }
    if (this.usesRawChatResponses() && /Codex is not enabled/i.test(rawBody)) {
      return new ModelHttpError(
        `${this.providerName()} HTTP ${response.status}：当前 API Key 未开通 RawChat Codex 服务，请在 RawChat 控制台启用 Codex 权限或更换 Key。`,
        details
      )
    }
    if (this.usesRawChatResponses() && /invalid api key|incorrect api key|unauthorized/i.test(rawBody)) {
      return new ModelHttpError(
        `${this.providerName()} HTTP ${response.status}：API Key 无效、已撤销或未正确填写，请重新生成并保存新的 Key。`,
        details
      )
    }
    if (this.settings.provider === 'openai-compatible' && /Codex is not enabled/i.test(rawBody)) {
      return new ModelHttpError(
        `${this.providerName()} HTTP ${response.status}：当前 API Key 未开通该地址对应的 Codex 聊天服务。请在服务商控制台启用相应权限，或改用已开通 Chat Completions 的 API 地址和模型。`,
        details
      )
    }
    return new ModelHttpError(`${this.providerName()} HTTP ${response.status}${body ? `: ${body}` : ''}`, details)
  }
}
