import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/renderer/src/project-management/ProjectManagementPage.tsx'), 'utf8')
assert.match(source, /综合匹配分/)
assert.match(source, /当前算法版本内的相对匹配程度，不代表统计概率/)
assert.match(source, /finalRank/)
assert.match(source, /decisionStatus/)
assert.match(source, /degradationCodes/)
assert.match(source, /project-requirement-match-runs:v2/)
assert.match(source, /匹配判断/)
assert.match(source, /判断依据/)
assert.match(source, /需人工确认/)
assert.match(source, /关键信息不完整，暂无法确认/)
assert.match(source, /业务模式相似/)
assert.match(source, /仅初步召回/)
assert.match(source, /clamp\(280px, calc\(100vh - 360px\), 620px\)/)
assert.doesNotMatch(source, /匹配度\s*&gt;/)
assert.doesNotMatch(source.slice(source.indexOf('function MatchDrawer'), source.indexOf('type OrganizationPeopleColumnKey')), /minScore/)
console.log(JSON.stringify({ ok: true, checks: ['ranked score copy', 'run metadata', 'business-readable decision/evidence', 'versioned widths', 'responsive scroll'] }))
