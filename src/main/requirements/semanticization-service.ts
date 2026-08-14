import { createHash, randomUUID } from 'node:crypto'
import type {
  ModelSettings,
  RequirementSemanticizationAnalysisTrace,
  RequirementSemanticizationControl,
  RequirementSemanticizationDivergence,
  RequirementSemanticizationProgress,
  RequirementSemanticizationRecentItem,
  RequirementSemanticizationStartInput,
  RequirementSemanticizationStartResult,
  RequirementSemanticizationTaskSnapshot,
  RequirementSemanticizationTraceEvent,
  RequirementSemanticizationTraceField,
  RequirementSemanticizationAnalysisStage,
  RequirementSemanticizationModelUsage
} from '../../shared/types'
import { AppDatabase, type RequirementSemanticizationCandidate } from '../database'
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

const activeTaskStatuses = new Set(['queued', 'running', 'pausing', 'paused', 'stopping'])
const recentItemLimit = 12
export const REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS = 15 * 60 * 1000

const semanticStagePredictBudget: Record<'initial' | 'independent' | 'adjudication', { deep: number; standard: number }> = {
  initial: { deep: 4800, standard: 2600 },
  independent: { deep: 4200, standard: 2200 },
  adjudication: { deep: 3200, standard: 1800 }
}

const semanticStageRetryBudget = (base: number): number => Math.min(8_000, Math.ceil(base * 1.5 / 200) * 200)

const knownSemanticFields: RequirementSemanticFieldName[] = ['requirementType', 'productDomain', 'module']
const confidenceForAdjudication = 0.78

const semanticStageLabels: Record<RequirementSemanticizationAnalysisStage, string> = {
  initial: '初步分析',
  independent: '独立复核',
  adjudication: '结果裁决',
  persisting: '校验与保存'
}

const isModelTimeout = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'TimeoutError') return true
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || /timed?\s*out|timeout|operation was aborted due to timeout/i.test(error.message)
}

class SemanticizationStoppedError extends Error {
  constructor() {
    super('语义化任务已停止')
  }
}

type SemanticOutputValidationReason =
  | 'invalid_result'
  | 'record_uid_mismatch'
  | 'missing_fields'
  | 'missing_field'
  | 'invalid_confidence'
  | 'invalid_action'
  | 'missing_evidence'
  | 'evidence_not_in_source'
  | 'missing_core'

interface SemanticOutputValidationIssue {
  message: string
  field?: RequirementSemanticFieldName
  reason: SemanticOutputValidationReason
}

class SemanticOutputValidationError extends Error {
  readonly fields: RequirementSemanticFieldName[]

  constructor(
    readonly issues: SemanticOutputValidationIssue[],
    readonly validFields: Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>> = {}
  ) {
    super(issues.map((issue) => issue.message).join('；'))
    this.name = 'SemanticOutputValidationError'
    const invalidFields = new Set(issues.flatMap((issue) => issue.field ? [issue.field] : []))
    this.fields = REQUIREMENT_SEMANTIC_FIELDS.filter((field) => invalidFields.has(field))
  }
}

const semanticValidationMaxAttempts = 4

const coreSemanticFields = new Set<RequirementSemanticFieldName>(['functionalObject', 'behavior'])

const semanticFieldRepairGuidance: Partial<Record<RequirementSemanticFieldName, string>> = {
  functionalObject: 'functionalObject 必须是用户实际查看、创建、修改、比较或配置的业务对象，不能只写宽泛模块名。',
  action: `action.value 必须从以下枚举选择：${REQUIREMENT_ACTIONS.join('、')}；有明确动作时 evidence 复制原文中的动作或目标表述；没有可复制的动作证据时必须返回 value="unknown"、evidence=""、confidence=0。`,
  currentState: 'currentState 只描述原文明确表达的现状、问题或已有行为。',
  targetState: 'targetState 只描述原文明确要求达到的目标状态。',
  behavior: 'behavior 必须表达用户可观察的完整目标行为，包括对什么对象做什么以及产生什么结果，不能留空，也不能只写模块名或抽象意图。',
  constraints: 'constraints 只保留原文明示的限制、条件或业务规则。',
  acceptance: 'acceptance 必须是可以从原文确认的预期结果或验收表现。'
}

const fieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence', 'evidence'],
  properties: {
    value: { type: 'string', description: '归一化后的语义结论；可以不在 sourceText 中逐字出现' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'string', description: '必须直接复制 sourceText 中逐字连续出现的原文片段；不得改写、概括或翻译' }
  }
} as const

const fieldSchemaFor = (name: RequirementSemanticFieldName) => {
  if (name === 'action') return {
      ...fieldSchema,
      properties: {
        ...fieldSchema.properties,
        value: { type: 'string', enum: REQUIREMENT_ACTIONS }
      }
    }
  if (coreSemanticFields.has(name)) return {
    ...fieldSchema,
    properties: {
      ...fieldSchema.properties,
      value: {
        ...fieldSchema.properties.value,
        minLength: 1,
        description: '核心语义字段不能为空；必须由模型根据名称或描述形成归一化结论'
      },
      evidence: {
        ...fieldSchema.properties.evidence,
        minLength: 1,
        description: '核心语义字段必须复制 sourceText 中逐字连续出现的非空原文片段'
      }
    }
  }
  return fieldSchema
}

const responseSchemaFor = (fields: readonly RequirementSemanticFieldName[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['recordUid', 'fields', 'analysisSummary'],
  properties: {
    recordUid: { type: 'string' },
    analysisSummary: { type: 'string' },
    fields: {
      type: 'object',
      additionalProperties: false,
      required: fields,
      properties: Object.fromEntries(fields.map((name) => [name, fieldSchemaFor(name)]))
    }
  }
} as const)

interface SemanticCallOptions {
  responseFields?: readonly RequirementSemanticFieldName[]
  fallbackFields?: Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>>
}

const normalizedEvidence = (value: string): string => value
  .replace(/[\s\u00a0]+/g, ' ')
  .trim()

const sourceEvidenceSegments = (sourceText: string): string[] => sourceText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .slice(0, 120)

const modelPromptChars = (messages: ModelChatInput['messages']): number => messages
  .reduce((total, message) => total + message.content.length, 0)

const dynamicModelContext = (
  messages: ModelChatInput['messages'],
  numPredict: number
): number => {
  // Keep a safety margin for JSON schema overhead and multilingual tokenization,
  // while avoiding a 32K KV cache for ordinary short requirements.
  const estimatedPromptTokens = Math.ceil(modelPromptChars(messages) / 1.5)
  const required = estimatedPromptTokens + numPredict + 1_024
  return Math.min(32_768, Math.max(8_192, Math.ceil(required / 1_024) * 1_024))
}

const mergeModelUsage = (
  previous: RequirementSemanticizationModelUsage | undefined,
  current: RequirementSemanticizationModelUsage | undefined
): RequirementSemanticizationModelUsage | undefined => {
  if (!previous) return current
  if (!current) return previous
  const sum = (left?: number, right?: number): number | undefined => {
    if (left === undefined) return right
    if (right === undefined) return left
    return left + right
  }
  return {
    promptTokens: sum(previous.promptTokens, current.promptTokens),
    completionTokens: sum(previous.completionTokens, current.completionTokens),
    promptDurationMs: sum(previous.promptDurationMs, current.promptDurationMs),
    completionDurationMs: sum(previous.completionDurationMs, current.completionDurationMs),
    totalDurationMs: sum(previous.totalDurationMs, current.totalDurationMs),
    loadDurationMs: sum(previous.loadDurationMs, current.loadDurationMs)
  }
}

export const requirementSemanticModelSignature = (settings: ModelSettings): string => createHash('sha256')
  .update(JSON.stringify({
    source: settings.source,
    provider: settings.provider,
    baseUrl: settings.baseUrl.replace(/\/+$/, ''),
    model: settings.model,
    thinking: true,
    forceThinking: true
  }))
  .digest('hex')

export class RequirementSemanticizationService {
  private task: RequirementSemanticizationTaskSnapshot | null = null
  private candidates: RequirementSemanticizationCandidate[] = []
  private resumeWaiters: Array<() => void> = []
  private currentTrace: RequirementSemanticizationAnalysisTrace | null = null

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
    if (this.task && activeTaskStatuses.has(this.task.status)) {
      throw new Error('当前已有 AI 语义化任务，请先等待完成或终止当前任务')
    }
    if (input.scope !== undefined && input.scope !== 'selected' && input.scope !== 'all_unready') {
      throw new Error('未知的 AI 语义化任务范围')
    }
    const settings = this.getSettings()
    const deepThinking = input.deepThinking !== false
    const context = {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }
    let available = 0
    let candidates: RequirementSemanticizationCandidate[] = []
    if (input.scope === 'all_unready') {
      const result = this.db.listRequirementSemanticizationCandidates(context)
      available = result.available
      candidates = result.candidates
    } else {
      const recordUids = [...new Set((input.recordUids ?? []).map((uid) => uid.trim()).filter(Boolean))]
      if (!recordUids.length) throw new Error('请选择至少一条需要 AI 语义化的数据')
      available = recordUids.length
      for (const recordUid of recordUids) {
        const record = this.db.getRecord(recordUid, false)
        const contentHash = this.db.getRecordContentHash(recordUid)
        if (!record || contentHash === null) continue
        const state = this.db.getRequirementSemanticCardState(recordUid)
        if (state?.status === 'processing') continue
        const validReady = this.db.getReadyRequirementSemanticCard({ recordUid, contentHash, ...context })
        if (validReady && !input.force) continue
        candidates.push({ recordUid, itemId: record.itemId, name: record.name, contentHash })
      }
    }
    const jobId = randomUUID()
    if (!candidates.length) {
      const timestamp = new Date().toISOString()
      this.candidates = []
      this.task = {
        jobId,
        status: 'completed',
        currentStage: 'idle',
        total: 0,
        available,
        completed: 0,
        succeeded: 0,
        failed: 0,
        remaining: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
        message: available > 0 ? `没有新任务，已跳过 ${available} 条记录` : '当前没有需要生成或更新的 AI 语义卡片',
        recentItems: [],
        deepThinking
      }
      this.emit()
      return { jobId, accepted: 0, skipped: available, available }
    }
    const timestamp = new Date().toISOString()
    this.candidates = candidates
    this.task = {
      jobId,
      status: 'queued',
      currentStage: 'queued',
      total: candidates.length,
      available,
      completed: 0,
      succeeded: 0,
      failed: 0,
      remaining: candidates.length,
      startedAt: timestamp,
      updatedAt: timestamp,
      message: `已创建任务，将逐条处理 ${candidates.length} 条记录`,
      recentItems: [],
      deepThinking
    }
    this.emit()
    void this.runJob(settings, deepThinking).catch((error) => {
      if (!this.task || this.task.status === 'stopped') return
      this.finishStopped(`任务异常结束：${error instanceof Error ? error.message : String(error)}`)
    })
    return {
      jobId,
      accepted: candidates.length,
      skipped: Math.max(0, available - candidates.length),
      available
    }
  }

  getTask(): RequirementSemanticizationTaskSnapshot | null {
    return this.task ? structuredClone(this.task) : null
  }

  control(action: RequirementSemanticizationControl): RequirementSemanticizationTaskSnapshot | null {
    if (action !== 'pause' && action !== 'resume' && action !== 'stop') {
      throw new Error('未知的 AI 语义化任务控制指令')
    }
    if (!this.task) return null
    if (action === 'pause') {
      if (this.task.status === 'queued') {
        this.task.status = 'paused'
        this.task.message = '任务已暂停，可随时继续'
      } else if (this.task.status === 'running') {
        this.task.status = 'pausing'
        this.task.message = '正在等待当前 AI 阶段安全结束后暂停'
      }
    } else if (action === 'resume') {
      if (this.task.status === 'paused' || this.task.status === 'pausing') {
        this.task.status = 'running'
        this.task.message = '任务已继续，按记录逐条执行'
        this.resolveWaiters()
      }
    } else if (activeTaskStatuses.has(this.task.status)) {
      this.task.status = 'stopping'
      this.task.message = this.task.currentRecord
        ? '正在等待当前 AI 阶段安全结束后停止'
        : '正在停止任务'
      this.resolveWaiters()
    }
    this.touch()
    this.emit()
    return this.getTask()
  }

  private async runJob(settings: ModelSettings, deepThinking: boolean): Promise<void> {
    if (!this.task) return
    if (this.task.status === 'stopping' || this.task.status === 'stopped') {
      this.finishStopped()
      return
    }
    const client = this.createModelClient(settings)
    this.task.status = this.task.status === 'paused' ? 'paused' : 'running'
    this.task.currentStage = 'idle'
    this.task.message = this.task.status === 'paused' ? '任务已暂停，可随时继续' : '任务已开始，按记录逐条执行'
    this.touch()
    this.emit()
    for (let index = 0; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index]
      try {
        await this.checkpoint()
      } catch (error) {
        if (error instanceof SemanticizationStoppedError) break
        throw error
      }
      if (!this.task) return
      const currentHash = this.db.getRecordContentHash(candidate.recordUid)
      if (currentHash === null || !this.db.claimRequirementSemanticCard({
        recordUid: candidate.recordUid,
        contentHash: currentHash,
        analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
        modelSignature: requirementSemanticModelSignature(settings),
        force: true
      })) {
        this.addResult(candidate, 'failed', 0, '记录状态已变化，未能开始处理')
        this.emit(candidate.recordUid, 'failed')
        continue
      }
      const startedAt = Date.now()
      this.task.currentRecord = {
        uid: candidate.recordUid,
        itemId: candidate.itemId,
        name: candidate.name,
        index: index + 1
      }
      this.task.status = 'running'
      this.task.currentStage = 'initial'
      this.task.message = `正在分析 ${candidate.itemId || candidate.name}`
      this.currentTrace = this.createTrace(candidate.recordUid, settings, deepThinking)
      this.startTraceStage('initial')
      this.touch()
      this.emit(candidate.recordUid, 'processing')
      try {
        const record = this.db.getRecord(candidate.recordUid, false)
        if (!record) throw new Error('数据中心记录不存在或已被删除')
        const source = buildRequirementSemanticCard(record)
        if (!source.evidence.trim()) throw new Error('记录没有可供 AI 分析的文本内容')
        const initial = this.enforceKnownFields(source, await this.analyze(client, candidate.recordUid, source, 'initial'))
        this.updateTraceStageOutput('initial', initial)
        await this.checkpoint()
        this.setStage('independent', '正在执行独立语义复核')
        const independent = this.enforceKnownFields(source, await this.analyze(client, candidate.recordUid, source, 'independent'))
        this.updateTraceStageOutput('independent', independent)
        await this.checkpoint()
        this.setStage('adjudication', '正在裁决两轮分析结果')
        const divergence = this.compareDivergence(initial, independent)
        const adjudicationFields = this.adjudicationFields(initial, independent, divergence)
        // Adjudication is always a real third model stage. Even when the first
        // two analyses agree, the final pass must return to the source and
        // confirm that the agreement is evidence-backed before persistence.
        const adjudicated = this.enforceKnownFields(
          source,
          await this.adjudicate(client, candidate.recordUid, source, initial, independent, adjudicationFields)
        )
        this.updateTraceStageOutput('adjudication', adjudicated)
        await this.checkpoint()
        this.setStage('persisting', '正在校验并保存语义卡片')
        const card = this.toCard(source, adjudicated)
        this.completeTraceStage('persisting', adjudicated, '结构化字段、置信度和原文证据校验通过，正在写入语义资产')
        this.db.completeRequirementSemanticCard(candidate.recordUid, card, this.finishTrace('completed'))
        this.addResult(candidate, 'ready', Date.now() - startedAt)
        this.emit(candidate.recordUid, 'ready')
      } catch (error) {
        if (error instanceof SemanticizationStoppedError) {
          this.finishStopped()
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        this.failTraceStage(message)
        this.db.failRequirementSemanticCard(candidate.recordUid, message, this.finishTrace('failed'))
        this.addResult(candidate, 'failed', Date.now() - startedAt, message)
        this.emit(candidate.recordUid, 'failed')
      }
    }
    if (!this.task) return
    if (this.getTask()?.status === 'stopping') {
      this.finishStopped()
      return
    }
    this.task.status = 'completed'
    this.task.currentStage = 'idle'
    this.task.currentRecord = undefined
    this.task.message = this.task.failed
      ? `处理完成，成功 ${this.task.succeeded} 条，失败 ${this.task.failed} 条`
      : `处理完成，共 ${this.task.succeeded} 条`
    this.touch()
    this.emit()
  }

  private async checkpoint(): Promise<void> {
    // Yield before reading task control so pause/stop requests queued in the same turn
    // are observed before another AI stage or record can begin.
    await Promise.resolve()
    if (!this.task) throw new SemanticizationStoppedError()
    if (this.task.status === 'stopping' || this.task.status === 'stopped') {
      throw new SemanticizationStoppedError()
    }
    if (this.task.status !== 'pausing' && this.task.status !== 'paused') return
    this.task.status = 'paused'
    this.task.message = '任务已暂停，可随时继续'
    this.touch()
    this.emit()
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    const resumedStatus = this.getTask()?.status
    if (!this.task || resumedStatus === 'stopping' || resumedStatus === 'stopped') {
      throw new SemanticizationStoppedError()
    }
  }

  private setStage(stage: RequirementSemanticizationTaskSnapshot['currentStage'], message: string): void {
    if (!this.task) return
    this.task.currentStage = stage
    this.task.message = message
    if (stage === 'initial' || stage === 'independent' || stage === 'adjudication' || stage === 'persisting') {
      this.startTraceStage(stage)
    }
    this.touch()
    this.emit(this.task.currentRecord?.uid, 'processing')
  }

  private addResult(
    candidate: RequirementSemanticizationCandidate,
    status: RequirementSemanticizationRecentItem['status'],
    durationMs: number,
    error?: string
  ): void {
    if (!this.task) return
    this.task.completed += 1
    this.task.succeeded += status === 'ready' ? 1 : 0
    this.task.failed += status === 'failed' ? 1 : 0
    this.task.remaining = Math.max(0, this.task.total - this.task.completed)
    this.task.recentItems = [{
      uid: candidate.recordUid,
      itemId: candidate.itemId,
      name: candidate.name,
      status,
      ...(error ? { error } : {}),
      durationMs
    }, ...this.task.recentItems].slice(0, recentItemLimit)
    this.task.currentRecord = undefined
    this.task.currentStage = 'idle'
    this.task.message = status === 'ready'
      ? `${candidate.itemId || candidate.name} 语义卡片已生成`
      : `${candidate.itemId || candidate.name} 处理失败：${error ?? '未知错误'}`
    this.touch()
  }

  private finishStopped(message?: string): void {
    if (!this.task) return
    const currentUid = this.task.currentRecord?.uid
    if (currentUid) this.db.releaseRequirementSemanticCard(currentUid, this.finishTrace('stopped'))
    this.task.status = 'stopped'
    this.task.currentStage = 'idle'
    this.task.currentRecord = undefined
    this.task.remaining = Math.max(0, this.task.total - this.task.completed)
    this.task.message = message ?? `任务已停止，已完成 ${this.task.completed} 条，剩余 ${this.task.remaining} 条未处理`
    this.touch()
    this.emit()
  }

  private resolveWaiters(): void {
    const waiters = this.resumeWaiters.splice(0)
    waiters.forEach((resolve) => resolve())
  }

  private touch(): void {
    if (this.task) this.task.updatedAt = new Date().toISOString()
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
    return this.callAndValidate(client, recordUid, source.evidence, pass, {
      messages: [
        {
          role: 'system',
          content: [
            role,
            '只能依据给定原文分析，禁止补充原文不存在的业务事实。',
            ...knownSemanticFields.flatMap((field) => source[field]
              ? [`${field} 已由数据中心明确提供，必须原样保留为 value：${source[field]}；不要重新推断或改写。`]
              : []),
            'value 是归一化后的语义结论，不要求在原文中逐字出现；evidence 是支撑该结论的原文证据，必须从 sourceText 复制一个逐字连续片段，禁止改写、概括或翻译。',
            '例如 action.value 可以是 add_capability，但 action.evidence 应复制原文中的“新增”“支持”或对应目标表述；requirementType/productDomain 等字段也必须复制 sourceText 中实际出现的值或标签片段。',
            '每个字段必须给出 value、0-1 confidence 和 evidence；找不到可逐字复制的证据时，该字段 value/evidence 置空且 confidence 为 0。',
            'action 是唯一例外：找不到可逐字复制的动作证据时，返回 action.value="unknown"、action.evidence=""、action.confidence=0，不得为满足枚举约束编造动作。',
            'functionalObject 和 behavior 是核心字段，不能留空。正文缺失或只有图片时，必须深度理解“名称：”行：functionalObject 提炼名称中真正被操作或出现异常的业务对象，behavior 归一化名称表达的用户可观察需求或问题；两者的 evidence 都可以直接复制完整名称文本。',
            `action 只能是：${REQUIREMENT_ACTIONS.join('、')}。`,
            'functionalObject 描述真正被操作的业务对象；behavior 描述用户可观察的完整目标行为；currentState 与 targetState 必须明确区分。',
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        { role: 'user', content: JSON.stringify({ recordUid, sourceText: source.evidence, analysisPass: pass }) }
      ]
    }, source)
  }

  private async adjudicate(
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput,
    focusFields: RequirementSemanticFieldName[]
  ): Promise<SemanticAnalysisOutput> {
    const divergence = this.compareDivergence(initial, independent)
    if (divergence.hasDivergence) this.recordTraceEvent({
      stage: 'adjudication',
      kind: 'divergence',
      message: '初步分析与独立复核存在字段分歧，已交由最终裁决',
      divergence
    })
    return this.callAndValidate(client, recordUid, source.evidence, 'adjudication', {
      messages: [
        {
          role: 'system',
          content: [
            '你是需求语义裁决专家。请回到原文，对两份独立分析逐字段核验后给出唯一终稿。',
            '一致不代表正确；必须检查业务对象、目标动作、现状/目标、触发、输入输出、约束和验收是否有原文支持。',
            '发生冲突时采用原文证据更直接、粒度更准确的结论；证据不足必须留空，不得折中拼接或猜测。',
            'value 是归一化语义，evidence 必须从 sourceText 复制逐字连续片段，不能把归一化 value、改写句或概括句当作 evidence。',
            '每个非空 value 必须附原文逐字证据，找不到则该字段置空；confidence 为 0-1。action 只能使用规定枚举。',
            `只输出重点裁决字段：${focusFields.join('、')}；稳定字段由服务端自动合并，请不要在 fields 中重复输出。`,
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            recordUid,
            sourceText: source.evidence,
            analysisPass: 'adjudication',
            stableFields: Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS
              .filter((field) => !focusFields.includes(field))
              .map((field) => [field, initial.fields[field]])),
            divergentFields: Object.fromEntries(focusFields.map((field) => [field, {
              initial: initial.fields[field],
              independent: independent.fields[field]
            }]))
          })
        }
      ]
    }, source, {
      responseFields: focusFields,
      fallbackFields: Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS
        .filter((field) => !focusFields.includes(field))
        .map((field) => [field, initial.fields[field]]))
    })
  }

  private enforceKnownFields(
    source: RequirementSemanticCard,
    output: SemanticAnalysisOutput
  ): SemanticAnalysisOutput {
    const fields = { ...output.fields }
    knownSemanticFields.forEach((field) => {
      const value = source[field].trim()
      if (!value) return
      const sourceAssessment = source.fieldAssessments[field]
      fields[field] = {
        value,
        confidence: sourceAssessment?.confidence ?? 1,
        evidence: sourceAssessment?.evidence || value
      }
    })
    return { ...output, fields }
  }

  private updateTraceStageOutput(
    stage: 'initial' | 'independent' | 'adjudication',
    output: SemanticAnalysisOutput
  ): void {
    const traceStage = this.currentTrace?.stages[stage]
    if (!traceStage || !this.currentTrace) return
    traceStage.fields = this.toTraceFields(output.fields)
    traceStage.summary = output.analysisSummary
    if (this.task) this.task.analysisTrace = structuredClone(this.currentTrace)
  }

  private adjudicationFields(
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput,
    divergence: RequirementSemanticizationDivergence
  ): RequirementSemanticFieldName[] {
    const fields = new Set<RequirementSemanticFieldName>(divergence.fields.map((item) => item.field as RequirementSemanticFieldName))
    REQUIREMENT_SEMANTIC_FIELDS.forEach((field) => {
      const left = initial.fields[field]
      const right = independent.fields[field]
      const hasSemanticValue = Boolean(left.value || right.value)
      const actionNeedsReview = field === 'action' &&
        Boolean(left.value || right.value) &&
        (left.value === 'unknown' || right.value === 'unknown')
      if ((hasSemanticValue && Math.min(left.confidence, right.confidence) < confidenceForAdjudication) ||
        actionNeedsReview) {
        fields.add(field)
      }
    })
    return REQUIREMENT_SEMANTIC_FIELDS.filter((field) => fields.has(field))
  }

  private async callAndValidate(
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    sourceText: string,
    stage: RequirementSemanticizationAnalysisStage,
    input: Pick<ModelChatInput, 'messages'>,
    source?: RequirementSemanticCard,
    options: SemanticCallOptions = {}
  ): Promise<SemanticAnalysisOutput> {
    let lastError: unknown
    let messages = input.messages
    let lockedFields: Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>> = {
      ...(options.fallbackFields ?? {})
    }
    let responseFields = options.responseFields ?? REQUIREMENT_SEMANTIC_FIELDS
    for (let attempt = 0; attempt < semanticValidationMaxAttempts; attempt += 1) {
      const traceStage = this.currentTrace?.stages[stage]
      if (traceStage) {
        traceStage.attempts = Math.max(traceStage.attempts, attempt + 1)
        if (this.task && this.currentTrace) this.task.analysisTrace = structuredClone(this.currentTrace)
      }
      let response: Awaited<ReturnType<RequirementSemanticizationModelClient['chat']>>
      let usedNumPredict = 0
      try {
        const stageBudget = semanticStagePredictBudget[stage === 'persisting' ? 'adjudication' : stage]
        const baseNumPredict = this.task?.deepThinking === false ? stageBudget.standard : stageBudget.deep
        const numPredict = attempt === 0 ? baseNumPredict : semanticStageRetryBudget(baseNumPredict)
        usedNumPredict = numPredict
        response = await client.chat({
          messages,
          think: this.task?.deepThinking !== false,
          forceThinking: this.task?.deepThinking !== false,
          stream: true,
          temperature: 0.05,
          numPredict,
          numCtx: dynamicModelContext(messages, numPredict),
          timeoutMs: REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
          format: responseSchemaFor(responseFields) as unknown as Record<string, unknown>
        })
        if (this.currentTrace?.stages[stage]) {
          this.currentTrace.stages[stage]!.modelUsage = mergeModelUsage(
            this.currentTrace.stages[stage]!.modelUsage,
            response.usage
          )
          if (this.task && this.currentTrace) this.task.analysisTrace = structuredClone(this.currentTrace)
        }
      } catch (error) {
        if (error instanceof SemanticizationStoppedError) throw error
        const stageLabel = semanticStageLabels[stage]
        const timeoutMinutes = Math.round(REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS / 60_000)
        const message = isModelTimeout(error)
          ? `${stageLabel}阶段模型调用超时：超过 ${timeoutMinutes} 分钟仍未完成。请检查模型服务负载，或在“大模型配置”中选择响应更快、上下文能力更强的模型后重试。`
          : `${stageLabel}阶段模型调用失败：${error instanceof Error ? error.message : String(error)}`
        this.recordTraceEvent({
          stage,
          kind: 'model_error',
          message: message.slice(0, 500),
          attempt: attempt + 1,
          maxAttempts: semanticValidationMaxAttempts
        })
        throw new Error(message)
      }
      try {
        const content = response.message?.content?.trim()
        if (!content) throw new Error('模型未返回语义分析结果')
        if (response.done_reason === 'length') {
          throw new Error(`模型输出达到 ${usedNumPredict} Token 上限，尚未确认结构化结果完整性`)
        }
        const parsed = JSON.parse(content) as unknown
        const merged = Object.keys(lockedFields).length ? this.mergeFallbackFields(parsed, lockedFields) : parsed
        const normalized = source ? this.applyKnownFieldsToModelOutput(merged, source) : merged
        const output = this.validateOutput(normalized, recordUid, sourceText)
        this.recordTraceEvent({
          stage,
          kind: 'validation_passed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出已通过 JSON 结构、字段、置信度和原文证据校验`,
          attempt: attempt + 1,
          maxAttempts: semanticValidationMaxAttempts
        })
        this.completeTraceStage(stage, output)
        return output
      } catch (error) {
        lastError = error
        this.recordTraceEvent({
          stage,
          kind: 'validation_failed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出未通过校验：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          attempt: attempt + 1,
          maxAttempts: semanticValidationMaxAttempts
        })
        if (attempt === 0) {
          await this.checkpoint()
          const validationError = error instanceof Error ? error.message : String(error)
          const previousContent = response.message?.content?.trim() ?? ''
          messages = [
            ...input.messages,
            ...(previousContent ? [{ role: 'assistant' as const, content: previousContent }] : []),
            {
              role: 'user' as const,
              content: JSON.stringify({
                task: 'repair_semantic_output',
                recordUid,
                sourceText,
                analysisPass: stage,
                validationError,
                instructions: [
                  '只修复校验错误并重新输出完整 JSON 对象，不要输出解释或 Markdown。',
                  'value 是归一化语义结论，可以不在原文逐字出现。',
                  '每个 evidence 必须直接复制 sourceText 中的一个逐字连续片段，禁止改写、概括、翻译或拼接多个不连续片段。',
                  '如果 sourceText 中找不到能支撑某字段的逐字证据，将该字段 value 和 evidence 置空，confidence 设为 0。',
                  `action.value 仍只能是：${REQUIREMENT_ACTIONS.join('、')}；有动作依据时 action.evidence 复制原文中的动作或目标表述，没有动作依据时必须返回 action.value="unknown"、action.evidence=""、action.confidence=0。`,
                  'functionalObject 和 behavior 是核心字段，不能置空；正文没有可用文字时，回到“名称：”行深度分析，value 可归一化，evidence 直接复制名称文本。'
                ]
              })
            }
          ]
          this.recordTraceEvent({
            stage,
            kind: 'retry',
            message: `${stage} 阶段将携带具体校验错误和原文证据规则进行第 2 次修复调用`,
            attempt: 2,
            maxAttempts: semanticValidationMaxAttempts
          })
        } else if (attempt === 1 && error instanceof SemanticOutputValidationError && error.fields.length > 0) {
          await this.checkpoint()
          lockedFields = {
            ...lockedFields,
            ...error.validFields
          }
          responseFields = error.fields
          const previousContent = response.message?.content?.trim() ?? ''
          const currentInvalidFields = this.modelFieldsFromContent(previousContent, error.fields)
          messages = [{
            role: 'system' as const,
            content: [
              '你是需求语义卡片的最终纠错专家。只依据 sourceText 深度分析指定失败字段。',
              '不得使用规则猜测、常识补充或原文之外的业务事实；必须由你重新理解原文后输出语义字段。',
              '只输出严格符合 JSON Schema 的 JSON，不要输出解释或 Markdown。',
              'value 是归一化语义结论；evidence 必须直接复制 sourceText 中一个逐字连续片段，不得改写、概括、翻译或拼接。',
              '如果普通字段没有原文支持，value/evidence 置空且 confidence 为 0；action 没有原文动作依据时必须返回 unknown、空 evidence 和 0 置信度。',
              'functionalObject 和 behavior 是核心字段，必须回到名称与描述中识别最直接、最具体的原文依据；正文缺失或只有图片时，深度理解名称并直接复制名称文本作为 evidence。'
            ].join('\n')
          }, {
            role: 'user' as const,
            content: JSON.stringify({
              task: 'repair_invalid_semantic_fields',
              recordUid,
              analysisPass: stage,
              sourceText,
              sourceEvidenceSegments: sourceEvidenceSegments(sourceText),
              invalidFields: error.fields,
              validationIssues: error.issues,
              previousInvalidFields: currentInvalidFields,
              lockedValidFields: lockedFields,
              instructions: error.fields.map((field) => semanticFieldRepairGuidance[field] ??
                `${field} 必须准确表达 sourceText 中对应语义；非空 value 必须附逐字连续原文 evidence。`)
            })
          }]
          this.recordTraceEvent({
            stage,
            kind: 'retry',
            message: `${stage} 阶段只重新分析失败字段 ${error.fields.join('、')}，其余已验证字段保持锁定`,
            attempt: 3,
            maxAttempts: semanticValidationMaxAttempts
          })
        } else if (attempt === 2 && error instanceof SemanticOutputValidationError && error.fields.length > 0) {
          await this.checkpoint()
          lockedFields = {
            ...lockedFields,
            ...error.validFields
          }
          responseFields = error.fields
          const previousContent = response.message?.content?.trim() ?? ''
          messages = [{
            role: 'system' as const,
            content: [
              '你是需求语义卡片的最终证据校准专家。前三次输出仍有少数字段不合法，请对失败字段重新独立分析。',
              '只输出失败字段，禁止重复或修改 lockedValidFields。不要解释，不要 Markdown。',
              '每个 evidence 必须从 sourceEvidenceSegments 中选择一个字符串并逐字复制；不得改写、截断、拼接或创造新句子。',
              'functionalObject 和 behavior 必须非空：可以根据名称文本形成归一化 value，并把完整“名称：...”行或其中连续出现的名称文本作为 evidence。',
              'action 没有明确动作证据时，必须输出 value="unknown"、confidence=0、evidence=""；不得输出无证据的其他枚举。'
            ].join('\n')
          }, {
            role: 'user' as const,
            content: JSON.stringify({
              task: 'final_repair_invalid_semantic_fields',
              recordUid,
              analysisPass: stage,
              invalidFields: error.fields,
              validationIssues: error.issues,
              previousInvalidFields: this.modelFieldsFromContent(previousContent, error.fields),
              lockedValidFields: lockedFields,
              sourceText,
              sourceEvidenceSegments: sourceEvidenceSegments(sourceText),
              instructions: error.fields.map((field) => semanticFieldRepairGuidance[field] ??
                `${field} 必须准确表达 sourceText 中对应语义；非空 value 必须附逐字连续原文 evidence。`)
            })
          }]
          this.recordTraceEvent({
            stage,
            kind: 'retry',
            message: `${stage} 阶段对仍失败的字段 ${error.fields.join('、')} 进行最终证据校准`,
            attempt: 4,
            maxAttempts: semanticValidationMaxAttempts
          })
        } else if (attempt >= 1) {
          // Malformed JSON and request-level errors do not identify a field that a
          // targeted repair can safely correct; avoid sending a duplicate call.
          break
        }
      }
    }
    throw new Error(`AI 语义分析校验失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private createTrace(
    recordUid: string,
    settings: ModelSettings,
    deepThinking = this.task?.deepThinking !== false
  ): RequirementSemanticizationAnalysisTrace {
    return {
      version: 1,
      recordUid,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings),
      deepThinking,
      events: [],
      stages: {}
    }
  }

  private startTraceStage(stage: RequirementSemanticizationAnalysisStage, attempts?: number): void {
    if (!this.currentTrace) return
    const startedAt = new Date().toISOString()
    this.currentTrace.stages[stage] = {
      status: 'running',
      startedAt,
      attempts: attempts ?? (stage === 'persisting' ? 0 : 1)
    }
    this.recordTraceEvent({ stage, kind: 'stage_started', message: `${stage} 阶段开始` })
  }

  private completeTraceStage(
    stage: RequirementSemanticizationAnalysisStage,
    output: SemanticAnalysisOutput,
    summary = output.analysisSummary
  ): void {
    if (!this.currentTrace) return
    const current = this.currentTrace.stages[stage]
    this.currentTrace.stages[stage] = {
      status: 'completed',
      startedAt: current?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      attempts: current?.attempts ?? 1,
      summary,
      fields: this.toTraceFields(output.fields),
      ...(current?.modelUsage ? { modelUsage: current.modelUsage } : {})
    }
    this.recordTraceEvent({
      stage,
      kind: 'stage_completed',
      message: `${stage} 阶段完成`,
      summary,
      fields: this.toTraceFields(output.fields)
    })
  }

  private failTraceStage(message: string): void {
    if (!this.currentTrace) return
    const stage = this.task?.currentStage
    if (stage !== 'initial' && stage !== 'independent' && stage !== 'adjudication' && stage !== 'persisting') return
    const current = this.currentTrace.stages[stage]
    this.currentTrace.stages[stage] = {
      status: 'failed',
      startedAt: current?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      attempts: current?.attempts ?? 0,
      summary: message.slice(0, 300)
    }
  }

  private finishTrace(outcome: RequirementSemanticizationAnalysisTrace['outcome']): RequirementSemanticizationAnalysisTrace {
    const trace = this.currentTrace ?? this.createTrace(
      this.task?.currentRecord?.uid ?? '',
      this.getSettings(),
      this.task?.deepThinking !== false
    )
    trace.outcome = outcome
    trace.completedAt = new Date().toISOString()
    if (outcome === 'completed') {
      const adjudication = trace.stages.adjudication
      if (adjudication?.fields) {
        trace.finalAdjudication = {
          completedAt: adjudication.completedAt ?? trace.completedAt,
          summary: adjudication.summary ?? '',
          fields: adjudication.fields
        }
      }
    }
    if (this.task) this.task.analysisTrace = structuredClone(trace)
    return structuredClone(trace)
  }

  private recordTraceEvent(input: Omit<RequirementSemanticizationTraceEvent, 'id' | 'recordUid' | 'timestamp'>): void {
    if (!this.currentTrace) return
    const event: RequirementSemanticizationTraceEvent = {
      ...input,
      id: randomUUID(),
      recordUid: this.currentTrace.recordUid,
      timestamp: new Date().toISOString()
    }
    this.currentTrace.events.push(event)
    const stage = this.currentTrace.stages[input.stage]
    if (stage && input.kind === 'retry') stage.attempts = Math.max(stage.attempts, input.attempt ?? 0)
    if (this.task) this.task.analysisTrace = structuredClone(this.currentTrace)
    this.db.updateRequirementSemanticCardTrace(this.currentTrace.recordUid, this.currentTrace)
    this.touch()
    this.emit(this.task?.currentRecord?.uid, 'processing')
  }

  private toTraceFields(fields: Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>): Record<string, RequirementSemanticizationTraceField> {
    return Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS.map((field) => [field, {
      value: fields[field].value,
      confidence: fields[field].confidence,
      evidence: fields[field].evidence
    }]))
  }

  private applyKnownFieldsToModelOutput(value: unknown, source: RequirementSemanticCard): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const candidate = value as { fields?: unknown }
    if (!candidate.fields || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)) return value
    const fields = { ...(candidate.fields as Record<string, unknown>) }
    knownSemanticFields.forEach((field) => {
      const valueText = source[field].trim()
      if (!valueText) return
      const assessment = source.fieldAssessments[field]
      fields[field] = {
        value: valueText,
        confidence: assessment?.confidence ?? 1,
        evidence: assessment?.evidence || valueText
      }
    })
    return { ...candidate, fields }
  }

  private mergeFallbackFields(
    value: unknown,
    fallbackFields: Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>>
  ): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const candidate = value as { fields?: unknown }
    if (!candidate.fields || typeof candidate.fields !== 'object' || Array.isArray(candidate.fields)) return value
    return {
      ...candidate,
      fields: {
        ...(candidate.fields as Record<string, unknown>),
        // Validated fields are authoritative. A model may repeat them despite
        // the narrowed schema, but it must not overwrite the locked result.
        ...fallbackFields
      }
    }
  }

  private modelFieldsFromContent(
    content: string,
    fields: readonly RequirementSemanticFieldName[]
  ): Partial<Record<RequirementSemanticFieldName, unknown>> {
    try {
      const parsed = JSON.parse(content) as { fields?: unknown }
      if (!parsed.fields || typeof parsed.fields !== 'object' || Array.isArray(parsed.fields)) return {}
      const candidate = parsed.fields as Record<string, unknown>
      return Object.fromEntries(fields.flatMap((field) =>
        Object.prototype.hasOwnProperty.call(candidate, field) ? [[field, candidate[field]]] : []
      ))
    } catch {
      return {}
    }
  }

  private compareDivergence(initial: SemanticAnalysisOutput, independent: SemanticAnalysisOutput): RequirementSemanticizationDivergence {
    const fields = REQUIREMENT_SEMANTIC_FIELDS.flatMap((field) => {
      const left = initial.fields[field]
      const right = independent.fields[field]
      const leftTrace = { value: left.value, confidence: left.confidence, evidence: left.evidence }
      const rightTrace = { value: right.value, confidence: right.confidence, evidence: right.evidence }
      return left.value !== right.value ||
        normalizedEvidence(left.evidence) !== normalizedEvidence(right.evidence) ||
        Math.abs(left.confidence - right.confidence) >= 0.2
        ? [{ field, initial: leftTrace, independent: rightTrace }]
        : []
    })
    if (this.currentTrace) this.currentTrace.divergence = { hasDivergence: fields.length > 0, fields }
    return { hasDivergence: fields.length > 0, fields }
  }

  private validateOutput(value: unknown, recordUid: string, sourceText: string): SemanticAnalysisOutput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new SemanticOutputValidationError([{ message: '返回结果不是 JSON 对象', reason: 'invalid_result' }])
    }
    const output = value as Partial<SemanticAnalysisOutput>
    if (output.recordUid !== recordUid) {
      throw new SemanticOutputValidationError([{ message: '返回的记录 UID 与请求不一致', reason: 'record_uid_mismatch' }])
    }
    if (!output.fields || typeof output.fields !== 'object') {
      throw new SemanticOutputValidationError([{ message: '返回结果缺少 fields', reason: 'missing_fields' }])
    }
    const source = normalizedEvidence(sourceText)
    const fields = {} as Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
    const validFields: Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>> = {}
    const issues: SemanticOutputValidationIssue[] = []
    for (const field of REQUIREMENT_SEMANTIC_FIELDS) {
      const item = output.fields[field]
      if (!item || typeof item !== 'object') {
        issues.push({ field, message: `缺少语义字段 ${field}`, reason: 'missing_field' })
        continue
      }
      const valueText = typeof item.value === 'string' ? item.value.trim() : ''
      const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
      const confidence = Number(item.confidence)
      const itemIssues: SemanticOutputValidationIssue[] = []
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        itemIssues.push({ field, message: `字段 ${field} 的置信度无效`, reason: 'invalid_confidence' })
      }
      if (field === 'action' && !REQUIREMENT_ACTIONS.includes(valueText as RequirementAction)) {
        itemIssues.push({ field, message: `字段 action 使用了未知枚举 ${valueText}`, reason: 'invalid_action' })
      }
      if (valueText && !(field === 'action' && valueText === 'unknown') && !evidence) {
        itemIssues.push({ field, message: `字段 ${field} 有值但没有原文证据`, reason: 'missing_evidence' })
      }
      if (evidence && !source.includes(normalizedEvidence(evidence))) {
        itemIssues.push({ field, message: `字段 ${field} 的证据不在原文中`, reason: 'evidence_not_in_source' })
      }
      if (itemIssues.length) {
        issues.push(...itemIssues)
        continue
      }
      const assessment = { value: valueText, confidence, evidence }
      fields[field] = assessment
      validFields[field] = assessment
    }
    if (fields.behavior && !fields.behavior.value) {
      issues.push({ field: 'behavior', message: '语义卡片缺少核心 behavior', reason: 'missing_core' })
      delete validFields.behavior
    }
    if (fields.functionalObject && !fields.functionalObject.value) {
      issues.push({ field: 'functionalObject', message: '语义卡片缺少核心 functionalObject', reason: 'missing_core' })
      delete validFields.functionalObject
    }
    if (issues.length) throw new SemanticOutputValidationError(issues, validFields)
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

  private emit(recordUid?: string, recordStatus?: RequirementSemanticizationProgress['recordStatus']): void {
    if (!this.task) return
    this.onProgress?.({
      ...structuredClone(this.task),
      ...(recordUid ? { recordUid } : {}),
      ...(recordStatus ? { recordStatus } : {})
    })
  }
}
