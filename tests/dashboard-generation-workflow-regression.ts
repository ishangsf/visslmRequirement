import assert from 'node:assert/strict'
import { DashboardGenerationSession } from '../src/main/dashboards/generation-tools'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { adaptDashboardComponentQuery } from '../src/main/dashboards/component-repair'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import type { FieldProfile, QuerySpec } from '../src/shared/query-spec'
import type { DashboardSpec, DashboardComponentSpec, VisualizationRunInput } from '../src/shared/dashboard'

const scope = { projectIds: ['p'] }
const records: AnalyticsRecord[] = Array.from({ length: 16 }, (_, i) => ({ uid: String(i), projectId: 'p', nodeType: 'Issue', itemId: `I-${i}`, name: `问题 ${i}`, lastModifyTime: '2026-10-01T00:00:00Z', raw: { status: String(i % 8), critical_delay: i + 1, effortHours: 5 } }))
const profiles: FieldProfile[] = Array.from({ length: 104 }, (_, i) => ({ field: `field_${i}`, inferredType: 'number', role: 'measure', sensitivity: 'normal', nonNullRate: 1, distinctCount: 16, samples: ['1'] }))
profiles.push({ ...profiles[0], field: 'critical_delay', displayName: '关键评审延迟', unit: '天', businessMeaning: '实际评审完成时间与计划评审时间之差' },
  { ...profiles[0], field: 'status', displayName: '问题状态', inferredType: 'enum', role: 'dimension', valueLabels: { '0': '待处理' } },
  { ...profiles[0], field: 'effortHours', unit: '小时' },
  { ...profiles[0], field: 'lastModifyTime', inferredType: 'date', role: 'time' })
const engine = new QueryEngine({ scanAnalyticsRecords: () => records, getFieldProfiles: () => profiles } as unknown as AppDatabase)
const session = new DashboardGenerationSession(engine, scope)
assert.equal(session.scope.snapshotAt, undefined, 'generation must not freeze future refreshes by inventing a persistent timestamp')
assert.equal(new DashboardGenerationSession(engine, { ...scope, snapshotAt: '2020-01-01T00:00:00.000Z' }).scope.snapshotAt, '2020-01-01T00:00:00.000Z')
assert.equal(session.searchFields().hasMore, true)
const found = session.searchFields('关键评审延迟').fields[0]
assert.equal(found.field, 'critical_delay'); assert.equal(found.unit, '天'); assert.ok(found.businessMeaning)
assert.deepEqual((await session.callTool('get_field', { field: 'status' }) as any).valueLabels, { '0': '待处理' })
const total: QuerySpec = { source: 'records', scope, measures: [{ id: 'n', aggregation: 'count' }] }
assert.throws(() => session.bindQuery({ ...total, scope: {} }), /范围/)
assert.throws(() => session.bindQuery({ ...total, scope: { ...scope, snapshotAt: '2020-01-01T00:00:00.000Z' } }), /快照/)
const scoped = new DashboardGenerationSession(engine, { ...scope, baseFilters: [{ field: 'status', operator: 'equals', value: '0' }] })
assert.equal(scoped.recordCount, 2)
assert.deepEqual(scoped.profiles.find(field => field.field === 'status')?.samples, ['0'])
assert.equal(new DashboardGenerationSession(engine, { ...scope, recordUids: [] }).recordCount, 0)
const before = (await session.callTool('preview_query', { query: total }) as any).rows[0].n
records.push({ ...records[0], uid: 'new' })
assert.equal((await session.callTool('preview_query', { query: total }) as any).rows[0].n, before, 'one run must retain its snapshot')
records.pop()
assert.equal((await session.handle({ id: 1, method: 'tools/list' }) as any).result.tools.length, 7)
assert.equal((await session.handle({ id: 2, method: 'tools/call', params: { name: 'unknown', arguments: {} } }) as any).result.isError, true)
const missing = { schemaVersion: '1.0', id: 'cost', title: '成本', subtitle: '', theme: 'technology-dark', updatedAt: '', components: [{ id: 'cost', type: 'kpi', title: '成本', data: [], layout: { x: 0, y: 0, w: 6, h: 3 }, query: { ...total, measures: [{ id: 'cost', field: 'cost_amount', aggregation: 'sum' }] }, encoding: { value: 'cost' } }] } as DashboardSpec
assert.throws(() => adaptDashboardComponentQuery(missing, 'cost', engine), /不能替换/)

const sumQuery: QuerySpec = { source: 'records', scope, dimensions: [], measures: [{ id: 'delay', field: 'critical_delay', aggregation: 'sum' }], limit: 50 }
const component = (id: string, type: DashboardComponentSpec['type'], query: QuerySpec): DashboardComponentSpec => ({ id, type, title: id, data: [], layout: { x: 0, y: 0, w: 8, h: 4 }, query, encoding: { value: query.measures[0].id, ...(query.dimensions?.length ? { label: query.dimensions[0].field } : {}) } })
const grouped: QuerySpec = { ...total, dimensions: [{ field: 'status' }], limit: 50 }
const candidate: DashboardSpec = { schemaVersion: '1.0', id: 'workflow', title: '问题分析', subtitle: '评审与状态', theme: 'technology-dark', updatedAt: new Date().toISOString(), components: [component('delay', 'kpi', sumQuery), component('pie', 'pie', grouped), component('ranking', 'ranking', grouped), component('table', 'table', grouped)] }
const nativeFetch = globalThis.fetch
const settings = { source: 'local' as const, provider: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434', model: 'workflow-mock', thinking: false }
let discovery = 0, compose = 0, patches = 0, previews = 0
const runs: VisualizationRunInput[] = []
globalThis.fetch = async (_url, init) => {
  const input = JSON.parse(String(init?.body))
  let content: unknown
  if (input.messages[0].content.startsWith('visualization-discovery-v1')) {
    if (!discovery++) return new Response(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'lookup', function: { name: 'search_fields', arguments: { query: '关键评审延迟' } } }] } }))
    content = { goals: [{ id: 'delay', question: '统计关键评审延迟', fields: ['critical_delay'], dimensionFields: [], query: sumQuery }], assumptions: [] }
  } else if (input.messages[0].content.startsWith('visualization-render-review-v1')) content = { issues: [] }
  else if (input.format.properties.operations) { patches++; content = { operations: [{ op: 'set-component-type', componentId: 'pie', value: 'bar' }] } }
  else { compose++; const payload = JSON.parse(input.messages[1].content); assert.ok(payload.fieldCatalog.some((field: any) => field.field === 'critical_delay' && field.unit === '天')); assert.equal(payload.analysisContract.goals.length, 1); assert.ok(payload.trialResults.length); content = candidate }
  return new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(content) } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
try {
  const result = await new VisualizationAgent(engine, settings, run => runs.push(run), undefined, { renderPreview: async spec => { previews++; return { rendered: true, componentCount: spec.components.length, issues: [] } } }).generate('统计关键评审延迟，并展示问题状态分布', scope)
  assert.equal(compose, 1); assert.equal(patches, 1); assert.equal(previews, 2)
  assert.equal(result.components.find(item => item.id === 'pie')!.type, 'bar')
  assert.equal(result.components.find(item => item.id === 'delay')!.data[0].value, 136)
  assert.equal(result.generationEvidence?.rendered, true)
  assert.equal(runs.at(-1)?.status, 'success')
  await session.callTool('finish_analysis', { goals: [{ id: 'must', question: '延迟', fields: ['critical_delay'], dimensionFields: [], query: sumQuery }], assumptions: [] })
  assert.ok(session.coverage({ ...result, components: result.components.filter(item => item.id !== 'delay') }).length)
  const draft = session.stage(result)
  session.stage(result)
  assert.equal((await session.handle({ id: 3, method: 'tools/call', params: { name: 'render_preview', arguments: draft } }) as any).result.isError, true)
  console.log(JSON.stringify({ ok: true, checks: ['complete semantic lookup', 'MCP dispatch', 'scope isolation', 'immutable snapshot', 'semantic repair guard', 'native model tool loop', 'query trial', 'goal coverage', 'quality feedback', 'incremental correction', 'stale draft rejection'] }))
} finally { globalThis.fetch = nativeFetch }
