import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import type { QuerySpec } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = [
  ['2025-01-15', 10],
  ['2025-02-15', 20],
  ['2026-01-15', 15],
  ['2026-02-15', 30],
  ['2026-03-15', 5]
].map(([updatedAt, effort], index) => ({
  uid: String(index + 1),
  projectId: 'p1',
  nodeType: 'Issue',
  itemId: `I-${index + 1}`,
  name: `Issue ${index + 1}`,
  lastModifyTime: `${updatedAt}T00:00:00Z`,
  raw: { updatedAt, effort }
}))

const engine = new QueryEngine({
  scanAnalyticsRecords: () => records
} as AppDatabase)

const query: QuerySpec = {
  source: 'records',
  scope: {},
  dimensions: [{ field: 'updatedAt', timeGrain: 'month' }],
  measures: [
    { id: 'total', field: 'effort', aggregation: 'sum' },
    { id: 'yoy', field: 'effort', aggregation: 'sum', calculation: 'yoy' },
    { id: 'mom', field: 'effort', aggregation: 'sum', calculation: 'mom' },
    { id: 'share', field: 'effort', aggregation: 'sum', calculation: 'share' },
    { id: 'cumulative', field: 'effort', aggregation: 'sum', calculation: 'cumulative' }
  ]
}

const result = engine.execute(query)
assert.deepEqual(result.rows, [
  { updatedAt: '2025-01', total: 10, yoy: null, mom: null, share: 12.5, cumulative: 10 },
  { updatedAt: '2025-02', total: 20, yoy: null, mom: 100, share: 25, cumulative: 30 },
  { updatedAt: '2026-01', total: 15, yoy: 50, mom: null, share: 18.75, cumulative: 45 },
  { updatedAt: '2026-02', total: 30, yoy: 50, mom: 100, share: 37.5, cumulative: 75 },
  { updatedAt: '2026-03', total: 5, yoy: null, mom: -83.333333, share: 6.25, cumulative: 80 }
])

const invalid = engine.validate({
  source: 'records',
  scope: {},
  measures: [{ id: 'yoy', field: 'effort', aggregation: 'sum', calculation: 'yoy' }]
})
assert.ok(invalid.some((error) => error.includes('需要带时间粒度')))

const quarter = engine.execute({
  source: 'records',
  scope: {},
  dimensions: [{ field: 'updatedAt', timeGrain: 'quarter' }],
  measures: [{ id: 'mom', field: 'effort', aggregation: 'sum', calculation: 'mom' }]
})
assert.equal(quarter.rows.at(-1)?.mom, null)

console.log(JSON.stringify({ ok: true, rows: result.rows }, null, 2))
