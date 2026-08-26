import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AssistantIntentRouter, type AssistantIntentModelClient } from '../src/main/assistant/intent-router'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import type {
  AssistantIntentDecision,
  AssistantIntentResultMode,
  AssistantIntentSourceMode,
  AssistantIntentTaskType,
  ModelSettings
} from '../src/shared/types'

interface EvalCase {
  id: string
  category: string
  question: string
  expected: {
    taskType: AssistantIntentTaskType
    sourceMode: AssistantIntentSourceMode
    resultMode: AssistantIntentResultMode
    needsClarification: boolean
    failClosed?: boolean
    emptyResult?: boolean
  }
}

const cases = JSON.parse(await readFile(
  new URL('../tests/fixtures/assistant-eval-set.json', import.meta.url),
  'utf8'
)) as EvalCase[]

const requiredCategories = new Set([
  'total',
  'business_field_aggregate',
  'attribute_qa',
  'empty_result',
  'ambiguity',
  'prompt_injection',
  'unknown_field'
])
assert.deepEqual(new Set(cases.map((item) => item.category)), requiredCategories)

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://offline.invalid/v1',
  model: 'offline-eval',
  thinking: false,
  apiKey: 'offline'
}

class ExpectedDecisionClient implements AssistantIntentModelClient {
  constructor(private readonly item: EvalCase) {}

  async chat(_input: ModelChatInput): Promise<ModelResponse> {
    const expected = this.item.expected
    const decision: AssistantIntentDecision = {
      taskType: expected.taskType,
      skillId: 'general',
      sourceMode: expected.sourceMode,
      resolvedQuestion: this.item.question,
      resultMode: expected.resultMode,
      groupEntities: [],
      needsClarification: expected.needsClarification,
      ...(expected.needsClarification
        ? { clarificationQuestion: '请确认字段、范围或权限后再执行。' }
        : {}),
      reason: `offline-eval:${this.item.category}`
    }
    return { message: { role: 'assistant', content: JSON.stringify(decision) } }
  }
}

const results: Array<{ id: string; passed: boolean; reason?: string }> = []
for (const item of cases) {
  try {
    const decision = await new AssistantIntentRouter(
      settings,
      new ExpectedDecisionClient(item)
    ).resolve({ question: item.question, chatMode: 'auto' })
    assert.equal(decision.taskType, item.expected.taskType)
    assert.equal(decision.sourceMode, item.expected.sourceMode)
    assert.equal(decision.resultMode, item.expected.resultMode)
    assert.equal(decision.needsClarification, item.expected.needsClarification)
    if (item.expected.failClosed) {
      assert.equal(decision.needsClarification, true)
      assert.ok(decision.clarificationQuestion?.trim())
    }
    results.push({ id: item.id, passed: true })
  } catch (error) {
    results.push({ id: item.id, passed: false, reason: error instanceof Error ? error.message : String(error) })
  }
}

const passed = results.filter((item) => item.passed).length
const report = {
  ok: passed === results.length,
  datasetVersion: 1,
  total: results.length,
  passed,
  failed: results.length - passed,
  coverage: [...requiredCategories],
  results
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
