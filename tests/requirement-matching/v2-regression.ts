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
import { buildRequirementSourceView } from '../../src/main/requirements/requirement-match-card'
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
  type RequirementMatchScoringSignals
} from '../../src/main/requirements/requirement-match-scoring'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

/**
 * Source-only regression boundary: retrieval, deterministic scoring, and the
 * explanation model remain separate. No test fixture persists or fabricates a
 * generated requirement card.
 */

const TEST_MODEL_VERSION = 'requirement-v2-regression-embedding-v1'
const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'requirement-v2-regression-model',
  thinking: false
}

const rerankerOnlyWeights = {
  semantic: 0,
  keyword: 0,
  domain: 0,
  requirementType: 0,
  productDomain: 0,
  module: 0,
  dense: 0,
  lexical: 0,
  reranker: 1
} as NonNullable<RequirementMatchScoringSignals['weights']>

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
    summary: 'The explanation batch was generated from the supplied source evidence.',
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

const sourceCandidate = (
  record: RecordDetail,
  denseScore = 0.5
): HybridRequirementCandidate => ({
  record,
  card: buildRequirementSourceView(record),
  denseScore,
  lexicalScore: denseScore,
  retrievalScore: denseScore,
  snippet: record.description
} as HybridRequirementCandidate)

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
  base: HybridRequirementCandidate['card'],
  candidates: HybridRequirementCandidate[]
): RequirementMatchExplanationRequest => ({ base, candidates })

const testHybridRecallUsesFullCurrentIndex = async (): Promise<void> => {
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
      description: 'A vector route identifies the reporting behavior.',
      module: 'reporting'
    })
    const lexicalOnly = addRecord(db, {
      uid: 'v2-bm25-source-only-uid',
      itemId: 'V2-BM25-SOURCE-ONLY',
      name: 'Lexical recall fixture',
      description: 'The reporting page exports report records to CSV.',
      module: 'reporting'
    })
    for (const record of [base, denseOnly, lexicalOnly]) addVectorIndex(db, record)

    const allCurrentIndexUids = [base.uid, denseOnly.uid, lexicalOnly.uid]
    const dense = denseStub(
      db,
      allCurrentIndexUids,
      [base.uid, denseOnly.uid],
      new Map([[denseOnly.uid, 91]])
    )
    const candidates = await new HybridRequirementRetriever(db, dense)
      .retrieve(buildRequirementSourceView(base), new Set([base.uid]))
    const byUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))

    assert.deepEqual(dense.allowedCalls, [allCurrentIndexUids.sort()])
    assert.ok(byUid.has(denseOnly.uid), 'Dense source-only candidate must remain eligible')
    assert.ok(byUid.has(lexicalOnly.uid), 'BM25 source-only candidate must remain eligible')
    assert.deepEqual(byUid.get(denseOnly.uid)?.card, buildRequirementSourceView(denseOnly))
    assert.deepEqual(byUid.get(lexicalOnly.uid)?.card, buildRequirementSourceView(lexicalOnly))
    assert.ok((byUid.get(denseOnly.uid)?.denseScore ?? 0) > 0)
    assert.ok((byUid.get(lexicalOnly.uid)?.lexicalScore ?? 0) > 0)
  })
}

const testCrossEncoderTop20FlowsToOneBatchExplanation = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-top20-base-uid',
      itemId: 'V2-TOP20-BASE',
      name: 'Top twenty base fixture',
      description: 'The reporting page exports records for review.',
      module: 'reporting'
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
    const baseCard = buildRequirementSourceView(base)
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

    assert.equal(reranked.length, 25)
    assert.equal(top20.length, 20)
    assert.equal(scored.length, 20)
    assert.equal(model.calls, 1)
    assert.equal(model.inputs[0]?.format !== undefined, true)
    assert.equal(explanationCandidates.length, 10)
    assert.equal(explanations.items.length, 10)
    assert.equal(
      explanationCandidates.every((item) => explanationByUid.has(item.candidate.record.uid)),
      true
    )
    for (const item of explanationCandidates) {
      const explanation = explanationByUid.get(item.candidate.record.uid)
      assert.ok(explanation)
      assert.equal('score' in explanation, false)
      assert.equal(explanation.relation, 'partial_overlap')
    }
    const explainedUids = new Set(explanationCandidates.map((item) => item.candidate.record.uid))
    assert.equal(scored.filter((item) => !explainedUids.has(item.candidate.record.uid)).length, 10)
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
    const baseCard = buildRequirementSourceView(base)
    const candidate = sourceCandidate(candidateRecord, 0.99)
    const result = scoreRequirementCandidate(baseCard, candidate, {
      denseScore: 0.99,
      rerankerScore: 61,
      weights: rerankerOnlyWeights
    })
    assert.equal(result.finalScore, 61)
    assert.equal(result.relation, 'partial_overlap')
    assert.equal(result.dimensions.reranker, 61)
    assert.equal(result.dimensions.dense, undefined)
    assert.notEqual(result.finalScore, candidate.denseScore)
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
      buildRequirementSourceView(baseRecord),
      [sourceCandidate(candidateRecord)]
    )
    const validModel = createExplanationModel(validExplanationBody)
    const valid = await explainRequirementMatches(validModel.client, request)
    assert.equal(validModel.calls, 1)
    assert.ok(valid.summary.length > 0)
    assert.deepEqual(valid.items.map((item) => item.recordUid), [candidateRecord.uid])
    assert.ok(valid.items[0]?.baseEvidence.includes('名称：'))
    assert.ok(valid.items[0]?.candidateEvidence.includes('名称：'))

    const unknownUid = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({
        summary: valid.summary,
        items: [{ ...valid.items[0], recordUid: 'v2-unknown-returned-uid' }]
      }),
      request
    )
    assert.equal(unknownUid.ok, false)
    if (!unknownUid.ok) assert.equal(unknownUid.error.code, 'uid')

    const invalidEvidence = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({
        summary: valid.summary,
        items: [{ ...valid.items[0], baseEvidence: 'B999', candidateEvidence: 'C999' }]
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
      buildRequirementSourceView(base),
      [sourceCandidate(candidateRecord)]
    )
    const deterministic = scoreRequirementCandidate(request.base, request.candidates[0]!, {
      rerankerScore: 61,
      weights: rerankerOnlyWeights
    })
    for (const body of ['not-json', '']) {
      const parsed = tryParseRequirementMatchExplanationResponse(body, request)
      assert.equal(parsed.ok, false, `${body || 'empty'} explanation must be rejected`)
      if (!parsed.ok) assert.ok(['non_json', 'empty_body'].includes(parsed.error.code))
    }
    assert.equal(deterministic.relation, 'partial_overlap')
    assert.equal(deterministic.finalScore, 61)
  })
}

const testRepeatedQueryRunsFreshExplanation = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'v2-repeat-base-uid',
      itemId: 'V2-REPEAT-BASE',
      name: 'Repeated query base fixture',
      description: 'The reporting page exports records for repeated-query validation.',
      module: 'reporting'
    })
    const candidate = addRecord(db, {
      uid: 'v2-repeat-candidate-uid',
      itemId: 'V2-REPEAT-CANDIDATE',
      name: 'Repeated query candidate fixture',
      description: 'The reporting page exports records for repeated-query validation.',
      module: 'reporting'
    })
    const currentCandidate = (): HybridRequirementCandidate => {
      const currentRecord = db.getRecord(candidate.uid, false)
      assert.ok(currentRecord)
      return sourceCandidate(currentRecord, 0.5)
    }
    const deterministicReranker: RequirementReranker = {
      modelId: 'v2-repeat-reranker',
      async rerank(_base, input) {
        return input.map((item) => ({ recordUid: item.record.uid, score: 61 }))
      }
    }
    const model = createExplanationModel(validExplanationBody)
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
        modelClient: model.client
      }
    )
    const first = await agent.ask({ question: '分析需求编号 V2-REPEAT-BASE' })
    assert.equal(model.calls, 1)
    assert.ok(first.sources.some((source) => source.itemId === 'V2-REPEAT-CANDIDATE'))
    const second = await agent.ask({ question: '分析需求编号 V2-REPEAT-BASE' })
    assert.equal(model.calls, 2, 'identical source query must run a fresh explanation batch')
    assert.ok(second.sources.some((source) => source.itemId === 'V2-REPEAT-CANDIDATE'))
    await agent.ask({ question: '请分析需求编号 V2-REPEAT-BASE' })
    assert.equal(model.calls, 3, 'changed wording must run a fresh explanation batch')
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
    const input = buildRequirementMatchExplanationInput({
      base: buildRequirementSourceView(base),
      candidates
    })
    const userMessage = input.messages.at(-1)?.content ?? ''
    assert.ok(userMessage.length < 50_000)
    assert.match(userMessage, /B001/)
    assert.match(userMessage, /C001/)
  })
}

type ContractTest = { name: string; run: () => Promise<void> }

const tests: ContractTest[] = [
  { name: 'hybrid recall keeps every current-index source-only record', run: testHybridRecallUsesFullCurrentIndex },
  { name: 'Cross-Encoder Top20 flows to one batch explanation', run: testCrossEncoderTop20FlowsToOneBatchExplanation },
  { name: 'final score is not cosine', run: testFinalScoreIsNotCosine },
  { name: 'UID and evidence validation fails closed', run: testUidAndEvidenceValidation },
  { name: 'malformed or empty explanation retains deterministic result', run: testMalformedExplanationKeepsDeterministicResult },
  { name: 'repeated query runs a fresh source-only explanation', run: testRepeatedQueryRunsFreshExplanation },
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
