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
  RequirementSemanticizationAnalysisStage
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
const maximumRecordsPerTask = 5

class SemanticizationStoppedError extends Error {
  constructor() {
    super('语义化任务已停止')
  }
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
    const context = {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }
    const requestedMaximum: unknown = input.maxRecords
    const maxRecords = requestedMaximum === undefined ? maximumRecordsPerTask : requestedMaximum
    if (typeof maxRecords !== 'number' || !Number.isFinite(maxRecords) || !Number.isInteger(maxRecords)) {
      throw new Error('单任务处理条数必须是 1–5 的整数')
    }
    if (maxRecords < 1 || maxRecords > maximumRecordsPerTask) {
      throw new Error('单任务处理条数必须在 1–5 之间')
    }
    let available = 0
    let candidates: RequirementSemanticizationCandidate[] = []
    if (input.scope === 'all_unready') {
      const result = this.db.listRequirementSemanticizationCandidates({ ...context, limit: maxRecords })
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
      candidates = candidates.slice(0, maxRecords)
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
        recentItems: []
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
      recentItems: []
    }
    this.emit()
    void this.runJob(settings).catch((error) => {
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

  private async runJob(settings: ModelSettings): Promise<void> {
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
      this.currentTrace = this.createTrace(candidate.recordUid, settings)
      this.startTraceStage('initial')
      this.touch()
      this.emit(candidate.recordUid, 'processing')
      try {
        const record = this.db.getRecord(candidate.recordUid, false)
        if (!record) throw new Error('数据中心记录不存在或已被删除')
        const source = buildRequirementSemanticCard(record)
        if (!source.evidence.trim()) throw new Error('记录没有可供 AI 分析的文本内容')
        const initial = await this.analyze(client, candidate.recordUid, source, 'initial')
        await this.checkpoint()
        this.setStage('independent', '正在执行独立语义复核')
        const independent = await this.analyze(client, candidate.recordUid, source, 'independent')
        await this.checkpoint()
        this.setStage('adjudication', '正在裁决两轮分析结果')
        const adjudicated = await this.adjudicate(client, candidate.recordUid, source, initial, independent)
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
    stage: RequirementSemanticizationAnalysisStage,
    input: Pick<ModelChatInput, 'messages'>
  ): Promise<SemanticAnalysisOutput> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const traceStage = this.currentTrace?.stages[stage]
      if (traceStage) {
        traceStage.attempts = Math.max(traceStage.attempts, attempt + 1)
        if (this.task && this.currentTrace) this.task.analysisTrace = structuredClone(this.currentTrace)
      }
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
        const output = this.validateOutput(JSON.parse(content) as unknown, recordUid, sourceText)
        this.recordTraceEvent({
          stage,
          kind: 'validation_passed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出已通过 JSON 结构、字段、置信度和原文证据校验`,
          attempt: attempt + 1,
          maxAttempts: 2
        })
        this.completeTraceStage(stage, output)
        return output
      } catch (error) {
        if (error instanceof SemanticizationStoppedError) throw error
        lastError = error
        this.recordTraceEvent({
          stage,
          kind: 'validation_failed',
          message: `${stage} 阶段第 ${attempt + 1} 次输出未通过校验：${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
          attempt: attempt + 1,
          maxAttempts: 2
        })
        if (attempt === 0) {
          await this.checkpoint()
          this.recordTraceEvent({
            stage,
            kind: 'retry',
            message: `${stage} 阶段准备进行第 2 次模型调用`,
            attempt: 2,
            maxAttempts: 2
          })
        }
      }
    }
    throw new Error(`AI 语义分析校验失败：${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  private createTrace(recordUid: string, settings: ModelSettings): RequirementSemanticizationAnalysisTrace {
    return {
      version: 1,
      recordUid,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings),
      events: [],
      stages: {}
    }
  }

  private startTraceStage(stage: RequirementSemanticizationAnalysisStage): void {
    if (!this.currentTrace) return
    const startedAt = new Date().toISOString()
    this.currentTrace.stages[stage] = {
      status: 'running',
      startedAt,
      attempts: stage === 'persisting' ? 0 : 1
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
      fields: this.toTraceFields(output.fields)
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
    const trace = this.currentTrace ?? this.createTrace(this.task?.currentRecord?.uid ?? '', this.getSettings())
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

  private compareDivergence(initial: SemanticAnalysisOutput, independent: SemanticAnalysisOutput): RequirementSemanticizationDivergence {
    const fields = REQUIREMENT_SEMANTIC_FIELDS.flatMap((field) => {
      const left = initial.fields[field]
      const right = independent.fields[field]
      const leftTrace = { value: left.value, confidence: left.confidence, evidence: left.evidence }
      const rightTrace = { value: right.value, confidence: right.confidence, evidence: right.evidence }
      return left.value !== right.value || left.confidence !== right.confidence || left.evidence !== right.evidence
        ? [{ field, initial: leftTrace, independent: rightTrace }]
        : []
    })
    if (this.currentTrace) this.currentTrace.divergence = { hasDivergence: fields.length > 0, fields }
    return { hasDivergence: fields.length > 0, fields }
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

  private emit(recordUid?: string, recordStatus?: RequirementSemanticizationProgress['recordStatus']): void {
    if (!this.task) return
    this.onProgress?.({
      ...structuredClone(this.task),
      ...(recordUid ? { recordUid } : {}),
      ...(recordStatus ? { recordStatus } : {})
    })
  }
}
