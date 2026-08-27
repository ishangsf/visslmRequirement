import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../../src/main/database'
import type { RequirementMatchCandidateResult } from '../../src/main/requirements/requirement-match-domain'

const directory = await mkdtemp(join(tmpdir(), 'requirement-match-runs-'))
const db = new AppDatabase(join(directory, 'runs.db'), join(directory, 'assets'))
try {
  const project = db.createManagedProject('project-run', { projectName: '运行仓储回归' })
  const document = db.insertKnowledgeDocument({
    id: 'document-run', fileName: 'run.txt', filePath: join(directory, 'run.txt'), extension: '.txt',
    mimeType: 'text/plain', byteSize: 1, sha256: 'run-hash'
  })
  db.replaceProjectRequirements(project.id, document.id, [{
    id: 'requirement-run', requirementNo: 1, title: '查询订单', content: '查询订单详情',
    sourceLocation: '1', sourceChunkId: 'chunk-1'
  }])
  db.upsertRecord({
    uid: 'candidate-run', projectId: 'external', nodeType: 'Requirement', itemId: 'C-1',
    parentId: '', name: '查询订单详情', lastModifyTime: new Date().toISOString(), raw: {}, normalizedText: '查询订单详情'
  })
  const input = {
    requirementId: 'requirement-run', requirementSnapshotHash: 'snapshot-v1',
    normalizationVersion: 'requirement-business-v1', pipelineVersion: 'requirement-matching-pipeline-v1',
    rankingVersion: 'requirement-ranking-v1-cross-encoder', configHash: 'config-v1', modelVersion: 'model-v1'
  }
  const first = db.createRequirementMatchRun(input)
  assert.equal(first.status, 'running')
  const candidate: RequirementMatchCandidateResult & { recordSnapshotHash: string } = {
    recordUid: 'candidate-run', finalRank: 1, rankingScore: 88.4,
    rankingVersion: input.rankingVersion, relation: 'highly_similar', decisionStatus: 'suggested',
    evidenceLevel: 'deterministic_rule', reasonCodes: [], degradationCodes: [],
    stageScores: { denseRank: 1, denseScore: 80, lexicalRank: 1, lexicalScore: 70, fusedRank: 1, fusedScore: 90, rerankerRank: 1, rerankerScore: 91 },
    explanation: '相似业务目标', recordSnapshotHash: 'record-v1'
  }
  db.completeRequirementMatchRun(first.id, [candidate], [])
  assert.equal(db.getRequirementMatchRun(first.id)?.status, 'succeeded')
  assert.equal(db.listRequirementMatchCandidates({ runId: first.id, page: 1, pageSize: 20 }).rows[0]?.finalRank, 1)

  const second = db.createRequirementMatchRun(input)
  assert.notEqual(second.id, first.id)
  db.failRequirementMatchRun(second.id, 'SMOKE_FAILURE')
  assert.equal(db.getRequirementMatchRun(second.id)?.status, 'failed')
  assert.equal(db.listRequirementMatchCandidates({ runId: second.id, page: 1, pageSize: 20 }).total, 0)
  assert.equal(db.getLatestCompatibleRequirementMatchRun({
    requirementId: input.requirementId,
    requirementSnapshotHash: input.requirementSnapshotHash
  })?.id, first.id)
  db.markRequirementMatchRunsStale(input.requirementId)
  assert.equal(db.getLatestCompatibleRequirementMatchRun({
    requirementId: input.requirementId,
    requirementSnapshotHash: input.requirementSnapshotHash
  }), null)
  console.log(JSON.stringify({ ok: true, checks: ['append-only runs', 'atomic completion', 'failure isolation', 'compatible latest', 'stale exclusion'] }))
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
