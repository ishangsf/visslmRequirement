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
import type { KnowledgeSearchHit } from './knowledge'
import { KnowledgeService } from './knowledge'

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
    private readonly knowledge?: KnowledgeService
  ) {}

  async test(): Promise<ConnectionResult> {
    return new ModelClient(this.settings).test()
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    if (this.knowledge && !this.isStructuredDataQuestion(request.question)) {
      const response = await this.askWithKnowledge(request)
      if (response) return response
    }
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
      return await this.executePlanAndAnswer(request, plan)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `查询计划执行或结果校验失败，本次未生成猜测性回答。${message ? ` 原因：${message}` : ''}`
      )
    }
  }

  private isStructuredDataQuestion(question: string): boolean {
    return /总数|数量|多少|统计|排名|分布|前\s*\d+|大于|小于|不小于|不大于|等于|筛选|排序|字段|可视化/.test(question)
  }

  private async askWithKnowledge(request: ChatRequest): Promise<ChatResponse | null> {
    if (!this.knowledge) return null
    const hits = await this.knowledge.search(request.question, 8)
    if (!hits.length) {
      const stats = this.db.getKnowledgeStats(this.knowledge.modelVersion)
      if (!stats.indexedChunkCount) {
        return {
          answer: '当前知识库还没有完成可用索引，暂时无法基于本地资料回答。请先上传文档或完成数据采集，等待索引完成后再试。',
          sources: [],
          dataViews: []
        }
      }
      return {
        answer: '当前问题没有检索到足够的本地依据，因此我不会生成猜测性结论。可以换一个更具体的关键词，或先检查知识库文档是否已完成索引。',
        sources: [],
        dataViews: []
      }
    }
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
    return new ModelClient(this.settings).chat(input)
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
        raw: detail.raw
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
        title: `${field} 查询数据`,
        description: [
          `统计范围 ${Number(aggregate.totalRecords ?? 0)} 条`,
          `字段非空 ${Number(aggregate.matchedRecords ?? 0)} 条`,
          `空值 ${Number(aggregate.emptyRecords ?? 0)} 条`,
          aggregate.splitMultiValue ? '多值字段已拆分' : '',
          '每个分组最多展示 50 条'
        ].filter(Boolean).join(' · '),
        total: Number(aggregate.matchedRecords ?? 0),
        fields: [field],
        groups
      }
    }

    if (toolName === 'query_records_by_fields' && result && typeof result === 'object') {
      const query = result as {
        matchedCount?: number
        fields?: string[]
        records?: Array<{
          source: ChatSource
          values: Record<string, string | string[]>
        }>
      }
      if (!query.records?.length) return null
      const fields = query.fields ?? []
      return {
        id: `field-query:${fields.join(',') || 'records'}`,
        title: '属性查询数据',
        description: `共命中 ${Number(query.matchedCount ?? query.records.length)} 条，当前展示 ${query.records.length} 条`,
        total: Number(query.matchedCount ?? query.records.length),
        fields,
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
