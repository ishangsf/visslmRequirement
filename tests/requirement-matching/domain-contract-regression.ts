import { strict as assert } from 'node:assert'
import {
  MATCH_DECISION_STATUSES,
  isMatchRelation,
  isRankingScore
} from '../../src/main/requirements/requirement-match-domain'

assert.deepEqual(MATCH_DECISION_STATUSES, ['confirmed', 'suggested', 'ambiguous', 'rejected'])
assert.equal(isMatchRelation('topic_only'), true)
assert.equal(isMatchRelation('related'), false)
assert.equal(isRankingScore(0), true)
assert.equal(isRankingScore(100), true)
assert.equal(isRankingScore(101), false)
assert.equal(isRankingScore(Number.NaN), false)

console.log(JSON.stringify({ ok: true, checks: ['domain enums', 'relation validator', 'ranking score bounds'] }))
