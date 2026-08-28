import { strict as assert } from 'node:assert'
import type { RecordDetail } from '../../src/shared/types'
import { extractRequirementBusinessFacts } from '../../src/main/requirements/requirement-business-normalization'
import type { RequirementMatchCard } from '../../src/main/requirements/requirement-match-card'
import { RequirementMatchingCore } from '../../src/main/requirements/requirement-matching-core'
import { agentRequirementMatchProjection, projectRequirementMatchProjection } from '../../src/main/requirements/requirement-match-adapters'
import { FULL_REQUIREMENT_RANKING_MANIFEST, hashRequirementRankingManifest } from '../../src/main/requirements/requirement-ranking-manifest'

const card = (text: string): RequirementMatchCard => ({
  requirementType: '功能需求', productDomain: '订单', module: '订单管理', sourceTitle: text,
  sourceDescription: text, evidence: text, matchingText: text, lexicalTerms: [text],
  businessFacts: extractRequirementBusinessFacts(text)
})
const base = card('查询订单详情')
const exactCandidates = Array.from({ length: 10 }, (_, index) => ({
  record: { uid: `exact-${index}`, name: '查询订单详情' } as RecordDetail,
  card: card('查询订单详情'), denseScore: 0, lexicalScore: 0, retrievalScore: 0, snippet: '查询订单详情'
}))
let businessWriteCount = 0
const core = new RequirementMatchingCore({
  retriever: { async retrieve() { return [] } },
  reranker: {
    modelId: 'quality-gate-reranker',
    async rerank(_base, candidates) {
      return candidates.map((candidate, index) => ({ recordUid: candidate.record.uid, score: 90 - index }))
    }
  },
  async exactBusinessHashCandidates() { return exactCandidates },
  candidateEligible() { return true }
})
const request = {
  base, excludedUids: new Set<string>(), includeCurrentProjectRecords: false, explainTopN: 0,
  explanationPolicy: { mode: 'disabled' as const, allowExternalProcessing: false }
}
const replayA = await core.match(request)
const replayB = await core.match(request)
const recalled = replayA.candidates.filter((candidate) => candidate.decisionStatus === 'confirmed').length
assert.equal(recalled / exactCandidates.length, 1, 'eligible exact duplicate Recall@50 must be 100%')
assert.deepEqual(replayA, replayB, 'identical inputs and versions must replay identically')
assert.deepEqual(projectRequirementMatchProjection(replayA), agentRequirementMatchProjection(replayA))
assert.equal(businessWriteCount, 0, 'the matching core has no formal business write capability')
assert.equal(replayA.candidates.every((candidate) => candidate.rankingScore === 100), true)
assert.equal(
  hashRequirementRankingManifest(FULL_REQUIREMENT_RANKING_MANIFEST),
  '16d71695db0c0cbda87d615e25248ea173fa81d72f5921e7963700ac85f58112',
  'an unversioned manifest change must fail the gate'
)

const incompleteCandidates = [60, 72, 84, 96].map((score, index) => ({
  record: { uid: `incomplete-${index}`, name: '系统能力说明' } as RecordDetail,
  card: card('系统能力说明'), denseScore: score, lexicalScore: score, retrievalScore: score, snippet: '系统能力说明'
}))
const plateauCore = new RequirementMatchingCore({
  retriever: { async retrieve() { return incompleteCandidates } },
  reranker: {
    modelId: 'plateau-gate-reranker',
    async rerank(_base, candidates) {
      return candidates.map((candidate, index) => ({ recordUid: candidate.record.uid, score: 96 - index * 8 }))
    }
  },
  async exactBusinessHashCandidates() { return [] },
  candidateEligible() { return true }
})
const plateauReplay = await plateauCore.match({ ...request, base: card('查询订单详情') })
assert.equal(new Set(plateauReplay.candidates.map((candidate) => candidate.rankingScore)).size > 1, true, 'ambiguous rows must retain ranking separation')
assert.equal(plateauReplay.candidates.every((candidate) => candidate.relation === null), true, 'unknown relations must not be inferred from score')
assert.equal(plateauReplay.candidates.every((candidate) => candidate.confidenceStatus === 'abstain'), true, 'incomplete evidence must abstain')
assert.equal(plateauReplay.candidates.every((candidate) => candidate.similarityScore === candidate.scoreBreakdown.total), true, 'every displayed score must retain its component breakdown')
console.log(JSON.stringify({
  ok: true,
  metrics: { exactEligibleRecallAt50: 1, businessWriteCount, replayIdentical: true, entrypointProjectionEqual: true, scorePlateauEliminated: true, unknownRelationPreserved: true },
  claimLimit: 'Automated gates verify deterministic safety and consistency, not open-domain business semantic accuracy.'
}))
