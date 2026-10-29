import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../src/main/database'
import { normalizeText, SyncService, type VisslmClient } from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-all-field-image-sync-'))
const database = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))

const allFieldsUid = 'all-field-image-record'
const existingUid = 'existing-legacy-image-record'
const allFieldsItemId = 'TASK-ALL-FIELDS-IMAGE'
const existingItemId = 'TASK-EXISTING-LEGACY-IMAGE'

const sources = {
  description: 'https://image.example.test/description.jpg',
  descriptionNext: 'https://image.example.test/description-next.jpg',
  legacy: 'https://image.example.test/legacy.jpg',
  removed: 'https://image.example.test/removed.jpg',
  nested: 'https://image.example.test/nested.jpg',
  standalone: 'https://image.example.test/standalone.jpg',
  missing: 'https://image.example.test/missing.jpg',
  existingLegacy: 'https://image.example.test/existing-legacy.jpg'
} as const

const jpeg = (marker: number): Buffer => Buffer.from([0xff, 0xd8, 0xff, marker, 0xff, 0xd9])

const bytesBySource = new Map<string, Buffer>([
  [sources.description, jpeg(0x11)],
  [sources.descriptionNext, jpeg(0x12)],
  [sources.legacy, jpeg(0x13)],
  [sources.removed, jpeg(0x14)],
  [sources.nested, jpeg(0x15)],
  [sources.standalone, jpeg(0x16)],
  [sources.existingLegacy, jpeg(0x17)]
])

const shapeValue = {
  filename: 'diagram.png',
  count: 7,
  enabled: true,
  empty: null,
  values: ['diagram.png', 3, null]
}

const firstAllFieldsRaw: Record<string, unknown> = {
  _valm_Uid: allFieldsUid,
  _valm_NodeType: 'Task',
  _valm_ItemID: allFieldsItemId,
  _valm_Name: '全字段图片记录',
  _valm_ProjectId: 'image-project',
  _valm_LastModifyTime: 'v1',
  _valm_Description: `<p>正文 <img src="${sources.description}"><img src="${sources.description}"></p>`,
  LegacyField: `<p>旧字段 <img src="${sources.legacy}"></p>`,
  RemovedField: `<p>待移除 <img src="${sources.removed}"></p>`,
  RichTextField: `<p>扩展字段 <img src="${sources.description}"></p>`,
  Nested: {
    cards: [
      { html: `<p>嵌套 HTML <img src="${sources.nested}"></p>` },
      { source: sources.standalone }
    ],
    responsive: `<picture><source srcset="${sources.nested} 1x, ${sources.standalone} 2x"></picture>`
  },
  MissingField: `<p>缺失图片仍保留 <img src="${sources.missing}"></p>`,
  ShapeField: shapeValue
}

const existingLegacyRaw: Record<string, unknown> = {
  _valm_Uid: existingUid,
  _valm_NodeType: 'Task',
  _valm_ItemID: existingItemId,
  _valm_Name: '已有旧图片记录',
  _valm_ProjectId: 'image-project',
  _valm_LastModifyTime: 'v1',
  LegacyOnly: `<p>已有记录 <img src="${sources.existingLegacy}"></p>`
}

const makeRemoteRecord = (
  uid: string,
  itemId: string,
  name: string,
  raw: Record<string, unknown>
): Record<string, unknown> => ({
  _valm_Uid: uid,
  _valm_NodeType: 'Task',
  _valm_ItemID: itemId,
  _valm_Name: name,
  _valm_ProjectId: 'image-project',
  ...raw
})

const firstRows = [
  firstAllFieldsRaw,
  existingLegacyRaw
]

let queryRows: Array<Record<string, unknown>> = firstRows
const downloadCalls = new Map<string, number>()
const progressEvents: Array<Record<string, unknown>> = []

const client = {
  test: async () => ({ ok: true, message: 'ok' }),
  queryItemsTrace: () => ({
    endpoint: 'https://platform.example.test/rest/items',
    params: { nodeType: 'Task' }
  }),
  queryItems: async () => queryRows,
  getAttachments: async () => [],
  download: async (source: string) => {
    downloadCalls.set(source, (downloadCalls.get(source) ?? 0) + 1)
    if (source === sources.missing) throw new Error('HTTP 404 missing image')
    const bytes = bytesBySource.get(source)
    if (!bytes) throw new Error(`unexpected image source: ${source}`)
    return { bytes, mimeType: 'image/jpeg', sourceUrl: source }
  }
} as unknown as VisslmClient

const config: SyncScopeConfig = {
  selectedTypes: ['Task'],
  rules: [{
    nodeType: 'Task',
    filters: [],
    // The second response intentionally omits fields that must survive the
    // merge, while still returning the fields changed by the platform.
    returnProperty: '_valm_Uid,_valm_NodeType,_valm_ItemID,_valm_Name,_valm_ProjectId,_valm_LastModifyTime,_valm_Description,RemovedField'
  }]
}

const tokenPattern = /visslm-asset:\/\/[a-f0-9]{64}\/[A-Za-z0-9_-]{1,128}/i

const assertTokenized = (value: unknown, source: string): void => {
  assert.equal(typeof value, 'string')
  assert.equal(String(value).includes(source), false, `source should be tokenized: ${source}`)
  assert.match(String(value), tokenPattern)
}

const assertReferenceIdsInRaw = (raw: Record<string, unknown>, ids: string[]): void => {
  const serialized = JSON.stringify(raw)
  for (const id of ids) assert.equal(serialized.includes(id), true, `missing token reference ${id}`)
}

try {
  // Seed a legacy raw image that is unchanged in the first platform response.
  // The sync must still discover and convert it through the existing-record path.
  database.upsertRecord({
    uid: existingUid,
    projectId: 'image-project',
    nodeType: 'Task',
    itemId: existingItemId,
    parentId: '',
    name: '已有旧图片记录',
    lastModifyTime: 'v1',
    raw: existingLegacyRaw,
    normalizedText: normalizeText(existingLegacyRaw)
  })

  const service = new SyncService(database, () => client, (progress) => {
    progressEvents.push(progress as unknown as Record<string, unknown>)
  })

  const firstRun = await service.run(config)
  assert.equal(firstRun.ok, true)
  assert.equal(firstRun.recordCount, 1)
  assert.equal(firstRun.updatedCount, 1)
  assert.equal(firstRun.imageCount, 6)

  for (const source of [
    sources.description,
    sources.legacy,
    sources.removed,
    sources.nested,
    sources.standalone,
    sources.existingLegacy,
    sources.missing
  ]) assert.equal(downloadCalls.get(source), 1, `each distinct source downloads once: ${source}`)
  assert.equal(downloadCalls.size, 7)

  const firstDetail = database.getRecord(allFieldsUid)
  assert(firstDetail)
  assert.equal(firstDetail.images.length, 6)
  assert.equal(firstDetail.images.filter((image) => image.state === 'ready').length, 5)
  assert.equal(firstDetail.images.filter((image) => image.state === 'unresolved').length, 1)
  const unresolved = firstDetail.images.find((image) => image.state === 'unresolved')
  assert(unresolved)
  assert.match(unresolved.sourceUrl, /missing\.jpg/)
  assert.match(unresolved.errorMessage ?? '', /404|下载失败/i)

  assertTokenized(firstDetail.raw._valm_Description, sources.description)
  assertTokenized(firstDetail.raw.LegacyField, sources.legacy)
  assertTokenized(firstDetail.raw.RemovedField, sources.removed)
  assertTokenized(firstDetail.raw.RichTextField, sources.description)
  assert.equal(String(firstDetail.raw.MissingField).includes(sources.missing), true)
  assert.equal(String(firstDetail.raw.MissingField).includes('visslm-asset://'), false)
  assert.deepEqual(firstDetail.raw.ShapeField, shapeValue)

  const nested = firstDetail.raw.Nested as {
    cards: Array<{ html?: unknown; source?: unknown }>
    responsive: unknown
  }
  assertTokenized(nested.cards[0]?.html, sources.nested)
  assertTokenized(nested.cards[1]?.source, sources.standalone)
  assertTokenized(nested.responsive, sources.nested)
  assert.equal(String(nested.responsive).includes(sources.standalone), false)

  const firstRefs = database.listRecordImageReferences(allFieldsUid)
  assert.equal(firstRefs.length, 9)
  assert.equal(new Set(firstRefs.map((reference) => reference.id)).size, firstRefs.length)
  assert.deepEqual(
    firstRefs.filter((reference) => reference.fieldPath === '_valm_Description').map((reference) => reference.ordinal),
    [0, 1]
  )
  assert.equal(firstRefs.filter((reference) => reference.fieldPath === 'RichTextField').length, 1)
  assert.equal(firstRefs.filter((reference) => reference.fieldPath === 'Nested.cards[0].html').length, 1)
  assert.equal(firstRefs.filter((reference) => reference.fieldPath === 'Nested.cards[1].source').length, 1)
  assert.deepEqual(
    firstRefs.filter((reference) => reference.fieldPath === 'Nested.responsive').map((reference) => reference.ordinal),
    [0, 1]
  )
  assertReferenceIdsInRaw(firstDetail.raw, firstRefs.map((reference) => reference.id))

  const existingDetail = database.getRecord(existingUid)
  assert(existingDetail)
  assertTokenized(existingDetail.raw.LegacyOnly, sources.existingLegacy)
  assert.equal(database.listRecordImageReferences(existingUid).length, 1)

  const legacyReference = firstRefs.find((reference) => reference.fieldPath === 'LegacyField')
  const removedReference = firstRefs.find((reference) => reference.fieldPath === 'RemovedField')
  const oldDescriptionReferences = firstRefs.filter((reference) =>
    reference.originalSource === sources.description && reference.fieldPath === '_valm_Description'
  )
  assert(legacyReference)
  assert(removedReference)
  assert.equal(oldDescriptionReferences.length, 2)

  queryRows = [
    makeRemoteRecord(allFieldsUid, allFieldsItemId, '全字段图片记录', {
      _valm_LastModifyTime: 'v2',
      _valm_Description: `<p>更新正文 <img src="${sources.descriptionNext}"></p>`,
      RemovedField: '此字段已改为普通文本'
    }),
    {
      _valm_Uid: existingUid,
      _valm_NodeType: 'Task',
      _valm_ItemID: existingItemId,
      _valm_Name: '已有旧图片记录'
    }
  ]

  const secondRun = await service.run(config)
  assert.equal(secondRun.ok, true)
  assert.equal(secondRun.recordCount, 0)
  assert.equal(secondRun.updatedCount, 1)
  assert.equal(secondRun.imageCount, 1)
  assert.equal(downloadCalls.get(sources.descriptionNext), 1)
  assert.equal(downloadCalls.get(sources.missing), 2)
  assert.equal(downloadCalls.get(sources.legacy), 1)
  assert.equal(downloadCalls.get(sources.existingLegacy), 1)

  const secondDetail = database.getRecord(allFieldsUid)
  assert(secondDetail)
  assertTokenized(secondDetail.raw._valm_Description, sources.descriptionNext)
  assert.equal(String(secondDetail.raw._valm_Description).includes(sources.description), false)
  assert.equal(secondDetail.raw.RemovedField, '此字段已改为普通文本')
  assert.equal(String(secondDetail.raw.MissingField).includes(sources.missing), true)
  assert.deepEqual(secondDetail.raw.ShapeField, shapeValue)
  assert.deepEqual(secondDetail.raw.LegacyField, firstDetail.raw.LegacyField)
  assert.deepEqual(secondDetail.raw.RichTextField, firstDetail.raw.RichTextField)
  assert.deepEqual(secondDetail.raw.Nested, firstDetail.raw.Nested)

  const secondRefs = database.listRecordImageReferences(allFieldsUid)
  assert.equal(secondRefs.some((reference) => reference.id === legacyReference.id), true)
  assert.equal(secondRefs.some((reference) => reference.id === removedReference.id), false)
  for (const reference of oldDescriptionReferences) {
    assert.equal(secondRefs.some((candidate) => candidate.id === reference.id), false)
  }
  assert.equal(secondRefs.some((reference) => reference.fieldPath === 'RichTextField' && reference.originalSource === sources.description), true)
  assert.equal(secondRefs.some((reference) => reference.originalSource === sources.descriptionNext), true)
  assert.equal(secondRefs.some((reference) => reference.fieldPath === 'Nested.cards[0].html'), true)
  assert.equal(secondRefs.some((reference) => reference.fieldPath === 'Nested.cards[1].source'), true)
  assert.equal(secondRefs.some((reference) => reference.fieldPath === 'Nested.responsive' && reference.ordinal === 1), true)
  assert.equal(secondRefs.some((reference) => reference.originalSource === sources.missing), false)

  const existingAfterSecond = database.getRecord(existingUid)
  assert(existingAfterSecond)
  assertTokenized(existingAfterSecond.raw.LegacyOnly, sources.existingLegacy)
  assert.equal(database.listRecordImageReferences(existingUid).length, 1)
  assert.equal(progressEvents.some((event) => event.phase === 'done'), true)

  console.log(JSON.stringify({
    ok: true,
    contract: 'all-field-image-sync-recursive-tokenization',
    firstRun,
    secondRun,
    downloadCalls: Object.fromEntries(downloadCalls),
    firstReferenceCount: firstRefs.length,
    secondReferenceCount: secondRefs.length,
    preservedReference: legacyReference.id,
    removedReference: removedReference.id
  }, null, 2))
} finally {
  database.close()
  rmSync(root, { recursive: true, force: true })
}
