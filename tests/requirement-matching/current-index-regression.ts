import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { KnowledgeRecordMatch } from '../../src/main/knowledge'
import {
  HybridRequirementRetriever,
  type RequirementDenseRetriever
} from '../../src/main/requirements/hybrid-retrieval'
import { buildRequirementSemanticCard } from '../../src/main/requirements/semantic-card'
import type { RecordDetail } from '../../src/shared/types'

const TEST_MODEL_VERSION = 'test-current-index-v1'

type RecordFixture = {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  name: string
  description: string
  module: string
}

const addRecord = (db: AppDatabase, input: RecordFixture): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: input.projectId,
    nodeType: input.nodeType,
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      _valm_Description: input.description,
      IssueType: 'Enhancement',
      _valm_Module: input.module
    },
    normalizedText: `${input.name}\n${input.description}`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `fixture record was not persisted: ${input.uid}`)
  return record
}

const addVectorIndex = (
  db: AppDatabase,
  record: RecordDetail,
  modelVersion = TEST_MODEL_VERSION
): void => {
  const chunkId = `requirement-test-chunk:${modelVersion}:${record.uid}`
  db.replaceKnowledgeRecordChunks(
    record.uid,
    [{
      id: chunkId,
      recordUid: record.uid,
      sourceType: 'record',
      sourceName: record.name,
      sourceHash: `requirement-test-hash:${record.uid}`,
      content: record.normalizedText ?? record.description,
      chunkIndex: 0,
      location: 'test',
      charStart: 0,
      charEnd: (record.normalizedText ?? record.description).length
    }],
    [{
      chunkId,
      vector: new Float32Array([1, 0]),
      modelVersion
    }]
  )
}

const createControlledDenseRetriever = (
  db: AppDatabase,
  indexedUids: string[]
): RequirementDenseRetriever & { calls: string[] } => {
  const indexed = new Set(indexedUids)
  const calls: string[] = []
  return {
    modelVersion: TEST_MODEL_VERSION,
    calls,
    async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
      return [...indexed].map((uid) => {
        const record = db.getRecord(uid, false)
        assert.ok(record, `indexed fixture record was not persisted: ${uid}`)
        return record
      })
    },
    async rankRequirementRecordMatches(question: string, limit = 100): Promise<KnowledgeRecordMatch[]> {
      calls.push(question)
      return [...indexed]
        .map((uid, index) => {
          const record = db.getRecord(uid, false)
          assert.ok(record, `indexed fixture record was not persisted: ${uid}`)
          return {
            recordUid: uid,
            recordName: record.name,
            nodeType: record.nodeType,
            itemId: record.itemId,
            score: 100 - index,
            chunkId: `requirement-test-chunk:${uid}`,
            snippet: record.description
          }
        })
        .slice(0, limit)
    }
  }
}

const retrieveUids = async (
  db: AppDatabase,
  dense: RequirementDenseRetriever,
  baseUid: string,
  excludedUids: Set<string>
): Promise<string[]> => {
  const base = db.getRecord(baseUid, false)
  assert.ok(base, `base fixture record was not persisted: ${baseUid}`)
  const candidates = await new HybridRequirementRetriever(db, dense).retrieve(
    buildRequirementSemanticCard(base),
    excludedUids
  )
  return candidates.map((candidate) => candidate.record.uid)
}

const testCurrentIndexScopeAndSingleBaseExclusion = async (db: AppDatabase): Promise<void> => {
  const base = addRecord(db, {
    uid: 'base-single-uid',
    projectId: 'project-base',
    nodeType: 'Requirement',
    itemId: 'BASE-SINGLE',
    name: '订单明细导出',
    description: '订单管理页面支持导出订单明细。',
    module: '订单管理'
  })
  const indexedCrossScope = addRecord(db, {
    uid: 'indexed-cross-scope-uid',
    projectId: 'project-other',
    nodeType: 'Release',
    itemId: 'INDEXED-CROSS-SCOPE',
    name: '订单明细导出增强',
    description: '其他项目的发布节点支持导出订单明细。',
    module: '订单管理'
  })
  const unindexedLexical = addRecord(db, {
    uid: 'unindexed-lexical-uid',
    projectId: 'project-other',
    nodeType: 'Requirement',
    itemId: 'UNINDEXED-LEXICAL',
    name: '订单明细导出词法命中',
    description: '订单管理页面支持导出订单明细，词法内容与基准高度重合。',
    module: '订单管理'
  })
  const unindexedStructured = addRecord(db, {
    uid: 'unindexed-structured-uid',
    projectId: 'project-structured',
    nodeType: 'Task',
    itemId: 'UNINDEXED-STRUCTURED',
    name: '订单管理同模块结构化命中',
    description: '订单管理页面处理相关配置。',
    module: '订单管理'
  })
  const staleModelMatch = addRecord(db, {
    uid: 'stale-model-uid',
    projectId: 'project-stale',
    nodeType: 'Requirement',
    itemId: 'STALE-MODEL',
    name: '订单明细导出旧索引',
    description: '订单管理页面支持导出订单明细，只有旧 embedding 版本建立过索引。',
    module: '订单管理'
  })
  addVectorIndex(db, indexedCrossScope)
  addVectorIndex(db, staleModelMatch, 'test-legacy-index-v1')

  const indexedRows = db.listKnowledgeVectorRows(TEST_MODEL_VERSION)
  assert.deepEqual(
    indexedRows.map(({ chunk }) => chunk.recordUid),
    [indexedCrossScope.uid],
    'fixture must contain only the intended current vector-index record'
  )
  const indexedDetails = db.listKnowledgeIndexedRecordDetails(TEST_MODEL_VERSION)
  assert.deepEqual(
    indexedDetails.map((record) => record.uid),
    [indexedCrossScope.uid],
    'current index details must exclude records that only have an older model version'
  )

  const dense = createControlledDenseRetriever(db, indexedDetails.map((record) => record.uid))
  const candidateUids = await retrieveUids(db, dense, base.uid, new Set([base.uid]))

  assert.deepEqual(
    candidateUids,
    [indexedCrossScope.uid],
    'hybrid recall must not add records that only matched lexical or structured routes'
  )
  assert.ok(!candidateUids.includes(base.uid), 'the single base UID must be excluded')
  assert.ok(!candidateUids.includes(unindexedLexical.uid), 'an unindexed lexical match must be excluded')
  assert.ok(!candidateUids.includes(unindexedStructured.uid), 'an unindexed structured match must be excluded')
  assert.ok(!candidateUids.includes(staleModelMatch.uid), 'a lexical/structured match indexed only by an older model version must be excluded')
  assert.ok(candidateUids.includes(indexedCrossScope.uid), 'an indexed record from another project/node type remains eligible')
}

const testMultipleBaseUidExclusion = async (db: AppDatabase): Promise<void> => {
  const baseOne = addRecord(db, {
    uid: 'base-multiple-one-uid',
    projectId: 'project-base',
    nodeType: 'Requirement',
    itemId: 'BASE-MULTIPLE-ONE',
    name: '库存明细查询',
    description: '库存管理页面支持查询库存明细。',
    module: '库存管理'
  })
  const baseTwo = addRecord(db, {
    uid: 'base-multiple-two-uid',
    projectId: 'project-base',
    nodeType: 'Requirement',
    itemId: 'BASE-MULTIPLE-TWO',
    name: '库存明细导出',
    description: '库存管理页面支持导出库存明细。',
    module: '库存管理'
  })
  const indexedCandidate = addRecord(db, {
    uid: 'indexed-multiple-candidate-uid',
    projectId: 'project-other',
    nodeType: 'Milestone',
    itemId: 'INDEXED-MULTIPLE-CANDIDATE',
    name: '库存明细处理',
    description: '其他项目的里程碑支持处理库存明细。',
    module: '库存管理'
  })
  addVectorIndex(db, indexedCandidate)

  const dense = createControlledDenseRetriever(db, [
    baseOne.uid,
    baseTwo.uid,
    indexedCandidate.uid
  ])
  const excludedUids = new Set([baseOne.uid, baseTwo.uid])
  const firstCandidateUids = await retrieveUids(db, dense, baseOne.uid, excludedUids)
  const secondCandidateUids = await retrieveUids(db, dense, baseTwo.uid, excludedUids)

  assert.deepEqual(firstCandidateUids, [indexedCandidate.uid], 'all requested base UIDs must be excluded for the first base')
  assert.deepEqual(secondCandidateUids, [indexedCandidate.uid], 'all requested base UIDs must be excluded for the second base')
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-requirement-current-index-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'current-index.db'), join(directory, 'assets'))
    await testCurrentIndexScopeAndSingleBaseExclusion(db)
    await testMultipleBaseUidExclusion(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'single base UID exclusion',
        'multiple base UID exclusion',
        'unindexed, lexical-only, structured-only, and stale-model records excluded',
        'indexed records from another nodeType/project remain eligible'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
