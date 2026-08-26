import type { ChatRequest, ChatResponse, ModelSettings } from '../shared/types'
import { ModelClient, type ModelMessage } from './model-client'
import { selectHistoryWithSummary } from './context-budget'

export interface PlainChatClient {
  chat(input: {
    messages: ModelMessage[]
    think?: boolean
    forceThinking?: boolean
    temperature?: number
    numPredict?: number
    timeoutMs?: number
  }): Promise<{ message?: ModelMessage }>
}

const plainChatSystemPrompt = [
  '你是 VISSLM AI 的普通对话助手。',
  '当前消息没有明确 @ 任何专家，因此不要自动执行专家工作流。',
  '不要自动检索本地知识库、统计数据、匹配需求编号、生成数据大屏，也不要把模型记忆当作本地事实。',
  '如果问题需要本地数据或专业处理，请简洁说明应使用哪个专家：',
  '@通用数据助手 用于本地数据检索、统计和字段查询；',
  '@需求分析专家 用于按需求编号匹配相似需求；',
  '@数据可视化专家 用于生成或修改数据大屏。',
  '对于一般解释、写作、方法建议和闲聊，直接回答当前问题。',
  '使用中文，简洁清楚；不确定时明确说明，不要编造本地数据。'
].join('\n')

const historyMessages = (request: ChatRequest): ModelMessage[] => (
  selectHistoryWithSummary(request.history, 8, 1_200, 1_600).map((message) => ({
    role: message.role as ModelMessage['role'],
    content: message.content
  }))
)

export class PlainChatAgent {
  private readonly client: PlainChatClient

  constructor(
    settings: ModelSettings,
    client?: PlainChatClient
  ) {
    this.client = client ?? new ModelClient(settings)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    const response = await this.client.chat({
      messages: [
        { role: 'system', content: plainChatSystemPrompt },
        ...historyMessages(request),
        { role: 'user', content: request.question }
      ],
      think: false,
      forceThinking: false,
      temperature: 0.2,
      numPredict: 1600
    })
    const answer = response.message?.content?.trim()
    if (!answer) throw new Error('模型服务未返回有效回答')
    return {
      answer,
      sources: [],
      dataViews: []
    }
  }
}
