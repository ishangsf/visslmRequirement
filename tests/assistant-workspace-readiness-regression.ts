import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { deriveAssistantWorkspaceReadiness } from '../src/shared/assistant-readiness'
import type { KnowledgeStats } from '../src/shared/types'

const stats = (overrides: Partial<KnowledgeStats> = {}): KnowledgeStats => ({
  documentCount: 0,
  readyCount: 0,
  processingCount: 0,
  failedCount: 0,
  chunkCount: 0,
  indexedChunkCount: 0,
  recordCount: 0,
  modelVersion: 'test-model',
  ...overrides
})

const checks: string[] = []

assert.equal(deriveAssistantWorkspaceReadiness({
  dataRecordCount: 0,
  knowledgeStats: stats()
}).state, 'no_data')
checks.push('empty workspace is distinguished from an empty answer')

assert.equal(deriveAssistantWorkspaceReadiness({
  dataRecordCount: 12,
  knowledgeStats: stats(),
  liveProgress: {
    taskId: 'running-task',
    phase: 'records',
    message: '正在建立索引',
    current: 3,
    total: 12,
    status: 'running'
  }
}).state, 'indexing')
checks.push('live indexing progress takes precedence over vector counts')

assert.equal(deriveAssistantWorkspaceReadiness({
  dataRecordCount: 12,
  knowledgeStats: stats({
    latestTask: {
      taskId: 'failed-task',
      phase: 'error',
      message: '模型资源不可用',
      current: 3,
      total: 12,
      status: 'failed'
    }
  })
}).state, 'index_failed')
checks.push('persisted index failure remains actionable after reload')

assert.equal(deriveAssistantWorkspaceReadiness({
  dataRecordCount: 12,
  knowledgeStats: stats()
}).state, 'index_missing')
assert.equal(deriveAssistantWorkspaceReadiness({
  dataRecordCount: 12,
  knowledgeStats: stats({ indexedChunkCount: 30, recordCount: 30 })
}).state, 'ready')
checks.push('missing and ready indexes have distinct states')

const directory = await mkdtemp(join(tmpdir(), 'assistant-readiness-'))
const databasePath = join(directory, 'readiness.db')
const assetsPath = join(directory, 'assets')
let db = new AppDatabase(databasePath, assetsPath)
try {
  db.saveKnowledgeIndexProgress({
    taskId: 'interrupted-task',
    phase: 'embedding',
    message: '正在生成向量',
    current: 2,
    total: 8,
    status: 'running'
  })
  db.close()
  db = new AppDatabase(databasePath, assetsPath)
  const persisted = db.getKnowledgeStats('test-model').latestTask
  assert.equal(persisted?.taskId, 'interrupted-task')
  assert.equal(persisted?.status, 'failed')
  assert.match(persisted?.message ?? '', /应用重启中断，可重试/)
  checks.push('interrupted index task is persisted as retryable failure')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const [renderer, knowledge, shared] = await Promise.all([
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/knowledge.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
])

assert.match(shared, /latestTask\?:\s*KnowledgeIndexProgress/)
assert.match(renderer, /onKnowledgeProgress\(\(next\)\s*=>/)
assert.match(renderer, /准备数据/)
assert.match(renderer, /上传文档/)
assert.match(renderer, /重建索引/)
assert.match(renderer, /刷新状态/)
assert.match(renderer, /onOpenAssetCenter\('data'\)/)
assert.match(renderer, /onOpenAssetCenter\('knowledge'\)/)
checks.push('chat UI exposes refresh, recovery, and source preparation CTAs')

assert.match(knowledge, /await this\.syncRecordIndexInternal\(\)[\s\S]*return this\.rebuildIndexInternal\(\)/)
assert.match(knowledge, /phase:\s*'error'[\s\S]*采集记录索引失败/)
assert.match(knowledge, /索引重建失败/)
checks.push('rebuild covers record sources and persists terminal failures')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
