import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  AssistantRunAlreadyActiveError,
  AssistantRunCancelledError,
  AssistantRunRegistry,
  getAssistantRunContext,
  InvalidAssistantRunIdError,
  isAssistantRunCancellation,
  isAssistantRunId,
  normalizeAssistantRunId,
  runWithAssistantRunContext,
  throwIfAssistantRunCancelled,
  type AssistantRunOwner
} from '../src/main/assistant/run-controller'
import {
  createAssistantTaskTrace,
  traceContextFromDecision
} from '../src/main/assistant/task-trace'
import { chatHistoryFromMessages } from '../src/main/context-budget'
import { ModelClient, type ModelChatInput } from '../src/main/model-client'
import type { AgentProgressUpdate } from '../src/shared/expert-types'
import type {
  AppApi,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ModelSettings
} from '../src/shared/types'

const OWNER_RUN_ID = '550e8400-e29b-41d4-a716-446655440000'
const OWNER_RUN_ID_UPPER = OWNER_RUN_ID.toUpperCase()
const SECOND_RUN_ID = '550e8400-e29b-41d4-a716-446655440001'
const OTHER_OWNER_RUN_ID = '550e8400-e29b-41d4-a716-446655440002'

const modelSettings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'assistant-run-cancellation-regression',
  thinking: false
}

class FakeOwner implements AssistantRunOwner {
  private destroyed = false
  private readonly destroyedListeners = new Set<() => void>()

  isDestroyed = (): boolean => this.destroyed

  once = (_event: 'destroyed', listener: () => void): void => {
    this.destroyedListeners.add(listener)
  }

  on = (_event: 'destroyed', listener: () => void): void => {
    this.destroyedListeners.add(listener)
  }

  removeListener = (_event: 'destroyed', listener: () => void): void => {
    this.destroyedListeners.delete(listener)
  }

  destroy = (): void => {
    this.destroyed = true
    for (const listener of [...this.destroyedListeners]) listener()
  }
}

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待条件超时（${timeoutMs}ms）`)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

const withFetch = async <T>(
  mock: typeof globalThis.fetch,
  callback: () => Promise<T>
): Promise<T> => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock
  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

const captureRejection = async (callback: () => Promise<unknown>): Promise<unknown> => {
  try {
    await callback()
    return undefined
  } catch (error) {
    return error
  }
}

const chatInput: ModelChatInput = {
  messages: [{ role: 'user', content: '请返回取消回归结果。' }],
  stream: false,
  timeoutMs: 5_000
}

const testRunIdOwnershipAndTrace = (): void => {
  const registry = new AssistantRunRegistry()
  const owner = new FakeOwner()
  const otherOwner = new FakeOwner()
  const registration = registry.register(owner, OWNER_RUN_ID_UPPER)

  assert.equal(registration.runId, OWNER_RUN_ID)
  assert.equal(isAssistantRunId(registration.runId), true)
  assert.equal(registration.context.runId, registration.runId)
  assert.equal(registration.context.signal, registration.signal)
  assert.equal(registration.signal.aborted, false)
  assert.throws(
    () => registry.register(owner, SECOND_RUN_ID),
    (error) => error instanceof AssistantRunAlreadyActiveError
  )
  assert.throws(
    () => registry.register(otherOwner, 'legacy-run-id'),
    (error) => error instanceof InvalidAssistantRunIdError
  )

  const nonOwnerCancellation = registry.cancel(otherOwner, registration.runId)
  assert.deepEqual(nonOwnerCancellation, {
    ok: false,
    runId: registration.runId,
    status: 'not_found',
    message: '没有找到属于当前窗口的运行任务'
  })
  assert.equal(registry.cancel(owner, 'legacy-run-id').status, 'invalid')

  const contextSeen = runWithAssistantRunContext(registration.context, () => getAssistantRunContext())
  assert.equal(contextSeen, registration.context)

  const trace = createAssistantTaskTrace(
    traceContextFromDecision({
      taskType: 'record_query',
      sourceMode: 'records',
      resultMode: 'list'
    }),
    {
      runId: registration.runId,
      status: 'cancelled',
      invokedAgents: ['data-center']
    }
  )
  assert.equal(trace.runId, registration.runId)
  assert.equal(trace.status, 'cancelled')
  assert.notEqual(trace.status, 'completed')
  assert.deepEqual(trace.invokedAgents, ['data-center'])

  const contextBoundTrace = runWithAssistantRunContext(registration.context, () =>
    createAssistantTaskTrace(
      traceContextFromDecision({
        taskType: 'record_query',
        sourceMode: 'records',
        resultMode: 'list'
      })
    )
  )
  assert.equal(
    contextBoundTrace.runId,
    registration.runId,
    'normal task traces must inherit the active runId when callers omit it'
  )

  const progress: AgentProgressUpdate = {
    runId: registration.runId,
    conversationId: 'cancellation-regression-conversation',
    event: { type: 'status', stage: 'execute', message: '执行中' }
  }
  assert.equal(progress.runId, trace.runId)

  const cancelledResponse: ChatResponse = {
    answer: '已取消',
    sources: [],
    dataViews: [],
    cancelled: true,
    taskTrace: trace
  }
  assert.equal(cancelledResponse.cancelled, true)
  assert.equal(cancelledResponse.taskTrace?.status, 'cancelled')

  registry.finish(owner, registration.runId)
  assert.equal(registry.cancel(owner, registration.runId).status, 'not_found')

  const generatedForLegacyCall = registry.register(owner)
  assert.equal(isAssistantRunId(generatedForLegacyCall.runId), true)
  assert.equal(isAssistantRunId(normalizeAssistantRunId(undefined)), true)
  registry.finish(owner, generatedForLegacyCall.runId)

  owner.destroy()
  assert.equal(registry.cancel(owner, generatedForLegacyCall.runId).status, 'not_found')
}

const testCancellationAbortsHangingModelClient = async (): Promise<void> => {
  const registry = new AssistantRunRegistry()
  const owner = new FakeOwner()
  const registration = registry.register(owner, OTHER_OWNER_RUN_ID)
  let observedSignal: AbortSignal | undefined
  let fetchAbortedAt: number | undefined

  try {
    const modelRejection = await withFetch(async (_input, init) => {
      observedSignal = init?.signal ?? undefined
      if (!observedSignal) throw new Error('ModelClient did not pass an AbortSignal to fetch')
      return await new Promise<Response>((_resolve, reject) => {
        const rejectOnAbort = (): void => {
          fetchAbortedAt = Date.now()
          reject(observedSignal?.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        }
        if (observedSignal!.aborted) rejectOnAbort()
        else observedSignal!.addEventListener('abort', rejectOnAbort, { once: true })
      })
    }, async () => {
      const pending = runWithAssistantRunContext(
        registration.context,
        () => new ModelClient(modelSettings).chat(chatInput)
      )
      await waitFor(() => observedSignal !== undefined)
      const cancelStartedAt = Date.now()
      const cancelResult = registry.cancel(owner, registration.runId)
      assert.equal(cancelResult.ok, true)
      assert.equal(cancelResult.status, 'cancel_requested')
      const error = await captureRejection(() => pending)
      assert.ok(Date.now() - cancelStartedAt < 1_000, 'cancelled model call should settle promptly')
      assert.ok(fetchAbortedAt !== undefined, 'cancellation must abort the pending fetch')
      assert.ok(fetchAbortedAt! >= cancelStartedAt)
      assert.equal(isAssistantRunCancellation(error), true)
      assert.equal((error as { code?: unknown }).code, 'AGENT_RUN_CANCELLED')
      assert.equal((error as { runId?: unknown }).runId, registration.runId)
      return error
    })
    assert.ok(modelRejection)
    assert.equal(registration.signal.aborted, true)
    assert.equal(isAssistantRunCancellation(registration.signal.reason), true)
    assert.throws(
      () => runWithAssistantRunContext(registration.context, () => throwIfAssistantRunCancelled()),
      (error) => error instanceof AssistantRunCancelledError && error.runId === registration.runId
    )
  } finally {
    registry.finish(owner, registration.runId)
  }
}

const testTimeoutAndNetworkRemainDistinct = async (): Promise<void> => {
  const timeoutError = await withFetch(async () => {
    throw new DOMException('model response timed out', 'TimeoutError')
  }, () => captureRejection(() => new ModelClient(modelSettings).chat(chatInput)))
  assert.ok(timeoutError)
  assert.equal(isAssistantRunCancellation(timeoutError), false)

  const networkError = await withFetch(async () => {
    throw Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
  }, () => captureRejection(() => new ModelClient(modelSettings).chat(chatInput)))
  assert.ok(networkError)
  assert.equal(isAssistantRunCancellation(networkError), false)
}

const testLifecycleCleanupAndDestroyedOwner = (): void => {
  const registry = new AssistantRunRegistry()
  const completedOwner = new FakeOwner()
  const failedOwner = new FakeOwner()
  const cancelledOwner = new FakeOwner()
  const completed = registry.register(completedOwner, OWNER_RUN_ID)
  registry.finish(completedOwner, completed.runId)
  assert.equal(registry.cancel(completedOwner, completed.runId).status, 'not_found')

  const failed = registry.register(failedOwner, SECOND_RUN_ID)
  registry.finish(failedOwner, failed.runId)
  assert.equal(registry.cancel(failedOwner, failed.runId).status, 'not_found')

  const cancelled = registry.register(cancelledOwner, OTHER_OWNER_RUN_ID)
  assert.equal(registry.cancel(cancelledOwner, cancelled.runId).status, 'cancel_requested')
  registry.finish(cancelledOwner, cancelled.runId)
  assert.equal(registry.cancel(cancelledOwner, cancelled.runId).status, 'not_found')

  const destroyedOwner = new FakeOwner()
  const destroyed = registry.register(destroyedOwner, '550e8400-e29b-41d4-a716-446655440003')
  destroyedOwner.destroy()
  assert.equal(destroyed.signal.aborted, true)
  assert.equal(isAssistantRunCancellation(destroyed.signal.reason), true)
  registry.finish(destroyedOwner, destroyed.runId)
  assert.equal(registry.cancel(destroyedOwner, destroyed.runId).status, 'not_found')
}

const testCancelledMessagesDoNotBecomeHistory = (): void => {
  const cancelledTrace = createAssistantTaskTrace(
    traceContextFromDecision({
      taskType: 'record_query',
      sourceMode: 'records',
      resultMode: 'list'
    }),
    {
      runId: OWNER_RUN_ID,
      status: 'cancelled',
      invokedAgents: ['data-center']
    }
  )
  const messages: ChatMessage[] = [
    {
      id: 'cancelled-assistant-message',
      role: 'assistant',
      content: '这段半截答案不应成为下一轮上下文。',
      createdAt: new Date(0).toISOString(),
      taskTrace: cancelledTrace
    },
    {
      id: 'successful-user-message',
      role: 'user',
      content: '请重新回答。',
      createdAt: new Date(0).toISOString()
    }
  ]
  const history = chatHistoryFromMessages(messages)
  assert.equal(
    history.some((turn) => turn.content.includes('半截答案')),
    false,
    'cancelled assistant output must not enter valid follow-up history'
  )
  assert.equal(history.some((turn) => turn.content === '请重新回答。'), true)
}

const testLegacyRequestAndIpcPreloadContract = async (): Promise<void> => {
  const legacyRequest: ChatRequest = { question: '旧调用不带 runId' }
  assert.equal(legacyRequest.runId, undefined)

  const apiContract: Pick<AppApi, 'cancelAgentRun'> = {
    cancelAgentRun: async (runId) => ({
      ok: false,
      runId,
      status: 'not_found'
    })
  }
  const legacyResult = await apiContract.cancelAgentRun('legacy-run-id')
  assert.equal(legacyResult.status, 'not_found')

  const mainSource = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const preloadSource = await readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  assert.match(mainSource, /ipcMain\.handle\(\s*['"]agent:cancel['"]/u)
  assert.match(mainSource, /runId:\s*registration\.runId/u)
  assert.match(
    mainSource,
    /const sendAgentEvent[\s\S]{0,500}registration\.signal\.aborted[\s\S]{0,500}return/u,
    'agent progress must stop after the owning run is cancelled'
  )
  assert.match(mainSource, /status:\s*['"]cancelled['"]/u)
  assert.match(preloadSource, /cancelAgentRun\s*:/u)
  assert.match(preloadSource, /ipcRenderer\.invoke\(\s*['"]agent:cancel['"]/u)
}

const main = async (): Promise<void> => {
  testRunIdOwnershipAndTrace()
  await testCancellationAbortsHangingModelClient()
  await testTimeoutAndNetworkRemainDistinct()
  testLifecycleCleanupAndDestroyedOwner()
  testCancelledMessagesDoNotBecomeHistory()
  await testLegacyRequestAndIpcPreloadContract()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'runId is generated/normalized, owner-scoped, and copied into progress/trace',
      'duplicate owner runs and non-owner cancellation are rejected',
      'cancellation aborts the hanging ModelClient fetch and settles promptly',
      'user cancellation remains distinct from timeout and network errors',
      'completed, failed, cancelled, and destroyed-owner runs are cleaned up',
      'cancelled responses are not included in valid follow-up history',
      'legacy requests remain compatible and agent:cancel IPC/preload contracts are present'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
