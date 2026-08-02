import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import type { DashboardComponentSpec, DashboardSpec, VisualizationRunInput } from '../src/shared/dashboard'
import { dashboardAiEditMode } from '../src/shared/dashboard'

const fakeDb = { scanAnalyticsRecords: () => [] } as unknown as AppDatabase

const snapshotComponent = (id: string, title: string, x: number): DashboardComponentSpec => ({
  id,
  type: 'kpi',
  title,
  layout: { x, y: 0, w: 6, h: 2 },
  data: [{ name: title, value: 1 }]
})

const snapshot: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'snapshot-ai-smoke',
  title: 'Data operations overview',
  subtitle: 'Cross-domain snapshot',
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    snapshotComponent('records', 'Records', 0),
    snapshotComponent('projects', 'Projects', 6),
    snapshotComponent('images', 'Images', 12),
    snapshotComponent('pushes', 'Pushes', 18)
  ]
}

const modelResponses = [
  [{ op: 'set-dashboard-title', value: 'Data operations cockpit' }],
  [{ op: 'set-component-title', componentId: 'records', value: 'Total records' }],
  [{ op: 'set-component-type', componentId: 'records', value: 'line' }],
  [{ op: 'set-component-type', componentId: 'records', value: 'line' }],
  [{ op: 'set-theme', value: 'business-light' }]
]

const originalFetch = globalThis.fetch
const runs: VisualizationRunInput[] = []
const prompts: Array<Record<string, unknown>> = []
let responseIndex = 0

try {
  globalThis.fetch = async (_input, init) => {
    const operations = modelResponses[responseIndex]
    responseIndex += 1
    assert.ok(operations, `unexpected model request ${responseIndex}`)
    if (typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { messages?: Array<{ content?: string }> }
      prompts.push(JSON.parse(body.messages?.at(-1)?.content ?? '{}') as Record<string, unknown>)
    }
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ operations }) }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const agent = new VisualizationAgent(
    new QueryEngine(fakeDb),
    {
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'snapshot-test',
      thinking: false
    },
    (run) => runs.push(run)
  )

  assert.equal(dashboardAiEditMode(snapshot), 'presentation-only')
  const renamed = await agent.patch('Rename the dashboard', snapshot, {})
  assert.equal(renamed.title, 'Data operations cockpit')
  assert.equal(runs.at(-1)?.status, 'success')
  assert.equal(runs.at(-1)?.toolCalls.filter((call) => call.tool === 'execute-query').length, 0)
  assert.equal(prompts[0].editMode, 'presentation-only')

  const componentRenamed = await agent.patch(
    'Rename only this component',
    renamed,
    {},
    'records'
  )
  assert.equal(componentRenamed.components.find((item) => item.id === 'records')?.title, 'Total records')
  assert.equal(runs.at(-1)?.toolCalls.filter((call) => call.tool === 'execute-query').length, 0)

  const beforeRejected = JSON.parse(JSON.stringify(componentRenamed)) as DashboardSpec
  await assert.rejects(
    () => agent.patch('Change this component to a line chart', componentRenamed, {}, 'records'),
    /展示快照模式不支持 set-component-type/
  )
  assert.deepEqual(componentRenamed, beforeRejected)
  assert.equal(runs.at(-1)?.status, 'failed')
  assert.equal(runs.at(-1)?.attemptCount, 2)
  assert.equal(runs.at(-1)?.toolCalls.filter((call) => call.tool === 'execute-query').length, 0)

  const themed = await agent.patch('Use the business light theme', componentRenamed, {})
  assert.equal(themed.theme, 'business-light')
  assert.equal(runs.at(-1)?.status, 'success')
  assert.equal(responseIndex, 5)

  console.log(JSON.stringify({
    ok: true,
    editMode: dashboardAiEditMode(snapshot),
    successfulPresentationPatches: runs.filter((run) => run.status === 'success').length,
    rejectedDataPatches: runs.filter((run) => run.status === 'failed').length,
    queryExecutions: runs.map((run) =>
      run.toolCalls.filter((call) => call.tool === 'execute-query').length
    ),
    finalTitle: themed.title,
    finalTheme: themed.theme
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
