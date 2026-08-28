import type { RequirementMatchCard } from './requirement-match-card'

export const MATCH_RELATIONS = [
  'duplicate', 'highly_similar', 'partial_overlap', 'same_pattern', 'topic_only', 'unrelated'
] as const
export type MatchRelation = typeof MATCH_RELATIONS[number] | null

export const MATCH_DECISION_STATUSES = ['confirmed', 'suggested', 'ambiguous', 'rejected'] as const
export type MatchDecisionStatus = typeof MATCH_DECISION_STATUSES[number]

export const MATCH_EVIDENCE_LEVELS = [
  'exact_business_hash', 'exact_normalized_text', 'deterministic_rule', 'model_supported', 'retrieval_only'
] as const
export type MatchEvidenceLevel = typeof MATCH_EVIDENCE_LEVELS[number]

export const MATCH_CONFIDENCE_STATUSES = ['high', 'medium', 'low', 'abstain'] as const
export type MatchConfidenceStatus = typeof MATCH_CONFIDENCE_STATUSES[number]

export const MATCH_EXPLANATION_STATUSES = ['not_requested', 'pending', 'available', 'unavailable'] as const
export type MatchExplanationStatus = typeof MATCH_EXPLANATION_STATUSES[number]

export const REQUIREMENT_MATCH_DEGRADATION_CODES = [
  'RERANKER_UNAVAILABLE', 'EXPLAINER_UNAVAILABLE', 'EXPLANATION_PARTIAL', 'EXPLANATION_PROTOCOL_ERROR'
] as const
export type RequirementMatchDegradationCode = typeof REQUIREMENT_MATCH_DEGRADATION_CODES[number]

export interface RequirementBusinessFacts {
  action: string
  object: string
  constraints: string[]
  negated: boolean | null
  source: 'structured' | 'deterministic' | 'missing'
}

export interface RequirementMatchStageScores {
  denseRank: number | null
  denseScore: number | null
  lexicalRank: number | null
  lexicalScore: number | null
  fusedRank: number
  fusedScore: number
  rerankerRank: number | null
  rerankerScore: number | null
}

export interface RequirementSimilarityScoreComponent {
  rawScore: number | null
  normalizedScore: number
  weight: number
  contribution: number
  available: boolean
}

export interface RequirementSimilarityScoreBreakdown {
  formulaVersion: string
  dense: RequirementSimilarityScoreComponent
  lexical: RequirementSimilarityScoreComponent
  reranker: RequirementSimilarityScoreComponent
  businessAlignment: RequirementSimilarityScoreComponent
  total: number
}

export interface RequirementMatchRequest {
  base: RequirementMatchCard
  excludedUids: ReadonlySet<string>
  includeCurrentProjectRecords: boolean
  /** Project scope used by candidate eligibility checks. */
  currentProjectId?: string
  explainTopN: number
  explanationPolicy: {
    mode: 'disabled' | 'local' | 'online'
    allowExternalProcessing: boolean
  }
}

export interface RequirementMatchCandidateResult {
  recordUid: string
  finalRank: number
  /** Evidence-based 0..100 similarity for this requirement/candidate pair. */
  similarityScore: number
  /** Compatibility alias retained for existing ranking consumers. */
  rankingScore: number
  rankingVersion: string
  scoreBreakdown: RequirementSimilarityScoreBreakdown
  relation: MatchRelation
  decisionStatus: MatchDecisionStatus
  confidenceStatus: MatchConfidenceStatus
  confidenceReasons: string[]
  evidenceLevel: MatchEvidenceLevel
  reasonCodes: string[]
  degradationCodes: RequirementMatchDegradationCode[]
  stageScores: RequirementMatchStageScores
  /** Source-derived evidence only; model explanations must not invent this data. */
  evidenceJson?: unknown
  explanationStatus: MatchExplanationStatus
  explanation: string | null
}

export interface RequirementMatchResult {
  normalizationVersion: string
  pipelineVersion: string
  rankingVersion: string
  configHash: string
  modelVersion: string | null
  degradationCodes: RequirementMatchDegradationCode[]
  candidates: RequirementMatchCandidateResult[]
}

export type RequirementMatchRunStatus = 'running' | 'succeeded' | 'failed' | 'stale'
export type RequirementMatchFailureCode =
  | 'MATCH_CANCELLED'
  | 'INDEX_VERSION_MISMATCH'
  | 'REQUIREMENT_SNAPSHOT_CHANGED'
  | 'NORMALIZATION_VERSION_UNAVAILABLE'
  | 'RANKING_VERSION_UNAVAILABLE'
  | 'CANDIDATE_PERSISTENCE_FAILED'
  | 'ACCESS_DENIED'

export interface RequirementMatchRun {
  id: string
  requirementId: string
  requirementSnapshotHash: string
  requirementBusinessHash: string
  normalizationVersion: string
  indexVersion: string
  pipelineVersion: string
  rankingVersion: string
  configHash: string
  modelVersion: string | null
  status: RequirementMatchRunStatus
  degradationCodes: RequirementMatchDegradationCode[]
  failureCode: string | null
  /** Canonical run start time. */
  startedAt: string
  /** Legacy compatibility alias retained for existing readers. */
  createdAt: string
  completedAt: string | null
}

export type RequirementMatchRunCreateInput = Omit<
  RequirementMatchRun,
  'id' | 'status' | 'degradationCodes' | 'failureCode' | 'createdAt' | 'startedAt' | 'completedAt' |
  'requirementBusinessHash' | 'indexVersion'
> & Partial<Pick<RequirementMatchRun, 'requirementBusinessHash' | 'indexVersion' | 'startedAt'>>

export interface PersistedRequirementMatchCandidate extends RequirementMatchCandidateResult {
  runId: string
  recordSnapshotHash: string
}

export interface RequirementMatchCandidatePage {
  rows: PersistedRequirementMatchCandidate[]
  total: number
}

export interface RequirementMatchRunCompatibilityQuery {
  requirementId: string
  requirementSnapshotHash: string
  requirementBusinessHash?: string
  normalizationVersion?: string
  pipelineVersion?: string
  indexVersion?: string
}

export const isMatchRelation = (value: unknown): value is Exclude<MatchRelation, null> =>
  typeof value === 'string' && MATCH_RELATIONS.includes(value as Exclude<MatchRelation, null>)

export const isRankingScore = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
