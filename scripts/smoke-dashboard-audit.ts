import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'

const directory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-audit-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))

try {
  db.recordDashboardAuditLog({
    dashboardId: 'audit-dashboard',
    action: 'save',
    status: 'success',
    version: 2,
    metadata: { componentCount: 4, changeSummary: 'editor update' }
  })
  db.recordDashboardAuditLog({
    dashboardId: 'audit-dashboard',
    action: 'export-png',
    status: 'canceled',
    format: 'png'
  })
  db.recordDashboardAuditLog({
    action: 'export-data',
    status: 'failed',
    format: 'jsonl',
    errorMessage: 'test failure'
  })

  const dashboardLogs = db.listDashboardAuditLogs('audit-dashboard')
  assert.equal(dashboardLogs.length, 2)
  assert.equal(dashboardLogs[0].status, 'canceled')
  assert.equal(dashboardLogs[1].version, 2)
  assert.equal(dashboardLogs[1].metadata?.componentCount, 4)

  const allLogs = db.listDashboardAuditLogs()
  assert.equal(allLogs.length, 3)
  assert.equal(allLogs[0].action, 'export-data')
  assert.equal(allLogs[0].status, 'failed')

  console.log(JSON.stringify({
    ok: true,
    total: allLogs.length,
    dashboardEvents: dashboardLogs.map((item) => `${item.action}:${item.status}`)
  }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
