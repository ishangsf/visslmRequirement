import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { RequirementAnalysisAgent } from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeRecordMatch } from '../../src/main/knowledge'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate,
  type RequirementDenseRetriever
} from '../../src/main/requirements/hybrid-retrieval'
import { buildRequirementSemanticCard, buildRequirementSourceView } from '../../src/main/requirements/semantic-card'
import type { RequirementSemanticCard } from '../../src/main/requirements/semantic-card'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

const TEST_MODEL_VERSION = 'test-current-index-v1'
const semanticContext = {
  analyzerVersion: 'current-index-semantic-v1',
  modelSignature: 'current-index-model-v1'
}

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

const persistReadySemanticCard = (db: AppDatabase, record: RecordDetail): RequirementSemanticCard => {
  const source = buildRequirementSemanticCard(record)
  const card: RequirementSemanticCard = {
    ...source,
    functionalObject: record.name,
    matchingText: source.evidence,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: record.name, confidence: 0.95, evidence: source.evidence.slice(0, 32) }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: '当前索引测试预置的 AI 语义卡片'
  }
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash)
  assert.equal(db.claimRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }), true)
  db.completeRequirementSemanticCard(record.uid, card)
  return card
}

const createControlledDenseRetriever = (
  db: AppDatabase,
  indexedUids: string[]
): RequirementDenseRetriever & { calls: string[]; allowedCalls: string[][] } => {
  const indexed = new Set(indexedUids)
  const calls: string[] = []
  const allowedCalls: string[][] = []
  return {
    modelVersion: TEST_MODEL_VERSION,
    calls,
    allowedCalls,
    async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
      return [...indexed].map((uid) => {
        const record = db.getRecord(uid, false)
        assert.ok(record, `indexed fixture record was not persisted: ${uid}`)
        return record
      })
    },
    async rankRequirementRecordMatches(
      question: string,
      limit = 100,
      allowedRecordUids?: ReadonlySet<string>
    ): Promise<KnowledgeRecordMatch[]> {
      calls.push(question)
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

const retrieveCandidates = async (
  db: AppDatabase,
  dense: RequirementDenseRetriever,
  baseUid: string,
  excludedUids: Set<string>
): Promise<HybridRequirementCandidate[]> => {
  const base = db.getRecord(baseUid, false)
  assert.ok(base, `base fixture record was not persisted: ${baseUid}`)
  const contentHash = db.getRecordContentHash(baseUid)
  assert.ok(contentHash)
  const baseCard = db.getReadyRequirementSemanticCard({ recordUid: baseUid, contentHash, ...semanticContext })
  assert.ok(baseCard, `base semantic card was not persisted: ${baseUid}`)
  return new HybridRequirementRetriever(db, dense, semanticContext).retrieve(
    baseCard,
    excludedUids
  )
}

const retrieveUids = async (
  db: AppDatabase,
  dense: RequirementDenseRetriever,
  baseUid: string,
  excludedUids: Set<string>
): Promise<string[]> => {
  const candidates = await retrieveCandidates(db, dense, baseUid, excludedUids)
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
  const indexedPendingSemantic = addRecord(db, {
    uid: 'indexed-pending-semantic-uid',
    projectId: 'project-other',
    nodeType: 'Requirement',
    itemId: 'INDEXED-PENDING-SEMANTIC',
    name: '已有向量但未语义化的订单需求',
    description: '订单管理页面支持查询订单明细，但尚未生成 AI 语义卡片。',
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
  addVectorIndex(db, indexedPendingSemantic)
  addVectorIndex(db, staleModelMatch, 'test-legacy-index-v1')
  persistReadySemanticCard(db, base)
  persistReadySemanticCard(db, indexedCrossScope)

  const indexedRows = db.listKnowledgeVectorRows(TEST_MODEL_VERSION)
  assert.deepEqual(
    indexedRows.map(({ chunk }) => chunk.recordUid).sort(),
    [indexedCrossScope.uid, indexedPendingSemantic.uid],
    'fixture must contain ready and pending-semantic current-index records'
  )
  const indexedDetails = db.listKnowledgeIndexedRecordDetails(TEST_MODEL_VERSION)
  assert.deepEqual(
    indexedDetails.map((record) => record.uid).sort(),
    [indexedCrossScope.uid, indexedPendingSemantic.uid],
    'current index details must exclude records that only have an older model version'
  )

  const dense = createControlledDenseRetriever(db, indexedDetails.map((record) => record.uid))
  const candidates = await retrieveCandidates(db, dense, base.uid, new Set([base.uid]))
  const candidateUids = candidates.map((candidate) => candidate.record.uid)
  const candidateByUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))

  assert.deepEqual(
    candidateUids,
    [indexedCrossScope.uid, indexedPendingSemantic.uid],
    'hybrid recall must include every current-index candidate, regardless of semantic-card readiness'
  )
  assert.deepEqual(
    dense.allowedCalls,
    [[indexedCrossScope.uid, indexedPendingSemantic.uid]],
    'Dense must receive the complete current embedding-index candidate set, not only ready-card records'
  )
  assert.ok(!candidateUids.includes(base.uid), 'the single base UID must be excluded')
  assert.ok(!candidateUids.includes(unindexedLexical.uid), 'an unindexed lexical match must be excluded')
  assert.ok(!candidateUids.includes(unindexedStructured.uid), 'an unindexed structured match must be excluded')
  assert.ok(!candidateUids.includes(staleModelMatch.uid), 'a lexical/structured match indexed only by an older model version must be excluded')
  assert.ok(candidateUids.includes(indexedCrossScope.uid), 'an indexed record from another project/node type remains eligible')

  const readyCandidate = candidateByUid.get(indexedCrossScope.uid)
  assert.ok(readyCandidate)
  assert.equal(readyCandidate.card.analysisStatus, 'ai_adjudicated', 'ready candidates must retain their AI semantic card')
  assert.equal(readyCandidate.card.functionalObject, indexedCrossScope.name, 'ready candidates must expose card-enhanced fields')
  assert.ok(readyCandidate.lexicalScore > 0, 'ready candidates must remain eligible for BM25 recall')
  assert.ok(readyCandidate.structuralScore > 0, 'structured recall must be available for ready candidates')

  const sourceOnlyCandidate = candidateByUid.get(indexedPendingSemantic.uid)
  assert.ok(sourceOnlyCandidate)
  assert.equal(sourceOnlyCandidate.card.analysisStatus, 'source_only', 'unsemanticized indexed candidates must receive a source-only source view')
  assert.deepEqual(
    sourceOnlyCandidate.card,
    buildRequirementSourceView(indexedPendingSemantic),
    'source-only candidate view must contain only readable source data'
  )
  assert.ok(sourceOnlyCandidate.lexicalScore > 0, 'source-only candidates must remain eligible for BM25 recall')
  assert.equal(sourceOnlyCandidate.structuralScore, 0, 'structured recall must not score candidates without ready AI cards')
}

const mathTypeSettings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'current-index-regression-model',
  thinking: false
}

const testMathTypeCurrentIndexCandidateFlowsToReview = async (db: AppDatabase): Promise<void> => {
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
    name: '数学公式在线编辑/MathType OLE',
    description: '支持数学公式在线编辑，并支持编辑 MathType OLE 公式对象。',
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

  assert.equal(db.getRequirementSemanticCardState(base.uid), null, 'the base fixture must have no AI semantic card')
  assert.equal(db.getRequirementSemanticCardState(indexedCandidate.uid), null, 'VISSLM-TSIS-79 fixture must have no AI semantic card')
  assert.equal(db.getRequirementSemanticCardState(unindexedCandidate.uid), null, 'unindexed fixture must have no AI semantic card')

  const dense = createControlledDenseRetriever(db, [base.uid, indexedCandidate.uid])
  const rerankerInputs: HybridRequirementCandidate[][] = []
  const reranker = {
    modelId: 'current-index-regression-reranker',
    async rerank(_base: RequirementSemanticCard, candidates: HybridRequirementCandidate[]) {
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
      const content = input.messages.at(-1)?.content ?? '{}'
      const payload = JSON.parse(content) as {
        summary?: string
        requirement?: { evidence?: string; semanticCardStatus?: string; evidenceSegments?: Array<{ id: string }> }
        candidates?: Array<{ recordUid: string; evidence?: string; semanticCardStatus?: string; evidenceSegments?: Array<{ id: string }> }>
      }
      assert.equal(payload.requirement?.semanticCardStatus, 'source_only', 'batch explanation must receive an unready base as source-only')
      assert.ok(payload.requirement?.evidence?.includes('导入 MathType 公式'), 'batch explanation must receive the base readable source evidence')
      assert.equal(payload.candidates?.length, 1, 'batch explanation should receive the indexed candidate after base exclusion')
      assert.equal(payload.candidates?.[0]?.recordUid, indexedCandidate.uid, 'batch explanation must receive the indexed candidate')
      assert.equal(payload.candidates?.[0]?.semanticCardStatus, 'source_only', 'batch explanation must receive the source-only card status')
      assert.ok(payload.candidates?.[0]?.evidence?.includes('MathType OLE'), 'batch explanation must receive the candidate readable source evidence')
      const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? ''
      const candidateEvidence = payload.candidates?.[0]?.evidenceSegments?.[0]?.id ?? ''
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'MathType 当前索引候选回归通过',
            items: [{
              recordUid: indexedCandidate.uid,
              similarities: ['都涉及 MathType 公式能力'],
              differences: ['基准关注导入，候选关注在线编辑与 OLE 对象'],
              baseEvidence,
              candidateEvidence
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
      retriever: new HybridRequirementRetriever(db, dense, semanticContext),
      reranker,
      modelClient,
      semanticContext
    }
  ).ask({ question: '分析需求编号 VISSLM-TSIS-4072' })

  assert.equal(rerankerInputs.length, 1, 'Cross-Encoder should receive one hybrid candidate batch')
  assert.deepEqual(rerankerInputs[0]?.map((candidate) => candidate.record.uid), [indexedCandidate.uid])
  assert.equal(rerankerInputs[0]?.[0]?.card.analysisStatus, 'source_only', 'Cross-Encoder must receive the source-only candidate card')
  assert.deepEqual(modelInputs.map((input) => JSON.parse(input.messages.at(-1)?.content ?? '{}').candidates.map((candidate: { recordUid: string }) => candidate.recordUid)), [
    [indexedCandidate.uid]
  ], 'the indexed candidate must receive one batch explanation')
  assert.ok(response.sources.some((source) => source.itemId === 'VISSLM-TSIS-79'), 'VISSLM-TSIS-4072 must recall VISSLM-TSIS-79')
  assert.ok(!response.sources.some((source) => source.itemId === 'VISSLM-TSIS-79-UNINDEXED'), 'unindexed MathType candidates must not be recalled')
  assert.ok(!response.sources.some((source) => source.itemId === 'VISSLM-TSIS-4072'), 'the base requirement UID must remain excluded')
  assert.deepEqual(
    dense.allowedCalls,
    [[base.uid, indexedCandidate.uid]],
    'MathType Dense scope must contain all current-index readable records, including the source-only candidate'
  )
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
  persistReadySemanticCard(db, baseOne)
  persistReadySemanticCard(db, baseTwo)
  persistReadySemanticCard(db, indexedCandidate)

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
    await testMathTypeCurrentIndexCandidateFlowsToReview(db)
    await testMultipleBaseUidExclusion(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'single base UID exclusion',
        'multiple base UID exclusion',
        'current-index records recalled with ready-card and source-only-card paths',
        'unindexed, lexical-only, structured-only, and stale-model records excluded',
        'current-index source-only candidate reaches Cross-Encoder and batch explanation'
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
