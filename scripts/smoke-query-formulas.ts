import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import type { QuerySpec } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = [
  ['2026-01-15', 10, 20],
  ['2026-02-15', 20, 25],
  ['2026-03-15', 30, 30],
  ['2026-04-15', 40, 40]
].map(([updatedAt, completed, planned], index) => ({
  uid: String(index + 1),
  projectId: 'p1',
  nodeType: 'Issue',
  itemId: `I-${index + 1}`,
  name: `Issue ${index + 1}`,
  lastModifyTime: `${updatedAt}T00:00:00Z`,
  raw: { updatedAt, completed, planned }
}))

const engine = new QueryEngine({
  scanAnalyticsRecords: () => records
} as AppDatabase)

const query: QuerySpec = {
  source: 'records',
  scope: {},
  dimensions: [{ field: 'updatedAt', timeGrain: 'month' }],
  measures: [
    { id: 'completed', field: 'completed', aggregation: 'sum' },
    { id: 'planned', field: 'planned', aggregation: 'sum' },
    {
      id: 'completionRate',
      aggregation: 'sum',
      formula: 'completed / planned * 100'
    },
    {
      id: 'halfRate',
      aggregation: 'sum',
      formula: 'completionRate / 2'
    },
    {
      id: 'twoMonthDelta',
      field: 'completed',
      aggregation: 'sum',
      comparison: { offset: 2, mode: 'difference' }
    }
  ]
}

const result = engine.execute(query)
assert.deepEqual(result.rows.map((row) => ({
  month: row.updatedAt,
  rate: row.completionRate,
  halfRate: row.halfRate,
  delta: row.twoMonthDelta
})), [
  { month: '2026-01', rate: 50, halfRate: 25, delta: null },
  { month: '2026-02', rate: 80, halfRate: 40, delta: null },
  { month: '2026-03', rate: 100, halfRate: 50, delta: 20 },
  { month: '2026-04', rate: 100, halfRate: 50, delta: 20 }
])

const missingReference = engine.validate({
  source: 'records',
  scope: {},
  measures: [{ id: 'rate', aggregation: 'sum', formula: 'completed / missing' }]
})
assert.ok(missingReference.some((error) => error.includes('不存在的指标')))

const invalidOffset = engine.validate({
  source: 'records',
  scope: {},
  dimensions: [{ field: 'updatedAt', timeGrain: 'month' }],
  measures: [{
    id: 'delta',
    field: 'completed',
    aggregation: 'sum',
    comparison: { offset: 25, mode: 'difference' }
  }]
})
assert.ok(invalidOffset.some((error) => error.includes('offset')))

console.log(JSON.stringify({
  ok: true,
  rows: result.rows,
  checks: ['multi-period-comparison', 'safe-formula', 'formula-reference-validation']
}, null, 2))
