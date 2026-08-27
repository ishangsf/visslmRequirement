import { strict as assert } from 'node:assert'
import {
  extractRequirementBusinessFacts,
  hashRequirementBusinessText,
  REQUIREMENT_NORMALIZATION_VERSION
} from '../../src/main/requirements/requirement-business-normalization'

assert.equal(REQUIREMENT_NORMALIZATION_VERSION, 'requirement-business-v1')
assert.equal(hashRequirementBusinessText('<p>查询 订单</p>'), hashRequirementBusinessText('查询订单'))
assert.notEqual(hashRequirementBusinessText('查询订单'), hashRequirementBusinessText('删除订单'))
assert.notEqual(hashRequirementBusinessText('允许导出'), hashRequirementBusinessText('禁止导出'))
assert.notEqual(hashRequirementBusinessText('响应时间 2 秒'), hashRequirementBusinessText('响应时间 5 秒'))

assert.deepEqual(extractRequirementBusinessFacts('查询订单详情'), {
  action: '查询', object: '订单详情', constraints: [], negated: false, source: 'deterministic'
})
assert.equal(extractRequirementBusinessFacts('不得删除订单').negated, true)
assert.equal(extractRequirementBusinessFacts('系统能力说明').source, 'missing')

console.log(JSON.stringify({ ok: true, checks: ['format invariance', 'semantic hash changes', 'deterministic facts'] }))
