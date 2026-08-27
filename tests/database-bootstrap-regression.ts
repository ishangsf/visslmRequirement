import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type RecordInput } from '../src/main/database'
import { startDatabaseBootstrap } from '../src/main/database-bootstrap'
import type { DatabaseMigrationProgress } from '../src/main/database-bootstrap-protocol'

const workerPath = join(process.cwd(), 'out', 'main', 'database-bootstrap-worker.js')
assert.equal(
  existsSync(workerPath),
  true,
  'database bootstrap regression requires a built out/main/database-bootstrap-worker.js'
)

const directory = mkdtempSync(join(tmpdir(), 'visslm-database-bootstrap-'))
const databasePath = join(directory, 'bootstrap.db')
const assetDir = join(directory, 'assets')
let database: AppDatabase | null = null

const makeRecord = (index: number): RecordInput => ({
  uid: `bootstrap-record-${String(index).padStart(4, '0')}`,
  projectId: 'bootstrap-project',
  nodeType: 'TSIssue',
  itemId: `BOOTSTRAP-${index}`,
  parentId: '',
  name: `启动迁移记录 ${index}`,
  lastModifyTime: '2026-08-27T00:00:00.000Z',
  raw: {
    _valm_ItemID: `BOOTSTRAP-${index}`,
    _valm_Name: `启动迁移记录 ${index}`,
    _valm_Description: `验证数据库迁移 Worker 不阻塞 Electron 主线程 ${index}`
  },
  normalizedText: `启动迁移记录 ${index} 数据库后台升级回归`
})

try {
  database = new AppDatabase(databasePath, assetDir)
  const records = Array.from({ length: 256 }, (_, index) => makeRecord(index))
  assert.equal(database.upsertRecords(records), records.length)
  // Simulate upgrading from the previous release. The current migration must
  // recompute requirement hashes and rebuild its FTS index in the Worker.
  database.setSetting('migration:requirement-business-index', 'requirement-business-index-v2')
  database.close()
  database = null

  const progress: DatabaseMigrationProgress[] = []
  const bootstrap = startDatabaseBootstrap({
    databasePath,
    assetDir,
    workerPath,
    onProgress: (entry) => progress.push(entry)
  })

  const firstCompleted = await Promise.race([
    bootstrap.done.then(() => 'worker' as const),
    new Promise<'main-loop'>((resolve) => setTimeout(() => resolve('main-loop'), 0))
  ])
  assert.equal(
    firstCompleted,
    'main-loop',
    'database migration must leave the main event loop responsive while the Worker runs'
  )

  const result = await bootstrap.done
  assert.ok(result.elapsedMs >= 0)
  assert.ok(progress.some((entry) => entry.phase === 'schema'))
  assert.ok(progress.some((entry) => entry.phase === 'requirement_hashes'))
  assert.ok(progress.some((entry) => entry.phase === 'requirement_search_index'))
  assert.ok(progress.some((entry) => entry.phase === 'ready'))

  database = new AppDatabase(databasePath, assetDir, { runMigrations: false })
  assert.equal(
    database.getSetting('migration:requirement-business-index'),
    'requirement-business-index-v4',
    'the Worker must commit the current database migration before the main process opens it'
  )
  assert.equal(database.getStats().recordCount, records.length)
  database.close()
  database = null

  console.log(JSON.stringify({
    ok: true,
    contract: 'database-bootstrap-worker',
    records: records.length,
    elapsedMs: result.elapsedMs,
    progressPhases: [...new Set(progress.map((entry) => entry.phase))]
  }, null, 2))
} finally {
  try { database?.close() } catch {}
  rmSync(directory, { recursive: true, force: true })
}
