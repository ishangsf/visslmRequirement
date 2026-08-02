import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type {
  DashboardComponentSpec,
  DashboardSpec,
  VisualizationRunInput
} from '../src/shared/dashboard'

const records: AnalyticsRecord[] = [
  {
    uid: 'ai-context-1',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-1',
    name: 'Issue 1',
    lastModifyTime: '2026-07-01T10:00:00Z',
    raw: { status: 'open', effort: 3 }
  },
  {
    uid: 'ai-context-2',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-2',
    name: 'Issue 2',
    lastModifyTime: '2026-07-08T10:00:00Z',
    raw: { status: 'closed', effort: 5 }
  }
]

const fakeDb = {
  scanAnalyticsRecords: (scope) => records.filter((record) =>
    !scope.projectIds?.length || scope.projectIds.includes(record.projectId)
  )
} as AppDatabase

const component = (id: string, title: string, x: number): DashboardComponentSpec => ({
  id,
  type: 'kpi',
  title,
  layout: { x, y: 0, w: 6, h: 3 },
  data: [{ name: title, value: 2 }],
  query: {
    source: 'records',
    scope: { projectIds: ['p1'] },
    dimensions: [],
    measures: [{ id: 'records', aggregation: 'count' }],
    limit: 1
  },
  encoding: { value: 'records' }
})

const baseDashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'dashboard-ai-context-smoke',
  title: 'Operations dashboard',
  subtitle: 'AI context smoke test',
  businessContext: {
    audience: 'QA',
    objective: 'Verify continuous AI patches',
    scopeDescription: 'p1'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    component('kpi-total', 'Total issues', 0),
    component('kpi-open', 'Open issues', 6),
    component('kpi-closed', 'Closed issues', 12),
    component('kpi-effort', 'Total effort', 18)
  ]
}

const settings = {
  source: 'local' as const,
  provider: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-model',
  thinking: false
}

const modelResponses = [
  [{ op: 'set-dashboard-title', value: 'Operations overview' }],
  [{ op: 'set-theme', value: 'light-business' }],
  [{ op: 'set-dashboard-title', value: 'Issue count' }],
  [{ op: 'set-component-limit', componentId: 'kpi-total', limit: 25 }],
  [{
    op: 'set-component-sort',
    componentId: 'kpi-total',
    sortField: 'records',
    sortDirection: 'desc'
  }],
  [
    { op: 'set-component-time-grain', componentId: 'kpi-total', timeGrain: 'month' }
  ],
  [{ op: 'set-component-subtitle', componentId: 'kpi-total', value: 'Monthly tracked issues' }],
  [{ op: 'set-dashboard-title', value: 'Rejected cross-component change' }],
  [{ op: 'set-dashboard-title', value: 'Rejected cross-component retry' }],
  [{ op: 'set-dashboard-subtitle', value: 'Recovered after a rejected patch' }],
  [{ op: 'remove-component', componentId: 'kpi-effort' }]
]

const originalFetch = globalThis.fetch
const versions: number[] = []
const runs: VisualizationRunInput[] = []
const modelPayloads: Array<{
  messages?: Array<{ role?: string; content?: string }>
}> = []
let fetchCount = 0
let current = baseDashboard
let fullRefreshQueryBaseline = 0

const queryExecutions = (run: VisualizationRunInput): number =>
  run.toolCalls.filter((call) => call.tool === 'execute-query').length

const patchMetadata = (run: VisualizationRunInput): Record<string, number | boolean> | undefined =>
  run.toolCalls.find((call) => call.tool === 'apply-patch' && call.status === 'success')?.metadata

const componentSnapshot = (
  dashboard: DashboardSpec,
  excludedId?: string
): DashboardComponentSpec[] => dashboard.components
  .filter((item) => item.id !== excludedId)
  .map((item) => JSON.parse(JSON.stringify(item)) as DashboardComponentSpec)

const longHistory = [
  { role: 'user', content: 'Keep the original quarterly operations context for later follow-ups' },
  { role: 'assistant', content: 'Quarterly operations context saved' },
  { role: 'user', content: 'Use concise metric labels' },
  { role: 'assistant', content: 'Metric labels are concise' },
  { role: 'user', content: 'Keep the executive audience in mind' },
  { role: 'assistant', content: 'Executive audience retained' },
  { role: 'user', content: 'Preserve issue status terminology' },
  { role: 'assistant', content: 'Issue status terminology retained' },
  { role: 'user', content: 'This rejected request must not become context', outcome: 'failed' },
  { role: 'assistant', content: 'The rejected change was not applied', outcome: 'failed' },
  { role: 'user', content: 'This undone request must not become context', outcome: 'undone' },
  { role: 'assistant', content: 'The change was later undone', outcome: 'undone' },
  { role: 'user', content: 'Recent request one' },
  { role: 'assistant', content: 'Recent result one' },
  { role: 'user', content: 'Recent request two' },
  { role: 'assistant', content: 'Recent result two' },
  { role: 'user', content: 'Recent request three' },
  { role: 'assistant', content: 'Recent result three' },
  { role: 'user', content: 'Recent request four' },
  { role: 'assistant', content: 'Recent result four' }
] as const

try {
  globalThis.fetch = async (_input, init) => {
    const operations = modelResponses[fetchCount]
    fetchCount += 1
    assert.ok(operations, `unexpected model request ${fetchCount}`)
    if (typeof init?.body === 'string') {
      modelPayloads.push(JSON.parse(init.body) as (typeof modelPayloads)[number])
    }
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ operations }) }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const agent = new VisualizationAgent(
    new QueryEngine(fakeDb),
    settings,
    (run) => runs.push(run)
  )
  const scope = { projectIds: ['p1'] }

  const applySuccessfulPatch = async (
    question: string,
    options: {
      focusComponentId?: string
      expectedQueries: number
      allowLayoutChanges?: boolean
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }
  ): Promise<DashboardSpec> => {
    const before = current
    const unaffectedBefore = componentSnapshot(before, options.focusComponentId)
    const next = await agent.patch(
      question,
      before,
      scope,
      options.focusComponentId,
      options.history
    )
    current = next
    versions.push(versions.length + 1)
    fullRefreshQueryBaseline += next.components.filter((item) => item.query).length
    assert.equal(next.id, baseDashboard.id)
    assert.equal(queryExecutions(runs.at(-1)!), options.expectedQueries)
    assert.equal(patchMetadata(runs.at(-1)!)?.queryExecutionCount, options.expectedQueries)
    if (!options.allowLayoutChanges) {
      assert.deepEqual(componentSnapshot(next, options.focusComponentId), unaffectedBefore)
    } else {
      const beforeById = new Map(unaffectedBefore.map((item) => [item.id, item]))
      for (const item of next.components.filter((candidate) => candidate.id !== options.focusComponentId)) {
        const previous = beforeById.get(item.id)
        assert.ok(previous)
        assert.deepEqual(item.query, previous.query)
        assert.deepEqual(item.data, previous.data)
        assert.equal(item.title, previous.title)
      }
    }
    return next
  }

  await applySuccessfulPatch('Rename the dashboard', {
    expectedQueries: 0,
    history: [...longHistory]
  })
  assert.equal(current.title, 'Operations overview')
  const firstModelContext = JSON.parse(modelPayloads[0].messages?.[1]?.content ?? '{}') as {
    conversationContext?: {
      currentState?: { title?: string; components?: Array<{ id?: string }> }
      earlierSuccessfulRequests?: string[]
      recentTurns?: Array<{ role: string; content: string }>
      omittedTurnCount?: number
    }
  }
  assert.equal(firstModelContext.conversationContext?.currentState?.title, baseDashboard.title)
  assert.deepEqual(
    firstModelContext.conversationContext?.currentState?.components?.map((item) => item.id),
    baseDashboard.components.map((item) => item.id)
  )
  assert.ok(firstModelContext.conversationContext?.earlierSuccessfulRequests?.includes(
    'Keep the original quarterly operations context for later follow-ups'
  ))
  assert.equal(firstModelContext.conversationContext?.recentTurns?.length, 8)
  assert.equal(firstModelContext.conversationContext?.recentTurns?.[0]?.content, 'Recent request one')
  assert.equal(firstModelContext.conversationContext?.omittedTurnCount, 12)
  assert.ok(!JSON.stringify(firstModelContext.conversationContext).includes('rejected request'))
  assert.ok(!JSON.stringify(firstModelContext.conversationContext).includes('undone request'))
  assert.ok(JSON.stringify(firstModelContext.conversationContext).length < 12_000)

  await applySuccessfulPatch('Use the business light theme', { expectedQueries: 0 })
  assert.equal(current.theme, 'business-light')

  await applySuccessfulPatch('Rename only the selected component', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1
  })
  assert.equal(current.components.find((item) => item.id === 'kpi-total')?.title, 'Issue count')
  assert.deepEqual(current.components.find((item) => item.id === 'kpi-total')?.data, [
    { name: 'Issue count', value: 2 }
  ])
  const focusedModelContext = JSON.parse(modelPayloads[2].messages?.[1]?.content ?? '{}') as {
    currentDashboard?: DashboardSpec
    focusComponent?: { id?: string }
  }
  assert.deepEqual(
    focusedModelContext.currentDashboard?.components.map((item) => item.id),
    ['kpi-total']
  )
  assert.equal(focusedModelContext.focusComponent?.id, 'kpi-total')

  await applySuccessfulPatch('Show the top 25 results', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1
  })
  assert.equal(current.components.find((item) => item.id === 'kpi-total')?.query?.limit, 25)

  await applySuccessfulPatch('Sort by issue count descending', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1
  })
  assert.deepEqual(current.components.find((item) => item.id === 'kpi-total')?.query?.sort, [
    { field: 'records', direction: 'desc' }
  ])

  await applySuccessfulPatch('Change the selected KPI into a monthly line chart', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1,
    allowLayoutChanges: true
  })
  const lineComponent = current.components.find((item) => item.id === 'kpi-total')
  assert.equal(lineComponent?.type, 'line')
  assert.equal(lineComponent?.query?.dimensions?.length, 1)
  assert.equal(lineComponent?.query?.dimensions?.[0]?.timeGrain, 'month')
  assert.equal(lineComponent?.encoding?.label, lineComponent?.query?.dimensions?.[0]?.field)

  await applySuccessfulPatch('Add a subtitle to the selected line chart', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1
  })
  assert.equal(
    current.components.find((item) => item.id === 'kpi-total')?.subtitle,
    'Monthly tracked issues'
  )

  const beforeRejectedPatch = JSON.parse(JSON.stringify(current)) as DashboardSpec
  await assert.rejects(
    () => agent.patch(
      'Change the whole dashboard while a component is selected',
      current,
      scope,
      'kpi-total'
    ),
    /DashboardSpec/
  )
  assert.deepEqual(current, beforeRejectedPatch)
  assert.equal(runs.at(-1)?.status, 'failed')
  assert.equal(queryExecutions(runs.at(-1)!), 0)
  assert.ok(runs.at(-1)?.toolCalls.some((call) => call.tool === 'repair-attempt'))

  await applySuccessfulPatch('Update the subtitle after the rejected change', { expectedQueries: 0 })
  assert.equal(current.subtitle, 'Recovered after a rejected patch')

  await applySuccessfulPatch('Remove the effort KPI', {
    focusComponentId: 'kpi-effort',
    expectedQueries: 0
  })
  assert.equal(current.components.some((item) => item.id === 'kpi-effort'), false)
  assert.equal(patchMetadata(runs.at(-1)!)?.removedComponentCount, 1)

  assert.equal(fetchCount, 11)
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(runs.map(queryExecutions), [0, 0, 1, 1, 1, 1, 1, 0, 0, 0])
  const incrementalQueryExecutions = runs.reduce((total, run) => total + queryExecutions(run), 0)
  assert.equal(fullRefreshQueryBaseline, 35)
  assert.equal(incrementalQueryExecutions, 5)
  assert.deepEqual(validateDashboardSpec(current, new QueryEngine(fakeDb)), [])

  console.log(JSON.stringify({
    ok: true,
    dashboardId: current.id,
    versions,
    successfulPatches: versions.length,
    rejectedPatches: runs.filter((run) => run.status === 'failed').length,
    queryExecutions: runs.map(queryExecutions),
    fullRefreshQueryBaseline,
    incrementalQueryExecutions,
    queryReductionPercent: Number(
      ((1 - incrementalQueryExecutions / fullRefreshQueryBaseline) * 100).toFixed(1)
    ),
    fetchCount,
    finalComponentCount: current.components.length
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
