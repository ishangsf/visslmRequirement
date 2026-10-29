import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ConfigProvider, theme } from 'antd'
import { DashboardGrid } from './dashboard/DashboardGrid'
import type { DashboardSpec } from '../../shared/dashboard'
import type { DashboardRenderIssue, DashboardRenderPreview } from '../../shared/dashboard-generation'
import './styles.css'

const noop = () => undefined
let update: (spec: DashboardSpec) => void = noop
function Preview() {
  const [spec, setSpec] = useState<DashboardSpec>()
  update = setSpec
  if (!spec) return null
  const light = spec.theme.includes('light')
  document.documentElement.dataset.theme = light ? 'light' : 'dark'
  return <ConfigProvider theme={{ algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm }}>
    <main className={`dashboard-preview-shell theme-${spec.theme}`} style={{ width: '100vw', height: '100vh', padding: 0 }}>
      <div className="dashboard-preview is-full-preview" style={{ minHeight: 0 }}>
        <header className="dashboard-preview-header"><div className="dashboard-title-mark" /><div><h2>{spec.title}</h2><p>{spec.subtitle}</p></div></header>
        <DashboardGrid components={spec.components} theme={spec.theme} preview selectedId={null} onSelect={noop} onProvenance={noop} onLayoutCommit={noop} onInteractionError={noop} />
      </div>
    </main>
  </ConfigProvider>
}
createRoot(document.getElementById('root')!).render(<Preview />)

const render = async (spec: DashboardSpec): Promise<DashboardRenderPreview> => {
  // Main process injects only the validated spec; this page has no preload or application IPC.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  flushSync(() => update(spec))
  await document.fonts.ready
  await new Promise(resolve => setTimeout(resolve, 850)) // ECharts uses a 500ms transition.
  const issues: DashboardRenderIssue[] = []
  const measurements: NonNullable<DashboardRenderPreview['measurements']> = []
  const widgets = [...document.querySelectorAll<HTMLElement>('[data-component-id]')]
  for (const widget of widgets) {
    const componentId = widget.dataset.componentId
    const box = widget.getBoundingClientRect()
    if (box.width < 1 || box.height < 1 || box.right > innerWidth + 2 || box.bottom > innerHeight + 2 || box.left < -2 || box.top < -2) issues.push({ code: 'component-outside-viewport', severity: 'error', componentId, message: '组件未正常显示或超出桌面画布' })
    for (const element of widget.querySelectorAll<HTMLElement>('header h3,header p,.viz-kpi-value')) {
      measurements.push({ componentId: componentId ?? '', element: element.className || element.tagName, width: element.clientWidth, height: element.clientHeight, scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight })
      const style = getComputedStyle(element)
      const clipsX = ['hidden', 'clip'].includes(style.overflowX)
      const clipsY = ['hidden', 'clip'].includes(style.overflowY)
      if ((clipsX && element.scrollWidth > element.clientWidth + 2) || (clipsY && element.scrollHeight > element.clientHeight + 2)) issues.push({ code: 'text-clipped', severity: 'warning', componentId, message: `文字被裁切：${element.innerText.slice(0, 100)}` })
    }
    for (const visual of widget.querySelectorAll<HTMLElement>('.dashboard-chart-visual')) {
      if (!visual.querySelector('canvas,svg') || visual.clientHeight < 20) issues.push({ code: 'chart-not-rendered', severity: 'error', componentId, message: '图表尚未完成真实渲染' })
    }
    const insight = widget.querySelector<HTMLElement>('.viz-insight p')
    if (insight && !insight.textContent?.trim()) issues.push({ code: 'insight-empty', severity: 'error', componentId, message: '洞察组件没有可读内容' })
  }
  if (widgets.length !== spec.components.length) issues.push({ code: 'missing-components', severity: 'error', message: '渲染组件数量与草稿不一致' })
  return { rendered: true, componentCount: widgets.length, issues, measurements }
}
;(window as unknown as { dashboardPreview: { render: typeof render } }).dashboardPreview = { render }
