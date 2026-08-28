import type {
  MatchConfidenceStatus,
  RequirementMatchCandidateResult,
  RequirementMatchDegradationCode,
  RequirementSimilarityScoreBreakdown,
  RequirementSimilarityScoreComponent,
  RequirementMatchStageScores
} from './requirement-match-domain'
import type { RequirementMatchPolicyDecision } from './requirement-match-policy'
import type { RequirementRankingManifest } from './requirement-ranking-manifest'

export interface RequirementRankingInput {
  recordUid: string
  policy: RequirementMatchPolicyDecision
  stageScores: RequirementMatchStageScores
  /** Agreement of deterministic business fields in the normalized 0..1 range. */
  deterministicAgreement: number
  degradationCodes: RequirementMatchDegradationCode[]
  explanationStatus: RequirementMatchCandidateResult['explanationStatus']
  explanation: string | null
}

const finite = (value: number | null | undefined, fallback = 0): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
)

const clamp = (minimum: number, maximum: number, value: number): number => (
  Math.max(minimum, Math.min(maximum, value))
)

const normalize = (value: number | null, range: readonly [number, number]): number => {
  const [minimum, maximum] = range
  if (maximum <= minimum) return 0
  return clamp(0, 100, (finite(value) - minimum) / (maximum - minimum) * 100)
}

const rounded = (value: number, precision: number): number => {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}

const component = (
  rawScore: number | null,
  normalizedScore: number,
  weight: number,
  available: boolean,
  precision: number
): RequirementSimilarityScoreComponent => ({
  rawScore,
  normalizedScore: rounded(normalizedScore, precision),
  weight,
  contribution: rounded(normalizedScore * weight, precision),
  available
})

const fixedBreakdown = (
  manifest: RequirementRankingManifest,
  total: number
): RequirementSimilarityScoreBreakdown => ({
  formulaVersion: manifest.rankingVersion,
  dense: component(null, 0, 0, false, manifest.scorePrecision),
  lexical: component(null, 0, 0, false, manifest.scorePrecision),
  reranker: component(null, 0, 0, false, manifest.scorePrecision),
  businessAlignment: component(total ? 1 : 0, total, 1, true, manifest.scorePrecision),
  total
})

const scoreCandidate = (
  input: RequirementRankingInput,
  manifest: RequirementRankingManifest
): RequirementSimilarityScoreBreakdown => {
  if (input.policy.decisionStatus === 'rejected') return fixedBreakdown(manifest, manifest.fixedScores.rejected)
  if (input.policy.decisionStatus === 'confirmed' && input.policy.evidenceLevel === 'exact_business_hash') {
    return fixedBreakdown(manifest, manifest.fixedScores.exactConfirmed)
  }
  const dense = normalize(input.stageScores.denseScore, manifest.inputRanges.dense)
  const lexical = normalize(input.stageScores.lexicalScore, manifest.inputRanges.lexical)
  const reranker = normalize(input.stageScores.rerankerScore, manifest.inputRanges.reranker)
  const businessAlignment = normalize(input.deterministicAgreement, manifest.inputRanges.businessAlignment)
  const breakdown: RequirementSimilarityScoreBreakdown = {
    formulaVersion: manifest.rankingVersion,
    dense: component(input.stageScores.denseScore, dense, manifest.weights.dense, input.stageScores.denseRank !== null, manifest.scorePrecision),
    lexical: component(input.stageScores.lexicalScore, lexical, manifest.weights.lexical, input.stageScores.lexicalRank !== null, manifest.scorePrecision),
    reranker: component(input.stageScores.rerankerScore, reranker, manifest.weights.reranker, input.stageScores.rerankerScore !== null, manifest.scorePrecision),
    businessAlignment: component(input.deterministicAgreement, businessAlignment, manifest.weights.businessAlignment, true, manifest.scorePrecision),
    total: 0
  }
  breakdown.total = rounded(clamp(0, 100,
    breakdown.dense.contribution + breakdown.lexical.contribution +
    breakdown.reranker.contribution + breakdown.businessAlignment.contribution
  ), manifest.scorePrecision)
  return breakdown
}

const confidenceOf = (
  input: RequirementRankingInput,
  similarityScore: number
): { status: MatchConfidenceStatus; reasons: string[] } => {
  if (input.policy.decisionStatus === 'confirmed') return { status: 'high', reasons: ['EXACT_BUSINESS_IDENTITY'] }
  if (input.policy.decisionStatus === 'ambiguous' || input.policy.decisionStatus === 'rejected') {
    return { status: 'abstain', reasons: [...input.policy.reasonCodes] }
  }
  const reasons: string[] = []
  if (input.deterministicAgreement >= 0.75) reasons.push('STRONG_STRUCTURED_AGREEMENT')
  else if (input.deterministicAgreement >= 0.4) reasons.push('PARTIAL_STRUCTURED_AGREEMENT')
  else reasons.push('WEAK_STRUCTURED_AGREEMENT')
  if (input.stageScores.rerankerScore !== null && input.stageScores.rerankerScore >= 85) reasons.push('STRONG_RERANK_SIGNAL')
  if (similarityScore >= 85 && input.deterministicAgreement >= 0.75) return { status: 'high', reasons }
  if (similarityScore >= 65 && input.deterministicAgreement >= 0.4) return { status: 'medium', reasons }
  return { status: 'low', reasons }
}

const ascendingRank = (value: number | null): number => finite(value, Number.MAX_SAFE_INTEGER)

export const rankRequirementCandidates = (
  inputs: RequirementRankingInput[],
  manifest: RequirementRankingManifest
): RequirementMatchCandidateResult[] => inputs
  .map((input) => {
    const scoreBreakdown = scoreCandidate(input, manifest)
    const similarityScore = scoreBreakdown.total
    const confidence = confidenceOf(input, similarityScore)
    return {
      input,
      result: {
        recordUid: input.recordUid,
        finalRank: 0,
        similarityScore,
        rankingScore: similarityScore,
        rankingVersion: manifest.rankingVersion,
        scoreBreakdown,
        relation: input.policy.relation,
        decisionStatus: input.policy.decisionStatus,
        confidenceStatus: confidence.status,
        confidenceReasons: confidence.reasons,
        evidenceLevel: input.policy.evidenceLevel,
        reasonCodes: [...input.policy.reasonCodes],
        degradationCodes: [...input.degradationCodes],
        stageScores: { ...input.stageScores },
        explanationStatus: input.explanationStatus,
        explanation: input.explanation
      } satisfies RequirementMatchCandidateResult
    }
  })
  .sort((left, right) => (
    right.result.similarityScore - left.result.similarityScore ||
    ascendingRank(left.input.stageScores.rerankerRank) - ascendingRank(right.input.stageScores.rerankerRank) ||
    left.input.stageScores.fusedRank - right.input.stageScores.fusedRank ||
    left.result.recordUid.localeCompare(right.result.recordUid)
  ))
  .map(({ result }, index, rows) => {
    if (index !== 0 || result.decisionStatus === 'confirmed' || result.confidenceStatus === 'abstain' || result.confidenceStatus === 'low') {
      return { ...result, finalRank: index + 1 }
    }
    const nextScore = rows[1]?.result.similarityScore
    const gap = typeof nextScore === 'number' ? result.similarityScore - nextScore : Number.POSITIVE_INFINITY
    if (gap <= 1) {
      return {
        ...result,
        finalRank: 1,
        confidenceStatus: 'low',
        confidenceReasons: [...result.confidenceReasons, 'TOP_RESULT_TIE']
      }
    }
    if (gap <= 3 && result.confidenceStatus === 'high') {
      return {
        ...result,
        finalRank: 1,
        confidenceStatus: 'medium',
        confidenceReasons: [...result.confidenceReasons, 'NARROW_TOP_GAP']
      }
    }
    return { ...result, finalRank: index + 1 }
  })
