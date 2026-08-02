import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { SyncService, VisslmClient } from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-itemid-dedup-'))
const db = new AppDatabase(join(root, 'dedup.db'), join(root, 'assets'))

const config: SyncScopeConfig = {
  selectedTypes: ['Task'],
  rules: [{ nodeType: 'Task', filters: [], returnProperty: '_valm_Name' }]
}

let remoteRows = [
  {
    _valm_Uid: 'remote-1',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'ITEM-1',
    _valm_Name: 'Original task'
  },
  {
    _valm_Uid: 'remote-2',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'ITEM-2',
    _valm_Name: 'Second task'
  }
]

const fakeClient = {
  test: async () => ({ ok: true, message: 'ok' }),
  queryItemsTrace: () => ({ endpoint: 'http://example.test/rest/items', params: {} }),
  queryItems: async () => remoteRows,
  getAttachments: async () => [],
  download: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/png', sourceUrl: '' })
} as unknown as VisslmClient

try {
  const service = new SyncService(db, () => fakeClient, () => undefined)
  const first = await service.run(config)
  assert.equal(first.ok, true)
  assert.equal(first.recordCount, 2)
  assert.equal(first.duplicates.length, 0)

  remoteRows = [
    {
      ...remoteRows[0],
      _valm_Name: 'Updated task'
    },
    remoteRows[1],
    {
      _valm_Uid: 'remote-3',
      _valm_NodeType: 'Task',
      _valm_ItemID: 'ITEM-3',
      _valm_Name: 'New task'
    }
  ]
  const second = await service.run(config)
  assert.equal(second.ok, true)
  assert.equal(second.recordCount, 1)
  assert.equal(second.skippedCount, 2)
  assert.equal(second.duplicates.length, 2)
  assert.equal(db.listRecords({ page: 1, pageSize: 20 }).total, 3)

  const syncOverwrite = await service.applyDataReviews(second.reviewBatchId!, second.duplicates.map((item) => item.id))
  assert.equal(syncOverwrite.updatedCount, 2)
  assert.equal(db.getRecord('remote-1')?.name, 'Updated task')

  const imported = db.importRows([{
    documentId: 'Task:import-3',
    title: 'Imported replacement',
    content: 'replacement',
    metadata: {
      recordType: 'Task',
      sourceId: 'import-3',
      itemId: 'ITEM-3'
    },
    raw: {
      _valm_Uid: 'import-3',
      _valm_NodeType: 'Task',
      _valm_ItemID: 'ITEM-3',
      _valm_Name: 'Imported replacement'
    }
  }])
  assert.equal(imported.recordCount, 0)
  assert.equal(imported.duplicates.length, 1)
  const importOverwrite = db.applyImportDataReviews(
    imported.reviewBatchId!,
    imported.duplicates.map((item) => item.id)
  )
  assert.equal(importOverwrite.updatedCount, 1)
  assert.equal(db.findRecordByItemId('ITEM-3')?.name, 'Imported replacement')

  const missingItemId = db.importRows([{
    documentId: 'Task:missing-item-id',
    title: 'Invalid record',
    metadata: { recordType: 'Task', sourceId: 'missing-item-id' },
    raw: { _valm_Uid: 'missing-item-id', _valm_NodeType: 'Task' }
  }])
  assert.equal(missingItemId.recordCount, 0)
  assert(missingItemId.errors.some((error) => error.includes('_valm_ItemID')))

  console.log(JSON.stringify({
    firstRun: first.recordCount,
    skippedOnSecondRun: second.skippedCount,
    syncUpdated: syncOverwrite.updatedCount,
    importUpdated: importOverwrite.updatedCount,
    missingItemIdRejected: missingItemId.recordCount === 0
  }, null, 2))
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
