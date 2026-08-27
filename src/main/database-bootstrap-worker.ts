import { performance } from 'node:perf_hooks'
import { parentPort, workerData } from 'node:worker_threads'

import { AppDatabase } from './database'
import type {
  DatabaseBootstrapWorkerData,
  DatabaseBootstrapWorkerMessage
} from './database-bootstrap-protocol'

const port = parentPort
if (!port) throw new Error('数据库启动 Worker 未连接到主线程')

const input = workerData as Partial<DatabaseBootstrapWorkerData>

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error || '未知数据库启动错误')
}

const post = (message: DatabaseBootstrapWorkerMessage): void => {
  port.postMessage(message)
}

const run = (): void => {
  const databasePath = typeof input.databasePath === 'string' ? input.databasePath.trim() : ''
  const assetDir = typeof input.assetDir === 'string' ? input.assetDir.trim() : ''
  if (!databasePath || !assetDir) throw new Error('数据库启动路径无效')

  const startedAt = performance.now()
  let database: AppDatabase | null = null
  try {
    database = new AppDatabase(databasePath, assetDir, {
      onMigrationProgress: (progress) => post({ type: 'progress', progress })
    })
    database.close()
    database = null
    post({
      type: 'complete',
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt))
    })
  } catch (error) {
    try { database?.close() } catch { /* Preserve the original migration error. */ }
    post({ type: 'error', error: errorMessage(error) })
  } finally {
    port.close()
  }
}

run()
