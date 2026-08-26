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

const blocks = buildEvidenceBlocks(sources, [view], summary)
assert.deepEqual(blocks.map((block) => block.kind), ['record', 'document', 'aggregate'])
assert.deepEqual(blocks[0].sourceIndexes, [0])
assert.deepEqual(blocks[1].sourceIndexes, [1])
assert.equal(blocks[2].dataViewId, 'view-1')
assert.equal(blocks[2].matchedCount, 55)
assert.equal(blocks[2].returnedCount, 20)
assert.equal(blocks[2].truncated, true)
checks.push('record, document and aggregate evidence share one source-aware ledger')

const queryBlocks = buildEvidenceBlocks([], [{ ...view, isPreview: false, total: 20 }], {
  ...summary,
  intent: 'filter_records'
})
assert.equal(queryBlocks[0].kind, 'query_detail')
assert.equal(queryBlocks[0].truncated, false)
checks.push('query details preserve matched, loaded and truncation truth')

const [mainSource, rendererSource, sharedSource] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
])
assert.match(mainSource, /buildEvidenceBlocks\(/)
assert.match(rendererSource, /回答证据区/)
assert.match(rendererSource, /message\.evidenceBlocks\.map/)
assert.match(sharedSource, /EvidenceBlockKind\s*=\s*'record'\s*\|\s*'document'\s*\|\s*'aggregate'\s*\|\s*'query_detail'/)
checks.push('EvidenceBlock is persisted and rendered through the shared response contract')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
