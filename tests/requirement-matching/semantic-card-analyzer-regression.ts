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

const removeTemporaryDirectory = async (directory: string): Promise<void> => {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  throw lastError
}

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-regression-model',
  thinking: false
}

const semanticizationStageTimeoutMs = 15 * 60 * 1000

type SemanticizationModelRequest = ModelChatInput & { timeoutMs?: number }

const requestTimeoutMs = (input: ModelChatInput): number | undefined =>
  (input as SemanticizationModelRequest).timeoutMs

const assertSemanticizationStream = (input: ModelChatInput): void => {
  assert.equal(input.stream, true, 'all semanticization model requests must use Ollama streaming')
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

const upsertSemanticRegressionRecord = (
  db: AppDatabase,
  input: {
    uid: string
    itemId: string
    name: string
    description: string
    normalizedText: string
    module?: string
    productDomain?: string
  }
): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'semantic-regression',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_Module: input.module ?? '',
      _valm_ProductDomain: input.productDomain ?? '',
      _valm_Description: input.description
    },
    normalizedText: input.normalizedText
  })
  const record = db.getRecord(input.uid, false)
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
        assertSemanticizationStream(input)
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
        assertSemanticizationStream(input)
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

  // normalizedText is a derived/search representation. Metadata-only changes
  // must not invalidate a ready semantic card whose business source is stable.
  db.updateRecordNormalizedText(record.uid, `${record.normalizedText}\n内容发生变化`)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, context).total, 0)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'ready' }, context).total, 1)
  const metadataOnlyHash = db.getRecordContentHash(record.uid)
  assert.equal(metadataOnlyHash, contentHash)
  assert.ok(db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...context }))

  // A real business-source change must invalidate the card. Use the public
  // record upsert contract so name, description and raw business fields are
  // hashed exactly as production writes them.
  const changedDescription = '<p>支持查看订单详情和状态。</p>'
  db.upsertRecord({
    uid: record.uid,
    projectId: record.projectId,
    nodeType: record.nodeType,
    itemId: record.itemId,
    parentId: record.parentId,
    name: '订单详情查询增强',
    lastModifyTime: record.lastModifyTime,
    raw: {
      ...record.raw,
      _valm_Description: changedDescription
    },
    normalizedText: `订单详情查询增强\n${changedDescription}`
  })
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
  assert.equal(model.calls.length, 4, 'invalid field output receives targeted repair and final evidence calibration before failing closed')
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
  assert.equal(trace?.stages?.initial?.attempts, 4)
  assert.ok(!JSON.stringify(trace).includes('rawResponse'), 'failed audit trace must not persist raw model output')
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'failed' }, service.context()).total, 1)
}

const testEvidenceRepairRetry = async (db: AppDatabase): Promise<void> => {
  const record = upsert(
    db,
    'semantic-evidence-repair-uid',
    '<p>用户可按订单编号查询并查看订单详情。</p>'
  )
  const calls: ModelChatInput[] = []
  let recordUid = ''
  let sourceText = ''
  const client = {
    async chat(input: ModelChatInput): Promise<ModelResponse> {
      calls.push(input)
      assertSemanticizationStream(input)
      const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
        task?: string
        recordUid?: string
        sourceText?: string
        analysisPass?: string
        validationError?: string
        instructions?: string[]
      }

      if (calls.length === 1) {
        assert.equal(payload.analysisPass, 'initial')
        assert.ok(payload.recordUid)
        assert.ok(payload.sourceText)
        recordUid = payload.recordUid
        sourceText = payload.sourceText
        const invalid = JSON.parse(outputFor(recordUid, sourceText)) as {
          fields: Record<string, { value: string; confidence: number; evidence: string }>
        }
        invalid.fields.requirementType.evidence = '这是一项功能增强需求'
        invalid.fields.productDomain.evidence = '属于订单业务域'
        invalid.fields.action.evidence = '新增订单详情查询能力'
        assert.ok(!sourceText.includes(invalid.fields.requirementType.evidence))
        assert.ok(!sourceText.includes(invalid.fields.productDomain.evidence))
        assert.ok(!sourceText.includes(invalid.fields.action.evidence))
        return { message: { role: 'assistant', content: JSON.stringify(invalid) } }
      }

      if (calls.length === 2) {
        assert.equal(payload.task, 'repair_semantic_output')
        assert.equal(payload.sourceText, sourceText)
        assert.match(payload.validationError ?? '', /证据不在原文中/)
        const repairInstructions = (payload.instructions ?? []).join('\n')
        assert.match(repairInstructions, /逐字连续片段/)
        assert.match(repairInstructions, /(?:无法|不能|找不到).*置空|找不到.*置空/)
        return { message: { role: 'assistant', content: outputFor(recordUid, sourceText) } }
      }

      assert.ok(payload.recordUid)
      assert.ok(payload.sourceText)
      return { message: { role: 'assistant', content: outputFor(payload.recordUid, payload.sourceText) } }
    }
  }
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settings,
    (progress) => listener?.(progress),
    () => client
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )

  assert.equal(completed.failed, 0)
  assert.equal(completed.succeeded, 1)
  assert.equal(calls.length, 4, 'initial evidence repair must add one retry before independent review and adjudication')
  assert.deepEqual(calls.map((call) => semanticPromptPayload(call).analysisPass), [
    'initial', 'initial', 'independent', 'adjudication'
  ])
  assert.ok(calls.every((call) => call.stream === true))
  const state = db.getRequirementSemanticCardState(record.uid)
  assert.equal(state?.status, 'ready')
  assert.equal(state?.analysisTrace?.stages.initial?.attempts, 2)
  assert.ok(state?.analysisTrace?.events.some((event) => event.kind === 'validation_failed'))
  assert.ok(state?.analysisTrace?.events.some((event) => event.kind === 'retry'))
  assert.ok(state?.analysisTrace?.events.some((event) => event.kind === 'validation_passed' && event.attempt === 2))
}

const semanticPromptPayload = (input: ModelChatInput): Record<string, unknown> => {
  const content = input.messages.at(-1)?.content ?? '{}'
  return JSON.parse(content) as Record<string, unknown>
}

const semanticResponseRequiredFields = (input: ModelChatInput): unknown[] => {
  if (!input.format || typeof input.format !== 'object' || Array.isArray(input.format)) return []
  const fields = (input.format as {
    properties?: { fields?: { required?: unknown[] } }
  }).properties?.fields
  return Array.isArray(fields?.required) ? fields.required : []
}

type CoreRepairAssessment = {
  value: string
  confidence: number
  evidence: string
}

type CoreRepairScenario = {
  uid: string
  invalidFields: Array<'functionalObject' | 'behavior'>
  makeInvalid(fields: Record<string, CoreRepairAssessment>): void
}

const testTargetedCoreFieldRepair = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-core-repair-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  const scenarios: CoreRepairScenario[] = [
    {
      uid: 'semantic-missing-core-fields',
      invalidFields: ['functionalObject', 'behavior'],
      makeInvalid(fields): void {
        fields.functionalObject = { value: '', confidence: 0, evidence: '' }
        fields.behavior = { value: '', confidence: 0, evidence: '' }
      }
    },
    {
      uid: 'semantic-invalid-behavior-evidence',
      invalidFields: ['behavior'],
      makeInvalid(fields): void {
        fields.behavior = {
          value: '用户按订单编号查询并查看订单详情',
          confidence: 0.96,
          evidence: '系统自动生成对账单'
        }
      }
    }
  ]

  try {
    for (const scenario of scenarios) {
      const record = upsert(
        db,
        scenario.uid,
        '<p>用户可按订单编号查询并查看订单详情。</p>'
      )
      const calls: ModelChatInput[] = []
      let recordUid = ''
      let sourceText = ''
      const validOutput = (): string => {
        const output = JSON.parse(outputFor(recordUid, sourceText)) as {
          fields: Record<string, CoreRepairAssessment>
          analysisSummary: string
        }
        output.fields.functionalObject = {
          value: '订单详情',
          confidence: 0.96,
          evidence: '订单详情查询'
        }
        output.fields.behavior = {
          value: '用户按订单编号查询并查看订单详情',
          confidence: 0.96,
          evidence: '用户可按订单编号查询并查看订单详情。'
        }
        output.analysisSummary = '定向修复根据原文补齐核心语义字段'
        return JSON.stringify(output)
      }
      const client = {
        async chat(input: ModelChatInput): Promise<ModelResponse> {
          calls.push(input)
          assertSemanticizationStream(input)
          const payload = semanticPromptPayload(input) as {
            task?: string
            recordUid?: string
            sourceText?: string
            analysisPass?: string
            invalidFields?: unknown
            lockedValidFields?: unknown
          }

          if (calls.length === 1) {
            assert.equal(payload.analysisPass, 'initial')
            assert.ok(payload.recordUid)
            assert.ok(payload.sourceText)
            recordUid = payload.recordUid
            sourceText = payload.sourceText
            assert.ok(sourceText.includes('用户可按订单编号查询并查看订单详情。'))
            const invalid = JSON.parse(validOutput()) as {
              fields: Record<string, CoreRepairAssessment>
            }
            scenario.makeInvalid(invalid.fields)
            return { message: { role: 'assistant', content: JSON.stringify(invalid) } }
          }

          if (calls.length === 2) {
            assert.equal(payload.task, 'repair_semantic_output')
            assert.equal(payload.analysisPass, 'initial')
            assert.equal(payload.sourceText, sourceText)
            const invalid = JSON.parse(validOutput()) as {
              fields: Record<string, CoreRepairAssessment>
            }
            scenario.makeInvalid(invalid.fields)
            return { message: { role: 'assistant', content: JSON.stringify(invalid) } }
          }

          if (calls.length === 3) {
            assert.equal(payload.task, 'repair_invalid_semantic_fields')
            assert.equal(payload.analysisPass, 'initial')
            assert.equal(payload.recordUid, recordUid)
            assert.equal(payload.sourceText, sourceText)
            assert.deepEqual(payload.invalidFields, scenario.invalidFields)
            assert.deepEqual(semanticResponseRequiredFields(input), scenario.invalidFields)
            assert.ok(payload.lockedValidFields && typeof payload.lockedValidFields === 'object')
            for (const field of REQUIREMENT_SEMANTIC_FIELDS.filter((field) => !scenario.invalidFields.includes(field as 'functionalObject' | 'behavior'))) {
              assert.ok(
                Object.prototype.hasOwnProperty.call(payload.lockedValidFields as Record<string, unknown>, field),
                `${field} must remain locked during targeted repair`
              )
            }
            const repaired = JSON.parse(validOutput()) as {
              fields: Record<string, CoreRepairAssessment>
              recordUid: string
              analysisSummary: string
            }
            return {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  recordUid: repaired.recordUid,
                  analysisSummary: repaired.analysisSummary,
                  fields: Object.fromEntries(scenario.invalidFields.map((field) => [field, repaired.fields[field]]))
                })
              }
            }
          }

          if (payload.analysisPass === 'adjudication') {
            return { message: { role: 'assistant', content: validOutput() } }
          }
          assert.equal(payload.analysisPass, 'independent')
          return { message: { role: 'assistant', content: validOutput() } }
        }
      }
      let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
      const service = new RequirementSemanticizationService(
        db,
        () => settings,
        (progress) => listener?.(progress),
        () => client
      )
      const completed = await waitForJob(
        () => service.start({ recordUids: [record.uid] }),
        (resolve) => { listener = resolve }
      )

      assert.equal(completed.failed, 0, JSON.stringify(completed.recentItems))
      assert.equal(completed.succeeded, 1)
       assert.equal(calls.length, 5, 'targeted core-field repair must complete before independent review and adjudication')
      const state = db.getRequirementSemanticCardState(record.uid)
      assert.equal(state?.status, 'ready')
      assert.ok(state?.card)
      assert.equal(state.card.functionalObject, '订单详情')
      assert.equal(state.card.behavior, '用户按订单编号查询并查看订单详情')
      assert.ok(sourceText.includes(state.card.fieldAssessments.functionalObject.evidence))
      assert.ok(sourceText.includes(state.card.fieldAssessments.behavior.evidence))
      assert.equal(state.analysisTrace?.stages.initial?.attempts, 3)
      assert.deepEqual(
        state.analysisTrace?.events
          .filter((event) => event.stage === 'initial' && event.kind === 'retry')
          .map((event) => event.attempt),
        [2, 3]
      )
    }
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testTargetedCoreFieldRepairFailsWithoutEvidence = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-core-repair-failure-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(
      db,
      'semantic-core-repair-no-evidence',
      '<p>用户可按订单编号查询并查看订单详情。</p>'
    )
    const calls: ModelChatInput[] = []
    let recordUid = ''
    let sourceText = ''
    const invalidBehavior = (): CoreRepairAssessment => ({
      value: '系统自动生成对账单',
      confidence: 0.96,
      evidence: '系统自动生成对账单'
    })
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = semanticPromptPayload(input) as {
          task?: string
          recordUid?: string
          sourceText?: string
          analysisPass?: string
          invalidFields?: unknown
        }
        if (calls.length === 1) {
          assert.equal(payload.analysisPass, 'initial')
          assert.ok(payload.recordUid)
          assert.ok(payload.sourceText)
          recordUid = payload.recordUid
          sourceText = payload.sourceText
          assert.ok(!sourceText.includes('系统自动生成对账单'))
        } else if (calls.length === 2) {
          assert.equal(payload.task, 'repair_semantic_output')
          assert.equal(payload.sourceText, sourceText)
        } else if (calls.length === 3) {
          assert.equal(payload.task, 'repair_invalid_semantic_fields')
          assert.equal(payload.recordUid, recordUid)
          assert.equal(payload.sourceText, sourceText)
          assert.deepEqual(payload.invalidFields, ['behavior'])
          assert.deepEqual(semanticResponseRequiredFields(input), ['behavior'])
        } else if (calls.length === 4) {
          assert.equal(payload.task, 'final_repair_invalid_semantic_fields')
          assert.equal(payload.recordUid, recordUid)
          assert.equal(payload.sourceText, sourceText)
          assert.deepEqual(payload.invalidFields, ['behavior'])
          assert.deepEqual(semanticResponseRequiredFields(input), ['behavior'])
        } else {
          assert.fail('an invalid final repair must not start independent review')
        }
        const invalid = JSON.parse(outputFor(recordUid || payload.recordUid || '', sourceText || payload.sourceText || '')) as {
          fields: Record<string, CoreRepairAssessment>
        }
        invalid.fields.behavior = invalidBehavior()
        return { message: { role: 'assistant', content: JSON.stringify(invalid) } }
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [record.uid] }),
      (resolve) => { listener = resolve }
    )

    assert.equal(completed.failed, 1)
    assert.equal(completed.succeeded, 0)
    assert.equal(calls.length, 4, 'targeted repair without source evidence must fail closed after final calibration')
    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'failed')
    assert.equal(state?.card, null)
    assert.match(state?.errorMessage ?? '', /behavior.*证据不在原文中/)
    assert.equal(state?.analysisTrace?.outcome, 'failed')
    assert.equal(state?.analysisTrace?.stages.initial?.attempts, 4)
    assert.ok(state?.analysisTrace?.events.some((event) => event.kind === 'validation_failed' && event.attempt === 4))
    assert.ok(!state?.analysisTrace?.events.some((event) => event.stage === 'independent'))
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testActionWithoutEvidenceRepairsToUnknown = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-action-unknown-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsertSemanticRegressionRecord(db, {
      uid: 'semantic-review-summary-action',
      itemId: 'VISSLM-TSIS-7',
      name: '在线评审模块-评审简述页面需要被评人填写被评文件的所有基本信息',
      description: '<p>评审简述页中，需要被评人填写被评文件的所有基本信息，即简述页面可显示该评审关联技术评审活动的默认视图。</p>',
      normalizedText: '在线评审模块-评审简述页面需要被评人填写被评文件的所有基本信息',
      module: '在线评审'
    })
    const calls: ModelChatInput[] = []
    let recordUid = ''
    let sourceText = ''
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = semanticPromptPayload(input) as {
          task?: string
          recordUid?: string
          sourceText?: string
          analysisPass?: string
          invalidFields?: unknown
          sourceEvidenceSegments?: unknown
        }
        if (calls.length === 1) {
          recordUid = String(payload.recordUid)
          sourceText = String(payload.sourceText)
          const invalid = JSON.parse(outputFor(recordUid, sourceText)) as {
            fields: Record<string, CoreRepairAssessment>
          }
          invalid.fields.action = { value: 'add_capability', confidence: 0.8, evidence: '' }
          return { message: { role: 'assistant', content: JSON.stringify(invalid) } }
        }
        if (calls.length === 2) {
          assert.equal(payload.task, 'repair_semantic_output')
          const repaired = JSON.parse(outputFor(recordUid, sourceText)) as {
            fields: Record<string, CoreRepairAssessment>
          }
          repaired.fields.action = { value: 'unknown', confidence: 0, evidence: '' }
          return { message: { role: 'assistant', content: JSON.stringify(repaired) } }
        }
        if (payload.analysisPass === 'adjudication') {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                recordUid,
                analysisSummary: '原文没有可验证的动作证据，保守裁决为 unknown',
                fields: { action: { value: 'unknown', confidence: 0, evidence: '' } }
              })
            }
          }
        }
        assert.equal(payload.analysisPass, 'independent')
        const stable = JSON.parse(outputFor(recordUid, sourceText)) as {
          fields: Record<string, CoreRepairAssessment>
        }
        stable.fields.action = { value: 'unknown', confidence: 0, evidence: '' }
        return { message: { role: 'assistant', content: JSON.stringify(stable) } }
      }
    }
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => client)
    service.start({ recordUids: [record.uid] })
    const completed = await waitForTaskStatus(service, 'completed')
    assert.equal(completed.failed, 0, JSON.stringify(completed.recentItems))
    assert.equal(completed.succeeded, 1)
    assert.equal(calls.length, 4)
    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'ready')
    assert.equal(state?.card?.action, 'unknown')
    assert.deepEqual(state?.card?.fieldAssessments.action, { value: 'unknown', confidence: 0, evidence: '' })
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testTitleOnlyCoreFieldsUseFinalAiRepair = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-title-only-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const title = '客户电脑上工作区“部门”显示异常'
    const record = upsertSemanticRegressionRecord(db, {
      uid: 'semantic-title-only-core-fields',
      itemId: 'VISSLM-TSIS-99',
      name: title,
      description: '<p><img src="FileCenterImg/index/example.png" /></p>',
      normalizedText: title,
      module: '工作区'
    })
    const calls: ModelChatInput[] = []
    let recordUid = ''
    let sourceText = ''
    const invalidOutput = (): string => {
      const output = JSON.parse(outputFor(recordUid, sourceText)) as {
        fields: Record<string, CoreRepairAssessment>
      }
      output.fields.functionalObject = { value: '', confidence: 0, evidence: '' }
      output.fields.behavior = { value: '', confidence: 0, evidence: '' }
      output.fields.action = { value: 'unknown', confidence: 0, evidence: '' }
      return JSON.stringify(output)
    }
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = semanticPromptPayload(input) as {
          task?: string
          recordUid?: string
          sourceText?: string
          invalidFields?: unknown
          sourceEvidenceSegments?: unknown
          analysisPass?: string
        }
        if (calls.length === 1) {
          recordUid = String(payload.recordUid)
          sourceText = String(payload.sourceText)
          assert.ok(sourceText.includes(title))
          return { message: { role: 'assistant', content: invalidOutput() } }
        }
        if (calls.length === 2) {
          assert.equal(payload.task, 'repair_semantic_output')
          return { message: { role: 'assistant', content: invalidOutput() } }
        }
        if (calls.length === 3) {
          assert.equal(payload.task, 'repair_invalid_semantic_fields')
          return { message: { role: 'assistant', content: invalidOutput() } }
        }
        if (calls.length === 4) {
          assert.equal(payload.task, 'final_repair_invalid_semantic_fields')
          assert.deepEqual(payload.invalidFields, ['functionalObject', 'behavior'])
          assert.ok(Array.isArray(payload.sourceEvidenceSegments))
          assert.ok((payload.sourceEvidenceSegments as string[]).some((line) => line.includes(title)))
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                recordUid,
                analysisSummary: '根据标题完成核心语义最终校准',
                fields: {
                  functionalObject: { value: '工作区部门字段', confidence: 0.9, evidence: title },
                  behavior: { value: '客户电脑上的工作区部门字段显示异常', confidence: 0.9, evidence: title },
                  action: { value: 'unknown', confidence: 0, evidence: '' }
                }
              })
            }
          }
        }
        if (payload.analysisPass === 'adjudication') {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                recordUid,
                analysisSummary: '根据标题裁决核心字段',
                fields: {
                  functionalObject: { value: '工作区部门字段', confidence: 0.9, evidence: title },
                  behavior: { value: '客户电脑上的工作区部门字段显示异常', confidence: 0.9, evidence: title },
                  action: { value: 'unknown', confidence: 0, evidence: '' }
                }
              })
            }
          }
        }
        assert.equal(payload.analysisPass, 'independent')
        const stable = JSON.parse(outputFor(recordUid, sourceText)) as {
          fields: Record<string, CoreRepairAssessment>
        }
        stable.fields.functionalObject = { value: '工作区部门字段', confidence: 0.9, evidence: title }
        stable.fields.behavior = { value: '客户电脑上的工作区部门字段显示异常', confidence: 0.9, evidence: title }
        stable.fields.action = { value: 'unknown', confidence: 0, evidence: '' }
        return { message: { role: 'assistant', content: JSON.stringify(stable) } }
      }
    }
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => client)
    service.start({ recordUids: [record.uid] })
    const completed = await waitForTaskStatus(service, 'completed')
    assert.equal(completed.failed, 0, JSON.stringify(completed.recentItems))
    assert.equal(completed.succeeded, 1)
    assert.equal(calls.length, 6)
    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'ready')
    assert.equal(state?.card?.functionalObject, '工作区部门字段')
    assert.equal(state?.card?.behavior, '客户电脑上的工作区部门字段显示异常')
    assert.equal(state?.analysisTrace?.stages.initial?.attempts, 4)
    assert.ok(state?.analysisTrace?.events.some((event) => event.kind === 'validation_passed' && event.attempt === 4))
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testSemanticPerformanceBudgetsAndDynamicContext = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-performance-budget-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const shortRecord = upsert(
      db,
      'semantic-performance-short',
      '<p>支持按订单编号查看订单详情。</p>'
    )
    const longDescription = '<p>支持按订单编号查看订单详情，并保留订单状态、客户信息、物流节点和异常处理说明。</p>'.repeat(2_400)
    const longRecord = upsert(db, 'semantic-performance-long', longDescription)
    const calls: ModelChatInput[] = []
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        assert.equal(typeof input.numCtx, 'number', 'semanticization requests must carry a dynamic context budget')
        assert.equal(Number.isInteger(input.numCtx), true)
        assert.ok((input.numCtx ?? 0) >= 1_024)
        assert.equal(typeof input.numPredict, 'number', 'semanticization requests must carry a stage output budget')
        assert.ok((input.numPredict ?? 0) > 0)
        const payload = semanticPromptPayload(input) as {
          recordUid: string
          sourceText: string
          analysisPass?: string
        }
        const output = JSON.parse(outputFor(payload.recordUid, payload.sourceText)) as {
          fields: Record<string, { value: string; confidence: number; evidence: string }>
          analysisSummary: string
        }
        if (payload.analysisPass === 'independent') {
          output.fields.functionalObject.value = '订单信息'
          output.fields.functionalObject.confidence = 0.82
          output.analysisSummary = '独立复核发现功能对象粒度差异'
        }
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify(output),
            reasoningContent: 'hidden model reasoning must never enter the audit trace'
          },
          usage: {
            promptTokens: 120,
            completionTokens: 40,
            promptDurationMs: 2,
            completionDurationMs: 3,
            totalDurationMs: 5
          }
        }
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [shortRecord.uid, longRecord.uid] }),
      (resolve) => { listener = resolve }
    )

    assert.equal(completed.failed, 0)
    assert.equal(completed.succeeded, 2)
    assert.equal(calls.length, 6, 'divergent two-round results must exercise all three stages per record')
    assert.deepEqual(completed.analysisTrace?.stages.initial?.modelUsage, {
      promptTokens: 120,
      completionTokens: 40,
      promptDurationMs: 2,
      completionDurationMs: 3,
      totalDurationMs: 5
    })
    assert.ok(!JSON.stringify(completed.analysisTrace).includes('hidden model reasoning'))

    const callsFor = (recordUid: string): ModelChatInput[] => calls.filter((input) => {
      const payload = semanticPromptPayload(input)
      return payload.recordUid === recordUid
    })
    const shortCalls = callsFor(shortRecord.uid)
    const longCalls = callsFor(longRecord.uid)
    assert.equal(shortCalls.length, 3)
    assert.equal(longCalls.length, 3)

    const shortInitial = semanticPromptPayload(shortCalls.find((input) => semanticPromptPayload(input).analysisPass === 'initial')!)
    const longInitial = semanticPromptPayload(longCalls.find((input) => semanticPromptPayload(input).analysisPass === 'initial')!)
    assert.ok(String(longInitial.sourceText).length > String(shortInitial.sourceText).length)
    assert.ok(
      (longCalls.find((input) => semanticPromptPayload(input).analysisPass === 'initial')?.numCtx ?? 0) >
        (shortCalls.find((input) => semanticPromptPayload(input).analysisPass === 'initial')?.numCtx ?? 0),
      'a longer source card must receive a larger context budget'
    )

    const budgetsByStage = new Map<string, Set<number>>()
    for (const input of calls) {
      const stage = String(semanticPromptPayload(input).analysisPass ?? '')
      const budget = input.numPredict
      assert.ok(stage)
      assert.equal(typeof budget, 'number')
      if (!budgetsByStage.has(stage)) budgetsByStage.set(stage, new Set())
      budgetsByStage.get(stage)?.add(budget as number)
    }
    assert.deepEqual([...budgetsByStage.keys()].sort(), ['adjudication', 'independent', 'initial'])
    assert.ok([...budgetsByStage.values()].every((budgets) => budgets.size === 1))
    assert.ok(
      new Set([...budgetsByStage.values()].map((budgets) => [...budgets][0])).size >= 2,
      'semantic stages must use stage-specific numPredict budgets rather than one global budget'
    )
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testKnownSourceFieldsRemainLocked = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-locked-fields-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-locked-source-fields', '<p>支持按订单编号查看订单详情。</p>')
    const sourceCard = buildRequirementSemanticCard(record)
    const calls: ModelChatInput[] = []
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = semanticPromptPayload(input) as { recordUid: string; sourceText: string }
        const promptText = input.messages.map((message) => message.content).join('\n')
        assert.match(promptText, new RegExp(`明确需求类型：${sourceCard.requirementType}`))
        assert.match(promptText, new RegExp(`明确产品域：${sourceCard.productDomain}`))
        assert.match(promptText, new RegExp(`明确模块：${sourceCard.module}`))
        const output = JSON.parse(outputFor(payload.recordUid, payload.sourceText)) as {
          fields: Record<string, { value: string; confidence: number; evidence: string }>
          analysisSummary: string
        }
        output.fields.requirementType.value = 'Bug'
        output.fields.productDomain.value = '库存管理'
        output.fields.module.value = '库存管理'
        output.analysisSummary = '模型尝试覆盖原始字段的锁定值'
        return { message: { role: 'assistant', content: JSON.stringify(output) } }
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [record.uid] }),
      (resolve) => { listener = resolve }
    )
    assert.equal(completed.failed, 0)
    assert.ok(calls.length >= 2)

    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'ready')
    assert.ok(state?.card)
    for (const field of ['requirementType', 'productDomain', 'module'] as const) {
      assert.equal(state.card[field], sourceCard[field], `${field} must remain locked to the source card`)
      assert.equal(state.card.fieldAssessments[field].value, sourceCard[field])
    }
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testStableRoundsRunAdjudication = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-stable-rounds-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-stable-rounds', '<p>支持按订单编号查看订单详情。</p>')
    const model = createModel(false, false)
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
    assert.equal(completed.succeeded, 1)
    assert.deepEqual(model.passes, ['initial', 'independent', 'adjudication'])
    assert.equal(model.calls.length, 3, 'identical validated rounds must still run adjudication')
    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'ready')
    assert.equal(state?.card?.functionalObject, '订单详情')
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testAdjudicationReceivesOnlyDivergentFields = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-divergent-fields-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-divergent-fields', '<p>支持按订单编号查看订单详情。</p>')
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
    assert.equal(model.calls.length, 3)
    const adjudicationCall = model.calls.find((input) => semanticPromptPayload(input).analysisPass === 'adjudication')
    assert.ok(adjudicationCall)
    const payload = semanticPromptPayload(adjudicationCall)
    const divergentFields = payload.divergentFields
    assert.ok(
      divergentFields && typeof divergentFields === 'object' && !Array.isArray(divergentFields),
      'adjudication must receive a divergentFields object'
    )
    assert.deepEqual(Object.keys(divergentFields as Record<string, unknown>), ['functionalObject'])
    const functionalObjectDivergence = (divergentFields as Record<string, unknown>).functionalObject
    assert.ok(functionalObjectDivergence && typeof functionalObjectDivergence === 'object')
    assert.deepEqual(Object.keys(functionalObjectDivergence as Record<string, unknown>).sort(), ['independent', 'initial'])
    assert.equal(payload.initial, undefined, 'adjudication must not receive the complete initial result')
    assert.equal(payload.independent, undefined, 'adjudication must not receive the complete independent result')
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
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

const testStageTimeoutContract = async (db: AppDatabase): Promise<void> => {
  const record = upsert(db, 'semantic-stage-timeout-contract', '<p>支持按订单编号查看订单详情，阶段时限测试。</p>')
  const model = createModel()
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
  assert.equal(model.calls.length, 3, 'every completed record must run adjudication')
  assert.deepEqual(
    model.calls.map(requestTimeoutMs),
    [semanticizationStageTimeoutMs, semanticizationStageTimeoutMs, semanticizationStageTimeoutMs],
    'each model request must carry its own 15-minute timeout'
  )
}

const testModelTimeoutFailure = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-model-timeout-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-model-timeout', '<p>支持按订单编号查看订单详情，模型超时测试。</p>')
    const calls: ModelChatInput[] = []
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const timeout = new Error('The operation was aborted due to timeout')
        timeout.name = 'TimeoutError'
        throw timeout
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [record.uid] }),
      (resolve) => { listener = resolve }
    )
    assert.equal(completed.failed, 1)
    assert.equal(calls.length, 1, 'a model timeout must not trigger an identical second model request')
    assert.equal(requestTimeoutMs(calls[0]), semanticizationStageTimeoutMs)

    const state = db.getRequirementSemanticCardState(record.uid)
    assert.equal(state?.status, 'failed')
    const errorMessage = state?.errorMessage ?? ''
    assert.match(errorMessage, /超时/)
    assert.match(errorMessage, /初步|初始|initial/)
    assert.match(errorMessage, /15\s*分钟/)
    assert.match(errorMessage, /建议|请/)
    assert.match(errorMessage, /模型设置|模型配置/)

    const trace = state?.analysisTrace as unknown as RequirementSemanticizationAnalysisTrace
    assert.equal(trace.outcome, 'failed')
    assert.equal(trace.stages.initial?.status, 'failed')
    assert.ok(trace.events.some((event) => event.kind === 'stage_started'))
    assert.ok(!trace.events.some((event) => event.kind === 'validation_failed'))
    assert.ok(!trace.events.some((event) => event.kind === 'retry'))
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testLengthLimitUsesLargerRepairBudget = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-length-retry-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-length-retry', '<p>支持按订单编号查看订单详情，长度重试测试。</p>')
    const calls: ModelChatInput[] = []
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = semanticPromptPayload(input) as { recordUid: string; sourceText: string }
        return {
          done_reason: calls.length === 1 ? 'length' : 'stop',
          message: { role: 'assistant', content: outputFor(payload.recordUid, payload.sourceText) }
        }
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [record.uid] }),
      (resolve) => { listener = resolve }
    )
    assert.equal(completed.failed, 0)
    assert.equal(calls.length, 4)
    assert.ok((calls[1].numPredict ?? 0) > (calls[0].numPredict ?? 0))
    assert.equal(semanticPromptPayload(calls[2]).analysisPass, 'independent')
    assert.equal(semanticPromptPayload(calls[3]).analysisPass, 'adjudication')
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testDeepThinkingTaskOption = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-thinking-option-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const record = upsert(db, 'semantic-thinking-off', '<p>支持按订单编号查看订单详情，思考模式开关测试。</p>')
    const calls: ModelChatInput[] = []
    const client = {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        assertSemanticizationStream(input)
        const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
          recordUid: string
          sourceText: string
        }
        return {
          message: {
            role: 'assistant' as const,
            content: outputFor(payload.recordUid, payload.sourceText)
          }
        }
      }
    }
    let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
    const service = new RequirementSemanticizationService(
      db,
      () => settings,
      (progress) => listener?.(progress),
      () => client
    )
    const completed = await waitForJob(
      () => service.start({ recordUids: [record.uid], deepThinking: false }),
      (resolve) => { listener = resolve }
    )
    assert.equal(completed.failed, 0)
    assert.equal(completed.deepThinking, false)
    assert.equal(calls.length, 3, 'stable validated rounds must still run adjudication')
    assert.ok(calls.every((call) => call.think === false && call.forceThinking === false))
    const standardBudgets = new Map<string, number>([
      ['initial', 2600],
      ['independent', 2200],
      ['adjudication', 1800]
    ])
    assert.ok(calls.every((call) => {
      const payload = semanticPromptPayload(call)
      return call.numPredict === standardBudgets.get(String(payload.analysisPass))
    }))
    const state = db.getRequirementSemanticCardState(record.uid)
    const trace = state?.analysisTrace as unknown as RequirementSemanticizationAnalysisTrace
    assert.equal(trace.deepThinking, false)
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
  }
}

const testAllUnreadyProcessesEveryRecordSequentially = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-bulk-regression-'))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    const uids = ['bulk-a', 'bulk-b', 'bulk-failed', 'bulk-ready', 'bulk-stale']
    uids.forEach((uid) => upsert(db, uid, `<p>支持按订单编号查看订单详情，记录 ${uid}。</p>`))
    const model = createModel()
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => model.client)
    const semanticContext = {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }

    service.start({ scope: 'selected', recordUids: ['bulk-ready', 'bulk-stale'] })
    await waitForTaskStatus(service, 'completed')
    const callsBeforeBulk = model.calls.length
    assert.equal(callsBeforeBulk, 6)
    const bulkStaleBeforeChange = db.getRecord('bulk-stale', false)
    assert.ok(bulkStaleBeforeChange)
    db.updateRecordNormalizedText('bulk-stale', '订单详情查询\n纯元数据变化')
    assert.equal(
      db.getRequirementSemanticCardState('bulk-stale')?.status,
      'ready',
      'normalizedText-only metadata changes must preserve the ready semantic asset'
    )
    const changedDescription = '<p>支持按订单编号查询订单状态，业务字段发生变化。</p>'
    db.upsertRecord({
      uid: bulkStaleBeforeChange.uid,
      projectId: bulkStaleBeforeChange.projectId,
      nodeType: bulkStaleBeforeChange.nodeType,
      itemId: bulkStaleBeforeChange.itemId,
      parentId: bulkStaleBeforeChange.parentId,
      name: '订单详情查询业务变更',
      lastModifyTime: bulkStaleBeforeChange.lastModifyTime,
      raw: {
        ...bulkStaleBeforeChange.raw,
        _valm_Description: changedDescription
      },
      normalizedText: `订单详情查询业务变更\n${changedDescription}`
    })
    const pendingAfterBusinessChange = db.listRecords(
      { page: 1, pageSize: 20, semanticStatus: 'pending' },
      semanticContext
    )
    assert.ok(
      pendingAfterBusinessChange.rows.some((row) => row.uid === 'bulk-stale'),
      'real name/description business changes must expose the stale semantic asset as pending'
    )
    const failedHash = db.getRecordContentHash('bulk-failed')
    assert.ok(failedHash)
    assert.equal(db.claimRequirementSemanticCard({
      recordUid: 'bulk-failed',
      contentHash: failedHash,
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }), true)
    db.failRequirementSemanticCard('bulk-failed', '上次模型调用失败')

    const started = service.start({ scope: 'all_unready' })
    assert.deepEqual(
      { accepted: started.accepted, available: started.available, skipped: started.skipped },
      { accepted: 4, available: 4, skipped: 0 },
      'global task must accept every invalid, missing or stale card'
    )
    const completed = await waitForTaskStatus(service, 'completed')
    assert.equal(completed.total, 4)
    assert.equal(completed.succeeded, 4)
    assert.equal(completed.remaining, 0)
    assert.equal(completed.recentItems.length, 4)

    const bulkCallUids = model.calls.slice(callsBeforeBulk).map((input) => {
      const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as { recordUid: string }
      return payload.recordUid
    })
    assert.deepEqual(
      bulkCallUids,
      [
        'bulk-a', 'bulk-a', 'bulk-a',
        'bulk-b', 'bulk-b', 'bulk-b',
        'bulk-failed', 'bulk-failed', 'bulk-failed',
        'bulk-stale', 'bulk-stale', 'bulk-stale'
      ],
      'the full task must finish every record serially before starting the next record'
    )

    const empty = service.start({ scope: 'all_unready' })
    assert.equal(empty.accepted, 0)
    assert.equal(empty.available, 0)
    assert.equal(service.getTask()?.status, 'completed')
    assert.match(service.getTask()?.message ?? '', /没有需要生成或更新/)
  } finally {
    db.close()
    await removeTemporaryDirectory(directory)
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
    await removeTemporaryDirectory(directory)
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
        assertSemanticizationStream(input)
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
    await removeTemporaryDirectory(directory)
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
    await removeTemporaryDirectory(directory)
  }
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-card-regression-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
    await testLifecycle(db)
    await testFailure(db)
    await testEvidenceRepairRetry(db)
    await testTargetedCoreFieldRepair()
    await testTargetedCoreFieldRepairFailsWithoutEvidence()
    await testActionWithoutEvidenceRepairsToUnknown()
    await testTitleOnlyCoreFieldsUseFinalAiRepair()
    await testStableRoundsRunAdjudication()
    await testAdjudicationReceivesOnlyDivergentFields()
    await testSemanticPerformanceBudgetsAndDynamicContext()
    await testKnownSourceFieldsRemainLocked()
    await testModelSettingsSnapshot(db)
    await testStageTimeoutContract(db)
    await testModelTimeoutFailure()
    await testLengthLimitUsesLargerRepairBudget()
    await testDeepThinkingTaskOption()
    await testAllUnreadyProcessesEveryRecordSequentially()
    await testPauseResumeAndStop()
    await testStopPreventsValidationRetry()
    await testInterruptedTraceRecovery()
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'persistent pending/processing/ready/failed lifecycle',
        'three reasoning stages per record',
        'strict schema, evidence and enum validation',
        'rewritten evidence retry receives validation context and repairs with verbatim source evidence',
        'targeted repair re-analyzes only missing or invalid behavior/functionalObject fields',
        'targeted repair fails closed when core-field evidence is absent from source text',
        'action without source evidence repairs to the explicit unknown enum',
        'title-only records receive final AI repair with verbatim title evidence',
        'every semanticization model request uses streaming mode',
        'stable validated rounds still execute adjudication',
        'adjudication receives only divergent fields',
        'semantic stages use dynamic numCtx and stage-specific numPredict budgets',
        'known source-card fields remain locked against model overrides',
        'real-time auditable stage, validation, retry and divergence events',
        'persisted final adjudication fields, confidence and source evidence',
        'failed and stopped execution traces remain reviewable',
        'incremental trace survives application interruption and startup recovery',
        'audit data excludes raw responses and hidden chain-of-thought payloads',
        'ready-card cache hit without model calls',
        'content/analyzer/model invalidation',
        'atomic model-settings snapshot for signature and execution',
        'independent 15-minute timeout on every semanticization stage request',
        'model timeout is not classified as JSON validation failure or retried identically',
        'length-limited model output retries with a larger stage budget',
        'task-level deep-thinking switch is snapshotted across all three stages and audit metadata',
        'global all-unready scope processes every unready record serially',
        'strict per-record sequential execution',
        'safe stage-boundary pause, resume and stop controls',
        'stop request blocks validation retry calls at the safe boundary',
        'asset-center status filtering',
        'failed output never becomes a usable card'
      ]
    }))
  } finally {
    db?.close()
    await removeTemporaryDirectory(directory)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
