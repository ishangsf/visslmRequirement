import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { ModelClient, ModelHttpError, type ModelChatInput, type ModelResponse } from '../../src/main/model-client'
import {
  REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
  RequirementSemanticizationService,
  type RequirementSemanticizationModelClient
} from '../../src/main/requirements/semanticization-service'
import {
  REQUIREMENT_SEMANTIC_FIELDS,
  type RequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import type {
  ModelSettings,
  RequirementSemanticizationProgress,
  RequirementSemanticizationTaskSnapshot
} from '../../src/shared/types'

const onlineSettings: ModelSettings = {
  source: 'online',
  provider: 'openai',
  baseUrl: 'https://semantic-fault-regression.invalid/v1',
  apiKey: 'semantic-fault-regression-key',
  model: 'semantic-fault-regression-model',
  thinking: false
}
const localSettings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-fault-regression-model',
  thinking: false
}

const input = (overrides: Partial<ModelChatInput> = {}): ModelChatInput => ({
  messages: [{ role: 'user', content: '请返回一个简短结果。' }],
  stream: false,
  think: false,
  forceThinking: false,
  temperature: 0,
  numCtx: 4096,
  numPredict: 64,
  timeoutMs: REQUIREMENT_SEMANTIC_MODEL_TIMEOUT_MS,
  maxTransportRetries: 2,
  ...overrides
})

const successBody = (content = '完成'): Record<string, unknown> => ({
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 }
})

const jsonResponse = (
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers }
})

const withFetch = async <T>(
  mock: typeof globalThis.fetch,
  run: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const assertModelHttpError = (error: unknown, status: number): void => {
  assert.ok(error instanceof Error)
  assert.ok(error instanceof ModelHttpError, 'HTTP failures must use the exported ModelHttpError type')
  assert.equal(error.name, 'ModelHttpError', 'HTTP failures must use the typed ModelHttpError')
  const typed = error as Error & { status?: number; statusCode?: number }
  const actualStatus = typed.status ?? typed.statusCode
  if (actualStatus !== undefined) assert.equal(actualStatus, status)
  assert.match(error.message, new RegExp(`HTTP\\s+${status}`))
}

/** ModelClient classifies and bounds HTTP retries; the fetch remains fully stubbed. */
const testModelHttpErrorClassification = async (): Promise<void> => {
  for (const status of [429, 503]) {
    let calls = 0
    await withFetch(async (_request, init) => {
      calls += 1
      assert.ok(init?.signal, 'ModelClient must pass an AbortSignal to fetch')
      if (calls < 3) return jsonResponse({ error: `transient-${status}` }, status, { 'Retry-After': '0' })
      return jsonResponse(successBody())
    }, async () => {
      const response = await new ModelClient({ ...onlineSettings, baseUrl: `${onlineSettings.baseUrl}/${status}-classification` })
        .chat(input())
      assert.equal(response.message?.content, '完成')
    })
    assert.equal(calls, 3, `${status} should allow at most two retries before success`)
  }

  let failedCalls = 0
  await withFetch(async (_request, init) => {
    failedCalls += 1
    assert.ok(init?.signal)
    const status = failedCalls === 2 ? 503 : 429
    return jsonResponse({ error: `still-busy-${status}` }, status, { 'Retry-After': '0' })
  }, async () => {
    await assert.rejects(
      new ModelClient({ ...onlineSettings, baseUrl: `${onlineSettings.baseUrl}/retry-failure` }).chat(input()),
      (error: unknown) => {
        assertModelHttpError(error, 429)
        return true
      }
    )
  })
  assert.equal(failedCalls, 3, 'retryable failures must stop after two retries')

  let clientErrorCalls = 0
  await withFetch(async () => {
    clientErrorCalls += 1
    return jsonResponse({ error: 'invalid request' }, 400)
  }, async () => {
    await assert.rejects(
      new ModelClient({ ...onlineSettings, baseUrl: `${onlineSettings.baseUrl}/non-retryable` }).chat(input()),
      (error: unknown) => {
        assertModelHttpError(error, 400)
        return true
      }
    )
  })
  assert.equal(clientErrorCalls, 1, 'non-retryable 4xx must fail without a retry')
}

const upsert = (db: AppDatabase, uid: string, description = '用户可以按订单编号查询并查看订单详情。'): void => {
  db.upsertRecord({
    uid,
    projectId: 'semantic-fault-regression',
    nodeType: 'Requirement',
    itemId: uid.toUpperCase(),
    parentId: '',
    name: '订单详情查询',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_ProductDomain: '订单管理',
      _valm_Module: '订单管理',
      _valm_Description: `<p>${description}</p>`
    },
    normalizedText: `订单详情查询\n${description}`
  })
}

const withDb = async <T>(name: string, callback: (db: AppDatabase) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), `semantic-fault-${name}-`))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  try {
    return await callback(db)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const waitWithTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const semanticCardForDatabase = (): RequirementSemanticCard => {
  const values: Record<string, { value: string; evidence: string }> = {
    requirementType: { value: 'Enhancement', evidence: 'Enhancement' },
    productDomain: { value: '订单管理', evidence: '订单管理' },
    module: { value: '订单管理', evidence: '订单管理' },
    functionalObject: { value: '订单详情', evidence: '订单详情查询' },
    action: { value: 'add_capability', evidence: '查询' },
    currentState: { value: '', evidence: '' },
    targetState: { value: '', evidence: '' },
    trigger: { value: '', evidence: '' },
    input: { value: '订单编号', evidence: '订单编号' },
    output: { value: '订单详情', evidence: '订单详情' },
    behavior: { value: '用户按订单编号查询并查看订单详情', evidence: '用户可以按订单编号查询并查看订单详情' },
    constraints: { value: '', evidence: '' },
    acceptance: { value: '返回对应订单详情', evidence: '返回对应订单详情' },
    businessScene: { value: '', evidence: '' }
  }
  const fieldAssessments = Object.fromEntries(
    REQUIREMENT_SEMANTIC_FIELDS.map((field) => {
      const item = values[field] ?? { value: '', evidence: '' }
      return [field, {
        value: item.value,
        confidence: item.value ? 0.96 : 0,
        evidence: item.evidence
      }]
    })
  ) as RequirementSemanticCard['fieldAssessments']
  return {
    requirementType: 'Enhancement',
    productDomain: '订单管理',
    module: '订单管理',
    functionalObject: '订单详情',
    action: 'add_capability',
    currentState: '',
    targetState: '',
    trigger: '',
    input: '订单编号',
    output: '订单详情',
    behavior: '用户按订单编号查询并查看订单详情',
    constraints: '',
    acceptance: '返回对应订单详情',
    businessScene: '',
    sourceTitle: '订单详情查询',
    sourceDescription: '用户可以按订单编号查询并查看订单详情。',
    evidence: '订单详情查询',
    matchingText: '订单详情 查询 订单编号 订单详情',
    lexicalTerms: ['订单详情', '订单编号'],
    analysisStatus: 'ai_adjudicated',
    analysisSummary: 'synthetic database fixture',
    fieldAssessments
  }
}

const testDatabaseClaimCompletionAndCandidates = async (): Promise<void> => withDb('database-paths', async (db) => {
  const analyzerVersion = 'database-regression-analyzer'
  const modelSignature = 'database-regression-model'
  const context = { analyzerVersion, modelSignature }
  const card = semanticCardForDatabase()

  const changedUid = 'database-changed-before-complete'
  upsert(db, changedUid)
  const originalHash = db.getRecordContentHash(changedUid)
  assert.ok(originalHash)
  const claimInput = {
    recordUid: changedUid,
    contentHash: originalHash,
    ...context,
    force: true
  }
  assert.equal(db.claimRequirementSemanticCard(claimInput), true, 'first UID claim must win')
  assert.equal(db.claimRequirementSemanticCard(claimInput), false, 'same UID processing claim must be atomic')
  upsert(db, changedUid, '用户可以按订单编号导出订单详情。')
  const changedHash = db.getRecordContentHash(changedUid)
  assert.ok(changedHash)
  assert.notEqual(changedHash, originalHash, 'source mutation must change the semantic content hash')
  assert.equal(
    db.completeRequirementSemanticCard(changedUid, card, { events: [] }, claimInput),
    false,
    'completion with an obsolete expected hash must be rejected'
  )
  assert.equal(db.getRequirementSemanticCardState(changedUid)?.status, 'processing')
  assert.equal(db.getReadyRequirementSemanticCard({ ...claimInput }), null, 'stale completion must not become ready')
  db.releaseRequirementSemanticCard(changedUid)

  const validUid = 'database-valid-ready'
  const staleUid = 'database-stale-ready'
  const invalidUid = 'database-invalid-ready'
  for (const uid of [validUid, staleUid, invalidUid]) upsert(db, uid)

  const completeFixture = (uid: string, value: RequirementSemanticCard): void => {
    const contentHash = db.getRecordContentHash(uid)
    assert.ok(contentHash)
    const expected = { recordUid: uid, contentHash, ...context, force: true }
    assert.equal(db.claimRequirementSemanticCard(expected), true)
    assert.equal(db.completeRequirementSemanticCard(uid, value, { events: [] }, expected), true)
  }
  completeFixture(validUid, card)
  assert.ok(db.getReadyRequirementSemanticCard({
    recordUid: validUid,
    contentHash: db.getRecordContentHash(validUid)!,
    ...context
  }))
  completeFixture(staleUid, card)
  upsert(db, staleUid, '用户可以按订单编号修改订单详情。')
  completeFixture(invalidUid, { analysisStatus: 'ai_adjudicated' } as unknown as RequirementSemanticCard)

  const candidates = db.listRequirementSemanticizationCandidates(context)
  const candidateUids = candidates.candidates.map((candidate) => candidate.recordUid)
  assert.equal(candidates.available, 3, 'valid ready card should be the only skipped candidate')
  assert.equal(candidateUids.includes(validUid), false, 'unchanged valid ready card must be skipped')
  assert.equal(candidateUids.includes(staleUid), true, 'changed source must invalidate the ready card')
  assert.equal(candidateUids.includes(invalidUid), true, 'corrupt ready payload must be reprocessed')
  assert.equal(candidateUids.includes(changedUid), true, 'released stale claim must remain a candidate')
})

const testStopAbortsInFlightAndDoesNotDispatch = async (): Promise<void> => withDb('stop-abort', async (db) => {
  const uids = ['stop-abort-1', 'stop-abort-2', 'stop-abort-3']
  uids.forEach((uid) => upsert(db, uid))
  let resolveStarted!: () => void
  let resolveAborted!: () => void
  let rejectPending!: (error: unknown) => void
  const started = new Promise<void>((resolve) => { resolveStarted = resolve })
  const aborted = new Promise<void>((resolve) => { resolveAborted = resolve })
  let calls = 0
  const client: RequirementSemanticizationModelClient = {
    chat(request) {
      calls += 1
      resolveStarted()
      assert.ok(request.signal, 'semantic model calls must expose an AbortSignal')
      return new Promise<ModelResponse>((_resolve, reject) => {
        rejectPending = reject
        const signal = request.signal!
        const onAbort = () => {
          resolveAborted()
          reject(new DOMException('The request was aborted', 'AbortError'))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
  let resolveStopped!: (snapshot: RequirementSemanticizationTaskSnapshot) => void
  const stopped = new Promise<RequirementSemanticizationTaskSnapshot>((resolve) => { resolveStopped = resolve })
  const service = new RequirementSemanticizationService(
    db,
    () => localSettings,
    (snapshot: RequirementSemanticizationProgress) => {
      if (snapshot.status === 'stopped') resolveStopped(snapshot)
    },
    () => client
  )
  try {
    const result = service.start({ recordUids: uids })
    assert.equal(result.accepted, 3)
    await waitWithTimeout(started, 'in-flight model call')
    assert.equal(service.control('stop')?.status, 'stopping')
    await waitWithTimeout(aborted, 'in-flight abort')
    const snapshot = await waitWithTimeout(stopped, 'stopped task')
    assert.equal(snapshot.status, 'stopped')
    assert.equal(calls, 1, 'stop must not dispatch a second record')
    for (const uid of uids) {
      const state = db.getRequirementSemanticCardState(uid)
      assert.equal(state?.status ?? 'pending', 'pending')
      assert.equal(state?.card ?? null, null)
    }
  } finally {
    rejectPending?.(new Error('test cleanup'))
  }
})

type PendingFetch = {
  settled: boolean
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

const createFetchBarrier = () => {
  const pending: PendingFetch[] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const notify = (): void => {
    for (const waiter of waiters.splice(0)) {
      if (calls >= waiter.count) waiter.resolve()
      else waiters.push(waiter)
    }
  }
  const mock: typeof globalThis.fetch = async (_request, init) => {
    calls += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    notify()
    let entry!: PendingFetch
    const settle = (action: () => void): void => {
      if (entry.settled) return
      entry.settled = true
      inFlight -= 1
      action()
    }
    const response = new Promise<Response>((resolve, reject) => {
      entry = {
        settled: false,
        resolve: (value) => settle(() => resolve(value)),
        reject: (error) => settle(() => reject(error))
      }
      pending.push(entry)
      const signal = init?.signal
      if (signal) {
        const onAbort = () => entry.reject(signal.reason ?? new DOMException('The request was aborted', 'AbortError'))
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
    return response
  }
  return {
    mock,
    get calls() { return calls },
    get maxInFlight() { return maxInFlight },
    waitForCalls(count: number): Promise<void> {
      if (calls >= count) return Promise.resolve()
      return new Promise((resolve) => waiters.push({ count, resolve }))
    },
    release(count = 1): void {
      let released = 0
      for (const entry of pending) {
        if (released >= count) break
        if (entry.settled) continue
        entry.resolve(jsonResponse(successBody()))
        released += 1
      }
    },
    failNext(error: Error): void {
      const entry = pending.find((item) => !item.settled)
      if (entry) entry.reject(error)
    }
  }
}

const testSharedLocalSemaphoreReleasesOnErrorAndAbort = async (): Promise<void> => {
  const baseUrl = `${localSettings.baseUrl}/semaphore-local`
  const firstClient = new ModelClient({ ...localSettings, baseUrl })
  const secondClient = new ModelClient({ ...localSettings, baseUrl })
  const thirdClient = new ModelClient({ ...localSettings, baseUrl })

  const runFailure = async (abort: boolean): Promise<void> => {
    const barrier = createFetchBarrier()
    await withFetch(barrier.mock, async () => {
      const controller = new AbortController()
      const firstPromise = firstClient.chat(input({ signal: abort ? controller.signal : undefined }))
      const secondPromise = secondClient.chat(input())
      const thirdPromise = thirdClient.chat(input())
      await barrier.waitForCalls(2)
      assert.equal(barrier.calls, 2, 'local shared semaphore must preserve the existing two-request provider cap')
      if (abort) controller.abort(new DOMException('cancelled by test', 'AbortError'))
      else barrier.failNext(new Error('synthetic transport failure'))
      await barrier.waitForCalls(3)
      assert.equal(barrier.maxInFlight, 2, 'abort/error must release the local semaphore permit')
      barrier.release(2)
      await assert.rejects(firstPromise)
      await Promise.all([secondPromise, thirdPromise])
      assert.equal(barrier.maxInFlight, 2)
    })
  }

  await runFailure(false)
  await runFailure(true)
}

const testSharedOnlineSemaphoreCapsFour = async (): Promise<void> => {
  const baseUrl = `${onlineSettings.baseUrl}/semaphore-online`
  const clients = Array.from({ length: 6 }, () => new ModelClient({ ...onlineSettings, baseUrl }))
  const barrier = createFetchBarrier()
  await withFetch(barrier.mock, async () => {
    const promises = clients.map((client) => client.chat(input()))
    await barrier.waitForCalls(4)
    assert.equal(barrier.calls, 4, 'online same-baseUrl semaphore must admit exactly four requests first')
    assert.equal(barrier.maxInFlight, 4)
    barrier.release(4)
    await barrier.waitForCalls(6)
    assert.equal(barrier.maxInFlight, 4)
    barrier.release(2)
    await Promise.all(promises)
  })
}

const main = async (): Promise<void> => {
  const failures: string[] = []
  const cases: Array<[string, () => Promise<void>]> = [
    ['model-http-error-classification', testModelHttpErrorClassification],
    ['database-claim-completion-candidates', testDatabaseClaimCompletionAndCandidates],
    ['stop-aborts-in-flight', testStopAbortsInFlightAndDoesNotDispatch],
    ['shared-local-semaphore', testSharedLocalSemaphoreReleasesOnErrorAndAbort],
    ['shared-online-semaphore', testSharedOnlineSemaphoreCapsFour]
  ]
  for (const [name, test] of cases) {
    try {
      await test()
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  console.log('semantic-card-fault-regression: ok')
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
