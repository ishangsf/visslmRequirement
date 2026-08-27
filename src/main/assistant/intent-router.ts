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
// Artifact delivery is an explicit-mention capability. Keeping it out of the
// automatic classifier schema/prompt avoids spending classification tokens on
// a route that Auto mode is never authorized to select.
const automaticTaskTypes = taskTypes.filter((taskType) => taskType !== 'artifact_generation')
const automaticResultModes = resultModes.filter((resultMode) => resultMode !== 'artifact')
const automaticSkillIds = ['general', 'knowledge-base', 'visualization', 'requirement-analysis'] as const

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
    taskType: { type: 'string', enum: automaticTaskTypes },
    skillId: { type: 'string', enum: automaticSkillIds },
    sourceMode: { type: 'string', enum: sourceModes },
    resolvedQuestion: { type: 'string' },
    resultMode: { type: 'string', enum: automaticResultModes },
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

const knowledgeSourcePattern = /(?:知识库|上传|附件|文档中|文件中|资料中)/u
const recordDomainPattern = /(?:数据中心|记录|需求|项目|资产|字段|负责人|状态|节点|本地数据)/u
const explicitRecordSourcePattern = /(?:数据中心|本地数据|本地记录|本地需求)/u
const recordReadPattern = /(?:一共有多少|有多少|多少(?:条|个|项)?|几条|数量|总数|数一下|数一数|算一下|算一算|统计|汇总|分布|列出|列表|查询|查找|筛选|搜索|查看|核对|有哪些|是谁|分别)/u
const visualizationPattern = /(?:可视化|大屏|看板|仪表盘|图表|折线图|柱状图|饼图|散点图)/u
const requirementMatchingPattern = /(?:需求(?:相似|匹配)|相似(?:的)?(?:需求|记录)|匹配(?:相似|相关)(?:需求|记录)|相关度|召回|重排)/u
const countResultPattern = /(?:一共有多少|有多少|多少(?:条|个|项)?|几条|数量|总数|数一下|数一数|算一下|算一算)/u
const tabularResultPattern = /(?:按.+(?:统计|汇总|分组)|分布|对比)/u
const listResultPattern = /(?:列出|列表|有哪些|查看|查找|筛选|搜索)/u
const groupedResultPattern = /(?:分别|各自|不要(?:放|放在|混在)?一起|不要合并|分开(?:列出|展示)?)/u
const comparativeResultPattern = /(?:哪个|谁).{0,20}(?:更多|较多|最多|更少|较少|最少|更高|更低)/u
const underspecifiedRequestPattern = /^(?:(?:请|麻烦)\s*)?(?:(?:帮我|帮忙)\s*)?(?:(?:根据|结合).{0,40})?(?:处理|分析|查看|查询|查|看|弄|做|回答)(?:一下|下)?(?:这个|这些|它)?(?:问题|内容|数据)?[。！？!?]*$/u
const internalRoutingClarificationPattern = /(?:任务类型|数据来源|资料来源|结果形式|交付形式|普通对话|数据中心查询、知识库问答)/u

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

const inferredTaskForQuestion = (
  question: string,
  exactRequirementIds: readonly string[] = []
): Exclude<AssistantIntentTaskType, 'artifact_generation'> => {
  const hasKnowledgeSource = knowledgeSourcePattern.test(question)
  const hasExplicitRecordSource = explicitRecordSourcePattern.test(question)
  const hasRecordGoal = recordDomainPattern.test(question) && (
    recordReadPattern.test(question) || hasExplicitRecordSource
  )
  if (visualizationPattern.test(question)) return 'visualization'
  if (exactRequirementIds.length || requirementMatchingPattern.test(question)) return 'requirement_matching'
  if (hasKnowledgeSource && hasExplicitRecordSource && hasRecordGoal) return 'mixed_analysis'
  if (hasKnowledgeSource) return 'knowledge_qa'
  if (hasRecordGoal) return 'record_query'
  return 'conversation'
}

const normalizedTaskForQuestion = (
  modelTask: AssistantIntentTaskType | undefined,
  question: string,
  exactRequirementIds: readonly string[] = []
): AssistantIntentTaskType => {
  const inferredTask = inferredTaskForQuestion(question, exactRequirementIds)
  // Strong, user-visible signals take priority over a contradictory classifier.
  // In particular, “相关需求有多少” is an aggregate record query, not a
  // requirement-similarity workflow merely because it contains “需求/相关”.
  if (inferredTask !== 'conversation') return inferredTask
  if (modelTask === 'visualization' && !visualizationPattern.test(question)) return 'conversation'
  if (
    modelTask === 'requirement_matching' &&
    !exactRequirementIds.length &&
    !requirementMatchingPattern.test(question)
  ) return 'conversation'
  if (modelTask === 'mixed_analysis' && !knowledgeSourcePattern.test(question)) return 'conversation'
  return modelTask ?? 'conversation'
}

const normalizedResultForQuestion = (
  taskType: AssistantIntentTaskType,
  modelResult: AssistantIntentResultMode | undefined,
  question: string,
  groupEntities: readonly string[]
): AssistantIntentResultMode => {
  if (taskType === 'visualization') return 'dashboard'
  if (taskType === 'artifact_generation') return 'artifact'
  if (taskType === 'conversation' || taskType === 'knowledge_qa' || taskType === 'requirement_matching') {
    return 'answer'
  }
  if (groupEntities.length >= 2 && comparativeResultPattern.test(question)) return 'answer'
  if (groupEntities.length && groupedResultPattern.test(question)) return 'grouped_list'
  if (groupEntities.length && modelResult === 'grouped_list') return 'grouped_list'
  if (countResultPattern.test(question)) return 'answer'
  if (tabularResultPattern.test(question)) return 'table'
  if (listResultPattern.test(question)) return 'list'
  if (modelResult && !['dashboard', 'artifact'].includes(modelResult)) return modelResult
  return defaultResultForTask(taskType)
}

const questionHasActionableGoal = (question: string): boolean => {
  const cleaned = question.replace(/[\s。！？!?，,；;：:]+/gu, ' ').trim()
  if (!cleaned) return false
  if (underspecifiedRequestPattern.test(question.trim())) return false
  return true
}

const safeClarificationQuestion = (value: string): string => (
  value && !internalRoutingClarificationPattern.test(value)
    ? value
    : '请说明希望我完成的具体目标或要处理的对象。'
)

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

/**
 * Recover a grouped query's entities from user-authored record requests.
 * Follow-up turns such as "分别列出，不要放一起" carry no names of their
 * own, so relying only on the classifier's proposed groupEntities loses the
 * previously grounded target. Keep this extractor intentionally narrow: it
 * only accepts names in a phrase tied to a record-like object and never reads
 * assistant messages.
 */
const extractGroupEntitiesFromUserText = (value: string): string[] => {
  const text = sanitizeContextText(value, 1_200).replace(/[\r\n]+/gu, ' ').trim()
  if (!text) return []
  const candidates: string[] = []
  const patterns = [
    /(?:查询|查找|查|列出|统计|查看|筛选|搜索|看看)\s*([^，。！？!?；;]{1,160}?)(?:(?:相关|有关)(?:的)?|的)\s*(?:需求|记录|项目|数据|事项)/gu,
    /([^，。！？!?；;]{1,160}?)(?:(?:相关|有关)(?:的)?|的)\s*(?:需求|记录|项目|数据|事项)/gu
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) candidates.push(match[1])
    }
    // The verb-led pattern is preferred. The broader fallback also matches
    // the verb itself as part of the candidate (for example "查周顺峰"),
    // which would otherwise create a duplicate, malformed entity.
    if (candidates.length) break
  }
  const entities: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const normalizedCandidate = candidate
      .replace(/^(?:(?:请|麻烦|帮我|帮忙|想知道|想查)\s*)+/u, '')
      .replace(/^(?:当前|本地)?数据中心(?:里|中|内)?\s*/u, '')
      .replace(/^(?:和|与|及|以及)\s*/u, '')
      .trim()
    for (const part of normalizedCandidate.split(/\s*(?:和|与|及|以及|、|,|，)\s*/u)) {
      const entity = part
        // "各自/分别" are grouping controls and may appear between the
        // entity list and the record noun (for example "甲和乙各自的需求").
        // Strip them before grounding so they cannot become "乙各自".
        .replace(/(?:分别|各自|逐一|单独)$/u, '')
        .replace(/(?:相关|有关)(?:的)?$/u, '')
        .replace(/的$/u, '')
        .trim()
      const key = normalizedGrounding(entity)
      if (!key || seen.has(key)) continue
      seen.add(key)
      entities.push(entity)
      if (entities.length >= 12) return entities
    }
  }
  return entities
}

const recoverGroupedEntities = (
  question: string,
  history: readonly ChatHistoryTurn[]
): string[] => {
  const currentEntities = extractGroupEntitiesFromUserText(question)
  if (currentEntities.length >= 2) return currentEntities
  // Search newest user turns first. Assistant prose is deliberately absent
  // from this input, so an assistant-invented name cannot become a query term.
  for (const message of [...history].reverse()) {
    const entities = extractGroupEntitiesFromUserText(message.content)
    if (entities.length >= 2) return entities
  }
  return []
}

const clarificationFor = (taskType: AssistantIntentTaskType | undefined): string => {
  if (taskType === 'visualization') return '请说明要生成或修改的大屏主题、数据范围或组件。'
  if (taskType === 'requirement_matching') return '请提供要分析的需求名称、编号或当前会话中的目标需求。'
  if (taskType === 'artifact_generation') return '请先选择一条包含可核验证据的已完成回答，再生成交付物。'
  return '请说明希望我完成的具体目标，或要处理的业务对象。'
}

const artifactSourceModeOf = (
  source: ChatRequest['artifactSource']
): Exclude<AssistantIntentSourceMode, 'conversation'> => {
  const hasDocument = source?.evidenceBlocks.some((block) => block.kind === 'document') === true
  const hasRecords = source?.evidenceBlocks.some((block) => block.kind !== 'document') === true
  if (hasDocument && hasRecords) return 'mixed'
  return hasDocument ? 'knowledge' : 'records'
}

const capabilitySummary = expertRegistry.filter((expert) => expert.id !== 'artifact').map((expert) => ({
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
    const groupedFollowUp = groupedResultPattern.test(cleanedQuestion)
    const recoveredGroupEntities = groupedFollowUp
      ? recoverGroupedEntities(cleanedQuestion, history)
      : []
    const explicitArtifactMention = mentionPatterns.artifact.test(question)
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
    if (explicitArtifactMention) {
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
          'taskType 必须是 conversation、record_query、knowledge_qa、mixed_analysis、visualization、requirement_matching 之一。',
          'sourceMode 必须分别表示普通对话、数据中心记录、上传文档知识库或两种来源；不要把记录向量当作文档知识。',
          'visualization 只用于明确的大屏/看板/图表交付，requirement_matching 只用于需求编号或需求相似匹配；普通数据列表、筛选、统计和分析使用 record_query。',
          '交付物生成不属于自动分类范围；不得选择、建议或准备交付物技能。该能力只由模型调用前的显式 @交付物专家 入口处理。',
          'resultMode 表示 answer、list、grouped_list、table 或 dashboard。用户要求按多个已提及实体分别列出时使用 grouped_list。',
          'groupEntities 只能填写当前问题或用户历史中实际出现、且与 grouped_list 直接相关的实体；不得创造、补全或猜测名称。',
          '当前句子省略实体时，可以从用户历史恢复明确实体；不要把助手上一轮的推测当作用户实体。',
          '只在缺少无法从问题、历史或后续只读工具中获得的用户决策时设置 needsClarification=true。',
          '不要要求用户填写 taskType、skillId、sourceMode、resultMode 等内部路由字段；低风险只读查询应选择最合理的默认值继续，由后续规划器结合真实字段目录校验。',
          '字段名、字段别名和数据是否存在不属于本阶段的追问理由；这些信息由后续规划与检索阶段从真实环境获得。',
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
    let raw: Record<string, unknown> = {}
    let classifierIssue = ''
    for (const numPredict of [intentInitialOutputBudget, intentRetryOutputBudget]) {
      try {
        const response = await classify(numPredict)
        if (hasEmptyVisibleContent(response)) {
          classifierIssue = 'classifier-empty-response'
          continue
        }
        if (isLengthTruncated(response)) {
          classifierIssue = 'classifier-length-truncated'
          continue
        }
        try {
          raw = parseModelJson(response)
          classifierIssue = ''
          break
        } catch (error) {
          classifierIssue = `classifier-invalid-json: ${error instanceof Error ? error.message : String(error)}`
        }
      } catch (error) {
        classifierIssue = `classifier-call-failed: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    const taskType = enumValue(taskTypes, raw.taskType)
    const modelSkill = typeof raw.skillId === 'string' && skillIds.has(raw.skillId.trim())
      ? raw.skillId.trim() as 'general' | 'knowledge-base' | 'visualization' | 'requirement-analysis' | 'artifact'
      : undefined
    const rawSourceMode = enumValue(sourceModes, raw.sourceMode)
    const rawResultMode = enumValue(resultModes, raw.resultMode)
    const invalidDecisionShape = !taskType || !rawSourceMode || !rawResultMode ||
      !modelSkill || !Array.isArray(raw.groupEntities) ||
      typeof raw.resolvedQuestion !== 'string' || !raw.resolvedQuestion.trim()
    const proposedGroupEntities = Array.isArray(raw.groupEntities) ? raw.groupEntities : []
    const modelGroupEntities = validatedGroupEntities(proposedGroupEntities, sourceText)
    const hasUngroundedModelEntity = proposedGroupEntities.some((item) => !safeEntity(item, sourceText))
    // A valid but incomplete model proposal may omit one of the user's prior
    // entities. Merge it with the deterministic history recovery; an invalid
    // proposal remains fail-closed instead of being silently repaired.
    const entities = hasUngroundedModelEntity
      ? modelGroupEntities
      : validatedGroupEntities([...proposedGroupEntities, ...recoveredGroupEntities], sourceText)
    const hasUngroundedGroupEntity = hasUngroundedModelEntity ||
      (!Array.isArray(raw.groupEntities) && raw.resultMode === 'grouped_list' && entities.length === 0)
    const modelResolvedQuestion = typeof raw.resolvedQuestion === 'string'
      ? sanitizeContextText(raw.resolvedQuestion, 2_000).trim()
      : ''
    const inferredTask = normalizedTaskForQuestion(taskType, cleanedQuestion, exactIds)
    const artifactWithoutExplicitMention = inferredTask === 'artifact_generation' && !explicitArtifactMention
    const contextualGroupedRecordQuery = groupedFollowUp && entities.length >= 2
    // A forced general mention stays inside the general assistant, while
    // automatic specialists require user-visible evidence in the question.
    const normalizedTask = contextualGroupedRecordQuery
      ? 'record_query'
      : artifactWithoutExplicitMention
      ? inferredTaskForQuestion(cleanedQuestion, exactIds)
      : forcedSkill === 'general' && (
          inferredTask === 'visualization' ||
          inferredTask === 'requirement_matching' ||
          inferredTask === 'artifact_generation'
        )
        ? 'record_query'
        : inferredTask
    const normalizedSource = canonicalSourceForTask(normalizedTask)
    const normalizedSkill = forcedSkill ?? canonicalSkillForTask(normalizedTask)
    const normalizedResult = normalizedResultForQuestion(
      normalizedTask,
      rawResultMode,
      cleanedQuestion,
      entities
    )
    const taskWasNormalized = taskType !== undefined && taskType !== normalizedTask
    const safeResolvedQuestion = hasUngroundedGroupEntity || invalidDecisionShape || taskWasNormalized
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
    const groupedWithoutGroundedEntities = normalizedResult === 'grouped_list' && entities.length === 0
    const artifactWithoutEvidence = normalizedTask === 'artifact_generation' &&
      explicitArtifactMention &&
      !request.artifactSource?.evidenceBlocks.length
    const sourceMismatch = rawSourceMode !== undefined && rawSourceMode !== normalizedSource
    const taskSkillMismatch = modelSkill !== undefined && modelSkill !== normalizedSkill
    const actionableGoal = questionHasActionableGoal(cleanedQuestion)
    // Classifier transport/schema errors and redundant route-field mismatches
    // are internal recovery events. They must never be presented as missing
    // user information. Clarification is reserved for a missing user goal or
    // a concrete, safety-relevant value that cannot be derived later.
    const needsClarification = groupedWithoutGroundedEntities || artifactWithoutEvidence ||
      hasUngroundedGroupEntity || !actionableGoal
    const clarificationQuestion = typeof raw.clarificationQuestion === 'string'
      ? sanitizeContextText(raw.clarificationQuestion, 240).trim()
      : ''
    const reason = typeof raw.reason === 'string' && raw.reason.trim()
      ? sanitizeContextText(raw.reason, 500).trim()
      : classifierIssue || 'deterministic-fallback'
    const normalizationNotes = [
      classifierIssue,
      invalidDecisionShape ? 'classifier-shape-normalized' : '',
      taskWasNormalized ? `task normalized from ${taskType} to ${normalizedTask}` : '',
      sourceMismatch ? `source normalized to ${normalizedSource}` : '',
      taskSkillMismatch ? `skill normalized to ${normalizedSkill}` : '',
      modelNeedsClarification && actionableGoal ? 'non-actionable classifier clarification suppressed' : ''
    ].filter(Boolean)

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
            clarificationQuestion: hasUngroundedGroupEntity
                ? '分组实体必须来自当前问题或用户历史，请确认要分别列出的实体。'
                : artifactWithoutEvidence
                  ? '请先选择一条包含可核验证据的已完成回答，再生成交付物。'
                  : groupedWithoutGroundedEntities
                    ? '请说明要分别列出的对象名称；这些名称需要来自当前问题或此前对话。'
                    : safeClarificationQuestion(clarificationQuestion)
          }
        : {}),
      reason: normalizationNotes.length ? `${reason}; ${normalizationNotes.join('; ')}` : reason
    }
  }
}

export const resolveAssistantIntent = (
  request: Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode' | 'artifactSource'>,
  settings: ModelSettings,
  client?: AssistantIntentModelClient
): Promise<AssistantIntentDecision> => new AssistantIntentRouter(settings, client).resolve(request)
