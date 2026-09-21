import {
  ArrowRightOutlined,
  ArrowUpOutlined,
  BulbOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  FileTextOutlined,
  InfoCircleFilled,
  WarningFilled
} from '@ant-design/icons'
import { Button, Empty, Progress } from 'antd'
import { TreemapChart } from 'echarts/charts'
import * as echarts from 'echarts/core'
import { memo, useEffect, useMemo, useState } from 'react'
import type {
  DashboardComponentSpec,
  DashboardDescriptionListContent,
  DashboardComparisonBarsContent,
  DashboardDataMatrixContent,
  DashboardStatusTone,
  DashboardThemeId
} from '../../../shared/dashboard'
import { dashboardComponentOptionValue } from '../../../shared/dashboard-component-options'
import LightweightECharts from '../components/LightweightECharts'

// LightweightECharts owns the common chart registrations.  Treemap is a
// dashboard-only P1 chart, so register the optional series at this boundary
// without broadening the shared bridge bundle.
echarts.use([TreemapChart])

type ChartThemeTokens = {
  textColor: string
  gridColor: string
  tooltipBackground: string
  tooltipBorder: string
  tooltipTextColor: string
  pieBorderColor: string
  palette: string[]
}

const chartThemeTokens: Record<DashboardThemeId, ChartThemeTokens> = {
  'technology-dark': {
    textColor: '#8fa2bf',
    gridColor: 'rgba(139, 164, 198, 0.12)',
    tooltipBackground: 'rgba(8, 19, 38, 0.94)',
    tooltipBorder: 'rgba(104, 218, 255, 0.35)',
    tooltipTextColor: '#e9f4ff',
    pieBorderColor: '#111c30',
    palette: ['#64dbff', '#8d7cff', '#50dda4', '#ffc568', '#ff7f9d', '#6c9cff']
  },
  'business-light': {
    textColor: '#667b91',
    gridColor: 'rgba(74, 111, 147, 0.16)',
    tooltipBackground: 'rgba(27, 46, 68, 0.96)',
    tooltipBorder: 'rgba(91, 151, 204, 0.55)',
    tooltipTextColor: '#f5f9fd',
    pieBorderColor: '#f4f8fc',
    palette: ['#3479b9', '#3ba29c', '#d99545', '#7187d3', '#d1667c', '#6e9b69']
  },
  'charcoal-dark': {
    textColor: '#aaa49a',
    gridColor: 'rgba(202, 190, 166, 0.14)',
    tooltipBackground: 'rgba(34, 32, 29, 0.96)',
    tooltipBorder: 'rgba(224, 179, 111, 0.48)',
    tooltipTextColor: '#f5efe5',
    pieBorderColor: '#232323',
    palette: ['#e0b36f', '#9bbd9a', '#d68a7e', '#9a9ed6', '#c7a4c7', '#7da9b1']
  },
  'minimal-light': {
    textColor: '#718086',
    gridColor: 'rgba(86, 125, 123, 0.14)',
    tooltipBackground: 'rgba(35, 54, 56, 0.96)',
    tooltipBorder: 'rgba(97, 181, 169, 0.52)',
    tooltipTextColor: '#f4fffd',
    pieBorderColor: 'rgba(46, 155, 144, 0.12)',
    palette: ['#2e9b90', '#e0a15b', '#7089d3', '#cf7184', '#82aa76', '#4a9cbb']
  }
}

const hexToRgba = (color: string, alpha: number): string => {
  const normalized = color.replace('#', '')
  if (![3, 6].includes(normalized.length) || !/^[0-9a-f]+$/i.test(normalized)) {
    return `rgba(100, 219, 255, ${alpha})`
  }
  const value = normalized.length === 3
    ? normalized.split('').map((item) => `${item}${item}`).join('')
    : normalized
  const red = Number.parseInt(value.slice(0, 2), 16)
  const green = Number.parseInt(value.slice(2, 4), 16)
  const blue = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

const formatNumber = (value: number, decimalPlaces = 1): string =>
  new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: decimalPlaces
  }).format(value)

const toneIcon = (tone: DashboardStatusTone): React.JSX.Element => {
  if (tone === 'success') return <CheckCircleFilled />
  if (tone === 'warning') return <WarningFilled />
  if (tone === 'error') return <ExclamationCircleFilled />
  if (tone === 'info') return <InfoCircleFilled />
  return <FileTextOutlined />
}

const fallbackDataMatrixContent = (
  component: DashboardComponentSpec
): DashboardDataMatrixContent => ({
  kind: 'data-matrix',
  leadingLabel: component.encoding?.label ?? '对象',
  columns: [component.encoding?.value ?? '数值'],
  rows: component.data.map((item, index) => ({
    id: `${component.id}-row-${index}`,
    label: item.name,
    cells: [{
      id: `${component.id}-cell-${index}`,
      label: formatNumber(item.value),
      tone: 'neutral'
    }]
  }))
})

function DataMatrixPrimitive({
  component,
  selectionByChannel,
  onSelectionChange
}: {
  component: DashboardComponentSpec
  selectionByChannel?: Record<string, string>
  onSelectionChange?: (channel: string, selectionId: string) => void
}): React.JSX.Element {
  const content = component.content?.kind === 'data-matrix'
    ? component.content
    : fallbackDataMatrixContent(component)
  const [localSelectedRowId, setLocalSelectedRowId] = useState(
    content.selectedRowId ?? content.rows[0]?.id ?? ''
  )
  const [page, setPage] = useState(1)
  const pageSize = Math.max(3, Math.min(20, content.pageSize ?? 8))
  const pageCount = Math.max(1, Math.ceil(content.rows.length / pageSize))
  const channelSelection = content.selectionChannel
    ? selectionByChannel?.[content.selectionChannel]
    : undefined
  const selectedRowId = channelSelection ?? localSelectedRowId
  const visibleRows = content.rows.slice((page - 1) * pageSize, page * pageSize)
  const expansionMode = content.expansionMode ?? 'inline'

  useEffect(() => {
    if (content.rows.some((row) => row.id === selectedRowId)) return
    setLocalSelectedRowId(content.selectedRowId ?? content.rows[0]?.id ?? '')
  }, [content.rows, content.selectedRowId, selectedRowId])

  useEffect(() => {
    const selectedIndex = content.rows.findIndex((row) => row.id === selectedRowId)
    if (selectedIndex >= 0) setPage(Math.floor(selectedIndex / pageSize) + 1)
  }, [content.rows, pageSize, selectedRowId])

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount))
  }, [pageCount])

  const selectRow = (rowId: string): void => {
    setLocalSelectedRowId(rowId)
    if (content.selectionChannel) onSelectionChange?.(content.selectionChannel, rowId)
  }

  return (
    <div className="viz-data-matrix">
      {content.legend?.length && dashboardComponentOptionValue(
        component.type,
        component.style,
        'showStatusLegend'
      ) !== false ? (
        <div className="viz-status-legend" aria-label="状态图例">
          {content.legend.map((item) => (
            <span className={`tone-${item.tone}`} key={`${item.label}-${item.tone}`}>
              {toneIcon(item.tone)} {item.label}
            </span>
          ))}
        </div>
      ) : null}
      <div className="viz-data-matrix-scroll">
        <table aria-label={`${component.title}矩阵`}>
          <thead>
            <tr>
              <th scope="col">{content.leadingLabel}</th>
              {content.columns.map((column, index) => (
                <th scope="col" key={`${column}-${index}`}>
                  <span>{column}</span>
                  {index < content.columns.length - 1 ? <ArrowRightOutlined aria-hidden="true" /> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => {
              const selected = row.id === selectedRowId
              return [
                <tr className={selected ? 'is-selected' : ''} key={row.id}>
                  <th scope="row">
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectRow(row.id)}
                    >
                      <span className={`tone-${row.tone ?? 'info'}`}>{toneIcon(row.tone ?? 'info')}</span>
                      <span><strong>{row.label}</strong>{row.caption ? <small>{row.caption}</small> : null}</span>
                    </button>
                  </th>
                  {content.columns.map((_, index) => {
                    const cell = row.cells[index]
                    return (
                      <td key={cell?.id ?? `${row.id}-empty-${index}`}>
                        {cell ? (
                          <span className={`viz-matrix-cell tone-${cell.tone ?? 'neutral'}`}>
                            {toneIcon(cell.tone ?? 'neutral')}
                            <span><strong>{cell.label}</strong>{cell.caption ? <small>{cell.caption}</small> : null}</span>
                            {cell.value ? <em>{cell.value}</em> : null}
                          </span>
                        ) : <span className="viz-matrix-cell is-empty">—</span>}
                      </td>
                    )
                  })}
                </tr>,
                selected && row.expanded && expansionMode === 'inline' ? (
                  <tr className="viz-matrix-expanded" key={`${row.id}-expanded`}>
                    <td colSpan={content.columns.length + 1}>
                      <div>
                        <strong>{row.expanded.label}</strong>
                        <span className="viz-matrix-expanded-nodes">
                          {row.expanded.nodes.map((node, index) => (
                            <span className={`viz-matrix-node tone-${node.tone ?? 'neutral'}`} key={node.id}>
                              {toneIcon(node.tone ?? 'neutral')}
                              <span><strong>{node.label}</strong>{node.caption ? <small>{node.caption}</small> : null}</span>
                              {index < row.expanded!.nodes.length - 1 ? <ArrowRightOutlined aria-hidden="true" /> : null}
                            </span>
                          ))}
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : null
              ]
            })}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <div className="viz-data-matrix-pager" aria-label="矩阵分页">
          <span>第 {page} / {pageCount} 页 · 共 {content.rows.length} 条</span>
          <span>
            <Button
              type="text"
              size="small"
              aria-label="上一页"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </Button>
            <Button
              type="text"
              size="small"
              aria-label="下一页"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              下一页
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  )
}

const fallbackDescriptionContent = (
  component: DashboardComponentSpec
): DashboardDescriptionListContent => ({
  kind: 'description-list',
  heading: component.data[0]?.name,
  fields: component.data.map((item, index) => ({
    id: `${component.id}-field-${index}`,
    label: item.name,
    value: `${formatNumber(item.value)}${component.unit ?? ''}`
  }))
})

function DescriptionListPrimitive({
  component,
  selectionByChannel
}: {
  component: DashboardComponentSpec
  selectionByChannel?: Record<string, string>
}): React.JSX.Element {
  const baseContent = component.content?.kind === 'description-list'
    ? component.content
    : fallbackDescriptionContent(component)
  const selectedVariant = baseContent.selectionChannel
    ? baseContent.variants?.find((variant) =>
      variant.selectionId === selectionByChannel?.[baseContent.selectionChannel!]
    )
    : undefined
  const content = selectedVariant
    ? { ...baseContent, ...selectedVariant, kind: 'description-list' as const }
    : baseContent
  const showStatus = dashboardComponentOptionValue(component.type, component.style, 'showStatus') !== false
  return (
    <div className="viz-description-list">
      {(content.heading || (showStatus && content.status)) && (
        <div className="viz-description-heading">
          <strong>{content.heading}</strong>
          {showStatus && content.status ? (
            <span className={`tone-${content.status.tone}`}>
              {toneIcon(content.status.tone)} {content.status.label}
            </span>
          ) : null}
        </div>
      )}
      {content.sections?.map((section) => (
        <section className={`tone-${section.tone ?? 'neutral'}`} key={section.id}>
          <span>{section.label}</span>
          <p>{section.value}</p>
          {section.help ? <small>{section.help}</small> : null}
        </section>
      ))}
      <dl>
        {content.fields.map((field) => (
          <div key={field.id}>
            <dt>{field.label}</dt>
            <dd className={`tone-${field.tone ?? 'neutral'}`}>{field.value}</dd>
          </div>
        ))}
      </dl>
      {content.summary ? (
        <section className={`viz-description-summary tone-${content.summary.tone ?? 'neutral'}`}>
          <span>{content.summary.label}</span>
          <p>{content.summary.value}</p>
        </section>
      ) : null}
    </div>
  )
}

const fallbackComparisonBarsContent = (
  component: DashboardComponentSpec
): DashboardComparisonBarsContent => ({
  kind: 'comparison-bars',
  items: component.data.map((item, index) => ({
    id: `${component.id}-interval-${index}`,
    label: item.name,
    value: item.value,
    secondaryValue: item.secondaryValue,
    unit: component.unit
  }))
})

function ComparisonBarsPrimitive({
  component
}: {
  component: DashboardComponentSpec
}): React.JSX.Element {
  const content = component.content?.kind === 'comparison-bars'
    ? component.content
    : fallbackComparisonBarsContent(component)
  const maxItems = Number(dashboardComponentOptionValue(component.type, component.style, 'maxItems'))
  const showValues = dashboardComponentOptionValue(component.type, component.style, 'showValues') !== false
  const items = content.items.slice(0, maxItems)
  const maximum = Math.max(...items.map((item) => item.value), 1)
  return (
    <div className="viz-comparison-bars" role="list" aria-label={component.title}>
      <div className="viz-comparison-bars-legend" aria-label="比较指标名称">
        <span>{content.valueLabel ?? '当前值'}</span>
        <span>{content.secondaryLabel ?? '对比值'}</span>
      </div>
      {items.map((item) => (
        <div className={`tone-${item.tone ?? 'info'}`} key={item.id} role="listitem">
          <span title={item.label}>{item.label}</span>
          <i aria-hidden="true"><b style={{ width: `${Math.max(4, item.value / maximum * 100)}%` }} /></i>
          <strong aria-label={`${content.valueLabel ?? '数值'} ${formatNumber(item.value)}${item.unit ?? ''}`}>
            {showValues ? `${formatNumber(item.value)}${item.unit ?? ''}` : ''}
          </strong>
          <em>
            {!showValues || item.secondaryValue === undefined
              ? '—'
              : `${formatNumber(item.secondaryValue)}${item.secondaryUnit ?? ''}`}
          </em>
        </div>
      ))}
    </div>
  )
}

export const buildDashboardChartOption = (
  component: DashboardComponentSpec,
  themeId: DashboardThemeId
): Record<string, unknown> => {
  const theme = chartThemeTokens[themeId]
  const sortOrder = dashboardComponentOptionValue(component.type, component.style, 'sortOrder')
  const chartData = sortOrder === 'ascending' || sortOrder === 'descending'
    ? [...component.data].sort((left, right) => sortOrder === 'ascending'
      ? left.value - right.value
      : right.value - left.value)
    : component.data
  const names = chartData.map((item) => item.name)
  const axisNames = (component.type === 'line' || component.type === 'combo')
    ? names.map((name) => {
        const isoDate = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(name)
        return isoDate ? `${isoDate[2]}-${isoDate[3]}` : name
      })
    : names
  const values = chartData.map((item) => item.value)
  const secondaryValues = chartData.some((item) => item.secondaryValue !== undefined)
    ? chartData.map((item) => item.secondaryValue ?? 0)
    : undefined
  const accent = component.accent ?? theme.palette[0]
  const componentStyle = component.style ?? {}
  const showLegend = componentStyle.showLegend ?? true
  const showGrid = componentStyle.showGrid ?? true
  const lineWidth = componentStyle.lineWidth ?? 3
  const horizontalBar = component.type === 'bar' && componentStyle.orientation !== 'vertical'
  const showLabels = dashboardComponentOptionValue(component.type, component.style, 'showLabels') === true
  const common = {
    animationDuration: 500,
    color: component.accent
      ? [component.accent, ...theme.palette.filter((item) => item !== component.accent)]
      : theme.palette,
    tooltip: {
      trigger: component.type === 'pie' ? 'item' : 'axis',
      confine: true,
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      textStyle: { color: theme.tooltipTextColor }
    }
  }

  if (component.type === 'pie') {
    const compact = component.layout.w < 8
    const legendPosition = dashboardComponentOptionValue(component.type, component.style, 'legendPosition')
    const legendAtRight = legendPosition === 'right' && !compact
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: '{b}<br/>{c} 条 · {d}%' },
      legend: {
        show: showLegend,
        orient: legendAtRight ? 'vertical' : 'horizontal',
        right: legendAtRight ? 4 : 'center',
        bottom: legendPosition === 'bottom' || compact ? 0 : 'auto',
        top: legendPosition === 'top' && !compact ? 0 : legendAtRight ? 'middle' : 'auto',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
      },
      series: [
        {
          type: 'pie',
          radius: componentStyle.donut === false ? ['0%', '72%'] : ['48%', '72%'],
          center: compact ? ['50%', '43%'] : legendAtRight ? ['36%', '53%'] : ['50%', '53%'],
          data: chartData,
          label: { show: showLabels, color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 },
          itemStyle: {
            borderWidth: 3,
            borderColor: theme.pieBorderColor,
            borderRadius: 5
          }
        }
      ]
    }
  }

  if (component.type === 'gauge') {
    const minimumValue = Number(dashboardComponentOptionValue(component.type, component.style, 'minimumValue'))
    const maximumValue = Number(dashboardComponentOptionValue(component.type, component.style, 'maximumValue'))
    const safeMaximumValue = maximumValue > minimumValue ? maximumValue : minimumValue + 1
    const showPointer = dashboardComponentOptionValue(component.type, component.style, 'showPointer') !== false
    return {
      ...common,
      series: [{
        type: 'gauge',
        min: minimumValue,
        max: safeMaximumValue,
        progress: { show: true, width: 12, itemStyle: { color: accent } },
        axisLine: { lineStyle: { width: 12, color: [[1, theme.gridColor]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: showPointer, itemStyle: { color: accent } },
        detail: {
          valueAnimation: true,
          color: theme.tooltipTextColor,
          fontSize: componentStyle.valueFontSize ?? 26,
          offsetCenter: [0, '12%']
        },
        data: [{
          value: Math.max(minimumValue, Math.min(safeMaximumValue, component.data[0]?.value ?? 0)),
          name: component.unit ?? '%'
        }]
      }]
    }
  }

  if (component.type === 'funnel') {
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item' },
      series: [{
        type: 'funnel',
        orient: componentStyle.orientation ?? 'vertical',
        left: '8%',
        right: '8%',
        top: 8,
        bottom: 8,
        minSize: '12%',
        maxSize: '92%',
        sort: sortOrder === 'ascending' ? 'ascending' : sortOrder === 'none' ? 'none' : 'descending',
        gap: 3,
        label: { show: showLabels, color: theme.tooltipTextColor, fontSize: componentStyle.bodyFontSize ?? 10 },
        itemStyle: { borderColor: theme.tooltipBackground, borderWidth: 1 },
        data: chartData.map((item) => ({ name: item.name, value: item.value }))
      }]
    }
  }

  if (component.type === 'radar') {
    const maxValue = Math.max(...component.data.map((item) => item.value), 1)
    return {
      ...common,
      radar: {
        shape: dashboardComponentOptionValue(component.type, component.style, 'radarShape'),
        indicator: component.data.map((item) => ({ name: item.name, max: maxValue })),
        axisName: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 },
        splitArea: { areaStyle: { color: ['rgba(255,255,255,0.03)', 'rgba(255,255,255,0.01)'] } },
        splitLine: { lineStyle: { color: theme.gridColor } },
        axisLine: { lineStyle: { color: theme.gridColor } }
      },
      series: [{
        type: 'radar',
        data: [{ value: component.data.map((item) => item.value), name: component.encoding?.value ?? '指标' }],
        lineStyle: { width: lineWidth, color: accent },
        areaStyle: {
          color: hexToRgba(
            accent,
            Number(dashboardComponentOptionValue(component.type, component.style, 'areaOpacity'))
          )
        },
        itemStyle: { color: accent }
      }]
    }
  }

  if (component.type === 'treemap') {
    return {
      ...common,
      tooltip: {
        ...common.tooltip,
        trigger: 'item',
        formatter: '{b}<br/>{c}'
      },
      series: [{
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        squareRatio: 1.15,
        data: component.data.map((item) => ({ name: item.name, value: item.value })),
        label: {
          show: showLabels,
          color: theme.tooltipTextColor,
          fontSize: componentStyle.bodyFontSize ?? 10,
          overflow: 'truncate'
        },
        upperLabel: { show: false },
        itemStyle: {
          borderColor: theme.tooltipBackground,
          borderWidth: 1,
          gapWidth: Number(dashboardComponentOptionValue(component.type, component.style, 'itemGap'))
        },
        emphasis: {
          label: { color: theme.tooltipTextColor },
          itemStyle: { borderColor: theme.tooltipBorder, borderWidth: 2 }
        }
      }]
    }
  }

  if (component.type === 'combo') {
    const compact = component.layout.w <= 10
    const valueName = component.encoding?.value ?? '指标'
    const secondaryName = component.encoding?.secondaryValue ?? '对比指标'
    const comboSecondaryValues = secondaryValues ?? component.data.map(() => 0)
    const axisLabel = {
      color: theme.textColor,
      fontSize: componentStyle.bodyFontSize ?? 10,
      interval: compact || names.length > 8 ? 'auto' : 0,
      rotate: compact || names.length > 8 ? 28 : 0,
      hideOverlap: true
    }
    const valueAxis = {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: showGrid, lineStyle: { color: theme.gridColor } },
      axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
    }
    return {
      ...common,
      tooltip: {
        ...common.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'cross' }
      },
      legend: {
        show: showLegend,
        top: 0,
        right: 4,
        itemWidth: 10,
        itemHeight: 8,
        textStyle: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 },
        data: [valueName, secondaryName]
      },
      grid: {
        left: compact ? 8 : 12,
        right: compact ? 8 : 16,
        top: showLegend ? 24 : 8,
        bottom: compact || names.length > 8 ? 30 : 14,
        containLabel: true
      },
      xAxis: {
        type: 'category',
        data: axisNames,
        boundaryGap: true,
        axisLine: { lineStyle: { color: theme.gridColor } },
        axisTick: { show: false },
        axisLabel
      },
      yAxis: [
        { ...valueAxis, name: compact ? undefined : valueName },
        {
          ...valueAxis,
          name: compact ? undefined : secondaryName,
          splitLine: { show: false },
          axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
        }
      ],
      series: [
        {
          name: valueName,
          type: 'bar',
          yAxisIndex: 0,
          data: values,
          barMaxWidth: Number(dashboardComponentOptionValue(component.type, component.style, 'barWidth')),
          itemStyle: { color: accent, borderRadius: [4, 4, 0, 0] }
        },
        {
          name: secondaryName,
          type: 'line',
          yAxisIndex: 1,
          data: comboSecondaryValues,
          smooth: dashboardComponentOptionValue(component.type, component.style, 'smooth') !== false,
          symbol: dashboardComponentOptionValue(component.type, component.style, 'showSymbols') === false ? 'none' : 'circle',
          symbolSize: compact ? 5 : 6,
          lineStyle: { width: lineWidth, color: theme.palette[1] },
          itemStyle: { color: theme.palette[1] }
        }
      ]
    }
  }

  if (component.type === 'scatter') {
    const axis = {
      type: 'value',
      axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 },
      splitLine: { show: showGrid, lineStyle: { color: theme.gridColor } }
    }
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item' },
      xAxis: axis,
      yAxis: axis,
      series: [{
        type: 'scatter',
        symbolSize: Number(dashboardComponentOptionValue(component.type, component.style, 'symbolSize')),
        label: {
          show: showLabels,
          formatter: (params: { data?: [number, number, string] }) => params.data?.[2] ?? '',
          color: theme.textColor,
          fontSize: componentStyle.bodyFontSize ?? 10
        },
        data: chartData.map((item) => [item.value, item.secondaryValue ?? item.value, item.name]),
        itemStyle: { color: accent }
      }]
    }
  }

  return {
    ...common,
    ...(secondaryValues && showLegend ? {
      legend: {
        top: 0,
        right: 4,
        textStyle: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 },
        data: [component.encoding?.value ?? '指标', component.encoding?.secondaryValue ?? '对比指标']
      }
    } : {}),
    grid: { left: 8, right: 10, top: showLegend && secondaryValues ? 18 : 4, bottom: 2, containLabel: true },
    xAxis: horizontalBar
      ? {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: showGrid, lineStyle: { color: theme.gridColor } },
          axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
        }
      : {
          type: 'category',
          data: axisNames,
          boundaryGap: component.type === 'bar',
          axisLine: { lineStyle: { color: theme.gridColor } },
          axisTick: { show: false },
          axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
        },
    yAxis: horizontalBar
      ? {
          type: 'category',
          data: names,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: {
            color: theme.textColor,
            fontSize: componentStyle.bodyFontSize ?? 10,
            width: 78,
            overflow: 'truncate'
          }
        }
      : {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { show: showGrid, lineStyle: { color: theme.gridColor } },
          axisLabel: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
        },
    series: (component.type === 'bar'
      ? [
          {
            name: component.encoding?.value ?? '指标',
            type: 'bar',
            data: values,
            barMaxWidth: Number(dashboardComponentOptionValue(component.type, component.style, 'barWidth')),
            label: { show: showLabels, position: 'right', color: theme.textColor },
            itemStyle: {
              color: accent,
              borderRadius: horizontalBar ? [0, 5, 5, 0] : [5, 5, 0, 0]
            }
          },
          ...(secondaryValues ? [{
            name: component.encoding?.secondaryValue ?? '对比指标',
            type: 'bar',
            data: secondaryValues,
            barMaxWidth: Number(dashboardComponentOptionValue(component.type, component.style, 'barWidth')),
            label: { show: showLabels, position: 'right', color: theme.textColor },
            itemStyle: {
              color: theme.palette[1],
              borderRadius: horizontalBar ? [0, 5, 5, 0] : [5, 5, 0, 0]
            }
          }] : [])
        ]
      : [
          {
            name: component.encoding?.value ?? '指标',
            type: 'line',
            data: values,
            smooth: dashboardComponentOptionValue(component.type, component.style, 'smooth') !== false,
            symbol: dashboardComponentOptionValue(component.type, component.style, 'showSymbols') === false ? 'none' : 'circle',
            symbolSize: 6,
            lineStyle: { width: lineWidth, color: accent },
            itemStyle: { color: accent },
            areaStyle: dashboardComponentOptionValue(component.type, component.style, 'showArea') === false ? undefined : {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: hexToRgba(accent, 0.3) },
                  { offset: 1, color: hexToRgba(accent, 0.01) }
                ]
              }
            }
          },
          ...(secondaryValues ? [{
            name: component.encoding?.secondaryValue ?? '对比指标',
            type: 'line',
            data: secondaryValues,
            smooth: dashboardComponentOptionValue(component.type, component.style, 'smooth') !== false,
            symbol: dashboardComponentOptionValue(component.type, component.style, 'showSymbols') === false ? 'none' : 'circle',
            symbolSize: 5,
            lineStyle: { width: 2, color: theme.palette[1] },
            itemStyle: { color: theme.palette[1] }
          }] : [])
        ])
  }

}

export function DashboardComponentRendererView({
  component,
  theme = 'technology-dark',
  selectionByChannel,
  onSelectionChange
}: {
  component: DashboardComponentSpec
  theme?: DashboardThemeId
  selectionByChannel?: Record<string, string>
  onSelectionChange?: (channel: string, selectionId: string) => void
}): React.JSX.Element {
  const first = component.data[0]
  const chartOption = useMemo(
    () => buildDashboardChartOption(component, theme),
    [component, theme]
  )

  if (!component.data.length) {
    return (
      <div role="status" aria-label={`${component.title}暂无数据`}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
      </div>
    )
  }

  if (component.type === 'kpi') {
    const decimalPlaces = Number(dashboardComponentOptionValue(component.type, component.style, 'decimalPlaces'))
    const showStatus = dashboardComponentOptionValue(component.type, component.style, 'showStatus') !== false
    return (
      <div
        className="viz-kpi"
        role="img"
        aria-label={`${component.title}：${formatNumber(first.value, decimalPlaces)}${component.unit ?? ''}`}
      >
        <div className="viz-kpi-value" style={{ color: component.accent, fontSize: component.style?.valueFontSize }}>
          {formatNumber(first.value, decimalPlaces)}
          <small>{component.unit}</small>
        </div>
        {showStatus ? (
          <div className="viz-kpi-meta">
            <span><ArrowUpOutlined /> 数据已同步</span>
            <i style={{ background: component.accent }} />
          </div>
        ) : null}
      </div>
    )
  }

  if (component.type === 'progress') {
    const targetValue = Math.max(
      1,
      Number(dashboardComponentOptionValue(component.type, component.style, 'targetValue'))
    )
    const currentValue = Math.max(0, first.value)
    const percent = Math.max(0, Math.min(100, currentValue / targetValue * 100))
    const showValues = dashboardComponentOptionValue(component.type, component.style, 'showValues') !== false
    return (
      <div
        className="viz-progress"
        role="meter"
        aria-label={`${component.title}完成率 ${formatNumber(percent)}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <Progress
          percent={percent}
          strokeColor={component.accent ?? '#54dfa6'}
          railColor="rgba(126, 151, 185, 0.15)"
          format={() => null}
        />
        <div className="viz-progress-labels">
          <span>{showValues ? `当前 ${formatNumber(currentValue)}${component.unit ?? ''}` : '当前进度'}</span>
          <span>目标 {formatNumber(targetValue)}{component.unit ?? ''}</span>
        </div>
      </div>
    )
  }

  if (component.type === 'ranking') {
    const maxItems = Number(dashboardComponentOptionValue(component.type, component.style, 'maxItems'))
    const showIndex = dashboardComponentOptionValue(component.type, component.style, 'showIndex') !== false
    const showValues = dashboardComponentOptionValue(component.type, component.style, 'showValues') !== false
    const items = component.data.slice(0, maxItems)
    const max = Math.max(...items.map((item) => item.value), 1)
    return (
      <div
        className="viz-ranking"
        style={{ fontSize: component.style?.bodyFontSize }}
        role="list"
        aria-label={`${component.title}排行`}
      >
        {items.map((item, index) => (
          <div className="viz-ranking-row" key={`${item.name}-${index}`} role="listitem">
            {showIndex ? <span className={`viz-ranking-index rank-${index + 1}`}>{index + 1}</span> : null}
            <span className="viz-ranking-name" title={item.name}>{item.name}</span>
            <span className="viz-ranking-track">
            <i
              style={{
                width: `${(item.value / max) * 100}%`,
                background: component.accent ?? undefined
              }}
            />
            </span>
            <strong>{showValues ? formatNumber(item.value) : ''}</strong>
          </div>
        ))}
      </div>
    )
  }

  if (component.type === 'insight') {
    const showIcon = dashboardComponentOptionValue(component.type, component.style, 'showIcon') !== false
    return (
      <div className="viz-insight" role="note" aria-label={`${component.title}洞察`}>
        {showIcon ? <span className="viz-insight-icon"><BulbOutlined /></span> : null}
        <p style={{ fontSize: component.style?.bodyFontSize }}>{component.insight}</p>
      </div>
    )
  }

  if (component.type === 'table') {
    const maxItems = Number(dashboardComponentOptionValue(component.type, component.style, 'maxItems'))
    const showIndex = dashboardComponentOptionValue(component.type, component.style, 'showIndex') === true
    const showValues = dashboardComponentOptionValue(component.type, component.style, 'showValues') !== false
    return (
      <div className="viz-table" style={{ fontSize: component.style?.bodyFontSize }} role="table" aria-label={`${component.title}明细`}>
        {component.data.slice(0, maxItems).map((item, index) => (
          <div key={item.name} role="row">
            {showIndex ? <i aria-label={`第 ${index + 1} 行`}>{index + 1}</i> : null}
            <span>{item.name}</span>
            <strong>{showValues ? formatNumber(item.value) : ''}</strong>
          </div>
        ))}
      </div>
    )
  }

  if (component.type === 'data-matrix') {
    return (
      <DataMatrixPrimitive
        component={component}
        selectionByChannel={selectionByChannel}
        onSelectionChange={onSelectionChange}
      />
    )
  }

  if (component.type === 'description-list') {
    return <DescriptionListPrimitive component={component} selectionByChannel={selectionByChannel} />
  }

  if (component.type === 'comparison-bars') {
    return <ComparisonBarsPrimitive component={component} />
  }

  return (
    <div
      className="dashboard-chart-visual"
      style={{ width: '100%', height: '100%', minHeight: 0 }}
      role="img"
      aria-label={`${component.title}图表，${component.data.length}项数据。${component.data
        .slice(0, 3)
        .map((item) => `${item.name}${formatNumber(item.value)}${component.unit ?? ''}`)
        .join('；')}`}
    >
      <LightweightECharts
        key={`${component.id}-${component.layout.w}-${component.layout.h}`}
        option={chartOption}
        notMerge
        lazyUpdate
        aria-hidden="true"
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  )
}

export const DashboardComponentRenderer = memo(DashboardComponentRendererView)
