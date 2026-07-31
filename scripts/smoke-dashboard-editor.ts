import assert from 'node:assert/strict'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { validateQuerySpecShape } from '../src/shared/query-spec'
import { swapDashboardComponentLayouts } from '../src/shared/dashboard-layout'
import type { DashboardSpec } from '../src/shared/dashboard'

const base: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'editor-smoke',
  title: '编辑闭环',
  subtitle: '颜色、编码和全局筛选器',
  theme: 'technology-dark',
  globalFilters: [{
    id: 'filter-status',
    field: 'status',
    label: '状态',
    operator: 'in',
    options: ['Open', 'Closed'],
    value: ['Open']
  }],
  updatedAt: new Date().toISOString(),
  components: [{
    id: 'total',
    type: 'kpi',
    title: '记录总数',
    layout: { x: 0, y: 0, w: 6, h: 2 },
    data: [{ name: '记录', value: 12 }],
    accent: '#64dbff',
    query: {
      source: 'records',
      scope: {},
      measures: [{ id: 'recordCount', aggregation: 'count' }],
      filters: [{ field: 'status', operator: 'in', value: ['Open'], source: 'dashboard' }],
      limit: 1
    },
    encoding: { value: 'recordCount' }
  }]
}

const validErrors = validateDashboardSpec(base)
assert.deepEqual(validErrors, [], validErrors.join('; '))

const queryShape = validateQuerySpecShape(base.components[0].query)
assert.equal(queryShape.valid, true, queryShape.errors.join('; '))

const invalidAccent = validateDashboardSpec({
  ...base,
  components: [{ ...base.components[0], accent: 'url(javascript:alert(1))' }]
})
assert.ok(invalidAccent.some((message) => message.includes('accent 必须是十六进制颜色')))

const invalidGlobalFilter = validateDashboardSpec({
  ...base,
  globalFilters: [{ ...base.globalFilters![0], operator: 'contains' as 'in' }]
})
assert.ok(invalidGlobalFilter.some((message) => message.includes('操作符不受支持')))

const swapResult = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'left', layout: { x: 0, y: 0, w: 6, h: 2 } },
  { ...base.components[0], id: 'right', layout: { x: 6, y: 0, w: 6, h: 2 } }
], 'left', { x: 5, y: 0, w: 6, h: 2 })
assert.equal(swapResult?.targetId, 'right')
assert.deepEqual(swapResult?.draggedLayout, { x: 6, y: 0, w: 6, h: 2 })
assert.deepEqual(swapResult?.targetLayout, { x: 0, y: 0, w: 6, h: 2 })
assert.deepEqual(swapResult?.errors, [])

const incompatibleSwap = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'small', layout: { x: 0, y: 0, w: 4, h: 2 } },
  { ...base.components[0], id: 'tall', type: 'table', layout: { x: 4, y: 0, w: 8, h: 5 } }
], 'small', { x: 4, y: 0, w: 4, h: 2 })
assert.ok(incompatibleSwap?.errors.length)

console.log(JSON.stringify({
  ok: true,
  globalFilterCount: base.globalFilters?.length ?? 0,
  encoding: base.components[0].encoding,
  checks: ['dashboard-validation', 'query-shape', 'accent-safety', 'filter-whitelist', 'component-swap']
}, null, 2))
