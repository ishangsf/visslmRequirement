import assert from 'node:assert/strict'

import {
  groupRankings,
  rankingAgreement
} from '../../scripts/compare-requirement-rerankers'

const inputs = [
  { id: 'q1/a', queryId: 'q1', candidateId: 'a', query: '查询一', candidate: '候选 A' },
  { id: 'q1/b', queryId: 'q1', candidateId: 'b', query: '查询一', candidate: '候选 B' },
  { id: 'q1/c', queryId: 'q1', candidateId: 'c', query: '查询一', candidate: '候选 C' },
  { id: 'q2/d', queryId: 'q2', candidateId: 'd', query: '查询二', candidate: '候选 D' },
  { id: 'q2/e', queryId: 'q2', candidateId: 'e', query: '查询二', candidate: '候选 E' }
]

const baseRankings = groupRankings(inputs, [
  { id: 'q1/a', score: 0.1 },
  { id: 'q1/b', score: 0.9 },
  { id: 'q1/c', score: 0.5 },
  { id: 'q2/d', score: 0.8 },
  { id: 'q2/e', score: 0.2 }
])

assert.deepEqual(baseRankings, [
  { queryId: 'q1', ranking: [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.5 }, { id: 'a', score: 0.1 }] },
  { queryId: 'q2', ranking: [{ id: 'd', score: 0.8 }, { id: 'e', score: 0.2 }] }
], 'scores must be grouped and sorted inside each query')

const baseRun = {
  role: 'base' as const,
  id: 'base',
  status: 'PASS' as const,
  inputCount: inputs.length,
  iterations: 1,
  warmup: 0,
  timingsMs: { p50: 1, p95: 1, min: 1, max: 1 },
  memory: null,
  rankings: baseRankings
}
const candidateRun = {
  ...baseRun,
  role: 'candidate' as const,
  id: 'candidate',
  rankings: groupRankings(inputs, [
    { id: 'q1/a', score: 0.8 },
    { id: 'q1/b', score: 0.9 },
    { id: 'q1/c', score: 0.1 },
    { id: 'q2/d', score: 0.2 },
    { id: 'q2/e', score: 0.8 }
  ])
}
const agreement = rankingAgreement(baseRun, candidateRun)
assert.equal(agreement.comparableInputCount, 2, 'agreement must compare query groups, not individual pairs')
assert.equal(agreement.exactRankingMatchCount, 0, 'changed query rankings must not be reported as exact matches')

console.log(JSON.stringify({
  ok: true,
  checks: [
    'candidate scores grouped by queryId',
    'ranking agreement compares complete query rankings'
  ]
}))
