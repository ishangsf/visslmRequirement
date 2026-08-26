import type { KnowledgeIndexProgress, KnowledgeStats } from './types'

export type AssistantWorkspaceReadinessState =
  | 'loading'
  | 'unavailable'
  | 'no_data'
  | 'indexing'
  | 'index_failed'
  | 'index_missing'
  | 'ready'

export interface AssistantWorkspaceReadinessInput {
  dataRecordCount?: number
  knowledgeStats?: KnowledgeStats | null
  liveProgress?: KnowledgeIndexProgress | null
  loadFailed?: boolean
}

export interface AssistantWorkspaceReadiness {
  state: AssistantWorkspaceReadinessState
  dataRecordCount: number
  documentCount: number
  indexedChunkCount: number
  progress?: KnowledgeIndexProgress
}

export function deriveAssistantWorkspaceReadiness(
  input: AssistantWorkspaceReadinessInput
): AssistantWorkspaceReadiness {
  const dataRecordCount = Math.max(0, Math.trunc(input.dataRecordCount ?? 0))
  const stats = input.knowledgeStats
  const documentCount = Math.max(0, Math.trunc(stats?.documentCount ?? 0))
  const indexedChunkCount = Math.max(0, Math.trunc(stats?.indexedChunkCount ?? 0))
  const progress = input.liveProgress ?? stats?.latestTask
  const base = {
    dataRecordCount,
    documentCount,
    indexedChunkCount,
    ...(progress ? { progress } : {})
  }

  if (input.loadFailed) return { state: 'unavailable', ...base }
  if (input.dataRecordCount === undefined || stats === undefined || stats === null) {
    return { state: 'loading', ...base }
  }
  if (progress?.status === 'running' || stats.processingCount > 0) {
    return { state: 'indexing', ...base }
  }
  if (progress?.status === 'failed' || (stats.failedCount > 0 && indexedChunkCount === 0)) {
    return { state: 'index_failed', ...base }
  }
  if (dataRecordCount === 0 && documentCount === 0) {
    return { state: 'no_data', ...base }
  }
  if (indexedChunkCount === 0) {
    return { state: 'index_missing', ...base }
  }
  return { state: 'ready', ...base }
}
