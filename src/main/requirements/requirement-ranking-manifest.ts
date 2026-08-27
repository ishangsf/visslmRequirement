import { createHash } from 'node:crypto'

export const FULL_RERANK_RANKING_VERSION = 'requirement-ranking-v1-cross-encoder'
export const FALLBACK_RANKING_VERSION = 'requirement-ranking-v1-rrf-fallback'

export interface RequirementRankingManifest {
  rankingVersion: string
  scorePrecision: number
  weights: {
    fused: number
    reranker: number
    deterministicAgreement: number
  }
  inputRanges: {
    fused: readonly [number, number]
    reranker: readonly [number, number]
    deterministicAgreement: readonly [number, number]
  }
  fixedScores: {
    exactConfirmed: number
    rejected: number
  }
  tieBreak: readonly ['rankingScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc']
}

export const FULL_REQUIREMENT_RANKING_MANIFEST: Readonly<RequirementRankingManifest> = Object.freeze({
  rankingVersion: FULL_RERANK_RANKING_VERSION,
  scorePrecision: 1,
  weights: Object.freeze({ fused: 0.35, reranker: 0.55, deterministicAgreement: 0.10 }),
  inputRanges: Object.freeze({
    fused: Object.freeze([0, 100] as const),
    reranker: Object.freeze([0, 100] as const),
    deterministicAgreement: Object.freeze([0, 1] as const)
  }),
  fixedScores: Object.freeze({ exactConfirmed: 100, rejected: 0 }),
  tieBreak: Object.freeze(['rankingScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc'] as const)
})

export const FALLBACK_REQUIREMENT_RANKING_MANIFEST: Readonly<RequirementRankingManifest> = Object.freeze({
  rankingVersion: FALLBACK_RANKING_VERSION,
  scorePrecision: 1,
  weights: Object.freeze({ fused: 0.85, reranker: 0, deterministicAgreement: 0.15 }),
  inputRanges: Object.freeze({
    fused: Object.freeze([0, 100] as const),
    reranker: Object.freeze([0, 100] as const),
    deterministicAgreement: Object.freeze([0, 1] as const)
  }),
  fixedScores: Object.freeze({ exactConfirmed: 100, rejected: 0 }),
  tieBreak: Object.freeze(['rankingScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc'] as const)
})

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}

export const hashRequirementRankingManifest = (manifest: RequirementRankingManifest): string => createHash('sha256')
  .update(JSON.stringify(canonicalize(manifest)))
  .digest('hex')
