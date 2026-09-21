import type { DashboardComponentStyle, DashboardComponentType } from './dashboard'

export type DashboardComponentOptionKey =
  | 'decimalPlaces'
  | 'maxItems'
  | 'showLabels'
  | 'showValues'
  | 'smooth'
  | 'showArea'
  | 'showSymbols'
  | 'showIndex'
  | 'showStatus'
  | 'showStatusLegend'
  | 'targetValue'
  | 'showIcon'
  | 'minimumValue'
  | 'maximumValue'
  | 'showPointer'
  | 'symbolSize'
  | 'barWidth'
  | 'legendPosition'
  | 'sortOrder'
  | 'radarShape'
  | 'areaOpacity'
  | 'itemGap'

export type DashboardComponentOptionDefinition = {
  key: DashboardComponentOptionKey
  label: string
  control: 'boolean' | 'number' | 'select'
  defaultValue: boolean | number | string
  min?: number
  max?: number
  step?: number
  options?: Array<{ label: string; value: string }>
}

const booleanOption = (
  key: DashboardComponentOptionKey,
  label: string,
  defaultValue = true
): DashboardComponentOptionDefinition => ({ key, label, control: 'boolean', defaultValue })

const numberOption = (
  key: DashboardComponentOptionKey,
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step = 1
): DashboardComponentOptionDefinition => ({
  key,
  label,
  control: 'number',
  defaultValue,
  min,
  max,
  step
})

const selectOption = (
  key: DashboardComponentOptionKey,
  label: string,
  defaultValue: string,
  options: Array<{ label: string; value: string }>
): DashboardComponentOptionDefinition => ({ key, label, control: 'select', defaultValue, options })

const sortOptions = [
  { label: '保持原序', value: 'none' },
  { label: '数值升序', value: 'ascending' },
  { label: '数值降序', value: 'descending' }
]

/**
 * The single capability manifest for component-specific presentation controls.
 * These are visual primitives, not business widgets: every consumer must read
 * this manifest instead of maintaining a separate per-component allow-list.
 */
export const dashboardComponentOptionDefinitions: Record<
DashboardComponentType,
DashboardComponentOptionDefinition[]
> = {
  kpi: [
    numberOption('decimalPlaces', '小数位数', 1, 0, 4),
    booleanOption('showStatus', '显示状态说明')
  ],
  bar: [
    numberOption('barWidth', '柱条宽度', 16, 6, 40),
    booleanOption('showLabels', '显示数值标签', false),
    selectOption('sortOrder', '数据排序', 'none', sortOptions)
  ],
  line: [
    booleanOption('smooth', '平滑曲线'),
    booleanOption('showArea', '显示面积填充'),
    booleanOption('showSymbols', '显示数据点')
  ],
  pie: [
    booleanOption('showLabels', '显示扇区标签', false),
    selectOption('legendPosition', '图例位置', 'right', [
      { label: '顶部', value: 'top' },
      { label: '右侧', value: 'right' },
      { label: '底部', value: 'bottom' }
    ])
  ],
  ranking: [
    numberOption('maxItems', '最多显示项', 10, 1, 50),
    booleanOption('showIndex', '显示排名序号'),
    booleanOption('showValues', '显示数值')
  ],
  table: [
    numberOption('maxItems', '最多显示行', 20, 1, 100),
    booleanOption('showIndex', '显示行号', false),
    booleanOption('showValues', '显示数值')
  ],
  progress: [
    numberOption('targetValue', '目标值', 100, 1, 10000),
    booleanOption('showValues', '显示当前值')
  ],
  insight: [
    booleanOption('showIcon', '显示洞察图标')
  ],
  gauge: [
    numberOption('minimumValue', '最小值', 0, -100000, 100000),
    numberOption('maximumValue', '最大值', 100, -100000, 100000),
    booleanOption('showPointer', '显示指针')
  ],
  funnel: [
    booleanOption('showLabels', '显示阶段标签'),
    selectOption('sortOrder', '阶段排序', 'descending', sortOptions)
  ],
  radar: [
    selectOption('radarShape', '雷达形状', 'polygon', [
      { label: '多边形', value: 'polygon' },
      { label: '圆形', value: 'circle' }
    ]),
    numberOption('areaOpacity', '区域透明度', 0.2, 0, 0.8, 0.05)
  ],
  scatter: [
    numberOption('symbolSize', '散点大小', 9, 4, 30),
    booleanOption('showLabels', '显示点标签', false)
  ],
  treemap: [
    booleanOption('showLabels', '显示区块标签'),
    numberOption('itemGap', '区块间距', 3, 0, 12)
  ],
  combo: [
    booleanOption('smooth', '平滑折线'),
    booleanOption('showSymbols', '显示折线数据点'),
    numberOption('barWidth', '柱条宽度', 20, 6, 40)
  ],
  'data-matrix': [
    booleanOption('showStatusLegend', '显示状态图例')
  ],
  'description-list': [
    booleanOption('showStatus', '显示详情状态')
  ],
  'comparison-bars': [
    numberOption('maxItems', '最多显示项', 10, 1, 50),
    booleanOption('showValues', '显示数值')
  ]
}

export const dashboardComponentOptionKeys = new Set<DashboardComponentOptionKey>(
  Object.values(dashboardComponentOptionDefinitions).flat().map((item) => item.key)
)

export const dashboardComponentSupportsOption = (
  type: DashboardComponentType,
  key: string
): key is DashboardComponentOptionKey =>
  dashboardComponentOptionDefinitions[type].some((item) => item.key === key)

export const dashboardComponentOptionValue = <K extends DashboardComponentOptionKey>(
  type: DashboardComponentType,
  style: DashboardComponentStyle | undefined,
  key: K
): NonNullable<DashboardComponentStyle[K]> => {
  const definition = dashboardComponentOptionDefinitions[type].find((item) => item.key === key)
  return (style?.[key] ?? definition?.defaultValue) as NonNullable<DashboardComponentStyle[K]>
}

const commonStyleKeys = new Set<keyof DashboardComponentStyle>([
  'titleFontSize',
  'subtitleFontSize',
  'bodyFontSize',
  'borderRadius',
  'padding'
])

const legacyStyleKeysByType: Partial<Record<
DashboardComponentType,
Array<keyof DashboardComponentStyle>
>> = {
  kpi: ['valueFontSize'],
  progress: ['valueFontSize'],
  gauge: ['valueFontSize'],
  bar: ['showLegend', 'showGrid', 'orientation'],
  line: ['showLegend', 'showGrid', 'lineWidth'],
  pie: ['showLegend', 'donut'],
  funnel: ['showLegend', 'orientation'],
  radar: ['showLegend', 'lineWidth'],
  scatter: ['showGrid'],
  combo: ['showLegend', 'showGrid', 'lineWidth']
}

export const dashboardComponentStyleForType = (
  type: DashboardComponentType,
  style: DashboardComponentStyle | undefined
): DashboardComponentStyle | undefined => {
  if (!style) return undefined
  const allowed = new Set<keyof DashboardComponentStyle>([
    ...commonStyleKeys,
    ...(legacyStyleKeysByType[type] ?? []),
    ...dashboardComponentOptionDefinitions[type].map((item) => item.key)
  ])
  const entries = Object.entries(style).filter(([key]) =>
    allowed.has(key as keyof DashboardComponentStyle)
  )
  return entries.length ? Object.fromEntries(entries) as DashboardComponentStyle : undefined
}
