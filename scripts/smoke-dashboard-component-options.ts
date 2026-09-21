import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  DashboardComponentContent,
  DashboardComponentSpec,
  DashboardComponentStyle,
  DashboardComponentType,
  DashboardSpec
} from '../src/shared/dashboard'
import {
  dashboardComponentOptionDefinitions,
  dashboardComponentStyleForType
} from '../src/shared/dashboard-component-options'
import { dashboardLayoutProfiles } from '../src/shared/dashboard-layout'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import {
  buildDashboardChartOption,
  DashboardComponentRendererView
} from '../src/renderer/src/dashboard/DashboardComponentRenderer'

const componentTypes = Object.keys(dashboardComponentOptionDefinitions) as DashboardComponentType[]

const componentOf = (
  type: DashboardComponentType,
  style: DashboardComponentStyle,
  content?: DashboardComponentContent
): DashboardComponentSpec => ({
  id: `audit-${type}`,
  type,
  title: `${type} audit`,
  subtitle: 'component option audit',
  layout: { x: 0, y: 0, w: 12, h: 6 },
  data: [
    { name: 'Alpha', value: 3.456, secondaryValue: 8 },
    { name: 'Bravo', value: 1, secondaryValue: 4 },
    { name: 'Charlie', value: 2, secondaryValue: 6 }
  ],
  unit: '%',
  style,
  ...(content ? { content } : {})
})

const optionOf = (type: DashboardComponentType, style: DashboardComponentStyle): any =>
  buildDashboardChartOption(componentOf(type, style), 'technology-dark')

const markupOf = (
  type: DashboardComponentType,
  style: DashboardComponentStyle,
  content?: DashboardComponentContent
): string => renderToStaticMarkup(createElement(DashboardComponentRendererView, {
  component: componentOf(type, style, content),
  theme: 'technology-dark'
}))

assert.equal(componentTypes.length, 17, '全部 17 类公共组件必须声明专属配置能力')
for (const type of componentTypes) {
  assert.ok(dashboardComponentOptionDefinitions[type].length > 0, `${type} 缺少专属配置定义`)
  const profile = dashboardLayoutProfiles[type]
  const style = Object.fromEntries(dashboardComponentOptionDefinitions[type].map((definition) => [
    definition.key,
    definition.defaultValue
  ])) as DashboardComponentStyle
  const spec: DashboardSpec = {
    schemaVersion: '1.0',
    id: `option-validation-${type}`,
    title: `${type} 专属配置校验`,
    subtitle: '公共配置能力回归',
    businessContext: { audience: '测试人员', objective: '验证配置', scopeDescription: 'inline fixture' },
    theme: 'technology-dark',
    updatedAt: '2026-08-30T00:00:00.000Z',
    components: [{
      ...componentOf(type, style),
      layout: { x: 0, y: 0, w: profile.preferredWidth, h: profile.preferredHeight }
    }]
  }
  assert.deepEqual(
    validateDashboardSpec(spec, undefined, { allowInlineData: true }),
    [],
    `${type} 的专属配置必须通过检查功能`
  )
}

const kpi = markupOf('kpi', { decimalPlaces: 3, showStatus: false })
assert.match(kpi, /3\.456%/, 'KPI 小数位配置必须进入渲染结果')
assert.doesNotMatch(kpi, /数据已同步/, 'KPI 状态开关必须进入渲染结果')

const bar = optionOf('bar', { barWidth: 30, showLabels: true, sortOrder: 'ascending' })
assert.deepEqual(bar.xAxis.data, undefined, '横向柱状图分类应位于 Y 轴')
assert.deepEqual(bar.yAxis.data, ['Bravo', 'Charlie', 'Alpha'])
assert.equal(bar.series[0].barMaxWidth, 30)
assert.equal(bar.series[0].label.show, true)

const line = optionOf('line', { smooth: false, showArea: false, showSymbols: false })
assert.equal(line.series[0].smooth, false)
assert.equal(line.series[0].symbol, 'none')
assert.equal(line.series[0].areaStyle, undefined)

const pie = optionOf('pie', { showLabels: true, legendPosition: 'top' })
assert.equal(pie.series[0].label.show, true)
assert.equal(pie.legend.top, 0)

const ranking = markupOf('ranking', { maxItems: 1, showIndex: false, showValues: false })
assert.match(ranking, /Alpha/)
assert.doesNotMatch(ranking, /Bravo/)
assert.doesNotMatch(ranking, /viz-ranking-index/)

const table = markupOf('table', { maxItems: 1, showIndex: true, showValues: false })
assert.match(table, /Alpha/)
assert.doesNotMatch(table, /Bravo/)
assert.match(table, /第 1 行/)

const progress = markupOf('progress', { targetValue: 200, showValues: true })
assert.match(progress, /完成率 1\.7%/)
assert.match(progress, /目标 200%/)

const insight = markupOf('insight', { showIcon: false })
assert.doesNotMatch(insight, /viz-insight-icon/)

const gauge = optionOf('gauge', { minimumValue: 1, maximumValue: 10, showPointer: false })
assert.equal(gauge.series[0].min, 1)
assert.equal(gauge.series[0].max, 10)
assert.equal(gauge.series[0].pointer.show, false)

const funnel = optionOf('funnel', { showLabels: false, sortOrder: 'ascending' })
assert.equal(funnel.series[0].label.show, false)
assert.equal(funnel.series[0].sort, 'ascending')

const radar = optionOf('radar', { radarShape: 'circle', areaOpacity: 0.6 })
assert.equal(radar.radar.shape, 'circle')
assert.match(radar.series[0].areaStyle.color, /0\.6\)$/)

const scatter = optionOf('scatter', { symbolSize: 18, showLabels: true })
assert.equal(scatter.series[0].symbolSize, 18)
assert.equal(scatter.series[0].label.show, true)

const treemap = optionOf('treemap', { showLabels: false, itemGap: 7 })
assert.equal(treemap.series[0].label.show, false)
assert.equal(treemap.series[0].itemStyle.gapWidth, 7)

const combo = optionOf('combo', { smooth: false, showSymbols: false, barWidth: 28 })
assert.equal(combo.series[0].barMaxWidth, 28)
assert.equal(combo.series[1].smooth, false)
assert.equal(combo.series[1].symbol, 'none')

const matrix = markupOf('data-matrix', { showStatusLegend: false }, {
  kind: 'data-matrix',
  leadingLabel: '对象',
  columns: ['证据'],
  rows: [{ id: 'row-1', label: '过程域', cells: [{ id: 'cell-1', label: '充分' }] }],
  legend: [{ label: '唯一图例文字', tone: 'success' }]
})
assert.doesNotMatch(matrix, /唯一图例文字/)

const description = markupOf('description-list', { showStatus: false }, {
  kind: 'description-list',
  heading: '详情标题',
  status: { label: '唯一状态文字', tone: 'warning' },
  fields: [{ id: 'field-1', label: '责任人', value: '测试人员' }]
})
assert.match(description, /详情标题/)
assert.doesNotMatch(description, /唯一状态文字/)

const comparison = markupOf('comparison-bars', { maxItems: 1, showValues: false }, {
  kind: 'comparison-bars',
  valueLabel: '实际值标签',
  secondaryLabel: '基准值标签',
  items: [
    { id: 'item-1', label: '第一项', value: 10, secondaryValue: 8 },
    { id: 'item-2', label: '第二项', value: 20, secondaryValue: 18 }
  ]
})
assert.match(comparison, /实际值标签/)
assert.match(comparison, /基准值标签/)
assert.match(comparison, /第一项/)
assert.doesNotMatch(comparison, /第二项/)

assert.deepEqual(
  dashboardComponentStyleForType('line', {
    smooth: false,
    showArea: false,
    showStatus: false,
    titleFontSize: 12
  }),
  { smooth: false, showArea: false, titleFontSize: 12 },
  '组件类型切换必须移除目标类型不支持的陈旧专属字段'
)

const unsupportedOptionSpec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'unsupported-option-audit',
  title: '不支持配置校验',
  subtitle: 'validator regression',
  businessContext: { audience: '测试人员', objective: '验证配置', scopeDescription: 'inline fixture' },
  theme: 'technology-dark',
  updatedAt: '2026-08-30T00:00:00.000Z',
  components: [componentOf('line', { showStatus: false })]
}
assert.ok(
  validateDashboardSpec(unsupportedOptionSpec, undefined, { allowInlineData: true })
    .some((error) => error.includes('不支持专属配置 style.showStatus')),
  '检查功能必须报告组件类型不支持的专属配置'
)

console.log(JSON.stringify({
  ok: true,
  componentTypes,
  checks: componentTypes.length * 2 + 2
}, null, 2))
