import { strict as assert } from 'node:assert'
import { extractRequirementBusinessFacts } from '../../src/main/requirements/requirement-business-normalization'
import { requirementLexicalTermsOf, type RequirementMatchCard } from '../../src/main/requirements/requirement-match-card'
import { buildDeterministicRequirementMatchAnalysis } from '../../src/main/requirements/requirement-match-analysis'

const card = (title: string, description: string): RequirementMatchCard => ({
  artifactType: 'requirement',
  requirementType: '功能需求',
  productDomain: '',
  module: '',
  sourceTitle: title,
  sourceDescription: description,
  evidence: `${title}\n${description}`,
  matchingText: `${title}\n${description}`,
  lexicalTerms: requirementLexicalTermsOf([title, description]),
  businessFacts: extractRequirementBusinessFacts(`${description}\n${title}`)
})

const base = card('覆盖 GJB5000B 四级实践域', '系统功能应覆盖 GJB5000B 四级用软件体系文件要求。')
const modelCandidate = card('GJB5000B 四级模型预测功能', '通过历史数据预测 GJB5000B 四级模型结果。')
const tipsCandidate = card('各页面 tips 功能', '各页面提供 tips 提示信息。')

const modelAnalysis = buildDeterministicRequirementMatchAnalysis(base, modelCandidate)
assert.match(modelAnalysis.similarities.join('；'), /GJB5000B|四级/)
assert.match(modelAnalysis.differences.join('；'), /动作|覆盖|候选未体现/)

const tipsAnalysis = buildDeterministicRequirementMatchAnalysis(base, tipsCandidate)
assert.match(tipsAnalysis.similarities.join('；'), /未发现可核验/)
assert.match(tipsAnalysis.differences.join('；'), /GJB5000B|四级实践域|动作/)
assert.equal(tipsAnalysis.similarities.some((item) => item.includes(tipsCandidate.sourceDescription)), false)
assert.equal(tipsAnalysis.differences.some((item) => item.includes(tipsCandidate.sourceDescription)), false)

const sameAction = buildDeterministicRequirementMatchAnalysis(
  card('查询订单', '支持查询订单详情。'),
  card('历史订单查询', '查询订单详情及状态。')
)
assert.match(sameAction.similarities.join('；'), /动作均为“查询”/)

console.log(JSON.stringify({
  ok: true,
  checks: ['GJB candidate comparison', 'tips false-positive explanation', 'raw description is not analysis', 'same-action evidence']
}))
