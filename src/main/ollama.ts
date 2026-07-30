import type {
  ChatRequest,
  ChatResponse,
  ChatSource,
  ConnectionResult,
  ModelSettings
} from '../shared/types'
import { AppDatabase } from './database'

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> }
  }>
}

interface OllamaResponse {
  message?: OllamaMessage
  done_reason?: string
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'search_records',
      description: '按关键词查询本地采集的 VISSLM 数据，返回匹配记录和来源 UID',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或短语' },
          project_id: { type: 'string', description: '可选的项目 UID' },
          limit: { type: 'integer', minimum: 1, maximum: 20 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_record_detail',
      description: '按 UID 获取一条 VISSLM 记录的完整字段',
      parameters: {
        type: 'object',
        properties: { uid: { type: 'string' } },
        required: ['uid']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'aggregate_records',
      description: '统计记录总数、图片数、按类型数量或按项目数量',
      parameters: {
        type: 'object',
        properties: {
          metric: {
            type: 'string',
            enum: ['record_count', 'image_count', 'count_by_type', 'count_by_project']
          },
          project_id: { type: 'string', description: '可选的项目 UID' }
        },
        required: ['metric']
      }
    }
  }
]

export class OllamaAgent {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: ModelSettings
  ) {}

  async test(): Promise<ConnectionResult> {
    try {
      const response = await fetch(`${this.settings.baseUrl.replace(/\/+$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(10_000)
      })
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
      const payload = (await response.json()) as { models?: Array<{ name?: string }> }
      const names = (payload.models ?? []).map((model) => model.name)
      if (!names.includes(this.settings.model)) {
        return {
          ok: false,
          message: `Ollama 已连接，但未找到模型 ${this.settings.model}`,
          details: { models: names }
        }
      }
      return {
        ok: true,
        message: `Ollama 连接成功，模型 ${this.settings.model} 可用`
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    const sources = new Map<string, ChatSource>()
    const system: OllamaMessage = {
      role: 'system',
      content: [
        '你是 VISSLM 项目数据助手，只能依据工具返回的本地采集数据回答。',
        '涉及数量时必须调用 aggregate_records，不得自行估算。',
        '涉及具体记录时必须调用 search_records 或 get_record_detail。',
        '找不到证据时明确说明未检索到，不要编造。',
        '回答使用中文，简洁清楚。引用记录时写成 [UID:实际UID]。'
      ].join('\n')
    }
    const messages: OllamaMessage[] = [
      system,
      ...(request.history ?? []).slice(-8).map(
        (message): OllamaMessage => ({
          role: message.role,
          content: message.content
        })
      ),
      { role: 'user', content: request.question }
    ]

    for (let turn = 0; turn < 5; turn += 1) {
      const response = await this.chat(messages)
      const assistant = response.message
      if (!assistant) throw new Error('Ollama 未返回有效消息')
      messages.push(assistant)
      if (!assistant.tool_calls?.length) {
        return {
          answer: assistant.content || '模型没有生成回答。',
          sources: [...sources.values()]
        }
      }
      for (const call of assistant.tool_calls) {
        const result = this.executeTool(call.function.name, call.function.arguments, request.projectId)
        this.collectSources(result, sources)
        messages.push({
          role: 'tool',
          content: JSON.stringify(result)
        })
      }
    }
    throw new Error('Agent 工具调用次数过多，请缩小问题范围后重试')
  }

  private async chat(messages: OllamaMessage[]): Promise<OllamaResponse> {
    const response = await fetch(`${this.settings.baseUrl.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        tools,
        think: this.settings.thinking,
        stream: false,
        options: {
          temperature: 0.1,
          num_ctx: 32768,
          num_predict: 2048
        }
      }),
      signal: AbortSignal.timeout(180_000)
    })
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 300)}`)
    }
    return (await response.json()) as OllamaResponse
  }

  private executeTool(
    name: string,
    args: Record<string, unknown>,
    selectedProjectId?: string
  ): unknown {
    if (name === 'search_records') {
      return this.db.searchForAgent(
        String(args.query ?? ''),
        String(args.project_id ?? selectedProjectId ?? '') || undefined,
        Math.min(20, Math.max(1, Number(args.limit ?? 8)))
      )
    }
    if (name === 'get_record_detail') {
      const detail = this.db.getRecord(String(args.uid ?? ''), false)
      if (!detail) return { error: '记录不存在' }
      return {
        source: {
          uid: detail.uid,
          name: detail.name,
          nodeType: detail.nodeType,
          itemId: detail.itemId
        },
        text: detail.normalizedText,
        raw: detail.raw
      }
    }
    if (name === 'aggregate_records') {
      return this.db.aggregate(
        String(args.metric ?? 'count_by_type'),
        String(args.project_id ?? selectedProjectId ?? '') || undefined
      )
    }
    return { error: `未知工具 ${name}` }
  }

  private collectSources(input: unknown, sources: Map<string, ChatSource>): void {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (!value || typeof value !== 'object') return
      const obj = value as Record<string, unknown>
      if (obj.source && typeof obj.source === 'object') {
        const source = obj.source as ChatSource
        if (source.uid) sources.set(source.uid, source)
      }
      Object.values(obj).forEach(visit)
    }
    visit(input)
  }
}
