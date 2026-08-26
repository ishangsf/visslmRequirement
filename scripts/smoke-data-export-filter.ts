import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { AppDatabase } from '../src/main/database'
import { exportVisslmPack, importVisslmPack } from '../src/main/transfer-pack'
import type { RecordExportQuery } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-data-export-filter-smoke-'))
const database = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))

type Fixture = {
  uid: string
  projectId: string
  nodeType: string
  releaseText: string
  searchable: boolean
  name: string
}

const fixtures: Fixture[] = []
const addFixtures = (count: number, prefix: string, input: Omit<Fixture, 'uid' | 'name'>): void => {
  for (let index = 0; index < count; index += 1) {
    fixtures.push({
      ...input,
      uid: `${prefix}-${index}`,
      name: `${prefix} ${index}`
    })
  }
}

// The primary asset-center result is intentionally 48 records, matching the
// large-page scenario. Other groups prove that every filter dimension is
// applied together rather than only filtering the visible page.
addFixtures(48, 'snapshot-match', {
  projectId: 'project-alpha',
  nodeType: 'Task',
  releaseText: '2026.Q3',
  searchable: true
})
addFixtures(4, 'snapshot-old-release', {
  projectId: 'project-alpha',
  nodeType: 'Task',
  releaseText: '2026.Q2',
  searchable: true
})
addFixtures(3, 'snapshot-other-type', {
  projectId: 'project-alpha',
  nodeType: 'Bug',
  releaseText: '2026.Q3',
  searchable: true
})
addFixtures(3, 'snapshot-other-project', {
  projectId: 'project-beta',
  nodeType: 'Task',
  releaseText: '2026.Q3',
  searchable: true
})
addFixtures(2, 'other-text', {
  projectId: 'project-alpha',
  nodeType: 'Task',
  releaseText: '2026.Q3',
  searchable: false
})
addFixtures(2, 'unrelated', {
  projectId: 'project-beta',
  nodeType: 'Bug',
  releaseText: '2026.Q1',
  searchable: false
})
addFixtures(2, 'empty-release', {
  projectId: 'project-alpha',
  nodeType: 'Task',
  releaseText: '',
  searchable: false
})

const imageBytes = (marker: number): Buffer => Buffer.from([0xff, 0xd8, 0xff, marker & 0xff, 0xff, 0xd9])
const imageShaByUid = new Map<string, string>()
for (const fixture of fixtures) {
  const description = fixture.searchable
    ? `资产中心 searchable snapshot 文本 ${fixture.uid}`
    : `资产中心其他文本 ${fixture.uid}`
  const raw = {
    _valm_Uid: fixture.uid,
    _valm_NodeType: fixture.nodeType,
    _valm_Name: fixture.name,
    _valm_ItemID: `ITEM-${fixture.uid}`,
    _valm_ProjectId: fixture.projectId,
    _valm_Release_text: fixture.releaseText,
    _valm_LastModifyTime: '2026-08-25T00:00:00.000Z',
    _valm_Description: description
  }
  database.upsertRecord({
    uid: fixture.uid,
    projectId: fixture.projectId,
    nodeType: fixture.nodeType,
    itemId: `ITEM-${fixture.uid}`,
    parentId: '',
    name: fixture.name,
    lastModifyTime: '2026-08-25T00:00:00.000Z',
    raw,
    normalizedText: description
  })
}

const matchingImage = database.saveImage({
  recordUid: 'snapshot-match-0',
  name: 'matching.jpg',
  mimeType: 'image/jpeg',
  sourceUrl: 'https://assets.example.test/matching.jpg',
  bytes: imageBytes(1)
})
imageShaByUid.set('snapshot-match-0', matchingImage.sha256)
const nonMatchingImage = database.saveImage({
  recordUid: 'snapshot-old-release-0',
  name: 'non-matching.jpg',
  mimeType: 'image/jpeg',
  sourceUrl: 'https://assets.example.test/non-matching.jpg',
  bytes: imageBytes(2)
})
imageShaByUid.set('snapshot-old-release-0', nonMatchingImage.sha256)

// A corrupt ready row should be skipped without dropping its otherwise
// matching record or the valid image in that record.
database.saveImage({
  recordUid: 'snapshot-match-0',
  name: 'corrupt.jpg',
  mimeType: 'image/jpeg',
  sourceUrl: 'https://assets.example.test/corrupt.jpg',
  bytes: Buffer.from('not-a-jpeg')
})

const readPack = (path: string): {
  archive: Record<string, Uint8Array>
  rows: Array<Record<string, any>>
  manifest: Record<string, any>
} => {
  const archive = unzipSync(readFileSync(path)) as Record<string, Uint8Array>
  const recordsText = Buffer.from(archive['records.jsonl'] ?? []).toString('utf8')
  const rows = recordsText.trim()
    ? recordsText.trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, any>)
    : []
  const manifest = JSON.parse(Buffer.from(archive['manifest.json'] ?? []).toString('utf8')) as Record<string, any>
  return { archive, rows, manifest }
}

const exportForQuery = async (query: RecordExportQuery | undefined, path: string) => {
  const recordUids = query ? new Set(database.listRecordUids(query)) : undefined
  return exportVisslmPack(database, path, recordUids)
}

try {
  const matchingQuery: RecordExportQuery = {
    projectId: 'project-alpha',
    nodeType: 'Task',
    releaseText: '2026.Q3',
    search: 'snapshot'
  }
  const matchingUids = database.listRecordUids(matchingQuery)
  assert.equal(matchingUids.length, 48)
  assert.deepEqual(
    new Set(database.listRecordUids({ ...matchingQuery, page: 1, pageSize: 1 } as any)),
    new Set(matchingUids),
    '导出筛选 UID 解析不应受 pageSize 影响'
  )
  assert.deepEqual(
    new Set(database.listRecordUids({ ...matchingQuery, page: 3, pageSize: 200 } as any)),
    new Set(matchingUids),
    '导出筛选 UID 解析不应读取分页窗口'
  )

  const filteredPath = join(root, 'filtered.visslmpack')
  const filtered = await exportForQuery(matchingQuery, filteredPath)
  assert.equal(filtered.ok, true)
  assert.equal(filtered.recordCount, 48)
  assert.equal(filtered.assetCount, 1)
  assert.match(filtered.message, /跳过 1 张无法恢复的图片/)
  const filteredPack = readPack(filteredPath)
  assert.equal(filteredPack.manifest.recordCount, 48)
  assert.equal(filteredPack.manifest.assetCount, 1)
  assert.equal(filteredPack.rows.length, 48)
  assert.ok(filteredPack.rows.every((row) => matchingUids.includes(String(row.metadata?.sourceId))))
  const filteredAssets = Object.keys(filteredPack.archive).filter((entry) => /^assets\/[a-f0-9]{64}$/i.test(entry))
  assert.deepEqual(filteredAssets, [`assets/${matchingImage.sha256}`])
  assert.deepEqual(
    Buffer.from(filteredPack.archive[`assets/${matchingImage.sha256}`] ?? []),
    imageBytes(1)
  )
  assert.ok(filteredPack.rows.some((row) => row.images?.some((image: any) => image.sha256 === matchingImage.sha256)))
  assert.ok(!filteredPack.rows.some((row) => row.images?.some((image: any) => image.sha256 === nonMatchingImage.sha256)))

  // No filter remains a backwards-compatible full-library export.
  const allPath = join(root, 'all.visslmpack')
  const all = await exportForQuery(undefined, allPath)
  assert.equal(all.ok, true)
  assert.equal(all.recordCount, fixtures.length)
  const allPack = readPack(allPath)
  assert.equal(allPack.rows.length, fixtures.length)
  assert.ok(allPack.rows.every((row) => fixtures.some((fixture) => fixture.uid === row.metadata?.sourceId)))
  assert.ok(Object.prototype.hasOwnProperty.call(allPack.archive, `assets/${matchingImage.sha256}`))
  assert.ok(Object.prototype.hasOwnProperty.call(allPack.archive, `assets/${nonMatchingImage.sha256}`))

  // Empty release is an explicit filter value, not the same as omitting the
  // release filter. This guards the asset-center “（空值）” option.
  const emptyReleasePath = join(root, 'empty-release.visslmpack')
  const emptyReleaseQuery: RecordExportQuery = { releaseText: '' }
  const emptyReleaseUids = database.listRecordUids(emptyReleaseQuery)
  assert.equal(emptyReleaseUids.length, 2)
  const emptyRelease = await exportForQuery(emptyReleaseQuery, emptyReleasePath)
  assert.equal(emptyRelease.recordCount, 2)
  assert.deepEqual(
    new Set(readPack(emptyReleasePath).rows.map((row) => String(row.metadata?.sourceId))),
    new Set(emptyReleaseUids)
  )

  // An empty filtered UID set still produces a valid, importable resource pack.
  const emptyQuery: RecordExportQuery = { projectId: 'project-does-not-exist' }
  assert.deepEqual(database.listRecordUids(emptyQuery), [])
  const emptyPath = join(root, 'empty.visslmpack')
  const empty = await exportForQuery(emptyQuery, emptyPath)
  assert.equal(empty.ok, true)
  assert.equal(empty.recordCount, 0)
  assert.equal(empty.assetCount, 0)
  const emptyPack = readPack(emptyPath)
  assert.equal(emptyPack.rows.length, 0)
  assert.equal(emptyPack.manifest.recordCount, 0)
  assert.equal(emptyPack.manifest.assetCount, 0)
  const emptyTarget = new AppDatabase(join(root, 'empty-target.db'), join(root, 'empty-target-assets'))
  const importedEmpty = await importVisslmPack(emptyTarget, emptyPath)
  assert.equal(importedEmpty.ok, true)
  assert.equal(importedEmpty.recordCount, 0)
  assert.equal(importedEmpty.assetCount, 0)
  assert.equal(importedEmpty.checksumVerified, true)
  emptyTarget.close()

  console.log(JSON.stringify({
    totalRecords: fixtures.length,
    matchingRecords: matchingUids.length,
    filtered,
    all,
    empty,
    filteredAssets,
    imageShaByUid: Object.fromEntries(imageShaByUid)
  }, null, 2))
} finally {
  database.close()
}
