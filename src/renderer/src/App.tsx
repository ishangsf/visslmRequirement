import {
  BarChartOutlined,
  BorderOutlined,
  BulbOutlined,
  CloudDownloadOutlined,
  CloseOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EyeOutlined,
  ExportOutlined,
  FileSearchOutlined,
  FilterOutlined,
  FundProjectionScreenOutlined,
  FullscreenExitOutlined,
  ImportOutlined,
  LeftOutlined,
  MessageOutlined,
  MinusOutlined,
  PictureOutlined,
  PlusOutlined,
  SearchOutlined,
  SendOutlined,
  SettingOutlined,
  SyncOutlined,
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
  Layout,
  Menu,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography
} from 'antd'
import type { TablePaginationConfig } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import appIcon from './assets/visslm-icon.png'
import { DashboardStudio } from './dashboard/DashboardStudio'
import type { DashboardSpec } from '../../shared/dashboard'
import type {
  AppSettings,
  ChatDataRow,
  ChatDataView,
  ChatMessage,
  CollectionRequestLogRow,
  DashboardStats,
  ModelSettings,
  PlatformSettingsInput,
  ProjectRow,
  PushConfig,
  PushFieldMapping,
  PushLogRow,
  PushResult,
  RecordDetail,
  RecordRow,
  SyncFieldFilter,
  SyncPreviewResult,
  SyncProgress,
  SyncScopeConfig
} from '../../shared/types'

const { Content, Sider } = Layout
const { Title, Text, Paragraph } = Typography

type PageKey = 'dashboard' | 'visualization' | 'data' | 'chat' | 'sync' | 'push' | 'settings'

const formatDate = (value?: string): string => {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

const plainTextFromHtml = (value?: string): string => {
  if (!value) return ''
  const document = new DOMParser().parseFromString(value, 'text/html')
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function RichDescription({
  html,
  images
}: {
  html: string
  images: RecordDetail['images']
}): React.JSX.Element {
  const safeHtml = useMemo(() => {
    if (!html) return ''
    const document = new DOMParser().parseFromString(html, 'text/html')
    document
      .querySelectorAll('script,style,iframe,object,embed,link,meta,form,input,button,svg')
      .forEach((element) => element.remove())

    const allowedTags = new Set([
      'P', 'BR', 'DIV', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U',
      'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
      'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'A', 'IMG'
    ])
    for (const element of [...document.body.querySelectorAll('*')]) {
      if (!allowedTags.has(element.tagName)) {
        element.replaceWith(...element.childNodes)
        continue
      }
      if (element.tagName === 'IMG') {
        const source = element.getAttribute('src') ?? ''
        const alt = element.getAttribute('alt') ?? '描述图片'
        const normalizedSource = (() => {
          try {
            return decodeURIComponent(source)
          } catch {
            return source
          }
        })()
        const localImage = images.find((image) =>
          Boolean(
            image.dataUri &&
            (
              image.sourceUrl.includes(source) ||
              image.sourceUrl.includes(normalizedSource) ||
              (source.startsWith('data:image/') && image.sourceUrl === 'inline:data-uri')
            )
          )
        )
        for (const attribute of [...element.attributes]) {
          element.removeAttribute(attribute.name)
        }
        if (localImage?.dataUri) {
          element.setAttribute('src', localImage.dataUri)
          element.setAttribute('alt', alt)
          element.setAttribute('loading', 'lazy')
        } else {
          element.replaceWith(document.createTextNode(`[图片暂未同步：${alt}]`))
        }
      } else {
        for (const attribute of [...element.attributes]) {
          element.removeAttribute(attribute.name)
        }
      }
    }
    return document.body.innerHTML
  }, [html, images])

  if (!safeHtml) return <Text type="secondary">暂无描述</Text>
  return (
    <div
      className="rich-description"
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
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

function DashboardPage({ refreshKey }: { refreshKey: number }): React.JSX.Element {
  const [stats, setStats] = useState<DashboardStats | null>(null)

  useEffect(() => {
    void window.visslm.getStats().then(setStats)
  }, [refreshKey])

  if (!stats) return <Spin />
  const typeTotal = stats.byType.reduce((sum, item) => sum + item.value, 0)
  const releaseTotal = stats.byRelease.reduce((sum, item) => sum + item.value, 0)
  const releaseColors = ['#8578ff', '#35c7ff', '#34d399', '#f59e0b', '#f472b6', '#8d96a8']
  const releaseOption = {
    animationDuration: 350,
    color: releaseColors,
    tooltip: {
      trigger: 'item',
      renderMode: 'html',
      appendToBody: false,
      confine: true,
      transitionDuration: 0,
      backgroundColor: '#181c26',
      borderColor: '#343a4a',
      textStyle: { color: '#e8ecf4' },
      formatter: '{b}<br/><strong>{c}</strong> 条（{d}%）'
    },
    title: {
      text: String(releaseTotal),
      subtext: '条数据',
      left: 'center',
      top: '36%',
      textStyle: { color: '#f4f6fb', fontSize: 25, fontWeight: 650 },
      subtextStyle: { color: '#778196', fontSize: 11, lineHeight: 18 }
    },
    series: [
      {
        name: '_valm_Release',
        type: 'pie',
        radius: ['62%', '82%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: {
          borderColor: '#151821',
          borderWidth: 3,
          borderRadius: 5
        },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scaleSize: 5,
          label: { show: false }
        },
        data: stats.byRelease
      }
    ]
  }

  return (
    <div className="page-stack">
      <Row gutter={[14, 14]} className="dashboard-metrics">
        {[
          { title: '项目', count: stats.projectCount, icon: <DatabaseOutlined />, tone: 'violet' },
          { title: '已采集数据', count: stats.collectedCount, icon: <BarChartOutlined />, tone: 'blue' },
          { title: '已推送数据', count: stats.pushedCount, icon: <SendOutlined />, tone: 'cyan' },
          { title: 'Base64 图片', count: stats.imageCount, icon: <CloudDownloadOutlined />, tone: 'amber' }
        ].map(({ title, count, icon, tone }) => (
          <Col xs={24} sm={12} xl={6} key={title}>
            <Card className={`metric-card metric-card-${tone}`}>
              <div className="metric-content">
                <div className="metric-icon">{icon}</div>
                <Statistic title={title} value={count} />
              </div>
            </Card>
          </Col>
        ))}
      </Row>
      <Card className="dashboard-insights-card">
        <div className="dashboard-insights-heading">
          <div>
            <Title level={4}>数据构成</Title>
            <Text type="secondary">快速了解本地知识数据的类型与发布状态</Text>
          </div>
          <Tag>{stats.collectedCount} 条记录</Tag>
        </div>
        <div className="dashboard-insights-grid">
          <section className="dashboard-insight-section type-insight">
            <div className="insight-section-heading">
              <div>
                <Text strong>对象类型</Text>
                <Text type="secondary">按已采集数据类型统计</Text>
              </div>
              <span>{stats.byType.length} 种</span>
            </div>
            {stats.byType.length ? (
              <div className="type-composition-list">
                {stats.byType.slice(0, 8).map((item, index) => {
                  const percent = typeTotal ? Math.round((item.value / typeTotal) * 100) : 0
                  return (
                    <div className="type-composition-item" key={item.name}>
                      <div className="composition-meta">
                        <span className={`composition-dot dot-${index % 4}`} />
                        <Text ellipsis>{item.name}</Text>
                        <strong>{item.value}</strong>
                        <small>{percent}%</small>
                      </div>
                      <div className="composition-track">
                        <span style={{ width: `${Math.max(percent, 3)}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="采集数据后显示统计" />
            )}
          </section>
          <section className="dashboard-insight-section release-insight">
            <div className="insight-section-heading">
              <div>
                <Text strong>发布状态</Text>
                <Text type="secondary">字段 _valm_Release</Text>
              </div>
              <span>{stats.byRelease.length} 项</span>
            </div>
            {stats.byRelease.length ? (
              <div className="release-insight-content">
                <ReactECharts
                  className="release-donut"
                  option={releaseOption}
                  notMerge
                  lazyUpdate
                  opts={{ renderer: 'svg' }}
                />
                <div className="release-status-list">
                  {stats.byRelease.slice(0, 6).map((item, index) => (
                    <div className="release-status-row" key={item.name}>
                      <span
                        className="release-status-dot"
                        style={{ backgroundColor: releaseColors[index % releaseColors.length] }}
                      />
                      <Text ellipsis>{item.name}</Text>
                      <strong>{item.value}</strong>
                      <small>
                        {releaseTotal ? Math.round((item.value / releaseTotal) * 100) : 0}%
                      </small>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="采集 _valm_Release 后显示统计"
              />
            )}
          </section>
        </div>
      </Card>
    </div>
  )
}

function DataPage({
  refreshKey,
  onDataChanged
}: {
  refreshKey: number
  onDataChanged: () => void
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
      <Card>
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
            style={{ minWidth: 220 }}
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
            style={{ minWidth: 160 }}
          />
        </div>
        <Table<RecordRow>
          rowKey="uid"
          rowSelection={{
            selectedRowKeys,
            preserveSelectedRowKeys: true,
            onChange: (keys) => setSelectedRowKeys(keys.map(String))
          }}
          loading={loading}
          dataSource={records}
          scroll={{ x: 1450 }}
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
                <Button type="link" className="table-link" onClick={() => void openDetail(record.uid)}>
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
            { title: 'UID', dataIndex: 'uid', width: 120 },
            { title: '项目 UID', dataIndex: 'projectId', width: 120 },
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
        title={detail?.name ?? '记录详情'}
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
  onOpenDashboard
}: {
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  question: string
  setQuestion: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
  onOpenDashboard: (dashboard: DashboardSpec) => void
}): React.JSX.Element {
  const { message, modal } = AntApp.useApp()
  const messageListRef = useRef<HTMLDivElement>(null)
  const [activeDataView, setActiveDataView] = useState<ChatDataView | null>(null)
  const [activeDataGroup, setActiveDataGroup] = useState('')
  const [activeRecordDetail, setActiveRecordDetail] = useState<RecordDetail | null>(null)
  const [recordDetailLoading, setRecordDetailLoading] = useState(false)
  const conversationId = useRef(crypto.randomUUID())
  const selectedDataGroup = activeDataView?.groups.find(
    (group) => group.name === activeDataGroup
  ) ?? activeDataView?.groups[0]

  const openDataView = (view: ChatDataView): void => {
    setActiveDataView(view)
    setActiveDataGroup(view.groups[0]?.name ?? '')
    setActiveRecordDetail(null)
  }

  const closeDataView = (): void => {
    setActiveDataView(null)
    setActiveDataGroup('')
    setActiveRecordDetail(null)
    setRecordDetailLoading(false)
  }

  const resetConversation = (): void => {
    conversationId.current = crypto.randomUUID()
    setMessages([])
    setQuestion('')
    closeDataView()
    message.success('已开始新会话')
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

  const openRecordDetail = async (row: ChatDataRow): Promise<void> => {
    setRecordDetailLoading(true)
    try {
      const detail = await window.visslm.getRecord(row.uid)
      if (detail) setActiveRecordDetail(detail)
    } finally {
      setRecordDetailLoading(false)
    }
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

  const send = async (): Promise<void> => {
    const text = question.trim()
    if (!text || loading) return
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    const next = [...messages, userMessage]
    setMessages(next)
    setQuestion('')
    setLoading(true)
    try {
      const response = await window.visslm.askAgent({
        question: text,
        conversationId: conversationId.current,
        history: messages.slice(-8).map(({ role, content }) => ({ role, content }))
      })
      if (response.events?.some((event) => event.type === 'error' && event.recoverable)) {
        setQuestion(text)
      }
      setMessages([
        ...next,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: response.answer,
          sources: response.sources,
          dataViews: response.dataViews,
          dashboard: response.dashboard,
          expertId: response.expertId,
          createdAt: new Date().toISOString()
        }
      ])
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const userMessage = rawMessage.replace(
        /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,
        ''
      )
      setQuestion(text)
      setMessages([
        ...next,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `请求失败：${userMessage}`,
          createdAt: new Date().toISOString()
        }
      ])
    } finally {
      setLoading(false)
    }
  }

  const promptSuggestions = [
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
    }
  ]

  return (
    <div className="chat-page">
      <Card className="chat-card">
        <div className="chat-toolbar">
          <div className="chat-session-label">
            <MessageOutlined />
            <Text strong>当前会话</Text>
            {messages.length > 0 && (
              <Text type="secondary">{messages.length} 条消息</Text>
            )}
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
        <div className="message-list" ref={messageListRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="assistant-orb">
                <img src={appIcon} alt="VISSLM AI" />
                <span className="assistant-orb-status" />
              </div>
              <Tag className="knowledge-ready-tag" icon={<BulbOutlined />}>
                知识库已就绪
              </Tag>
              <Title level={3}>今天想从数据中了解什么？</Title>
              <Text type="secondary" className="chat-empty-description">
                我会检索本地 VISSLM 数据，进行统计、归纳和内容查询，并提供可查看的数据清单。
              </Text>
              <div className="prompt-grid">
                {promptSuggestions.map((item) => (
                  <Button
                    className="prompt-card"
                    key={item.prompt}
                    onClick={() => setQuestion(item.prompt)}
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
            </div>
          ) : (
            messages.map((message) => (
              <div className={`message-row ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === 'assistant'
                    ? <img src={appIcon} alt="VISSLM AI" />
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
                  <div className="message-bubble">
                    {message.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    ) : (
                      <Paragraph>{message.content}</Paragraph>
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
                          onClick={() => onOpenDashboard(message.dashboard!)}
                        >
                          打开可视化大屏
                        </Button>
                        <Text type="secondary">
                          {message.dashboard.components.length} 个组件
                        </Text>
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
                <img src={appIcon} alt="VISSLM AI" />
              </div>
              <div className="message-content">
                <div className="message-meta">
                  <Text strong>VISSLM AI</Text>
                  <Text type="secondary">正在思考</Text>
                </div>
                <div className="message-bubble thinking">
                  <span className="thinking-dots">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span>正在检索知识库并组织回答</span>
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="composer">
          <div className="composer-input">
            <Input.TextArea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onPressEnter={(event) => {
                if (!event.shiftKey) {
                  event.preventDefault()
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
                  if (!question.includes('@数据可视化专家')) {
                    setQuestion(`@数据可视化专家 ${question}`)
                  }
                }}
              >
                @数据可视化专家
              </Button>
              <Button
                className="chat-send-button"
                type="primary"
                icon={<SendOutlined />}
                loading={loading}
                disabled={!question.trim()}
                onClick={() => void send()}
              >
                发送
              </Button>
            </div>
          </div>
          <Text type="secondary" className="composer-disclaimer">
            AI 回答基于本地采集数据，可通过“查看查询数据”核实关键信息
          </Text>
        </div>
      </Card>
      <Modal
        className="chat-data-modal"
        width="min(1120px, calc(100vw - 48px))"
        centered
        footer={null}
        open={Boolean(activeDataView)}
        onCancel={closeDataView}
        destroyOnHidden
        title={
          <div className="chat-data-modal-title">
            <DatabaseOutlined />
            <span>
              {activeRecordDetail?.name ?? activeDataView?.title ?? '查询数据'}
            </span>
          </div>
        }
      >
        {activeDataView && (
          <Spin spinning={recordDetailLoading}>
            {activeRecordDetail ? (
              <div className="chat-record-detail">
                <Button
                  className="chat-record-back"
                  type="link"
                  icon={<LeftOutlined />}
                  onClick={() => setActiveRecordDetail(null)}
                >
                  返回查询列表
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
                <Divider titlePlacement="start">完整属性</Divider>
                <pre className="json-preview">
                  {JSON.stringify(activeRecordDetail.raw, null, 2)}
                </pre>
              </div>
            ) : (
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
                      style={{ minWidth: 280 }}
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
                    <Table<ChatDataRow>
                      rowKey="uid"
                      size="small"
                      dataSource={selectedDataGroup.rows}
                      scroll={{ x: 960, y: 'calc(100vh - 390px)' }}
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
                          title: field,
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
  onSync
}: {
  progress: SyncProgress | null
  syncing: boolean
  onSync: (config: SyncScopeConfig) => void
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
      onSync(config)
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
            <div>
              <Text strong>ReturnProperty</Text>
              <Text type="secondary">
                输入需要采集的字段 Key，多个字段使用英文逗号分隔；系统会自动补充必要字段
              </Text>
            </div>
            <Input
              value={returnPropertyFor(nodeType)}
              placeholder="例如：_valm_Description,_valm_Status"
              onChange={(event) => updateReturnProperty(nodeType, event.target.value)}
            />
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

          <Table<SyncFieldFilter>
            className="filter-config-table"
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={filters}
            locale={{ emptyText: '尚未添加过滤条件，将采集该类型的全部数据' }}
            scroll={{ x: 760 }}
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
        <Spin spinning={loadingConfig} tip="正在读取采集配置">
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
            <Col xs={24} sm={12}>
              <Statistic title="检查记录" value={preview.scannedCount} />
            </Col>
            <Col xs={24} sm={12}>
              <Statistic title="匹配记录" value={preview.matchedCount} />
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
          <Table<SyncPreviewResult['samples'][number]>
            className="sync-preview-table"
            rowKey="uid"
            size="small"
            pagination={false}
            dataSource={preview.samples}
            scroll={{ x: 1120, y: 280 }}
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
          <Table<CollectionRequestLogRow>
            rowKey="id"
            loading={requestLogsLoading}
            dataSource={requestLogs}
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
        message="安全说明"
        description="数据采集只读访问 VISSLM，不会修改平台数据。图片会转换为 Base64 并按内容哈希去重；平台当前使用 HTTP，正式环境建议启用 HTTPS。"
      />}
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
            <Table<PushFieldMapping>
              className="push-mapping-table"
              rowKey="id"
              pagination={false}
              dataSource={fieldMappings}
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
        <Table<RecordRow>
          rowKey="uid"
          loading={loading}
          dataSource={records}
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
        <Table<PushLogRow>
          rowKey="id"
          loading={logsLoading}
          dataSource={pushLogs}
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

function SettingsPage({
  settings,
  onChanged
}: {
  settings: AppSettings | null
  onChanged: (settings: AppSettings) => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const [platformForm] = Form.useForm<PlatformSettingsInput>()
  const [modelForm] = Form.useForm<ModelSettings>()
  const [platformTesting, setPlatformTesting] = useState(false)
  const [modelTesting, setModelTesting] = useState(false)

  useEffect(() => {
    if (!settings) return
    platformForm.setFieldsValue({
      baseUrl: settings.platform.baseUrl,
      username: settings.platform.username,
      token: ''
    })
    modelForm.setFieldsValue(settings.model)
  }, [settings, platformForm, modelForm])

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

  const testModel = async (): Promise<void> => {
    const values = await modelForm.validateFields()
    setModelTesting(true)
    try {
      const result = await window.visslm.testModel(values)
      result.ok ? message.success(result.message) : message.error(result.message)
    } finally {
      setModelTesting(false)
    }
  }

  const saveModel = async (values: ModelSettings): Promise<void> => {
    const next = await window.visslm.saveModelSettings(values)
    onChanged(next)
    message.success('模型配置已保存')
  }

  return (
    <div className="page-stack settings-width">
      <Card title="VISSLM 平台">
        <Form form={platformForm} layout="vertical" onFinish={(values) => void savePlatform(values)}>
          <Form.Item
            label="平台地址"
            name="baseUrl"
            rules={[{ required: true, message: '请输入平台地址' }]}
          >
            <Input placeholder="http://server/alm" />
          </Form.Item>
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item
            label="API Token"
            name="token"
            extra={settings?.platform.hasToken ? '已保存 Token；留空表示继续使用原 Token' : 'Token 将使用操作系统安全存储加密'}
            rules={[
              {
                validator: async (_, value) => {
                  if (!value && !settings?.platform.hasToken) throw new Error('请输入 API Token')
                }
              }
            ]}
          >
            <Input.Password autoComplete="new-password" placeholder={settings?.platform.hasToken ? '••••••••' : ''} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit">
              保存平台配置
            </Button>
            <Button loading={platformTesting} onClick={() => void testPlatform()}>
              测试连接
            </Button>
          </Space>
        </Form>
      </Card>
      <Card title="Ollama 模型">
        <Form form={modelForm} layout="vertical" onFinish={(values) => void saveModel(values)}>
          <Form.Item
            label="Ollama 地址"
            name="baseUrl"
            rules={[{ required: true, message: '请输入 Ollama 地址' }]}
          >
            <Input placeholder="http://127.0.0.1:11434" />
          </Form.Item>
          <Form.Item
            label="模型名称"
            name="model"
            rules={[{ required: true, message: '请输入模型名称' }]}
          >
            <Input placeholder="qwen3:8b" />
          </Form.Item>
          <Form.Item label="思考模式" name="thinking" valuePropName="checked">
            <Switch checkedChildren="开启" unCheckedChildren="关闭" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="Agent 工具调用建议关闭思考模式"
            description="qwen3:8b 开启思考后会增加响应时间，并可能在较小输出预算下无法及时生成工具调用。"
            style={{ marginBottom: 20 }}
          />
          <Space>
            <Button type="primary" htmlType="submit">
              保存模型配置
            </Button>
            <Button loading={modelTesting} onClick={() => void testModel()}>
              测试模型
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  )
}

function WindowTitleBar(): React.JSX.Element {
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
        <img src={appIcon} alt="" className="window-app-icon" />
        <Text strong>VISSLM Agent</Text>
      </div>
      <div className="window-controls">
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

function AppShell(): React.JSX.Element {
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
  const [generatedDashboard, setGeneratedDashboard] = useState<DashboardSpec | null>(null)

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

  const startSync = async (config?: SyncScopeConfig): Promise<void> => {
    setSyncing(true)
    setProgress({ phase: 'start', message: '准备采集', current: 0, total: 0 })
    try {
      const result = await window.visslm.startSync(config)
      if (result.ok) {
        message.success(`采集完成，共 ${result.recordCount} 条记录`)
        setRefreshKey((key) => key + 1)
      } else {
        message.error(result.message)
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSyncing(false)
    }
  }

  const titleMap: Record<PageKey, string> = {
    dashboard: '数据概览',
    visualization: '可视化大屏',
    data: '数据中心',
    chat: 'AI 助手',
    sync: '数据采集',
    push: '数据推送',
    settings: '连接设置'
  }

  const currentPage = useMemo(() => {
    if (page === 'dashboard') return <DashboardPage refreshKey={refreshKey} />
    if (page === 'visualization') {
      return <DashboardStudio generatedDashboard={generatedDashboard} />
    }
    if (page === 'data') {
      return (
        <DataPage
          refreshKey={refreshKey}
          onDataChanged={() => setRefreshKey((key) => key + 1)}
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
          onOpenDashboard={(dashboard) => {
            setGeneratedDashboard(dashboard)
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
          onSync={(config) => void startSync(config)}
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
    generatedDashboard,
    page,
    progress,
    refreshKey,
    settings,
    syncing
  ])

  return (
    <div className="app-frame">
      <WindowTitleBar />
      <Layout className="app-layout">
        <Sider width={224} className="app-sider" theme="light">
          <div className="brand">
            <div className="brand-mark">
              <img src={appIcon} alt="VISSLM Agent" />
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
              { key: 'dashboard', icon: <BarChartOutlined />, label: '数据概览' },
              {
                key: 'visualization',
                icon: <FundProjectionScreenOutlined />,
                label: '可视化大屏'
              },
              { key: 'data', icon: <DatabaseOutlined />, label: '数据中心' },
              { key: 'chat', icon: <MessageOutlined />, label: 'AI 助手' },
              { key: 'sync', icon: <SyncOutlined />, label: '数据采集' },
              { key: 'push', icon: <SendOutlined />, label: '数据推送' },
              { type: 'divider' },
              { key: 'settings', icon: <SettingOutlined />, label: '连接设置' }
            ]}
          />
          <div className={`model-status ${modelOnline === true ? 'online' : modelOnline === false ? 'offline' : 'checking'}`}>
            <span className="model-status-light" />
            <div>
              <Text strong ellipsis>{settings?.model.model ?? 'qwen3:8b'}</Text>
              <Text type="secondary">
                {modelOnline === true
                  ? '本地模型在线'
                  : modelOnline === false
                    ? '本地模型离线'
                    : '正在检测模型'}
              </Text>
            </div>
          </div>
        </Sider>
        <Layout className="app-main-layout">
          <Content className="app-content">
            <div className="content-page-title">{titleMap[page]}</div>
            {currentPage}
          </Content>
        </Layout>
      </Layout>
    </div>
  )
}

export default function App(): React.JSX.Element {
  return (
    <AntApp>
      <AppShell />
    </AntApp>
  )
}
