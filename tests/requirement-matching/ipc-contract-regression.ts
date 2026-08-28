import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../../src/main/database'
import type { KnowledgeService } from '../../src/main/knowledge'
import { ProjectManagementService } from '../../src/main/project-management'
import { RequirementMatchingCore } from '../../src/main/requirements/requirement-matching-core'
import { hashProjectRequirementSnapshot } from '../../src/main/requirements/requirement-match-run-service'

const directory = await mkdtemp(join(tmpdir(), 'requirement-match-ipc-'))
const db = new AppDatabase(join(directory, 'ipc.db'), join(directory, 'assets'))
try {
  const project = db.createManagedProject('project-ipc', { projectName: 'IPC 回归' })
  const document = db.insertKnowledgeDocument({ id: 'doc-ipc', fileName: 'ipc.txt', filePath: join(directory, 'ipc.txt'), extension: '.txt', mimeType: 'text/plain', byteSize: 1, sha256: 'ipc' })
  db.replaceProjectRequirements(project.id, document.id, [{ id: 'requirement-ipc', requirementNo: 1, title: '查询订单', content: '查询订单详情', sourceLocation: '1', sourceChunkId: 'c1' }])
  db.upsertRecord({ uid: 'candidate-ipc', projectId: 'external', nodeType: 'Requirement', itemId: 'C-IPC', parentId: '', name: '订单详情查询', lastModifyTime: new Date().toISOString(), raw: {}, normalizedText: '订单详情查询' })
  const requirement = db.getProjectRequirement('requirement-ipc')!
  const run = db.createRequirementMatchRun({
    requirementId: requirement.id, requirementSnapshotHash: hashProjectRequirementSnapshot(requirement),
    normalizationVersion: 'requirement-business-v1', pipelineVersion: 'requirement-matching-pipeline-v3',
    rankingVersion: 'requirement-similarity-v3-cross-encoder', configHash: 'config', modelVersion: 'model'
  })
  db.completeRequirementMatchRun(run.id, [{
    recordUid: 'candidate-ipc', finalRank: 1, rankingScore: 87.4,
    rankingVersion: 'requirement-similarity-v3-cross-encoder', relation: 'highly_similar',
    decisionStatus: 'suggested', evidenceLevel: 'deterministic_rule', reasonCodes: [], degradationCodes: [],
    stageScores: { denseRank: 1, denseScore: 80, lexicalRank: 1, lexicalScore: 70, fusedRank: 1, fusedScore: 85, rerankerRank: 1, rerankerScore: 90 },
    explanation: '订单查询目标一致', recordSnapshotHash: 'record'
  }], [])
  const core = new RequirementMatchingCore({
    retriever: { async retrieve() { return [] } },
    reranker: { modelId: 'unused', async rerank() { return [] } },
    async exactBusinessHashCandidates() { return [] }, candidateEligible() { return true }
  })
  const service = new ProjectManagementService(db, {} as KnowledgeService, () => ({ source: 'local', provider: 'ollama', baseUrl: '', model: '', thinking: false }), undefined, undefined, core)
  const page = service.listMatches({ requirementId: requirement.id, page: 1, pageSize: 20 })
  assert.equal(page.run?.rankingVersion, 'requirement-similarity-v3-cross-encoder')
  assert.equal(page.rows[0]?.finalRank, 1)
  assert.equal(page.rows[0]?.rankingScore, 87.4)
  assert.equal(page.rows[0]?.similarityScore, 87.4)
  assert.equal(page.rows[0]?.scoreBreakdown.total, 87.4)
  assert.match(page.rows[0]?.deterministicAnalysis.similarities.join('；') ?? '', /查询|订单/)
  assert.equal(page.rows[0]?.deterministicAnalysis.basis, 'business_facts_and_terms')
  assert.equal(page.rows[0]?.decisionStatus, 'suggested')
  assert.deepEqual(page.rows[0]?.degradationCodes, [])
  assert.equal('finalScore' in page.rows[0]!, false)
  assert.equal('scoreSource' in page.rows[0]!, false)
  console.log(JSON.stringify({ ok: true, checks: ['run summary', 'ranked candidate DTO', 'no legacy score fields'] }))
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
