import { strict as assert } from 'node:assert'
import type { RecordDetail } from '../../src/shared/types'
import { extractRequirementBusinessFacts } from '../../src/main/requirements/requirement-business-normalization'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import type { RequirementMatchCard } from '../../src/main/requirements/requirement-match-card'
import { RequirementMatchingCore } from '../../src/main/requirements/requirement-matching-core'

const card = (text: string): RequirementMatchCard => ({
  requirementType: '功能需求', productDomain: '订单', module: '订单管理',
  sourceTitle: text, sourceDescription: text, evidence: text, matchingText: text,
  lexicalTerms: [text], businessFacts: extractRequirementBusinessFacts(text)
})

const candidate = (uid: string, text = `查询订单${uid}`, retrievalScore = 50): HybridRequirementCandidate => ({
  record: { uid, name: text } as RecordDetail,
  card: card(text),
  denseScore: retrievalScore,
  lexicalScore: retrievalScore,
  retrievalScore,
  snippet: text
})

const retrieved = Array.from({ length: 55 }, (_, index) => candidate(`r-${String(index).padStart(2, '0')}`, `查询订单字段${index}`, 100 - index))
const rerankedUids: string[] = []
const explainedUids: string[] = []
const core = new RequirementMatchingCore({
  retriever: { async retrieve() { return retrieved } },
  reranker: {
    modelId: 'fake-reranker-v1',
    async rerank(_base, candidates) {
      rerankedUids.push(...candidates.map((item) => item.record.uid))
      return candidates.map((item, index) => ({ recordUid: item.record.uid, score: 100 - index }))
    }
  },
  explainer: {
    mode: 'local',
    async explain(_base, candidates) {
      explainedUids.push(...candidates.map((item) => item.record.uid))
      return new Map(candidates.map((item) => [item.record.uid, `解释 ${item.record.uid}`]))
    }
  },
  async exactBusinessHashCandidates() { return [] },
  candidateEligible() { return true }
})

const request = {
  base: card('查询订单详情'),
  excludedUids: new Set<string>(),
  includeCurrentProjectRecords: false,
  explainTopN: 10,
  explanationPolicy: { mode: 'local' as const, allowExternalProcessing: false }
}

const result = await core.match(request)
assert.equal(result.candidates.length, 50)
assert.equal(rerankedUids.length, 20)
assert.equal(explainedUids.length, 10)
assert.equal(result.candidates[0]?.finalRank, 1)
assert.equal(result.candidates[0]?.explanation?.startsWith('解释'), true)
assert.notEqual(result.candidates[0]?.decisionStatus, 'confirmed')

const exact = candidate('exact-omitted', '查询订单详情', 0)
const exactCore = new RequirementMatchingCore({
  retriever: { async retrieve() { return retrieved.slice(0, 50) } },
  reranker: { modelId: 'fake', async rerank() { throw new Error('offline') } },
  async exactBusinessHashCandidates() { return [exact] },
  candidateEligible(item) { return item.record.uid !== 'ineligible' }
})
const degraded = await exactCore.match({ ...request, explanationPolicy: { mode: 'disabled', allowExternalProcessing: false } })
assert.ok(degraded.candidates.some((item) => item.recordUid === exact.record.uid && item.decisionStatus === 'confirmed'))
assert.ok(degraded.degradationCodes.includes('RERANKER_UNAVAILABLE'))
assert.equal(degraded.rankingVersion, 'requirement-ranking-v1-rrf-fallback')

const ineligible = candidate('ineligible', '查询订单详情', 0)
const ineligibleCore = new RequirementMatchingCore({
  retriever: { async retrieve() { return [] } },
  reranker: { modelId: 'fake', async rerank() { return [] } },
  async exactBusinessHashCandidates() { return [ineligible] },
  candidateEligible() { return false }
})
const rejected = await ineligibleCore.match({ ...request, explanationPolicy: { mode: 'disabled', allowExternalProcessing: false } })
assert.equal(rejected.candidates[0]?.decisionStatus, 'rejected')

let onlineCalls = 0
const onlineCore = new RequirementMatchingCore({
  retriever: { async retrieve() { return [candidate('online')] } },
  reranker: { modelId: 'fake', async rerank() { return [] } },
  explainer: { mode: 'online', async explain() { onlineCalls += 1; return new Map() } },
  async exactBusinessHashCandidates() { return [] },
  candidateEligible() { return true }
})
await onlineCore.match({ ...request, explanationPolicy: { mode: 'online', allowExternalProcessing: false } })
assert.equal(onlineCalls, 0)

console.log(JSON.stringify({ ok: true, checks: ['50/20/10 pipeline', 'exact injection', 'reranker degradation', 'eligibility', 'online consent'] }))
