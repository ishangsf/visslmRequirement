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

const maxRecordText = 5_000
const maxModelContext = 60_000

const trimText = (value: unknown, limit = maxRecordText): string => {
  const text = String(value ?? '').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
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

const dataViewOf = (records: RequestedRecord[]): ChatDataView => ({
  id: `direct-requirement-data:${records.map((record) => record.detail.uid).join(',')}`,
  title: '自动提取的需求数据',
  description: '仅按用户提供的需求编号精确读取本地记录，未执行需求匹配、召回、重排或内置评分流程。',
  total: records.length,
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
    rows: records.map((record) => ({
      uid: record.detail.uid,
      name: record.detail.name,
      nodeType: record.detail.nodeType,
      itemId: record.resolvedId,
      values: {
        itemId: record.resolvedId,
        name: record.detail.name,
        description: record.detail.description,
        nodeType: record.detail.nodeType,
        lastModifyTime: record.detail.lastModifyTime
      }
    }))
  }]
})

const recordPrompt = (record: RequestedRecord): string => {
  const raw = trimText(JSON.stringify(record.detail.raw, null, 2))
  return [
    `用户请求编号：${record.requestedId}`,
    `实际记录编号：${record.resolvedId}`,
    `UID：${record.detail.uid}`,
    `类型：${record.detail.nodeType}`,
    `名称：${record.detail.name}`,
    `描述：${trimText(record.detail.description)}`,
    `最后修改时间：${record.detail.lastModifyTime}`,
    `清洗正文：${trimText(record.detail.normalizedText)}`,
    `原始字段：${raw}`
  ].join('\n')
}

const recordIndexLine = (record: RequestedRecord): string => {
  const description = trimText(record.detail.description || record.detail.normalizedText, 320)
  return `${record.resolvedId} | UID ${record.detail.uid} | ${trimText(record.detail.name, 180)} | ${description}`
}

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
    const requestedIds = request.extractedRequirementIds?.length
      ? request.extractedRequirementIds
      : extractRequirementAnalysisIds(request.question, MAX_DIRECT_REQUIREMENT_IDS)
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

    const recordIndex = records.map(recordIndexLine).join('\n')
    const blocks = records.map(recordPrompt)
    const evidenceBudget = Math.max(20_000, maxModelContext - recordIndex.length - 2_000)
    let evidence = blocks.join('\n\n---\n\n')
    if (evidence.length > evidenceBudget) evidence = `${evidence.slice(0, evidenceBudget)}\n[后续记录详细字段因上下文限制未发送；上面的完整记录索引仍然有效]`
    const missingText = missing.length ? `\n未找到的编号：${missing.join('、')}` : ''
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
        ...(request.history ?? [])
          .filter((message) => message.role === 'user')
          .slice(-3)
          .map((message): ModelMessage => ({
          role: message.role,
          content: message.content
          })),
        {
          role: 'user',
          content: [
            `当前问题：${request.question}`,
            `\n已提取的本地记录索引（共 ${records.length} 条，以下列表完整）：`,
            recordIndex || '没有成功提取到任何记录。',
            '\n可供深入分析的记录详细字段：',
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
    return {
      answer,
      sources: records.map(sourceOf),
      dataViews: records.length ? [dataViewOf(records)] : []
    }
  }
}
