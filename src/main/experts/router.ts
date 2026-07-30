import type {
  ExpertDefinition,
  ExpertId,
  ExpertRouteInput,
  ExpertRouteResult
} from '../../shared/expert-types'

export const expertRegistry: readonly ExpertDefinition[] = [
  {
    id: 'general',
    name: '通用数据助手',
    mention: '@通用数据助手',
    description: '检索、统计和解释本地 VISSLM 数据',
    icon: 'robot',
    capabilities: ['search', 'question-answering', 'record-analysis'],
    allowedTools: ['search_records', 'get_record_detail', 'aggregate_records'],
    systemPromptVersion: 'general-v1'
  },
  {
    id: 'visualization',
    name: '数据可视化专家',
    mention: '@数据可视化专家',
    description: '基于本地数据生成可追溯的可视化大屏',
    icon: 'dashboard',
    capabilities: ['field-profile', 'query-spec', 'dashboard-spec'],
    allowedTools: ['list_field_profiles', 'execute_query', 'validate_dashboard_spec'],
    systemPromptVersion: 'visualization-v1'
  }
] as const

const byId = new Map<ExpertId, ExpertDefinition>(
  expertRegistry.map((expert) => [expert.id, expert])
)

export class ExpertRouter {
  private readonly conversationExperts = new Map<string, ExpertId>()

  route(input: ExpertRouteInput): ExpertRouteResult {
    const visualization = byId.get('visualization')!
    const general = byId.get('general')!
    const explicitVisualization = /@数据可视化专家(?:\s|$)/.test(input.question)
    let result: ExpertRouteResult
    if (explicitVisualization) {
      result = {
        expert: visualization,
        reason: 'explicit-mention',
        question: input.question.replace(/@数据可视化专家\s*/g, '').trim()
      }
    } else if (input.entrypoint === 'dashboard') {
      result = { expert: visualization, reason: 'entrypoint', question: input.question.trim() }
    } else if (input.expertId) {
      result = {
        expert: byId.get(input.expertId) ?? general,
        reason: 'request',
        question: input.question.trim()
      }
    } else if (input.conversationId && this.conversationExperts.has(input.conversationId)) {
      result = {
        expert: byId.get(this.conversationExperts.get(input.conversationId)!) ?? general,
        reason: 'conversation',
        question: input.question.trim()
      }
    } else {
      result = { expert: general, reason: 'default', question: input.question.trim() }
    }
    if (input.conversationId) this.conversationExperts.set(input.conversationId, result.expert.id)
    return result
  }
}
