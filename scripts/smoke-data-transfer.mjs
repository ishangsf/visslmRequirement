import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database.ts'

const root = mkdtempSync(join(tmpdir(), 'visslm-data-transfer-'))
const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const imageDataUri = `data:image/png;base64,${imageBytes.toString('base64')}`
const source = new AppDatabase(
  join(root, 'source.db'),
  join(root, 'source-assets')
)
source.upsertRecord({
  uid: 'test-1',
  projectId: '',
  nodeType: 'Task',
  itemId: 'TASK-1',
  parentId: '',
  name: '导入导出测试',
  lastModifyTime: '2026-07-30T00:00:00.000Z',
  raw: {
    _valm_Uid: 'test-1',
    _valm_NodeType: 'Task',
    _valm_Name: '导入导出测试',
    _valm_Description: `<p>带图片的描述<img alt="inline" src="${imageDataUri}"></p>`
  },
  normalizedText: '带图片的描述'
})
source.saveImage({
  recordUid: 'test-1',
  name: 'test.png',
  mimeType: 'image/png',
  sourceUrl: 'inline:data-uri',
  bytes: imageBytes
})
const exported = source.exportRows()

const target = new AppDatabase(
  join(root, 'target.db'),
  join(root, 'target-assets')
)
const imported = target.importRows(exported)
target.markPushResult('test-1', 'success', '推送成功', 'remote-1')
const pushLogId = target.beginPushLog({
  recordUid: 'test-1',
  recordName: '导入导出测试',
  endpoint: 'http://example.test/alm/rest/items',
  params: {
    nodeType: 'Task',
    projectId: 'project-1',
    user: 'tester',
    ApiToken: '******'
  },
  body: {
    _valm_Name: '导入导出测试',
    _valm_Description: '这段大字段不应进入日志',
    customField: '保留字段'
  }
})
target.finishPushLog(pushLogId, 'success', {
  httpStatus: 200,
  response: { ErrorCode: 0 },
  remoteUid: 'remote-1'
})
const statsAfterPush = target.getStats()
const pushLogs = target.listPushLogs()
const importedDetail = target.getRecord('test-1')
const importedSha = importedDetail?.images[0]?.sha256 ?? ''
const importedBinaryPath = join(
  root,
  'target-assets',
  'blobs',
  importedSha.slice(0, 2),
  importedSha
)
const importedImagePath = join(
  root,
  'target-assets',
  `${importedDetail?.images[0]?.sha256}.b64`
)
const partialDelete = target.deleteData(['test-1'])
const partialFileRemoved = !existsSync(importedBinaryPath) && !existsSync(importedImagePath)
const reimported = target.importRows(exported)
const allDelete = target.deleteData()
const finalStats = target.getStats()
const retainedPushLogs = target.listPushLogs()

const legacyDbPath = join(root, 'legacy.db')
const legacyAssetDir = join(root, 'legacy-assets')
const legacy = new AppDatabase(legacyDbPath, legacyAssetDir)
legacy.upsertRecord({
  uid: 'legacy-record',
  projectId: '',
  nodeType: 'Task',
  itemId: 'TASK-LEGACY-1',
  parentId: '',
  name: '旧文件迁移测试',
  lastModifyTime: '',
  raw: { _valm_Uid: 'legacy-record', _valm_NodeType: 'Task', _valm_Name: '旧文件迁移测试', _valm_ItemID: 'TASK-LEGACY-1' },
  normalizedText: '旧文件迁移测试'
})
const legacyImage = legacy.saveImage({
  recordUid: 'legacy-record',
  name: 'legacy.png',
  mimeType: 'image/png',
  sourceUrl: 'legacy:test',
  bytes: imageBytes
})
legacy.close()
const legacyBase64Path = join(legacyAssetDir, 'legacy.png.b64')
writeFileSync(legacyBase64Path, imageBytes.toString('base64'), 'utf8')
const legacySql = new DatabaseSync(legacyDbPath)
legacySql.prepare('UPDATE images SET base64_path = ?, binary_path = \'\' WHERE id = ?')
  .run(legacyBase64Path, legacyImage.id)
legacySql.close()
rmSync(join(legacyAssetDir, 'blobs'), { recursive: true, force: true })
const migratedLegacy = new AppDatabase(legacyDbPath, legacyAssetDir)
const migratedLegacyDetail = migratedLegacy.getRecord('legacy-record')
const legacyMigrated = Boolean(
  migratedLegacyDetail?.images[0]?.assetUrl &&
  migratedLegacy.readAssetBytes(legacyImage.sha256)?.equals(imageBytes) &&
  !existsSync(legacyBase64Path)
)
migratedLegacy.close()
if (!legacyMigrated) throw new Error('旧 .b64 文件未完成原子迁移')

source.close()
target.close()

if (!importedDetail?.description.includes('visslm-asset://') || importedDetail.description.includes('data:image/')) {
  throw new Error('旧 JSON/JSONL 导入未将描述中的 Base64 图片转换为资源令牌')
}

console.log(JSON.stringify({
  root,
  exportedRecords: exported.length,
  exportedImageHasBase64: Boolean(
    (exported[0]?.images)?.[0]?.base64
  ),
  imported,
  importedDescription: importedDetail?.description,
  importedImageHasBase64: importedDetail?.images[0]?.dataUri?.startsWith('data:image/'),
  pushStatusStored:
    importedDetail?.pushStatus === 'success' &&
    importedDetail?.pushedUid === 'remote-1',
  overviewCounts:
    statsAfterPush.collectedCount === 1 &&
    statsAfterPush.pushedCount === 1,
  pushLogStored:
    pushLogs.total === 1 &&
    pushLogs.rows[0]?.status === 'success' &&
    pushLogs.rows[0]?.httpStatus === 200 &&
    pushLogs.rows[0]?.remoteUid === 'remote-1',
  pushLogDescriptionOmitted:
    !('_valm_Description' in (pushLogs.rows[0]?.body ?? {})) &&
    pushLogs.rows[0]?.body.customField === '保留字段',
  pushLogTokenRedacted: pushLogs.rows[0]?.params.ApiToken === '******',
  partialDelete,
  partialFileRemoved,
  reimported,
  legacyMigrated,
  allDelete,
  finalRecordCount: finalStats.recordCount,
  finalProjectCount: finalStats.projectCount,
  finalImageCount: finalStats.imageCount,
  pushLogRetainedAfterDataDelete: retainedPushLogs.total === 1
}, null, 2))
