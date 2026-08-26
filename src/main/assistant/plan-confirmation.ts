import type { AssistantPlanPatch, ConfirmAgentPlanResult } from '../../shared/types'
import {
  validateAndApplyAssistantPlanPatch,
  type AssistantPlanConfirmationInput,
  type ConfirmedAssistantPlan
} from './execution-plan'

interface PlanConfirmationOwner {
  id: number
  isDestroyed?: () => boolean
}

interface PendingPlanConfirmation {
  owner: PlanConfirmationOwner
  input?: AssistantPlanConfirmationInput
  resolve: (plan?: ConfirmedAssistantPlan) => void
  reject: (error: Error) => void
  signal: AbortSignal
  abort: () => void
  timeout?: ReturnType<typeof setTimeout>
}

const normalizedRunId = (runId: unknown): string => typeof runId === 'string' ? runId.trim() : ''
const defaultPlanConfirmationTimeoutMs = 10 * 60 * 1000

export class AssistantPlanConfirmationController {
  private readonly pending = new Map<string, PendingPlanConfirmation>()

  constructor(private readonly timeoutMs = defaultPlanConfirmationTimeoutMs) {}

  wait(
    owner: PlanConfirmationOwner,
    runIdValue: unknown,
    signal: AbortSignal,
    input?: AssistantPlanConfirmationInput
  ): Promise<ConfirmedAssistantPlan | undefined> {
    const runId = normalizedRunId(runIdValue)
    if (!runId) throw new Error('执行计划缺少有效 runId')
    if (this.pending.has(runId)) throw new Error(`执行计划 ${runId} 已在等待确认`)
    if (owner.isDestroyed?.()) throw new Error('执行计划所属窗口已关闭')
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('助手任务已取消')

    return new Promise<ConfirmedAssistantPlan | undefined>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', abort)
        if (pending.timeout) clearTimeout(pending.timeout)
        this.pending.delete(runId)
      }
      const abort = (): void => {
        cleanup()
        reject(signal.reason instanceof Error ? signal.reason : new Error('助手任务已取消'))
      }
      const pending: PendingPlanConfirmation = {
        owner,
        input,
        signal,
        abort,
        resolve: (plan) => {
          cleanup()
          resolve(plan)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        }
      }
      this.pending.set(runId, pending)
      pending.timeout = setTimeout(() => {
        if (this.pending.get(runId) !== pending) return
        pending.reject(new Error('执行计划确认已超时，请重新提交问题'))
      }, Math.max(1, this.timeoutMs))
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  confirm(
    owner: PlanConfirmationOwner,
    runIdValue: unknown,
    patch?: AssistantPlanPatch
  ): ConfirmAgentPlanResult {
    const runId = normalizedRunId(runIdValue)
    const pending = this.pending.get(runId)
    if (
      !runId ||
      !pending ||
      pending.owner.id !== owner.id ||
      owner.isDestroyed?.() ||
      pending.signal.aborted
    ) {
      return { status: 'not_found', runId }
    }
    if (!pending.input) {
      pending.resolve()
      return { status: 'approved', runId }
    }

    const validation = validateAndApplyAssistantPlanPatch(pending.input, patch)
    if (!validation.ok) {
      // Invalid edits are deliberately non-consuming: the pending plan stays
      // live so the user can repair the patch and submit it again.
      return {
        status: 'invalid',
        runId,
        errors: validation.errors,
        ...(validation.warnings.length ? { warnings: validation.warnings } : {})
      }
    }
    pending.resolve(validation.plan)
    return {
      status: 'approved',
      runId,
      effectiveSummary: validation.plan.effectiveSummary,
      ...(validation.plan.warnings.length ? { warnings: validation.plan.warnings } : {})
    }
  }

  clearOwner(owner: PlanConfirmationOwner): void {
    for (const [runId, pending] of this.pending) {
      if (pending.owner.id !== owner.id) continue
      this.pending.delete(runId)
      pending.signal.removeEventListener('abort', pending.abort)
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(new Error('执行计划所属窗口已关闭'))
    }
  }

  clearAll(): void {
    for (const pending of [...this.pending.values()]) {
      pending.signal.removeEventListener('abort', pending.abort)
      if (pending.timeout) clearTimeout(pending.timeout)
      pending.reject(new Error('应用正在退出'))
    }
    this.pending.clear()
  }
}
