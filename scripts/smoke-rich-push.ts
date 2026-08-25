import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { PushService, type VisslmClient } from '../src/main/visslm'

const root = mkdtempSync(join(tmpdir(), 'visslm-rich-push-smoke-'))
const db = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))
const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex')
db.upsertRecord({
  uid: 'push-record',
  projectId: 'source-project',
  nodeType: 'Task',
  itemId: 'TASK-PUSH-1',
  parentId: '',
  name: '推送图片测试',
  lastModifyTime: '2026-08-24T00:00:00.000Z',
  raw: {
    _valm_Uid: 'push-record',
    _valm_NodeType: 'Task',
    _valm_Name: '推送图片测试',
    _valm_ItemID: 'TASK-PUSH-1',
    _valm_Description: ''
  },
  normalizedText: '推送图片测试'
})
const saved = db.saveImage({
  recordUid: 'push-record',
  name: 'push.png',
  mimeType: 'image/png',
  sourceUrl: 'push:test',
  bytes: imageBytes
})
const token = saved.assetUrl as string
db.updateRecordRawAndNormalizedText('push-record', {
  _valm_Uid: 'push-record',
  _valm_NodeType: 'Task',
  _valm_Name: '推送图片测试',
  _valm_ItemID: 'TASK-PUSH-1',
  _valm_Description: `<p><img alt="x" src="${token}"></p>`
}, '推送图片测试')
db.saveRecordImageReference({
  id: token.split('/').pop(),
  recordUid: 'push-record',
  fieldPath: '_valm_Description',
  ordinal: 0,
  assetSha256: saved.sha256,
  sourceType: 'rich-text',
  sourceName: saved.name,
  originalSource: token
})

let uploadCount = 0
let createCount = 0
let failUpload = false
const fakeClient = {
  baseUrl: 'http://example.test/alm',
  createItemEndpoint: () => 'http://example.test/alm/rest/items',
  createItemTraceParams: (params: Record<string, string>) => ({ ...params, user: 'tester', ApiToken: '******' }),
  uploadRichImage: async () => {
    uploadCount += 1
    if (failUpload) throw new Error('模拟图片上传失败')
    return { remotePath: 'FileCenterImg/Index/push.png', httpStatus: 200 }
  },
  createItem: async (_params: Record<string, string>, body: Record<string, unknown>) => {
    createCount += 1
    assert.equal(body._valm_Description, '<p><img alt="x" src="FileCenterImg/Index/push.png"></p>')
    return { data: { ErrorCode: 0, props: { _valm_Uid: 'remote-1' } }, httpStatus: 200 }
  }
} as unknown as VisslmClient

const service = new PushService(db, () => fakeClient)
const config = { recordUids: ['push-record'], nodeType: 'Task', projectId: 'target-project' }
const preview = service.preview(config)
assert.equal(preview.imageTotal, 1)
assert.equal(preview.imageUpload, 1)
assert.equal(preview.imageFailed, 0)
const pushed = await service.push(config)
assert.equal(pushed.successCount, 1)
assert.equal(uploadCount, 1)
assert.equal(createCount, 1)
const retried = await service.push(config)
assert.equal(retried.successCount, 1)
assert.equal(uploadCount, 1)
assert.equal(createCount, 2)

failUpload = true
db.upsertRecord({
  uid: 'push-record-fail',
  projectId: 'source-project',
  nodeType: 'Task',
  itemId: 'TASK-PUSH-2',
  parentId: '',
  name: '推送图片测试',
  lastModifyTime: '',
  raw: {
    _valm_Uid: 'push-record-fail',
    _valm_NodeType: 'Task',
    _valm_Name: '推送图片测试',
    _valm_ItemID: 'TASK-PUSH-1',
    _valm_Description: `<p><img src="${token}"></p>`
  },
  normalizedText: '推送图片测试'
})
db.attachImageAsset({ recordUid: 'push-record-fail', name: saved.name, mimeType: saved.mimeType, sourceUrl: saved.sourceUrl, sha256: saved.sha256 })
const failed = await service.push({ ...config, recordUids: ['push-record-fail'], projectId: 'target-project-fail' })
assert.equal(failed.failedCount, 1)
assert.equal(createCount, 2)
assert.equal(failed.imageFailed, 1)

db.close()
console.log(JSON.stringify({ uploadCount, createCount, preview, pushed, retried, failed }))
