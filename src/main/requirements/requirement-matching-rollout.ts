import { normalizeRequirementMatchingRolloutMode, type RequirementMatchingRolloutMode } from '../../shared/types'

export interface RequirementMatchingRolloutDecision {
  mode: RequirementMatchingRolloutMode
  primaryReadPath: 'legacy_safe' | 'v1_1'
  newPipelinePersisted: boolean
  businessWriteCount: 0
}

export interface RequirementMatchingComparisonRow {
  recordUid: string
  rank: number
  decisionStatus: string
}

export interface RequirementMatchingComparison {
  candidateOverlapAt20: number
  rankCorrelation: number
  decisionDriftCount: number
  businessWriteCount: 0
}

interface NormalizedComparisonRow {
  recordUid: string
  rank: number
  decisionStatus: string
}

const COMPARISON_LIMIT = 20

const normalizeComparisonRows = (
  rows: readonly RequirementMatchingComparisonRow[]
): NormalizedComparisonRow[] => {
  const byRecordUid = new Map<string, NormalizedComparisonRow>()
  for (const row of rows) {
    const recordUid = String(row.recordUid ?? '').trim()
    if (!recordUid) continue
    const rawRank = Number(row.rank)
    const rank = Number.isFinite(rawRank) && rawRank > 0 ? rawRank : Number.POSITIVE_INFINITY
    const current = byRecordUid.get(recordUid)
    if (!current || rank < current.rank) {
      byRecordUid.set(recordUid, {
        recordUid,
        rank,
        decisionStatus: String(row.decisionStatus ?? '')
      })
    }
  }
  return [...byRecordUid.values()]
    .sort((left, right) => left.rank - right.rank || left.recordUid.localeCompare(right.recordUid))
    .slice(0, COMPARISON_LIMIT)
    .map((row, index) => ({
      ...row,
      rank: Number.isFinite(row.rank) ? row.rank : index + 1
    }))
}

const calculateRankCorrelation = (
  legacyRows: readonly NormalizedComparisonRow[],
  v11Rows: readonly NormalizedComparisonRow[]
): number => {
  const v11ByRecordUid = new Map(v11Rows.map((row) => [row.recordUid, row]))
  const commonRows = legacyRows
    .map((legacyRow) => ({ legacyRow, v11Row: v11ByRecordUid.get(legacyRow.recordUid) }))
    .filter((row): row is { legacyRow: NormalizedComparisonRow; v11Row: NormalizedComparisonRow } => Boolean(row.v11Row))
  if (commonRows.length === 0) return 0
  if (commonRows.length === 1) return 1

  const legacyRanks = commonRows.map(({ legacyRow }) => legacyRow.rank)
  const v11Ranks = commonRows.map(({ v11Row }) => v11Row.rank)
  const legacyMean = legacyRanks.reduce((sum, rank) => sum + rank, 0) / legacyRanks.length
  const v11Mean = v11Ranks.reduce((sum, rank) => sum + rank, 0) / v11Ranks.length
  let numerator = 0
  let legacyVariance = 0
  let v11Variance = 0
  for (let index = 0; index < commonRows.length; index += 1) {
    const legacyDelta = legacyRanks[index] - legacyMean
    const v11Delta = v11Ranks[index] - v11Mean
    numerator += legacyDelta * v11Delta
    legacyVariance += legacyDelta ** 2
    v11Variance += v11Delta ** 2
  }
  const denominator = Math.sqrt(legacyVariance * v11Variance)
  if (denominator === 0) {
    return legacyRanks.every((rank, index) => rank === v11Ranks[index]) ? 1 : 0
  }
  return Number(Math.max(-1, Math.min(1, numerator / denominator)).toFixed(6))
}

export const compareRequirementMatchingResults = (
  legacy: readonly RequirementMatchingComparisonRow[],
  v11: readonly RequirementMatchingComparisonRow[]
): RequirementMatchingComparison => {
  const legacyRows = normalizeComparisonRows(legacy)
  const v11Rows = normalizeComparisonRows(v11)
  const v11ByRecordUid = new Map(v11Rows.map((row) => [row.recordUid, row]))
  const overlapCount = legacyRows.filter((row) => v11ByRecordUid.has(row.recordUid)).length
  const denominator = Math.max(legacyRows.length, v11Rows.length)
  const legacyByRecordUid = new Map(legacyRows.map((row) => [row.recordUid, row]))
  const decisionDriftCount = v11Rows.reduce((count, row) => {
    const legacyRow = legacyByRecordUid.get(row.recordUid)
    return legacyRow && legacyRow.decisionStatus !== row.decisionStatus ? count + 1 : count
  }, 0)
  return {
    candidateOverlapAt20: denominator === 0 ? 0 : overlapCount / denominator,
    rankCorrelation: calculateRankCorrelation(legacyRows, v11Rows),
    decisionDriftCount,
    businessWriteCount: 0
  }
}

export const resolveRequirementMatchingRollout = (value: unknown): RequirementMatchingRolloutDecision => {
  const mode = normalizeRequirementMatchingRolloutMode(value)
  return {
    mode,
    primaryReadPath: mode === 'v1_1' ? 'v1_1' : 'legacy_safe',
    newPipelinePersisted: mode !== 'legacy_safe',
    businessWriteCount: 0
  }
}
