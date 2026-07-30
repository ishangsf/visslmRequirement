import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { OllamaAgent } from '../src/main/ollama'

const base = join(process.env.APPDATA ?? '', 'visslm-agent-desktop')
const db = new AppDatabase(
  join(base, 'visslm-agent.db'),
  join(base, 'assets', 'base64')
)
const agent = new OllamaAgent(db, {
  baseUrl: db.getSetting('model.baseUrl') ?? 'http://127.0.0.1:11434',
  model: db.getSetting('model.model') ?? 'qwen3:8b',
  thinking: false
})

const greeting = await agent.ask({ question: '你好' })
const greetingPassed =
  greeting.dataViews.length === 0 &&
  greeting.sources.length === 0 &&
  greeting.answer.length > 0 &&
  !greeting.answer.includes('4103') &&
  !greeting.answer.includes('record_count')

const advice = await agent.ask({ question: '如何写好一条软件需求？' })
const advicePassed =
  advice.dataViews.length === 0 &&
  advice.sources.length === 0 &&
  advice.answer.length > 80 &&
  !advice.answer.includes('4103') &&
  !advice.answer.includes('record_count')

const expectedSources = db.aggregateByField({
  field: 'Source',
  limit: 10,
  splitMultiValue: true
})
const sourceValues = await agent.ask({
  question: '数据中来源属性都有哪些单位？'
})
const sourceValuesPassed =
  sourceValues.dataViews.some((view) => view.title === 'Source 查询数据') &&
  expectedSources.items
    .slice(0, 3)
    .every((item) => sourceValues.answer.includes(item.name)) &&
  !sourceValues.answer.includes('与“Source”相关的记录')

const analysis = await agent.ask({
  question: '请根据与性能相关的需求，总结主要问题和改进建议'
})
const analysisPassed =
  analysis.dataViews.some((view) => view.total > 0) &&
  analysis.sources.length > 0 &&
  analysis.answer.length > 80 &&
  !analysis.answer.startsWith('共找到') &&
  !analysis.answer.includes('_valm_') &&
  !analysis.answer.includes('<p>')

console.log(JSON.stringify({
  passed: greetingPassed && advicePassed && sourceValuesPassed && analysisPassed,
  greetingPassed,
  greetingAnswer: greeting.answer,
  greetingDataViews: greeting.dataViews.length,
  advicePassed,
  adviceAnswer: advice.answer,
  adviceDataViews: advice.dataViews.length,
  sourceValuesPassed,
  sourceValuesAnswer: sourceValues.answer,
  sourceValuesDataViews: sourceValues.dataViews.map((view) => ({
    title: view.title,
    total: view.total,
    groups: view.groups.length
  })),
  analysisPassed,
  analysisAnswer: analysis.answer,
  analysisDataViews: analysis.dataViews.map((view) => ({
    title: view.title,
    total: view.total,
    displayed: view.groups.reduce((sum, group) => sum + group.rows.length, 0)
  }))
}, null, 2))

db.close()
if (!greetingPassed || !advicePassed || !sourceValuesPassed || !analysisPassed) {
  process.exitCode = 1
}
