import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../../src/main/database'

const directory = await mkdtemp(join(tmpdir(), 'requirement-matching-safety-'))
const databasePath = join(directory, 'safety.db')
const assetsPath = join(directory, 'assets')
let db: AppDatabase | null = null

try {
  db = new AppDatabase(databasePath, assetsPath)
  const project = db.createManagedProject('safety-project', { projectName: '安全迁移项目' })
  db.upsertRecord({
    uid: 'legacy-record', projectId: 'historical-project', nodeType: 'Requirement', itemId: 'LEGACY-1',
    parentId: '', name: '历史订单查询能力', lastModifyTime: new Date().toISOString(),
    raw: { description: '支持按订单号查询订单详情' }, normalizedText: '支持按订单号查询订单详情'
  })
  const document = db.insertKnowledgeDocument({
    id: randomUUID(), fileName: 'agreement.txt', filePath: join(directory, 'agreement.txt'),
    extension: '.txt', mimeType: 'text/plain', byteSize: 1, sha256: randomUUID()
  })
  db.replaceProjectRequirements(project.id, document.id, [{
    id: 'legacy-requirement', requirementNo: 1, module: '订单管理', title: '订单查询',
    content: '支持按订单号查询订单详情', sourceLocation: '第 1 页', sourceChunkId: 'chunk-1',
    status: 'satisfied', statusReason: '历史 AI 自动判断'
  }])
  assert(db.linkProjectAsset(project.id, 'legacy-record', 'legacy-requirement'))
  db.setSetting('requirementMatching.provenanceMigration', '')
  db.close()

  db = new AppDatabase(databasePath, assetsPath)
  const asset = db.listProjectAssets(project.id)[0]
  const requirement = db.getProjectRequirement('legacy-requirement')
  assert(asset)
  assert(requirement)
  assert.equal(asset.linkSource, 'legacy_unknown')
  assert.equal(asset.confirmedBy, '')
  assert.equal(asset.requirements[0]?.linkSource, 'legacy_unknown')
  assert.equal(requirement.status, 'satisfied')
  assert.equal(requirement.statusSource, 'legacy_unverified')

  db.updateProjectRequirementStatus('legacy-requirement', 'satisfied')
  db.close()
  db = new AppDatabase(databasePath, assetsPath)
  assert.equal(db.getProjectRequirement('legacy-requirement')?.statusSource, 'manual')
  db.close()
  db = null

  console.log(JSON.stringify({ ok: true, checks: ['legacy link provenance', 'legacy status preserved', 'migration idempotence'] }))
} finally {
  try { db?.close() } catch { /* already closed */ }
  await rm(directory, { recursive: true, force: true })
}
