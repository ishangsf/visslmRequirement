import assert from 'node:assert/strict'

import {
  calculateRequirementMatchingAccuracyMetrics,
  evaluateRequirementMatchingAccuracyGates
} from '../../scripts/requirement-matching-accuracy'

type RankedCandidate = {
  candidateUid: string
  rank: number
  scenario: string
  relevanceGrade: 0 | 1 | 2 | 3 | 4
  candidateEligible: boolean
  expectedDecisionStatus: 'confirmed' | 'suggested' | 'rejected'
  expectedReasonCode: string
  decisionStatus: 'confirmed' | 'suggested' | 'rejected'
  hardConflictClass: string
}

type MiniatureMetricInput = {
  queryResults: Array<{
    queryId: string
    rankedCandidates: RankedCandidate[]
  }>
  businessWriteCount: number
  rerankerDegradationCount: number
  rankingStability: number
  entrypointConsistency: number
}

const buildMiniatureInput = (): MiniatureMetricInput => ({
  queryResults: [
    {
      queryId: 'q1',
      rankedCandidates: [
        { candidateUid: 'q1-grade-1', rank: 1, scenario: 'topic_only', relevanceGrade: 1, candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', decisionStatus: 'suggested', hardConflictClass: 'none' },
        { candidateUid: 'q1-grade-2', rank: 5, scenario: 'partial_overlap_shared_object', relevanceGrade: 2, candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', decisionStatus: 'suggested', hardConflictClass: 'none' },
        { candidateUid: 'q1-action-conflict', rank: 20, scenario: 'action_conflict', relevanceGrade: 0, candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'ACTION_CONFLICT', decisionStatus: 'rejected', hardConflictClass: 'action_conflict' }
      ]
    },
    {
      queryId: 'q2',
      rankedCandidates: [
        { candidateUid: 'q2-grade-1', rank: 1, scenario: 'same_pattern_or_topic_only', relevanceGrade: 1, candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', decisionStatus: 'suggested', hardConflictClass: 'none' },
        { candidateUid: 'q2-grade-3', rank: 10, scenario: 'highly_similar_same_object', relevanceGrade: 3, candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', decisionStatus: 'suggested', hardConflictClass: 'none' },
        { candidateUid: 'q2-key-constraint-conflict', rank: 25, scenario: 'key_constraint_conflict', relevanceGrade: 0, candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CONSTRAINT_CONFLICT', decisionStatus: 'rejected', hardConflictClass: 'key_constraint_conflict' }
      ]
    },
    {
      queryId: 'q3',
      rankedCandidates: [
        { candidateUid: 'q3-grade-1', rank: 1, scenario: 'same_title_description_diff', relevanceGrade: 1, candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', decisionStatus: 'suggested', hardConflictClass: 'none' },
        { candidateUid: 'q3-exact', rank: 40, scenario: 'eligible_exact_duplicate', relevanceGrade: 4, candidateEligible: true, expectedDecisionStatus: 'confirmed', expectedReasonCode: 'EXACT_BUSINESS_HASH', decisionStatus: 'confirmed', hardConflictClass: 'none' }
      ]
    }
  ],
  businessWriteCount: 0,
  rerankerDegradationCount: 0,
  rankingStability: 1,
  entrypointConsistency: 1
})

const calculate = (input: MiniatureMetricInput) => calculateRequirementMatchingAccuracyMetrics(
  input as Parameters<typeof calculateRequirementMatchingAccuracyMetrics>[0]
)
const metrics = calculate(buildMiniatureInput())

assert.equal(metrics.exactRecallAt1, 0)
assert.equal(metrics.exactRecallAt5, 0)
assert.equal(metrics.exactRecallAt10, 0)
assert.equal(metrics.exactRecallAt50, 1)
assert.equal(metrics.semanticRecallAt1, 0, 'rank-1 grade-1 candidates must not count as semantic relevance')
assert.equal(metrics.semanticRecallAt5, 1 / 3, 'grade >= 2 at rank 5 must count as semantic relevance')
assert.equal(metrics.semanticRecallAt10, 2 / 3, 'grade >= 2 at rank 10 must count as semantic relevance')
assert.equal(metrics.semanticRecallAt50, 1, 'rank 40 must count at @50 while remaining excluded at @10')
assert.equal(metrics.mrr, 13 / 120, 'MRR must use the first grade >= 2 result and exclude grade 1')

const approximately = (actual: number, expected: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, received ${actual}`)
}

approximately(metrics.dcgAt10, 2.06133740197628, 'DCG@10')
approximately(metrics.idcgAt10, 8.964263086904792, 'IDCG@10')
approximately(metrics.ndcgAt10, 0.3517429589885594, 'NDCG@10')
assert.equal(metrics.confirmedPrecision, 1)
assert.equal(metrics.hardConflictFalseConfirmationRate, 0)
assert.equal(metrics.rerankerDegradationCount, 0)
assert.equal(metrics.rankingStability, 1)
assert.equal(metrics.entrypointConsistency, 1)
assert.equal(metrics.businessWriteCount, 0)

const badPrecisionInput = buildMiniatureInput()
badPrecisionInput.queryResults[0]!.rankedCandidates.find((candidate) => candidate.candidateUid === 'q1-grade-2')!.decisionStatus = 'confirmed'
const badPrecisionMetrics = calculate(badPrecisionInput)
assert.equal(badPrecisionMetrics.confirmedPrecision, 1 / 2, 'one valid and one invalid confirmation must produce 50% precision')
assert.equal(badPrecisionMetrics.hardConflictFalseConfirmationRate, 0)

const badConflictInput = buildMiniatureInput()
badConflictInput.queryResults[0]!.rankedCandidates.find((candidate) => candidate.candidateUid === 'q1-action-conflict')!.decisionStatus = 'confirmed'
const badConflictMetrics = calculate(badConflictInput)
assert.equal(badConflictMetrics.hardConflictFalseConfirmationRate, 1 / 2, 'one confirmed hard conflict out of two must produce a 50% false-confirmation rate')

const passingGates = {
  exactRecallAt50: 1,
  confirmedPrecision: 1,
  hardConflictFalseConfirmationRate: 0,
  businessWriteCount: 0,
  rerankerDegradationCount: 0,
  rankingStability: 1,
  entrypointConsistency: 1,
  semanticRecallAt5: 0.90,
  mrr: 0.80,
  ndcgAt10: 0.85
}

assert.equal(evaluateRequirementMatchingAccuracyGates(passingGates).ok, true)

const assertSingleGateError = (
  overrides: Partial<typeof passingGates>,
  field: keyof typeof passingGates
): void => {
  const result = evaluateRequirementMatchingAccuracyGates({ ...passingGates, ...overrides })
  assert.equal(result.ok, false, `${field} must fail outside its gate boundary`)
  assert.equal(result.errors.length, 1, `${field} must report its corresponding gate error only`)
  assert.ok(result.errors.some((error) => error.includes(field)), `${field} error must identify the failing metric`)
}

assertSingleGateError({ exactRecallAt50: 0.999999 }, 'exactRecallAt50')
assertSingleGateError({ confirmedPrecision: 0.999999 }, 'confirmedPrecision')
assertSingleGateError({ hardConflictFalseConfirmationRate: 0.000001 }, 'hardConflictFalseConfirmationRate')
assertSingleGateError({ businessWriteCount: 1 }, 'businessWriteCount')
assertSingleGateError({ rerankerDegradationCount: 1 }, 'rerankerDegradationCount')
assertSingleGateError({ rankingStability: 0.999999 }, 'rankingStability')
assertSingleGateError({ entrypointConsistency: 0.999999 }, 'entrypointConsistency')
assertSingleGateError({ semanticRecallAt5: 0.899999 }, 'semanticRecallAt5')
assertSingleGateError({ mrr: 0.799999 }, 'mrr')
assertSingleGateError({ ndcgAt10: 0.849999 }, 'ndcgAt10')

console.log(JSON.stringify({
  ok: true,
  metrics: {
    exactRecallAt1: metrics.exactRecallAt1,
    exactRecallAt5: metrics.exactRecallAt5,
    exactRecallAt10: metrics.exactRecallAt10,
    exactRecallAt50: metrics.exactRecallAt50,
    semanticRecallAt1: metrics.semanticRecallAt1,
    semanticRecallAt5: metrics.semanticRecallAt5,
    semanticRecallAt10: metrics.semanticRecallAt10,
    semanticRecallAt50: metrics.semanticRecallAt50,
    mrr: metrics.mrr,
    dcgAt10: metrics.dcgAt10,
    idcgAt10: metrics.idcgAt10,
    ndcgAt10: metrics.ndcgAt10,
    confirmedPrecision: metrics.confirmedPrecision,
    hardConflictFalseConfirmationRate: metrics.hardConflictFalseConfirmationRate,
    rerankerDegradationCount: metrics.rerankerDegradationCount,
    rankingStability: metrics.rankingStability,
    entrypointConsistency: metrics.entrypointConsistency,
    businessWriteCount: metrics.businessWriteCount
  },
  gateBoundaryChecks: 10
}))
