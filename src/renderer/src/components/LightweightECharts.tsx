import type { EChartsOption } from 'echarts'
import type { EChartsType, EChartsInitOpts, SetOptionOpts } from 'echarts/core'
import {
  BarChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart
} from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'
import {
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes
} from 'react'

echarts.use([
  BarChart,
  FunnelChart,
  GaugeChart,
  GraphChart,
  LineChart,
  PieChart,
  RadarChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
  SVGRenderer
])

export type LightweightEChartsProps = HTMLAttributes<HTMLDivElement> & {
  /** Keep the permissive option contract used by the previous React bridge. */
  option: unknown
  theme?: string | Record<string, unknown>
  notMerge?: boolean
  lazyUpdate?: boolean
  opts?: EChartsInitOpts
  onChartReady?: (instance: EChartsType) => void
  onEvents?: Record<string, (params: unknown) => void>
  autoResize?: boolean
}

const setOption = (
  chart: EChartsType,
  option: EChartsOption,
  notMerge: boolean,
  lazyUpdate: boolean
): void => {
  chart.setOption(option, { notMerge, lazyUpdate } satisfies SetOptionOpts)
}

/**
 * Small ECharts React bridge that registers only the chart/component types
 * used by VISSLM.  The previous React bridge imported the complete ECharts bundle,
 * which made both the first renderer chunk and the offline viewer larger than
 * necessary.  This bridge keeps the existing option/event API at the call
 * sites while allowing ECharts tree-shaking.
 */
export const LightweightECharts = ({
  option,
  theme,
  notMerge = false,
  lazyUpdate = false,
  opts,
  onChartReady,
  onEvents,
  autoResize = true,
  className,
  style,
  ...rest
}: LightweightEChartsProps): React.JSX.Element => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<EChartsType | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const chart = echarts.init(element, theme, opts)
    chartRef.current = chart
    onChartReady?.(chart)
    return () => {
      chart.dispose()
      if (chartRef.current === chart) chartRef.current = null
    }
  }, [theme, opts?.renderer, opts?.devicePixelRatio, opts?.width, opts?.height, opts?.locale])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    setOption(chart, option as EChartsOption, notMerge, lazyUpdate)
  }, [option, notMerge, lazyUpdate])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !onEvents) return undefined
    const entries = Object.entries(onEvents)
    entries.forEach(([eventName, handler]) => chart.on(eventName, handler))
    return () => {
      entries.forEach(([eventName, handler]) => chart.off(eventName, handler))
    }
  }, [onEvents])

  useEffect(() => {
    if (!autoResize) return undefined
    const chart = chartRef.current
    const element = containerRef.current
    if (!chart || !element) return undefined
    const resize = (): void => chart.resize()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(resize)
      observer.observe(element)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [autoResize])

  const mergedStyle: CSSProperties = { width: '100%', height: '100%', ...style }
  return <div ref={containerRef} className={className} style={mergedStyle} {...rest} />
}

export default LightweightECharts
