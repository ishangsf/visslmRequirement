import {
  extractRequirementAnalysisIds,
  MAX_DIRECT_REQUIREMENT_IDS
} from './requirement-analysis-agent'
import type { ChatHistoryTurn } from '../../shared/types'

export type AutoChatRoute = 'plain' | 'general' | 'visualization' | 'requirement-analysis'

const requirementFollowupPattern = /这些|上述|刚才|前面|它们|该(?:需求|记录)|上一轮|上面/u
const explicitVisualizationPattern = /@数据可视化专家(?:\s|$)/u
const explicitGeneralPattern = /@通用数据助手(?:\s|$)/u
const explicitRequirementPattern = /@需求分析专家(?:\s|$)/u
const visualizationIntentPattern = /(?:生成|创建|新建|制作|构建|绘制|展示|修改|调整).{0,36}(?:可视化|大屏|看板|驾驶舱)|(?:可视化|大屏|看板|驾驶舱).{0,36}(?:生成|创建|新建|制作|构建|绘制|展示|修改|调整)/u

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
  if (!requirementFollowupPattern.test(question)) return []
  return idsFromHistory(history)
}

export const resolveAutoChatRoute = (
  question: string,
  history?: readonly ChatHistoryTurn[]
): AutoChatRoute => {
  // Explicit mentions are resolved before every heuristic. This keeps an
  // explicit expert choice authoritative even when the same message contains
  // a requirement ID or data vocabulary.
  if (explicitVisualizationPattern.test(question)) return 'visualization'
  if (explicitRequirementPattern.test(question)) return 'requirement-analysis'
  if (explicitGeneralPattern.test(question)) return 'general'
  if (autoRequirementIds(question, history).length) return 'requirement-analysis'
  if (visualizationIntentPattern.test(question)) return 'visualization'
  // Auto mode always falls through to the unified planner. It can classify
  // conversation, records, knowledge and mixed requests without relying on a
  // fixed vocabulary or language-specific keyword list. PlainChatAgent remains
  // available when the user explicitly selects plain mode.
  return 'general'
}
