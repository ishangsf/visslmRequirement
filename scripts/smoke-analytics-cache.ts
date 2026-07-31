import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { AppDatabase } from '../src/main/database'
import type { DataScope, QuerySpec } from '../src/shared/query-spec'

const directory = mkdtempSync(join(tmpdir(), 'visslm-analytics-cache-'))
const realDb = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))
let scanCount = 0
const db = {
  scanAnalyticsRecords(scope: DataScope) {
    scanCount += 1
    return realDb.scanAnalyticsRecords(scope)
  },
  getAnalyticsRevision: realDb.getAnalyticsRevision.bind(realDb),
  getFieldProfiles: realDb.getFieldProfiles.bind(realDb),
  saveFieldProfiles: realDb.saveFieldProfiles.bind(realDb),
  updateFieldProfileSemantics: realDb.updateFieldProfileSemantics.bind(realDb),
  getQueryCache: realDb.getQueryCache.bind(realDb),
  saveQueryCache: realDb.saveQueryCache.bind(realDb)
}

const scope: DataScope = { projectIds: ['project-1'] }
const query: QuerySpec = {
  source: 'records',
  scope,
  dimensions: [{ field: 'status' }],
  measures: [{ id: 'records', aggregation: 'count' }],
  sort: [{ field: 'records', direction: 'desc' }]
}

try {
  realDb.upsertRecord({
    uid: 'issue-1',
    projectId: 'project-1',
    nodeType: 'Issue',
    itemId: 'ISSUE-1',
    parentId: '',
    name: 'Issue 1',
    lastModifyTime: '2026-07-01T00:00:00Z',
    raw: {
      status: 'Open', effort: 3, updatedAt: '2026-07-01T00:00:00Z',
      tags: ['frontend', 'urgent'], meta: { source: 'imported' }, owner_email: 'masked@example.test'
    },
    normalizedText: 'Issue 1 Open'
  })
  realDb.bumpAnalyticsRevision()

  const firstEngine = new QueryEngine(db)
  const first = firstEngine.execute(query)
  assert.deepEqual(first.rows, [{ status: 'Open', records: 1 }])
  assert.equal(scanCount, 2, '第一次查询应扫描一次画像和一次结果')

  const second = new QueryEngine(db).execute(query)
  assert.deepEqual(second.rows, first.rows)
  assert.equal(scanCount, 2, '第二次查询应命中持久化结果缓存')
  const reordered = new QueryEngine(db).execute({
    measures: query.measures,
    dimensions: query.dimensions,
    scope: { projectIds: ['project-1'] },
    source: 'records',
    sort: query.sort
  })
  assert.deepEqual(reordered.rows, first.rows)
  assert.equal(scanCount, 2, 'QuerySpec 字段顺序变化不应破坏缓存命中')

  const profile = firstEngine.profile(scope).find((item) => item.field === 'status')
  assert.equal(profile?.role, 'dimension')
  assert.equal(profile?.inferredType, 'enum')
  assert.equal(firstEngine.profile(scope).find((item) => item.field === 'tags')?.inferredType, 'array')
  assert.equal(firstEngine.profile(scope).find((item) => item.field === 'meta')?.inferredType, 'object')
  assert.equal(firstEngine.profile(scope).find((item) => item.field === 'owner_email')?.sensitivity, 'sensitive')
  const updated = firstEngine.updateFieldProfileSemantics(scope, 'status', {
    displayName: '状态',
    role: 'dimension',
    synonyms: ['状态', '进度', '状态'],
    sensitivity: 'internal'
  })
  assert.equal(updated.displayName, '状态')
  assert.deepEqual(updated.synonyms, ['状态', '进度'])
  assert.equal(updated.sensitivity, 'internal')
  assert.equal(new QueryEngine(db).profile(scope).find((item) => item.field === 'status')?.displayName, '状态')

  realDb.upsertRecord({
    uid: 'issue-2',
    projectId: 'project-1',
    nodeType: 'Issue',
    itemId: 'ISSUE-2',
    parentId: '',
    name: 'Issue 2',
    lastModifyTime: '2026-07-02T00:00:00Z',
    raw: { status: 'Closed', effort: 5, updatedAt: '2026-07-02T00:00:00Z' },
    normalizedText: 'Issue 2 Closed'
  })
  realDb.bumpAnalyticsRevision()
  const third = new QueryEngine(db).execute(query)
  assert.equal(third.rows.reduce((sum, row) => sum + Number(row.records ?? 0), 0), 2)
  assert.equal(scanCount, 4, '数据修订号变化后应重新扫描并计算')

  console.log(JSON.stringify({ ok: true, scanCount, rows: third.rows }, null, 2))
} finally {
  realDb.close()
  rmSync(directory, { recursive: true, force: true })
}
