import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildEvidenceBlocks } from '../src/main/assistant/evidence-block'
import type { AssistantExecutionSummary } from '../src/shared/expert-types'
import type { ChatDataView, ChatSource } from '../src/shared/types'

const checks: string[] = []
const sources: ChatSource[] = [
  { uid: 'record-1', name: '需求一', nodeType: 'Requirement', itemId: 'R-1', sourceType: 'record' },
  {
    uid: 'chunk-1',
    name: '制度说明.pdf',
    nodeType: 'KnowledgeDocument',
    itemId: 'DOC-1',
    sourceType: 'document',
    documentId: 'doc-1',
    chunkId: 'chunk-1',
    location: '第 2 页'
  }
]
const view: ChatDataView = {
  id: 'view-1',
  title: '负责人统计',
  description: '按负责人聚合',
  total: 55,
  loadedRows: 20,
  isPreview: true,
  fields: ['Owner'],
  recordUids: Array.from({ length: 55 }, (_, index) => `record-${index + 1}`),
  groups: [{ name: '全部', count: 55, rows: [] }]
}
const summary: AssistantExecutionSummary = {
  question: '按负责人统计',
  taskType: 'record_query',
  sourceMode: 'mixed',
  resultMode: 'table',
  intent: 'field_aggregate',
  searchTerms: [],
  fields: ['Owner'],
  filters: [],
  limit: 50,
  scope: { projectIds: ['project-a'], nodeTypes: ['Requirement'], baseFilters: [] }
}

// A response may carry one ChatSource per cited chunk/occurrence rather than
// one source per record/document.  EvidenceBlock.sourceIndexes must preserve
// every occurrence for the “回答依据” list, while count/summary describe the
// number of unique source identities shown by the card.
const repeatedSources: ChatSource[] = [
  {
    uid: 'record-repeat',
    name: '需求重复引用甲',
    nodeType: 'Requirement',
    itemId: 'R-REPEAT',
    sourceType: 'record',
    location: '字段：负责人'
  },
  {
    uid: 'record-repeat',
    name: '需求重复引用乙',
    nodeType: 'Requirement',
    itemId: 'R-REPEAT',
    sourceType: 'record',
    location: '字段：状态'
  },
  {
    uid: 'record-unique',
    name: '需求唯一引用',
    nodeType: 'Requirement',
    itemId: 'R-UNIQUE',
    sourceType: 'record',
    location: '字段：优先级'
  },
  ...Array.from({ length: 20 }, (_unused, index): ChatSource => ({
    uid: `document-source-${index + 1}`,
    name: '制度说明.pdf',
    nodeType: 'KnowledgeDocument',
    itemId: index < 10 ? 'DOC-A' : 'DOC-B',
    sourceType: 'document',
    documentId: index < 10 ? 'doc-repeat-a' : 'doc-repeat-b',
    chunkId: `chunk-${index + 1}`,
    location: `第 ${index + 1} 页`
  }))
]

const blocks = buildEvidenceBlocks(sources, [view], summary)
assert.deepEqual(blocks.map((block) => block.kind), ['record', 'document', 'aggregate'])
assert.deepEqual(blocks[0].sourceIndexes, [0])
assert.deepEqual(blocks[1].sourceIndexes, [1])
assert.equal(blocks[2].dataViewId, 'view-1')
assert.equal(blocks[2].matchedCount, 55)
assert.equal(blocks[2].returnedCount, 20)
assert.equal(blocks[2].truncated, true)
checks.push('record, document and aggregate evidence share one source-aware ledger')

const repeatedBlocks = buildEvidenceBlocks(repeatedSources, [], summary)
const repeatedRecordBlock = repeatedBlocks.find((block) => block.kind === 'record')
const repeatedDocumentBlock = repeatedBlocks.find((block) => block.kind === 'document')
assert.ok(repeatedRecordBlock, '重复记录引用必须生成记录证据卡')
assert.ok(repeatedDocumentBlock, '重复文档引用必须生成文档证据卡')
assert.deepEqual(repeatedRecordBlock?.sourceIndexes, [0, 1, 2])
assert.equal(repeatedRecordBlock?.count, 2, '记录卡数量必须按唯一 uid 计数，而不是引用次数')
assert.match(repeatedRecordBlock?.summary ?? '', /^2 条记录依据/u)
assert.deepEqual(
  repeatedDocumentBlock?.sourceIndexes,
  Array.from({ length: 20 }, (_unused, index) => index + 3),
  '文档卡必须保留同一 documentId 的全部引用索引'
)
assert.equal(repeatedDocumentBlock?.count, 2, '文档卡数量必须按唯一 documentId 计数，而不是 20 个引用')
assert.match(repeatedDocumentBlock?.summary ?? '', /^2 份文档依据/u)
checks.push('record/document evidence counts use unique uid/documentId identities while preserving every citation index')

const queryBlocks = buildEvidenceBlocks([], [{ ...view, isPreview: false, total: 20 }], {
  ...summary,
  intent: 'filter_records'
})
assert.equal(queryBlocks[0].kind, 'query_detail')
assert.equal(queryBlocks[0].truncated, false)
checks.push('query details preserve matched, loaded and truncation truth')

const quantityOnlyView: ChatDataView = {
  ...view,
  id: 'view-quantity-only',
  title: '负责人统计结果',
  description: '55',
  total: 55,
  loadedRows: 55,
  isPreview: false
}
const quantityOnlyBlocks = buildEvidenceBlocks([], [quantityOnlyView], {
  ...summary,
  intent: 'filter_records'
})
assert.equal(quantityOnlyBlocks[0]?.kind, 'query_detail')
assert.equal(
  quantityOnlyBlocks[0]?.summary,
  quantityOnlyView.title,
  '纯数量描述不能成为查询明细卡的摘要，应回退到视图标题'
)
checks.push('query detail evidence falls back to its title when the view description is only a quantity')

const [mainSource, rendererSource, sharedSource] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
])
assert.match(mainSource, /buildEvidenceBlocks\(/)
assert.match(rendererSource, /回答证据区/)
assert.match(rendererSource, /message\.evidenceBlocks\.map/)
assert.match(sharedSource, /EvidenceBlockKind\s*=\s*'record'\s*\|\s*'document'\s*\|\s*'aggregate'\s*\|\s*'query_detail'/)

const evidenceCardBodyStart = rendererSource.indexOf('const body = (')
const evidenceCardReturnMatch = rendererSource
  .slice(evidenceCardBodyStart)
  .match(/return\s+(?:view|canOpen)\s*\?\s*\(/)
const evidenceCardBodyEnd = evidenceCardReturnMatch?.index === undefined
  ? -1
  : evidenceCardBodyStart + evidenceCardReturnMatch.index
assert.ok(evidenceCardBodyStart >= 0 && evidenceCardBodyEnd > evidenceCardBodyStart, '查询明细证据卡必须有稳定的渲染主体')
const evidenceCardBody = rendererSource.slice(evidenceCardBodyStart, evidenceCardBodyEnd)
const hasExplicitEvidenceSlots = (
  /chat-evidence-block-icon/.test(evidenceCardBody) &&
  /chat-evidence-block-copy/.test(evidenceCardBody) &&
  /chat-evidence-block-meta/.test(evidenceCardBody)
)
const hasDataSlotEvidenceSlots = (
  /data-slot\s*=\s*['"]icon['"]/.test(evidenceCardBody) &&
  /data-slot\s*=\s*['"]copy['"]/.test(evidenceCardBody) &&
  /data-slot\s*=\s*['"]meta['"]/.test(evidenceCardBody)
)
assert.equal(
  hasExplicitEvidenceSlots || hasDataSlotEvidenceSlots,
  true,
  '证据卡需要显式 icon/copy/meta 槽位，避免依赖脆弱的子元素位置选择器'
)
assert.equal(
  (evidenceCardBody.match(/<em\b/g) ?? []).length,
  1,
  '证据卡的数量/核验提示只能有一个明确的 meta 输出位'
)
checks.push('EvidenceBlock is persisted and rendered through the shared response contract')

const evidenceGridStart = rendererSource.indexOf('<div className="chat-evidence-block-grid">')
const sourceListClassOffset = rendererSource.indexOf('className="source-list"', evidenceGridStart)
const sourceListStart = sourceListClassOffset < 0
  ? -1
  : rendererSource.lastIndexOf('<details', sourceListClassOffset)
const sourceListOpeningEnd = sourceListStart < 0
  ? -1
  : rendererSource.indexOf('>', sourceListClassOffset)
const sourceListEnd = sourceListOpeningEnd < 0
  ? -1
  : rendererSource.indexOf('</details>', sourceListOpeningEnd)
assert.ok(
  evidenceGridStart >= 0 && sourceListStart > evidenceGridStart && sourceListOpeningEnd > sourceListStart && sourceListEnd > sourceListOpeningEnd,
  '证据卡与同消息回答依据 details 必须保持可定位的渲染边界'
)

const evidenceNavigationSource = rendererSource.slice(evidenceGridStart, sourceListStart)
const openEvidenceStart = evidenceNavigationSource.indexOf('const openEvidence')
const openEvidenceEnd = openEvidenceStart < 0
  ? -1
  : evidenceNavigationSource.indexOf('return ', openEvidenceStart)
assert.ok(openEvidenceStart >= 0 && openEvidenceEnd > openEvidenceStart, '证据卡必须提供独立的点击导航处理器')
const openEvidenceBody = evidenceNavigationSource.slice(openEvidenceStart, openEvidenceEnd)
assert.match(openEvidenceBody, /if\s*\(\s*dataViewBlock\s*&&\s*view\s*\)[\s\S]{0,240}openDataView\(view\)/, 'dataView 证据卡必须继续直接打开查询/聚合视图')
assert.match(
  openEvidenceBody,
  /message\.id/,
  '记录/文档证据卡点击必须携带当前消息 id，不能脱离消息上下文打开首个来源'
)
assert.match(
  openEvidenceBody,
  /if\s*\(\s*sourceGroupType\s*\)[\s\S]{0,240}focusAnswerSources\(message\.id,\s*sourceGroupType\)/,
  '记录/文档证据卡必须把来源卡点击路由到同消息的回答依据详情'
)
assert.doesNotMatch(
  openEvidenceBody,
  /open(?:RecordDetail|KnowledgeDetail)\s*\(/,
  '记录/文档证据卡不得只打开 sourceIndexes 中解析出的第一条来源'
)

assert.match(
  evidenceNavigationSource,
  /const sourceGroupCount\s*=\s*sourceGroupType[\s\S]*?sourceGroups\.filter\(\(group\) => group\.sourceType === sourceGroupType\)\.length/,
  '记录/文档证据卡必须按来源类型从同消息的来源分组派生去重数量'
)
assert.doesNotMatch(
  evidenceNavigationSource,
  /block\.sourceIndexes\s*\??\.\s*\[\s*0\s*\]/,
  '证据卡不能把 sourceIndexes 的第一条当作整组记录/文档来源'
)
const sourceGroupCountStart = evidenceNavigationSource.indexOf('const sourceGroupCount =')
const sourceGroupCountEnd = sourceGroupCountStart < 0
  ? -1
  : evidenceNavigationSource.indexOf('const canOpen', sourceGroupCountStart)
const sourceGroupCountSource = sourceGroupCountStart < 0 || sourceGroupCountEnd < 0
  ? ''
  : evidenceNavigationSource.slice(sourceGroupCountStart, sourceGroupCountEnd)
assert.match(
  sourceGroupCountSource,
  /sourceGroupType[\s\S]*sourceGroups\.filter\(\(group\) => group\.sourceType === sourceGroupType\)\.length/,
  '旧会话中的 record/document block.count 可能是引用数，证据卡展示数量必须从去重后的来源分组派生'
)
const countLabelStart = evidenceNavigationSource.indexOf('const countLabel =')
const countLabelEnd = countLabelStart < 0
  ? -1
  : evidenceNavigationSource.indexOf('const body =', countLabelStart)
const countLabelSource = countLabelStart < 0 || countLabelEnd < 0
  ? ''
  : evidenceNavigationSource.slice(countLabelStart, countLabelEnd)
assert.match(countLabelSource, /sourceGroupCount/, '证据卡数量标签必须使用来源分组计数，而不是直接信任 block.count')

const sourceListOpening = rendererSource.slice(sourceListStart, sourceListOpeningEnd + 1)
assert.match(sourceListOpening, /message\.id/, '回答依据 details 必须绑定当前消息 id')
const sourceListBody = rendererSource.slice(sourceListStart, sourceListEnd + '</details>'.length)
assert.match(sourceListBody, /data-source-reference-id=\{reference\.id\}/, '回答依据中的具体引用必须保留稳定引用 id')
assert.match(
  sourceListBody,
  /const source = reference\.source[\s\S]{0,4000}openKnowledgeDetail\(documentId,\s*normalizedChatSourceValueOf\(source\.chunkId\)/,
  '文档具体引用按钮必须使用该引用自身的 documentId/chunkId'
)
assert.match(
  sourceListBody,
  /const source = reference\.source[\s\S]{0,4000}openRecordDetail\(\{[\s\S]{0,500}uid:\s*recordUid/,
  '记录具体引用按钮必须使用该引用自身的 uid'
)

const sourceNavigationCall = openEvidenceBody.match(
  /(?<![\w$])([A-Za-z_$][\w$]*)\(\s*message\.id(?:\s*,|\s*\))/u
)
assert.ok(sourceNavigationCall, '证据卡点击必须调用以 message.id 为参数的回答依据导航 helper')
const sourceNavigationHelperName = sourceNavigationCall?.[1] ?? ''
const sourceNavigationHelperStart = sourceNavigationHelperName
  ? rendererSource.lastIndexOf(`const ${sourceNavigationHelperName}`, evidenceGridStart)
  : -1
const sourceNavigationHelper = sourceNavigationHelperStart >= 0
  ? rendererSource.slice(sourceNavigationHelperStart, Math.min(evidenceGridStart, sourceNavigationHelperStart + 4_000))
  : ''
assert.match(
  sourceNavigationHelper,
  /(?:\.open\s*=\s*true|setAttribute\(\s*['"]open['"])/,
  '回答依据导航 helper 必须先展开同消息 details'
)
assert.match(sourceNavigationHelper, /\.focus\s*\(/, '回答依据导航 helper 必须把焦点移到同消息 details')
checks.push('record/document evidence cards expand and focus the same message evidence details; data views and exact citations keep their dedicated targets')
checks.push('legacy record/document block counts are replaced by the current message source-group counts in the renderer')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
