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
  RequirementSemanticizationModelUsage,
  RequirementSemanticizationQualityMode,
  RequirementSemanticizationActiveRecord
} from '../../shared/types'
import { AppDatabase, type RequirementSemanticizationCandidate } from '../database'
import { ModelClient, type ModelChatInput, type ModelReasoningEffort } from '../model-client'
import {
  buildRequirementMatchingText,
  buildRequirementSemanticCard,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_SEMANTIC_FIELDS,
  requirementLexicalTerms,
  type RequirementAction,
  type RequirementSemanticCard,
  type RequirementSemanticFieldAssessment,
  type RequirementSemanticFieldName,
  semanticTextSimilarity
} from './semantic-card'

export const REQUIREMENT_SEMANTIC_ANALYZER_VERSION = 'requirement-semantic-card-v2'
export const REQUIREMENT_SEMANTIC_POLICY_VERSION = 'requirement-semantic-routing-v1'
const REQUIREMENT_SEMANTIC_SCHEMA_VERSION = 'requirement-semantic-output-v2'

type SemanticAnalysisOutput = {
  recordUid: string
  fields: Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
  analysisSummary: string
}

/** All mutable state for one claimed record lives here, never on the service. */
interface RecordExecutionContext {
  candidate: RequirementSemanticizationCandidate
  index: number
  startedAt: number
  stage: RequirementSemanticizationAnalysisStage
  message: string
  messageBeforePause?: string
  waitingForResume: boolean
  released: boolean
  trace: RequirementSemanticizationAnalysisTrace
}

export interface RequirementSemanticizationModelClient {
  chat(input: ModelChatInput): ReturnType<ModelClient['chat']>
}

const activeTaskStatuses = new Set(['queued', 'running', 'pausing', 'paused', 'stopping'])
const recentItemLimit = 12
/** One model request may still run for at most fifteen minutes. */
export const REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS = 15 * 60 * 1000

const semanticStagePredictBudget: Record<'initial' | 'independent' | 'adjudication', { deep: number; standard: number }> = {
  // Structured extraction should finish within a small visible-output budget;
  // strict mode gets more room, while standard mode stays deliberately cheap.
  initial: { deep: 2400, standard: 1200 },
  independent: { deep: 2200, standard: 1200 },
  adjudication: { deep: 2000, standard: 1200 }
}

const semanticStageRetryBudget = (base: number, fieldCount = 1): number => {
  const scaled = Math.ceil(Math.max(1, fieldCount) * 320 / 160) * 160
  return Math.min(2_400, Math.max(640, Math.ceil(Math.min(base * 1.25, scaled) / 160) * 160))
}

const knownSemanticFields: RequirementSemanticFieldName[] = ['requirementType', 'productDomain', 'module']
const modelSemanticFields: RequirementSemanticFieldName[] = REQUIREMENT_SEMANTIC_FIELDS
  .filter((field) => !knownSemanticFields.includes(field))
const confidenceForAdjudication = 0.78

/**
 * Pick a bounded record worker pool without ever relying on an unbounded
 * Promise.all. Ollama/local models are deliberately kept single-flight;
 * online providers can use a small pool, with strict mode capped so its two
 * per-record source-only requests do not exceed four model requests total.
 */
export const requirementSemanticizationMaxConcurrency = (
  settings: Pick<ModelSettings, 'source' | 'provider'>,
  qualityMode: RequirementSemanticizationQualityMode
): number => settings.source === 'local' || settings.provider === 'ollama'
  ? 1
  : qualityMode === 'strict' ? 2 : 4

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

// A malformed/invalid initial response gets one targeted repair, never a
// cascade of full-card retries. The final card still has to pass validation.
const semanticValidationMaxAttempts = 2

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

/** Stable prefix shared by initial and independent calls for provider caching. */
const semanticAnalysisSystemPrompt = [
  '你是需求语义卡片分析专家。请深入理解原文，生成可用于精准匹配的结构化语义，不要仅做关键词摘抄。',
  '只能依据给定原文分析，禁止补充原文不存在的业务事实；analysisPass/reviewerMode 由用户 payload 指定。',
  'reviewerMode=primary 时执行首轮抽取；reviewerMode=independent 时必须仅依据原文独立复核，不参考其他结论。',
  'requirementType、productDomain、module 如果在 knownFields 中提供，由服务端原样注入；不要在 fields 中生成或改写这些字段。',
  'value 是归一化后的语义结论，不要求在原文中逐字出现；evidence 是支撑该结论的原文证据，必须从 sourceText 复制一个逐字连续片段，禁止改写、概括或翻译。',
  '每个可推断字段必须给出 value、0-1 confidence 和 evidence；找不到可逐字复制的证据时，该字段 value/evidence 置空且 confidence 为 0。',
  'action 是唯一例外：找不到可逐字复制的动作证据时，返回 action.value="unknown"、action.evidence=""、action.confidence=0，不得为满足枚举约束编造动作。',
  'functionalObject 和 behavior 是核心字段，不能留空。正文缺失或只有图片时，必须深度理解“名称：”行并使用名称文本作为 evidence。',
  `action 只能是：${REQUIREMENT_ACTIONS.join('、')}。`,
  'functionalObject 描述真正被操作的业务对象；behavior 描述用户可观察的完整目标行为；currentState 与 targetState 必须明确区分。',
  '输出严格 JSON，不要 Markdown。'
].join('\n')

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
  maxAttempts?: number
  reasoningEffort?: ModelReasoningEffort
}

const normalizedEvidence = (value: string): string => value
  .replace(/[\s\u00a0]+/g, ' ')
  .trim()

const normalizedDivergenceEnum = (value: string): string => value
  .normalize('NFKC')
  .trim()
  .toLocaleLowerCase()
  .replace(/[\s-]+/g, '_')

const normalizedDivergenceText = (value: string): string => value.normalize('NFKC').trim()

/**
 * Treat only clear paraphrases as equivalent. A shared evidence span can
 * support a modestly different normalization, but it must not hide a real
 * semantic conflict such as create versus delete.
 */
const freeTextDiverges = (
  leftValue: string,
  rightValue: string,
  leftEvidence: string,
  rightEvidence: string
): boolean => {
  const left = normalizedDivergenceText(leftValue)
  const right = normalizedDivergenceText(rightValue)
  if (!left || !right) return left !== right
  const valueSimilarity = semanticTextSimilarity(left, right)
  if (valueSimilarity >= 0.3) return false
  const evidenceLeft = normalizedDivergenceText(leftEvidence)
  const evidenceRight = normalizedDivergenceText(rightEvidence)
  const evidenceSimilarity = evidenceLeft && evidenceRight
    ? semanticTextSimilarity(evidenceLeft, evidenceRight)
    : 0
  // Keep the threshold above the typical unrelated/single-shared-token score;
  // evidence overlap is only a secondary signal for conservative paraphrases.
  return !(valueSimilarity >= 0.24 && evidenceSimilarity >= 0.72)
}

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
  return Math.min(24_576, Math.max(4_096, Math.ceil(required / 1_024) * 1_024))
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
    analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
    policyVersion: REQUIREMENT_SEMANTIC_POLICY_VERSION,
    schemaVersion: REQUIREMENT_SEMANTIC_SCHEMA_VERSION,
    source: settings.source,
    provider: settings.provider,
    baseUrl: settings.baseUrl.replace(/\/+$/, ''),
    model: settings.model,
    // The task-level deepThinking switch is a route, not a global cache
    // identity. The persisted card must be reusable by either route.
    configuredThinking: settings.thinking,
    structuredOutput: 'json-schema'
  }))
  .digest('hex')

export class RequirementSemanticizationService {
  private task: RequirementSemanticizationTaskSnapshot | null = null
  private candidates: RequirementSemanticizationCandidate[] = []
  private resumeWaiters: Array<() => void> = []
  private readonly activeRecords = new Map<string, RecordExecutionContext>()
  private lastAnalysisTrace: RequirementSemanticizationAnalysisTrace | undefined
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  private progressPending: { recordUid?: string; recordStatus?: RequirementSemanticizationProgress['recordStatus']; jobId: string } | null = null
  private jobAbortController: AbortController | null = null

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
    this.clearJobAbortController()
    const qualityMode: RequirementSemanticizationQualityMode = input.qualityMode ??
      (input.deepThinking === true ? 'strict' : 'standard')
    const deepThinking = qualityMode === 'strict'
    const maxConcurrency = requirementSemanticizationMaxConcurrency(settings, qualityMode)
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
        deepThinking,
        qualityMode,
        maxConcurrency,
        activeCount: 0,
        activeRecords: [],
        elapsedMs: 0,
        recordsPerMinute: 0
      }
      this.emit(undefined, undefined, true)
      return { jobId, accepted: 0, skipped: available, available }
    }
    const timestamp = new Date().toISOString()
    this.candidates = candidates
    this.jobAbortController = new AbortController()
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
      message: `已创建任务，将按并发策略处理 ${candidates.length} 条记录`,
      recentItems: [],
      deepThinking,
      qualityMode,
      maxConcurrency,
      activeCount: 0,
      activeRecords: [],
      elapsedMs: 0,
      recordsPerMinute: 0
    }
    this.emit(undefined, undefined, true)
    void this.runJob(settings, qualityMode).catch((error) => {
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
        this.task.message = '正在等待所有在途 AI 阶段到达安全边界后暂停'
      }
    } else if (action === 'resume') {
      if (this.task.status === 'paused' || this.task.status === 'pausing') {
        this.task.status = 'running'
        this.task.message = '任务已继续，按当前并发策略执行'
        this.resolveWaiters()
      }
    } else if (activeTaskStatuses.has(this.task.status)) {
      this.task.status = 'stopping'
      this.task.message = this.task.currentRecord
        ? '正在取消所有在途 AI 请求并停止任务'
        : '正在停止任务'
      this.jobAbortController?.abort(new SemanticizationStoppedError())
      this.resolveWaiters()
    }
    this.touch()
    this.emit(undefined, undefined, true)
    return this.getTask()
  }

  private async runJob(settings: ModelSettings, qualityMode: RequirementSemanticizationQualityMode): Promise<void> {
    const deepThinking = qualityMode === 'strict'
    if (!this.task) return
    if (this.task.status === 'stopping' || this.task.status === 'stopped') {
      this.finishStopped()
      return
    }
    const client = this.createModelClient(settings)
    this.task.status = this.task.status === 'paused' ? 'paused' : 'running'
    this.task.currentStage = 'idle'
    this.task.message = this.task.status === 'paused' ? '任务已暂停，可随时继续' : '任务已开始，按当前并发策略执行'
    this.touch()
    this.emit(undefined, undefined, true)
    const maxConcurrency = this.task.maxConcurrency ?? requirementSemanticizationMaxConcurrency(settings, qualityMode)
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        try {
          await this.checkpoint()
        } catch (error) {
          if (error instanceof SemanticizationStoppedError) return
          throw error
        }
        if (!this.task || this.task.status === 'stopping' || this.task.status === 'stopped') return
        const index = nextIndex
        nextIndex += 1
        if (index >= this.candidates.length) return
        await this.processCandidate(settings, qualityMode, client, this.candidates[index], index)
      }
    }
    // The array length is a small provider-derived bound, not the candidate
    // count. Wait for every worker to converge before surfacing an unexpected
    // setup/claim error, otherwise the outer catch could release cards while
    // sibling workers are still completing records.
    const workerResults = await Promise.allSettled(
      Array.from({ length: Math.min(maxConcurrency, this.candidates.length) }, () => worker())
    )
    const unexpectedWorkerFailure = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (unexpectedWorkerFailure) throw unexpectedWorkerFailure.reason
    if (!this.task) return
    if (this.getTask()?.status === 'stopping') {
      this.finishStopped()
      return
    }
    this.clearJobAbortController()
    this.task.status = 'completed'
    this.task.currentStage = 'idle'
    this.task.currentRecord = undefined
    this.task.message = this.task.failed
      ? `处理完成，成功 ${this.task.succeeded} 条，失败 ${this.task.failed} 条`
      : `处理完成，共 ${this.task.succeeded} 条`
    this.touch()
    this.emit(undefined, undefined, true)
  }

  private async processCandidate(
    settings: ModelSettings,
    qualityMode: RequirementSemanticizationQualityMode,
    client: RequirementSemanticizationModelClient,
    candidate: RequirementSemanticizationCandidate,
    index: number
  ): Promise<void> {
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
      this.emit(candidate.recordUid, 'failed', true)
      return
    }
    const startedAt = Date.now()
    const context: RecordExecutionContext = {
      candidate,
      index: index + 1,
      startedAt,
      stage: 'initial',
      message: `正在分析 ${candidate.itemId || candidate.name}`,
      waitingForResume: false,
      released: false,
      trace: this.createTrace(candidate.recordUid, settings, qualityMode === 'strict', qualityMode)
    }
    this.activeRecords.set(candidate.recordUid, context)
    this.startTraceStage(context, 'initial')
    this.touch()
    this.emit(candidate.recordUid, 'processing', true)
    try {
      const record = this.db.getRecord(candidate.recordUid, false)
      if (!record) throw new Error('数据中心记录不存在或已被删除')
      const source = buildRequirementSemanticCard(record)
      if (!source.evidence.trim()) throw new Error('记录没有可供 AI 分析的文本内容')
      let finalOutput: SemanticAnalysisOutput
      if (qualityMode === 'standard') {
        const initial = this.enforceKnownFields(
          source,
          await this.analyze(context, client, candidate.recordUid, source, 'initial')
        )
        this.updateTraceStageOutput(context, 'initial', initial)
        await this.checkpoint(context)
        const lowConfidenceFields = this.lowConfidenceCoreFields(initial)
        if (lowConfidenceFields.length) {
          this.setStage(context, 'initial', `正在定向修复低置信核心字段：${lowConfidenceFields.join('、')}`)
          finalOutput = this.enforceKnownFields(
            source,
            await this.repairFields(context, client, candidate.recordUid, source, initial, lowConfidenceFields)
          )
          this.updateTraceStageOutput(context, 'initial', finalOutput)
        } else {
          finalOutput = initial
        }
      } else {
        // Online providers can overlap the two independent source-only
        // analyses. Ollama/local models are kept single-flight because a
        // second request competes for the same model/GPU and usually makes
        // both responses slower.
        const serializeStrictPasses = settings.source === 'local' || settings.provider === 'ollama'
        let initial: SemanticAnalysisOutput
        let independent: SemanticAnalysisOutput
        if (serializeStrictPasses) {
          this.setStage(context, 'initial', '正在执行初步分析')
          initial = this.enforceKnownFields(
            source,
            await this.analyze(context, client, candidate.recordUid, source, 'initial')
          )
          this.updateTraceStageOutput(context, 'initial', initial)
          await this.checkpoint(context)
          this.setStage(context, 'independent', '正在执行独立语义复核')
          independent = this.enforceKnownFields(
            source,
            await this.analyze(context, client, candidate.recordUid, source, 'independent')
          )
          this.updateTraceStageOutput(context, 'independent', independent)
        } else {
          this.setStage(context, 'initial', '正在并行执行初步分析与独立语义复核')
          this.startTraceStage(context, 'independent')
          const parallelResults = await Promise.allSettled([
            this.analyze(context, client, candidate.recordUid, source, 'initial'),
            this.analyze(context, client, candidate.recordUid, source, 'independent')
          ])
          const rejected = parallelResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (rejected) throw rejected.reason
          const initialResult = (parallelResults[0] as PromiseFulfilledResult<SemanticAnalysisOutput>).value
          const independentResult = (parallelResults[1] as PromiseFulfilledResult<SemanticAnalysisOutput>).value
          initial = this.enforceKnownFields(source, initialResult)
          independent = this.enforceKnownFields(source, independentResult)
          this.updateTraceStageOutput(context, 'initial', initial)
          this.updateTraceStageOutput(context, 'independent', independent)
        }
        await this.checkpoint(context)
        const divergence = this.compareDivergence(context, initial, independent)
        const lowConfidenceFields = this.lowConfidenceCoreFields(initial, independent)
        const adjudicationFields = this.adjudicationFields(initial, independent, divergence)
        if (divergence.hasDivergence || lowConfidenceFields.length) {
          this.setStage(context, 'adjudication', '正在裁决存在分歧或低置信核心字段')
          finalOutput = this.enforceKnownFields(
            source,
            await this.adjudicate(
              context,
              client,
              candidate.recordUid,
              source,
              initial,
              independent,
              adjudicationFields,
              divergence
            )
          )
          this.updateTraceStageOutput(context, 'adjudication', finalOutput)
        } else {
          finalOutput = this.mergeAgreeingOutputs(initial, independent)
        }
      }
        await this.checkpoint(context)
      this.setStage(context, 'persisting', '正在校验并保存语义卡片')
      const card = this.toCard(source, finalOutput)
      this.completeTraceStage(context, 'persisting', finalOutput, '结构化字段、置信度和原文证据校验通过，正在写入语义资产')
      const trace = this.finishTrace(context, 'completed')
      this.lastAnalysisTrace = trace
      const completed = this.db.completeRequirementSemanticCard(candidate.recordUid, card, trace, {
        contentHash: currentHash,
        analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
        modelSignature: requirementSemanticModelSignature(settings)
      })
      if (!completed) {
        const discardedMessage = '源内容已变化，已丢弃本次 AI 结果，等待下次重试'
        this.failTraceStage(context, discardedMessage)
        const discardedTrace = this.finishTrace(context, 'failed')
        this.lastAnalysisTrace = discardedTrace
        context.released = true
        this.db.releaseRequirementSemanticCard(candidate.recordUid, discardedTrace)
        this.addResult(candidate, 'failed', Date.now() - startedAt, discardedMessage)
        this.emit(candidate.recordUid, 'failed', true)
        return
      }
      this.activeRecords.delete(candidate.recordUid)
      this.addResult(candidate, 'ready', Date.now() - startedAt)
      this.emit(candidate.recordUid, 'ready', true)
    } catch (error) {
      const stopping = error instanceof SemanticizationStoppedError ||
        this.task?.status === 'stopping' || this.task?.status === 'stopped'
      if (stopping) {
        if (!context.released) {
          const trace = this.finishTrace(context, 'stopped')
          this.lastAnalysisTrace = trace
          context.released = true
          this.db.releaseRequirementSemanticCard(candidate.recordUid, trace)
        }
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      this.failTraceStage(context, message)
      const trace = this.finishTrace(context, 'failed')
      this.lastAnalysisTrace = trace
      this.db.failRequirementSemanticCard(candidate.recordUid, message, trace)
      this.activeRecords.delete(candidate.recordUid)
      this.addResult(candidate, 'failed', Date.now() - startedAt, message)
      this.emit(candidate.recordUid, 'failed', true)
    } finally {
      this.activeRecords.delete(candidate.recordUid)
      this.touch()
    }
  }

  private async checkpoint(context?: RecordExecutionContext): Promise<void> {
    // Yield before reading task control so pause/stop requests queued in the same turn
    // are observed before another AI stage or record can begin.
    await Promise.resolve()
    if (!this.task) throw new SemanticizationStoppedError()
    if (this.task.status === 'stopping' || this.task.status === 'stopped') {
      throw new SemanticizationStoppedError()
    }
    if (this.task.status !== 'pausing' && this.task.status !== 'paused') return
    if (context) {
      context.messageBeforePause ??= context.message
      context.waitingForResume = true
      context.message = '任务已暂停，可随时继续'
    }
    const allActiveWaiting = [...this.activeRecords.values()].every((item) => item.waitingForResume)
    if (!this.activeRecords.size || allActiveWaiting) this.task.status = 'paused'
    this.task.message = this.task.status === 'paused'
      ? '任务已暂停，可随时继续'
      : '正在等待所有在途记录到达安全暂停边界'
    this.touch()
    this.emit(context?.candidate.recordUid, 'processing', true)
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve))
    // The control handler may mutate task.status while this promise is
    // suspended; widen the value so TypeScript does not assume the old union.
    const resumedStatus = this.task ? String(this.task.status) : undefined
    if (!this.task || resumedStatus === 'stopping' || resumedStatus === 'stopped') {
      throw new SemanticizationStoppedError()
    }
    if (context) {
      context.waitingForResume = false
      context.message = context.messageBeforePause ?? context.message
      context.messageBeforePause = undefined
    }
  }

  private setStage(
    context: RecordExecutionContext,
    stage: RequirementSemanticizationAnalysisStage,
    message: string
  ): void {
    if (!this.task) return
    const changed = context.stage !== stage
    context.stage = stage
    context.message = message
    if (changed) this.startTraceStage(context, stage)
    this.touch()
    this.emit(context.candidate.recordUid, 'processing')
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
    this.task.message = status === 'ready'
      ? `${candidate.itemId || candidate.name} 语义卡片已生成`
      : `${candidate.itemId || candidate.name} 处理失败：${error ?? '未知错误'}`
    this.touch()
  }

  private finishStopped(message?: string): void {
    if (!this.task) return
    this.jobAbortController?.abort(new SemanticizationStoppedError())
    this.clearJobAbortController()
    for (const context of this.activeRecords.values()) {
      if (!context.released) {
        const trace = this.finishTrace(context, 'stopped')
        this.lastAnalysisTrace = trace
        context.released = true
        this.db.releaseRequirementSemanticCard(context.candidate.recordUid, trace)
      }
    }
    this.activeRecords.clear()
    this.task.status = 'stopped'
    this.task.currentStage = 'idle'
    this.task.currentRecord = undefined
    this.task.remaining = Math.max(0, this.task.total - this.task.completed)
    this.task.message = message ?? `任务已停止，已完成 ${this.task.completed} 条，剩余 ${this.task.remaining} 条未处理`
    this.touch()
    this.emit(undefined, undefined, true)
  }

  private resolveWaiters(): void {
    const waiters = this.resumeWaiters.splice(0)
    waiters.forEach((resolve) => resolve())
  }

  private clearJobAbortController(): void {
    const controller = this.jobAbortController
    this.jobAbortController = null
    if (controller && !controller.signal.aborted) {
      controller.abort(new SemanticizationStoppedError())
    }
  }

  private stopRequested(): boolean {
    return Boolean(this.jobAbortController?.signal.aborted) ||
      this.task?.status === 'stopping' || this.task?.status === 'stopped'
  }

  private touch(syncSnapshot = true): void {
    if (!this.task) return
    if (syncSnapshot) this.syncActiveTaskSnapshot()
    this.task.updatedAt = new Date().toISOString()
  }

  private async analyze(
    context: RecordExecutionContext,
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    pass: 'initial' | 'independent'
  ): Promise<SemanticAnalysisOutput> {
    return this.callAndValidate(context, client, recordUid, source.evidence, pass, {
      messages: [
        {
          role: 'system',
          content: semanticAnalysisSystemPrompt
        },
        {
          role: 'user',
          content: JSON.stringify({
            recordUid,
            sourceText: source.evidence,
            analysisPass: pass,
            reviewerMode: pass === 'initial' ? 'primary' : 'independent',
            knownFields: Object.fromEntries(knownSemanticFields.map((field) => [field, source[field]]))
          })
        }
      ]
    }, source)
  }

  private async adjudicate(
    context: RecordExecutionContext,
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput,
    focusFields: RequirementSemanticFieldName[],
    divergence?: RequirementSemanticizationDivergence
  ): Promise<SemanticAnalysisOutput> {
    if (divergence?.hasDivergence) this.recordTraceEvent(context, {
      stage: 'adjudication',
      kind: 'divergence',
      message: '初步分析与独立复核存在字段分歧，已交由最终裁决',
      divergence
    })
    return this.callAndValidate(context, client, recordUid, source.evidence, 'adjudication', {
      messages: [
        {
          role: 'system',
          content: [
            '你是需求语义裁决专家。请回到原文，对两份独立分析逐字段核验后给出唯一终稿。',
            '一致不代表正确；必须检查业务对象、目标动作、现状/目标、触发、输入输出、约束和验收是否有原文支持。',
            '发生冲突时采用原文证据更直接、粒度更准确的结论；证据不足必须留空，不得折中拼接或猜测。',
            'value 是归一化语义，evidence 必须从 sourceText 复制逐字连续片段，不能把归一化 value、改写句或概括句当作 evidence。',
            '每个非空 value 必须附原文逐字证据，找不到则该字段置空；confidence 为 0-1。action 只能使用规定枚举。',
            'focusFields、stableFields 和 divergentFields 由用户 payload 指定；只输出 focusFields，稳定字段由服务端合并。',
            '输出严格 JSON，不要 Markdown。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            recordUid,
            sourceText: source.evidence,
            analysisPass: 'adjudication',
            reviewerMode: 'adjudication',
            focusFields,
            knownFields: Object.fromEntries(knownSemanticFields.map((field) => [field, source[field]])),
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
        .map((field) => [field, initial.fields[field]])),
      reasoningEffort: 'medium'
    })
  }

  private enforceKnownFields(
    source: RequirementSemanticCard,
    output: SemanticAnalysisOutput
  ): SemanticAnalysisOutput {
    const fields = { ...output.fields }
    knownSemanticFields.forEach((field) => {
      const value = source[field].trim()
      const sourceAssessment = source.fieldAssessments[field]
      fields[field] = {
        value,
        confidence: sourceAssessment?.confidence ?? (value ? 1 : 0),
        evidence: value ? (sourceAssessment?.evidence || value) : ''
      }
    })
    return { ...output, fields }
  }

  private updateTraceStageOutput(
    context: RecordExecutionContext,
    stage: 'initial' | 'independent' | 'adjudication',
    output: SemanticAnalysisOutput
  ): void {
    const traceStage = context.trace.stages[stage]
    if (!traceStage) return
    traceStage.fields = this.toTraceFields(output.fields)
    traceStage.summary = output.analysisSummary
    this.syncActiveTaskSnapshot()
  }

  private adjudicationFields(
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput,
    divergence: RequirementSemanticizationDivergence
  ): RequirementSemanticFieldName[] {
    const fields = new Set<RequirementSemanticFieldName>(divergence.fields
      .map((item) => item.field as RequirementSemanticFieldName)
      .filter((field) => modelSemanticFields.includes(field)))
    modelSemanticFields.forEach((field) => {
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

  private lowConfidenceCoreFields(
    ...outputs: SemanticAnalysisOutput[]
  ): RequirementSemanticFieldName[] {
    return modelSemanticFields.filter((field) => coreSemanticFields.has(field) && outputs.some((output) => {
      const assessment = output.fields[field]
      return !assessment.value || assessment.confidence < confidenceForAdjudication
    }))
  }

  private mergeAgreeingOutputs(
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput
  ): SemanticAnalysisOutput {
    const fields = Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS.map((field) => {
      const left = initial.fields[field]
      const right = independent.fields[field]
      return [field, right.confidence > left.confidence ? right : left]
    })) as Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
    return {
      recordUid: initial.recordUid,
      fields,
      analysisSummary: initial.analysisSummary || independent.analysisSummary
    }
  }

  private async repairFields(
    context: RecordExecutionContext,
    client: RequirementSemanticizationModelClient,
    recordUid: string,
    source: RequirementSemanticCard,
    previous: SemanticAnalysisOutput,
    fields: readonly RequirementSemanticFieldName[]
  ): Promise<SemanticAnalysisOutput> {
    const responseFields = fields.filter((field) => modelSemanticFields.includes(field))
    if (!responseFields.length) return previous
    const lockedFields = Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS
      .filter((field) => !responseFields.includes(field))
      .map((field) => [field, previous.fields[field]])) as Partial<Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>>
    return this.callAndValidate(context, client, recordUid, source.evidence, 'initial', {
      messages: [
        {
          role: 'system',
          content: [
            '你是需求语义卡片的定向修复专家，只重新分析指定的低置信核心字段。',
            '只能依据 sourceText，不得引入原文之外的事实；只输出严格 JSON，不要输出解释或 Markdown。',
            '待修复字段和锁定字段由用户 payload 指定；只输出待修复字段。',
            'value 是归一化语义结论；evidence 必须从 sourceText 复制逐字连续片段。',
            'functionalObject 和 behavior 必须表达具体、可观察的业务语义，不能只写模块名。'
          ].join('\n')
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'repair_low_confidence_semantic_fields',
            recordUid,
            sourceText: source.evidence,
            analysisPass: 'initial',
            reviewerMode: 'targeted-repair',
            responseFields,
            knownFields: Object.fromEntries(knownSemanticFields.map((field) => [field, source[field]])),
            fields: Object.fromEntries(responseFields.map((field) => [field, previous.fields[field]])),
            lockedFields
          })
        }
      ]
    }, source, {
      responseFields,
      fallbackFields: lockedFields,
      reasoningEffort: 'low',
      // This is already the one allowed low-confidence escalation. If its
      // output is invalid, fail closed instead of starting another model call.
      maxAttempts: 1
    })
  }

  private async callAndValidate(
    context: RecordExecutionContext,
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
    let responseFields = options.responseFields ?? modelSemanticFields
    const maxAttempts = Math.max(1, Math.min(semanticValidationMaxAttempts, options.maxAttempts ?? semanticValidationMaxAttempts))
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const traceStage = context.trace.stages[stage]
      if (traceStage) {
        traceStage.attempts = Math.max(traceStage.attempts, attempt + 1)
        this.syncActiveTaskSnapshot()
      }
      let response: Awaited<ReturnType<RequirementSemanticizationModelClient['chat']>>
      let usedNumPredict = 0
      try {
        const stageBudget = semanticStagePredictBudget[stage === 'persisting' ? 'adjudication' : stage]
        const baseNumPredict = this.task?.qualityMode === 'strict' ? stageBudget.deep : stageBudget.standard
        const numPredict = attempt === 0
          ? baseNumPredict
          : semanticStageRetryBudget(baseNumPredict, responseFields.length)
        // A validation retry is a targeted repair and is intentionally cheap,
        // even when the failed first pass was adjudication. Explicit stage
        // overrides are used for the initial request only.
        const reasoningEffort: ModelReasoningEffort = attempt > 0
          ? 'low'
          : options.reasoningEffort ?? (
            stage === 'adjudication'
              ? 'medium'
              : stage === 'independent' || this.task?.qualityMode === 'strict'
                ? 'low'
                : 'none'
        )
        usedNumPredict = numPredict
        const chatInput: ModelChatInput = {
          messages,
          think: reasoningEffort !== 'none',
          forceThinking: reasoningEffort !== 'none',
          reasoningEffort,
          stream: false,
          temperature: 0,
          numPredict,
          numCtx: dynamicModelContext(messages, numPredict),
          timeoutMs: REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
          maxTransportRetries: 2,
          format: responseSchemaFor(responseFields) as unknown as Record<string, unknown>,
          signal: this.jobAbortController?.signal,
          onRetry: ({ attempt: retryAttempt, maxAttempts: retryMaxAttempts, delayMs, status }) => {
            this.recordTraceEvent(context, {
              stage,
              kind: 'retry',
              message: `${stage}阶段模型传输暂时失败${status === undefined ? '' : `（HTTP ${status}）`}，将在 ${delayMs}ms 后进行第 ${retryAttempt}/${retryMaxAttempts} 次传输；响应正文未记录`,
              attempt: retryAttempt,
              maxAttempts: retryMaxAttempts
            })
          }
        }
        response = await client.chat(chatInput)
        if (context.trace.stages[stage]) {
          context.trace.stages[stage]!.modelUsage = mergeModelUsage(
            context.trace.stages[stage]!.modelUsage,
            response.usage
          )
          this.syncActiveTaskSnapshot()
        }
      } catch (error) {
        if (error instanceof SemanticizationStoppedError || this.stopRequested()) {
          throw new SemanticizationStoppedError()
        }
        const stageLabel = semanticStageLabels[stage]
        const timeoutMinutes = Math.round(REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS / 60_000)
        const message = isModelTimeout(error)
          ? `${stageLabel}阶段模型调用超时：超过 ${timeoutMinutes} 分钟仍未完成。请检查模型服务负载，或在“大模型配置”中选择响应更快、上下文能力更强的模型后重试。`
          : `${stageLabel}阶段模型调用失败：${error instanceof Error ? error.message : String(error)}`
        this.recordTraceEvent(context, {
          stage,
          kind: 'model_error',
          message: message.slice(0, 500),
          attempt: attempt + 1,
          maxAttempts
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
        this.recordTraceEvent(context, {
          stage,
          kind: 'validation_passed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出已通过 JSON 结构、字段、置信度和原文证据校验`,
          attempt: attempt + 1,
          maxAttempts
        })
        this.completeTraceStage(context, stage, output)
        return output
      } catch (error) {
        lastError = error
        this.recordTraceEvent(context, {
          stage,
          kind: 'validation_failed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出未通过校验：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          attempt: attempt + 1,
          maxAttempts
        })
        if (attempt + 1 < maxAttempts) {
      await this.checkpoint(context)
          const validationError = error instanceof Error ? error.message : String(error)
          const validationFields = error instanceof SemanticOutputValidationError && error.fields.length
            ? error.fields
            : responseFields
          lockedFields = {
            ...lockedFields,
            ...(error instanceof SemanticOutputValidationError ? error.validFields : {})
          }
          responseFields = validationFields.filter((field) => modelSemanticFields.includes(field))
          if (!responseFields.length) responseFields = modelSemanticFields
          const previousContent = response.message?.content?.trim() ?? ''
          const previousFields = this.modelFieldsFromContent(previousContent, responseFields)
          messages = [{
            role: 'system' as const,
            content: [
              '你是需求语义卡片的定向纠错专家，只重新分析校验失败的字段。',
              '只能依据 sourceText，不得使用规则猜测或原文之外的业务事实。',
              `只输出字段：${responseFields.join('、')}；其他字段由服务端锁定，不要生成。`,
              '只输出严格符合 JSON Schema 的 JSON，不要输出解释或 Markdown。',
              '每个非空 value 必须附 sourceText 中逐字连续复制的 evidence；找不到证据时置空并将 confidence 设为 0。',
              `action.value 只能是：${REQUIREMENT_ACTIONS.join('、')}。`,
              'functionalObject 和 behavior 是核心字段，必须保持具体且可观察。'
            ].join('\n')
          }, {
            role: 'user' as const,
            content: JSON.stringify({
              task: 'repair_invalid_semantic_fields',
              recordUid,
              analysisPass: stage,
              sourceText,
              invalidFields: responseFields,
              validationError,
              previousFields,
              lockedValidFields: lockedFields,
              instructions: responseFields.map((field) => semanticFieldRepairGuidance[field] ??
                `${field} 必须准确表达 sourceText 中对应语义；非空 value 必须附逐字连续原文 evidence。`)
            })
          }]
          this.recordTraceEvent(context, {
            stage,
            kind: 'retry',
            message: `${stage} 阶段只重新分析校验失败字段，最多进行 1 次定向修复`,
            attempt: 2,
            maxAttempts
          })
        } else {
          // Do not replay a second repair request after the bounded attempt.
          break
        }
      }
    }
    throw new Error(`AI 语义分析校验失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private createTrace(
    recordUid: string,
    settings: ModelSettings,
    deepThinking = this.task?.qualityMode === 'strict',
    qualityMode: RequirementSemanticizationQualityMode = deepThinking ? 'strict' : 'standard'
  ): RequirementSemanticizationAnalysisTrace {
    return {
      version: 1,
      recordUid,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings),
      deepThinking,
      qualityMode,
      events: [],
      stages: {}
    }
  }

  private startTraceStage(
    context: RecordExecutionContext,
    stage: RequirementSemanticizationAnalysisStage,
    attempts?: number
  ): void {
    context.stage = stage
    const startedAt = new Date().toISOString()
    context.trace.stages[stage] = {
      status: 'running',
      startedAt,
      attempts: attempts ?? (stage === 'persisting' ? 0 : 1)
    }
    this.recordTraceEvent(context, { stage, kind: 'stage_started', message: `${stage} 阶段开始` })
  }

  private completeTraceStage(
    context: RecordExecutionContext,
    stage: RequirementSemanticizationAnalysisStage,
    output: SemanticAnalysisOutput,
    summary = output.analysisSummary
  ): void {
    const current = context.trace.stages[stage]
    context.trace.stages[stage] = {
      status: 'completed',
      startedAt: current?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      attempts: current?.attempts ?? 1,
      summary,
      fields: this.toTraceFields(output.fields),
      ...(current?.modelUsage ? { modelUsage: current.modelUsage } : {})
    }
    this.recordTraceEvent(context, {
      stage,
      kind: 'stage_completed',
      message: `${stage} 阶段完成`,
      summary,
      fields: this.toTraceFields(output.fields)
    })
  }

  private failTraceStage(context: RecordExecutionContext, message: string): void {
    const stage = context.stage
    const current = context.trace.stages[stage]
    context.trace.stages[stage] = {
      status: 'failed',
      startedAt: current?.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      attempts: current?.attempts ?? 0,
      summary: message.slice(0, 300)
    }
  }

  private finishTrace(
    context: RecordExecutionContext,
    outcome: RequirementSemanticizationAnalysisTrace['outcome']
  ): RequirementSemanticizationAnalysisTrace {
    const trace = context.trace
    trace.outcome = outcome
    trace.completedAt = new Date().toISOString()
    if (outcome === 'completed') {
      // Keep the existing renderer contract (`finalAdjudication`) even when
      // standard mode finishes on the validated initial extraction.
      const finalStage = trace.stages.adjudication ?? trace.stages.initial
      if (finalStage?.fields) {
        trace.finalAdjudication = {
          completedAt: finalStage.completedAt ?? trace.completedAt,
          summary: finalStage.summary ?? '',
          fields: finalStage.fields
        }
      }
    }
    this.syncActiveTaskSnapshot()
    return structuredClone(trace)
  }

  private recordTraceEvent(
    context: RecordExecutionContext,
    input: Omit<RequirementSemanticizationTraceEvent, 'id' | 'recordUid' | 'timestamp'>
  ): void {
    const event: RequirementSemanticizationTraceEvent = {
      ...input,
      id: randomUUID(),
      recordUid: context.trace.recordUid,
      timestamp: new Date().toISOString()
    }
    context.trace.events.push(event)
    const stage = context.trace.stages[input.stage]
    if (stage && input.kind === 'retry') stage.attempts = Math.max(stage.attempts, input.attempt ?? 0)
    // Keep every event in the in-memory/IPC audit stream, but only rewrite the
    // durable full trace at meaningful boundaries. Terminal paths always flush
    // through complete/fail/releaseRequirementSemanticCard.
    if (input.kind === 'stage_completed' || input.kind === 'model_error' || input.kind === 'divergence') {
      this.db.updateRequirementSemanticCardTrace(context.trace.recordUid, context.trace)
    }
    // emit() builds the active snapshot immediately below. Avoid cloning the
    // same trace multiple times for one audit event.
    this.touch(false)
    this.emit(context.candidate.recordUid, 'processing',
      input.kind === 'stage_started' || input.kind === 'stage_completed' ||
      input.kind === 'model_error' || input.kind === 'divergence')
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
      const assessment = source.fieldAssessments[field]
      fields[field] = {
        value: valueText,
        confidence: assessment?.confidence ?? (valueText ? 1 : 0),
        evidence: valueText ? (assessment?.evidence || valueText) : ''
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

  private compareDivergence(
    context: RecordExecutionContext,
    initial: SemanticAnalysisOutput,
    independent: SemanticAnalysisOutput
  ): RequirementSemanticizationDivergence {
    const fields = modelSemanticFields.flatMap((field) => {
      const left = initial.fields[field]
      const right = independent.fields[field]
      const leftTrace = { value: left.value, confidence: left.confidence, evidence: left.evidence }
      const rightTrace = { value: right.value, confidence: right.confidence, evidence: right.evidence }
      const diverges = field === 'action'
        ? normalizedDivergenceEnum(left.value) !== normalizedDivergenceEnum(right.value)
        : freeTextDiverges(left.value, right.value, left.evidence, right.evidence)
      return diverges
        ? [{ field, initial: leftTrace, independent: rightTrace }]
        : []
    })
    context.trace.divergence = { hasDivergence: fields.length > 0, fields }
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

  private syncActiveTaskSnapshot(): void {
    if (!this.task) return
    const contexts = [...this.activeRecords.values()].sort((left, right) => left.index - right.index)
    const activeRecords: RequirementSemanticizationActiveRecord[] = contexts.map((context) => ({
      uid: context.candidate.recordUid,
      itemId: context.candidate.itemId,
      name: context.candidate.name,
      index: context.index,
      stage: context.stage,
      startedAt: new Date(context.startedAt).toISOString()
    }))
    this.task.activeRecords = activeRecords
    this.task.activeCount = activeRecords.length
    const focus = contexts[0]
    if (focus) {
      this.task.currentRecord = {
        uid: focus.candidate.recordUid,
        itemId: focus.candidate.itemId,
        name: focus.candidate.name,
        index: focus.index
      }
      this.task.currentStage = focus.stage
      this.task.message = focus.message
      this.task.analysisTrace = structuredClone(focus.trace)
    } else {
      this.task.currentRecord = undefined
      if (this.task.status !== 'queued') this.task.currentStage = 'idle'
      if (this.lastAnalysisTrace) this.task.analysisTrace = structuredClone(this.lastAnalysisTrace)
    }
    const started = Date.parse(this.task.startedAt)
    const elapsedMs = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0
    const recordsPerMinute = elapsedMs > 0
      ? this.task.completed / (elapsedMs / 60_000)
      : 0
    this.task.elapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : 0
    this.task.recordsPerMinute = Number.isFinite(recordsPerMinute) ? recordsPerMinute : 0
    this.task.estimatedRemainingMs = this.task.recordsPerMinute > 0 && this.task.remaining > 0
      ? Math.max(0, this.task.remaining / this.task.recordsPerMinute * 60_000)
      : undefined
  }

  private emit(
    recordUid?: string,
    recordStatus?: RequirementSemanticizationProgress['recordStatus'],
    immediate = false
  ): void {
    if (!this.task) return
    this.syncActiveTaskSnapshot()
    const pending = { recordUid, recordStatus, jobId: this.task.jobId }
    if (immediate) {
      if (this.progressTimer) {
        clearTimeout(this.progressTimer)
        this.progressTimer = null
      }
      this.progressPending = null
      this.onProgress?.({
        ...structuredClone(this.task),
        ...(recordUid ? { recordUid } : {}),
        ...(recordStatus ? { recordStatus } : {})
      })
      return
    }
    this.progressPending = pending
    if (this.progressTimer) return
    const jobId = this.task.jobId
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      const queued = this.progressPending
      this.progressPending = null
      if (!queued || !this.task || this.task.jobId !== jobId) return
      this.syncActiveTaskSnapshot()
      this.onProgress?.({
        ...structuredClone(this.task),
        ...(queued.recordUid ? { recordUid: queued.recordUid } : {}),
        ...(queued.recordStatus ? { recordStatus: queued.recordStatus } : {})
      })
    }, 250)
  }
}
