import {
  FullscreenExitOutlined,
  FullscreenOutlined
} from '@ant-design/icons'
import { Button, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import type { DashboardFilter, DashboardSpec } from '../../shared/dashboard'
import { DashboardGrid } from '../src/dashboard/DashboardGrid'
import '../src/styles.css'
import './offline.css'

const formatFilterValue = (filter: DashboardFilter): string => {
  if (Array.isArray(filter.value)) return filter.value.map(String).join('、') || '全部'
  if (filter.value === undefined || filter.value === '') return '全部'
  return String(filter.value)
}

const formatUpdatedAt = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

const OfflineFilters = ({ filters }: { filters: DashboardFilter[] }): React.JSX.Element | null => {
  if (!filters.length) return null
  return (
    <div className="dashboard-filter-bar offline-filter-bar" aria-label="离线快照筛选条件">
      <span className="dashboard-filter-bar-label">快照筛选</span>
      {filters.map((filter) => (
        <span className="offline-filter-chip" key={filter.id}>
          <span>{filter.label}</span>
          <strong>{formatFilterValue(filter)}</strong>
        </span>
      ))}
      <span className="dashboard-filter-bar-hint">数据已固定，不会重新查询</span>
    </div>
  )
}

const OfflineDashboard = ({ spec }: { spec: DashboardSpec }): React.JSX.Element => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const themeMode = spec.theme.endsWith('light') ? 'light' : 'dark'

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    document.documentElement.style.colorScheme = themeMode
    const handleFullscreenChange = (): void => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [themeMode])

  const antTheme = useMemo(() => ({
    hashed: false,
    token: {
      colorPrimary: '#7c6cff',
      colorBgBase: 'transparent',
      colorBgContainer: 'transparent',
      colorBgElevated: themeMode === 'dark' ? '#151821' : '#ffffff',
      colorText: themeMode === 'dark' ? '#eef1f7' : '#25313d',
      colorTextSecondary: themeMode === 'dark' ? '#929bad' : '#718086',
      colorBorder: themeMode === 'dark' ? '#2b3040' : '#dfe3e8',
      borderRadius: 8,
      controlHeight: 32
    }
  }), [themeMode])

  const toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen()
    }
  }

  return (
    <ConfigProvider locale={zhCN} theme={antTheme}>
      <div className={[
        'offline-app',
        `theme-${spec.theme}`,
        isFullscreen ? 'is-fullscreen' : ''
      ].filter(Boolean).join(' ')}>
        <header className="offline-toolbar">
          <div className="offline-toolbar-title">
            <span className="offline-brand-mark" aria-hidden="true" />
            <div>
              <strong>离线大屏预览</strong>
              <span>快照模式 · 不访问网络</span>
            </div>
          </div>
          <div className="offline-toolbar-actions">
            <span className="offline-toolbar-dashboard-name" title={spec.title}>{spec.title}</span>
            <Button
              type="text"
              icon={isFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
              aria-label={isFullscreen ? '退出全屏' : '进入全屏'}
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? '退出全屏' : '全屏'}
            </Button>
          </div>
        </header>
        <main className="offline-stage-scroll">
          <section className="offline-stage" aria-label="离线大屏画布">
            <div className="dashboard-preview offline-dashboard-preview">
              <header className="dashboard-preview-header">
                <div className="dashboard-title-mark" />
                <div>
                  <h2>{spec.title}</h2>
                  <p>{spec.subtitle}</p>
                </div>
                <div className="dashboard-preview-meta">
                  <span className="live-dot" />
                  <span>离线快照</span>
                  <time>{formatUpdatedAt(spec.updatedAt)}</time>
                </div>
              </header>
              <OfflineFilters filters={spec.globalFilters ?? []} />
              <DashboardGrid
                components={spec.components}
                theme={spec.theme}
                preview
                selectedId={null}
                onSelect={() => undefined}
                onProvenance={() => undefined}
                onLayoutCommit={() => undefined}
                onInteractionError={() => undefined}
              />
            </div>
          </section>
        </main>
      </div>
    </ConfigProvider>
  )
}

const payload = window.__VISSLM_DASHBOARD_EXPORT__
const root = document.getElementById('root')

if (!root) throw new Error('离线预览根节点不存在')

if (!payload?.spec) {
  root.innerHTML = '<main class="offline-invalid">离线预览数据无效，请重新导出预览包。</main>'
} else {
  ReactDOM.createRoot(root).render(<OfflineDashboard spec={payload.spec} />)
}
