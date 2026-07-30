import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database.ts'

const root = mkdtempSync(join(tmpdir(), 'visslm-collection-logs-'))
const db = new AppDatabase(join(root, 'test.db'), join(root, 'assets'))

const request = (nodeType) => ({
  nodeType,
  endpoint: 'http://example.test/alm/rest/items',
  params: {
    'q._valm_NodeType': nodeType,
    ReturnProperty: '_valm_Name',
    user: 'tester',
    ApiToken: '******'
  }
})
const successId = db.beginCollectionRequestLog(request('Task'))
db.finishCollectionRequestLog(successId, 'success', {
  httpStatus: 200,
  recordCount: 1,
  response: { ErrorCode: 0, recordCount: 1 }
})
const failedId = db.beginCollectionRequestLog(request('BrokenType'))
db.finishCollectionRequestLog(failedId, 'failed', {
  httpStatus: 503,
  errorMessage: 'VISSLM HTTP 503'
})
const logs = db.listCollectionRequestLogs()

const runningId = db.beginCollectionRequestLog(request('RunningType'))
const logsWithRunning = db.listCollectionRequestLogs()
db.finishCollectionRequestLog(runningId, 'failed', {
  errorMessage: '测试清理'
})

console.log(JSON.stringify({
  logCount: logs.total,
  runningStateStored: logsWithRunning.rows.some((log) =>
    log.nodeType === 'RunningType' && log.status === 'running'
  ),
  successLog:
    logs.rows.some((log) =>
      log.nodeType === 'Task' &&
      log.status === 'success' &&
      log.httpStatus === 200 &&
      log.recordCount === 1
    ),
  failedLog:
    logs.rows.some((log) =>
      log.nodeType === 'BrokenType' &&
      log.status === 'failed' &&
      log.httpStatus === 503 &&
      log.errorMessage.includes('503')
    ),
  tokensRedacted: logs.rows.every((log) => log.params.ApiToken === '******'),
  endpointCorrect: logs.rows.every((log) => log.endpoint.endsWith('/alm/rest/items'))
}, null, 2))

db.close()
