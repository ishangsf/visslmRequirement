import { strict as assert } from 'node:assert'
import type { RequirementMatchResult } from '../../src/main/requirements/requirement-match-domain'
import {
  agentRequirementMatchProjection,
  projectRequirementMatchProjection
} from '../../src/main/requirements/requirement-match-adapters'

const stageScores = {
  denseRank: 1, denseScore: 80, lexicalRank: 2, lexicalScore: 60,
  fusedRank: 1, fusedScore: 90, rerankerRank: 1, rerankerScore: 95
}
const result: RequirementMatchResult = {
  normalizationVersion: 'requirement-business-v1',
  pipelineVersion: 'requirement-matching-pipeline-v1',
  rankingVersion: 'requirement-ranking-v1-cross-encoder',
  configHash: 'fixture',
  modelVersion: 'fixture',
  degradationCodes: [],
  candidates: [
    {
      recordUid: 'a', finalRank: 1, rankingScore: 91.2,
      rankingVersion: 'requirement-ranking-v1-cross-encoder', relation: 'highly_similar',
      decisionStatus: 'suggested', evidenceLevel: 'deterministic_rule', reasonCodes: [],
      degradationCodes: [], stageScores, explanation: null
    },
    {
      recordUid: 'rejected', finalRank: 2, rankingScore: 0,
      rankingVersion: 'requirement-ranking-v1-cross-encoder', relation: 'unrelated',
      decisionStatus: 'rejected', evidenceLevel: 'deterministic_rule', reasonCodes: ['ACTION_CONFLICT'],
      degradationCodes: [], stageScores: { ...stageScores, fusedRank: 2 }, explanation: null
    }
  ]
}

assert.deepEqual(projectRequirementMatchProjection(result), agentRequirementMatchProjection(result))
assert.deepEqual(projectRequirementMatchProjection(result).map(({ recordUid, finalRank, rankingScore, relation }) => ({
  recordUid, finalRank, rankingScore, relation
})), [{ recordUid: 'a', finalRank: 1, rankingScore: 91.2, relation: 'highly_similar' }])

console.log(JSON.stringify({ ok: true, checks: ['project/agent projection parity', 'rejected default-list exclusion'] }))
