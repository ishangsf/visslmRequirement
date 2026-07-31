import type { ConnectionResult, ModelSettings } from '../shared/types'

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
}

export interface ModelChatInput {
  messages: ModelMessage[]
  tools?: unknown[]
  think?: boolean
  format?: 'json' | Record<string, unknown>
  temperature?: number
  numPredict?: number
}

const trimBaseUrl = (value: string): string => value.replace(/\/+$/, '')

export class ModelClient {
  constructor(private readonly settings: ModelSettings) {}

  async test(): Promise<ConnectionResult> {
    try {
      if (this.settings.source === 'local') return await this.testOllama()
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
      return {
        ok: true,
        message: `${this.providerName()} 连接成功${models.includes(this.settings.model) ? `，模型 ${this.settings.model} 可用` : ''}`,
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
    const response = await fetch(`${trimBaseUrl(this.settings.baseUrl)}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model,
        messages: input.messages,
        tools: input.tools,
        think: this.resolveThinking(input),
        stream: false,
        ...(input.format ? { format: input.format } : {}),
        options: {
          temperature: input.temperature ?? 0.1,
          num_ctx: 32768,
          num_predict: input.numPredict ?? 2048
        }
      }),
      signal: AbortSignal.timeout(180_000)
    })
    if (!response.ok) throw await this.httpError(response)
    return (await response.json()) as ModelResponse
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
      signal: AbortSignal.timeout(180_000)
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
      signal: AbortSignal.timeout(180_000)
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
    if (this.settings.provider === 'openai-compatible' && thinking) {
      return { reasoning_effort: 'medium' }
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
    return new Error(`${this.providerName()} HTTP ${response.status}${body ? `: ${body}` : ''}`)
  }
}
