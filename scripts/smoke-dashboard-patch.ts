import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { DashboardSpec } from '../src/shared/dashboard'

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
    undefined,
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
    () => agent.patch('Use a monthly grain on the first KPI', baseDashboard, { projectIds: ['p1'] }),
    /DashboardSpec 修改失败/
  )

  console.log(JSON.stringify({ ok: true, patchedTitle: patched.title, componentCount: patched.components.length, progress }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
