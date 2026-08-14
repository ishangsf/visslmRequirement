import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase, type KnowledgeVectorInput } from '../../src/main/database'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate,
  type RequirementDenseRetriever
} from '../../src/main/requirements/hybrid-retrieval'
import {
  buildRequirementSemanticCard,
  type RequirementAction,
  type RequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import { RequirementAnalysisAgent } from '../../src/main/experts/requirement-analysis-agent'
import type { RequirementReranker } from '../../src/main/requirements/cross-encoder-reranker'
import {
  buildRequirementMatchExplanationInput,
  explainRequirementMatches,
  tryParseRequirementMatchExplanationResponse,
  type RequirementMatchExplanationRequest
} from '../../src/main/requirements/requirement-match-explainer'
import {
  scoreRequirementCandidate,
  scoreRequirementCards,
  type RequirementMatchScoringSignals
} from '../../src/main/requirements/requirement-match-scoring'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../../src/main/requirements/semanticization-service'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

/**
 * V2 regression boundary:
 * retrieval, deterministic scoring, and explanation are separate stages.
 * The explanation stage may add evidence text only; it cannot decide a
 * relation, replace a score, or turn a malformed response into a match.
 */

const TEST_MODEL_VERSION = 'requirement-v2-regression-embedding-v1'
const TEST_MATCH_SIGNATURE = 'requirement-v2-regression-match-v1'
const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'requirement-v2-regression-model',
  thinking: false
}
const semanticContext = {
  analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  modelSignature: requirementSemanticModelSignature(settings)
}

type FixtureRecord = {
  uid: string
  itemId: string
  name: string
  description: string
  module?: string
  issueType?: string
}

type ExplanationSegment = { id: string; text: string }

type ExplanationPrompt = {
  requirement?: { evidenceSegments?: ExplanationSegment[] }
  candidates?: Array<{
    recordUid: string
    evidenceSegments?: ExplanationSegment[]
  }>
}

type ExplanationModel = {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: number
  inputs: ModelChatInput[]
}

const rerankerOnlyWeights: NonNullable<RequirementMatchScoringSignals['weights']> = {
  semantic: 0,
  keyword: 0,
  domain: 0,
  object: 0,
  functionalObject: 0,
  action: 0,
  currentState: 0,
  targetState: 0,
  trigger: 0,
  input: 0,
  output: 0,
  behavior: 0,
  constraints: 0,
  acceptance: 0,
  businessScene: 0,
  requirementType: 0,
  productDomain: 0,
  module: 0,
  dense: 0,
  lexical: 0,
  structural: 0,
  reranker: 1
}

const behaviorOnlyWeights: NonNullable<RequirementMatchScoringSignals['weights']> = {
  ...rerankerOnlyWeights,
  behavior: 1,
  reranker: 0
}

const parseExplanationPrompt = (input: ModelChatInput): ExplanationPrompt => {
  try {
    const value = JSON.parse(input.messages.at(-1)?.content ?? '{}') as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as ExplanationPrompt
      : {}
  } catch {
    return {}
  }
}

const validExplanationBody = (input: ModelChatInput): Record<string, unknown> => {
  const prompt = parseExplanationPrompt(input)
  const baseEvidence = prompt.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
  return {
    summary: 'The explanation batch was generated from the supplied evidence.',
    items: (prompt.candidates ?? []).map((candidate) => ({
      recordUid: candidate.recordUid,
      relation: 'partial_overlap',
      similarities: ['Both records describe a related reporting capability.'],
      differences: ['The requested scope and target behavior are different.'],
      baseEvidence,
      candidateEvidence: candidate.evidenceSegments?.[0]?.id ?? 'C001'
    }))
  }
}

const createExplanationModel = (
  response: (input: ModelChatInput) => unknown
): ExplanationModel => {
  const model: ExplanationModel = {
    calls: 0,
    inputs: [],
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        model.inputs.push(input)
        const value = response(input)
        return {
          message: {
            role: 'assistant',
            content: typeof value === 'string' ? value : JSON.stringify(value)
          }
        }
      }
    }
  }
  return model
}

const addRecord = (db: AppDatabase, input: FixtureRecord): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'requirement-v2-regression-project',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: '2026-08-14T00:00:00.000Z',
    raw: {
      IssueType: input.issueType ?? 'Enhancement',
      _valm_Module: input.module ?? 'reporting',
      _valm_Description: input.description
    },
    normalizedText: `${input.name}\n${input.description}\n${input.module ?? 'reporting'}`
  })
  const record = db.getRecord(input.uid, false)
  if (!record) throw new Error(`fixture record was not persisted: ${input.uid}`)
  return record
}

const addVectorIndex = (db: AppDatabase, record: RecordDetail): void => {
  const chunkId = `requirement-v2-chunk-${record.uid}`
  const vector: KnowledgeVectorInput = {
    chunkId,
    vector: new Float32Array([1, 0, 0]),
    modelVersion: TEST_MODEL_VERSION
  }
  db.replaceKnowledgeRecordChunks(
    record.uid,
    [{
      id: chunkId,
      recordUid: record.uid,
      sourceType: 'record',
      sourceName: record.name,
      sourceHash: `requirement-v2-source-${record.uid}`,
      content: record.description,
      chunkIndex: 0,
      charStart: 0,
      charEnd: record.description.length
    }],
    [vector]
  )
}

const aiCard = (
  record: RecordDetail,
  overrides: { action?: RequirementAction; functionalObject?: string } = {}
): RequirementSemanticCard => {
  const source = buildRequirementSemanticCard(record)
  const functionalObject = overrides.functionalObject ?? record.name
  const action = overrides.action ?? 'add_capability'
  return {
    ...source,
    functionalObject,
    action,
    matchingText: `${source.evidence}\n功能对象：${functionalObject}`,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: functionalObject, confidence: 0.95, evidence: source.evidence },
      action: { value: action, confidence: 0.95, evidence: source.evidence }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: 'V2 regression fixture AI card'
  }
}

const persistReadyCard = (db: AppDatabase, record: RecordDetail, card: RequirementSemanticCard): void => {
  const contentHash = db.getRecordContentHash(record.uid)
  if (!contentHash) throw new Error(`fixture record has no semantic content hash: ${record.uid}`)
  assert.equal(
    db.claimRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    true,
    `fixture card claim failed: ${record.uid}`
  )
  db.completeRequirementSemanticCard(record.uid, card)
  assert.ok(
    db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    `fixture card was not ready: ${record.uid}`
  )
}

const sourceCandidate = (
  record: RecordDetail,
  denseScore = 0.5,
  card = buildRequirementSemanticCard(record)
): HybridRequirementCandidate => ({
  record,
  card,
  denseScore,
  lexicalScore: denseScore,
  structuralScore: 0,
  retrievalScore: denseScore,
  snippet: record.description
})

const denseStub = (
  db: AppDatabase,
  indexedUids: string[],
  denseRankedUids: string[],
  scores: ReadonlyMap<string, number> = new Map()
): RequirementDenseRetriever & { allowedCalls: string[][] } => {
  const allowedCalls: string[][] = []
  return {
    modelVersion: TEST_MODEL_VERSION,
    allowedCalls,
    async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
      return indexedUids.flatMap((uid) => {
        const record = db.getRecord(uid, false)
        return record ? [record] : []
      })
    },
    async rankRequirementRecordMatches(
      _question: string,
      limit = 100,
      allowedRecordUids?: ReadonlySet<string>
    ) {
      allowedCalls.push([...allowedRecordUids ?? []].sort())
      return denseRankedUids.flatMap((uid, index) => {
        if (allowedRecordUids && !allowedRecordUids.has(uid)) return []
        const record = db.getRecord(uid, false)
        return record ? [{
          recordUid: uid,
          recordName: record.name,
          nodeType: record.nodeType,
          itemId: record.itemId,
          score: scores.get(uid) ?? 100 - index,
          chunkId: `requirement-v2-chunk-${uid}`,
          snippet: record.description
        }] : []
      }).slice(0, limit)
    }
  }
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'requirement-v2-regression-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'regression.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const makeExplanationRequest = (
  base: RequirementSemanticCard,
  candidates: HybridRequirementCandidate[]
): RequirementMatchExplanationRequest => ({ base, candidates })

const testHybridRecallDoesNotFilterSourceOnly = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-base-uid',
      itemId: 'V2-BASE-FIXTURE',
      name: 'Report export settings',
      description: 'The reporting page exports report records for review.',
      module: 'reporting'
    })
    const denseOnly = addRecord(db, {
      uid: 'v2-dense-source-only-uid',
      itemId: 'V2-DENSE-SOURCE-ONLY',
      name: 'Vector recall fixture',
      description: 'A semantic vector route identifies the reporting behavior.',
      module: 'reporting'
    })
    const lexicalOnly = addRecord(db, {
      uid: 'v2-bm25-source-only-uid',
      itemId: 'V2-BM25-SOURCE-ONLY',
      name: 'Lexical recall fixture',
      description: 'The reporting page exports report records to CSV.',
      module: 'reporting'
    })
    const structured = addRecord(db, {
      uid: 'v2-structured-ready-uid',
      itemId: 'V2-STRUCTURED-READY',
      name: 'Structured recall fixture',
      description: 'The reporting module handles output configuration.',
      module: 'reporting'
    })
    for (const record of [base, denseOnly, lexicalOnly, structured]) addVectorIndex(db, record)

    const baseCard = aiCard(base, {
      action: 'add_capability',
      functionalObject: 'report export settings'
    })
    const structuredCard = aiCard(structured, {
      action: 'add_capability',
      functionalObject: 'report export settings'
    })
    persistReadyCard(db, base, baseCard)
    persistReadyCard(db, structured, structuredCard)

    const allCurrentIndexUids = [base.uid, denseOnly.uid, lexicalOnly.uid, structured.uid]
    const dense = denseStub(
      db,
      allCurrentIndexUids,
      [base.uid, denseOnly.uid],
      new Map([[denseOnly.uid, 91]])
    )
    const candidates = await new HybridRequirementRetriever(db, dense, semanticContext)
      .retrieve(baseCard, new Set([base.uid]))
    const byUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))

    assert.deepEqual(
      dense.allowedCalls,
      [allCurrentIndexUids.sort()],
      'Dense must receive every current-index UID, not only ready-card records'
    )
    assert.ok(byUid.has(denseOnly.uid), 'Dense source-only candidate must remain eligible')
    assert.ok(byUid.has(lexicalOnly.uid), 'BM25 source-only candidate must remain eligible')
    assert.ok(byUid.has(structured.uid), 'structured ready-card candidate must remain eligible')
    assert.equal(byUid.get(denseOnly.uid)?.card.analysisStatus, 'source_only')
    assert.equal(byUid.get(lexicalOnly.uid)?.card.analysisStatus, 'source_only')
    assert.equal(byUid.get(structured.uid)?.card.analysisStatus, 'ai_adjudicated')
    assert.ok((byUid.get(denseOnly.uid)?.denseScore ?? 0) > 0, 'Dense score must survive source-only fallback')
    assert.ok((byUid.get(lexicalOnly.uid)?.lexicalScore ?? 0) > 0, 'BM25 score must survive source-only fallback')
    assert.ok((byUid.get(structured.uid)?.structuralScore ?? 0) > 0, 'structured score must use a ready card')
  })
}

const testCrossEncoderTop20FlowsToOneBatchExplanation = async (): Promise<void> => {
  const baseRecord = {
    uid: 'v2-top20-base-uid',
    itemId: 'V2-TOP20-BASE',
    name: 'Top twenty base fixture',
    description: 'The reporting page exports records for review.',
    module: 'reporting'
  }
  await withDatabase(async (db) => {
    const base = addRecord(db, baseRecord)
    const baseCard = aiCard(base, {
      action: 'add_capability',
      functionalObject: 'report export'
    })
    const candidates = Array.from({ length: 25 }, (_, index) => {
      const record = addRecord(db, {
        uid: `v2-top20-candidate-${String(index + 1).padStart(2, '0')}-uid`,
        itemId: `V2-TOP20-CANDIDATE-${String(index + 1).padStart(2, '0')}`,
        name: `Top twenty candidate ${index + 1}`,
        description: `Candidate ${index + 1} describes reporting output behavior.`,
        module: 'reporting'
      })
      return sourceCandidate(record, 0.01 * (index + 1))
    })

    const crossEncoder: RequirementReranker = {
      modelId: 'requirement-v2-regression-cross-encoder',
      async rerank(_base, input) {
        return input
          .map((candidate, index) => ({ recordUid: candidate.record.uid, score: 100 - index }))
          .sort((left, right) => right.score - left.score)
      }
    }
    const reranked = await crossEncoder.rerank(baseCard, candidates)
    const top20 = reranked.slice(0, 20)
    const candidateByUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))
    const scored = top20.map((item) => {
      const candidate = candidateByUid.get(item.recordUid)
      assert.ok(candidate)
      return {
        candidate,
        score: scoreRequirementCandidate(baseCard, candidate, {
          rerankerScore: item.score,
          weights: rerankerOnlyWeights
        })
      }
    })
    const explanationCandidates = [...scored]
      .sort((left, right) => (
        right.score.finalScore - left.score.finalScore ||
        right.candidate.rerankerScore - left.candidate.rerankerScore ||
        right.candidate.retrievalScore - left.candidate.retrievalScore ||
        left.candidate.record.uid.localeCompare(right.candidate.record.uid)
      ))
      .slice(0, 10)
    const request = makeExplanationRequest(baseCard, explanationCandidates.map((item) => item.candidate))
    const model = createExplanationModel(validExplanationBody)
    const explanations = await explainRequirementMatches(model.client, request)
    const explanationByUid = new Map(explanations.items.map((item) => [item.recordUid, item]))

    assert.equal(reranked.length, 25, 'Cross-Encoder must score the full hybrid candidate set')
    assert.equal(top20.length, 20, 'only Cross-Encoder Top20 may enter V2 scoring')
    assert.equal(scored.length, 20, 'Cross-Encoder Top20 must all reach deterministic scoring')
    assert.equal(model.calls, 1, 'AI explanation must be exactly one batch call')
    assert.equal(model.inputs[0]?.format !== undefined, true, 'batch explanation must use a structured response schema')
    assert.equal(explanationCandidates.length, 10, 'only the top ten deterministic candidates may enter explanation')
    assert.equal(explanations.items.length, 10, 'the one explanation batch must cover only the top ten candidates')
    assert.equal(
      explanationCandidates.every((item) => explanationByUid.has(item.candidate.record.uid)),
      true,
      'each explained candidate must receive one explanation'
    )
    for (const item of explanationCandidates) {
      const explanation = explanationByUid.get(item.candidate.record.uid)
      assert.ok(explanation)
      assert.equal('relation' in explanation, true, 'explanation must return a validated relation')
      assert.equal('score' in explanation, false, 'explanation cannot return a score decision')
      assert.equal(explanation.relation, 'partial_overlap')
    }
    const explainedUids = new Set(explanationCandidates.map((item) => item.candidate.record.uid))
    assert.equal(
      scored.filter((item) => !explainedUids.has(item.candidate.record.uid)).length,
      10,
      'the ten candidates outside final-score Top10 must be deterministically scored but not explained'
    )
    assert.equal(
      [...explainedUids].every((uid) => explanationByUid.has(uid)),
      true,
      'final-score Top10 must be fully covered by the explanation batch'
    )
    assert.equal(candidateByUid.has(reranked[20]!.recordUid), true)
    assert.equal(scored.some((item) => item.candidate.record.uid === reranked[20]!.recordUid), false)
  })
}

const testFinalScoreIsNotCosine = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-score-base-uid',
      itemId: 'V2-SCORE-BASE',
      name: 'Score base fixture',
      description: 'The reporting page exports records for review.',
      module: 'reporting'
    })
    const candidateRecord = addRecord(db, {
      uid: 'v2-score-candidate-uid',
      itemId: 'V2-SCORE-CANDIDATE',
      name: 'Score candidate fixture',
      description: 'The reporting page exports records to CSV.',
      module: 'reporting'
    })
    const baseCard = aiCard(base, { functionalObject: 'report export' })
    const candidate = sourceCandidate(candidateRecord, 0.99)
    const result = scoreRequirementCandidate(baseCard, candidate, {
      denseScore: 0.99,
      rerankerScore: 61,
      weights: rerankerOnlyWeights
    })

    assert.equal(result.finalScore, 61, 'final score must come from deterministic business scoring')
    assert.equal(result.relation, 'partial_overlap')
    assert.equal(result.dimensions.reranker, 61)
    assert.equal(result.dimensions.dense, undefined, 'cosine/dense is not the final score dimension')
    assert.notEqual(result.finalScore, candidate.denseScore, 'final score must not be the cosine value')
  })
}

const testActionConflictDowngrades = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-action-base-uid',
      itemId: 'V2-ACTION-BASE',
      name: 'Action base fixture',
      description: 'The reporting page adds a new export capability.',
      module: 'reporting'
    })
    const candidate = addRecord(db, {
      uid: 'v2-action-candidate-uid',
      itemId: 'V2-ACTION-CANDIDATE',
      name: 'Action candidate fixture',
      description: 'The reporting page fixes an export defect.',
      module: 'reporting'
    })
    const baseCard = aiCard(base, { action: 'add_capability', functionalObject: 'report export' })
    const candidateCard = aiCard(candidate, { action: 'fix_defect', functionalObject: 'report export' })
    const result = scoreRequirementCards(baseCard, candidateCard, {
      dimensionScores: { behavior: 94 },
      weights: behaviorOnlyWeights
    })

    assert.equal(result.relation, 'topic_only', 'conflicting actions must be downgraded')
    assert.ok(result.finalScore <= 39, 'conflicting actions must cap the final score')
    assert.ok(result.downgradeReasons.length > 0, 'the downgrade must remain diagnosable')
  })
}

const testUidAndEvidenceValidation = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const baseRecord = addRecord(db, {
      uid: 'v2-validation-base-uid',
      itemId: 'V2-VALIDATION-BASE',
      name: 'Validation base fixture',
      description: 'The reporting page exports records for validation.',
      module: 'reporting'
    })
    const candidateRecord = addRecord(db, {
      uid: 'v2-validation-candidate-uid',
      itemId: 'V2-VALIDATION-CANDIDATE',
      name: 'Validation candidate fixture',
      description: 'The reporting page exports records for validation.',
      module: 'reporting'
    })
    const request = makeExplanationRequest(
      aiCard(baseRecord, { functionalObject: 'report export' }),
      [sourceCandidate(candidateRecord)]
    )
    const validModel = createExplanationModel(validExplanationBody)
    const valid = await explainRequirementMatches(validModel.client, request)
    assert.equal(validModel.calls, 1)
    assert.equal(valid.summary.length > 0, true, 'valid explanation must include a summary')
    assert.deepEqual(valid.items.map((item) => item.recordUid), [candidateRecord.uid], 'valid UID must be retained')
    assert.ok(valid.items[0]?.baseEvidence.includes('名称：'), 'base evidence must resolve to source text')
    assert.ok(valid.items[0]?.candidateEvidence.includes('名称：'), 'candidate evidence must resolve to source text')

    const unknownUid = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({
        summary: valid.summary,
        items: [{
          ...valid.items[0],
          recordUid: 'v2-unknown-returned-uid'
        }]
      }),
      request
    )
    assert.equal(unknownUid.ok, false)
    if (!unknownUid.ok) assert.equal(unknownUid.error.code, 'uid')

    const invalidEvidence = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({
        summary: valid.summary,
        items: [{
          ...valid.items[0],
          baseEvidence: 'B999',
          candidateEvidence: 'C999'
        }]
      }),
      request
    )
    assert.equal(invalidEvidence.ok, false)
    if (!invalidEvidence.ok) assert.equal(invalidEvidence.error.code, 'evidence')
  })
}

const testMalformedExplanationKeepsDeterministicResult = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-explanation-base-uid',
      itemId: 'V2-EXPLANATION-BASE',
      name: 'Explanation base fixture',
      description: 'The reporting page exports records for explanation fallback.',
      module: 'reporting'
    })
    const candidateRecord = addRecord(db, {
      uid: 'v2-explanation-candidate-uid',
      itemId: 'V2-EXPLANATION-CANDIDATE',
      name: 'Explanation candidate fixture',
      description: 'The reporting page exports records for explanation fallback.',
      module: 'reporting'
    })
    const request = makeExplanationRequest(
      aiCard(base, { functionalObject: 'report export' }),
      [sourceCandidate(candidateRecord)]
    )
    const deterministic = scoreRequirementCandidate(request.base, request.candidates[0]!, {
      rerankerScore: 61,
      weights: rerankerOnlyWeights
    })

    for (const body of ['not-json', '']) {
      const parsed = tryParseRequirementMatchExplanationResponse(body, request)
      assert.equal(parsed.ok, false, `${body || 'empty'} explanation must be rejected as protocol input`)
      if (!parsed.ok) {
        assert.ok(['non_json', 'empty_body'].includes(parsed.error.code))
      }
    }
    assert.equal(deterministic.relation, 'partial_overlap', 'fallback must retain deterministic relation')
    assert.equal(deterministic.finalScore, 61, 'fallback must retain deterministic score')
  })
}

const testDuplicateQueryUsesCache = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-cache-base-uid',
      itemId: 'V2-CACHE-BASE',
      name: 'Cache base fixture',
      description: 'The reporting page exports records for cache validation.',
      module: 'reporting'
    })
    const candidate = addRecord(db, {
      uid: 'v2-cache-candidate-uid',
      itemId: 'V2-CACHE-CANDIDATE',
      name: 'Cache candidate fixture',
      description: 'The reporting page exports records for cache validation.',
      module: 'reporting'
    })
    const baseCard = aiCard(base, { functionalObject: 'report export' })
    const candidateCard = aiCard(candidate, { functionalObject: 'report export' })
    persistReadyCard(db, base, baseCard)
    persistReadyCard(db, candidate, candidateCard)
    const deterministicReranker: RequirementReranker = {
      modelId: 'v2-cache-reranker',
      async rerank(_base, input) {
        return input.map((item) => ({ recordUid: item.record.uid, score: 61 }))
      }
    }
    const model = createExplanationModel(validExplanationBody)
    const currentCandidate = (): HybridRequirementCandidate => {
      const currentRecord = db.getRecord(candidate.uid, false)
      assert.ok(currentRecord)
      const currentContentHash = db.getRecordContentHash(candidate.uid)
      assert.ok(currentContentHash)
      const currentCard = db.getReadyRequirementSemanticCard({
        recordUid: candidate.uid,
        contentHash: currentContentHash,
        ...semanticContext
      }) ?? buildRequirementSemanticCard(currentRecord)
      return sourceCandidate(currentRecord, 0.5, currentCard)
    }
    const agent = new RequirementAnalysisAgent(
      db,
      {} as import('../../src/main/knowledge').KnowledgeService,
      settings,
      undefined,
      {
        retriever: {
          async retrieve(_base, excludedUids) {
            return excludedUids.has(base.uid) ? [currentCandidate()] : []
          }
        },
        reranker: deterministicReranker,
        modelClient: model.client,
        semanticContext,
        embeddingModelVersion: TEST_MODEL_VERSION,
        matchModelSignature: TEST_MATCH_SIGNATURE
      }
    )
    const first = await agent.ask({ question: '分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 1, 'first query should use one batch explanation call')
    assert.ok(first.sources.some((source) => source.itemId === 'V2-CACHE-CANDIDATE'))
    const second = await agent.ask({ question: '分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 1, 'second identical query must use persistent verified cache with zero model calls')
    assert.ok(second.sources.some((source) => source.itemId === 'V2-CACHE-CANDIDATE'))
    const changedQuestion = await agent.ask({ question: '请分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 2, 'query hash changes must invalidate the explanation cache')
    assert.ok(changedQuestion.sources.some((source) => source.itemId === 'V2-CACHE-CANDIDATE'))
    const changedSignatureAgent = new RequirementAnalysisAgent(
      db,
      {} as import('../../src/main/knowledge').KnowledgeService,
      settings,
      undefined,
      {
        retriever: {
          async retrieve(_base, excludedUids) {
            return excludedUids.has(base.uid) ? [currentCandidate()] : []
          }
        },
        reranker: deterministicReranker,
        modelClient: model.client,
        semanticContext,
        embeddingModelVersion: TEST_MODEL_VERSION,
        matchModelSignature: 'changed-match-signature'
      }
    )
    await changedSignatureAgent.ask({ question: '分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 3, 'explanation model signature changes must invalidate the cache')
    // The current match-cache contract tracks every stored source field.
    // Even a normalizedText-only source change therefore invalidates it.
    db.updateRecordNormalizedText(candidate.uid, `${candidate.normalizedText}\n纯元数据变化`)
    await agent.ask({ question: '分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 4, 'normalizedText-only source changes must invalidate the cache')
    addRecord(db, {
      uid: candidate.uid,
      itemId: candidate.itemId,
      name: 'Cache candidate fixture changed',
      description: 'The reporting page now exports records and status for cache validation.',
      module: 'reporting'
    })
    await agent.ask({ question: '分析需求编号 V2-CACHE-BASE' })
    assert.equal(model.calls, 5, 'candidate business content changes must invalidate the cache')
  })
}

const testExplanationPromptIsBounded = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-prompt-base-uid',
      itemId: 'V2-PROMPT-BASE',
      name: 'Prompt budget base',
      description: '原文'.repeat(8_000),
      module: 'reporting'
    })
    const candidates = Array.from({ length: 10 }, (_, index) => {
      const record = addRecord(db, {
        uid: `v2-prompt-candidate-${index}-uid`,
        itemId: `V2-PROMPT-CANDIDATE-${index}`,
        name: `Prompt budget candidate ${index}`,
        description: '候选原文'.repeat(8_000),
        module: 'reporting'
      })
      return sourceCandidate(record, 0.5)
    })
    const input = buildRequirementMatchExplanationInput({ base: aiCard(base), candidates })
    const userMessage = input.messages.at(-1)?.content ?? ''
    assert.ok(userMessage.length < 50_000, 'ten long candidates must fit the bounded explanation prompt')
    assert.match(userMessage, /B001/)
    assert.match(userMessage, /C001/)
  })
}

type ContractTest = { name: string; run: () => Promise<void> }

const tests: ContractTest[] = [
  { name: 'hybrid recall keeps Dense/BM25 source-only and structured candidates', run: testHybridRecallDoesNotFilterSourceOnly },
  { name: 'Cross-Encoder Top20 flows to one batch explanation without changing scores', run: testCrossEncoderTop20FlowsToOneBatchExplanation },
  { name: 'final score is not cosine', run: testFinalScoreIsNotCosine },
  { name: 'conflicting actions downgrade conservatively', run: testActionConflictDowngrades },
  { name: 'UID and evidence validation fails closed', run: testUidAndEvidenceValidation },
  { name: 'malformed or empty explanation retains deterministic result', run: testMalformedExplanationKeepsDeterministicResult },
  { name: 'duplicate query reuses conclusion cache', run: testDuplicateQueryUsesCache },
  { name: 'batch explanation prompt stays within a bounded context', run: testExplanationPromptIsBounded }
]

const main = async (): Promise<void> => {
  const results: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = []
  for (const test of tests) {
    try {
      await test.run()
      results.push({ name: test.name, status: 'passed' })
    } catch (error) {
      results.push({
        name: test.name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const failed = results.filter((result) => result.status === 'failed')
  console.log(JSON.stringify({
    ok: failed.length === 0,
    contract: 'requirement-analysis-v2',
    results
  }, null, 2))
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
