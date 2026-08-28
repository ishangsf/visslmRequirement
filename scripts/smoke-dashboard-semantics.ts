import { strict as assert } from 'node:assert'
import type {
  DashboardAnalysisBlueprint,
  DashboardComponentSpec,
  DashboardSpec
} from '../src/shared/dashboard'
import {
  automaticDashboardComponentTitle,
  validateDashboardSemanticConsistency
} from '../src/shared/dashboard-semantics'

const blueprint: DashboardAnalysisBlueprint = {
  version: '1.0',
  request: '观察研发质量趋势与缺陷总量',
  audience: '项目经理',
  objective: '跟踪缺陷规模和周趋势',
  scopeDescription: '脱敏项目的 Issue 数据',
  metrics: [
    {
      id: 'issueCount',
      label: '缺陷',
      measureId: 'records',
      aggregation: 'count',
      source: 'catalog',
      confidence: 1
    },
    {
      id: 'effortTotal',
      label: '投入工时',
      measureId: 'effort',
      field: 'effort',
      aggregation: 'sum',
      unit: '小时',
      source: 'catalog',
      confidence: 1
    }
  ],
  questions: [
    {
      id: 'q-total',
      question: '当前有多少缺陷？',
      metricIds: ['issueCount'],
      dimensionFields: [],
      preferredComponentTypes: ['kpi'],
      slotRole: 'headline',
      priority: 1,
      required: true
    },
    {
      id: 'q-trend',
      question: '缺陷数量如何变化？',
      metricIds: ['issueCount'],
      dimensionFields: ['updatedAt'],
      timeGrain: 'week',
      preferredComponentTypes: ['line'],
      slotRole: 'trend',
      priority: 2,
      required: true
    }
  ],
  assumptions: [],
  unresolvedAmbiguities: [],
  generatedAt: '2026-08-27T00:00:00.000Z'
}

const totalTitle = automaticDashboardComponentTitle(blueprint, {
  type: 'kpi',
  semanticBinding: {
    questionId: 'q-total',
    metricIds: ['issueCount'],
    dimensionFields: [],
    titleMode: 'auto',
    confidence: 1
  }
})
const trendTitle = automaticDashboardComponentTitle(blueprint, {
  type: 'line',
  semanticBinding: {
    questionId: 'q-trend',
    metricIds: ['issueCount'],
    dimensionFields: ['updatedAt'],
    titleMode: 'auto',
    confidence: 1
  }
})

const total: DashboardComponentSpec = {
  id: 'total',
  type: 'kpi',
  title: totalTitle,
  layout: { x: 0, y: 0, w: 6, h: 2 },
  data: [{ name: totalTitle, value: 12 }],
  query: {
    source: 'records',
    scope: { projectIds: ['p1'] },
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { value: 'records' },
  semanticBinding: {
    questionId: 'q-total',
    metricIds: ['issueCount'],
    dimensionFields: [],
    titleMode: 'auto',
    confidence: 1
  },
  slotRole: 'headline'
}

const trend: DashboardComponentSpec = {
  id: 'trend',
  type: 'line',
  title: trendTitle,
  layout: { x: 6, y: 0, w: 18, h: 5 },
  data: [{ name: '2026-08-24', value: 3 }],
  query: {
    source: 'records',
    scope: { projectIds: ['p1'] },
    dimensions: [{ field: 'updatedAt', timeGrain: 'week' }],
    measures: [{ id: 'records', aggregation: 'count' }]
  },
  encoding: { label: 'updatedAt', value: 'records' },
  semanticBinding: {
    questionId: 'q-trend',
    metricIds: ['issueCount'],
    dimensionFields: ['updatedAt'],
    titleMode: 'auto',
    confidence: 1
  },
  slotRole: 'trend'
}

const base: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'semantic-smoke',
  title: '研发质量驾驶舱',
  subtitle: '语义契约 smoke',
  theme: 'technology-dark',
  updatedAt: blueprint.generatedAt,
  analysisBlueprint: blueprint,
  components: [total, trend]
}

const codes = (spec: DashboardSpec): string[] =>
  validateDashboardSemanticConsistency(spec).map((issue) => issue.code)

assert.deepEqual(codes(base), [], '合法 blueprint 与绑定必须零语义错误')
assert.equal(totalTitle, '缺陷数量')
assert.equal(trendTitle, '更新时间 · 缺陷数量趋势')

const clone = (spec: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(spec)) as DashboardSpec

const unknownMetric = clone(base)
unknownMetric.components[0].semanticBinding!.metricIds = ['missing-metric']
assert.ok(codes(unknownMetric).includes('unknown-metric'))

const unknownQuestion = clone(base)
unknownQuestion.components[0].semanticBinding!.questionId = 'missing-question'
assert.ok(codes(unknownQuestion).includes('unknown-question'))

const questionMetricMismatch = clone(base)
questionMetricMismatch.components[0].semanticBinding!.metricIds = []
assert.ok(codes(questionMetricMismatch).includes('missing-bound-metric'))
assert.ok(codes(questionMetricMismatch).includes('question-metric-mismatch'))

const twoMetricQuestionUnderbound = clone(base)
twoMetricQuestionUnderbound.analysisBlueprint!.questions[1].metricIds = ['issueCount', 'effortTotal']
assert.ok(codes(twoMetricQuestionUnderbound).includes('question-metric-mismatch'),
  '双指标问题少绑定一个指标必须拒绝')

const unboundQueryMeasure = clone(base)
unboundQueryMeasure.components[1].query!.measures.push({
  id: 'effort',
  field: 'effort',
  aggregation: 'sum'
})
assert.ok(codes(unboundQueryMeasure).includes('unbound-query-measure'),
  'QuerySpec 中未绑定的 measure 必须拒绝')

const questionDimensionMismatch = clone(base)
questionDimensionMismatch.components[0].semanticBinding!.dimensionFields = ['status']
assert.ok(codes(questionDimensionMismatch).includes('question-dimension-mismatch'))

const questionSlotMismatch = clone(base)
questionSlotMismatch.components[0].slotRole = 'trend'
assert.ok(codes(questionSlotMismatch).includes('question-slot-mismatch'))

const questionComponentTypeMismatch = clone(base)
questionComponentTypeMismatch.components[0].type = 'bar'
assert.ok(codes(questionComponentTypeMismatch).includes('question-component-type-mismatch'))

const mismatchedQuery = clone(base)
mismatchedQuery.components[0].query!.measures = [{
  id: 'records',
  field: 'effort',
  aggregation: 'sum'
}]
assert.ok(codes(mismatchedQuery).includes('metric-definition-mismatch'))

const mismatchedDimension = clone(base)
mismatchedDimension.components[1].query!.dimensions = [{ field: 'createdAt', timeGrain: 'week' }]
assert.ok(codes(mismatchedDimension).includes('dimension-query-mismatch'))

const mismatchedTimeGrain = clone(base)
mismatchedTimeGrain.components[1].query!.dimensions = [{ field: 'updatedAt', timeGrain: 'month' }]
assert.ok(codes(mismatchedTimeGrain).includes('question-time-grain-mismatch'))

const mismatchedAutoTitle = clone(base)
mismatchedAutoTitle.components[0].title = '总量'
assert.ok(codes(mismatchedAutoTitle).includes('automatic-title-mismatch'))

const unanswered = clone(base)
unanswered.components = [unanswered.components[0]]
assert.ok(codes(unanswered).includes('unanswered-required-question'))

const legacy = clone(base)
delete legacy.analysisBlueprint
assert.deepEqual(
  validateDashboardSemanticConsistency(legacy),
  [],
  'legacy v1 无 blueprint 时必须保持兼容'
)

console.log(JSON.stringify({
  ok: true,
  blueprintVersion: blueprint.version,
  components: base.components.length,
  automaticTitles: { total: totalTitle, trend: trendTitle },
  negativeCases: [
    'unknown-metric',
    'unknown-question',
    'missing-bound-metric',
    'question-metric-mismatch',
    'unbound-query-measure',
    'question-dimension-mismatch',
    'question-slot-mismatch',
    'question-component-type-mismatch',
    'metric-definition-mismatch',
    'dimension-query-mismatch',
    'question-time-grain-mismatch',
    'automatic-title-mismatch',
    'unanswered-required-question'
  ],
  legacyCompatible: true
}, null, 2))
