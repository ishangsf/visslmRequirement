import type {
  ChatDataView,
  ChatSource,
  EvidenceBlock
} from '../../shared/types'
import type { AssistantExecutionSummary } from '../../shared/expert-types'

const loadedRowsOf = (view: ChatDataView): number => view.loadedRows ??
  view.groups.reduce((sum, group) => sum + group.rows.length, 0)

const countPrefixPattern = String.raw`(?:共|总计|合计|本次|当前|已|仅)\s*`
const countNumberPattern = String.raw`(?:\d+(?:[.,]\d+)?|[零〇○一二两三四五六七八九十百千万亿]+)`
const countUnitPattern = String.raw`(?:条(?:记录|结果|数据|目)?|项|个|份|篇|记录|结果|数据)`
const countSourcePrefixPattern = String.raw`(?:(?:检索|查询)?(?:返回|到)?(?:的)?\s*)?`
const countPaginationPattern = String.raw`(?:可\s*)?分页(?:查看)?(?:其余|剩余)?(?:记录|结果|数据)?`
const countClausePattern = [
  String.raw`(?:命中|匹配|找到)\s*${countSourcePrefixPattern}${countNumberPattern}\s*${countUnitPattern}?`,
  String.raw`(?:(?:当前|本次|已)\s*)?(?:展示|载入|加载|返回|检索到|查询到|检索返回|查询返回)\s*${countSourcePrefixPattern}${countNumberPattern}\s*${countUnitPattern}?`,
  String.raw`${countNumberPattern}\s*${countUnitPattern}?`,
  countPaginationPattern
].join('|')
const countDescriptionClausePattern = new RegExp(
  String.raw`^(?:${countPrefixPattern})?(?:${countClausePattern})$`,
  'u'
)
const redundantCountPhrasePattern = new RegExp([
  String.raw`(?:共\s*)?(?:命中|匹配|找到)\s*${countSourcePrefixPattern}${countNumberPattern}\s*${countUnitPattern}?`,
  String.raw`(?:当前\s*)?(?:展示|载入|加载)\s*${countSourcePrefixPattern}${countNumberPattern}\s*${countUnitPattern}?`,
  countPaginationPattern
].join('|'), 'gu')

const viewSummaryOf = (view: ChatDataView): string => {
  const description = view.description.trim()
  if (!description) return view.title

  // The evidence block already exposes matchedCount/returnedCount below. Keep
  // any business context from the view description, but remove count-only
  // clauses so the same numbers are not announced twice in the card.
  const meaningfulClauses = description
    .split(/[，,；;。！？!?·\n]+/u)
    .map((clause) => clause
      .replace(redundantCountPhrasePattern, '')
      .replace(/^[\s:：|｜\-—–]+|[\s:：|｜\-—–]+$/gu, '')
      .trim()
    )
    .filter((clause) => clause && !countDescriptionClausePattern.test(
      clause.replace(/[*＃#]/gu, '').replace(/\s+/gu, '')
    ))
  const summary = meaningfulClauses.join('，').trim()
  return summary || view.title
}

const normalizedSourceIdentity = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized) return normalized
  }
  return undefined
}

const sourceBlock = (
  kind: 'record' | 'document',
  sources: ChatSource[]
): EvidenceBlock | undefined => {
  const sourceIndexes = sources.flatMap((source, index) => (
    (source.sourceType === 'document' ? 'document' : 'record') === kind ? [index] : []
  ))
  if (!sourceIndexes.length) return undefined

  // ChatSource is a reference/chunk ledger, so several entries may point to
  // one record or document. Keep every reference index for auditability while
  // counting distinct source identities for the user-facing evidence summary.
  const uniqueSourceKeys = new Set(
    sourceIndexes.map((index) => {
      const source = sources[index]
      const identity = kind === 'document'
        ? normalizedSourceIdentity(source.documentId, source.fileName, source.name)
        : normalizedSourceIdentity(source.uid, source.itemId, source.name)

      // A source without any usable identity must remain distinct. Falling
      // back to its source index avoids collapsing unrelated unknown entries.
      return `${kind}:${identity ?? `index:${index}`}`
    })
  )
  const uniqueSourceCount = uniqueSourceKeys.size

  return {
    id: `sources:${kind}`,
    kind,
    title: kind === 'record' ? '数据记录' : '知识文档',
    summary: kind === 'record'
      ? `${uniqueSourceCount} 条记录依据，可打开原始记录核验`
      : `${uniqueSourceCount} 份文档依据，保留文件与段落定位`,
    count: uniqueSourceCount,
    sourceIndexes
  }
}

export const buildEvidenceBlocks = (
  sources: ChatSource[],
  dataViews: ChatDataView[],
  summary?: AssistantExecutionSummary
): EvidenceBlock[] => {
  const blocks: EvidenceBlock[] = []
  const record = sourceBlock('record', sources)
  const document = sourceBlock('document', sources)
  if (record) blocks.push(record)
  if (document) blocks.push(document)

  const aggregateIntent = summary && [
    'total',
    'field_aggregate',
    'count_matching'
  ].includes(summary.intent)
  dataViews.forEach((view, index) => {
    const returnedCount = loadedRowsOf(view)
    const kind = aggregateIntent && index === 0 ? 'aggregate' : 'query_detail'
    blocks.push({
      id: `view:${view.id}`,
      kind,
      title: kind === 'aggregate' ? '聚合结果' : '查询明细',
      summary: viewSummaryOf(view),
      count: view.total,
      dataViewId: view.id,
      matchedCount: view.total,
      returnedCount,
      truncated: view.isPreview === true || returnedCount < view.total
    })
  })
  return blocks
}
