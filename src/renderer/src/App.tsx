import {
  BarChartOutlined,
  BorderOutlined,
  BulbOutlined,
  CheckCircleOutlined,
  CloudDownloadOutlined,
  CloseOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  FileExcelOutlined,
  FilePdfOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  FilterOutlined,
  FileWordOutlined,
  FundProjectionScreenOutlined,
  FullscreenExitOutlined,
  HistoryOutlined,
  HolderOutlined,
  InfoCircleOutlined,
  ImportOutlined,
  LeftOutlined,
  MessageOutlined,
  MoonOutlined,
  MinusOutlined,
  PictureOutlined,
  PlusOutlined,
  ProjectOutlined,
  ReloadOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SyncOutlined,
  SunOutlined,
  UserOutlined
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  InputNumber,
  Layout,
  Menu,
  Modal,
  Progress,
  Row,
  Select,
  Segmented,
  Space,
  Spin,
  Statistic,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import type { TablePaginationConfig } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import appIconDark from './assets/visslm-icon.png'
import appIconLight from './assets/visslm-icon-light.png'
import { DashboardStudio } from './dashboard/DashboardStudio'
import { RichDescription } from './RichDescription'
import { ResizableTable } from './ResizableTable'
import { ProjectManagementPage } from './project-management/ProjectManagementPage'
import type { AppThemeMode } from './theme'
import type { DashboardSpec } from '../../shared/dashboard'
import type { DataScope } from '../../shared/query-spec'
import type { AgentEvent, ExpertId } from '../../shared/expert-types'
import {
  DEFAULT_PROJECT_MATCHING_SETTINGS,
  DEFAULT_FEATURE_MODULE_SETTINGS,
  DEFAULT_FEATURE_NAVIGATION_ORDER
} from '../../shared/types'
import type {
  AppSettings,
  ChatDataRow,
  ChatDataView,
  ChatMessage,
  ChatSessionSummary,
  CollectionRequestLogRow,
  DataReviewApplyResult,
  DataReviewItem,
  DataReviewSource,
  DashboardStats,
  FeatureNavigationOrder,
  FeatureModuleKey,
  FeatureModuleSettings,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeIndexProgress,
  KnowledgeStats,
  ModelSettings,
  ModelProvider,
  ModelSource,
  PlatformSettingsInput,
  ProjectMatchingSettings,
  ProjectRow,
  PushConfig,
  PushFieldMapping,
  PushLogRow,
  PushResult,
  RecordDetail,
  RecordRow,
  SystemSettingsInput,
  SyncFieldFilter,
  SyncPreviewResult,
  SyncProgress,
  SyncResult,
  SyncScopeConfig,
  UpdateStatus
} from '../../shared/types'

const { Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography

type PageKey = 'dashboard' | 'visualization' | 'projects' | 'data' | 'chat' | 'sync' | 'push' | 'settings'
type AppProps = {
  themeMode: AppThemeMode
  onThemeModeChange: (next: AppThemeMode) => void
}

const AppIconThemeContext = React.createContext<AppThemeMode>('dark')

function ThemedAppIcon({ alt }: { alt: string }): React.JSX.Element {
  const themeMode = React.useContext(AppIconThemeContext)
  return <img src={themeMode === 'light' ? appIconLight : appIconDark} alt={alt} />
}

type SystemSettingsTabKey = 'platform' | 'model' | 'general' | 'features'
type FeatureDropPosition = 'before' | 'after'
type FeatureDropTarget = {
  key: FeatureModuleKey
  position: FeatureDropPosition
}

const systemSettingsTabKeys: readonly SystemSettingsTabKey[] = [
  'platform',
  'model',
  'general',
  'features'
]

const isSystemSettingsTabKey = (key: string): key is SystemSettingsTabKey =>
  systemSettingsTabKeys.includes(key as SystemSettingsTabKey)

const artifactVersionOf = (events: AgentEvent[] | undefined): number | undefined =>
  events?.find((event): event is Extract<AgentEvent, { type: 'artifact' }> => event.type === 'artifact')?.version

const appTableScrollY = 'min(560px, max(260px, calc(100vh - 300px)))'
const compactTableScrollY = 'min(360px, max(180px, calc(100vh - 420px)))'

const featureNavigationItems: Array<{
  key: Exclude<PageKey, 'settings'>
  feature: FeatureModuleKey
  icon: React.ReactNode
  label: string
}> = [
  { key: 'dashboard', feature: 'dashboard', icon: <BarChartOutlined />, label: '数据概览' },
  {
    key: 'visualization',
    feature: 'visualization',
    icon: <FundProjectionScreenOutlined />,
    label: '可视化大屏'
  },
  { key: 'projects', feature: 'projects', icon: <ProjectOutlined />, label: '项目管理' },
  { key: 'data', feature: 'data', icon: <DatabaseOutlined />, label: '资产中心' },
  { key: 'chat', feature: 'chat', icon: <MessageOutlined />, label: 'AI 助手' },
  { key: 'sync', feature: 'sync', icon: <SyncOutlined />, label: '数据采集' },
  { key: 'push', feature: 'push', icon: <SendOutlined />, label: '数据推送' }
]

const featureDefinitions: Array<{
  key: FeatureModuleKey
  label: string
  description: string
  icon: React.ReactNode
  defaultDisabled?: boolean
}> = [
  {
    key: 'dashboard',
    label: '数据概览',
    description: '查看本地数据统计、类型构成与发布状态。',
    icon: <BarChartOutlined />
  },
  {
    key: 'visualization',
    label: '可视化大屏',
    description: '创建、编辑和导出可追溯的数据可视化大屏。',
    icon: <FundProjectionScreenOutlined />
  },
  {
    key: 'projects',
    label: '项目管理',
    description: '管理项目成本、协议需求和数据中心资产。',
    icon: <ProjectOutlined />
  },
  {
    key: 'data',
    label: '资产中心',
    description: '管理已同步的数据记录与本地知识库资产。',
    icon: <DatabaseOutlined />
  },
  {
    key: 'chat',
    label: 'AI 助手',
    description: '使用本地或在线模型进行数据问答和分析。',
    icon: <MessageOutlined />
  },
  {
    key: 'sync',
    label: '数据采集',
    description: '从 VISSLM 平台读取数据并同步到本地。',
    icon: <SyncOutlined />
  },
  {
    key: 'push',
    label: '数据推送',
    description: '将本地处理后的数据按配置推送回业务平台。',
    icon: <SendOutlined />,
    defaultDisabled: true
  }
]

const normalizeFeatureNavigationOrder = (
  input?: readonly FeatureModuleKey[]
): FeatureNavigationOrder => {
  const seen = new Set<FeatureModuleKey>()
  const normalized: FeatureNavigationOrder = []

  for (const key of input ?? []) {
    if (!DEFAULT_FEATURE_NAVIGATION_ORDER.includes(key) || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }

  for (const key of DEFAULT_FEATURE_NAVIGATION_ORDER) {
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

const onlineModelProviders: Array<{
  value: ModelProvider
  label: string
  baseUrl: string
  models: string[]
}> = [
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.2', 'gpt-4.1', 'gpt-4.1-mini'] },
  { value: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-opus-4-1', 'claude-sonnet-4-0', 'claude-3-7-sonnet-latest'] },
  { value: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { value: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'] },
  { value: 'zhipu', label: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'] },
  { value: 'moonshot', label: 'Moonshot', baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'] },
  { value: 'minimax', label: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', models: ['MiniMax-M2.5', 'MiniMax-M2.1'] },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口', baseUrl: '', models: [] }
]

const chatExperts: Array<{
  id: ExpertId
  name: string
  mention: string
  description: string
}> = [
  {
    id: 'visualization',
    name: '数据可视化专家',
    mention: '@数据可视化专家',
    description: '生成可追溯、可编辑的数据大屏'
  },
  {
    id: 'general',
    name: '通用数据助手',
    mention: '@通用数据助手',
    description: '检索、统计和解释本地数据'
  },
  {
    id: 'requirement-analysis',
    name: '需求分析专家',
    mention: '@需求分析专家',
    description: '按需求编号匹配数据中心相似需求'
  }
]

const visualizationStages = [
  { id: 'intent', label: '理解需求' },
  { id: 'profile', label: '分析数据' },
  { id: 'plan', label: '规划指标' },
  { id: 'query', label: '校验查询' },
  { id: 'execute', label: '计算数据' },
  { id: 'compose', label: '生成大屏' },
  { id: 'validate', label: '质量检查' },
  { id: 'persist', label: '完成' }
] as const

const formatDate = (value?: string): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

const formatChatSessionTime = (value: string): string => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60000))} 分钟前`
  if (elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)} 小时前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

const plainTextFromHtml = (value?: string): string => {
  if (!value) return ''
  const document = new DOMParser().parseFromString(value, 'text/html')
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const renderPushStatus = (record: Pick<
  RecordRow,
  'pushStatus' | 'pushMessage' | 'pushedAt' | 'pushedUid'
>): React.JSX.Element => {
  if (record.pushStatus === 'success') {
    return (
      <Tag color="success" title={record.pushedUid ? `平台 UID：${record.pushedUid}` : undefined}>
        推送成功
      </Tag>
    )
  }
  if (record.pushStatus === 'failed') {
    return (
      <Tag color="error" title={record.pushMessage || undefined}>
        推送失败
      </Tag>
    )
  }
  return <Tag>未推送</Tag>
}

function readDashboardToken(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function DashboardPage({ refreshKey, themeMode }: { refreshKey: number; themeMode: AppThemeMode }): React.JSX.Element {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadStats = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStats(await window.visslm.getStats())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats, refreshKey])

  if (!stats && loading) {
    return (
      <div className="overview-state overview-loading" role="status">
        <Spin size="small" />
        <Text>正在加载数据概览</Text>
      </div>
    )
  }

  if (!stats) {
    return (
      <div className="overview-state">
        <Alert
          type="error"
          showIcon
          message="数据概览加载失败"
          description={error || '暂时无法读取本地统计数据'}
          action={<Button onClick={() => void loadStats()}>重试</Button>}
        />
      </div>
    )
  }

  const typeTotal = stats.byType.reduce((sum, item) => sum + item.value, 0)
  const releaseTotal = stats.byRelease.reduce((sum, item) => sum + item.value, 0)
  const pushRate = stats.collectedCount
    ? Math.round((stats.pushedCount / stats.collectedCount) * 100)
    : 0
  const typeRows = stats.byType.slice(0, 8)
  const releaseRows = stats.byRelease.slice(0, 6)
  const releaseChartRows = stats.byRelease.slice(0, 6)
  const releaseChartTotal = releaseChartRows.reduce((sum, item) => sum + item.value, 0)
  if (releaseTotal > releaseChartTotal) {
    releaseChartRows.push({ name: '其他', value: releaseTotal - releaseChartTotal })
  }
  const releaseColors = [
    readDashboardToken('--accent', '#7c6cff'),
    readDashboardToken('--state-info', '#60b9ff'),
    readDashboardToken('--state-success', '#49d597'),
    readDashboardToken('--state-warning', '#f2b45c'),
    readDashboardToken('--state-error', '#ef6b73'),
    readDashboardToken('--text-muted', '#929bad')
  ]
  const releaseOtherColor = readDashboardToken('--surface-soft', '#171b25')
  const releaseChartColors = [
    ...releaseColors,
    releaseOtherColor
  ]
  const releaseChartData = releaseChartRows.map((item, index) => ({
    ...item,
    itemStyle: { color: releaseChartColors[index] ?? releaseOtherColor }
  }))
  const chartSurface = readDashboardToken('--surface-raised', '#131720')
  const chartOverlay = readDashboardToken('--surface-overlay', '#171b24')
  const chartStroke = readDashboardToken('--stroke-strong', 'rgba(255, 255, 255, 0.13)')
  const chartText = readDashboardToken('--text-main', '#eef1f7')
  const chartMuted = readDashboardToken('--text-muted', '#929bad')
  const releaseOption = {
    animationDuration: 350,
    color: releaseChartColors,
    tooltip: {
      trigger: 'item',
      renderMode: 'html',
      appendToBody: false,
      confine: true,
      transitionDuration: 0,
      backgroundColor: chartOverlay,
      borderColor: chartStroke,
      textStyle: { color: chartText },
      formatter: '{b}<br/><strong>{c}</strong> 条（{d}%）'
    },
    title: {
      text: String(releaseTotal),
      subtext: '条记录',
      left: 'center',
      top: '36%',
      textStyle: { color: chartText, fontSize: 25, fontWeight: 650 },
      subtextStyle: { color: chartMuted, fontSize: 11, lineHeight: 18 }
    },
    series: [
      {
        name: '_valm_Release_text',
        type: 'pie',
        radius: ['62%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: {
          borderColor: chartSurface,
          borderWidth: 3,
          borderRadius: 5
        },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scaleSize: 5,
          label: { show: false }
        },
        data: releaseChartData
      }
    ]
  }
  const metrics = [
    {
      key: 'projects',
      label: '采集项目',
      value: stats.projectCount,
      detail: '资产中心采集项目',
      icon: <ProjectOutlined />,
      tone: 'accent'
    },
    {
      key: 'records',
      label: '已采集数据',
      value: stats.collectedCount,
      detail: '本地 records 记录',
      icon: <DatabaseOutlined />,
      tone: 'info'
    },
    {
      key: 'pushed',
      label: '已推送数据',
      value: stats.pushedCount,
      detail: `成功推送率 ${pushRate}%`,
      icon: <SendOutlined />,
      tone: 'success'
    },
    {
      key: 'images',
      label: '图片资产',
      value: stats.imageCount,
      detail: '已提取 Base64 图片',
      icon: <PictureOutlined />,
      tone: 'warning'
    }
  ]
  const moduleStats = [
    {
      key: 'project-management',
      title: '项目管理',
      subtitle: '项目、需求审核与关联资产',
      icon: <ProjectOutlined />,
      tone: 'accent',
      badge: `${stats.projectManagement.projectCount} 个项目`,
      meta: stats.projectManagement.processingProjectCount
        ? `${stats.projectManagement.processingProjectCount} 个处理中`
        : `${stats.projectManagement.activeProjectCount} 个已启用`,
      items: [
        { label: '已启用项目', value: stats.projectManagement.activeProjectCount },
        { label: '需求条目', value: stats.projectManagement.requirementCount },
        { label: '待审核需求', value: stats.projectManagement.pendingReviewCount },
        { label: '关联资产', value: stats.projectManagement.linkedAssetCount }
      ]
    },
    {
      key: 'asset-center',
      title: '资产中心',
      subtitle: '本地记录、项目归属与媒体资源',
      icon: <DatabaseOutlined />,
      tone: 'info',
      badge: `${stats.assetCenter.recordCount} 条记录`,
      meta: `${stats.assetCenter.typeCount} 种对象类型`,
      items: [
        { label: '数据记录', value: stats.assetCenter.recordCount },
        { label: '采集项目', value: stats.assetCenter.projectCount },
        { label: '对象类型', value: stats.assetCenter.typeCount },
        { label: '图片资产', value: stats.assetCenter.imageCount }
      ]
    }
  ]

  return (
    <div className="page-stack overview-dashboard">
      <div className="overview-metric-grid" aria-label="数据总量">
        {metrics.map((metric) => (
          <Card
            className={`overview-metric-card overview-metric-card-${metric.tone}`}
            key={metric.key}
            role="group"
            aria-label={`${metric.label} ${metric.value}`}
          >
            <div className="overview-metric-heading">
              <span className="overview-metric-icon" aria-hidden="true">
                {metric.icon}
              </span>
              <span className="overview-metric-label">{metric.label}</span>
            </div>
            <Statistic value={metric.value} />
            <span className="overview-metric-detail">{metric.detail}</span>
          </Card>
        ))}
      </div>

      <Card className="overview-analytics-card">
        <div className="overview-analytics-heading">
          <div className="overview-analytics-title">
            <span className="overview-section-kicker">
              <BarChartOutlined />
              数据构成
            </span>
            <Title level={4}>本地数据分布</Title>
            <Text type="secondary">按对象类型与发布状态查看已采集记录的结构</Text>
          </div>
          <div className="overview-analytics-actions">
            <div className="overview-summary-strip" aria-label="数据摘要">
              <span>{stats.byType.length} 种对象类型</span>
              <span>{stats.byRelease.length} 个发布状态</span>
              <span>{pushRate}% 推送率</span>
            </div>
            <Button
              type="text"
              className="overview-refresh-button"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => void loadStats()}
              aria-label="刷新数据概览"
              title="刷新数据概览"
            />
          </div>
        </div>

        <div className="overview-analysis-grid">
          <section className="overview-analysis-section overview-type-section">
            <div className="overview-section-heading">
              <div>
                <strong>对象类型</strong>
                <Text type="secondary">按本地已采集记录统计</Text>
              </div>
              <span>{stats.byType.length} 种</span>
            </div>
            {typeRows.length ? (
              <div className="overview-type-list" role="list" aria-label="对象类型分布">
                {typeRows.map((item, index) => {
                  const percent = typeTotal ? Math.round((item.value / typeTotal) * 100) : 0
                  return (
                    <div
                      className="overview-type-item"
                      key={item.name}
                      role="listitem"
                      title={`${item.name}：${item.value} 条，占比 ${percent}%`}
                      aria-label={`${item.name} ${item.value} 条，占比 ${percent}%`}
                    >
                      <div className="overview-type-meta">
                        <span className={`overview-type-dot overview-type-dot-${index % 4}`} aria-hidden="true" />
                        <span className="overview-type-name">{item.name}</span>
                        <strong>{item.value}</strong>
                      </div>
                      <div className="overview-type-track" aria-hidden="true">
                        <span style={{ width: `${Math.max(percent, 3)}%` }} />
                      </div>
                    </div>
                  )
                })}
                {stats.byType.length > typeRows.length ? (
                  <span className="overview-list-note">其余 {stats.byType.length - typeRows.length} 种类型未展开</span>
                ) : null}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采集数据后显示统计" />
            )}
          </section>

          <section className="overview-analysis-section overview-release-section">
            <div className="overview-section-heading">
              <div>
                <strong>发布状态</strong>
                <Text type="secondary">显示字段 _valm_Release_text</Text>
              </div>
              <span>{stats.byRelease.length} 项</span>
            </div>
            {releaseRows.length ? (
              <div className="overview-release-layout">
                <ReactECharts
                  className="overview-release-chart"
                  option={releaseOption}
                  notMerge
                  lazyUpdate
                  opts={{ renderer: 'svg' }}
                />
                <div className="overview-release-list" role="list" aria-label="发布状态分布">
                  {releaseRows.map((item, index) => {
                    const percent = releaseTotal ? Math.round((item.value / releaseTotal) * 100) : 0
                    return (
                      <div
                        className="overview-release-row"
                        key={item.name}
                        role="listitem"
                        title={`${item.name}：${item.value} 条，占比 ${percent}%`}
                      >
                        <span
                          className="overview-release-dot"
                          style={{ backgroundColor: releaseColors[index % releaseColors.length] }}
                          aria-hidden="true"
                        />
                        <span className="overview-release-name">{item.name}</span>
                        <strong>{item.value}</strong>
                        <small>{percent}%</small>
                      </div>
                    )
                  })}
                  {stats.byRelease.length > releaseRows.length ? (
                    <span className="overview-list-note">其余 {stats.byRelease.length - releaseRows.length} 项状态未展开</span>
                  ) : null}
                </div>
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采集发布显示字段后显示统计" />
            )}
          </section>
        </div>

        <div className="overview-module-grid" aria-label="业务模块统计">
          {moduleStats.map((module) => (
            <section className={`overview-module-section overview-module-${module.tone}`} key={module.key}>
              <div className="overview-module-heading">
                <div className="overview-module-title">
                  <span className="overview-module-icon" aria-hidden="true">
                    {module.icon}
                  </span>
                  <div className="overview-module-copy">
                    <strong>{module.title}</strong>
                    <Text type="secondary">{module.subtitle}</Text>
                  </div>
                </div>
                <div className="overview-module-summary">
                  <strong>{module.badge}</strong>
                  <span>{module.meta}</span>
                </div>
              </div>
              <div className="overview-module-stat-grid" role="list" aria-label={`${module.title}统计`}>
                {module.items.map((item) => (
                  <div className="overview-module-stat" key={item.label} role="listitem">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Card>
    </div>
  )
}

function DataReviewModal({
  source,
  batchId,
  items,
  onClose,
  onApplied
}: {
  source: DataReviewSource
  batchId: string
  items: DataReviewItem[]
  onClose: () => void
  onApplied: (result: DataReviewApplyResult) => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [visibleItems, setVisibleItems] = useState(items)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [applying, setApplying] = useState(false)
  const sourceLabel = source === 'sync' ? '数据采集' : '数据导入'

  useEffect(() => {
    setVisibleItems(items)
    setSelectedRowKeys([])
  }, [batchId, items])

  const apply = async (reviewIds: string[]): Promise<void> => {
    if (!reviewIds.length) {
      message.warning('请先选择需要覆盖的数据')
      return
    }
    setApplying(true)
    try {
      const result = await window.visslm.applyDataReview({ source, batchId, reviewIds })
      onApplied(result)
      if (result.resolvedReviewIds.length) {
        setVisibleItems((current) => current.filter((item) => !result.resolvedReviewIds.includes(item.id)))
        setSelectedRowKeys((current) => current.filter((id) => !result.resolvedReviewIds.includes(id)))
      }
      if (result.errors.length) {
        message.warning(result.message)
      } else {
        message.success(result.message)
      }
      if (result.resolvedReviewIds.length === visibleItems.length && !result.errors.length) {
        onClose()
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  const confirmApply = (reviewIds: string[], all: boolean): void => {
    if (!reviewIds.length) {
      message.warning('请先选择需要覆盖的数据')
      return
    }
    modal.confirm({
      title: all ? `确认覆盖全部 ${reviewIds.length} 条数据？` : `确认覆盖选中的 ${reviewIds.length} 条数据？`,
      content: '覆盖后本地记录内容、文本和图片将以待审查数据为准。',
      okText: '确认覆盖',
      okType: 'danger',
      cancelText: '暂不覆盖',
      onOk: () => apply(reviewIds)
    })
  }

  return (
    <Modal
      className="data-review-modal"
      open
      width="min(1120px, calc(100vw - 32px))"
      title={`${sourceLabel} · 已有数据审查`}
      onCancel={onClose}
      maskClosable={false}
      footer={(
        <Space wrap>
          <Button onClick={onClose}>暂不覆盖</Button>
          <Button
            danger
            loading={applying}
            disabled={!selectedRowKeys.length}
            onClick={() => confirmApply(selectedRowKeys, false)}
          >
            覆盖选中（{selectedRowKeys.length}）
          </Button>
          <Button
            type="primary"
            danger
            loading={applying}
            disabled={!visibleItems.length}
            onClick={() => confirmApply(visibleItems.map((item) => item.id), true)}
          >
            覆盖全部（{visibleItems.length}）
          </Button>
        </Space>
      )}
    >
      <Alert
        showIcon
        type="warning"
        title={`检测到 ${visibleItems.length} 条数据的 _valm_ItemID 已存在，本次默认已过滤。`}
        description="请核对已有记录和待采集/导入记录后，再决定是否覆盖更新。"
        className="data-review-alert"
      />
      <ResizableTable<DataReviewItem>
        tableKey={`data-review-${source}`}
        rowKey="id"
        dataSource={visibleItems}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => setSelectedRowKeys(keys.map(String))
        }}
        pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (count) => `共 ${count} 条` }}
        scroll={{ x: 1080, y: 'min(440px, max(220px, calc(100vh - 390px)))' }}
        locale={{ emptyText: '暂无待审查数据' }}
        columns={[
          {
            title: '_valm_ItemID',
            dataIndex: 'itemId',
            width: 180,
            ellipsis: true
          },
          {
            title: '已有记录',
            key: 'existingName',
            width: 220,
            ellipsis: true,
            render: (_value, item) => <span title={item.existing.name}>{item.existing.name || '—'}</span>
          },
          {
            title: '待更新记录',
            key: 'incomingName',
            width: 220,
            ellipsis: true,
            render: (_value, item) => <span title={item.incoming.name}>{item.incoming.name || '—'}</span>
          },
          {
            title: '已有类型',
            key: 'existingNodeType',
            width: 130,
            ellipsis: true,
            render: (_value, item) => item.existing.nodeType || '—'
          },
          {
            title: '待更新类型',
            key: 'incomingNodeType',
            width: 130,
            ellipsis: true,
            render: (_value, item) => item.incoming.nodeType || '—'
          },
          {
            title: '已有 UID',
            key: 'existingUid',
            width: 150,
            ellipsis: true,
            render: (_value, item) => <span title={item.existing.uid}>{item.existing.uid || '—'}</span>
          },
          {
            title: '待更新 UID',
            key: 'incomingUid',
            width: 150,
            ellipsis: true,
            render: (_value, item) => <span title={item.incoming.uid}>{item.incoming.uid || '—'}</span>
          },
          {
            title: '已有修改时间',
            key: 'existingLastModifyTime',
            width: 170,
            render: (_value, item) => formatDate(item.existing.lastModifyTime)
          },
          {
            title: '待更新修改时间',
            key: 'incomingLastModifyTime',
            width: 170,
            render: (_value, item) => formatDate(item.incoming.lastModifyTime)
          }
        ]}
      />
    </Modal>
  )
}

function DataPage({
  refreshKey,
  onDataChanged,
  onVisualize
}: {
  refreshKey: number
  onDataChanged: () => void
  onVisualize: (scope: DataScope, summary: string) => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [nodeTypes, setNodeTypes] = useState<string[]>([])
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [projectId, setProjectId] = useState<string>()
  const [nodeType, setNodeType] = useState<string>()
  const [detail, setDetail] = useState<RecordDetail | null>(null)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [review, setReview] = useState<{ batchId: string; items: DataReviewItem[] } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.visslm.listRecords({
        page,
        pageSize,
        search,
        projectId,
        nodeType
      })
      setRecords(data.rows)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search, projectId, nodeType])

  useEffect(() => {
    void Promise.all([window.visslm.listProjects(), window.visslm.listNodeTypes()]).then(
      ([projectRows, types]) => {
        setProjects(projectRows)
        setNodeTypes(types)
      }
    )
  }, [refreshKey])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const openDetail = async (uid: string): Promise<void> => {
    setDetail(await window.visslm.getRecord(uid))
  }

  const importData = async (): Promise<void> => {
    setImporting(true)
    try {
      const result = await window.visslm.importData()
      if (result.canceled) return
      if (!result.ok) {
        message.error(result.message)
        return
      }
      message.success(result.message)
      if (result.errors.length) {
        modal.warning({
          title: '部分数据未导入',
          content: (
            <pre className="import-error-list">
              {result.errors.slice(0, 20).join('\n')}
            </pre>
          )
        })
      }
      if (result.reviewBatchId && result.duplicates.length) {
        setReview({ batchId: result.reviewBatchId, items: result.duplicates })
      }
      setSelectedRowKeys([])
      onDataChanged()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  const exportData = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await window.visslm.exportData()
      if (result.canceled) return
      result.ok ? message.success(result.message) : message.error(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExporting(false)
    }
  }

  const deleteData = (uids?: string[]): void => {
    const deletingAll = uids === undefined
    const count = deletingAll ? total : uids.length
    modal.confirm({
      title: deletingAll ? '确认删除全部数据？' : `确认删除选中的 ${count} 条数据？`,
      content: deletingAll
        ? '将清空数据中心内的项目、记录和图片。平台连接、模型和采集范围配置不会被删除。'
        : '记录关联的本地 Base64 图片也会一并清理，此操作不可撤销。',
      okText: deletingAll ? '全部删除' : '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        setDeleting(true)
        try {
          const result = await window.visslm.deleteData(uids)
          message.success(result.message)
          setSelectedRowKeys([])
          setDetail(null)
          setPage(1)
          onDataChanged()
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          setDeleting(false)
        }
      }
    })
  }

  const handoffToVisualization = (): void => {
    const selectedRecords = selectedRowKeys.length > 0
    const scope: DataScope = selectedRecords
      ? { recordUids: selectedRowKeys }
      : {
          ...(projectId ? { projectIds: [projectId] } : {}),
          ...(nodeType ? { nodeTypes: [nodeType] } : {})
        }
    const parts = selectedRecords
      ? [`已选 ${selectedRowKeys.length} 条记录`]
      : [
          projectId
            ? `项目 ${projects.find((project) => project.uid === projectId)?.name ?? projectId}`
            : '',
          nodeType ? `类型 ${nodeType}` : ''
        ].filter(Boolean)
    onVisualize(scope, parts.join(' · '))
  }

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        <Space wrap>
          <Button
            icon={<ImportOutlined />}
            loading={importing}
            onClick={() => void importData()}
          >
            导入数据
          </Button>
          <Button
            icon={<ExportOutlined />}
            loading={exporting}
            onClick={() => void exportData()}
          >
            导出数据
          </Button>
          <Button
            type="primary"
            icon={<FundProjectionScreenOutlined />}
            disabled={!selectedRowKeys.length && !projectId && !nodeType}
            onClick={handoffToVisualization}
          >
            交给可视化专家
            {selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
          </Button>
          <Button
            danger
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={!selectedRowKeys.length}
            onClick={() => deleteData(selectedRowKeys)}
          >
            删除所选{selectedRowKeys.length ? `（${selectedRowKeys.length}）` : ''}
          </Button>
          <Button
            danger
            type="primary"
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={!total}
            onClick={() => deleteData()}
          >
            全部删除
          </Button>
        </Space>
      </div>
      <Card className="data-workbench-card">
        <div className="filter-bar">
          <Input.Search
            allowClear
            placeholder="搜索名称、编号和正文"
            prefix={<SearchOutlined />}
            onSearch={(value) => {
              setSearch(value)
              setPage(1)
            }}
            style={{ width: 360 }}
          />
          <Select
            allowClear
            placeholder="全部项目"
            value={projectId}
            onChange={(value) => {
              setProjectId(value)
              setPage(1)
            }}
            options={projects.map((project) => ({ label: project.name, value: project.uid }))}
            style={{ width: 220 }}
          />
          <Select
            allowClear
            placeholder="全部类型"
            value={nodeType}
            onChange={(value) => {
              setNodeType(value)
              setPage(1)
            }}
            options={nodeTypes.map((type) => ({ label: type, value: type }))}
            style={{ width: 160 }}
          />
        </div>
        <ResizableTable<RecordRow>
          tableKey="asset-center-records"
          rowKey="uid"
          rowSelection={{
            selectedRowKeys,
            preserveSelectedRowKeys: true,
            onChange: (keys) => setSelectedRowKeys(keys.map(String))
          }}
          loading={loading}
          dataSource={records}
          scroll={{ x: 1450, y: appTableScrollY }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          onRow={(record) => ({
            onDoubleClick: () => void openDetail(record.uid)
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              width: 260,
              ellipsis: true,
              render: (name: string, record) => (
                <Button
                  type="link"
                  className="table-link"
                  title={name || '未命名记录'}
                  onClick={() => void openDetail(record.uid)}
                >
                  {name}
                </Button>
              )
            },
            { title: '类型', dataIndex: 'nodeType', width: 130, render: (v) => <Tag>{v || '—'}</Tag> },
            { title: '对象编号', dataIndex: 'itemId', width: 180, ellipsis: true },
            {
              title: '描述',
              dataIndex: 'description',
              width: 360,
              ellipsis: true,
              render: (description: string) => {
                const text = plainTextFromHtml(description)
                return (
                  <span className="description-cell" title={text}>
                    {text || '—'}
                  </span>
                )
              }
            },
            { title: 'UID', dataIndex: 'uid', width: 120, ellipsis: true },
            { title: '项目 UID', dataIndex: 'projectId', width: 120, ellipsis: true },
            {
              title: '数据状态',
              key: 'pushStatus',
              width: 110,
              render: (_value, record) => renderPushStatus(record)
            },
            { title: '图片', dataIndex: 'imageCount', width: 80 },
            {
              title: '最后修改',
              dataIndex: 'lastModifyTime',
              width: 180,
              render: formatDate
            }
          ]}
        />
      </Card>
      <Drawer
        className="record-detail-drawer"
        title={detail ? (
          <div className="drawer-context-title">
            <DatabaseOutlined />
            <span>数据中心记录</span>
            <strong title={detail.name}>{detail.name}</strong>
          </div>
        ) : '数据中心记录'}
        size={720}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <div className="detail-stack">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="UID">{detail.uid}</Descriptions.Item>
              <Descriptions.Item label="类型">{detail.nodeType}</Descriptions.Item>
              <Descriptions.Item label="对象编号">{detail.itemId || '—'}</Descriptions.Item>
              <Descriptions.Item label="项目 UID">{detail.projectId}</Descriptions.Item>
              <Descriptions.Item label="最后修改" span={2}>
                {formatDate(detail.lastModifyTime)}
              </Descriptions.Item>
            </Descriptions>
            <Divider titlePlacement="start">描述</Divider>
            <RichDescription html={detail.description} images={detail.images} />
            {detail.images.length > 0 && (
              <>
                <Divider titlePlacement="start">图片资源</Divider>
                <Image.PreviewGroup>
                  <div className="image-grid">
                    {detail.images.map((image) => (
                      <div className="image-tile" key={image.id}>
                        <Image src={image.dataUri} alt={image.name} />
                        <Text ellipsis>{image.name || image.sha256.slice(0, 12)}</Text>
                      </div>
                    ))}
                  </div>
                </Image.PreviewGroup>
              </>
            )}
            <Divider titlePlacement="start">知识文本</Divider>
            <pre className="text-preview">{detail.normalizedText || '暂无可索引文本'}</pre>
            <Divider titlePlacement="start">原始 JSON</Divider>
            <pre className="json-preview">{JSON.stringify(detail.raw, null, 2)}</pre>
          </div>
        )}
      </Drawer>
      {review && (
        <DataReviewModal
          source="import"
          batchId={review.batchId}
          items={review.items}
          onClose={() => setReview(null)}
          onApplied={(result) => {
            if (result.updatedCount > 0) onDataChanged()
            setReview((current) => {
              if (!current) return current
              const resolved = new Set(result.resolvedReviewIds)
              const items = current.items.filter((item) => !resolved.has(item.id))
              return items.length ? { ...current, items } : null
            })
          }}
        />
      )}
    </div>
  )
}

const knowledgeStatusMeta: Record<KnowledgeDocument['status'], { label: string; color: string }> = {
  queued: { label: '排队中', color: 'default' },
  processing: { label: '处理中', color: 'processing' },
  ready: { label: '已就绪', color: 'success' },
  failed: { label: '失败', color: 'error' }
}

const knowledgeFileIcon = (extension: string): React.JSX.Element => {
  if (extension === '.pdf') return <FilePdfOutlined />
  if (extension === '.docx') return <FileWordOutlined />
  if (extension === '.xlsx' || extension === '.xls') return <FileExcelOutlined />
  return <FileTextOutlined />
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function KnowledgeBasePage({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<KnowledgeStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<KnowledgeDocument['status']>()
  const [extension, setExtension] = useState<string>()
  const [tag, setTag] = useState('')
  const [progress, setProgress] = useState<KnowledgeIndexProgress | null>(null)
  const [detail, setDetail] = useState<KnowledgeDocumentDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [tagDraft, setTagDraft] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const [pageResult, statsResult] = await Promise.all([
        window.visslm.listKnowledgeDocuments({ page, pageSize, search, status, extension, tag }),
        window.visslm.getKnowledgeStats()
      ])
      setDocuments(pageResult.rows)
      setTotal(pageResult.total)
      setStats(statsResult)
    } finally {
      setLoading(false)
    }
  }, [extension, page, pageSize, search, status, tag])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  useEffect(() => window.visslm.onKnowledgeProgress((next) => {
    setProgress(next)
    if (next.phase === 'done' || next.phase === 'error') void load()
  }), [load])

  const upload = async (): Promise<void> => {
    setUploading(true)
    try {
      const result = await window.visslm.uploadKnowledgeDocuments()
      if (result.canceled) return
      result.ok ? message.success(result.message) : message.warning(result.message)
      if (result.skipped.length) {
        modal.warning({
          title: '部分文件未加入知识库',
          content: <pre className="knowledge-error-list">{result.skipped.map((item) => `${item.fileName}: ${item.reason}`).join('\n')}</pre>
        })
      }
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  const openDetail = async (id: string): Promise<void> => {
    setDetailLoading(true)
    try {
      const result = await window.visslm.getKnowledgeDocument(id)
      setDetail(result)
      setTagDraft(result?.tags.join(', ') ?? '')
    } finally {
      setDetailLoading(false)
    }
  }

  const retry = async (id: string): Promise<void> => {
    try {
      const result = await window.visslm.retryKnowledgeDocument(id)
      result ? message.success(`已重新处理 ${result.fileName}`) : message.error('文档不存在')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const remove = (document: KnowledgeDocument): void => {
    modal.confirm({
      title: `确认从知识库删除“${document.fileName}”？`,
      content: '只会移除知识库索引和元数据，不会删除电脑上的原始文件。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const result = await window.visslm.deleteKnowledgeDocument(document.id)
        result.ok ? message.success(result.message) : message.error(result.message)
        if (detail?.id === document.id) setDetail(null)
        await load()
      }
    })
  }

  const rebuild = async (): Promise<void> => {
    setRebuilding(true)
    try {
      const result = await window.visslm.rebuildKnowledgeIndex()
      message.success(result.message)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRebuilding(false)
    }
  }

  const saveTags = async (): Promise<void> => {
    if (!detail) return
    const result = await window.visslm.updateKnowledgeDocumentTags(
      detail.id,
      tagDraft.split(/[,，]/g)
    )
    if (result) {
      setDetail({ ...detail, tags: result.tags, updatedAt: result.updatedAt })
      message.success('标签已保存')
      await load()
    }
  }

  return (
    <div className="knowledge-page page-stack">
      <div className="knowledge-toolbar page-toolbar">
        <Space wrap>
          <Button type="primary" icon={<CloudUploadOutlined />} loading={uploading} onClick={() => void upload()}>
            上传文档
          </Button>
          <Button icon={<ReloadOutlined />} loading={rebuilding} onClick={() => void rebuild()}>
            重建向量索引
          </Button>
        </Space>
        <Text type="secondary">支持 DOCX、PDF、XLSX/XLS、TXT，单文件不超过 100 MB</Text>
      </div>
      <div className="knowledge-metric-grid">
        <Card size="small"><Statistic title="文档" value={stats?.documentCount ?? 0} /></Card>
        <Card size="small" className="knowledge-metric-card knowledge-metric-card-success"><Statistic title="已就绪" value={stats?.readyCount ?? 0} /></Card>
        <Card size="small"><Statistic title="索引分块" value={stats?.indexedChunkCount ?? 0} /></Card>
        <Card size="small"><Statistic title="采集记录" value={stats?.recordCount ?? 0} /></Card>
      </div>
      {(progress?.status === 'running' || progress?.phase === 'error') && (
        <div className={`knowledge-progress ${progress.phase === 'error' ? 'has-error' : ''}`}>
          <div className="knowledge-progress-heading">
            <Text strong>{progress.message}</Text>
            {progress.total > 0 && <Text type="secondary">{progress.current}/{progress.total}</Text>}
          </div>
          <Progress
            percent={progress.total ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : undefined}
            status={progress.status === 'failed' ? 'exception' : 'active'}
            showInfo={false}
          />
        </div>
      )}
      <Card className="knowledge-list-card">
        <div className="knowledge-filter-bar">
          <Input.Search
            allowClear
            placeholder="搜索文件名或失败原因"
            prefix={<SearchOutlined />}
            onSearch={(value) => { setSearch(value); setPage(1) }}
            style={{ width: 300 }}
          />
          <Select
            allowClear
            placeholder="全部状态"
            value={status}
            onChange={(value) => { setStatus(value); setPage(1) }}
            options={Object.entries(knowledgeStatusMeta).map(([value, item]) => ({ value, label: item.label }))}
            style={{ width: 140 }}
          />
          <Select
            allowClear
            placeholder="全部类型"
            value={extension}
            onChange={(value) => { setExtension(value); setPage(1) }}
            options={['.docx', '.pdf', '.xlsx', '.xls', '.txt'].map((value) => ({ value, label: value.toUpperCase() }))}
            style={{ width: 130 }}
          />
          <Input
            allowClear
            placeholder="标签"
            value={tag}
            onChange={(event) => setTag(event.target.value)}
            onPressEnter={() => setPage(1)}
            style={{ width: 160 }}
          />
        </div>
        <ResizableTable<KnowledgeDocument>
          tableKey="knowledge-documents"
          rowKey="id"
          loading={loading}
          dataSource={documents}
          scroll={{ x: 980, y: appTableScrollY }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 个文档`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          columns={[
            {
              title: '文档',
              key: 'fileName',
              width: 330,
              render: (_value, document) => (
                <Button type="link" className="knowledge-name-button" onClick={() => void openDetail(document.id)}>
                  <span className="knowledge-file-icon">{knowledgeFileIcon(document.extension)}</span>
                  <span>{document.fileName}</span>
                </Button>
              )
            },
            { title: '状态', dataIndex: 'status', width: 110, render: (value: KnowledgeDocument['status']) => <Tag color={knowledgeStatusMeta[value].color}>{knowledgeStatusMeta[value].label}</Tag> },
            { title: '分块', dataIndex: 'chunkCount', width: 80 },
            { title: '标签', dataIndex: 'tags', width: 200, render: (tags: string[]) => tags.length ? tags.map((item) => <Tag key={item}>{item}</Tag>) : <Text type="secondary">未设置</Text> },
            { title: '大小', dataIndex: 'byteSize', width: 100, render: formatBytes },
            { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: formatDate },
            {
              title: '操作',
              key: 'actions',
              fixed: 'right',
              width: 150,
              render: (_value, document) => (
                <Space size={4}>
                  {(document.status === 'failed' || document.status === 'ready') && (
                    <Button type="link" size="small" icon={<ReloadOutlined />} onClick={() => void retry(document.id)}>
                      {document.status === 'failed' ? '重试' : '重新解析'}
                    </Button>
                  )}
                  <Button type="link" danger size="small" icon={<DeleteOutlined />} onClick={() => remove(document)}>删除</Button>
                </Space>
              )
            }
          ]}
        />
      </Card>
      <Drawer
        className="knowledge-detail-drawer"
        title={detail ? (
          <div className="drawer-context-title">
            <BulbOutlined />
            <span>知识库文档</span>
            <strong title={detail.fileName}>{detail.fileName}</strong>
          </div>
        ) : '知识库文档'}
        size={720}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        <Spin spinning={detailLoading}>
          {detail && (
            <div className="knowledge-detail-stack">
              <Descriptions bordered size="small" column={2}>
                <Descriptions.Item label="格式">{detail.extension.toUpperCase()}</Descriptions.Item>
                <Descriptions.Item label="大小">{formatBytes(detail.byteSize)}</Descriptions.Item>
                <Descriptions.Item label="状态"><Tag color={knowledgeStatusMeta[detail.status].color}>{knowledgeStatusMeta[detail.status].label}</Tag></Descriptions.Item>
                <Descriptions.Item label="页数/工作表">{detail.pageCount || '-'}</Descriptions.Item>
                <Descriptions.Item label="SHA-256" span={2}><Text copyable ellipsis>{detail.sha256}</Text></Descriptions.Item>
              </Descriptions>
              {detail.errorMessage && <Alert type="error" showIcon title={detail.errorMessage} />}
              <div className="knowledge-tag-editor">
                <Text strong>标签</Text>
                <Input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder="用逗号分隔多个标签" />
                <Button onClick={() => void saveTags()}>保存标签</Button>
              </div>
              <Divider titlePlacement="start">分块预览（{detail.chunks.length}）</Divider>
              <div className="knowledge-chunk-list">
                {detail.chunks.slice(0, 30).map((chunk) => (
                  <div className="knowledge-chunk-item" key={chunk.id}>
                    <div className="knowledge-chunk-meta"><Tag>{chunk.location || `分块 ${chunk.chunkIndex + 1}`}</Tag><Text type="secondary">#{chunk.chunkIndex + 1}</Text></div>
                    <Paragraph ellipsis={{ rows: 4, expandable: true }}>{chunk.content}</Paragraph>
                  </div>
                ))}
              </div>
              {detail.chunks.length > 30 && <Text type="secondary">仅预览前 30 个分块</Text>}
            </div>
          )}
        </Spin>
      </Drawer>
    </div>
  )
}

function ChatPage({
  messages,
  setMessages,
  question,
  setQuestion,
  loading,
  setLoading,
  onOpenDashboard,
  onDashboardUpdate,
  activeArtifact,
  activeArtifactVersion,
  dataScope,
  dataScopeSummary,
  onClearDataScope,
  conversationId,
  onConversationIdChange,
  modelOnline,
  modelName,
  onOpenSettings,
  onOpenSync,
  refreshKey
}: {
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  question: string
  setQuestion: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
  onOpenDashboard: (dashboard: DashboardSpec, version?: number) => void
  onDashboardUpdate: (dashboard: DashboardSpec, version?: number) => void
  activeArtifact: DashboardSpec | null
  activeArtifactVersion?: number
  dataScope: DataScope | null
  dataScopeSummary: string
  onClearDataScope: () => void
  conversationId: string
  onConversationIdChange: (id: string) => void
  modelOnline: boolean | null
  modelName?: string
  onOpenSettings: () => void
  onOpenSync: () => void
  refreshKey: number
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const messageListRef = useRef<HTMLDivElement>(null)
  const [activeDataView, setActiveDataView] = useState<ChatDataView | null>(null)
  const [activeDataGroup, setActiveDataGroup] = useState('')
  const [activeRecordDetail, setActiveRecordDetail] = useState<RecordDetail | null>(null)
  const [recordDetailModalOpen, setRecordDetailModalOpen] = useState(false)
  const [activeKnowledgeDetail, setActiveKnowledgeDetail] = useState<KnowledgeDocumentDetail | null>(null)
  const [recordDetailLoading, setRecordDetailLoading] = useState(false)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [agentProgress, setAgentProgress] = useState<Array<Extract<AgentEvent, { type: 'status' }>>>([])
  const [artifactAttached, setArtifactAttached] = useState(Boolean(activeArtifact))
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve())
  const [historySessions, setHistorySessions] = useState<ChatSessionSummary[]>([])
  const [historyRefreshing, setHistoryRefreshing] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [workspaceStats, setWorkspaceStats] = useState<KnowledgeStats | null>(null)
  const [workspaceDataStats, setWorkspaceDataStats] = useState<DashboardStats | null>(null)
  const [workspaceStatsLoading, setWorkspaceStatsLoading] = useState(true)
  const selectedDataGroup = activeDataView?.groups.find(
    (group) => group.name === activeDataGroup
  ) ?? activeDataView?.groups[0]

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryRefreshing(true)
    try {
      setHistorySessions(await window.visslm.listChatSessions(50))
    } catch (error) {
      message.warning(`历史会话加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setHistoryRefreshing(false)
    }
  }, [message])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  useEffect(() => {
    let active = true
    setWorkspaceStatsLoading(true)
    void Promise.allSettled([
      window.visslm.getKnowledgeStats(),
      window.visslm.getStats()
    ])
      .then(([knowledgeResult, dataResult]) => {
        if (!active) return
        setWorkspaceStats(knowledgeResult.status === 'fulfilled' ? knowledgeResult.value : null)
        setWorkspaceDataStats(dataResult.status === 'fulfilled' ? dataResult.value : null)
      })
      .finally(() => {
        if (active) setWorkspaceStatsLoading(false)
      })
    return () => {
      active = false
    }
  }, [refreshKey])

  useEffect(() => {
    setArtifactAttached(Boolean(activeArtifact))
  }, [activeArtifact])

  const openDataView = (view: ChatDataView): void => {
    setActiveDataView(view)
    setActiveDataGroup(view.groups[0]?.name ?? '')
    setActiveRecordDetail(null)
    setRecordDetailModalOpen(false)
  }

  const closeDataView = (): void => {
    setActiveDataView(null)
    setActiveDataGroup('')
    setActiveRecordDetail(null)
    setRecordDetailModalOpen(false)
    setActiveKnowledgeDetail(null)
    setRecordDetailLoading(false)
  }

  const persistSession = useCallback((sessionId: string, sessionMessages: ChatMessage[]): Promise<void> => {
    if (!sessionMessages.length) return Promise.resolve()
    const firstUserMessage = sessionMessages.find((item) => item.role === 'user')
    const save = async (): Promise<void> => {
      try {
        await window.visslm.saveChatSession({
          id: sessionId,
          title: firstUserMessage?.content,
          messages: sessionMessages
        })
        await refreshHistory()
      } catch (error) {
        message.warning(`历史会话保存失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    persistQueueRef.current = persistQueueRef.current.then(save, save)
    return persistQueueRef.current
  }, [message, refreshHistory])

  const resetConversation = (successMessage = '已开始新会话'): void => {
    const nextConversationId = crypto.randomUUID()
    onConversationIdChange(nextConversationId)
    setMessages([])
    setQuestion('')
    setMentionOpen(false)
    setAgentProgress([])
    setArtifactAttached(false)
    onClearDataScope()
    closeDataView()
    message.success(successMessage)
  }

  const mentionCandidates = useMemo(
    () => chatExperts.filter((expert) =>
      `${expert.name}${expert.mention}`.toLocaleLowerCase().includes(mentionQuery.toLocaleLowerCase())
    ),
    [mentionQuery]
  )

  const updateQuestion = (value: string): void => {
    setQuestion(value)
    const match = value.match(/(?:^|\s)@([^@\s]*)$/)
    setMentionOpen(Boolean(match))
    setMentionQuery(match?.[1] ?? '')
    setMentionIndex(0)
  }

  const selectExpert = (expert: (typeof chatExperts)[number]): void => {
    setQuestion((current) => {
      const match = current.match(/(^|\s)@[^@\s]*$/)
      if (!match || match.index === undefined) return `${expert.mention} ${current}`.trimStart()
      const prefix = current.slice(0, match.index) + match[1]
      return `${prefix}${expert.mention} `
    })
    setMentionOpen(false)
  }

  const startNewConversation = (): void => {
    if (loading) return
    if (messages.length === 0 && !question.trim()) {
      resetConversation()
      return
    }
    modal.confirm({
      title: '开始新会话？',
      content: '当前消息和未发送内容将被清空，后续提问不会沿用本次会话上下文。',
      okText: '开始新会话',
      cancelText: '取消',
      onOk: resetConversation
    })
  }

  const loadSessionById = async (sessionId: string): Promise<void> => {
    setHistoryLoading(true)
    try {
      const session = await window.visslm.getChatSession(sessionId)
      if (!session) {
        message.warning('历史会话不存在或已被清理')
        await refreshHistory()
        return
      }
      onConversationIdChange(session.id)
      setMessages(session.messages)
      setQuestion('')
      setMentionOpen(false)
      setAgentProgress([])
      onClearDataScope()
      closeDataView()
      const latestDashboardMessage = [...session.messages]
        .reverse()
        .find((item) => item.dashboard)
      if (latestDashboardMessage?.dashboard) {
        onDashboardUpdate(latestDashboardMessage.dashboard, latestDashboardMessage.dashboardVersion)
        setArtifactAttached(true)
      } else {
        setArtifactAttached(false)
      }
      message.success(`已加载历史会话：${session.title}`)
    } catch (error) {
      message.error(`历史会话加载失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setHistoryLoading(false)
    }
  }

  const requestLoadSession = (session: ChatSessionSummary): void => {
    if (loading || historyLoading || session.id === conversationId) return
    const load = (): Promise<void> => loadSessionById(session.id)
    if (!messages.length && !question.trim()) {
      void load()
      return
    }
    modal.confirm({
      title: '切换历史会话？',
      content: '当前会话中的草稿和未保存内容将被清空。',
      okText: '加载会话',
      cancelText: '继续当前会话',
      onOk: load
    })
  }

  const requestDeleteSession = (session: ChatSessionSummary): void => {
    if (loading || historyLoading) return
    modal.confirm({
      title: '删除历史会话？',
      content: `“${session.title}”及其消息记录将被删除，无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setHistoryLoading(true)
        try {
          const result = await window.visslm.deleteChatSession(session.id)
          if (!result.ok) {
            message.warning(result.message)
            return
          }
          setHistorySessions((items) => items.filter((item) => item.id !== session.id))
          if (session.id === conversationId) {
            resetConversation('当前会话已删除，已开始新会话')
          } else {
            message.success('历史会话已删除')
          }
        } catch (error) {
          message.error(`历史会话删除失败：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          setHistoryLoading(false)
        }
      }
    })
  }

  const openRecordDetail = async (row: ChatDataRow, standalone = false): Promise<void> => {
    if (standalone) {
      setActiveDataView(null)
      setActiveDataGroup('')
      setRecordDetailModalOpen(true)
    }
    setActiveRecordDetail(null)
    setRecordDetailLoading(true)
    try {
      const detail = await window.visslm.getRecord(row.uid)
      if (detail) {
        setActiveRecordDetail(detail)
      } else {
        message.warning('回答依据对应的记录不存在或已被删除')
        if (standalone) setRecordDetailModalOpen(false)
      }
    } catch (error) {
      message.error(`记录详情加载失败：${error instanceof Error ? error.message : String(error)}`)
      if (standalone) setRecordDetailModalOpen(false)
    } finally {
      setRecordDetailLoading(false)
    }
  }

  const openKnowledgeDetail = async (documentId: string): Promise<void> => {
    const detail = await window.visslm.getKnowledgeDocument(documentId)
    if (detail) setActiveKnowledgeDetail(detail)
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = messageListRef.current
      if (container) {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [messages.length, loading])

  useEffect(() => window.visslm.onAgentEvent((update) => {
    if (update.conversationId !== conversationId || update.event.type !== 'status') return
    const statusEvent: Extract<AgentEvent, { type: 'status' }> = update.event
    setAgentProgress((items) => [...items, statusEvent].slice(-20))
  }), [conversationId])

  const send = async (overrideQuestion?: string): Promise<void> => {
    const text = (overrideQuestion ?? question).trim()
    if (!text || loading) return
    if (modelOnline !== true) {
      message.warning('模型未连接，请先完成系统配置')
      return
    }
    const sessionId = conversationId
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    const next = [...messages, userMessage]
    setMessages(next)
    setQuestion('')
    setMentionOpen(false)
    setAgentProgress([])
    setLoading(true)
    try {
      const requestsVisualization = /@数据可视化专家(?:\s|$)/.test(text)
      const requestArtifact = requestsVisualization && artifactAttached ? activeArtifact : null
      const contextMessages = messages
        .filter((message) => message.contextOutcome !== 'failed' && message.contextOutcome !== 'undone')
        .map(({ role, content, contextOutcome }) => ({
          role,
          content,
          ...(contextOutcome ? { outcome: contextOutcome } : {})
        }))
      const response = await window.visslm.askAgent({
        question: text,
        conversationId: sessionId,
        entrypoint: 'chat',
        expertId: 'general',
        ...(dataScope ? { dataScope } : {}),
        ...(requestArtifact
          ? {
              activeArtifact: {
                artifactId: requestArtifact.id,
                ...(activeArtifactVersion === undefined ? {} : { version: activeArtifactVersion }),
                dashboard: requestArtifact
              }
            }
          : {}),
        history: requestArtifact ? contextMessages : contextMessages.slice(-8)
      })
      const responseError = response.events?.find((event) => event.type === 'error')
      if (responseError?.recoverable) {
        setQuestion(text)
      }
      if (requestArtifact && (responseError || !response.dashboard)) {
        throw new Error(responseError?.message ?? response.answer)
      }
      const dashboardVersion = artifactVersionOf(response.events)
      if (response.dashboard) {
        onDashboardUpdate(response.dashboard, dashboardVersion)
        setArtifactAttached(true)
      }
      const completedMessages: ChatMessage[] = [
        ...messages,
        { ...userMessage, contextOutcome: responseError ? 'failed' : 'success' },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.answer,
          ...(responseError ? { retryQuestion: text } : {}),
          sources: response.sources,
          dataViews: response.dataViews,
          dashboard: response.dashboard,
          dashboardVersion,
          expertId: response.expertId,
          createdAt: new Date().toISOString(),
          contextOutcome: responseError ? 'failed' : 'success'
        }
      ]
      setMessages(completedMessages)
      void persistSession(sessionId, completedMessages)
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const errorMessage = rawMessage.replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        ''
      )
      setQuestion(text)
      const failedMessages: ChatMessage[] = [
        ...messages,
        { ...userMessage, contextOutcome: 'failed' },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `请求失败：${errorMessage}`,
          retryQuestion: text,
          createdAt: new Date().toISOString(),
          contextOutcome: 'failed'
        }
      ]
      setMessages(failedMessages)
      void persistSession(sessionId, failedMessages)
    } finally {
      setLoading(false)
    }
  }

  const copyAnswer = async (content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      message.success('回答已复制')
    } catch {
      message.warning('当前环境无法访问剪贴板，请手动选择文本复制')
    }
  }

  const dataRecordCount = workspaceDataStats?.recordCount ?? 0
  const hasData = dataRecordCount > 0
  const hasKnowledge = Boolean(workspaceStats?.indexedChunkCount)
  const latestStatus = agentProgress.at(-1)
  const agentStageLabel: Record<string, string> = {
    route: '理解需求',
    locate: '定位编号',
    retrieve: '检索依据',
    match: '计算匹配',
    plan: '规划查询',
    query: '执行查询',
    verify: '核对结果',
    reason: '复核语义',
    critique: '独立复核',
    answer: '整理回答',
    error: '任务中断'
  }
  const visibleAgentProgress = useMemo(() => {
    const latestByStage = new Map<string, Extract<AgentEvent, { type: 'status' }>>()
    agentProgress.forEach((event) => latestByStage.set(event.stage, event))
    return [...latestByStage.values()].slice(-6)
  }, [agentProgress])

  const promptSuggestions = [
    {
      prompt: '@需求分析专家 分析需求编号 VISSLM-TSIS-3959',
      title: '分析需求匹配',
      description: '按编号核对相似数据',
      icon: <FileSearchOutlined />
    },
    {
      prompt: '按类型统计当前数据',
      title: '分析数据分布',
      description: '按对象类型汇总知识库',
      icon: <BarChartOutlined />
    },
    {
      prompt: '有哪些最近修改的任务？',
      title: '查找最近变更',
      description: '定位近期更新的数据',
      icon: <FileSearchOutlined />
    },
    {
      prompt: '知识库中有多少张图片？',
      title: '统计图片资源',
      description: '了解已采集图片数量',
      icon: <PictureOutlined />
    },
    {
      prompt: '当前数据有哪些可用字段？',
      title: '查看数据结构',
      description: '确认字段、覆盖率和样例',
      icon: <DatabaseOutlined />
    }
  ]

  return (
    <div className="chat-page chat-workspace-v2">
      <aside className="chat-history-panel" aria-label="历史会话">
        <div className="chat-history-panel-header">
          <div className="chat-history-title">
            <HistoryOutlined />
            <span>历史会话</span>
          </div>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            loading={historyRefreshing}
            aria-label="刷新历史会话"
            onClick={() => void refreshHistory()}
          />
        </div>
        <div className="chat-history-panel-body">
          <Text type="secondary" className="chat-history-hint">
            点击会话可继续提问
          </Text>
          {historyLoading ? (
            <div className="chat-history-loading"><Spin /></div>
          ) : historySessions.length ? (
            <div className="chat-history-list">
              {historySessions.map((session) => (
                <div
                  role="button"
                  tabIndex={loading || historyLoading ? -1 : 0}
                  aria-disabled={loading || historyLoading}
                  className={`chat-history-item ${session.id === conversationId ? 'active' : ''}`}
                  key={session.id}
                  onClick={() => requestLoadSession(session)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      requestLoadSession(session)
                    }
                  }}
                >
                  <span className="chat-history-item-main">
                    <strong>{session.title}</strong>
                    <small>{session.preview || '暂无消息预览'}</small>
                  </span>
                  <span className="chat-history-item-meta">
                    <span>{session.messageCount} 条</span>
                    <time>{formatChatSessionTime(session.updatedAt)}</time>
                  </span>
                  <Button
                    className="chat-history-delete"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={loading || historyLoading}
                    aria-label={`删除历史会话：${session.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestDeleteSession(session)
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              className="chat-history-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无历史会话"
            />
          )}
        </div>
      </aside>
      <Card className="chat-card">
        <div className="chat-toolbar chat-toolbar-v2">
          <div className="chat-session-label">
            <MessageOutlined />
            <div className="chat-session-copy">
              <Text strong>{messages.length ? '工作会话' : '新的数据任务'}</Text>
              <Text type="secondary">
                {messages.length ? `${messages.length} 条消息` : '从问题开始，让 Agent 执行可核验的查询'}
              </Text>
            </div>
          </div>
          <div className="chat-toolbar-actions">
            <div className="chat-health-strip" aria-label="AI 工作区状态">
              <span className={`chat-health-item ${modelOnline === true ? 'success' : modelOnline === false ? 'error' : 'pending'}`}>
                {modelOnline === true ? <CheckCircleOutlined /> : modelOnline === false ? <ExclamationCircleOutlined /> : <InfoCircleOutlined />}
                <span>{modelOnline === true ? '模型可用' : modelOnline === false ? '模型离线' : '检测模型'}</span>
              </span>
              <span className={`chat-health-item ${hasData ? 'success' : 'warning'}`}>
                <DatabaseOutlined />
                <span>{workspaceStatsLoading ? '读取数据' : hasData ? `${dataRecordCount} 条记录` : '暂无数据'}</span>
              </span>
            </div>
            <Button
              className="new-conversation-button"
              type="text"
              icon={<PlusOutlined />}
              disabled={loading}
              onClick={startNewConversation}
            >
              新建会话
            </Button>
          </div>
        </div>
        <div className="message-list" ref={messageListRef}>
          {messages.length === 0 ? (
            <div className="chat-empty chat-welcome">
              <div className="chat-welcome-hero">
                <div className="assistant-orb">
                  <ThemedAppIcon alt="VISSLM AI" />
                  <span className="assistant-orb-status" />
                </div>
                <div className="chat-welcome-copy">
                  <Tag className="knowledge-ready-tag" icon={hasKnowledge ? <CheckCircleOutlined /> : <BulbOutlined />}>
                    {hasKnowledge ? '知识库可检索' : '知识库待准备'}
                  </Tag>
                  <Title level={3}>把数据问题交给 Agent</Title>
                  <Text type="secondary" className="chat-empty-description">
                    先确认事实，再给出结论；每个查询都可展开查看原始记录和依据。
                  </Text>
                </div>
              </div>
              <div className="chat-welcome-status-grid">
                <div className={modelOnline === true ? 'ready' : modelOnline === false ? 'blocked' : 'pending'}>
                  {modelOnline === true ? <CheckCircleOutlined /> : modelOnline === false ? <ExclamationCircleOutlined /> : <InfoCircleOutlined />}
                  <span>
                    <strong>{modelOnline === true ? '模型服务已连接' : modelOnline === false ? '模型服务未连接' : '正在检测模型服务'}</strong>
                    <small>{modelName || '请在系统配置中选择模型'}</small>
                  </span>
                  {modelOnline === false && <Button type="link" size="small" onClick={onOpenSettings}>去配置</Button>}
                </div>
                <div className={hasData ? 'ready' : 'blocked'}>
                  {hasData ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
                  <span>
                    <strong>{hasData ? '数据资产可用' : '还没有可查询数据'}</strong>
                    <small>{hasData ? `${dataRecordCount} 条记录 · ${workspaceStats?.indexedChunkCount ?? 0} 个索引分块` : '先完成一次数据采集'}</small>
                  </span>
                  {!hasData && <Button type="link" size="small" onClick={onOpenSync}>去采集</Button>}
                </div>
              </div>
              {modelOnline === false && (
                <Alert
                  className="chat-welcome-alert"
                  type="warning"
                  showIcon
                  icon={<ExclamationCircleOutlined />}
                  title="当前不能执行模型任务"
                  description="请检查模型地址、模型名称和 API Key。"
                  action={<Button size="small" onClick={onOpenSettings}>打开配置</Button>}
                />
              )}
              <div className="chat-task-prompt-heading">
                <div>
                  <Text strong>从一个具体问题开始</Text>
                  <Text type="secondary">常用任务</Text>
                </div>
                <Tag icon={<InfoCircleOutlined />}>支持自然语言追问</Tag>
              </div>
              <div className="prompt-grid">
                {promptSuggestions.map((item) => (
                  <Button
                    className="prompt-card"
                    key={item.prompt}
                    onClick={() => {
                      setQuestion(item.prompt)
                      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
                    }}
                  >
                    <span className="prompt-card-icon">{item.icon}</span>
                    <span className="prompt-card-copy">
                      <strong>{item.title}</strong>
                      <small>{item.description}</small>
                    </span>
                    <span className="prompt-card-arrow">→</span>
                  </Button>
                ))}
              </div>
              <div className="chat-welcome-footnote">
                <BulbOutlined />
                <span>结果会标注数据依据；不确定时会明确说明，而不是补写不存在的结论。</span>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div className={`message-row ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === 'assistant'
                    ? <ThemedAppIcon alt="VISSLM AI" />
                    : <UserOutlined />}
                </div>
                <div className="message-content">
                  <div className="message-meta">
                    <Text strong>{message.role === 'assistant' ? 'VISSLM AI' : '你'}</Text>
                    <Text type="secondary">
                      {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </Text>
                  </div>
                  <div
                    className="message-bubble"
                    role={message.contextOutcome === 'failed' ? 'alert' : undefined}
                  >
                    {message.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    ) : (
                      <Paragraph>{message.content}</Paragraph>
                    )}
                    {message.role === 'assistant' && (
                      <div className="message-tools">
                        <Tooltip title="复制回答">
                          <Button
                            type="text"
                            size="small"
                            icon={<CopyOutlined />}
                            aria-label="复制回答"
                            onClick={() => void copyAnswer(message.content)}
                          />
                        </Tooltip>
                        {message.retryQuestion && (
                          <Button
                            type="link"
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={() => void send(message.retryQuestion)}
                            disabled={loading}
                          >
                            重试本次任务
                          </Button>
                        )}
                        {message.contextOutcome === 'failed' && (
                          <Tag color="error">未完成</Tag>
                        )}
                      </div>
                    )}
                    {message.dataViews?.length ? (
                      <div className="chat-data-action">
                        <Button
                          icon={<EyeOutlined />}
                          onClick={() => openDataView(message.dataViews![0])}
                        >
                          查看查询数据
                        </Button>
                        <Text type="secondary">
                          {message.dataViews[0].total} 条
                        </Text>
                      </div>
                    ) : null}
                    {message.dashboard ? (
                      <div className="chat-data-action">
                        <Button
                          type="primary"
                          icon={<FundProjectionScreenOutlined />}
                          onClick={() => onOpenDashboard(message.dashboard!, message.dashboardVersion)}
                        >
                          打开可视化大屏
                        </Button>
                        <Text type="secondary">
                          {message.dashboard.components.length} 个组件
                        </Text>
                      </div>
                    ) : null}
                    {message.role === 'assistant' && message.sources?.length ? (
                      <div className="source-list">
                        <div className="source-list-title">
                          <BulbOutlined />
                          <Text strong>回答依据</Text>
                          <Text type="secondary" className="source-list-count">{message.sources.length} 条</Text>
                        </div>
                        <div className="source-chips">
                          {message.sources.map((source, index) => (
                            <Button
                              type="text"
                              className="source-chip"
                              key={`${source.chunkId ?? source.uid}-${index}`}
                              aria-label={`打开回答依据 ${source.name}`}
                              onClick={() => source.sourceType === 'document' && source.documentId
                                ? void openKnowledgeDetail(source.documentId)
                                : void openRecordDetail({
                                    uid: source.uid,
                                    name: source.name,
                                    nodeType: source.nodeType,
                                    itemId: source.itemId,
                                    values: {}
                                  }, true)}
                            >
                              {source.sourceType === 'document' ? <FileTextOutlined /> : <DatabaseOutlined />}
                              <span>
                                <strong>[{index + 1}] {source.name}</strong>
                                <small>{source.location || source.nodeType}{source.snippet ? ` · ${source.snippet.slice(0, 80)}` : ''}</small>
                              </span>
                            </Button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            ))
          )}
          {loading && (
            <div className="message-row assistant">
              <div className="message-avatar">
                <ThemedAppIcon alt="VISSLM AI" />
              </div>
              <div className="message-content">
                <div className="message-meta">
                  <Text strong>VISSLM AI</Text>
                  <Text type="secondary">正在思考</Text>
                </div>
                <div className="message-bubble thinking">
                  <div className="agent-run-panel" aria-live="polite">
                    <div className="agent-run-current">
                      <span className="thinking-dots"><i /><i /><i /></span>
                      <span>{latestStatus?.message ?? '正在准备任务'}</span>
                      <Tag>{agentStageLabel[latestStatus?.stage ?? 'route'] ?? '执行中'}</Tag>
                    </div>
                    <div className="agent-run-steps" aria-label="Agent 执行阶段">
                      {(visibleAgentProgress.length ? visibleAgentProgress : [{ stage: 'route', message: '准备执行' }]).map((event, index, items) => (
                        <span className={index === items.length - 1 ? 'active' : 'complete'} key={`${event.stage}-${index}`}>
                          {index === items.length - 1 ? <InfoCircleOutlined /> : <CheckCircleOutlined />}
                          <span>{agentStageLabel[event.stage] ?? event.stage}</span>
                        </span>
                      ))}
                    </div>
                    <Text type="secondary" className="agent-run-note">
                      只使用本地数据和已检索依据，完成后可打开查询明细核对。
                    </Text>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="composer">
          {(dataScope || (artifactAttached && activeArtifact)) && (
            <div className="chat-context-row">
              {dataScope && (
                <div className="chat-data-scope">
                  <span>
                    <DatabaseOutlined />
                    <strong>可视化范围</strong>
                    <Text type="secondary">{dataScopeSummary}</Text>
                  </span>
                  <Button type="text" size="small" onClick={onClearDataScope}>
                    清除
                  </Button>
                </div>
              )}
              {artifactAttached && activeArtifact && (
                <Tag className="chat-artifact-context" icon={<FundProjectionScreenOutlined />}>
                  已附加大屏：{activeArtifact.title}
                </Tag>
              )}
            </div>
          )}
          <div className="composer-input">
            {mentionOpen && (
              <div className="expert-mention-menu" role="listbox" aria-label="选择专家">
                {mentionCandidates.length ? mentionCandidates.map((expert, index) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? 'selected' : ''}
                    key={expert.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectExpert(expert)}
                  >
                    <span className="expert-mention-icon">
                      {expert.id === 'visualization'
                        ? <FundProjectionScreenOutlined />
                        : expert.id === 'requirement-analysis'
                          ? <FileSearchOutlined />
                          : <MessageOutlined />}
                    </span>
                    <span>
                      <strong>{expert.name}</strong>
                      <small>{expert.description}</small>
                    </span>
                    <Tag>{expert.mention}</Tag>
                  </button>
                )) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配的专家" />
                )}
              </div>
            )}
            <Input.TextArea
              value={question}
              onChange={(event) => updateQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (mentionOpen && mentionCandidates.length) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    const direction = event.key === 'ArrowDown' ? 1 : -1
                    setMentionIndex((index) =>
                      (index + direction + mentionCandidates.length) % mentionCandidates.length
                    )
                    return
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault()
                    selectExpert(mentionCandidates[mentionIndex] ?? mentionCandidates[0])
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setMentionOpen(false)
                    return
                  }
                }
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  if (modelOnline !== true) {
                    message.warning('模型未连接，请先完成系统配置')
                    return
                  }
                  void send()
                }
              }}
              autoSize={{ minRows: 1, maxRows: 5 }}
              variant="borderless"
              placeholder="向本地知识库提问…"
            />
            <div className="composer-footer">
              <span className="composer-hint">
                <kbd>Enter</kbd> 发送
                <span className="composer-hint-divider">·</span>
                <kbd>Shift + Enter</kbd> 换行
              </span>
              <Button
                size="small"
                icon={<FundProjectionScreenOutlined />}
                onClick={() => {
                  const prefix = question && !question.endsWith(' ') ? `${question} ` : question
                  updateQuestion(`${prefix}@`)
                }}
              >
                选择专家
              </Button>
              <Button
                className="chat-send-button"
                type="primary"
                icon={<SendOutlined />}
                loading={loading}
                disabled={!question.trim() || modelOnline !== true}
                onClick={() => void send()}
              >
                发送
              </Button>
            </div>
          </div>
          <Text type="secondary" className="composer-disclaimer">
            {modelOnline === false
              ? '模型未连接，发送前请先完成系统配置'
              : `${modelName || '当前模型'} · 回答可通过“查看查询数据”核实`}
          </Text>
        </div>
      </Card>
      <Drawer
        title={activeKnowledgeDetail?.fileName ?? '知识库文档'}
        size={720}
        open={Boolean(activeKnowledgeDetail)}
        onClose={() => setActiveKnowledgeDetail(null)}
      >
        {activeKnowledgeDetail && (
          <div className="knowledge-detail-stack">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="格式">{activeKnowledgeDetail.extension.toUpperCase()}</Descriptions.Item>
              <Descriptions.Item label="分块">{activeKnowledgeDetail.chunkCount}</Descriptions.Item>
              <Descriptions.Item label="标签" span={2}>
                {activeKnowledgeDetail.tags.length ? activeKnowledgeDetail.tags.map((tag) => <Tag key={tag}>{tag}</Tag>) : '未设置'}
              </Descriptions.Item>
            </Descriptions>
            <Divider titlePlacement="start">匹配分块</Divider>
            {activeKnowledgeDetail.chunks.slice(0, 20).map((chunk) => (
              <div className="knowledge-chunk-item" key={chunk.id}>
                <div className="knowledge-chunk-meta"><Tag>{chunk.location || `分块 ${chunk.chunkIndex + 1}`}</Tag></div>
                <Paragraph>{chunk.content}</Paragraph>
              </div>
            ))}
          </div>
        )}
      </Drawer>
      <Modal
        className="chat-data-modal"
        width="min(1120px, calc(100vw - 48px))"
        centered
        footer={null}
        open={Boolean(activeDataView || recordDetailModalOpen)}
        onCancel={closeDataView}
        destroyOnHidden
        title={
          <div className="chat-data-modal-title">
            <DatabaseOutlined />
            <span title={activeRecordDetail?.name ?? activeDataView?.title ?? '查询数据'}>
              {activeRecordDetail
                ? `数据中心记录 · ${activeRecordDetail.name}`
                : activeDataView?.title ?? '查询数据'}
            </span>
          </div>
        }
      >
        {(activeDataView || recordDetailModalOpen) && (
          <Spin spinning={recordDetailLoading}>
            {activeRecordDetail ? (
              <div className="chat-record-detail">
                <Button
                  className="chat-record-back"
                  type="link"
                  icon={<LeftOutlined />}
                  onClick={() => activeDataView ? setActiveRecordDetail(null) : closeDataView()}
                >
                  {activeDataView ? '返回查询列表' : '关闭详情'}
                </Button>
                <Descriptions bordered size="small" column={2}>
                  <Descriptions.Item label="名称" span={2}>
                    {activeRecordDetail.name}
                  </Descriptions.Item>
                  <Descriptions.Item label="UID">
                    {activeRecordDetail.uid}
                  </Descriptions.Item>
                  <Descriptions.Item label="类型">
                    {activeRecordDetail.nodeType}
                  </Descriptions.Item>
                  <Descriptions.Item label="业务编号">
                    {activeRecordDetail.itemId || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="项目 UID">
                    {activeRecordDetail.projectId || '—'}
                  </Descriptions.Item>
                  <Descriptions.Item label="最后修改时间" span={2}>
                    {formatDate(activeRecordDetail.lastModifyTime)}
                  </Descriptions.Item>
                </Descriptions>
                {activeRecordDetail.images.length > 0 && (
                  <>
                    <Divider titlePlacement="start">图片资源</Divider>
                    <Image.PreviewGroup>
                      <div className="image-grid">
                        {activeRecordDetail.images.map((image) => (
                          <div className="image-tile" key={image.id}>
                            <Image
                              src={image.dataUri ?? image.sourceUrl}
                              alt={image.name}
                              fallback=""
                            />
                            <div>{image.name}</div>
                          </div>
                        ))}
                      </div>
                    </Image.PreviewGroup>
                  </>
                )}
                <Divider titlePlacement="start">知识文本</Divider>
                <pre className="text-preview">
                  {activeRecordDetail.normalizedText || '暂无可索引文本'}
                </pre>
                <Collapse
                  className="chat-raw-details"
                  items={[{
                    key: 'raw',
                    label: '查看完整属性（原始 JSON）',
                    children: (
                      <pre className="json-preview">
                        {JSON.stringify(activeRecordDetail.raw, null, 2)}
                      </pre>
                    )
                  }]}
                />
              </div>
            ) : activeDataView ? (
              <div className="chat-data-modal-content">
                <div className="chat-data-summary">
                  <div>
                    <strong>{activeDataView.total}</strong>
                    <span>查询命中</span>
                  </div>
                  <Text type="secondary">{activeDataView.description}</Text>
                </div>
                {activeDataView.groups.length > 1 && (
                  <div className="chat-data-group-picker">
                    <Text strong>查看分组</Text>
                    <Select
                      value={selectedDataGroup?.name}
                      onChange={setActiveDataGroup}
                      options={activeDataView.groups.map((group) => ({
                        value: group.name,
                        label: `${group.name}（${group.count} 条）`
                      }))}
                      style={{ width: 280 }}
                    />
                  </div>
                )}
                {selectedDataGroup && (
                  <>
                    <div className="chat-data-table-meta">
                      <Text strong>{selectedDataGroup.name}</Text>
                      <Text type="secondary">
                        共 {selectedDataGroup.count} 条，当前展示{' '}
                        {selectedDataGroup.rows.length} 条
                      </Text>
                    </div>
                    <ResizableTable<ChatDataRow>
                      tableKey="chat-data-results"
                      rowKey="uid"
                      size="small"
                      dataSource={selectedDataGroup.rows}
                      scroll={{ x: 960, y: appTableScrollY }}
                      pagination={{
                        pageSize: 20,
                        showSizeChanger: true,
                        pageSizeOptions: [20, 50, 100],
                        showTotal: (count) => `当前清单 ${count} 条`
                      }}
                      columns={[
                        {
                          title: '名称',
                          dataIndex: 'name',
                          width: 280,
                          ellipsis: true,
                          render: (name: string, row: ChatDataRow) => (
                            <Button
                              className="chat-data-name-button"
                              type="link"
                              title={name}
                              onClick={() => void openRecordDetail(row)}
                            >
                              {name || '未命名记录'}
                            </Button>
                          )
                        },
                        {
                          title: '类型',
                          dataIndex: 'nodeType',
                          width: 110
                        },
                        {
                          title: '业务编号',
                          dataIndex: 'itemId',
                          width: 160,
                          ellipsis: true
                        },
                        {
                          title: 'UID',
                          dataIndex: 'uid',
                          width: 100
                        },
                        ...activeDataView.fields.map((field) => ({
                          title: activeDataView.fieldLabels?.[field] ?? field,
                          key: field,
                          width: 180,
                          ellipsis: true,
                          render: (_value: unknown, row: ChatDataRow) => {
                            const value = row.values[field]
                            return Array.isArray(value) ? value.join('、') : value || '—'
                          }
                        }))
                      ]}
                    />
                  </>
                )}
              </div>
            ) : (
              <div className="chat-record-detail chat-record-detail-loading">
                <Text type="secondary">正在加载记录详情...</Text>
              </div>
            )}
          </Spin>
        )}
      </Modal>
    </div>
  )
}

function SyncPage({
  progress,
  syncing,
  onSync,
  onDataChanged
}: {
  progress: SyncProgress | null
  syncing: boolean
  onSync: (config: SyncScopeConfig) => Promise<SyncResult | null>
  onDataChanged: () => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [config, setConfig] = useState<SyncScopeConfig>({ selectedTypes: [], rules: [] })
  const [typeInput, setTypeInput] = useState('')
  const [activeTypes, setActiveTypes] = useState<string[]>([])
  const [loadingConfig, setLoadingConfig] = useState(true)
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<SyncPreviewResult | null>(null)
  const [savedSignature, setSavedSignature] = useState('')
  const [activeTab, setActiveTab] = useState<'config' | 'logs'>('config')
  const [requestLogs, setRequestLogs] = useState<CollectionRequestLogRow[]>([])
  const [requestLogTotal, setRequestLogTotal] = useState(0)
  const [requestLogsLoading, setRequestLogsLoading] = useState(false)
  const [review, setReview] = useState<{ batchId: string; items: DataReviewItem[] } | null>(null)

  const configSignature = useMemo(() => JSON.stringify(config), [config])
  const isConfigSaved = Boolean(savedSignature) && savedSignature === configSignature

  useEffect(() => {
    void window.visslm
      .getSyncConfig()
      .then((saved) => {
        if (!saved) return
        setConfig(saved)
        setSavedSignature(JSON.stringify(saved))
        setActiveTypes(saved.selectedTypes.slice(0, 1))
      })
      .catch((error) => {
        message.error(`读取采集配置失败：${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => setLoadingConfig(false))
  }, [message])

  useEffect(() => {
    if (!isConfigSaved) setPreview(null)
  }, [isConfigSaved])

  const loadRequestLogs = useCallback(async (): Promise<void> => {
    setRequestLogsLoading(true)
    try {
      const data = await window.visslm.listCollectionRequestLogs(1, 50)
      setRequestLogs(data.rows)
      setRequestLogTotal(data.total)
    } finally {
      setRequestLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadRequestLogs()
  }, [loadRequestLogs])

  useEffect(() => {
    if (progress?.phase === 'done' || progress?.phase === 'error') {
      void loadRequestLogs()
    }
  }, [progress?.phase, loadRequestLogs])

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0

  const filtersFor = (nodeType: string): SyncFieldFilter[] =>
    config.rules.find((rule) => rule.nodeType === nodeType)?.filters ?? []

  const returnPropertyFor = (nodeType: string): string =>
    config.rules.find((rule) => rule.nodeType === nodeType)?.returnProperty ?? ''

  const updateFilters = (nodeType: string, filters: SyncFieldFilter[]): void => {
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules.filter((rule) => rule.nodeType !== nodeType),
        {
          nodeType,
          returnProperty:
            current.rules.find((rule) => rule.nodeType === nodeType)?.returnProperty ?? '',
          filters
        }
      ]
    }))
  }

  const updateReturnProperty = (nodeType: string, returnProperty: string): void => {
    setConfig((current) => ({
      ...current,
      rules: [
        ...current.rules.filter((rule) => rule.nodeType !== nodeType),
        {
          nodeType,
          returnProperty,
          filters: current.rules.find((rule) => rule.nodeType === nodeType)?.filters ?? []
        }
      ]
    }))
  }

  const returnPropertiesFor = (nodeType: string): string[] =>
    [...new Set(
      returnPropertyFor(nodeType)
        .split(/[,，]/g)
        .map((field) => field.trim())
        .filter(Boolean)
    )]

  const updateReturnProperties = (nodeType: string, properties: string[]): void => {
    updateReturnProperty(
      nodeType,
      [...new Set(properties.map((field) => field.trim()).filter(Boolean))].join(',')
    )
  }

  const addType = (): void => {
    const nodeType = typeInput.trim()
    if (!nodeType) {
      message.warning('请输入数据类型')
      return
    }
    if (config.selectedTypes.includes(nodeType)) {
      message.warning(`数据类型 ${nodeType} 已存在`)
      setActiveTypes((current) => [...new Set([...current, nodeType])])
      return
    }
    setConfig((current) => ({
      selectedTypes: [...current.selectedTypes, nodeType],
      rules: [...current.rules, { nodeType, returnProperty: '', filters: [] }]
    }))
    setActiveTypes((current) => [...new Set([...current, nodeType])])
    setTypeInput('')
  }

  const removeType = (nodeType: string): void => {
    setConfig((current) => ({
      selectedTypes: current.selectedTypes.filter((item) => item !== nodeType),
      rules: current.rules.filter((rule) => rule.nodeType !== nodeType)
    }))
    setActiveTypes((current) => current.filter((item) => item !== nodeType))
  }

  const addFilter = (nodeType: string): void => {
    updateFilters(nodeType, [
      ...filtersFor(nodeType),
      { id: crypto.randomUUID(), field: '', operator: 'equals', value: '' }
    ])
  }

  const updateFilter = (
    nodeType: string,
    filterId: string,
    patch: Partial<SyncFieldFilter>
  ): void => {
    updateFilters(
      nodeType,
      filtersFor(nodeType).map((filter) =>
        filter.id === filterId ? { ...filter, ...patch } : filter
      )
    )
  }

  const validateConfig = (): boolean => {
    if (!config.selectedTypes.length) {
      message.warning('请至少添加一种采集数据类型')
      return false
    }
    for (const rule of config.rules) {
      const invalidReturnProperty = (rule.returnProperty ?? '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
        .find((field) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(field))
      if (invalidReturnProperty) {
        message.warning(`${rule.nodeType} 的 ReturnProperty 字段 ${invalidReturnProperty} 格式无效`)
        return false
      }
      for (const filter of rule.filters) {
        if (!filter.field.trim()) {
          message.warning(`${rule.nodeType} 的过滤条件尚未填写字段 Key`)
          return false
        }
        if (
          !['empty', 'notEmpty'].includes(filter.operator) &&
          !filter.value.trim()
        ) {
          message.warning(`${rule.nodeType} 的过滤条件尚未填写属性值`)
          return false
        }
      }
    }
    return true
  }

  const saveConfig = async (): Promise<boolean> => {
    if (!validateConfig()) return false
    setSaving(true)
    try {
      await window.visslm.saveSyncConfig(config)
      setSavedSignature(configSignature)
      message.success('采集范围已保存')
      return true
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setSaving(false)
    }
  }

  const previewConfig = async (): Promise<void> => {
    if (!isConfigSaved) {
      message.warning('采集范围已修改，请先保存后再测试预览')
      return
    }
    setPreviewing(true)
    try {
      const result = await window.visslm.previewSync()
      setPreview(result)
      message.success(`预览完成，命中 ${result.matchedCount} 条记录`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  const startConfiguredSync = async (): Promise<void> => {
    if (!validateConfig()) return
    try {
      await window.visslm.saveSyncConfig(config)
      setSavedSignature(configSignature)
      const result = await onSync(config)
      if (result?.reviewBatchId && result.duplicates.length) {
        setReview({ batchId: result.reviewBatchId, items: result.duplicates })
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const operatorOptions = [
    { label: '等于', value: 'equals' },
    { label: '不等于', value: 'notEquals' },
    { label: '包含', value: 'contains' },
    { label: '不包含', value: 'notContains' },
    { label: '为空', value: 'empty' },
    { label: '不为空', value: 'notEmpty' },
    { label: '大于', value: 'greaterThan' },
    { label: '大于等于', value: 'greaterThanOrEqual' },
    { label: '小于', value: 'lessThan' },
    { label: '小于等于', value: 'lessThanOrEqual' }
  ]

  const commonReturnPropertyOptions = [
    '_valm_Name',
    '_valm_Description',
    '_valm_Status',
    'Priority',
    'IssueType',
    'Source',
    '_valm_AssignedTo',
    '_valm_Release',
    '_valm_CreateBy'
  ].map((field) => ({ label: field, value: field }))

  const collapseItems = config.selectedTypes.map((nodeType) => {
    const filters = filtersFor(nodeType)
    return {
      key: nodeType,
      label: (
        <div className="type-collapse-label">
          <Text strong>{nodeType}</Text>
          {filters.length > 0 && <Tag color="processing">{filters.length} 个条件</Tag>}
          <Button
            danger
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            onClick={(event) => {
              event.stopPropagation()
              removeType(nodeType)
            }}
          >
            删除类型
          </Button>
        </div>
      ),
      children: (
        <div className="type-scope-content">
          <div className="return-property-config">
            <div className="return-property-heading">
              <div>
                <Text strong>ReturnProperty</Text>
                <Text type="secondary">
                  选择或输入需要采集的字段 Key；系统会自动补充必要字段
                </Text>
              </div>
              <Tag color="blue">已选 {returnPropertiesFor(nodeType).length} 个字段</Tag>
            </div>
            <Select
              className="return-property-editor"
              mode="tags"
              value={returnPropertiesFor(nodeType)}
              options={commonReturnPropertyOptions}
              tokenSeparators={[',', '，']}
              optionFilterProp="label"
              allowClear
              maxTagCount="responsive"
              placeholder="输入字段 Key，按 Enter 或逗号添加"
              notFoundContent="按 Enter 添加自定义字段"
              onChange={(values) =>
                updateReturnProperties(nodeType, Array.isArray(values) ? values : [values])
              }
            />
            <Text className="return-property-hint" type="secondary">
              支持一次粘贴多个逗号分隔的字段；下拉菜单提供常用字段建议，也可以直接输入自定义字段
            </Text>
          </div>
          <div className="scope-subheading">
            <div>
              <Text strong>过滤条件列表</Text>
              <Text type="secondary">字段 Key 必须与 VISSLM 平台字段标识完全一致，多个条件按“并且”执行</Text>
            </div>
            <Button
              icon={<PlusOutlined />}
              onClick={() => addFilter(nodeType)}
            >
              添加条件
            </Button>
          </div>

          <ResizableTable<SyncFieldFilter>
            tableKey="data-sync-filter-config"
            className="filter-config-table"
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={filters}
            locale={{ emptyText: '尚未添加业务过滤条件，将按 _valm_ItemID 强制规则采集有效数据' }}
            scroll={{ x: 760, y: compactTableScrollY }}
            columns={[
              {
                title: '字段 Key',
                dataIndex: 'field',
                width: 280,
                render: (_field: string, filter) => (
                  <Input
                    value={filter.field}
                    placeholder="例如：_valm_Name"
                    onChange={(event) =>
                      updateFilter(nodeType, filter.id, { field: event.target.value })
                    }
                  />
                )
              },
              {
                title: '过滤方式',
                dataIndex: 'operator',
                width: 160,
                render: (_operator: string, filter) => (
                  <Select
                    value={filter.operator}
                    onChange={(operator) =>
                      updateFilter(nodeType, filter.id, {
                        operator,
                        value: ['empty', 'notEmpty'].includes(operator) ? '' : filter.value
                      })
                    }
                    options={operatorOptions}
                  />
                )
              },
              {
                title: '匹配值',
                dataIndex: 'value',
                render: (_value: string, filter) => {
                const noValue = filter.operator === 'empty' || filter.operator === 'notEmpty'
                return (
                  <Input
                    value={filter.value}
                    disabled={noValue}
                    placeholder={noValue ? '该方式无需匹配值' : '输入匹配值'}
                    onChange={(event) =>
                      updateFilter(nodeType, filter.id, { value: event.target.value })
                    }
                  />
                )
                }
              },
              {
                title: '操作',
                key: 'action',
                width: 70,
                align: 'center',
                render: (_value, filter) => (
                  <Button
                    danger
                    type="text"
                    aria-label="删除过滤条件"
                    icon={<DeleteOutlined />}
                    onClick={() =>
                      updateFilters(
                        nodeType,
                        filters.filter((item) => item.id !== filter.id)
                      )
                    }
                  />
                )
              }
            ]}
          />
        </div>
      )
    }
  })

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        {activeTab === 'config' && <Space>
          <Button loading={saving} onClick={() => void saveConfig()}>
            保存采集范围
          </Button>
          <Button
            icon={<EyeOutlined />}
            loading={previewing}
            disabled={!isConfigSaved || !config.selectedTypes.length}
            onClick={() => void previewConfig()}
          >
            测试预览
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            loading={syncing}
            disabled={loadingConfig}
            onClick={() => void startConfiguredSync()}
          >
            {syncing ? '正在采集' : '开始采集'}
          </Button>
        </Space>}
      </div>

      <Tabs
        className="page-inner-tabs"
        activeKey={activeTab}
        onChange={(key) => {
          const next = key as 'config' | 'logs'
          setActiveTab(next)
          if (next === 'logs') void loadRequestLogs()
        }}
        items={[
          { key: 'config', label: '采集配置' },
          {
            key: 'logs',
            label: requestLogTotal ? `请求日志（${requestLogTotal}）` : '请求日志'
          }
        ]}
      />

      {activeTab === 'config' && <Card
        className="sync-scope-card"
        title={
          <Space>
            <FilterOutlined />
            采集范围
          </Space>
        }
      >
        <Spin spinning={loadingConfig} description="正在读取采集配置">
          <div className="sync-scope-form">
            <div className="manual-type-entry">
              <div>
                <Text strong>手动添加数据类型</Text>
                <Paragraph type="secondary">
                  输入 VISSLM 数据类型的准确标识，例如 Project、Task 或 Requirement。
                </Paragraph>
              </div>
              <Space.Compact className="manual-type-input">
                <Input
                  value={typeInput}
                  placeholder="输入数据类型"
                  onChange={(event) => setTypeInput(event.target.value)}
                  onPressEnter={addType}
                />
                <Button type="primary" icon={<PlusOutlined />} onClick={addType}>
                  新增类型
                </Button>
              </Space.Compact>
            </div>
            {collapseItems.length ? (
              <Collapse
                className="sync-type-collapse"
                activeKey={activeTypes}
                onChange={(keys) => setActiveTypes(Array.isArray(keys) ? keys : [keys])}
                items={collapseItems}
              />
            ) : (
              <Empty description="尚未配置数据类型，请先手动新增" />
            )}
            <Alert
              showIcon
              type="info"
              title="_valm_ItemID 强制校验"
              description="系统只采集 _valm_ItemID 非空的数据；本地已存在的编号会自动过滤，并在采集完成后进入审查清单。"
            />
            <Text type="secondary">
              {isConfigSaved
                ? '采集范围已保存，可以测试预览或开始采集。'
                : config.selectedTypes.length
                  ? '当前配置尚未保存，保存后才能测试预览。'
                  : '默认不配置任何数据类型，请手动新增后保存。'}
            </Text>
          </div>
        </Spin>
      </Card>}

      {activeTab === 'config' && preview && (
        <Card
          className="sync-preview-card"
          title={
            <Space>
              <EyeOutlined />
              测试预览
            </Space>
          }
          extra={<Text type="secondary">仅预览，不写入本地知识库</Text>}
        >
          <Row gutter={[16, 16]} className="preview-metrics">
            <Col xs={24} sm={8}>
              <Statistic title="检查记录" value={preview.scannedCount} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="匹配记录" value={preview.matchedCount} />
            </Col>
            <Col xs={24} sm={8}>
              <Statistic title="缺少 _valm_ItemID" value={preview.invalidItemIdCount} />
            </Col>
          </Row>
          <div className="preview-type-summary">
            <Text type="secondary">类型分布：</Text>
            {preview.byType.length ? (
              preview.byType.map((item) => (
                <Tag color="blue" key={item.name}>
                  {item.name} · {item.value}
                </Tag>
              ))
            ) : (
              <Text type="secondary">当前条件未命中数据</Text>
            )}
          </div>
          <ResizableTable<SyncPreviewResult['samples'][number]>
            tableKey="data-sync-preview"
            className="sync-preview-table"
            rowKey="uid"
            size="small"
            pagination={false}
            dataSource={preview.samples}
            scroll={{ x: 1120, y: compactTableScrollY }}
            locale={{ emptyText: '没有匹配的样例记录' }}
            columns={[
              { title: '名称', dataIndex: 'name', width: 240, ellipsis: true },
              { title: '类型', dataIndex: 'nodeType', width: 130 },
              { title: '对象编号', dataIndex: 'itemId', width: 190, ellipsis: true },
              {
                title: '描述',
                dataIndex: 'description',
                width: 360,
                ellipsis: true,
                render: (description: string) => {
                  const text = plainTextFromHtml(description)
                  return <span title={text}>{text || '—'}</span>
                }
              },
              { title: 'UID', dataIndex: 'uid', width: 120 },
              { title: '项目 UID', dataIndex: 'projectId', width: 130 }
            ]}
          />
          {preview.matchedCount > preview.samples.length && (
            <Text type="secondary">
              当前仅展示前 {preview.samples.length} 条样例记录。
            </Text>
          )}
          <Divider />
          <div className="scope-subheading">
            <div>
              <Text strong>请求调试信息</Text>
              <Text type="secondary">
                共 {preview.requests.length} 次接口请求，认证 Token 已脱敏
              </Text>
            </div>
          </div>
          <Collapse
            className="preview-request-collapse"
            items={preview.requests.map((request) => ({
              key: String(request.id),
              label: (
                <div className="preview-request-label">
                  <Tag color={request.error ? 'error' : 'success'}>{request.method}</Tag>
                  <Text ellipsis title={request.endpoint}>{request.endpoint}</Text>
                  <Tag color={request.error ? 'error' : 'default'}>
                    {request.error ? '失败' : '成功'}
                  </Tag>
                </div>
              ),
              children: (
                <div className="preview-request-detail">
                  <Text strong>请求参数</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.params, null, 2)}
                  </pre>
                  <Text strong>{request.error ? '错误信息' : '返回值'}</Text>
                  <pre className="json-preview">
                    {request.error ?? JSON.stringify(request.response, null, 2)}
                  </pre>
                </div>
              )
            }))}
          />
        </Card>
      )}

      {activeTab === 'logs' && (
        <Card
          title="真实采集请求日志"
          extra={<Text type="secondary">共 {requestLogTotal} 条，显示最近 50 条</Text>}
        >
          <Alert
            showIcon
            type="info"
            title="这里只记录点击“开始采集”后实际发送的接口请求；测试预览不会写入日志"
            style={{ marginBottom: 16 }}
          />
          <ResizableTable<CollectionRequestLogRow>
            tableKey="data-collection-request-logs"
            rowKey="id"
            loading={requestLogsLoading}
            dataSource={requestLogs}
            scroll={{ y: appTableScrollY }}
            pagination={false}
            locale={{ emptyText: '暂无真实数据采集请求日志' }}
            expandable={{
              expandedRowRender: (log) => (
                <div className="preview-request-detail">
                  <Text strong>请求接口</Text>
                  <pre className="json-preview">{log.endpoint}</pre>
                  <Text strong>请求参数（Token 已脱敏）</Text>
                  <pre className="json-preview">{JSON.stringify(log.params, null, 2)}</pre>
                  <Text strong>{log.errorMessage ? '错误与返回摘要' : '返回摘要'}</Text>
                  <pre className="json-preview">
                    {JSON.stringify(
                      log.errorMessage
                        ? { error: log.errorMessage, response: log.response }
                        : log.response,
                      null,
                      2
                    )}
                  </pre>
                </div>
              )
            }}
            columns={[
              {
                title: '请求时间',
                dataIndex: 'createdAt',
                width: 180,
                render: formatDate
              },
              {
                title: '数据类型',
                dataIndex: 'nodeType',
                width: 170,
                ellipsis: true
              },
              {
                title: '请求接口',
                dataIndex: 'endpoint',
                ellipsis: true
              },
              {
                title: 'HTTP',
                dataIndex: 'httpStatus',
                width: 90,
                render: (status: number) => status || '—'
              },
              {
                title: '返回记录',
                dataIndex: 'recordCount',
                width: 110
              },
              {
                title: '请求状态',
                dataIndex: 'status',
                width: 110,
                render: (status: CollectionRequestLogRow['status']) => (
                  <Tag
                    color={
                      status === 'success'
                        ? 'success'
                        : status === 'failed'
                          ? 'error'
                          : 'processing'
                    }
                  >
                    {status === 'success' ? '成功' : status === 'failed' ? '失败' : '执行中'}
                  </Tag>
                )
              }
            ]}
          />
        </Card>
      )}

      {activeTab === 'config' && (progress || syncing) && (
        <Card
          className="sync-progress-card"
          title={
            <Space>
              <CloudDownloadOutlined />
              采集进度
            </Space>
          }
        >
          <div className="sync-progress">
            <Progress
              percent={progress?.phase === 'done' ? 100 : percent}
              status={
                progress?.phase === 'error'
                  ? 'exception'
                  : progress?.phase === 'done'
                    ? 'success'
                    : 'active'
              }
            />
            <Text>{progress?.message ?? '准备采集'}</Text>
          </div>
        </Card>
      )}

      {activeTab === 'config' && <Alert
        showIcon
        type="info"
        title="安全说明"
        description="数据采集只读访问 VISSLM，不会修改平台数据。图片会转换为 Base64 并按内容哈希去重；平台当前使用 HTTP，正式环境建议启用 HTTPS。"
      />}
      {review && (
        <DataReviewModal
          source="sync"
          batchId={review.batchId}
          items={review.items}
          onClose={() => setReview(null)}
          onApplied={(result) => {
            if (result.updatedCount > 0) onDataChanged()
            setReview((current) => {
              if (!current) return current
              const resolved = new Set(result.resolvedReviewIds)
              const items = current.items.filter((item) => !resolved.has(item.id))
              return items.length ? { ...current, items } : null
            })
          }}
        />
      )}
    </div>
  )
}

function PushPage({
  refreshKey,
  onPushed
}: {
  refreshKey: number
  onPushed: () => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const [form] = Form.useForm<Omit<PushConfig, 'recordUids'>>()
  const [fieldMappings, setFieldMappings] = useState<PushFieldMapping[]>([])
  const [records, setRecords] = useState<RecordRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [selectedRowKeys, setSelectedRowKeys] = useState<string[]>([])
  const [result, setResult] = useState<PushResult | null>(null)
  const [pushLogs, setPushLogs] = useState<PushLogRow[]>([])
  const [pushLogTotal, setPushLogTotal] = useState(0)
  const [logsLoading, setLogsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'config' | 'logs'>('config')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.visslm.listRecords({
        page,
        pageSize,
        search
      })
      setRecords(data.rows)
      setTotal(data.total)
    } finally {
      setLoading(false)
    }
  }, [page, pageSize, search])

  const loadPushLogs = useCallback(async (): Promise<void> => {
    setLogsLoading(true)
    try {
      const data = await window.visslm.listPushLogs(1, 50)
      setPushLogs(data.rows)
      setPushLogTotal(data.total)
    } finally {
      setLogsLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void loadPushLogs()
  }, [load, loadPushLogs, refreshKey])

  const getConfig = async (): Promise<PushConfig> => {
    const values = await form.validateFields()
    if (!selectedRowKeys.length) throw new Error('请至少选择一条待推送数据')
    for (const mapping of fieldMappings) {
      if (!mapping.sourceField.trim() || !mapping.targetField.trim()) {
        throw new Error('请完整填写字段映射的源属性 Key 和目标属性 Key')
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(mapping.sourceField.trim())) {
        throw new Error(`源属性 Key ${mapping.sourceField} 格式无效`)
      }
      if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(mapping.targetField.trim())) {
        throw new Error(`目标属性 Key ${mapping.targetField} 格式无效`)
      }
      if (['_valm_Uid', '_valm_NodeType', '_valm_ItemID'].includes(mapping.targetField.trim())) {
        throw new Error(`目标属性 Key ${mapping.targetField} 是消息体禁止字段`)
      }
    }
    const sourceKeys = fieldMappings.map((mapping) => mapping.sourceField.trim())
    const targetKeys = fieldMappings.map((mapping) => mapping.targetField.trim())
    if (new Set(sourceKeys).size !== sourceKeys.length) {
      throw new Error('字段映射中存在重复的源属性 Key')
    }
    if (new Set(targetKeys).size !== targetKeys.length) {
      throw new Error('字段映射中存在重复的目标属性 Key')
    }
    return {
      recordUids: selectedRowKeys,
      nodeType: values.nodeType.trim(),
      projectId: values.projectId.trim(),
      componentId: values.componentId?.trim(),
      parentId: values.parentId?.trim(),
      insertAfterId: values.insertAfterId?.trim(),
      insertBeforeId: values.insertBeforeId?.trim(),
      fieldMappings: fieldMappings.map((mapping) => ({
        ...mapping,
        sourceField: mapping.sourceField.trim(),
        targetField: mapping.targetField.trim()
      }))
    }
  }

  const addFieldMapping = (): void => {
    setFieldMappings((current) => [
      ...current,
      { id: crypto.randomUUID(), sourceField: '', targetField: '' }
    ])
    setResult(null)
  }

  const updateFieldMapping = (
    id: string,
    patch: Partial<PushFieldMapping>
  ): void => {
    setFieldMappings((current) =>
      current.map((mapping) => mapping.id === id ? { ...mapping, ...patch } : mapping)
    )
    setResult(null)
  }

  const removeFieldMapping = (id: string): void => {
    setFieldMappings((current) => current.filter((mapping) => mapping.id !== id))
    setResult(null)
  }

  const previewRequests = async (): Promise<void> => {
    setPreviewing(true)
    try {
      const config = await getConfig()
      const preview = await window.visslm.previewPush(config)
      setResult(preview)
      setActiveTab('logs')
      message.success(`已生成 ${preview.total} 条 POST 请求预览，未访问真实平台`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  const confirmPush = async (): Promise<void> => {
    let config: PushConfig
    try {
      config = await getConfig()
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return
    }
    modal.confirm({
      title: `确认向平台新建 ${config.recordUids.length} 条数据？`,
      content: (
        <span>
          将调用 <code>/alm/rest/items</code> 执行真实 POST 写入，请先检查请求预览中的参数和消息体。
        </span>
      ),
      okText: '确认推送',
      cancelText: '取消',
      onOk: async () => {
        setPushing(true)
        try {
          const pushed = await window.visslm.startPush(config)
          setResult(pushed)
          setActiveTab('logs')
          if (pushed.failedCount) {
            message.warning(
              `推送完成：成功 ${pushed.successCount} 条，失败 ${pushed.failedCount} 条`
            )
          } else {
            message.success(`推送成功，共 ${pushed.successCount} 条`)
          }
          onPushed()
          await Promise.all([load(), loadPushLogs()])
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error))
          throw error
        } finally {
          setPushing(false)
        }
      }
    })
  }

  return (
    <div className="page-stack">
      <div className="page-toolbar">
        {activeTab === 'config' && <Space>
          <Button
            icon={<EyeOutlined />}
            loading={previewing}
            disabled={!selectedRowKeys.length}
            onClick={() => void previewRequests()}
          >
            测试预览
          </Button>
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={pushing}
            disabled={!selectedRowKeys.length}
            onClick={() => void confirmPush()}
          >
            开始推送
          </Button>
        </Space>}
      </div>

      <Tabs
        className="page-inner-tabs"
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as 'config' | 'logs')}
        items={[
          { key: 'config', label: '推送配置' },
          {
            key: 'logs',
            label: pushLogTotal ? `请求日志（${pushLogTotal}）` : '请求日志'
          }
        ]}
      />

      {activeTab === 'config' && <Card
        className="compact-push-config-card"
        title="数据新建参数"
        extra={<Text type="secondary">必填 2 项 · 其他参数按需展开</Text>}
      >
        <Form
          form={form}
          layout="vertical"
          className="compact-push-form"
          initialValues={{ insertAfterId: '-1' }}
          onValuesChange={() => setResult(null)}
        >
          <Row gutter={[14, 0]}>
            <Col xs={24} md={12}>
              <Form.Item
                label="nodeType"
                name="nodeType"
                rules={[{ required: true, whitespace: true, message: '请输入目标节点类型' }]}
              >
                <Input placeholder="例如：Task、Requirement" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                label="projectId"
                name="projectId"
                rules={[{ required: true, whitespace: true, message: '请输入目标项目 UID' }]}
              >
                <Input placeholder="目标项目 UID（必填）" />
              </Form.Item>
            </Col>
          </Row>
          <Collapse
            className="push-advanced-collapse"
            items={[
              {
                key: 'advanced',
                label: '高级位置参数（可选）',
                children: (
                  <Row gutter={[14, 0]}>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="componentId" name="componentId">
                        <Input placeholder="目标组件 UID" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="parentId" name="parentId">
                        <Input placeholder="父节点 UID" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item label="insertAfterId" name="insertAfterId">
                        <Input placeholder="-1 表示最后" />
                      </Form.Item>
                    </Col>
                    <Col xs={24} md={12} xl={6}>
                      <Form.Item
                        label="insertBeforeId"
                        name="insertBeforeId"
                        extra="填写后覆盖 insertAfterId"
                      >
                        <Input placeholder="指定节点之前" />
                      </Form.Item>
                    </Col>
                  </Row>
                )
              }
            ]}
          />
        </Form>

        <div className="push-mapping-section">
          <div className="push-mapping-heading">
            <div>
              <Text strong>字段映射</Text>
              <Text type="secondary">将本地属性重命名为目标平台属性 Key</Text>
            </div>
            <Button icon={<PlusOutlined />} onClick={addFieldMapping}>
              新增映射
            </Button>
          </div>
          {fieldMappings.length ? (
            <ResizableTable<PushFieldMapping>
              tableKey="push-field-mappings"
              className="push-mapping-table"
              rowKey="id"
              pagination={false}
              dataSource={fieldMappings}
              scroll={{ y: compactTableScrollY }}
              columns={[
                {
                  title: '当前数据属性 Key',
                  dataIndex: 'sourceField',
                  render: (_value, mapping) => (
                    <Input
                      value={mapping.sourceField}
                      placeholder="例如：Owner"
                      onChange={(event) =>
                        updateFieldMapping(mapping.id, { sourceField: event.target.value })
                      }
                    />
                  )
                },
                {
                  title: '',
                  key: 'arrow',
                  width: 46,
                  align: 'center',
                  render: () => <Text type="secondary">→</Text>
                },
                {
                  title: '目标属性 Key',
                  dataIndex: 'targetField',
                  render: (_value, mapping) => (
                    <Input
                      value={mapping.targetField}
                      placeholder="例如：_valm_Owner"
                      onChange={(event) =>
                        updateFieldMapping(mapping.id, { targetField: event.target.value })
                      }
                    />
                  )
                },
                {
                  title: '操作',
                  key: 'action',
                  width: 64,
                  align: 'center',
                  render: (_value, mapping) => (
                    <Button
                      danger
                      type="text"
                      aria-label="删除字段映射"
                      icon={<DeleteOutlined />}
                      onClick={() => removeFieldMapping(mapping.id)}
                    />
                  )
                }
              ]}
            />
          ) : (
            <div className="push-mapping-empty">
              暂无字段映射，未配置的属性将保持原 Key
            </div>
          )}
        </div>

        <Alert
          showIcon
          type="warning"
          className="compact-push-alert"
          title="预览不发送请求；真实推送前会强制移除 _valm_Uid、_valm_NodeType 和 _valm_ItemID"
        />
      </Card>}

      {activeTab === 'config' && <Card
        title={`选择待推送数据（已选 ${selectedRowKeys.length} 条）`}
        extra={
          <Input.Search
            allowClear
            placeholder="搜索名称、编号和正文"
            onSearch={(value) => {
              setSearch(value)
              setPage(1)
            }}
            style={{ width: 320 }}
          />
        }
      >
        <ResizableTable<RecordRow>
          tableKey="push-record-selection"
          rowKey="uid"
          loading={loading}
          dataSource={records}
          scroll={{ y: appTableScrollY }}
          rowSelection={{
            selectedRowKeys,
            preserveSelectedRowKeys: true,
            onChange: (keys) => {
              setSelectedRowKeys(keys.map(String))
              setResult(null)
            }
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count) => `共 ${count} 条`
          }}
          onChange={(pagination: TablePaginationConfig) => {
            setPage(pagination.current ?? 1)
            setPageSize(pagination.pageSize ?? 20)
          }}
          columns={[
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '本地类型', dataIndex: 'nodeType', width: 140 },
            { title: '对象编号', dataIndex: 'itemId', width: 200, ellipsis: true },
            { title: 'UID', dataIndex: 'uid', width: 140 },
            {
              title: '数据状态',
              key: 'pushStatus',
              width: 120,
              render: (_value, record) => renderPushStatus(record)
            }
          ]}
        />
      </Card>}

      {activeTab === 'logs' && result && (
        <Card
          className="push-debug-card"
          title="接口调试信息"
          extra={
            <Tag color={result.preview ? 'processing' : result.failedCount ? 'warning' : 'success'}>
              {result.preview
                ? '仅预览，未发送'
                : `成功 ${result.successCount} / 失败 ${result.failedCount}`}
            </Tag>
          }
        >
          <Text type="secondary">
            共 {result.requests.length} 次 POST 请求，认证 Token 已脱敏
          </Text>
          <Collapse
            className="preview-request-collapse push-request-collapse"
            items={result.requests.map((request) => ({
              key: String(request.id),
              label: (
                <div className="preview-request-label">
                  <Tag color={request.error ? 'error' : 'blue'}>POST</Tag>
                  <Text>{request.recordName}</Text>
                  <Text ellipsis title={request.endpoint}>{request.endpoint}</Text>
                  <Tag color={request.error ? 'error' : result.preview ? 'default' : 'success'}>
                    {request.error ? '失败' : result.preview ? '未发送' : '成功'}
                  </Tag>
                </div>
              ),
              children: (
                <div className="preview-request-detail">
                  <Text strong>请求参数</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.params, null, 2)}
                  </pre>
                  <Text strong>请求消息体</Text>
                  <pre className="json-preview">
                    {JSON.stringify(request.body, null, 2)}
                  </pre>
                  <Text strong>{request.error ? '错误信息' : '返回值'}</Text>
                  <pre className="json-preview">
                    {request.error ?? JSON.stringify(request.response, null, 2)}
                  </pre>
                </div>
              )
            }))}
          />
        </Card>
      )}

      {activeTab === 'logs' && <Card
        title="推送请求日志"
        extra={<Text type="secondary">共 {pushLogTotal} 条，显示最近 50 条</Text>}
      >
        <Alert
          showIcon
          type="info"
          title="日志存储说明"
          description="日志保留接口、脱敏参数、请求属性、HTTP 状态、平台返回值及错误信息；为控制数据量，请求日志不保存 _valm_Description 字段。"
          style={{ marginBottom: 16 }}
        />
        <ResizableTable<PushLogRow>
          tableKey="push-request-logs"
          rowKey="id"
          loading={logsLoading}
          dataSource={pushLogs}
          scroll={{ y: appTableScrollY }}
          pagination={false}
          locale={{ emptyText: '暂无真实推送请求日志' }}
          expandable={{
            expandedRowRender: (log) => (
              <div className="preview-request-detail">
                <Text strong>请求参数（Token 已脱敏）</Text>
                <pre className="json-preview">{JSON.stringify(log.params, null, 2)}</pre>
                <Text strong>请求属性（未记录 _valm_Description）</Text>
                <pre className="json-preview">{JSON.stringify(log.body, null, 2)}</pre>
                <Text strong>{log.errorMessage ? '错误与平台返回' : '平台返回值'}</Text>
                <pre className="json-preview">
                  {JSON.stringify(
                    log.errorMessage
                      ? { error: log.errorMessage, response: log.response }
                      : log.response,
                    null,
                    2
                  )}
                </pre>
              </div>
            )
          }}
          columns={[
            {
              title: '请求时间',
              dataIndex: 'createdAt',
              width: 180,
              render: formatDate
            },
            {
              title: '数据',
              dataIndex: 'recordName',
              ellipsis: true
            },
            {
              title: '目标类型',
              width: 160,
              render: (_value, log) => log.params.nodeType || '—'
            },
            {
              title: '项目 UID',
              width: 120,
              render: (_value, log) => log.params.projectId || '—'
            },
            {
              title: 'HTTP',
              dataIndex: 'httpStatus',
              width: 90,
              render: (status: number) => status || '—'
            },
            {
              title: '请求状态',
              dataIndex: 'status',
              width: 110,
              render: (status: PushLogRow['status']) => (
                <Tag
                  color={
                    status === 'success'
                      ? 'success'
                      : status === 'failed'
                        ? 'error'
                        : 'processing'
                  }
                >
                  {status === 'success' ? '成功' : status === 'failed' ? '失败' : '发送中'}
                </Tag>
              )
            },
            {
              title: '远端 UID',
              dataIndex: 'remoteUid',
              width: 120,
              render: (value: string) => value || '—'
            }
          ]}
        />
      </Card>}
    </div>
  )
}

function SettingsPanelHeading({
  title,
  description,
  titleId,
  extra,
  className
}: {
  title: string
  description: string
  titleId?: string
  extra?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div className={['settings-panel-heading', className].filter(Boolean).join(' ')}>
      <div className="settings-panel-heading-copy">
        <Title id={titleId} level={4}>{title}</Title>
        <Text type="secondary">{description}</Text>
      </div>
      {extra}
    </div>
  )
}

const formatUpdateBytes = (value?: number): string => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unitIndex = 0
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024
    unitIndex += 1
  }
  return `${amount >= 100 || unitIndex === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unitIndex]}`
}

const formatUpdateDate = (value?: string): string => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN')
}

const updateStatusLabel = (status: UpdateStatus | null): string => {
  if (!status) return '正在读取更新状态'
  switch (status.phase) {
    case 'idle': return '尚未检查更新'
    case 'checking': return '正在检查更新'
    case 'available': return `发现新版本 ${status.version ?? ''}`.trim()
    case 'not-available': return '已是最新版本'
    case 'downloading': return '正在下载更新'
    case 'downloaded': return '更新已下载'
    case 'installing': return '正在重启安装'
    case 'unsupported': return '当前环境不支持在线更新'
    case 'error': return '更新检查失败'
  }
}

const updateStatusColor = (status: UpdateStatus | null): string => {
  if (!status) return 'default'
  if (status.phase === 'available' || status.phase === 'downloaded') return 'success'
  if (status.phase === 'error') return 'error'
  if (status.phase === 'checking' || status.phase === 'downloading' || status.phase === 'installing') {
    return 'processing'
  }
  return 'default'
}

function SettingsPage({
  settings,
  onChanged
}: {
  settings: AppSettings | null
  onChanged: (settings: AppSettings) => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [platformForm] = Form.useForm<PlatformSettingsInput>()
  const [systemForm] = Form.useForm<SystemSettingsInput>()
  const [modelForm] = Form.useForm<ModelSettings>()
  const [settingsTab, setSettingsTab] = useState<SystemSettingsTabKey>('platform')
  const [platformTesting, setPlatformTesting] = useState(false)
  const [modelTesting, setModelTesting] = useState(false)
  const [matchingForm] = Form.useForm<ProjectMatchingSettings>()
  const [modelSource, setModelSource] = useState<ModelSource>('local')
  const [modelProvider, setModelProvider] = useState<ModelProvider>('ollama')
  const [featureSettings, setFeatureSettings] = useState<FeatureModuleSettings>(
    DEFAULT_FEATURE_MODULE_SETTINGS
  )
  const [featureSaving, setFeatureSaving] = useState<FeatureModuleKey | null>(null)
  const [navigationOrder, setNavigationOrder] = useState<FeatureNavigationOrder>(
    DEFAULT_FEATURE_NAVIGATION_ORDER
  )
  const [navigationSaving, setNavigationSaving] = useState(false)
  const [draggingFeature, setDraggingFeature] = useState<FeatureModuleKey | null>(null)
  const [dragOverFeature, setDragOverFeature] = useState<FeatureDropTarget | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateAction, setUpdateAction] = useState<'check' | 'download' | 'install' | null>(null)
  const selectedProvider = onlineModelProviders.find((item) => item.value === modelProvider)
  const hasSavedModelApiKey = Boolean(
    settings?.model.provider === modelProvider && settings.model.hasApiKey
  )
  const modelThinkingHint = modelSource === 'local'
    ? 'Ollama 使用原生 think 参数；开启后会增加响应时间。'
    : modelProvider === 'qwen'
      ? '通义千问通过 enable_thinking 传递；具体模型仍需支持混合思考模式。'
      : modelProvider === 'deepseek' || modelProvider === 'zhipu'
        ? '当前服务商通过 thinking.type 传递；具体模型不支持时可能忽略或返回接口错误。'
        : modelProvider === 'openai'
          ? '仅对支持 reasoning_effort 的 OpenAI 推理模型生效，普通模型不会额外启用思考。'
          : modelProvider === 'anthropic'
            ? '按 Anthropic 模型能力发送 thinking 配置；请使用支持思考模式的模型。'
            : modelProvider === 'minimax'
              ? 'MiniMax M 系列为模型内置思考模型，当前兼容接口不提供通用的关闭参数。'
              : modelProvider === 'openai-compatible'
                ? '通用兼容接口不发送厂商专有思考参数；深度分析由 Agent 提示和独立复核流程保证。'
                : '当前服务商没有通用思考参数；深度分析能力取决于所选模型。'

  useEffect(() => {
    if (!settings) return
    if (settingsTab === 'platform') {
      platformForm.setFieldsValue({
        baseUrl: settings.platform.baseUrl,
        username: settings.platform.username,
        token: ''
      })
    }
    if (settingsTab === 'model') {
      modelForm.setFieldsValue({ ...settings.model, apiKey: '' })
    }
    if (settingsTab === 'general') {
      systemForm.setFieldsValue(settings.system)
      matchingForm.setFieldsValue(settings.projectMatching)
    }
    setModelSource(settings.model.source)
    setModelProvider(settings.model.provider)
    setFeatureSettings({ ...DEFAULT_FEATURE_MODULE_SETTINGS, ...settings.features })
    setNavigationOrder(normalizeFeatureNavigationOrder(settings.navigationOrder))
  }, [settings, settingsTab, platformForm, systemForm, modelForm, matchingForm])

  useEffect(() => {
    let mounted = true
    void window.visslm.getUpdateStatus().then((status) => {
      if (mounted) setUpdateStatus(status)
    })
    const unsubscribe = window.visslm.onUpdateStatus((status) => {
      if (mounted) setUpdateStatus(status)
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const orderedFeatureDefinitions = useMemo(() => {
    const order = normalizeFeatureNavigationOrder(navigationOrder)
    return [...featureDefinitions].sort(
      (left, right) => order.indexOf(left.key) - order.indexOf(right.key)
    )
  }, [navigationOrder])

  const testPlatform = async (): Promise<void> => {
    const values = await platformForm.validateFields()
    setPlatformTesting(true)
    try {
      const result = await window.visslm.testPlatform(values)
      result.ok ? message.success(result.message) : message.error(result.message)
    } finally {
      setPlatformTesting(false)
    }
  }

  const savePlatform = async (values: PlatformSettingsInput): Promise<void> => {
    const next = await window.visslm.savePlatformSettings(values)
    onChanged(next)
    platformForm.setFieldValue('token', '')
    message.success('平台配置已安全保存')
  }

  const saveSystem = async (values: SystemSettingsInput): Promise<void> => {
    const next = await window.visslm.saveSystemSettings(values)
    onChanged(next)
    systemForm.setFieldsValue(next.system)
    message.success('系统配置已保存')
  }

  const checkForUpdates = async (): Promise<void> => {
    setUpdateAction('check')
    try {
      const next = await window.visslm.checkForUpdates()
      setUpdateStatus(next)
      if (next.phase === 'not-available') message.success('当前已是最新版本')
      if (next.phase === 'error') message.error(`检查更新失败：${next.message ?? '未知错误'}`)
    } finally {
      setUpdateAction(null)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    setUpdateAction('download')
    try {
      const next = await window.visslm.downloadUpdate()
      setUpdateStatus(next)
      if (next.phase === 'error') message.error(`下载更新失败：${next.message ?? '未知错误'}`)
    } finally {
      setUpdateAction(null)
    }
  }

  const installUpdate = async (): Promise<void> => {
    setUpdateAction('install')
    try {
      await window.visslm.installUpdate()
    } finally {
      setUpdateAction(null)
    }
  }

  const testModel = async (): Promise<void> => {
    const values = await modelForm.validateFields()
    setModelTesting(true)
    try {
      const result = await window.visslm.testModel(values, true)
      result.ok ? message.success(result.message) : message.error(result.message)
    } finally {
      setModelTesting(false)
    }
  }

  const saveModel = async (values: ModelSettings): Promise<void> => {
    const next = await window.visslm.saveModelSettings(values)
    onChanged(next)
    modelForm.setFieldValue('apiKey', '')
    message.success('模型配置已保存')
  }

  const saveProjectMatching = async (values: ProjectMatchingSettings): Promise<void> => {
    const next = await window.visslm.saveProjectMatchingSettings(values)
    onChanged(next)
    matchingForm.setFieldsValue(next.projectMatching)
    message.success('项目匹配配置已保存')
  }

  const saveFeature = async (key: FeatureModuleKey, enabled: boolean): Promise<void> => {
    const previousFeatures = featureSettings
    const nextFeatures: FeatureModuleSettings = { ...previousFeatures, [key]: enabled }
    setFeatureSettings(nextFeatures)
    setFeatureSaving(key)
    try {
      const next = await window.visslm.saveFeatureSettings(nextFeatures)
      setFeatureSettings(next.features)
      onChanged(next)
      const definition = featureDefinitions.find((item) => item.key === key)
      message.success([definition?.label ?? '功能模块', enabled ? '开启' : '关闭'].join('已'))
    } catch (error) {
      setFeatureSettings(previousFeatures)
      message.error(error instanceof Error ? error.message : '功能开关保存失败，请稍后重试')
    } finally {
      setFeatureSaving(null)
    }
  }

  const saveNavigationOrder = async (nextOrder: FeatureNavigationOrder): Promise<void> => {
    if (navigationSaving) return
    const previousOrder = navigationOrder
    const normalizedOrder = normalizeFeatureNavigationOrder(nextOrder)
    setNavigationOrder(normalizedOrder)
    setNavigationSaving(true)
    try {
      const next = await window.visslm.saveNavigationOrder(normalizedOrder)
      setNavigationOrder(normalizeFeatureNavigationOrder(next.navigationOrder))
      onChanged(next)
      message.success('导航顺序已保存')
    } catch (error) {
      setNavigationOrder(previousOrder)
      message.error(error instanceof Error ? error.message : '导航顺序保存失败，请稍后重试')
    } finally {
      setNavigationSaving(false)
    }
  }

  const handleFeatureDragStart = (
    event: React.DragEvent<HTMLButtonElement>,
    key: FeatureModuleKey
  ): void => {
    if (navigationSaving) {
      event.preventDefault()
      return
    }
    setDraggingFeature(key)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', key)
  }

  const handleFeatureDragOver = (
    event: React.DragEvent<HTMLDivElement>,
    key: FeatureModuleKey
  ): void => {
    if (!draggingFeature || navigationSaving || draggingFeature === key) {
      if (draggingFeature === key) setDragOverFeature(null)
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const position: FeatureDropPosition = event.clientY < rect.top + rect.height / 2
      ? 'before'
      : 'after'
    setDragOverFeature((current) => (
      current?.key === key && current.position === position
        ? current
        : { key, position }
    ))
  }

  const handleFeatureDrop = (
    event: React.DragEvent<HTMLDivElement>,
    targetKey: FeatureModuleKey
  ): void => {
    event.preventDefault()
    const rawSourceKey = draggingFeature ?? event.dataTransfer.getData('text/plain')
    const targetRect = event.currentTarget.getBoundingClientRect()
    const position: FeatureDropPosition = dragOverFeature?.key === targetKey
      ? dragOverFeature.position
      : event.clientY < targetRect.top + targetRect.height / 2
        ? 'before'
        : 'after'
    setDraggingFeature(null)
    setDragOverFeature(null)
    if (
      navigationSaving ||
      !DEFAULT_FEATURE_NAVIGATION_ORDER.includes(rawSourceKey as FeatureModuleKey)
    ) {
      return
    }

    const sourceKey = rawSourceKey as FeatureModuleKey
    const currentOrder = normalizeFeatureNavigationOrder(navigationOrder)
    const sourceIndex = currentOrder.indexOf(sourceKey)
    if (sourceIndex < 0 || sourceKey === targetKey) return

    const nextOrder = currentOrder.filter((key) => key !== sourceKey)
    const targetIndex = nextOrder.indexOf(targetKey)
    if (targetIndex < 0) return
    nextOrder.splice(targetIndex + (position === 'after' ? 1 : 0), 0, sourceKey)
    void saveNavigationOrder(nextOrder)
  }

  const updateAvailable = updateStatus?.phase === 'available'
  const updateDownloading = updateStatus?.phase === 'downloading'
  const updateDownloaded = updateStatus?.phase === 'downloaded'
  const updateUnsupported = updateStatus?.phase === 'unsupported'
  const updateBusy = updateAction !== null || updateStatus?.phase === 'checking' || updateDownloading

  const changeModelSource = (source: string | number): void => {
    const thinking = Boolean(modelForm.getFieldValue('thinking'))
    if (source === 'local') {
      setModelSource('local')
      setModelProvider('ollama')
      modelForm.setFieldsValue({
        source: 'local',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3:8b',
        thinking
      })
      return
    }
    const provider = onlineModelProviders.find((item) => item.value === modelProvider && item.value !== 'ollama')
      ?? onlineModelProviders[0]
    setModelSource('online')
    setModelProvider(provider.value)
    modelForm.setFieldsValue({
      source: 'online',
      provider: provider.value,
      baseUrl: provider.baseUrl,
      model: provider.models[0] ?? '',
      thinking
    })
  }

  const changeOnlineProvider = (provider: ModelProvider): void => {
    const preset = onlineModelProviders.find((item) => item.value === provider)
    if (!preset) return
    const thinking = Boolean(modelForm.getFieldValue('thinking'))
    setModelProvider(provider)
    modelForm.setFieldsValue({
      provider,
      baseUrl: preset.baseUrl,
      model: preset.models[0] ?? '',
      thinking
    })
  }

  return (
    <div className="settings-width">
      <Card className="settings-card">
        <Tabs
          className="settings-tabs"
          activeKey={settingsTab}
          onChange={(key) => {
            if (isSystemSettingsTabKey(key)) setSettingsTab(key)
          }}
          items={[
            {
              key: 'platform',
              label: '平台配置',
              children: (
                <div className="settings-panel">
                  <SettingsPanelHeading
                    title="VISSLM 平台"
                    description="配置业务平台的数据采集与推送连接"
                  />
                  <Form form={platformForm} layout="vertical" onFinish={(values) => void savePlatform(values)}>
                    <Form.Item label="平台地址" name="baseUrl" rules={[{ required: true, message: '请输入平台地址' }]}>
                      <Input placeholder="http://server/alm" />
                    </Form.Item>
                    <Form.Item label="用户名" name="username" rules={[{ required: true, message: '请输入用户名' }]}>
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      label="API Token"
                      name="token"
                      extra={settings?.platform.hasToken ? '已安全保存；留空将继续使用原 Token' : 'Token 将使用操作系统安全存储加密'}
                      rules={[{
                        validator: async (_, value) => {
                          if (!value && !settings?.platform.hasToken) throw new Error('请输入 API Token')
                        }
                      }]}
                    >
                      <Input.Password autoComplete="new-password" placeholder={settings?.platform.hasToken ? '••••••••' : '输入平台 Token'} />
                    </Form.Item>
                    <Space>
                      <Button type="primary" htmlType="submit">保存平台配置</Button>
                      <Button loading={platformTesting} onClick={() => void testPlatform()}>测试连接</Button>
                    </Space>
                  </Form>
                </div>
              )
            },
            {
              key: 'model',
              label: '大模型配置',
              children: (
                <div className="settings-panel">
                  <SettingsPanelHeading
                    title="大模型连接"
                    description="选择 Agent 使用的本地或在线模型服务"
                    className="model-settings-heading"
                    extra={(
                      <Segmented
                        value={modelSource}
                        options={[
                          { label: '本地大模型', value: 'local' },
                          { label: '在线大模型', value: 'online' }
                        ]}
                        onChange={changeModelSource}
                      />
                    )}
                  />
                  <Form form={modelForm} layout="vertical" onFinish={(values) => void saveModel(values)}>
                    <Form.Item name="source" hidden><Input /></Form.Item>
                    <Form.Item name="provider" hidden={modelSource === 'local'} label="模型服务商">
                      <Select
                        options={onlineModelProviders.map((provider) => ({ label: provider.label, value: provider.value }))}
                        onChange={(value) => changeOnlineProvider(value as ModelProvider)}
                      />
                    </Form.Item>
                    <Form.Item
                      label={modelSource === 'local' ? 'Ollama 地址' : 'API 地址'}
                      name="baseUrl"
                      extra={modelProvider === 'openai-compatible' ? '填写兼容 OpenAI Chat Completions API 的基础地址，通常以 /v1 结尾' : undefined}
                      rules={[{ required: true, message: '请输入服务地址' }]}
                    >
                      <Input placeholder={modelSource === 'local' ? 'http://127.0.0.1:11434' : selectedProvider?.baseUrl || 'https://example.com/v1'} />
                    </Form.Item>
                    {modelSource === 'online' && (
                      <Form.Item
                        label="API Key"
                        name="apiKey"
                        extra={hasSavedModelApiKey ? '已安全保存；留空将继续使用原 API Key' : 'API Key 将使用操作系统安全存储加密'}
                        rules={[{
                          validator: async (_, value) => {
                            if (!value && !hasSavedModelApiKey) throw new Error('请输入 API Key')
                          }
                        }]}
                      >
                        <Input.Password autoComplete="new-password" placeholder={hasSavedModelApiKey ? '••••••••' : '输入 API Key'} />
                      </Form.Item>
                    )}
                    <Form.Item label="模型名称" name="model" rules={[{ required: true, message: '请输入模型名称' }]}>
                      <Input list="model-name-options" placeholder={modelSource === 'local' ? 'qwen3:8b' : selectedProvider?.models[0] || '输入模型 ID'} />
                    </Form.Item>
                    <datalist id="model-name-options">
                      {(selectedProvider?.models ?? []).map((model) => <option key={model} value={model} />)}
                    </datalist>
                    <Form.Item label="思考模式" name="thinking" valuePropName="checked" extra={modelThinkingHint}>
                      <Switch checkedChildren="开启" unCheckedChildren="关闭" />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      title={modelSource === 'local' ? 'Agent 工具调用建议关闭思考模式' : '在线模型思考模式'}
                      description={modelSource === 'local'
                        ? '开启后会增加响应时间，并可能在较小输出预算下无法及时生成工具调用。'
                        : '开关会随模型配置保存，并应用到在线模型请求；思考模式通常会增加响应时间和 Token 消耗。'}
                      className="model-settings-alert"
                    />
                    <Space>
                      <Button type="primary" htmlType="submit">保存模型配置</Button>
                      <Button loading={modelTesting} onClick={() => void testModel()}>测试模型</Button>
                    </Space>
                  </Form>
                </div>
              )
            },
            {
              key: 'general',
              label: '通用配置',
              children: (
                <div className="settings-panel settings-general-panel">
                  <SettingsPanelHeading
                    title="系统参数"
                    description="配置跨平台复用的用户属性字段和项目需求匹配参数，供数据查询与项目匹配使用。"
                  />
                  <Form
                    className="settings-form settings-general-form"
                    form={systemForm}
                    layout="vertical"
                    onFinish={(values) => void saveSystem(values)}
                  >
                    <Form.Item
                      label="用户属性 Key"
                      name="userPropertyKeys"
                      extra="仅对这些字段的非空值查询用户显示名；相同登录名只查询一次。"
                    >
                      <Select
                        mode="tags"
                        allowClear
                        tokenSeparators={[',', '，', ';', '；', '\n']}
                        maxTagCount="responsive"
                        placeholder="例如：_valm_AssignedTo"
                      />
                    </Form.Item>
                    <div className="settings-form-actions">
                      <Button type="primary" htmlType="submit">保存系统配置</Button>
                    </div>
                  </Form>
                  <section
                    className="settings-general-section settings-matching-section"
                    aria-labelledby="project-matching-settings-title"
                  >
                    <SettingsPanelHeading
                      title="项目需求匹配"
                      titleId="project-matching-settings-title"
                      description="控制“查看匹配”列表展示的数据最低匹配度，低于或等于阈值的数据不会显示。"
                    />
                    <Form
                      className="settings-form settings-matching-form"
                      form={matchingForm}
                      layout="vertical"
                      onFinish={(values) => void saveProjectMatching(values)}
                    >
                      <Form.Item
                        className="settings-matching-score-field"
                        name="minScore"
                        label="最低匹配度"
                        extra="默认 40%；系统只展示匹配度严格高于该值的数据。"
                        rules={[{ required: true, message: '请输入最低匹配度' }]}
                      >
                        <InputNumber min={0} max={100} precision={0} step={1} suffix="%" />
                      </Form.Item>
                      <div className="settings-form-actions">
                        <Button type="primary" htmlType="submit">保存项目匹配配置</Button>
                      </div>
                    </Form>
                  </section>
                  <section
                    className="settings-general-section settings-update-section"
                    aria-labelledby="online-update-title"
                  >
                    <SettingsPanelHeading
                      title="在线更新"
                      titleId="online-update-title"
                      description="从 GitHub Release 检查、下载并安装 VISSLM Agent 的新版本。"
                      extra={(
                        <Tag color={updateStatusColor(updateStatus)}>
                          {updateStatusLabel(updateStatus)}
                        </Tag>
                      )}
                    />
                    <div className="settings-update-body">
                      <div className="settings-update-summary" aria-live="polite">
                        <div className="settings-update-version-row">
                          <Text strong>当前版本 {updateStatus?.currentVersion ?? '读取中…'}</Text>
                          {updateStatus?.version && updateStatus.phase !== 'not-available' && (
                            <Text type="secondary">目标版本 {updateStatus.version}</Text>
                          )}
                        </div>
                        {updateAvailable && (
                          <Alert
                            type="info"
                            showIcon
                            title={`发现新版本 ${updateStatus?.version ?? ''}`}
                            description="下载完成后可重启应用安装更新。"
                            className="settings-update-alert"
                          />
                        )}
                        {updateDownloading && (
                          <div
                            className="settings-update-progress"
                            aria-label={`正在下载 ${updateStatus?.version ?? '新版本'} 更新`}
                          >
                            <div className="settings-update-progress-meta">
                              <Text type="secondary">正在下载更新</Text>
                              {formatUpdateBytes(updateStatus?.bytesPerSecond) && (
                                <Text type="secondary">
                                  {formatUpdateBytes(updateStatus?.bytesPerSecond)}/s
                                </Text>
                              )}
                            </div>
                            <Progress
                              percent={Math.round(updateStatus?.percent ?? 0)}
                              showInfo={false}
                              strokeColor="var(--accent)"
                            />
                          </div>
                        )}
                        {updateDownloaded && (
                          <Alert
                            type="success"
                            showIcon
                            title="更新已下载"
                            description="重启应用后将完成安装。"
                            className="settings-update-alert"
                          />
                        )}
                        {updateStatus?.phase === 'not-available' && (
                          <Text type="secondary">最近检查时间：{formatUpdateDate(updateStatus.checkedAt) || '刚刚'}</Text>
                        )}
                        {updateStatus?.phase === 'unsupported' && (
                          <Text type="secondary">{updateStatus.message}</Text>
                        )}
                        {updateStatus?.phase === 'error' && (
                          <Alert
                            type="error"
                            showIcon
                            title="更新操作失败"
                            description={updateStatus.message}
                            className="settings-update-alert"
                          />
                        )}
                        {updateStatus?.releaseNotes && (
                          <div className="settings-update-notes">
                            <Text type="secondary">发行说明</Text>
                            <div>{updateStatus.releaseNotes}</div>
                          </div>
                        )}
                      </div>
                      <Space className="settings-update-actions" wrap>
                        <Button
                          icon={<ReloadOutlined />}
                          loading={updateAction === 'check'}
                          disabled={updateBusy || updateUnsupported}
                          onClick={() => void checkForUpdates()}
                        >
                          检查更新
                        </Button>
                        {updateAvailable && (
                          <Button
                            type="primary"
                            icon={<CloudDownloadOutlined />}
                            loading={updateAction === 'download'}
                            disabled={updateBusy}
                            onClick={() => void downloadUpdate()}
                          >
                            下载更新
                          </Button>
                        )}
                        {updateDownloaded && (
                          <Button
                            type="primary"
                            icon={<SyncOutlined />}
                            loading={updateAction === 'install'}
                            disabled={updateBusy}
                            onClick={() => void installUpdate()}
                          >
                            重启并安装
                          </Button>
                        )}
                      </Space>
                    </div>
                  </section>
                </div>
              )
            },
            {
              key: 'features',
              label: '功能模块',
              children: (
                <div className="settings-panel feature-settings-panel">
                  <SettingsPanelHeading
                    title="导航功能"
                    description="按需开放工作台功能，关闭后对应入口不会出现在左侧导航栏。"
                  />
                  <Alert
                    className="feature-settings-notice"
                    type="warning"
                    showIcon
                    title="数据推送默认关闭"
                    description="数据推送会将本地处理后的数据写回业务平台，不会执行数据采集。确认平台连接和推送范围后，再开启该功能。"
                  />
                  <div className="feature-module-sort-hint">
                    拖动每项左侧手柄即可调整导航栏顺序
                  </div>
                  <div className="feature-module-list">
                    {orderedFeatureDefinitions.map((definition) => (
                      <div
                        className={`feature-module-row ${draggingFeature === definition.key ? 'is-dragging' : ''} ${dragOverFeature?.key === definition.key ? `is-drop-target-${dragOverFeature.position}` : ''}`}
                        key={definition.key}
                        onDragOver={(event) => handleFeatureDragOver(event, definition.key)}
                        onDragLeave={() => setDragOverFeature(null)}
                        onDrop={(event) => handleFeatureDrop(event, definition.key)}
                      >
                        <button
                          type="button"
                          className="feature-module-drag-handle"
                          draggable={!navigationSaving}
                          aria-label={`拖动${definition.label}调整导航顺序`}
                          title="拖动调整导航顺序"
                          onDragStart={(event) => handleFeatureDragStart(event, definition.key)}
                          onDragEnd={() => {
                            setDraggingFeature(null)
                            setDragOverFeature(null)
                          }}
                        >
                          <HolderOutlined />
                        </button>
                        <div className="feature-module-icon">{definition.icon}</div>
                        <div className="feature-module-copy">
                          <div className="feature-module-title">
                            <Text strong>{definition.label}</Text>
                            {definition.defaultDisabled && <Tag color="warning">默认关闭</Tag>}
                          </div>
                          <Text type="secondary">{definition.description}</Text>
                        </div>
                        <Switch
                          checked={featureSettings[definition.key]}
                          loading={featureSaving === definition.key}
                          checkedChildren="开启"
                          unCheckedChildren="关闭"
                          onChange={(checked) => void saveFeature(definition.key, checked)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            }
          ]}
        />
      </Card>
    </div>
  )
}

function WindowTitleBar({
  themeMode,
  onThemeModeChange
}: {
  themeMode: AppThemeMode
  onThemeModeChange: (next: AppThemeMode) => void
}): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void window.visslm.isWindowMaximized().then(setMaximized)
    return window.visslm.onWindowMaximized(setMaximized)
  }, [])

  const toggleMaximize = async (): Promise<void> => {
    setMaximized(await window.visslm.toggleMaximizeWindow())
  }

  return (
    <div className="window-titlebar">
      <div className="window-drag-region" onDoubleClick={() => void toggleMaximize()}>
        <Text strong>VISSLM Agent</Text>
      </div>
      <div className="window-controls">
        <Tooltip title={themeMode === 'dark' ? '切换到亮色主题' : '切换到暗色主题'} placement="bottom">
          <button
            type="button"
            className="window-control-button window-theme-toggle"
            aria-label={themeMode === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
            aria-pressed={themeMode === 'dark'}
            onClick={() => onThemeModeChange(themeMode === 'dark' ? 'light' : 'dark')}
          >
            {themeMode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          </button>
        </Tooltip>
        <button
          type="button"
          className="window-control-button"
          aria-label="最小化"
          onClick={() => void window.visslm.minimizeWindow()}
        >
          <MinusOutlined />
        </button>
        <button
          type="button"
          className="window-control-button"
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? <FullscreenExitOutlined /> : <BorderOutlined />}
        </button>
        <button
          type="button"
          className="window-control-button close"
          aria-label="关闭"
          onClick={() => void window.visslm.closeWindow()}
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
  )
}

function AssetCenterPage({
  refreshKey,
  onDataChanged,
  onVisualize
}: {
  refreshKey: number
  onDataChanged: () => void
  onVisualize: (scope: DataScope, summary: string) => void
}): React.JSX.Element {
  const [activeTab, setActiveTab] = useState('data')
  return (
    <div className="asset-center-page page-stack">
      <Tabs
        className="page-inner-tabs asset-center-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'data',
            label: <span><DatabaseOutlined />数据中心</span>,
            children: (
              <DataPage
                refreshKey={refreshKey}
                onDataChanged={onDataChanged}
                onVisualize={onVisualize}
              />
            )
          },
          {
            key: 'knowledge',
            label: <span><BulbOutlined />知识库</span>,
            children: <KnowledgeBasePage refreshKey={refreshKey} />
          }
        ]}
      />
    </div>
  )
}

function AppShell({ themeMode, onThemeModeChange }: AppProps): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [page, setPage] = useState<PageKey>('dashboard')
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [modelOnline, setModelOnline] = useState<boolean | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatQuestion, setChatQuestion] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatConversationId, setChatConversationId] = useState<string>(() => crypto.randomUUID())
  const [generatedDashboard, setGeneratedDashboard] = useState<DashboardSpec | null>(null)
  const [generatedDashboardVersion, setGeneratedDashboardVersion] = useState<number | undefined>(undefined)
  const [chatDataScope, setChatDataScope] = useState<DataScope | null>(null)
  const [chatDataScopeSummary, setChatDataScopeSummary] = useState('')

  const updateGeneratedDashboard = useCallback((dashboard: DashboardSpec, version?: number): void => {
    setGeneratedDashboard(dashboard)
    setGeneratedDashboardVersion(version)
  }, [])

  useEffect(() => {
    void window.visslm.getSettings().then(setSettings)
    return window.visslm.onSyncProgress(setProgress)
  }, [])

  useEffect(() => {
    if (!settings) return
    setModelOnline(null)
    void window.visslm
      .testModel(settings.model)
      .then((result) => setModelOnline(result.ok))
      .catch(() => setModelOnline(false))
  }, [settings])

  const enabledFeatures = settings?.features ?? DEFAULT_FEATURE_MODULE_SETTINGS
  const navigationOrder = settings?.navigationOrder ?? DEFAULT_FEATURE_NAVIGATION_ORDER
  const visibleNavigationItems = useMemo(
    () => {
      const order = normalizeFeatureNavigationOrder(navigationOrder)
      return [...featureNavigationItems]
        .sort((left, right) => order.indexOf(left.feature) - order.indexOf(right.feature))
        .filter((item) => enabledFeatures[item.feature])
    },
    [enabledFeatures, navigationOrder]
  )

  useEffect(() => {
    if (page === 'settings' || enabledFeatures[page]) return
    setPage(visibleNavigationItems[0]?.key ?? 'settings')
  }, [enabledFeatures, page, visibleNavigationItems])

  const startSync = async (config?: SyncScopeConfig): Promise<SyncResult | null> => {
    setSyncing(true)
    setProgress({ phase: 'start', message: '准备采集', current: 0, total: 0 })
    try {
      const result = await window.visslm.startSync(config)
      if (result.ok) {
        message.success(result.message)
        setRefreshKey((key) => key + 1)
      } else {
        message.error(result.message)
      }
      return result
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setSyncing(false)
    }
  }

  const pageMeta: Record<PageKey, { title: string; description: string }> = {
    dashboard: { title: '数据概览', description: '掌握本地数据规模、类型构成与发布状态' },
    visualization: { title: '可视化大屏', description: '编辑可追溯的数据大屏并输出运营视图' },
    projects: { title: '项目管理', description: '管理项目进度、需求匹配与交付风险' },
    data: { title: '资产中心', description: '浏览、筛选和复用已同步的数据资产' },
    chat: { title: 'AI 助手', description: '用自然语言检索、统计和解释本地数据' },
    sync: { title: '数据采集', description: '定义采集范围、预览请求并执行同步' },
    push: { title: '数据推送', description: '配置字段映射并将数据安全推送回平台' },
    settings: { title: '系统配置', description: '配置平台连接、模型服务、通用参数与功能模块' }
  }

  const currentPage = useMemo(() => {
    if (page === 'dashboard') return <DashboardPage refreshKey={refreshKey} themeMode={themeMode} />
    if (page === 'visualization') {
      return (
        <DashboardStudio
          generatedDashboard={generatedDashboard}
          generatedDashboardVersion={generatedDashboardVersion}
          onDashboardChange={updateGeneratedDashboard}
        />
      )
    }
    if (page === 'projects') {
      return <ProjectManagementPage refreshKey={refreshKey} modelSettings={settings?.model ?? null} matchScoreThreshold={settings?.projectMatching.minScore ?? DEFAULT_PROJECT_MATCHING_SETTINGS.minScore} onChanged={() => setRefreshKey((key) => key + 1)} />
    }
    if (page === 'data') {
      return (
        <AssetCenterPage
          refreshKey={refreshKey}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
           onVisualize={(scope, summary) => {
             setChatDataScope(scope)
             setChatDataScopeSummary(summary)
             setChatQuestion(
               '@数据可视化专家 基于当前数据范围生成一个可视化大屏，请先分析可用字段并规划核心指标。'
             )
              if (!enabledFeatures.chat) {
                message.info('请先在系统配置的功能模块中开启 AI 助手')
                setPage('settings')
                return
              }
              setPage('chat')
            }}
        />
      )
    }
    if (page === 'chat') {
      return (
        <ChatPage
          messages={chatMessages}
          setMessages={setChatMessages}
          question={chatQuestion}
          setQuestion={setChatQuestion}
          loading={chatLoading}
          setLoading={setChatLoading}
          activeArtifact={generatedDashboard}
          activeArtifactVersion={generatedDashboardVersion}
          onDashboardUpdate={updateGeneratedDashboard}
          dataScope={chatDataScope}
          dataScopeSummary={chatDataScopeSummary}
          conversationId={chatConversationId}
          onConversationIdChange={setChatConversationId}
          modelOnline={modelOnline}
          modelName={settings?.model.model}
          onOpenSettings={() => setPage('settings')}
          onOpenSync={() => setPage('sync')}
          refreshKey={refreshKey}
          onClearDataScope={() => {
            setChatDataScope(null)
            setChatDataScopeSummary('')
          }}
          onOpenDashboard={(dashboard, version) => {
            updateGeneratedDashboard(dashboard, version)
            setPage('visualization')
          }}
        />
      )
    }
    if (page === 'sync') {
      return (
        <SyncPage
          progress={progress}
          syncing={syncing}
          onSync={startSync}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
        />
      )
    }
    if (page === 'push') {
      return (
        <PushPage
          refreshKey={refreshKey}
          onPushed={() => setRefreshKey((key) => key + 1)}
        />
      )
    }
    return <SettingsPage settings={settings} onChanged={setSettings} />
  }, [
    chatLoading,
    chatMessages,
    chatQuestion,
    chatConversationId,
    chatDataScope,
    chatDataScopeSummary,
    generatedDashboard,
    generatedDashboardVersion,
    modelOnline,
    page,
    progress,
    refreshKey,
    settings,
    syncing,
    themeMode,
    updateGeneratedDashboard
  ])

  return (
    <div className="app-frame">
      <WindowTitleBar themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
      <Layout className="app-layout">
        <Sider width={224} className="app-sider" theme="light">
          <div className="brand">
            <div className="brand-mark">
              <ThemedAppIcon alt="VISSLM Agent" />
            </div>
            <div>
              <div className="brand-title">VISSLM Agent</div>
              <div className="brand-subtitle">本地数据智能工作台</div>
            </div>
          </div>
          <Menu
            mode="inline"
           selectedKeys={[page]}
            onClick={({ key }) => setPage(key as PageKey)}
            items={[
              ...visibleNavigationItems.map(({ key, icon, label }) => ({ key, icon, label })),
              { type: 'divider' },
              { key: 'settings', icon: <SettingOutlined />, label: '系统配置' }
            ]}
          />
          <div className={`model-status ${modelOnline === true ? 'online' : modelOnline === false ? 'offline' : 'checking'}`}>
            <span className="model-status-light" />
            <div>
              <Text strong ellipsis>{settings?.model.model ?? 'qwen3:8b'}</Text>
              <Text type="secondary">
                {modelOnline === true
                  ? settings?.model.source === 'online' ? '在线模型可用' : '本地模型在线'
                  : modelOnline === false
                    ? settings?.model.source === 'online' ? '在线模型不可用' : '本地模型离线'
                    : '正在检测模型'}
              </Text>
            </div>
          </div>
        </Sider>
        <Layout className="app-main-layout">
          <Content className="app-content">
            <div className="content-page-heading">
              <div className="content-page-title">{pageMeta[page].title}</div>
              <div className="content-page-subtitle">{pageMeta[page].description}</div>
            </div>
            {currentPage}
          </Content>
        </Layout>
      </Layout>
    </div>
  )
}

export default function App({ themeMode, onThemeModeChange }: AppProps): React.JSX.Element {
  return (
    <AppIconThemeContext.Provider value={themeMode}>
      <AntApp>
        <AppShell themeMode={themeMode} onThemeModeChange={onThemeModeChange} />
      </AntApp>
    </AppIconThemeContext.Provider>
  )
}
