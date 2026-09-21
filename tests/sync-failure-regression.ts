import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type RecordInput } from '../src/main/database'
import { normalizeText, SyncService, type VisslmClient } from '../src/main/visslm'
import type {
  SyncFailureDetail,
  SyncProgress,
  SyncScopeConfig
} from '../src/shared/types'

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

type Fixture = {
  raw: RawDatabase
  requirementId: string
  runId: string
  staleUid: string
  keptUid: string
}

type RemoteRow = Record<string, unknown>

const syncConfig: SyncScopeConfig = {
  selectedTypes: ['Task'],
  rules: [{ nodeType: 'Task', filters: [], returnProperty: '_valm_Uid,_valm_NodeType,_valm_ItemID,_valm_Name,_valm_ProjectId,_valm_LastModifyTime' }]
}

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

const recordRaw = (
  uid: string,
  itemId: string,
  name: string
): Record<string, unknown> => ({
  _valm_Uid: uid,
  _valm_NodeType: 'Task',
  _valm_ItemID: itemId,
  _valm_Name: name,
  _valm_ProjectId: 'sync-regression-project',
  _valm_LastModifyTime: '2026-09-21T00:00:00.000Z'
})

const makeRecord = (uid: string, itemId: string, name: string): RecordInput => {
  const raw = recordRaw(uid, itemId, name)
  return {
    uid,
    projectId: 'sync-regression-project',
    nodeType: 'Task',
    itemId,
    parentId: '',
    name,
    lastModifyTime: '2026-09-21T00:00:00.000Z',
    raw,
    normalizedText: normalizeText(raw)
  }
}

const makeCandidate = (recordUid: string, finalRank: number): CandidateInput => ({
  recordUid,
  finalRank,
  rankingScore: 90 - finalRank,
  similarityScore: 90 - finalRank,
  rankingVersion: 'requirement-ranking-v1-sync-test',
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

const createFixture = (database: AppDatabase, suffix: string, includeKept = true): Fixture => {
  const raw = rawDatabase(database)
  const projectId = `sync-regression-project-${suffix}`
  const requirementId = `sync-regression-requirement-${suffix}`
  const documentId = `sync-regression-document-${suffix}`
  const staleUid = `sync-stale-${suffix}`
  const keptUid = `sync-kept-${suffix}`

  database.createManagedProject(projectId, { projectName: `同步失败回归 ${suffix}` })
  database.insertKnowledgeDocument({
    id: documentId,
    fileName: `sync-regression-${suffix}.txt`,
    filePath: `sync-regression-${suffix}.txt`,
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 1,
    sha256: `sync-regression-document-hash-${suffix}`
  })
  database.replaceProjectRequirements(projectId, documentId, [{
    id: requirementId,
    requirementNo: 1,
    title: '同步清理候选引用',
    content: '验证同步删除旧记录时先清理匹配候选，并保留运行记录与需求',
    sourceLocation: '1',
    sourceChunkId: 'sync-regression-chunk'
  }])

  database.upsertRecord(makeRecord(staleUid, `ITEM-STALE-${suffix}`, `旧任务 ${suffix}`))
  const candidateUids = [staleUid]
  if (includeKept) {
    database.upsertRecord(makeRecord(keptUid, `ITEM-KEPT-${suffix}`, `保留任务 ${suffix}`))
    candidateUids.push(keptUid)
  }

  const run = database.createRequirementMatchRun({
    requirementId,
    requirementSnapshotHash: `sync-regression-snapshot-${suffix}`,
    normalizationVersion: 'requirement-business-v1',
    pipelineVersion: 'requirement-matching-pipeline-v1',
    rankingVersion: 'requirement-ranking-v1-sync-test',
    configHash: 'sync-regression-config',
    modelVersion: null
  })
  database.completeRequirementMatchRun(
    run.id,
    candidateUids.map((uid, index) => makeCandidate(uid, index + 1)),
    []
  )

  return { raw, requirementId, runId: run.id, staleUid, keptUid }
}

const withDatabase = async <T>(worker: (database: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'sync-failure-regression-'))
  const database = new AppDatabase(join(directory, 'sync-failure.db'), join(directory, 'assets'))
  try {
    return await worker(database)
  } finally {
    database.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const makeClient = (state: { rows: RemoteRow[]; error?: Error }): VisslmClient => ({
  test: async () => ({ ok: true, message: 'ok' }),
  queryItemsTrace: () => ({ endpoint: 'http://example.test/rest/items', params: {} }),
  queryItems: async () => {
    if (state.error) throw state.error
    return state.rows
  },
  getAttachments: async () => [],
  download: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/png', sourceUrl: '' })
} as unknown as VisslmClient)

const candidateUids = (database: RawDatabase, runId: string): string[] => (
  database.prepare(`
    SELECT record_uid FROM pm_requirement_match_candidates
    WHERE run_id = ? ORDER BY final_rank ASC
  `).all(runId).map((row) => String((row as { record_uid?: unknown }).record_uid ?? ''))
)

const latestErrorDetail = (events: SyncProgress[]): SyncFailureDetail => {
  const event = events.findLast((item) => item.phase === 'error')
  assert.ok(event?.errorDetail, 'sync error progress must include structured errorDetail')
  return event.errorDetail
}

const testSuccessfulSyncPrunesReferencedOldRecords = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const fixture = createFixture(database, 'success')
    const keptRaw = recordRaw(fixture.keptUid, 'ITEM-KEPT-success', '保留任务 success')
    const events: SyncProgress[] = []
    const service = new SyncService(
      database,
      () => makeClient({ rows: [keptRaw] }),
      (progress) => events.push(progress)
    )

    const result = await service.run(syncConfig)

    assert.equal(result.ok, true)
    assert.equal(database.getRecord(fixture.staleUid), null)
    assert.ok(database.getRecord(fixture.keptUid))
    assert.deepEqual(candidateUids(fixture.raw, fixture.runId), [fixture.keptUid])
    assert.equal(database.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(database.getProjectRequirement(fixture.requirementId))
    assert.equal(database.listSyncRuns()[0]?.status, 'success')
    assert.equal(events.findLast((item) => item.phase === 'done')?.successfulCount, 1)
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const testEmptyRetainPrunesAllCandidateReferences = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const fixture = createFixture(database, 'empty')
    const events: SyncProgress[] = []
    const service = new SyncService(
      database,
      () => makeClient({ rows: [] }),
      (progress) => events.push(progress)
    )

    const result = await service.run(syncConfig)

    assert.equal(result.ok, true)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM records'), 0)
    assert.equal(countRows(fixture.raw, 'SELECT COUNT(*) AS count FROM pm_requirement_match_candidates'), 0)
    assert.equal(database.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(database.getProjectRequirement(fixture.requirementId))
    assert.equal(database.listSyncRuns()[0]?.status, 'success')
    assert.equal(events.findLast((item) => item.phase === 'done')?.successfulCount, 0)
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const testRetainFailureRollsBackCandidatesAndPersistsDiagnostics = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const fixture = createFixture(database, 'failure')
    fixture.raw.exec(`
      CREATE TRIGGER force_sync_retain_failure
      BEFORE DELETE ON records
      WHEN OLD.uid = '${fixture.staleUid}'
      BEGIN
        SELECT RAISE(ABORT, 'forced retainRecords failure');
      END
    `)
    const keptRaw = recordRaw(fixture.keptUid, 'ITEM-KEPT-failure', '保留任务 failure')
    const events: SyncProgress[] = []
    const service = new SyncService(
      database,
      () => makeClient({ rows: [keptRaw] }),
      (progress) => events.push(progress)
    )

    let result
    try {
      result = await service.run(syncConfig)
    } finally {
      fixture.raw.exec('DROP TRIGGER force_sync_retain_failure')
    }

    assert.equal(result.ok, false)
    assert.equal(result.recordCount, 0)
    assert.equal(result.updatedCount, 0)
    assert.equal(result.imageCount, 0)
    assert.ok(result.errorDetail)
    const detail = result.errorDetail
    assert.equal(detail.stage, '清理旧数据')
    assert.equal(detail.reason, 'forced retainRecords failure')
    assert.equal(detail.suggestion.includes('旧数据清理未完成'), true)
    assert.equal(detail.nodeType, undefined)
    assert.equal(detail.recordUid, undefined)
    assert.equal(detail.itemId, undefined)
    assert.equal(detail.recordName, undefined)
    assert.equal(detail.batchCount, undefined)
    assert.equal(detail.runId, database.listSyncRuns()[0]?.id)

    // Candidate deletion and record deletion share one transaction. The
    // trigger aborts after candidate cleanup starts, so both references remain.
    assert.ok(database.getRecord(fixture.staleUid))
    assert.ok(database.getRecord(fixture.keptUid))
    assert.deepEqual(candidateUids(fixture.raw, fixture.runId), [fixture.staleUid, fixture.keptUid])
    assert.equal(database.getRequirementMatchRun(fixture.runId)?.status, 'succeeded')
    assert.ok(database.getProjectRequirement(fixture.requirementId))
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])

    const errorEventDetail = latestErrorDetail(events)
    assert.deepEqual(errorEventDetail, detail)
    const errorEvent = events.findLast((item) => item.phase === 'error')
    assert.deepEqual(
      { current: errorEvent?.current, total: errorEvent?.total, successfulCount: errorEvent?.successfulCount, failedCount: errorEvent?.failedCount },
      { current: 0, total: 1, successfulCount: 1, failedCount: 1 }
    )

    const failedRun = database.listSyncRuns().find((run) => run.id === detail.runId)
    assert.ok(failedRun)
    assert.equal(failedRun.status, 'failed')
    assert.match(failedRun.errorMessage, /清理旧数据失败/)
    assert.match(failedRun.errorMessage, /原始原因：forced retainRecords failure/)
    assert.match(failedRun.errorMessage, /处理建议：/)

    const logs = database.listCollectionRequestLogs(1, 100).rows
    const successfulRemoteLog = logs.find((log) => log.endpoint === 'http://example.test/rest/items')
    assert.equal(successfulRemoteLog?.status, 'success')
    const localFailureLog = logs.find((log) => log.endpoint === 'local://collection/清理旧数据')
    assert.ok(localFailureLog)
    assert.equal(localFailureLog.status, 'failed')
    assert.match(localFailureLog.errorMessage, /清理旧数据失败/)
    assert.match(localFailureLog.errorMessage, /forced retainRecords failure/)
  })
}

const testQueryFailureDoesNotLeakStaleRecordContext = async (): Promise<void> => {
  await withDatabase(async (database) => {
    const fixture = createFixture(database, 'query-failure', false)
    const events: SyncProgress[] = []
    const service = new SyncService(
      database,
      () => makeClient({ error: new Error('simulated collection failure'), rows: [] }),
      (progress) => events.push(progress)
    )

    const result = await service.run(syncConfig)

    assert.equal(result.ok, false)
    assert.ok(result.errorDetail)
    const detail = result.errorDetail
    assert.equal(detail.stage, '请求数据')
    assert.equal(detail.reason, 'simulated collection failure')
    assert.equal(detail.nodeType, 'Task')
    assert.equal(detail.recordUid, undefined)
    assert.equal(detail.itemId, undefined)
    assert.equal(detail.recordName, undefined)
    assert.equal(detail.batchCount, undefined)
    assert.equal(detail.runId, database.listSyncRuns()[0]?.id)
    assert.deepEqual(latestErrorDetail(events), detail)

    const failedRun = database.listSyncRuns().find((run) => run.id === detail.runId)
    assert.ok(failedRun)
    assert.equal(failedRun.status, 'failed')
    assert.match(failedRun.errorMessage, /请求数据失败/)
    assert.match(failedRun.errorMessage, /simulated collection failure/)
    assert.doesNotMatch(failedRun.errorMessage, /sync-stale-query-failure|ITEM-STALE-query-failure|旧任务 query-failure/)

    const logs = database.listCollectionRequestLogs(1, 100).rows
    const remoteFailureLog = logs.find((log) => log.endpoint === 'http://example.test/rest/items')
    assert.equal(remoteFailureLog?.status, 'failed')
    const localFailureLog = logs.find((log) => log.endpoint === 'local://collection/请求数据')
    assert.ok(localFailureLog)
    assert.equal(localFailureLog.status, 'failed')
    assert.match(localFailureLog.errorMessage, /请求数据失败/)
    assert.doesNotMatch(localFailureLog.errorMessage, /sync-stale-query-failure|ITEM-STALE-query-failure|旧任务 query-failure/)
    assert.deepEqual(foreignKeyViolations(fixture.raw), [])
  })
}

const main = async (): Promise<void> => {
  await testSuccessfulSyncPrunesReferencedOldRecords()
  await testEmptyRetainPrunesAllCandidateReferences()
  await testRetainFailureRollsBackCandidatesAndPersistsDiagnostics()
  await testQueryFailureDoesNotLeakStaleRecordContext()
  console.log(JSON.stringify({
    ok: true,
    contract: 'sync-retain-records-failure-diagnostics',
    checks: [
      'successful SyncService pruning removes old candidates before referenced records',
      'empty retain removes all old candidates while preserving runs and requirements',
      'retain failure rolls back candidate and record deletion',
      'structured cleanup failure details include stage, reason, suggestion and run id',
      'sync run and local collection failure logs persist diagnostics',
      'query failures do not leak stale record identifiers'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
