import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { parseRichImageUploadCallback, PushService, type VisslmClient } from '../src/main/visslm'

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
    _valm_Description: '',
    Source: '来源字段'
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
  _valm_Description: `<p><img alt="x" src="${token}"></p>`,
  Source: '来源字段'
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

assert.equal(
  parseRichImageUploadCallback(
    "window.parent.CKEDITOR.tools.callFunction(7, '/app/FileCenterImg/Index/ckeditor.png')"
  ),
  'app/FileCenterImg/Index/ckeditor.png'
)
assert.equal(
  parseRichImageUploadCallback(
    JSON.stringify({ uploaded: 1, url: '/app/FileCenterImg/Index/from-json.png' })
  ),
  'app/FileCenterImg/Index/from-json.png'
)

let uploadCount = 0
let createCount = 0
let failUpload = false
const uploadPaths: string[] = []
const callEvents: string[] = []
const createCalls: Array<{ params: Record<string, string>; body: Record<string, unknown> }> = []
const fakeClient = {
  baseUrl: 'http://172.1.1.251',
  createItemEndpoint: () => `${fakeClient.baseUrl}/rest/items`,
  createItemTraceParams: (params: Record<string, string>) => ({ ...params, user: 'tester', ApiToken: '******' }),
  uploadRichImage: async () => {
    callEvents.push('upload')
    uploadCount += 1
    if (failUpload) throw new Error('模拟图片上传失败')
    const remotePath = `FileCenterImg/Index/upload-${uploadCount}.png`
    uploadPaths.push(remotePath)
    return { remotePath, httpStatus: 200 }
  },
  createItem: async (params: Record<string, string>, body: Record<string, unknown>) => {
    callEvents.push('create')
    createCount += 1
    createCalls.push({ params, body })
    const description = String(body._valm_Description ?? '')
    assert.match(description, /FileCenterImg\/Index\//)
    assert.equal(description.includes('visslm-asset://'), false)
    if (createCount === 1) {
      return { data: { ErrorCode: 0, propList: [{ _valm_Uid: 'remote-prop-list' }] }, httpStatus: 200 }
    }
    if (createCount === 2) {
      return { data: { ErrorCode: 0, props: { _valm_Uid: 'remote-props' } }, httpStatus: 200 }
    }
    return { data: { ErrorCode: 0, prop: { _valm_Uid: 'remote-prop' } }, httpStatus: 200 }
  }
} as unknown as VisslmClient

const service = new PushService(db, () => fakeClient)
const config = { recordUids: ['push-record'], nodeType: 'Task', projectId: 'target-project' }
const preview = service.preview(config)
assert.equal(preview.total, 1)
assert.equal(preview.requests.length, 1)
assert.equal(preview.requests[0].recordUid, 'push-record')
assert.equal(preview.imageTotal, 1)
assert.equal(preview.imageUpload, 1)
assert.equal(preview.imageFailed, 0)
const mappedPreview = service.preview({
  ...config,
  fieldMappings: [{
    id: 'require-by',
    sourceField: 'Source',
    targetField: 'RequireBy'
  }, {
    id: 'user-story-description',
    sourceField: '_valm_Description',
    targetField: 'UserStoryDescription'
  }, {
    id: 'accept-criteria',
    sourceField: '_valm_ItemID',
    targetField: 'AcceptCriteria'
  }]
})
assert.deepEqual(Object.keys(mappedPreview.requests[0].body).sort(), [
  'AcceptCriteria',
  'RequireBy',
  'UserStoryDescription'
].sort())
assert.equal(mappedPreview.requests[0].body.RequireBy, '来源字段')
assert.equal(mappedPreview.requests[0].body.UserStoryDescription, preview.requests[0].body._valm_Description)
assert.equal(mappedPreview.requests[0].body.AcceptCriteria, 'TASK-PUSH-1')
assert.equal('_valm_Name' in mappedPreview.requests[0].body, false)
assert.equal('_valm_Description' in mappedPreview.requests[0].body, false)
assert.equal('_valm_ItemID' in mappedPreview.requests[0].body, false)
for (const sourceField of ['_valm_Uid', '_valm_NodeType']) {
  assert.throws(
    () => service.preview({
      ...config,
      fieldMappings: [{ id: `forbidden-source-${sourceField}`, sourceField, targetField: 'MappedInternal' }]
    }),
    /消息体禁止字段/
  )
}
for (const targetField of ['_valm_Uid', '_valm_NodeType', '_valm_ItemID']) {
  assert.throws(
    () => service.preview({
      ...config,
      fieldMappings: [{ id: `forbidden-target-${targetField}`, sourceField: 'Source', targetField }]
    }),
    /消息体禁止字段/
  )
}
const firstPushEventStart = callEvents.length
const pushed = await service.push(config)
assert.equal(pushed.total, 1)
assert.equal(pushed.requests.length, 1)
assert.equal(pushed.requests[0].recordUid, 'push-record')
assert.equal(pushed.successCount, 1)
assert.equal(uploadCount, 1)
assert.equal(createCount, 1)
assert.deepEqual(callEvents.slice(firstPushEventStart), ['upload', 'create'])
assert.equal(
  createCalls[0]?.body._valm_Description,
  `<p><img alt="x" src="${uploadPaths[0]}"></p>`
)
assert.equal(createCalls[0]?.body._valm_Description === '<p><img alt="x" src="FileCenterImg/Index/push.png"></p>', false)
assert.equal(pushed.requests[0].response && typeof pushed.requests[0].response === 'object'
  ? (pushed.requests[0].response as Record<string, unknown>).propList?.[0] &&
    ((pushed.requests[0].response as Record<string, unknown>).propList as Array<Record<string, unknown>>)[0]?._valm_Uid
  : undefined, 'remote-prop-list')
assert.equal(db.getRecord('push-record', false)?.pushedUid, 'remote-prop-list')
assert.equal(
  db.listPushLogs(1, 20).rows.find((row) => row.recordUid === 'push-record')?.remoteUid,
  'remote-prop-list'
)
const retried = await service.push(config)
assert.equal(retried.total, 1)
assert.equal(retried.requests.length, 1)
assert.equal(retried.requests[0].recordUid, 'push-record')
assert.equal(retried.successCount, 1)
assert.equal(uploadCount, 2)
assert.equal(createCount, 2)
assert.deepEqual(callEvents.slice(firstPushEventStart + 2), ['upload', 'create'])
assert.equal(
  createCalls[1]?.body._valm_Description,
  `<p><img alt="x" src="${uploadPaths[1]}"></p>`
)
assert.notEqual(uploadPaths[1], uploadPaths[0])
assert.equal(db.getRecord('push-record', false)?.pushedUid, 'remote-props')
assert.equal(
  db.listPushLogs(1, 20).rows.find((row) => row.recordUid === 'push-record')?.remoteUid,
  'remote-props'
)
const singularPushEventStart = callEvents.length
const singular = await service.push(config)
assert.equal(singular.total, 1)
assert.equal(singular.requests.length, 1)
assert.equal(singular.requests[0].recordUid, 'push-record')
assert.equal(singular.successCount, 1)
assert.equal(uploadCount, 3)
assert.deepEqual(callEvents.slice(singularPushEventStart), ['upload', 'create'])
assert.equal(
  createCalls[2]?.body._valm_Description,
  `<p><img alt="x" src="${uploadPaths[2]}"></p>`
)
assert.notEqual(uploadPaths[2], uploadPaths[1])
assert.equal(db.getRecord('push-record', false)?.pushedUid, 'remote-prop')
assert.equal(
  db.listPushLogs(1, 20).rows.find((row) => row.recordUid === 'push-record')?.remoteUid,
  'remote-prop'
)
assert.equal(createCalls.length, 3)
assert.equal(createCalls[0].params.projectId, 'target-project')
assert.equal(createCalls[1].params.projectId, 'target-project')
assert.equal(createCalls[2].params.projectId, 'target-project')

const addOriginalSourceRecord = (
  uid: string,
  itemId: string,
  name: string,
  originalSource: string
): void => {
  db.upsertRecord({
    uid,
    projectId: 'source-project',
    nodeType: 'Task',
    itemId,
    parentId: '',
    name,
    lastModifyTime: '',
    raw: {
      _valm_Uid: uid,
      _valm_NodeType: 'Task',
      _valm_Name: name,
      _valm_ItemID: itemId,
      _valm_Description: ''
    },
    normalizedText: name
  })
  const attached = db.attachImageAsset({
    recordUid: uid,
    name,
    mimeType: saved.mimeType,
    sourceUrl: originalSource,
    sha256: saved.sha256
  })
  const attachedToken = attached.assetUrl as string
  db.updateRecordRawAndNormalizedText(uid, {
    _valm_Uid: uid,
    _valm_NodeType: 'Task',
    _valm_Name: name,
    _valm_ItemID: itemId,
    _valm_Description: `<p><img alt="x" src="${attachedToken}"></p>`
  }, name)
  db.saveRecordImageReference({
    id: attachedToken.split('/').pop(),
    recordUid: uid,
    fieldPath: '_valm_Description',
    ordinal: 0,
    assetSha256: saved.sha256,
    sourceType: 'rich-text',
    sourceName: name,
    originalSource
  })
}

const safeOriginalPath = 'FileCenterImg/Index/eed1399b6cfd45b5.png'
const safeOriginalUid = '182005'
addOriginalSourceRecord(safeOriginalUid, 'TASK-PUSH-ORIGINAL', 'original-path.png', safeOriginalPath)
const safePushEventStart = callEvents.length
const safeUploadCount = uploadCount
const safe = await service.push({
  recordUids: [safeOriginalUid],
  nodeType: 'Task',
  projectId: 'target-original-path'
})
assert.equal(safe.total, 1)
assert.equal(safe.requests.length, 1)
assert.equal(safe.requests[0].recordUid, safeOriginalUid)
assert.equal(safe.successCount, 1)
assert.equal(safe.failedCount, 0)
assert.equal(safe.imageTotal, 1)
assert.equal(safe.imageReuse, 0)
assert.equal(safe.imageUpload, 1)
assert.equal(safe.imageFailed, 0)
assert.equal(uploadCount, safeUploadCount + 1)
assert.deepEqual(callEvents.slice(safePushEventStart), ['upload', 'create'])
assert.equal(
  createCalls[3]?.body._valm_Description,
  `<p><img alt="x" src="${uploadPaths[safeUploadCount]}"></p>`
)
assert.notEqual(createCalls[3]?.body._valm_Description, `<p><img alt="x" src="${safeOriginalPath}"></p>`)
assert.equal(db.getRecord(safeOriginalUid, false)?.pushedUid, 'remote-prop')
assert.equal(
  db.listPushLogs(1, 50).rows.find((row) => row.recordUid === safeOriginalUid)?.remoteUid,
  'remote-prop'
)

fakeClient.baseUrl = 'http://172.1.1.251/alm'
const assertIntranetPathUpload = async (input: {
  uid: string
  projectId: string
  name: string
  originalSource: string
}): Promise<Awaited<ReturnType<PushService['push']>>> => {
  addOriginalSourceRecord(input.uid, `TASK-${input.uid}`, input.name, input.originalSource)
  const eventStart = callEvents.length
  const uploadBefore = uploadCount
  const createBefore = createCount
  const result = await service.push({
    recordUids: [input.uid],
    nodeType: 'Task',
    projectId: input.projectId
  })
  assert.equal(result.total, 1)
  assert.equal(result.requests.length, 1)
  assert.equal(result.requests[0].recordUid, input.uid)
  assert.equal(result.successCount, 1)
  assert.equal(result.failedCount, 0)
  assert.equal(result.imageTotal, 1)
  assert.equal(result.imageReuse, 0)
  assert.equal(result.imageUpload, 1)
  assert.equal(result.imageFailed, 0)
  assert.equal(uploadCount, uploadBefore + 1)
  assert.deepEqual(callEvents.slice(eventStart), ['upload', 'create'])
  assert.equal(createCalls.length, createBefore + 1)
  assert.equal(
    createCalls[createBefore]?.body._valm_Description,
    `<p><img alt="x" src="${uploadPaths[uploadBefore]}"></p>`
  )
  assert.notEqual(
    createCalls[createBefore]?.body._valm_Description,
    `<p><img alt="x" src="${input.originalSource}"></p>`
  )
  assert.equal(db.getRecord(input.uid, false)?.pushedUid, 'remote-prop')
  assert.equal(
    db.listPushLogs(1, 50).rows.find((row) => row.recordUid === input.uid)?.remoteUid,
    'remote-prop'
  )
  return result
}

const intranetRoot = await assertIntranetPathUpload({
  uid: 'push-record-intranet-root',
  projectId: 'target-intranet-root',
  name: 'intranet-root.png',
  originalSource: '/alm/FileCenterImg/Index/intranet-root.png'
})
const intranetRelative = await assertIntranetPathUpload({
  uid: 'push-record-intranet-relative',
  projectId: 'target-intranet-relative',
  name: 'intranet-relative.png',
  originalSource: 'alm/FileCenterImg/Index/intranet-relative.png'
})
const intranetDirectRoot = await assertIntranetPathUpload({
  uid: 'push-record-intranet-direct-root',
  projectId: 'target-intranet-direct-root',
  name: 'direct-root.png',
  originalSource: '/FileCenterImg/Index/direct-root.png'
})

const historicalCacheUid = 'push-record-historical-cache'
const historicalCacheProjectId = 'target-historical-cache'
addOriginalSourceRecord(
  historicalCacheUid,
  `TASK-${historicalCacheUid}`,
  'historical-cache.png',
  '/alm/FileCenterImg/Index/historical-cache.png'
)
db.savePushAssetUpload({
  baseUrl: fakeClient.baseUrl,
  projectId: historicalCacheProjectId,
  sha256: saved.sha256,
  remotePath: 'FileCenterImg/Index/stale-cache.png'
})
const historicalCacheEventStart = callEvents.length
const historicalCacheUploadBefore = uploadCount
const historicalCacheCreateBefore = createCount
const historicalCache = await service.push({
  recordUids: [historicalCacheUid],
  nodeType: 'Task',
  projectId: historicalCacheProjectId
})
assert.equal(historicalCache.total, 1)
assert.equal(historicalCache.requests.length, 1)
assert.equal(historicalCache.requests[0].recordUid, historicalCacheUid)
assert.equal(historicalCache.successCount, 1)
assert.equal(historicalCache.failedCount, 0)
assert.equal(historicalCache.imageTotal, 1)
assert.equal(historicalCache.imageReuse, 0)
assert.equal(historicalCache.imageUpload, 1)
assert.equal(historicalCache.imageFailed, 0)
assert.equal(uploadCount, historicalCacheUploadBefore + 1)
assert.deepEqual(callEvents.slice(historicalCacheEventStart), ['upload', 'create'])
assert.equal(
  createCalls[historicalCacheCreateBefore]?.body._valm_Description,
  `<p><img alt="x" src="${uploadPaths[historicalCacheUploadBefore]}"></p>`
)
assert.notEqual(
  createCalls[historicalCacheCreateBefore]?.body._valm_Description,
  '<p><img alt="x" src="FileCenterImg/Index/stale-cache.png"></p>'
)
assert.equal(
  db.getPushAssetUpload(fakeClient.baseUrl, historicalCacheProjectId, saved.sha256)?.remotePath,
  'FileCenterImg/Index/stale-cache.png'
)
assert.equal(db.getRecord(historicalCacheUid, false)?.pushedUid, 'remote-prop')
assert.equal(
  db.listPushLogs(1, 100).rows.find((row) => row.recordUid === historicalCacheUid)?.remoteUid,
  'remote-prop'
)

const unsafeOriginalSources = [
  {
    uid: 'push-record-other-alm-prefix',
    projectId: 'target-other-alm-prefix',
    name: 'other-alm-prefix.png',
    originalSource: '/other/alm/FileCenterImg/Index/other-alm-prefix.png'
  },
  {
    uid: 'push-record-almish-prefix',
    projectId: 'target-almish-prefix',
    name: 'almish-prefix.png',
    originalSource: '/almish/FileCenterImg/Index/almish-prefix.png'
  },
  {
    uid: 'push-record-path-traversal',
    projectId: 'target-path-traversal',
    name: 'path-traversal.png',
    originalSource: 'FileCenterImg/Index/../escape.png'
  },
  {
    uid: 'push-record-sensitive-query',
    projectId: 'target-sensitive-query',
    name: 'sensitive-query.png',
    originalSource: 'FileCenterImg/Index/eed1399b6cfd45b5.png?ApiToken=secret'
  },
  {
    uid: 'push-record-external-url',
    projectId: 'target-external-url',
    name: 'external-url.png',
    originalSource: 'https://evil.example/FileCenterImg/Index/eed1399b6cfd45b5.png'
  }
] as const
for (const scenario of unsafeOriginalSources) {
  addOriginalSourceRecord(scenario.uid, `TASK-${scenario.uid}`, scenario.name, scenario.originalSource)
  const eventStart = callEvents.length
  const uploadBefore = uploadCount
  const createBefore = createCount
  const result = await service.push({
    recordUids: [scenario.uid],
    nodeType: 'Task',
    projectId: scenario.projectId
  })
  assert.equal(result.total, 1)
  assert.equal(result.requests.length, 1)
  assert.equal(result.requests[0].recordUid, scenario.uid)
  assert.equal(result.imageReuse ?? 0, 0)
  const eventDelta = callEvents.slice(eventStart)
  const uploadWasAttempted = uploadCount > uploadBefore || eventDelta.includes('upload')
  if (result.successCount === 1) {
    assert.equal(result.failedCount, 0)
    assert.equal(uploadWasAttempted, true, `不安全原始图片路径不得直接复用：${scenario.originalSource}`)
    assert.equal(result.imageUpload, 1)
    assert.equal(uploadCount, uploadBefore + 1)
    assert.equal(createCount, createBefore + 1)
    assert.deepEqual(eventDelta, ['upload', 'create'])
    const createdBody = createCalls[createBefore]?.body
    const createdDescription = String(createdBody?._valm_Description ?? '')
    assert.equal(createdDescription, `<p><img alt="x" src="${uploadPaths[uploadBefore]}"></p>`)
    assert.equal(createdDescription.includes(scenario.originalSource), false)
    assert.equal(createdDescription.includes('visslm-asset://'), false)
    assert.equal(db.getRecord(scenario.uid, false)?.pushedUid, 'remote-prop')
  } else {
    assert.equal(result.failedCount, 1)
    assert.equal(createCount, createBefore)
    assert.equal(db.getRecord(scenario.uid, false)?.pushedUid, '')
  }
}

const createCountBeforeFailure = createCount
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
const failedPushEventStart = callEvents.length
const failed = await service.push({ ...config, recordUids: ['push-record-fail'], projectId: 'target-project-fail' })
assert.equal(failed.total, 1)
assert.equal(failed.requests.length, 1)
assert.equal(failed.requests[0].recordUid, 'push-record-fail')
assert.equal(failed.failedCount, 1)
assert.equal(createCount, createCountBeforeFailure)
assert.equal(failed.imageFailed, 1)
assert.deepEqual(callEvents.slice(failedPushEventStart), ['upload'])
assert.equal(db.getRecord('push-record-fail', false)?.pushedUid, '')
assert.equal(
  db.listPushLogs(1, 20).rows.find((row) => row.recordUid === 'push-record-fail')?.status,
  'failed'
)

db.close()
console.log(JSON.stringify({ uploadCount, createCount, preview, pushed, retried, singular, safe, intranetRoot, intranetRelative, intranetDirectRoot, historicalCache, failed }))
