import type {
  MatchDecisionStatus,
  MatchEvidenceLevel,
  MatchRelation,
  RequirementBusinessFacts
} from './requirement-match-domain'
import type { RequirementMatchCard } from './requirement-match-card'

export const REQUIREMENT_MATCH_REASON_CODES = [
  'EXACT_BUSINESS_HASH',
  'EXACT_NORMALIZED_TEXT',
  'MISSING_REQUIRED_FIELD',
  'CANDIDATE_INELIGIBLE',
  'NORMALIZATION_VERSION_MISMATCH',
  'ACTION_CONFLICT',
  'OBJECT_CONFLICT',
  'NEGATION_CONFLICT',
  'CONSTRAINT_CONFLICT'
] as const

export type RequirementMatchReasonCode = typeof REQUIREMENT_MATCH_REASON_CODES[number]

export interface RequirementMatchPolicyContext {
  baseBusinessHash: string
  candidateBusinessHash: string
  normalizationVersionMatches: boolean
  candidateEligible: boolean
  normalizedTextMatches?: boolean
}

export interface RequirementMatchPolicyDecision {
  relation: MatchRelation
  decisionStatus: MatchDecisionStatus
  evidenceLevel: MatchEvidenceLevel
  rankingCap: number
  mayConfirm: boolean
  reasonCodes: RequirementMatchReasonCode[]
}

const normalizedFact = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const objectConflict = (left: string, right: string): boolean => {
  const a = normalizedFact(left)
  const b = normalizedFact(right)
  if (!a || !b || a === b || a.includes(b) || b.includes(a)) return false
  const charsA = new Set([...a])
  const charsB = new Set([...b])
  const overlap = [...charsA].filter((item) => charsB.has(item)).length
  return overlap / Math.max(1, Math.min(charsA.size, charsB.size)) < 0.34
}

const constraintKey = (value: string): string => normalizedFact(value).replace(/\d+(?:\.\d+)?/gu, '#')
const constraintsConflict = (left: string[], right: string[]): boolean => {
  for (const baseConstraint of left) {
    const baseKey = constraintKey(baseConstraint)
    const candidate = right.find((item) => constraintKey(item) === baseKey)
    if (candidate && normalizedFact(candidate) !== normalizedFact(baseConstraint)) return true
  }
  return false
}

const rejected = (reason: RequirementMatchReasonCode): RequirementMatchPolicyDecision => ({
  relation: 'unrelated',
  decisionStatus: 'rejected',
  evidenceLevel: 'deterministic_rule',
  rankingCap: 0,
  mayConfirm: false,
  reasonCodes: [reason]
})

const hasRequiredFacts = (facts: RequirementBusinessFacts): boolean => (
  facts.source !== 'missing' && Boolean(normalizedFact(facts.action)) && Boolean(normalizedFact(facts.object))
)

/** Deterministic policy. Later model output may explain this decision but cannot upgrade it. */
export const evaluateRequirementMatchPolicy = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  context: RequirementMatchPolicyContext
): RequirementMatchPolicyDecision => {
  if (!context.candidateEligible) return rejected('CANDIDATE_INELIGIBLE')
  if (!context.normalizationVersionMatches) {
    return {
      relation: null,
      decisionStatus: 'ambiguous',
      evidenceLevel: 'retrieval_only',
      rankingCap: 69.99,
      mayConfirm: false,
      reasonCodes: ['NORMALIZATION_VERSION_MISMATCH']
    }
  }

  const baseFacts = base.businessFacts
  const candidateFacts = candidate.businessFacts
  if (baseFacts.action && candidateFacts.action && normalizedFact(baseFacts.action) !== normalizedFact(candidateFacts.action)) {
    return rejected('ACTION_CONFLICT')
  }
  if (baseFacts.negated !== null && candidateFacts.negated !== null && baseFacts.negated !== candidateFacts.negated) {
    return rejected('NEGATION_CONFLICT')
  }
  if (objectConflict(baseFacts.object, candidateFacts.object)) return rejected('OBJECT_CONFLICT')
  if (constraintsConflict(baseFacts.constraints, candidateFacts.constraints) ||
      constraintsConflict(candidateFacts.constraints, baseFacts.constraints)) {
    return rejected('CONSTRAINT_CONFLICT')
  }
  if (!hasRequiredFacts(baseFacts) || !hasRequiredFacts(candidateFacts)) {
    return {
      relation: null,
      decisionStatus: 'ambiguous',
      evidenceLevel: 'retrieval_only',
      rankingCap: 69.99,
      mayConfirm: false,
      reasonCodes: ['MISSING_REQUIRED_FIELD']
    }
  }
  if (context.baseBusinessHash && context.baseBusinessHash === context.candidateBusinessHash) {
    return {
      relation: 'duplicate',
      decisionStatus: 'confirmed',
      evidenceLevel: 'exact_business_hash',
      rankingCap: 100,
      mayConfirm: true,
      reasonCodes: ['EXACT_BUSINESS_HASH']
    }
  }
  if (context.normalizedTextMatches) {
    return {
      relation: 'duplicate',
      decisionStatus: 'suggested',
      evidenceLevel: 'exact_normalized_text',
      rankingCap: 99,
      mayConfirm: false,
      reasonCodes: ['EXACT_NORMALIZED_TEXT']
    }
  }
  return {
    relation: null,
    decisionStatus: 'suggested',
    evidenceLevel: 'deterministic_rule',
    rankingCap: 99,
    mayConfirm: false,
    reasonCodes: []
  }
}
