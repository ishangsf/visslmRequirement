import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { DashboardSpec, VisualizationRunInput } from '../src/shared/dashboard'

const records: AnalyticsRecord[] = [
  {
    uid: '1',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-1',
    name: 'Issue 1',
    lastModifyTime: '2026-07-01T10:00:00Z',
    raw: { status: 'open', effort: 3, updatedAt: '2026-07-01T10:00:00Z' }
  },
  {
    uid: '2',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-2',
    name: 'Issue 2',
    lastModifyTime: '2026-07-08T10:00:00Z',
    raw: { status: 'closed', effort: 5, updatedAt: '2026-07-08T10:00:00Z' }
  }
]

const fakeDb = {
  scanAnalyticsRecords: (scope) => records.filter((record) =>
    (!scope.projectIds?.length || scope.projectIds.includes(record.projectId))
  )
} as AppDatabase

const makeComponent = (index: number) => ({
  id: `kpi-${index}`,
  type: 'kpi' as const,
  title: `KPI ${index}`,
  layout: { x: (index - 1) * 6, y: 0, w: 6, h: 3 },
  data: [{ name: `KPI ${index}`, value: 2 }],
  query: {
    source: 'records' as const,
    scope: { projectIds: ['p1'] },
    dimensions: [],
    measures: [{ id: 'records', aggregation: 'count' as const }],
    limit: 1
  },
  encoding: { value: 'records' }
})

const baseDashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'patch-dashboard',
  title: 'Operations dashboard',
  subtitle: 'Patch smoke test',
  businessContext: {
    audience: 'QA',
    objective: 'Patch',
    scopeDescription: 'p1'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [1, 2, 3, 4].map(makeComponent)
}

const settings = {
  source: 'local' as const,
  provider: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-model',
  thinking: false
}

const originalFetch = globalThis.fetch
const progress: string[] = []
const runs: VisualizationRunInput[] = []

try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: {
      content: JSON.stringify({
        operations: [
          { op: 'set-dashboard-title', value: 'Patched operations dashboard' },
          { op: 'set-theme', value: 'business-light' },
          { op: 'set-component-title', componentId: 'kpi-1', value: 'Total issues' },
          { op: 'set-component-limit', componentId: 'kpi-1', limit: 10 },
          { op: 'remove-component', componentId: 'kpi-4' }
        ]
      })
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const agent = new VisualizationAgent(
    new QueryEngine(fakeDb),
    settings,
    (run) => runs.push(run),
    (event) => progress.push(event.stage)
  )
  const patched = await agent.patch('Change the title and remove the fourth KPI', baseDashboard, {
    projectIds: ['p1']
  })
  assert.equal(patched.id, baseDashboard.id)
  assert.equal(patched.title, 'Patched operations dashboard')
  assert.equal(patched.theme, 'business-light')
  assert.equal(patched.components.length, 3)
  assert.equal(patched.components[0].title, 'Total issues')
  assert.equal(patched.components[0].query?.limit, 10)
  assert.deepEqual(patched.components[0].data, [{ name: 'Total issues', value: 2 }])
  assert.deepEqual(validateDashboardSpec(patched, new QueryEngine(fakeDb)), [])
  assert.deepEqual(progress, [
    'intent',
    'profile',
    'plan',
    'query',
    'execute',
    'compose',
    'validate',
    'persist'
  ])
  assert.equal(runs[0].mode, 'patch')
  assert.equal(runs[0].status, 'success')
  const appliedPatchCall = runs[0].toolCalls.find((call) => call.tool === 'apply-patch')
  assert.ok(appliedPatchCall)
  assert.equal(appliedPatchCall.metadata?.operationCount, 5)
  assert.equal(appliedPatchCall.metadata?.affectedComponentCount, 1)
  assert.equal(appliedPatchCall.metadata?.removedComponentCount, 1)
  assert.equal(appliedPatchCall.metadata?.queryExecutionCount, 1)
  assert.equal(runs[0].toolCalls.filter((call) => call.tool === 'execute-query').length, 1)

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: {
      content: JSON.stringify({
        operations: [
          { op: 'set-dashboard-subtitle', value: 'Metadata-only patch' },
          { op: 'set-theme', value: 'charcoal-dark' }
        ]
      })
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const metadataOnly = await agent.patch(
    'Update the dashboard subtitle and theme',
    patched,
    { projectIds: ['p1'] }
  )
  assert.equal(metadataOnly.subtitle, 'Metadata-only patch')
  assert.equal(metadataOnly.theme, 'charcoal-dark')
  assert.deepEqual(metadataOnly.components, patched.components)
  assert.equal(runs[1].status, 'success')
  assert.equal(runs[1].toolCalls.filter((call) => call.tool === 'execute-query').length, 0)
  const metadataPatchCall = runs[1].toolCalls.find((call) => call.tool === 'apply-patch')
  assert.equal(metadataPatchCall?.metadata?.affectedComponentCount, 0)
  assert.equal(metadataPatchCall?.metadata?.queryExecutionCount, 0)

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: {
      content: JSON.stringify({
        operations: [{
          op: 'set-component-time-grain',
          componentId: 'kpi-1',
          timeGrain: 'month'
        }]
      })
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  await assert.rejects(
    () => agent.patch('Use a monthly grain on the first KPI', metadataOnly, { projectIds: ['p1'] }),
    /DashboardSpec 修改失败/
  )
  assert.equal(runs[2].status, 'failed')
  assert.equal(runs[2].mode, 'patch')
  assert.ok(runs[2].toolCalls.some((call) => call.tool === 'repair-attempt'))

  console.log(JSON.stringify({
    ok: true,
    patchedTitle: patched.title,
    componentCount: patched.components.length,
    toolCallCount: runs.map((run) => run.toolCalls.length),
    progress
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
