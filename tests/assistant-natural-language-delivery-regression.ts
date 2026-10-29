import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import type { AssistantIntentDecision, ModelSettings } from '../src/shared/types'

const settings: ModelSettings = { source: 'online', provider: 'openai-compatible', baseUrl: 'https://example.invalid', model: 'mock', thinking: false }
for (const [question, format] of [
  ['整理这些事项为工作簿', 'xlsx'],
  ['Create a document from the verified results', 'docx'],
  ['把刚才的证据整理成演示材料', 'pptx'],
  ['我只想讨论Excel文件评审，别生成文件', undefined]
] as const) {
  const decision: AssistantIntentDecision = { taskType: 'record_query', skillId: 'general', sourceMode: 'records',
    resultMode: 'list', resolvedQuestion: question, groupEntities: [], needsClarification: false, reason: 'semantic fixture',
    ...(format ? { delivery: { format, instructions: question, referencesPriorResult: true } } : {}) }
  const router = new AssistantIntentRouter(settings, { chat: async (input) => {
    assert.equal(JSON.parse(input.messages[1].content).currentQuestion, question, 'delivery wording must not be stripped before semantic planning')
    return { message: { role: 'assistant', content: JSON.stringify(decision) } }
  } })
  const result = await router.resolve({ question })
  assert.equal(result.delivery?.format, format)
  assert.equal(result.taskType, 'record_query', 'preview intent does not authorize artifact generation')
}
const renderer = await readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
assert.doesNotMatch(renderer, /resolveNaturalLanguageDeliveryIntent|isNaturalLanguageDeliveryReference/)
assert.match(renderer, /response\.assistantIntent\?\.delivery/)
assert.match(renderer, /const queryQuestion = text/)
console.log(JSON.stringify({ ok: true, checks: ['semantic format selection', 'negative file mentions', 'original wording retained', 'preview separate from generation'] }))
