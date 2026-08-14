import type { DashboardSpec } from './dashboard'
import type { DataScope } from './query-spec'

export type ExpertId = 'general' | 'visualization' | 'requirement-analysis'

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

export type AgentEvent =
  | { type: 'status'; stage: string; message: string; progress?: AgentProgress }
  | { type: 'text'; content: string }
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
