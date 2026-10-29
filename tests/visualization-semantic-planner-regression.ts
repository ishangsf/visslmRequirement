import assert from 'node:assert/strict'
import { planVisualizationIntent } from '../src/main/experts/visualization-planner'
import { resolveDashboardDomainRequest } from '../src/main/experts/dashboard-domain-request'
import { workLogForStatus } from '../src/main/assistant/work-log'
import type { ModelChatInput } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

const settings: ModelSettings = { source: 'local', provider: 'ollama', baseUrl: 'http://localhost', model: 'mock', thinking: false }
const none = { mode: 'generate', scenario: 'none', role: 'none', sampleBaseline: false, recordOrigin: 'inherit' }
const plan = async (question: string, active: boolean, outputs: unknown[]) => {
  const calls: ModelChatInput[] = []
  const result = await planVisualizationIntent(question, active, undefined, settings, { chat: async input => {
    calls.push(input)
    return { message: { role: 'assistant', content: JSON.stringify(outputs[Math.min(calls.length - 1, outputs.length - 1)]) } }
  } })
  return { result, calls }
}
for (const question of ['不要套用项目综合态势模板', 'Create a new dashboard while keeping the old one', '保留柱状图，不要改成饼图']) {
  const { result, calls } = await plan(question, true, [none])
  assert.equal(result.mode, 'generate')
  assert.equal(result.domainSelection, undefined)
  assert.equal(calls.length, 1)
}
const repaired = await plan('修改图表', false, [{ ...none, mode: 'patch' }, none])
assert.equal(repaired.calls.length, 2)
assert.match(repaired.calls[1].messages.at(-1)!.content, /validationError/)
await assert.rejects(plan('创建图表', false, [{ ...none, scenario: 'unregistered' }]), /目录/)
await assert.rejects(plan('创建图表', false, [{ ...none, sampleBaseline: true, sampleEvidence: '受控样例' }]), /用户依据/)
const chosen = await plan('使用受控样例创建项目负责人的项目态势图表', false, [{ ...none, scenario: 'project-overview', role: 'project-owner', sampleBaseline: true, sampleEvidence: '受控样例' }])
assert.equal(chosen.result.domainSelection?.tailoringBaselineId, 'sample-tailoring-baseline-v1')
assert.equal(resolveDashboardDomainRequest('项目负责人基于受控样例生成项目综合态势大屏', {}).recognized, false)
assert.equal(workLogForStatus('plan', '执行准备已完成').status, 'running', 'display words must not set completion')
assert.equal(workLogForStatus('plan', '任意文本', 'completed').status, 'completed')
console.log(JSON.stringify({ ok: true, checks: ['semantic mode', 'no keyword template selection', 'bounded repair', 'sample authorization', 'typed progress'] }))
