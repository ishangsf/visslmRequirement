import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { AppDatabase } from '../src/main/database'
import { exportVisslmPack, importVisslmPack } from '../src/main/transfer-pack'
import { parseRichImageUploadCallback } from '../src/main/visslm'

const root = mkdtempSync(join(tmpdir(), 'visslm-pack-smoke-'))
const source = new AppDatabase(join(root, 'source.db'), join(root, 'source-assets'))
const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex')
const inlineBytes = Buffer.from('47494638376101000100000000', 'hex')
const inlineDataUri = `data:image/gif;base64,${inlineBytes.toString('base64')}`
const imageUrl = 'https://example.test/assets/a.png'
const description = `<p data-keep="1">前文 <img title='保留' alt="示例" src="${imageUrl}"></p><picture><source srcset="${imageUrl} 1x, ${imageUrl} 2x"><img src="${imageUrl}"></picture><img alt="内嵌" src="${inlineDataUri}">`
source.upsertRecord({
  uid: 'pack-record',
  projectId: 'project-1',
  nodeType: 'Task',
  itemId: 'TASK-PACK-1',
  parentId: '',
  name: '资源包测试',
  lastModifyTime: '2026-08-24T00:00:00.000Z',
  raw: {
    _valm_Uid: 'pack-record',
    _valm_NodeType: 'Task',
    _valm_Name: '资源包测试',
    _valm_ItemID: 'TASK-PACK-1',
    _valm_Description: description
  },
  normalizedText: '前文'
})
source.saveImage({
  recordUid: 'pack-record',
  name: 'a.png',
  mimeType: 'image/png',
  sourceUrl: imageUrl,
  bytes: imageBytes
})
source.saveImage({
  recordUid: 'pack-record',
  name: 'inline.gif',
  mimeType: 'image/gif',
  sourceUrl: 'inline:data-uri',
  bytes: inlineBytes
})

const packPath = join(root, 'transfer.visslmpack')
const exported = await exportVisslmPack(source, packPath)
assert.equal(exported.format, 'visslmpack')
assert.equal(exported.assetCount, 2)
assert.equal(exported.assetBytes, imageBytes.byteLength + inlineBytes.byteLength)
const archive = unzipSync(readFileSync(packPath))
const recordsText = Buffer.from(archive['records.jsonl']).toString('utf8')
assert.equal((recordsText.match(/"assetPath":"assets\//g) ?? []).length, 2)
assert.ok(!recordsText.includes('data:image/'))
assert.ok(!recordsText.includes(inlineBytes.toString('base64')))
assert.ok(recordsText.includes('visslm-asset://'))
assert.ok(recordsText.includes('data-keep=\\"1\\"'))

const target = new AppDatabase(join(root, 'target.db'), join(root, 'target-assets'))
const imported = await importVisslmPack(target, packPath)
assert.equal(imported.ok, true)
assert.equal(imported.assetCount, 2)
assert.equal(imported.checksumVerified, true)
const detail = target.getRecord('pack-record')
assert.ok(detail?.description.includes('visslm-asset://'))
assert.equal(target.listRecordImageReferences('pack-record').length, 5)
assert.deepEqual(target.readAssetBytes(detail?.images[0]?.sha256 ?? ''), imageBytes)
const unresolvedSource = 'https://example.test/assets/missing.png'
target.updateRecordRawAndNormalizedText(
  'pack-record',
  { ...(detail?.raw ?? {}), _valm_Description: `${detail?.description ?? ''}<img src="${unresolvedSource}">` },
  '前文'
)
const unresolved = target.saveUnresolvedImage({
  recordUid: 'pack-record',
  name: '富文本图片',
  sourceUrl: unresolvedSource,
  errorMessage: '模拟下载失败'
})
const unresolvedPackPath = join(root, 'unresolved.visslmpack')
const partialExport = await exportVisslmPack(target, unresolvedPackPath)
assert.equal(partialExport.ok, true)
assert.equal(partialExport.recordCount, 1)
assert.equal(partialExport.assetCount, 2)
assert.equal(partialExport.assetBytes, imageBytes.byteLength + inlineBytes.byteLength)

// An unresolved image is a recoverable export warning.  It must not create an
// asset entry (or an asset token) that the archive cannot satisfy, while the
// record text and all resolved images remain exportable.
const unresolvedArchive = unzipSync(readFileSync(unresolvedPackPath))
const unresolvedRecords = Buffer.from(unresolvedArchive['records.jsonl']).toString('utf8')
const unresolvedRow = JSON.parse(unresolvedRecords.trim()) as {
  title?: string
  content?: string
  raw?: { _valm_Description?: string }
  images?: Array<{ state?: string; sha256?: string; assetPath?: string; assetUrl?: string }>
}
assert.equal(unresolvedRow.title, '资源包测试')
assert.equal(unresolvedRow.content, '前文')
assert.equal(unresolvedRow.images?.filter((image) => image.state === 'unresolved').length ?? 0, 0)
assert.ok(unresolvedRow.images?.some((image) => image.sha256 && image.assetPath?.startsWith('assets/')))
assert.ok(!unresolvedRecords.includes(`assets/${unresolved.sha256}`))
assert.ok(!unresolvedRecords.includes(`visslm-asset://${unresolved.sha256}/`))
assert.ok(!unresolvedRecords.includes(unresolvedSource))
assert.equal(unresolvedArchive[`assets/${unresolved.sha256}`], undefined)

const archiveAssetEntries = new Set(Object.keys(unresolvedArchive).filter((entry) => /^assets\/[a-f0-9]{64}$/i.test(entry)))
for (const image of unresolvedRow.images ?? []) {
  if (image.assetPath) assert.ok(archiveAssetEntries.has(image.assetPath), `缺少图片资源条目：${image.assetPath}`)
}
for (const match of unresolvedRecords.matchAll(/visslm-asset:\/\/([a-f0-9]{64})\//gi)) {
  assert.ok(archiveAssetEntries.has(`assets/${match[1].toLowerCase()}`), `正文引用了缺失图片资源：${match[1]}`)
}

assert.match(partialExport.message, /跳过 1 张无法恢复的图片/)

const partialTarget = new AppDatabase(join(root, 'partial-target.db'), join(root, 'partial-target-assets'))
const partialImported = await importVisslmPack(partialTarget, unresolvedPackPath)
assert.equal(partialImported.ok, true)
assert.equal(partialImported.imageCount, 2)
assert.equal(partialTarget.getRecord('pack-record')?.images.length, 2)
partialTarget.close()

const ckeditorCallback = (value: string, functionNumber = 123, prefix = 'window.parent'): string => (
  `${prefix}.CKEDITOR.tools.callFunction(${functionNumber}, '${value}')`
)

for (const functionNumber of [0, 1, 42, 999]) {
  assert.equal(
    parseRichImageUploadCallback(ckeditorCallback('FileCenterImg/Index/a.png', functionNumber)),
    'FileCenterImg/Index/a.png',
    `任意 CKEditor 回调号都应可解析：${functionNumber}`
  )
}
assert.equal(
  parseRichImageUploadCallback(ckeditorCallback('/FileCenterImg/Index/root-relative.png', 7, 'parent')),
  'FileCenterImg/Index/root-relative.png',
  'window 前缀应可省略，根相对路径应规范化'
)
assert.equal(
  parseRichImageUploadCallback(ckeditorCallback('/app/FileCenterImg/Index/prefixed.png', 8, 'parent')),
  'app/FileCenterImg/Index/prefixed.png',
  '应用前缀的根相对路径应可解析'
)
assert.equal(
  parseRichImageUploadCallback(ckeditorCallback('FileCenterImg/Index/with-query.png?v=1&token=abc', 9)),
  'FileCenterImg/Index/with-query.png?v=1&token=abc',
  '合法 query 应保留'
)
assert.equal(
  parseRichImageUploadCallback(JSON.stringify({ uploaded: 1, url: '/app/FileCenterImg/Index/from-json.png' })),
  'app/FileCenterImg/Index/from-json.png',
  'JSON 上传响应应解析 url'
)

const rejectedUploadResponses = [
  ckeditorCallback('http://evil.test/FileCenterImg/Index/external.png'),
  ckeditorCallback('https://evil.test/FileCenterImg/Index/external.png'),
  ckeditorCallback('//evil.test/FileCenterImg/Index/external.png'),
  ckeditorCallback('FileCenterImg\\Index\\backslash.png'),
  ckeditorCallback(`FileCenterImg/Index/control-${String.fromCharCode(0)}.png`),
  ckeditorCallback('FileCenterImg/Index/../escape.png'),
  ckeditorCallback('OtherCenter/Index/not-an-image.png'),
  JSON.stringify({ uploaded: 0, data: { url: '/FileCenterImg/Index/stale.png' } }),
  ckeditorCallback('/login?returnUrl=%2FFileCenterImg%2FIndex%2Fa.png'),
  '<html><head><title>登录</title></head><body>登录页面</body></html>'
]
for (const response of rejectedUploadResponses) {
  assert.throws(
    () => parseRichImageUploadCallback(response),
    undefined,
    `不合法的图片上传响应应被拒绝：${JSON.stringify(response)}`
  )
}

source.close()
target.close()
console.log(JSON.stringify({ packPath, exported, imported, referenceCount: 5 }))
