import type { AssistantExecutionSummary } from '../../shared/expert-types'
import type { ChatRecoverySuggestion } from '../../shared/types'

const clean = (value: string): string => value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500)

export const buildSafeQueryRecoverySuggestions = (
  summary: AssistantExecutionSummary | undefined
): ChatRecoverySuggestion[] => {
  if (!summary || summary.sourceMode === 'conversation') return []
  const question = clean(summary.question)
  const fields = [...new Set([
    ...summary.fields,
    ...summary.filters.map((filter) => filter.field),
    ...summary.scope.baseFilters.map((filter) => filter.field)
  ].map(clean).filter(Boolean))].slice(0, 6)
  const terms = [...new Set(summary.searchTerms.map(clean).filter(Boolean))].slice(0, 6)
  const suggestions: ChatRecoverySuggestion[] = []

  suggestions.push({
    id: 'confirm_fields',
    label: fields.length ? '按已确认字段重试' : '先查看可用字段',
    prompt: fields.length
      ? `${question}。只使用这些已确认字段：${fields.join('、')}。如果字段仍不明确，请先向我确认。`
      : '请列出当前数据范围中可用于查询的业务字段、显示名和示例值，不要执行统计。',
    reason: fields.length ? '仅引用本轮真实字段目录中的字段' : '先读取字段目录，避免猜测字段名'
  })

  if (
    summary.scope.projectIds.length === 0 ||
    summary.scope.nodeTypes.length === 0 ||
    summary.scope.recordCount === undefined
  ) {
    suggestions.push({
      id: 'narrow_scope',
      label: '缩小数据范围',
      prompt: `请先确认项目、数据类型或时间范围，再重新执行：${question}`,
      reason: '减少全量扫描和同名字段歧义'
    })
  }

  suggestions.push({
    id: 'search_content',
    label: '切换正文检索',
    prompt: terms.length
      ? `请改为在记录正文中检索“${terms.join('、')}”，不要猜测不存在的结构化字段。`
      : `请改为在记录正文中检索这个问题涉及的原始词句：${question}`,
    reason: '结构化字段无法安全映射时使用原文证据'
  })
  return suggestions.slice(0, 3)
}
