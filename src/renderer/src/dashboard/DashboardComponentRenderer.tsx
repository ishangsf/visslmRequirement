import { ArrowUpOutlined, BulbOutlined } from '@ant-design/icons'
import { Empty, Progress } from 'antd'
import ReactECharts from 'echarts-for-react'
import type { DashboardComponentSpec } from '../../../shared/dashboard'

const chartTextColor = '#8fa2bf'
const chartGridColor = 'rgba(139, 164, 198, 0.12)'
const palette = ['#64dbff', '#8d7cff', '#50dda4', '#ffc568', '#ff7f9d', '#6c9cff']

const formatNumber = (value: number): string =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value)

const buildChartOption = (component: DashboardComponentSpec): Record<string, unknown> => {
  const names = component.data.map((item) => item.name)
  const values = component.data.map((item) => item.value)
  const common = {
    animationDuration: 500,
    color: palette,
    tooltip: {
      trigger: component.type === 'pie' ? 'item' : 'axis',
      confine: true,
      backgroundColor: 'rgba(8, 19, 38, 0.94)',
      borderColor: 'rgba(104, 218, 255, 0.35)',
      textStyle: { color: '#e9f4ff' }
    }
  }

  if (component.type === 'pie') {
    const compact = component.layout.w < 8
    return {
      ...common,
      tooltip: { ...common.tooltip, trigger: 'item', formatter: '{b}<br/>{c} 条 · {d}%' },
      legend: {
        orient: compact ? 'horizontal' : 'vertical',
        right: compact ? 'center' : 4,
        bottom: compact ? 0 : 'auto',
        top: compact ? 'auto' : 'middle',
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
        textStyle: { color: chartTextColor, fontSize: 10 }
      },
      series: [
        {
          type: 'pie',
          radius: ['48%', '72%'],
          center: compact ? ['50%', '43%'] : ['36%', '53%'],
          data: component.data,
          label: { show: false },
          itemStyle: {
            borderWidth: 3,
            borderColor: '#111c30',
            borderRadius: 5
          }
        }
      ]
    }
  }

  return {
    ...common,
    grid: { left: 8, right: 10, top: 18, bottom: 2, containLabel: true },
    xAxis: component.type === 'bar'
      ? {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: chartGridColor } },
          axisLabel: { color: chartTextColor, fontSize: 10 }
        }
      : {
          type: 'category',
          data: names,
          boundaryGap: false,
          axisLine: { lineStyle: { color: chartGridColor } },
          axisTick: { show: false },
          axisLabel: { color: chartTextColor, fontSize: 10 }
        },
    yAxis: component.type === 'bar'
      ? {
          type: 'category',
          data: names,
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: chartTextColor, fontSize: 10, width: 78, overflow: 'truncate' }
        }
      : {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          splitLine: { lineStyle: { color: chartGridColor } },
          axisLabel: { color: chartTextColor, fontSize: 10 }
        },
    series: [
      component.type === 'bar'
        ? {
            type: 'bar',
            data: values,
            barMaxWidth: 16,
            itemStyle: {
              color: component.accent ?? palette[0],
              borderRadius: [0, 5, 5, 0]
            }
          }
        : {
            type: 'line',
            data: values,
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            lineStyle: { width: 3, color: component.accent ?? palette[0] },
            itemStyle: { color: component.accent ?? palette[0] },
            areaStyle: {
              color: {
                type: 'linear',
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: 'rgba(100, 219, 255, 0.3)' },
                  { offset: 1, color: 'rgba(100, 219, 255, 0.01)' }
                ]
              }
            }
          }
    ]
  }
}

export function DashboardComponentRenderer({
  component
}: {
  component: DashboardComponentSpec
}): React.JSX.Element {
  const first = component.data[0]

  if (!component.data.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
  }

  if (component.type === 'kpi') {
    return (
      <div className="viz-kpi">
        <div className="viz-kpi-value" style={{ color: component.accent }}>
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
          trailColor="rgba(126, 151, 185, 0.15)"
          format={(value) => <span>{value}%</span>}
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
      <div className="viz-ranking">
        {component.data.map((item, index) => (
          <div className="viz-ranking-row" key={`${item.name}-${index}`}>
            <span className={`viz-ranking-index rank-${index + 1}`}>{index + 1}</span>
            <span className="viz-ranking-name" title={item.name}>{item.name}</span>
            <span className="viz-ranking-track">
              <i style={{ width: `${(item.value / max) * 100}%` }} />
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
        <p>{component.insight}</p>
      </div>
    )
  }

  if (component.type === 'table') {
    return (
      <div className="viz-table">
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
    <ReactECharts
      key={`${component.id}-${component.layout.w}-${component.layout.h}`}
      option={buildChartOption(component)}
      notMerge
      lazyUpdate
      style={{ width: '100%', height: '100%' }}
    />
  )
}
