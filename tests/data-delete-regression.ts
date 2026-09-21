import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type RecordInput } from '../src/main/database'

type SqlStatement = {
  all(...values: unknown[]): unknown[]
  get(...values: unknown[]): unknown
  run(...values: unknown[]): unknown
}

type RawDatabase = {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
}

type CandidateInput = Parameters<AppDatabase['completeRequirementMatchRun']>[1][number]

const rawDatabase = (database: AppDatabase): RawDatabase => (
  (database as unknown as { db: RawDatabase }).db
)

const countRows = (database: RawDatabase, sql: string, ...values: unknown[]): number => {
  const row = database.prepare(sql).get(...values) as { count?: unknown } | undefined
  return Number(row?.count ?? 0)
}

const foreignKeyViolations = (database: RawDatabase): unknown[] => (
  database.prepare('PRAGMA foreign_key_check').all()
)

const makeRecord = (uid: string): RecordInput => ({
  uid,
  projectId: 'data-delete-record-project',
  nodeType: 'Requirement',
  itemId: `DELETE-${uid}`,
  parentId: '',
  name: `待删除数据 ${uid}`,
  lastModifyTime: '2026-09-21T00:00:00.000Z',
  raw: { description: `delete regression fixture ${uid}` },
  normalizedText: `delete regression fixture ${uid}`
})

const makeCandidate = (recordUid: string, finalRank: number): CandidateInput => ({
  recordUid,
  finalRank,
  rankingScore: 90 - finalRank,
  similarityScore: 90 - finalRank,
  rankingVersion: 'requirement-ranking-v1-test',
  relation: 'highly_similar',
  decisionStatus: 'suggested',
  confidenceStatus: 'high',
  confidenceReasons: [],
  evidenceLevel: 'deterministic_rule',
  reasonCodes: [],
  degradationCodes: [],
  stageScores: {
    denseRank: finalRank,
    denseScore: 90 - finalRank,
    lexicalRank: finalRank,
    lexicalScore: 90 - finalRank,
    fusedRank: finalRank,
    fusedScore: 90 - finalRank,
    rerankerRank: finalRank,
    rerankerScore: 90 - finalRank
  },
  explanation: `candidate ${recordUid}`,
  recordSnapshotHash: `snapshot-${recordUid}`
})

type Fixture = {
  db: AppDatabase
  raw: RawDatabase
  requirementId: string
  runId: string
  recordUids: string[]
}

const createFixture = (db: AppDatabase, suffix: string, recordUids: string[]): Fixture => {
  const raw = rawDatabase(db)
  const projectId = `data-delete-project-${suffix}`
  const requirementId = `data-delete-requirement-${suffix}`
  const documentId = `data-delete-document-${suffix}`

  db.createManagedProject(projectId, { projectName: `数据删除回归 ${suffix}` })
  db.insertKnowledgeDocument({
    id: documentId,
    fileName: `data-delete-${suffix}.txt`,
    filePath: `data-delete-${suffix}.txt`,
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 1,
    sha256: `data-delete-document-hash-${suffix}`
  })
  db.replaceProjectRequirements(projectId, documentId, [{
    id: requirementId,
    requirementNo: 1,
    title: '删除数据后保留匹配运行',
    content: '验证删除数据时只清理引用候选，保留需求和运行记录',
    sourceLocation: '1',
    sourceChunkId: 'delete-regression-chunk'
  }])

  for (const uid of recordUids) db.upsertRecord(makeRecord(uid))

  const run = db.createRequirementMatchRun({
    requirementId,
    requirementSnapshotHash: `requirement-snapshot-${suffix}`,
    normalizationVersion: 'requirement-business-v1',
    pipelineVersion: 'requirement-matching-pipeline-v1',
    rankingVersion: 'requirement-ranking-v1-test',
    configHash: 'data-delete-test-config',
    modelVersion: null
  })
  db.completeRequirementMatchRun(
    run.id,
    recordUids.map((uid, index) => makeCandidate(uid, index + 1)),
    []
  )

  return { db, raw, requirementId, runId: run.id, recordUids }
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'data-delete-regression-'))
  const db = new AppDatabase(join(directory, 'data-delete.db'), join(directory, 'assets'))
  try {
    return await worker(db)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testSelectedDeleteRemovesOnlyReferencedCandidates = async (): Promise<void> => {
  await withDatabase((db) => {
    const fixture = createFixture(db, 'selected', ['selected-record', 'kept-record'])
    const [selectedUid, keptUid] = fixture.recordUids
    assert.ok(selectedUid)
    assert.ok(keptUid)

    // The fixture reproduces the original failure: RESTRICT prevents a direct
    // record delete while a match candidate still references that record.
    assert.throws(
      () => fixture.raw.prepare('DELETE FROM records WHERE uid = ?').run(selectedUid),
      /FOREIGN KEY constraint failed/
    )
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records'), 2)

    const result = db.deleteData([selectedUid])
    assert.deepEqual(result, {
      ok: true,
      recordCount: 1,
      imageCount: 0,
      message: '已删除 1 条记录和 0 张图片'
    })
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records WHERE uid = ?', selectedUid), 0)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records WHERE uid = ?', keptUid), 1)
    assert.equal(
      countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates WHERE record_uid = ?', selectedUid),
      0
    )
    assert.equal(
      countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates WHERE record_uid = ?', keptUid),
      1
    )
    assert.equal(db.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(db.getProjectRequirement(fixture.requirementId))
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const testAllDeleteRemovesAllCandidatesButRetainsMatchingHistory = async (): Promise<void> => {
  await withDatabase((db) => {
    const fixture = createFixture(db, 'all', ['all-record-a', 'all-record-b', 'all-record-c'])
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records'), 3)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates'), 3)

    const result = db.deleteData()
    assert.deepEqual(result, {
      ok: true,
      recordCount: 3,
      imageCount: 0,
      message: '已删除 3 条记录和 0 张图片'
    })
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records'), 0)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates'), 0)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_runs'), 1)
    assert.equal(db.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(db.getProjectRequirement(fixture.requirementId))
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const testEmptySelectionIsNoOp = async (): Promise<void> => {
  await withDatabase((db) => {
    const fixture = createFixture(db, 'empty', ['empty-record'])
    const beforeRecords = countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records')
    const beforeCandidates = countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates')

    assert.deepEqual(db.deleteData([]), {
      ok: true,
      recordCount: 0,
      imageCount: 0,
      message: '没有需要删除的数据'
    })
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records'), beforeRecords)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates'), beforeCandidates)
    assert.equal(db.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const testDeleteFailureRollsBackCandidateCleanup = async (): Promise<void> => {
  await withDatabase((db) => {
    const fixture = createFixture(db, 'rollback', ['rollback-record', 'rollback-keep'])
    fixture.raw.exec(`
      CREATE TRIGGER force_data_delete_failure
      BEFORE DELETE ON records
      WHEN OLD.uid = 'rollback-record'
      BEGIN
        SELECT RAISE(ABORT, 'forced data delete failure');
      END
    `)
    try {
      assert.throws(
        () => db.deleteData(['rollback-record']),
        /forced data delete failure/
      )
    } finally {
      fixture.raw.exec('DROP TRIGGER force_data_delete_failure')
    }

    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records WHERE uid = ?', 'rollback-record'), 1)
    assert.equal(
      countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates WHERE record_uid = ?', 'rollback-record'),
      1,
      'candidate cleanup must roll back when record deletion fails'
    )
    assert.equal(
      countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates WHERE record_uid = ?', 'rollback-keep'),
      1
    )
    assert.equal(db.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(db.getProjectRequirement(fixture.requirementId))
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const main = async (): Promise<void> => {
  await testSelectedDeleteRemovesOnlyReferencedCandidates()
  await testAllDeleteRemovesAllCandidatesButRetainsMatchingHistory()
  await testEmptySelectionIsNoOp()
  await testDeleteFailureRollsBackCandidateCleanup()
  console.log(JSON.stringify({
    ok: true,
    contract: 'data-delete-match-candidate-integrity',
    checks: [
      'direct record delete reproduces the RESTRICT foreign-key failure',
      'selected deletion removes only matching candidates',
      'all deletion removes candidates while preserving runs and requirements',
      'empty selection is a no-op',
      'candidate cleanup rolls back with the record transaction',
      'PRAGMA foreign_key_check remains clean'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
