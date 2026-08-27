import { extractRequirementBusinessFacts, hashRequirementBusiness } from '../../src/main/requirements/requirement-business-normalization'
import type { RequirementMatchCard } from '../../src/main/requirements/requirement-match-card'
import { evaluateRequirementMatchPolicy } from '../../src/main/requirements/requirement-match-policy'
import { rankRequirementCandidates } from '../../src/main/requirements/requirement-ranking'
import { FULL_REQUIREMENT_RANKING_MANIFEST } from '../../src/main/requirements/requirement-ranking-manifest'

export type MetamorphicCaseName = 'exact_duplicate' | 'format_only' | 'action_conflict' | 'object_conflict' | 'negation_conflict' | 'constraint_conflict' | 'missing_required_field' | 'irrelevant_padding'
export interface MetamorphicRequirementCase {
  name: MetamorphicCaseName
  card: RequirementMatchCard
  businessHash: string
  decisionStatus: string
  rankingScore: number
}

const card = (text: string, description = text): RequirementMatchCard => ({
  requirementType: '功能需求', productDomain: '订单', module: '订单管理',
  sourceTitle: text, sourceDescription: description, evidence: description,
  matchingText: description, lexicalTerms: [text], businessFacts: extractRequirementBusinessFacts(description)
})

export const buildMetamorphicCases = (seedText = '查询订单详情'): MetamorphicRequirementCase[] => {
  const seed = card(seedText)
  const variants: Array<[MetamorphicCaseName, RequirementMatchCard]> = [
    ['exact_duplicate', card(seedText)],
    ['format_only', card(` <p> ${seedText} </p> `, `<p> ${seedText} </p>`)],
    ['action_conflict', card('删除订单详情')],
    ['object_conflict', card('查询员工档案')],
    ['negation_conflict', card('不得查询订单详情')],
    ['constraint_conflict', card('查询订单详情，响应时间 5 秒')],
    ['missing_required_field', card('系统能力说明')],
    ['irrelevant_padding', { ...card(seedText), lexicalTerms: [seedText, '创建人张三', '版本2026'] }]
  ]
  return variants.map(([name, candidate], index) => {
    const businessHash = hashRequirementBusiness(candidate)
    const policy = evaluateRequirementMatchPolicy(seed, candidate, {
      baseBusinessHash: hashRequirementBusiness(seed), candidateBusinessHash: businessHash,
      normalizationVersionMatches: true, candidateEligible: true,
      normalizedTextMatches: name === 'format_only'
    })
    const ranked = rankRequirementCandidates([{
      recordUid: `case-${index}`, policy,
      stageScores: { denseRank: 1, denseScore: 90, lexicalRank: 1, lexicalScore: 90, fusedRank: 1, fusedScore: 90, rerankerRank: 1, rerankerScore: 90 },
      deterministicAgreement: 1, degradationCodes: [], explanation: null
    }], FULL_REQUIREMENT_RANKING_MANIFEST)[0]!
    return { name, card: candidate, businessHash, decisionStatus: ranked.decisionStatus, rankingScore: ranked.rankingScore }
  })
}
