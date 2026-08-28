import assert from 'node:assert/strict'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { validateQuerySpecShape } from '../src/shared/query-spec'
import { swapDashboardComponentLayouts } from '../src/shared/dashboard-layout'
import type {
  DashboardAnalysisBlueprint,
  DashboardComponentSpec,
  DashboardSpec
} from '../src/shared/dashboard'
import type { FieldProfile } from '../src/shared/query-spec'
import { dashboardComponentRegistry } from '../src/renderer/src/dashboard/componentRegistry'
import {
  dashboardComponentDataShape,
  planDashboardComponentTypeChange,
  type DashboardComponentTypeChangePlan
} from '../src/renderer/src/dashboard/componentTypeAdapter'
import {
  createManualDashboardComponent,
  planDashboardComponentRemoval
} from '../src/renderer/src/dashboard/dashboardComponentFactory'
import { validateDashboardSemanticConsistency } from '../src/shared/dashboard-semantics'

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
assert.equal(dashboardComponentRegistry.length, 14, 'P1 Manifest 必须覆盖全部 14 个内置组件')
assert.equal(registeredTypes.size, dashboardComponentRegistry.length, 'Manifest type 必须唯一')
for (const type of ['gauge', 'funnel', 'radar', 'scatter', 'treemap', 'combo'] as const) {
  assert.ok(registeredTypes.has(type), `missing component type: ${type}`)
}

type ManifestEntry = {
  manifestVersion?: unknown
  type?: unknown
  name?: unknown
  description?: unknown
  category?: unknown
  minimumSize?: { w?: unknown; h?: unknown }
  preferredSize?: { w?: unknown; h?: unknown }
  supportedDataShapes?: unknown
  compatibleSlotRoles?: unknown
  supportsManualAdd?: unknown
  requiresQuery?: unknown
}
const manifestEntries = dashboardComponentRegistry as unknown as ManifestEntry[]
for (const entry of manifestEntries) {
  assert.equal(entry.manifestVersion, '1.0', `${String(entry.type)} manifestVersion 必须是 1.0`)
  for (const field of ['type', 'name', 'description', 'category'] as const) {
    assert.equal(typeof entry[field], 'string', `${String(entry.type)} 缺少 Manifest 字段 ${field}`)
  }
  for (const sizeName of ['minimumSize', 'preferredSize'] as const) {
    const size = entry[sizeName]
    assert.ok(size && Number.isInteger(size.w) && Number.isInteger(size.h), `${String(entry.type)} ${sizeName} 无效`)
    assert.ok(Number(size.w) > 0 && Number(size.h) > 0, `${String(entry.type)} ${sizeName} 必须为正数`)
  }
  assert.ok(
    Number(entry.preferredSize!.w) >= Number(entry.minimumSize!.w) &&
      Number(entry.preferredSize!.h) >= Number(entry.minimumSize!.h),
    `${String(entry.type)} preferredSize 不能小于 minimumSize`
  )
  assert.ok(Array.isArray(entry.supportedDataShapes) && entry.supportedDataShapes.length > 0,
    `${String(entry.type)} 必须声明 supportedDataShapes`)
  assert.ok(Array.isArray(entry.compatibleSlotRoles) && entry.compatibleSlotRoles.length > 0,
    `${String(entry.type)} 必须声明 compatibleSlotRoles`)
  assert.equal(typeof entry.supportsManualAdd, 'boolean', `${String(entry.type)} 缺少 supportsManualAdd`)
  assert.equal(typeof entry.requiresQuery, 'boolean', `${String(entry.type)} 缺少 requiresQuery`)
  assert.equal(entry.supportsManualAdd, true, `${String(entry.type)} 必须支持手工新增`)
  if (entry.requiresQuery) {
    assert.ok(Array.isArray(entry.supportedDataShapes) && entry.supportedDataShapes.length > 0,
      `${String(entry.type)} requiresQuery 时必须声明数据形态`)
  }
}
const scatterManifest = manifestEntries.find((entry) => entry.type === 'scatter')
assert.ok(scatterManifest)
assert.ok(
  (scatterManifest.supportedDataShapes as unknown[]).includes('dual-measure'),
  'scatter Manifest 必须声明 dual-measure 数据形态'
)

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
    displayName: 'created At',
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

const rectanglesOverlap = (left: DashboardComponentSpec, right: DashboardComponentSpec): boolean =>
  left.layout.x < right.layout.x + right.layout.w &&
  left.layout.x + left.layout.w > right.layout.x &&
  left.layout.y < right.layout.y + right.layout.h &&
  left.layout.y + left.layout.h > right.layout.y

const assertNoOverlaps = (components: DashboardComponentSpec[], label: string): void => {
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      assert.equal(
        rectanglesOverlap(components[left], components[right]),
        false,
        `${label}: ${components[left].id} 与 ${components[right].id} 不得重叠`
      )
    }
  }
}

const requireManualComponent = (
  dashboard: DashboardSpec,
  type: DashboardComponentSpec['type']
): { component: DashboardComponentSpec; analysisBlueprint?: DashboardAnalysisBlueprint } => {
  const result = createManualDashboardComponent(dashboard, type, profiles)
  if ('error' in result) throw new Error(result.error)
  return result
}

const manualBarSource = JSON.stringify(base)
const manualBar = requireManualComponent(base, 'bar').component
assert.equal(manualBar.type, 'bar')
assert.equal(manualBar.query?.source, 'records')
assert.deepEqual(manualBar.query?.dimensions, [{ field: 'status' }])
assert.equal(manualBar.query?.measures.length, 1)
assert.equal(manualBar.query?.measures[0]?.aggregation, 'count')
assert.equal(manualBar.encoding?.label, 'status')
assert.equal(manualBar.encoding?.value, manualBar.query?.measures[0]?.id)
assertNoOverlaps([...base.components, manualBar], 'bar 手工新增布局')
assert.equal(JSON.stringify(base), manualBarSource, 'bar 手工工厂不得修改源 Spec')

const manualLineSource = JSON.stringify(base)
const manualLinePlan = requireManualComponent(base, 'line')
const manualLine = manualLinePlan.component
assert.equal(manualLine.type, 'line')
assert.deepEqual(manualLine.query?.dimensions, [{ field: 'createdAt', timeGrain: 'month' }])
assert.equal(manualLine.encoding?.label, 'createdAt')
assert.equal(manualLine.encoding?.value, manualLine.query?.measures[0]?.id)
assert.ok(manualLinePlan.analysisBlueprint?.questions.some((question) =>
  question.dimensionFields.includes('createdAt') && question.question.includes('创建时间')
), '手工新增的问题文案必须将 raw-equivalent displayName 本地化')
assert.ok(!manualLinePlan.analysisBlueprint?.questions.some((question) =>
  question.question.includes('created At')
), '手工新增的问题文案不得泄露技术字段别名')
assertNoOverlaps([...base.components, manualLine], 'line 手工新增布局')
assert.equal(JSON.stringify(base), manualLineSource, 'line 手工工厂不得修改源 Spec')

const manualScatterSource = JSON.stringify(base)
const manualScatter = requireManualComponent(base, 'scatter').component
assert.equal(manualScatter.type, 'scatter')
assert.equal(manualScatter.query?.measures.length, 2)
assert.equal(manualScatter.query?.measures[1]?.field, 'amount')
assert.equal(manualScatter.encoding?.label, 'status')
assert.equal(manualScatter.encoding?.value, manualScatter.query?.measures[0]?.id)
assert.equal(manualScatter.encoding?.secondaryValue, manualScatter.query?.measures[1]?.id)
assert.equal(dashboardComponentDataShape(manualScatter.type), 'dual-measure')
assertNoOverlaps([...base.components, manualScatter], 'scatter 手工新增布局')
assert.equal(JSON.stringify(base), manualScatterSource, 'scatter 手工工厂不得修改源 Spec')

const manualTreemapSource = JSON.stringify(base)
const manualTreemap = requireManualComponent(base, 'treemap').component
assert.equal(manualTreemap.type, 'treemap')
assert.deepEqual(manualTreemap.query?.dimensions, [{ field: 'status' }])
assert.equal(manualTreemap.query?.measures.length, 1)
assert.equal(manualTreemap.query?.measures[0]?.aggregation, 'count')
assert.equal(manualTreemap.encoding?.label, 'status')
assert.equal(manualTreemap.encoding?.value, manualTreemap.query?.measures[0]?.id)
assert.equal(dashboardComponentDataShape(manualTreemap.type), 'category-value')
assertNoOverlaps([...base.components, manualTreemap], 'treemap 手工新增布局')
assert.equal(JSON.stringify(base), manualTreemapSource, 'treemap 手工工厂不得修改源 Spec')

const manualComboSource = JSON.stringify(base)
const manualCombo = requireManualComponent(base, 'combo').component
assert.equal(manualCombo.type, 'combo')
assert.deepEqual(manualCombo.query?.dimensions, [{ field: 'createdAt', timeGrain: 'month' }])
assert.equal(manualCombo.query?.measures.length, 2)
assert.notEqual(manualCombo.query?.measures[0]?.id, manualCombo.query?.measures[1]?.id)
assert.equal(manualCombo.query?.measures[1]?.field, 'amount')
assert.equal(manualCombo.encoding?.label, 'createdAt')
assert.equal(manualCombo.encoding?.value, manualCombo.query?.measures[0]?.id)
assert.equal(manualCombo.encoding?.secondaryValue, manualCombo.query?.measures[1]?.id)
assert.equal(dashboardComponentDataShape(manualCombo.type), 'dual-measure')
assertNoOverlaps([...base.components, manualCombo], 'combo 手工新增布局')
assert.equal(JSON.stringify(base), manualComboSource, 'combo 手工工厂不得修改源 Spec')

const withFirstBar: DashboardSpec = { ...base, components: [...base.components, manualBar] }
const secondManualBar = requireManualComponent(withFirstBar, 'bar').component
assert.notEqual(secondManualBar.id, manualBar.id, '连续手工新增必须生成唯一组件 id')
assert.notDeepEqual(secondManualBar.layout, manualBar.layout, '连续手工新增必须自动落位到不同网格')
assertNoOverlaps([...withFirstBar.components, secondManualBar], '连续手工新增布局')

const manualBlueprint: DashboardAnalysisBlueprint = {
  version: '1.0',
  request: '观察缺陷总量和状态分布',
  audience: '项目经理',
  objective: '跟踪研发质量',
  scopeDescription: 'p1 Issue 数据',
  metrics: [{
    id: 'issueCount',
    label: '缺陷',
    measureId: 'record_count',
    aggregation: 'count',
    source: 'catalog',
    confidence: 1
  }],
  questions: [
    {
      id: 'q-total',
      question: '当前缺陷总量是多少？',
      metricIds: ['issueCount'],
      dimensionFields: [],
      preferredComponentTypes: ['kpi'],
      slotRole: 'headline',
      priority: 1,
      required: true
    },
    {
      id: 'q-status',
      question: '缺陷按状态如何分布？',
      metricIds: ['issueCount'],
      dimensionFields: ['status'],
      preferredComponentTypes: ['bar'],
      slotRole: 'comparison',
      priority: 2,
      required: false
    }
  ],
  assumptions: [],
  unresolvedAmbiguities: [],
  generatedAt: new Date().toISOString()
}
const semanticKpi: DashboardComponentSpec = {
  ...base.components[0],
  title: '缺陷数量',
  query: {
    ...base.components[0].query!,
    measures: [{ id: 'record_count', aggregation: 'count' }]
  },
  encoding: { value: 'record_count' },
  semanticBinding: {
    questionId: 'q-total',
    metricIds: ['issueCount'],
    dimensionFields: [],
    titleMode: 'auto',
    confidence: 1
  },
  slotRole: 'headline'
}
const blueprintDashboard: DashboardSpec = {
  ...base,
  id: 'editor-blueprint-smoke',
  analysisBlueprint: manualBlueprint,
  components: [semanticKpi]
}
const blueprintSource = JSON.stringify(blueprintDashboard)
const blueprintPlan = requireManualComponent(blueprintDashboard, 'bar')
assert.ok(blueprintPlan.analysisBlueprint, 'Blueprint-backed 手工新增必须返回更新后的 Blueprint')
assert.equal(blueprintPlan.component.semanticBinding?.questionId, 'q-status')
assert.deepEqual(blueprintPlan.component.semanticBinding?.metricIds, ['issueCount'])
assert.equal(blueprintPlan.component.semanticBinding?.titleMode, 'auto')
assert.equal(blueprintPlan.component.slotRole, 'comparison')
assert.equal(blueprintPlan.component.title, 'status · 缺陷数量对比')
assert.equal(JSON.stringify(blueprintDashboard), blueprintSource, 'Blueprint 手工工厂不得修改源 Spec')
const blueprintResult: DashboardSpec = {
  ...blueprintDashboard,
  analysisBlueprint: blueprintPlan.analysisBlueprint,
  components: [...blueprintDashboard.components, blueprintPlan.component]
}
assertNoOverlaps(blueprintResult.components, 'Blueprint 手工新增布局')
assert.deepEqual(validateDashboardSemanticConsistency(blueprintResult), [],
  'Blueprint-backed 手工新增必须通过语义一致性校验')

const comboBlueprint: DashboardAnalysisBlueprint = {
  ...manualBlueprint,
  metrics: [
    ...manualBlueprint.metrics,
    {
      id: 'effortTotal',
      label: '投入工时',
      measureId: 'sum_amount',
      field: 'amount',
      aggregation: 'sum',
      source: 'catalog',
      confidence: 1
    }
  ],
  questions: [
    ...manualBlueprint.questions,
    {
      id: 'q-combo',
      question: '缺陷数量与投入工时如何随时间变化？',
      metricIds: ['issueCount', 'effortTotal'],
      dimensionFields: ['createdAt'],
      timeGrain: 'month',
      preferredComponentTypes: ['combo'],
      slotRole: 'trend',
      priority: 3,
      required: true
    }
  ]
}
const comboBlueprintDashboard: DashboardSpec = {
  ...blueprintDashboard,
  id: 'editor-combo-blueprint-smoke',
  analysisBlueprint: comboBlueprint
}
const comboBlueprintSource = JSON.stringify(comboBlueprintDashboard)
const comboBlueprintPlan = requireManualComponent(comboBlueprintDashboard, 'combo')
assert.ok(comboBlueprintPlan.analysisBlueprint)
assert.equal(comboBlueprintPlan.component.semanticBinding?.questionId, 'q-combo')
assert.deepEqual(comboBlueprintPlan.component.semanticBinding?.metricIds, ['issueCount', 'effortTotal'])
assert.equal(comboBlueprintPlan.component.title, '创建时间 · 缺陷数量 / 投入工时总量组合趋势')
assert.equal(JSON.stringify(comboBlueprintDashboard), comboBlueprintSource, 'Combo Blueprint 手工工厂不得修改源 Spec')
const comboBlueprintResult: DashboardSpec = {
  ...comboBlueprintDashboard,
  analysisBlueprint: comboBlueprintPlan.analysisBlueprint,
  components: [...comboBlueprintDashboard.components, comboBlueprintPlan.component]
}
assertNoOverlaps(comboBlueprintResult.components, 'Combo Blueprint 手工新增布局')
assert.deepEqual(validateDashboardSemanticConsistency(comboBlueprintResult), [],
  'Legacy/Blueprint combo 手工新增必须通过完整语义校验')

const legacyQueryDashboard: DashboardSpec = {
  ...base,
  id: 'editor-legacy-query-upgrade-smoke',
  components: [
    {
      ...base.components[0],
      id: 'legacy-total',
      title: '历史记录总数'
    },
    {
      ...base.components[0],
      id: 'legacy-trend',
      type: 'line',
      title: '历史投入工时趋势',
      layout: { x: 6, y: 0, w: 12, h: 5 },
      data: [],
      query: {
        source: 'records',
        scope: {},
        dimensions: [{ field: 'createdAt', timeGrain: 'month' }],
        measures: [{ id: 'amountSum', field: 'amount', aggregation: 'sum' }],
        limit: 12
      },
      encoding: { label: 'createdAt', value: 'amountSum' }
    }
  ]
}
delete legacyQueryDashboard.analysisBlueprint
const legacyQuerySource = JSON.stringify(legacyQueryDashboard)
const legacyQueryPlan = createManualDashboardComponent(legacyQueryDashboard, 'treemap', profiles)
assert.ok(!('error' in legacyQueryPlan), 'query-backed legacy 手工新增必须可升级')
if ('error' in legacyQueryPlan) throw new Error(legacyQueryPlan.error)
assert.ok(legacyQueryPlan.analysisBlueprint, 'query-backed legacy 手工新增必须生成 Blueprint')
assert.ok(legacyQueryPlan.components, 'query-backed legacy 手工新增必须返回升级后的完整组件列表')
assert.equal(legacyQueryPlan.components?.length, legacyQueryDashboard.components.length + 1)
assert.ok(legacyQueryPlan.components?.every((item) => item.semanticBinding && item.slotRole),
  'query-backed legacy 的全部旧组件和新组件都必须补齐 binding/slotRole')
const legacyQueryResult: DashboardSpec = {
  ...legacyQueryDashboard,
  components: legacyQueryPlan.components!,
  analysisBlueprint: legacyQueryPlan.analysisBlueprint
}
assert.deepEqual(validateDashboardSemanticConsistency(legacyQueryResult), [],
  'query-backed legacy 升级并新增组件后必须通过完整语义校验')
assert.equal(JSON.stringify(legacyQueryDashboard), legacyQuerySource,
  'query-backed legacy 手工升级不得修改源 Spec')

const mixedLegacyDashboard: DashboardSpec = {
  ...legacyQueryDashboard,
  id: 'editor-legacy-mixed-reject-smoke',
  components: [
    legacyQueryDashboard.components[0],
    { ...legacyQueryDashboard.components[1], query: undefined, encoding: undefined }
  ]
}
const mixedLegacySource = JSON.stringify(mixedLegacyDashboard)
const mixedLegacyPlan = createManualDashboardComponent(mixedLegacyDashboard, 'bar', profiles)
assert.ok('error' in mixedLegacyPlan, '混合 QuerySpec/inline legacy 必须原子拒绝')
assert.match(mixedLegacyPlan.error, /同时包含 QuerySpec 与 inline 组件/)
assert.equal(JSON.stringify(mixedLegacyDashboard), mixedLegacySource,
  '混合 legacy 拒绝时源 Spec 必须保持不变')

const deletionSource = JSON.stringify(blueprintResult)
const deletionPlan = planDashboardComponentRemoval(blueprintResult, semanticKpi.id)
if ('error' in deletionPlan) throw new Error(deletionPlan.error)
assert.equal(deletionPlan.components.length, 1)
assert.equal(
  deletionPlan.analysisBlueprint?.questions.find((question) => question.id === 'q-total')?.required,
  false,
  '删除 required question 的最后绑定组件时必须同步降级，避免留下无法保存的 Blueprint'
)
assert.equal(JSON.stringify(blueprintResult), deletionSource, '删除规划不得修改源 Spec')
assert.deepEqual(validateDashboardSemanticConsistency({
  ...blueprintResult,
  components: deletionPlan.components,
  analysisBlueprint: deletionPlan.analysisBlueprint
}), [], '删除后的 Blueprint 必须保持语义可保存')
assert.ok('error' in planDashboardComponentRemoval(blueprintDashboard, semanticKpi.id),
  '大屏必须至少保留一个组件')

console.log(JSON.stringify({
  ok: true,
  globalFilterCount: base.globalFilters?.length ?? 0,
  encoding: base.components[0].encoding,
  componentTypeCount: dashboardComponentRegistry.length,
  checks: ['dashboard-validation', 'query-shape', 'accent-safety', 'style-ranges', 'filter-whitelist', 'horizontal-swap', 'vertical-swap', 'sized-slot-swap', 'component-registry', 'type-adaptation', 'date-dimension', 'scatter-measures', 'immutable-planning', 'manifest-shape', 'manual-add-contract', 'scatter-dual-measure', 'slot-role-contract', 'manual-factory-bar', 'manual-factory-line', 'manual-factory-scatter', 'manual-factory-treemap', 'manual-factory-combo', 'manual-layout-placement', 'manual-blueprint-binding', 'manual-semantic-validation', 'manual-combo-blueprint-binding', 'manual-legacy-query-upgrade', 'manual-mixed-legacy-rejection', 'manual-delete-cleanup', 'minimum-one-component']
}, null, 2))
