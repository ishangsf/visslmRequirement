import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  PlayCircleOutlined,
  RocketOutlined,
  SafetyCertificateOutlined
} from '@ant-design/icons'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Steps,
  Tag,
  Typography
} from 'antd'
import { useEffect, useMemo, useState } from 'react'
import type {
  DashboardDomainPlatformAdapter,
  DashboardDomainRole,
  DashboardScenarioDataMode,
  DashboardScenarioDraft,
  DashboardScenarioGenerationResult,
  DashboardScenarioReadiness
} from '../../../shared/dashboard-domain'
import type { DataScope } from '../../../shared/query-spec'
import type { DashboardSpec } from '../../../shared/dashboard'
import type { ProjectRow } from '../../../shared/types'

const { Text, Paragraph, Title } = Typography

type ScenarioDefinition = {
  id: string
  name: string
  description: string
  roles: DashboardDomainRole[]
  metrics: string[]
  components: string[]
  lines: string[]
}

const roleLabels: Record<DashboardDomainRole, string> = {
  'project-owner': '项目负责人',
  'qa-epg': '质量与过程负责人',
  'rd-lead': '研发负责人',
  'model-org-manager': '型号/组织管理负责人'
}

const wizardStepGuidance = [
  {
    title: '选择场景',
    heading: '先确定要回答的业务问题',
    description: '从受控的黄金场景开始，指标和组件会自动带出。'
  },
  {
    title: '数据范围',
    heading: '配置数据范围',
    description: '确认使用角色、数据来源和需要纳入的项目。'
  },
  {
    title: '准备度检查',
    heading: '确认生成准备度',
    description: '查看指标、权限和过程证据是否满足生成条件。'
  },
  {
    title: '生成预览',
    heading: '检查组件方案',
    description: '确认预置组件后生成大屏预览，并继续在画布中调整。'
  }
] as const

const scenarioDefinitions: ScenarioDefinition[] = [
  {
    id: 'project-overview',
    name: '项目综合态势',
    description: '回答项目能否按期、按质、合规交付，串联执行、质量和过程证据。',
    roles: ['project-owner', 'qa-epg', 'rd-lead', 'model-org-manager'],
    metrics: ['健康度', '里程碑达成率', '需求完成率', '缺陷密度', '高风险数', '过程符合度'],
    components: ['综合评分', '里程碑时间线', '执行趋势', '风险排行', '过程证据摘要'],
    lines: ['执行', '质量', '过程']
  },
  {
    id: 'requirements-delivery',
    name: '需求到交付全链路',
    description: '围绕需求完整性、稳定性、评审、开发、验证和双向追溯组织首屏。',
    roles: ['project-owner', 'qa-epg', 'rd-lead'],
    metrics: ['需求稳定度', '评审完成率', '变更率', '开发完成率', '测试覆盖率', '双向追溯'],
    components: ['交付漏斗', '需求趋势', '追溯链路', '变更排行', '异常明细'],
    lines: ['执行', '质量', '过程']
  },
  {
    id: 'plan-milestone',
    name: '计划与里程碑执行',
    description: '识别计划偏差、延期任务和关键路径风险，提前提示里程碑影响。',
    roles: ['project-owner', 'rd-lead'],
    metrics: ['计划完成率', '进度偏差', '延期任务数', '关键路径风险', '里程碑预测'],
    components: ['甘特摘要', '进度趋势', '延期排行', '里程碑预测', '预警卡'],
    lines: ['执行']
  },
  {
    id: 'software-quality',
    name: '软件质量与缺陷闭环',
    description: '判断质量风险是否收敛，关注严重缺陷、重开率和遗留风险。',
    roles: ['project-owner', 'qa-epg', 'rd-lead'],
    metrics: ['严重缺陷数', '重开率', '缺陷密度', '未关闭缺陷', '平均修复时长', '遗留风险'],
    components: ['质量趋势', '严重度分布', '模块热力图', '修复效率', '缺陷明细'],
    lines: ['质量']
  },
  {
    id: 'test-validation',
    name: '测试与验证充分性',
    description: '检查测试执行、通过、需求覆盖、代码覆盖、自动化和阻塞用例。',
    roles: ['project-owner', 'qa-epg', 'rd-lead'],
    metrics: ['用例执行率', '测试通过率', '需求覆盖率', '代码覆盖率', '自动化率', '阻塞用例数'],
    components: ['测试漏斗', '覆盖矩阵', '通过趋势', '自动化对比', '阻塞清单'],
    lines: ['质量', '过程']
  },
  {
    id: 'configuration-change',
    name: '配置管理与变更控制',
    description: '围绕配置项、基线、变更审批和构建可复现组织受控交付视图。',
    roles: ['project-owner', 'qa-epg', 'rd-lead'],
    metrics: ['配置项纳管率', '基线完整率', '变更审批率', '未关闭变更', '构建可复现率'],
    components: ['基线状态卡', '变更漏斗', '版本趋势', '审批排行', '异常明细'],
    lines: ['过程', '执行', '质量']
  },
  {
    id: 'gjb5000b-compliance',
    name: 'GJB5000B 过程符合度与证据审计',
    description: '检查过程活动、工作产品、证据、偏差和整改闭环；不自动替代正式符合性结论。',
    roles: ['qa-epg', 'model-org-manager'],
    metrics: ['活动执行率', '工作产品完整率', '证据充分率', '过程偏差数', '不符合项关闭率'],
    components: ['核心指标', '阶段矩阵', '描述列表', '趋势折线', '排行列表', '区间条形'],
    lines: ['过程', '质量']
  },
  {
    id: 'organization-improvement',
    name: '组织级度量与过程改进',
    description: '从项目群角度观察质量差异、估算偏差、生产率、缺陷逃逸和改进成效。',
    roles: ['model-org-manager', 'qa-epg'],
    metrics: ['质量离散度', '估算偏差率', '交付生产率', '缺陷逃逸率', '改进完成率', '基线稳定性'],
    components: ['项目群矩阵', '统计分布', '质量趋势', '改进闭环', '基线稳定性'],
    lines: ['组织', '执行', '质量', '过程']
  }
]

const scenarioById = (id: string): ScenarioDefinition =>
  scenarioDefinitions.find((scenario) => scenario.id === id) ?? scenarioDefinitions[0]

const readinessTag = (level: DashboardScenarioReadiness['level']): React.JSX.Element => {
  if (level === 'ready') return <Tag color="success">可生成</Tag>
  if (level === 'partial') return <Tag color="warning">可预览，需补充</Tag>
  return <Tag color="error">暂不可生成</Tag>
}

const generationClarificationMessage = (result: DashboardScenarioGenerationResult): string => {
  const details: string[] = []
  const addDetail = (value?: string): void => {
    const detail = value?.trim()
    if (detail && !details.includes(detail)) details.push(detail)
  }

  addDetail(result.answer)
  addDetail(result.reason)
  addDetail(result.clarification?.reason)

  const optionLabels = (result.clarification?.options ?? [])
    .map((option) => option.label.trim())
    .filter(Boolean)
  if (optionLabels.length > 0) details.push(`可选处理方式：${optionLabels.join('、')}`)

  return details.join('；') || '生成需要补充信息，请确认场景范围、权限和指标口径后重试。'
}

const draftScope = (projectIds: string[]): DataScope => ({
  ...(projectIds.length ? { projectIds } : {})
})

const adapterFor = (
  adapters: readonly DashboardDomainPlatformAdapter[],
  scenarioId: string,
  adapterId?: string
): DashboardDomainPlatformAdapter | undefined => {
  if (adapterId) return adapters.find((adapter) => adapter.id === adapterId)
  return adapters.find((adapter) => adapter.scenarioId === scenarioId)
}

type DashboardScenarioWizardProps = {
  open: boolean
  onClose: () => void
  onGenerated: (dashboard: DashboardSpec, result: DashboardScenarioGenerationResult) => void
}

export function DashboardScenarioWizard({
  open,
  onClose,
  onGenerated
}: DashboardScenarioWizardProps): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [scenarioId, setScenarioId] = useState('project-overview')
  const [role, setRole] = useState<DashboardDomainRole>('project-owner')
  const [dataMode, setDataMode] = useState<DashboardScenarioDataMode>('controlled-sample')
  const [projectIds, setProjectIds] = useState<string[]>([])
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [adapters, setAdapters] = useState<DashboardDomainPlatformAdapter[]>([])
  const [adapterId, setAdapterId] = useState<string>()
  const [readiness, setReadiness] = useState<DashboardScenarioReadiness | null>(null)
  const [generation, setGeneration] = useState<DashboardScenarioGenerationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const scenario = useMemo(() => scenarioById(scenarioId), [scenarioId])
  const selectedAdapter = useMemo(
    () => adapterFor(adapters, scenario.id, adapterId),
    [adapters, scenario.id, adapterId]
  )

  const reset = (): void => {
    setStep(0)
    setScenarioId('project-overview')
    setRole('project-owner')
    setDataMode('controlled-sample')
    setProjectIds([])
    setAdapterId(undefined)
    setReadiness(null)
    setGeneration(null)
    setLoading(false)
    setError('')
  }

  useEffect(() => {
    if (!open) return
    let canceled = false
    setError('')
    void Promise.all([window.visslm.listProjects(), window.visslm.getSettings()])
      .then(([nextProjects, settings]) => {
        if (canceled) return
        setProjects(nextProjects)
        setAdapters(settings.dashboardDomainPlatformAdapters)
      })
      .catch((cause: unknown) => {
        if (!canceled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      canceled = true
    }
  }, [open])

  const chooseScenario = (nextScenarioId: string): void => {
    const nextScenario = scenarioById(nextScenarioId)
    setScenarioId(nextScenario.id)
    if (!nextScenario.roles.includes(role)) setRole(nextScenario.roles[0])
    setReadiness(null)
    setGeneration(null)
    setAdapterId(undefined)
  }

  const buildDraft = (): DashboardScenarioDraft => ({
    entry: 'gallery',
    scenarioId: scenario.id,
    role,
    dataMode,
    scope: draftScope(projectIds),
    ...(dataMode === 'platform-adapter' && selectedAdapter
      ? {
          adapter: selectedAdapter,
          requestedPermissions: selectedAdapter.permissions
        }
      : {}),
    generatedAt: new Date().toISOString()
  })

  const checkReadiness = async (): Promise<DashboardScenarioReadiness | null> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.visslm.getDashboardScenarioReadiness(buildDraft())
      setReadiness(result)
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return null
    } finally {
      setLoading(false)
    }
  }

  const generate = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const result = await window.visslm.generateDashboardFromScenario(buildDraft())
      setGeneration(result)
      if (result.status === 'ready') {
        if (result.dashboard) {
          onGenerated(result.dashboard, result)
        } else {
          setError(result.answer?.trim() || result.reason?.trim() || '场景生成未返回大屏结果')
        }
      } else if (result.status === 'rejected') {
        setError(result.answer?.trim() || result.reason?.trim() || '场景生成未完成')
      } else if (result.status === 'clarification') {
        // Keep the structured result on the preview step so the user can see
        // the question and any safe choices instead of silently stopping.
        setError(generationClarificationMessage(result))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const next = async (): Promise<void> => {
    if (step === 0) {
      setStep(1)
      return
    }
    if (step === 1) {
      const result = await checkReadiness()
      if (result) setStep(2)
      return
    }
    if (step === 2) {
      if (!readiness) {
        const result = await checkReadiness()
        if (!result || result.level === 'blocked') return
      } else if (readiness.level === 'blocked') {
        return
      }
      setStep(3)
    }
  }

  const canContinue = step === 0 || step === 1 || (step === 2 && readiness?.level !== 'blocked') || step === 3
  const activeGuidance = wizardStepGuidance[step] ?? wizardStepGuidance[0]

  return (
    <Modal
      className="dashboard-scenario-wizard-modal"
      title={(
        <Space>
          <RocketOutlined />
          <span>从黄金场景创建大屏</span>
        </Space>
      )}
      open={open}
      width="min(1120px, calc(100vw - 32px))"
      destroyOnHidden={false}
      onCancel={() => {
        onClose()
        reset()
      }}
      footer={(
        <div className="dashboard-scenario-wizard-footer">
          <span className="dashboard-scenario-wizard-footer-context" aria-live="polite">
            第 {step + 1} 步 / 4 · {scenario.name}
          </span>
          <Space size={8} className="dashboard-scenario-wizard-footer-actions">
            <Button onClick={() => {
              onClose()
              reset()
            }}>
              取消
            </Button>
            {step > 0 && (
              <Button disabled={loading} onClick={() => setStep((current) => current - 1)}>
                上一步
              </Button>
            )}
            {step < 3 && (
              <Button type="primary" disabled={!canContinue || loading} onClick={() => void next()}>
                {step === 2 ? '查看生成预览' : '下一步'}
              </Button>
            )}
            {step === 3 && (
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={loading}
                disabled={readiness?.level === 'blocked'}
                onClick={() => void generate()}
              >
                生成大屏预览
              </Button>
            )}
          </Space>
        </div>
      )}
    >
      <div className="dashboard-scenario-wizard-shell">
        <aside className="dashboard-scenario-wizard-rail" aria-label="黄金场景向导进度">
          <div className="dashboard-scenario-wizard-rail-heading">
            <Text type="secondary">向导进度</Text>
            <strong>从问题到画布</strong>
          </div>
          <div className="dashboard-scenario-wizard-rail-context">
            <span className="dashboard-scenario-wizard-rail-label">当前黄金场景</span>
            <strong className="dashboard-scenario-wizard-rail-scenario" title={scenario.name}>{scenario.name}</strong>
            <span className="dashboard-scenario-wizard-rail-role">{roleLabels[role]}</span>
            <div className="dashboard-scenario-wizard-rail-tags" aria-label="场景覆盖业务线">
              {scenario.lines.map((line) => <Tag key={line}>{line}线</Tag>)}
            </div>
            <span className="dashboard-scenario-wizard-rail-metrics">
              {scenario.metrics.length} 项指标 · {scenario.components.length} 个组件
            </span>
          </div>
          <Steps
            current={step}
            direction="vertical"
            className="dashboard-scenario-wizard-steps"
            aria-label="黄金场景向导步骤"
            items={[
              { title: '选择场景', description: '确定业务问题', icon: <RocketOutlined /> },
              { title: '数据范围', description: '选择数据来源', icon: <FileSearchOutlined /> },
              { title: '准备度检查', description: '确认生成条件', icon: <SafetyCertificateOutlined /> },
              { title: '生成预览', description: '查看组件方案', icon: <PlayCircleOutlined /> }
            ]}
          />
          <span className="dashboard-scenario-wizard-rail-note">可随时返回上一步调整范围</span>
        </aside>

        <section className="dashboard-scenario-wizard-panel" aria-label={`黄金场景向导：${activeGuidance.heading}`}>
          <div className="dashboard-scenario-wizard-panel-heading">
            <div>
              <Text type="secondary">第 {step + 1} 步 · {activeGuidance.title}</Text>
              <Title level={4}>{activeGuidance.heading}</Title>
              <Paragraph type="secondary">{activeGuidance.description}</Paragraph>
            </div>
            <Tag color="purple">{step + 1} / 4</Tag>
          </div>

          <div className="dashboard-scenario-wizard-content">
            {error && generation?.status !== 'clarification' && (
              <Alert
                className="dashboard-scenario-wizard-alert"
                type="error"
                showIcon
                closable
                message="向导未完成"
                description={error}
                onClose={() => setError('')}
              />
            )}

            {step === 0 && (
              <div className="dashboard-scenario-gallery" aria-label="黄金场景列表">
                <div className="dashboard-scenario-gallery-intro">
                  <div>
                    <Text strong>选择一个可复用的业务问题</Text>
                    <Paragraph type="secondary">
                      场景会带出受控指标、布局和过程证据要求；你只需确认范围，组件不需要逐个配置。
                    </Paragraph>
                  </div>
                  <Tag color="purple">8 个黄金场景</Tag>
                </div>
                <div className="dashboard-scenario-card-grid">
                  {scenarioDefinitions.map((item) => (
                    <Card
                      key={item.id}
                      hoverable
                      className={`dashboard-scenario-card ${item.id === scenario.id ? 'is-selected' : ''}`}
                      onClick={() => chooseScenario(item.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          chooseScenario(item.id)
                        }
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={item.id === scenario.id}
                    >
                      <div className="dashboard-scenario-card-heading">
                        <Title level={5} title={item.name}>{item.name}</Title>
                        {item.id === scenario.id && (
                          <span className="dashboard-scenario-card-selected" aria-label="已选择">
                            <CheckCircleOutlined /> 已选择
                          </span>
                        )}
                      </div>
                      <Paragraph ellipsis={{ rows: 2 }}>{item.description}</Paragraph>
                      <div className="dashboard-scenario-card-lines" aria-label="覆盖业务线">
                        {item.lines.map((line) => <Tag key={line}>{line}线</Tag>)}
                      </div>
                      <div className="dashboard-scenario-card-meta">
                        <span><strong>{item.metrics.length}</strong> 项核心指标</span>
                        <span><strong>{item.components.length}</strong> 个预置组件</span>
                      </div>
                      <div className="dashboard-scenario-card-roles">
                        <span>适用角色</span>
                        <Space size={4} wrap>
                          {item.roles.map((itemRole) => <Tag key={itemRole}>{roleLabels[itemRole]}</Tag>)}
                        </Space>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="dashboard-scenario-wizard-step dashboard-scenario-wizard-step-scope">
                <div className="dashboard-scenario-wizard-summary">
                  <div>
                    <Text type="secondary">当前黄金场景</Text>
                    <Title level={4}>{scenario.name}</Title>
                    <Paragraph type="secondary">{scenario.description}</Paragraph>
                  </div>
                  <div className="dashboard-scenario-wizard-summary-tags">
                    {scenario.lines.map((line) => <Tag key={line}>{line}线</Tag>)}
                    <Tag>{scenario.metrics.length} 项指标</Tag>
                  </div>
                </div>
                <div className="dashboard-scenario-form-grid">
                  <label>
                    <span>使用角色</span>
                    <Select
                      aria-label="黄金场景使用角色"
                      value={role}
                      options={scenario.roles.map((itemRole) => ({ value: itemRole, label: roleLabels[itemRole] }))}
                      onChange={(value) => {
                        setRole(value as DashboardDomainRole)
                        setReadiness(null)
                      }}
                    />
                  </label>
                  <label>
                    <span>数据模式</span>
                    <Select
                      aria-label="黄金场景数据模式"
                      value={dataMode}
                      options={[
                        { value: 'controlled-sample', label: '受控样例（仅预览）' },
                        { value: 'platform-adapter', label: '平台适配器（真实项目范围）' }
                      ]}
                      onChange={(value) => {
                        setDataMode(value as DashboardScenarioDataMode)
                        setReadiness(null)
                      }}
                    />
                  </label>
                  {dataMode === 'platform-adapter' && (
                    <label>
                      <span>平台适配器</span>
                      <Select
                        aria-label="黄金场景平台适配器"
                        placeholder="选择已验证的适配器"
                        value={selectedAdapter?.id}
                        options={adapters
                          .filter((adapter) => adapter.scenarioId === scenario.id)
                          .map((adapter) => ({ value: adapter.id, label: `${adapter.sourceSystem} · ${adapter.id}` }))}
                        onChange={(value) => {
                          setAdapterId(value)
                          setReadiness(null)
                        }}
                        notFoundContent="当前场景没有已配置适配器"
                      />
                    </label>
                  )}
                  <label className="dashboard-scenario-form-wide">
                    <span>{dataMode === 'platform-adapter' ? '项目范围（必选）' : '项目范围（可选）'}</span>
                    <Select
                      mode="multiple"
                      aria-label="黄金场景项目范围"
                      placeholder={dataMode === 'platform-adapter' ? '至少选择一个项目' : '不选择则使用受控样例范围'}
                      value={projectIds}
                      options={projects.map((project) => ({
                        value: project.uid,
                        label: `${project.name} · ${project.recordCount} 条记录`
                      }))}
                      onChange={(values) => {
                        setProjectIds(values as string[])
                        setReadiness(null)
                      }}
                      optionFilterProp="label"
                      showSearch
                    />
                  </label>
                </div>
                {dataMode === 'platform-adapter' && !selectedAdapter && (
                  <Alert
                    className="dashboard-scenario-scope-alert"
                    type="warning"
                    showIcon
                    message="当前场景尚未配置平台适配器"
                    description="可以先查看受控样例预览，或到系统配置中完成字段、权限和过程证据映射。"
                  />
                )}
                {dataMode === 'platform-adapter' && !projects.length && (
                  <Alert className="dashboard-scenario-scope-alert" type="warning" showIcon message="当前没有可选择的项目" description="请先完成项目同步或数据采集。" />
                )}
              </div>
            )}

            {step === 2 && (
              <div className="dashboard-scenario-wizard-step dashboard-scenario-wizard-step-readiness">
                {loading && !readiness ? (
                  <div className="dashboard-scenario-wizard-loading"><Spin tip="正在检查数据准备度" /></div>
                ) : readiness ? (
                  <>
                    <div className="dashboard-scenario-readiness-heading">
                      <div>
                        <Text type="secondary">{scenario.name} · {roleLabels[role]}</Text>
                        <Title level={4}>生成前准备度</Title>
                      </div>
                      {readinessTag(readiness.level)}
                    </div>
                    {readiness.blockers.length > 0 && (
                      <Alert
                        className="dashboard-scenario-readiness-blockers"
                        type="error"
                        showIcon
                        message="存在必须先处理的阻断项"
                        description={<List size="small" dataSource={readiness.blockers} renderItem={(item) => <List.Item>{item.message}</List.Item>} />}
                      />
                    )}
                    <Descriptions className="dashboard-scenario-readiness-summary" bordered size="small" column={{ xs: 1, sm: 2 }}>
                      <Descriptions.Item label="项目范围"><span className="dashboard-scenario-readiness-value">{readiness.projectIds.length ? readiness.projectIds.join('、') : '未限定'}</span></Descriptions.Item>
                      <Descriptions.Item label="字段画像"><span className="dashboard-scenario-readiness-value">{readiness.profiledFieldCount} 个字段</span></Descriptions.Item>
                      <Descriptions.Item label="缺少权限"><span className="dashboard-scenario-readiness-value">{readiness.missingPermissions.length ? readiness.missingPermissions.join('、') : '无'}</span></Descriptions.Item>
                      <Descriptions.Item label="缺少证据"><span className="dashboard-scenario-readiness-value">{readiness.missingEvidence.length ? `${readiness.missingEvidence.length} 项` : '无'}</span></Descriptions.Item>
                    </Descriptions>
                    <Card size="small" title="核心指标准备度" className="dashboard-scenario-readiness-card">
                      <List
                        size="small"
                        className="dashboard-scenario-readiness-list"
                        dataSource={readiness.metricStatuses}
                        renderItem={(metric, index) => {
                          const label = scenario.metrics[scenario.metrics.length - readiness.metricStatuses.length + index] ?? metric.metricId
                          const detail = metric.reason ?? metric.resolvedField ?? metric.metricId
                          const ok = metric.availability === 'ready'
                          const statusLabel = ok ? '已就绪' : metric.availability === 'missing' ? '缺失' : '需复核'
                          return (
                            <List.Item>
                              <List.Item.Meta
                                avatar={ok ? <CheckCircleOutlined className="dashboard-scenario-readiness-ok" /> : <ExclamationCircleOutlined className="dashboard-scenario-readiness-warn" />}
                                title={<span title={label}>{label}</span>}
                                description={<span title={detail}>{detail}</span>}
                              />
                              <Tag color={ok ? 'success' : metric.availability === 'missing' ? 'error' : 'warning'} aria-label={`${label}：${statusLabel}`}>
                                {statusLabel}
                              </Tag>
                            </List.Item>
                          )
                        }}
                      />
                    </Card>
                    {readiness.warnings.length > 0 && (
                      <Alert
                        className="dashboard-scenario-readiness-warning"
                        type="warning"
                        showIcon
                        message="生成说明"
                        description={<ul>{readiness.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
                      />
                    )}
                  </>
                ) : (
                  <Empty description="尚未执行准备度检查" />
                )}
              </div>
            )}

            {step === 3 && (
              <div className="dashboard-scenario-wizard-step dashboard-scenario-wizard-step-preview">
                <div className="dashboard-scenario-preview-head">
                  <div>
                    <Text type="secondary">将生成的业务驾驶舱</Text>
                    <Title level={4}>{scenario.name}</Title>
                    <Paragraph type="secondary">{scenario.description}</Paragraph>
                  </div>
                  {readiness && readinessTag(readiness.level)}
                </div>
                <Card size="small" title="预置组件方案" className="dashboard-scenario-component-plan">
                  <List
                    className="dashboard-scenario-component-plan-list"
                    grid={{ gutter: 12, column: 2 }}
                    dataSource={scenario.components}
                    renderItem={(component, index) => (
                      <List.Item>
                        <div className="dashboard-scenario-component-plan-item">
                          <span>{String(index + 1).padStart(2, '0')}</span>
                          <div>
                            <strong>{component}</strong>
                            <Text type="secondary">{index === 0 ? '指标摘要' : '公共基础组件'}</Text>
                          </div>
                        </div>
                      </List.Item>
                    )}
                  />
                </Card>
                <Alert
                  className="dashboard-scenario-preview-note"
                  type={dataMode === 'controlled-sample' ? 'warning' : 'info'}
                  showIcon
                  message={dataMode === 'controlled-sample' ? '这是受控样例预览' : '这是平台适配器数据预览'}
                  description="生成后会进入现有画布，可继续用 AI 修改、组件库和属性面板调整；正式保存仍受质量门禁控制。"
                />
                {generation?.status === 'ready' && generation.dashboard && (
                  <Alert
                    className="dashboard-scenario-preview-success"
                    type="success"
                    showIcon
                    message={`已生成 ${generation.dashboard.components.length} 个组件`}
                    description={generation.answer ?? '结果已回写到大屏工作台。'}
                  />
                )}
                {generation?.status === 'clarification' && (
                  <Alert
                    className="dashboard-scenario-preview-clarification"
                    type="warning"
                    showIcon
                    message="生成需要补充信息"
                    description={generationClarificationMessage(generation)}
                  />
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </Modal>
  )
}
