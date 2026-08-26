import type {
  ChatDataView,
  ChatRequest,
  ChatResponse,
  ChatSource,
  ModelSettings,
  RecordDetail
} from '../shared/types'
import { AppDatabase } from './database'
import { ModelClient, type ModelMessage } from './model-client'
import {
  compactContextJson,
  compactContextValue,
  contextRefsFromResponse,
  createContextBudget,
  sanitizeContextText,
  selectHistoryMessages,
  selectWholeContextBlocks
} from './context-budget'
import {
  extractRequirementAnalysisIds,
  MAX_DIRECT_REQUIREMENT_IDS
} from './experts/requirement-analysis-agent'

interface DirectDataAnalysisClient {
  chat(input: {
    messages: ModelMessage[]
    think?: boolean
    forceThinking?: boolean
    temperature?: number
    numPredict?: number
    numCtx?: number
    timeoutMs?: number
  }): Promise<{ message?: ModelMessage }>
}

interface RequestedRecord {
  requestedId: string
  resolvedId: string
  detail: RecordDetail
}

const maxRecordText = 2_400
const maxRecordBlockChars = 5_000
const maxDataViewRows = 100
const directContextBudget = createContextBudget({
  contextTokens: 32_768,
  outputTokens: 2_400,
  safetyTokens: 2_048,
  systemTokens: 2_000,
  historyTokens: 2_000
})

const trimText = (value: unknown, limit = maxRecordText): string =>
  sanitizeContextText(value, limit)

const directRawFieldAllowList = new Set([
  'Source',
  'Status',
  'State',
  'StateName',
  'Owner',
  'User',
  'UserName',
  'Version',
  'Priority',
  'Severity',
  'Category',
  'Module',
  '_valm_AssignedTo',
  '_valm_State',
  '_valm_LastModifyTime',
  '_valm_Priority',
  '_valm_Module'
])

const isDescriptionOrAssetField = (key: string): boolean =>
  /description|normalized|rich.?text|html|image|picture|photo|avatar|thumbnail|base64|asset|blob|screenshot|attachment|fileurl|imageurl|url/i.test(
    key
  )

const pickSafeRawFields = (
  raw: Record<string, unknown>,
  question: string
): { fields: Record<string, unknown>; omitted: string[] } => {
  const questionText = question.toLocaleLowerCase()
  const candidates = Object.entries(raw).filter(([key]) => {
    if (isDescriptionOrAssetField(key)) return false
    if (directRawFieldAllowList.has(key)) return true
    return key.length <= 120 && questionText.includes(key.toLocaleLowerCase())
  })
  const fields: Record<string, unknown> = {}
  const omitted: string[] = []
  for (const [key, value] of candidates.slice(0, 12)) {
    fields[key] = compactContextValue(value, {
      maxStringChars: 640,
      maxArrayItems: 8,
      maxObjectEntries: 16,
      maxDepth: 2
    })
  }
  for (const [key] of candidates.slice(12)) omitted.push(key)
  return { fields, omitted }
}

const resolveRecord = (db: AppDatabase, requestedId: string): RequestedRecord | null => {
  const exact = db.findRecordByItemId(requestedId)
  const suffixMatches = !exact && /^\d+$/.test(requestedId)
    ? db.findRecordsByItemIdSuffix(requestedId)
    : []
  const row = exact ?? (suffixMatches.length === 1 ? suffixMatches[0] : null)
  if (!row) return null
  const detail = db.getRecord(row.uid, false)
  return detail ? { requestedId, resolvedId: row.itemId, detail } : null
}

const sourceOf = (record: RequestedRecord): ChatSource => ({
  uid: record.detail.uid,
  name: record.detail.name,
  nodeType: record.detail.nodeType,
  itemId: record.resolvedId,
  sourceType: 'record',
  snippet: trimText(record.detail.description || record.detail.normalizedText, 240)
})

interface DirectContextReport {
  requestedCount: number
  requestOmittedCount: number
  resolvedCount: number
  missingCount: number
  detailIncludedCount: number
  detailOmittedCount: number
  detailOmittedFields: number
}

const dataViewOf = (records: RequestedRecord[], report: DirectContextReport): ChatDataView => ({
  id: `direct-requirement-data:${records.map((record) => record.detail.uid).join(',')}`,
  title: '自动提取的需求数据',
  description: [
    '仅按用户提供的需求编号精确读取本地记录，未执行需求匹配、召回、重排或内置评分流程。',
    `请求 ${report.requestedCount} 条，成功 ${report.resolvedCount} 条，未找到 ${report.missingCount} 条，超出上限 ${report.requestOmittedCount} 条。`,
    `模型已发送 ${report.detailIncludedCount} 条完整证据块，省略 ${report.detailOmittedCount} 条、${report.detailOmittedFields} 个字段；省略内容可继续按编号查询。`
  ].join(' '),
  total: records.length,
  loadedRows: Math.min(records.length, maxDataViewRows),
  isPreview: records.length > maxDataViewRows,
  recordUids: records.map((record) => record.detail.uid),
  fields: ['itemId', 'name', 'description', 'nodeType', 'lastModifyTime'],
  fieldLabels: {
    itemId: '需求编号',
    name: '名称',
    description: '描述',
    nodeType: '类型',
    lastModifyTime: '最后修改时间'
  },
  groups: [{
    name: '按编号提取',
    count: records.length,
      rows: records.slice(0, maxDataViewRows).map((record) => ({
      uid: record.detail.uid,
      name: record.detail.name,
      nodeType: record.detail.nodeType,
      itemId: record.resolvedId,
      values: {
        itemId: record.resolvedId,
        name: record.detail.name,
        // The full description stays behind the record reference; the chat
        // message only needs a bounded preview for the data-view card.
        description: trimText(record.detail.description, 240),
        nodeType: record.detail.nodeType,
        lastModifyTime: record.detail.lastModifyTime
      }
    }))
  }]
})

const recordPrompt = (
  record: RequestedRecord,
  question: string
): { text: string; omittedFields: number } => {
  const description = trimText(record.detail.description, 1_200)
  const normalizedText = trimText(record.detail.normalizedText, 1_200)
  const includeNormalized = Boolean(normalizedText) &&
    (!description || (!description.includes(normalizedText) && !normalizedText.includes(description)))
  const safeRaw = pickSafeRawFields(record.detail.raw, question)
  let raw = safeRaw.fields
  let omittedFields = safeRaw.omitted.length
  const makeText = (): string => [
    `用户请求编号：${trimText(record.requestedId, 160)}`,
    `实际记录编号：${trimText(record.resolvedId, 160)}`,
    `UID：${trimText(record.detail.uid, 240)}`,
    `类型：${trimText(record.detail.nodeType, 120)}`,
    `名称：${trimText(record.detail.name, 360)}`,
    description ? `描述（已清洗）：${description}` : '',
    includeNormalized ? `清洗正文：${normalizedText}` : '',
    `最后修改时间：${trimText(record.detail.lastModifyTime, 120)}`,
    `原始字段：${compactContextJson(raw)}（安全投影；图片、HTML 和大字段已省略）`,
    omittedFields ? `[${omittedFields} 个字段因单条记录上下文预算已省略]` : ''
  ].filter(Boolean).join('\n')

  // Drop optional raw fields until the block fits. The resulting block is
  // always complete; no string slice is ever applied to JSON or a record.
  while (makeText().length > maxRecordBlockChars && Object.keys(raw).length) {
    const lastKey = Object.keys(raw).at(-1)
    if (!lastKey) break
    delete raw[lastKey]
    omittedFields += 1
  }
  return { text: makeText(), omittedFields }
}

const recordIndexLine = (record: RequestedRecord): string =>
  `${trimText(record.resolvedId, 160)} | UID ${trimText(record.detail.uid, 200)} | ${trimText(record.detail.name, 180)}`

const contextReportText = (report: DirectContextReport): string => [
  '上下文统计（contextStats；这是程序实际发送范围，不是记录缺失）：',
  `请求编号 ${report.requestedCount} 条；超出处理上限 ${report.requestOmittedCount} 条；成功解析 ${report.resolvedCount} 条；未找到 ${report.missingCount} 条。`,
  `完整详情证据块发送 ${report.detailIncludedCount} 条；因上下文预算省略 ${report.detailOmittedCount} 条，字段级省略 ${report.detailOmittedFields} 个。`,
  '模型只能依据已发送的完整证据块回答；对于省略详情，请明确提示用户按具体编号继续查询。'
].join('\n')

export class DirectRequirementDataAnalysisAgent {
  private readonly client: DirectDataAnalysisClient

  constructor(
    private readonly db: AppDatabase,
    settings: ModelSettings,
    client?: DirectDataAnalysisClient
  ) {
    this.client = client ?? new ModelClient(settings)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    const requestedIdsInput = request.extractedRequirementIds?.length
      ? request.extractedRequirementIds
      : extractRequirementAnalysisIds(request.question, MAX_DIRECT_REQUIREMENT_IDS)
    const requestedIds = requestedIdsInput.slice(0, MAX_DIRECT_REQUIREMENT_IDS)
    const requestOmittedCount = Math.max(0, requestedIdsInput.length - requestedIds.length)
    const records: RequestedRecord[] = []
    const missing: string[] = []
    const seen = new Set<string>()
    for (const requestedId of requestedIds) {
      const record = resolveRecord(this.db, requestedId)
      if (!record) {
        missing.push(requestedId)
        continue
      }
      if (seen.has(record.detail.uid)) continue
      seen.add(record.detail.uid)
      records.push(record)
    }

    const recordByRequestedId = new Map(records.map((record) => [record.requestedId, record]))
    const recordIndex = requestedIds.map((requestedId) => {
      const record = recordByRequestedId.get(requestedId)
      return record
        ? recordIndexLine(record)
        : `${trimText(requestedId, 160)} | 未找到本地记录`
    }).join('\n')
    const detailBlocks = records.map((record) => {
      const prompt = recordPrompt(record, request.question)
      return {
        id: `detail:${record.detail.uid}`,
        content: prompt.text,
        priority: 50,
        omittedFields: prompt.omittedFields
      }
    })
    const packed = selectWholeContextBlocks([
      {
        id: 'record-index',
        content: `完整编号索引（共 ${requestedIds.length} 条）：\n${recordIndex || '没有成功提取到任何记录。'}`,
        priority: 100,
        required: true
      },
      ...detailBlocks
    ], directContextBudget)
    const evidence = packed.text
    const keptDetailIds = new Set(packed.keptBlockIds.filter((id) => id.startsWith('detail:')))
    const detailOmittedCount = detailBlocks.length - keptDetailIds.size
    const detailOmittedFields = detailBlocks.reduce((total, block) => total + block.omittedFields, 0)
    const report: DirectContextReport = {
      requestedCount: requestedIds.length,
      requestOmittedCount,
      resolvedCount: records.length,
      missingCount: missing.length,
      detailIncludedCount: keptDetailIds.size,
      detailOmittedCount,
      detailOmittedFields
    }
    const missingText = missing.length ? `\n未找到的编号：${missing.map((id) => trimText(id, 160)).join('、')}` : ''
    const history = selectHistoryMessages(request.history, 4, 1_200)
    const response = await this.client.chat({
      messages: [
        {
          role: 'system',
          content: [
            '你是 VISSLM 的直接需求分析模型。',
            '程序已经按用户提供的需求编号精确提取了本地记录，下面的数据是唯一事实依据。',
            '请直接根据这些记录和用户问题进行分析，不要调用、复述或模拟任何内置需求匹配流程。',
            '禁止执行 Dense、BM25、向量召回、Cross-Encoder、候选匹配、关系分类、综合匹配度或缓存评分。',
            '可以比较记录的描述、原始字段、模块、状态、时间和业务目标；没有证据的内容明确标注不确定。',
            '回答使用中文，引用记录时使用实际需求编号或 UID；不要声称执行了未执行的工具或流程。'
          ].join('\n')
        },
        ...history.map((message): ModelMessage => ({
          role: message.role as ModelMessage['role'],
          content: message.content
        })),
        {
          role: 'user',
          content: [
            `当前问题：${request.question}`,
            contextReportText(report),
            '\n可供深入分析的完整证据块（编号索引始终优先保留）：',
            evidence || '没有成功提取到任何记录。',
            missingText
          ].join('\n')
        }
      ],
      think: true,
      forceThinking: undefined,
      temperature: 0.2,
      numPredict: 2400,
      numCtx: 32_768
    })
    const answer = response.message?.content?.trim()
    if (!answer) throw new Error('模型服务未返回有效需求分析')
    const responsePayload = {
      answer,
      sources: records.map(sourceOf),
      dataViews: records.length ? [dataViewOf(records, report)] : [],
      contextStats: {
        budgetTokens: directContextBudget.contextTokens,
        evidenceBudgetTokens: directContextBudget.evidenceTokens,
        evidenceUsedTokens: packed.estimatedTokens,
        ...report,
        ...(report.detailOmittedCount || report.requestOmittedCount
          ? {
              recoveryHint: '上下文已保留完整编号索引；请按具体需求编号发起下一轮查询以恢复被省略详情。'
            }
          : {})
      }
    }
    return {
      ...responsePayload,
      contextRefs: contextRefsFromResponse(responsePayload)
    }
  }
}
