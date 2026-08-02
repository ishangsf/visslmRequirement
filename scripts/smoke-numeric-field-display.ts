import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { SyncService, VisslmClient } from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-numeric-field-display-'))
const db = new AppDatabase(join(root, 'display.db'), join(root, 'assets'))
const originalFetch = globalThis.fetch
const lookupNames = new Map([
  ['177560', 'V2.00.01.76'],
  ['177561', 'V2.00.01.77'],
  ['42', 'Answer']
])
const lookupRequests: URL[] = []
const userLookupRequests: URL[] = []

const response = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })

try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/ssf/user/getUserByName')) {
      userLookupRequests.push(url)
      const loginName = url.searchParams.get('name') ?? ''
      return response({
        Data: {
          UserName: loginName,
          DisplayName: loginName === 'shunfengzhou' ? '顺丰州' : loginName
        }
      })
    }
    const lookupUid = url.searchParams.get('q._valm_Uid')
    if (lookupUid) {
      lookupRequests.push(url)
      return response({
        ErrorCode: 0,
        propList: [{ _valm_Uid: lookupUid, _valm_Name: lookupNames.get(lookupUid) ?? '' }]
      })
    }
    return response({
      ErrorCode: 0,
      propList: [{
        _valm_Uid: 'remote-1',
        _valm_NodeType: 'Task',
        _valm_ItemID: 'TASK-1',
        _valm_Name: 'Numeric field task',
        _valm_Release: 177560,
        reference: 177560,
        numericString: '42',
        decimal: '42.5',
        nested: { key: '177560' },
        numericArray: [177560, 177561],
        assignee: 'shunfengzhou',
        reviewer: 'shunfengzhou',
        owner: { key: 'shunfengzhou' },
        unconfiguredUser: 'other-user'
      }]
    })
  }

  const client = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: 'test-user',
    token: 'test-token',
    userPropertyKeys: ['assignee', 'reviewer', 'owner']
  })
  const trace = client.queryItemsTrace('Task', [], '_valm_Name')
  assert(trace.params.ReturnProperty.includes('assignee'))
  assert(trace.params.ReturnProperty.includes('reviewer'))
  assert(trace.params.ReturnProperty.includes('owner'))
  const records = await client.queryItems('Task', [], '_valm_Name')
  const raw = records[0]
  assert.equal(raw.reference, 177560)
  assert.equal(raw.reference_text, 'V2.00.01.76')
  assert.equal(raw.numericString_text, 'Answer')
  assert.equal(raw.nested && typeof raw.nested === 'object' && (raw.nested as Record<string, unknown>).key_text, 'V2.00.01.76')
  assert.deepEqual(raw.numericArray_text, ['V2.00.01.76', 'V2.00.01.77'])
  assert.equal(raw.decimal_text, undefined)
  assert.equal(raw.assignee_text, '顺丰州')
  assert.equal(raw.reviewer_text, '顺丰州')
  assert.equal((raw.owner as Record<string, unknown>).key_text, '顺丰州')
  assert.equal(raw.unconfiguredUser_text, undefined)
  assert.equal(lookupRequests.filter((url) => url.searchParams.get('q._valm_Uid') === '177560').length, 1)
  assert(lookupRequests.every((url) => url.searchParams.get('ReturnProperty') === '_valm_Uid,_valm_Name'))
  assert.equal(userLookupRequests.length, 1)
  assert.equal(userLookupRequests[0]?.searchParams.get('name'), 'shunfengzhou')

  const config: SyncScopeConfig = {
    selectedTypes: ['Task'],
    rules: [{ nodeType: 'Task', filters: [], returnProperty: '_valm_Name' }]
  }
  const fakeClient = {
    test: async () => ({ ok: true, message: 'ok' }),
    queryItemsTrace: () => ({ endpoint: 'http://example.test/alm/rest/items', params: {} }),
    queryItems: async () => records,
    getAttachments: async () => [],
    download: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/png', sourceUrl: '' })
  } as unknown as VisslmClient
  const service = new SyncService(db, () => fakeClient, () => undefined)
  const sync = await service.run(config)
  assert.equal(sync.ok, true)
  const stored = db.getRecord('remote-1', false)
  assert.equal(stored?.raw.reference_text, 'V2.00.01.76')
  assert.deepEqual(db.getStats().byRelease, [{ name: 'V2.00.01.76', value: 1 }])
  assert(stored?.normalizedText?.includes('reference_text: V2.00.01.76'))

  console.log(JSON.stringify({
    storedDisplayValue: stored?.raw.reference_text,
    nestedDisplayValue: (stored?.raw.nested as Record<string, unknown>)?.key_text,
    userDisplayValue: stored?.raw.assignee_text,
    lookupCountFor177560: lookupRequests.filter((url) => url.searchParams.get('q._valm_Uid') === '177560').length,
    userLookupCount: userLookupRequests.length,
    decimalSkipped: raw.decimal_text === undefined
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(root, { recursive: true, force: true })
}
