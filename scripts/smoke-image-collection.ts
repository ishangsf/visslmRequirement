import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { SyncService, VisslmClient } from '../src/main/visslm'

const root = mkdtempSync(join(tmpdir(), 'visslm-image-collection-smoke-'))
const database = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))

const baseUrl = 'https://alm.example.test'
const credentials = {
  baseUrl,
  username: 'smoke-user',
  token: 'ApiToken-should-never-appear'
}
const retrySource = 'https://image.example.test/retry.jpg'
const invalidSource = 'https://image.example.test/invalid.jpg'
const forbiddenSource = 'https://image.example.test/forbidden.jpg'
const validSource = 'https://image.example.test/valid.jpg'
const trailingJpegSource = 'https://image.example.test/181999.jpg'
const missingEoiSource = 'https://image.example.test/missing-eoi.jpg'
const excessiveTrailingSource = 'https://image.example.test/excessive-trailing.jpg'
const htmlDisguisedSource = 'https://image.example.test/html-disguised.jpg'
const invalidBody = Buffer.from('not-a-jpeg ApiToken=source-api-token UToken=source-u-token')
const validJpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9])
const MAX_JPEG_TRAILING_BYTES = 64 * 1024

const makeJpegFixture = (length: number, trailingBytes: number, includeEoi = true): Buffer => {
  const bytes = Buffer.alloc(length, 0)
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x02, 0x00,
    0x00, 0x01, 0x00, 0x01, 0x00
  ]).copy(bytes)
  if (includeEoi) {
    const eoiOffset = length - trailingBytes - 2
    assert.ok(eoiOffset >= 19 && eoiOffset + 2 <= length)
    bytes[eoiOffset] = 0xff
    bytes[eoiOffset + 1] = 0xd9
  }
  return bytes
}

// Evidence fixture: UID 181999 is a 236,559-byte JFIF JPEG whose decoder
// accepts 24 bytes after EOI (the strict last-two-byte check rejected it).
const trailingJpeg = makeJpegFixture(236_559, 24)
assert.equal(trailingJpeg.byteLength, 236_559)
assert.deepEqual(trailingJpeg.subarray(-26, -24), Buffer.from([0xff, 0xd9]))
assert.equal(trailingJpeg.subarray(-24).byteLength, 24)
const missingEoiJpeg = makeJpegFixture(1_024, 0, false)
const excessiveTrailingJpeg = makeJpegFixture(19 + 2 + MAX_JPEG_TRAILING_BYTES + 1, MAX_JPEG_TRAILING_BYTES + 1)
const disguisedHtml = Buffer.from('<!doctype html><html><body>not an image</body></html>')

const recordsForRun = (retryVersion = 'v1') => [
  {
    _valm_Uid: 'retry-record',
    _valm_NodeType: 'Task',
    _valm_Name: '重试图片记录',
    _valm_ItemID: 'TASK-IMAGE-RETRY',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>重试正文<img src="${retrySource}"></p>`
  },
  {
    _valm_Uid: 'invalid-record',
    _valm_NodeType: 'Task',
    _valm_Name: '无效图片记录',
    _valm_ItemID: 'TASK-IMAGE-INVALID',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>文本必须保留<img src="${invalidSource}"></p>`
  },
  {
    _valm_Uid: 'forbidden-record',
    _valm_NodeType: 'Task',
    _valm_Name: '权限失败记录',
    _valm_ItemID: 'TASK-IMAGE-FORBIDDEN',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>权限失败不应阻断记录<img src="${forbiddenSource}"></p>`
  },
  {
    _valm_Uid: 'valid-record',
    _valm_NodeType: 'Task',
    _valm_Name: '有效图片记录',
    _valm_ItemID: 'TASK-IMAGE-VALID',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>有效图片<img src="${validSource}"></p>`
  },
  {
    _valm_Uid: 'trailing-jpeg-record',
    _valm_NodeType: 'Task',
    _valm_Name: 'EOI 后有尾随字节的 JPEG',
    _valm_ItemID: 'TASK-IMAGE-TRAILING-JPEG',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>真实 JPEG<img src="${trailingJpegSource}"></p>`
  },
  {
    _valm_Uid: 'missing-eoi-record',
    _valm_NodeType: 'Task',
    _valm_Name: '缺失 EOI 的 JPEG',
    _valm_ItemID: 'TASK-IMAGE-MISSING-EOI',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>缺失 EOI<img src="${missingEoiSource}"></p>`
  },
  {
    _valm_Uid: 'excessive-trailing-record',
    _valm_NodeType: 'Task',
    _valm_Name: '尾随字节超阈值的 JPEG',
    _valm_ItemID: 'TASK-IMAGE-EXCESSIVE-TRAILING',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>尾随字节超阈值<img src="${excessiveTrailingSource}"></p>`
  },
  {
    _valm_Uid: 'html-disguised-record',
    _valm_NodeType: 'Task',
    _valm_Name: '伪装 HTML 图片',
    _valm_ItemID: 'TASK-IMAGE-HTML-DISGUISED',
    _valm_ProjectId: 'project-1',
    _valm_LastModifyTime: retryVersion,
    _valm_Description: `<p>伪装 HTML<img src="${htmlDisguisedSource}"></p>`
  }
]

let queryRecords = recordsForRun()
const downloadCalls = new Map<string, number>()
const responseQueues = new Map<string, Array<Response>>([
  [retrySource, [
    new Response(invalidBody, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(invalidBody, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(validJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [invalidSource, [
    new Response(invalidBody, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(invalidBody, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(invalidBody, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [forbiddenSource, [
    new Response('AUTH-RESPONSE-BODY-MUST-NOT-LEAK', {
      status: 403,
      headers: { 'content-type': 'text/html' }
    })
  ]],
  [validSource, [
    new Response(validJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [trailingJpegSource, [
    new Response(trailingJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [missingEoiSource, [
    new Response(missingEoiJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(missingEoiJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(missingEoiJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [excessiveTrailingSource, [
    new Response(excessiveTrailingJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(excessiveTrailingJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(excessiveTrailingJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]],
  [htmlDisguisedSource, [
    new Response(disguisedHtml, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(disguisedHtml, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    new Response(disguisedHtml, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  ]]
])

const originalFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
  if (url.origin === baseUrl && url.pathname === '/rest/application/Version') {
    return new Response(JSON.stringify({ ErrorCode: 0, Version: 'smoke' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  if (url.origin === baseUrl && url.pathname === '/rest/application/DBVersion') {
    return new Response(JSON.stringify({ ErrorCode: 0, DBVersion: 'smoke' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  if (url.origin === baseUrl && url.pathname === '/Admin/Virtualization_ReadMember') {
    return new Response(JSON.stringify({ ErrorCode: 0, propList: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  if (url.origin === baseUrl && url.pathname === '/rest/items') {
    return new Response(JSON.stringify({ ErrorCode: 0, propList: queryRecords }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  const source = [...responseQueues.keys()].find((candidate) => {
    const candidateUrl = new URL(candidate)
    return candidateUrl.origin === url.origin && candidateUrl.pathname === url.pathname
  })
  if (source) {
    downloadCalls.set(source, (downloadCalls.get(source) ?? 0) + 1)
    const queue = responseQueues.get(source) as Response[]
    const response = queue.shift()
    if (!response) throw new Error(`mock 图片响应耗尽：${source}`)
    return response
  }
  throw new Error(`mock 未处理请求：${url}`)
}) as typeof fetch

const config = {
  selectedTypes: ['Task'],
  rules: [{ nodeType: 'Task', filters: [] }]
}
const progress = (): void => {}
const client = new VisslmClient(credentials)
const service = new SyncService(database, () => client, progress)

try {
  const firstRun = await service.run(config)
  assert.equal(firstRun.ok, true)
  assert.equal(firstRun.recordCount, 8)
  assert.equal(database.getRecord('invalid-record')?.description.includes('文本必须保留'), true)
  assert.equal(database.getRecord('forbidden-record')?.description.includes('权限失败不应阻断记录'), true)

  // Two HTTP 200 responses with an image/jpeg header but invalid bytes are
  // retried; the subsequent valid JPEG is stored as ready.
  assert.equal(downloadCalls.get(retrySource), 3)
  const retryImage = database.getRecord('retry-record')?.images ?? []
  assert.equal(retryImage.length, 1)
  assert.equal(retryImage[0]?.state, 'ready')
  assert.deepEqual(database.readAssetBytes(retryImage[0]?.sha256 ?? ''), validJpeg)

  // A permanently invalid payload is retained as one unresolved row, while
  // its record survives and its diagnostic is bounded/sanitized.
  assert.equal(downloadCalls.get(invalidSource), 3)
  const invalidImages = database.getRecord('invalid-record')?.images ?? []
  assert.equal(invalidImages.length, 1)
  assert.equal(invalidImages[0]?.state, 'unresolved')
  const invalidError = invalidImages[0]?.errorMessage ?? ''
  assert.match(invalidError, /200/)
  assert.match(invalidError, /image\/jpeg/i)
  assert.match(invalidError, new RegExp(String(invalidBody.byteLength)))
  assert.match(invalidError, new RegExp(invalidBody.subarray(0, 16).toString('hex')))
  assert.doesNotMatch(invalidError, /ApiToken|UToken|source-api-token|source-u-token/i)
  assert.doesNotMatch(invalidError, /AUTH-RESPONSE-BODY-MUST-NOT-LEAK|not-a-jpeg/i)

  // Authentication/authorization failures are permanent for this download;
  // they must not trigger content-level retries.
  assert.equal(downloadCalls.get(forbiddenSource), 1)
  const forbiddenImage = database.getRecord('forbidden-record')?.images ?? []
  assert.equal(forbiddenImage.length, 1)
  assert.equal(forbiddenImage[0]?.state, 'unresolved')
  assert.doesNotMatch(forbiddenImage[0]?.errorMessage ?? '', /AUTH-RESPONSE-BODY-MUST-NOT-LEAK/i)

  // Existing valid image collection remains healthy.
  const validImage = database.getRecord('valid-record')?.images ?? []
  assert.equal(validImage.length, 1)
  assert.equal(validImage[0]?.state, 'ready')
  assert.deepEqual(database.readAssetBytes(validImage[0]?.sha256 ?? ''), validJpeg)

  // UID 181999's JPEG is a valid JFIF payload even though 24 bytes follow its
  // EOI marker. The collector must preserve it as a ready asset after one
  // request instead of treating the trailing bytes as corruption.
  assert.equal(downloadCalls.get(trailingJpegSource), 1)
  const trailingImage = database.getRecord('trailing-jpeg-record')?.images ?? []
  assert.equal(trailingImage.length, 1)
  assert.equal(trailingImage[0]?.state, 'ready')
  assert.equal(trailingImage[0]?.byteSize, trailingJpeg.byteLength)
  assert.deepEqual(database.readAssetBytes(trailingImage[0]?.sha256 ?? ''), trailingJpeg)

  const assertUnresolvedAfterRetries = (source: string, recordUid: string): string => {
    assert.equal(downloadCalls.get(source), 3, `图片内容校验失败时应重试三次：${source}`)
    const images = database.getRecord(recordUid)?.images ?? []
    assert.equal(images.length, 1)
    assert.equal(images[0]?.state, 'unresolved')
    return images[0]?.errorMessage ?? ''
  }
  assertUnresolvedAfterRetries(missingEoiSource, 'missing-eoi-record')
  assertUnresolvedAfterRetries(excessiveTrailingSource, 'excessive-trailing-record')
  const htmlError = assertUnresolvedAfterRetries(htmlDisguisedSource, 'html-disguised-record')
  assert.match(htmlError, /image\/jpeg/i)
  assert.doesNotMatch(htmlError, /<!doctype|<html|not an image/i)

  // A later successful sync for the same source removes the old unresolved
  // marker before saving the ready asset; it must not leave two image rows.
  responseQueues.get(invalidSource)?.push(
    new Response(validJpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } })
  )
  queryRecords = [recordsForRun('v2')[1]]
  const secondRun = await service.run(config)
  assert.equal(secondRun.ok, true)
  assert.equal(secondRun.updatedCount, 1)
  const recoveredImages = database.getRecord('invalid-record')?.images ?? []
  assert.equal(recoveredImages.length, 1)
  assert.equal(recoveredImages[0]?.state, 'ready')
  assert.deepEqual(database.readAssetBytes(recoveredImages[0]?.sha256 ?? ''), validJpeg)

  console.log(JSON.stringify({
    firstRun,
    secondRun,
    attempts: Object.fromEntries(downloadCalls),
    unresolvedError: invalidError,
    retryImageCount: recoveredImages.length,
    validImageCount: validImage.length
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  database.close()
}
