import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database.ts'

const root = mkdtempSync(join(tmpdir(), 'visslm-data-transfer-'))
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
    _valm_Description: '<p>带图片的描述</p>'
  },
  normalizedText: '带图片的描述'
})
source.saveImage({
  recordUid: 'test-1',
  name: 'test.png',
  mimeType: 'image/png',
  sourceUrl: 'import-test:image',
  bytes: Buffer.from('89504e470d0a1a0a', 'hex')
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
const importedImagePath = join(
  root,
  'target-assets',
  `${importedDetail?.images[0]?.sha256}.b64`
)
const partialDelete = target.deleteData(['test-1'])
const partialFileRemoved = !existsSync(importedImagePath)
const reimported = target.importRows(exported)
const allDelete = target.deleteData()
const finalStats = target.getStats()
const retainedPushLogs = target.listPushLogs()

source.close()
target.close()

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
  allDelete,
  finalRecordCount: finalStats.recordCount,
  finalProjectCount: finalStats.projectCount,
  finalImageCount: finalStats.imageCount,
  pushLogRetainedAfterDataDelete: retainedPushLogs.total === 1
}, null, 2))
