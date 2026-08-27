import type {
  MatchRelation,
  RequirementMatchCandidateResult,
  RequirementMatchDegradationCode,
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

const relationFromScore = (score: number): Exclude<MatchRelation, null> => {
  if (score >= 85) return 'duplicate'
  if (score >= 70) return 'highly_similar'
  if (score >= 40) return 'partial_overlap'
  if (score >= 25) return 'same_pattern'
  if (score >= 10) return 'topic_only'
  return 'unrelated'
}

const scoreCandidate = (
  input: RequirementRankingInput,
  manifest: RequirementRankingManifest
): number => {
  if (input.policy.decisionStatus === 'rejected') return manifest.fixedScores.rejected
  if (input.policy.decisionStatus === 'confirmed' && input.policy.evidenceLevel === 'exact_business_hash') {
    return manifest.fixedScores.exactConfirmed
  }
  const fused = normalize(input.stageScores.fusedScore, manifest.inputRanges.fused)
  const reranker = normalize(input.stageScores.rerankerScore, manifest.inputRanges.reranker)
  const agreement = normalize(input.deterministicAgreement, manifest.inputRanges.deterministicAgreement)
  const raw = fused * manifest.weights.fused + reranker * manifest.weights.reranker +
    agreement * manifest.weights.deterministicAgreement
  const factor = 10 ** manifest.scorePrecision
  return Math.round(clamp(0, input.policy.rankingCap, raw) * factor) / factor
}

const ascendingRank = (value: number | null): number => finite(value, Number.MAX_SAFE_INTEGER)

export const rankRequirementCandidates = (
  inputs: RequirementRankingInput[],
  manifest: RequirementRankingManifest
): RequirementMatchCandidateResult[] => inputs
  .map((input) => {
    const rankingScore = scoreCandidate(input, manifest)
    return {
      input,
      result: {
        recordUid: input.recordUid,
        finalRank: 0,
        rankingScore,
        rankingVersion: manifest.rankingVersion,
        relation: input.policy.relation ?? relationFromScore(rankingScore),
        decisionStatus: input.policy.decisionStatus,
        evidenceLevel: input.policy.evidenceLevel,
        reasonCodes: [...input.policy.reasonCodes],
        degradationCodes: [...input.degradationCodes],
        stageScores: { ...input.stageScores },
        explanation: input.explanation
      } satisfies RequirementMatchCandidateResult
    }
  })
  .sort((left, right) => (
    right.result.rankingScore - left.result.rankingScore ||
    ascendingRank(left.input.stageScores.rerankerRank) - ascendingRank(right.input.stageScores.rerankerRank) ||
    left.input.stageScores.fusedRank - right.input.stageScores.fusedRank ||
    left.result.recordUid.localeCompare(right.result.recordUid)
  ))
  .map(({ result }, index) => ({ ...result, finalRank: index + 1 }))
