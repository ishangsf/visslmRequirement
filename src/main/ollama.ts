import type {
  ChatDataRow,
  ChatDataView,
  ChatRequest,
  ChatResponse,
  ChatSource,
  ConnectionResult,
  ModelSettings
} from '../shared/types'
import { AppDatabase } from './database'
import { ModelClient } from './model-client'
import type { ModelMessage, ModelResponse } from './model-client'
import type { KnowledgeRecordMatch, KnowledgeSearchHit } from './knowledge'
import { KnowledgeService } from './knowledge'
import type { AgentEvent } from '../shared/expert-types'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

interface RecordSimilarityRequest {
  itemId?: string
  limit: number
}

interface RecordSimilarityCandidate {
  match: KnowledgeRecordMatch
  record: NonNullable<ReturnType<AppDatabase['getRecord']>>
}

type RecordSimilarityVerdict = 'high' | 'medium' | 'low' | 'none'

interface RecordSimilarityReviewItem {
  recordUid: string
  score: number
  verdict: RecordSimilarityVerdict
  sharedEvidence: string
  difference: string
}

interface RecordSimilarityReview {
  summary: string
  items: RecordSimilarityReviewItem[]
}

type RelatedDataRelation = 'direct' | 'indirect' | 'none'

interface RelatedDataRequest {
  topic: string
  limit: number
}

interface RelatedDataReviewItem {
  sourceIndex: number
  relation: RelatedDataRelation
  claim: string
  evidence: string
}

interface RelatedDataReview {
  summary: string
  items: RelatedDataReviewItem[]
}

interface ValidatedRelatedDataItem extends RelatedDataReviewItem {
  hit: KnowledgeSearchHit
}

const RECORD_SIMILARITY_MIN_SCORE = 40
const RECORD_SIMILARITY_AI_MIN_SCORE = 50
const RECORD_SIMILARITY_DEFAULT_LIMIT = 10
const RECORD_SIMILARITY_MAX_LIMIT = 20
const RELATED_DATA_DEFAULT_LIMIT = 20
const RELATED_DATA_MAX_LIMIT = 20
const RELATED_DATA_SEARCH_LIMIT = 12

const relatedDataReviewFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: RELATED_DATA_SEARCH_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceIndex', 'relation', 'claim', 'evidence'],
        properties: {
          sourceIndex: { type: 'integer', minimum: 1, maximum: RELATED_DATA_SEARCH_LIMIT },
          relation: { type: 'string', enum: ['direct', 'indirect', 'none'] },
          claim: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    }
  }
}

const recordSimilarityReviewFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      maxItems: RECORD_SIMILARITY_MAX_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordUid', 'score', 'sharedEvidence', 'difference'],
        properties: {
          recordUid: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 100 },
          sharedEvidence: { type: 'string' },
          difference: { type: 'string' }
        }
      }
    }
  }
}

type QuestionPlanIntent =
  | 'conversation'
  | 'schema_inspection'
  | 'total'
  | 'field_aggregate'
  | 'count_matching'
  | 'record_lookup'
  | 'filter_records'
  | 'analyze_records'
  | 'search_content'

interface QuestionPlan {
  intent: QuestionPlanIntent
  explanation: string
  nodeType?: string
  searchTerms: string[]
  searchMode: 'any' | 'all'
  filters: Array<{
    field: string
    operator:
      | 'equals'
      | 'not_equals'
      | 'contains'
      | 'not_contains'
      | 'is_empty'
      | 'not_empty'
      | 'gt'
      | 'gte'
      | 'lt'
      | 'lte'
    value?: string
  }>
  fields: string[]
  groupByField?: string
  metric?: 'record_count' | 'image_count' | 'count_by_type' | 'count_by_project'
  sort?: { field: string; direction: 'asc' | 'desc' }
  limit: number
}

interface MutableJsonSchema {
  [key: string]: unknown
  enum?: string[]
  items?: MutableJsonSchema
  properties?: Record<string, MutableJsonSchema>
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'search_records',
      description: '按名称、编号或正文关键词查找具体记录，适合定位某条记录；不用于全量字段统计',
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
      name: 'inspect_fields',
      description: '只用于发现真实字段、嵌套路径、类型、覆盖率和样例，不能回答某条记录的属性值。确认字段后必须继续调用 query_records_by_fields',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: '可选的项目 UID' },
          node_type: { type: 'string', description: '可选的记录类型，例如 TSIssue' },
          search: { type: 'string', description: '可选的字段名关键词，例如 Source、状态、User' },
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'query_records_by_fields',
      description: '按任意原始业务字段过滤、比较、排序并返回指定属性。已知记录名称时放入 search，所问属性必须放入 fields；适合回答“某条记录的属性是什么”“哪些记录满足条件”“最近/最大/最小”等问题',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: '可选的项目 UID' },
          node_type: { type: 'string', description: '可选的记录类型' },
          search: { type: 'string', description: '可选的名称、编号或正文关键词' },
          filters: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                field: { type: 'string', description: '原始字段名或嵌套路径' },
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
              },
              required: ['field', 'operator']
            }
          },
          fields: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string' },
            description: '需要返回的属性字段或嵌套路径'
          },
          sort: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] }
            },
            required: ['field', 'direction']
          },
          limit: { type: 'integer', minimum: 1, maximum: 50 }
        }
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
      description: '只统计记录总数、图片数、记录类型数量或项目数量；不能用于 Source、状态、负责人等原始业务字段',
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
  },
  {
    type: 'function',
    function: {
      name: 'aggregate_by_field',
      description: '按原始 JSON 中的任意业务字段全量分组统计并返回 Top N。适用于 Source、状态、负责人、版本等字段的排名、分布和最多/最少问题',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description: '要统计的原始字段名或点分隔字段路径，例如 Source、StateName'
          },
          project_id: { type: 'string', description: '可选的项目 UID' },
          node_type: { type: 'string', description: '可选的记录类型，例如 TSIssue' },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            description: '返回排名数量，例如前三名传 3'
          },
          split_multi_value: {
            type: 'boolean',
            description: '是否按中英文逗号、分号、顿号、竖线和换行拆分多值字段，默认 true'
          }
        },
        required: ['field']
      }
    }
  }
]

const questionPlanFormat = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'explanation',
    'searchTerms',
    'searchMode',
    'filters',
    'fields',
    'limit'
  ],
  properties: {
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

export class OllamaAgent {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: ModelSettings,
    private readonly knowledge?: KnowledgeService,
    private readonly onProgress?: (event: AgentStatusEvent) => void
  ) {}

  async test(probeChat = false): Promise<ConnectionResult> {
    return new ModelClient(this.settings).test(probeChat)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    this.progress('route', '正在判断问题类型')
    const similarityRequest = this.parseRecordSimilarityRequest(request.question)
    if (similarityRequest) {
      return this.answerRecordSimilarity(request, similarityRequest)
    }
    const relatedDataRequest = this.parseRelatedDataRequest(request.question)
    if (relatedDataRequest) {
      return this.answerRelatedData(request, relatedDataRequest)
    }
    if (this.knowledge && !this.isStructuredDataQuestion(request.question)) {
      this.progress('retrieve', '正在检索本地知识库')
      const response = await this.askWithKnowledge(request)
      if (response) {
        this.progress('answer', '正在整理可核验的回答')
        return response
      }
    }
    this.progress('plan', '正在读取字段目录并生成查询计划')
    let plan: QuestionPlan | undefined
    let planningError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        plan = await this.planQuestion(request)
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
      throw new Error(
        `无法形成可验证的数据查询计划，本次未生成猜测性回答。${message ? ` 原因：${message}` : ''}`
      )
    }
    if (process.env.VISSLM_AGENT_DEBUG === '1') {
      console.info('[Agent] 结构化计划：', JSON.stringify(plan))
    }
    try {
      this.progress('query', '正在执行本地查询并获取证据')
      return await this.executePlanAndAnswer(request, plan)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `查询计划执行或结果校验失败，本次未生成猜测性回答。${message ? ` 原因：${message}` : ''}`
      )
    }
  }

  private progress(stage: string, message: string): void {
    this.onProgress?.({ type: 'status', stage, message })
  }

  private isStructuredDataQuestion(question: string): boolean {
    return Boolean(this.parseRecordSimilarityRequest(question)) ||
      Boolean(this.parseRelatedDataRequest(question)) ||
      /总数|数量|多少|统计|排名|分布|前\s*\d+|大于|小于|不小于|不大于|等于|筛选|排序|字段|可视化/.test(question)
  }

  private parseRelatedDataRequest(question: string): RelatedDataRequest | null {
    const normalized = question.trim()
    const asksForList = /(?:哪些|什么|列出|清单|明细|包括|包含)/.test(normalized)
    const usesExplicitRelation = /(?:与|和|跟|关于|围绕|涉及).*(?:相关|有关|关联)/.test(normalized)
    if (!normalized || (!asksForList && !usesExplicitRelation)) {
      return null
    }

    const kind = '(?:数据|记录|内容|资料|条目|文档|信息)'
    const topicPart = '[^?？。；;，,\\n]{1,80}?'
    const matches = [
      normalized.match(new RegExp('(?:与|和|跟|同)\\s*(' + topicPart + ')\\s*(?:相关|有关|关联)(?:的)?\\s*' + kind)),
      normalized.match(new RegExp('(?:关于|围绕|涉及)\\s*(' + topicPart + ')\\s*(?:相关|有关|关联)?(?:的)?\\s*' + kind)),
      normalized.match(new RegExp('(' + topicPart + ')\\s*(?:相关|有关|关联)(?:的)?\\s*' + kind)),
      normalized.match(new RegExp(kind + '\\s*(?:与|和|跟)\\s*(' + topicPart + ')\\s*(?:相关|有关|关联)'))
    ]
    const rawTopic = matches.find((match) => match?.[1])?.[1]
    const topic = rawTopic
      ?.replace(/^[\s:：，,、"'“”‘’]+|[\s:：，,、?？。；;！!]+$/g, '')
      .replace(/^(?:哪些|什么|关于|与|和|跟)\s*/, '')
      .trim()
    if (!topic || topic.length < 2 || /^(?:数据|记录|内容|资料|条目|文档|信息|相关|有关|关联)$/.test(topic)) {
      return null
    }

    const requestedLimit = Number(
      normalized.match(/(?:前|最多|返回|列出)\s*(\d+)\s*(?:条|个|项)?/)?.[1] ??
      RELATED_DATA_DEFAULT_LIMIT
    )
    return {
      topic,
      limit: Math.min(
        RELATED_DATA_MAX_LIMIT,
        Math.max(1, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : RELATED_DATA_DEFAULT_LIMIT)
      )
    }
  }

  private parseRecordSimilarityRequest(question: string): RecordSimilarityRequest | null {
    const normalized = question.trim()
    const hasSimilarityCue = /相似|类似|差不多|近似|同类|雷同/.test(normalized)
    const hasRecordCue = /需求|条目|记录|数据|编号|工单|问题单|\bID\b/i.test(normalized)
    if (!hasSimilarityCue || !hasRecordCue) return null

    const labeledItemId = normalized.match(
      /(?:编号|\bID\b)\s*(?:为|是|[:：#])?\s*([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)/i
    )?.[1]
    const itemId = labeledItemId ?? normalized.match(
      /([A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)/
    )?.[1]
    const requestedLimit = Number(
      normalized.match(/(?:前|最多|返回|列出)?\s*(\d+)\s*(?:条|个)/)?.[1] ??
      RECORD_SIMILARITY_DEFAULT_LIMIT
    )
    return {
      ...(itemId ? { itemId } : {}),
      limit: Math.min(
        RECORD_SIMILARITY_MAX_LIMIT,
        Math.max(1, Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : RECORD_SIMILARITY_DEFAULT_LIMIT)
      )
    }
  }

  private async answerRelatedData(
    request: ChatRequest,
    relatedDataRequest: RelatedDataRequest
  ): Promise<ChatResponse> {
    const knowledge = this.knowledge
    if (!knowledge) {
      return {
        answer: '当前未启用可核验的本地知识库索引，无法准确列出与“' + relatedDataRequest.topic + '”相关的数据。本次不会根据模型记忆或语义猜测作答。',
        sources: [],
        dataViews: []
      }
    }

    this.progress('retrieve', '正在围绕主题“' + relatedDataRequest.topic + '”检索知识库')
    const hits = this.dedupeRelatedDataHits(
      await knowledge.search(relatedDataRequest.topic, RELATED_DATA_SEARCH_LIMIT)
    )
    if (!hits.length) {
      return {
        answer: '没有从本地知识库检索到与“' + relatedDataRequest.topic + '”相匹配的证据，因此本次不生成猜测性相关数据清单。',
        sources: [],
        dataViews: []
      }
    }

    let review: RelatedDataReview
    try {
      this.progress('reason', '大模型正在深度判断每条证据与主题的关系')
      const draft = await this.reviewRelatedData(request.question, relatedDataRequest.topic, hits)
      this.progress('critique', '独立复核模型正在检查直接关系、间接关系和原文证据')
      review = await this.reviewRelatedData(request.question, relatedDataRequest.topic, hits, draft)
    } catch {
      return {
        answer: [
          '已检索到 ' + hits.length + ' 条候选证据，但大模型没有返回可通过校验的结构化关系判断。',
          '出于准确性要求，本次不把候选内容直接当作与“' + relatedDataRequest.topic + '”相关的数据，请重试。'
        ].join('\n\n'),
        sources: [],
        dataViews: []
      }
    }

    const hitByIndex = new Map(hits.map((hit, index) => [index + 1, hit]))
    const validated = review.items.flatMap((item): ValidatedRelatedDataItem[] => {
      const hit = hitByIndex.get(item.sourceIndex)
      if (!hit || item.relation === 'none' || !this.isKnowledgeEvidenceSupported(item.evidence, hit)) {
        return []
      }
      return [{ ...item, hit }]
    })
    const direct = validated
      .filter((item) =>
        item.relation === 'direct' &&
        this.hasExplicitRelatedTopicEvidence(relatedDataRequest.topic, item.evidence)
      )
      .slice(0, relatedDataRequest.limit)
    const indirect = validated
      .filter((item) => item.relation === 'indirect')
      .slice(0, relatedDataRequest.limit)

    const displayItems = [...direct, ...indirect]
    const sources = [...new Map(
      displayItems.map((item) => [item.hit.source.uid, item.hit.source])
    ).values()]
    const dataViews = displayItems.length
      ? [this.createRelatedDataView(relatedDataRequest.topic, direct, indirect)]
      : []

    if (!direct.length) {
      const answer = [
        '没有找到能够从现有证据中确认与“' + relatedDataRequest.topic + '”直接相关的数据。',
        indirect.length
          ? [
              '以下候选最多只能判为可能间接相关，不计入直接结果：',
              ...indirect.flatMap((item) => [
                '- **' + item.hit.source.name + '** [' + item.sourceIndex + ']',
                '  证据：' + item.evidence
              ]),
              '',
              '这些内容没有在证据中明确证明与主题直接相关，请不要将其当作“' + relatedDataRequest.topic + '”本身的数据。'
            ].join('\n')
          : '其余候选未通过主题明确命中、原文证据或独立复核，因此没有列入结果。',
        '判定口径：只有证据原文明确出现主题词或可核验的核心词，并经两次结构化判断后，才会列入直接相关数据。'
      ].join('\n\n')
      return { answer, sources, dataViews }
    }

    const answer = [
      '与“' + relatedDataRequest.topic + '”直接相关的数据（' + direct.length + ' 条）：',
      ...direct.flatMap((item, index) => [
        (index + 1) + '. **' + item.hit.source.name + '** [' + item.sourceIndex + ']',
        '   证据：' + item.evidence
      ]),
      indirect.length
        ? [
            '',
            '可能间接相关的候选（不计入上面的直接结果）：',
            ...indirect.flatMap((item) => [
              '- **' + item.hit.source.name + '** [' + item.sourceIndex + ']',
              '  证据：' + item.evidence
            ])
          ].join('\n')
        : '',
      '判定口径：直接相关必须同时满足主题明确命中、证据原文可定位和大模型独立复核通过；仅有向量相似或业务上的可能关联不会并入直接结果。'
    ].filter(Boolean).join('\n\n')
    return { answer, sources, dataViews }
  }

  private dedupeRelatedDataHits(hits: KnowledgeSearchHit[]): KnowledgeSearchHit[] {
    const bestBySource = new Map<string, KnowledgeSearchHit>()
    for (const hit of hits) {
      const key = hit.source.uid || hit.chunk.id
      const existing = bestBySource.get(key)
      if (!existing || hit.score > existing.score) bestBySource.set(key, hit)
    }
    return [...bestBySource.values()]
      .sort((left, right) => right.score - left.score || left.source.uid.localeCompare(right.source.uid))
      .slice(0, RELATED_DATA_SEARCH_LIMIT)
  }

  private createRelatedDataView(
    topic: string,
    direct: ValidatedRelatedDataItem[],
    indirect: ValidatedRelatedDataItem[]
  ): ChatDataView {
    const toRows = (items: ValidatedRelatedDataItem[], relation: string): ChatDataRow[] =>
      items.map((item) => ({
        uid: item.hit.source.uid,
        name: item.hit.source.name,
        nodeType: item.hit.source.nodeType,
        itemId: item.hit.source.itemId,
        values: {
          relation,
          evidence: item.evidence
        }
      }))
    const groups: ChatDataView['groups'] = []
    if (direct.length) groups.push({ name: '直接相关', count: direct.length, rows: toRows(direct, '直接相关') })
    if (indirect.length) groups.push({ name: '可能间接相关', count: indirect.length, rows: toRows(indirect, '可能间接相关') })
    return {
      id: 'related-data:' + topic,
      title: '与“' + topic + '”相关的数据',
      description: '结果经过主题明确命中、原文证据校验和两次大模型关系复核；间接候选不会并入直接结果。',
      total: direct.length + indirect.length,
      fields: ['relation', 'evidence'],
      fieldLabels: {
        relation: '关系',
        evidence: '原文证据'
      },
      groups
    }
  }

  private async reviewRelatedData(
    question: string,
    topic: string,
    hits: KnowledgeSearchHit[],
    draft?: RelatedDataReview
  ): Promise<RelatedDataReview> {
    const evidence = {
      question,
      topic,
      sources: hits.map((hit, index) => ({
        sourceIndex: index + 1,
        uid: hit.source.uid,
        name: hit.source.name,
        sourceType: hit.source.sourceType,
        location: hit.source.location,
        score: Number(hit.score.toFixed(4)),
        content: hit.chunk.content.slice(0, 1600)
      }))
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.callModel({
          messages: [
            {
              role: 'system',
              content: draft
                ? [
                    '你是 VISSLM 相关数据结论的独立复核器。请忽略初审的结论，重新阅读当前主题和全部原始证据。',
                    'direct 只有在证据原文或来源名称明确出现主题词或可核验的核心词，并且证据明确描述该主题的数据时才能使用。',
                    'indirect 表示最多只能从业务上下游、权限、统计、流程或语义接近性推测有关；它绝不能放入直接相关结果。',
                    'none 表示没有足够关系。不要因为同属一个系统、模块或业务领域就判为 direct。',
                    'evidence 必须是 source.name 或 source.content 中逐字出现的短句；不能改写、补全或引用常识。claim 只能忠实概括这段原文。',
                    '必须为每个 sourceIndex 输出且只输出一项。内部可以充分推理，但不要输出思维过程，只输出 schema 规定的 JSON。'
                  ].join('\n')
                : [
                    '你是 VISSLM 相关数据的意图理解和证据分类器。请先准确理解用户要查找的主题，再逐条判断证据与主题的关系。',
                    'direct 只有在证据原文或来源名称明确出现主题词或可核验的核心词，并且证据明确描述该主题的数据时才能使用。',
                    'indirect 表示最多只能从业务上下游、权限、统计、流程或语义接近性推测有关；它绝不能放入直接相关结果。',
                    'none 表示没有足够关系。向量相似分数只用于召回，不能作为 direct 的依据；同属一个系统、模块或业务领域也不能直接判相关。',
                    'evidence 必须是 source.name 或 source.content 中逐字出现的短句；不能改写、补全或引用常识。claim 只能忠实概括这段原文。',
                    '必须为每个 sourceIndex 输出且只输出一项。内部可以充分推理，但不要输出思维过程，只输出 schema 规定的 JSON。'
                  ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                ...(draft ? { evidence, draftToVerify: draft } : evidence),
                validationAttempt: attempt
              })
            }
          ],
          format: relatedDataReviewFormat,
          think: true,
          temperature: 0,
          numPredict: 3600
        })
        return this.parseRelatedDataReview(response.message?.content ?? '', hits)
      } catch (error) {
        lastError = error
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? '')
    throw new Error('相关数据复核连续两次未通过结构化校验' + (message ? '：' + message : ''))
  }

  private parseRelatedDataReview(
    content: string,
    hits: KnowledgeSearchHit[]
  ): RelatedDataReview {
    const codeFence = String.fromCharCode(96).repeat(3)
    const normalized = content.trim()
      .replace(new RegExp('^' + codeFence + '(?:json)?\\s*', 'i'), '')
      .replace(new RegExp('\\s*' + codeFence + '$'), '')
    if (!normalized) throw new Error('相关数据复核模型未返回内容')
    const start = normalized.indexOf('{')
    const end = normalized.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('相关数据复核结果不是有效 JSON')
    const raw = JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    if (!summary) throw new Error('相关数据复核结果缺少总结')
    if (!Array.isArray(raw.items)) throw new Error('相关数据复核结果缺少证据明细')

    const expectedIndexes = new Set(hits.map((_hit, index) => index + 1))
    const seenIndexes = new Set<number>()
    const items = raw.items.map((value): RelatedDataReviewItem => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('相关数据复核明细格式无效')
      }
      const item = value as Record<string, unknown>
      const sourceIndex = Number(item.sourceIndex)
      const relation = String(item.relation ?? '') as RelatedDataRelation
      const claim = typeof item.claim === 'string' ? item.claim.trim() : ''
      const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
      if (!Number.isInteger(sourceIndex) || !expectedIndexes.has(sourceIndex)) {
        throw new Error('相关数据复核包含未知来源编号')
      }
      if (seenIndexes.has(sourceIndex)) throw new Error('相关数据复核重复来源编号')
      if (!['direct', 'indirect', 'none'].includes(relation)) {
        throw new Error('相关数据复核包含未知关系类型')
      }
      if (!claim) throw new Error('相关数据复核缺少事实归纳')
      const hit = hits[sourceIndex - 1]
      if (relation !== 'none' && !this.isKnowledgeEvidenceSupported(evidence, hit)) {
        throw new Error('相关数据复核的证据不是来源原文')
      }
      seenIndexes.add(sourceIndex)
      return { sourceIndex, relation, claim, evidence: relation === 'none' ? '' : evidence }
    })
    if (items.length !== hits.length || seenIndexes.size !== expectedIndexes.size) {
      throw new Error('相关数据复核没有覆盖全部候选证据')
    }
    return { summary, items }
  }

  private isKnowledgeEvidenceSupported(evidence: string, hit: KnowledgeSearchHit): boolean {
    const normalizedEvidence = this.normalizeKnowledgeMatchText(evidence)
    if (normalizedEvidence.length < 2) return false
    const sourceText = this.normalizeKnowledgeMatchText(
      hit.source.name + '\n' + hit.chunk.content
    )
    return sourceText.includes(normalizedEvidence)
  }

  private hasExplicitRelatedTopicEvidence(topic: string, evidence: string): boolean {
    const normalizedTopic = this.normalizeKnowledgeMatchText(topic)
    const normalizedEvidence = this.normalizeKnowledgeMatchText(evidence)
    if (!normalizedTopic || !normalizedEvidence) return false
    if (normalizedEvidence.includes(normalizedTopic)) return true
    const coreTerms = this.extractRelatedDataCoreTerms(topic)
    return coreTerms.length > 0 && coreTerms.every((term) => normalizedEvidence.includes(term))
  }

  private extractRelatedDataCoreTerms(topic: string): string[] {
    const normalized = this.normalizeKnowledgeMatchText(topic)
    const stripped = normalized.replace(
      /功能|数据|记录|内容|资料|信息|条目|文档|事项|相关|有关|关联/g,
      ' '
    )
    const terms = stripped.match(/[a-z0-9][a-z0-9._/-]*|[\u4e00-\u9fff]{2,}/g) ?? []
    return [...new Set(terms.filter((term) => term.length >= 2))]
  }

  private normalizeKnowledgeMatchText(value: string): string {
    return value
      .toLocaleLowerCase()
      .replace(/\s+/g, '')
      .replace(/[，。！？；：、“”‘’"'、（）()【】[\]{}<>《》·,.;:!?]/g, '')
  }

  private async answerRecordSimilarity(
    request: ChatRequest,
    similarityRequest: RecordSimilarityRequest
  ): Promise<ChatResponse> {
    const requestedItemId = similarityRequest.itemId?.trim()
    if (!requestedItemId) {
      return {
        answer: '请提供一条作为比较基准的业务编号，例如：`和编号 VISSLM-TSIS-3959 相似的需求有哪些？`。缺少基准记录时，我不会猜测相似对象。',
        sources: [],
        dataViews: []
      }
    }

    this.progress('locate', `正在定位基准记录 ${requestedItemId}`)
    const baseRecord = this.db.findRecordByItemId(requestedItemId) ??
      this.db.findRecordByItemId(requestedItemId.toLocaleUpperCase())
    if (!baseRecord) {
      return {
        answer: `数据中心中不存在编号为 **${requestedItemId}** 的记录。请核对编号或先完成数据采集；本次未执行宽泛检索。`,
        sources: [],
        dataViews: []
      }
    }
    if (!this.knowledge) {
      return {
        answer: `已定位到 **${baseRecord.itemId}**，但当前记录向量索引服务不可用，暂时无法计算相似记录。`,
        sources: [],
        dataViews: []
      }
    }

    const baseDetail = this.db.getRecord(baseRecord.uid, false)
    const baseText = baseDetail?.normalizedText?.trim() ?? ''
    if (!baseDetail || !baseText) {
      return {
        answer: `已定位到 **${baseRecord.itemId}**，但该记录没有可用于语义匹配的正文，无法计算相似记录。`,
        sources: [],
        dataViews: []
      }
    }

    this.progress('match', `正在计算与 ${baseRecord.itemId} 的记录相似度`)
    const vectorMatches = await this.knowledge.rankRecordMatches(baseText)
    const candidates = vectorMatches
      .map((match) => ({ match, record: this.db.getRecord(match.recordUid, false) }))
      .filter((candidate): candidate is RecordSimilarityCandidate => Boolean(candidate.record))
      .filter(({ match, record }) =>
        record.uid !== baseRecord.uid &&
        record.nodeType === baseRecord.nodeType &&
        (!request.projectId || record.projectId === request.projectId) &&
        Number.isFinite(match.score) &&
        match.score >= RECORD_SIMILARITY_MIN_SCORE
      )
      .sort((left, right) =>
        right.match.score - left.match.score || left.record.uid.localeCompare(right.record.uid)
      )
      .slice(0, similarityRequest.limit)

    this.progress('verify', '正在核对候选记录和真实业务字段')
    if (!candidates.length) {
      return {
        answer: [
          `已定位基准记录 **${baseRecord.itemId} · ${baseRecord.name}**。`,
          `未找到相似度达到 **${RECORD_SIMILARITY_MIN_SCORE}%** 的同类型记录。已排除基准记录自身和其他记录类型，没有使用宽泛检索结果凑数。`
        ].join('\n\n'),
        sources: [],
        dataViews: []
      }
    }

    let review: RecordSimilarityReview
    try {
      this.progress('reason', `大模型正在深度分析 ${candidates.length} 条候选记录`)
      const draft = await this.reviewRecordSimilarity(request.question, baseDetail, candidates)
      this.progress('critique', '独立复核模型正在检查结论和证据一致性')
      review = await this.reviewRecordSimilarity(request.question, baseDetail, candidates, draft)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.progress('answer', '深度复核未通过，停止输出候选结论')
      return {
        answer: [
          `已定位基准记录 **${baseRecord.itemId} · ${baseRecord.name}**，也已完成候选召回。`,
          '但大模型深度分析或独立复核没有返回可验证的结构化结果。出于准确性要求，本次不输出相似候选，请重试。',
          `校验信息：${message}`
        ].join('\n\n'),
        sources: [],
        dataViews: []
      }
    }

    const reviewByUid = new Map(review.items.map((item) => [item.recordUid, item]))
    const accepted = candidates
      .map((candidate) => ({ ...candidate, review: reviewByUid.get(candidate.record.uid)! }))
      .filter(({ review: item }) =>
        ['high', 'medium'].includes(item.verdict) && item.score >= RECORD_SIMILARITY_AI_MIN_SCORE
      )
      .sort((left, right) =>
        right.review.score - left.review.score ||
        right.match.score - left.match.score ||
        left.record.uid.localeCompare(right.record.uid)
      )

    if (!accepted.length) {
      this.progress('answer', '正在生成深度复核结论')
      return {
        answer: [
          `已按编号精确定位基准记录 **${baseRecord.itemId} · ${baseRecord.name}**。`,
          review.summary,
          `大模型逐条分析并经第二次独立复核后，没有候选达到 ${RECORD_SIMILARITY_AI_MIN_SCORE}% 的有效相似标准，因此本次不列出相似记录。`
        ].join('\n\n'),
        sources: [],
        dataViews: []
      }
    }

    const sources: ChatSource[] = accepted.map(({ match, record, review: item }) => ({
      uid: record.uid,
      name: record.name,
      nodeType: record.nodeType,
      itemId: record.itemId,
      sourceType: 'record',
      chunkId: match.chunkId,
      snippet: match.snippet,
      score: Math.round(item.score * 10) / 10
    }))
    const rows: ChatDataRow[] = accepted.map(({ match, record, review: item }) => ({
      uid: record.uid,
      name: record.name,
      nodeType: record.nodeType,
      itemId: record.itemId,
      values: {
        aiSimilarity: `${item.score.toFixed(1)}%`,
        semanticRecall: `${match.score.toFixed(1)}%`,
        reviewReason: `相同点：${item.sharedEvidence}；差异：${item.difference}`
      }
    }))
    const list = accepted.flatMap(({ record, review: item }, index) => [
      `${index + 1}. **${record.itemId} · ${record.name}** · AI 复核匹配度 **${item.score.toFixed(1)}%** [UID:${record.uid}]`,
      `   - 相同点：${item.sharedEvidence}`,
      `   - 主要差异：${item.difference}`
    ])
    const answer = [
      `已按编号精确定位基准记录 **${baseRecord.itemId} · ${baseRecord.name}**。`,
      review.summary,
      `经语义召回、AI 深度分析和第二次独立复核，确认 ${sources.length} 条有效相似记录：`,
      '',
      ...list,
      '',
      '匹配口径：先以完整标准化正文召回同类型候选，再由大模型逐条比较目标、范围、行为和约束，最后对结论进行独立复核；基准记录自身、其他类型、低分和证据不足的候选均不展示。'
    ].join('\n')
    const dataView: ChatDataView = {
      id: `record-similarity:${baseRecord.uid}`,
      title: `与 ${baseRecord.itemId} 相似的记录`,
      description: `基准：${baseRecord.itemId} · ${baseRecord.name} · 已完成语义召回、AI 深度分析和独立复核`,
      total: rows.length,
      fields: ['aiSimilarity', 'semanticRecall', 'reviewReason'],
      fieldLabels: {
        aiSimilarity: 'AI 复核匹配度',
        semanticRecall: '语义召回分',
        reviewReason: '复核依据'
      },
      groups: [{
        name: '相似记录',
        count: rows.length,
        rows
      }]
    }
    this.progress('answer', '正在生成可核验的相似记录清单')
    return { answer, sources, dataViews: [dataView] }
  }

  private async reviewRecordSimilarity(
    question: string,
    baseRecord: NonNullable<ReturnType<AppDatabase['getRecord']>>,
    candidates: RecordSimilarityCandidate[],
    draft?: RecordSimilarityReview
  ): Promise<RecordSimilarityReview> {
    const evidence = {
      question,
      baseRecord: {
        uid: baseRecord.uid,
        itemId: baseRecord.itemId,
        name: baseRecord.name,
        nodeType: baseRecord.nodeType,
        content: baseRecord.normalizedText?.slice(0, 6000) ?? ''
      },
      candidates: candidates.map(({ match, record }) => ({
        uid: record.uid,
        itemId: record.itemId,
        name: record.name,
        nodeType: record.nodeType,
        semanticRecallScore: Number(match.score.toFixed(2)),
        content: record.normalizedText?.slice(0, 2400) ?? ''
      }))
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.callModel({
          messages: [
            {
              role: 'system',
              content: draft
                ? [
                    '你是 VISSLM 相似记录结论的独立复核器。请重新阅读全部原始证据，检查初审是否误解用户意图、遗漏关键差异或给出无依据结论。',
                    '必须独立判断并修正初审，不能因为初审给出高分就直接接受。只允许引用输入中的事实，不得补充常识推测或不存在的字段。',
                    '逐条比较业务目标、作用对象、触发条件、输入输出、功能行为和约束。字面词相同但目标不同不能判为相似；字面不同但能力和约束一致可以判为相似。',
                    'semanticRecallScore 只用于候选召回，不是最终结论。必须为每个候选 UID 输出且只输出一条复核。',
                    '在内部完成充分推理，但不要输出思维过程，只输出符合 schema 的结论、相同点和主要差异。'
                  ].join('\n')
                : [
                    '你是 VISSLM 需求与记录相似性深度分析器。请先准确理解用户问题和基准记录，再逐条分析候选。',
                    '逐条比较业务目标、作用对象、触发条件、输入输出、功能行为和约束。不要只按关键词重合判断，也不要把同属一个模块误判为需求相似。',
                    'semanticRecallScore 只用于候选召回，不是最终结论。只允许使用输入中的真实证据，不得虚构字段、背景或因果关系。',
                    '为每个候选给出 0-100 分，必须为每个候选 UID 输出且只输出一条分析。相似等级由系统根据分数统一计算，不要输出 verdict 字段。',
                    '在内部完成充分推理，但不要输出思维过程，只输出符合 schema 的总结、相同点和主要差异。'
                  ].join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({
                ...(draft ? { evidence, draftToVerify: draft } : evidence),
                validationAttempt: attempt
              })
            }
          ],
          format: recordSimilarityReviewFormat,
          think: true,
          temperature: 0,
          numPredict: 2800
        })
        return this.parseRecordSimilarityReview(response.message?.content ?? '', candidates)
      } catch (error) {
        lastError = error
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? '')
    throw new Error(`${draft ? '独立复核' : '深度分析'}连续两次未通过结构化校验${message ? `：${message}` : ''}`)
  }

  private parseRecordSimilarityReview(
    content: string,
    candidates: RecordSimilarityCandidate[]
  ): RecordSimilarityReview {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    if (!normalized) throw new Error('复核模型未返回内容')
    const start = normalized.indexOf('{')
    const end = normalized.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('复核结果不是有效 JSON')
    const raw = JSON.parse(normalized.slice(start, end + 1)) as Record<string, unknown>
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    if (!summary) throw new Error('复核结果缺少总结')
    if (!Array.isArray(raw.items)) throw new Error('复核结果缺少候选明细')

    const expectedUids = new Set(candidates.map(({ record }) => record.uid))
    const seenUids = new Set<string>()
    const items = raw.items.map((value): RecordSimilarityReviewItem => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('复核候选格式无效')
      }
      const item = value as Record<string, unknown>
      const recordUid = typeof item.recordUid === 'string' ? item.recordUid.trim() : ''
      const score = Number(item.score)
      const sharedEvidence = typeof item.sharedEvidence === 'string' ? item.sharedEvidence.trim() : ''
      const difference = typeof item.difference === 'string' ? item.difference.trim() : ''
      if (!expectedUids.has(recordUid)) throw new Error(`复核结果包含未知 UID：${recordUid || '空'}`)
      if (seenUids.has(recordUid)) throw new Error(`复核结果重复 UID：${recordUid}`)
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error(`UID ${recordUid} 的相似分数无效`)
      }
      if (!sharedEvidence || !difference) throw new Error(`UID ${recordUid} 缺少相同点或差异说明`)
      seenUids.add(recordUid)
      const normalizedScore = Math.round(score * 10) / 10
      return {
        recordUid,
        score: normalizedScore,
        verdict: normalizedScore >= 75
          ? 'high'
          : normalizedScore >= 50
            ? 'medium'
            : normalizedScore >= 25
              ? 'low'
              : 'none',
        sharedEvidence,
        difference
      }
    })
    if (items.length !== candidates.length || seenUids.size !== expectedUids.size) {
      throw new Error('复核结果未覆盖全部候选记录')
    }
    return { summary, items }
  }

  private async askWithKnowledge(request: ChatRequest): Promise<ChatResponse | null> {
    if (!this.knowledge) return null
    this.progress('retrieve', '正在检索本地知识库')
    const hits = await this.knowledge.search(request.question, 8)
    if (!hits.length) {
      const stats = this.db.getKnowledgeStats(this.knowledge.modelVersion)
      if (!stats.indexedChunkCount && !stats.documentCount && !this.db.hasRecords()) {
        return {
          answer: '当前知识库还没有完成可用索引，暂时无法基于本地资料回答。请先上传文档或完成数据采集，等待索引完成后再试。',
          sources: [],
          dataViews: []
        }
      }
      // A semantic miss does not mean the structured records are unavailable.
      // Let the validated query planner answer from the records table instead.
      return null
    }
    this.progress('verify', `已找到 ${hits.length} 条知识依据，正在核对引用`)
    const evidence = hits.map((hit, index) => this.formatKnowledgeEvidence(hit, index + 1)).join('\n\n')
    const response = await this.callModel({
      messages: [
        {
          role: 'system',
          content: [
            '你是 VISSLM 本地知识库助手，只能依据用户问题和下面提供的检索证据回答。',
            '证据编号必须使用正文引用 [1]、[2]；不能编造未出现在证据中的事实。',
            '回答时区分事实、基于事实的分析判断和不确定性；证据不足时明确说证据不足。',
            '不要把采集记录当成上传文档，也不要把上传文档当成结构化统计结果。',
            '使用简洁、清晰的中文 Markdown。'
          ].join('\n')
        },
        ...(request.history ?? []).slice(-6).map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          role: 'user',
          content: `问题：${request.question}\n\n检索证据：\n${evidence}`
        }
      ],
      think: false,
      temperature: 0.1,
      numPredict: 1600
    })
    const answer = this.ensureKnowledgeCitations(
      response.message?.content?.trim() || '检索到依据，但模型没有生成可验证的回答。',
      hits
    )
    return {
      answer,
      sources: hits.map((hit) => hit.source),
      dataViews: []
    }
  }

  private formatKnowledgeEvidence(hit: KnowledgeSearchHit, index: number): string {
    const source = hit.source
    const location = source.location ? `，位置：${source.location}` : ''
    return `[${index}] 来源：${source.name}${location}\n${hit.chunk.content.slice(0, 1800)}`
  }

  private ensureKnowledgeCitations(answer: string, hits: KnowledgeSearchHit[]): string {
    const valid = new Set<number>()
    const normalized = answer.replace(/\[(\d+)\]/g, (full, raw: string) => {
      const number = Number(raw)
      if (number >= 1 && number <= hits.length) {
        valid.add(number)
        return full
      }
      return ''
    }).trim()
    if (valid.size) return normalized
    const references = hits.slice(0, 4).map((_hit, index) => `[${index + 1}]`).join('、')
    return `${normalized}\n\n依据：${references}`
  }

  private async planQuestion(request: ChatRequest): Promise<QuestionPlan> {
    const profile = this.db.inspectFields({
      projectId: request.projectId,
      limit: 100
    })
    const nodeTypes = this.db.listNodeTypes()
    const catalog = profile.fields.map((field) => ({
      field: field.field,
      kind: /^_valm_|^(Record|uid|parentId|projectId|nodeType)$/i.test(field.field)
        ? 'technical'
        : 'business',
      types: field.types,
      coverageRate: field.coverageRate,
      samples: field.samples.slice(0, 3)
    }))
    const fieldNames = catalog.map((field) => field.field)
    const planFormat = structuredClone(questionPlanFormat) as MutableJsonSchema
    const planProperties = planFormat.properties
    if (planProperties) {
      planProperties.nodeType.enum = nodeTypes
      planProperties.groupByField.enum = fieldNames
      planProperties.fields.items!.enum = fieldNames
      planProperties.filters.items!.properties!.field.enum = fieldNames
      planProperties.sort.properties!.field.enum = fieldNames
    }
    const contextual =
      /^(继续|再|那|那么)|上一个|刚才|上述|其中|它们|这些|该问题|该记录/.test(
        request.question.trim()
      )
    const response = await this.callModel({
      messages: [
        {
          role: 'system',
          content: [
            '你是 AI 助手意图与数据查询规划器，不回答问题，只输出 JSON 计划。',
            '必须根据当前问题和提供的真实字段目录规划，不能复用无关历史结论。',
            '先判断问题是否真的需要访问本地数据；没有明确数据诉求时绝不能强行生成统计或查询计划。',
            '问候、闲聊、助手身份、能力介绍、通用知识或方法建议使用 conversation。',
            '询问当前数据有哪些字段、字段含义、覆盖率或示例值时使用 schema_inspection。',
            '要求基于若干记录归纳、总结、比较、解释原因、发现规律或提出建议时使用 analyze_records。',
            '需要数据时，再识别总量、字段聚合、条件计数、具体记录属性、记录筛选、记录分析或正文检索。',
            '只要问题包含主题、属性、时间、状态、对象类别等限定条件，就不能使用 total。',
            '业务类别应优先映射到目录中真实存在的字段过滤；无法映射为字段的主题概念使用 searchTerms。',
            '字段目录中的 kind=technical 表示同步或存储技术字段，kind=business 表示用户可理解的业务属性。',
            '当用户表达业务类别、状态、优先级等条件时，必须优先选择语义匹配的 business 字段，不能用 _valm_NodeType 等 technical 字段替代。',
            'searchTerms 只能使用当前问题中明确出现的词或短语；除非用户明确要求同义扩展，否则禁止自行增加近义词、关联词。',
            '同义词、近义词和主题扩展词之间使用 searchMode=any；只有用户明确要求多个不同概念必须同时满足时才使用 all。',
            'record_lookup 仅用于用户通过唯一名称、UID 或业务编号定位一条记录并询问其具体属性。',
            '用户要求列出、查找或查看一组相关记录时使用 filter_records 或 search_content，不能使用 record_lookup。',
            '询问某个字段有哪些取值、单位、人员、状态或分布时使用 field_aggregate，并把该字段放入 groupByField。',
            '用户询问的属性必须放入 fields；排名或分布的维度放入 groupByField。',
            'fields 只能包含用户明确要求查看的属性，不能为了生成回答而把所有原始字段加入 fields。',
            '所有 filters.field、fields、groupByField、sort.field 必须来自字段目录，禁止发明字段。',
            '字段目录中的 samples 只用于理解字段含义，绝不能擅自选一个样例值作为 filters.value。',
            'is_empty 或 not_empty 只能在用户明确询问空值、未填写、缺失或非空数据时使用，且不得携带 value。',
            'limit 为需要返回给用户核查的记录数，范围 1 到 50。',
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            currentQuestion: request.question,
            conversationContext: contextual ? (request.history ?? []).slice(-6) : [],
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
    const content = response.message?.content?.trim()
    if (!content) throw new Error('规划模型未返回查询计划')
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('查询计划不是有效 JSON')
    const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>
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
    const intent = intents.includes(raw.intent as QuestionPlanIntent)
      ? raw.intent as QuestionPlanIntent
      : 'search_content'
    const resolveField = (input: unknown): string | undefined => {
      const requested = String(input ?? '').trim()
      if (!requested) return undefined
      return catalog.find(
        (field) =>
          field.field.localeCompare(requested, undefined, { sensitivity: 'accent' }) === 0
      )?.field
    }
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
    const asksEmptyValue = /为空|空值|未填写|未设置|缺失|没有值|无值/.test(request.question)
    const asksNonEmptyValue = /非空|不为空|已填写|有值/.test(request.question)
    const filters = Array.isArray(raw.filters)
      ? raw.filters.flatMap((input) => {
          if (!input || typeof input !== 'object' || Array.isArray(input)) return []
          const filter = input as Record<string, unknown>
          const field = resolveField(filter.field)
          const operator = String(filter.operator ?? '')
          if (!field || !allowedOperators.has(operator)) return []
          if (operator === 'is_empty' && !asksEmptyValue) return []
          if (operator === 'not_empty' && !asksNonEmptyValue) return []
          return [{
            field,
            operator: operator as QuestionPlan['filters'][number]['operator'],
            value:
              operator === 'is_empty' || operator === 'not_empty'
                ? undefined
                : filter.value === undefined
                  ? undefined
                  : String(filter.value)
          }]
        }).slice(0, 10)
      : []
    const fields = Array.isArray(raw.fields)
      ? [...new Set(raw.fields.map(resolveField).filter((field): field is string => Boolean(field)))]
          .slice(0, 20)
      : []
    const normalizedQuestion = request.question.toLocaleLowerCase()
    const searchTerms = Array.isArray(raw.searchTerms)
      ? [...new Set(
          raw.searchTerms
            .map((term) => String(term).trim())
            .filter(
              (term) =>
                Boolean(term) &&
                normalizedQuestion.includes(term.toLocaleLowerCase())
            )
        )].slice(0, 10)
      : []
    const requestedNodeType = String(raw.nodeType ?? '').trim()
    const nodeType = nodeTypes.find(
      (value) => value.localeCompare(requestedNodeType, undefined, { sensitivity: 'accent' }) === 0
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
    const plan: QuestionPlan = {
      intent,
      explanation: String(raw.explanation ?? '').trim(),
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
      limit: Math.min(50, Math.max(1, Math.trunc(Number(raw.limit ?? 30))))
    }
    const explicitlyRequiresAllTerms =
      /同时满足|同时包含|全部包含|均包含|并且包含|且包含/.test(request.question)
    if (plan.searchTerms.length > 1 && !explicitlyRequiresAllTerms) {
      plan.searchMode = 'any'
    }
    const requestsCount = /多少|几条|数量|总数|计数/.test(request.question)
    const requestsList = /列出|清单|明细|有哪些|哪些记录|哪些数据/.test(request.question)
    if (
      requestsCount &&
      ['record_lookup', 'filter_records', 'analyze_records', 'search_content'].includes(plan.intent)
    ) {
      plan.intent = 'count_matching'
    } else if (
      requestsList &&
      ['count_matching', 'record_lookup', 'analyze_records', 'search_content'].includes(plan.intent)
    ) {
      plan.intent = 'filter_records'
    }
    if (plan.intent === 'total' && (plan.searchTerms.length || plan.filters.length)) {
      plan.intent = 'count_matching'
      plan.metric = undefined
    }
    if (plan.intent === 'total' && !plan.metric) plan.metric = 'record_count'
    if (plan.intent === 'field_aggregate' && !plan.groupByField) {
      throw new Error('字段聚合计划缺少有效 groupByField')
    }
    if (
      ['count_matching', 'record_lookup', 'filter_records', 'analyze_records', 'search_content']
        .includes(plan.intent) &&
      !plan.searchTerms.length &&
      !plan.filters.length
    ) {
      throw new Error('条件查询计划缺少检索词或字段过滤')
    }
    return plan
  }

  private async executePlanAndAnswer(
    request: ChatRequest,
    plan: QuestionPlan
  ): Promise<ChatResponse> {
    if (plan.intent === 'conversation') {
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
          ...(request.history ?? []).slice(-6).map((message) => ({
            role: message.role,
            content: message.content
          })),
          { role: 'user' as const, content: request.question }
        ],
        think: false,
        temperature: 0.3,
        numPredict: 800
      })
      return {
        answer: response.message?.content?.trim() || '你好，我是 VISSLM AI 助手。',
        sources: [],
        dataViews: []
      }
    }

    let toolName: string
    let args: Record<string, unknown>
    let result: unknown
    if (plan.intent === 'schema_inspection') {
      toolName = 'inspect_fields'
      args = {
        project_id: request.projectId,
        node_type: plan.nodeType,
        limit: plan.limit
      }
      result = this.executeTool(toolName, args, request.projectId)
    } else if (plan.intent === 'total') {
      toolName = 'aggregate_records'
      args = {
        metric: plan.metric ?? 'record_count',
        project_id: request.projectId
      }
      result = this.executeTool(toolName, args, request.projectId)
    } else if (plan.intent === 'field_aggregate') {
      toolName = 'aggregate_by_field'
      args = {
        field: plan.groupByField,
        project_id: request.projectId,
        node_type: plan.nodeType,
        limit: plan.limit,
        split_multi_value: true
      }
      result = this.executeTool(toolName, args, request.projectId)
    } else {
      toolName = 'query_records_by_fields'
      args = {
        project_id: request.projectId,
        node_type: plan.nodeType,
        search_terms: plan.searchTerms,
        search_mode: plan.searchMode,
        filters: plan.filters,
        fields: plan.fields,
        sort: plan.sort,
        limit: plan.limit
      }
      result = this.db.queryRecordsByFields({
        projectId: request.projectId,
        nodeType: plan.nodeType,
        searchTerms: plan.searchTerms,
        searchMode: plan.searchMode,
        filters: plan.filters,
        fields: plan.fields,
        sort: plan.sort,
        limit: plan.limit
      })
    }

    this.progress('verify', '正在核对查询结果与问题口径')
    const sources = new Map<string, ChatSource>()
    this.collectSources(result, sources)
    const dataView = this.createDataView(toolName, args, result, request.projectId)
    const response = await this.callModel({
      messages: [
        {
          role: 'system',
          content: [
            '你是 VISSLM 数据回答器。只能使用本轮查询计划和执行结果回答，禁止补充未查询的数据。',
            '先核对问题、计划和结果是否一致，再给出结论。',
            '计数必须使用 matchedCount 或工具返回的明确计数，不能使用 totalScanned 代替命中数。',
            '说明关键查询口径，例如检索词、字段过滤、分组字段或多值拆分。',
            '如果结果为空，明确说明本轮查询条件下未命中，并给出可调整的查询方向。',
            '不要提及与当前问题无关的字段、上一轮数字或结论。',
            '列表类问题只概述命中数量并列出记录名称，不要输出 HTML、JSON、流程日志或内部原始字段。',
            '分析类问题应先给出结论，再说明由哪些查询结果支持；区分事实、归纳和建议。',
            '字段结构类问题使用用户可理解的名称解释字段，不要把字段数量误当成记录统计。',
            '引用记录时使用 source.uid 写成 [UID:实际UID]。',
            '回答使用中文，结论优先，简洁但信息完整。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            question: request.question,
            queryPlan: plan,
            queryResult: result
          })
        }
      ],
      think: false,
      temperature: 0.1,
      numPredict: 1400
    })
    let answer = this.renderVerifiedAnswer(
      plan,
      result,
      response.message?.content?.trim() || '模型没有生成回答。'
    )
    for (const source of sources.values()) {
      if (source.itemId && source.uid && source.itemId !== source.uid) {
        answer = answer.replaceAll(`[UID:${source.itemId}]`, `[UID:${source.uid}]`)
      }
    }
    return {
      answer,
      sources: [...sources.values()],
      dataViews: dataView ? [dataView] : []
    }
  }

  private renderVerifiedAnswer(
    plan: QuestionPlan,
    result: unknown,
    modelAnswer: string
  ): string {
    if (plan.intent === 'count_matching' && result && typeof result === 'object') {
      const query = result as { matchedCount?: number }
      const matchedCount = Number(query.matchedCount ?? 0)
      const terms = plan.searchTerms.length
        ? `检索词：${plan.searchTerms.join('、')}`
        : ''
      const filters = plan.filters.length
        ? `字段过滤：${plan.filters.map((filter) =>
            `${filter.field} ${filter.operator}${filter.value === undefined ? '' : ` ${filter.value}`}`
          ).join('；')}`
        : ''
      return [
        `根据本轮查询条件，共命中 **${matchedCount}** 条记录。`,
        [terms, filters].filter(Boolean).join('；')
      ].filter(Boolean).join('\n\n')
    }

    if (plan.intent === 'record_lookup' && result && typeof result === 'object') {
      const query = result as {
        records?: Array<{
          source: ChatSource
          values: Record<string, string | string[]>
        }>
      }
      const records = query.records ?? []
      if (!records.length) return '本轮查询没有定位到符合条件的记录。'
      const exact = records.find((record) =>
        plan.searchTerms.some(
          (term) =>
            record.source.name.localeCompare(term, undefined, { sensitivity: 'accent' }) === 0 ||
            record.source.itemId.localeCompare(term, undefined, { sensitivity: 'accent' }) === 0
        )
      )
      if (exact && (plan.fields.length > 0 || records.length === 1)) {
        const properties = plan.fields.map((field) => {
          const value = exact.values[field]
          const display = Array.isArray(value) ? value.join('、') : value || '未设置'
          return `- ${field}：${display}`
        })
        return [
          `记录“${exact.source.name}”的查询结果：`,
          ...properties,
          `[UID:${exact.source.uid}]`
        ].join('\n')
      }
    }

    if (
      ['record_lookup', 'filter_records', 'search_content'].includes(plan.intent) &&
      result &&
      typeof result === 'object'
    ) {
      const query = result as {
        matchedCount?: number
        records?: Array<{ source: ChatSource }>
      }
      const records = query.records ?? []
      const matchedCount = Number(query.matchedCount ?? records.length)
      if (!records.length) return '本轮查询条件下没有找到相关记录。'
      const visibleRecords = records.slice(0, 20)
      const criteria = plan.searchTerms.length
        ? `与“${plan.searchTerms.join('、')}”相关`
        : '符合筛选条件'
      const list = visibleRecords.map((record, index) => {
        const source = record.source
        const metadata = [source.nodeType, source.itemId].filter(Boolean).join(' · ')
        return `${index + 1}. ${source.name || '未命名记录'}${metadata ? `（${metadata}）` : ''}`
      })
      const remainder = matchedCount - visibleRecords.length
      return [
        `共找到 **${matchedCount}** 条${criteria}的记录：`,
        '',
        ...list,
        ...(remainder > 0
          ? ['', `其余 ${remainder} 条请点击“查看查询数据”查看。`]
          : ['', '可点击“查看查询数据”查看每条记录的完整属性。'])
      ].join('\n')
    }

    if (plan.intent === 'field_aggregate' && result && typeof result === 'object') {
      const aggregate = result as {
        field?: string
        items?: Array<{ name: string; value: number }>
        matchedRecords?: number
        totalRecords?: number
        splitMultiValue?: boolean
      }
      if (aggregate.items?.length) {
        const ranking = aggregate.items.map(
          (item, index) => `${index + 1}. ${item.name}：${item.value} 条`
        )
        return [
          `按 ${aggregate.field ?? plan.groupByField ?? '指定字段'} 统计结果：`,
          ...ranking,
          `统计口径：${aggregate.matchedRecords ?? 0}/${aggregate.totalRecords ?? 0} 条记录字段非空${aggregate.splitMultiValue ? '，多值已拆分计数' : ''}。`
        ].join('\n')
      }
    }

    if (plan.intent === 'total' && result && typeof result === 'object' && !Array.isArray(result)) {
      const total = result as { metric?: string; value?: number }
      if (Number.isFinite(Number(total.value))) {
        return `查询结果：${Number(total.value)}。统计指标：${total.metric ?? plan.metric ?? '总量'}。`
      }
    }

    return modelAnswer
  }

  private async callModel(input: {
    messages: ModelMessage[]
    think: boolean
    format?: 'json' | Record<string, unknown>
    temperature: number
    numPredict: number
  }): Promise<ModelResponse> {
    return new ModelClient(this.settings).chat({ ...input, forceThinking: true })
  }

  private async askWithTools(request: ChatRequest): Promise<ChatResponse> {
    const sources = new Map<string, ChatSource>()
    const dataViews = new Map<string, ChatDataView>()
    const usedTools = new Set<string>()
    const evidenceTools = new Set([
      'search_records',
      'get_record_detail',
      'aggregate_records',
      'aggregate_by_field',
      'query_records_by_fields'
    ])
    const recordPropertyQuestion =
      /名为|UID|编号为|某条记录|这条记录|该记录|它的.+(?:是什么|分别)/.test(request.question)
    const filteredRecordQuestion =
      /哪些记录|满足.+条件|最近|最早|最大|最小|大于|小于|等于|不为空|为空/.test(request.question)
    const fieldAggregateQuestion =
      /前\s*\d+\s*名|排名|排行|分布|最多|最少|占比/.test(request.question)
    const requiredEvidenceTools = recordPropertyQuestion
      ? new Set(['get_record_detail', 'query_records_by_fields'])
      : filteredRecordQuestion
        ? new Set(['query_records_by_fields'])
        : fieldAggregateQuestion
          ? new Set(['aggregate_by_field', 'aggregate_records'])
          : null
    const requiredEvidenceHint = recordPropertyQuestion
      ? '这是指定记录的属性问题，必须调用 query_records_by_fields（或 search_records/get_record_detail）取得目标记录的真实属性值。全局字段聚合不能回答此问题。'
      : filteredRecordQuestion
        ? '这是按条件筛选或排序记录的问题，必须调用 query_records_by_fields。'
        : fieldAggregateQuestion
          ? '这是字段排名或分布问题，必须调用 aggregate_by_field；只有记录类型/项目统计才使用 aggregate_records。'
          : ''
    const asksOnlyForFieldSchema =
      /有哪些(?:可用)?字段|字段列表|数据结构|字段结构|字段覆盖率|查看字段/.test(request.question)
    const system: ModelMessage = {
      role: 'system',
      content: [
        '你是 VISSLM 项目数据助手，只能依据工具返回的本地采集数据回答。',
        '先判断问题类型，再选择工具：总量统计用 aggregate_records；业务字段排名或分布用 aggregate_by_field；按属性查记录或读取指定属性用 query_records_by_fields；按名称或正文定位具体记录用 search_records/get_record_detail。',
        '每轮必须只回答当前用户问题。历史消息只用于解析“它、上述、继续”等指代；当前问题已经自包含时，禁止复用上一轮的字段、数字、工具结果或结论。',
        '用户使用的业务叫法可能与真实字段名不同。字段不确定时先调用 inspect_fields，根据字段名、样例和覆盖率确认，禁止猜测字段。',
        'inspect_fields 只描述字段结构，绝不能作为某条记录属性值或业务结论的最终证据。除非用户明确询问“有哪些字段”，调用 inspect_fields 后必须继续调用 query_records_by_fields、aggregate_by_field 或其他数据工具。',
        '当问题格式是“名为X的记录，其A和B是什么”时，调用 query_records_by_fields：search=X，fields=[A的真实字段,B的真实字段]。例如“某记录的Source和负责人”应使用 fields=[Source,_valm_AssignedTo]。',
        '常用语义：负责人/责任人通常对应 _valm_AssignedTo；来源单位对应 Source；活动记录中的执行人对应 Record.UserName。若同义词仍不确定，inspect_fields 不要只搜索一个属性，应分别检查所有属性或不加 search。',
        '涉及记录总量、图片总量、按记录类型或按项目数量时必须调用 aggregate_records，不得自行估算。',
        '当用户要求按某个业务字段统计、排名、前N名、分布、最多或最少时，必须调用 aggregate_by_field；不要用 count_by_type 代替字段统计。',
        'Source、状态、负责人、版本等是业务字段，不是记录类型。用户说“Source 前3名”时应调用 aggregate_by_field，field=Source，limit=3。',
        'aggregate_by_field 返回的 matchedRecords 是字段非空记录数，emptyRecords 是空值记录数；回答时说明统计范围和多值拆分口径。',
        '需要回答某条或某批记录的具体属性时，必须让 query_records_by_fields 的 fields 明确包含所需字段，回答只能使用工具返回的 values。',
        '时间、数字比较和排序必须由 query_records_by_fields 执行，不得根据少量搜索结果自行比较。',
        '按名称或正文定位具体记录时调用 search_records；已知 UID 时调用 get_record_detail；按字段条件定位记录时调用 query_records_by_fields。',
        '找不到证据时明确说明未检索到，不要编造。',
        '回答使用中文，简洁清楚。引用记录时必须使用工具 source.uid 写成 [UID:实际UID]，不要把 source.itemId 当成 UID。'
      ].join('\n')
    }
    const messages: ModelMessage[] = [
      system,
      ...(
        /^(继续|再|那|那么)|上一个|刚才|上述|其中|它们|这些|该问题|该记录/.test(
          request.question.trim()
        )
          ? (request.history ?? []).slice(-8)
          : []
      ).map(
        (message): ModelMessage => ({
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
        const hasEvidence = [...usedTools].some((tool) => evidenceTools.has(tool))
        const hasRequiredEvidence =
          !requiredEvidenceTools ||
          [...usedTools].some((tool) => requiredEvidenceTools.has(tool))
        if (
          !asksOnlyForFieldSchema &&
          (
            (usedTools.has('inspect_fields') && !hasEvidence) ||
            (requiredEvidenceTools && !hasRequiredEvidence)
          )
        ) {
          messages.push({
            role: 'system',
            content: [
              '你尚未取得与用户问题类型匹配的证据，因此禁止结束回答。',
              requiredEvidenceHint,
              '请立即继续调用合适的证据工具：具体记录属性使用 query_records_by_fields，字段排名使用 aggregate_by_field，名称/正文检索使用 search_records。',
              '如果用户给出了记录名称，把名称放入 search；把用户询问的所有真实字段放入 fields。'
            ].join('\n')
          })
          continue
        }
        let answer = assistant.content || '模型没有生成回答。'
        for (const source of sources.values()) {
          if (source.itemId && source.uid && source.itemId !== source.uid) {
            answer = answer.replaceAll(`[UID:${source.itemId}]`, `[UID:${source.uid}]`)
          }
        }
        return {
          answer,
          sources: [...sources.values()],
          dataViews: [...dataViews.values()]
        }
      }
      for (const call of assistant.tool_calls) {
        usedTools.add(call.function.name)
        const result = this.executeTool(call.function.name, call.function.arguments, request.projectId)
        const dataView = this.createDataView(
          call.function.name,
          call.function.arguments,
          result,
          request.projectId
        )
        if (dataView) dataViews.set(dataView.id, dataView)
        if (!requiredEvidenceTools || requiredEvidenceTools.has(call.function.name)) {
          this.collectSources(result, sources)
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result)
        })
      }
    }
    throw new Error('Agent 工具调用次数过多，请缩小问题范围后重试')
  }

  private async chat(messages: ModelMessage[]): Promise<ModelResponse> {
    return new ModelClient(this.settings).chat({
      messages,
      tools,
      think: this.settings.thinking,
      forceThinking: true,
      temperature: 0.1,
      numPredict: 2048
    })
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
    if (name === 'inspect_fields') {
      const result = this.db.inspectFields({
        projectId: String(args.project_id ?? selectedProjectId ?? '') || undefined,
        nodeType: String(args.node_type ?? '') || undefined,
        search: String(args.search ?? '') || undefined,
        limit: Math.min(100, Math.max(1, Number(args.limit ?? 40)))
      })
      return {
        ...result,
        usage:
          '字段画像只用于确认真实字段名，不能代表目标记录的属性值。若用户询问记录属性，请继续调用 query_records_by_fields，并在 fields 中列出所需真实字段。'
      }
    }
    if (name === 'query_records_by_fields') {
      const filters = Array.isArray(args.filters)
        ? args.filters
            .filter((filter): filter is Record<string, unknown> =>
              Boolean(filter) && typeof filter === 'object' && !Array.isArray(filter)
            )
            .map((filter) => ({
              field: String(filter.field ?? ''),
              operator: String(filter.operator ?? 'equals') as
                | 'equals'
                | 'not_equals'
                | 'contains'
                | 'not_contains'
                | 'is_empty'
                | 'not_empty'
                | 'gt'
                | 'gte'
                | 'lt'
                | 'lte',
              value: filter.value === undefined ? undefined : String(filter.value)
            }))
        : []
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => String(field))
        : []
      const sortInput =
        args.sort && typeof args.sort === 'object' && !Array.isArray(args.sort)
          ? args.sort as Record<string, unknown>
          : null
      return this.db.queryRecordsByFields({
        projectId: String(args.project_id ?? selectedProjectId ?? '') || undefined,
        nodeType: String(args.node_type ?? '') || undefined,
        search: String(args.search ?? '') || undefined,
        filters,
        fields,
        sort: sortInput?.field
          ? {
              field: String(sortInput.field),
              direction: sortInput.direction === 'asc' ? 'asc' : 'desc'
            }
          : undefined,
        limit: Math.min(50, Math.max(1, Number(args.limit ?? 10)))
      })
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
        raw: detail.raw,
        ...(detail.fieldLabels && Object.keys(detail.fieldLabels).length
          ? { fieldLabels: detail.fieldLabels }
          : {})
      }
    }
    if (name === 'aggregate_records') {
      return this.db.aggregate(
        String(args.metric ?? 'count_by_type'),
        String(args.project_id ?? selectedProjectId ?? '') || undefined
      )
    }
    if (name === 'aggregate_by_field') {
      return this.db.aggregateByField({
        field: String(args.field ?? ''),
        projectId: String(args.project_id ?? selectedProjectId ?? '') || undefined,
        nodeType: String(args.node_type ?? '') || undefined,
        limit: Math.min(50, Math.max(1, Number(args.limit ?? 10))),
        splitMultiValue: args.split_multi_value !== false
      })
    }
    return { error: `未知工具 ${name}` }
  }

  private createDataView(
    toolName: string,
    args: Record<string, unknown>,
    result: unknown,
    selectedProjectId?: string
  ): ChatDataView | null {
    const toRow = (record: {
      source: ChatSource
      values?: Record<string, string | string[]>
    }): ChatDataRow => ({
      uid: record.source.uid,
      name: record.source.name,
      nodeType: record.source.nodeType,
      itemId: record.source.itemId,
      values: record.values ?? {}
    })

    if (toolName === 'aggregate_by_field' && result && typeof result === 'object') {
      const aggregate = result as {
        field?: string
        totalRecords?: number
        matchedRecords?: number
        emptyRecords?: number
        splitMultiValue?: boolean
        items?: Array<{ name?: string; value?: number }>
      }
      const field = String(aggregate.field ?? args.field ?? '').trim()
      if (!field || !aggregate.items?.length) return null
      const fieldLabels = this.db.getFieldDisplayNames(
        String(args.node_type ?? '').trim(),
        [field]
      )
      const groups = aggregate.items.slice(0, 5).map((item) => {
        const groupName = String(item.name ?? '')
        const query = this.db.queryRecordsByFields({
          projectId: String(args.project_id ?? selectedProjectId ?? '') || undefined,
          nodeType: String(args.node_type ?? '') || undefined,
          filters: [{ field, operator: 'contains', value: groupName }],
          fields: [field],
          limit: 100
        })
        return {
          name: groupName,
          count: Number(item.value ?? query.matchedCount),
          rows: query.records.map(toRow)
        }
      })
      return {
        id: `aggregate-by-field:${field}`,
        title: `${fieldLabels[field] ?? field} 查询数据`,
        description: [
          `统计范围 ${Number(aggregate.totalRecords ?? 0)} 条`,
          `字段非空 ${Number(aggregate.matchedRecords ?? 0)} 条`,
          `空值 ${Number(aggregate.emptyRecords ?? 0)} 条`,
          aggregate.splitMultiValue ? '多值字段已拆分' : '',
          '每个分组最多展示 50 条'
        ].filter(Boolean).join(' · '),
        total: Number(aggregate.matchedRecords ?? 0),
        fields: [field],
        ...(Object.keys(fieldLabels).length ? { fieldLabels } : {}),
        groups
      }
    }

    if (toolName === 'query_records_by_fields' && result && typeof result === 'object') {
      const query = result as {
        matchedCount?: number
        fields?: string[]
        fieldLabels?: Record<string, string>
        records?: Array<{
          source: ChatSource
          values: Record<string, string | string[]>
        }>
      }
      if (!query.records?.length) return null
      const fields = query.fields ?? []
      const fieldLabels = query.fieldLabels ?? this.db.getFieldDisplayNames(
        String(args.node_type ?? '').trim(),
        fields
      )
      return {
        id: `field-query:${fields.join(',') || 'records'}`,
        title: '属性查询数据',
        description: `共命中 ${Number(query.matchedCount ?? query.records.length)} 条，当前展示 ${query.records.length} 条`,
        total: Number(query.matchedCount ?? query.records.length),
        fields,
        ...(Object.keys(fieldLabels).length ? { fieldLabels } : {}),
        groups: [{
          name: '查询结果',
          count: Number(query.matchedCount ?? query.records.length),
          rows: query.records.map(toRow)
        }]
      }
    }

    if (toolName === 'search_records' && Array.isArray(result) && result.length) {
      const records = result.filter(
        (item): item is { source: ChatSource } =>
          Boolean(item) && typeof item === 'object' && Boolean((item as { source?: unknown }).source)
      )
      return {
        id: 'record-search',
        title: '检索到的记录',
        description: `当前展示检索返回的 ${records.length} 条记录`,
        total: records.length,
        fields: [],
        groups: [{
          name: '检索结果',
          count: records.length,
          rows: records.map(toRow)
        }]
      }
    }

    if (toolName === 'get_record_detail' && result && typeof result === 'object') {
      const detail = result as {
        source?: ChatSource
        raw?: Record<string, unknown>
        fieldLabels?: Record<string, string>
      }
      if (!detail.source) return null
      const values: Record<string, string | string[]> = {}
      for (const field of ['Source', '_valm_AssignedTo', '_valm_State', '_valm_LastModifyTime']) {
        const value = detail.raw?.[field]
        if (value !== undefined && value !== null) {
          values[field] = typeof value === 'object' ? JSON.stringify(value) : String(value)
        }
      }
      return {
        id: `record-detail:${detail.source.uid}`,
        title: '记录详情',
        description: '当前回答读取的具体记录',
        total: 1,
        fields: Object.keys(values),
        ...(detail.fieldLabels && Object.keys(detail.fieldLabels).length
          ? { fieldLabels: detail.fieldLabels }
          : {}),
        groups: [{
          name: '记录',
          count: 1,
          rows: [toRow({ source: detail.source, values })]
        }]
      }
    }

    return null
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
