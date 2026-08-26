import { randomUUID } from 'node:crypto'
import type {
  AssistantExecutionAgentId,
  AssistantIntentDecision,
  AssistantIntentResultMode,
  AssistantIntentSourceMode,
  AssistantIntentTaskType,
  AssistantTaskTrace,
  AssistantTaskTraceStatus,
  ChatResponse
} from '../../shared/types'
import { resolveAssistantExecutionRoute } from './agent-registry'
import { getAssistantRunContext } from './run-controller'

export interface AssistantTraceContext {
  taskType: AssistantIntentTaskType
  sourceMode: AssistantIntentSourceMode
  resultMode: AssistantIntentResultMode
  primaryAgent: AssistantExecutionAgentId
  invokedAgents: AssistantExecutionAgentId[]
}

const timestamp = (): string => new Date().toISOString()

export const traceContextFromDecision = (
  decision: Pick<AssistantIntentDecision, 'taskType' | 'sourceMode' | 'resultMode'>
): AssistantTraceContext => {
  const route = resolveAssistantExecutionRoute(decision.taskType, decision.sourceMode)
  return {
    taskType: decision.taskType,
    sourceMode: decision.sourceMode,
    resultMode: decision.resultMode,
    primaryAgent: route.primaryAgent,
    invokedAgents: route.agents.map((agent) => agent.id)
  }
}

export const createAssistantTaskTrace = (
  context: AssistantTraceContext,
  options: {
    startedAt?: string
    status?: AssistantTaskTraceStatus
    invokedAgents?: AssistantExecutionAgentId[]
    clarificationQuestion?: string
    error?: { code: string; message: string }
    runId?: string
  } = {}
): AssistantTaskTrace => ({
  runId: options.runId ?? getAssistantRunContext()?.runId ?? randomUUID(),
  status: options.status ?? 'completed',
  primaryAgent: context.primaryAgent,
  invokedAgents: options.status === 'clarification'
    ? []
    : [...(options.invokedAgents ?? context.invokedAgents)],
  taskType: context.taskType,
  sourceMode: context.sourceMode,
  resultMode: context.resultMode,
  startedAt: options.startedAt ?? timestamp(),
  completedAt: timestamp(),
  ...(options.clarificationQuestion ? { clarificationQuestion: options.clarificationQuestion } : {}),
  ...(options.error ? { error: options.error } : {})
})

export const attachAssistantTaskTrace = (
  response: ChatResponse,
  context: AssistantTraceContext,
  options: Parameters<typeof createAssistantTaskTrace>[1] = {}
): ChatResponse => ({
  ...response,
  taskTrace: createAssistantTaskTrace(context, options)
})
