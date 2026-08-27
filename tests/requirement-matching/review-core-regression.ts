import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'
import { RequirementAnalysisAgent } from '../../src/main/experts/requirement-analysis-agent'
import type { RequirementReranker } from '../../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import {
  buildRequirementSourceView,
  type RequirementMatchCard
} from '../../src/main/requirements/requirement-match-card'
import { extractRequirementBusinessFacts } from '../../src/main/requirements/requirement-business-normalization'
import {
  RequirementMatchingCore,
  type RequirementMatchingDependencies
} from '../../src/main/requirements/requirement-matching-core'
import type {
  RequirementMatchRequest,
  RequirementMatchResult
} from '../../src/main/requirements/requirement-match-domain'

const card = (text: string): RequirementMatchCard => ({
  requirementType: '功能需求',
  productDomain: '订单',
  module: '订单管理',
  sourceTitle: text,
  sourceDescription: text,
  evidence: text,
  matchingText: text,
  lexicalTerms: [text],
  businessFacts: extractRequirementBusinessFacts(text)
})

const candidate = (
  uid: string,
  text: string,
  projectId = 'project-other',
  retrievalScore = 0.5
): HybridRequirementCandidate => ({
  record: { uid, projectId, name: text } as RecordDetail,
  card: card(text),
  denseScore: retrievalScore,
  lexicalScore: retrievalScore,
  retrievalScore,
  snippet: text
})

const request = (base: RequirementMatchCard): RequirementMatchRequest => ({
  base,
  excludedUids: new Set<string>(),
  includeCurrentProjectRecords: false,
  explainTopN: 0,
  explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }
})

const reranker = (modelId: string, calls: string[][]): RequirementReranker => ({
  modelId,
  async rerank(_base, candidates) {
    calls.push(candidates.map((item) => item.record.uid))
    return candidates.map((item, index) => ({ recordUid: item.record.uid, score: 80 - index }))
  }
})

// Mutation caught: retaining exact-hash or retrieved candidates after candidateEligible=false,
// including current-project records when includeCurrentProjectRecords=false.
const testIneligibleCandidatesAreExcludedBeforeRerank = async (): Promise<void> => {
  const currentProjectId = 'project-current'
  const base = card('查询订单详情')
  const exactCurrent = candidate('exact-current', '查询订单详情', currentProjectId, 0)
  const retrievedCurrent = candidate('retrieved-current', '查询订单字段', currentProjectId, 0.9)
  const rerankerCalls: string[][] = []
  const eligibilityChecks: Array<{ uid: string; includeCurrentProjectRecords: boolean }> = []
  const core = new RequirementMatchingCore({
    retriever: { async retrieve() { return [retrievedCurrent] } },
    reranker: reranker('review-ineligible-reranker', rerankerCalls),
    async exactBusinessHashCandidates() { return [exactCurrent] },
    candidateEligible(item, matchRequest) {
      eligibilityChecks.push({ uid: item.record.uid, includeCurrentProjectRecords: matchRequest.includeCurrentProjectRecords })
      return matchRequest.includeCurrentProjectRecords || item.record.projectId !== currentProjectId
    }
  })

  const result = await core.match(request(base))

  assert.deepEqual(result.candidates.map((item) => item.recordUid), [])
  assert.equal(rerankerCalls.length, 0)
  assert.deepEqual(new Set(eligibilityChecks.map((item) => item.uid)), new Set(['exact-current', 'retrieved-current']))
  assert.ok(eligibilityChecks.every((item) => item.includeCurrentProjectRecords === false))
}

// Mutation caught: prepending an exact-hash candidate and renumbering every retrieved candidate's true RRF fusedRank.
// Mutation caught: allowing exact-hash injection to evict one of the original RRF Top20 reranker inputs.
const testExactInjectionPreservesRrfRanksAndTop20 = async (): Promise<void> => {
  const base = card('查询订单详情')
  const retrieved = Array.from({ length: 20 }, (_, index) => candidate(
    `retrieved-${String(index).padStart(2, '0')}`,
    `查询订单字段${index}`,
    'project-other',
    1 - index / 100
  ))
  const exact = candidate('exact-injected', '查询订单详情', 'project-other', 0)
  const rerankerCalls: string[][] = []
  const dependencies: RequirementMatchingDependencies = {
    retriever: { async retrieve() { return retrieved } },
    reranker: reranker('review-exact-reranker', rerankerCalls),
    async exactBusinessHashCandidates() { return [exact] },
    candidateEligible() { return true }
  }

  const result = await new RequirementMatchingCore(dependencies).match(request(base))
  const firstRetrieved = result.candidates.find((item) => item.recordUid === 'retrieved-00')
  const lastRetrieved = result.candidates.find((item) => item.recordUid === 'retrieved-19')
  const exactResult = result.candidates.find((item) => item.recordUid === exact.record.uid)

  assert.equal(firstRetrieved?.stageScores.fusedRank, 1)
  assert.equal(lastRetrieved?.stageScores.fusedRank, 20)
  assert.deepEqual(rerankerCalls, [retrieved.map((item) => item.record.uid)])
  assert.equal(exactResult?.decisionStatus, 'confirmed')
  assert.equal(exactResult?.rankingScore, 100)
}

type AuditableReranker = RequirementReranker & { readonly modelVersion: string }

const auditableReranker = (modelId: string, modelVersion: string): AuditableReranker => ({
  modelId,
  modelVersion,
  async rerank(_base, candidates) {
    return candidates.map((item) => ({ recordUid: item.record.uid, score: 60 }))
  }
})

const coreWithReranker = (rerankerDependency: RequirementReranker): RequirementMatchingCore => new RequirementMatchingCore({
  retriever: { async retrieve() { return [candidate('provenance-candidate', '查询订单字段')] } },
  reranker: rerankerDependency,
  async exactBusinessHashCandidates() { return [] },
  candidateEligible() { return true }
})

// Mutation caught: recording only the mutable reranker model id/path in RequirementMatchResult.modelVersion.
const testResultUsesPinnedRerankerIdentity = async (): Promise<void> => {
  const pinnedModelVersion = 'bge-reranker-base-int8-local-v1'
  const result = await coreWithReranker(
    auditableReranker('Xenova/bge-reranker-base/latest', pinnedModelVersion)
  ).match(request(card('查询订单详情')))

  assert.equal(result.modelVersion, pinnedModelVersion)
}

// Mutation caught: including a mutable reranker model id/path in configHash when the pinned audit identity is unchanged.
const testConfigHashUsesPinnedRerankerIdentity = async (): Promise<void> => {
  const pinnedModelVersion = 'bge-reranker-base-int8-local-v1'
  const first = await coreWithReranker(
    auditableReranker('cache/reranker/latest', pinnedModelVersion)
  ).match(request(card('查询订单详情')))
  const second = await coreWithReranker(
    auditableReranker('cache/reranker/rotated-path', pinnedModelVersion)
  ).match(request(card('查询订单详情')))

  assert.equal(first.configHash, second.configHash)
}

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'review-agent-model',
  thinking: false
}

const seedRecord = (
  db: AppDatabase,
  uid: string,
  itemId: string,
  projectId: string,
  name: string,
  description: string
): RecordDetail => {
  db.upsertRecord({
    uid,
    projectId,
    nodeType: 'Requirement',
    itemId,
    parentId: '',
    name,
    lastModifyTime: '2026-08-28T00:00:00.000Z',
    raw: {
      IssueType: 'Enhancement',
      _valm_Module: '订单管理',
      _valm_Description: description
    },
    normalizedText: `${name}\n${description}`
  })
  const record = db.getRecord(uid, false)
  assert.ok(record)
  return record
}

// Mutation caught: constructing the reduced fallback core instead of honoring the production-injected shared core.
const testRequirementAgentUsesInjectedSharedCore = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'review-core-agent-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'review.db'), join(directory, 'assets'))
    const base = seedRecord(db, 'review-agent-base', 'REVIEW-AGENT-BASE', 'project-current', '订单查询', '支持查询订单详情。')
    const injectedCandidate = seedRecord(db, 'review-agent-candidate', 'REVIEW-AGENT-CANDIDATE', 'project-other', '订单详情查询', '支持查询订单详情并展示状态。')
    const calls: RequirementMatchRequest[] = []
    const injectedCore = {
      async match(matchRequest: RequirementMatchRequest): Promise<RequirementMatchResult> {
        calls.push(matchRequest)
        return {
          normalizationVersion: 'review-normalization-v1',
          pipelineVersion: 'review-injected-pipeline-v1',
          rankingVersion: 'review-injected-ranking-v1',
          configHash: 'review-injected-config',
          modelVersion: 'review-injected-model',
          degradationCodes: [],
          candidates: [{
            recordUid: injectedCandidate.uid,
            finalRank: 1,
            rankingScore: 100,
            rankingVersion: 'review-injected-ranking-v1',
            relation: 'duplicate',
            decisionStatus: 'confirmed',
            evidenceLevel: 'exact_business_hash',
            reasonCodes: ['EXACT_BUSINESS_HASH'],
            degradationCodes: [],
            stageScores: {
              denseRank: 1,
              denseScore: 100,
              lexicalRank: 1,
              lexicalScore: 100,
              fusedRank: 1,
              fusedScore: 100,
              rerankerRank: 1,
              rerankerScore: 100
            },
            explanation: null
          }]
        }
      }
    } as unknown as RequirementMatchingCore

    const response = await new RequirementAnalysisAgent(
      db,
      {} as KnowledgeService,
      settings,
      undefined,
      { matchingCore: injectedCore }
    ).ask({ question: `分析需求编号 ${base.itemId}` })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.includeCurrentProjectRecords, false)
    assert.ok(response.sources.some((source) => source.uid === injectedCandidate.uid))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const tests: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'ineligible candidates are excluded before rerank', run: testIneligibleCandidatesAreExcludedBeforeRerank },
  { name: 'exact injection preserves RRF ranks and original Top20', run: testExactInjectionPreservesRrfRanksAndTop20 },
  { name: 'result uses pinned reranker identity', run: testResultUsesPinnedRerankerIdentity },
  { name: 'config hash uses pinned reranker identity', run: testConfigHashUsesPinnedRerankerIdentity },
  { name: 'RequirementAnalysisAgent uses injected shared core', run: testRequirementAgentUsesInjectedSharedCore }
]

const main = async (): Promise<void> => {
  const failures: Array<{ name: string; error: unknown }> = []
  for (const test of tests) {
    try {
      await test.run()
      console.log(`PASS ${test.name}`)
    } catch (error) {
      failures.push({ name: test.name, error })
      console.error(`FAIL ${test.name}`)
      console.error(error)
    }
  }
  if (failures.length) {
    process.exitCode = 1
    console.error(`RED: ${failures.length}/${tests.length} review regression tests failed`)
    return
  }
  console.log(`PASS: ${tests.length}/${tests.length} review regression tests`)
}

await main()
