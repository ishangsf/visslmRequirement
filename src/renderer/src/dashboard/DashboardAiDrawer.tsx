import { CheckCircleOutlined, MessageOutlined, SendOutlined, UndoOutlined } from '@ant-design/icons'
import { Alert, Button, Drawer, Empty, Input, Space, Tag, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import type {
  DashboardAiChangeSummary,
  DashboardComponentSpec,
  DashboardSpec
} from '../../../shared/dashboard'
import { compareDashboardSpecValues, dashboardAiEditMode } from '../../../shared/dashboard'
import type { AgentEvent } from '../../../shared/expert-types'

const { Text } = Typography

type DashboardAiMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  contextOutcome?: 'success' | 'failed' | 'undone'
  changeSummary?: DashboardAiChangeSummary
  changeLabels?: string[]
  undone?: boolean
}

type DashboardAiFailure = {
  title: string
  detail: string
  suggestion: string
}

type LastAppliedAiChange = {
  requestMessageId: string
  responseMessageId: string
  before: DashboardSpec
  after: DashboardSpec
  previousVersion?: number
}

type DashboardAiDrawerProps = {
  open: boolean
  onClose: () => void
  dashboard: DashboardSpec | null
  selectedComponent: DashboardComponentSpec | null
  artifactVersion?: number
  onDashboardChange: (dashboard: DashboardSpec, version?: number) => void
  onUndoDashboardChange: (
    previous: DashboardSpec,
    applied: DashboardSpec,
    previousVersion?: number
  ) => boolean
}

const artifactEventOf = (
  events: AgentEvent[] | undefined
): Extract<AgentEvent, { type: 'artifact' }> | undefined =>
  events?.find((event): event is Extract<AgentEvent, { type: 'artifact' }> => event.type === 'artifact')

const dashboardFieldLabels: Record<string, string> = {
  title: '大屏标题',
  subtitle: '大屏副标题',
  theme: '主题',
  businessContext: '业务说明',
  globalFilters: '全局筛选',
  viewport: '画布尺寸'
}

const changeLabelsOf = (
  summary: DashboardAiChangeSummary,
  before: DashboardSpec,
  after: DashboardSpec
): string[] => {
  const componentNames = new Map(
    [...before.components, ...after.components].map((component) => [component.id, component.title])
  )
  return [
    ...summary.changedFields.map((field) => dashboardFieldLabels[field] ?? field),
    ...summary.addedComponents.map((id) => `新增：${componentNames.get(id) ?? id}`),
    ...summary.removedComponents.map((id) => `移除：${componentNames.get(id) ?? id}`),
    ...summary.updatedComponents.map((id) => `组件：${componentNames.get(id) ?? id}`)
  ].slice(0, 8)
}

const failureOf = (
  detail: string,
  event?: Extract<AgentEvent, { type: 'error' }>
): DashboardAiFailure => {
  const normalizedDetail = detail.replace(/\s+/g, ' ').trim()
  const conciseDetail = normalizedDetail.length > 360
    ? `${normalizedDetail.slice(0, 360)}…`
    : normalizedDetail
  if (detail.includes('画布已发生变化')) {
    return {
      title: '画布状态已变化',
      detail: conciseDetail,
      suggestion: '检查当前画布后重新发送，AI 不会覆盖处理期间产生的编辑。'
    }
  }
  if (event?.code === 'NO_ANALYTICS_DATA') {
    return {
      title: '当前范围没有可用数据',
      detail: conciseDetail,
      suggestion: '先调整数据范围或完成数据采集，再重新修改。'
    }
  }
  if (event?.code === 'DASHBOARD_AI_MODEL_OUTPUT') {
    return {
      title: '模型输出未形成有效修改',
      detail: conciseDetail,
      suggestion: '缩小修改范围或明确指定组件、图表类型和目标属性后重试。'
    }
  }
  if (event?.code === 'DASHBOARD_AI_QUERY_FAILED') {
    return {
      title: '组件数据查询失败',
      detail: conciseDetail,
      suggestion: '检查目标组件的数据字段与聚合方式，或改为修改样式和文字。'
    }
  }
  if (event?.code === 'DASHBOARD_AI_VALIDATION_FAILED') {
    return {
      title: '修改未通过大屏校验',
      detail: conciseDetail,
      suggestion: '保留当前画布，尝试一次只调整一个组件或一个属性。'
    }
  }
  return {
    title: 'AI 修改失败',
    detail: conciseDetail,
    suggestion: event?.attemptCount && event.attemptCount > 1
      ? `已自动尝试 ${event.attemptCount} 次，建议简化本次修改后重试。`
      : '确认模型服务可用后重试，当前画布没有发生变化。'
  }
}

export function DashboardAiDrawer({
  open,
  onClose,
  dashboard,
  selectedComponent,
  artifactVersion,
  onDashboardChange,
  onUndoDashboardChange
}: DashboardAiDrawerProps): React.JSX.Element {
  const [messages, setMessages] = useState<DashboardAiMessage[]>([])
  const [question, setQuestion] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [failure, setFailure] = useState<DashboardAiFailure | null>(null)
  const [appliedChanges, setAppliedChanges] = useState<LastAppliedAiChange[]>([])
  const conversationId = useRef(crypto.randomUUID())
  const messageListRef = useRef<HTMLDivElement>(null)
  const dashboardRef = useRef<DashboardSpec | null>(dashboard)
  const dashboardIdRef = useRef<string | null>(dashboard?.id ?? null)

  useEffect(() => {
    dashboardRef.current = dashboard
  }, [dashboard])

  useEffect(() => {
    const dashboardId = dashboard?.id ?? null
    if (dashboardIdRef.current === dashboardId) return
    dashboardIdRef.current = dashboardId
    conversationId.current = crypto.randomUUID()
    setMessages([])
    setQuestion('')
    setProgress('')
    setFailure(null)
    setAppliedChanges([])
  }, [dashboard?.id])

  useEffect(() => window.visslm.onAgentEvent((update) => {
    if (update.conversationId !== conversationId.current || update.event.type !== 'status') return
    setProgress(update.event.message)
  }), [])

  useEffect(() => {
    const container = messageListRef.current
    if (container) container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [messages.length, loading])

  const send = async (): Promise<void> => {
    const text = question.trim()
    if (!text || loading || !dashboard) return
    const requestDashboard = dashboard
    const requestDashboardSnapshot = JSON.stringify(requestDashboard)
    const userMessage: DashboardAiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text
    }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setQuestion('')
    setFailure(null)
    setProgress('正在准备大屏修改')
    setLoading(true)
    let responseFailureEvent: Extract<AgentEvent, { type: 'error' }> | undefined
    try {
      const response = await window.visslm.askAgent({
        question: text,
        conversationId: conversationId.current,
        entrypoint: 'dashboard',
        ...(selectedComponent ? { focusComponentId: selectedComponent.id } : {}),
        activeArtifact: {
          artifactId: requestDashboard.id,
          ...(artifactVersion === undefined ? {} : { version: artifactVersion }),
          dashboard: requestDashboard
        },
        history: messages.map(({ role, content, contextOutcome }) => ({
          role,
          content,
          ...(contextOutcome ? { outcome: contextOutcome } : {})
        }))
      })
      const responseError = response.events?.find(
        (event): event is Extract<AgentEvent, { type: 'error' }> => event.type === 'error'
      )
      responseFailureEvent = responseError
      if (responseError || !response.dashboard) {
        throw new Error(responseError?.message ?? response.answer)
      }
      const responseDashboard = response.dashboard
      const latestDashboard = dashboardRef.current
      if (!latestDashboard ||
          latestDashboard.id !== requestDashboard.id ||
          JSON.stringify(latestDashboard) !== requestDashboardSnapshot) {
        throw new Error('AI 处理期间画布已发生变化，本次结果未应用。请基于当前画布重新发送。')
      }
      const artifactEvent = artifactEventOf(response.events)
      const fallbackDiff = compareDashboardSpecValues(requestDashboard, responseDashboard)
      const changeSummary: DashboardAiChangeSummary = response.dashboardChange ?? {
        ...fallbackDiff,
        queryExecutionCount: fallbackDiff.queryChanges.length,
        attemptCount: 1,
        durationMs: 0
      }
      const responseMessageId = crypto.randomUUID()
      dashboardRef.current = responseDashboard
      onDashboardChange(responseDashboard, artifactEvent?.version)
      setAppliedChanges((items) => [
        ...items.slice(-19),
        {
          requestMessageId: userMessage.id,
          responseMessageId,
          before: requestDashboard,
          after: responseDashboard,
          previousVersion: artifactVersion
        }
      ])
      setMessages([
        ...messages,
        { ...userMessage, contextOutcome: 'success' },
        {
          id: responseMessageId,
          role: 'assistant',
          content: response.answer,
          contextOutcome: 'success',
          changeSummary,
          changeLabels: changeLabelsOf(changeSummary, requestDashboard, responseDashboard)
        }
      ])
      setProgress('修改完成，结果已回写到当前画布')
    } catch (requestError) {
      const detail = requestError instanceof Error ? requestError.message : String(requestError)
      const nextFailure = failureOf(detail, responseFailureEvent)
      setFailure(nextFailure)
      setQuestion(text)
      setMessages([
        ...messages,
        { ...userMessage, contextOutcome: 'failed' },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          contextOutcome: 'failed',
          content: `${nextFailure.title}：${nextFailure.detail}\n建议：${nextFailure.suggestion}`
        }
      ])
    } finally {
      setLoading(false)
    }
  }

  const latestAppliedChange = appliedChanges.at(-1)

  const undoLastAiChange = (): void => {
    if (!latestAppliedChange || loading) return
    const restored = onUndoDashboardChange(
      latestAppliedChange.before,
      latestAppliedChange.after,
      latestAppliedChange.previousVersion
    )
    if (!restored) {
      setFailure(failureOf('AI 修改后画布已继续编辑，无法直接撤销该次修改。'))
      return
    }
    dashboardRef.current = latestAppliedChange.before
    setMessages((items) => items.map((item) => {
      if (item.id === latestAppliedChange.requestMessageId) {
        return { ...item, contextOutcome: 'undone' }
      }
      if (item.id === latestAppliedChange.responseMessageId) {
        return { ...item, contextOutcome: 'undone', undone: true }
      }
      return item
    }))
    setFailure(null)
    setProgress('最近一次 AI 修改已撤销')
    setAppliedChanges((items) => items.slice(0, -1))
  }

  const title = selectedComponent
    ? `AI 修改 · ${selectedComponent.title}`
    : 'AI 修改当前大屏'
  const editMode = dashboard ? dashboardAiEditMode(dashboard) : 'full'
  const latestChangeUndoAvailable = Boolean(
    latestAppliedChange && dashboard && JSON.stringify(dashboard) === JSON.stringify(latestAppliedChange.after)
  )

  return (
    <Drawer
      className="dashboard-ai-drawer"
      title={(
        <Space size={8}>
          <MessageOutlined />
          <span>{title}</span>
        </Space>
      )}
      placement="right"
      size="min(440px, calc(100vw - 32px))"
      open={open}
      mask={false}
      onClose={onClose}
      destroyOnHidden={false}
    >
      <div className="dashboard-ai-drawer-content">
        <div className="dashboard-ai-context" aria-label="AI 修改上下文">
          <div>
            <Text strong>{dashboard?.title ?? '当前大屏'}</Text>
            <Text type="secondary">
              {selectedComponent
                ? editMode === 'presentation-only'
                  ? `展示快照，仅修改组件文字：${selectedComponent.title}`
                  : `仅修改组件：${selectedComponent.title}`
                : editMode === 'presentation-only'
                  ? '展示快照，仅支持大屏文字与主题'
                  : '未选中组件，可修改大屏标题、主题或组件'}
            </Text>
          </div>
          <Tag color={selectedComponent ? 'processing' : 'default'}>
            {editMode === 'presentation-only'
              ? '展示快照'
              : selectedComponent ? selectedComponent.id : '整屏'}
          </Tag>
        </div>

        {failure && (
          <Alert
            type="error"
            showIcon
            message={failure.title}
            description={(
              <div className="dashboard-ai-failure-detail">
                <span>{failure.detail}</span>
                <strong>{failure.suggestion}</strong>
              </div>
            )}
            closable
            onClose={() => setFailure(null)}
          />
        )}

        <div className="dashboard-ai-message-list" ref={messageListRef} role="log" aria-live="polite">
          {!messages.length ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={selectedComponent
                ? '描述要如何调整当前组件'
                : '描述要如何调整当前大屏'}
            />
          ) : messages.map((message) => (
            <div className={`dashboard-ai-message ${message.role}`} key={message.id}>
              <Text className="dashboard-ai-message-role">
                {message.role === 'assistant' ? 'VISSLM AI' : '你'}
              </Text>
              <div className="dashboard-ai-message-bubble">{message.content}</div>
              {message.changeSummary && (
                <div className={`dashboard-ai-change-summary${message.undone ? ' is-undone' : ''}`}>
                  <div className="dashboard-ai-change-summary-header">
                    <span>
                      <CheckCircleOutlined />
                      {message.undone ? '修改已撤销' : '已应用到当前草稿'}
                    </span>
                    {message.id === latestAppliedChange?.responseMessageId && (
                      <Button
                        size="small"
                        type="text"
                        icon={<UndoOutlined />}
                        disabled={!latestChangeUndoAvailable || loading}
                        onClick={undoLastAiChange}
                      >
                        撤销
                      </Button>
                    )}
                  </div>
                  <div className="dashboard-ai-change-tags">
                    {message.changeLabels?.map((label) => <Tag key={label}>{label}</Tag>)}
                  </div>
                  <Text type="secondary">
                    重算 {message.changeSummary.queryExecutionCount} 个查询
                    {' · '}
                    {message.changeSummary.attemptCount > 1
                      ? `经 ${message.changeSummary.attemptCount} 轮校验修复`
                      : '首轮校验通过'}
                    {message.changeSummary.durationMs > 0
                      ? ` · ${(message.changeSummary.durationMs / 1000).toFixed(1)}s`
                      : ''}
                  </Text>
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="dashboard-ai-message assistant">
              <Text className="dashboard-ai-message-role">VISSLM AI</Text>
              <div className="dashboard-ai-message-bubble is-thinking">{progress || '正在处理'}</div>
            </div>
          )}
        </div>

        <div className="dashboard-ai-composer">
          <Input.TextArea
            value={question}
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={loading || !dashboard}
            placeholder={selectedComponent
              ? editMode === 'presentation-only'
                ? `例如：把“${selectedComponent.title}”改成更简洁的标题`
                : `例如：将“${selectedComponent.title}”改为折线图并按月展示`
              : editMode === 'presentation-only'
                ? '例如：精简大屏标题并切换为明亮商务主题'
                : '例如：把大屏主标题改得更简洁'}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
          />
          <div className="dashboard-ai-composer-footer">
            <Text type="secondary">Enter 发送，Shift + Enter 换行</Text>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={loading}
              disabled={!question.trim() || !dashboard}
              onClick={() => void send()}
            >
              发送
            </Button>
          </div>
        </div>
      </div>
    </Drawer>
  )
}
