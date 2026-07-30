import {
  AppstoreOutlined,
  BgColorsOutlined,
  DownloadOutlined,
  EditOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  UndoOutlined
} from '@ant-design/icons'
import {
  App,
  Button,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardQualityReport,
  DashboardSpec,
  DashboardSummary,
  DashboardThemeId,
  DashboardVersion,
  VisualizationRun
} from '../../../shared/dashboard'
import type { DashboardStats } from '../../../shared/types'
import { dashboardRowCount } from '../../../shared/dashboard-layout'
import { dashboardComponentRegistry } from './componentRegistry'
import { DashboardComponentRenderer } from './DashboardComponentRenderer'
import { buildSampleDashboard } from './sampleDashboard'

const { Text } = Typography

const componentTypeIcons: Record<DashboardComponentType, string> = {
  kpi: '01',
  line: '02',
  bar: '03',
  pie: '04',
  ranking: '05',
  progress: '06',
  table: '07',
  insight: 'AI'
}

const cloneSpec = (spec: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(spec)) as DashboardSpec

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

export function DashboardStudio({
  generatedDashboard
}: {
  generatedDashboard?: DashboardSpec | null
}): React.JSX.Element {
  const { message } = App.useApp()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [dashboard, setDashboard] = useState<DashboardSpec | null>(null)
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([])
  const [versions, setVersions] = useState<DashboardVersion[]>([])
  const [currentVersion, setCurrentVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<DashboardSpec[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [qualityOpen, setQualityOpen] = useState(false)
  const [qualityReport, setQualityReport] = useState<DashboardQualityReport | null>(null)
  const [visualizationRuns, setVisualizationRuns] = useState<VisualizationRun[]>([])
  const [diagnosing, setDiagnosing] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [printMode, setPrintMode] = useState(false)
  const generatedIdRef = useRef<string | null>(null)

  const refreshDashboards = async (): Promise<void> => {
    setDashboards(await window.visslm.listDashboards())
  }

  useEffect(() => {
    void Promise.all([window.visslm.getStats(), window.visslm.listDashboards()]).then(
      ([nextStats, saved]) => {
        setStats(nextStats)
        setDashboards(saved)
      }
    )
  }, [])

  useEffect(() => {
    if (!generatedDashboard || generatedIdRef.current === generatedDashboard.id) return
    generatedIdRef.current = generatedDashboard.id
    setDashboard(cloneSpec(generatedDashboard))
    setSelectedId(generatedDashboard.components[0]?.id ?? null)
    setHistory([])
    setCurrentVersion(0)
  }, [generatedDashboard])

  useEffect(() => {
    if (!dashboard && stats) {
      const sample = buildSampleDashboard(stats)
      setDashboard(sample)
      setSelectedId(sample.components[0]?.id ?? null)
    }
  }, [dashboard, stats])

  const selectedComponent = useMemo(
    () => dashboard?.components.find((component) => component.id === selectedId) ?? null,
    [dashboard, selectedId]
  )

  const mutateDashboard = (mutate: (draft: DashboardSpec) => void): void => {
    setDashboard((current) => {
      if (!current) return current
      setHistory((items) => [...items.slice(-29), cloneSpec(current)])
      const draft = cloneSpec(current)
      mutate(draft)
      draft.updatedAt = new Date().toISOString()
      return draft
    })
  }

  const updateComponent = (patch: Partial<DashboardComponentSpec>): void => {
    if (!selectedId) return
    mutateDashboard((draft) => {
      const index = draft.components.findIndex((component) => component.id === selectedId)
      if (index >= 0) draft.components[index] = { ...draft.components[index], ...patch }
    })
  }

  const updateLayout = (
    field: keyof DashboardComponentSpec['layout'],
    value: number | null
  ): void => {
    if (!selectedComponent || value === null) return
    updateComponent({ layout: { ...selectedComponent.layout, [field]: value } })
  }

  const undo = (): void => {
    const previous = history.at(-1)
    if (!previous) return
    setDashboard(previous)
    setHistory((items) => items.slice(0, -1))
  }

  const save = async (): Promise<void> => {
    if (!dashboard) return
    setSaving(true)
    try {
      const saved = await window.visslm.saveDashboard({
        spec: dashboard,
        changeSummary: currentVersion ? '画布编辑' : '创建大屏'
      })
      setDashboard(saved.spec)
      setCurrentVersion(saved.version)
      setHistory([])
      await refreshDashboards()
      message.success(`已保存为 V${saved.version}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const openDashboard = async (id: string): Promise<void> => {
    const saved = await window.visslm.getDashboard(id)
    if (!saved) return
    setDashboard(saved.spec)
    setCurrentVersion(saved.version)
    setSelectedId(saved.spec.components[0]?.id ?? null)
    setHistory([])
  }

  const openHistory = async (): Promise<void> => {
    if (!dashboard) return
    setVersions(await window.visslm.listDashboardVersions(dashboard.id))
    setHistoryOpen(true)
  }

  const openQuality = async (): Promise<void> => {
    if (!dashboard) return
    setQualityOpen(true)
    setDiagnosing(true)
    try {
      const [report, runs] = await Promise.all([
        window.visslm.diagnoseDashboard(dashboard),
        window.visslm.listVisualizationRuns(20)
      ])
      setQualityReport(report)
      setVisualizationRuns(runs)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDiagnosing(false)
    }
  }

  const restore = async (version: number): Promise<void> => {
    if (!dashboard) return
    try {
      const restored = await window.visslm.restoreDashboard(dashboard.id, version)
      setDashboard(restored.spec)
      setCurrentVersion(restored.version)
      setHistory([])
      setVersions(await window.visslm.listDashboardVersions(dashboard.id))
      await refreshDashboards()
      message.success(`已从 V${version} 恢复，并保存为 V${restored.version}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const exportDashboard = async (format: 'json' | 'pdf'): Promise<void> => {
    if (!dashboard) return
    setExporting(true)
    try {
      if (format === 'pdf') {
        setPrintMode(true)
        await nextFrame()
      }
      const result = format === 'json'
        ? await window.visslm.exportDashboardJson(dashboard)
        : await window.visslm.exportDashboardPdf(dashboard)
      if (result.ok) message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPrintMode(false)
      setExporting(false)
    }
  }

  const renderCanvas = (preview = false): React.JSX.Element => (
    <div
      className={`dashboard-preview ${preview ? 'is-full-preview' : ''}`}
      style={{
        '--dashboard-rows': dashboardRowCount(dashboard?.components ?? [])
      } as React.CSSProperties}
    >
      <header className="dashboard-preview-header">
        <div className="dashboard-title-mark" />
        <div>
          <h2>{dashboard?.title}</h2>
          <p>{dashboard?.subtitle}</p>
        </div>
        <div className="dashboard-preview-meta">
          <span className="live-dot" />
          本地数据
          <time>{dashboard ? new Date(dashboard.updatedAt).toLocaleTimeString('zh-CN') : ''}</time>
        </div>
      </header>
      <div className="dashboard-grid">
        {dashboard?.components.map((component) => (
          <section
            className={[
              'dashboard-widget',
              `widget-${component.type}`,
              !preview && selectedId === component.id ? 'selected' : ''
            ].join(' ')}
            key={component.id}
            onClick={() => !preview && setSelectedId(component.id)}
            style={{
              gridColumn: `${component.layout.x + 1} / span ${component.layout.w}`,
              gridRow: `${component.layout.y + 1} / span ${component.layout.h}`
            }}
          >
            <header>
              <div>
                <h3>{component.title}</h3>
                {component.subtitle && <p>{component.subtitle}</p>}
              </div>
              <span className="widget-corner" />
            </header>
            <div className="dashboard-widget-content">
              <DashboardComponentRenderer component={component} />
            </div>
          </section>
        ))}
      </div>
    </div>
  )

  return (
    <div className={`dashboard-studio ${printMode ? 'dashboard-print-mode' : ''}`}>
      <div className="dashboard-studio-toolbar">
        <div>
          <div className="dashboard-studio-heading">
            <RobotOutlined />
            <span>数据可视化专家工作台</span>
            <Tag color={currentVersion ? 'blue' : 'default'}>
              {currentVersion ? `V${currentVersion}` : '未保存'}
            </Tag>
          </div>
          <Text type="secondary">结构化画布 · 本地版本 · 可追溯导出</Text>
        </div>
        <div className="dashboard-studio-actions">
          <Segmented
            value={dashboard?.theme}
            onChange={(value) => mutateDashboard((draft) => {
              draft.theme = value as DashboardThemeId
            })}
            options={[
              { label: '深色科技', value: 'technology-dark', icon: <BgColorsOutlined /> },
              { label: '明亮商务', value: 'business-light', icon: <AppstoreOutlined /> }
            ]}
          />
          <Tooltip title="撤销本次编辑">
            <Button icon={<UndoOutlined />} disabled={!history.length} onClick={undo} />
          </Tooltip>
          <Button
            icon={<SafetyCertificateOutlined />}
            loading={diagnosing}
            onClick={() => void openQuality()}
          >
            质量
          </Button>
          <Button icon={<HistoryOutlined />} disabled={!currentVersion} onClick={() => void openHistory()}>
            版本
          </Button>
          <Button icon={<FullscreenOutlined />} onClick={() => setPreviewOpen(true)}>预览</Button>
          <Dropdown
            menu={{
              items: [
                { key: 'json', label: 'DashboardSpec JSON' },
                { key: 'pdf', label: 'PDF 文档' }
              ],
              onClick: ({ key }) => void exportDashboard(key as 'json' | 'pdf')
            }}
          >
            <Button icon={<DownloadOutlined />} loading={exporting}>导出</Button>
          </Dropdown>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>

      <div className="dashboard-studio-body">
        <aside className="dashboard-library">
          <div className="dashboard-panel-title">
            <span>已保存大屏</span>
            <small>{dashboards.length} 个</small>
          </div>
          <Select
            className="dashboard-selector"
            value={currentVersion ? dashboard?.id : undefined}
            placeholder="打开大屏"
            options={dashboards.map((item) => ({
              value: item.id,
              label: `${item.title} · V${item.currentVersion}`
            }))}
            onChange={(id) => void openDashboard(id)}
          />
          <Divider />
          <div className="dashboard-panel-title">
            <span>看板组件</span>
            <small>{dashboard?.components.length ?? 0} 个</small>
          </div>
          <div className="dashboard-component-list">
            {dashboard?.components.map((component) => (
              <button
                type="button"
                key={component.id}
                className={selectedId === component.id ? 'selected' : ''}
                onClick={() => setSelectedId(component.id)}
              >
                <span className="dashboard-component-icon">{componentTypeIcons[component.type]}</span>
                <span>
                  <strong>{component.title}</strong>
                  <small>{dashboardComponentRegistry.find((item) => item.type === component.type)?.name}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className={`dashboard-preview-shell theme-${dashboard?.theme ?? 'technology-dark'}`}>
          {!dashboard ? <div className="dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : renderCanvas()}
        </main>

        <aside className="dashboard-inspector">
          <div className="dashboard-panel-title">
            <span><EditOutlined /> 属性面板</span>
            <small>{selectedComponent?.id ?? '未选择'}</small>
          </div>
          {!selectedComponent ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择画布组件" /> : (
            <div className="dashboard-inspector-form">
              <label>组件标题</label>
              <Input
                value={selectedComponent.title}
                onChange={(event) => updateComponent({ title: event.target.value })}
              />
              <label>副标题</label>
              <Input
                value={selectedComponent.subtitle}
                onChange={(event) => updateComponent({ subtitle: event.target.value })}
              />
              <label>图表类型</label>
              <Select
                value={selectedComponent.type}
                options={dashboardComponentRegistry.map((item) => ({
                  value: item.type,
                  label: item.name
                }))}
                onChange={(type) => updateComponent({ type })}
              />
              <label>单位</label>
              <Input
                value={selectedComponent.unit}
                placeholder="条、个、%"
                onChange={(event) => updateComponent({ unit: event.target.value })}
              />
              <Divider>24 列网格</Divider>
              <div className="dashboard-layout-inputs">
                {(['x', 'y', 'w', 'h'] as const).map((field) => (
                  <label key={field}>
                    <span>{field.toUpperCase()}</span>
                    <InputNumber
                      min={field === 'w' || field === 'h' ? 2 : 0}
                      max={field === 'x' || field === 'w' ? 24 : 20}
                      value={selectedComponent.layout[field]}
                      onChange={(value) => updateLayout(field, value)}
                    />
                  </label>
                ))}
              </div>
              <Text type="secondary">
                保存前会检查组件越界、重叠、查询字段与图表编码。
              </Text>
            </div>
          )}
        </aside>
      </div>

      <Drawer title="版本历史" open={historyOpen} width={420} onClose={() => setHistoryOpen(false)}>
        <List
          locale={{ emptyText: '暂无版本' }}
          dataSource={versions}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="restore"
                  size="small"
                  disabled={item.version === currentVersion}
                  onClick={() => void restore(item.version)}
                >
                  恢复
                </Button>
              ]}
            >
              <List.Item.Meta
                title={<Space><Tag>V{item.version}</Tag>{item.changeSummary}</Space>}
                description={new Date(item.createdAt).toLocaleString('zh-CN')}
              />
            </List.Item>
          )}
        />
      </Drawer>

      <Drawer
        title="大屏质量诊断"
        open={qualityOpen}
        width={520}
        onClose={() => setQualityOpen(false)}
      >
        {!qualityReport ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <div className="dashboard-quality">
            <div className="dashboard-quality-score">
              <div>
                <strong>{qualityReport.score}</strong>
                <span>质量分</span>
              </div>
              <div>
                <Text strong>{qualityReport.queryCount} 个受控查询</Text>
                <Text type="secondary">
                  合计 {qualityReport.totalElapsedMs.toFixed(2)} ms ·
                  {qualityReport.issues.length
                    ? ` ${qualityReport.issues.length} 项待处理`
                    : ' 未发现问题'}
                </Text>
              </div>
            </div>
            <Divider titlePlacement="start">检查结果</Divider>
            <List
              size="small"
              locale={{ emptyText: '未发现结构、数据或性能问题' }}
              dataSource={qualityReport.issues}
              renderItem={(issue) => (
                <List.Item>
                  <List.Item.Meta
                    title={(
                      <Space>
                        <Tag color={
                          issue.severity === 'error'
                            ? 'error'
                            : issue.severity === 'warning'
                              ? 'warning'
                              : 'default'
                        }>
                          {issue.severity === 'error'
                            ? '错误'
                            : issue.severity === 'warning'
                              ? '警告'
                              : '建议'}
                        </Tag>
                        {issue.componentId && <Text code>{issue.componentId}</Text>}
                      </Space>
                    )}
                    description={issue.message}
                  />
                </List.Item>
              )}
            />
            <Divider titlePlacement="start">查询性能</Divider>
            <div className="dashboard-quality-queries">
              {qualityReport.components.map((component) => (
                <div key={component.componentId}>
                  <div>
                    <Text strong ellipsis>{component.title}</Text>
                    <Tag color={
                      component.status === 'ok'
                        ? 'success'
                        : component.status === 'empty'
                          ? 'warning'
                          : 'error'
                    }>
                      {component.status === 'ok'
                        ? `${component.elapsedMs} ms`
                        : component.status === 'empty'
                          ? '空结果'
                          : '失败'}
                    </Tag>
                  </div>
                  <Text type="secondary">
                    扫描 {component.scannedRows} · 命中 {component.matchedRows} ·
                    返回 {component.resultRows}
                  </Text>
                </div>
              ))}
            </div>
            <Divider titlePlacement="start">最近生成运行</Divider>
            <List
              size="small"
              locale={{ emptyText: '暂无生成运行记录' }}
              dataSource={visualizationRuns}
              renderItem={(run) => (
                <List.Item>
                  <List.Item.Meta
                    title={(
                      <Space>
                        <Tag color={run.status === 'success' ? 'success' : 'error'}>
                          {run.status === 'success' ? '成功' : '失败'}
                        </Tag>
                        <Text>{run.modelName}</Text>
                        <Text type="secondary">{run.durationMs} ms</Text>
                      </Space>
                    )}
                    description={`${new Date(run.createdAt).toLocaleString('zh-CN')} · ${run.requestSummary}`}
                  />
                </List.Item>
              )}
            />
          </div>
        )}
      </Drawer>

      <Modal
        className="dashboard-preview-modal"
        title={dashboard?.title}
        open={previewOpen}
        footer={null}
        width="96vw"
        onCancel={() => setPreviewOpen(false)}
      >
        <div className={`dashboard-modal-canvas theme-${dashboard?.theme ?? 'technology-dark'}`}>
          {dashboard && renderCanvas(true)}
        </div>
      </Modal>
    </div>
  )
}
