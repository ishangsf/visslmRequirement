import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type ImageAsset } from '../src/main/database'
import { PushService, type VisslmClient } from '../src/main/visslm'
import type { PushConfig, PushResult } from '../src/shared/types'

type MockState = {
  uploadCount: number
  createCount: number
  uploadPaths: string[]
  createdBodies: Array<Record<string, unknown>>
  failUpload?: boolean
  failCreate?: boolean
}

const pushConfig = (recordUid: string, projectId = 'target-push-project'): PushConfig => ({
  recordUids: [recordUid],
  nodeType: 'Task',
  projectId
})

const createMockClient = (state: MockState): VisslmClient => ({
  baseUrl: 'http://example.test',
  createItemEndpoint: () => 'http://example.test/rest/items',
  createItemTraceParams: (params: Record<string, string>) => ({
    ...params,
    user: 'tester',
    ApiToken: '******'
  }),
  uploadRichImage: async () => {
    state.uploadCount += 1
    if (state.failUpload) throw new Error('模拟图片上传失败')
    const remotePath = `FileCenterImg/Index/upload-${state.uploadCount}.png`
    state.uploadPaths.push(remotePath)
    return { remotePath, httpStatus: 200 }
  },
  createItem: async (_params: Record<string, string>, body: Record<string, unknown>) => {
    state.createCount += 1
    state.createdBodies.push(body)
    if (state.failCreate) throw new Error('模拟创建失败')
    return {
      data: { ErrorCode: 0, props: { _valm_Uid: `remote-push-${state.createCount}` } },
      httpStatus: 200
    }
  }
} as unknown as VisslmClient)

const createMockState = (): MockState => ({
  uploadCount: 0,
  createCount: 0,
  uploadPaths: [],
  createdBodies: []
})

const withDatabase = async <T>(worker: (database: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'push-image-preflight-regression-'))
  const database = new AppDatabase(join(directory, 'push-image-preflight.db'), join(directory, 'assets'))
  try {
    return await worker(database)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const recordRaw = (
  uid: string,
  itemId: string,
  name: string,
  fields: Record<string, unknown>
): Record<string, unknown> => ({
  _valm_Uid: uid,
  _valm_NodeType: 'Task',
  _valm_Name: name,
  _valm_ItemID: itemId,
  ...fields
})

const addRecord = (
  database: AppDatabase,
  uid: string,
  itemId: string,
  name: string,
  raw: Record<string, unknown>
): void => {
  database.upsertRecord({
    uid,
    projectId: 'source-push-project',
    nodeType: 'Task',
    itemId,
    parentId: '',
    name,
    lastModifyTime: '2026-09-21T00:00:00.000Z',
    raw,
    normalizedText: name
  })
}

const addImage = (
  database: AppDatabase,
  recordUid: string,
  name: string,
  source: string,
  bytes: string
): ImageAsset => database.saveImage({
  recordUid,
  name,
  mimeType: 'image/png',
  sourceUrl: source,
  bytes: Buffer.from(bytes)
})

const addReference = (
  database: AppDatabase,
  recordUid: string,
  image: ImageAsset,
  fieldPath: string,
  source: string,
  ordinal = 0
): string => {
  const reference = database.saveRecordImageReference({
    recordUid,
    fieldPath,
    ordinal,
    assetSha256: image.sha256,
    sourceType: 'rich-text',
    sourceName: image.name,
    originalSource: source
  })
  return `visslm-asset://${image.sha256}/${reference.id}`
}

const serviceFor = (database: AppDatabase, state: MockState): PushService => (
  new PushService(database, () => createMockClient(state))
)

const imageStats = (result: PushResult): Record<string, number> => ({
  imageTotal: result.imageTotal ?? 0,
  imageUpload: result.imageUpload ?? 0,
  imageReuse: result.imageReuse ?? 0,
  imageFailed: result.imageFailed ?? 0
})

const assertNoUnresolvedImage = (body: Record<string, unknown>, sources: string[]): void => {
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes('visslm-asset://'), false, 'created body must not contain local asset tokens')
  for (const source of sources) {
    assert.equal(serialized.includes(source), false, `created body must not contain unresolved source: ${source}`)
  }
  assert.match(serialized, /图片|图像|未解析|不可用/, 'failed image should become a readable placeholder')
}

const testMixedTokenAndExactRawAliasUsesOneUploadAndOneReuse = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-mixed-alias'
    const originalSource = 'FileCenterImg/Index/mixed-alias.png'
    addRecord(database, recordUid, 'TASK-MIXED', '混合图片别名', recordRaw(recordUid, 'TASK-MIXED', '混合图片别名', {}))
    const image = addImage(database, recordUid, 'mixed-alias.png', originalSource, 'mixed-image-bytes')
    const token = addReference(database, recordUid, image, '_valm_Description', originalSource)
    addReference(database, recordUid, image, 'LegacyImage', originalSource, 0)
    database.updateRecordRawAndNormalizedText(recordUid, recordRaw(recordUid, 'TASK-MIXED', '混合图片别名', {
      _valm_Description: `<p><img alt="token" src="${token}"></p>`,
      LegacyImage: `<p><img alt="raw" src="${originalSource}"></p>`
    }), '混合图片别名')

    const state = createMockState()
    const service = serviceFor(database, state)
    const config = pushConfig(recordUid)
    const preview = service.preview(config)

    assert.deepEqual(imageStats(preview), {
      imageTotal: 2,
      imageUpload: 1,
      imageReuse: 1,
      imageFailed: 0
    }, JSON.stringify(preview, null, 2))
    const previewDescription = String(preview.requests[0]?.body._valm_Description ?? '')
    const previewLegacy = String(preview.requests[0]?.body.LegacyImage ?? '')
    assert.match(previewDescription, /visslm-asset:\/\//)
    assert.match(previewLegacy, /visslm-asset:\/\//)
    assert.equal(previewLegacy.includes(originalSource), false)

    const pushed = await service.push(config)
    assert.deepEqual(imageStats(pushed), imageStats(preview))
    assert.equal(pushed.successCount, 1)
    assert.equal(pushed.failedCount, 0)
    assert.equal(state.uploadCount, 1)
    assert.equal(state.createCount, 1)
    const created = state.createdBodies[0]
    assert.equal(
      created._valm_Description,
      `<p><img alt="token" src="${state.uploadPaths[0]}"></p>`
    )
    assert.equal(
      created.LegacyImage,
      `<p><img alt="raw" src="${state.uploadPaths[0]}"></p>`
    )
  })
}

const testUnboundRawStillCreatesWithPlaceholder = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-unbound-raw'
    const boundSource = 'FileCenterImg/Index/bound.png'
    const unboundSource = 'FileCenterImg/Index/unbound.png?ApiToken=super-secret'
    addRecord(database, recordUid, 'TASK-UNBOUND', '未绑定图片', recordRaw(recordUid, 'TASK-UNBOUND', '未绑定图片', {}))
    const image = addImage(database, recordUid, 'bound.png', boundSource, 'bound-image-bytes')
    const token = addReference(database, recordUid, image, 'BoundImage', boundSource)
    database.updateRecordRawAndNormalizedText(recordUid, recordRaw(recordUid, 'TASK-UNBOUND', '未绑定图片', {
      BoundImage: `<p><img src="${token}"></p>`,
      UnboundImage: `<p><img src="${unboundSource}"></p>`
    }), '未绑定图片')

    const state = createMockState()
    const service = serviceFor(database, state)
    const config = pushConfig(recordUid)
    const preview = service.preview(config)
    assert.deepEqual(imageStats(preview), {
      imageTotal: 2,
      imageUpload: 1,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.equal(preview.requests[0]?.imageErrors?.length, 1)
    const previewError = preview.requests[0]?.imageErrors?.[0] ?? ''
    assert.match(previewError, /字段 UnboundImage，第 1 处图片（src）/)
    assert.match(previewError, /FileCenterImg\/Index\/unbound\.png\?ApiToken=\[已脱敏\]/)
    assert.equal(previewError.includes('super-secret'), false)

    const pushed = await service.push(config)
    assert.equal(pushed.successCount, 1)
    assert.equal(pushed.failedCount, 0)
    assert.deepEqual(imageStats(pushed), {
      imageTotal: 2,
      imageUpload: 1,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.equal(state.uploadCount, 1, 'valid references should still upload')
    assert.equal(state.createCount, 1, 'unresolved references should not block item creation')
    assert.equal(pushed.requests[0]?.imageUpload, 1)
    assert.equal(pushed.requests[0]?.imageFailed, 1)
    assert.equal(pushed.requests[0]?.error, undefined)
    assert.ok((pushed.imageErrors ?? []).some((error) => /字段 UnboundImage，第 1 处图片（src）/.test(error)))
    assert.equal((pushed.imageErrors ?? []).some((error) => error.includes('super-secret')), false)
    const created = state.createdBodies[0]
    assert.equal(created.BoundImage, `<p><img src="${state.uploadPaths[0]}"></p>`)
    assertNoUnresolvedImage(created, [unboundSource])
  })
}

const testNestedSrcsetErrorsIncludePathsAndOccurrences = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-nested-srcset'
    const firstSource = 'FileCenterImg/Index/nested-first.png'
    const secondSource = 'FileCenterImg/Index/nested-second.png'
    addRecord(database, recordUid, 'TASK-NESTED', '嵌套图片', recordRaw(recordUid, 'TASK-NESTED', '嵌套图片', {
      Metadata: {
        Gallery: `<picture><source srcset="${firstSource} 1x, ${secondSource} 2x"></picture>`
      }
    }))

    const state = createMockState()
    const service = serviceFor(database, state)
    const config = pushConfig(recordUid)
    const preview = service.preview(config)
    assert.deepEqual(imageStats(preview), {
      imageTotal: 2,
      imageUpload: 0,
      imageReuse: 0,
      imageFailed: 2
    })
    assert.equal(preview.requests[0]?.imageErrors?.length, 2)
    const previewErrors = preview.requests[0]?.imageErrors ?? []
    assert.ok(previewErrors.some((error) => /字段 Metadata\.Gallery，第 1 处图片（srcset）/.test(error)))
    assert.ok(previewErrors.some((error) => /字段 Metadata\.Gallery，第 2 处图片（srcset）/.test(error)))
    assert.ok(previewErrors.every((error) => error.includes('请重新采集或导入包含图片的资源包')))

    const pushed = await service.push(config)
    assert.deepEqual(imageStats(pushed), imageStats(preview))
    assert.equal(pushed.successCount, 1)
    assert.equal(pushed.failedCount, 0)
    assert.equal(state.uploadCount, 0)
    assert.equal(state.createCount, 1)
    assert.equal(pushed.requests[0]?.error, undefined)
    assertNoUnresolvedImage(state.createdBodies[0], [firstSource, secondSource])
  })
}

const testAmbiguousOriginalSourceDoesNotAutoBind = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-ambiguous-source'
    const originalSource = 'FileCenterImg/Index/ambiguous.png'
    addRecord(database, recordUid, 'TASK-AMBIGUOUS', '歧义图片', recordRaw(recordUid, 'TASK-AMBIGUOUS', '歧义图片', {}))
    const first = addImage(database, recordUid, 'ambiguous-a.png', originalSource, 'ambiguous-image-a')
    const second = addImage(database, recordUid, 'ambiguous-b.png', originalSource, 'ambiguous-image-b')
    addReference(database, recordUid, first, 'FirstImage', originalSource)
    addReference(database, recordUid, second, 'SecondImage', originalSource)
    database.updateRecordRawAndNormalizedText(recordUid, recordRaw(recordUid, 'TASK-AMBIGUOUS', '歧义图片', {
      AmbiguousImage: `<p><img src="${originalSource}"></p>`
    }), '歧义图片')

    const state = createMockState()
    const service = serviceFor(database, state)
    const config = pushConfig(recordUid)
    const preview = service.preview(config)
    assert.deepEqual(imageStats(preview), {
      imageTotal: 1,
      imageUpload: 0,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.match(preview.requests[0]?.imageErrors?.[0] ?? '', /字段 AmbiguousImage，第 1 处图片（src）/)

    const pushed = await service.push(config)
    assert.deepEqual(imageStats(pushed), imageStats(preview))
    assert.equal(state.uploadCount, 0)
    assert.equal(state.createCount, 1)
    assert.equal(pushed.failedCount, 0)
    assert.equal(pushed.requests[0]?.error, undefined)
    assertNoUnresolvedImage(state.createdBodies[0], [originalSource])
  })
}

const testDifferentRecordReferencesAreNeverUsed = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const originalSource = 'FileCenterImg/Index/other-record.png'
    const ownerUid = 'push-reference-owner'
    const otherUid = 'push-reference-other'
    addRecord(database, ownerUid, 'TASK-OWNER', '引用所属记录', recordRaw(ownerUid, 'TASK-OWNER', '引用所属记录', {}))
    const ownerImage = addImage(database, ownerUid, 'owner.png', originalSource, 'owner-image-bytes')
    addReference(database, ownerUid, ownerImage, 'OwnerImage', originalSource)
    database.updateRecordRawAndNormalizedText(ownerUid, recordRaw(ownerUid, 'TASK-OWNER', '引用所属记录', {
      OwnerImage: `<p><img src="visslm-asset://${ownerImage.sha256}/owner-token"></p>`
    }), '引用所属记录')
    addRecord(database, otherUid, 'TASK-OTHER', '其他记录', recordRaw(otherUid, 'TASK-OTHER', '其他记录', {
      OtherImage: `<p><img src="${originalSource}"></p>`
    }))

    const state = createMockState()
    const service = serviceFor(database, state)
    const preview = service.preview(pushConfig(otherUid))
    assert.deepEqual(imageStats(preview), {
      imageTotal: 1,
      imageUpload: 0,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.match(preview.requests[0]?.imageErrors?.[0] ?? '', /字段 OtherImage，第 1 处图片（src）/)

    const pushed = await service.push(pushConfig(otherUid))
    assert.equal(pushed.failedCount, 0)
    assert.equal(state.uploadCount, 0)
    assert.equal(state.createCount, 1)
    assertNoUnresolvedImage(state.createdBodies[0], [originalSource])
  })
}

const testUploadFailureStillCreatesWithPlaceholder = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-upload-failure'
    const originalSource = 'FileCenterImg/Index/upload-failure.png'
    addRecord(database, recordUid, 'TASK-UPLOAD-FAILURE', '上传失败图片', recordRaw(recordUid, 'TASK-UPLOAD-FAILURE', '上传失败图片', {}))
    const image = addImage(database, recordUid, 'upload-failure.png', originalSource, 'upload-failure-image')
    const token = addReference(database, recordUid, image, 'FailureImage', originalSource)
    database.updateRecordRawAndNormalizedText(recordUid, recordRaw(recordUid, 'TASK-UPLOAD-FAILURE', '上传失败图片', {
      FailureImage: `<p><img src="${token}"></p>`
    }), '上传失败图片')

    const state = createMockState()
    state.failUpload = true
    const service = serviceFor(database, state)
    const config = pushConfig(recordUid, 'target-upload-failure')
    const preview = service.preview(config)
    assert.deepEqual(imageStats(preview), {
      imageTotal: 1,
      imageUpload: 1,
      imageReuse: 0,
      imageFailed: 0
    })

    const pushed = await service.push(config)
    assert.deepEqual(imageStats(pushed), {
      imageTotal: 1,
      imageUpload: 0,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.equal(pushed.successCount, 1)
    assert.equal(pushed.failedCount, 0)
    assert.equal(state.uploadCount, 1)
    assert.equal(state.createCount, 1)
    assert.equal(pushed.requests[0]?.error, undefined)
    assert.ok((pushed.imageErrors ?? []).some((error) => error.includes('模拟图片上传失败')))
    assertNoUnresolvedImage(state.createdBodies[0], [originalSource])
  })
}

const testCreateFailureStillFailsRecord = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const recordUid = 'push-create-failure'
    const originalSource = 'FileCenterImg/Index/create-failure.png'
    addRecord(database, recordUid, 'TASK-CREATE-FAILURE', '创建失败图片', recordRaw(recordUid, 'TASK-CREATE-FAILURE', '创建失败图片', {}))
    const image = addImage(database, recordUid, 'create-failure.png', originalSource, 'create-failure-image')
    const token = addReference(database, recordUid, image, 'FailureImage', originalSource)
    database.updateRecordRawAndNormalizedText(recordUid, recordRaw(recordUid, 'TASK-CREATE-FAILURE', '创建失败图片', {
      FailureImage: `<p><img src="${token}"></p>`
    }), '创建失败图片')

    const state = createMockState()
    state.failUpload = true
    state.failCreate = true
    const service = serviceFor(database, state)
    const pushed = await service.push(pushConfig(recordUid, 'target-create-failure'))

    assert.equal(pushed.successCount, 0)
    assert.equal(pushed.failedCount, 1)
    assert.deepEqual(imageStats(pushed), {
      imageTotal: 1,
      imageUpload: 0,
      imageReuse: 0,
      imageFailed: 1
    })
    assert.equal(state.uploadCount, 1)
    assert.equal(state.createCount, 1)
    assert.equal(pushed.requests[0]?.imageFailed, 1)
    assert.equal(pushed.requests[0]?.error, '模拟创建失败')
    assert.ok((pushed.imageErrors ?? []).some((error) => error.includes('模拟图片上传失败')))
    assertNoUnresolvedImage(state.createdBodies[0], [originalSource])
    assert.equal(database.getRecord(recordUid, false)?.pushedUid, '')
    const log = database.listPushLogs(1, 20).rows.find((row) => row.recordUid === recordUid)
    assert.equal(log?.status, 'failed')
    assert.match(log?.errorMessage ?? '', /模拟创建失败/)
  })
}

const main = async (): Promise<void> => {
  await testMixedTokenAndExactRawAliasUsesOneUploadAndOneReuse()
  await testUnboundRawStillCreatesWithPlaceholder()
  await testNestedSrcsetErrorsIncludePathsAndOccurrences()
  await testAmbiguousOriginalSourceDoesNotAutoBind()
  await testDifferentRecordReferencesAreNeverUsed()
  await testUploadFailureStillCreatesWithPlaceholder()
  await testCreateFailureStillFailsRecord()
  console.log(JSON.stringify({
    ok: true,
    contract: 'push-image-preflight-and-source-binding',
    checks: [
      'same-record token and exact raw alias share one upload and one reuse',
      'unbound raw image reports field/source and still creates with a placeholder',
      'nested srcset failures report field paths and occurrences',
      'ambiguous originalSource hashes remain unresolved',
      'image references from another record are never used',
      'upload failures preserve item creation with readable placeholders',
      'create failures remain record failures even when image preparation is best-effort',
      'preview and actual image statistics preserve available-count semantics'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
