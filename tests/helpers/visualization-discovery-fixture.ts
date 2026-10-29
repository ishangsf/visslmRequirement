import { ModelClient } from '../../src/main/model-client'

// Existing deterministic rendering/patch fixtures do not test goal planning.
// Keep their provider fixtures scoped to composition; new workflow tests exercise discovery itself.
const chat = ModelClient.prototype.chat
ModelClient.prototype.chat = async function (input) {
  if (input.messages[0]?.content.startsWith('visualization-discovery-v1')) {
    const { question } = JSON.parse(input.messages[1].content)
    return { message: { role: 'assistant', content: JSON.stringify({ goals: [{ id: 'fixture-goal', question, fields: [], dimensionFields: [] }], assumptions: ['确定性组件测试：业务目标由独立工作流测试覆盖'] }) } }
  }
  return chat.call(this, input)
}
