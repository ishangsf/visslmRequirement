import type { MatchDecisionStatus, MatchRelation, RequirementMatchResult } from './requirement-match-domain'

export interface RequirementMatchEntrypointRow {
  recordUid: string
  finalRank: number
  rankingScore: number
  relation: MatchRelation
  decisionStatus: MatchDecisionStatus
}

const project = (result: RequirementMatchResult): RequirementMatchEntrypointRow[] => result.candidates
  .filter((candidate) => candidate.decisionStatus !== 'rejected')
  .map(({ recordUid, finalRank, rankingScore, relation, decisionStatus }) => ({
    recordUid, finalRank, rankingScore, relation, decisionStatus
  }))

const agent = (result: RequirementMatchResult): RequirementMatchEntrypointRow[] => result.candidates
  .filter(({ decisionStatus }) => decisionStatus !== 'rejected')
  .map((candidate) => ({
    recordUid: candidate.recordUid,
    finalRank: candidate.finalRank,
    rankingScore: candidate.rankingScore,
    relation: candidate.relation,
    decisionStatus: candidate.decisionStatus
  }))

export const projectRequirementMatchProjection = project
export const agentRequirementMatchProjection = agent
