import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import type { AssistantRunHistory } from '../src/shared/types'

const checks: string[] = []
const directory = await mkdtemp(join(tmpdir(), 'assistant-run-history-'))
const db = new AppDatabase(join(directory, 'runs.db'), join(directory, 'assets'))
try {
  const completed: AssistantRunHistory = {
    runId: 'run-completed',
    conversationId: 'conversation-1',
    status: 'completed',
    taskType: 'record_query',
    sourceMode: 'records',
    resultMode: 'table',
    primaryAgent: 'data-center',
    invokedAgents: ['data-center'],
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1_200).toISOString(),
    durationMs: 1_200,
    stages: [{ stage: 'query', message: '执行结构化查询', at: new Date(500).toISOString() }],
    toolCallCount: 1,
    matchedCount: 55,
    recordEvidenceCount: 3,
    documentEvidenceCount: 0
  }
  const failed: AssistantRunHistory = {
    ...completed,
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
  assert.equal(runs.find((run) => run.runId === 'run-failed')?.failedStage, 'query')
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
  checks.push('run history persists duration, observable tool stages, hits and failure stage with aggregate stats')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const [fixture, evaluator, mainSource, rendererSource] = await Promise.all([
  readFile(new URL('./fixtures/assistant-eval-set.json', import.meta.url), 'utf8'),
  readFile(new URL('../scripts/evaluate-assistant-offline.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
])
const categories = new Set((JSON.parse(fixture) as Array<{ category: string }>).map((item) => item.category))
for (const category of ['total', 'business_field_aggregate', 'attribute_qa', 'empty_result', 'ambiguity', 'prompt_injection', 'unknown_field']) {
  assert.equal(categories.has(category), true, `missing eval category: ${category}`)
}
assert.match(evaluator, /failClosed/)
assert.match(mainSource, /saveAssistantRunHistory\(history\)/)
assert.match(rendererSource, /Agent 运行历史与质量指标/)
checks.push('offline eval coverage and run-history product entry are wired into production')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
