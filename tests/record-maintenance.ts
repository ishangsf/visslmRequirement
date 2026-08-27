import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AppDatabase,
  type KnowledgeChunkInput,
  type KnowledgeVectorInput
} from '../src/main/database'
import { KnowledgeService } from '../src/main/knowledge'
import { RecordMaintenanceService } from '../src/main/record-maintenance'
import { AsyncMutex } from '../src/main/record-index-lock'
import {
  RECORD_LEXICAL_INDEX_VERSION,
  RECORD_NORMALIZER_VERSION,
  RECORD_VECTOR_INDEX_VERSION
} from '../src/main/record-maintenance-constants'
import {
  buildRequirementSemanticCard,
  type RequirementSemanticCard
} from '../src/main/requirements/semantic-card'
import type {
  RecordDetail,
  RecordMaintenanceTaskSnapshot,
  RecordMaintenanceTaskStatus
} from '../src/shared/types'

const FALLBACK_MODEL_VERSION = 'local-hash-v1'
const SEMANTIC_ANALYZER_VERSION = 'record-maintenance-test-analyzer-v1'
const SEMANTIC_MODEL_SIGNATURE = 'record-maintenance-test-model-v1'
const TERMINAL_STATUSES = new Set<RecordMaintenanceTaskStatus>([
  'stopped', 'completed', 'completed_with_errors', 'failed'
])

type RecordFixture = {
  uid: string
  name?: string
  raw?: Record<string, unknown>
  normalizedText?: string
}

type DatabaseContext = {
  db: AppDatabase
  knowledge: KnowledgeService
  service: RecordMaintenanceService
  lock: AsyncMutex
}

const addRecord = (db: AppDatabase, input: RecordFixture): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'record-maintenance-test-project',
    nodeType: 'Requirement',
    itemId: `RM-${input.uid}`,
    parentId: '',
    name: input.name ?? `Record ${input.uid}`,
    lastModifyTime: '2026-08-14T00:00:00.000Z',
    raw: input.raw ?? {
      IssueType: 'Enhancement',
      _valm_Description: `Description for ${input.uid}`,
      _valm_Module: 'maintenance'
    },
    normalizedText: input.normalizedText ?? `legacy normalized text for ${input.uid}`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `fixture record was not persisted: ${input.uid}`)
  return record
}

const seedRecordVector = (
  db: AppDatabase,
  record: RecordDetail,
  modelVersion: string,
  chunkId: string,
  content = 'seeded record chunk',
  sourceHash?: string
): void => {
  const effectiveSourceHash = sourceHash ?? db.getKnowledgeRecordIndexRow(record.uid)?.contentHash ?? 'seeded-source-hash'
  const chunk: KnowledgeChunkInput = {
    id: chunkId,
    recordUid: record.uid,
    sourceType: 'record',
    sourceName: record.name,
    sourceHash: effectiveSourceHash,
    content,
    chunkIndex: 0,
    location: 'test',
    charStart: 0,
    charEnd: content.length
  }
  const vector: KnowledgeVectorInput = {
    chunkId,
    vector: new Float32Array([1, 0, 0]),
    modelVersion
  }
  db.replaceKnowledgeRecordChunks(record.uid, [chunk], [vector])
}

const recordVectorRows = (db: AppDatabase, recordUid: string, modelVersion: string) => (
  db.listKnowledgeVectorRows(modelVersion)
    .filter((row) => row.chunk.recordUid === recordUid)
)

const withDatabase = async <T>(worker: (context: DatabaseContext) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'record-maintenance-regression-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'maintenance.db'), join(directory, 'assets'))
    const lock = new AsyncMutex()
    const knowledge = new KnowledgeService(db, undefined, lock)
    const service = new RecordMaintenanceService(db, knowledge, lock)
    return await worker({ db, knowledge, service, lock })
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const waitForTask = async (
  service: RecordMaintenanceService,
  taskId: string,
  timeoutMs = 5000
): Promise<RecordMaintenanceTaskSnapshot> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = service.getTask()
    if (snapshot?.taskId === taskId && TERMINAL_STATUSES.has(snapshot.status)) return snapshot
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`maintenance task did not finish: ${taskId}`)
}

const persistReadySemanticCard = (db: AppDatabase, record: RecordDetail): void => {
  const source = buildRequirementSemanticCard(record)
  const card: RequirementSemanticCard = {
    ...source,
    functionalObject: record.name,
    action: 'add_capability',
    matchingText: source.evidence,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: record.name, confidence: 1, evidence: source.evidence },
      action: { value: 'add_capability', confidence: 1, evidence: source.evidence }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: 'record maintenance regression fixture'
  }
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash)
  assert.equal(db.claimRequirementSemanticCard({
    recordUid: record.uid,
    contentHash,
    analyzerVersion: SEMANTIC_ANALYZER_VERSION,
    modelSignature: SEMANTIC_MODEL_SIGNATURE
  }), true)
  db.completeRequirementSemanticCard(record.uid, card)
  assert.equal(db.getRequirementSemanticCardState(record.uid)?.status, 'ready')
}

const testMigrationDefaultsAndReadOnlyPreviews = async (): Promise<void> => {
  await withDatabase(async ({ db, knowledge, service }) => {
    const first = addRecord(db, { uid: 'preview-first' })
    const second = addRecord(db, { uid: 'preview-second' })
    const initialState = db.getRecordMaintenanceState(first.uid, knowledge.modelVersion)

    assert.equal(initialState.clean.status, 'ready')
    assert.equal(initialState.clean.version, RECORD_NORMALIZER_VERSION)
    assert.equal(initialState.lexical.status, 'ready')
    assert.equal(initialState.lexical.version, RECORD_LEXICAL_INDEX_VERSION)
    assert.equal(initialState.vector.status, 'pending')
    assert.equal(initialState.vector.version, RECORD_VECTOR_INDEX_VERSION)
    assert.equal(initialState.overallStatus, 'pending')
    assert.equal(db.getRecord(first.uid, false, undefined, knowledge.modelVersion)?.maintenance.overallStatus, 'pending')

    const beforeRaw = db.getRecord(first.uid, false)?.raw
    const beforeNormalized = db.getRecord(first.uid, false)?.normalizedText
    const all = service.preview({ scope: 'all' })
    assert.equal(all.scope, 'all')
    assert.equal(all.totalCount, 2)
    assert.equal(all.cleanPendingCount, 0)
    assert.equal(all.lexicalPendingCount, 0)
    assert.equal(all.vectorPendingCount, 2)
    assert.equal(all.semanticInvalidationCount, 0)
    assert.equal(all.modelVersion, FALLBACK_MODEL_VERSION)
    assert.equal(service.getTask(), null)

    const selected = service.preview({
      scope: 'selected',
      recordUids: [second.uid, 'missing-record', second.uid]
    })
    assert.equal(selected.scope, 'selected')
    assert.equal(selected.totalCount, 1)
    assert.equal(selected.semanticInvalidationCount, 0)
    assert.equal(selected.vectorPendingCount, 1)
    assert.equal(service.getTask(), null)
    assert.deepEqual(db.getRecord(first.uid, false)?.raw, beforeRaw)
    assert.equal(db.getRecord(first.uid, false)?.normalizedText, beforeNormalized)
  })
}

const testCleaningPreservesRawAndRefreshesFts = async (): Promise<void> => {
  await withDatabase(async ({ db, knowledge, service }) => {
    const raw = {
      IssueType: 'Enhancement',
      _valm_Module: '<b>maintenance-module</b>',
      _valm_Description: '<p>maintenancecleanterm</p><script>drop-this-script</script>',
      nested: {
        note: 'nested-clean-term',
        image: 'data:image/png;base64,not-searchable'
      },
      count: 42
    }
    const record = addRecord(db, {
      uid: 'clean-record',
      name: 'Cleanable record',
      raw,
      normalizedText: 'legacy-normalized-value'
    })
    seedRecordVector(db, record, knowledge.modelVersion, 'clean-existing-vector')
    assert.equal(db.listRecords({ page: 1, pageSize: 20, search: 'maintenancecleanterm' }).total, 0)

    const queued = service.start({
      scope: 'selected',
      recordUids: [record.uid],
      operation: 'clean'
    })
    const completed = await waitForTask(service, queued.taskId)
    assert.equal(completed.status, 'completed')
    assert.equal(completed.total, 1)
    assert.equal(completed.succeeded, 1)
    assert.equal(completed.failed, 0)

    const cleaned = db.getRecord(record.uid, false, undefined, knowledge.modelVersion)
    assert.ok(cleaned)
    assert.deepEqual(cleaned.raw, raw)
    assert.notEqual(cleaned.normalizedText, 'legacy-normalized-value')
    assert.ok(cleaned.normalizedText?.includes('maintenancecleanterm'))
    assert.ok(cleaned.normalizedText?.includes('nested-clean-term'))
    assert.ok(!cleaned.normalizedText?.includes('<p>'))
    assert.ok(!cleaned.normalizedText?.includes('drop-this-script'))
    assert.ok(!cleaned.normalizedText?.includes('data:image/'))

    const ftsPage = db.listRecords({ page: 1, pageSize: 20, search: 'maintenancecleanterm' })
    assert.equal(ftsPage.total, 1)
    assert.equal(ftsPage.rows[0]?.uid, record.uid)
    const lexical = db.searchRequirementRecordsLexical(
      ['maintenancecleanterm'],
      knowledge.modelVersion
    )
    assert.equal(lexical[0]?.recordUid, record.uid)

    const state = db.getRecordMaintenanceState(record.uid, knowledge.modelVersion)
    assert.equal(state.clean.status, 'ready')
    assert.equal(state.lexical.status, 'ready')
    assert.equal(state.vector.status, 'ready')
    assert.equal(state.lastTaskId, queued.taskId)
    assert.equal(state.lastOperation, 'clean')
    const items = db.getRecordMaintenanceItems(queued.taskId)
    assert.deepEqual(items.map((item) => ({ uid: item.uid, status: item.status, stage: item.stage })), [
      { uid: record.uid, status: 'succeeded', stage: 'cleaning' }
    ])
  })
}

const testRecordVectorReindexIsTransactional = async (): Promise<void> => {
  await withDatabase(async ({ db, knowledge }) => {
    const record = addRecord(db, {
      uid: 'vector-success-record',
      raw: {
        IssueType: 'Enhancement',
        _valm_Description: 'vector success evidence',
        _valm_Module: 'maintenance'
      }
    })
    const otherRecord = addRecord(db, { uid: 'vector-other-record' })
    seedRecordVector(db, record, 'old-vector-model', 'old-vector-chunk', 'old indexed content', 'old-hash')
    seedRecordVector(db, otherRecord, 'other-vector-model', 'other-existing-vector', 'other record content', 'other-hash')
    const otherBefore = recordVectorRows(db, otherRecord.uid, 'other-vector-model')
      .map((row) => ({ id: row.chunk.id, content: row.chunk.content, vector: [...row.vector] }))
    const source = db.getKnowledgeRecordIndexRow(record.uid)
    assert.ok(source)
    assert.equal(knowledge.modelVersion, FALLBACK_MODEL_VERSION)

    const count = await knowledge.rebuildRecordIndexInLock(
      record.uid,
      'vector-success-task',
      'rebuild_indexes'
    )
    assert.equal(count, 1)
    const rows = recordVectorRows(db, record.uid, FALLBACK_MODEL_VERSION)
    assert.equal(rows.length, 1)
    assert.notEqual(rows[0]?.chunk.id, 'old-vector-chunk')
    assert.equal(rows[0]?.chunk.sourceType, 'record')
    assert.equal(rows[0]?.chunk.content, source.content)
    assert.equal(db.getKnowledgeRecordIndexHash(record.uid), source.contentHash)
    assert.equal(rows[0]?.vector.length, 384)
    const otherAfter = recordVectorRows(db, otherRecord.uid, 'other-vector-model')
      .map((row) => ({ id: row.chunk.id, content: row.chunk.content, vector: [...row.vector] }))
    assert.deepEqual(otherAfter, otherBefore)
    const state = db.getRecordMaintenanceState(record.uid, FALLBACK_MODEL_VERSION)
    assert.equal(state.vector.status, 'ready')
    assert.equal(state.vector.modelVersion, FALLBACK_MODEL_VERSION)
    assert.equal(state.vector.chunkCount, 1)
    assert.equal(state.lastTaskId, 'vector-success-task')
    assert.equal(state.lastOperation, 'rebuild_indexes')
  })

  await withDatabase(async ({ db }) => {
    const record = addRecord(db, { uid: 'vector-failure-record' })
    seedRecordVector(db, record, 'old-vector-model', 'preserve-vector-chunk', 'preserve this chunk', 'preserve-hash')
    const beforeChunks = db.listKnowledgeChunksForRebuild()
      .filter((chunk) => chunk.recordUid === record.uid)
    const beforeVectors = recordVectorRows(db, record.uid, 'old-vector-model')
      .map((row) => ({ id: row.chunk.id, vector: [...row.vector] }))
    const previousFallback = process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
    delete process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
    try {
      const unavailable = new KnowledgeService(db)
      await assert.rejects(() => unavailable.rebuildRecordIndexInLock(
        record.uid,
        'vector-failure-task',
        'rebuild_indexes'
      ))
    } finally {
      if (previousFallback === undefined) delete process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
      else process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = previousFallback
    }
    const afterChunks = db.listKnowledgeChunksForRebuild()
      .filter((chunk) => chunk.recordUid === record.uid)
    const afterVectors = recordVectorRows(db, record.uid, 'old-vector-model')
      .map((row) => ({ id: row.chunk.id, vector: [...row.vector] }))
    assert.deepEqual(afterChunks, beforeChunks)
    assert.deepEqual(afterVectors, beforeVectors)
  })
}

const testSemanticInvalidationAndMaintenanceStatus = async (): Promise<void> => {
  await withDatabase(async ({ db, knowledge, service }) => {
    const record = addRecord(db, {
      uid: 'semantic-invalidation-record',
      raw: {
        IssueType: 'Enhancement',
        _valm_Description: 'semantic original evidence',
        _valm_Module: 'maintenance'
      }
    })
    persistReadySemanticCard(db, record)
    seedRecordVector(db, record, knowledge.modelVersion, 'semantic-existing-vector')
    const readyPreview = service.preview({ scope: 'selected', recordUids: [record.uid] })
    assert.equal(readyPreview.semanticInvalidationCount, 0)
    assert.equal(readyPreview.cleanPendingCount, 0)
    assert.equal(readyPreview.lexicalPendingCount, 0)
    assert.equal(readyPreview.vectorPendingCount, 0)

    const changedRaw = {
      IssueType: 'Enhancement',
      _valm_Description: 'semantic changed evidence',
      _valm_Module: 'maintenance'
    }
    db.updateRecordRawAndNormalizedText(record.uid, changedRaw, 'changed normalized evidence')
    const invalidated = service.preview({ scope: 'selected', recordUids: [record.uid] })
    assert.equal(invalidated.semanticInvalidationCount, 1)
    assert.equal(invalidated.cleanPendingCount, 0)
    assert.equal(invalidated.lexicalPendingCount, 0)
    // A physical vector from the old content must not mask a pending rebuild.
    assert.equal(invalidated.vectorPendingCount, 1)
    assert.equal(db.getRequirementSemanticCardState(record.uid)?.status, 'ready')
    assert.equal(db.getRecordMaintenanceState(record.uid, knowledge.modelVersion).overallStatus, 'pending')
  })
}

const testStoppedTaskPersistsPartialItems = async (): Promise<void> => {
  await withDatabase(async ({ db, knowledge, lock }) => {
    const records = [
      addRecord(db, { uid: 'stop-record-a' }),
      addRecord(db, { uid: 'stop-record-b' }),
      addRecord(db, { uid: 'stop-record-c' })
    ]
    let stopIssued = false
    let runningService: RecordMaintenanceService | undefined
    const service = new RecordMaintenanceService(
      db,
      knowledge,
      lock,
      (snapshot) => {
        if (!stopIssued && snapshot.succeeded === 1 && snapshot.current === 1) {
          stopIssued = true
          runningService?.stop()
        }
      }
    )
    runningService = service
    const queued = service.start({ scope: 'all', operation: 'clean' })
    const stopped = await waitForTask(service, queued.taskId)
    assert.equal(stopIssued, true)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.total, records.length)
    assert.equal(stopped.current, 1)
    assert.equal(stopped.succeeded, 1)
    assert.equal(stopped.failed, 0)
    assert.ok(stopped.finishedAt)

    const persisted = service.getTask()
    assert.equal(persisted?.taskId, queued.taskId)
    assert.equal(persisted?.status, 'stopped')
    assert.equal(persisted?.succeeded, 1)
    const items = db.getRecordMaintenanceItems(queued.taskId)
    assert.equal(items.filter((item) => item.status === 'succeeded').length, 1)
    assert.equal(items.filter((item) => item.status === 'pending').length, 2)
    assert.equal(items.filter((item) => item.status === 'failed').length, 0)
  })
}

const testPartialFailurePersistsFailureDetails = async (): Promise<void> => {
  await withDatabase(async ({ db, lock }) => {
    const good = addRecord(db, { uid: 'failure-record-a-good' })
    const bad = addRecord(db, { uid: 'failure-record-b-bad' })
    const modelVersion = 'record-maintenance-test-vector-v1'
    const failingKnowledge = {
      modelVersion,
      async rebuildRecordIndexInLock(
        recordUid: string,
        taskId = '',
        operation: 'rebuild_indexes' | 'optimize' | 'clean' | '' = ''
      ): Promise<number> {
        if (recordUid === bad.uid) throw new Error('deterministic vector failure')
        db.markRecordMaintenanceVectorReady(recordUid, modelVersion, 1, taskId, operation)
        return 1
      }
    } as unknown as KnowledgeService
    let recordsChanged = 0
    const service = new RecordMaintenanceService(
      db,
      failingKnowledge,
      lock,
      undefined,
      () => { recordsChanged += 1 }
    )
    const queued = service.start({ scope: 'all', operation: 'rebuild_indexes' })
    const completed = await waitForTask(service, queued.taskId)
    assert.equal(completed.status, 'completed_with_errors')
    assert.equal(completed.total, 2)
    assert.equal(completed.succeeded, 1)
    assert.equal(completed.failed, 1)
    assert.deepEqual(completed.failedItems, [{
      uid: bad.uid,
      name: bad.name,
      stage: 'vector',
      error: 'deterministic vector failure'
    }])

    const persisted = service.getTask()
    assert.equal(persisted?.status, 'completed_with_errors')
    assert.deepEqual(db.getRecordMaintenanceItems(queued.taskId).map((item) => ({
      uid: item.uid,
      status: item.status,
      stage: item.stage,
      error: item.error
    })), [
      { uid: good.uid, status: 'succeeded', stage: 'vector', error: undefined },
      { uid: bad.uid, status: 'failed', stage: 'vector', error: 'deterministic vector failure' }
    ])
    const failedState = db.getRecordMaintenanceState(bad.uid, modelVersion)
    assert.equal(failedState.overallStatus, 'failed')
    assert.equal(failedState.vector.status, 'failed')
    assert.equal(failedState.vector.error, 'deterministic vector failure')
    assert.equal(failedState.lastTaskId, queued.taskId)
    assert.equal(failedState.lastOperation, 'rebuild_indexes')
    assert.equal(recordsChanged, 1)
  })
}

const testEmbeddingInfrastructureFailureFailsTaskWithoutPerRecordExplosion = async (): Promise<void> => {
  await withDatabase(async ({ db, lock }) => {
    const records = [
      addRecord(db, { uid: 'embedding-health-record-a' }),
      addRecord(db, { uid: 'embedding-health-record-b' }),
      addRecord(db, { uid: 'embedding-health-record-c' })
    ]
    const previousModel = 'embedding-health-previous-model-v1'
    for (const record of records) {
      seedRecordVector(
        db,
        record,
        previousModel,
        `embedding-health-old-${record.uid}`,
        `old vector content for ${record.uid}`,
        `old-source-${record.uid}`
      )
    }
    const beforeVectors = records.map((record) => ({
      uid: record.uid,
      rows: recordVectorRows(db, record.uid, previousModel).map((row) => ({
        id: row.chunk.id,
        content: row.chunk.content,
        vector: [...row.vector]
      }))
    }))

    const modelVersion = 'embedding-health-current-model-v1'
    let rebuildCalls = 0
    const unavailableKnowledge = {
      modelVersion,
      async assertEmbeddingReady(): Promise<never> {
        throw new Error('本地 embedding 不可用：onnxruntime_binding.node DLL 初始化失败')
      },
      async rebuildRecordIndexesInLock(): Promise<never> {
        rebuildCalls += 1
        throw new Error('本地 embedding 不可用：onnxruntime_binding.node DLL 初始化失败')
      },
      async rebuildRecordIndexInLock(): Promise<never> {
        rebuildCalls += 1
        throw new Error('本地 embedding 不可用：onnxruntime_binding.node DLL 初始化失败')
      }
    } as unknown as KnowledgeService
    const service = new RecordMaintenanceService(db, unavailableKnowledge, lock)
    const queued = service.start({ scope: 'all', operation: 'rebuild_indexes' })
    const failed = await waitForTask(service, queued.taskId)

    assert.equal(failed.status, 'failed', 'embedding health failure must fail the maintenance task')
    assert.equal(
      failed.current,
      0,
      'an infrastructure failure must leave all records unprocessed'
    )
    assert.equal(failed.succeeded, 0)
    assert.equal(failed.failed, 0)
    assert.deepEqual(
      failed.failedItems,
      [],
      'one embedding infrastructure error must not become one failed item per record'
    )
    assert.ok(rebuildCalls <= 1, 'embedding health failure must be detected before repeated record work')

    const items = db.getRecordMaintenanceItems(queued.taskId)
    assert.equal(items.length, records.length)
    assert.ok(
      items.every((item) => item.status === 'pending'),
      'records left behind by an infrastructure failure must remain pending'
    )
    for (const before of beforeVectors) {
      assert.deepEqual(
        recordVectorRows(db, before.uid, previousModel).map((row) => ({
          id: row.chunk.id,
          content: row.chunk.content,
          vector: [...row.vector]
        })),
        before.rows,
        `old vectors must be preserved for ${before.uid}`
      )
    }
  })
}

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const main = async (): Promise<void> => {
  const previousFallback = process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
  const previousModelPath = process.env.VISSLM_EMBEDDING_MODEL_PATH
  const modelBlocker = await mkdtemp(join(tmpdir(), 'record-maintenance-model-blocker-'))
  await writeFile(join(modelBlocker, 'config.json'), '{}', 'utf8')
  process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = '1'
  process.env.VISSLM_EMBEDDING_MODEL_PATH = modelBlocker
  try {
    await testMigrationDefaultsAndReadOnlyPreviews()
    await testCleaningPreservesRawAndRefreshesFts()
    await testRecordVectorReindexIsTransactional()
    await testStoppedTaskPersistsPartialItems()
    await testPartialFailurePersistsFailureDetails()
    await testEmbeddingInfrastructureFailureFailsTaskWithoutPerRecordExplosion()
    await testSemanticInvalidationAndMaintenanceStatus()
    console.log(JSON.stringify({
      ok: true,
      contract: 'record-maintenance',
      checks: [
        'migration defaults and read-only all/selected previews',
        'non-destructive normalized cleaning and records FTS refresh',
        'record vector replacement only after successful embedding',
        'semantic invalidation and maintenance status reporting',
        'stopped task persistence with pending items',
        'partial failure details and failed vector state persistence',
        'embedding infrastructure failure is task-scoped and preserves old vectors'
      ]
    }))
  } finally {
    restoreEnvironment('VISSLM_KNOWLEDGE_TEST_FALLBACK', previousFallback)
    restoreEnvironment('VISSLM_EMBEDDING_MODEL_PATH', previousModelPath)
    await rm(modelBlocker, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
