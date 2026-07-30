import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database.ts'

const root = mkdtempSync(join(tmpdir(), 'visslm-field-aggregate-'))
const db = new AppDatabase(join(root, 'test.db'), join(root, 'assets'))

const addRecord = (uid, source, nodeType = 'TSIssue', extra = {}) => {
  const raw = {
    _valm_Uid: uid,
    _valm_NodeType: nodeType,
    _valm_Name: `记录 ${uid}`,
    ...extra
  }
  if (source !== undefined) raw.Source = source
  db.upsertRecord({
    uid,
    projectId: 'project-1',
    nodeType,
    itemId: uid.toUpperCase(),
    parentId: '',
    name: `记录 ${uid}`,
    lastModifyTime: '2026-07-30T00:00:00.000Z',
    raw,
    normalizedText: source === undefined ? '' : `Source: ${String(source)}`
  })
}

addRecord('issue-1', '中电10所，中电29所', 'TSIssue', {
  Priority: 3,
  Record: [{ UserName: '王五', Value: '已分析', Time: '2026-07-28 10:00:00' }]
})
addRecord('issue-2', '中电29所; 中电30所', 'TSIssue', {
  Priority: 1,
  Record: [{ UserName: '王六', Value: '待处理', Time: '2026-07-29 10:00:00' }]
})
addRecord('issue-3', ['中电29所', '中电10所', '中电29所'], 'TSIssue', {
  Priority: 5,
  Record: [
    { UserName: '王五', Value: '已分析', Time: '2026-07-30 10:00:00' },
    { UserName: '王七', Value: '已关闭', Time: '2026-07-30 11:00:00' }
  ]
})
addRecord('issue-4', '')
addRecord('task-1', '不应计入', 'Task')

const result = db.aggregateByField({
  field: 'source',
  nodeType: 'TSIssue',
  limit: 3,
  splitMultiValue: true
})

const expected = [
  { name: '中电29所', value: 3 },
  { name: '中电10所', value: 2 },
  { name: '中电30所', value: 1 }
]
const sourceFields = db.inspectFields({
  nodeType: 'TSIssue',
  search: 'source',
  limit: 10
})
const nestedFields = db.inspectFields({
  nodeType: 'TSIssue',
  search: 'Record.User',
  limit: 10
})
const sourceQuery = db.queryRecordsByFields({
  nodeType: 'TSIssue',
  filters: [{ field: 'source', operator: 'contains', value: '中电10所' }],
  fields: ['Source', 'Record.UserName'],
  limit: 10
})
const sortedQuery = db.queryRecordsByFields({
  nodeType: 'TSIssue',
  filters: [{ field: 'Priority', operator: 'gte', value: '3' }],
  fields: ['Priority'],
  sort: { field: 'Priority', direction: 'desc' },
  limit: 10
})
const passed =
  result.totalRecords === 4 &&
  result.matchedRecords === 3 &&
  result.emptyRecords === 1 &&
  result.valueOccurrences === 6 &&
  JSON.stringify(result.items.map(({ name, value }) => ({ name, value }))) ===
    JSON.stringify(expected) &&
  result.items.every((item) => item.examples.length > 0 && item.examples.length <= 2) &&
  sourceFields.fields.some((field) => field.field === 'Source' && field.nonEmptyRecords === 3) &&
  nestedFields.fields.some(
    (field) => field.field === 'Record.UserName' && field.samples.includes('王五')
  ) &&
  sourceQuery.matchedCount === 2 &&
  sourceQuery.records.some(
    (record) =>
      record.source.uid === 'issue-3' &&
      Array.isArray(record.values['Record.UserName']) &&
      record.values['Record.UserName'].includes('王七')
  ) &&
  JSON.stringify(sortedQuery.records.map((record) => record.source.uid)) ===
    JSON.stringify(['issue-3', 'issue-1'])

console.log(JSON.stringify({
  passed,
  aggregate: result,
  sourceFields,
  nestedFields,
  sourceQuery,
  sortedQuery
}, null, 2))
db.close()

if (!passed) process.exitCode = 1
