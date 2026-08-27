import { randomUUID } from 'node:crypto'
import type {
  RecordMaintenanceFailedItem,
  RecordMaintenanceOperation,
  RecordMaintenancePreview,
  RecordMaintenanceScope,
  RecordMaintenanceStage,
  RecordMaintenanceStartInput,
  RecordMaintenanceTaskSnapshot,
  RecordMaintenanceTaskStatus
} from '../shared/types'
import { normalizeText } from './visslm'
import {
  AppDatabase,
  type RecordMaintenanceTarget,
  type RecordMaintenanceTaskItem
} from './database'
import { KnowledgeService } from './knowledge'
import { AsyncMutex } from './record-index-lock'

const activeStatuses = new Set<RecordMaintenanceTaskStatus>([
  'queued', 'scanning', 'running', 'stopping'
])

const supportedScopes = new Set<RecordMaintenanceScope>(['all', 'selected'])
const supportedOperations = new Set<RecordMaintenanceOperation>([
  'clean', 'rebuild_indexes', 'optimize'
])
const RECORD_MAINTENANCE_VECTOR_BATCH_SIZE = 32

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  setImmediate(resolve)
})

const maintenanceError = (error: unknown): string => (
  error instanceof Error && error.message.trim() ? error.message.trim() : String(error)
)

export class RecordMaintenanceService {
  private activeTaskId: string | null = null
  private stopRequested = false

  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge: KnowledgeService,
    private readonly recordIndexLock: AsyncMutex,
    private readonly progress?: (snapshot: RecordMaintenanceTaskSnapshot) => void,
    private readonly onRecordsChanged?: () => void
  ) {}

  preview(input: Pick<RecordMaintenanceStartInput, 'scope' | 'recordUids'>): RecordMaintenancePreview {
    this.assertScope(input.scope)
    return this.db.getRecordMaintenancePreview(
      input.scope,
      input.recordUids,
      this.knowledge.modelVersion
    )
  }

  start(input: RecordMaintenanceStartInput): RecordMaintenanceTaskSnapshot {
    this.assertScope(input.scope)
    this.assertOperation(input.operation)
    const active = this.db.getRecordMaintenanceTask(true)
    if (active) throw new Error('已有数据维护任务正在运行，请先停止或等待其完成')
    const targets = this.db.getRecordMaintenanceTargets(input.scope, input.recordUids)
    if (input.scope === 'selected' && !targets.length) {
      throw new Error('请选择至少一条存在的数据中心记录')
    }
    const timestamp = new Date().toISOString()
    const snapshot: RecordMaintenanceTaskSnapshot = {
      taskId: randomUUID(),
      scope: input.scope,
      operation: input.operation,
      status: 'queued',
      stage: 'scanning',
      message: targets.length ? '数据维护任务已排队' : '没有需要维护的数据中心记录',
      current: 0,
      total: targets.length,
      succeeded: 0,
      failed: 0,
      failedItems: [],
      startedAt: timestamp,
      updatedAt: timestamp
    }
    this.db.createRecordMaintenanceTask(snapshot, targets)
    this.activeTaskId = snapshot.taskId
    this.stopRequested = false
    void this.execute(snapshot, targets)
    return snapshot
  }

  getTask(): RecordMaintenanceTaskSnapshot | null {
    return this.db.getRecordMaintenanceTask()
  }

  stop(): RecordMaintenanceTaskSnapshot | null {
    const active = this.db.getRecordMaintenanceTask(true)
    if (!active) return this.db.getRecordMaintenanceTask()
    this.stopRequested = true
    this.activeTaskId = active.taskId
    const snapshot = this.withUpdate(active, {
      status: 'stopping',
      message: '正在等待当前记录处理完成后安全停止',
      stage: active.stage
    })
    this.db.saveRecordMaintenanceTask(snapshot)
    this.emit(snapshot)
    return snapshot
  }

  private async execute(
    initial: RecordMaintenanceTaskSnapshot,
    targets: RecordMaintenanceTarget[]
  ): Promise<void> {
    try {
      await this.recordIndexLock.runExclusive(async () => {
        let snapshot = this.withUpdate(initial, {
          status: this.stopRequested ? 'stopped' : 'scanning',
          stage: 'scanning',
          message: this.stopRequested ? '任务已安全停止，未处理记录未执行' : '正在扫描待处理记录'
        })
        this.persist(snapshot)
        if (this.stopRequested) return

        if (snapshot.operation === 'rebuild_indexes' || snapshot.operation === 'optimize') {
          const assertEmbeddingReady = (this.knowledge as KnowledgeService & {
            assertEmbeddingReady?: KnowledgeService['assertEmbeddingReady']
          }).assertEmbeddingReady
          if (typeof assertEmbeddingReady === 'function') {
            snapshot = this.withUpdate(snapshot, {
              status: 'scanning',
              stage: 'scanning',
              message: '正在检查本地向量运行时'
            })
            this.persist(snapshot)
            await assertEmbeddingReady.call(this.knowledge)
          }
        }

        if (snapshot.operation === 'optimize') this.db.optimizeRecordMaintenance()
        let changed = false
        const vectorBatch: RecordMaintenanceTarget[] = []
        const flushVectorBatch = async (): Promise<void> => {
          if (!vectorBatch.length) return
          const batch = vectorBatch.splice(0, vectorBatch.length)
          snapshot = await this.executeVectorBatch(snapshot, batch)
          changed = true
          await yieldToEventLoop()
        }
        for (const target of targets) {
          if (this.stopRequested) break
          snapshot = this.withUpdate(snapshot, {
            status: 'running',
            stage: 'scanning',
            message: `正在处理 ${target.name || target.uid}`,
            currentUid: target.uid,
            currentName: target.name
          })
          this.persist(snapshot)
          this.db.saveRecordMaintenanceItem(snapshot.taskId, {
            uid: target.uid,
            name: target.name,
            status: 'running',
            stage: 'scanning'
          })
          let itemStage: RecordMaintenanceStage = 'scanning'
          try {
            itemStage = await this.executeRecord(
              snapshot,
              target,
              (stage) => {
                itemStage = stage
              },
              () => {
                changed = true
              },
              snapshot.operation !== 'clean'
            )
            if (itemStage === 'vector') {
              this.db.saveRecordMaintenanceItem(snapshot.taskId, {
                uid: target.uid,
                name: target.name,
                status: 'running',
                stage: 'vector'
              })
              vectorBatch.push(target)
              if (
                vectorBatch.length >= RECORD_MAINTENANCE_VECTOR_BATCH_SIZE ||
                this.stopRequested
              ) {
                await flushVectorBatch()
              }
            } else {
              this.db.saveRecordMaintenanceItem(snapshot.taskId, {
                uid: target.uid,
                name: target.name,
                status: 'succeeded',
                stage: itemStage
              })
              snapshot = this.withUpdate(snapshot, {
                current: snapshot.current + 1,
                succeeded: snapshot.succeeded + 1,
                message: `已完成 ${target.name || target.uid}`,
                stage: itemStage,
                currentUid: target.uid,
                currentName: target.name
              })
            }
          } catch (error) {
            const message = maintenanceError(error)
            const failedItem: RecordMaintenanceFailedItem = {
              uid: target.uid,
              name: target.name,
              stage: itemStage,
              error: message
            }
            this.db.saveRecordMaintenanceItem(snapshot.taskId, {
              uid: target.uid,
              name: target.name,
              status: 'failed',
              stage: itemStage,
              error: message
            })
            this.db.markRecordMaintenanceStageFailed(
              target.uid,
              itemStage,
              message,
              snapshot.taskId,
              snapshot.operation
            )
            snapshot = this.withUpdate(snapshot, {
              current: snapshot.current + 1,
              failed: snapshot.failed + 1,
              failedItems: [...snapshot.failedItems, failedItem],
              message: `处理 ${target.name || target.uid} 失败：${message}`,
              stage: itemStage,
              currentUid: target.uid,
              currentName: target.name
            })
          }
          this.persist(snapshot)
          await yieldToEventLoop()
        }
        await flushVectorBatch()

        snapshot = this.withUpdate(snapshot, {
          status: this.stopRequested
            ? 'stopped'
            : snapshot.failed > 0
              ? 'completed_with_errors'
              : 'completed',
          stage: 'finalizing',
          message: this.stopRequested
            ? `已安全停止：完成 ${snapshot.succeeded} 条，失败 ${snapshot.failed} 条`
            : snapshot.failed > 0
              ? `维护完成：成功 ${snapshot.succeeded} 条，失败 ${snapshot.failed} 条`
              : `维护完成：成功处理 ${snapshot.succeeded} 条记录`,
          currentUid: undefined,
          currentName: undefined,
          finishedAt: new Date().toISOString()
        })
        this.persist(snapshot)
        if (changed) this.onRecordsChanged?.()
        snapshot = this.withUpdate(snapshot, { stage: 'idle' })
        this.persist(snapshot)
      })
    } catch (error) {
      const current = this.db.getRecordMaintenanceTask() ?? initial
      const failed = this.withUpdate(current, {
        status: 'failed',
        stage: 'idle',
        message: `数据维护任务失败：${maintenanceError(error)}`,
        currentUid: undefined,
        currentName: undefined,
        finishedAt: new Date().toISOString()
      })
      this.persist(failed)
      this.emit(failed)
    } finally {
      if (this.activeTaskId === initial.taskId) this.activeTaskId = null
      this.stopRequested = false
    }
  }

  private async executeRecord(
    snapshot: RecordMaintenanceTaskSnapshot,
    target: RecordMaintenanceTarget,
    onStage: (stage: RecordMaintenanceStage) => void,
    onChanged: () => void,
    deferVector = false
  ): Promise<RecordMaintenanceStage> {
    const shouldClean = snapshot.operation === 'clean' || snapshot.operation === 'optimize'
    const shouldRebuildIndexes = snapshot.operation === 'rebuild_indexes' || snapshot.operation === 'optimize'
    if (shouldClean) {
      onStage('cleaning')
      await this.updateStage(snapshot, target, 'cleaning', '正在重新生成可检索文本')
      const detail = this.db.getRecord(target.uid, false)
      if (!detail) throw new Error('记录不存在或已被删除')
      const labels = this.db.getFieldDisplayNames(detail.nodeType, Object.keys(detail.raw))
      const normalized = normalizeText(detail.raw, labels)
      if (!this.db.cleanRecordNormalizedText(target.uid, normalized, snapshot.taskId, snapshot.operation)) {
        throw new Error('记录不存在或已被删除')
      }
      onChanged()
    }
    if (shouldRebuildIndexes) {
      onStage('lexical')
      await this.updateStage(snapshot, target, 'lexical', '正在重建全文索引')
      if (!this.db.rebuildRequirementRecordLexicalIndex(target.uid, snapshot.taskId, snapshot.operation)) {
        throw new Error('记录不存在或已被删除')
      }
      onChanged()
      onStage('vector')
      if (deferVector) return 'vector'
      await this.updateStage(snapshot, target, 'vector', '正在生成记录向量')
      await this.knowledge.rebuildRecordIndexInLock(target.uid, snapshot.taskId, snapshot.operation)
      onChanged()
      return 'vector'
    }
    return shouldClean ? 'cleaning' : 'finalizing'
  }

  private async executeVectorBatch(
    snapshot: RecordMaintenanceTaskSnapshot,
    targets: RecordMaintenanceTarget[]
  ): Promise<RecordMaintenanceTaskSnapshot> {
    if (!targets.length) return snapshot
    const byUid = new Map(targets.map((target) => [target.uid, target]))
    const completed = new Set<string>()
    let next = this.withUpdate(snapshot, {
      status: 'running',
      stage: 'vector',
      message: `正在批量生成 ${targets.length} 条记录向量`,
      currentUid: targets[0].uid,
      currentName: targets[0].name
    })
    this.persist(next)

    const complete = (uid: string, error?: string): void => {
      if (completed.has(uid)) return
      const target = byUid.get(uid)
      if (!target) return
      completed.add(uid)
      if (error) {
        const message = maintenanceError(error)
        const failedItem: RecordMaintenanceFailedItem = {
          uid: target.uid,
          name: target.name,
          stage: 'vector',
          error: message
        }
        this.db.saveRecordMaintenanceItem(next.taskId, {
          uid: target.uid,
          name: target.name,
          status: 'failed',
          stage: 'vector',
          error: message
        })
        this.db.markRecordMaintenanceStageFailed(
          target.uid,
          'vector',
          message,
          next.taskId,
          next.operation
        )
        next = this.withUpdate(next, {
          current: next.current + 1,
          failed: next.failed + 1,
          failedItems: [...next.failedItems, failedItem],
          message: `处理 ${target.name || target.uid} 失败：${message}`,
          stage: 'vector',
          currentUid: target.uid,
          currentName: target.name
        })
      } else {
        this.db.saveRecordMaintenanceItem(next.taskId, {
          uid: target.uid,
          name: target.name,
          status: 'succeeded',
          stage: 'vector'
        })
        next = this.withUpdate(next, {
          current: next.current + 1,
          succeeded: next.succeeded + 1,
          message: `已完成 ${target.name || target.uid}`,
          stage: 'vector',
          currentUid: target.uid,
          currentName: target.name
        })
      }
      this.persist(next)
    }

    const batchMethod = (this.knowledge as KnowledgeService & {
      rebuildRecordIndexesInLock?: KnowledgeService['rebuildRecordIndexesInLock']
    }).rebuildRecordIndexesInLock
    try {
      if (typeof batchMethod === 'function') {
        const result = await batchMethod.call(
          this.knowledge,
          targets.map((target) => target.uid),
          next.taskId,
          next.operation,
          {
            onRecordComplete: (item) => complete(item.uid, item.error)
          }
        )
        for (const item of result.results) complete(item.uid, item.error)
      } else {
        for (const target of targets) {
          try {
            await this.knowledge.rebuildRecordIndexInLock(
              target.uid,
              next.taskId,
              next.operation
            )
            complete(target.uid)
          } catch (error) {
            complete(target.uid, maintenanceError(error))
          }
        }
      }
    } catch (error) {
      const message = maintenanceError(error)
      for (const target of targets) complete(target.uid, message)
    }
    for (const target of targets) {
      complete(target.uid, '记录向量索引未返回处理结果')
    }
    return next
  }

  private async updateStage(
    snapshot: RecordMaintenanceTaskSnapshot,
    target: RecordMaintenanceTarget,
    stage: RecordMaintenanceStage,
    message: string
  ): Promise<void> {
    const next = this.withUpdate(snapshot, {
      status: 'running',
      stage,
      message,
      currentUid: target.uid,
      currentName: target.name
    })
    this.persist(next)
    await yieldToEventLoop()
  }

  private persist(snapshot: RecordMaintenanceTaskSnapshot): void {
    this.db.saveRecordMaintenanceTask(snapshot)
    this.emit(snapshot)
  }

  private emit(snapshot: RecordMaintenanceTaskSnapshot): void {
    this.progress?.(snapshot)
  }

  private withUpdate(
    snapshot: RecordMaintenanceTaskSnapshot,
    patch: Partial<RecordMaintenanceTaskSnapshot>
  ): RecordMaintenanceTaskSnapshot {
    const next = {
      ...snapshot,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    if ('currentUid' in patch && patch.currentUid === undefined) delete next.currentUid
    if ('currentName' in patch && patch.currentName === undefined) delete next.currentName
    return next
  }

  private assertScope(scope: RecordMaintenanceScope): void {
    if (!supportedScopes.has(scope)) throw new Error('数据维护范围无效')
  }

  private assertOperation(operation: RecordMaintenanceOperation): void {
    if (!supportedOperations.has(operation)) throw new Error('数据维护操作无效')
  }
}
