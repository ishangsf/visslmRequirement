import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import type { AnalyticsRecord } from '../src/main/database'
import type { KnowledgeChunkInput, KnowledgeVectorInput } from '../src/main/database'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { BackgroundTaskRunner } from '../src/main/background-task-runner'
import { KnowledgeService } from '../src/main/knowledge'
import type { DataScope, QuerySpec } from '../src/shared/query-spec'

const makeRecord = (index: number) => ({
  uid: `perf-record-${index}`,
  projectId: 'perf-project',
  nodeType: index % 2 === 0 ? 'Issue' : 'Task',
  itemId: `PERF-${index}`,
  parentId: '',
  name: `Performance record ${index}`,
  lastModifyTime: `2026-08-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
  raw: {
    status: index % 3 === 0 ? 'Open' : 'Closed',
    effort: index + 1,
    _valm_Release_text: index % 4 === 0 ? '2026.Q3' : '2026.Q4'
  },
  normalizedText: `Performance record ${index}`
})

const errorDetails = (error: unknown): { name: string; message: string } => ({
  name: error instanceof Error ? error.name : 'UnknownError',
  message: error instanceof Error ? error.message : String(error)
})

const run = async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), 'visslm-performance-regressions-'))
  let database: AppDatabase | undefined
  const timings: Record<string, number> = {}
  const checks: Record<string, unknown>[] = []

  try {
    database = new AppDatabase(join(directory, 'performance.db'), join(directory, 'assets'))

    // The batch API must wrap all writes in one transaction. Besides exercising
    // the public API, counting the wrapper calls makes this regression stable
    // across machines where wall-clock timings vary considerably.
    let transactionCount = 0
    const instrumentedDatabase = database as unknown as {
      runInTransaction(action: () => unknown): unknown
    }
    const originalRunInTransaction = database.runInTransaction.bind(database)
    instrumentedDatabase.runInTransaction = (action) => {
      transactionCount += 1
      return originalRunInTransaction(action)
    }

    const batch = Array.from({ length: 64 }, (_, index) => makeRecord(index))
    const batchStartedAt = performance.now()
    assert.equal(database.upsertRecords(batch), batch.length)
    timings.batchUpsertMs = Number((performance.now() - batchStartedAt).toFixed(2))
    assert.equal(transactionCount, 1, '批量写入必须只开启一个 SQLite 事务')
    assert.equal(database.getStats().recordCount, batch.length)
    assert.deepEqual(
      database.getStats().byRelease,
      [
        { name: '2026.Q4', value: 48 },
        { name: '2026.Q3', value: 16 }
      ],
      'SQLite JSON 聚合必须保持版本分布'
    )
    checks.push({
      name: 'database-batch-upsert',
      records: batch.length,
      transactionCount
    })

    // External work is not replayed automatically, but stale active rows must
    // become explicit failures after a process restart instead of remaining
    // "running/sending" forever in the UI.
    const interruptedSyncId = database.beginSync()
    const interruptedCollectionId = database.beginCollectionRequestLog({
      nodeType: 'Project',
      endpoint: 'https://example.test/rest/items',
      params: { VSearch: 'select _valm_Uid from Project' }
    })
    const interruptedPushId = database.beginPushLog({
      recordUid: 'perf-record-0',
      recordName: 'Performance record 0',
      endpoint: 'https://example.test/rest/items',
      params: { nodeType: 'Project' },
      body: { _valm_Name: 'Performance record 0' }
    })
    const repairedExternal = database.reconcileInterruptedExternalRuns()
    assert.equal(repairedExternal.syncRuns, 1)
    assert.equal(repairedExternal.collectionRequests, 1)
    assert.equal(repairedExternal.pushLogs, 1)
    assert.equal(database.listSyncRuns().find((run) => run.id === interruptedSyncId)?.status, 'failed')
    assert.equal(database.listCollectionRequestLogs(1, 10).rows.find((row) => row.id === interruptedCollectionId)?.status, 'failed')
    assert.equal(database.listPushLogs(1, 10).rows.find((row) => row.id === interruptedPushId)?.status, 'failed')
    checks.push({
      name: 'external-run-recovery',
      syncRuns: repairedExternal.syncRuns,
      collectionRequests: repairedExternal.collectionRequests,
      pushLogs: repairedExternal.pushLogs
    })

    // A duplicate in the same batch must roll back the earlier rows too.
    const countBeforeRollback = database.getStats().recordCount
    assert.throws(
      () => database!.upsertRecords([
        makeRecord(1000),
        { ...makeRecord(1001), itemId: makeRecord(1000).itemId }
      ]),
      /已存在/
    )
    assert.equal(database.getStats().recordCount, countBeforeRollback)
    assert.equal(transactionCount, 2)

    // Repeated reads at one analytics revision return the cached value. A
    // record write and an explicit revision bump must invalidate that value.
    const firstStats = database.getStats()
    const secondStats = database.getStats()
    assert.strictEqual(secondStats, firstStats, '相同修订号的统计应复用缓存对象')
    database.upsertRecord(makeRecord(64))
    const afterWriteStats = database.getStats()
    assert.notStrictEqual(afterWriteStats, firstStats, '记录写入后统计缓存必须失效')
    assert.equal(afterWriteStats.recordCount, batch.length + 1)
    assert.strictEqual(database.getStats(), afterWriteStats)
    const revisionBefore = database.getAnalyticsRevision()
    assert.equal(database.bumpAnalyticsRevision(), revisionBefore + 1)
    const afterRevisionStats = database.getStats()
    assert.notStrictEqual(afterRevisionStats, afterWriteStats, '数据修订号变化后统计缓存必须失效')
    assert.equal(afterRevisionStats.recordCount, batch.length + 1)
    checks.push({
      name: 'database-stats-cache',
      cachedIdentity: true,
      invalidatedAfterWrite: true,
      invalidatedAfterRevision: true,
      recordCount: afterRevisionStats.recordCount
    })

    // QueryEngine.profile() and execute() are separate public calls in the
    // dashboard flow. They should share one revision/scope snapshot, while a
    // revision change must force exactly one new scan.
    const scope: DataScope = { projectIds: ['snapshot-project'] }
    const snapshotRecords: AnalyticsRecord[] = [
      {
        uid: 'snapshot-1',
        projectId: 'snapshot-project',
        nodeType: 'Issue',
        itemId: 'SNAPSHOT-1',
        name: 'Snapshot issue 1',
        lastModifyTime: '2026-08-01T00:00:00.000Z',
        raw: { status: 'Open', effort: 3 }
      },
      {
        uid: 'snapshot-2',
        projectId: 'snapshot-project',
        nodeType: 'Issue',
        itemId: 'SNAPSHOT-2',
        name: 'Snapshot issue 2',
        lastModifyTime: '2026-08-02T00:00:00.000Z',
        raw: { status: 'Closed', effort: 5 }
      }
    ]
    let snapshotRevision = 7
    let scanCount = 0
    const analyticsDatabase = {
      scanAnalyticsRecords(currentScope: DataScope): AnalyticsRecord[] {
        scanCount += 1
        assert.deepEqual(currentScope, scope)
        return snapshotRecords
      },
      getAnalyticsRevision: () => snapshotRevision
    }
    const query: QuerySpec = {
      source: 'records',
      scope,
      dimensions: [{ field: 'status' }],
      measures: [{ id: 'records', aggregation: 'count' }]
    }
    const snapshotStartedAt = performance.now()
    const firstEngine = new QueryEngine(analyticsDatabase)
    firstEngine.profile(scope)
    const firstResult = firstEngine.execute(query)
    timings.querySnapshotMs = Number((performance.now() - snapshotStartedAt).toFixed(2))
    assert.equal(scanCount, 1, '画像和查询应复用同一份短期快照')
    assert.equal(firstResult.rows.reduce((sum, row) => sum + Number(row.records ?? 0), 0), 2)

    new QueryEngine(analyticsDatabase).execute(query)
    assert.equal(scanCount, 1, '同一修订号和范围的后续查询应继续复用快照')
    snapshotRevision += 1
    new QueryEngine(analyticsDatabase).execute(query)
    assert.equal(scanCount, 2, '数据修订号变化后应只重新扫描一次')
    checks.push({
      name: 'query-engine-record-snapshot',
      scansBeforeRevisionChange: 1,
      scansAfterRevisionChange: scanCount,
      matchedRows: firstResult.matchedRows
    })

    const taskRunner = new BackgroundTaskRunner()
    const task = taskRunner.begin('performance-cancel')
    assert.equal(taskRunner.size, 1)
    assert.equal(taskRunner.cancel('performance-cancel'), true)
    assert.equal(task.signal.aborted, true, '后台任务取消必须传播到 AbortSignal')
    await assert.rejects(() => task.checkpoint(), /任务已取消/)
    task.dispose()
    assert.equal(taskRunner.size, 0)
    checks.push({ name: 'background-task-cancellation', cancelled: true })

    const limitedRunner = new BackgroundTaskRunner(1)
    const limitedTask = limitedRunner.begin('performance-limit-1')
    assert.throws(
      () => limitedRunner.begin('performance-limit-2'),
      /并发上限/,
      '后台任务资源上限必须阻止未排队的第三个重任务'
    )
    limitedTask.dispose()
    assert.equal(limitedRunner.begin('performance-limit-2').taskId, 'performance-limit-2')
    limitedRunner.cancelAll()
    checks.push({ name: 'background-task-concurrency-limit', maxConcurrentTasks: 1 })

    // Startup recovery must make an interrupted knowledge task observable and
    // put its document back into the idempotent resume queue.
    const recoveryDocument = database.insertKnowledgeDocument({
      id: 'knowledge-recovery-document',
      fileName: 'recovery.txt',
      filePath: join(directory, 'recovery.txt'),
      extension: '.txt',
      mimeType: 'text/plain',
      byteSize: 12,
      sha256: 'knowledge-recovery-sha256',
      status: 'processing',
      modelVersion: 'smoke-model'
    })
    database.saveKnowledgeIndexProgress({
      taskId: 'knowledge-recovery-task',
      phase: 'embedding',
      documentId: recoveryDocument.id,
      fileName: recoveryDocument.fileName,
      message: '正在生成向量',
      current: 1,
      total: 2,
      elapsedMs: 2_500,
      throughputPerSecond: 0.4,
      status: 'running'
    })
    assert.ok(database.reconcileInterruptedKnowledgeTasks() >= 2)
    const recoveredKnowledgeTask = database.getKnowledgeIndexProgress('knowledge-recovery-task')
    assert.equal(recoveredKnowledgeTask?.status, 'failed')
    assert.equal(recoveredKnowledgeTask?.elapsedMs, 2_500)
    assert.equal(recoveredKnowledgeTask?.throughputPerSecond, 0.4)
    assert.equal(database.getKnowledgeDocument(recoveryDocument.id)?.status, 'queued')
    checks.push({
      name: 'knowledge-task-recovery',
      status: 'failed',
      documentStatus: 'queued',
      elapsedMs: recoveredKnowledgeTask?.elapsedMs,
      throughputPerSecond: recoveredKnowledgeTask?.throughputPerSecond
    })

    // A streamed legacy import records its committed batches independently of
    // the data transaction. Restart cleanup must preserve that diagnostic
    // trail while marking the run incomplete instead of silently losing it.
    const importRunId = database.startDataImportRun(join(directory, 'records.jsonl'), 'jsonl', 123, 456)
    database.updateDataImportRun(importRunId, {
      batchCount: 2,
      sourceRowCount: 512,
      importedRecordCount: 500,
      skippedCount: 12,
      reviewBatchId: 'review-batch-smoke'
    })
    assert.equal(database.getDataImportRun(importRunId)?.status, 'running')
    assert.equal(database.reconcileInterruptedDataImports(), 1)
    const interruptedImport = database.getDataImportRun(importRunId)
    assert.equal(interruptedImport?.status, 'failed')
    assert.equal(interruptedImport?.batchCount, 2)
    assert.equal(interruptedImport?.fileSize, 123)
    assert.equal(interruptedImport?.fileMtimeMs, 456)
    assert.ok(
      database.listDataImportRuns(10).some((run) => run.id === importRunId),
      '导入运行列表必须包含重启清理后的诊断记录'
    )
    const resumedImport = database.resumeDataImportRun(importRunId)
    assert.equal(resumedImport?.status, 'running')
    assert.equal(resumedImport?.sourceRowCount, 512)
    database.finishDataImportRun(importRunId, 'failed', {
      batchCount: resumedImport?.batchCount,
      sourceRowCount: resumedImport?.sourceRowCount,
      importedRecordCount: resumedImport?.importedRecordCount,
      skippedCount: resumedImport?.skippedCount,
      parseErrorCount: resumedImport?.parseErrorCount,
      reviewBatchId: resumedImport?.reviewBatchId,
      errorMessage: 'smoke reset'
    })
    checks.push({
      name: 'data-import-run-recovery',
      status: interruptedImport?.status,
      batchCount: interruptedImport?.batchCount,
      resumeCheckpoint: resumedImport?.sourceRowCount
    })

    const atomicImportRunId = database.startDataImportRun(join(directory, 'atomic.jsonl'), 'jsonl')
    const atomicImport = database.importRows([{
      documentId: 'Task:atomic-import-record',
      title: 'Atomic import checkpoint',
      content: 'atomic import checkpoint',
      metadata: {
        sourceId: 'atomic-import-record',
        recordType: 'Task',
        projectId: 'perf-project',
        itemId: 'ATOMIC-IMPORT-1',
        updatedAt: '2026-08-25T00:00:00.000Z'
      },
      raw: {
        _valm_Uid: 'atomic-import-record',
        _valm_NodeType: 'Task',
        _valm_Name: 'Atomic import checkpoint',
        _valm_ItemID: 'ATOMIC-IMPORT-1'
      }
    }], {
      importRunId: atomicImportRunId,
      batchNumber: 1,
      sourceRowCount: 1,
      parseErrorCount: 2
    })
    assert.equal(atomicImport.recordCount, 1)
    const atomicSnapshot = database.getDataImportRun(atomicImportRunId)
    assert.equal(atomicSnapshot?.importedRecordCount, 1)
    assert.equal(atomicSnapshot?.parseErrorCount, 2)
    assert.equal(atomicSnapshot?.skippedCount, 2)
    checks.push({
      name: 'data-import-atomic-checkpoint',
      recordCount: atomicImport.recordCount,
      parserErrorsIncludedInCheckpoint: atomicSnapshot?.skippedCount === 2
    })

    // Newly written vectors carry their normalized coarse representation so a
    // later shard/backfill pass does not need to rescan the full dimensions.
    const vectorDocument = database.insertKnowledgeDocument({
      id: 'knowledge-coarse-document',
      fileName: 'coarse.txt',
      filePath: join(directory, 'coarse.txt'),
      extension: '.txt',
      mimeType: 'text/plain',
      byteSize: 10,
      sha256: 'knowledge-coarse-sha256',
      status: 'ready',
      modelVersion: 'smoke-model'
    })
    const coarseChunk: KnowledgeChunkInput = {
      id: 'knowledge-coarse-chunk',
      documentId: vectorDocument.id,
      sourceType: 'document',
      sourceName: vectorDocument.fileName,
      sourceHash: vectorDocument.sha256,
      content: 'coarse vector smoke',
      chunkIndex: 0
    }
    const coarseVector: KnowledgeVectorInput = {
      chunkId: coarseChunk.id,
      vector: new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      modelVersion: 'smoke-model'
    }
    database.replaceKnowledgeDocumentChunks(vectorDocument.id, [coarseChunk], [coarseVector])
    const coarseRows = database.listKnowledgeVectorRows('smoke-model')
    assert.equal(coarseRows.length, 1)
    assert.ok((coarseRows[0].coarse?.length ?? 0) > 0)
    checks.push({ name: 'knowledge-coarse-vector-persistence', coarseDimension: coarseRows[0].coarse?.length })

    // Identical questions within the short TTL reuse the same ranked result,
    // avoiding a second embedding/ranking pass while retaining bounded memory.
    const searchDatabase = new AppDatabase(join(directory, 'search.db'), join(directory, 'search-assets'))
    const previousFallback = process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
    process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = '1'
    try {
      const service = new KnowledgeService(searchDatabase)
      await (service as unknown as { embeddings: { prepare: () => Promise<void> } }).embeddings.prepare()
      const searchModelVersion = service.modelVersion
      const searchDocument = searchDatabase.insertKnowledgeDocument({
        id: 'knowledge-search-document',
        fileName: 'search.txt',
        filePath: join(directory, 'search.txt'),
        extension: '.txt',
        mimeType: 'text/plain',
        byteSize: 12,
        sha256: 'knowledge-search-sha256',
        status: 'ready',
        modelVersion: searchModelVersion
      })
      const searchChunk: KnowledgeChunkInput = {
        id: 'knowledge-search-chunk',
        documentId: searchDocument.id,
        sourceType: 'document',
        sourceName: searchDocument.fileName,
        sourceHash: searchDocument.sha256,
        content: '重复问题缓存 smoke',
        chunkIndex: 0
      }
      searchDatabase.replaceKnowledgeDocumentChunks(searchDocument.id, [searchChunk], [{
        chunkId: searchChunk.id,
        vector: new Float32Array(384).fill(0.01),
        modelVersion: searchModelVersion
      }])
      assert.equal(searchDatabase.listKnowledgeVectorRows(searchModelVersion).length, 1)
      const firstSearch = await service.search('重复问题缓存 smoke', 3)
      const searchCache = (service as unknown as { searchResultCache: Map<string, unknown> }).searchResultCache
      assert.equal(searchCache.size, 1, '搜索结果缓存应写入一条记录')
      const secondSearch = await service.search('重复问题缓存 smoke', 3)
      assert.strictEqual(secondSearch, firstSearch, '相同问题应在短 TTL 内复用搜索结果')
      checks.push({ name: 'knowledge-search-result-cache', resultIdentityReused: true })
    } finally {
      if (previousFallback === undefined) delete process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
      else process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = previousFallback
      searchDatabase.close()
    }

    console.log(JSON.stringify({ ok: true, checks, timings }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, checks, timings, error: errorDetails(error) }, null, 2))
    process.exitCode = 1
  } finally {
    try { database?.close() } catch { /* best-effort cleanup for a failed smoke */ }
    rmSync(directory, { recursive: true, force: true })
  }
}

void run()
