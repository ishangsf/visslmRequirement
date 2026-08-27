import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../../src/main/database'
import { RequirementMatchingCore } from '../../src/main/requirements/requirement-matching-core'
import { RequirementMatchRunService } from '../../src/main/requirements/requirement-match-run-service'
import { buildRequirementSourceView } from '../../src/main/requirements/requirement-match-card'

const directory = await mkdtemp(join(tmpdir(), 'requirement-match-run-service-'))
const db = new AppDatabase(join(directory, 'service.db'), join(directory, 'assets'))
try {
  const project = db.createManagedProject('project-service', { projectName: '运行服务回归' })
  const document = db.insertKnowledgeDocument({
    id: 'document-service', fileName: 'service.txt', filePath: join(directory, 'service.txt'), extension: '.txt',
    mimeType: 'text/plain', byteSize: 1, sha256: 'service-hash'
  })
  db.replaceProjectRequirements(project.id, document.id, [{
    id: 'requirement-service', requirementNo: 1, title: '查询订单', content: '查询订单详情',
    sourceLocation: '1', sourceChunkId: 'chunk-1'
  }])
  db.upsertRecord({
    uid: 'candidate-service', projectId: 'external', nodeType: 'Requirement', itemId: 'C-1', parentId: '',
    name: '查询订单详情', lastModifyTime: new Date().toISOString(), raw: { description: '查询订单详情' }, normalizedText: '查询订单详情'
  })
  const record = db.getRecord('candidate-service', false)!
  const hybrid = {
    record, card: buildRequirementSourceView(record), denseScore: 90, lexicalScore: 80, retrievalScore: 90, snippet: '查询订单详情'
  }
  let mutateDuringRun = false
  const core = new RequirementMatchingCore({
    retriever: {
      async retrieve() {
        if (mutateDuringRun) {
          const raw = db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }
          raw.db.prepare('UPDATE pm_requirements SET content = ?, updated_at = ? WHERE id = ?')
            .run('需求已在运行期间修改', new Date(Date.now() + 1000).toISOString(), 'requirement-service')
        }
        return [hybrid]
      }
    },
    reranker: {
      modelId: 'run-service-reranker',
      async rerank(_base, candidates) {
        return candidates.map((candidate) => ({ recordUid: candidate.record.uid, score: 95 }))
      }
    },
    async exactBusinessHashCandidates() { return [] },
    candidateEligible() { return true }
  })
  const service = new RequirementMatchRunService(db, core)
  const first = await service.start({
    requirementId: 'requirement-service', explainTopN: 0,
    explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }
  })
  await service.execute(first.runId)
  assert.equal(db.getRequirementMatchRun(first.runId)?.status, 'succeeded')
  assert.equal(db.listRequirementMatchCandidates({ runId: first.runId, page: 1, pageSize: 20 }).total, 1)
  assert.equal(db.listProjectRequirementMatches({ requirementId: 'requirement-service', page: 1, pageSize: 20 }).total, 0)
  assert.equal(db.listProjectAssets(project.id).length, 0)

  mutateDuringRun = true
  const second = await service.start({
    requirementId: 'requirement-service', explainTopN: 0,
    explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }
  })
  await service.execute(second.runId)
  assert.equal(db.getRequirementMatchRun(second.runId)?.status, 'failed')
  assert.equal(db.getRequirementMatchRun(second.runId)?.failureCode, 'REQUIREMENT_SNAPSHOT_CHANGED')
  assert.equal(db.listRequirementMatchCandidates({ runId: second.runId, page: 1, pageSize: 20 }).total, 0)

  console.log(JSON.stringify({ ok: true, checks: ['run success', 'no legacy/formal writes', 'snapshot race failure'] }))
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}
