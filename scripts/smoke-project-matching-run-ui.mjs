import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/renderer/src/project-management/ProjectManagementPage.tsx'), 'utf8')
assert.match(source, /综合匹配分/)
assert.match(source, /当前算法版本内的相对匹配程度，不代表统计概率/)
assert.match(source, /finalRank/)
assert.match(source, /decisionStatus/)
assert.match(source, /degradationCodes/)
assert.match(source, /project-requirement-match-runs:v1/)
assert.match(source, /clamp\(280px, calc\(100vh - 360px\), 620px\)/)
assert.doesNotMatch(source, /匹配度\s*&gt;/)
assert.doesNotMatch(source.slice(source.indexOf('function MatchDrawer'), source.indexOf('type OrganizationPeopleColumnKey')), /minScore/)
console.log(JSON.stringify({ ok: true, checks: ['ranked score copy', 'run metadata', 'decision/degradation evidence', 'versioned widths', 'responsive scroll'] }))
