export const DATABASE_BOOTSTRAP_WORKER_FILE_NAME = 'database-bootstrap-worker.js'

export interface DatabaseMigrationProgress {
  phase: string
  message: string
  current?: number
  total?: number
}

export interface DatabaseBootstrapWorkerData {
  databasePath: string
  assetDir: string
}

export type DatabaseBootstrapProgressMessage = {
  type: 'progress'
  progress: DatabaseMigrationProgress
}

export type DatabaseBootstrapCompleteMessage = {
  type: 'complete'
  elapsedMs: number
}

export type DatabaseBootstrapErrorMessage = {
  type: 'error'
  error: string
}

export type DatabaseBootstrapWorkerMessage =
  | DatabaseBootstrapProgressMessage
  | DatabaseBootstrapCompleteMessage
  | DatabaseBootstrapErrorMessage

export const isDatabaseBootstrapWorkerMessage = (
  value: unknown
): value is DatabaseBootstrapWorkerMessage => {
  if (!value || typeof value !== 'object') return false
  const message = value as Partial<DatabaseBootstrapWorkerMessage>
  if (message.type === 'complete') {
    return typeof message.elapsedMs === 'number' && Number.isFinite(message.elapsedMs)
  }
  if (message.type === 'error') return typeof message.error === 'string' && Boolean(message.error)
  if (message.type !== 'progress' || !message.progress || typeof message.progress !== 'object') {
    return false
  }
  return typeof message.progress.phase === 'string' &&
    typeof message.progress.message === 'string'
}
