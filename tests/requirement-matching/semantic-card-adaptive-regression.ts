import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
  RequirementSemanticizationService,
  type RequirementSemanticizationModelClient
} from '../../src/main/requirements/semanticization-service'
import { REQUIREMENT_SEMANTIC_FIELDS } from '../../src/main/requirements/semantic-card'
import type { ModelSettings, RequirementSemanticizationTaskSnapshot } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-adaptive-regression-model', thinking: false
}
const knownFields = ['requirementType', 'productDomain', 'module'] as const
const modelFields = REQUIREMENT_SEMANTIC_FIELDS.filter((field) => !knownFields.includes(field as never))

type Assessment = { value: string; confidence: number; evidence: string }
type Payload = {
  task?: string
  recordUid?: string
  sourceText?: string
  analysisPass?: string
  fields?: Record<string, unknown>
  divergentFields?: Record<string, unknown>
}
type Tracker = {
  client: RequirementSemanticizationModelClient
  calls: ModelChatInput[]
  payloads: Payload[]
  maxInFlight: number
}

const upsert = (db: AppDatabase, uid: string) => {
  db.upsertRecord({
    uid, projectId: 'semantic-adaptive-regression', nodeType: 'Requirement', itemId: uid.toUpperCase(),
    parentId: '', name: '订单详情查询', lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement', _valm_ProductDomain: '订单管理', _valm_Module: '订单管理',
      _valm_Description: '<p>用户可以按订单编号查询并查看订单详情；返回对应订单详情。</p><script>不要发送</script>'
    },
    normalizedText: '订单详情查询\n用户可以按订单编号查询并查看订单详情；返回对应订单详情。'
  })
  const record = db.getRecord(uid, false)
  assert.ok(record)
  return record
}

const empty = (): Assessment => ({ value: '', confidence: 0, evidence: '' })

const modelFieldsFor = (sourceText: string, overrides: Partial<Record<string, Assessment>> = {}) => {
  const fields = Object.fromEntries(modelFields.map((field) => [field, empty()])) as Record<string, Assessment>
  const values: Record<string, Assessment> = {
    functionalObject: { value: '订单详情', confidence: 0.96, evidence: '订单详情查询' },
    action: { value: 'add_capability', confidence: 0.96, evidence: '查询' },
    behavior: { value: '用户按订单编号查询并查看订单详情', confidence: 0.96, evidence: '用户可以按订单编号查询并查看订单详情' },
    input: { value: '订单编号', confidence: 0.9, evidence: '订单编号' },
    output: { value: '订单详情', confidence: 0.9, evidence: '订单详情' },
    acceptance: { value: '返回对应订单详情', confidence: 0.88, evidence: '返回对应订单详情' }
  }
  for (const field of modelFields) {
    if (values[field]) fields[field] = values[field]
    if (fields[field].evidence && !sourceText.includes(fields[field].evidence)) fields[field] = empty()
  }
  for (const [field, value] of Object.entries(overrides)) fields[field] = { ...value }
  return fields
}

const responseFor = (recordUid: string, sourceText: string, fields = modelFieldsFor(sourceText)): ModelResponse => ({
  message: {
    role: 'assistant',
    reasoningContent: 'hidden reasoning must not enter the trace',
    content: JSON.stringify({ recordUid, fields, analysisSummary: '原文证据校验通过' })
  },
  usage: { promptTokens: 100, completionTokens: 30, totalDurationMs: 5 }
})

const payloadOf = (input: ModelChatInput): Payload => {
  const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload
  assert.ok(payload.recordUid)
  assert.ok(payload.sourceText)
  assert.equal(payload.sourceText.includes('<p>'), false)
  assert.equal(payload.sourceText.includes('<script>'), false)
  return payload
}

const assertRequest = (input: ModelChatInput, quality: 'standard' | 'strict'): void => {
  assert.equal(input.stream, false, 'structured semantic calls must not stream')
  assert.equal(input.think, quality === 'strict')
  assert.equal(input.forceThinking, quality === 'strict')
  assert.equal(input.temperature, 0)
  assert.equal(input.timeoutMs, REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS)
  assert.ok(Number.isInteger(input.numCtx) && (input.numCtx ?? 0) >= 4096 && (input.numCtx ?? 0) <= 24576)
  assert.ok(Number.isInteger(input.numPredict) && (input.numPredict ?? 0) > 0)
  if (quality === 'standard') assert.ok((input.numPredict ?? Infinity) <= 1200)
  else assert.ok((input.numPredict ?? 0) <= 2400)
  assert.ok(input.format && typeof input.format === 'object')
  const format = input.format as Record<string, unknown>
  const fieldsSchema = ((format.properties as Record<string, unknown>).fields) as Record<string, unknown>
  const required = fieldsSchema.required as unknown[]
  const properties = fieldsSchema.properties as Record<string, unknown>
  for (const field of knownFields) {
    assert.equal(required.includes(field), false, `${field} must not be model-required`)
    assert.equal(Object.prototype.hasOwnProperty.call(properties, field), false, `${field} must not be model-generated`)
  }
}

const trackerFor = (
  response: (input: ModelChatInput, payload: Payload, index: number) => ModelResponse
): Tracker => {
  const calls: ModelChatInput[] = []
  const payloads: Payload[] = []
  let inFlight = 0
  let maxInFlight = 0
  const client: RequirementSemanticizationModelClient = {
    chat(input) {
      const index = calls.length
      calls.push(input)
      const payload = payloadOf(input)
      payloads.push(payload)
      assertRequest(input, input.think ? 'strict' : 'standard')
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      let result: ModelResponse
      try {
        result = response(input, payload, index)
      } catch (error) {
        inFlight -= 1
        return Promise.reject(error)
      }
      // The finally callback runs after Promise.all has invoked both strict calls.
      return Promise.resolve(result).finally(() => { inFlight -= 1 })
    }
  }
  return { client, calls, payloads, get maxInFlight() { return maxInFlight } } as Tracker
}

const withDb = async <T>(name: string, callback: (db: AppDatabase) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), `semantic-adaptive-${name}-`))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try { return await callback(db) } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const waitFor = async (
  service: RequirementSemanticizationService,
  status: RequirementSemanticizationTaskSnapshot['status']
): Promise<RequirementSemanticizationTaskSnapshot> => {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    const task = service.getTask()
    if (task?.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`semanticization task did not reach ${status}`)
}

const serviceFor = (db: AppDatabase, tracker: Tracker) => new RequirementSemanticizationService(
  db, () => settings, undefined, () => tracker.client
)

const testThinkingAndQualityModeCompatibility = async (): Promise<void> => {
  const cases: Array<{
    name: string
    input: { deepThinking?: boolean; qualityMode?: 'standard' | 'strict' }
    expected: 'standard' | 'strict'
    calls: number
  }> = [
    { name: 'deep-true', input: { deepThinking: true }, expected: 'strict', calls: 2 },
    { name: 'deep-false', input: { deepThinking: false }, expected: 'standard', calls: 1 },
    { name: 'quality-strict', input: { qualityMode: 'strict' }, expected: 'strict', calls: 2 },
    { name: 'quality-standard', input: { qualityMode: 'standard' }, expected: 'standard', calls: 1 }
  ]
  for (const testCase of cases) {
    await withDb(`compat-${testCase.name}`, async (db) => {
      const record = upsert(db, `compat-${testCase.name}`)
      const tracker = trackerFor((_input, payload) => responseFor(payload.recordUid!, payload.sourceText!))
      const service = serviceFor(db, tracker)
      service.start({ recordUids: [record.uid], ...testCase.input })
      assert.equal(service.getTask()?.qualityMode, testCase.expected)
      assert.equal(service.getTask()?.deepThinking, testCase.expected === 'strict')
      const task = await waitFor(service, 'completed')
      assert.equal(task.succeeded, 1)
      assert.equal(tracker.calls.length, testCase.calls)
      assert.equal(tracker.calls.every((input) => input.think === (testCase.expected === 'strict')), true)
    })
  }
}

const testReadyCacheAndModelInvalidation = async (): Promise<void> => withDb('cache-model', async (db) => {
  const record = upsert(db, 'cache-model')
  const tracker = trackerFor((_input, payload) => responseFor(payload.recordUid!, payload.sourceText!))
  let currentSettings = settings
  const createService = () => new RequirementSemanticizationService(
    db, () => currentSettings, undefined, () => tracker.client
  )
  const service = createService()
  const first = service.start({ recordUids: [record.uid] })
  assert.equal(first.accepted, 1)
  await waitFor(service, 'completed')
  assert.equal(tracker.calls.length, 1)

  const hit = service.start({ recordUids: [record.uid] })
  assert.equal(hit.accepted, 0)
  assert.equal(hit.skipped, 1)
  assert.equal(tracker.calls.length, 1, 'same-signature ready cache hit must make zero model calls')

  currentSettings = { ...settings, model: 'semantic-adaptive-regression-model-v2' }
  const changedModelService = createService()
  const changed = changedModelService.start({ recordUids: [record.uid] })
  assert.equal(changed.accepted, 1, 'model configuration changes must invalidate a ready card')
  await waitFor(changedModelService, 'completed')
  assert.equal(tracker.calls.length, 2)
})

const createDeferredModel = (): {
  client: RequirementSemanticizationModelClient
  calls: ModelChatInput[]
  releasePending: () => void
  enableAutomaticResponses: () => void
} => {
  const calls: ModelChatInput[] = []
  const pending: Array<() => void> = []
  let automatic = false
  const client: RequirementSemanticizationModelClient = {
    chat(input) {
      calls.push(input)
      const payload = payloadOf(input)
      assertRequest(input, input.think ? 'strict' : 'standard')
      const response = responseFor(payload.recordUid!, payload.sourceText!)
      if (automatic) return Promise.resolve(response)
      return new Promise<ModelResponse>((resolve) => pending.push(() => resolve(response)))
    }
  }
  return {
    client,
    calls,
    releasePending: () => pending.splice(0).forEach((resolve) => resolve()),
    enableAutomaticResponses: () => { automatic = true }
  }
}

const waitForCallCount = async (calls: ModelChatInput[], count: number): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`model stub did not receive ${count} calls`)
}

const testStopAndPauseBoundaries = async (): Promise<void> => {
  await withDb('queued-stop', async (db) => {
    const record = upsert(db, 'queued-stop')
    const controlled = createDeferredModel()
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => controlled.client)
    service.start({ recordUids: [record.uid] })
    service.control('stop')
    const task = await waitFor(service, 'stopped')
    assert.equal(task.completed, 0)
    assert.equal(controlled.calls.length, 0, 'queued stop must prevent every model call')
  })

  await withDb('pause-boundary', async (db) => {
    const first = upsert(db, 'pause-first')
    const second = upsert(db, 'pause-second')
    const controlled = createDeferredModel()
    const service = new RequirementSemanticizationService(db, () => settings, undefined, () => controlled.client)
    service.start({ recordUids: [first.uid, second.uid] })
    await waitForCallCount(controlled.calls, 1)
    assert.equal(service.control('pause')?.status, 'pausing')
    controlled.releasePending()
    const paused = await waitFor(service, 'paused')
    assert.equal(paused.completed, 0)
    assert.equal(controlled.calls.length, 1, 'pause at a stage boundary must not start the next record')
    controlled.enableAutomaticResponses()
    service.control('resume')
    const completed = await waitFor(service, 'completed')
    assert.equal(completed.succeeded, 2)
    assert.equal(controlled.calls.length, 2)
  })
}

const testStandardHealthy = async (): Promise<void> => withDb('standard-healthy', async (db) => {
  const record = upsert(db, 'standard-healthy')
  const tracker = trackerFor((_input, payload) => responseFor(payload.recordUid!, payload.sourceText!))
  const service = serviceFor(db, tracker)
  service.start({ recordUids: [record.uid] })
  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 1)
  assert.equal(task.qualityMode, 'standard')
  assert.equal(tracker.calls.length, 1, 'healthy standard path must use one model call')
  assert.equal(tracker.maxInFlight, 1)
  const card = db.getRequirementSemanticCardState(record.uid)?.card
  assert.ok(card)
  assert.equal(card.requirementType, 'Enhancement')
  assert.equal(card.productDomain, '订单管理')
  assert.equal(card.module, '订单管理')
})

const testStandardRepairAndFailClosed = async (): Promise<void> => {
  await withDb('standard-repair', async (db) => {
    const record = upsert(db, 'standard-repair')
    const tracker = trackerFor((_input, payload, index) => {
      if (payload.task === 'repair_low_confidence_semantic_fields') {
        assert.deepEqual(Object.keys(payload.fields ?? {}), ['functionalObject'])
        return responseFor(payload.recordUid!, payload.sourceText!, {
          functionalObject: { value: '订单详情', confidence: 0.96, evidence: '订单详情查询' }
        })
      }
      return responseFor(payload.recordUid!, payload.sourceText!, modelFieldsFor(payload.sourceText!, {
        functionalObject: { value: '订单详情', confidence: index === 0 ? 0.4 : 0.4, evidence: '订单详情查询' }
      }))
    })
    const service = serviceFor(db, tracker)
    service.start({ recordUids: [record.uid] })
    const task = await waitFor(service, 'completed')
    assert.equal(task.succeeded, 1)
    assert.equal(tracker.calls.length, 2, 'low confidence permits one targeted repair')
    assert.equal(tracker.payloads[1].task, 'repair_low_confidence_semantic_fields')
  })

  await withDb('standard-invalid', async (db) => {
    const record = upsert(db, 'standard-invalid')
    const tracker = trackerFor((_input, payload) => responseFor(payload.recordUid!, payload.sourceText!, {
      ...modelFieldsFor(payload.sourceText!),
      action: { value: 'not-an-action', confidence: 0.9, evidence: '查询' }
    }))
    const service = serviceFor(db, tracker)
    service.start({ recordUids: [record.uid] })
    const task = await waitFor(service, 'completed')
    assert.equal(task.succeeded, 0, 'exhausted validation repair must fail closed')
    assert.equal(task.failed, 1)
    assert.equal(tracker.calls.length, 2, 'validation failure permits one repair and no retry cascade')
    assert.equal(db.getRequirementSemanticCardState(record.uid)?.card, null)
  })
}

const testStrictRouting = async (): Promise<void> => {
  for (const divergent of [false, true]) {
    await withDb(`strict-${divergent ? 'divergent' : 'stable'}`, async (db) => {
      const record = upsert(db, `strict-${divergent ? 'divergent' : 'stable'}`)
      const tracker = trackerFor((_input, payload) => {
        if (payload.analysisPass === 'adjudication') {
          assert.ok(payload.divergentFields)
          assert.ok(Object.hasOwn(payload.divergentFields, 'functionalObject'))
          return responseFor(payload.recordUid!, payload.sourceText!, {
            functionalObject: { value: '订单详情', confidence: 0.98, evidence: '订单详情查询' }
          })
        }
        return responseFor(payload.recordUid!, payload.sourceText!, divergent && payload.analysisPass === 'independent'
          ? modelFieldsFor(payload.sourceText!, {
            functionalObject: { value: '订单信息', confidence: 0.82, evidence: '订单详情查询' }
          })
          : modelFieldsFor(payload.sourceText!))
      })
      const service = serviceFor(db, tracker)
      service.start({ recordUids: [record.uid], qualityMode: 'strict' })
      const task = await waitFor(service, 'completed')
      assert.equal(task.succeeded, 1)
      assert.equal(tracker.maxInFlight, 2, 'strict initial and independent calls must run concurrently')
      assert.equal(tracker.payloads.filter((item) => item.analysisPass === 'initial').length, 1)
      assert.equal(tracker.payloads.filter((item) => item.analysisPass === 'independent').length, 1)
      assert.equal(tracker.payloads.filter((item) => item.analysisPass === 'adjudication').length, divergent ? 1 : 0)
      assert.equal(tracker.calls.length, divergent ? 3 : 2,
        divergent ? 'divergence adds one adjudication call' : 'stable agreement skips adjudication')
    })
  }
}

const main = async (): Promise<void> => {
  await testThinkingAndQualityModeCompatibility()
  await testReadyCacheAndModelInvalidation()
  await testStopAndPauseBoundaries()
  await testStandardHealthy()
  await testStandardRepairAndFailClosed()
  await testStrictRouting()
  console.log('semantic-card-adaptive-regression: ok')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  // Keep the npm script fail-fast: assertions must produce a non-zero exit.
  process.exitCode = 1
})
