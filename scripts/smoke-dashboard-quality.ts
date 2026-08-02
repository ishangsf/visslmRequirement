import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { AppDatabase as RealDatabase } from '../src/main/database'
import { diagnoseDashboard } from '../src/main/dashboards/diagnostics'
import type { DashboardSpec } from '../src/shared/dashboard'
import type { DataScope } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = Array.from({ length: 8 }, (_, index) => ({
  uid: String(index + 1),
  projectId: 'p1',
  nodeType: 'Issue',
  itemId: `I-${index + 1}`,
  name: `问题 ${index + 1}`,
  lastModifyTime: `2026-07-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
  raw: { status: `状态 ${index + 1}`, phone: `1380000000${index}` }
}))

const fakeDb = {
  scanAnalyticsRecords(scope: DataScope): AnalyticsRecord[] {
    return records.filter((record) =>
      !scope.projectIds?.length || scope.projectIds.includes(record.projectId)
    )
  }
} as AppDatabase
const engine = new QueryEngine(fakeDb)
const query = {
  source: 'records' as const,
  scope: { projectIds: ['p1'] },
  dimensions: [{ field: 'status' }],
  measures: [{ id: 'records', aggregation: 'count' as const }],
  limit: 5
}
const dashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'diagnostic-dashboard',
  title: '质量诊断测试',
  subtitle: '阶段 5',
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    {
      id: 'status-pie',
      type: 'pie',
      title: '这是一个用于验证会议大屏长标题风险提示是否生效的状态分布组件标题',
      layout: { x: 0, y: 0, w: 12, h: 5 },
      data: records.map((record) => ({ name: String(record.raw.status), value: 1 })),
      query,
      encoding: { label: 'status', value: 'records' }
    },
    {
      id: 'status-ranking',
      type: 'ranking',
      title: '状态排行',
      layout: { x: 12, y: 0, w: 12, h: 5 },
      data: [],
      query,
      encoding: { label: 'status', value: 'records' }
    }
  ]
}

const report = diagnoseDashboard(dashboard, engine)
assert.ok(report.score < 100)
assert.equal(report.components.length, 2)
assert.ok(report.issues.some((issue) => issue.code === 'long-title'))
assert.ok(report.issues.some((issue) => issue.code === 'pie-too-many-categories'))
assert.ok(report.issues.some((issue) => issue.code === 'truncated-result'))
assert.ok(report.issues.some((issue) => issue.code === 'duplicate-query'))

const directory = mkdtempSync(join(tmpdir(), 'visslm-quality-'))
const db = new RealDatabase(join(directory, 'test.db'), join(directory, 'assets'))
try {
  db.recordVisualizationRun({
    dashboardId: dashboard.id,
    requestSummary: '生成质量大屏',
    modelName: 'qwen3:8b',
    promptVersion: 'visualization-v1',
    mode: 'generate',
    status: 'success',
    attemptCount: 1,
    componentCount: 2,
    queryCount: 2,
    durationMs: 1200,
    toolCalls: [
      {
        sequence: 1,
        tool: 'profile-fields',
        status: 'success',
        attempt: 0,
        durationMs: 12.345,
        metadata: { fieldCount: 8 }
      },
      {
        sequence: 2,
        tool: 'execute-query',
        status: 'success',
        attempt: 1,
        durationMs: 20,
        componentId: 'status-pie',
        metadata: { resultRows: 5, truncated: true }
      }
    ]
  })
  const savedRun = db.listVisualizationRuns()[0]
  assert.equal(savedRun.dashboardId, dashboard.id)
  assert.equal(savedRun.mode, 'generate')
  assert.equal(savedRun.toolCalls.length, 2)
  assert.equal(savedRun.toolCalls[0].durationMs, 12.35)
  assert.equal(savedRun.toolCalls[1].componentId, 'status-pie')
  assert.deepEqual(savedRun.toolCalls[1].metadata, { resultRows: 5, truncated: true })
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}

console.log(JSON.stringify({
  ok: true,
  score: report.score,
  issues: report.issues.map((issue) => issue.code),
  totalElapsedMs: report.totalElapsedMs
}, null, 2))
