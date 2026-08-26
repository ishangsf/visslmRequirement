import type {
  AssistantIntentDecision,
  AssistantIntentResultMode,
  AssistantIntentSourceMode,
  AssistantIntentTaskType,
  ChatHistoryTurn,
  ChatRequest,
  ModelSettings
} from '../../shared/types'
import { expertRegistry } from '../experts/router'
import { ModelClient } from '../model-client'
import type { ModelChatInput, ModelResponse } from '../model-client'
import { sanitizeContextText, selectHistoryMessages } from '../context-budget'

/** Narrow adapter used by tests and by alternative model transports. */
export interface AssistantIntentModelClient {
  chat(input: ModelChatInput): Promise<ModelResponse>
}

const taskTypes: readonly AssistantIntentTaskType[] = [
  'conversation',
  'record_query',
  'knowledge_qa',
  'mixed_analysis',
  'visualization',
  'requirement_matching',
  'artifact_generation'
]

const sourceModes: readonly AssistantIntentSourceMode[] = [
  'conversation',
  'records',
  'knowledge',
  'mixed'
]

const resultModes: readonly AssistantIntentResultMode[] = [
  'answer',
  'list',
  'grouped_list',
  'table',
  'dashboard',
  'artifact'
]

const skillIds = new Set(['general', 'knowledge-base', 'visualization', 'requirement-analysis', 'artifact'])

const intentInitialOutputBudget = 900
const intentRetryOutputBudget = 1_800

export const assistantIntentDecisionFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taskType',
    'skillId',
    'sourceMode',
    'resolvedQuestion',
    'resultMode',
    'groupEntities',
    'needsClarification',
    'reason'
  ],
  properties: {
    taskType: { type: 'string', enum: taskTypes },
    skillId: { type: 'string', enum: ['general', 'knowledge-base', 'visualization', 'requirement-analysis', 'artifact'] },
    sourceMode: { type: 'string', enum: sourceModes },
    resolvedQuestion: { type: 'string' },
    resultMode: { type: 'string', enum: resultModes },
    groupEntities: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', maxLength: 80 }
    },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string', maxLength: 240 },
    reason: { type: 'string', maxLength: 500 }
  }
} as const

const mentionPatterns = {
  visualization: /@数据可视化专家(?=$|[\s，,。！？!?：:；;])/u,
  requirement: /@需求分析专家(?=$|[\s，,。！？!?：:；;])/u,
  knowledge: /@知识库专家(?=$|[\s，,。！？!?：:；;])/u,
  artifact: /@交付物专家(?=$|[\s，,。！？!?：:；;])/u,
  general: /@通用数据助手(?=$|[\s，,。！？!?：:；;])/u
} as const

const allMentionPattern = /@(?:数据可视化专家|需求分析专家|知识库专家|交付物专家|通用数据助手)\s*/gu

const normalizedGrounding = (value: string): string => (
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
)

const userHistory = (history: readonly ChatHistoryTurn[] | undefined): ChatHistoryTurn[] => (
  selectHistoryMessages(history, 8, 1_000)
    .filter((message) => message.role === 'user')
)

const groundingText = (
  question: string,
  history: readonly ChatHistoryTurn[] | undefined
): string => [
  question,
  ...userHistory(history).map((message) => message.content)
].join('\n')

const extractExplicitRequirementIds = (value: string): string[] => {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/gu)) {
    const id = match[0].trim()
    // Requirement identifiers have a structured separator and at least one
    // numeric component. This avoids treating ordinary hyphenated prose as an
    // exact-ID request while keeping the project-specific prefix flexible.
    if (!/\d/u.test(id)) continue
    const key = id.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    ids.push(id)
    if (ids.length >= 200) break
  }
  return ids
}

const parseModelJson = (response: ModelResponse): Record<string, unknown> => {
  const content = response.message?.content?.trim() ?? ''
  if (!content) throw new Error('统一意图模型未返回决策')
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('统一意图模型返回的决策不是有效 JSON')
  const parsed = JSON.parse(content.slice(start, end + 1)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('统一意图模型返回的决策不是对象')
  }
  return parsed as Record<string, unknown>
}

const hasEmptyVisibleContent = (response: ModelResponse): boolean => (
  !(response.message?.content?.trim() ?? '')
)

const isLengthTruncated = (response: ModelResponse): boolean => {
  const reason = response.done_reason?.trim().toLocaleLowerCase()
  return reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens'
}

const enumValue = <T extends string>(values: readonly T[], value: unknown): T | undefined => {
  const candidate = typeof value === 'string' ? value.trim() : ''
  return values.includes(candidate as T) ? candidate as T : undefined
}

const canonicalSourceForTask = (taskType: AssistantIntentTaskType): AssistantIntentSourceMode => {
  if (taskType === 'conversation') return 'conversation'
  if (taskType === 'knowledge_qa') return 'knowledge'
  if (taskType === 'mixed_analysis') return 'mixed'
  if (taskType === 'artifact_generation') return 'mixed'
  return 'records'
}

const canonicalSkillForTask = (
  taskType: AssistantIntentTaskType
): 'general' | 'knowledge-base' | 'visualization' | 'requirement-analysis' | 'artifact' => {
  if (taskType === 'knowledge_qa') return 'knowledge-base'
  if (taskType === 'visualization') return 'visualization'
  if (taskType === 'requirement_matching') return 'requirement-analysis'
  if (taskType === 'artifact_generation') return 'artifact'
  return 'general'
}

const defaultResultForTask = (taskType: AssistantIntentTaskType): AssistantIntentResultMode => {
  if (taskType === 'visualization') return 'dashboard'
  if (taskType === 'artifact_generation') return 'artifact'
  return taskType === 'record_query' ? 'list' : 'answer'
}

const stripMentions = (question: string): string => (
  question.replace(allMentionPattern, ' ').replace(/\s{2,}/gu, ' ').trim()
)

const safeEntity = (value: unknown, sourceText: string): string | undefined => {
  if (typeof value !== 'string') return undefined
  const candidate = sanitizeContextText(value, 80).replace(/[\r\n]+/gu, ' ').trim()
  const normalized = normalizedGrounding(candidate)
  // One-letter Latin values are too ambiguous to safely turn into a query
  // term. CJK names, identifiers and longer labels remain eligible.
  if (!normalized || (normalized.length < 2 && /^[a-z]$/u.test(normalized))) return undefined
  return normalizedGrounding(sourceText).includes(normalized) ? candidate : undefined
}

const validatedGroupEntities = (
  value: unknown,
  sourceText: string
): string[] => {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const entities: string[] = []
  for (const item of value) {
    const entity = safeEntity(item, sourceText)
    if (!entity) continue
    const key = normalizedGrounding(entity)
    if (seen.has(key)) continue
    seen.add(key)
    entities.push(entity)
    if (entities.length >= 12) break
  }
  return entities
}

const clarificationFor = (taskType: AssistantIntentTaskType | undefined): string => {
  if (taskType === 'visualization') return '请说明要生成或修改的大屏主题、数据范围或组件。'
  if (taskType === 'requirement_matching') return '请提供要分析的需求编号或明确的需求范围。'
  if (taskType === 'artifact_generation') return '请先选择一条包含可核验证据的已完成回答，再生成交付物。'
  return '请明确要查询的数据范围、资料来源或希望得到的结果形式。'
}

const artifactSourceModeOf = (
  source: ChatRequest['artifactSource']
): Exclude<AssistantIntentSourceMode, 'conversation'> => {
  const hasDocument = source?.evidenceBlocks.some((block) => block.kind === 'document') === true
  const hasRecords = source?.evidenceBlocks.some((block) => block.kind !== 'document') === true
  if (hasDocument && hasRecords) return 'mixed'
  return hasDocument ? 'knowledge' : 'records'
}

const capabilitySummary = expertRegistry.map((expert) => ({
  skillId: expert.id,
  name: expert.name,
  description: expert.description,
  capabilities: expert.capabilities
}))

export class AssistantIntentRouter {
  private readonly client: AssistantIntentModelClient

  constructor(
    private readonly settings: ModelSettings,
    client?: AssistantIntentModelClient
  ) {
    this.client = client ?? new ModelClient(settings)
  }

  async resolve(
    request: Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode' | 'artifactSource'>
  ): Promise<AssistantIntentDecision> {
    const question = String(request.question ?? '').trim()
    const cleanedQuestion = stripMentions(question)
    const history = userHistory(request.history)
    const sourceText = groundingText(question, request.history)
    if (!cleanedQuestion) {
      return {
        taskType: 'conversation',
        skillId: 'general',
        sourceMode: 'conversation',
        resolvedQuestion: '',
        resultMode: 'answer',
        groupEntities: [],
        needsClarification: true,
        clarificationQuestion: '请先输入要咨询的问题。',
        reason: 'empty-question'
      }
    }

    // Explicit specialist mentions retain priority and do not need a second
    // model interpretation that could redirect the request to another skill.
    if (mentionPatterns.visualization.test(question)) {
      return {
        taskType: 'visualization',
        skillId: 'visualization',
        sourceMode: 'records',
        resolvedQuestion: cleanedQuestion,
        resultMode: 'dashboard',
        groupEntities: [],
        needsClarification: false,
        reason: 'explicit-visualization-skill'
      }
    }
    if (mentionPatterns.requirement.test(question)) {
      return {
        taskType: 'requirement_matching',
        skillId: 'requirement-analysis',
        sourceMode: 'records',
        resolvedQuestion: cleanedQuestion,
        resultMode: 'answer',
        groupEntities: [],
        needsClarification: false,
        reason: 'explicit-requirement-skill'
      }
    }
    if (mentionPatterns.knowledge.test(question)) {
      return {
        taskType: 'knowledge_qa',
        skillId: 'knowledge-base',
        sourceMode: 'knowledge',
        resolvedQuestion: cleanedQuestion,
        resultMode: 'answer',
        groupEntities: [],
        needsClarification: false,
        reason: 'explicit-knowledge-base-skill'
      }
    }
    if (mentionPatterns.artifact.test(question)) {
      const hasEvidence = Boolean(request.artifactSource?.evidenceBlocks.length)
      return {
        taskType: 'artifact_generation',
        skillId: 'artifact',
        sourceMode: artifactSourceModeOf(request.artifactSource),
        resolvedQuestion: cleanedQuestion,
        resultMode: 'artifact',
        groupEntities: [],
        needsClarification: !hasEvidence,
        ...(!hasEvidence
          ? { clarificationQuestion: '请先选择一条包含可核验证据的已完成回答，再调用 @交付物专家。' }
          : {}),
        reason: 'explicit-artifact-skill'
      }
    }

    const forcedSkill = mentionPatterns.general.test(question) ? 'general' : undefined
    const exactIds = forcedSkill ? [] : extractExplicitRequirementIds(cleanedQuestion)
    if (exactIds.length) {
      return {
        taskType: 'requirement_matching',
        skillId: 'requirement-analysis',
        sourceMode: 'records',
        resolvedQuestion: cleanedQuestion,
        resultMode: 'answer',
        groupEntities: [],
        needsClarification: false,
        reason: 'exact-requirement-id'
      }
    }

    const messages: ModelChatInput['messages'] = [
      {
        role: 'system',
        content: [
          '你是 VISSLM Auto 助手的统一意图路由器，只输出一个严格 JSON 决策，不回答用户问题。',
          '这是模型优先的分类阶段：不得访问、猜测或依赖数据库字段、向量索引、知识库内容或工具结果。',
          'taskType 必须是 conversation、record_query、knowledge_qa、mixed_analysis、visualization、requirement_matching、artifact_generation 之一。',
          'sourceMode 必须分别表示普通对话、数据中心记录、上传文档知识库或两种来源；不要把记录向量当作文档知识。',
          'visualization 只用于明确的大屏/看板/图表交付，requirement_matching 只用于需求编号或需求相似匹配，artifact_generation 只用于把已验证证据生成 DOCX/XLSX/PPTX/ZIP；普通数据列表、筛选、统计和分析使用 record_query。',
          'resultMode 表示 answer、list、grouped_list、table 或 dashboard。用户要求按多个已提及实体分别列出时使用 grouped_list。',
          'groupEntities 只能填写当前问题或用户历史中实际出现、且与 grouped_list 直接相关的实体；不得创造、补全或猜测名称。',
          '当前句子省略实体时，可以从用户历史恢复明确实体；不要把助手上一轮的推测当作用户实体。',
          '来源、范围、字段或交付形式不能安全确定时，设置 needsClarification=true，给出具体 clarificationQuestion，并且不要猜测查询。',
          '不要宣称支持未列出的文件格式或交付物。',
          ...(forcedSkill ? [`用户显式选择了 general 技能，skillId 必须保持 general；只在该技能能力范围内选择任务。`] : []),
          `已注册技能能力：${JSON.stringify(capabilitySummary)}`,
          '输出严格 JSON，不要 Markdown。'
        ].join('\n')
      },
      {
        role: 'user',
        content: JSON.stringify({
          currentQuestion: question,
          conversationHistory: history.map((message) => ({
            role: message.role,
            content: message.content
          })),
          ...(forcedSkill ? { forcedSkill } : {})
        })
      }
    ]
    const classify = (numPredict: number): Promise<ModelResponse> => this.client.chat({
      messages,
      think: false,
      forceThinking: false,
      format: assistantIntentDecisionFormat,
      temperature: 0,
      numPredict
    })
    let response = await classify(intentInitialOutputBudget)
    if (hasEmptyVisibleContent(response) || isLengthTruncated(response)) {
      response = await classify(intentRetryOutputBudget)
    }
    const raw = parseModelJson(response)
    const taskType = enumValue(taskTypes, raw.taskType)
    const modelSkill = typeof raw.skillId === 'string' && skillIds.has(raw.skillId.trim())
      ? raw.skillId.trim() as 'general' | 'knowledge-base' | 'visualization' | 'requirement-analysis' | 'artifact'
      : undefined
    const rawSourceMode = enumValue(sourceModes, raw.sourceMode)
    const rawResultMode = enumValue(resultModes, raw.resultMode)
    const invalidDecisionShape = !taskType || !rawSourceMode || !rawResultMode ||
      !modelSkill || !Array.isArray(raw.groupEntities) ||
      typeof raw.resolvedQuestion !== 'string' || !raw.resolvedQuestion.trim()
    const resolvedTask = taskType ?? 'conversation'
    const skillId = forcedSkill ?? canonicalSkillForTask(resolvedTask)
    const sourceMode = canonicalSourceForTask(resolvedTask)
    const resultMode = rawResultMode ?? defaultResultForTask(resolvedTask)
    const proposedGroupEntities = Array.isArray(raw.groupEntities) ? raw.groupEntities : []
    const entities = validatedGroupEntities(proposedGroupEntities, sourceText)
    const hasUngroundedGroupEntity = !Array.isArray(raw.groupEntities) && raw.resultMode === 'grouped_list'
      ? true
      : proposedGroupEntities.some((item) => !safeEntity(item, sourceText))
    const modelResolvedQuestion = typeof raw.resolvedQuestion === 'string'
      ? sanitizeContextText(raw.resolvedQuestion, 2_000).trim()
      : ''
    const safeResolvedQuestion = hasUngroundedGroupEntity || invalidDecisionShape
      ? cleanedQuestion
      : modelResolvedQuestion
    const resolvedQuestion = [
      safeResolvedQuestion || cleanedQuestion,
      entities.length && entities.some((entity) => !normalizedGrounding(safeResolvedQuestion).includes(
        normalizedGrounding(entity)
      ))
        ? `分组实体：${entities.join('、')}`
        : ''
    ].filter(Boolean).join('\n')
    const modelNeedsClarification = raw.needsClarification === true
    const groupedWithoutGroundedEntities = resultMode === 'grouped_list' && entities.length === 0
    const artifactWithoutEvidence = resolvedTask === 'artifact_generation' &&
      !request.artifactSource?.evidenceBlocks.length
    const sourceMismatch = rawSourceMode !== undefined && rawSourceMode !== sourceMode
    const taskSkillMismatch = modelSkill !== undefined && modelSkill !== canonicalSkillForTask(resolvedTask)
    const needsClarification = modelNeedsClarification || groupedWithoutGroundedEntities || artifactWithoutEvidence ||
      hasUngroundedGroupEntity || invalidDecisionShape || sourceMismatch || taskSkillMismatch
    const clarificationQuestion = typeof raw.clarificationQuestion === 'string'
      ? sanitizeContextText(raw.clarificationQuestion, 240).trim()
      : ''
    const reason = typeof raw.reason === 'string' && raw.reason.trim()
      ? sanitizeContextText(raw.reason, 500).trim()
      : 'model-classified'

    // A forced general mention can still classify conversation, records,
    // knowledge or mixed work. It cannot silently escalate to a specialist.
    const normalizedTask = forcedSkill === 'general' && (
      resolvedTask === 'visualization' || resolvedTask === 'requirement_matching' || resolvedTask === 'artifact_generation'
    ) ? 'record_query' : resolvedTask
    const normalizedSource = canonicalSourceForTask(normalizedTask)
    const normalizedResult = normalizedTask === 'record_query' && resultMode === 'dashboard'
      ? 'list'
      : resultMode
    const normalizedSkill = forcedSkill ?? canonicalSkillForTask(normalizedTask)

    return {
      taskType: normalizedTask,
      skillId: normalizedSkill,
      sourceMode: normalizedSource,
      resolvedQuestion,
      resultMode: normalizedResult,
      groupEntities: entities,
      needsClarification,
      ...(needsClarification
        ? {
            clarificationQuestion: clarificationQuestion || (
                hasUngroundedGroupEntity
                ? '分组实体必须来自当前问题或用户历史，请确认要分别列出的实体。'
                : artifactWithoutEvidence
                  ? '请先选择一条包含可核验证据的已完成回答，再生成交付物。'
                : invalidDecisionShape || sourceMismatch || taskSkillMismatch
                  ? '统一意图决策不完整或来源不一致，请明确任务类型、数据来源和结果形式。'
                : clarificationFor(normalizedTask)
            )
          }
        : {}),
      reason: modelSkill && modelSkill !== normalizedSkill
        ? `${reason}; skill normalized to ${normalizedSkill}`
        : reason
    }
  }
}

export const resolveAssistantIntent = (
  request: Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode' | 'artifactSource'>,
  settings: ModelSettings,
  client?: AssistantIntentModelClient
): Promise<AssistantIntentDecision> => new AssistantIntentRouter(settings, client).resolve(request)
