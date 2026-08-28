import type {
  MatchDecisionStatus,
  MatchEvidenceLevel,
  MatchRelation,
  RequirementBusinessFacts
} from './requirement-match-domain'
import type { RequirementMatchCard } from './requirement-match-card'
import { normalizeRequirementAction } from './requirement-business-normalization'

export const REQUIREMENT_MATCH_REASON_CODES = [
  'EXACT_BUSINESS_HASH',
  'EXACT_NORMALIZED_TEXT',
  'MISSING_REQUIRED_FIELD',
  'MISSING_CATEGORY_FIELD',
  'CANDIDATE_INELIGIBLE',
  'SOURCE_TYPE_MISMATCH',
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
  mayConfirm: boolean
  reasonCodes: RequirementMatchReasonCode[]
}

const normalizedFact = (value: string): string => value
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const normalizedObject = (value: string): string => normalizedFact(value)
  .replace(/明细/gu, '详情')
  .replace(/检索结果|查询结果/gu, '结果')

const objectConflict = (left: string, right: string): boolean => {
  const a = normalizedObject(left)
  const b = normalizedObject(right)
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
  mayConfirm: false,
  reasonCodes: [reason]
})

const REQUIREMENT_CATEGORY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  functional: 'functional', 功能: 'functional', 功能需求: 'functional',
  interface: 'interface', 接口: 'interface', 接口需求: 'interface',
  data: 'data', 数据: 'data', 数据需求: 'data',
  performance: 'performance', 性能: 'performance', 性能需求: 'performance',
  security: 'security', 安全: 'security', 安全需求: 'security',
  deployment: 'deployment', 部署: 'deployment', 环境: 'deployment',
  operations: 'operations', 运维: 'operations', 运营: 'operations',
  acceptance: 'acceptance', 验收: 'acceptance',
  business: 'business', 业务: 'business'
})

const categoryOf = (card: RequirementMatchCard): string => {
  const raw = normalizedFact(card.requirementCategory || card.requirementType)
  return REQUIREMENT_CATEGORY_ALIASES[raw] ?? raw
}

export const requirementArtifactTypeOf = (card: RequirementMatchCard): 'requirement' | 'defect' | 'unknown' => {
  if (card.artifactType) return card.artifactType
  const type = normalizedFact(card.requirementType)
  if (/(?:defect|bug|缺陷|故障|错误)/iu.test(type)) return 'defect'
  if (/(?:requirement|enhancement|feature|story|需求|功能)/iu.test(type) || REQUIREMENT_CATEGORY_ALIASES[type]) {
    return 'requirement'
  }
  return 'unknown'
}

export const requirementArtifactTypesCompatible = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): boolean => {
  const baseType = requirementArtifactTypeOf(base)
  const candidateType = requirementArtifactTypeOf(candidate)
  return baseType === 'unknown' || candidateType === 'unknown' || baseType === candidateType
}

const categoryFactsComplete = (card: RequirementMatchCard, category: string): boolean => {
  const facts = card.businessFacts
  const action = Boolean(normalizedFact(facts.action))
  const object = Boolean(normalizedFact(facts.object))
  const text = `${card.sourceTitle}\n${card.sourceDescription}`
  if (category === 'performance') {
    return facts.constraints.length > 0 && (action || object || /(?:响应|吞吐|并发|时延|准确率|容量|可用率|性能)/u.test(text))
  }
  if (category === 'interface') {
    return (action && object) || /(?:接口|协议|调用|接收|发送|输入|输出|来源|目标|请求|响应)/u.test(text)
  }
  if (category === 'deployment') {
    return (action || object) && /(?:部署|安装|环境|操作系统|数据库|服务器|国产化|版本|架构)/u.test(text)
  }
  if (category === 'acceptance') {
    return /(?:验收|通过|满足|符合|交付|验证|测试)/u.test(text) && (object || facts.constraints.length > 0)
  }
  if (category === 'operations') {
    return (action && object) || /(?:运维|维护|服务|支持|保障|SLA|响应时间|驻场)/iu.test(text)
  }
  if (category === 'business') {
    return (action && object) || /(?:负责|提供|承担|完成|交付|配合)/u.test(text)
  }
  return facts.source !== 'missing' && action && object
}

/** Deterministic policy. Later model output may explain this decision but cannot upgrade it. */
export const evaluateRequirementMatchPolicy = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  context: RequirementMatchPolicyContext
): RequirementMatchPolicyDecision => {
  if (!context.candidateEligible) return rejected('CANDIDATE_INELIGIBLE')
  if (!requirementArtifactTypesCompatible(base, candidate)) return rejected('SOURCE_TYPE_MISMATCH')
  if (!context.normalizationVersionMatches) {
    return {
      relation: null,
      decisionStatus: 'ambiguous',
      evidenceLevel: 'retrieval_only',
      mayConfirm: false,
      reasonCodes: ['NORMALIZATION_VERSION_MISMATCH']
    }
  }

  const baseFacts = base.businessFacts
  const candidateFacts = candidate.businessFacts
  if (baseFacts.action && candidateFacts.action &&
      normalizeRequirementAction(baseFacts.action) !== normalizeRequirementAction(candidateFacts.action)) {
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
  const category = categoryOf(base)
  if (!categoryFactsComplete(base, category) || !categoryFactsComplete(candidate, category)) {
    return {
      relation: null,
      decisionStatus: 'ambiguous',
      evidenceLevel: 'retrieval_only',
      mayConfirm: false,
      reasonCodes: [category && category !== 'functional' ? 'MISSING_CATEGORY_FIELD' : 'MISSING_REQUIRED_FIELD']
    }
  }
  if (context.baseBusinessHash && context.baseBusinessHash === context.candidateBusinessHash) {
    return {
      relation: 'duplicate',
      decisionStatus: 'confirmed',
      evidenceLevel: 'exact_business_hash',
      mayConfirm: true,
      reasonCodes: ['EXACT_BUSINESS_HASH']
    }
  }
  if (context.normalizedTextMatches) {
    return {
      relation: 'duplicate',
      decisionStatus: 'suggested',
      evidenceLevel: 'exact_normalized_text',
      mayConfirm: false,
      reasonCodes: ['EXACT_NORMALIZED_TEXT']
    }
  }
  return {
    relation: null,
    decisionStatus: 'suggested',
    evidenceLevel: 'deterministic_rule',
    mayConfirm: false,
    reasonCodes: []
  }
}
