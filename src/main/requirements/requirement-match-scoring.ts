import {
  semanticTextSimilarity,
  type RequirementMatchCard
} from './semantic-card'
import type { HybridRequirementCandidate } from './hybrid-retrieval'

export const REQUIREMENT_MATCH_RELATIONS = [
  'duplicate',
  'highly_similar',
  'partial_overlap',
  'same_pattern',
  'topic_only',
  'unrelated'
] as const

export type RequirementMatchRelation = typeof REQUIREMENT_MATCH_RELATIONS[number]

export const REQUIREMENT_MATCH_DECISION_PATHS = [
  'exact_text',
  'near_duplicate_text',
  'semantic_card',
  'deterministic_score',
  'ai_review',
  'unavailable'
] as const

export type RequirementMatchDecisionPath = typeof REQUIREMENT_MATCH_DECISION_PATHS[number]

export const REQUIREMENT_MATCH_RELATION_SCORE_RANGES: Record<
  RequirementMatchRelation,
  { min: number; max: number }
> = {
  duplicate: { min: 85, max: 100 },
  highly_similar: { min: 70, max: 94 },
  // Scores are continuous and rounded to two decimals. The highest value that
  // still classifies below the 70-point threshold is 69.99.
  partial_overlap: { min: 40, max: 69.99 },
  same_pattern: { min: 25, max: 59 },
  topic_only: { min: 10, max: 39 },
  unrelated: { min: 0, max: 24 }
}

export const REQUIREMENT_MATCH_DIMENSIONS = [
  'semantic',
  'keyword',
  'domain',
  'object',
  'functionalObject',
  'action',
  'currentState',
  'targetState',
  'trigger',
  'input',
  'output',
  'behavior',
  'constraints',
  'acceptance',
  'businessScene',
  'requirementType',
  'productDomain',
  'module',
  'dense',
  'lexical',
  'structural',
  'reranker'
] as const

export type RequirementMatchDimension = typeof REQUIREMENT_MATCH_DIMENSIONS[number]

export const REQUIREMENT_MATCH_DEFAULT_WEIGHTS: Readonly<Record<RequirementMatchDimension, number>> = {
  semantic: 0.20,
  keyword: 0.10,
  domain: 0.05,
  object: 0.05,
  action: 0.05,
  // Cross-Encoder output is an uncalibrated ordering signal. It is retained
  // on each ranked candidate, but must not become a percentage or relation by
  // default.
  reranker: 0,
  functionalObject: 0,
  currentState: 0,
  targetState: 0,
  trigger: 0,
  input: 0,
  output: 0,
  behavior: 0,
  constraints: 0,
  acceptance: 0,
  businessScene: 0,
  requirementType: 0,
  productDomain: 0,
  module: 0,
  dense: 0,
  lexical: 0,
  structural: 0
}

export interface RequirementScoreRange {
  min: number
  max: number
}

export interface RequirementMatchScoringSignals {
  denseScore?: number
  lexicalScore?: number
  structuralScore?: number
  rerankerScore?: number
  semanticScore?: number
  keywordScore?: number
  domainScore?: number
  objectScore?: number
  actionScore?: number
  /** Optional deterministic dimension values supplied by the caller. */
  dimensionScores?: Partial<Record<RequirementMatchDimension, number>>
  /** Input range for caller-supplied values; the default range is 0..100. */
  dimensionRanges?: Partial<Record<RequirementMatchDimension, RequirementScoreRange>>
  /** Positive weights replace the corresponding default weight. */
  weights?: Partial<Record<RequirementMatchDimension, number>>
}

export interface RequirementMatchScoreDimension {
  dimension: RequirementMatchDimension
  score: number
  weight: number
  contribution: number
}

export interface RequirementMatchDecision {
  relation: RequirementMatchRelation
  finalScore: number
  downgradeReasons: string[]
  decisionPath?: RequirementMatchDecisionPath
  confidenceBasis?: string[]
}

export interface RequirementMatchScoreResult extends RequirementMatchDecision {
  recordUid?: string
  /** Only dimensions with both valid data and a positive weight are included. */
  dimensions: Partial<Record<RequirementMatchDimension, number>>
  dimensionDetails: RequirementMatchScoreDimension[]
  validDimensions: RequirementMatchDimension[]
  totalWeight: number
  objectSimilarity: number
  actionComparison: 'same' | 'different' | 'unknown'
  decisionPath: RequirementMatchDecisionPath
  confidenceBasis: string[]
}

const TEXT_DIMENSIONS: readonly RequirementMatchDimension[] = [
  'functionalObject',
  'currentState',
  'targetState',
  'trigger',
  'input',
  'output',
  'behavior',
  'constraints',
  'acceptance',
  'businessScene',
  'requirementType',
  'productDomain',
  'module'
]

const SCORE_RANGE_0_TO_100: RequirementScoreRange = { min: 0, max: 100 }

const roundScore = (value: number): number => Number(value.toFixed(2))

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
)

const hasOwn = (value: object, key: PropertyKey): boolean => (
  Object.prototype.hasOwnProperty.call(value, key)
)

/** Convert a finite value from an arbitrary numeric range into 0..100. */
export const normalizeRequirementScore = (
  value: unknown,
  range: RequirementScoreRange = SCORE_RANGE_0_TO_100
): number | undefined => {
  if (!isFiniteNumber(value) || !isFiniteNumber(range.min) || !isFiniteNumber(range.max)) return undefined
  if (range.max <= range.min) return undefined
  const ratio = (value - range.min) / (range.max - range.min)
  return roundScore(Math.max(0, Math.min(100, ratio * 100)))
}

/** Clamp an already 0..100 value; invalid values fail closed to zero. */
export const clampRequirementScore = (value: unknown): number => (
  normalizeRequirementScore(value) ?? 0
)

// Short aliases keep orchestration code readable while the longer names remain
// explicit at module boundaries.
export const normalizeScore = normalizeRequirementScore
export const clampScore = clampRequirementScore

const relationRankMap: Record<RequirementMatchRelation, number> = {
  unrelated: 0,
  topic_only: 1,
  same_pattern: 2,
  partial_overlap: 3,
  highly_similar: 4,
  duplicate: 5
}

export const requirementMatchRelationRank = (relation: RequirementMatchRelation): number => (
  relationRankMap[relation]
)

export const scoreFitsRequirementRelation = (
  relation: RequirementMatchRelation,
  score: number
): boolean => {
  if (!isFiniteNumber(score) || score < 0 || score > 100) return false
  const range = REQUIREMENT_MATCH_RELATION_SCORE_RANGES[relation]
  if (!range) return false
  return score >= range.min && score <= range.max
}

const relationFromScore = (score: number): RequirementMatchRelation => {
  if (score >= 85) return 'duplicate'
  if (score >= 70) return 'highly_similar'
  if (score >= 40) return 'partial_overlap'
  if (score >= 25) return 'same_pattern'
  if (score >= 10) return 'topic_only'
  return 'unrelated'
}

export interface RequirementMatchRelationContext {
  objectSimilarity?: number
  actionKnown?: boolean
  sameAction?: boolean
}

/**
 * Classify a deterministic final score. Optional card-comparison context makes
 * the classifier conservative without inferring any business meaning from raw
 * text: action and object values must already be present in semantic cards.
 */
export const classifyRequirementRelation = (
  score: number,
  context: RequirementMatchRelationContext = {}
): RequirementMatchRelation => {
  const normalized = clampRequirementScore(score)
  const relation = relationFromScore(normalized)
  const objectSimilarity = isFiniteNumber(context.objectSimilarity)
    ? Math.max(0, Math.min(1, context.objectSimilarity))
    : undefined

  if (context.actionKnown && context.sameAction === true && objectSimilarity !== undefined && objectSimilarity < 0.5) {
    return requirementMatchRelationRank(relation) > requirementMatchRelationRank('same_pattern')
      ? 'same_pattern'
      : relation
  }
  if (context.actionKnown && context.sameAction === false && objectSimilarity !== undefined && objectSimilarity < 0.55) {
    return requirementMatchRelationRank(relation) > requirementMatchRelationRank('topic_only')
      ? 'topic_only'
      : relation
  }
  return relation
}

const isHybridRequirementCandidate = (
  candidate: RequirementMatchCard | HybridRequirementCandidate
): candidate is HybridRequirementCandidate => (
  'card' in candidate && Boolean(candidate.card) && typeof candidate.card === 'object' &&
  'record' in candidate && Boolean(candidate.record) && typeof candidate.record === 'object'
)

const cardFromCandidate = (
  candidate: RequirementMatchCard | HybridRequirementCandidate
): RequirementMatchCard => isHybridRequirementCandidate(candidate) ? candidate.card : candidate

const candidateUidOf = (
  candidate: RequirementMatchCard | HybridRequirementCandidate
): string | undefined => isHybridRequirementCandidate(candidate) ? candidate.record.uid : undefined

const textValueOf = (card: RequirementMatchCard, dimension: RequirementMatchDimension): string => {
  if (!TEXT_DIMENSIONS.includes(dimension)) return ''
  return String(card[dimension as keyof RequirementMatchCard] ?? '').trim()
}

const textDimensionScore = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  dimension: RequirementMatchDimension
): number | undefined => {
  const left = textValueOf(base, dimension)
  const right = textValueOf(candidate, dimension)
  if (!left || !right) return undefined
  return normalizeRequirementScore(semanticTextSimilarity(left, right), { min: 0, max: 1 })
}

const objectSimilarityOf = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): number => semanticTextSimilarity(base.functionalObject, candidate.functionalObject)

const actionComparisonOf = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): RequirementMatchScoreResult['actionComparison'] => {
  if (base.action === 'unknown' || candidate.action === 'unknown') return 'unknown'
  return base.action === candidate.action ? 'same' : 'different'
}

const normalizedSourceValue = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const sourceTermsOf = (value: string): Set<string> => {
  const normalized = value.toLocaleLowerCase()
  const words = normalized.match(/[A-Za-z0-9]+|[\p{Script=Han}]/gu) ?? []
  const grams = normalized.length > 1
    ? Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2))
    : []
  return new Set([...words, ...grams])
}

const sourceFieldSimilarity = (left: string, right: string): {
  char: number
  coverage: number
  terms: number
  combined: number
} => {
  const a = normalizedSourceValue(left)
  const b = normalizedSourceValue(right)
  if (!a || !b) return { char: 0, coverage: 0, terms: 0, combined: 0 }
  const leftTerms = sourceTermsOf(a)
  const rightTerms = sourceTermsOf(b)
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length
  const terms = intersection / Math.max(1, new Set([...leftTerms, ...rightTerms]).size)
  const coverage = Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const char = semanticTextSimilarity(a, b)
  return { char, coverage, terms, combined: char * 0.55 + coverage * 0.2 + terms * 0.25 }
}

const sourceEvidenceSection = (
  card: RequirementMatchCard,
  label: string,
  nextLabels: readonly string[] = []
): string => {
  const lines = card.evidence.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim().startsWith(label))
  if (start < 0) return ''
  const values: string[] = [lines[start]!.trim().slice(label.length).trim()]
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (nextLabels.some((nextLabel) => line.startsWith(nextLabel))) break
    if (line) values.push(line)
  }
  return values.filter(Boolean).join('\n').trim()
}

const sourceTitleOf = (card: RequirementMatchCard): string => (
  card.sourceTitle?.trim() || sourceEvidenceSection(card, '名称：', [
    '明确需求类型：', '明确产品域：', '明确模块：', '描述：'
  ])
)

const sourceDescriptionOf = (card: RequirementMatchCard): string => (
  card.sourceDescription?.trim() || sourceEvidenceSection(card, '描述：')
)

export interface RequirementMatchConfirmation {
  relation: Extract<RequirementMatchRelation, 'duplicate' | 'highly_similar'>
  decisionPath: Extract<RequirementMatchDecisionPath, 'exact_text' | 'near_duplicate_text' | 'semantic_card'>
  confidenceBasis: string[]
}

const sourceConfirmationOf = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): RequirementMatchConfirmation | null => {
  const baseTitle = sourceTitleOf(base)
  const candidateTitle = sourceTitleOf(candidate)
  const baseDescription = sourceDescriptionOf(base)
  const candidateDescription = sourceDescriptionOf(candidate)
  if (!baseTitle || !candidateTitle || !baseDescription || !candidateDescription) return null

  const titleNormalized = normalizedSourceValue(baseTitle)
  const candidateTitleNormalized = normalizedSourceValue(candidateTitle)
  const descriptionNormalized = normalizedSourceValue(baseDescription)
  const candidateDescriptionNormalized = normalizedSourceValue(candidateDescription)
  if (titleNormalized === candidateTitleNormalized && descriptionNormalized === candidateDescriptionNormalized) {
    return {
      relation: 'duplicate',
      decisionPath: 'exact_text',
      confidenceBasis: ['标题与清洗描述规范化后完全一致']
    }
  }

  const title = sourceFieldSimilarity(baseTitle, candidateTitle)
  const description = sourceFieldSimilarity(baseDescription, candidateDescription)
  const titleNear = title.combined >= 0.70 && title.char >= 0.68 &&
    title.coverage >= 0.62 && title.terms >= 0.58
  const descriptionNear = description.combined >= 0.86 && description.coverage >= 0.72 && description.terms >= 0.68
  const titleExact = titleNormalized === candidateTitleNormalized
  const descriptionContained = descriptionNormalized.includes(candidateDescriptionNormalized) ||
    candidateDescriptionNormalized.includes(descriptionNormalized)
  const containedDescriptionNear = titleExact && descriptionContained &&
    description.coverage >= 0.72 && description.char >= 0.72 && description.terms >= 0.60
  if (!titleNear || (!descriptionNear && !containedDescriptionNear)) return null

  const duplicateText = title.char >= 0.72 && title.coverage >= 0.70 && title.terms >= 0.70 &&
    description.char >= 0.94 && description.coverage >= 0.90 && description.terms >= 0.84
  return {
    relation: containedDescriptionNear || duplicateText ? 'duplicate' : 'highly_similar',
    decisionPath: 'near_duplicate_text',
    confidenceBasis: [
      `标题字符相似 ${title.char.toFixed(2)}、覆盖率 ${title.coverage.toFixed(2)}、词项相似 ${title.terms.toFixed(2)}`,
      `描述字符相似 ${description.char.toFixed(2)}、覆盖率 ${description.coverage.toFixed(2)}、词项相似 ${description.terms.toFixed(2)}`
    ]
  }
}

const semanticCardConfirmationOf = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): RequirementMatchConfirmation | null => {
  if (base.analysisStatus !== 'ai_adjudicated' || candidate.analysisStatus !== 'ai_adjudicated') return null
  if (base.action === 'unknown' || candidate.action === 'unknown' || base.action !== candidate.action) return null

  const fields: Array<{ name: keyof RequirementMatchCard; weight: number }> = [
    { name: 'functionalObject', weight: 0.30 },
    { name: 'action', weight: 0.20 },
    { name: 'behavior', weight: 0.20 },
    { name: 'currentState', weight: 0.10 },
    { name: 'targetState', weight: 0.15 },
    { name: 'constraints', weight: 0.05 }
  ]
  const values = fields.map(({ name, weight }) => ({
    name,
    weight,
    left: String(base[name] ?? '').trim(),
    right: String(candidate[name] ?? '').trim()
  }))
  const mandatory = values.filter((item) => ['functionalObject', 'action', 'behavior'].includes(item.name as string))
  if (mandatory.some((item) => !item.left || !item.right)) return null

  // The denominator is the full fixed business-dimension weight. Missing
  // fields therefore lower confidence instead of amplifying one populated
  // dimension through re-normalization.
  const confidence = values.reduce((sum, item) => {
    if (!item.left || !item.right) return sum
    const similarity = item.name === 'action'
      ? (item.left === item.right ? 1 : 0)
      : semanticTextSimilarity(item.left, item.right)
    return sum + similarity * item.weight
  }, 0)
  const comparedWeight = values.reduce((sum, item) => (
    item.left && item.right ? sum + item.weight : sum
  ), 0)
  if (comparedWeight < 0.65 || confidence < 0.82) return null
  return {
    relation: confidence >= 0.9 && comparedWeight >= 0.8 ? 'duplicate' : 'highly_similar',
    decisionPath: 'semantic_card',
    confidenceBasis: [
      `ready 语义卡片关键维度一致性 ${confidence.toFixed(2)}`,
      `已比较业务维度权重 ${comparedWeight.toFixed(2)}`
    ]
  }
}

export const requirementMatchConfirmationOf = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): RequirementMatchConfirmation | null => sourceConfirmationOf(base, candidate) ?? semanticCardConfirmationOf(base, candidate)

export const isDeterministicRequirementMatch = (
  score: Pick<RequirementMatchScoreResult, 'decisionPath' | 'relation'>
): boolean => (
  (score.decisionPath === 'exact_text' || score.decisionPath === 'near_duplicate_text' || score.decisionPath === 'semantic_card') &&
  (score.relation === 'duplicate' || score.relation === 'highly_similar')
)

const defaultSignalOf = (
  candidate: RequirementMatchCard | HybridRequirementCandidate,
  dimension: RequirementMatchDimension,
  signals: RequirementMatchScoringSignals
): number | undefined => {
  if (dimension === 'dense') {
    if (isFiniteNumber(signals.denseScore)) return signals.denseScore
    return isHybridRequirementCandidate(candidate) && isFiniteNumber(candidate.denseScore)
      ? candidate.denseScore
      : undefined
  }
  if (dimension === 'lexical') {
    if (isFiniteNumber(signals.lexicalScore)) return signals.lexicalScore
    return isHybridRequirementCandidate(candidate) && isFiniteNumber(candidate.lexicalScore)
      ? candidate.lexicalScore
      : undefined
  }
  if (dimension === 'structural') {
    if (isFiniteNumber(signals.structuralScore)) return signals.structuralScore
    return isHybridRequirementCandidate(candidate) && isFiniteNumber(candidate.structuralScore)
      ? candidate.structuralScore
      : undefined
  }
  if (dimension === 'semantic') return signals.semanticScore
  if (dimension === 'keyword') return signals.keywordScore
  if (dimension === 'domain') return signals.domainScore
  if (dimension === 'object') return signals.objectScore
  if (dimension === 'reranker') return signals.rerankerScore
  return undefined
}

const lexicalTermSimilarity = (left: RequirementMatchCard, right: RequirementMatchCard): number | undefined => {
  const leftTerms = new Set(left.lexicalTerms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))
  const rightTerms = new Set(right.lexicalTerms.map((term) => term.trim().toLocaleLowerCase()).filter(Boolean))
  if (!leftTerms.size || !rightTerms.size) return undefined
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length
  return intersection / Math.max(1, new Set([...leftTerms, ...rightTerms]).size)
}

const domainSimilarity = (left: RequirementMatchCard, right: RequirementMatchCard): number | undefined => {
  const values: number[] = []
  if (left.productDomain && right.productDomain) values.push(semanticTextSimilarity(left.productDomain, right.productDomain))
  if (left.module && right.module) values.push(semanticTextSimilarity(left.module, right.module))
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined
}

const scoreForDimension = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard | HybridRequirementCandidate,
  candidateCard: RequirementMatchCard,
  dimension: RequirementMatchDimension,
  signals: RequirementMatchScoringSignals
): number | undefined => {
  const explicitScores = signals.dimensionScores
  if (explicitScores && hasOwn(explicitScores, dimension)) {
    const explicit = explicitScores[dimension]
    return normalizeRequirementScore(explicit, signals.dimensionRanges?.[dimension] ?? SCORE_RANGE_0_TO_100)
  }
  if (dimension === 'action') {
    if (base.action === 'unknown' || candidateCard.action === 'unknown') return undefined
    return base.action === candidateCard.action ? 100 : 0
  }
  if (dimension === 'semantic') {
    const denseSignal = defaultSignalOf(candidate, 'dense', signals)
    if (denseSignal !== undefined) {
      return normalizeRequirementScore(
        denseSignal,
        signals.dimensionRanges?.semantic ?? SCORE_RANGE_0_TO_100
      )
    }
    if (!base.matchingText || !candidateCard.matchingText) return undefined
    return normalizeRequirementScore(
      semanticTextSimilarity(base.matchingText, candidateCard.matchingText),
      { min: 0, max: 1 }
    )
  }
  if (dimension === 'keyword') {
    const similarity = lexicalTermSimilarity(base, candidateCard)
    return similarity === undefined ? undefined : normalizeRequirementScore(similarity, { min: 0, max: 1 })
  }
  if (dimension === 'domain') {
    const similarity = domainSimilarity(base, candidateCard)
    return similarity === undefined ? undefined : normalizeRequirementScore(similarity, { min: 0, max: 1 })
  }
  if (dimension === 'object') {
    if (!base.functionalObject || !candidateCard.functionalObject) return undefined
    return normalizeRequirementScore(
      semanticTextSimilarity(base.functionalObject, candidateCard.functionalObject),
      { min: 0, max: 1 }
    )
  }
  if (TEXT_DIMENSIONS.includes(dimension)) return textDimensionScore(base, candidateCard, dimension)
  const signal = defaultSignalOf(candidate, dimension, signals)
  return normalizeRequirementScore(signal, signals.dimensionRanges?.[dimension] ?? SCORE_RANGE_0_TO_100)
}

const weightedDimensionDetails = (
  dimensions: Array<{ dimension: RequirementMatchDimension; score: number; weight: number }>,
  totalWeight: number
): RequirementMatchScoreDimension[] => dimensions.map((item) => ({
  ...item,
  contribution: roundScore(item.score * item.weight / totalWeight)
}))

const downgradeDecision = (
  decision: RequirementMatchDecision,
  targetRelation: RequirementMatchRelation,
  maximumScore: number,
  reason: string
): RequirementMatchDecision => {
  const shouldLowerRelation = requirementMatchRelationRank(decision.relation) > requirementMatchRelationRank(targetRelation)
  const relationMaximum = REQUIREMENT_MATCH_RELATION_SCORE_RANGES[decision.relation]?.max ?? 100
  const scoreMaximum = shouldLowerRelation ? maximumScore : Math.min(maximumScore, relationMaximum)
  const shouldLowerScore = decision.finalScore > scoreMaximum
  if (!shouldLowerRelation && !shouldLowerScore) return decision
  return {
    relation: shouldLowerRelation ? targetRelation : decision.relation,
    finalScore: clampRequirementScore(Math.min(decision.finalScore, scoreMaximum)),
    downgradeReasons: [...decision.downgradeReasons, reason]
  }
}

/** Apply only card-provided action/object rules; it never reads raw requirement IDs or text patterns. */
export const applyRequirementMatchHardRules = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  decision: RequirementMatchDecision
): RequirementMatchDecision => {
  const objectSimilarity = objectSimilarityOf(base, candidate)
  const actionKnown = base.action !== 'unknown' && candidate.action !== 'unknown'
  let current = {
    relation: decision.relation,
    finalScore: clampRequirementScore(decision.finalScore),
    downgradeReasons: [...decision.downgradeReasons]
  }

  if ((base.action === 'add_capability' && candidate.action === 'fix_defect') ||
      (base.action === 'fix_defect' && candidate.action === 'add_capability')) {
    current = downgradeDecision(current, 'topic_only', 39, '功能新增与缺陷修复属于不同需求动作')
  }
  if ((base.action === 'rename_label') !== (candidate.action === 'rename_label')) {
    current = downgradeDecision(current, 'topic_only', 39, '文案修改与其他业务动作不能视为同一需求')
  }
  if (actionKnown && base.action !== candidate.action) {
    current = objectSimilarity >= 0.55
      ? downgradeDecision(current, 'partial_overlap', 69, '功能对象相近但需求动作不同')
      : downgradeDecision(current, 'topic_only', 39, '需求动作和功能对象均不一致')
  }
  if (actionKnown && base.action === candidate.action && objectSimilarity < 0.5) {
    current = downgradeDecision(current, 'same_pattern', 59, '需求动作相同但功能对象不同')
  }
  return current
}

/**
 * Apply the relation adjudicated by the batch explanation to a deterministic
 * score. The model supplies only the relation; the local score remains the
 * source of the percentage and is clamped to that relation's interval.
 */
export const constrainRequirementMatchToRelation = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  score: RequirementMatchScoreResult,
  relation: RequirementMatchRelation
): RequirementMatchScoreResult => {
  const range = REQUIREMENT_MATCH_RELATION_SCORE_RANGES[relation]
  const boundedScore = clampRequirementScore(Math.max(range.min, Math.min(range.max, score.finalScore)))
  const constrained: RequirementMatchDecision = {
    relation,
    finalScore: boundedScore,
    downgradeReasons: relation === score.relation
      ? [...score.downgradeReasons]
      : [...score.downgradeReasons, `批量 AI 复核关系为 ${relation}，本地分数限制在对应区间`],
    decisionPath: isDeterministicRequirementMatch(score) ? score.decisionPath : 'ai_review',
    confidenceBasis: isDeterministicRequirementMatch(score)
      ? [...score.confidenceBasis, 'AI 复核补充审计，不覆盖已独立成立的确定性路径']
      : ['一次批量 AI 关系复核约束本地确定性分数']
  }
  const ruled = applyRequirementMatchHardRules(base, candidate, constrained)
  return { ...score, ...ruled }
}

/** A failed review may never leave a formal relation visible to the caller. */
export const downgradeRequirementMatchForUnavailableReview = (
  score: RequirementMatchScoreResult
): RequirementMatchScoreResult => {
  if (isDeterministicRequirementMatch(score) || !['duplicate', 'highly_similar'].includes(score.relation)) return score
  return {
    ...score,
    ...downgradeDecision(
      score,
      'partial_overlap',
      REQUIREMENT_MATCH_RELATION_SCORE_RANGES.partial_overlap.max,
      'AI 语义复核不可用，正式匹配关系已降级为非正式关系'
    ),
    decisionPath: 'unavailable',
    confidenceBasis: [...score.confidenceBasis, 'AI 语义复核不可用，未形成正式关系置信依据']
  }
}

export const scoreRequirementMatch = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard | HybridRequirementCandidate,
  signals: RequirementMatchScoringSignals = {}
): RequirementMatchScoreResult => {
  const candidateCard = cardFromCandidate(candidate)
  const dimensions: Partial<Record<RequirementMatchDimension, number>> = {}
  const weighted: Array<{ dimension: RequirementMatchDimension; score: number; weight: number }> = []
  const configuredWeights = signals.weights ?? {}

  for (const dimension of REQUIREMENT_MATCH_DIMENSIONS) {
    const score = scoreForDimension(base, candidate, candidateCard, dimension, signals)
    const configuredWeight = hasOwn(configuredWeights, dimension)
      ? configuredWeights[dimension]
    : REQUIREMENT_MATCH_DEFAULT_WEIGHTS[dimension]
    if (score === undefined || !isFiniteNumber(configuredWeight) || configuredWeight <= 0) continue
    const normalizedScore = clampRequirementScore(score)
    dimensions[dimension] = normalizedScore
    weighted.push({ dimension, score: normalizedScore, weight: configuredWeight })
  }

  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0)
  const rawFinalScore = totalWeight > 0
    ? weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight
    : 0
  const finalScore = clampRequirementScore(rawFinalScore)
  const objectSimilarity = objectSimilarityOf(base, candidateCard)
  const actionComparison = actionComparisonOf(base, candidateCard)
  const initialDecision: RequirementMatchDecision = {
    relation: classifyRequirementRelation(finalScore, {
      objectSimilarity,
      actionKnown: actionComparison !== 'unknown',
      sameAction: actionComparison === 'same'
    }),
    finalScore,
    downgradeReasons: []
  }
  let decision = applyRequirementMatchHardRules(base, candidateCard, initialDecision)
  // A reranker score is useful for ordering, but a high absolute value from
  // that uncalibrated model cannot independently establish a formal match.
  const hasIndependentSignal = weighted.some((item) => item.dimension !== 'reranker')
  if (!hasIndependentSignal && ['duplicate', 'highly_similar'].includes(decision.relation)) {
    decision = downgradeDecision(
      decision,
      'partial_overlap',
      REQUIREMENT_MATCH_RELATION_SCORE_RANGES.partial_overlap.max,
      'Cross-Encoder 绝对分仅用于排序，不能单独产生正式匹配关系'
    )
  }
  let decisionPath: RequirementMatchDecisionPath = 'deterministic_score'
  let confidenceBasis: string[] = ['本地多维确定性评分']
  const confirmation = requirementMatchConfirmationOf(base, candidateCard)
  if (confirmation) {
    const range = REQUIREMENT_MATCH_RELATION_SCORE_RANGES[confirmation.relation]
    const confirmedDecision = applyRequirementMatchHardRules(base, candidateCard, {
      relation: confirmation.relation,
      finalScore: clampRequirementScore(Math.max(range.min, Math.min(range.max, decision.finalScore))),
      downgradeReasons: [...decision.downgradeReasons],
      decisionPath: confirmation.decisionPath,
      confidenceBasis: confirmation.confidenceBasis
    })
    if (confirmedDecision.relation === confirmation.relation) {
      decision = confirmedDecision
      decisionPath = confirmation.decisionPath
      confidenceBasis = confirmation.confidenceBasis
    }
  }
  return {
    ...decision,
    recordUid: candidateUidOf(candidate),
    dimensions,
    dimensionDetails: weightedDimensionDetails(weighted, totalWeight || 1),
    validDimensions: weighted.map((item) => item.dimension),
    totalWeight: roundScore(totalWeight),
    objectSimilarity: roundScore(objectSimilarity * 100) / 100,
    actionComparison,
    decisionPath,
    confidenceBasis
  }
}

export const scoreRequirementCandidate = (
  base: RequirementMatchCard,
  candidate: HybridRequirementCandidate,
  signals: RequirementMatchScoringSignals = {}
): RequirementMatchScoreResult => scoreRequirementMatch(base, candidate, signals)

export const scoreRequirementCards = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard,
  signals: RequirementMatchScoringSignals = {}
): RequirementMatchScoreResult => scoreRequirementMatch(base, candidate, signals)

export const scoreRequirementCandidates = (
  base: RequirementMatchCard,
  candidates: HybridRequirementCandidate[],
  signals: RequirementMatchScoringSignals = {}
): RequirementMatchScoreResult[] => candidates.map((candidate) => (
  scoreRequirementCandidate(base, candidate, signals)
))

export const computeRequirementMatchFinalScore = (
  dimensions: Partial<Record<RequirementMatchDimension, number>>,
  weights: Partial<Record<RequirementMatchDimension, number>> = {}
): number => {
  const weighted: Array<{ score: number; weight: number }> = []
  for (const dimension of REQUIREMENT_MATCH_DIMENSIONS) {
    const score = normalizeRequirementScore(dimensions[dimension])
    const weight = hasOwn(weights, dimension) ? weights[dimension] : REQUIREMENT_MATCH_DEFAULT_WEIGHTS[dimension]
    if (score === undefined || !isFiniteNumber(weight) || weight <= 0) continue
    weighted.push({ score, weight })
  }
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight) return 0
  return clampRequirementScore(weighted.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight)
}

export const calculateRequirementFinalScore = computeRequirementMatchFinalScore
export const classifyRequirementMatchRelation = classifyRequirementRelation
export const enforceRequirementMatchHardRules = applyRequirementMatchHardRules
