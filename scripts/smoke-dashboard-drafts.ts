import { strict as assert } from 'node:assert'
import type { DashboardSpec } from '../src/shared/dashboard'
import {
  dashboardDraftStorageKey,
  parseDashboardDraft,
  serializeDashboardDraft
} from '../src/renderer/src/dashboard/dashboardDraft'

const dashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'draft-dashboard',
  title: '草稿测试',
  subtitle: '自动保存',
  theme: 'technology-dark',
  updatedAt: '2026-07-31T08:00:00.000Z',
  components: []
}

const savedAt = '2026-07-31T08:01:00.000Z'
const value = serializeDashboardDraft(dashboard, savedAt)
assert.equal(dashboardDraftStorageKey(dashboard.id), 'visslm:dashboard-draft:draft-dashboard')
assert.deepEqual(parseDashboardDraft(value, dashboard.id), { spec: dashboard, savedAt })
assert.equal(parseDashboardDraft(value, 'other-dashboard'), null)
assert.equal(parseDashboardDraft('{invalid json', dashboard.id), null)
assert.equal(parseDashboardDraft(JSON.stringify({ spec: dashboard, savedAt: 'invalid' }), dashboard.id), null)

console.log(JSON.stringify({ ok: true, key: dashboardDraftStorageKey(dashboard.id), savedAt }, null, 2))
