import {
  extractRequirementAnalysisIds,
  MAX_DIRECT_REQUIREMENT_IDS
} from './requirement-analysis-agent'
import type { ChatHistoryTurn } from '../../shared/types'

export type AutoChatRoute = 'plain' | 'general' | 'visualization' | 'requirement-analysis'

const explicitVisualizationPattern = /@数据可视化专家(?:\s|$)/u
const explicitGeneralPattern = /@通用数据助手(?:\s|$)/u
const explicitRequirementPattern = /@需求分析专家(?:\s|$)/u

const userHistory = (history: readonly ChatHistoryTurn[] | undefined): ChatHistoryTurn[] => (
  (history ?? []).filter((message) => message.role === 'user')
)

const idsFromHistory = (history: readonly ChatHistoryTurn[] | undefined): string[] => {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const message of userHistory(history).reverse()) {
    for (const id of extractRequirementAnalysisIds(message.content, MAX_DIRECT_REQUIREMENT_IDS)) {
      const key = id.toLocaleLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      ids.push(id)
    }
    if (ids.length) break
  }
  return ids
}

export const autoRequirementQuestion = (
  question: string,
  history?: readonly ChatHistoryTurn[]
): string | null => {
  const ids = autoRequirementIds(question, history)
  return ids.length ? question : null
}

export const autoRequirementIds = (
  question: string,
  history?: readonly ChatHistoryTurn[]
): string[] => {
  const currentIds = extractRequirementAnalysisIds(question, MAX_DIRECT_REQUIREMENT_IDS)
  if (currentIds.length) return currentIds
  // Called only after semantic routing selected requirement matching.
  return idsFromHistory(history)
}

export const resolveAutoChatRoute = (
  question: string,
  history?: readonly ChatHistoryTurn[]
): AutoChatRoute => {
  // Explicit mentions are parsed as commands. This keeps an
  // explicit expert choice authoritative even when the same message contains
  // a requirement ID or data vocabulary.
  if (explicitVisualizationPattern.test(question)) return 'visualization'
  if (explicitRequirementPattern.test(question)) return 'requirement-analysis'
  if (explicitGeneralPattern.test(question)) return 'general'
  // Auto mode always falls through to the unified planner. It can classify
  // conversation, records, knowledge and mixed requests without relying on a
  // fixed vocabulary or language-specific keyword list. PlainChatAgent remains
  // available when the user explicitly selects plain mode.
  return 'general'
}
