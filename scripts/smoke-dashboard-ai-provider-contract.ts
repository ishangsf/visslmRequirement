import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage } from 'node:http'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import type { DashboardComponentSpec, DashboardSpec, VisualizationRunInput } from '../src/shared/dashboard'
import type { ModelProvider, ModelSettings } from '../src/shared/types'

const records: AnalyticsRecord[] = [{
  uid: 'provider-contract-1',
  projectId: 'p1',
  nodeType: 'Issue',
  itemId: 'I-1',
  name: 'Issue 1',
  lastModifyTime: '2026-07-01T10:00:00Z',
  raw: { status: 'open' }
}]

const fakeDb = {
  scanAnalyticsRecords: () => records
} as AppDatabase

const component = (id: string, title: string, x: number): DashboardComponentSpec => ({
  id,
  type: 'kpi',
  title,
  layout: { x, y: 0, w: 6, h: 3 },
  data: [{ name: title, value: 1 }],
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
  id: 'dashboard-provider-contract',
  title: 'Provider contract dashboard',
  subtitle: 'Structured patch contract smoke',
  businessContext: {
    audience: 'QA',
    objective: 'Verify provider request contracts',
    scopeDescription: 'p1'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    component('kpi-total', 'Total issues', 0),
    component('kpi-open', 'Open issues', 6),
    component('kpi-closed', 'Closed issues', 12),
    component('kpi-other', 'Other issues', 18)
  ]
}

type CapturedRequest = {
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

const captured: CapturedRequest[] = []
const attempts = new Map<string, number>()

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const server = createServer(async (request, response) => {
  try {
    const path = request.url ?? ''
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>
    captured.push({ path, headers: request.headers, body })
    const attempt = (attempts.get(path) ?? 0) + 1
    attempts.set(path, attempt)
    const operations = attempt === 1
      ? [{ op: 'set-component-title', componentId: 'kpi-other', value: 'Wrong target' }]
      : [{ op: 'set-component-title', componentId: 'kpi-total', value: `Renamed by ${path.split('/')[1]}` }]
    const content = JSON.stringify({ operations })
    response.setHeader('Content-Type', 'application/json')
    if (path === '/anthropic/messages') {
      response.end(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: content }]
      }))
      return
    }
    response.end(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }]
    }))
  } catch (error) {
    response.statusCode = 500
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
  }
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const origin = `http://127.0.0.1:${address.port}`

const providers: Array<{ provider: ModelProvider; prefix: string }> = [
  { provider: 'openai', prefix: 'openai' },
  { provider: 'openai-compatible', prefix: 'compatible' },
  { provider: 'anthropic', prefix: 'anthropic' }
]

const providerResults: Array<Record<string, unknown>> = []

try {
  for (const { provider, prefix } of providers) {
    const runs: VisualizationRunInput[] = []
    const settings: ModelSettings = {
      source: 'online',
      provider,
      baseUrl: `${origin}/${prefix}`,
      model: provider === 'openai' ? 'gpt-4.1-mini' : 'contract-model',
      thinking: false,
      apiKey: `private-${prefix}-key`
    }
    const agent = new VisualizationAgent(
      new QueryEngine(fakeDb),
      settings,
      (run) => runs.push(run)
    )
    const next = await agent.patch(
      'Rename only the selected component',
      baseDashboard,
      { projectIds: ['p1'] },
      'kpi-total',
      [
        { role: 'user', content: 'Keep this successful context', outcome: 'success' },
        { role: 'assistant', content: 'Applied', outcome: 'success' },
        { role: 'user', content: 'Rejected old request', outcome: 'failed' }
      ]
    )
    assert.equal(next.components.find((item) => item.id === 'kpi-total')?.title, `Renamed by ${prefix}`)
    assert.equal(next.components.find((item) => item.id === 'kpi-other')?.title, 'Other issues')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'success')
    assert.equal(runs[0].attemptCount, 2)
    assert.equal(runs[0].toolCalls.filter((call) => call.tool === 'execute-query').length, 1)
    assert.ok(runs[0].toolCalls.some((call) => call.tool === 'repair-attempt'))

    const path = provider === 'anthropic' ? `/${prefix}/messages` : `/${prefix}/chat/completions`
    const requests = captured.filter((request) => request.path === path)
    assert.equal(requests.length, 2)
    const [first, retry] = requests
    if (provider === 'anthropic') {
      assert.equal(first.headers['x-api-key'], `private-${prefix}-key`)
      assert.equal(first.headers['anthropic-version'], '2023-06-01')
      assert.equal(first.headers.authorization, undefined)
      assert.equal(typeof first.body.system, 'string')
      assert.ok(String(first.body.system).includes('JSON'))
      assert.ok(Array.isArray(first.body.messages))
      assert.equal('response_format' in first.body, false)
    } else {
      assert.equal(first.headers.authorization, `Bearer private-${prefix}-key`)
      assert.equal(first.headers['x-api-key'], undefined)
      const responseFormat = first.body.response_format as {
        type?: string
        json_schema?: { strict?: boolean; schema?: { required?: string[] } }
      }
      if (provider === 'openai') {
        assert.equal(responseFormat.type, 'json_schema')
        assert.equal(responseFormat.json_schema?.strict, true)
        assert.ok(responseFormat.json_schema?.schema?.required?.includes('operations'))
      } else {
        assert.deepEqual(responseFormat, { type: 'json_object' })
      }
    }
    const retryMessages = retry.body.messages as Array<{ role?: string; content?: string }>
    const retryPrompt = JSON.parse(retryMessages.at(-1)?.content ?? '{}') as {
      currentDashboard?: DashboardSpec
      conversationContext?: { recentTurns?: Array<{ content?: string }> }
      previousValidationErrors?: string
    }
    assert.deepEqual(retryPrompt.currentDashboard?.components.map((item) => item.id), ['kpi-total'])
    assert.ok(retryPrompt.previousValidationErrors?.includes('其他组件'))
    assert.ok(!JSON.stringify(retryPrompt.conversationContext).includes('Rejected old request'))
    providerResults.push({ provider, attempts: requests.length, queryExecutions: 1 })
  }

  console.log(JSON.stringify({
    ok: true,
    providers: providerResults,
    verified: [
      'provider-specific authentication headers',
      'OpenAI strict json_schema response format',
      'OpenAI-compatible json_object response format',
      'Anthropic system and message separation',
      'focused component restriction and retry',
      'failed history exclusion'
    ]
  }, null, 2))
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
