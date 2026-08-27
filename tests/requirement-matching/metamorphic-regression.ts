import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { buildMetamorphicCases } from './metamorphic-fixtures'

const fixture = JSON.parse(readFileSync('test-data/requirement-matching/v1.1/deterministic-facts.json', 'utf8')) as { cases: string[] }
const cases = buildMetamorphicCases()
assert.deepEqual(cases.map((item) => item.name), fixture.cases)
const byName = new Map(cases.map((item) => [item.name, item]))
const seed = byName.get('exact_duplicate')!
assert.equal(seed.decisionStatus, 'confirmed')
assert.equal(seed.rankingScore, 100)
assert.equal(byName.get('format_only')?.businessHash, seed.businessHash)
assert.equal(byName.get('irrelevant_padding')?.businessHash, seed.businessHash)
assert.notEqual(byName.get('action_conflict')?.businessHash, seed.businessHash)
assert.equal(byName.get('action_conflict')?.decisionStatus, 'rejected')
assert.equal(byName.get('object_conflict')?.decisionStatus, 'rejected')
assert.equal(byName.get('negation_conflict')?.decisionStatus, 'rejected')
assert.notEqual(byName.get('missing_required_field')?.decisionStatus, 'confirmed')
console.log(JSON.stringify({ ok: true, checks: fixture.cases }))
