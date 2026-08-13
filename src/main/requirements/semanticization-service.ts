import { createHash, randomUUID } from 'node:crypto'
import type {
  ModelSettings,
  RequirementSemanticizationProgress,
  RequirementSemanticizationStartInput,
  RequirementSemanticizationStartResult
} from '../../shared/types'
import { AppDatabase } from '../database'
import { ModelClient, type ModelChatInput } from '../model-client'
import {
  buildRequirementMatchingText,
  buildRequirementSemanticCard,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_SEMANTIC_FIELDS,
  requirementLexicalTerms,
  type RequirementAction,
  type RequirementSemanticCard,
  type RequirementSemanticFieldAssessment,
  type RequirementSemanticFieldName
} from './semantic-card'

export const REQUIREMENT_SEMANTIC_ANALYZER_VERSION = 'requirement-semantic-card-v2'

type SemanticAnalysisOutput = {
  recordUid: string
  fields: Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
  analysisSummary: string
}

export interface RequirementSemanticizationModelClient {
  chat(input: ModelChatInput): ReturnType<ModelClient['chat']>
}

const fieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence', 'evidence'],
  properties: {
    value: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string' }
  }
} as const

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recordUid', 'fields', 'analysisSummary'],
  properties: {
    recordUid: { type: 'string' },
    analysisSummary: { type: 'string' },
    fields: {
      type: 'object',
      additionalProperties: false,
      required: REQUIREMENT_SEMANTIC_FIELDS,
      properties: Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS.map((name) => [
        name,
        name === 'action'
          ? {
              ...fieldSchema,
              properties: {
                ...fieldSchema.properties,
                value: { type: 'string', enum: REQUIREMENT_ACTIONS }
              }
            }
          : fieldSchema
      ]))
    }
  }
} as const

const normalizedEvidence = (value: string): string => value
  .replace(/[\s\u00a0]+/g, ' ')
  .trim()

export const requirementSemanticModelSignature = (settings: ModelSettings): string => createHash('sha256')
  .update(JSON.stringify({
    source: settings.source,
    provider: settings.provider,
    baseUrl: settings.baseUrl.replace(/\/+$/, ''),
    model: settings.model,
    thinking: true
  }))
  .digest('hex')

export class RequirementSemanticizationService {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: AppDatabase,
    private readonly getSettings: () => ModelSettings,
    private readonly onProgress?: (progress: RequirementSemanticizationProgress) => void,
    private readonly createModelClient: (settings: ModelSettings) => RequirementSemanticizationModelClient =
      (settings) => new ModelClient(settings)
  ) {}

  context(): { analyzerVersion: string; modelSignature: string } {
    return {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(this.getSettings())
    }
  }

  start(input: RequirementSemanticizationStartInput): RequirementSemanticizationStartResult {
    const recordUids = [...new Set(input.recordUids.map((uid) => uid.trim()).filter(Boolean))]
    if (!recordUids.length) throw new Error('请选择至少一条需要 AI 语义化的数据')
    if (recordUids.length > 200) throw new Error('单次最多处理 200 条数据，请分批执行')
    const settings = this.getSettings()
    const context = {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }
    const accepted: string[] = []
    for (const recordUid of recordUids) {
      const contentHash = this.db.getRecordContentHash(recordUid)
      if (contentHash === null) continue
      if (this.db.claimRequirementSemanticCard({
        recordUid,
        contentHash,
        ...context,
        force: input.force
      })) accepted.push(recordUid)
    }
    const jobId = randomUUID()
    if (accepted.length) {
      this.queue = this.queue
        .catch(() => undefined)
        .then(() => this.runJob(jobId, accepted, settings))
    }
    return { jobId, accepted: accepted.length, skipped: recordUids.length - accepted.length }
  }

  private async runJob(jobId: string, recordUids: string[], settings: ModelSettings): Promise<void> {
    let completed = 0
    let failed = 0
    const total = recordUids.length
    const client = this.createModelClient(settings)
    for (const recordUid of recordUids) {
      this.emit({ jobId, recordUid, status: 'processing', completed, total, failed, message: '正在执行三阶段 AI 深度语义分析' })
      try {
        const record = this.db.getRecord(recordUid, false)
        if (!record) throw new Error('数据中心记录不存在或已被删除')
        const source = buildRequirementSemanticCard(record)
        if (!source.evidence.trim()) throw new Error('记录没有可供 AI 分析的文本内容')
        const initial = await this.analyze(client, recordUid, source, 'initial')
        const independent = await this.analyze(client, recordUid, source, 'independent')
        const adjudicated = await this.adjudicate(client, recordUid, source, initial, independent)
        const card = this.toCard(source, adjudicated)
        this.db.completeRequirementSemanticCard(recordUid, card, {
          initialSummary: initial.analysisSummary,
          independentSummary: independent.analysisSummary,
          adjudicationSummary: adjudicated.analysisSummary,
          completedWithAnalyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION
        })
        completed += 1
        this.emit({ jobId, recordUid, status: 'ready', completed, total, failed, message: 'AI 语义卡片已生成' })
      } catch (error) {
        failed += 1
        completed += 1
        const message = error instanceof Error ? error.message : String(error)
        this.db.failRequirementSemanticCard(recordUid, message)
        this.emit({ jobId, recordUid, status: 'failed', completed, total, failed, message })
      }
    }
    this.emit({
      jobId,
      status: 'completed',
      completed,
      total,
      failed,
      message: failed ? `处理完成，成功 ${completed - failed} 条，失败 ${failed} 条` : `处理完成，共 ${completed} 条`
    })
  }

  private async analyze(
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    pass: 'initial' | 'independent'
  ): Promise<SemanticAnalysisOutput> {
    const role = pass === 'initial'
      ? '你是资深需求工程师。请深入理解原文，生成可用于精准匹配的结构化语义，不要仅做关键词摘抄。'
      : '你是独立的需求审查专家。不要参考其他分析结论，从原文重新推理每个语义字段，主动识别歧义与缺失。'
    return this.callAndValidate(client, recordUid, source.evidence, {
      messages: [
        {
          role: 'system',
          content: [
            role,
            '只能依据给定原文分析，禁止补充原文不存在的业务事实。',
            '每个字段必须给出 value、0-1 confidence 和原文逐字证据 evidence；无法确认时 value/evidence 置空且 confidence 为 0。',
            `action 只能是：${REQUIREMENT_ACTIONS.join('、')}。`,
            'functionalObject 描述真正被操作的业务对象；behavior 描述用户可观察的完整目标行为；currentState 与 targetState 必须明确区分。',
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        { role: 'user', content: JSON.stringify({ recordUid, sourceText: source.evidence, analysisPass: pass }) }
      ]
    })
  }

  private async adjudicate(
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput
  ): Promise<SemanticAnalysisOutput> {
    return this.callAndValidate(client, recordUid, source.evidence, {
      messages: [
        {
          role: 'system',
          content: [
            '你是需求语义裁决专家。请回到原文，对两份独立分析逐字段核验后给出唯一终稿。',
            '一致不代表正确；必须检查业务对象、目标动作、现状/目标、触发、输入输出、约束和验收是否有原文支持。',
            '发生冲突时采用原文证据更直接、粒度更准确的结论；证据不足必须留空，不得折中拼接或猜测。',
            '每个非空 value 必须附原文逐字证据，confidence 为 0-1。action 只能使用规定枚举。',
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            recordUid,
            sourceText: source.evidence,
            analysisPass: 'adjudication',
            initial,
            independent
          })
        }
      ]
    })
  }

  private async callAndValidate(
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    sourceText: string,
    input: Pick<ModelChatInput, 'messages'>
  ): Promise<SemanticAnalysisOutput> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await client.chat({
          ...input,
          think: true,
          forceThinking: true,
          temperature: 0.05,
          numPredict: 6000,
          format: responseSchema as unknown as Record<string, unknown>
        })
        const content = response.message?.content?.trim()
        if (!content) throw new Error('模型未返回语义分析结果')
        return this.validateOutput(JSON.parse(content) as unknown, recordUid, sourceText)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`AI 语义分析校验失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private validateOutput(value: unknown, recordUid: string, sourceText: string): SemanticAnalysisOutput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('返回结果不是 JSON 对象')
    const output = value as Partial<SemanticAnalysisOutput>
    if (output.recordUid !== recordUid) throw new Error('返回的记录 UID 与请求不一致')
    if (!output.fields || typeof output.fields !== 'object') throw new Error('返回结果缺少 fields')
    const source = normalizedEvidence(sourceText)
    const fields = {} as Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
    for (const field of REQUIREMENT_SEMANTIC_FIELDS) {
      const item = output.fields[field]
      if (!item || typeof item !== 'object') throw new Error(`缺少语义字段 ${field}`)
      const valueText = typeof item.value === 'string' ? item.value.trim() : ''
      const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
      const confidence = Number(item.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`字段 ${field} 的置信度无效`)
      }
      if (field === 'action' && !REQUIREMENT_ACTIONS.includes(valueText as RequirementAction)) {
        throw new Error(`字段 action 使用了未知枚举 ${valueText}`)
      }
      if (valueText && !(field === 'action' && valueText === 'unknown') && !evidence) {
        throw new Error(`字段 ${field} 有值但没有原文证据`)
      }
      if (evidence && !source.includes(normalizedEvidence(evidence))) throw new Error(`字段 ${field} 的证据不在原文中`)
      fields[field] = { value: valueText, confidence, evidence }
    }
    if (!fields.behavior.value) throw new Error('语义卡片缺少核心 behavior')
    if (!fields.functionalObject.value) throw new Error('语义卡片缺少核心 functionalObject')
    return {
      recordUid,
      fields,
      analysisSummary: typeof output.analysisSummary === 'string'
        ? output.analysisSummary.trim().slice(0, 2000)
        : ''
    }
  }

  private toCard(source: RequirementSemanticCard, output: SemanticAnalysisOutput): RequirementSemanticCard {
    const value = (field: RequirementSemanticFieldName): string => output.fields[field].value
    const action = value('action') as RequirementAction
    const card: RequirementSemanticCard = {
      requirementType: value('requirementType'),
      productDomain: value('productDomain'),
      module: value('module'),
      functionalObject: value('functionalObject'),
      action,
      currentState: value('currentState'),
      targetState: value('targetState'),
      trigger: value('trigger'),
      input: value('input'),
      output: value('output'),
      behavior: value('behavior'),
      constraints: value('constraints'),
      acceptance: value('acceptance'),
      businessScene: value('businessScene'),
      evidence: source.evidence,
      matchingText: '',
      lexicalTerms: [],
      fieldAssessments: output.fields,
      analysisStatus: 'ai_adjudicated',
      analysisSummary: output.analysisSummary
    }
    card.matchingText = buildRequirementMatchingText(card)
    card.lexicalTerms = requirementLexicalTerms([source.evidence,
      card.functionalObject, card.currentState, card.targetState, card.trigger,
      card.input, card.output, card.constraints, card.acceptance, card.businessScene,
      card.productDomain, card.module, card.requirementType, card.behavior
    ])
    return card
  }

  private emit(progress: RequirementSemanticizationProgress): void {
    this.onProgress?.(progress)
  }
}
