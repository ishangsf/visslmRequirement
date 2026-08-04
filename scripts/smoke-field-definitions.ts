import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import {
  normalizeText,
  parseFieldDefinitions,
  SyncService,
  VisslmClient
} from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-field-definitions-'))
const db = new AppDatabase(join(root, 'fields.db'), join(root, 'assets'))
const originalFetch = globalThis.fetch
const fieldRequests: URL[] = []
let sourceDisplayName = '来源'

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
})

const fieldDefinitionResponse = (): Record<string, unknown> => ({
  ErrorCode: 0,
  Data: {
    _valm_NodeType: 'Task',
    members: [
      {
        _valm_NodeType: 'Task',
        _valm_MemberName: 'Source',
        _valm_DisplayName: sourceDisplayName
      },
      {
        _valm_NodeType: 'Task',
        _valm_FieldName: 'State',
        _valm_Label: '状态'
      }
    ],
    fields: {
      Owner: { displayName: '负责人' }
    }
  }
})

const config: SyncScopeConfig = {
  selectedTypes: ['Task'],
  rules: [{ nodeType: 'Task', filters: [], returnProperty: 'Source,State,Owner' }]
}

let remoteRows = [{
  _valm_Uid: 'task-1',
  _valm_NodeType: 'Task',
  _valm_ItemID: 'TASK-1',
  _valm_Name: 'Collected task',
  Source: 'Customer',
  State: 'Open',
  Owner: 'Alice'
}]

try {
  const parsed = parseFieldDefinitions({
    Data: [
      { _valm_NodeType: 'SoftwareRequirement', prop: {
        _valm_FieldName: 'RequirementTitle',
        _valm_DisplayText: '需求标题'
      } },
      { _valm_NodeType: 'OtherType', fields: { Priority: '优先级' } }
    ]
  }, 'RequestedType')
  assert.deepEqual(
    parsed.map((item) => [item.nodeType, item.field, item.displayName]),
    [
      ['SoftwareRequirement', 'RequirementTitle', '需求标题'],
      ['OtherType', 'Priority', '优先级']
    ]
  )

  db.replaceFieldDefinitions(parsed)
  assert.deepEqual(db.getFieldDisplayNames('SoftwareRequirement', ['RequirementTitle']), {
    RequirementTitle: '需求标题'
  })
  assert.deepEqual(db.getFieldDisplayNames('OtherType', ['Priority']), {
    Priority: '优先级'
  })
  assert.equal(normalizeText({ RequirementTitle: '内容' }, {
    RequirementTitle: '需求标题'
  }), '需求标题: 内容')

  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/Admin/Virtualization_ReadMember')) {
      fieldRequests.push(url)
      return response(fieldDefinitionResponse())
    }
    if (url.pathname.endsWith('/rest/application/Version')) {
      return response({ ErrorCode: 0, Data: '1.0' })
    }
    if (url.pathname.endsWith('/rest/application/DBVersion')) {
      return response({ ErrorCode: 0, Data: '1.0' })
    }
    if (url.pathname.endsWith('/rest/items/id/task-1/attachment')) {
      return response({ ErrorCode: 0, propList: [] })
    }
    if (url.pathname.endsWith('/rest/items')) {
      return response({ ErrorCode: 0, propList: remoteRows })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: 'collector',
    token: 'token'
  })
  const service = new SyncService(db, () => client, () => undefined)

  const first = await service.run(config)
  assert.equal(first.ok, true)
  assert.equal(first.recordCount, 1)
  assert.equal(fieldRequests[0]?.searchParams.get('nodeType'), 'Task')
  assert.equal(fieldRequests[0]?.searchParams.get('name'), 'collector,user')
  assert.equal(fieldRequests[0]?.searchParams.get('user'), 'collector')
  assert.equal(fieldRequests[0]?.searchParams.get('ApiToken'), 'token')

  const stored = db.getRecord('task-1', false)
  assert.equal(stored?.fieldLabels?.Source, '来源')
  assert.equal(stored?.fieldLabels?.State, '状态')
  assert.equal(stored?.fieldLabels?.Owner, '负责人')
  assert(stored?.normalizedText?.includes('来源: Customer'))
  assert(stored?.normalizedText?.includes('状态: Open'))
  assert(!stored?.normalizedText?.includes('Source: Customer'))

  const firstIndexHash = db.listKnowledgeRecordIndexRows()[0]?.contentHash
  const query = db.queryRecordsByFields({ nodeType: 'Task', fields: ['Source', 'State'], limit: 10 })
  assert.deepEqual(query.fieldLabels, { Source: '来源', State: '状态' })

  sourceDisplayName = '客户来源'
  const second = await service.run(config)
  assert.equal(second.ok, true)
  assert.equal(second.skippedCount, 1)
  const refreshed = db.getRecord('task-1', false)
  assert(refreshed?.normalizedText?.includes('客户来源: Customer'))
  assert(!refreshed?.normalizedText?.split('\n').some((line) => line.startsWith('来源:')))
  assert.notEqual(db.listKnowledgeRecordIndexRows()[0]?.contentHash, firstIndexHash)

  console.log(JSON.stringify({
    parsedDefinitionCount: parsed.length,
    storedLabels: refreshed?.fieldLabels,
    queryLabels: query.fieldLabels,
    duplicateRefresh: refreshed?.normalizedText?.includes('客户来源: Customer') === true,
    fieldRequest: fieldRequests[0]?.pathname
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(root, { recursive: true, force: true })
}
