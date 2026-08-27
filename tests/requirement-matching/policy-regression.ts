import { strict as assert } from 'node:assert'
import { extractRequirementBusinessFacts, hashRequirementBusiness } from '../../src/main/requirements/requirement-business-normalization'
import type { RequirementMatchCard } from '../../src/main/requirements/requirement-match-card'
import { evaluateRequirementMatchPolicy } from '../../src/main/requirements/requirement-match-policy'

const card = (text: string): RequirementMatchCard => ({
  requirementType: 'functional',
  productDomain: '订单',
  module: '订单管理',
  sourceTitle: text,
  sourceDescription: text,
  evidence: text,
  matchingText: text,
  lexicalTerms: [text],
  businessFacts: extractRequirementBusinessFacts(text)
})

const decide = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  overrides: Partial<Parameters<typeof evaluateRequirementMatchPolicy>[2]> = {}
) => evaluateRequirementMatchPolicy(base, candidate, {
  baseBusinessHash: hashRequirementBusiness(base),
  candidateBusinessHash: hashRequirementBusiness(candidate),
  normalizationVersionMatches: true,
  candidateEligible: true,
  ...overrides
})

assert.deepEqual(decide(card('查询订单详情'), card('查询订单详情')), {
  relation: 'duplicate',
  decisionStatus: 'confirmed',
  evidenceLevel: 'exact_business_hash',
  rankingCap: 100,
  mayConfirm: true,
  reasonCodes: ['EXACT_BUSINESS_HASH']
})

const actionConflict = decide(card('查询订单'), card('删除订单'))
assert.equal(actionConflict.relation, 'unrelated')
assert.equal(actionConflict.decisionStatus, 'rejected')
assert.equal(actionConflict.rankingCap, 0)
assert.ok(actionConflict.reasonCodes.includes('ACTION_CONFLICT'))

const objectConflict = decide(card('查询订单'), card('查询员工'))
assert.equal(objectConflict.decisionStatus, 'rejected')
assert.ok(objectConflict.reasonCodes.includes('OBJECT_CONFLICT'))

const negationConflict = decide(card('允许导出订单'), card('禁止导出订单'))
assert.equal(negationConflict.decisionStatus, 'rejected')
assert.ok(negationConflict.reasonCodes.includes('NEGATION_CONFLICT'))

const constraintConflict = decide(card('查询订单，响应时间 2 秒'), card('查询订单，响应时间 5 秒'))
assert.equal(constraintConflict.decisionStatus, 'rejected')
assert.ok(constraintConflict.reasonCodes.includes('CONSTRAINT_CONFLICT'))

const missingAction = decide(card('系统能力说明'), card('系统功能简介'))
assert.equal(missingAction.decisionStatus, 'ambiguous')
assert.equal(missingAction.mayConfirm, false)
assert.ok(missingAction.reasonCodes.includes('MISSING_REQUIRED_FIELD'))

const normalizedTextOnly = decide(card('查询订单'), card('查询订单'), {
  baseBusinessHash: 'structured-hash-a',
  candidateBusinessHash: 'structured-hash-b',
  normalizedTextMatches: true
})
assert.equal(normalizedTextOnly.relation, 'duplicate')
assert.equal(normalizedTextOnly.decisionStatus, 'suggested')
assert.equal(normalizedTextOnly.rankingCap, 99)
assert.equal(normalizedTextOnly.mayConfirm, false)

const ineligible = decide(card('查询订单'), card('查询订单'), { candidateEligible: false })
assert.equal(ineligible.decisionStatus, 'rejected')
assert.equal(ineligible.rankingCap, 0)

console.log(JSON.stringify({ ok: true, checks: ['exact confirmation', 'hard conflicts', 'missing facts', 'normalized-only suggestion', 'eligibility'] }))
