import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { RequirementAnalysisAgent } from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeRecordMatch, KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate,
  type RequirementDenseRetriever
} from '../../src/main/requirements/hybrid-retrieval'
import { buildRequirementSourceView } from '../../src/main/requirements/requirement-match-card'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

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
  const content = record.normalizedText ?? record.description
  db.replaceKnowledgeRecordChunks(
    record.uid,
    [{
      id: chunkId,
      recordUid: record.uid,
      sourceType: 'record',
      sourceName: record.name,
      sourceHash: `requirement-test-hash:${record.uid}`,
      content,
      chunkIndex: 0,
      location: 'test',
      charStart: 0,
      charEnd: content.length
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
): RequirementDenseRetriever & { allowedCalls: string[][] } => {
  const indexed = new Set(indexedUids)
  const allowedCalls: string[][] = []
  return {
    modelVersion: TEST_MODEL_VERSION,
    allowedCalls,
    async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
      return [...indexed].map((uid) => {
        const record = db.getRecord(uid, false)
        assert.ok(record, `indexed fixture record was not persisted: ${uid}`)
        return record
      })
    },
    async rankRequirementRecordMatches(
      _question: string,
      limit = 100,
      allowedRecordUids?: ReadonlySet<string>
    ): Promise<KnowledgeRecordMatch[]> {
      allowedCalls.push([...(allowedRecordUids ?? [])].sort())
      return [...indexed]
        .filter((uid) => !allowedRecordUids || allowedRecordUids.has(uid))
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

const sourceCandidate = (
  db: AppDatabase,
  uid: string,
  score = 80
): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `candidate fixture was not persisted: ${uid}`)
  const card = buildRequirementSourceView(record)
  // Keep this fixture independent of optional score dimensions. The matcher
  // must be able to consume a source-only card without any generated fields.
  return {
    record,
    card,
    denseScore: score,
    lexicalScore: score - 3,
    retrievalScore: score / 100,
    snippet: record.description
  } as HybridRequirementCandidate
}

const retrieveCandidates = async (
  db: AppDatabase,
  dense: RequirementDenseRetriever,
  baseUid: string,
  excludedUids: Set<string>
): Promise<HybridRequirementCandidate[]> => {
  const base = db.getRecord(baseUid, false)
  assert.ok(base, `base fixture was not persisted: ${baseUid}`)
  return new HybridRequirementRetriever(db, dense).retrieve(
    buildRequirementSourceView(base),
    excludedUids
  )
}

const assertSourceOnlyCard = (
  candidate: HybridRequirementCandidate,
  record: RecordDetail
): void => {
  assert.deepEqual(candidate.card, buildRequirementSourceView(record))
  assert.deepEqual(Object.keys(candidate.card).sort(), [
    'artifactType', 'businessFacts', 'evidence', 'lexicalTerms', 'matchingText', 'module', 'productDomain',
    'requirementType', 'sourceDescription', 'sourceTitle'
  ].sort())
  assert.ok(candidate.card.evidence.includes(record.name))
}

const testCurrentIndexScopeAndSourceOnlyRecall = async (db: AppDatabase): Promise<void> => {
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
  const indexedSourceOnly = addRecord(db, {
    uid: 'indexed-source-only-uid',
    projectId: 'project-other',
    nodeType: 'Requirement',
    itemId: 'INDEXED-SOURCE-ONLY',
    name: '已有向量的订单需求',
    description: '订单管理页面支持查询订单明细，只有完整原文可供匹配。',
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
  const staleModelMatch = addRecord(db, {
    uid: 'stale-model-uid',
    projectId: 'project-stale',
    nodeType: 'Requirement',
    itemId: 'STALE-MODEL',
    name: '订单明细导出旧索引',
    description: '订单管理页面支持导出订单明细，但只有旧 embedding 版本建立过索引。',
    module: '订单管理'
  })
  addVectorIndex(db, indexedCrossScope)
  addVectorIndex(db, indexedSourceOnly)
  addVectorIndex(db, staleModelMatch, 'test-legacy-index-v1')

  const indexedDetails = db.listKnowledgeIndexedRecordDetails(TEST_MODEL_VERSION)
  assert.deepEqual(
    indexedDetails.map((record) => record.uid).sort(),
    [indexedCrossScope.uid, indexedSourceOnly.uid],
    'only current-model indexed records are eligible for matching'
  )
  const dense = createControlledDenseRetriever(db, indexedDetails.map((record) => record.uid))
  const candidates = await retrieveCandidates(db, dense, base.uid, new Set([base.uid]))
  const candidateUids = candidates.map((candidate) => candidate.record.uid)

  assert.deepEqual(
    candidateUids,
    [indexedCrossScope.uid, indexedSourceOnly.uid],
    'full current index must be recalled from cleaned source records'
  )
  assert.deepEqual(
    dense.allowedCalls,
    [[indexedCrossScope.uid, indexedSourceOnly.uid]],
    'Dense must receive the complete current-index UID set'
  )
  assert.ok(!candidateUids.includes(base.uid), 'the base UID must be excluded')
  assert.ok(!candidateUids.includes(unindexedLexical.uid), 'an unindexed lexical hit must be excluded')
  assert.ok(!candidateUids.includes(staleModelMatch.uid), 'an older-model index must be excluded')
  assertSourceOnlyCard(candidates[0]!, indexedCrossScope)
  assertSourceOnlyCard(candidates[1]!, indexedSourceOnly)
  assert.ok(candidates.every((candidate) => candidate.lexicalScore > 0), 'source-only records remain eligible for lexical recall')
}

const mathTypeSettings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'current-index-regression-model',
  thinking: false
}

const testCurrentIndexCandidateFlowsToReview = async (db: AppDatabase): Promise<void> => {
  const base = addRecord(db, {
    uid: 'mathtype-base-uid',
    projectId: 'project-mathtype',
    nodeType: 'Requirement',
    itemId: 'VISSLM-TSIS-4072',
    name: '支持 MathType 公式导入',
    description: '需求支持导入 MathType 公式，并保留导入后的数学公式内容。',
    module: '公式编辑'
  })
  const indexedCandidate = addRecord(db, {
    uid: 'mathtype-indexed-candidate-uid',
    projectId: 'project-mathtype',
    nodeType: 'Requirement',
    itemId: 'VISSLM-TSIS-79',
    name: '数学公式导入/MathType OLE',
    description: '支持导入数学公式，并保留 MathType OLE 公式对象。',
    module: '公式编辑'
  })
  const unindexedCandidate = addRecord(db, {
    uid: 'mathtype-unindexed-candidate-uid',
    projectId: 'project-mathtype',
    nodeType: 'Requirement',
    itemId: 'VISSLM-TSIS-79-UNINDEXED',
    name: '未索引的 MathType 公式候选',
    description: '同样涉及数学公式在线编辑和 MathType OLE，但没有当前 embedding 索引。',
    module: '公式编辑'
  })
  addVectorIndex(db, base)
  addVectorIndex(db, indexedCandidate)

  const dense = createControlledDenseRetriever(db, [base.uid, indexedCandidate.uid])
  const rerankerInputs: HybridRequirementCandidate[][] = []
  const reranker = {
    modelId: 'current-index-regression-reranker',
    async rerank(_base: HybridRequirementCandidate['card'], candidates: HybridRequirementCandidate[]) {
      rerankerInputs.push(candidates)
      return candidates.map((candidate, index) => ({
        recordUid: candidate.record.uid,
        score: 90 - index
      }))
    }
  }
  const modelInputs: ModelChatInput[] = []
  const modelClient = {
    async chat(input: ModelChatInput): Promise<ModelResponse> {
      modelInputs.push(input)
      const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
        requirement?: { evidence?: string; evidenceSegments?: Array<{ id: string }> }
        candidates?: Array<{ recordUid: string; evidence?: string; evidenceSegments?: Array<{ id: string }> }>
      }
      assert.ok(payload.requirement?.evidence?.includes('导入 MathType 公式'))
      assert.equal(payload.candidates?.length, 1)
      assert.equal(payload.candidates?.[0]?.recordUid, indexedCandidate.uid)
      assert.ok(payload.candidates?.[0]?.evidence?.includes('MathType OLE'))
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'MathType 当前索引候选回归通过',
            items: [{
              recordUid: indexedCandidate.uid,
              relation: 'partial_overlap',
              similarities: ['都涉及 MathType 公式能力'],
              differences: ['候选额外明确 MathType OLE 对象保留'],
              baseEvidence: payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001',
              candidateEvidence: payload.candidates?.[0]?.evidenceSegments?.[0]?.id ?? 'C001'
            }]
          })
        }
      }
    }
  }
  const response = await new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    mathTypeSettings,
    undefined,
    {
      retriever: new HybridRequirementRetriever(db, dense),
      reranker,
      modelClient
    }
  ).ask({ question: '分析需求编号 4072' })

  assert.equal(rerankerInputs.length, 1)
  assert.deepEqual(rerankerInputs[0]?.map((candidate) => candidate.record.uid), [indexedCandidate.uid])
  assertSourceOnlyCard(rerankerInputs[0]![0]!, indexedCandidate)
  assert.equal(modelInputs.length, 1, 'one current-index base uses one batch explanation call')
  assert.ok(response.sources.some((source) => source.itemId === 'VISSLM-TSIS-79'))
  assert.ok(!response.sources.some((source) => source.itemId === unindexedCandidate.itemId))
  assert.ok(!response.sources.some((source) => source.itemId === base.itemId))
  assert.deepEqual(dense.allowedCalls, [[base.uid, indexedCandidate.uid]])
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
  addVectorIndex(db, baseOne)
  addVectorIndex(db, baseTwo)
  addVectorIndex(db, indexedCandidate)
  const dense = createControlledDenseRetriever(db, [baseOne.uid, baseTwo.uid, indexedCandidate.uid])
  const excludedUids = new Set([baseOne.uid, baseTwo.uid])
  const first = await retrieveCandidates(db, dense, baseOne.uid, excludedUids)
  const second = await retrieveCandidates(db, dense, baseTwo.uid, excludedUids)
  assert.deepEqual(first.map((candidate) => candidate.record.uid), [indexedCandidate.uid])
  assert.deepEqual(second.map((candidate) => candidate.record.uid), [indexedCandidate.uid])
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-requirement-current-index-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'current-index.db'), join(directory, 'assets'))
    await testCurrentIndexScopeAndSourceOnlyRecall(db)
    await testCurrentIndexCandidateFlowsToReview(db)
    await testMultipleBaseUidExclusion(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'single and multiple base UID exclusion',
        'all current-index records recalled as source-only cards',
        'unindexed and stale-model records excluded',
        'source-only current-index candidate reaches Cross-Encoder and batch explanation',
        'explanation payload carries cleaned source evidence'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
