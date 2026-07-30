import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import type { DashboardSpec } from '../src/shared/dashboard'

const directory = mkdtempSync(join(tmpdir(), 'visslm-dashboard-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))

const spec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'quality-dashboard',
  title: '研发质量驾驶舱',
  subtitle: '阶段 4 版本测试',
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [{
    id: 'record-total',
    type: 'kpi',
    title: '记录总数',
    layout: { x: 0, y: 0, w: 6, h: 2 },
    data: [{ name: '记录数', value: 0 }],
    query: {
      source: 'records',
      scope: {},
      measures: [{ id: 'records', aggregation: 'count' }]
    },
    encoding: { value: 'records' }
  }]
}

try {
  const version1 = db.saveDashboard({ spec, changeSummary: '创建大屏' })
  assert.equal(version1.version, 1)

  const version2 = db.saveDashboard({
    spec: { ...version1.spec, title: '研发质量周报' },
    changeSummary: '修改标题'
  })
  assert.equal(version2.version, 2)
  assert.equal(db.listDashboards()[0].currentVersion, 2)
  assert.equal(db.listDashboardVersions(spec.id).length, 2)

  const restored = db.restoreDashboard(spec.id, 1)
  assert.equal(restored.version, 3)
  assert.equal(restored.spec.title, spec.title)
  assert.equal(restored.changeSummary, '恢复自版本 V1')

  console.log(JSON.stringify({
    ok: true,
    dashboardId: restored.dashboardId,
    currentVersion: restored.version,
    versions: db.listDashboardVersions(spec.id).map((item) => item.version)
  }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
