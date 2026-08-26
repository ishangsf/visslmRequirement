import type {
  AssistantExecutionAgentId,
  AssistantIntentDecision,
  AssistantIntentSourceMode,
  AssistantIntentTaskType
} from '../../shared/types'

export interface AssistantExecutionAgentDefinition {
  id: AssistantExecutionAgentId
  name: string
  version: string
  supportedTaskTypes: AssistantIntentTaskType[]
  allowedSources: AssistantIntentSourceMode[]
  allowedTools: string[]
  readonly: boolean
  capabilities: string[]
}

/**
 * Runtime execution agents are deliberately separate from the three UI
 * experts. The general expert is a planner/skill identity; it is never an
 * evidence executor by itself.
 */
export const assistantExecutionAgentRegistry: readonly AssistantExecutionAgentDefinition[] = [
  {
    id: 'conversation',
    name: 'Conversation Agent',
    version: 'conversation-v1',
    supportedTaskTypes: ['conversation'],
    allowedSources: ['conversation'],
    allowedTools: [],
    readonly: true,
    capabilities: ['bounded-history-response', 'general-explanation']
  },
  {
    id: 'data-center',
    name: 'Data Center Agent',
    version: 'data-center-v1',
    supportedTaskTypes: ['record_query', 'mixed_analysis', 'visualization', 'requirement_matching'],
    allowedSources: ['records', 'mixed'],
    allowedTools: [
      'inspect_fields',
      'search_records',
      'query_records_by_fields',
      'get_record_detail',
      'aggregate_records',
      'aggregate_by_field'
    ],
    readonly: true,
    capabilities: [
      'field-catalog',
      'full-candidate-structured-query',
      'aggregate',
      'paged-data-view',
      'record-provenance'
    ]
  },
  {
    id: 'knowledge-base',
    name: 'Knowledge Base Agent',
    version: 'knowledge-base-v1',
    supportedTaskTypes: ['knowledge_qa', 'mixed_analysis'],
    allowedSources: ['knowledge', 'mixed'],
    allowedTools: ['search_document_chunks'],
    readonly: true,
    capabilities: ['document-only-retrieval', 'bounded-evidence', 'document-provenance']
  },
  {
    id: 'requirement-analysis',
    name: 'Requirement Analysis Agent',
    version: 'requirement-analysis-v2',
    supportedTaskTypes: ['requirement_matching'],
    allowedSources: ['records'],
    allowedTools: [
      'locate_requirement',
      'hybrid_requirement_retrieval',
      'cross_encoder_rerank',
      'score_requirement_matches',
      'explain_requirement_matches'
    ],
    readonly: true,
    capabilities: ['requirement-lookup', 'hybrid-retrieval', 'deterministic-scoring']
  },
  {
    id: 'visualization',
    name: 'Visualization Agent',
    version: 'visualization-v1',
    supportedTaskTypes: ['visualization'],
    allowedSources: ['records'],
    allowedTools: ['list_field_profiles', 'execute_query', 'validate_dashboard_spec', 'patch_dashboard'],
    readonly: false,
    capabilities: ['field-profile', 'query-spec', 'dashboard-spec', 'dashboard-patch']
  }
] as const

export const assistantAgentRegistry = assistantExecutionAgentRegistry

const byId = new Map<AssistantExecutionAgentId, AssistantExecutionAgentDefinition>(
  assistantExecutionAgentRegistry.map((agent) => [agent.id, agent])
)

const routeAgents = (
  taskType: AssistantIntentTaskType,
  sourceMode: AssistantIntentSourceMode
): AssistantExecutionAgentId[] => {
  if (taskType === 'conversation' && sourceMode === 'conversation') return ['conversation']
  if (taskType === 'record_query' && sourceMode === 'records') return ['data-center']
  if (taskType === 'knowledge_qa' && sourceMode === 'knowledge') return ['knowledge-base']
  if (taskType === 'mixed_analysis' && sourceMode === 'mixed') {
    return ['data-center', 'knowledge-base']
  }
  if (taskType === 'visualization' && sourceMode === 'records') return ['visualization']
  if (taskType === 'requirement_matching' && sourceMode === 'records') {
    return ['requirement-analysis']
  }
  return []
}

export interface AssistantExecutionRoute {
  primaryAgent: AssistantExecutionAgentId
  agents: AssistantExecutionAgentDefinition[]
}

/**
 * Resolve and validate a complete task/source pair. An empty result is never
 * executable: callers must fail closed instead of falling back to general.
 */
export const resolveAssistantExecutionRoute = (
  taskType: AssistantIntentTaskType,
  sourceMode: AssistantIntentSourceMode
): AssistantExecutionRoute => {
  const ids = routeAgents(taskType, sourceMode)
  if (!ids.length) {
    throw new Error(`未注册的任务与来源组合：${taskType}/${sourceMode}`)
  }
  const agents = ids.map((id) => byId.get(id)).filter(
    (agent): agent is AssistantExecutionAgentDefinition => Boolean(agent)
  )
  if (agents.length !== ids.length) throw new Error('执行 Agent 注册表不完整')
  for (const agent of agents) {
    if (!agent.supportedTaskTypes.includes(taskType)) {
      throw new Error(`执行 Agent ${agent.id} 不支持任务 ${taskType}`)
    }
    if (!agent.allowedSources.includes(sourceMode)) {
      throw new Error(`执行 Agent ${agent.id} 不允许来源 ${sourceMode}`)
    }
  }
  return { primaryAgent: agents[0].id, agents }
}

export const validateAssistantExecutionRoute = (
  decision: Pick<AssistantIntentDecision, 'taskType' | 'sourceMode'>
): { ok: true; route: AssistantExecutionRoute } | { ok: false; error: string } => {
  try {
    return { ok: true, route: resolveAssistantExecutionRoute(decision.taskType, decision.sourceMode) }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export const getAssistantExecutionAgent = (
  id: AssistantExecutionAgentId
): AssistantExecutionAgentDefinition | undefined => byId.get(id)

/**
 * Tool calls are an execution boundary, so callers must validate them against
 * the registered agent before touching a database, index, or external
 * service. Keeping this check here makes an accidental cross-agent call fail
 * closed instead of silently widening an agent's authority.
 */
export const isAssistantAgentToolAllowed = (
  agentId: AssistantExecutionAgentId,
  toolName: string
): boolean => {
  const agent = getAssistantExecutionAgent(agentId)
  return Boolean(agent && agent.allowedTools.includes(toolName))
}

export const validateAssistantAgentTool = (
  agentId: AssistantExecutionAgentId,
  toolName: string
): { ok: true } | { ok: false; error: string } => {
  if (!getAssistantExecutionAgent(agentId)) {
    return { ok: false, error: `未注册的执行 Agent：${String(agentId)}` }
  }
  if (!isAssistantAgentToolAllowed(agentId, toolName)) {
    return { ok: false, error: `执行 Agent ${agentId} 不允许工具 ${toolName}` }
  }
  return { ok: true }
}

export const assertAssistantAgentToolAllowed = (
  agentId: AssistantExecutionAgentId,
  toolName: string
): void => {
  const validation = validateAssistantAgentTool(agentId, toolName)
  if (!validation.ok) throw new Error(validation.error)
}

// Explicit aliases keep the registry easy to discover for callers/tests that
// use the longer execution-agent terminology.
export const isAssistantExecutionAgentToolAllowed = isAssistantAgentToolAllowed
export const validateAssistantExecutionAgentTool = validateAssistantAgentTool
export const assertAssistantExecutionAgentToolAllowed = assertAssistantAgentToolAllowed
