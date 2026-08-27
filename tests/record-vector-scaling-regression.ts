import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type RecordInput } from '../src/main/database'
import {
  KnowledgeService,
  type KnowledgeRecordIndexBatchOptions,
  type KnowledgeRecordIndexBatchResult
} from '../src/main/knowledge'
import { RecordMaintenanceService } from '../src/main/record-maintenance'
import { AsyncMutex } from '../src/main/record-index-lock'
import type { RecordMaintenanceTaskSnapshot } from '../src/shared/types'

const TEST_MODEL_VERSION = 'record-vector-scaling-regression-v1'
const RECORD_COUNT = 96
const MAX_EMBED_BATCH_SIZE = 64
const MAX_INITIAL_EMBED_CALLS = 8
const ASSET_CENTER_RECORD_COUNT = 65
const ASSET_CENTER_BATCH_SIZE = 32
const TERMINAL_MAINTENANCE_STATUSES = new Set<RecordMaintenanceTaskSnapshot['status']>([
  'completed',
  'completed_with_errors',
  'stopped',
  'failed'
])

type EmbeddingProbe = {
  modelVersion: string
  available: boolean
  unavailableReason: string
  prepare: () => Promise<void>
  embedMany: (texts: string[]) => Promise<Float32Array[]>
}

class DeterministicEmbeddingProbe implements EmbeddingProbe {
  readonly modelVersion = TEST_MODEL_VERSION
  readonly available = true
  readonly unavailableReason = 'deterministic embedding probe unavailable'
  readonly batches: string[][] = []
  shouldFail = false

  async prepare(): Promise<void> {}

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    this.batches.push([...texts])
    if (this.shouldFail) throw new Error('deterministic embedding failure')
    return texts.map((text) => this.vectorFor(text))
  }

  reset(): void {
    this.batches.length = 0
  }

  private vectorFor(text: string): Float32Array {
    let hash = 2166136261
    for (const character of text) {
      hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619)
    }
    return new Float32Array([
      text.length,
      hash >>> 0,
      text.codePointAt(0) ?? 0,
      text.codePointAt(Math.max(0, text.length - 1)) ?? 0
    ])
  }
}

type VectorSnapshot = {
  chunkId: string
  content: string
  vector: number[]
}

type RecordIndexSnapshot = Map<string, VectorSnapshot[]>

const installEmbeddingProbe = (
  service: KnowledgeService,
  probe: EmbeddingProbe
): void => {
  const runtimeService = service as unknown as { embeddings: EmbeddingProbe }
  runtimeService.embeddings = probe
}

const recordInput = (index: number, description?: string): RecordInput => {
  const uid = `record-vector-scale-${String(index).padStart(3, '0')}`
  const name = `批处理记录 ${String(index).padStart(3, '0')}`
  const content = description ?? `稳定采集内容 ${index}，用于验证批量向量索引。`
  return {
    uid,
    projectId: 'record-vector-scaling-regression-project',
    nodeType: 'Requirement',
    itemId: `RVS-${String(index).padStart(3, '0')}`,
    parentId: '',
    name,
    lastModifyTime: '2026-08-27T00:00:00.000Z',
    raw: {
      IssueType: 'Enhancement',
      _valm_Description: content,
      _valm_Module: 'record-vector-scaling-regression'
    },
    normalizedText: `${name}\n${content}`
  }
}

const snapshotRecordIndex = (
  db: AppDatabase,
  modelVersion: string
): RecordIndexSnapshot => {
  const snapshot: RecordIndexSnapshot = new Map()
  for (const row of db.listKnowledgeVectorRows(modelVersion)) {
    const recordUid = row.chunk.recordUid
    if (!recordUid) continue
    const rows = snapshot.get(recordUid) ?? []
    rows.push({
      chunkId: row.chunk.id,
      content: row.chunk.content,
      vector: Array.from(row.vector)
    })
    snapshot.set(recordUid, rows)
  }
  for (const rows of snapshot.values()) rows.sort((left, right) => left.chunkId.localeCompare(right.chunkId))
  return snapshot
}

const assertCompleteCurrentIndex = (
  db: AppDatabase,
  modelVersion: string,
  expectedRecordUids: readonly string[]
): RecordIndexSnapshot => {
  const snapshot = snapshotRecordIndex(db, modelVersion)
  assert.equal(
    snapshot.size,
    expectedRecordUids.length,
    'every fixture record must have a current-model vector'
  )
  for (const uid of expectedRecordUids) {
    const rows = snapshot.get(uid)
    assert.ok(rows, `missing current-model vector for ${uid}`)
    assert.equal(rows.length, 1, `short fixture ${uid} should produce exactly one chunk/vector`)
    assert.equal(
      db.getKnowledgeRecordIndexModelVersion(uid),
      modelVersion,
      `record ${uid} must report the current embedding model`
    )
  }
  return snapshot
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T>): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'record-vector-scaling-regression-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'record-vector-scaling.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    try {
      db?.close()
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  }
}

const waitForMaintenanceTask = async (
  service: RecordMaintenanceService,
  taskId: string,
  timeoutMs = 10_000
): Promise<RecordMaintenanceTaskSnapshot> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = service.getTask()
    if (
      snapshot?.taskId === taskId &&
      TERMINAL_MAINTENANCE_STATUSES.has(snapshot.status)
    ) {
      return snapshot
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`record maintenance task did not finish: ${taskId}`)
}

const testBatchingIdempotenceIncrementalRebuildAndFailureSafety = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const inputs = Array.from({ length: RECORD_COUNT }, (_value, index) => recordInput(index))
    db.upsertRecords(inputs)
    const recordUids = inputs.map((input) => input.uid)
    const changedUid = recordUids[Math.floor(RECORD_COUNT / 2)]
    assert.ok(changedUid)

    const probe = new DeterministicEmbeddingProbe()
    const knowledge = new KnowledgeService(db)
    installEmbeddingProbe(knowledge, probe)

    await knowledge.syncRecordIndexInLock()
    assert.ok(probe.batches.length > 0, 'initial sync must request embeddings')
    assert.ok(
      probe.batches.length <= MAX_INITIAL_EMBED_CALLS,
      `initial sync should batch ${RECORD_COUNT} records, got ${probe.batches.length} embedding calls`
    )
    assert.ok(
      probe.batches.every((batch) => batch.length > 0 && batch.length <= MAX_EMBED_BATCH_SIZE),
      `embedding batches must be non-empty and no larger than ${MAX_EMBED_BATCH_SIZE}`
    )
    assert.equal(
      probe.batches.reduce((total, batch) => total + batch.length, 0),
      RECORD_COUNT,
      'initial sync must embed every short record exactly once'
    )
    const beforeChange = assertCompleteCurrentIndex(db, TEST_MODEL_VERSION, recordUids)

    probe.reset()
    await knowledge.syncRecordIndexInLock()
    assert.equal(probe.batches.length, 0, 'unchanged sync must not call embedding again')

    const oldChanged = beforeChange.get(changedUid)
    assert.ok(oldChanged?.[0], `missing old index snapshot for ${changedUid}`)
    const oldChangedChunk = oldChanged[0]
    const changedDescription = `内容已变化 ${changedUid}，仅此记录需要重新生成向量。`
    db.updateRecordRawAndNormalizedText(
      changedUid,
      {
        IssueType: 'Enhancement',
        _valm_Description: changedDescription,
        _valm_Module: 'record-vector-scaling-regression'
      },
      `${changedUid}\n${changedDescription}`
    )
    const changedRow = db.getKnowledgeRecordIndexRow(changedUid)
    assert.ok(changedRow)
    assert.notEqual(
      changedRow.contentHash,
      db.getKnowledgeRecordIndexHash(changedUid),
      'a changed record must no longer match the old chunk source hash'
    )

    const beforeFailure = snapshotRecordIndex(db, TEST_MODEL_VERSION)
    assert.deepEqual(beforeFailure, beforeChange, 'record mutation must not alter the persisted old index before sync')
    probe.reset()
    probe.shouldFail = true
    await assert.rejects(
      () => knowledge.syncRecordIndexInLock(),
      /deterministic embedding failure/,
      'embedding failure should be surfaced by record-index sync'
    )
    assert.equal(probe.batches.length, 1, 'one dirty short record should be sent in one failing batch')
    assert.deepEqual(
      probe.batches.flat(),
      [changedRow.content],
      'the failing incremental request must contain only the changed record'
    )
    assert.deepEqual(
      snapshotRecordIndex(db, TEST_MODEL_VERSION),
      beforeChange,
      'failed embedding must preserve all old chunks and vectors'
    )

    probe.shouldFail = false
    probe.reset()
    await knowledge.syncRecordIndexInLock()
    assert.ok(probe.batches.length > 0 && probe.batches.length <= 1, 'one changed short record needs at most one embedding batch')
    assert.ok(
      probe.batches.every((batch) => batch.length > 0 && batch.length <= MAX_EMBED_BATCH_SIZE),
      'incremental embedding batch must remain within the global batch bound'
    )
    assert.deepEqual(
      probe.batches.flat(),
      [changedRow.content],
      'incremental rebuild must embed only the changed record'
    )

    const afterChange = assertCompleteCurrentIndex(db, TEST_MODEL_VERSION, recordUids)
    const newChanged = afterChange.get(changedUid)
    assert.ok(newChanged?.[0])
    assert.notEqual(newChanged[0].chunkId, oldChangedChunk.chunkId, 'changed content must replace the old chunk')
    assert.equal(newChanged[0].content, changedRow.content, 'changed content must be persisted in the new chunk')
    assert.notDeepEqual(newChanged[0].vector, oldChangedChunk.vector, 'changed content must receive a new deterministic vector')
    for (const uid of recordUids) {
      if (uid === changedUid) continue
      assert.deepEqual(
        afterChange.get(uid),
        beforeChange.get(uid),
        `unchanged record ${uid} must retain its existing chunk and vector`
      )
    }
  })
}

const testAssetCenterLargeRebuildUsesBatchOrchestration = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const inputs = Array.from(
      { length: ASSET_CENTER_RECORD_COUNT },
      (_value, index) => recordInput(index)
    )
    db.upsertRecords(inputs)
    const expectedUids = inputs.map((input) => input.uid)
    const batchCalls: string[][] = []
    const callbackUids: string[] = []
    let singleCalls = 0
    const fakeKnowledge = {
      modelVersion: 'asset-center-vector-batch-regression-v1',
      async rebuildRecordIndexesInLock(
        recordUids: string[],
        _taskId = '',
        _operation = '',
        options: KnowledgeRecordIndexBatchOptions = {}
      ): Promise<KnowledgeRecordIndexBatchResult> {
        batchCalls.push([...recordUids])
        const results = recordUids.map((uid) => ({ uid, chunkCount: 1 }))
        for (const result of results) {
          callbackUids.push(result.uid)
          await options.onRecordComplete?.(result)
        }
        return {
          results,
          succeeded: results.length,
          failed: 0,
          stopped: false
        }
      },
      async rebuildRecordIndexInLock(): Promise<number> {
        singleCalls += 1
        throw new Error('single-record vector rebuild must not be used for a large maintenance task')
      }
    } as unknown as KnowledgeService
    const service = new RecordMaintenanceService(db, fakeKnowledge, new AsyncMutex())

    const queued = service.start({ scope: 'all', operation: 'rebuild_indexes' })
    const completed = await waitForMaintenanceTask(service, queued.taskId)
    const flattenedUids = batchCalls.flat()

    assert.equal(batchCalls.length, 3, '65 records must be orchestrated as three vector batches')
    assert.deepEqual(
      batchCalls.map((batch) => batch.length),
      [32, 32, 1],
      'asset-center maintenance must use 32-record windows'
    )
    assert.ok(
      batchCalls.every((batch) => batch.length > 0 && batch.length <= ASSET_CENTER_BATCH_SIZE),
      'every asset-center vector batch must be non-empty and contain at most 32 records'
    )
    assert.equal(flattenedUids.length, ASSET_CENTER_RECORD_COUNT, 'batch calls must cover all 65 records once')
    assert.deepEqual(
      [...new Set(flattenedUids)].sort(),
      [...expectedUids].sort(),
      'batch calls must cover exactly the maintenance target UIDs'
    )
    assert.deepEqual(
      [...callbackUids].sort(),
      [...expectedUids].sort(),
      'fake batch indexing must report one successful callback per record'
    )
    assert.equal(singleCalls, 0, 'maintenance batching must not fall back to single-record rebuilds')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.total, ASSET_CENTER_RECORD_COUNT)
    assert.equal(completed.current, ASSET_CENTER_RECORD_COUNT)
    assert.equal(completed.succeeded, ASSET_CENTER_RECORD_COUNT)
    assert.equal(completed.failed, 0)
    assert.deepEqual(completed.failedItems, [])
    const items = db.getRecordMaintenanceItems(queued.taskId)
    assert.equal(items.length, ASSET_CENTER_RECORD_COUNT)
    assert.ok(items.every((item) => item.status === 'succeeded' && item.stage === 'vector'))
  })
}

const main = async (): Promise<void> => {
  await testBatchingIdempotenceIncrementalRebuildAndFailureSafety()
  await testAssetCenterLargeRebuildUsesBatchOrchestration()
  console.log(JSON.stringify({
    ok: true,
    contract: 'record-vector-scaling',
    checks: [
      'large record set is embedded in bounded batches',
      'unchanged rerun performs zero embedding calls',
      'one changed record rebuilds only its own chunk/vector',
      'failed embedding preserves the previous record index',
      'asset-center rebuild_indexes uses 32-record maintenance batches'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
