import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, zipSync } from 'fflate'
import { AppDatabase } from '../src/main/database'
import { exportVisslmPack, importVisslmPack } from '../src/main/transfer-pack'

const root = mkdtempSync(join(tmpdir(), 'visslm-all-field-pack-'))
const source = new AppDatabase(join(root, 'source.db'), join(root, 'source-assets'))
const target = new AppDatabase(join(root, 'target.db'), join(root, 'target-assets'))

const pngBytes = (marker: number): Buffer => Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker & 0xff
])
const recordUid = 'all-field-record'
const descriptionSource = 'https://images.example.test/description.png'
const coverSource = 'https://images.example.test/cover.png'
const nestedSource = 'https://images.example.test/nested.png'
const missingSource = 'https://images.example.test/missing.png'
const inlineBytes = pngBytes(4)
const inlineDataUri = `data:image/png;base64,${inlineBytes.toString('base64')}`

const initialRaw = {
  _valm_Uid: recordUid,
  _valm_NodeType: 'Task',
  _valm_Name: '全字段图片资源包',
  _valm_ItemID: 'ITEM-ALL-FIELD',
  _valm_Description: `<p>说明<img src="${descriptionSource}"></p>`,
  CoverImage: coverSource,
  nested: [
    { html: `<p>嵌套<img src="${nestedSource}"></p>`, inline: inlineDataUri }
  ],
  missingHtml: `<p>缺失<img src="${missingSource}"></p>`,
  missingStandalone: missingSource,
  ordinaryText: 'icon.png'
}
source.upsertRecord({
  uid: recordUid,
  projectId: 'project-all-fields',
  nodeType: 'Task',
  itemId: 'ITEM-ALL-FIELD',
  parentId: '',
  name: '全字段图片资源包',
  lastModifyTime: '2026-09-22T00:00:00.000Z',
  raw: initialRaw,
  normalizedText: '全字段图片资源包'
})

const descriptionImage = source.saveImage({
  recordUid,
  name: 'description.png',
  mimeType: 'image/png',
  sourceUrl: descriptionSource,
  bytes: pngBytes(1)
})
const coverImage = source.saveImage({
  recordUid,
  name: 'cover.png',
  mimeType: 'image/png',
  sourceUrl: coverSource,
  bytes: pngBytes(2)
})
const nestedImage = source.saveImage({
  recordUid,
  name: 'nested.png',
  mimeType: 'image/png',
  sourceUrl: nestedSource,
  bytes: pngBytes(3)
})
const inlineImage = source.saveImage({
  recordUid,
  name: 'inline.png',
  mimeType: 'image/png',
  sourceUrl: 'inline:data-uri',
  bytes: inlineBytes
})

// This token represents the collector's standalone-image path. It must keep
// its reference id and field path through export/import.
// Legacy raw HTML/URLs may already have a reference; reuse the exact alias.
const coverReference = source.saveRecordImageReference({
  recordUid,
  fieldPath: 'CoverImage',
  ordinal: 0,
  assetSha256: coverImage.sha256,
  originalSource: coverSource
})
const standaloneReference = source.saveRecordImageReference({
  recordUid,
  fieldPath: 'nested[0].standaloneToken',
  ordinal: 0,
  assetSha256: nestedImage.sha256,
  sourceType: 'rich-text',
  sourceName: nestedImage.name,
  originalSource: nestedSource
})
const standaloneToken = `visslm-asset://${nestedImage.sha256}/${standaloneReference.id}`
source.updateRecordRawAndNormalizedText(
  recordUid,
  {
    ...initialRaw,
    nested: [{ ...initialRaw.nested[0], standaloneToken }]
  },
  '全字段图片资源包'
)

const packPath = join(root, 'all-fields.visslmpack')
const exported = await exportVisslmPack(source, packPath)
assert.equal(exported.ok, true)
assert.equal(exported.recordCount, 1)
assert.equal(exported.assetCount, 4)

const archive = unzipSync(readFileSync(packPath))
const exportedRow = JSON.parse(Buffer.from(archive['records.jsonl']).toString('utf8').trim()) as {
  raw: Record<string, any>
  imageReferences: Array<Record<string, any>>
}
const exportedRaw = exportedRow.raw
assert.match(String(exportedRaw._valm_Description), /visslm-asset:\/\//)
assert.match(String(exportedRaw.CoverImage), /visslm-asset:\/\//)
assert.equal(exportedRaw.CoverImage, `visslm-asset://${coverImage.sha256}/${coverReference.id}`)
assert.match(String(exportedRaw.nested[0].html), /visslm-asset:\/\//)
assert.match(String(exportedRaw.nested[0].inline), /visslm-asset:\/\//)
assert.equal(exportedRaw.nested[0].standaloneToken, standaloneToken)
assert.equal(exportedRaw.ordinaryText, 'icon.png')
assert.equal(String(exportedRaw.missingStandalone), '[图片未能导出]')
assert.doesNotMatch(JSON.stringify(exportedRaw), new RegExp(missingSource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
assert.ok(exportedRow.imageReferences.some((reference) => reference.fieldPath === '_valm_Description'))
assert.ok(exportedRow.imageReferences.some((reference) => reference.fieldPath === 'CoverImage'))
assert.ok(exportedRow.imageReferences.some((reference) => reference.fieldPath === 'nested[0].html'))
assert.ok(exportedRow.imageReferences.some((reference) => reference.fieldPath === 'nested[0].inline'))
assert.ok(exportedRow.imageReferences.some((reference) => reference.fieldPath === 'nested[0].standaloneToken'))

const imported = await importVisslmPack(target, packPath)
assert.equal(imported.ok, true)
const importedDetail = target.getRecord(recordUid)
assert.equal(importedDetail?.raw.CoverImage, exportedRaw.CoverImage)
assert.equal((importedDetail?.raw.nested as any[])[0].standaloneToken, standaloneToken)
assert.equal(importedDetail?.raw.ordinaryText, 'icon.png')
assert.deepEqual(target.readAssetBytes(descriptionImage.sha256), pngBytes(1))
assert.deepEqual(target.readAssetBytes(coverImage.sha256), pngBytes(2))
assert.deepEqual(target.readAssetBytes(nestedImage.sha256), pngBytes(3))
assert.deepEqual(target.readAssetBytes(inlineImage.sha256), inlineBytes)
const importedPaths = new Set(target.listRecordImageReferences(recordUid).map((reference) => reference.fieldPath))
assert.ok(importedPaths.has('CoverImage'))
assert.ok(importedPaths.has('nested[0].html'))
assert.ok(importedPaths.has('nested[0].standaloneToken'))

// A v1 pack written before all-field image tokenization may still contain a
// plain image URL in a non-description field. It remains import-compatible so
// importing a historical record never discards its text.
const legacyRow = {
  documentId: 'Task:legacy-non-description',
  title: '历史非描述字段',
  content: '历史文本',
  metadata: {
    projectId: 'project-legacy',
    recordType: 'Task',
    sourceId: 'legacy-non-description',
    itemId: 'ITEM-LEGACY-NON-DESCRIPTION',
    updatedAt: '2026-09-22T00:00:00.000Z'
  },
  raw: {
    _valm_Uid: 'legacy-non-description',
    _valm_NodeType: 'Task',
    _valm_Name: '历史非描述字段',
    _valm_ItemID: 'ITEM-LEGACY-NON-DESCRIPTION',
    legacyImageField: 'https://legacy.example.test/old.png',
    preservedText: '缺失图片也不应丢掉这条记录'
  },
  images: [],
  imageReferences: []
}
const legacyRecords = Buffer.from(`${JSON.stringify(legacyRow)}\n`, 'utf8')
const legacyManifest = Buffer.from(`${JSON.stringify({
  format: 'visslm-transfer',
  version: 1,
  createdAt: new Date().toISOString(),
  recordCount: 1,
  assetCount: 0,
  assetBytes: 0,
  entries: { records: 'records.jsonl', assets: 'assets/', checksums: 'checksums.jsonl' }
}, null, 2)}\n`, 'utf8')
const legacyChecksums = Buffer.from([
  JSON.stringify({ path: 'records.jsonl', sha256: createHash('sha256').update(legacyRecords).digest('hex'), byteSize: legacyRecords.byteLength }),
  JSON.stringify({ path: 'manifest.json', sha256: createHash('sha256').update(legacyManifest).digest('hex'), byteSize: legacyManifest.byteLength })
].join('\n') + '\n', 'utf8')
const legacyPackPath = join(root, 'legacy.visslmpack')
writeFileSync(legacyPackPath, Buffer.from(zipSync({
  'records.jsonl': legacyRecords,
  'manifest.json': legacyManifest,
  'checksums.jsonl': legacyChecksums
})))
const legacyImported = await importVisslmPack(target, legacyPackPath)
assert.equal(legacyImported.ok, true)
assert.equal(
  target.getRecord('legacy-non-description')?.raw.legacyImageField,
  'https://legacy.example.test/old.png'
)
assert.equal(
  target.getRecord('legacy-non-description')?.raw.preservedText,
  '缺失图片也不应丢掉这条记录'
)

source.close()
target.close()
console.log(JSON.stringify({
  exported,
  imported,
  legacyImported,
  referencePaths: [...importedPaths]
}))
