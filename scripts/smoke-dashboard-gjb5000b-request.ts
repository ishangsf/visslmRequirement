import { strict as assert } from 'node:assert'
import type { DataScope } from '../src/shared/query-spec'
import { resolveDashboardDomainRequest } from '../src/main/experts/dashboard-domain-request'

type RequestScope = DataScope

type DomainRequestResult = {
  recognized: boolean
  role?: 'project-owner'
  scenario?: string
  scenarioStatus?: 'active' | 'planned'
  tailoringBaselineId?: string
  permissions?: readonly string[]
  provenance?: { source: string }
  request: string
  scope: RequestScope
}

const resolve = resolveDashboardDomainRequest as unknown as (
  question: string,
  scope: RequestScope
) => DomainRequestResult

const scope: RequestScope = { projectIds: ['sample-project-001'] }
const preserveInput = (question: string, result: DomainRequestResult): void => {
  assert.equal(result.request, question, '领域请求不得改写原始 question')
  assert.deepEqual(result.scope, scope, '领域请求不得扩大或改写 scope')
}

const controlledQuestion = '项目负责人基于受控样例生成项目综合态势大屏'
const controlled = resolve(controlledQuestion, scope)
preserveInput(controlledQuestion, controlled)
assert.equal(controlled.recognized, true)
assert.equal(controlled.role, 'project-owner')
assert.equal(controlled.scenario, 'project-overview')
assert.equal(controlled.scenarioStatus, 'active')
assert.equal(controlled.tailoringBaselineId, 'sample-tailoring-baseline-v1')
assert.ok(controlled.permissions?.includes('project:read'))
assert.ok(controlled.permissions?.includes('process:evidence:read'))
assert.equal(controlled.provenance?.source, 'local-single-user-policy',
  '单机权限映射必须标明 local-single-user-policy，不得伪装 RBAC')
assert.ok(!JSON.stringify(controlled).toLocaleLowerCase().includes('rbac'))

const roleAmbiguousQuestion = '生成项目综合态势大屏'
const roleAmbiguous = resolve(roleAmbiguousQuestion, scope)
preserveInput(roleAmbiguousQuestion, roleAmbiguous)
assert.equal(roleAmbiguous.recognized, true)
assert.equal(roleAmbiguous.role, undefined,
  '未明确项目负责人时不得暗猜角色，应交由 planner 追问')

const baselineAmbiguousQuestion = '项目负责人生成项目综合态势大屏'
const baselineAmbiguous = resolve(baselineAmbiguousQuestion, scope)
preserveInput(baselineAmbiguousQuestion, baselineAmbiguous)
assert.equal(baselineAmbiguous.recognized, true)
assert.equal(baselineAmbiguous.role, 'project-owner')
assert.equal(baselineAmbiguous.scenario, 'project-overview')
assert.equal(baselineAmbiguous.tailoringBaselineId, undefined,
  '未声明受控样例时不得静默套用 sample baseline')

const genericQuestion = '生成销售大屏，关注销售额和客户转化率'
const generic = resolve(genericQuestion, scope)
preserveInput(genericQuestion, generic)
assert.equal(generic.recognized, false, '泛经营请求必须继续走通用可视化链路')
assert.equal(generic.role, undefined)
assert.equal(generic.scenario, undefined)
assert.equal(generic.tailoringBaselineId, undefined)

const plannedKeywordCases: Array<{ question: string; scenario: string }> = [
  { question: 'QA/EPG 生成 GJB5000B 过程证据符合度大屏', scenario: 'gjb5000b-compliance' },
  { question: '型号组织管理负责人生成组织改进大屏', scenario: 'organization-improvement' }
]
for (const item of plannedKeywordCases) {
  const result = resolve(item.question, scope)
  preserveInput(item.question, result)
  assert.equal(result.recognized, true, `${item.question} 必须识别为领域请求`)
  assert.equal(result.scenario, item.scenario)
  assert.equal(result.scenarioStatus, 'planned',
    `${item.scenario} 只能识别 planned，不得在请求解析阶段激活`)
  assert.notEqual(result.scenarioStatus, 'active')
  assert.notEqual((result as unknown as { status?: string }).status, 'ready')
}

console.log(JSON.stringify({
  ok: true,
  controlled: {
    recognized: controlled.recognized,
    role: controlled.role,
    scenario: controlled.scenario,
    tailoringBaselineId: controlled.tailoringBaselineId,
    permissions: controlled.permissions,
    provenance: controlled.provenance
  },
  roleAmbiguous: { recognized: roleAmbiguous.recognized, role: roleAmbiguous.role },
  baselineAmbiguous: {
    recognized: baselineAmbiguous.recognized,
    role: baselineAmbiguous.role,
    tailoringBaselineId: baselineAmbiguous.tailoringBaselineId
  },
  generic: { recognized: generic.recognized },
  planned: plannedKeywordCases.map(({ question, scenario }) => ({
    question,
    scenario,
    status: resolve(question, scope).scenarioStatus
  }))
}, null, 2))
