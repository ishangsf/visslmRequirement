import { strict as assert } from 'node:assert'
import type { RequirementMatchPolicyDecision } from '../../src/main/requirements/requirement-match-policy'
import {
  FALLBACK_REQUIREMENT_RANKING_MANIFEST,
  FALLBACK_RANKING_VERSION,
  FULL_REQUIREMENT_RANKING_MANIFEST,
  FULL_RERANK_RANKING_VERSION,
  hashRequirementRankingManifest
} from '../../src/main/requirements/requirement-ranking-manifest'
import { rankRequirementCandidates, type RequirementRankingInput } from '../../src/main/requirements/requirement-ranking'

const policy = (overrides: Partial<RequirementMatchPolicyDecision> = {}): RequirementMatchPolicyDecision => ({
  relation: 'partial_overlap',
  decisionStatus: 'suggested',
  evidenceLevel: 'deterministic_rule',
  rankingCap: 99,
  mayConfirm: false,
  reasonCodes: [],
  ...overrides
})

const input = (
  recordUid: string,
  overrides: Partial<RequirementRankingInput> = {}
): RequirementRankingInput => ({
  recordUid,
  policy: policy(),
  stageScores: {
    denseRank: 1, denseScore: 80, lexicalRank: 1, lexicalScore: 80,
    fusedRank: 1, fusedScore: 80, rerankerRank: 1, rerankerScore: 80
  },
  deterministicAgreement: 0.8,
  degradationCodes: [],
  explanation: null,
  ...overrides
})

const exact = rankRequirementCandidates([
  input('exact', { policy: policy({ relation: 'duplicate', decisionStatus: 'confirmed', evidenceLevel: 'exact_business_hash', rankingCap: 100, mayConfirm: true }) })
], FULL_REQUIREMENT_RANKING_MANIFEST)[0]!
assert.equal(exact.rankingScore, 100)

const rejected = rankRequirementCandidates([
  input('rejected', { policy: policy({ relation: 'unrelated', decisionStatus: 'rejected', rankingCap: 0 }) })
], FULL_REQUIREMENT_RANKING_MANIFEST)[0]!
assert.equal(rejected.rankingScore, 0)

const normalizedOnly = rankRequirementCandidates([
  input('normalized', { policy: policy({ relation: 'duplicate', evidenceLevel: 'exact_normalized_text', rankingCap: 99 }) })
], FULL_REQUIREMENT_RANKING_MANIFEST)[0]!
assert.ok(normalizedOnly.rankingScore <= 99)

const rerankerOrder = rankRequirementCandidates([
  input('low', { stageScores: { ...input('x').stageScores, rerankerRank: 2, rerankerScore: 20 } }),
  input('high', { stageScores: { ...input('x').stageScores, rerankerRank: 1, rerankerScore: 90 } })
], FULL_REQUIREMENT_RANKING_MANIFEST)
assert.deepEqual(rerankerOrder.map((item) => item.recordUid), ['high', 'low'])

const tied = rankRequirementCandidates([input('b'), input('a')], FULL_REQUIREMENT_RANKING_MANIFEST)
assert.deepEqual(tied.map((item) => item.recordUid), ['a', 'b'])
assert.deepEqual(tied.map((item) => item.finalRank), [1, 2])

assert.notEqual(FULL_RERANK_RANKING_VERSION, FALLBACK_RANKING_VERSION)
assert.notEqual(
  hashRequirementRankingManifest(FULL_REQUIREMENT_RANKING_MANIFEST),
  hashRequirementRankingManifest(FALLBACK_REQUIREMENT_RANKING_MANIFEST)
)
assert.equal(
  hashRequirementRankingManifest(FULL_REQUIREMENT_RANKING_MANIFEST),
  '9c5ed8aa71146a86ce9f38892a4dce5fdcdf1ac34c209823719621cafd373285',
  'ranking weights, transforms, caps, or tie-breaks require an explicit versioned contract update'
)

console.log(JSON.stringify({ ok: true, checks: ['fixed score boundaries', 'reranker monotonicity', 'stable tie break', 'degraded version'] }))
