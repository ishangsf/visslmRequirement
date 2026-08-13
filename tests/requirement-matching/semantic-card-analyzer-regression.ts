import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  RequirementSemanticizationService,
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../../src/main/requirements/semanticization-service'
import {
  REQUIREMENT_SEMANTIC_FIELDS,
  buildRequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import type {
  ModelSettings,
  RecordDetail,
  RequirementSemanticizationProgress,
  RequirementSemanticizationAnalysisTrace,
  RequirementSemanticizationTaskSnapshot,
  RequirementSemanticizationTaskStatus
} from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-regression-model',
  thinking: false
}

const upsert = (db: AppDatabase, uid: string, description: string): RecordDetail => {
  db.upsertRecord({
    uid,
    projectId: 'semantic-regression',
    nodeType: 'Requirement',
    itemId: uid.toUpperCase(),
    parentId: '',
    name: '订单详情查询',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_Module: '订单管理',
      _valm_ProductDomain: '订单管理',
      _valm_Description: description
    },
    normalizedText: `订单详情查询\n${description}`
  })
  const record = db.getRecord(uid, false)
  assert.ok(record)
  return record
}

const outputFor = (recordUid: string, sourceText: string, invalid = false): string => {
  const evidence = sourceText.slice(0, Math.min(24, sourceText.length))
  const fields = Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS.map((field) => [field, {
    value: '',
    confidence: 0,
    evidence: ''
  }])) as Record<string, { value: string; confidence: number; evidence: string }>
  Object.assign(fields.requirementType, { value: 'Enhancement', confidence: 0.99, evidence })
  Object.assign(fields.productDomain, { value: '订单管理', confidence: 0.98, evidence })
  Object.assign(fields.module, { value: '订单管理', confidence: 0.98, evidence })
  Object.assign(fields.functionalObject, { value: '订单详情', confidence: 0.96, evidence })
  Object.assign(fields.action, { value: invalid ? 'invented_action' : 'add_capability', confidence: 0.95, evidence })
  Object.assign(fields.behavior, { value: '用户按订单编号查询并查看订单详情', confidence: 0.96, evidence })
  Object.assign(fields.input, { value: '订单编号', confidence: 0.9, evidence })
  Object.assign(fields.output, { value: '订单详情', confidence: 0.9, evidence })
  Object.assign(fields.acceptance, { value: '返回对应订单详情', confidence: 0.88, evidence })
  return JSON.stringify({ recordUid, fields, analysisSummary: '三阶段分析与裁决完成' })
}

const createModel = (invalid = false, divergent = false): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: ModelChatInput[]
  passes: string[]
} => {
  const calls: ModelChatInput[] = []
  const passes: string[] = []
  return {
    calls,
    passes,
    client: {
      async chat(input): Promise<ModelResponse> {
        calls.push(input)
        assert.equal(input.think, true, 'all semanticization stages must request model reasoning')
        assert.equal(input.forceThinking, true, 'all semanticization stages must force model reasoning')
        assert.ok(input.format && typeof input.format === 'object', 'all semanticization stages must request strict schema output')
        const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
          recordUid: string
          sourceText: string
          analysisPass?: string
        }
        assert.ok(payload.recordUid)
        assert.ok(payload.sourceText.includes('订单详情查询'))
        assert.ok(!payload.sourceText.includes('<p>') && !payload.sourceText.includes('&quot;'))
        passes.push(payload.analysisPass ?? '')
        const output = JSON.parse(outputFor(payload.recordUid, payload.sourceText, invalid)) as {
          fields: Record<string, { value: string; confidence: number; evidence: string }>
          analysisSummary: string
        }
        if (divergent && payload.analysisPass === 'independent') {
          output.fields.functionalObject.value = '订单信息'
          output.fields.functionalObject.confidence = 0.82
          output.analysisSummary = '独立复核认为功能对象粒度应为订单信息'
        }
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify(output)
          }
        }
      }
    }
  }
}

const waitForJob = (
  start: () => { jobId: string },
  subscribe: (resolve: (progress: RequirementSemanticizationProgress) => void) => void
): Promise<RequirementSemanticizationProgress> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('semanticization job timed out')), 10_000)
  const result = start()
  subscribe((progress) => {
    if (progress.jobId !== result.jobId || progress.status !== 'completed') return
    clearTimeout(timer)
    resolve(progress)
  })
})

const waitForTaskStatus = async (
  service: RequirementSemanticizationService,
  status: RequirementSemanticizationTaskStatus
): Promise<RequirementSemanticizationTaskSnapshot> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    const task = service.getTask()
    if (task?.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`semanticization task did not reach ${status}`)
}

const createControlledModel = (): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: ModelChatInput[]
  releasePending(): void
  enableAutomaticResponses(): void
} => {
  const calls: ModelChatInput[] = []
  const pending: Array<() => void> = []
  let automatic = false
  const response = (input: ModelChatInput): ModelResponse => {
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
      recordUid: string
      sourceText: string
    }
    return {
      message: {
        role: 'assistant',
        content: outputFor(payload.recordUid, payload.sourceText)
      }
    }
  }
  return {
    calls,
    client: {
      async chat(input): Promise<ModelResponse> {
        calls.push(input)
        if (!automatic) await new Promise<void>((resolve) => pending.push(resolve))
        return response(input)
      }
    },
    releasePending(): void {
      pending.splice(0).forEach((resolve) => resolve())
    },
    enableAutomaticResponses(): void {
      automatic = true
      pending.splice(0).forEach((resolve) => resolve())
    }
  }
}

const waitForCallCount = async (calls: ModelChatInput[], expected: number): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    if (calls.length >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`semanticization model did not receive ${expected} calls`)
}

const testLifecycle = async (db: AppDatabase): Promise<void> => {
  const record = upsert(
    db,
    'semantic-ready-uid',
    '<p>支持按订单编号查询 &quot;订单&quot; &amp; 详情。</p><script>alert(1)</script>'
  )
  const model = createModel(false, true)
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settings,
    (progress) => listener?.(progress),
    () => model.client
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 0)
  assert.equal(model.calls.length, 3, 'one record must execute initial, independent and adjudication exactly once')
  assert.deepEqual(model.passes, ['initial', 'independent', 'adjudication'])

  const context = service.context()
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash)
  const card = db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...context })
  assert.ok(card)
  assert.equal(card.analysisStatus, 'ai_adjudicated')
  assert.equal(card.functionalObject, '订单详情')

  const trace = completed.analysisTrace
  assert.ok(trace, 'completed progress must expose an auditable analysis trace')
  assert.equal(trace.outcome, 'completed')
  assert.deepEqual(
    Object.keys(trace.stages).sort(),
    ['adjudication', 'independent', 'initial', 'persisting'],
    'trace must cover all three AI stages and persistence validation'
  )
  assert.equal(trace.stages.initial?.attempts, 1)
  assert.equal(trace.stages.independent?.attempts, 1)
  assert.equal(trace.stages.adjudication?.attempts, 1)
  assert.equal(trace.divergence?.hasDivergence, true)
  assert.ok(trace.divergence?.fields.some((field) => field.field === 'functionalObject'))
  assert.equal(trace.finalAdjudication?.fields.functionalObject.value, '订单详情')
  assert.ok(trace.finalAdjudication?.fields.functionalObject.evidence)
  assert.ok(trace.events.some((event) => event.kind === 'stage_started'))
  assert.ok(trace.events.some((event) => event.kind === 'validation_passed'))
  assert.ok(trace.events.some((event) => event.kind === 'stage_completed'))
  assert.ok(trace.events.some((event) => event.kind === 'divergence'))

  const persistedDetail = db.getRecord(record.uid, false)
  assert.equal(persistedDetail?.semanticAnalysisTrace?.outcome, 'completed')
  assert.equal(persistedDetail?.semanticAnalysisTrace?.finalAdjudication?.fields.functionalObject.value, '订单详情')
  const serializedTrace = JSON.stringify(trace)
  ;['rawResponse', 'chainOfThought', 'thinkingTokens', 'messages', 'apiKey'].forEach((forbidden) => {
    assert.ok(!serializedTrace.includes(forbidden), `audit trace must not persist ${forbidden}`)
  })

  const cached = service.start({ recordUids: [record.uid] })
  assert.equal(cached.accepted, 0)
  assert.equal(cached.skipped, 1)
  assert.equal(model.calls.length, 3, 'valid ready cards must not be regenerated')

  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'ready' }, context).total, 1)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, context).total, 0)

  db.updateRecordNormalizedText(record.uid, `${record.normalizedText}\n内容发生变化`)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, context).total, 1)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'ready' }, context).total, 0)
  const changedHash = db.getRecordContentHash(record.uid)
  assert.ok(changedHash && changedHash !== contentHash)
  assert.equal(db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash: changedHash, ...context }), null)

  const analyzerChanged = { ...context, analyzerVersion: `${REQUIREMENT_SEMANTIC_ANALYZER_VERSION}-next` }
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, analyzerChanged).total, 1)
  const modelChanged = {
    ...context,
    modelSignature: requirementSemanticModelSignature({ ...settings, model: 'semantic-regression-model-next' })
  }
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, modelChanged).total, 1)
}

const testFailure = async (db: AppDatabase): Promise<void> => {
  const record = upsert(db, 'semantic-failed-uid', '<p>支持查看订单详情。</p>')
  const model = createModel(true)
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settings,
    (progress) => listener?.(progress),
    () => model.client
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 1)
  assert.equal(model.calls.length, 2, 'invalid schema output retries once and fails closed before later stages')
  const state = db.getRequirementSemanticCardState(record.uid)
  assert.equal(state?.status, 'failed')
  assert.equal(state?.card, null)
  assert.match(state?.errorMessage ?? '', /未知枚举/)
  const trace = state?.analysisTrace as unknown as {
    outcome?: string
    events?: Array<{ kind?: string }>
  }
  assert.equal(trace?.outcome, 'failed')
  assert.ok(trace?.events?.some((event) => event.kind === 'validation_failed'))
  assert.ok(trace?.events?.some((event) => event.kind === 'retry'))
  assert.ok(!JSON.stringify(trace).includes('rawResponse'), 'failed audit trace must not persist raw model output')
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'failed' }, service.context()).total, 1)
}

const testModelSettingsSnapshot = async (db: AppDatabase): Promise<void> => {
  const record = upsert(db, 'semantic-settings-snapshot-uid', '<p>支持按订单编号查看订单详情。</p>')
  const firstSettings = { ...settings, model: 'semantic-snapshot-first' }
  const laterSettings = { ...settings, model: 'semantic-snapshot-later' }
  const model = createModel()
  const capturedModels: string[] = []
  let settingsReads = 0
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settingsReads++ === 0 ? firstSettings : laterSettings,
    (progress) => listener?.(progress),
    (capturedSettings) => {
      capturedModels.push(capturedSettings.model)
      return model.client
    }
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 0)
  assert.equal(settingsReads, 1, 'job submission must capture model settings exactly once')
  assert.deepEqual(capturedModels, [firstSettings.model], 'model client must use the settings captured for the cache signature')
  const state = db.getRequirementSemanticCardState(record.uid)
  assert.equal(state?.status, 'ready')
  assert.equal(state?.modelSignature, requirementSemanticModelSignature(firstSettings))
}

const testAllUnreadyLimitAndSequentialExecution = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-bulk-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const uids = ['bulk-a', 'bulk-b', 'bulk-failed', 'bulk-ready', 'bulk-stale']
    uids.forEach((uid) => upsert(db, uid, `<p>支持按订单编号查看订单详情，记录 ${uid}。</p>`))
    const model = createModel()
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => model.client)

    service.start({ scope: 'selected', recordUids: ['bulk-ready', 'bulk-stale'] })
    await waitForTaskStatus(service, 'completed')
    const callsBeforeBulk = model.calls.length
    assert.equal(callsBeforeBulk, 6)
    db.updateRecordNormalizedText('bulk-stale', '订单详情查询\n内容发生变化，需要重新分析')
    const failedHash = db.getRecordContentHash('bulk-failed')
    assert.ok(failedHash)
    assert.equal(db.claimRequirementSemanticCard({
      recordUid: 'bulk-failed',
      contentHash: failedHash,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }), true)
    db.failRequirementSemanticCard('bulk-failed', '上次模型调用失败')

    const started = service.start({ scope: 'all_unready', maxRecords: 2 })
    assert.deepEqual(
      { accepted: started.accepted, available: started.available, skipped: started.skipped },
      { accepted: 2, available: 4, skipped: 2 },
      'global task must count every invalid/missing card and enforce the configured task size'
    )
    const completed = await waitForTaskStatus(service, 'completed')
    assert.equal(completed.total, 2)
    assert.equal(completed.succeeded, 2)
    assert.equal(completed.remaining, 0)
    assert.equal(completed.recentItems.length, 2)

    const bulkCallUids = model.calls.slice(callsBeforeBulk).map((input) => {
      const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as { recordUid: string }
      return payload.recordUid
    })
    assert.deepEqual(
      bulkCallUids,
      ['bulk-a', 'bulk-a', 'bulk-a', 'bulk-b', 'bulk-b', 'bulk-b'],
      'each record must finish all three AI stages before the next record begins'
    )

    const remainder = service.start({ scope: 'all_unready', maxRecords: 5 })
    assert.equal(remainder.accepted, 2)
    assert.equal(remainder.available, 2)
    await waitForTaskStatus(service, 'completed')
    const empty = service.start({ scope: 'all_unready', maxRecords: 5 })
    assert.equal(empty.accepted, 0)
    assert.equal(empty.available, 0)
    assert.equal(service.getTask()?.status, 'completed')
    assert.match(service.getTask()?.message ?? '', /没有需要生成或更新/)
    assert.throws(
      () => service.start({ scope: 'all_unready', maxRecords: Number.NaN }),
      /1–5 的整数/
    )
    assert.throws(
      () => service.start({ scope: 'all_unready', maxRecords: 6 }),
      /1–5 之间/
    )
    assert.throws(
      () => service.start({ scope: 'all_unready', maxRecords: null as unknown as number }),
      /1–5 的整数/
    )
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testPauseResumeAndStop = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-control-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    upsert(db, 'pause-a', '<p>支持按订单编号查看订单详情，暂停测试 A。</p>')
    upsert(db, 'pause-b', '<p>支持按订单编号查看订单详情，暂停测试 B。</p>')
    const pauseModel = createControlledModel()
    const pauseService = new RequirementSemanticizationService(
      db,
      () => settings,
      undefined,
      () => pauseModel.client
    )
    pauseService.start({ scope: 'selected', recordUids: ['pause-a', 'pause-b'] })
    await waitForCallCount(pauseModel.calls, 1)
    assert.equal(pauseService.control('pause')?.status, 'pausing')
    pauseModel.releasePending()
    const paused = await waitForTaskStatus(pauseService, 'paused')
    assert.equal(paused.currentRecord?.uid, 'pause-a')
    assert.equal(paused.currentStage, 'initial')
    assert.equal(pauseModel.calls.length, 1, 'pause must block the next AI stage at a safe boundary')

    assert.equal(pauseService.control('resume')?.status, 'running')
    pauseModel.enableAutomaticResponses()
    const resumed = await waitForTaskStatus(pauseService, 'completed')
    assert.equal(resumed.succeeded, 2)
    assert.equal(pauseModel.calls.length, 6)

    upsert(db, 'stop-a', '<p>支持按订单编号查看订单详情，停止测试 A。</p>')
    upsert(db, 'stop-b', '<p>支持按订单编号查看订单详情，停止测试 B。</p>')
    const stopModel = createControlledModel()
    const stopService = new RequirementSemanticizationService(db, () => settings, undefined, () => stopModel.client)
    stopService.start({ scope: 'selected', recordUids: ['stop-a', 'stop-b'] })
    await waitForCallCount(stopModel.calls, 1)
    assert.equal(stopService.control('stop')?.status, 'stopping')
    stopModel.enableAutomaticResponses()
    const stopped = await waitForTaskStatus(stopService, 'stopped')
    assert.equal(stopped.completed, 0)
    assert.equal(stopped.remaining, 2)
    assert.equal(stopModel.calls.length, 1, 'stop must not begin another stage or record')
    assert.equal(db.getRequirementSemanticCardState('stop-a')?.status, 'pending')
    const stoppedTrace = db.getRecord('stop-a', false)?.semanticAnalysisTrace
    assert.equal(stoppedTrace?.outcome, 'stopped')
    assert.ok(stoppedTrace?.events.some((event) => event.kind === 'validation_passed'))
    assert.equal(db.getRequirementSemanticCardState('stop-b'), null)

    upsert(db, 'queued-stop', '<p>支持按订单编号查看订单详情，排队停止测试。</p>')
    const queuedModel = createModel()
    const queuedService = new RequirementSemanticizationService(db, () => settings, undefined, () => queuedModel.client)
    queuedService.start({ scope: 'selected', recordUids: ['queued-stop'] })
    assert.equal(queuedService.control('stop')?.status, 'stopping')
    const queuedStopped = await waitForTaskStatus(queuedService, 'stopped')
    assert.equal(queuedStopped.completed, 0)
    assert.equal(queuedModel.calls.length, 0, 'stopping a queued task must prevent the first AI call')
    assert.equal(db.getRequirementSemanticCardState('queued-stop'), null)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testStopPreventsValidationRetry = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-stop-retry-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    upsert(db, 'stop-before-retry', '<p>支持按订单编号查看订单详情，停止重试测试。</p>')
    const calls: ModelChatInput[] = []
    let release: (() => void) | undefined
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        await new Promise<void>((resolve) => { release = resolve })
        return { message: { role: 'assistant', content: '{invalid-json' } }
      }
    }
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => client)
    service.start({ scope: 'selected', recordUids: ['stop-before-retry'] })
    await waitForCallCount(calls, 1)
    assert.equal(service.control('stop')?.status, 'stopping')
    release?.()
    const stopped = await waitForTaskStatus(service, 'stopped')
    assert.equal(stopped.completed, 0)
    assert.equal(calls.length, 1, 'a stop request must be honored before a validation retry starts')
    const trace = db.getRecord('stop-before-retry', false)?.semanticAnalysisTrace
    assert.equal(trace?.outcome, 'stopped')
    assert.ok(trace?.events.some((event) => event.kind === 'validation_failed'))
    assert.ok(!trace?.events.some((event) => event.kind === 'retry'))
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testInterruptedTraceRecovery = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-interruption-regression-'))
  const databasePath = join(directory, 'semantic.db')
  const assetPath = join(directory, 'assets')
  let db = new AppDatabase(databasePath, assetPath)
  try {
    const record = upsert(db, 'interrupted-trace', '<p>支持按订单编号查看订单详情，中断恢复测试。</p>')
    const contentHash = db.getRecordContentHash(record.uid)
    assert.ok(contentHash)
    assert.equal(db.claimRequirementSemanticCard({
      recordUid: record.uid,
      contentHash,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }), true)
    const startedAt = new Date().toISOString()
    const trace: RequirementSemanticizationAnalysisTrace = {
      version: 1,
      recordUid: record.uid,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings),
      events: [{
        id: 'interrupted-stage-start',
        recordUid: record.uid,
        stage: 'initial',
        kind: 'stage_started',
        timestamp: startedAt,
        message: 'initial 阶段开始'
      }],
      stages: {
        initial: { status: 'running', startedAt, attempts: 1 }
      }
    }
    db.updateRequirementSemanticCardTrace(record.uid, trace)
    db.close()

    db = new AppDatabase(databasePath, assetPath)
    const recovered = db.getRequirementSemanticCardState(record.uid)
    assert.equal(recovered?.status, 'failed')
    assert.match(recovered?.errorMessage ?? '', /应用在语义化处理中断/)
    const recoveredTrace = recovered?.analysisTrace as unknown as RequirementSemanticizationAnalysisTrace
    assert.equal(recoveredTrace.outcome, 'failed')
    assert.ok(recoveredTrace.completedAt)
    assert.equal(recoveredTrace.events[0]?.kind, 'stage_started')
    assert.equal(recoveredTrace.stages.initial?.attempts, 1)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-card-regression-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
    await testLifecycle(db)
    await testFailure(db)
    await testModelSettingsSnapshot(db)
    await testAllUnreadyLimitAndSequentialExecution()
    await testPauseResumeAndStop()
    await testStopPreventsValidationRetry()
    await testInterruptedTraceRecovery()
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'persistent pending/processing/ready/failed lifecycle',
        'three reasoning stages per record',
        'strict schema, evidence and enum validation',
        'real-time auditable stage, validation, retry and divergence events',
        'persisted final adjudication fields, confidence and source evidence',
        'failed and stopped execution traces remain reviewable',
        'incremental trace survives application interruption and startup recovery',
        'audit data excludes raw responses and hidden chain-of-thought payloads',
        'ready-card cache hit without model calls',
        'content/analyzer/model invalidation',
        'atomic model-settings snapshot for signature and execution',
        'global all-unready scope with configurable task size',
        'strict per-record sequential execution',
        'safe stage-boundary pause, resume and stop controls',
        'stop request blocks validation retry calls at the safe boundary',
        'asset-center status filtering',
        'failed output never becomes a usable card'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
