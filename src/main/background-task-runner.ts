export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'TaskCancelledError'
  }
}

export interface BackgroundTaskHandle {
  readonly taskId: string
  readonly signal: AbortSignal
  checkpoint(): Promise<void>
  dispose(): void
}

/**
 * Cooperative boundary for CPU-heavy main-process work.
 *
 * Electron's main process still owns SQLite and the native model runtimes, so
 * moving those objects across a worker boundary would be unsafe without a
 * larger repository split.  This runner gives long jobs a cancellation
 * handle, yields between expensive batches, and prevents leaked controllers.
 */
export class BackgroundTaskRunner {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly maxConcurrentTasks = Number.POSITIVE_INFINITY) {
    if (maxConcurrentTasks <= 0 || Number.isNaN(maxConcurrentTasks)) {
      throw new Error('后台任务并发上限必须大于 0')
    }
  }

  begin(taskId: string): BackgroundTaskHandle {
    const normalized = taskId.trim()
    if (!normalized) throw new Error('后台任务缺少 taskId')
    if (this.controllers.has(normalized)) throw new Error(`任务 ${normalized} 已在运行`)
    if (this.controllers.size >= this.maxConcurrentTasks) {
      throw new Error(`后台任务资源已达到并发上限（${this.maxConcurrentTasks}）`)
    }
    const controller = new AbortController()
    this.controllers.set(normalized, controller)
    let disposed = false
    return {
      taskId: normalized,
      signal: controller.signal,
      checkpoint: async (): Promise<void> => {
        if (controller.signal.aborted) throw new TaskCancelledError()
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (controller.signal.aborted) throw new TaskCancelledError()
      },
      dispose: (): void => {
        if (disposed) return
        disposed = true
        if (this.controllers.get(normalized) === controller) this.controllers.delete(normalized)
      }
    }
  }

  cancel(taskId: string): boolean {
    const controller = this.controllers.get(taskId.trim())
    if (!controller) return false
    controller.abort()
    return true
  }

  cancelAll(): void {
    for (const controller of this.controllers.values()) controller.abort()
  }

  get size(): number {
    return this.controllers.size
  }
}
