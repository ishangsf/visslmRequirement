import type {
  ChatDataView,
  ChatSource,
  EvidenceBlock
} from '../../shared/types'
import type { AssistantExecutionSummary } from '../../shared/expert-types'

const loadedRowsOf = (view: ChatDataView): number => view.loadedRows ??
  view.groups.reduce((sum, group) => sum + group.rows.length, 0)

const sourceBlock = (
  kind: 'record' | 'document',
  sources: ChatSource[]
): EvidenceBlock | undefined => {
  const sourceIndexes = sources.flatMap((source, index) => (
    (source.sourceType === 'document' ? 'document' : 'record') === kind ? [index] : []
  ))
  if (!sourceIndexes.length) return undefined
  return {
    id: `sources:${kind}`,
    kind,
    title: kind === 'record' ? '数据记录' : '知识文档',
    summary: kind === 'record'
      ? `${sourceIndexes.length} 条记录依据，可打开原始记录核验`
      : `${sourceIndexes.length} 份文档依据，保留文件与段落定位`,
    count: sourceIndexes.length,
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
      summary: view.description || view.title,
      count: view.total,
      dataViewId: view.id,
      matchedCount: view.total,
      returnedCount,
      truncated: view.isPreview === true || returnedCount < view.total
    })
  })
  return blocks
}
