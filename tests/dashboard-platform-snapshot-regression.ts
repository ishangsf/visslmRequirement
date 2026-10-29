import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capturePlatformDashboardSnapshot, platformSnapshotQueryEngine } from '../src/main/dashboards/platform-snapshot'
import { createDashboardQueryEngineForSpec } from '../src/main/experts/dashboard-domain-controlled-fixtures'
import type { PlatformReader } from '../src/main/assistant/platform-analysis'
import type { DashboardSpec } from '../src/shared/dashboard'
import type { AppDatabase } from '../src/main/database'

const root = await mkdtemp(join(tmpdir(), 'visslm-platform-dashboard-test-'))
const credentials = { baseUrl: 'https://example.invalid', username: 'tester', token: 'test-token', uploadPassword: '' }
const scope = { projectIds: ['p'], nodeTypes: ['Issue'] }
const makeReader = (outside = false): PlatformReader => ({
  async connect() {}, async close() {},
  async read(path) {
    if (path === '/Admin/Virtualization_ReadMember') return { rows: [
      { HideMember: '_valm_ProjectId', MemberName: '项目', MemberType: 'SINGLELINETEXT' },
      { HideMember: 'Status', MemberName: '状态', MemberType: 'SINGLELINETEXT' }
    ] }
    return { propList: [
      { _valm_Uid: 'a', _valm_ProjectId: 'p', _valm_Name: '一', Status: 'open' },
      { _valm_Uid: 'b', _valm_ProjectId: outside ? 'other' : 'p', _valm_Name: '二', Status: 'done' }
    ] }
  }
})
const source = await capturePlatformDashboardSnapshot({ reader: makeReader(), credentials, nodeTypes: ['Issue'], scope, root })
assert.equal(source.recordCount, 2)
assert.equal(source.completePopulation, false)
const query = { source: 'records' as const, scope, measures: [{ id: 'n', aggregation: 'count' as const }] }
const engine = platformSnapshotQueryEngine(root, source)
assert.equal(engine.execute(query).rows[0].n, 2)
const saved = JSON.parse(JSON.stringify({ dataSource: source, dataScope: scope })) as DashboardSpec
assert.equal(createDashboardQueryEngineForSpec(saved, {} as AppDatabase, root).execute(query).rows[0].n, 2)
assert.throws(() => createDashboardQueryEngineForSpec(saved, {} as AppDatabase), /快照目录/)
assert.throws(() => engine.execute({ ...query, scope: { projectIds: ['other'], nodeTypes: ['Issue'] } }), /范围/)
assert.throws(() => platformSnapshotQueryEngine(root, { ...source, snapshotId: '../outside' }), /路径或标识/)
await assert.rejects(capturePlatformDashboardSnapshot({ reader: makeReader(true), credentials, nodeTypes: ['Issue'], scope, root }), /范围外/)
console.log('dashboard platform snapshot regression passed')
