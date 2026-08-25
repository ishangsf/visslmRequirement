import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { PushService, type VisslmClient } from '../src/main/visslm'

const directory = mkdtempSync(join(tmpdir(), 'visslm-push-release-filter-'))
const db = new AppDatabase(join(directory, 'data.db'), join(directory, 'assets'))

const addRecord = (
  uid: string,
  name: string,
  lastModifyTime: string,
  raw: Record<string, unknown>
): void => {
  db.upsertRecord({
    uid,
    projectId: 'source-project',
    nodeType: 'Task',
    itemId: uid.toUpperCase(),
    parentId: '',
    name,
    lastModifyTime,
    raw: {
      _valm_Uid: uid,
      _valm_NodeType: 'Task',
      _valm_Name: name,
      ...raw
    },
    normalizedText: `${name} release filter smoke`
  })
}

try {
  addRecord('release-a-1', 'Alpha first', '2026-08-01T00:00:00.000Z', { _valm_Release_text: ' 2026.Q3 ' })
  addRecord('release-a-2', 'Alpha second', '2026-08-02T00:00:00.000Z', { _valm_Release_text: '2026.Q3' })
  addRecord('release-b', 'Beta item', '2026-08-03T00:00:00.000Z', { _valm_Release_text: '2026.Q4' })
  addRecord('release-legacy', 'Legacy only', '2026-08-04T00:00:00.000Z', { _valm_Release: '2026.Q3' })

  assert.deepEqual(db.listRecordReleaseValues(), [
    { value: '2026.Q3', count: 2 },
    { value: '2026.Q4', count: 1 }
  ])

  const q3Page = db.listRecords({ page: 1, pageSize: 20, releaseText: '2026.Q3' })
  assert.equal(q3Page.total, 2)
  assert.deepEqual(q3Page.rows.map((record) => record.uid), ['release-a-2', 'release-a-1'])
  assert.ok(q3Page.rows.every((record) => record.releaseText === '2026.Q3'))
  assert.equal(db.listRecords({ page: 1, pageSize: 20, releaseText: '' }).total, 0)

  const filteredUids = db.listRecordUids({ releaseText: '2026.Q3', search: 'Alpha' })
  assert.deepEqual(filteredUids, ['release-a-2', 'release-a-1'])

  const createdNames: string[] = []
  const fakeClient = {
    baseUrl: 'http://example.test/alm',
    createItemEndpoint: () => 'http://example.test/alm/rest/items',
    createItemTraceParams: (params: Record<string, string>) => ({ ...params, user: 'tester', ApiToken: '******' }),
    createItem: async (_params: Record<string, string>, body: Record<string, unknown>) => {
      createdNames.push(String(body._valm_Name ?? ''))
      return { data: { ErrorCode: 0, props: { _valm_Uid: `remote-${createdNames.length}` } }, httpStatus: 200 }
    }
  } as unknown as VisslmClient

  const pushed = await new PushService(db, () => fakeClient).push({
    recordUids: filteredUids,
    nodeType: 'Task',
    projectId: 'target-project'
  })
  assert.equal(pushed.successCount, 2)
  assert.equal(pushed.failedCount, 0)
  assert.deepEqual(createdNames, ['Alpha second', 'Alpha first'])
  assert.ok(!createdNames.includes('Beta item'))
  assert.ok(!createdNames.includes('Legacy only'))

  const appSource = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  assert.ok(appSource.includes('...(releaseText !== undefined ? { releaseText } : {})'))
  assert.ok(appSource.includes('window.visslm.listRecordUids({'))
  assert.ok(appSource.includes('applyRecordFilter(search, value)'))
  assert.ok(appSource.includes('clearSelection()'))
  assert.ok(appSource.includes("dataIndex: 'releaseText'"))

  console.log(JSON.stringify({
    ok: true,
    releaseValues: db.listRecordReleaseValues(),
    filteredUids,
    pushed: { successCount: pushed.successCount, failedCount: pushed.failedCount }
  }))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
