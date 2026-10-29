import { ModelClient, type ModelChatInput, type ModelResponse } from '../model-client'
import type { ModelSettings } from '../../shared/types'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'
import type { DashboardDomainSelection } from './dashboard-domain-request'

export interface VisualizationIntentPlan {
  mode: 'generate' | 'patch'
  recordOrigin: 'inherit' | 'local' | 'platform'
  domainSelection?: DashboardDomainSelection
}

export const planVisualizationIntent = async (
  question: string, hasActiveArtifact: boolean, focusComponentId: string | undefined,
  settings: ModelSettings, client: { chat(input: ModelChatInput): Promise<ModelResponse> } = new ModelClient(settings)
): Promise<VisualizationIntentPlan> => {
  const roles = ['project-owner', 'qa-epg', 'rd-lead', 'model-org-manager'] as const
  const scenarios = dashboardDomainCatalog.scenarios.map(({ id, name, status }) => ({ id, name, status }))
  const messages: ModelChatInput['messages'] = [{ role: 'system', content: [
    '根据完整用户目的规划可视化入口，仅输出 JSON。不要因名词出现就触发业务模板。',
    'mode=generate 创建新大屏，patch 修改已附带的大屏。没有当前大屏时只能 generate。focusComponentId 是用户选中的修改对象。',
    'recordOrigin=platform 仅用于用户要求实时读取 VISSLM 平台，local 表示明确使用本地数据，inherit 表示沿用当前大屏或现有数据范围。不要把普通的平台概念问答当作实时读取。',
    '仅在用户的业务目标适合已注册领域模板时填写 scenario 和 role，否则 scenario=none。角色未知留 none，不猜权限。',
    'sampleBaseline=true 仅用于用户明确选择受控样例基线，同时提供 sampleEvidence 原文片段，不能因提到标准就自动用样例。'
  ].join('\n') }, { role: 'user', content: JSON.stringify({ question, hasActiveArtifact, focusComponentId, scenarios, roles }) }]
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await client.chat({ messages, think: false, temperature: 0, numPredict: 900, format: {
        type: 'object', additionalProperties: false, required: ['mode', 'scenario', 'role', 'sampleBaseline', 'recordOrigin'], properties: {
          mode: { type: 'string', enum: ['generate', 'patch'] }, scenario: { type: 'string', enum: ['none', ...scenarios.map((item) => item.id)] },
          recordOrigin: { type: 'string', enum: ['inherit', 'local', 'platform'] },
          role: { type: 'string', enum: ['none', ...roles] }, sampleBaseline: { type: 'boolean' }, sampleEvidence: { type: 'string' }
        }
      } })
      const raw = JSON.parse(response.message?.content ?? '')
      if (!['generate', 'patch'].includes(raw.mode) || (raw.mode === 'patch' && !hasActiveArtifact)) throw new Error('修改模式缺少当前大屏')
      if (!['inherit', 'local', 'platform'].includes(raw.recordOrigin)) throw new Error('数据来源无效')
      if (!['none', ...scenarios.map((item) => item.id)].includes(raw.scenario) || !['none', ...roles].includes(raw.role)) throw new Error('业务场景或角色不在目录中')
      if (typeof raw.sampleBaseline !== 'boolean' || (raw.sampleBaseline && (!raw.sampleEvidence || !question.includes(raw.sampleEvidence)))) throw new Error('样例基线缺少用户依据')
      return { mode: raw.mode, recordOrigin: raw.recordOrigin, ...(raw.scenario !== 'none' ? { domainSelection: {
        scenario: raw.scenario, ...(raw.role !== 'none' ? { role: raw.role } : {}),
        ...(raw.sampleBaseline ? { tailoringBaselineId: 'sample-tailoring-baseline-v1' } : {})
      } } : {}) }
    } catch (error) {
      if (attempt) throw error
      messages.push({ role: 'user', content: JSON.stringify({ validationError: String(error), instruction: '修正计划，不要切换到默认业务模板。' }) })
    }
  }
  throw new Error('可视化规划失败')
}
