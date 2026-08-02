import assert from 'node:assert/strict'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { validateQuerySpecShape } from '../src/shared/query-spec'
import { swapDashboardComponentLayouts } from '../src/shared/dashboard-layout'
import type { DashboardSpec } from '../src/shared/dashboard'
import type { FieldProfile } from '../src/shared/query-spec'
import { dashboardComponentRegistry } from '../src/renderer/src/dashboard/componentRegistry'
import {
  dashboardComponentDataShape,
  planDashboardComponentTypeChange,
  type DashboardComponentTypeChangePlan
} from '../src/renderer/src/dashboard/componentTypeAdapter'

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
    style: { titleFontSize: 12, valueFontSize: 30, borderRadius: 8, padding: 9 },
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

const invalidStyle = validateDashboardSpec({
  ...base,
  components: [{ ...base.components[0], style: { valueFontSize: 72 } }]
})
assert.ok(invalidStyle.some((message) => message.includes('style.valueFontSize')))

const swapResult = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'left', layout: { x: 0, y: 0, w: 6, h: 2 } },
  { ...base.components[0], id: 'right', layout: { x: 6, y: 0, w: 6, h: 2 } }
], 'left', { x: 5, y: 0, w: 6, h: 2 })
assert.equal(swapResult?.targetId, 'right')
assert.deepEqual(swapResult?.draggedLayout, { x: 6, y: 0, w: 6, h: 2 })
assert.deepEqual(swapResult?.targetLayout, { x: 0, y: 0, w: 6, h: 2 })
assert.deepEqual(swapResult?.errors, [])

const verticalSwap = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'top', layout: { x: 0, y: 0, w: 6, h: 2 } },
  { ...base.components[0], id: 'bottom', layout: { x: 0, y: 2, w: 6, h: 2 } }
], 'top', { x: 0, y: 1, w: 6, h: 2 })
assert.equal(verticalSwap?.targetId, 'bottom')
assert.deepEqual(verticalSwap?.draggedLayout, { x: 0, y: 2, w: 6, h: 2 })
assert.deepEqual(verticalSwap?.targetLayout, { x: 0, y: 0, w: 6, h: 2 })
assert.deepEqual(verticalSwap?.errors, [])

const sizedSlotSwap = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'wide-bar', type: 'bar', layout: { x: 0, y: 0, w: 8, h: 5 } },
  { ...base.components[0], id: 'wide-line', type: 'line', layout: { x: 8, y: 0, w: 10, h: 5 } }
], 'wide-bar', { x: 8, y: 0, w: 8, h: 5 })
assert.deepEqual(sizedSlotSwap?.draggedLayout, { x: 8, y: 0, w: 10, h: 5 })
assert.deepEqual(sizedSlotSwap?.targetLayout, { x: 0, y: 0, w: 8, h: 5 })
assert.deepEqual(sizedSlotSwap?.errors, [])

const incompatibleSwap = swapDashboardComponentLayouts([
  { ...base.components[0], id: 'small', layout: { x: 0, y: 0, w: 4, h: 2 } },
  { ...base.components[0], id: 'tall', type: 'table', layout: { x: 4, y: 0, w: 8, h: 5 } }
], 'small', { x: 4, y: 0, w: 4, h: 2 })
assert.ok(incompatibleSwap?.errors.length)

const registeredTypes = new Set(dashboardComponentRegistry.map((component) => component.type))
assert.ok(dashboardComponentRegistry.length >= 10)
for (const type of ['gauge', 'funnel', 'radar', 'scatter'] as const) {
  assert.ok(registeredTypes.has(type), `missing component type: ${type}`)
}

const profiles: FieldProfile[] = [
  {
    field: 'status',
    inferredType: 'string',
    sensitivity: 'normal',
    nonNullRate: 1,
    distinctCount: 2,
    samples: ['Open', 'Closed'],
    role: 'dimension'
  },
  {
    field: 'createdAt',
    inferredType: 'date',
    sensitivity: 'normal',
    nonNullRate: 1,
    distinctCount: 12,
    samples: ['2026-01-01'],
    role: 'time'
  },
  {
    field: 'amount',
    inferredType: 'number',
    sensitivity: 'normal',
    nonNullRate: 1,
    distinctCount: 10,
    samples: ['100'],
    role: 'measure'
  }
]

const requireTypeChange = (plan: DashboardComponentTypeChangePlan) => {
  if ('error' in plan) throw new Error(plan.error)
  return plan.component
}

const sourceSnapshot = JSON.stringify(base.components[0])
const gaugeComponent = requireTypeChange(planDashboardComponentTypeChange(
  base.components,
  'total',
  'gauge',
  profiles
))
assert.equal(gaugeComponent.type, 'gauge')
assert.equal(gaugeComponent.query?.limit, 1)
assert.equal(gaugeComponent.query?.dimensions, undefined)
assert.ok(gaugeComponent.layout.h >= 4)
assert.equal(JSON.stringify(base.components[0]), sourceSnapshot, 'type planning must not mutate the source')

const blockedCategory = planDashboardComponentTypeChange(base.components, 'total', 'bar', [])
assert.ok('error' in blockedCategory)

const barComponent = requireTypeChange(planDashboardComponentTypeChange(
  base.components,
  'total',
  'bar',
  profiles
))
assert.equal(barComponent.query?.dimensions?.[0]?.field, 'status')
assert.equal(barComponent.encoding?.label, 'status')

const radarComponent = requireTypeChange(planDashboardComponentTypeChange(
  [barComponent],
  'total',
  'radar',
  profiles
))
assert.equal(radarComponent.type, 'radar')
assert.equal(radarComponent.query?.limit, 10)

const lineComponent = requireTypeChange(planDashboardComponentTypeChange(
  base.components,
  'total',
  'line',
  profiles
))
assert.equal(lineComponent.query?.dimensions?.[0]?.field, 'createdAt')
assert.equal(lineComponent.query?.dimensions?.[0]?.timeGrain, 'month')

const scatterComponent = requireTypeChange(planDashboardComponentTypeChange(
  base.components,
  'total',
  'scatter',
  profiles
))
assert.equal(scatterComponent.query?.measures.length, 2)
assert.equal(scatterComponent.query?.measures[1]?.field, 'amount')
assert.equal(scatterComponent.encoding?.secondaryValue, scatterComponent.query?.measures[1]?.id)
assert.equal(dashboardComponentDataShape('scatter'), 'dual-measure')
assert.equal(dashboardComponentDataShape('kpi'), 'single-value')

console.log(JSON.stringify({
  ok: true,
  globalFilterCount: base.globalFilters?.length ?? 0,
  encoding: base.components[0].encoding,
  componentTypeCount: dashboardComponentRegistry.length,
  checks: ['dashboard-validation', 'query-shape', 'accent-safety', 'style-ranges', 'filter-whitelist', 'horizontal-swap', 'vertical-swap', 'sized-slot-swap', 'component-registry', 'type-adaptation', 'date-dimension', 'scatter-measures', 'immutable-planning']
}, null, 2))
