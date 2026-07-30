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

const expectedTop = ['华东上飞院', '北方区HT1Y12S', '华东航空118厂民机部']
const aggregateAnswer = await agent.ask({
  question: '帮我统计 Source 前3名的单位，并给出 Source 来源最多的单位是哪家？'
})

const target = db.getRecord('149356', false)
if (!target) throw new Error('真实数据中未找到用于属性问答验证的 UID 149356')
const propertyAnswer = await agent.ask({
  question: `知识库中名为“${target.name}”的记录，它的 Source 和负责人分别是什么？`
})
const expectedSource = String(target.raw.Source ?? '')
const expectedAssignee = String(target.raw._valm_AssignedTo ?? '')
const expectedPerformance = db.queryRecordsByFields({
  search: '性能',
  filters: [{ field: 'IssueType', operator: 'equals', value: 'Requirement' }],
  fields: ['IssueType', 'Source'],
  limit: 50
})
const performanceAnswer = await agent.ask({
  question: '和性能相关的需求有多少？',
  history: [
    { role: 'user', content: '来源最多的是哪家单位？' },
    { role: 'assistant', content: '来源最多的是华东上飞院，共有 191 条记录。' }
  ]
})
const relatedListAnswer = await agent.ask({
  question: '列出所有与中电10所相关的数据'
})

const aggregatePassed =
  expectedTop.every((name) => aggregateAnswer.answer.includes(name)) &&
  !aggregateAnswer.answer.includes('TSIssue 4103')
const propertyPassed =
  Boolean(expectedSource) &&
  Boolean(expectedAssignee) &&
  expectedSource
    .split(/[，,；;\n\r、|]+/)
    .filter(Boolean)
    .every((value) => propertyAnswer.answer.includes(value.trim())) &&
  propertyAnswer.answer.includes(expectedAssignee) &&
  propertyAnswer.answer.includes(`[UID:${target.uid}]`) &&
  propertyAnswer.sources.some((source) => source.uid === target.uid)
const performancePassed =
  Boolean(performanceAnswer.dataViews[0]?.total) &&
  performanceAnswer.answer.includes(String(performanceAnswer.dataViews[0]?.total)) &&
  !performanceAnswer.answer.includes('4103') &&
  !performanceAnswer.answer.includes('华东上飞院') &&
  performanceAnswer.dataViews.some(
    (view) =>
      view.total === expectedPerformance.matchedCount &&
      view.groups.some((group) => group.rows.length > 0)
  )
const relatedListView = relatedListAnswer.dataViews[0]
const relatedListRows = relatedListView?.groups.flatMap((group) => group.rows) ?? []
const relatedListPassed =
  Boolean(relatedListView?.total) &&
  relatedListAnswer.answer.includes(String(relatedListView?.total)) &&
  relatedListRows
    .slice(0, 3)
    .every((record) => relatedListAnswer.answer.includes(record.name)) &&
  !relatedListAnswer.answer.includes('_valm_') &&
  !relatedListAnswer.answer.includes('<p>') &&
  !relatedListAnswer.answer.includes('Record: [')

console.log(JSON.stringify({
  passed: aggregatePassed && propertyPassed && performancePassed && relatedListPassed,
  expected: {
    targetUid: target.uid,
    targetName: target.name,
    source: expectedSource,
    assignee: expectedAssignee
  },
  aggregatePassed,
  aggregateAnswer: aggregateAnswer.answer,
  aggregateDataView: aggregateAnswer.dataViews.map((view) => ({
    title: view.title,
    total: view.total,
    groups: view.groups.map((group) => ({
      name: group.name,
      count: group.count,
      displayed: group.rows.length
    }))
  })),
  propertyPassed,
  propertyAnswer: propertyAnswer.answer,
  propertyDataView: propertyAnswer.dataViews.map((view) => ({
    total: view.total,
    fields: view.fields,
    rows: view.groups.flatMap((group) => group.rows)
  })),
  expectedPerformanceCount: expectedPerformance.matchedCount,
  performancePassed,
  performanceAnswer: performanceAnswer.answer,
  performanceDataView: performanceAnswer.dataViews.map((view) => ({
    title: view.title,
    total: view.total,
    displayed: view.groups.reduce((sum, group) => sum + group.rows.length, 0)
  })),
  expectedRelatedCount: relatedListView?.total,
  relatedListPassed,
  relatedListAnswer: relatedListAnswer.answer,
  relatedListDataView: relatedListAnswer.dataViews.map((view) => ({
    title: view.title,
    total: view.total,
    displayed: view.groups.reduce((sum, group) => sum + group.rows.length, 0)
  }))
}, null, 2))

db.close()
if (!aggregatePassed || !propertyPassed || !performancePassed || !relatedListPassed) {
  process.exitCode = 1
}
