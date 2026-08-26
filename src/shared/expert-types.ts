import type { DashboardSpec } from './dashboard'
import type { DataScope } from './query-spec'

export type ExpertId =
  | 'general'
  | 'knowledge-base'
  | 'visualization'
  | 'requirement-analysis'
  | 'artifact'

export interface ExpertDefinition {
  id: ExpertId
  name: string
  mention: string
  description: string
  icon: string
  capabilities: string[]
  allowedTools: string[]
  systemPromptVersion: string
}

export interface AgentMatchProgress {
  hasMatch: boolean
  recallTotal?: number
  rerankCurrent?: number
  rerankTotal?: number
  scoredCurrent?: number
  scoredTotal?: number
  explanationDone?: number
  explanationTotal?: number
  cacheHits?: number
  isolated?: number
}

export interface AgentProgress {
  percent: number
  currentItem: number
  totalItems: number
  completedItems: number
  stageCurrent?: number
  stageTotal?: number
  match?: AgentMatchProgress
}

export interface AssistantExecutionSummary {
  question: string
  taskType: string
  sourceMode: 'conversation' | 'records' | 'knowledge' | 'mixed'
  resultMode: 'answer' | 'list' | 'grouped_list' | 'table' | 'dashboard'
  intent: string
  searchTerms: string[]
  fields: string[]
  filters: Array<{ field: string; operator: string; value?: string }>
  /** Fixed execution semantics retained for plan confirmation and audit. */
  groupEntities?: string[]
  searchMode?: 'any' | 'all'
  groupByField?: string
  sort?: { field: string; direction: 'asc' | 'desc' }
  limit: number
  scope: {
    projectIds: string[]
    nodeTypes: string[]
    recordCount?: number
    baseFilters: Array<{ field: string; operator: string; value?: string }>
    snapshotAt?: string
  }
}

export type AgentEvent =
  | {
      type: 'status'
      stage: string
      message: string
      progress?: AgentProgress
      /** Auditable control metadata; never derived from status prose. */
      metadata?: {
        expertId?: ExpertId
        taskType?: string
        sourceMode?: string
        resultMode?: string
        followUp?: boolean
        clarificationQuestion?: string
      }
    }
  | {
      type: 'text'
      /** A visible answer delta.  Legacy producers may omit sequencing fields. */
      content: string
      sequence?: number
      done?: boolean
      /** Replace the currently buffered answer with content. */
      replace?: boolean
      /** Alias for clients that call replacement a reset. */
      reset?: boolean
    }
  | {
      type: 'plan'
      summary: AssistantExecutionSummary
      requiresConfirmation: true
    }
  | { type: 'artifact'; artifactId: string; version: number; dashboard: DashboardSpec }
  | {
      type: 'error'
      code: string
      message: string
      recoverable: boolean
      stage?: string
      attemptCount?: number
    }

export interface AgentProgressUpdate {
  /** The assistant run that emitted this update; stale events can be ignored. */
  runId: string
  conversationId?: string
  event: AgentEvent
}

export interface ExpertRouteInput {
  question: string
  expertId?: ExpertId
  conversationId?: string
  entrypoint?: 'chat' | 'dashboard'
  dataScope?: DataScope
}

export interface ExpertRouteResult {
  expert: ExpertDefinition
  reason: 'explicit-mention' | 'entrypoint' | 'request' | 'conversation' | 'default'
  question: string
}
