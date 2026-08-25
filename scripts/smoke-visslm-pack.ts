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
target.saveUnresolvedImage({
  recordUid: 'pack-record',
  name: '富文本图片',
  sourceUrl: 'https://example.test/assets/missing.png',
  errorMessage: '模拟下载失败'
})
await assert.rejects(
  () => exportVisslmPack(target, join(root, 'unresolved.visslmpack')),
  /未解析图片/
)

assert.equal(
  parseRichImageUploadCallback(`<script>window.parent.CKEDITOR.tools.callFunction(0, 'FileCenterImg/Index/a.png');</script>`),
  'FileCenterImg/Index/a.png'
)
assert.throws(() => parseRichImageUploadCallback(
  `window.parent.CKEDITOR.tools.callFunction(1, 'FileCenterImg/Index/a.png')`
))
assert.throws(() => parseRichImageUploadCallback(
  `window.parent.CKEDITOR.tools.callFunction(0, 'https://evil.test/a.png')`
))

source.close()
target.close()
console.log(JSON.stringify({ packPath, exported, imported, referenceCount: 5 }))
