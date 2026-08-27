import { strict as assert } from 'node:assert'
import { normalizeRequirementMatchingRolloutMode } from '../../src/shared/types'
import { resolveRequirementMatchingRollout } from '../../src/main/requirements/requirement-matching-rollout'

assert.equal(normalizeRequirementMatchingRolloutMode('invalid'), 'legacy_safe')
const shadow = resolveRequirementMatchingRollout('shadow')
assert.equal(shadow.primaryReadPath, 'legacy_safe')
assert.equal(shadow.newPipelinePersisted, true)
assert.equal(shadow.businessWriteCount, 0)
assert.equal(resolveRequirementMatchingRollout('v1_1').primaryReadPath, 'v1_1')
assert.equal(resolveRequirementMatchingRollout('legacy_safe').primaryReadPath, 'legacy_safe')
assert.equal(resolveRequirementMatchingRollout('invalid').primaryReadPath, 'legacy_safe')
console.log(JSON.stringify({ ok: true, checks: ['invalid fail-safe', 'shadow persistence', 'v1.1 cutover', 'safe rollback', 'zero business writes'] }))
