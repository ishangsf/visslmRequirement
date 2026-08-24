import {
  extractRequirementAnalysisIds,
  MAX_DIRECT_REQUIREMENT_IDS
} from './requirement-analysis-agent'
import type { ChatHistoryTurn } from '../../shared/types'

export type AutoChatRoute = 'plain' | 'general' | 'requirement-analysis'

const dataIntentPattern = /本地|数据|记录|知识库|字段|统计|数量|多少|查询|检索|查找|任务|项目|需求|编号|来源|状态|负责人|图片/u
const requirementFollowupPattern = /这些|上述|刚才|前面|它们|该(?:需求|记录)|上一轮|上面/u

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
  if (autoRequirementIds(question, history).length) return 'requirement-analysis'
  return dataIntentPattern.test(question) ? 'general' : 'plain'
}
