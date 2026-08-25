import { ArrowUpOutlined, BulbOutlined } from '@ant-design/icons'
import { Empty, Progress } from 'antd'
import { memo, useMemo } from 'react'
import type { DashboardComponentSpec, DashboardThemeId } from '../../../shared/dashboard'
import LightweightECharts from '../components/LightweightECharts'

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
    pieBorderColor: '#ffffff',
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

const formatNumber = (value: number): string =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)

const buildChartOption = (
  component: DashboardComponentSpec,
  themeId: DashboardThemeId
): Record<string, unknown> => {
  const theme = chartThemeTokens[themeId]
  const names = component.data.map((item) => item.name)
  const values = component.data.map((item) => item.value)
  const secondaryValues = component.data.some((item) => item.secondaryValue !== undefined)
    ? component.data.map((item) => item.secondaryValue ?? 0)
    : undefined
  const accent = component.accent ?? theme.palette[0]
  const componentStyle = component.style ?? {}
  const showLegend = componentStyle.showLegend ?? true
  const showGrid = componentStyle.showGrid ?? true
  const lineWidth = componentStyle.lineWidth ?? 3
  const horizontalBar = component.type === 'bar' && componentStyle.orientation !== 'vertical'
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
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: '{b}<br/>{c} 条 · {d}%' },
      legend: {
        show: showLegend,
        orient: compact ? 'horizontal' : 'vertical',
        right: compact ? 'center' : 4,
        bottom: compact ? 0 : 'auto',
        top: compact ? 'auto' : 'middle',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: theme.textColor, fontSize: componentStyle.bodyFontSize ?? 10 }
      },
      series: [
        {
          type: 'pie',
          radius: componentStyle.donut === false ? ['0%', '72%'] : ['48%', '72%'],
          center: compact ? ['50%', '43%'] : ['36%', '53%'],
          data: component.data,
          label: { show: false },
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
    return {
      ...common,
      series: [{
        type: 'gauge',
        min: 0,
        max: 100,
        progress: { show: true, width: 12, itemStyle: { color: accent } },
        axisLine: { lineStyle: { width: 12, color: [[1, theme.gridColor]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { itemStyle: { color: accent } },
        detail: {
          valueAnimation: true,
          color: theme.tooltipTextColor,
          fontSize: componentStyle.valueFontSize ?? 26,
          offsetCenter: [0, '12%']
        },
        data: [{
          value: Math.max(0, Math.min(100, component.data[0]?.value ?? 0)),
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
        sort: 'descending',
        gap: 3,
        label: { color: theme.tooltipTextColor, fontSize: componentStyle.bodyFontSize ?? 10 },
        itemStyle: { borderColor: theme.tooltipBackground, borderWidth: 1 },
        data: component.data.map((item) => ({ name: item.name, value: item.value }))
      }]
    }
  }

  if (component.type === 'radar') {
    const maxValue = Math.max(...component.data.map((item) => item.value), 1)
    return {
      ...common,
      radar: {
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
        areaStyle: { color: hexToRgba(accent, 0.2) },
        itemStyle: { color: accent }
      }]
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
        symbolSize: 9,
        data: component.data.map((item) => [item.value, item.secondaryValue ?? item.value, item.name]),
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
          data: names,
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
            barMaxWidth: 16,
            itemStyle: {
              color: accent,
              borderRadius: horizontalBar ? [0, 5, 5, 0] : [5, 5, 0, 0]
            }
          },
          ...(secondaryValues ? [{
            name: component.encoding?.secondaryValue ?? '对比指标',
            type: 'bar',
            data: secondaryValues,
            barMaxWidth: 16,
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
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { width: lineWidth, color: accent },
            itemStyle: { color: accent },
            areaStyle: {
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
            smooth: true,
            symbol: 'circle',
            symbolSize: 5,
            lineStyle: { width: 2, color: theme.palette[1] },
            itemStyle: { color: theme.palette[1] }
          }] : [])
        ])
  }

}

function DashboardComponentRendererView({
  component,
  theme = 'technology-dark'
}: {
  component: DashboardComponentSpec
  theme?: DashboardThemeId
}): React.JSX.Element {
  const first = component.data[0]
  const chartOption = useMemo(
    () => buildChartOption(component, theme),
    [component, theme]
  )

  if (!component.data.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
  }

  if (component.type === 'kpi') {
    return (
      <div className="viz-kpi">
        <div className="viz-kpi-value" style={{ color: component.accent, fontSize: component.style?.valueFontSize }}>
          {formatNumber(first.value)}
          <small>{component.unit}</small>
        </div>
        <div className="viz-kpi-meta">
          <span><ArrowUpOutlined /> 数据已同步</span>
          <i style={{ background: component.accent }} />
        </div>
      </div>
    )
  }

  if (component.type === 'progress') {
    return (
      <div className="viz-progress">
        <Progress
          percent={Math.max(0, Math.min(100, first.value))}
          strokeColor={component.accent ?? '#54dfa6'}
          railColor="rgba(126, 151, 185, 0.15)"
          format={(value) => <span style={{ fontSize: component.style?.valueFontSize }}>{value}%</span>}
        />
        <div className="viz-progress-labels">
          <span>当前覆盖</span>
          <span>目标 100%</span>
        </div>
      </div>
    )
  }

  if (component.type === 'ranking') {
    const max = Math.max(...component.data.map((item) => item.value), 1)
    return (
      <div className="viz-ranking" style={{ fontSize: component.style?.bodyFontSize }}>
        {component.data.map((item, index) => (
          <div className="viz-ranking-row" key={`${item.name}-${index}`}>
            <span className={`viz-ranking-index rank-${index + 1}`}>{index + 1}</span>
            <span className="viz-ranking-name" title={item.name}>{item.name}</span>
            <span className="viz-ranking-track">
            <i
              style={{
                width: `${(item.value / max) * 100}%`,
                background: component.accent ?? undefined
              }}
            />
            </span>
            <strong>{formatNumber(item.value)}</strong>
          </div>
        ))}
      </div>
    )
  }

  if (component.type === 'insight') {
    return (
      <div className="viz-insight">
        <span className="viz-insight-icon"><BulbOutlined /></span>
        <p style={{ fontSize: component.style?.bodyFontSize }}>{component.insight}</p>
      </div>
    )
  }

  if (component.type === 'table') {
    return (
      <div className="viz-table" style={{ fontSize: component.style?.bodyFontSize }}>
        {component.data.map((item) => (
          <div key={item.name}>
            <span>{item.name}</span>
            <strong>{formatNumber(item.value)}</strong>
          </div>
        ))}
      </div>
    )
  }

  return (
    <LightweightECharts
      key={`${component.id}-${component.layout.w}-${component.layout.h}`}
      option={chartOption}
      notMerge
      lazyUpdate
      style={{ width: '100%', height: '100%' }}
    />
  )
}

export const DashboardComponentRenderer = memo(DashboardComponentRendererView)
