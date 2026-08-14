import type {
  ConnectionResult,
  ModelSettings,
  RequirementSemanticizationModelUsage
} from '../shared/types'

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
  usage?: RequirementSemanticizationModelUsage
}

export interface ModelChatInput {
  messages: ModelMessage[]
  tools?: unknown[]
  think?: boolean
  forceThinking?: boolean
  stream?: boolean
  numCtx?: number
  format?: 'json' | Record<string, unknown>
  temperature?: number
  numPredict?: number
  timeoutMs?: number
}

const trimBaseUrl = (value: string): string => value.replace(/\/+$/, '')
const defaultChatTimeoutMs = 180_000

const chatTimeoutSignal = (input: ModelChatInput): AbortSignal => AbortSignal.timeout(
  Math.max(1_000, Math.round(input.timeoutMs ?? defaultChatTimeoutMs))
)

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

const ollamaUsage = (chunk: Record<string, unknown>): RequirementSemanticizationModelUsage | undefined => {
  const usage: RequirementSemanticizationModelUsage = {
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

export class ModelClient {
  constructor(private readonly settings: ModelSettings) {}

  async test(probeChat = false): Promise<ConnectionResult> {
    try {
      if (this.settings.source === 'local') {
        const connection = await this.testOllama()
        if (!connection.ok || !probeChat) return connection
        await this.chatOllama({
          messages: [
            { role: 'system', content: '这是模型连通性测试。请只返回 OK。' },
            { role: 'user', content: 'OK' }
          ],
          forceThinking: false,
          temperature: 0,
          numPredict: 32
        })
        return { ...connection, message: `${connection.message}，最小问答测试通过` }
      }
      if (!this.settings.apiKey) throw new Error('请输入 API Key')
      const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/models`, {
        headers: this.onlineHeaders(),
        signal: AbortSignal.timeout(15_000)
      })
      if (!response.ok) throw await this.httpError(response)
      const payload = (await response.json()) as {
        data?: Array<{ id?: string }>
        models?: Array<{ id?: string }>
      }
      const models = (payload.data ?? payload.models ?? []).map((item) => item.id).filter(Boolean)
      if (models.length && !models.includes(this.settings.model)) {
        return {
          ok: false,
          message: `${this.providerName()} 已连接，但未找到模型 ${this.settings.model}`,
          details: { models }
        }
      }
      if (probeChat) {
        try {
          await this.chat({
            messages: [
              { role: 'system', content: '这是模型连通性测试。请只返回 OK。' },
              { role: 'user', content: 'OK' }
            ],
            forceThinking: false,
            temperature: 0,
            numPredict: 32
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {
            ok: false,
            message: `${this.providerName()} 模型列表可访问，但最小问答测试失败：${message}`,
            details: { models }
          }
        }
      }
      return {
        ok: true,
        message: `${this.providerName()} 连接成功${models.includes(this.settings.model) ? `，模型 ${this.settings.model} 可用` : ''}${probeChat ? '，最小问答测试通过' : ''}`,
        details: { models }
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async chat(input: ModelChatInput): Promise<ModelResponse> {
    return this.settings.source === 'local'
      ? this.chatOllama(input)
      : this.settings.provider === 'anthropic'
        ? this.chatAnthropic(input)
        : this.chatOpenAi(input)
  }

  private resolveThinking(input: ModelChatInput): boolean {
    if (input.forceThinking !== undefined) return input.forceThinking
    // The online switch is a persisted model preference. Local Ollama keeps
    // the existing per-request override used by the agent's tool workflow.
    return this.settings.source === 'online'
      ? this.settings.thinking
      : input.think ?? this.settings.thinking
  }

  private async testOllama(): Promise<ConnectionResult> {
    const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/api/tags`, {
      signal: AbortSignal.timeout(10_000)
    })
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
        signal: chatTimeoutSignal(input)
      })
    } catch (error) {
      throw ollamaConnectionError(error)
    }
    if (!response.ok) throw await this.httpError(response)
    if (!input.stream) {
      const payload = (await response.json()) as ModelResponse & Record<string, unknown>
      const usage = ollamaUsage(payload)
      return usage ? { ...payload, usage } : payload
    }

    try {
      return await this.readOllamaStream(response)
    } catch (error) {
      if (error instanceof OllamaProtocolError) throw error
      throw ollamaConnectionError(error)
    }
  }

  private async readOllamaStream(response: Response): Promise<ModelResponse> {
    if (!response.body) throw new OllamaProtocolError('Ollama 流式响应缺少响应体')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let done = false
    let doneReason: string | undefined
    let usage: RequirementSemanticizationModelUsage | undefined
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
      if (typeof chunk.message?.content === 'string') content += chunk.message.content
      if (chunk.message?.tool_calls?.length) toolCalls.push(...chunk.message.tool_calls)
      usage = ollamaUsage(chunk as unknown as Record<string, unknown>) ?? usage
      if (chunk.done === true) {
        done = true
        doneReason = chunk.done_reason
      }
    }

    while (true) {
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
    return {
      done_reason: doneReason,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      },
      ...(usage ? { usage } : {})
    }
  }

  private async chatOpenAi(input: ModelChatInput): Promise<ModelResponse> {
    if (!this.settings.apiKey) throw new Error('未配置 API Key')
    const thinking = this.resolveThinking(input)
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
      ...(reasoningModel
        ? { max_completion_tokens: input.numPredict ?? 2048 }
        : {
            ...(this.settings.provider === 'deepseek' && thinking
              ? {}
              : { temperature: input.temperature ?? 0.1 }),
            max_tokens: input.numPredict ?? 2048
          }),
      ...this.openAiThinkingParams(thinking),
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
    const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: this.onlineHeaders(),
      body: JSON.stringify(body),
      signal: chatTimeoutSignal(input)
    })
    if (!response.ok) throw await this.httpError(response)
    const payload = (await response.json()) as {
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
    return {
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
        : undefined
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
    const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/messages`, {
      method: 'POST',
      headers: this.onlineHeaders(),
      body: JSON.stringify({
        model: this.settings.model,
        system: [system, input.format ? '只输出符合要求的 JSON 对象，不要输出 Markdown。' : ''].filter(Boolean).join('\n'),
        messages,
        tools: anthropicTools,
        ...(thinking
          ? {
              max_tokens: Math.max(input.numPredict ?? 2048, 2048),
              ...this.anthropicThinkingParams()
            }
          : {
              temperature: input.temperature ?? 0.1,
              max_tokens: input.numPredict ?? 2048
            })
      }),
      signal: chatTimeoutSignal(input)
    })
    if (!response.ok) throw await this.httpError(response)
    const payload = (await response.json()) as {
      stop_reason?: string
      content?: Array<{
        [key: string]: unknown
        type?: string
        text?: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }>
    }
    return {
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
      }
    }
  }

  private openAiThinkingParams(thinking: boolean): Record<string, unknown> {
    if (this.settings.provider === 'deepseek' || this.settings.provider === 'zhipu') {
      return { thinking: { type: thinking ? 'enabled' : 'disabled' } }
    }
    if (this.settings.provider === 'qwen') {
      return { enable_thinking: thinking }
    }
    if (this.settings.provider === 'openai' && this.isOpenAiReasoningModel()) {
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

  private anthropicThinkingParams(): Record<string, unknown> {
    if (this.supportsAnthropicAdaptiveThinking()) {
      return {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' }
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
      'openai-compatible': 'OpenAI 兼容服务'
    }
    return names[this.settings.provider] ?? this.settings.provider
  }

  private async httpError(response: Response): Promise<Error> {
    const body = (await response.text()).slice(0, 500)
    if (this.settings.provider === 'openai-compatible' && /Codex is not enabled/i.test(body)) {
      return new Error(
        `${this.providerName()} HTTP ${response.status}：当前 API Key 未开通该地址对应的 Codex 聊天服务。请在服务商控制台启用相应权限，或改用已开通 Chat Completions 的 API 地址和模型。`
      )
    }
    return new Error(`${this.providerName()} HTTP ${response.status}${body ? `: ${body}` : ''}`)
  }
}
