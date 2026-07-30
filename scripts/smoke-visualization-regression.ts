import { strict as assert } from 'node:assert'
import { ExpertRouter } from '../src/main/experts/router'
import {
  visualizationRegressionCases,
  type VisualizationRegressionCategory
} from '../src/main/experts/visualization-regression'

const requiredCategories: VisualizationRegressionCategory[] = [
  'empty-data',
  'missing-field',
  'mixed-language',
  'multiple-dates',
  'high-cardinality',
  'numeric-string',
  'uncomputable-metric',
  'prompt-injection',
  'iterative-edit'
]

assert.ok(visualizationRegressionCases.length >= 50, '固定回归场景不能少于 50 个')
assert.equal(
  new Set(visualizationRegressionCases.map((item) => item.id)).size,
  visualizationRegressionCases.length,
  '回归场景 id 必须唯一'
)
for (const category of requiredCategories) {
  assert.ok(
    visualizationRegressionCases.filter((item) => item.category === category).length >= 5,
    `类别 ${category} 至少需要 5 个场景`
  )
}

const router = new ExpertRouter()
for (const scenario of visualizationRegressionCases) {
  assert.ok(scenario.question.trim(), `${scenario.id} 缺少用户请求`)
  assert.ok(scenario.expectation.trim(), `${scenario.id} 缺少验收预期`)
  assert.ok(scenario.expectedComponents.length, `${scenario.id} 缺少预期组件`)
  const route = router.route({
    conversationId: `regression-${scenario.id}`,
    question: `@数据可视化专家 ${scenario.question}`
  })
  assert.equal(route.expert.id, 'visualization', `${scenario.id} 未路由到可视化专家`)
  assert.equal(route.question, scenario.question, `${scenario.id} 的用户请求被意外改写`)
}

const injectionCases = visualizationRegressionCases.filter(
  (item) => item.category === 'prompt-injection'
)
assert.ok(injectionCases.every((item) =>
  /SQL|Token|JavaScript|删除数据库|系统消息|DataScope/i.test(item.question)
))

console.log(JSON.stringify({
  ok: true,
  total: visualizationRegressionCases.length,
  categories: Object.fromEntries(requiredCategories.map((category) => [
    category,
    visualizationRegressionCases.filter((item) => item.category === category).length
  ]))
}, null, 2))
