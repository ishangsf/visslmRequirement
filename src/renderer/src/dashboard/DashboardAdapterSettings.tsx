import {
  CheckCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlusOutlined,
  SaveOutlined,
  WarningOutlined
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Typography
} from 'antd'
import React, { useEffect, useMemo, useState } from 'react'
import type {
  AppSettings,
  DashboardDomainPlatformAdapterPreviewResult
} from '../../../shared/types'
import type { FieldProfile } from '../../../shared/query-spec'
import type {
  DashboardDomainAdapterMetricBinding,
  DashboardDomainAdapterQuestionBinding,
  DashboardDomainAdapterEvidenceBinding,
  DashboardDomainPlatformAdapter,
  DashboardEvidenceStatus
} from '../../../shared/dashboard-domain'

const { Text, Title } = Typography

type ScenarioMeta = {
  id: string
  name: string
  metricIds: string[]
  questionIds: string[]
  processBindingIds: string[]
}

/** Renderer-safe summary of the shared domain catalog used to build mappings. */
const scenarioCatalog: ScenarioMeta[] = [
  {
    id: 'project-overview', name: '项目综合态势',
    metricIds: ['project-health', 'milestone-achievement', 'requirement-completion', 'defect-density', 'high-risk-count', 'process-compliance'],
    questionIds: ['project-overview-health-question', 'project-overview-milestone-question', 'project-overview-requirement-question', 'project-overview-defect-question', 'project-overview-risk-question', 'project-overview-process-question'],
    processBindingIds: ['process.project-health', 'process.milestone-tracking', 'process.requirement-status', 'process.defect-classification', 'process.risk-register', 'process.baseline-evidence']
  },
  {
    id: 'requirements-delivery', name: '需求到交付全链路',
    metricIds: ['requirement-stability', 'requirement-review-completion', 'requirement-change-rate', 'development-completion', 'requirement-test-coverage', 'bidirectional-traceability'],
    questionIds: ['requirements-delivery-stability-question', 'requirements-delivery-review-question', 'requirements-delivery-change-question', 'requirements-delivery-development-question', 'requirements-delivery-test-question', 'requirements-delivery-trace-question'],
    processBindingIds: ['process.requirement-baseline-control', 'process.requirement-review', 'process.requirement-change-control', 'process.requirement-development', 'process.requirement-verification', 'process.bidirectional-traceability']
  },
  {
    id: 'plan-milestone', name: '计划与里程碑执行',
    metricIds: ['plan-completion-rate', 'schedule-variance-days', 'delayed-task-count', 'critical-path-risk-score', 'milestone-forecast-delay-days'],
    questionIds: ['plan-milestone-completion-question', 'plan-milestone-variance-question', 'plan-milestone-delayed-question', 'plan-milestone-critical-path-question', 'plan-milestone-forecast-question'],
    processBindingIds: ['process.plan-monitoring', 'process.schedule-variance-review', 'process.delayed-task-control', 'process.critical-path-review', 'process.milestone-forecast-review']
  },
  {
    id: 'software-quality', name: '软件质量与缺陷闭环',
    metricIds: ['critical-defect-count', 'defect-reopen-rate', 'defect-density', 'open-defect-count', 'mean-defect-repair-hours', 'residual-defect-risk-score'],
    questionIds: ['software-quality-critical-question', 'software-quality-reopen-question', 'software-quality-density-question', 'software-quality-trend-question', 'software-quality-repair-question', 'software-quality-residual-risk-question'],
    processBindingIds: ['process.severe-defect-review', 'process.defect-status-monitoring', 'process.defect-classification', 'process.defect-resolution', 'process.defect-closure-verification', 'process.release-defect-risk-review']
  },
  {
    id: 'test-validation', name: '测试与验证充分性',
    metricIds: ['test-case-execution-rate', 'test-pass-rate', 'requirement-test-coverage', 'code-coverage-rate', 'test-automation-rate', 'blocked-test-case-count'],
    questionIds: ['test-validation-execution-question', 'test-validation-pass-question', 'test-validation-requirement-coverage-question', 'test-validation-code-coverage-question', 'test-validation-automation-question', 'test-validation-blocked-question'],
    processBindingIds: ['process.test-execution-control', 'process.test-result-review', 'process.requirement-verification', 'process.code-coverage-review', 'process.test-automation-governance', 'process.blocked-test-case-control']
  },
  {
    id: 'configuration-change', name: '配置管理与变更控制',
    metricIds: ['configuration-item-control-rate', 'baseline-completeness-rate', 'change-approval-rate', 'open-change-count', 'reproducible-build-rate'],
    questionIds: ['configuration-change-item-control-question', 'configuration-change-baseline-question', 'configuration-change-approval-question', 'configuration-change-open-trend-question', 'configuration-change-reproducible-build-question'],
    processBindingIds: ['process.configuration-identification', 'process.configuration-baseline-audit', 'process.change-approval-control', 'process.change-status-monitoring', 'process.build-reproducibility-verification']
  },
  {
    id: 'gjb5000b-compliance', name: 'GJB5000B 过程符合度与证据审计',
    metricIds: ['process-activity-execution-rate', 'work-product-completeness-rate', 'evidence-sufficiency-rate', 'process-deviation-count', 'nonconformity-closure-rate'],
    questionIds: ['gjb5000b-compliance-activity-question', 'gjb5000b-compliance-work-product-question', 'gjb5000b-compliance-evidence-question', 'gjb5000b-compliance-deviation-question', 'gjb5000b-compliance-nonconformity-question'],
    processBindingIds: ['process.activity-execution-evidence', 'process.work-product-completeness-audit', 'process.evidence-sufficiency-review', 'process.deviation-control', 'process.nonconformity-closure-verification']
  },
  {
    id: 'organization-improvement', name: '组织级度量与过程改进',
    metricIds: ['project-quality-dispersion-score', 'estimation-deviation-rate', 'delivery-productivity-index', 'defect-escape-rate', 'process-improvement-completion-rate', 'organizational-baseline-stability-rate'],
    questionIds: ['organization-improvement-quality-dispersion-question', 'organization-improvement-estimation-question', 'organization-improvement-productivity-question', 'organization-improvement-defect-escape-question', 'organization-improvement-completion-question', 'organization-improvement-baseline-question'],
    processBindingIds: ['process.organization-measurement-analysis', 'process.estimation-baseline-review', 'process.productivity-baseline-analysis', 'process.defect-causal-analysis', 'process.improvement-action-closure', 'process.organizational-baseline-governance']
  }
]

const aggregations = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'] as const
const adapterPermissionOptions = [
  { value: 'project:read', label: '项目数据读取' },
  { value: 'process:evidence:read', label: '过程证据读取' }
]

const templateAdapter = (scenario: ScenarioMeta): DashboardDomainPlatformAdapter => ({
  schemaVersion: '1.0',
  id: `platform-${scenario.id}-v1`,
  scenarioId: scenario.id,
  sourceSystem: 'VISSLM lifecycle platform',
  allowedProjectIds: ['platform-project-alpha'],
  permissions: adapterPermissionOptions.map((option) => option.value),
  nodeTypes: ['ProjectStatusRecord'],
  tailoringBaselineId: `BL-${scenario.id.toUpperCase()}-V1`,
  metricBindings: scenario.metricIds.map((metricId) => ({
    metricId,
    field: metricId.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()),
    aggregation: 'avg'
  })),
  questionBindings: scenario.questionIds.map((questionId) => ({ questionId, dimensionFields: [] })),
  evidenceBindings: scenario.processBindingIds.map((processBindingId) => ({
    processBindingId,
    evidenceStatus: 'insufficient',
    sourceKey: `platform.${scenario.id}.${processBindingId.replace(/^process\./, '')}`
  })),
  updatedAt: new Date().toISOString()
})

const cloneAdapter = (adapter: DashboardDomainPlatformAdapter): DashboardDomainPlatformAdapter => ({
  ...adapter,
  allowedProjectIds: [...adapter.allowedProjectIds],
  permissions: [...adapter.permissions],
  nodeTypes: [...adapter.nodeTypes],
  metricBindings: adapter.metricBindings.map((binding) => ({ ...binding })),
  questionBindings: adapter.questionBindings.map((binding) => ({ ...binding, dimensionFields: [...binding.dimensionFields] })),
  evidenceBindings: adapter.evidenceBindings.map((binding) => ({ ...binding }))
})

const scenarioFor = (id: string): ScenarioMeta => scenarioCatalog.find((item) => item.id === id) ?? scenarioCatalog[0]

export function DashboardAdapterSettings({
  settings,
  onChanged
}: {
  settings: AppSettings | null
  onChanged: (settings: AppSettings) => void
}): React.JSX.Element {
  const { message } = AntApp.useApp()
  const adapters = settings?.dashboardDomainPlatformAdapters ?? []
  const [selectedId, setSelectedId] = useState<string | null>(adapters[0]?.id ?? null)
  const [draft, setDraft] = useState<DashboardDomainPlatformAdapter | null>(null)
  const [projectId, setProjectId] = useState('')
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<DashboardDomainPlatformAdapterPreviewResult | null>(null)
  const [fieldProfiles, setFieldProfiles] = useState<FieldProfile[]>([])
  const [fieldLoading, setFieldLoading] = useState(false)
  const [fieldError, setFieldError] = useState('')

  useEffect(() => {
    if (draft || selectedId || adapters.length === 0) return
    setSelectedId(adapters[0].id)
  }, [adapters, draft, selectedId])

  const selectedAdapter = useMemo(() => {
    if (draft) return draft
    const found = adapters.find((adapter) => adapter.id === selectedId)
    return found ? cloneAdapter(found) : null
  }, [adapters, draft, selectedId])
  const scenario = selectedAdapter ? scenarioFor(selectedAdapter.scenarioId) : null

  const refreshFieldProfiles = async (): Promise<void> => {
    if (!selectedAdapter) return
    setFieldLoading(true)
    setFieldError('')
    try {
      const profiles = await window.visslm.listFieldProfiles({
        ...(projectId.trim() ? { projectIds: [projectId.trim()] } : {}),
        nodeTypes: [...selectedAdapter.nodeTypes]
      })
      setFieldProfiles(profiles)
    } catch (error) {
      setFieldProfiles([])
      setFieldError(error instanceof Error ? error.message : String(error))
    } finally {
      setFieldLoading(false)
    }
  }

  React.useEffect(() => {
    if (!selectedAdapter) {
      setFieldProfiles([])
      return
    }
    void refreshFieldProfiles()
    // Refresh only when the selected adapter's source scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAdapter?.id, selectedAdapter?.nodeTypes.join(',')])

  const numericFieldOptions = fieldProfiles
    .filter((profile) => profile.inferredType === 'number' && profile.sensitivity !== 'sensitive')
    .map((profile) => ({ value: profile.field, label: `${profile.displayName ?? profile.field} · 数值` }))
  const dimensionFieldOptions = fieldProfiles
    .filter((profile) => profile.sensitivity !== 'sensitive')
    .map((profile) => ({ value: profile.field, label: `${profile.displayName ?? profile.field} · ${profile.inferredType}` }))

  const selectAdapter = (adapter: DashboardDomainPlatformAdapter): void => {
    setSelectedId(adapter.id)
    setDraft(cloneAdapter(adapter))
    setPreview(null)
  }

  const updateDraft = (patch: Partial<DashboardDomainPlatformAdapter>): void => {
    if (!selectedAdapter) return
    setDraft({ ...selectedAdapter, ...patch, updatedAt: new Date().toISOString() })
    setPreview(null)
  }

  const createAdapter = (): void => {
    const next = templateAdapter(scenarioCatalog[0])
    setSelectedId(next.id)
    setDraft(next)
    setPreview(null)
  }

  const changeScenario = (scenarioId: string): void => {
    const nextScenario = scenarioFor(scenarioId)
    const next = templateAdapter(nextScenario)
    updateDraft({
      scenarioId: next.scenarioId,
      metricBindings: next.metricBindings,
      questionBindings: next.questionBindings,
      evidenceBindings: next.evidenceBindings
    })
  }

  const save = async (): Promise<void> => {
    if (!selectedAdapter) return
    setSaving(true)
    try {
      const result = await window.visslm.saveDashboardDomainPlatformAdapters({
        adapters: [...adapters.filter((adapter) => adapter.id !== selectedAdapter.id), selectedAdapter]
      })
      onChanged(result)
      setSelectedId(selectedAdapter.id)
      setDraft(cloneAdapter(selectedAdapter))
      message.success('平台适配器已保存')
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!selectedAdapter) return
    setSaving(true)
    try {
      const result = await window.visslm.saveDashboardDomainPlatformAdapters({
        adapters: adapters.filter((adapter) => adapter.id !== selectedAdapter.id)
      })
      onChanged(result)
      const next = result.dashboardDomainPlatformAdapters[0]
      setSelectedId(next?.id ?? null)
      setDraft(next ? cloneAdapter(next) : null)
      setPreview(null)
      message.success('平台适配器已删除')
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    if (!selectedAdapter || !projectId.trim()) {
      message.warning('请先填写项目范围 ID')
      return
    }
    setPreviewing(true)
    try {
      const result = await window.visslm.previewDashboardDomainPlatformAdapter({
        adapter: selectedAdapter,
        projectId: projectId.trim()
      })
      setPreview(result)
      if (result.ok) message.success('平台数据预览生成成功')
      else message.warning(result.reason ?? '平台数据预览未通过')
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPreviewing(false)
    }
  }

  const updateMetric = (index: number, patch: Partial<DashboardDomainAdapterMetricBinding>): void => {
    if (!selectedAdapter) return
    const metricBindings = selectedAdapter.metricBindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...patch } : binding)
    updateDraft({ metricBindings })
  }

  const updateQuestion = (index: number, patch: Partial<DashboardDomainAdapterQuestionBinding>): void => {
    if (!selectedAdapter) return
    const questionBindings = selectedAdapter.questionBindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...patch } : binding)
    updateDraft({ questionBindings })
  }

  const updateEvidence = (index: number, patch: Partial<DashboardDomainAdapterEvidenceBinding>): void => {
    if (!selectedAdapter) return
    const evidenceBindings = selectedAdapter.evidenceBindings.map((binding, itemIndex) => itemIndex === index ? { ...binding, ...patch } : binding)
    updateDraft({ evidenceBindings })
  }

  return (
    <div className="settings-panel dashboard-adapter-settings">
      <div className="settings-panel-heading">
        <div className="settings-panel-heading-copy">
          <Title level={4}>数据适配器与指标映射</Title>
          <Text type="secondary">把 VISSLM / GJB5000B 平台字段映射到黄金场景；配置通过 fail-closed 校验后才会被 AI 大屏使用。</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={createAdapter}>新增适配器</Button>
      </div>
      {settings?.dashboardDomainPlatformAdapterErrors.length ? (
        <Alert type="error" showIcon icon={<WarningOutlined />} message="检测到无效的平台适配器配置" description={settings.dashboardDomainPlatformAdapterErrors.join('；')} />
      ) : null}
      <div className="dashboard-adapter-layout">
        <Card size="small" className="dashboard-adapter-list-card" title="已配置适配器">
          {adapters.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未配置平台适配器" /> : (
            <div className="dashboard-adapter-list">
              {adapters.map((adapter) => {
                const active = adapter.id === selectedAdapter?.id
                return (
                  <button key={adapter.id} type="button" className={`dashboard-adapter-list-item${active ? ' is-active' : ''}`} onClick={() => selectAdapter(adapter)}>
                    <span className="dashboard-adapter-list-item-title">{scenarioFor(adapter.scenarioId).name}</span>
                    <span className="dashboard-adapter-list-item-meta">{adapter.sourceSystem} · {adapter.id}</span>
                    <span className="dashboard-adapter-list-item-meta">项目：{adapter.allowedProjectIds.join(', ') || '未授权'} · 权限：{adapter.permissions.join(', ') || '未声明'}</span>
                    <Tag color={adapter.nodeTypes.some((nodeType) => /sample/i.test(nodeType)) ? 'error' : 'success'}>{adapter.nodeTypes.join(', ') || '未设置节点类型'}</Tag>
                  </button>
                )
              })}
            </div>
          )}
        </Card>
        {selectedAdapter && scenario ? (
          <Card size="small" className="dashboard-adapter-editor-card" title={`${scenario.name} · 映射编辑`}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <div className="dashboard-adapter-form-grid">
                <label>适配器 ID<Input value={selectedAdapter.id} onChange={(event) => updateDraft({ id: event.target.value })} /></label>
                <label>来源系统<Input value={selectedAdapter.sourceSystem} onChange={(event) => updateDraft({ sourceSystem: event.target.value })} /></label>
                <label>裁剪基线<Input value={selectedAdapter.tailoringBaselineId} onChange={(event) => updateDraft({ tailoringBaselineId: event.target.value })} /></label>
                <label>节点类型（逗号分隔）<Input value={selectedAdapter.nodeTypes.join(', ')} onChange={(event) => updateDraft({ nodeTypes: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
                <label>允许项目 ID（逗号分隔）<Input value={selectedAdapter.allowedProjectIds.join(', ')} onChange={(event) => updateDraft({ allowedProjectIds: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} placeholder="例如 platform-project-alpha" /></label>
                <label>权限范围<Select mode="multiple" value={[...selectedAdapter.permissions]} options={adapterPermissionOptions} onChange={(permissions) => updateDraft({ permissions })} placeholder="选择适配器可用权限" /></label>
                <label className="dashboard-adapter-form-wide">黄金场景<Select value={selectedAdapter.scenarioId} options={scenarioCatalog.map((item) => ({ value: item.id, label: item.name }))} onChange={changeScenario} /></label>
              </div>
              <Alert type="info" showIcon message="字段只接受已同步到本地分析索引的非敏感字段；平台密码和 Token 不属于适配器配置。" />
              <div className="dashboard-adapter-field-catalog-toolbar">
                <div>
                  <Text strong>字段目录</Text>
                  <Text type="secondary">{fieldProfiles.length ? `已发现 ${fieldProfiles.length} 个字段` : '尚未读取字段目录'}</Text>
                </div>
                <Button size="small" loading={fieldLoading} onClick={() => void refreshFieldProfiles()}>刷新字段目录</Button>
              </div>
              {fieldError ? <Alert type="warning" showIcon message="字段目录读取失败" description={fieldError} /> : null}
              {fieldProfiles.length ? (
                <div className="dashboard-adapter-field-profile-list" aria-label="字段类型和敏感性摘要">
                  {fieldProfiles.slice(0, 24).map((profile) => <Tag key={profile.field} color={profile.sensitivity === 'sensitive' ? 'error' : profile.inferredType === 'number' ? 'processing' : 'default'}>{profile.displayName ?? profile.field} · {profile.inferredType} · {profile.sensitivity}</Tag>)}
                </div>
              ) : null}
              <Divider titlePlacement="start">指标字段映射</Divider>
              <div className="dashboard-adapter-binding-list">
                {scenario.metricIds.map((metricId, index) => {
                  const binding = selectedAdapter.metricBindings[index] ?? { metricId, field: '', aggregation: 'avg' as const }
                  const fieldOptions = binding.field && !numericFieldOptions.some((option) => option.value === binding.field)
                    ? [{ value: binding.field, label: `${binding.field} · 当前映射未在目录中` }, ...numericFieldOptions]
                    : numericFieldOptions
                  return <div className="dashboard-adapter-binding-row" key={metricId}><Text code>{metricId}</Text><Select showSearch optionFilterProp="label" aria-label={`${metricId} 字段`} value={binding.field || undefined} options={fieldOptions} placeholder={fieldLoading ? '正在读取字段目录…' : '选择数值字段'} onChange={(field) => updateMetric(index, { metricId, field })} /><Select aria-label={`${metricId} 聚合`} value={binding.aggregation} options={aggregations.map((value) => ({ value, label: value }))} onChange={(aggregation) => updateMetric(index, { metricId, aggregation })} /></div>
                })}
              </div>
              <Divider titlePlacement="start">问题维度映射</Divider>
              <div className="dashboard-adapter-binding-list">
                {scenario.questionIds.map((questionId, index) => {
                  const binding = selectedAdapter.questionBindings[index] ?? { questionId, dimensionFields: [] }
                  const dimensionOptions = binding.dimensionFields
                    .filter((field) => !dimensionFieldOptions.some((option) => option.value === field))
                    .map((field) => ({ value: field, label: `${field} · 当前映射未在目录中` }))
                    .concat(dimensionFieldOptions)
                  return <div className="dashboard-adapter-binding-row dashboard-adapter-dimension-row" key={questionId}><Text code>{questionId}</Text><Select mode="multiple" showSearch optionFilterProp="label" aria-label={`${questionId} 维度`} value={[...binding.dimensionFields]} options={dimensionOptions} placeholder={fieldLoading ? '正在读取字段目录…' : '选择维度字段（可多选）'} onChange={(dimensionFields) => updateQuestion(index, { questionId, dimensionFields })} /></div>
                })}
              </div>
              <Divider titlePlacement="start">过程证据状态</Divider>
              <div className="dashboard-adapter-binding-list">
                {scenario.processBindingIds.map((processBindingId, index) => {
                  const binding = selectedAdapter.evidenceBindings[index] ?? { processBindingId, evidenceStatus: 'insufficient' as DashboardEvidenceStatus, sourceKey: '' }
                  return <div className="dashboard-adapter-binding-row" key={processBindingId}><Text code>{processBindingId}</Text><Select aria-label={`${processBindingId} 状态`} value={binding.evidenceStatus} options={(['missing', 'insufficient', 'sufficient'] as DashboardEvidenceStatus[]).map((value) => ({ value, label: value }))} onChange={(evidenceStatus) => updateEvidence(index, { processBindingId, evidenceStatus })} /><Input aria-label={`${processBindingId} 来源`} value={binding.sourceKey} placeholder="平台证据来源 key" onChange={(event) => updateEvidence(index, { processBindingId, sourceKey: event.target.value })} /></div>
                })}
              </div>
              <div className="dashboard-adapter-actions">
                <Space wrap>
                  <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>保存适配器</Button>
                  <Button icon={<EyeOutlined />} loading={previewing} onClick={() => void runPreview()}>试运行预览</Button>
                  <Button danger icon={<DeleteOutlined />} loading={saving} onClick={() => void remove()}>删除</Button>
                </Space>
                <label className="dashboard-adapter-project-input">项目范围 ID<Input value={projectId} onChange={(event) => setProjectId(event.target.value)} placeholder="例如 project-alpha" /></label>
              </div>
              {preview ? (
                <Alert
                  type={preview.ok ? 'success' : 'warning'}
                  showIcon
                  icon={preview.ok ? <CheckCircleOutlined /> : <WarningOutlined />}
                  message={preview.ok ? `${preview.title} · ${preview.componentCount ?? 0} 个组件` : '平台数据预览未通过'}
                  description={preview.ok ? (
                    <div className="dashboard-adapter-preview-summary"><div>{preview.subtitle}</div><div>适配器：{preview.adapterId} · 置信度：{preview.receipt?.confidence ?? 0}</div><div>证据缺失 {preview.receipt?.evidenceMissing?.length ?? 0} 项，不足 {preview.receipt?.evidenceInsufficient?.length ?? 0} 项</div></div>
                  ) : preview.reason}
                />
              ) : null}
            </Space>
          </Card>
        ) : (
          <Card size="small" className="dashboard-adapter-editor-card"><Empty description="选择一个适配器开始配置" /></Card>
        )}
      </div>
    </div>
  )
}

export default DashboardAdapterSettings
