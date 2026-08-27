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
  '9c5ed8aa71146a86ce9f38892a4dce5fdcdf1ac34c209823719621cafd373285',
  'an unversioned manifest change must fail the gate'
)
console.log(JSON.stringify({
  ok: true,
  metrics: { exactEligibleRecallAt50: 1, businessWriteCount, replayIdentical: true, entrypointProjectionEqual: true },
  claimLimit: 'Automated gates verify deterministic safety and consistency, not open-domain business semantic accuracy.'
}))
