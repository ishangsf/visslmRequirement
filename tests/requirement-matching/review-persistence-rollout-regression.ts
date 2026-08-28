import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { RequirementMatchCandidateResult, RequirementMatchRun } from '../../src/main/requirements/requirement-match-domain'
import type { RequirementMatchingCore } from '../../src/main/requirements/requirement-matching-core'
import { hashProjectRequirementSnapshot } from '../../src/main/requirements/requirement-match-run-service'
import {
  compareRequirementMatchingResults,
  resolveRequirementMatchingRollout
} from '../../src/main/requirements/requirement-matching-rollout'
import { ProjectManagementService } from '../../src/main/project-management'

type RawObject = Record<string, unknown>
type RunCreateInput = Parameters<AppDatabase['createRequirementMatchRun']>[0]
type CandidateInput = Parameters<AppDatabase['completeRequirementMatchRun']>[1][number]

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'review-persistence-rollout-'))
  const db = new AppDatabase(join(directory, 'regression.db'), join(directory, 'assets'))
  try {
    return await worker(db)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const createRequirementFixture = (db: AppDatabase, suffix: string): { projectId: string; requirementId: string; recordUid: string } => {
  const project = db.createManagedProject(`review-project-${suffix}`, { projectName: `Review 回归 ${suffix}` })
  const document = db.insertKnowledgeDocument({
    id: `review-document-${suffix}`,
    fileName: 'review.txt',
    filePath: 'review.txt',
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 1,
    sha256: `review-document-hash-${suffix}`
  })
  const requirementId = `review-requirement-${suffix}`
  const recordUid = `review-record-${suffix}`
  db.replaceProjectRequirements(project.id, document.id, [{
    id: requirementId,
    requirementNo: 1,
    title: '查询订单',
    content: '支持按订单号查询订单详情',
    sourceLocation: '第 1 页',
    sourceChunkId: 'review-chunk'
  }])
  db.upsertRecord({
    uid: recordUid,
    projectId: 'historical-project',
    nodeType: 'Requirement',
    itemId: 'REVIEW-001',
    parentId: '',
    name: '历史订单查询能力',
    lastModifyTime: '2026-08-28T00:00:00.000Z',
    raw: { description: '支持按订单号查询订单详情' },
    normalizedText: '历史订单查询能力\n支持按订单号查询订单详情'
  })
  return { projectId: project.id, requirementId, recordUid }
}

const createRun = (db: AppDatabase, input: RawObject): RequirementMatchRun => (
  db.createRequirementMatchRun(input as unknown as RunCreateInput)
)

const completeRun = (db: AppDatabase, runId: string, candidate?: RawObject): void => {
  db.completeRequirementMatchRun(
    runId,
    candidate ? [candidate as unknown as CandidateInput] : [],
    []
  )
}

const legacyMatch = (recordUid: string, requirementId: string) => ({
  recordUid,
  vectorScore: 90,
  aiScore: 91,
  finalScore: 91,
  scoreSource: 'ai' as const,
  reason: '历史匹配结果',
  bestChunkId: 'legacy-chunk',
  requirementId
})

const createService = (
  db: AppDatabase,
  rolloutMode: 'legacy_safe' | 'shadow' | 'v1_1',
  core?: RequirementMatchingCore
): ProjectManagementService => new ProjectManagementService(
  db,
  {} as KnowledgeService,
  () => ({ source: 'local', provider: 'ollama', baseUrl: '', model: '', thinking: false }),
  undefined,
  () => ({ minScore: 40, rolloutMode }),
  core
)

// Production mutation caught: omitting requirementBusinessHash, indexVersion, or startedAt from the run schema, insert, or mapper.
const testRunProvenancePersists = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId } = createRequirementFixture(db, 'provenance')
    const run = createRun(db, {
      requirementId,
      requirementSnapshotHash: 'snapshot-v1',
      requirementBusinessHash: 'business-hash-v1',
      indexVersion: 'requirement-business-index-v4',
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v1',
      rankingVersion: 'requirement-ranking-v1-cross-encoder',
      configHash: 'config-v1',
      modelVersion: null,
      startedAt: '2026-08-28T00:00:00.000Z'
    })
    const persisted = db.getRequirementMatchRun(run.id) as unknown as RawObject
    assert.equal(persisted.requirementBusinessHash, 'business-hash-v1')
    assert.equal(persisted.indexVersion, 'requirement-business-index-v4')
    assert.equal(persisted.startedAt, '2026-08-28T00:00:00.000Z')
  })
}

// Production mutation caught: dropping candidate.evidenceJson during candidate INSERT or result mapping.
const testCandidateEvidencePersists = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId, recordUid } = createRequirementFixture(db, 'evidence')
    const run = createRun(db, {
      requirementId,
      requirementSnapshotHash: 'snapshot-evidence-v1',
      requirementBusinessHash: 'business-evidence-v1',
      indexVersion: 'requirement-business-index-v4',
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v1',
      rankingVersion: 'requirement-ranking-v1-cross-encoder',
      configHash: 'config-v1',
      modelVersion: null,
      startedAt: '2026-08-28T00:01:00.000Z'
    })
    const evidenceJson = {
      baseEvidence: 'B001',
      candidateEvidence: 'C001',
      matchedTerms: ['订单号', '订单详情']
    }
    completeRun(db, run.id, {
      recordUid,
      finalRank: 1,
      rankingScore: 88,
      rankingVersion: 'requirement-ranking-v1-cross-encoder',
      relation: 'highly_similar',
      decisionStatus: 'suggested',
      evidenceLevel: 'deterministic_rule',
      reasonCodes: ['BUSINESS_OVERLAP'],
      degradationCodes: [],
      stageScores: {
        denseRank: 1, denseScore: 80, lexicalRank: 1, lexicalScore: 75,
        fusedRank: 1, fusedScore: 85, rerankerRank: 1, rerankerScore: 90
      },
      evidenceJson,
      explanation: null,
      recordSnapshotHash: 'record-evidence-v1'
    })
    const row = db.listRequirementMatchCandidates({ runId: run.id, page: 1, pageSize: 20 }).rows[0] as unknown as RawObject
    assert.deepEqual(row.evidenceJson, evidenceJson)
  })
}

// Production mutation caught: ignoring indexVersion in latest-compatible-run filtering and returning a stale-index run.
const testLatestCompatibleRejectsMismatchedIndex = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId } = createRequirementFixture(db, 'index')
    const run = createRun(db, {
      requirementId,
      requirementSnapshotHash: 'snapshot-index-v1',
      requirementBusinessHash: 'business-index-v1',
      indexVersion: 'requirement-business-index-old',
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v1',
      rankingVersion: 'requirement-ranking-v1-cross-encoder',
      configHash: 'config-v1',
      modelVersion: null,
      startedAt: '2026-08-28T00:02:00.000Z'
    })
    completeRun(db, run.id)
    const latest = db.getLatestCompatibleRequirementMatchRun({
      requirementId,
      requirementSnapshotHash: 'snapshot-index-v1',
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v1',
      indexVersion: 'requirement-business-index-current'
    } as unknown as Parameters<AppDatabase['getLatestCompatibleRequirementMatchRun']>[0])
    assert.equal(latest, null)
  })
}

// Production mutation caught: assigning the current index version to a historical run whose index provenance is unknown.
const testLegacyRunDefaultsToUnknownIndex = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId } = createRequirementFixture(db, 'legacy-index')
    const raw = db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }
    raw.db.prepare(`
      INSERT INTO pm_requirement_match_runs(
        id, requirement_id, requirement_snapshot_hash, normalization_version,
        pipeline_version, ranking_version, config_hash, model_version, status,
        degradation_codes_json, failure_code, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'succeeded', '[]', NULL, ?, ?)
    `).run(
      'legacy-run-unknown-index', requirementId, 'legacy-snapshot', 'requirement-business-v1',
      'requirement-matching-pipeline-v1', 'legacy-ranking', 'legacy-config',
      '2026-08-27T00:00:00.000Z', '2026-08-27T00:01:00.000Z'
    )
    const run = db.getRequirementMatchRun('legacy-run-unknown-index')
    assert.equal(run?.indexVersion, 'legacy_unknown')
    assert.equal(db.getLatestCompatibleRequirementMatchRun({
      requirementId,
      requirementSnapshotHash: 'legacy-snapshot',
      indexVersion: 'requirement-business-index-v4'
    }), null)
  })
}

// Production mutation caught: coercing legacy_unverified to ai while importing a project snapshot.
const testSnapshotRoundTripPreservesLegacyStatusSource = async (): Promise<void> => {
  await withDatabase((db) => {
    const { projectId, requirementId } = createRequirementFixture(db, 'snapshot')
    const raw = db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }
    raw.db.prepare('UPDATE pm_requirements SET status_source = ? WHERE id = ?')
      .run('legacy_unverified', requirementId)
    const snapshot = db.exportManagedProjectSnapshot(projectId)
    assert(snapshot)
    assert.equal(snapshot.requirements[0]?.statusSource, 'legacy_unverified')
    const imported = db.importManagedProjectSnapshot(snapshot)
    const importedRequirement = db.listProjectRequirements({
      projectId: imported.projectId,
      page: 1,
      pageSize: 20
    }).rows[0]
    assert.equal(importedRequirement?.statusSource, 'legacy_unverified')
  })
}

// Production mutation caught: blocking legacy_safe from reading historical rows or allowing it to mutate them.
const testLegacySafeReadPathIsReadOnly = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId, recordUid } = createRequirementFixture(db, 'legacy-safe')
    db.replaceRequirementMatches(requirementId, [legacyMatch(recordUid, requirementId)])
    const before = db.listLegacyProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 })
    const page = createService(db, 'legacy_safe').listMatches({ requirementId, page: 1, pageSize: 20 }) as unknown as RawObject
    const rows = page.rows as Array<RawObject>
    assert.equal(page.total, 1)
    assert.equal(rows[0]?.recordUid, recordUid)
    const after = db.listLegacyProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 })
    assert.deepEqual(after, before)
  })
}

// Production mutation caught: letting shadow replace the legacy read path or mutate historical business-match rows.
const testShadowReadPathIsReadOnly = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId, recordUid } = createRequirementFixture(db, 'shadow-read')
    db.replaceRequirementMatches(requirementId, [legacyMatch(recordUid, requirementId)])
    const before = db.listLegacyProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 })
    const page = createService(db, 'shadow').listMatches({ requirementId, page: 1, pageSize: 20 }) as unknown as RawObject
    const rows = page.rows as Array<RawObject>
    assert.equal(page.total, 1)
    assert.equal(rows[0]?.recordUid, recordUid)
    const after = db.listLegacyProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 })
    assert.deepEqual(after, before)
  })
}

// Production mutation caught: shadow mode failing to persist v1.1, omit technical comparison metrics, or perform a business write.
const testShadowPersistsTechnicalOnlyComparison = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const { projectId, requirementId } = createRequirementFixture(db, 'shadow-persist')
    const core = {
      async match() {
        return {
          normalizationVersion: 'requirement-business-v1',
          pipelineVersion: 'requirement-matching-pipeline-v3',
          rankingVersion: 'requirement-similarity-v3-cross-encoder',
          configHash: 'shadow-config-v1',
          modelVersion: null,
          degradationCodes: [],
          candidates: []
        }
      }
    } as unknown as RequirementMatchingCore
    const service = createService(db, 'shadow', core)
    const started = service.startRequirementMatching(requirementId)
    assert.equal(started.ok, true)
    for (let attempt = 0; attempt < 100 && db.getManagedProject(projectId)?.matchStatus === 'processing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const requirement = db.getProjectRequirement(requirementId)
    assert(requirement)
    const persistedRun = db.getLatestCompatibleRequirementMatchRun({
      requirementId,
      requirementSnapshotHash: hashProjectRequirementSnapshot(requirement),
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v3'
    })
    assert(persistedRun)
    assert.equal(persistedRun.status, 'succeeded')
    assert.equal(db.listLegacyProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 }).total, 0)

    const decision = resolveRequirementMatchingRollout('shadow') as unknown as RawObject
    assert.equal(decision.primaryReadPath, 'legacy_safe')
    assert.equal(decision.newPipelinePersisted, true)
    assert.equal(decision.businessWriteCount, 0)

    const comparison = compareRequirementMatchingResults(
      [
        { recordUid: 'A', rank: 1, decisionStatus: 'suggested' },
        { recordUid: 'B', rank: 2, decisionStatus: 'ambiguous' }
      ],
      [
        { recordUid: 'A', rank: 1, decisionStatus: 'suggested' },
        { recordUid: 'C', rank: 2, decisionStatus: 'suggested' }
      ]
    )
    assert.equal(comparison.candidateOverlapAt20, 0.5)
    assert.equal(comparison.rankCorrelation, 1)
    assert.equal(comparison.decisionDriftCount, 0)
    assert.equal(comparison.businessWriteCount, 0)
  })
}

// Production mutation caught: dropping run provenance or candidate evidence at the project-management API boundary.
const testProjectMatchDtoIncludesProvenanceAndEvidence = async (): Promise<void> => {
  await withDatabase((db) => {
    const { requirementId, recordUid } = createRequirementFixture(db, 'dto')
    const run = createRun(db, {
      requirementId,
      requirementSnapshotHash: hashProjectRequirementSnapshot(db.getProjectRequirement(requirementId)!),
      requirementBusinessHash: 'dto-business-hash',
      indexVersion: 'requirement-business-index-v4',
      normalizationVersion: 'requirement-business-v1',
      pipelineVersion: 'requirement-matching-pipeline-v1',
      rankingVersion: 'requirement-ranking-v1-cross-encoder',
      configHash: 'dto-config',
      modelVersion: 'dto-model',
      startedAt: '2026-08-28T01:00:00.000Z'
    })
    const evidenceJson = { baseBusinessHash: 'dto-business-hash', recordBusinessHash: 'dto-record-hash' }
    completeRun(db, run.id, {
      recordUid, finalRank: 1, rankingScore: 88, rankingVersion: 'requirement-ranking-v1-cross-encoder',
      relation: 'highly_similar', decisionStatus: 'suggested', evidenceLevel: 'deterministic_rule',
      reasonCodes: ['BUSINESS_OVERLAP'], degradationCodes: [], evidenceJson,
      stageScores: { denseRank: 1, denseScore: 80, lexicalRank: 1, lexicalScore: 75, fusedRank: 1, fusedScore: 85, rerankerRank: 1, rerankerScore: 90 },
      explanation: null, recordSnapshotHash: 'dto-record-hash'
    })
    const page = createService(db, 'v1_1').listMatches({ requirementId, runId: run.id, page: 1, pageSize: 20 })
    assert.deepEqual(page.rows[0]?.evidenceJson, evidenceJson)
    const summary = page.run as unknown as RawObject
    assert.equal(summary.requirementBusinessHash, 'dto-business-hash')
    assert.equal(summary.indexVersion, 'requirement-business-index-v4')
    assert.equal(summary.startedAt, '2026-08-28T01:00:00.000Z')
  })
}

// Production mutation caught: starting a batch match in legacy_safe and writing processing/ready status despite the read-only contract.
const testLegacySafeBatchStartIsRejectedWithoutStateWrites = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const { projectId } = createRequirementFixture(db, 'legacy-batch')
    const before = db.getManagedProject(projectId)
    const started = createService(db, 'legacy_safe').startMatching(projectId)
    for (let attempt = 0; attempt < 100 && db.getManagedProject(projectId)?.matchStatus === 'processing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const after = db.getManagedProject(projectId)
    assert.equal(started.ok, false)
    assert.equal(after?.matchStatus, before?.matchStatus)
    assert.equal(after?.matchMessage, before?.matchMessage)
  })
}

// Production mutation caught: treating a failed/stale run as success at the project-service boundary.
const testFailedRunMarksProjectFailed = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const { projectId, requirementId } = createRequirementFixture(db, 'failed-run')
    const raw = db as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }
    const core = {
      async match() {
        raw.db.prepare('UPDATE pm_requirements SET updated_at = ? WHERE id = ?')
          .run('2099-01-01T00:00:00.000Z', requirementId)
        return {
          normalizationVersion: 'requirement-business-v1', pipelineVersion: 'requirement-matching-pipeline-v1',
          rankingVersion: 'requirement-ranking-v1-cross-encoder', configHash: 'failed-run-config',
          modelVersion: null, degradationCodes: [], candidates: []
        }
      }
    } as unknown as RequirementMatchingCore
    const started = createService(db, 'v1_1', core).startRequirementMatching(requirementId)
    assert.equal(started.ok, true)
    for (let attempt = 0; attempt < 100 && db.getManagedProject(projectId)?.matchStatus === 'processing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(db.getManagedProject(projectId)?.matchStatus, 'failed')
  })
}

type Regression = {
  name: string
  mutation: string
  run: () => Promise<void>
}

const regressions: Regression[] = [
  {
    name: 'run provenance fields persist',
    mutation: 'remove requirementBusinessHash/indexVersion/startedAt from run storage or mapping',
    run: testRunProvenancePersists
  },
  {
    name: 'candidate evidence JSON persists',
    mutation: 'drop evidenceJson during candidate storage or mapping',
    run: testCandidateEvidencePersists
  },
  {
    name: 'latest compatible run rejects an index mismatch',
    mutation: 'ignore indexVersion when selecting the latest compatible run',
    run: testLatestCompatibleRejectsMismatchedIndex
  },
  {
    name: 'legacy runs default to unknown index provenance',
    mutation: 'backfill an unknown historical run with the current index version',
    run: testLegacyRunDefaultsToUnknownIndex
  },
  {
    name: 'snapshot round-trip preserves legacy status provenance',
    mutation: 'coerce legacy_unverified statusSource to ai during import',
    run: testSnapshotRoundTripPreservesLegacyStatusSource
  },
  {
    name: 'legacy_safe reads historical rows without writes',
    mutation: 'block the legacy read path or mutate historical match rows in legacy_safe',
    run: testLegacySafeReadPathIsReadOnly
  },
  {
    name: 'shadow reads legacy rows without writes',
    mutation: 'replace the legacy read path or mutate historical match rows in shadow',
    run: testShadowReadPathIsReadOnly
  },
  {
    name: 'shadow persists v1.1 and exposes technical-only metrics',
    mutation: 'skip v1.1 persistence, expose no comparison metrics, or perform a business write in shadow',
    run: testShadowPersistsTechnicalOnlyComparison
  },
  {
    name: 'project match DTO includes provenance and evidence',
    mutation: 'drop run provenance or candidate evidence at the project API boundary',
    run: testProjectMatchDtoIncludesProvenanceAndEvidence
  },
  {
    name: 'legacy_safe batch start is rejected without state writes',
    mutation: 'start a read-only legacy batch and report processing/success',
    run: testLegacySafeBatchStartIsRejectedWithoutStateWrites
  },
  {
    name: 'failed run marks project failed',
    mutation: 'mark the project ready after the immutable run failed',
    run: testFailedRunMarksProjectFailed
  }
]

const main = async (): Promise<void> => {
  const results: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = []
  for (const regression of regressions) {
    console.log(`[mutation guard] ${regression.name}: ${regression.mutation}`)
    try {
      await regression.run()
      results.push({ name: regression.name, status: 'passed' })
    } catch (error) {
      results.push({
        name: regression.name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const failed = results.filter((result) => result.status === 'failed')
  console.log(JSON.stringify({ phase: 'GREEN', ok: failed.length === 0, results }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
