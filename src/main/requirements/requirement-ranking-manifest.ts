import { createHash } from 'node:crypto'

export const FULL_RERANK_RANKING_VERSION = 'requirement-similarity-v3-cross-encoder'
export const FALLBACK_RANKING_VERSION = 'requirement-similarity-v3-retrieval-fallback'

export interface RequirementRankingManifest {
  rankingVersion: string
  scorePrecision: number
  weights: {
    dense: number
    lexical: number
    reranker: number
    businessAlignment: number
  }
  inputRanges: {
    dense: readonly [number, number]
    lexical: readonly [number, number]
    reranker: readonly [number, number]
    businessAlignment: readonly [number, number]
  }
  fixedScores: {
    exactConfirmed: number
    rejected: number
  }
  tieBreak: readonly ['similarityScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc']
}

export const FULL_REQUIREMENT_RANKING_MANIFEST: Readonly<RequirementRankingManifest> = Object.freeze({
  rankingVersion: FULL_RERANK_RANKING_VERSION,
  scorePrecision: 2,
  weights: Object.freeze({ dense: 0.20, lexical: 0.10, reranker: 0.55, businessAlignment: 0.15 }),
  inputRanges: Object.freeze({
    dense: Object.freeze([0, 100] as const),
    lexical: Object.freeze([0, 100] as const),
    reranker: Object.freeze([0, 100] as const),
    businessAlignment: Object.freeze([0, 1] as const)
  }),
  fixedScores: Object.freeze({ exactConfirmed: 100, rejected: 0 }),
  tieBreak: Object.freeze(['similarityScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc'] as const)
})

export const FALLBACK_REQUIREMENT_RANKING_MANIFEST: Readonly<RequirementRankingManifest> = Object.freeze({
  rankingVersion: FALLBACK_RANKING_VERSION,
  scorePrecision: 2,
  weights: Object.freeze({ dense: 0.55, lexical: 0.20, reranker: 0, businessAlignment: 0.25 }),
  inputRanges: Object.freeze({
    dense: Object.freeze([0, 100] as const),
    lexical: Object.freeze([0, 100] as const),
    reranker: Object.freeze([0, 100] as const),
    businessAlignment: Object.freeze([0, 1] as const)
  }),
  fixedScores: Object.freeze({ exactConfirmed: 100, rejected: 0 }),
  tieBreak: Object.freeze(['similarityScoreDesc', 'rerankerRankAsc', 'fusedRankAsc', 'recordUidAsc'] as const)
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
