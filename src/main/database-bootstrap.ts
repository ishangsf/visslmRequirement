import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  DATABASE_BOOTSTRAP_WORKER_FILE_NAME,
  isDatabaseBootstrapWorkerMessage,
  type DatabaseBootstrapWorkerData,
  type DatabaseMigrationProgress
} from './database-bootstrap-protocol'

export interface DatabaseBootstrapOptions extends DatabaseBootstrapWorkerData {
  workerPath?: string
  onProgress?: (progress: DatabaseMigrationProgress) => void
}

export interface DatabaseBootstrapResult {
  elapsedMs: number
}

export interface DatabaseBootstrapHandle {
  worker: Worker
  done: Promise<DatabaseBootstrapResult>
}

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  const message = String(error || '').trim()
  return message || fallback
}

export const resolveDatabaseBootstrapWorkerPath = (): string => {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDirectory, DATABASE_BOOTSTRAP_WORKER_FILE_NAME),
    join(moduleDirectory, '..', DATABASE_BOOTSTRAP_WORKER_FILE_NAME),
    join(process.cwd(), 'out', 'main', DATABASE_BOOTSTRAP_WORKER_FILE_NAME)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

export const startDatabaseBootstrap = (
  options: DatabaseBootstrapOptions
): DatabaseBootstrapHandle => {
  const workerPath = options.workerPath ?? resolveDatabaseBootstrapWorkerPath()
  if (!existsSync(workerPath)) {
    throw new Error('数据库启动 Worker 未找到，请重新构建或修复 VISSLM Agent')
  }

  const worker = new Worker(workerPath, {
    workerData: {
      databasePath: options.databasePath,
      assetDir: options.assetDir
    } satisfies DatabaseBootstrapWorkerData
  })

  const done = new Promise<DatabaseBootstrapResult>((resolve, reject) => {
    let completed: DatabaseBootstrapResult | null = null
    let workerError: Error | null = null

    worker.on('message', (value: unknown) => {
      if (!isDatabaseBootstrapWorkerMessage(value)) {
        workerError = new Error('数据库启动 Worker 返回了无效响应')
        void worker.terminate()
        return
      }
      if (value.type === 'progress') {
        options.onProgress?.(value.progress)
        return
      }
      if (value.type === 'error') {
        workerError = new Error(value.error)
        return
      }
      completed = { elapsedMs: value.elapsedMs }
    })
    worker.once('error', (error) => {
      workerError = new Error(errorMessage(error, '数据库启动 Worker 执行失败'))
    })
    worker.once('exit', (code) => {
      if (completed && code === 0 && !workerError) {
        resolve(completed)
        return
      }
      reject(workerError ?? new Error(`数据库启动 Worker 异常退出（代码 ${code}）`))
    })
  })

  return { worker, done }
}
