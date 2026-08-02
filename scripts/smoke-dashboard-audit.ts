import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { dashboardSpecHash } from '../src/main/dashboards/spec-hash'
import type { DashboardSpec } from '../src/shared/dashboard'

const directory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-audit-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))

try {
  const hashSpec: DashboardSpec = {
    schemaVersion: '1.0',
    id: 'hash-dashboard',
    title: 'Hash test',
    subtitle: '',
    theme: 'technology-dark',
    updatedAt: '2026-08-01T00:00:00.000Z',
    components: []
  }
  const reorderedHashSpec: DashboardSpec = {
    components: hashSpec.components,
    updatedAt: hashSpec.updatedAt,
    theme: hashSpec.theme,
    subtitle: hashSpec.subtitle,
    title: hashSpec.title,
    id: hashSpec.id,
    schemaVersion: hashSpec.schemaVersion
  }
  assert.equal(dashboardSpecHash(hashSpec), dashboardSpecHash(reorderedHashSpec))
  assert.notEqual(dashboardSpecHash(hashSpec), dashboardSpecHash({ ...hashSpec, title: 'Changed' }))
  db.recordDashboardAuditLog({
    dashboardId: 'audit-dashboard',
    action: 'save',
    status: 'success',
    version: 2,
    metadata: {
      componentCount: 4,
      changeSummary: 'editor update',
      specHash: dashboardSpecHash(hashSpec)
    }
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
  db.recordDashboardAuditLog({
    dashboardId: 'audit-dashboard',
    action: 'repair-component',
    status: 'success',
    metadata: { componentId: 'chart-1', actionCount: 3 }
  })
  db.recordDashboardAuditLog({
    dashboardId: 'audit-dashboard',
    action: 'repair-component',
    status: 'failed',
    metadata: { componentId: 'chart-2' },
    errorMessage: 'repair failed'
  })

  const dashboardLogs = db.listDashboardAuditLogs('audit-dashboard')
  assert.equal(dashboardLogs.length, 4)
  assert.equal(dashboardLogs[0].action, 'repair-component')
  assert.equal(dashboardLogs[0].status, 'failed')
  assert.equal(dashboardLogs[1].metadata?.actionCount, 3)
  assert.equal(dashboardLogs[2].status, 'canceled')
  assert.equal(dashboardLogs[3].version, 2)
  assert.equal(dashboardLogs[3].metadata?.componentCount, 4)
  assert.equal(dashboardLogs[3].metadata?.specHash, dashboardSpecHash(hashSpec))

  const allLogs = db.listDashboardAuditLogs()
  assert.equal(allLogs.length, 5)
  assert.ok(allLogs.some((item) => item.action === 'export-data' && item.status === 'failed'))
  assert.ok(allLogs.some((item) => item.action === 'repair-component' && item.status === 'success'))
  assert.ok(allLogs.some((item) => item.action === 'repair-component' && item.status === 'failed'))

  console.log(JSON.stringify({
    ok: true,
    total: allLogs.length,
    dashboardEvents: dashboardLogs.map((item) => `${item.action}:${item.status}`)
  }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
