import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
  RequirementSemanticizationService,
  requirementSemanticizationMaxConcurrency,
  type RequirementSemanticizationModelClient
} from '../../src/main/requirements/semanticization-service'
import { REQUIREMENT_SEMANTIC_FIELDS } from '../../src/main/requirements/semantic-card'
import type {
  ModelSettings,
  RequirementSemanticizationAnalysisTrace,
  RequirementSemanticizationProgress,
  RequirementSemanticizationTaskSnapshot
} from '../../src/shared/types'

const localSettings: ModelSettings = {
  source: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-concurrency-regression', thinking: false
}
const onlineSettings: ModelSettings = {
  source: 'online', provider: 'openai', baseUrl: 'https://example.invalid/v1',
  model: 'semantic-concurrency-regression', thinking: false
}
const knownFields = ['requirementType', 'productDomain', 'module'] as const
const modelFields = REQUIREMENT_SEMANTIC_FIELDS.filter((field) => !knownFields.includes(field as never))

type Assessment = { value: string; confidence: number; evidence: string }
type Payload = {
  recordUid?: string
  sourceText?: string
  analysisPass?: string
  reviewerMode?: string
  knownFields?: Record<string, string>
}
type PendingCall = { resolve: (response: ModelResponse) => void; reject: (error: unknown) => void; input: ModelChatInput; payload: Payload }
type SemanticReasoningEffort = 'none' | 'low' | 'medium'
type SemanticModelChatInput = ModelChatInput & { reasoningEffort?: SemanticReasoningEffort }

const empty = (): Assessment => ({ value: '', confidence: 0, evidence: '' })

const outputFor = (recordUid: string, sourceText: string, functionalObject = '订单详情'): ModelResponse => {
  const fields = Object.fromEntries(modelFields.map((field) => [field, empty()])) as Record<string, Assessment>
  Object.assign(fields, {
    functionalObject: { value: functionalObject, confidence: 0.96, evidence: '订单详情查询' },
    action: { value: 'add_capability', confidence: 0.96, evidence: '查询' },
    behavior: { value: '用户按订单编号查询并查看订单详情', confidence: 0.96, evidence: '用户可以按订单编号查询并查看订单详情' },
    input: { value: '订单编号', confidence: 0.9, evidence: '订单编号' },
    output: { value: '订单详情', confidence: 0.9, evidence: '订单详情' },
    acceptance: { value: '返回对应订单详情', confidence: 0.88, evidence: '返回对应订单详情' }
  })
  return {
    message: {
      role: 'assistant',
      reasoningContent: 'not persisted',
      content: JSON.stringify({ recordUid, fields, analysisSummary: 'barrier stub result' })
    },
    usage: { promptTokens: 19, completionTokens: 11, totalDurationMs: 2 }
  }
}

const upsert = (db: AppDatabase, uid: string): void => {
  db.upsertRecord({
    uid,
    projectId: 'semantic-concurrency-regression',
    nodeType: 'Requirement',
    itemId: uid.toUpperCase(),
    parentId: '',
    name: '订单详情查询',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_ProductDomain: '订单管理',
      _valm_Module: '订单管理',
      _valm_Description: '<p>用户可以按订单编号查询并查看订单详情；返回对应订单详情。</p><script>不应发送</script>'
    },
    normalizedText: '订单详情查询\n用户可以按订单编号查询并查看订单详情；返回对应订单详情。'
  })
}

const parsePayload = (input: ModelChatInput): Payload => {
  const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload
  assert.ok(payload.recordUid)
  assert.ok(payload.sourceText)
  assert.equal(payload.sourceText.includes('<p>'), false)
  assert.equal(payload.sourceText.includes('<script>'), false)
  return payload
}

const assertRequest = (input: ModelChatInput, payload: Payload): void => {
  assert.equal(input.stream, false)
  assert.equal(input.temperature, 0)
  assert.equal(input.timeoutMs, REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS)
  const expectedEffort: SemanticReasoningEffort = payload.task?.startsWith('repair_')
    ? 'low'
    : payload.analysisPass === 'adjudication'
      ? 'medium'
      : input.think ? 'low' : 'none'
  assert.equal((input as SemanticModelChatInput).reasoningEffort, expectedEffort)
  assert.ok(Number.isInteger(input.numCtx) && (input.numCtx ?? 0) >= 4096 && (input.numCtx ?? 0) <= 24576)
  assert.ok(Number.isInteger(input.numPredict) && (input.numPredict ?? 0) > 0)
  assert.ok((input.numPredict ?? Infinity) <= (input.think ? 2400 : 1200))
  assert.ok(input.format && typeof input.format === 'object')
  const format = input.format as Record<string, unknown>
  const fieldsSchema = (format.properties as Record<string, unknown>).fields as Record<string, unknown>
  const required = fieldsSchema.required as unknown[]
  const properties = fieldsSchema.properties as Record<string, unknown>
  for (const field of knownFields) {
    assert.equal(required.includes(field), false)
    assert.equal(Object.hasOwn(properties, field), false)
  }
}

/**
 * A deterministic model barrier. Calls stay pending until the test releases
 * exactly a chosen batch; no real network and no long sleep are involved.
 */
const createBarrier = (responseForCall = (_input: ModelChatInput, payload: Payload) => outputFor(payload.recordUid!, payload.sourceText!)) => {
  const calls: ModelChatInput[] = []
  const payloads: Payload[] = []
  const pending: PendingCall[] = []
  let inFlight = 0
  let maxInFlight = 0
  let automatic = false
  const client: RequirementSemanticizationModelClient = {
    chat(input) {
      const payload = parsePayload(input)
      assertRequest(input, payload)
      calls.push(input)
      payloads.push(payload)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      const complete = (resolve: (response: ModelResponse) => void, reject: (error: unknown) => void) => {
        try {
          resolve(responseForCall(input, payload))
        } catch (error) {
          reject(error)
        }
      }
      if (automatic) {
        return new Promise<ModelResponse>((resolve, reject) => {
          queueMicrotask(() => complete(resolve, reject))
        }).finally(() => { inFlight -= 1 })
      }
      return new Promise<ModelResponse>((resolve, reject) => {
        pending.push({ resolve, reject, input, payload })
      }).finally(() => { inFlight -= 1 })
    }
  }
  return {
    client,
    calls,
    payloads,
    get pendingCount() { return pending.length },
    get maxInFlight() { return maxInFlight },
    release(count = pending.length) {
      const batch = pending.splice(0, count)
      batch.forEach(({ resolve, reject, input, payload }) => {
        try { resolve(responseForCall(input, payload)) } catch (error) { reject(error) }
      })
    },
    setAutomatic(value = true) { automatic = value }
  }
}

const withDb = async <T>(name: string, callback: (db: AppDatabase) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), `semantic-concurrency-${name}-`))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try { return await callback(db) } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const waitFor = async (
  service: RequirementSemanticizationService,
  status: RequirementSemanticizationTaskSnapshot['status'],
  timeoutMs = 10_000
): Promise<RequirementSemanticizationTaskSnapshot> => {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const task = service.getTask()
    if (task?.status === status) return task
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`task did not reach ${status}`)
}

const waitForCalls = async (calls: ModelChatInput[], count: number): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    if (calls.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`expected ${count} model calls, got ${calls.length}`)
}

const serviceFor = (
  db: AppDatabase,
  barrier: ReturnType<typeof createBarrier>,
  modelSettings: ModelSettings,
  progress?: (snapshot: RequirementSemanticizationProgress) => void
) => new RequirementSemanticizationService(db, () => modelSettings, progress, () => barrier.client)

const assertMetricSnapshots = (snapshots: RequirementSemanticizationProgress[]): void => {
  for (const snapshot of snapshots) {
    for (const value of [snapshot.elapsedMs, snapshot.recordsPerMinute, snapshot.estimatedRemainingMs]) {
      if (value !== undefined) assert.ok(Number.isFinite(value) && value >= 0, 'metrics must be finite and non-negative')
    }
    const active = snapshot.activeRecords ?? []
    assert.equal(snapshot.activeCount ?? active.length, active.length)
    assert.ok(new Set(active.map((item) => item.uid)).size === active.length)
    assert.ok(new Set(active.map((item) => item.index)).size === active.length)
  }
}

const testConcurrencySelector = (): void => {
  for (const source of ['local', 'online'] as const) {
    for (const provider of ['ollama', 'openai'] as const) {
      const settingsForCase = { ...onlineSettings, source, provider }
      assert.equal(requirementSemanticizationMaxConcurrency(settingsForCase, 'standard'), source === 'online' && provider !== 'ollama' ? 4 : 1)
      assert.equal(requirementSemanticizationMaxConcurrency(settingsForCase, 'strict'), source === 'online' && provider !== 'ollama' ? 2 : 1)
    }
  }
}

const testOnlineStandardPool = async (): Promise<void> => withDb('online-standard-pool', async (db) => {
  const uids = Array.from({ length: 8 }, (_, index) => `online-standard-${index + 1}`)
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier()
  const snapshots: RequirementSemanticizationProgress[] = []
  const service = serviceFor(db, barrier, onlineSettings, (snapshot) => snapshots.push(snapshot))
  const result = service.start({ recordUids: uids })
  assert.equal(result.accepted, 8)
  await waitForCalls(barrier.calls, 4)
  assert.equal(barrier.calls.length, 4, 'online standard must launch exactly the first four records')
  assert.equal(barrier.pendingCount, 4)
  assert.equal(new Set(barrier.payloads.map((payload) => payload.recordUid)).size, 4)
  assert.equal(service.getTask()?.maxConcurrency, 4)
  assert.equal(service.getTask()?.activeCount, 4)
  assert.deepEqual(service.getTask()?.activeRecords?.map((item) => item.index).sort((a, b) => a - b), [1, 2, 3, 4])
  assert.equal(barrier.calls.some((input) => input.messages.at(-1)?.content.includes('online-standard-5')), false)
  barrier.release(4)
  barrier.setAutomatic()
  await waitForCalls(barrier.calls, 8)
  assert.equal(barrier.calls.length, 8)
  assert.equal(barrier.maxInFlight, 4)
  assert.equal(new Set(barrier.payloads.map((payload) => payload.recordUid)).size, 8)
  assertMetricSnapshots(snapshots)
  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 8)
  assert.equal(task.failed, 0)
  assert.equal(task.maxConcurrency, 4)
  assert.equal(task.activeCount, 0)
  assert.deepEqual(task.activeRecords, [])
  assert.ok(task.estimatedRemainingMs === undefined || task.estimatedRemainingMs >= 0)
  for (const uid of uids) assert.equal(barrier.payloads.filter((payload) => payload.recordUid === uid).length, 1)
})

const testOnlineStrictPoolAndStaticPrompt = async (): Promise<void> => withDb('online-strict-pool', async (db) => {
  const uids = ['online-strict-1', 'online-strict-2', 'online-strict-3']
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier()
  const snapshots: RequirementSemanticizationProgress[] = []
  const service = serviceFor(db, barrier, onlineSettings, (snapshot) => snapshots.push(snapshot))
  service.start({ recordUids: uids, qualityMode: 'strict' })
  await waitForCalls(barrier.calls, 4)
  assert.equal(barrier.calls.length, 4, 'strict online pool starts two records, each with initial+independent')
  assert.equal(barrier.maxInFlight, 4)
  assert.equal(service.getTask()?.maxConcurrency, 2)
  assert.equal(service.getTask()?.activeCount, 2)
  assert.equal(barrier.payloads.some((payload) => payload.recordUid === 'online-strict-3'), false)
  const firstTwo = barrier.payloads.filter((payload) => payload.recordUid !== 'online-strict-3')
  for (const uid of ['online-strict-1', 'online-strict-2']) {
    assert.deepEqual(firstTwo.filter((payload) => payload.recordUid === uid).map((payload) => payload.analysisPass).sort(), ['independent', 'initial'])
  }
  const systems = barrier.calls
    .filter((input) => ['initial', 'independent'].includes((JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload).analysisPass ?? ''))
    .map((input) => input.messages[0]?.content)
  assert.equal(new Set(systems).size, 1, 'initial and independent must share byte-identical static system prompt')
  for (const payload of firstTwo) {
    assert.deepEqual(Object.keys(payload.knownFields ?? {}).sort(), [...knownFields].sort(), 'known fields belong in user payload')
  }
  barrier.release(4)
  barrier.setAutomatic()
  await waitForCalls(barrier.calls, 6)
  assert.equal(barrier.payloads.some((payload) => payload.recordUid === 'online-strict-3'), true)
  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 3)
  assert.equal(task.failed, 0)
  assert.equal(barrier.maxInFlight, 4)
  assert.equal(barrier.calls.filter((input) => (JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload).analysisPass === 'adjudication').length, 0)
  for (const uid of uids) assert.equal(barrier.payloads.filter((payload) => payload.recordUid === uid).length, 2)
  assertMetricSnapshots(snapshots)
})

const testLocalPool = async (): Promise<void> => withDb('local-pool', async (db) => {
  const uids = ['local-1', 'local-2', 'local-3']
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier()
  const service = serviceFor(db, barrier, localSettings)
  service.start({ recordUids: uids })
  await waitForCalls(barrier.calls, 1)
  assert.equal(barrier.calls.length, 1)
  assert.equal(barrier.maxInFlight, 1)
  assert.equal(service.getTask()?.maxConcurrency, 1)
  assert.equal(service.getTask()?.activeCount, 1)
  barrier.release(1)
  barrier.setAutomatic()
  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 3)
  assert.equal(barrier.maxInFlight, 1, 'local/ollama must remain single-flight across records')
  assert.equal(barrier.calls.length, 3)
})

const testLocalStrictStagesAreSerial = async (): Promise<void> => withDb('local-strict-serial', async (db) => {
  const uid = 'local-strict-serial-1'
  upsert(db, uid)
  const barrier = createBarrier()
  const service = serviceFor(db, barrier, localSettings)
  service.start({ recordUids: [uid], qualityMode: 'strict' })
  await waitForCalls(barrier.calls, 1)
  assert.equal(barrier.calls.length, 1, 'local/Ollama strict must not start independent before initial completes')
  assert.equal(barrier.payloads[0]?.analysisPass, 'initial')
  assert.equal(barrier.maxInFlight, 1)

  barrier.release(1)
  await waitForCalls(barrier.calls, 2)
  assert.equal(barrier.calls.length, 2)
  assert.equal(barrier.payloads[1]?.analysisPass, 'independent')
  assert.equal(barrier.maxInFlight, 1, 'local/Ollama strict main stages must remain single-flight')
  barrier.release(1)

  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 1)
  assert.equal(barrier.calls.filter((input) => {
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload
    return payload.analysisPass === 'initial' || payload.analysisPass === 'independent'
  }).length, 2)
})

const testTraceIsolationAndFailure = async (): Promise<void> => withDb('trace-isolation', async (db) => {
  const uids = ['trace-ok-1', 'trace-fail', 'trace-ok-2', 'trace-ok-3']
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier((_input, payload) => {
    if (payload.recordUid === 'trace-fail') throw new Error('intentional isolated failure')
    return outputFor(payload.recordUid!, payload.sourceText!)
  })
  const service = serviceFor(db, barrier, onlineSettings)
  service.start({ recordUids: uids })
  barrier.setAutomatic()
  const task = await waitFor(service, 'completed')
  assert.equal(task.succeeded, 3)
  assert.equal(task.failed, 1)
  assert.equal(task.completed, 4)
  for (const uid of uids) {
    const state = db.getRequirementSemanticCardState(uid)
    assert.ok(state)
    const trace = state.analysisTrace as unknown as RequirementSemanticizationAnalysisTrace
    assert.equal(trace.recordUid, uid)
    assert.ok(trace.events.every((event) => event.recordUid === uid))
    assert.equal(state.status, uid === 'trace-fail' ? 'failed' : 'ready')
  }
})

const testPauseBarrier = async (): Promise<void> => withDb('pause-barrier', async (db) => {
  const uids = Array.from({ length: 8 }, (_, index) => `pause-${index + 1}`)
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier()
  const service = serviceFor(db, barrier, onlineSettings)
  service.start({ recordUids: uids })
  await waitForCalls(barrier.calls, 4)
  assert.equal(service.control('pause')?.status, 'pausing')
  barrier.release(1)
  // Only one record has reached its safe boundary; all other model calls stay in flight.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(service.getTask()?.status, 'pausing')
  assert.equal(barrier.calls.length, 4, 'pause must not dispatch the fifth record early')
  barrier.release(3)
  const paused = await waitFor(service, 'paused')
  assert.equal(paused.activeCount, 4)
  assert.equal(barrier.calls.length, 4)
  barrier.setAutomatic()
  service.control('resume')
  const completed = await waitFor(service, 'completed')
  assert.equal(completed.succeeded, 8)
  assert.equal(barrier.calls.length, 8)
})

const testStopBarrier = async (): Promise<void> => withDb('stop-barrier', async (db) => {
  const uids = Array.from({ length: 8 }, (_, index) => `stop-${index + 1}`)
  uids.forEach((uid) => upsert(db, uid))
  const barrier = createBarrier()
  const service = serviceFor(db, barrier, onlineSettings)
  service.start({ recordUids: uids })
  await waitForCalls(barrier.calls, 4)
  assert.equal(service.control('stop')?.status, 'stopping')
  assert.equal(barrier.calls.length, 4)
  barrier.release(4)
  const stopped = await waitFor(service, 'stopped')
  assert.equal(stopped.completed, 0)
  assert.equal(stopped.succeeded, 0)
  assert.equal(stopped.failed, 0)
  assert.equal(stopped.activeCount, 0)
  assert.equal(barrier.calls.length, 4, 'stop must not dispatch records after the in-flight batch')
  for (const uid of uids) {
    const state = db.getRequirementSemanticCardState(uid)
    assert.equal(state?.status ?? 'pending', 'pending', `${uid} must not remain claimed after stop`)
    assert.equal(state?.card ?? null, null)
  }
})

const main = async (): Promise<void> => {
  testConcurrencySelector()
  await testOnlineStandardPool()
  await testOnlineStrictPoolAndStaticPrompt()
  await testLocalPool()
  await testLocalStrictStagesAreSerial()
  await testTraceIsolationAndFailure()
  await testPauseBarrier()
  await testStopBarrier()
  console.log('semantic-card-concurrency-regression: ok')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
