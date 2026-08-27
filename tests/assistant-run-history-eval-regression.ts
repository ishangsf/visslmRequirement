import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import {
  getAssistantRunUsage,
  recordAssistantRunUsage,
  runWithAssistantRunContext,
  type AssistantRunContext
} from '../src/main/assistant/run-controller'
import type { AssistantRunHistory } from '../src/shared/types'

const checks: string[] = []
const usageContext: AssistantRunContext = {
  runId: '00000000-0000-4000-8000-000000000001',
  signal: new AbortController().signal
}
runWithAssistantRunContext(usageContext, () => {
  recordAssistantRunUsage({ promptTokens: 100, completionTokens: 20, completionDurationMs: 400 })
  recordAssistantRunUsage({ promptTokens: 50, completionTokens: 10, completionDurationMs: 200 })
})
assert.deepEqual(getAssistantRunUsage(usageContext), {
  inputTokenCount: 150,
  outputTokenCount: 30,
  completionDurationMs: 600
})
checks.push('assistant run usage accumulates every model response exactly once per aggregation call')

const directory = await mkdtemp(join(tmpdir(), 'assistant-run-history-'))
const db = new AppDatabase(join(directory, 'runs.db'), join(directory, 'assets'))
try {
  const baseHistory: Omit<AssistantRunHistory, 'runId' | 'status' | 'durationMs' | 'matchedCount' | 'failedStage' | 'error' | 'inputTokenCount' | 'outputTokenCount' | 'tokensPerSecond'> = {
    conversationId: 'conversation-1',
    taskType: 'record_query',
    sourceMode: 'records',
    resultMode: 'table',
    primaryAgent: 'data-center',
    invokedAgents: ['data-center'],
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1_200).toISOString(),
    stages: [{ stage: 'query', message: '执行结构化查询', at: new Date(500).toISOString() }],
    toolCallCount: 1,
    recordEvidenceCount: 3,
    documentEvidenceCount: 0
  }
  const completed: AssistantRunHistory = {
    ...baseHistory,
    runId: 'run-completed',
    conversationId: 'conversation-1',
    status: 'completed',
    durationMs: 1_200,
    matchedCount: 55,
    inputTokenCount: 1_000,
    outputTokenCount: 250,
    tokensPerSecond: 208.333
  }
  const failed: AssistantRunHistory = {
    ...baseHistory,
    runId: 'run-failed',
    status: 'failed',
    durationMs: 800,
    matchedCount: 0,
    failedStage: 'query',
    error: { code: 'QUERY_FAILED', message: '字段不存在' }
  }
  db.saveAssistantRunHistory(completed)
  db.saveAssistantRunHistory(failed)
  const runs = db.listAssistantRunHistory()
  assert.equal(runs.length, 2)
  const persistedCompleted = runs.find((run) => run.runId === 'run-completed')
  assert.equal(persistedCompleted?.inputTokenCount, 1_000)
  assert.equal(persistedCompleted?.outputTokenCount, 250)
  assert.equal(persistedCompleted?.tokensPerSecond, 208.333)
  const legacyRun = runs.find((run) => run.runId === 'run-failed')
  assert.equal(legacyRun?.failedStage, 'query')
  assert.equal(legacyRun?.inputTokenCount, undefined)
  assert.equal(legacyRun?.outputTokenCount, undefined)
  assert.equal(legacyRun?.tokensPerSecond, undefined)
  const stats = db.getAssistantRunHistoryStats()
  assert.deepEqual(stats, {
    total: 2,
    completed: 1,
    failed: 1,
    cancelled: 0,
    clarification: 0,
    averageDurationMs: 1000,
    totalToolCalls: 2,
    totalMatchedCount: 55
  })
  checks.push('run history persists token telemetry, keeps legacy records readable, and preserves aggregate stats')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const [fixture, evaluator, typesSource, mainSource, modelClientSource, rendererSource] = await Promise.all([
  readFile(new URL('./fixtures/assistant-eval-set.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/evaluate-assistant-offline.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/model-client.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
])
const categories = new Set((JSON.parse(fixture) as Array<{ category: string }>).map((item) => item.category))
for (const category of ['total', 'business_field_aggregate', 'attribute_qa', 'empty_result', 'ambiguity', 'prompt_injection', 'unknown_field']) {
  assert.equal(categories.has(category), true, `missing eval category: ${category}`)
}
assert.match(evaluator, /failClosed/)
assert.match(mainSource, /saveAssistantRunHistory\(history\)/)
assert.match(rendererSource, /Agent 运行历史与质量指标/)

for (const field of ['inputTokenCount', 'outputTokenCount', 'tokensPerSecond']) {
  assert.match(typesSource, new RegExp(`${field}\\?:\\s*number`), `${field} must remain optional for legacy history rows`)
}

const historyBlockStart = mainSource.indexOf('const history: AssistantRunHistory')
const historyBlockEnd = mainSource.indexOf('db.saveAssistantRunHistory(history)', historyBlockStart)
assert.ok(historyBlockStart >= 0 && historyBlockEnd > historyBlockStart, 'run-history persistence block must remain discoverable')
const historyBlock = mainSource.slice(historyBlockStart, historyBlockEnd)
for (const field of ['inputTokenCount', 'outputTokenCount', 'tokensPerSecond']) {
  assert.match(historyBlock, new RegExp(field), `${field} must be wired into persisted run history`)
}
assert.match(
  historyBlock,
  /(?:usage|telemetry|token)/iu,
  'history construction must consume model usage telemetry rather than only writing placeholder values'
)

const modelUsageAggregation = /(?:record|track|collect|capture|merge|accumulat|add|update|set)[A-Za-z0-9_]*(?:\s*\([^)]*usage|[\s._]*(?:usage|telemetry|token))/iu
assert.match(
  modelClientSource,
  modelUsageAggregation,
  'ModelClient must expose a usage/telemetry aggregation hook for active assistant runs'
)

const runHistoryDrawerStart = rendererSource.indexOf('title="Agent 运行历史与质量指标"')
const runHistoryDrawerEnd = rendererSource.indexOf('</Drawer>', runHistoryDrawerStart)
assert.ok(runHistoryDrawerStart >= 0 && runHistoryDrawerEnd > runHistoryDrawerStart, 'run-history drawer must remain discoverable')
const runHistoryDrawer = rendererSource.slice(runHistoryDrawerStart, runHistoryDrawerEnd)
const durationFormatterStart = rendererSource.indexOf('const formatDurationSeconds')
const durationFormatterEnd = rendererSource.indexOf('const formatRunMetric', durationFormatterStart)
assert.ok(durationFormatterStart >= 0 && durationFormatterEnd > durationFormatterStart, 'duration formatter must remain discoverable')
const durationFormatter = rendererSource.slice(durationFormatterStart, durationFormatterEnd)
assert.match(
  runHistoryDrawer,
  /平均耗时[\s\S]{0,220}(?:formatDurationSeconds|suffix\s*=\s*(?:\{\s*)?["'](?:秒|s)["'])/u,
  'average duration must be rendered with a seconds formatter or suffix'
)
assert.match(
  durationFormatter,
  /\/\s*1000/u,
  'average duration display must convert milliseconds to seconds'
)
assert.match(durationFormatter, /(?:秒|suffix\s*=\s*(?:\{\s*)?["']s["'])/u, 'duration formatter must expose a seconds unit')
for (const field of ['inputTokenCount', 'outputTokenCount', 'tokensPerSecond']) {
  assert.match(runHistoryDrawer, new RegExp(`dataIndex\\s*:\\s*['"]${field}['"]`), `${field} must have a dedicated history column`)
}
assert.match(
  rendererSource,
  /const formatRunMetric[\s\S]{0,300}return ['"]?—/u,
  'missing token telemetry must use an explicit placeholder'
)
checks.push('offline eval coverage and run-history product entry are wired into production')
checks.push('ModelClient usage aggregation, seconds-based average duration, and token columns/placeholders are covered')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
