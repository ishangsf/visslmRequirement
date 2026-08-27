import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildAssistantClarificationOptions } from '../src/main/assistant/clarification-options'

const root = resolve(import.meta.dirname, '..')
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

const renderer = read('src/renderer/src/App.tsx')
const styles = read('src/renderer/src/styles.css')
const main = read('src/main/index.ts')
const dataCenterAgent = read('src/main/assistant/agents/data-center-agent.ts')
const preload = read('src/preload/index.ts')
const sharedTypes = read('src/shared/types.ts')
const expertTypes = read('src/shared/expert-types.ts')

for (const removedFile of [
  'src/main/assistant/execution-plan.ts',
  'src/main/assistant/plan-confirmation.ts',
  'tests/assistant-execution-plan-confirmation-regression.ts'
]) {
  assert.equal(existsSync(resolve(root, removedFile)), false, `${removedFile} 应已移除`)
}

for (const [name, source] of [
  ['renderer', renderer],
  ['styles', styles],
  ['main', main],
  ['preload', preload],
  ['shared types', sharedTypes],
  ['expert events', expertTypes]
] as const) {
  assert.doesNotMatch(source, /confirmAgentPlan|agent:confirm-plan|AssistantExecutionPlanCard|agent-plan-card|requiresConfirmation/u, `${name} 不得残留执行计划确认功能`)
}

assert.match(sharedTypes, /interface AssistantClarificationOption[\s\S]*action: AssistantClarificationOptionAction/u)
assert.match(sharedTypes, /clarificationOptions\?: AssistantClarificationOption\[\]/u)
assert.match(main, /buildAssistantClarificationOptions/u)
assert.match(renderer, /message\.clarificationOptions\?\.length/u)
assert.match(renderer, /option\.action === 'submit'[\s\S]*void send\(option\.prompt\)/u)
assert.match(renderer, /setQuestion\(option\.prompt\)/u)
assert.match(styles, /\.chat-clarification-options[\s\S]*var\(--accent\)/u)
assert.doesNotMatch(
  dataCenterAgent,
  /字段过滤：|检索词：\$\{plan\.searchTerms/u,
  '计数回答不得把内部字段 Key 或查询表达式展示给用户'
)

const generic = buildAssistantClarificationOptions({
  originalQuestion: '请处理一下',
  clarificationQuestion: '你希望我处理什么？'
})
assert.equal(generic.length, 3)
assert.deepEqual(generic.map((option) => option.label), [
  '查询数据记录',
  '查找知识资料',
  '直接回答问题'
])

const records = buildAssistantClarificationOptions({
  originalQuestion: '统计相关需求',
  clarificationQuestion: '要统计哪些需求？',
  intent: {
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: '统计相关需求',
    resultMode: 'answer',
    groupEntities: [],
    needsClarification: true,
    reason: 'missing-business-target'
  }
})
assert.equal(records.length, 3)
assert.ok(records.some((option) => option.action === 'submit'))
assert.ok(records.some((option) => option.action === 'compose'))

for (const option of [...generic, ...records]) {
  assert.ok(option.id.trim())
  assert.ok(option.label.trim())
  assert.ok(option.prompt.trim())
  assert.doesNotMatch(`${option.label} ${option.description ?? ''}`, /taskType|sourceMode|resultMode|字段\s*key|内部计划/ui)
}

console.log(JSON.stringify({
  ok: true,
  checks: [
    'execution-plan confirmation files and contracts removed',
    'clarification option contract shared across main and renderer',
    'selectable choices support immediate submit and composer completion',
    'business labels and count answers do not expose internal routing or query fields'
  ]
}, null, 2))
