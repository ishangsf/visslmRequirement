import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import type { DataScope, QueryDataset, QuerySpec } from '../src/shared/query-spec'

const recordCount = 50_000
const records: AnalyticsRecord[] = Array.from({ length: recordCount }, (_, index) => {
  const day = (index % 180) + 1
  const month = Math.floor((day - 1) / 30) + 1
  const date = `2026-${String(month).padStart(2, '0')}-${String(((day - 1) % 30) + 1).padStart(2, '0')}`
  return {
    uid: `perf-${index}`,
    projectId: `project-${index % 8}`,
    nodeType: index % 2 ? 'Issue' : 'Task',
    itemId: `ITEM-${index}`,
    name: `脱敏记录 ${index}`,
    lastModifyTime: `${date}T10:00:00Z`,
    raw: {
      status: ['open', 'closed', 'in-progress', 'blocked'][index % 4],
      updatedAt: `${date}T10:00:00Z`,
      estimate: (index % 17) + 1
    }
  }
})

const db = {
  scanAnalyticsRecords(scope: DataScope): AnalyticsRecord[] {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType))
    )
  }
} as AppDatabase

const query: QuerySpec = {
  source: 'records',
  scope: {},
  dimensions: [
    { field: 'updatedAt', timeGrain: 'week' },
    { field: 'status' }
  ],
  measures: [
    { id: 'records', aggregation: 'count' },
    { id: 'effort', field: 'estimate', aggregation: 'sum' }
  ],
  filters: [{ field: 'status', operator: 'in', value: ['open', 'in-progress'] }],
  sort: [{ field: 'records', direction: 'desc' }],
  limit: 500
}

const engine = new QueryEngine(db)
const timings: number[] = []
for (let index = 0; index < 20; index += 1) {
  const started = performance.now()
  const dataset = engine.execute(query)
  const elapsed = performance.now() - started
  assert.ok(dataset.rows.length > 0, '性能门禁查询不应返回空数据')
  assert.ok(dataset.scannedRows === recordCount, '性能门禁必须覆盖 5 万条记录')
  timings.push(elapsed)
}

const sorted = [...timings].sort((left, right) => left - right)
const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
assert.ok(p95 < 2_000, `5 万条记录查询 P95 ${p95.toFixed(2)} ms 超过 2 秒门禁`)

type CacheDb = AppDatabase & {
  getFieldProfiles: (key: string, revision: number) => ReturnType<QueryEngine['profile']> | null
  saveFieldProfiles: (key: string, revision: number, profiles: ReturnType<QueryEngine['profile']>) => void
  getQueryCache: (key: string, revision: number) => QueryDataset | null
  saveQueryCache: (key: string, revision: number, dataset: QueryDataset) => void
}
const fieldCache = new Map<string, ReturnType<QueryEngine['profile']>>()
const resultCache = new Map<string, QueryDataset>()
const cachedDb = {
  scanAnalyticsRecords: db.scanAnalyticsRecords,
  getAnalyticsRevision: () => 1,
  getFieldProfiles: (key: string) => fieldCache.get(key) ?? null,
  saveFieldProfiles: (key: string, _revision: number, profiles: ReturnType<QueryEngine['profile']>) => {
    fieldCache.set(key, profiles)
  },
  getQueryCache: (key: string) => resultCache.get(key) ?? null,
  saveQueryCache: (key: string, _revision: number, dataset: QueryDataset) => {
    resultCache.set(key, dataset)
  }
} as CacheDb
const cachedEngine = new QueryEngine(cachedDb)
cachedEngine.execute(query)
const warmStarted = performance.now()
cachedEngine.execute(query)
const warmElapsed = performance.now() - warmStarted
assert.ok(warmElapsed < p95, '查询缓存命中后应快于冷查询 P95')

console.log(JSON.stringify({
  ok: true,
  recordCount,
  runs: timings.length,
  p95Ms: Number(p95.toFixed(2)),
  minMs: Number(Math.min(...timings).toFixed(2)),
  maxMs: Number(Math.max(...timings).toFixed(2)),
  warmCacheMs: Number(warmElapsed.toFixed(2))
}, null, 2))
