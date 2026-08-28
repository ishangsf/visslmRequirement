import type {
  ChatRequest,
  ChatResponse,
  ChatSource,
  AssistantThinkingMode,
  AssistantIntentResultMode,
  AssistantExecutionAgentId,
  ConnectionResult,
  FieldDefinitionNormalizedType,
  ModelSettings
} from '../shared/types'
import { AppDatabase } from './database'
import { ModelClient } from './model-client'
import type { ModelMessage, ModelResponse } from './model-client'
import { KnowledgeService } from './knowledge'
import type { AgentEvent, AssistantExecutionSummary } from '../shared/expert-types'
import {
  DataCenterAgent,
  findAmbiguousSemanticAliases,
  isGenericRecordTypeTerm,
  isRecordCountScaffoldingTerm
} from './assistant/agents/data-center-agent'
import type {
  DataCenterExecution,
  DataCenterQueryPlan
} from './assistant/agents/data-center-agent'
import { stripRedundantAssistantCitationSections } from '../shared/chat-message-format'
import { KnowledgeBaseAgent } from './assistant/agents/knowledge-base-agent'
import {
  attachAssistantTaskTrace,
  createAssistantTaskTrace,
  type AssistantTraceContext
} from './assistant/task-trace'
import { traceContextFromDecision } from './assistant/task-trace'
import {
  workLogForDelivery,
  workLogForEvidence,
  workLogForStatus,
  workLogForVerification,
  type AssistantWorkLogDraft
} from './assistant/work-log'
import {
  compactContextValue,
  compactEvidenceJson,
  sanitizeContextText,
  selectHistoryMessages,
  selectHistoryWithSummary
} from './context-budget'
import { resolveNaturalLanguageDeliveryIntent } from '../shared/assistant-natural-language'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

const MODEL_TOOL_FIELD_LIMIT = 512

const assistantCountQuestionPattern = /(?:一共有多少|有多少|多少(?:条|个|项)?|几条|数量|总数|数一下|数一数|算一下|算一算)/u
const assistantListQuestionPattern = /(?:列出|列表|有哪些|查找|查询|筛选|搜索|查看)/u
const assistantRecentListQuestionPattern = /(?:最近|最新|近期).{0,16}(?:更新|修改|变更)/u
const assistantExplicitRecordSourcePattern = /(?:本地|数据中心)(?:的)?(?:需求|记录|数据)/u
const assistantComparativeQuestionPattern = /(?:哪个|谁).{0,20}(?:更多|较多|最多|更少|较少|最少|更高|更低)/u
const assistantUnderspecifiedQuestionPattern = /^(?:(?:请|麻烦)\s*)?(?:(?:帮我|帮忙)\s*)?(?:处理|分析|查看|查询|查|看|弄|做|回答)(?:一下|下)?(?:这个|这些|它)?(?:问题|内容|数据)?[。！？!?]*$/u
const recordCountQuestionNoisePattern = /(?:当前|本地)?数据中心|全部|所有|需求记录|需求|记录|数据|一共有|一共|总共有|总共|共有|有多少|多少|几(?:条|个|项)?|数量|总数|数一下|数一数|算一下|算一算|统计一下|统计|请告诉我|告诉我|请问|请|麻烦|帮我|帮忙|想知道|是|有|条|个|项|的|吗|呢/gu

const parseChineseListLimit = (value: string): number | undefined => {
  const normalized = value.normalize('NFKC').trim()
  if (/^\d{1,3}$/u.test(normalized)) return Number(normalized)
  const digits: Record<string, number> = {
    '一': 1,
    '二': 2,
    '两': 2,
    '三': 3,
    '四': 4,
    '五': 5,
    '六': 6,
    '七': 7,
    '八': 8,
    '九': 9,
    '零': 0
  }
  const units: Record<string, number> = { '十': 10, '百': 100, '千': 1_000 }
  if (!normalized || [...normalized].some((character) => digits[character] === undefined && units[character] === undefined)) return undefined
  let total = 0
  let current = 0
  for (const character of normalized) {
    if (digits[character] !== undefined) {
      current = digits[character]
      continue
    }
    const unit = units[character]
    total += (current || 1) * unit
    current = 0
  }
  const result = total + current
  return result > 0 ? result : undefined
}

const explicitListLimitFromQuestion = (question: string): number | undefined => {
  const match = sanitizeContextText(question, 2_000)
    .normalize('NFKC')
    .match(/(\d{1,3}|[零一二两三四五六七八九十百千]{1,6})\s*(?:条|个|项|名|记录)/u)
  const value = match?.[1] ? parseChineseListLimit(match[1]) : undefined
  return value === undefined ? undefined : Math.min(50, Math.max(1, value))
}

const isUnconstrainedRecordCountQuestion = (question: string): boolean => {
  if (!assistantCountQuestionPattern.test(question)) return false
  const residual = sanitizeContextText(question, 2_000)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s，,。！？!?：:；;、]+/gu, '')
    .replace(recordCountQuestionNoisePattern, '')
  return residual.length === 0
}

const normalizeSearchCandidate = (value: string): string | undefined => {
  let candidate = sanitizeContextText(value, 120)
    .replace(/[\r\n]+/gu, ' ')
    .replace(/[\s，,。！？!?：:；;]+$/gu, '')
    .trim()
  // Planner output is untrusted text.  Strip only well-known query/delivery
  // scaffolding in a bounded loop; never expand a term or invent synonyms.
  for (let pass = 0; pass < 4; pass += 1) {
    const previous = candidate
    candidate = candidate
      .replace(/^(?:请问|请|麻烦|帮我|帮忙|想知道|想查|需要|查询|查找|统计|看看|看一下|数一下|统计一下|算一下|找出|列出|搜索|筛选)\s*/u, '')
      .replace(/^(?:当前|本地)?数据中心(?:里|中|内)?\s*(?:和|与|及|以及)?/u, '')
      .replace(/^(?:(?:整理|汇总|梳理|收集|归纳)(?:成|为)?|导出|生成|制作|做成|转(?:成|为)|转换(?:成|为)|保存(?:为|成)|给我(?:一份|一个|一张)?|提供(?:一份|一个|一张)?)\s*/u, '')
      .replace(/^(?:和|与|及|以及)\s*/u, '')
      .replace(/^[“"']|[”"']$/gu, '')
      .trim()
    if (candidate === previous) break
  }
  candidate = candidate
    .replace(/的(?:需求记录|需求|记录|项目|数据|事项)$/u, '')
    .replace(/(?:相关|有关)(?:的)?(?:需求|记录|项目|数据|事项)$/u, '')
    .replace(/(?:相关|有关)$/u, '')
    .replace(/(?:文件|表格)给我$/u, '')
    .replace(/(?:的)?(?:一共|总共|共有)?(?:有多少|多少|几(?:条|个|项)?|数量|总数)$/u, '')
    .replace(/[\s，,。！？!?：:；;]+$/gu, '')
    .trim()
  if (!candidate || candidate.length > 80) return undefined
  if (
    /^(?:当前|本地)?(?:数据中心)?(?:全部|所有)?(?:需求|记录|数据)?$/u.test(candidate) ||
    isGenericRecordTypeTerm(candidate) ||
    isRecordCountScaffoldingTerm(candidate)
  ) return undefined
  return candidate
}

/**
 * Recover only phrases that are visibly grounded in the user's wording. This
 * is a last-resort planner fallback, not a synonym-expansion mechanism.
 */
const groundedSearchTermsFromQuestion = (question: string): string[] => {
  const text = sanitizeContextText(question, 2_000).replace(/[\r\n]+/gu, ' ').trim()
  const candidates: string[] = []
  const quoted = text.match(/[“"']([^”"']{1,80})[”"']/u)?.[1]
  if (quoted) candidates.push(quoted)
  for (const pattern of [
    /([^，。！？!?]{1,80}?)(?:相关(?:的)?|有关(?:的)?)(?:需求|记录|数据)/u,
    /名称(?:为|是)\s*[“"']?([^”"'，。！？!?]{1,80})/u,
    /需求(?:代号|编号|ID|id)\s*(?:为|是|[:：])?\s*[“"']?([A-Za-z0-9][\p{L}\p{N}_-]{2,80})/u,
    /(?:把|由|让)?\s*([^，。！？!?]{1,80}?)(?:负责的|所负责的)(?:需求|记录|项目|数据)/u,
    /(?:负责人|责任人|承办人|经办人)\s*(?:为|是|[:：])\s*([^，。！？!?]{1,80}?)(?:的)?(?:需求|记录|项目|数据)/u,
    /([^，。！？!?]{1,80}?)(?:的)?(?:需求|记录)(?:一共)?(?:有)?(?:多少|几条)/u,
    /关于\s*([^，。！？!?]{1,80}?)(?:的)?(?:需求|记录|数据)/u,
    /(?:包含|含有|涉及|围绕)\s*([^，。！？!?]{1,80}?)(?:关键词)?(?:的)?(?:需求|记录|数据)/u,
    /(?:关于|针对|围绕|面向)\s*([^，。！？!?]{1,80}?)(?:的)?$/u,
    /(?:负责人|责任人|承办人|经办人)\s*(?:为|是|[:：])\s*([^，。！？!?]{1,80}?)(?:的)?$/u
  ]) {
    const match = text.match(pattern)?.[1]
    if (match) candidates.push(match)
  }
  // Delivery requests can contain a bare, but explicit, target such as
  // "生成周顺峰的 Excel".  Once the delivery clause has been removed, the
  // remaining short phrase is safe to ground as a term; scaffolding and broad
  // record nouns are rejected by normalizeSearchCandidate below.
  if (
    !candidates.length &&
    !/(?:数据中心|需求|记录|项目|数据|事项|查询|查找|统计|筛选|搜索|列出|查看|负责人|责任人|承办人|经办人|知识库|文档|资料)/u.test(text)
  ) {
    const fallback = normalizeSearchCandidate(text)
    if (fallback && !isGenericRecordTypeTerm(fallback) && !isRecordCountScaffoldingTerm(fallback)) {
      candidates.push(fallback)
    }
  }
  return candidates
    .map(normalizeSearchCandidate)
    .filter((candidate, index, values): candidate is string => (
      Boolean(candidate) && values.indexOf(candidate) === index
    ))
    .slice(0, 4)
}

const normalizeAssistantThinkingMode = (value: unknown): AssistantThinkingMode => {
  if (value === 'on' || value === 'off' || value === 'auto') return value
  return 'auto'
}

const finalAnswerThinkingEnabled = (value: unknown): boolean => (
  normalizeAssistantThinkingMode(value) === 'on'
)

/**
 * Knowledge citations are renderer-intercepted local fragments.  The
 * fragment deliberately carries only the two opaque identifiers needed to
 * locate a chunk; the visible Markdown label is always a document name/file
 * name plus its human-readable location.  Never use ChatSource.uid as the
 * visible citation for a document.
 */
const knowledgeCitationFragmentPrefix = '#knowledge-document='

const safeCitationIdentifier = (value: unknown): string | undefined => {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate || candidate.length > 300 || /[\u0000-\u001f\u007f]/u.test(candidate)) return undefined
  return candidate
}

const encodeCitationIdentifier = (value: string): string => encodeURIComponent(value)
  .replace(/[!'()*]/gu, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)

const citationLabelPart = (value: unknown, fallback: string): string => {
  const text = sanitizeContextText(value, 240).replace(/[\r\n]+/gu, ' ').trim() || fallback
  // Keep labels simple so the validator remains idempotent even when a file
  // name contains Markdown punctuation; links are never built from raw text.
  return text.replace(/[\\[\]()`]/gu, ' ').replace(/\s{2,}/gu, ' ').trim() || fallback
}

const genericCitationLocationPattern = /^(?:文档正文|正文|文档内容|正文内容|内容|默认位置|采集记录|(?:分块|chunk)[\s:：#-]*\d+(?:\s*[/／]\s*\d+)?)$/iu

const citationLocationFor = (source: ChatSource): string | undefined => {
  const pageNumber = Number(source.pageNumber)
  if (Number.isFinite(pageNumber) && pageNumber >= 1) {
    return `第 ${Math.trunc(pageNumber)} 页`
  }
  const sheetName = citationLabelPart(source.sheetName, '')
  if (sheetName) return `工作表「${sheetName}」`
  const location = citationLabelPart(source.location, '')
  if (location && !genericCitationLocationPattern.test(location)) return location

  const snippet = sanitizeContextText(source.snippet, 240)
  if (!snippet) return undefined
  const snippetCharacters = Array.from(snippet)
  const preview = snippetCharacters.slice(0, 24).join('')
  return `正文「${preview}${snippetCharacters.length > 24 ? '…' : ''}」`
}

const knowledgeCitationHref = (source: ChatSource): string | undefined => {
  if (source.sourceType !== 'document') return undefined
  const documentId = safeCitationIdentifier(source.documentId)
  const chunkId = safeCitationIdentifier(source.chunkId)
  if (!documentId || !chunkId) return undefined
  return `${knowledgeCitationFragmentPrefix}${encodeCitationIdentifier(documentId)}&chunk=${encodeCitationIdentifier(chunkId)}`
}

const knowledgeCitationMarkdown = (source: ChatSource): string | undefined => {
  const href = knowledgeCitationHref(source)
  if (!href) return undefined
  const name = citationLabelPart(source.fileName || source.name, '知识库文档')
  const location = citationLocationFor(source)
  // A chunk-specific link without a human-readable location is not a
  // complete provenance marker.  Keep malformed legacy sources fail-closed.
  if (!location) return undefined
  return `[${name} · ${location}](${href})`
}

const sourceIdentity = (source: ChatSource): string => {
  if (source.sourceType === 'document') {
    // A document can produce many chunks while retaining the same document
    // UID.  Prefer the document/chunk pair so every evidence block remains
    // independently addressable; fall back only for malformed legacy data.
    const documentId = safeCitationIdentifier(source.documentId)
    const chunkId = safeCitationIdentifier(source.chunkId)
    if (documentId && chunkId) return `document:${documentId}:${chunkId}`
    return `document-uid:${source.uid}`
  }
  return `record:${source.uid}`
}

type QuestionPlanIntent = DataCenterQueryPlan['intent']
type QuestionPlanSourceMode = DataCenterQueryPlan['sourceMode']
type QuestionPlan = DataCenterQueryPlan
type RecordPlanExecution = DataCenterExecution
type KnowledgePlanExecution = Awaited<ReturnType<KnowledgeBaseAgent['search']>>

const compactGroundingForSearch = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, '')

const explicitBusinessIdentifierPattern = /^[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+$/u

/**
 * Return one bounded term-only correction for a zero-hit record query.
 *
 * The candidate must be produced by removing known planner/query scaffolding
 * from an existing term, remain visibly present in user-authored text, and
 * not be a structured business identifier.  Scope, filters, fields, project
 * and permissions are intentionally outside this helper and therefore remain
 * untouched by the retry.
 */
const zeroHitSearchCorrectionFor = (
  request: ChatRequest,
  plan: QuestionPlan
): string[] | undefined => {
  if (plan.sourceMode !== 'records' || !plan.searchTerms.length) return undefined
  const userText = [
    request.question,
    ...(request.history ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
  ].join('\n')
  const compactUserText = compactGroundingForSearch(userText)
  const corrected: string[] = []
  let changed = false
  for (const value of plan.searchTerms) {
    const original = String(value ?? '').trim()
    if (!original || explicitBusinessIdentifierPattern.test(original)) return undefined
    const candidate = normalizeSearchCandidate(original)
    if (!candidate) return undefined
    if (candidate !== original) changed = true
    if (candidate !== original) {
      if (explicitBusinessIdentifierPattern.test(candidate)) return undefined
      const compactCandidate = compactGroundingForSearch(candidate)
      if (!compactCandidate || !compactUserText.includes(compactCandidate)) return undefined
      if (isGenericRecordTypeTerm(candidate) || isRecordCountScaffoldingTerm(candidate)) return undefined
    }
    if (!corrected.some((term) => compactGroundingForSearch(term) === compactGroundingForSearch(candidate))) {
      corrected.push(candidate)
    }
  }
  return changed && corrected.length ? corrected : undefined
}

interface PlanAnswerExecution {
  response: ChatResponse
  invokedAgents: AssistantExecutionAgentId[]
}

interface AssistantExecutionFailure extends Error {
  invokedAgents?: AssistantExecutionAgentId[]
  traceContext?: AssistantTraceContext
}

const removeRecordUidIndex = (value: unknown, propertyKey?: string): unknown => {
  if (Array.isArray(value)) return value.map((item) => removeRecordUidIndex(item, propertyKey))
  if (!value || typeof value !== 'object') return value
  const sourceType = (value as { sourceType?: unknown }).sourceType
  const recordSource = sourceType === 'record' || (propertyKey === 'source' && sourceType !== 'document')
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['recordUids', 'recordUidsByTerm'].includes(key) && !(recordSource && key === 'uid'))
      .map(([key, nested]) => [key, removeRecordUidIndex(nested, key)])
  )
}

const matchedRecordCount = (result: unknown): number => {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return 0
  const value = result as { matchedCount?: unknown; records?: unknown }
  const matchedCount = Number(value.matchedCount)
  if (Number.isFinite(matchedCount) && matchedCount >= 0) return Math.trunc(matchedCount)
  return Array.isArray(value.records) ? value.records.length : 0
}

interface MutableJsonSchema {
  [key: string]: unknown
  enum?: string[]
  items?: MutableJsonSchema
  properties?: Record<string, MutableJsonSchema>
}

const questionPlanFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceMode',
    'needsClarification',
    'intent',
    'explanation',
    'searchTerms',
    'searchMode',
    'filters',
    'fields',
    'limit'
  ],
  properties: {
    sourceMode: {
      type: 'string',
      enum: ['conversation', 'records', 'knowledge', 'mixed']
    },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string' },
    intent: {
      type: 'string',
      enum: [
        'conversation',
        'schema_inspection',
        'total',
        'field_aggregate',
        'count_matching',
        'record_lookup',
        'filter_records',
        'analyze_records',
        'search_content'
      ]
    },
    explanation: { type: 'string' },
    nodeType: { type: 'string' },
    searchTerms: {
      type: 'array',
      maxItems: 10,
      items: { type: 'string' }
    },
    searchMode: { type: 'string', enum: ['any', 'all'] },
    filters: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'operator'],
        properties: {
          field: { type: 'string' },
          operator: {
            type: 'string',
            enum: [
              'equals',
              'not_equals',
              'contains',
              'not_contains',
              'is_empty',
              'not_empty',
              'gt',
              'gte',
              'lt',
              'lte'
            ]
          },
          value: { type: 'string' }
        }
      }
    },
    fields: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string' }
    },
    resultMode: {
      type: 'string',
      enum: ['answer', 'list', 'grouped_list', 'table', 'dashboard']
    },
    groupEntities: {
      type: 'array',
      maxItems: 12,
      items: { type: 'string', maxLength: 80 }
    },
    groupByField: { type: 'string' },
    metric: {
      type: 'string',
      enum: ['record_count', 'image_count', 'count_by_type', 'count_by_project']
    },
    sort: {
      type: 'object',
      additionalProperties: false,
      required: ['field', 'direction'],
      properties: {
        field: { type: 'string' },
        direction: { type: 'string', enum: ['asc', 'desc'] }
      }
    },
    limit: { type: 'integer', minimum: 1, maximum: 50 }
  }
}

const questionSourceDecisionFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceMode', 'needsClarification', 'intent'],
  properties: {
    sourceMode: {
      type: 'string',
      enum: ['conversation', 'records', 'knowledge', 'mixed']
    },
    needsClarification: { type: 'boolean' },
    clarificationQuestion: { type: 'string' },
    evidenceLimit: { type: 'integer', minimum: 4, maximum: 20 },
    intent: {
      type: 'string',
      enum: [
        'conversation',
        'schema_inspection',
        'total',
        'field_aggregate',
        'count_matching',
        'record_lookup',
        'filter_records',
        'analyze_records',
        'search_content'
      ]
    }
  }
}

export class OllamaAgent {
  private readonly dataCenterAgent: DataCenterAgent
  private readonly knowledgeBaseAgent: KnowledgeBaseAgent

  constructor(
    private readonly db: AppDatabase,
    private readonly settings: ModelSettings,
    private readonly knowledge?: KnowledgeService,
    private readonly onProgress?: (event: AgentStatusEvent) => void,
    private readonly onTextDelta?: (content: string) => void,
    private readonly onActivity?: (activity: AssistantWorkLogDraft) => void
  ) {
    this.dataCenterAgent = new DataCenterAgent(db)
    this.knowledgeBaseAgent = new KnowledgeBaseAgent(db, knowledge, {
      onProgress: (message) => this.progress('retrieve', message)
    })
  }

  async test(probeChat = false, probeCapabilities = false): Promise<ConnectionResult> {
    return new ModelClient(this.settings).test(probeChat, probeCapabilities)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    const startedAt = new Date().toISOString()
    const providedIntent = request.assistantIntent
    const fallbackTraceContext: AssistantTraceContext = {
      taskType: 'conversation',
      sourceMode: 'conversation',
      resultMode: 'answer',
      primaryAgent: 'conversation',
      invokedAgents: []
    }
    const makeFailure = (
      message: string,
      context: AssistantTraceContext,
      invokedAgents: AssistantExecutionAgentId[]
    ): AssistantExecutionFailure => {
      const failure = new Error(message) as AssistantExecutionFailure
      failure.invokedAgents = [...invokedAgents]
      failure.traceContext = context
      return failure
    }
    if (providedIntent) {
      const routeValidation = (() => {
        try {
          return { route: traceContextFromDecision(providedIntent) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      })()
      if ('error' in routeValidation) {
        throw new Error(`执行任务与来源组合未通过校验：${routeValidation.error}`)
      }
      if (providedIntent.taskType === 'visualization' || providedIntent.taskType === 'requirement_matching') {
        throw new Error(`任务 ${providedIntent.taskType} 必须交给已注册的专业执行 Agent`)
      }
    }
    if (request.assistantIntent?.needsClarification) {
      const clarificationQuestion = request.assistantIntent.clarificationQuestion ||
        '请说明希望查询的业务对象或要解决的具体问题。'
      const context = providedIntent
        ? traceContextFromDecision(providedIntent)
        : {
            taskType: 'conversation' as const,
            sourceMode: 'conversation' as const,
            resultMode: 'answer' as const,
            primaryAgent: 'conversation' as const,
            invokedAgents: [] as AssistantExecutionAgentId[]
          }
      return {
        answer: clarificationQuestion,
        sources: [],
        dataViews: [],
        needsClarification: true,
        clarificationQuestion,
        taskTrace: createAssistantTaskTrace(context, {
          startedAt,
          status: 'clarification',
          clarificationQuestion
        })
      }
    }
    const naturalDelivery = resolveNaturalLanguageDeliveryIntent(request.question)
    const naturalDeliveryQuery = naturalDelivery?.queryText.trim() ?? ''
    const suppliedResolvedQuestion = request.assistantIntent?.resolvedQuestion?.trim() ?? ''
    // Prefer the deterministic delivery boundary over a model-provided
    // resolvedQuestion.  This prevents a planner/classifier from re-inserting
    // "Excel 文件给我" as a record term while keeping explicit artifact
    // routing (which never reaches this path) unchanged.
    const effectiveQuestion = naturalDeliveryQuery || suppliedResolvedQuestion || request.question
    let effectiveRequest = effectiveQuestion === request.question
      ? request
      : { ...request, question: effectiveQuestion }
    this.progress('route', '正在理解问题并准备执行')
    let plan: QuestionPlan | undefined
    let planningError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        this.progress('plan', '正在读取可用数据并准备查询')
        // Only a detected delivery clause may replace the grounding text.
        // For ordinary requests, keep the user's original wording as the
        // evidence boundary even when the intent router supplied a rewritten
        // resolvedQuestion; otherwise grounded entities can disappear.
        const planningGroundingQuestion = naturalDeliveryQuery || request.question
        plan = await this.planQuestion(effectiveRequest, planningGroundingQuestion)
        break
      } catch (error) {
        planningError = error
        console.warn(
          `结构化查询规划第 ${attempt} 次失败${attempt < 2 ? '，准备重试' : ''}：`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    if (!plan) {
      const message =
        planningError instanceof Error ? planningError.message : String(planningError ?? '')
      const context = providedIntent
        ? traceContextFromDecision(providedIntent)
        : fallbackTraceContext
      throw makeFailure(
        `无法确定可验证的数据查询条件，本次未生成猜测性回答。${message ? ` 原因：${message}` : ''}`,
        context,
        []
      )
    }
    if (plan.needsClarification) {
      const clarificationQuestion = plan.clarificationQuestion || '请说明希望查询的业务对象或要解决的具体问题。'
      this.activity({
        kind: 'checkpoint',
        stage: 'scope-confirmation',
        title: '等待用户选择',
        summary: '当前缺少无法从上下文安全推断的业务对象或处理条件。',
        status: 'warning'
      })
      const context = this.traceContextForPlan(plan)
      return {
        answer: clarificationQuestion,
        sources: [],
        dataViews: [],
        needsClarification: true,
        clarificationQuestion,
        taskTrace: createAssistantTaskTrace(context, {
          startedAt,
          status: 'clarification',
          clarificationQuestion
        })
      }
    }
    if (process.env.VISSLM_AGENT_DEBUG === '1') {
      console.info('[Agent] 结构化查询条件：', JSON.stringify(plan))
    }
    try {
      this.progress('query', '正在执行本地查询并获取证据')
      const execution = await this.executePlanAndAnswer(effectiveRequest, plan)
      // executePlanAndAnswer may perform one bounded, term-only recovery.  It
      // updates the plan before returning so this summary records the exact
      // searchTerms that reached the data-center tool.
      const executionSummary = this.executionSummaryFor(effectiveRequest, plan)
      const context = this.traceContextForPlan(plan)
      return attachAssistantTaskTrace({ ...execution.response, executionSummary }, context, {
        startedAt,
        invokedAgents: execution.invokedAgents
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = error as AssistantExecutionFailure
      const context = failure.traceContext ?? (
        providedIntent ? traceContextFromDecision(providedIntent) : fallbackTraceContext
      )
      throw makeFailure(
        `查询执行或结果校验失败，本次未生成猜测性回答。${message ? ` 原因：${message}` : ''}`,
        context,
        failure.invokedAgents ?? []
      )
    }
  }

  private progress(stage: string, message: string): void {
    this.onProgress?.({ type: 'status', stage, message })
    this.onActivity?.(workLogForStatus(stage, message))
  }

  private activity(activity: AssistantWorkLogDraft): void {
    this.onActivity?.(activity)
  }

  private executionSummaryFor(request: ChatRequest, plan: QuestionPlan): AssistantExecutionSummary {
    const scope = request.dataScope
    const projectIds = [...new Set(
      (scope?.projectIds !== undefined
        ? scope.projectIds
        : request.projectId ? [request.projectId] : [])
        .map((value) => value.trim())
        .filter(Boolean)
    )]
    const valueText = (value: unknown): string | undefined => {
      if (value === undefined) return undefined
      if (typeof value === 'string') return sanitizeContextText(value, 240)
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return sanitizeContextText(JSON.stringify(value), 240)
    }
    return {
      question: request.question,
      taskType: this.traceContextForPlan(plan).taskType,
      sourceMode: plan.sourceMode,
      resultMode: plan.resultMode,
      intent: plan.intent,
      searchTerms: [...plan.searchTerms],
      fields: [...plan.fields],
      filters: plan.filters.map((filter) => ({
        field: filter.field,
        operator: filter.operator,
        ...(filter.value === undefined ? {} : { value: filter.value })
      })),
      ...(plan.groupEntities.length ? { groupEntities: [...plan.groupEntities] } : {}),
      ...(plan.searchMode ? { searchMode: plan.searchMode } : {}),
      ...(plan.groupByField ? { groupByField: plan.groupByField } : {}),
      ...(plan.sort ? { sort: { ...plan.sort } } : {}),
      limit: plan.limit,
      scope: {
        projectIds,
        nodeTypes: [...new Set((scope?.nodeTypes ?? []).map((value) => value.trim()).filter(Boolean))],
        ...(scope?.recordUids ? { recordCount: scope.recordUids.length } : {}),
        baseFilters: (scope?.baseFilters ?? []).map((filter) => ({
          field: filter.field,
          operator: filter.operator,
          ...(filter.value === undefined ? {} : { value: valueText(filter.value) })
        })),
        ...(scope?.snapshotAt ? { snapshotAt: scope.snapshotAt } : {})
      }
    }
  }

  private traceContextForPlan(plan: QuestionPlan): AssistantTraceContext {
    const taskType = plan.sourceMode === 'conversation'
      ? 'conversation'
      : plan.sourceMode === 'knowledge'
        ? 'knowledge_qa'
        : plan.sourceMode === 'mixed'
          ? 'mixed_analysis'
          : 'record_query'
    return traceContextFromDecision({
      taskType,
      sourceMode: plan.sourceMode,
      resultMode: plan.resultMode
    })
  }

  private async planQuestion(
    request: ChatRequest,
    groundingQuestionInput?: string
  ): Promise<QuestionPlan> {
    const rawGroundingQuestion = String(groundingQuestionInput ?? request.question).trim()
    const parsedDelivery = resolveNaturalLanguageDeliveryIntent(rawGroundingQuestion)
    const groundingQuestion = parsedDelivery?.queryText.trim() || rawGroundingQuestion
    const naturalDeliveryQuery = parsedDelivery?.queryText.trim() ?? ''
    const naturalDeliveryRecordRequest = Boolean(naturalDeliveryQuery)
    const conversationContext = selectHistoryMessages(request.history, 6, 1_200)
    const plannerGroundingText = [
      groundingQuestion,
      ...(request.history ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
    ].join('\n')
    const parsePlannerResponse = (response: ModelResponse): Record<string, unknown> => {
      const content = response.message?.content?.trim()
      if (!content) throw new Error('规划模型未返回查询计划')
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start < 0 || end <= start) throw new Error('查询计划不是有效 JSON')
      return JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
    }
    const intents: QuestionPlanIntent[] = [
      'conversation',
      'schema_inspection',
      'total',
      'field_aggregate',
      'count_matching',
      'record_lookup',
      'filter_records',
      'analyze_records',
      'search_content'
    ]
    const intentFromRaw = (raw: Record<string, unknown>): QuestionPlanIntent => {
      if (intents.includes(raw.intent as QuestionPlanIntent)) {
        return raw.intent as QuestionPlanIntent
      }
      return raw.sourceMode === 'conversation' ? 'conversation' : 'search_content'
    }
    const sourceModes: QuestionPlanSourceMode[] = ['conversation', 'records', 'knowledge', 'mixed']
    const sourceModeFromRaw = (
      raw: Record<string, unknown>,
      intent: QuestionPlanIntent
    ): QuestionPlanSourceMode => (
      sourceModes.includes(raw.sourceMode as QuestionPlanSourceMode)
        ? raw.sourceMode as QuestionPlanSourceMode
        // Older planner responses predate sourceMode. Preserve their contract:
        // conversation remains conversation and every data intent uses records.
        : intent === 'conversation'
          ? 'conversation'
          : 'records'
    )
    const providedDecision = request.assistantIntent
    const sourceResponse = providedDecision
      ? undefined
      : await this.callModel({
          messages: [
            {
              role: 'system',
              content: [
                '你是 VISSLM 统一任务规划器的来源判定阶段，不回答问题，只输出 JSON。',
                '必须先选择唯一 sourceMode：conversation（闲聊/通用方法）、records（当前数据中心记录）、knowledge（上传文档知识库）或 mixed（明确同时需要记录与文档）。',
                '问候、闲聊、助手身份、通用知识或方法建议使用 conversation；明确要求上传资料、文档或知识库内容使用 knowledge；明确同时要求数据中心记录和文档内容使用 mixed。',
                '来源、范围或问题意图不能安全确定时设置 needsClarification=true，并提出具体 clarificationQuestion；不得猜测。',
                'knowledge 或 mixed 可用 evidenceLimit 指定送入回答模型的文档证据预算：简单问答默认 8，跨文档汇总、对比或清单可提高到 12-20；该值不是知识库扫描范围。',
                'sourceMode=conversation 时 intent 使用 conversation；其他 sourceMode 使用最贴近的结构化意图。',
                '只输出符合计划 schema 的 JSON；暂时不要访问或假设任何字段目录。',
                '输出严格 JSON，不要 Markdown。'
              ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                currentQuestion: groundingQuestion,
                conversationContext,
                availableNodeTypes: [],
                fieldCatalog: []
              })
            }
          ],
          think: true,
          format: questionSourceDecisionFormat,
          temperature: 0,
          numPredict: 500
        })
    const intentFromDecision = (decision: NonNullable<ChatRequest['assistantIntent']>): QuestionPlanIntent => {
      if (decision.taskType === 'conversation') return 'conversation'
      if (decision.taskType === 'knowledge_qa') return 'search_content'
      if (decision.taskType === 'visualization') return 'analyze_records'
      if (decision.taskType === 'requirement_matching') return 'record_lookup'
      if (decision.taskType === 'mixed_analysis') return 'analyze_records'
      if (decision.taskType === 'record_query' && assistantCountQuestionPattern.test(groundingQuestion)) {
        return groundedSearchTermsFromQuestion(plannerGroundingText).length ? 'count_matching' : 'total'
      }
      return decision.resultMode === 'grouped_list' || decision.resultMode === 'list' || decision.resultMode === 'table'
        ? 'filter_records'
        : 'search_content'
    }
    const sourceRaw = providedDecision
      ? {
          sourceMode: providedDecision.sourceMode,
          needsClarification: providedDecision.needsClarification,
          clarificationQuestion: providedDecision.clarificationQuestion,
          intent: intentFromDecision(providedDecision),
          explanation: providedDecision.reason,
          searchTerms: providedDecision.groupEntities,
          groupEntities: providedDecision.groupEntities,
          resultMode: providedDecision.resultMode
        } as Record<string, unknown>
      : parsePlannerResponse(sourceResponse!)
    const initialIntent = intentFromRaw(sourceRaw)
    const initialSourceMode = sourceModeFromRaw(sourceRaw, initialIntent)
    const initialNeedsClarification = sourceRaw.needsClarification === true

    let raw = sourceRaw
    let plannerRecoveryIssue = ''
    let nodeTypes: string[] = []
    let catalog: Array<{
      field: string
      displayName?: string
      role?: 'dimension' | 'measure' | 'time' | 'identifier'
      synonyms: string[]
      kind: 'technical' | 'business'
      declaredType?: FieldDefinitionNormalizedType
      sourceType?: string
      attrType?: string
      types: string[]
      coverageRate: number
      samples: string[]
    }> = []
    const deterministicGroupedDecision = Boolean(
      providedDecision &&
      providedDecision.resultMode === 'grouped_list' &&
      providedDecision.groupEntities.length
    )
    if (
      !initialNeedsClarification &&
      (initialSourceMode === 'records' || initialSourceMode === 'mixed')
    ) {
      const catalogSnapshot = this.dataCenterAgent.inspectCatalog(request.projectId)
      nodeTypes = catalogSnapshot.nodeTypes
      catalog = catalogSnapshot.fields
      const fieldNames = catalog.map((field) => field.field)
      if (!deterministicGroupedDecision) {
        const planFormat = structuredClone(questionPlanFormat) as MutableJsonSchema
        const planProperties = planFormat.properties
        if (planProperties) {
          planProperties.nodeType.enum = nodeTypes
          planProperties.groupByField.enum = fieldNames
          planProperties.fields.items!.enum = fieldNames
          planProperties.filters.items!.properties!.field.enum = fieldNames
          planProperties.sort.properties!.field.enum = fieldNames
        }
        try {
          const planResponse = await this.callModel({
            messages: [
              {
                role: 'system',
                content: [
                  '你是 AI 助手意图与数据查询规划器，不回答问题，只输出 JSON 计划。',
                  'sourceMode 已由统一规划阶段选定；records 表示当前数据中心记录，mixed 表示还要单独检索上传文档。',
                  '必须根据当前问题和提供的真实字段目录规划，不能复用无关历史结论。',
                  '先判断问题是否真的需要访问本地数据；没有明确数据诉求时绝不能强行生成统计或查询计划。',
                  '只有用户明确要求上传资料/知识库内容时使用 knowledge；同时明确要求数据中心记录和上传资料时使用 mixed。',
                  '低风险只读查询中，不要让用户填写内部任务类型、数据来源、字段 key 或结果枚举；优先用真实字段目录、显示名和同义词完成映射。',
                  '只有两个以上已验证业务解释会实质改变结果，且无法从上下文或只读查询消除时，才设置 needsClarification=true，并提出一个具体业务问题。',
                  '询问当前数据有哪些字段、字段含义、覆盖率或示例值时使用 schema_inspection。',
                  '要求基于若干记录归纳、总结、比较、解释原因、发现规律或提出建议时使用 analyze_records。',
                  '需要数据时，再识别总量、字段聚合、条件计数、具体记录属性、记录筛选、记录分析或正文检索。',
                  '只要问题包含主题、属性、时间、状态、对象类别等限定条件，就不能使用 total。',
                  '业务类别应优先映射到目录中真实存在的字段过滤；无法映射为字段的主题概念使用 searchTerms。',
                  '“需求”“需求记录”等宽泛记录类型词只表示当前记录集合，不是全文 searchTerms；无其他限定条件的总数必须使用 record_count 全量统计。',
                  '字段目录中的 kind=technical 表示同步或存储技术字段，kind=business 表示用户可理解的业务属性。',
                  '字段目录中的 displayName 是平台字段显示名；理解用户问题时优先匹配 displayName，但查询计划必须输出对应的 field 原始 key。',
                  '字段目录中的 synonyms 是用户人工维护的业务别名，优先级高于模型自行联想；别名命中多个字段时必须 needsClarification=true，禁止任选一个。',
                  '字段目录中的 role 表示 dimension、measure、time 或 identifier；聚合、时间筛选和唯一记录定位必须选择匹配角色的字段。',
                  'declaredType 是平台声明类型，types 是采集值观察类型；选择日期比较、数值比较、枚举分组等操作时优先参考 declaredType，并在二者冲突时采用保守查询。',
                  '当用户表达业务类别、状态、优先级等条件时，必须优先选择语义匹配的 business 字段，不能用 _valm_NodeType 等 technical 字段替代。',
                  'searchTerms 只能使用当前问题或用户历史中明确出现的词或短语；除非用户明确要求同义扩展，否则禁止自行增加近义词、关联词。',
                  '同义词、近义词和主题扩展词之间使用 searchMode=any；只有用户明确要求多个不同概念必须同时满足时才使用 all。',
                  'record_lookup 仅用于用户通过唯一名称、UID 或业务编号定位一条记录并询问其具体属性。',
                  '用户要求列出、查找或查看一组相关记录时使用 filter_records 或 search_content，不能使用 record_lookup。',
                  '询问某个字段有哪些取值、单位、人员、状态或分布时使用 field_aggregate，并把该字段放入 groupByField。',
                  '用户询问的属性必须放入 fields；排名或分布的维度放入 groupByField。',
                  'fields 只能包含用户明确要求查看的属性，不能为了生成回答而把所有原始字段加入 fields。',
                  '所有 filters.field、fields、groupByField、sort.field 必须来自字段目录，禁止发明字段。',
                  '字段目录中的 samples 只用于理解字段含义，绝不能擅自选一个样例值作为 filters.value。',
                  'is_empty 或 not_empty 只能在用户明确询问空值、未填写、缺失或非空数据时使用，且不得携带 value。',
                  'limit 为需要返回给用户核查的记录数，范围 1 到 50；未明确数量的列表/明细优先使用安全上限 50。',
                  'resultMode 可为 answer、list、grouped_list、table 或 dashboard；按多个用户已提及实体分别列出时使用 grouped_list，并填写 groupEntities。',
                  '输出严格 JSON，不要 Markdown。'
                ].join('\n')
              },
              {
                role: 'user',
                content: JSON.stringify({
                  currentQuestion: groundingQuestion,
                  groundingQuestion,
                  conversationContext,
                  availableNodeTypes: nodeTypes,
                  fieldCatalog: catalog
                })
              }
            ],
            think: true,
            format: planFormat,
            temperature: 0,
            numPredict: 1800
          })
          raw = parsePlannerResponse(planResponse)
        } catch (error) {
          plannerRecoveryIssue = error instanceof Error ? error.message : String(error)
          const fallbackTerms = groundedSearchTermsFromQuestion(plannerGroundingText)
          const countRequested = assistantCountQuestionPattern.test(groundingQuestion)
          const listRequested = assistantListQuestionPattern.test(groundingQuestion)
          raw = {
            sourceMode: initialSourceMode,
            needsClarification: false,
            intent: countRequested
              ? fallbackTerms.length ? 'count_matching' : 'total'
              : listRequested ? 'filter_records' : 'search_content',
            resultMode: countRequested ? 'answer' : listRequested ? 'list' : 'answer',
            searchTerms: fallbackTerms,
            groupEntities: providedDecision?.groupEntities ?? [],
            explanation: `规划模型不可用，已使用问题原文中的显式线索生成只读降级计划：${plannerRecoveryIssue}`
          }
        }
      }
    }
    const sourceMode = initialSourceMode
    let intent = intentFromRaw(raw)
    if (sourceMode === 'conversation') intent = 'conversation'
    else if (sourceMode === 'knowledge') intent = 'search_content'
    else if (intent === 'conversation') intent = 'search_content'
    const modelRequestedClarification = raw.needsClarification === true
    // The planner may propose a clarification, but only deterministic checks
    // against the real catalog and grounded user text may stop a read-only run.
    const needsClarification = modelRequestedClarification && assistantUnderspecifiedQuestionPattern.test(
      groundingQuestion.trim()
    )
    const clarificationQuestion = typeof raw.clarificationQuestion === 'string'
      ? raw.clarificationQuestion.trim()
      : ''
    const normalizedGrounding = [
      groundingQuestion,
      ...(request.history ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => message.content)
    ].join('\n').normalize('NFKC').toLocaleLowerCase()
    const groundingContains = (value: unknown): boolean => {
      const candidate = String(value ?? '').normalize('NFKC').trim()
      return Boolean(candidate) && normalizedGrounding.includes(candidate.toLocaleLowerCase())
    }
    const resolveField = (input: unknown): string | undefined => {
      const requested = String(input ?? '').trim()
      if (!requested) return undefined
      const normalized = requested.normalize('NFKC').toLocaleLowerCase()
      const matches = catalog.filter((field) => [
        field.field,
        field.displayName ?? '',
        ...field.synonyms
      ].some((candidate) => candidate.normalize('NFKC').toLocaleLowerCase() === normalized))
      return matches.length === 1 ? matches[0]?.field : undefined
    }
    const hasUnknownField = (input: unknown): boolean => {
      const requested = String(input ?? '').trim()
      return Boolean(requested) && !resolveField(requested)
    }
    const catalogEntryForField = (field: string) => catalog.find((entry) => entry.field === field)
    const hasGroundedFieldReference = (requested: unknown, resolved: string): boolean => {
      const entry = catalogEntryForField(resolved)
      return [
        requested,
        resolved,
        entry?.displayName,
        ...(entry?.synonyms ?? [])
      ].some(groundingContains)
    }
    const hasGroundedEmptyValue = (operator: string): boolean => {
      // Match the longest/negated phrases as one semantic token first. This
      // prevents `为空` from being found inside `不为空` (and `有值` inside
      // `没有值`) before applying the mutually-exclusive check below.
      const semanticMatches = normalizedGrounding.match(
        /(?:不为空|非空|已(?:填写|填|设置)|有(?:值|内容)|不缺失|没有(?:填写|设置|值|内容)|无(?:值|内容)|未(?:填写|填|设置)|为空|空值|缺失|空白)/gu
      ) ?? []
      const hasNonEmptySemantic = semanticMatches.some((term) => (
        term === '不为空' ||
        term === '非空' ||
        term === '已填写' ||
        term === '已填' ||
        term === '已设置' ||
        term === '有值' ||
        term === '有内容' ||
        term === '不缺失'
      ))
      const hasEmptySemantic = semanticMatches.some((term) => (
        term === '为空' ||
        term === '空值' ||
        term === '未填写' ||
        term === '未填' ||
        term === '未设置' ||
        term === '缺失' ||
        term === '没有填写' ||
        term === '没有设置' ||
        term === '没有值' ||
        term === '没有内容' ||
        term === '无值' ||
        term === '无内容' ||
        term === '空白'
      ))
      return operator === 'is_empty'
        ? hasEmptySemantic && !hasNonEmptySemantic
        : hasNonEmptySemantic && !hasEmptySemantic
    }
    const rawFilters = Array.isArray(raw.filters)
      ? raw.filters.filter((input): input is Record<string, unknown> => (
          Boolean(input) && typeof input === 'object' && !Array.isArray(input)
        ))
      : []
    const hasUnknownPlannedField =
      (Array.isArray(raw.fields) && raw.fields.some(hasUnknownField)) ||
      rawFilters.some((filter) => hasUnknownField(filter.field)) ||
      hasUnknownField(raw.groupByField) ||
      (raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort)
        ? hasUnknownField((raw.sort as Record<string, unknown>).field)
        : false)
    const allowedOperators = new Set([
      'equals',
      'not_equals',
      'contains',
      'not_contains',
      'is_empty',
      'not_empty',
      'gt',
      'gte',
      'lt',
      'lte'
    ])
    const filters = rawFilters.length
      ? rawFilters.flatMap((input) => {
          if (!input || typeof input !== 'object' || Array.isArray(input)) return []
          const filter = input as Record<string, unknown>
          const requestedField = String(filter.field ?? '').trim()
          const field = resolveField(filter.field)
          const operator = String(filter.operator ?? '')
          if (!field || !allowedOperators.has(operator) || !hasGroundedFieldReference(requestedField, field)) return []
          const value = filter.value === undefined ? undefined : String(filter.value).trim()
          if (operator === 'is_empty' || operator === 'not_empty') {
            if (!hasGroundedEmptyValue(operator)) return []
          } else if (!value || !groundingContains(value)) {
            return []
          }
          return [{
            field,
            operator: operator as QuestionPlan['filters'][number]['operator'],
            value:
              operator === 'is_empty' || operator === 'not_empty'
                ? undefined
                : value
          }]
        }).slice(0, 10)
      : []
    const fields = Array.isArray(raw.fields)
      ? [...new Set(raw.fields.map(resolveField).filter((field): field is string => Boolean(field)))]
          .slice(0, 20)
      : []
    const groundedTerm = (value: unknown): string | undefined => {
      const term = normalizeSearchCandidate(String(value ?? ''))
      if (!term) return undefined
      const normalizedTerm = term.normalize('NFKC').toLocaleLowerCase()
      return normalizedGrounding.includes(normalizedTerm) ? term : undefined
    }
    const countQuestion = assistantCountQuestionPattern.test(groundingQuestion)
    const groundedQuestionTerms = groundedSearchTermsFromQuestion(plannerGroundingText)
    const searchTerms = [
      ...(countQuestion ? groundedQuestionTerms : []),
      ...(Array.isArray(raw.searchTerms) ? raw.searchTerms : []),
      ...(Array.isArray(raw.groupEntities) ? raw.groupEntities : []),
      ...(providedDecision?.groupEntities ?? []),
      ...(countQuestion ? [] : groundedQuestionTerms)
    ]
      .map(groundedTerm)
      .filter((term, index, values): term is string => Boolean(term) && values.indexOf(term) === index)
      .filter((term) => sourceMode === 'records' || sourceMode === 'mixed'
        ? !(countQuestion
          ? isRecordCountScaffoldingTerm(term)
          : isGenericRecordTypeTerm(term))
        : true)
      .slice(0, 10)
    const requestedNodeType = String(raw.nodeType ?? '').trim()
    const nodeType = nodeTypes.find(
      (value) => value.localeCompare(requestedNodeType, undefined, { sensitivity: 'accent' }) === 0 &&
        groundingContains(value)
    )
    const metricValues = ['record_count', 'image_count', 'count_by_type', 'count_by_project']
    const metric = metricValues.includes(String(raw.metric))
      ? String(raw.metric) as QuestionPlan['metric']
      : undefined
    const sortInput =
      raw.sort && typeof raw.sort === 'object' && !Array.isArray(raw.sort)
        ? raw.sort as Record<string, unknown>
        : null
    const sortField = resolveField(sortInput?.field)
    const resultModeValues: QuestionPlan['resultMode'][] = [
      'answer',
      'list',
      'grouped_list',
      'table',
      'dashboard'
    ]
    const resultMode = resultModeValues.includes(raw.resultMode as QuestionPlan['resultMode'])
      ? raw.resultMode as QuestionPlan['resultMode']
      : (providedDecision && resultModeValues.includes(providedDecision.resultMode as QuestionPlan['resultMode'])
          ? providedDecision.resultMode as QuestionPlan['resultMode']
          : undefined) ?? (
          ['filter_records', 'record_lookup', 'search_content'].includes(intent)
            ? 'list'
            : intent === 'field_aggregate' || intent === 'schema_inspection'
              ? 'table'
              : 'answer'
        )
    const groupEntities = [
      ...(Array.isArray(raw.groupEntities) ? raw.groupEntities : []),
      ...(providedDecision?.groupEntities ?? [])
    ]
      .map(groundedTerm)
      .filter((entity, index, values): entity is string => Boolean(entity) && values.indexOf(entity) === index)
      .filter((entity) => sourceMode === 'records' || sourceMode === 'mixed'
        ? !(countQuestion ? isRecordCountScaffoldingTerm(entity) : isGenericRecordTypeTerm(entity))
        : true)
      .slice(0, 12)
    const rawLimit = Math.min(50, Math.max(1, Math.trunc(Number(raw.limit ?? 30))))
    const hasExplicitListLimit = /(?:前|最多|至多|返回|列出|展示|显示|取|限制)\s*(?:\d{1,3}|[一二三四五六七八九十百千万]+)\s*(?:条|个|项|名|记录)?/u.test(
      groundingQuestion
    )
    const effectiveLimit = ['list', 'grouped_list', 'table'].includes(resultMode) && !hasExplicitListLimit
      ? 50
      : rawLimit
    const plan: QuestionPlan = {
      sourceMode,
      needsClarification,
      ...(clarificationQuestion ? { clarificationQuestion } : {}),
      ...(Number.isFinite(Number(sourceRaw.evidenceLimit))
        ? { evidenceLimit: Math.min(20, Math.max(4, Math.trunc(Number(sourceRaw.evidenceLimit)))) }
        : {}),
      resultMode,
      groupEntities,
      intent,
      explanation: [
        String(raw.explanation ?? '').trim(),
        plannerRecoveryIssue ? `planner recovered: ${plannerRecoveryIssue}` : '',
        modelRequestedClarification ? 'planner clarification proposal deferred to grounded validation' : ''
      ].filter(Boolean).join('; '),
      nodeType,
      searchTerms,
      searchMode: raw.searchMode === 'all' ? 'all' : 'any',
      filters,
      fields,
      groupByField: resolveField(raw.groupByField),
      metric,
      sort: sortField
        ? { field: sortField, direction: sortInput?.direction === 'asc' ? 'asc' : 'desc' }
        : undefined,
      limit: effectiveLimit
    }
    if (
      naturalDeliveryRecordRequest &&
      (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      plan.intent !== 'conversation'
    ) {
      // A composite request such as "整理周顺峰的数据，生成 Excel" first
      // needs a concrete record retrieval.  Do not let a planner fallback to
      // search_content merely because the cleaned query no longer contains a
      // list verb from the delivery clause.
      plan.intent = 'filter_records'
      if (plan.resultMode !== 'grouped_list' && plan.resultMode !== 'table') {
        plan.resultMode = 'list'
      }
      plan.needsClarification = false
      plan.clarificationQuestion = undefined
    }
    const comparativeRecordRequest = (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      plan.groupEntities.length >= 2 &&
      assistantComparativeQuestionPattern.test(groundingQuestion)
    if (comparativeRecordRequest) {
      // A comparison asks for a conclusion over multiple grounded entities;
      // do not let a planner's table/grouped-list proposal change the user
      // visible delivery mode.
      plan.resultMode = 'answer'
      plan.intent = 'count_matching'
      plan.metric = undefined
    }
    if (
      (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      assistantCountQuestionPattern.test(groundingQuestion)
    ) {
      const preservesGroupedOutput = plan.resultMode === 'grouped_list' && plan.groupEntities.length > 0
      const preservesTabularOutput = plan.resultMode === 'table' && Boolean(plan.groupByField)
      if (preservesGroupedOutput) {
        plan.intent = 'filter_records'
        plan.metric = undefined
      } else if (!preservesTabularOutput) {
        plan.resultMode = 'answer'
        plan.intent = plan.searchTerms.length || plan.filters.length ? 'count_matching' : 'total'
        plan.metric = plan.intent === 'total' ? 'record_count' : undefined
      }
    }
    if (
      plan.sourceMode === 'records' &&
      isUnconstrainedRecordCountQuestion(groundingQuestion)
    ) {
      // A broad collection-count question must not inherit model-generated
      // question grammar as a text term or an invented field condition.
      plan.searchTerms = []
      plan.filters = []
      plan.groupEntities = []
      plan.resultMode = 'answer'
      plan.intent = 'total'
      plan.metric = 'record_count'
    }
    const ambiguousSemanticAliases = findAmbiguousSemanticAliases(groundingQuestion, catalog)
    if (ambiguousSemanticAliases.length) {
      const details = ambiguousSemanticAliases
        .map(({ alias, fields }) => `“${alias}”可能对应 ${fields.join('、')}`)
        .join('；')
      plan.needsClarification = true
      plan.clarificationQuestion = `字段语义词典存在歧义：${details}。请明确要使用哪个字段。`
    }
    if (plan.sourceMode !== 'knowledge' && plan.intent === 'total' && (plan.searchTerms.length || plan.filters.length)) {
      plan.intent = 'count_matching'
      plan.metric = undefined
    }
    if (plan.sourceMode !== 'knowledge' && plan.intent === 'total' && !plan.metric) plan.metric = 'record_count'
    if (plan.sourceMode !== 'knowledge' && plan.intent === 'field_aggregate' && !plan.groupByField) {
      plan.needsClarification = true
      plan.clarificationQuestion = '请明确要按哪个数据中心字段分组统计；我只会使用字段目录中存在的字段。'
    }
    if (hasUnknownPlannedField && (plan.sourceMode === 'records' || plan.sourceMode === 'mixed')) {
      plan.explanation = [
        plan.explanation,
        '已忽略规划器生成但无法映射到真实字段目录的字段；继续使用已落地的检索词或筛选条件'
      ].filter(Boolean).join('; ')
    }
    const explicitListRequest = (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      plan.intent !== 'conversation' &&
      assistantListQuestionPattern.test(groundingQuestion) &&
      !assistantCountQuestionPattern.test(groundingQuestion)
    if (explicitListRequest) {
      // A user-visible list verb is a concrete delivery instruction. Keep it
      // deterministic even when the planner responds with answer/table or a
      // stale clarification proposal.
      plan.intent = 'filter_records'
      if (plan.resultMode !== 'grouped_list') plan.resultMode = 'list'
      plan.needsClarification = false
      plan.clarificationQuestion = undefined
      const requestedLimit = explicitListLimitFromQuestion(groundingQuestion)
      if (requestedLimit !== undefined) plan.limit = requestedLimit
      if (assistantRecentListQuestionPattern.test(groundingQuestion) && !plan.sort) {
        // lastModifyTime is the built-in record timestamp, so it remains safe
        // to use even when a small project-specific catalog omits it.
        const recentField = resolveField('lastModifyTime') ?? resolveField('_valm_LastModifyTime') ?? 'lastModifyTime'
        if (recentField) plan.sort = { field: recentField, direction: 'desc' }
      }
    }
    const explicitMixedRecordScope = plan.sourceMode === 'mixed' &&
      plan.intent !== 'conversation' &&
      assistantExplicitRecordSourcePattern.test(groundingQuestion) &&
      !plan.filters.length
    if (explicitMixedRecordScope) {
      // Mixed analysis explicitly names local records even when it has no
      // narrower record keyword. Query the authorized collection so the final
      // answer can distinguish “no record evidence” from an empty result.
      const recordTerms = groundedQuestionTerms
      const hasOnlyGroundedRecordTerms = plan.searchTerms.every((term) => recordTerms.includes(term))
      if (!hasOnlyGroundedRecordTerms) plan.searchTerms = recordTerms
      plan.intent = 'filter_records'
      plan.needsClarification = false
      plan.clarificationQuestion = undefined
      if (plan.limit < 50) plan.limit = 50
    }
    const broadListRequest = plan.intent === 'filter_records' &&
      plan.resultMode === 'list' &&
      !plan.searchTerms.length &&
      !plan.filters.length &&
      assistantListQuestionPattern.test(groundingQuestion)
    const safeMixedRecordScope = explicitMixedRecordScope && plan.intent === 'filter_records'
    if (
      (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      ['count_matching', 'record_lookup', 'filter_records', 'analyze_records', 'search_content']
        .includes(plan.intent) &&
      !plan.searchTerms.length &&
      !plan.filters.length &&
      !broadListRequest &&
      !safeMixedRecordScope
    ) {
      plan.needsClarification = true
      plan.clarificationQuestion = '请补充要查询的记录范围、关键词或字段条件，以便执行可验证的查询。'
    }
    if (
      (plan.sourceMode === 'records' || plan.sourceMode === 'mixed') &&
      plan.resultMode === 'grouped_list' &&
      !plan.groupEntities.length
    ) {
      plan.needsClarification = true
      plan.clarificationQuestion = '请明确要按哪些已提及实体分别列出记录，以便生成分组结果。'
    }
    if (plan.sourceMode === 'mixed' && plan.intent === 'conversation') {
      plan.needsClarification = true
      plan.clarificationQuestion = '请明确需要同时查询哪些数据中心记录和哪些知识库资料。'
    }
    return plan
  }

  private async executePlanAndAnswer(
    request: ChatRequest,
    plan: QuestionPlan
  ): Promise<PlanAnswerExecution> {
    const invokedAgents: AssistantExecutionAgentId[] = []
    try {
    if (plan.intent === 'conversation') {
      invokedAgents.push('conversation')
      this.progress('answer', '正在整理回答')
      const response = await this.callModel({
        messages: [
          {
            role: 'system',
            content: [
              '你是 VISSLM AI 助手，可以进行自然对话、解释概念、提供方法建议，并帮助用户理解如何使用本地数据。',
              '当前请求不需要查询本地数据库，不要虚构记录、数量、字段值或声称已经检索数据。',
              '直接回应用户当前意图，使用自然、清晰的中文。',
              '如果用户只是问候，简短友好地回应，并可概括你能提供的数据查询、分析、总结和可视化能力。'
            ].join('\n')
          },
          ...selectHistoryWithSummary(request.history, 6, 1_200, 1_600).map((message) => ({
            role: message.role as ModelMessage['role'],
            content: message.content
          })),
          { role: 'user' as const, content: request.question }
        ],
        think: finalAnswerThinkingEnabled(request.thinkingMode),
        temperature: 0.3,
        numPredict: 800,
        ...(this.onTextDelta ? { onTextDelta: this.onTextDelta } : {})
      })
      this.activity(workLogForDelivery())
      return {
        response: {
          answer: response.message?.content?.trim() || '你好，我是 VISSLM AI 助手。',
          sources: [],
          dataViews: []
        },
        invokedAgents
      }
    }

    let recordExecution: RecordPlanExecution | undefined
    const selectedProjectId = plan.scope?.projectIds === undefined
      ? request.projectId
      : plan.scope.projectIds.length === 1
        ? plan.scope.projectIds[0]
        : undefined
    if (plan.sourceMode !== 'knowledge') {
      invokedAgents.push('data-center')
      recordExecution = this.dataCenterAgent.executePlan(selectedProjectId, plan)
      if (
        plan.sourceMode === 'records' &&
        recordExecution.toolName === 'query_records_by_fields' &&
        matchedRecordCount(recordExecution.result) === 0
      ) {
        const correctedSearchTerms = zeroHitSearchCorrectionFor(request, plan)
        if (correctedSearchTerms) {
          const originalSearchTerms = [...plan.searchTerms]
          const retryPlan: QuestionPlan = {
            ...plan,
            searchTerms: correctedSearchTerms
          }
          recordExecution = this.dataCenterAgent.executePlan(selectedProjectId, retryPlan)
          // Keep the in-memory plan authoritative for rendering, the data
          // view, and the execution summary.  No scope/filters/fields are
          // changed by this one bounded retry.
          plan.searchTerms = correctedSearchTerms
          plan.explanation = [
            plan.explanation,
            `首次查询零命中，已将检索词从“${originalSearchTerms.join('、')}”安全清理为“${correctedSearchTerms.join('、')}”后重试`
          ].filter(Boolean).join('; ')
        }
      }
    }
    let knowledgeExecution: KnowledgePlanExecution | undefined
    if (plan.sourceMode !== 'records') {
      invokedAgents.push('knowledge-base')
      const knowledgeQuestion = plan.sourceMode === 'knowledge' && plan.evidenceLimit !== undefined && plan.searchTerms.length
        ? plan.searchTerms.join(' ')
        : request.question
      const knowledgeLimit = Math.min(20, Math.max(1, Math.trunc(plan.evidenceLimit ?? 8)))
      knowledgeExecution = await this.knowledgeBaseAgent.search(
        knowledgeQuestion,
        knowledgeLimit
      )
    }
    const sources = new Map<string, ChatSource>()
    if (recordExecution) this.collectSources(recordExecution.result, sources)
    for (const hit of knowledgeExecution?.hits ?? []) {
      this.collectSources({ source: this.knowledgeSourceForHit(hit) }, sources)
    }
    const hasRecordEvidence = recordExecution
      ? this.dataCenterAgent.hasEvidence(recordExecution.toolName, recordExecution.result)
      : false
    const hasKnowledgeEvidence = Boolean(knowledgeExecution?.hits.length)
    const dataView = recordExecution
      ? this.dataCenterAgent.createDataView(
          recordExecution.toolName,
          recordExecution.args,
          recordExecution.result,
          selectedProjectId
        )
      : null

    this.activity(workLogForEvidence(
      recordExecution ? matchedRecordCount(recordExecution.result) : 0,
      knowledgeExecution?.hits.length ?? 0
    ))

    // Never ask the model to fill an empty source with a plausible answer.
    if (
      (plan.sourceMode === 'records' && !hasRecordEvidence) ||
      (plan.sourceMode === 'knowledge' && !hasKnowledgeEvidence) ||
      (plan.sourceMode === 'mixed' && !hasRecordEvidence && !hasKnowledgeEvidence)
    ) {
      return {
        response: {
          answer: this.renderMissingEvidenceAnswer(plan, recordExecution?.result, knowledgeExecution?.missingReason),
          sources: [],
          dataViews: dataView ? [dataView] : []
        },
        invokedAgents
      }
    }

    // Count/list/lookup record answers are already rendered from the trusted
    // query result. Do not spend another model round on a deterministic answer
    // path: besides adding latency, an empty reasoning response could turn a
    // successful local query into AGENT_REQUEST_FAILED. Analysis and all
    // knowledge/mixed paths still use the final model below.
    const deterministicRecordAnswer = plan.sourceMode === 'records' && recordExecution
      ? this.dataCenterAgent.renderVerifiedAnswer(plan, recordExecution.result, '')
      : ''
    if (deterministicRecordAnswer.trim()) {
      this.progress('verify', '正在核对查询结果与问题口径')
      const answer = this.ensureVerifiableCitations(deterministicRecordAnswer, [...sources.values()])
      this.activity(workLogForVerification())
      this.activity(workLogForDelivery())
      return {
        response: {
          answer,
          sources: [...sources.values()],
          dataViews: dataView ? [dataView] : []
        },
        invokedAgents
      }
    }

    this.progress('verify', '正在核对查询结果与问题口径')
    const missingSources = plan.sourceMode === 'mixed'
      ? [
          !hasRecordEvidence ? '数据中心记录' : '',
          !hasKnowledgeEvidence ? '知识库文档' : ''
        ].filter(Boolean)
      : []
    const queryResult = recordExecution
      ? this.compactModelResult(recordExecution.result)
      : undefined
    const knowledgeEvidence = knowledgeExecution?.hits.map((hit) => {
      const source = this.knowledgeSourceForHit(hit)
      const citation = knowledgeCitationMarkdown(source)
      return {
        // Do not send uid/itemId/documentId/chunkId as model-visible fields.
        // The complete local citation is enough for the model to reproduce a
        // safe link, while the final validator still checks it against the
        // trusted source collection.
        source: {
          sourceType: 'document' as const,
          name: citationLabelPart(source.fileName || source.name, '知识库文档'),
          ...(source.fileName ? { fileName: citationLabelPart(source.fileName, '') } : {}),
          ...(source.location ? { location: citationLabelPart(source.location, '') } : {})
        },
        ...(citation ? { citation } : {}),
        content: sanitizeContextText(hit.chunk.content, 1_800)
      }
    })
    const response = await this.callModel({
      messages: [
        {
          role: 'system',
          content: [
            '你是 VISSLM 数据回答器。只能使用本轮统一计划和提供的有界证据回答，禁止补充未查询的数据。',
            '先核对问题、计划和证据来源是否一致，再给出结论。',
            '记录统计必须使用 matchedCount 或工具返回的明确计数，不能使用 totalScanned 代替命中数；禁止估算。',
            '记录证据的 sourceType=record，知识库文档证据的 sourceType=document；两者不能互换。',
            '引用记录时才可使用证据中的 source.uid 写成 [UID:实际UID]，且只能使用已提供的记录 UID。',
            '需要把引用贴近具体结论时，可使用 evidence 中提供的完整 Markdown citation（文档名/文件名 + location 链接）；禁止输出 UID、documentId、chunkId、序号或其他内部标识。',
            '不要单独输出“来源”或“依据”清单，应用会在回答下方统一展示可核验的回答依据。',
            '如果 mixed 计划中有来源缺失，明确指出缺失来源，并只回答现有来源能支持的部分。',
            '如果结果为空，明确说明本轮查询条件下未命中，不得编造。',
            '列表类问题只概述命中数量并列出记录名称，不要输出 HTML、JSON、流程日志或内部索引。',
            '分析类问题应先给出结论，再说明由哪些查询结果支持；区分事实、归纳和建议。',
            '回答使用中文，结论优先，简洁但信息完整。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: request.question,
            queryPlan: plan,
            ...(queryResult === undefined ? {} : { queryResult }),
            ...(knowledgeEvidence?.length ? { knowledgeEvidence } : {}),
            ...(missingSources.length ? { missingSources } : {})
          })
        }
      ],
      think: finalAnswerThinkingEnabled(request.thinkingMode),
      temperature: 0.1,
      numPredict: 1400
    })
    const modelAnswer = response.message?.content?.trim() || '模型没有生成可验证的回答。'
    let answer = plan.sourceMode === 'records' && recordExecution
      ? this.dataCenterAgent.renderVerifiedAnswer(plan, recordExecution.result, modelAnswer)
      : this.ensureVerifiableCitations(modelAnswer, [...sources.values()])
    if (missingSources.length) {
      answer = `${answer.trim()}\n\n未获得${missingSources.join('、')}证据，本次回答仅基于已返回来源。`
    }
    answer = this.ensureVerifiableCitations(answer, [...sources.values()])
    this.activity(workLogForVerification())
    this.activity(workLogForDelivery())
    return {
      response: {
        answer,
        sources: [...sources.values()],
        dataViews: dataView ? [dataView] : []
      },
      invokedAgents
    }
    } catch (error) {
      const failure = error instanceof Error
        ? error as AssistantExecutionFailure
        : new Error(String(error)) as AssistantExecutionFailure
      failure.invokedAgents = [...invokedAgents]
      failure.traceContext = this.traceContextForPlan(plan)
      throw failure
    }
  }

  private renderMissingEvidenceAnswer(
    plan: QuestionPlan,
    result: unknown,
    missingReason?: string
  ): string {
    const deterministic = result === undefined
      ? ''
      : this.dataCenterAgent.renderVerifiedAnswer(plan, result, '')
    if (deterministic.trim()) return deterministic
    if (plan.sourceMode === 'knowledge') {
      return `${missingReason || '知识库中没有可核验的文档证据'}，本次未生成猜测性回答。`
    }
    if (plan.sourceMode === 'mixed') {
      return '数据中心和知识库都没有返回可核验证据，本次未生成猜测性回答。'
    }
    return '数据中心没有返回可核验证据，本次未生成猜测性回答。'
  }

  private compactModelResult(result: unknown): unknown {
    const withoutUidIndex = removeRecordUidIndex(result)
    const compacted = compactContextValue(withoutUidIndex, {
      maxStringChars: MODEL_TOOL_FIELD_LIMIT,
      maxArrayItems: 50,
      maxObjectEntries: 80,
      maxDepth: 5
    })
    try {
      return JSON.parse(compactEvidenceJson(compacted, 24_000)) as unknown
    } catch {
      return { evidence: '查询结果因上下文预算已省略' }
    }
  }

  private ensureVerifiableCitations(answer: string, sources: ChatSource[]): string {
    const boundedSources = sources
      .filter((source) => typeof source.uid === 'string' && source.uid.trim())
      .slice(0, 20)
    const documentSources = boundedSources.filter((source) => source.sourceType === 'document')
    const citationsByHref = new Map<string, { source: ChatSource; markdown: string }>()
    for (const source of documentSources) {
      const href = knowledgeCitationHref(source)
      const markdown = knowledgeCitationMarkdown(source)
      if (href && markdown) citationsByHref.set(href, { source, markdown })
    }
    const documentIdentityCandidates = new Map<string, ChatSource[]>()
    for (const source of documentSources) {
      // Keep each document chunk distinct.  A document UID alone is not a
      // safe citation key because several chunks intentionally share it.
      for (const identity of [source.uid, source.itemId, source.documentId, source.chunkId]) {
        const normalizedIdentity = safeCitationIdentifier(identity)
        if (!normalizedIdentity) continue
        const candidates = documentIdentityCandidates.get(normalizedIdentity) ?? []
        if (!candidates.includes(source)) candidates.push(source)
        documentIdentityCandidates.set(normalizedIdentity, candidates)
      }
    }
    const sourceByDocumentIdentity = new Map<string, ChatSource>()
    for (const [identity, candidates] of documentIdentityCandidates) {
      // Only an identity that resolves to exactly one chunk may be used to
      // upgrade a legacy [UID:...] token.  Ambiguous document-level IDs are
      // removed and replaced by the complete, chunk-specific references.
      if (candidates.length === 1 && candidates[0]) {
        sourceByDocumentIdentity.set(identity, candidates[0])
      }
    }
    const validRecordUids = new Set(
      boundedSources
        .filter((source) => source.sourceType !== 'document')
        .map((source) => source.uid.trim())
        .filter(Boolean)
    )
    let normalized = String(answer ?? '')
    const protectedDocumentCitations: Array<{ token: string; markdown: string }> = []
    const protectDocumentCitation = (markdown: string): string => {
      const token = `\uE000VISSLM_DOCUMENT_CITATION_${protectedDocumentCitations.length}\uE001`
      protectedDocumentCitations.push({ token, markdown })
      return token
    }

    // Canonical citations can pass through this validator more than once.
    // Protect trusted links before opaque-ID stripping so validation remains
    // idempotent even when a document UID appears inside its local href.
    normalized = normalized.replace(/\[([^\]]*)\]\((#[^)]+)\)/gu, (full, _label: string, href: string) => {
      if (!href.startsWith(knowledgeCitationFragmentPrefix)) return full
      const markdown = citationsByHref.get(href)?.markdown
      return markdown ? protectDocumentCitation(markdown) : ''
    })

    // Convert legacy document citations before validating Markdown links.  A
    // source identity is accepted only when it maps to the exact trusted
    // document/chunk source; otherwise the legacy token is removed. Protect
    // the generated Markdown while stripping opaque IDs below because a
    // document UID may also be a substring of its trusted local href.
    normalized = normalized.replace(/\[UID:([^\]]+)\]/gu, (full, rawUid: string) => {
      const uid = rawUid.trim()
      const documentSource = sourceByDocumentIdentity.get(uid)
      const markdown = documentSource ? knowledgeCitationMarkdown(documentSource) : undefined
      if (markdown) return protectDocumentCitation(markdown)
      if (!validRecordUids.has(uid)) return ''
      return `[UID:${uid}]`
    })

    // A model may echo a document UID outside the legacy citation wrapper.
    // Remove the exact opaque token before links are canonicalized; generated
    // local fragments do not contain the `document:<uid>` token, so this does
    // not alter the safe href we add below.
    for (const source of documentSources) {
      const uid = source.uid.trim()
      if (uid) normalized = normalized.replaceAll(uid, '')
    }
    for (const citation of protectedDocumentCitations) {
      normalized = normalized.replaceAll(citation.token, citation.markdown)
    }

    // Canonicalize known local citation links (including labels supplied by a
    // model) and drop unknown local fragments.  This keeps the renderer's
    // interception surface closed to the current trusted evidence set.
    normalized = normalized.replace(/\[([^\]]*)\]\((#[^)]+)\)/gu, (full, _label: string, href: string) => {
      if (!href.startsWith(knowledgeCitationFragmentPrefix)) return full
      return citationsByHref.get(href)?.markdown ?? ''
    })

    // Some models still emit a numbered citation even after being instructed
    // to copy the complete citation.  Resolve it only against the bounded,
    // ordered document evidence; an unknown number is left as ordinary text
    // rather than being allowed to select an arbitrary source.
    normalized = normalized.replace(/\[(\d{1,2})\]/gu, (full, rawIndex: string) => {
      const source = documentSources[Number(rawIndex) - 1]
      return source ? knowledgeCitationMarkdown(source) ?? '' : full
    }).trim()

    const usedHrefs = new Set<string>()
    for (const match of normalized.matchAll(/\]\((#[^)]+)\)/gu)) {
      const href = match[1]
      if (href?.startsWith(knowledgeCitationFragmentPrefix)) usedHrefs.add(href)
    }
    const usedRecordUids = new Set<string>()
    for (const match of normalized.matchAll(/\[UID:([^\]]+)\]/gu)) {
      if (match[1]) usedRecordUids.add(match[1].trim())
    }
    const references = boundedSources
      .filter((source) => {
        if (source.sourceType === 'document') {
          const href = knowledgeCitationHref(source)
          return Boolean(href && !usedHrefs.has(href))
        }
        return !usedRecordUids.has(source.uid.trim())
      })
      .map((source) => source.sourceType === 'document'
        ? knowledgeCitationMarkdown(source)
        : `[UID:${source.uid.trim()}]`)
      .filter((reference): reference is string => Boolean(reference))
      .slice(0, 8)
    normalized = stripRedundantAssistantCitationSections(normalized, boundedSources.length > 0)

    const hasSafeCitation = usedHrefs.size > 0 || usedRecordUids.size > 0 || references.length > 0
    // Evidence without a usable citation must not be presented as a verified
    // answer.  This also prevents malformed legacy document sources (missing
    // documentId/chunkId/location) from falling through with model prose.
    if (normalized && (!boundedSources.length || hasSafeCitation)) return normalized
    const fallbackReferences = boundedSources
      .slice(0, 8)
      .map((source) => source.sourceType === 'document'
        ? knowledgeCitationMarkdown(source)
        : `[UID:${source.uid.trim()}]`)
      .filter((reference): reference is string => Boolean(reference))
    return fallbackReferences.length
      ? '已找到可核验来源，请展开回答下方的“回答依据”查看。'
      : boundedSources.length
        ? '本次回答没有可核验的安全来源引用，未生成猜测性回答。'
        : '模型没有生成可验证的回答。'
  }

  private async callModel(input: {
    messages: ModelMessage[]
    think: boolean
    format?: 'json' | Record<string, unknown>
    temperature: number
    numPredict: number
    onTextDelta?: (content: string) => void
  }): Promise<ModelResponse> {
    return new ModelClient(this.settings).chat({
      ...input,
      ...(input.onTextDelta ? { stream: true } : {}),
      forceThinking: input.think
    })
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
        if (source.uid) sources.set(sourceIdentity(source), source)
      }
      Object.values(obj).forEach(visit)
    }
    visit(input)
  }

  private knowledgeSourceForHit(
    hit: KnowledgePlanExecution['hits'][number]
  ): ChatSource {
    const source = hit.source
    if (source.sourceType !== 'document') return source
    // Older adapters populated chunk metadata but returned a source object
    // without documentId/chunkId.  Merge the trusted chunk identity before
    // collecting or citing it; never collapse chunks by document UID.
    return {
      ...source,
      documentId: source.documentId ?? hit.chunk.documentId,
      chunkId: source.chunkId ?? hit.chunk.id,
      fileName: source.fileName ?? hit.chunk.sourceName,
      location: source.location ?? hit.chunk.location,
      pageNumber: source.pageNumber ?? hit.chunk.pageNumber,
      sheetName: source.sheetName ?? hit.chunk.sheetName,
      snippet: source.snippet ?? hit.chunk.content.slice(0, 320)
    }
  }
}
