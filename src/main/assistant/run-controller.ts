import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { CancelAgentRunResult } from '../../shared/types'

/** A renderer-owned object that can notify us when its IPC endpoint is gone. */
export interface AssistantRunOwner {
  isDestroyed?: () => boolean
  once?: (event: 'destroyed', listener: () => void) => unknown
  on?: (event: 'destroyed', listener: () => void) => unknown
  removeListener?: (event: 'destroyed', listener: () => void) => unknown
}

export interface AssistantRunContext {
  runId: string
  signal: AbortSignal
}

export interface AssistantRunRegistration {
  runId: string
  signal: AbortSignal
  context: AssistantRunContext
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const isAssistantRunId = (value: unknown): value is string => (
  typeof value === 'string' && UUID_PATTERN.test(value.trim())
)

/** Keep legacy callers working while rejecting an explicitly malformed run key. */
export const normalizeAssistantRunId = (value: unknown): string => {
  if (value === undefined || value === null) return randomUUID()
  if (!isAssistantRunId(value)) throw new InvalidAssistantRunIdError()
  return value.trim().toLowerCase()
}

export class AssistantRunCancelledError extends Error {
  readonly code = 'AGENT_RUN_CANCELLED'
  readonly runId: string

  constructor(runId: string, message = '助手任务已取消') {
    super(message)
    this.name = 'AssistantRunCancelledError'
    this.runId = runId
  }
}

export class AssistantRunAlreadyActiveError extends Error {
  readonly code = 'AGENT_RUN_ALREADY_ACTIVE'

  constructor() {
    super('当前窗口已有正在执行的助手任务')
    this.name = 'AssistantRunAlreadyActiveError'
  }
}

export class InvalidAssistantRunIdError extends Error {
  readonly code = 'INVALID_AGENT_RUN_ID'

  constructor() {
    super('runId 格式无效')
    this.name = 'InvalidAssistantRunIdError'
  }
}

const contextStorage = new AsyncLocalStorage<AssistantRunContext>()

export const getAssistantRunContext = (): AssistantRunContext | undefined => contextStorage.getStore()

export const runWithAssistantRunContext = <T>(
  context: AssistantRunContext,
  callback: () => T
): T => contextStorage.run(context, callback)

/** Throw only for the explicit assistant run signal, never for ordinary timeouts. */
export const throwIfAssistantRunCancelled = (): void => {
  const context = getAssistantRunContext()
  if (context?.signal.aborted) throw new AssistantRunCancelledError(context.runId)
}

export const isAssistantRunCancellation = (error: unknown): boolean => {
  if (error instanceof AssistantRunCancelledError) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; name?: unknown; cause?: unknown }
  if (candidate.code === 'AGENT_RUN_CANCELLED' || candidate.name === 'AssistantRunCancelledError') return true
  return candidate.cause !== undefined && isAssistantRunCancellation(candidate.cause)
}

interface ActiveAssistantRun extends AssistantRunRegistration {
  owner: AssistantRunOwner
  controller: AbortController
  onDestroyed: () => void
}

/**
 * Owns the process-local cancellation handles for renderer initiated runs.
 * A renderer can have at most one active assistant run, and only that
 * renderer's WebContents owner can cancel it.
 */
export class AssistantRunRegistry {
  private readonly active = new Map<AssistantRunOwner, Map<string, ActiveAssistantRun>>()

  register(owner: AssistantRunOwner, requestedRunId?: unknown): AssistantRunRegistration {
    if (!owner || owner.isDestroyed?.()) throw new Error('助手请求来源已销毁')
    const ownerRuns = this.active.get(owner)
    if (ownerRuns?.size) throw new AssistantRunAlreadyActiveError()

    const runId = normalizeAssistantRunId(requestedRunId)
    const controller = new AbortController()
    const context: AssistantRunContext = { runId, signal: controller.signal }
    const registration: AssistantRunRegistration = { runId, signal: controller.signal, context }
    const onDestroyed = (): void => {
      if (!controller.signal.aborted) controller.abort(new AssistantRunCancelledError(runId, '助手窗口已关闭'))
    }
    const activeRun: ActiveAssistantRun = { ...registration, owner, controller, onDestroyed }
    const runs = ownerRuns ?? new Map<string, ActiveAssistantRun>()
    runs.set(runId, activeRun)
    if (!ownerRuns) this.active.set(owner, runs)
    if (owner.once) owner.once('destroyed', onDestroyed)
    else owner.on?.('destroyed', onDestroyed)
    return registration
  }

  finish(owner: AssistantRunOwner, runId: string): void {
    const runs = this.active.get(owner)
    const activeRun = runs?.get(runId)
    if (!activeRun) return
    activeRun.owner.removeListener?.('destroyed', activeRun.onDestroyed)
    runs!.delete(runId)
    if (!runs!.size) this.active.delete(owner)
  }

  cancel(owner: AssistantRunOwner, requestedRunId: unknown): CancelAgentRunResult {
    const candidate = typeof requestedRunId === 'string' ? requestedRunId.trim() : ''
    if (!isAssistantRunId(candidate)) {
      return {
        ok: false,
        runId: candidate,
        status: 'invalid',
        message: 'runId 格式无效'
      }
    }
    const runId = candidate.toLowerCase()
    const activeRun = this.active.get(owner)?.get(runId)
    if (!activeRun) {
      return { ok: false, runId, status: 'not_found', message: '没有找到属于当前窗口的运行任务' }
    }
    if (!activeRun.signal.aborted) {
      // Abort with a typed reason so every provider and the outer handler can
      // distinguish user cancellation from a provider timeout.
      activeRun.controller.abort(new AssistantRunCancelledError(runId))
    }
    return { ok: true, runId, status: 'cancel_requested', message: '已请求取消助手任务' }
  }

  abortAll(): void {
    for (const runs of this.active.values()) {
      for (const activeRun of runs.values()) {
        if (!activeRun.signal.aborted) {
          activeRun.controller.abort(new AssistantRunCancelledError(activeRun.runId, '应用正在关闭'))
        }
      }
    }
  }
}
