import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantArtifactPreview,
  verifyAssistantArtifactPreview
} from '../src/main/assistant/artifact-service'
import { AppDatabase } from '../src/main/database'
import { renderAssistantArtifact } from '../src/main/assistant/artifact-exporter'
import { unzipSync } from 'fflate'
import type { AssistantArtifactInput } from '../src/shared/types'

const checks: string[] = []
const input: AssistantArtifactInput = {
  type: 'analysis_snapshot',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  title: '负责人分析快照',
  question: '按负责人统计需求',
  answer: '共命中 55 条需求。',
  evidenceBlocks: [{
    id: 'view:view-1',
    kind: 'aggregate',
    title: '聚合结果',
    summary: '按负责人统计',
    count: 55,
    dataViewId: 'view-1',
    matchedCount: 55,
    returnedCount: 20,
    truncated: true
  }],
  dataViews: [{
    id: 'view-1',
    title: '负责人统计',
    description: '按负责人统计',
    total: 55,
    loadedRows: 20,
    isPreview: true,
    fields: ['Owner'],
    groups: []
  }]
}

const preview = createAssistantArtifactPreview(input)
assert.equal(preview.impact.queryMatchedCount, 55)
assert.equal(preview.impact.sourceWriteCount, 0)
assert.match(preview.rollbackPoint, /不修改数据中心或知识库/)
assert.deepEqual(verifyAssistantArtifactPreview(preview), input)
checks.push('artifact creation requires an explicit preview with impact and rollback point')

await assert.rejects(
  async () => verifyAssistantArtifactPreview({
    ...preview,
    input: { ...preview.input, answer: '被预览后篡改的内容' }
  }),
  /预览已变化/
)
assert.throws(() => createAssistantArtifactPreview({ ...input, evidenceBlocks: [] }), /没有 EvidenceBlock/)
checks.push('tampered previews and evidence-free artifacts fail closed')

const directory = await mkdtemp(join(tmpdir(), 'assistant-artifact-'))
const db = new AppDatabase(join(directory, 'artifact.db'), join(directory, 'assets'))
try {
  const saved = db.saveAssistantArtifact(verifyAssistantArtifactPreview(preview))
  assert.equal(saved.status, 'active')
  assert.equal(saved.version, 1)
  assert.equal(db.listAssistantArtifacts()[0].id, saved.id)
  for (const format of ['docx', 'xlsx', 'pptx', 'zip'] as const) {
    const rendered = await renderAssistantArtifact(saved, format)
    assert.ok(rendered.bytes.byteLength > 100)
    assert.equal(rendered.manifest.evidence.queryMatchedCount, 55)
    assert.equal(rendered.manifest.files[0].sha256.length, 64)
    if (format === 'docx') assert.ok(unzipSync(rendered.bytes)['word/document.xml'])
    if (format === 'pptx') assert.ok(unzipSync(rendered.bytes)['ppt/slides/slide1.xml'])
    if (format === 'zip') {
      const entries = unzipSync(rendered.bytes)
      assert.ok(entries['manifest.json'])
      assert.ok(entries['report.docx'])
      assert.ok(entries['table.xlsx'])
      assert.ok(entries['presentation.pptx'])
    }
  }
  checks.push('confirmed evidence renders DOCX, XLSX, PPTX and ZIP with an auditable manifest')
  const reverted = db.revertAssistantArtifact(saved.id)
  assert.equal(reverted.status, 'reverted')
  assert.equal(reverted.version, 2)
  assert.equal(reverted.payload.answer, input.answer)
  checks.push('confirmed artifacts persist as versions and revert without deleting their audit payload')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const [mainSource, preloadSource, rendererSource, artifactPanelSource] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/assistant/ArtifactExportPanel.tsx', import.meta.url), 'utf8')
])
assert.match(mainSource, /assistant-artifacts:preview/)
assert.match(mainSource, /assistant-artifacts:commit/)
assert.match(preloadSource, /previewAssistantArtifact/)
assert.match(artifactPanelSource, /确认后才会生成文件并写入本地导出目录/)
assert.match(rendererSource, /分析快照/)
assert.match(rendererSource, /保存筛选视图/)
assert.match(rendererSource, /报告草稿/)
checks.push('three controlled artifact entry points use preview-confirm IPC rather than direct model writes')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
