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
    capabilities: ['field-profile', 'query-spec', 'dashboard-spec', 'dashboard-patch'],
    allowedTools: ['list_field_profiles', 'execute_query', 'validate_dashboard_spec', 'patch_dashboard'],
    systemPromptVersion: 'visualization-v1'
  },
  {
    id: 'requirement-analysis',
    name: '需求分析专家',
    mention: '@需求分析专家',
    description: '按需求编号定位数据中心记录并匹配相似数据',
    icon: 'file-search',
    capabilities: ['requirement-lookup', 'record-similarity', 'match-explanation'],
    allowedTools: ['locate_requirement', 'rank_record_matches', 'review_requirement_matches'],
    systemPromptVersion: 'requirement-analysis-v1'
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
    const requirementAnalysis = byId.get('requirement-analysis')!
    const explicitVisualization = /@数据可视化专家(?:\s|$)/.test(input.question)
    const explicitGeneral = /@通用数据助手(?:\s|$)/.test(input.question)
    const explicitRequirementAnalysis = /@需求分析专家(?:\s|$)/.test(input.question)
    let result: ExpertRouteResult
    if (explicitVisualization) {
      result = {
        expert: visualization,
        reason: 'explicit-mention',
        question: input.question.replace(/@数据可视化专家\s*/g, '').trim()
      }
    } else if (explicitGeneral) {
      result = {
        expert: general,
        reason: 'explicit-mention',
        question: input.question.replace(/@通用数据助手\s*/g, '').trim()
      }
    } else if (explicitRequirementAnalysis) {
      result = {
        expert: requirementAnalysis,
        reason: 'explicit-mention',
        question: input.question.replace(/@需求分析专家\s*/g, '').trim()
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
