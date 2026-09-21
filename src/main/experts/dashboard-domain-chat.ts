import type { DashboardDomainReceipt } from '../../shared/dashboard'
import type { DataScope } from '../../shared/query-spec'
import type { QueryEngine } from '../analytics/query-engine'
import {
  generateDashboardDomainArtifact,
  type DashboardDomainGenerationResult
} from './dashboard-domain-generation'
import {
  resolveDashboardDomainRequest,
  type DashboardDomainRequestResult
} from './dashboard-domain-request'
import type {
  DashboardDomainPlatformAdapter,
  DashboardDomainRole,
  DashboardScenarioStatus
} from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'
import { validateDashboardDomainAdapterAccess } from './dashboard-domain-adapter'
import type { DashboardDomainPlanClarificationReason } from './dashboard-domain-planner'

export interface DashboardDomainChatInput {
  question: string
  scope: DataScope
  generatedAt: string
  /** Caller capabilities; intersected with the selected adapter capabilities. */
  permissions?: readonly string[]
  platformAdapter?: DashboardDomainPlatformAdapter
  platformAdapters?: readonly DashboardDomainPlatformAdapter[]
  platformAdapterConfigurationErrors?: readonly string[]
}

export type DashboardDomainChatClarificationReason =
  | DashboardDomainPlanClarificationReason
  | 'scenario-not-active'

export interface AssistantClarificationOption {
  id: string
  label: string
  prompt: string
  action: 'submit' | 'compose'
  recommended?: boolean
}

export interface DashboardDomainChatResult {
  recognized: boolean
  status: 'ready' | 'clarification' | 'rejected'
  answer?: string
  needsClarification?: boolean
  reason?: string
  scenario?: string
  dashboard?: DashboardDomainGenerationResult['dashboard']
  receipt?: DashboardDomainReceipt
  clarificationOptions?: readonly AssistantClarificationOption[]
}

const roleLabels: Record<DashboardDomainRole, string> = {
  'project-owner': '项目负责人',
  'qa-epg': '质量与过程负责人',
  'rd-lead': '研发负责人',
  'model-org-manager': '型号/组织管理负责人'
}

const scenarioName = (scenarioId: string | undefined): string =>
  dashboardDomainCatalog.scenarios.find((scenario) => scenario.id === scenarioId)?.name ?? '项目综合态势'

const roleFromOptionId = (optionId: string): DashboardDomainRole | undefined => {
  const roleId = optionId.replace(/^role-/, '')
  const roleMap: Record<string, DashboardDomainRole> = {
    'project-owner': 'project-owner',
    'qa-epg': 'qa-epg',
    'rd-lead': 'rd-lead',
    'model-org-manager': 'model-org-manager'
  }
  return roleMap[roleId]
}

const businessPrompt = (
  role: DashboardDomainRole,
  scenario: string,
  includeControlledSample = true
): string => {
  const samplePhrase = includeControlledSample ? '基于受控样例' : ''
  return `${roleLabels[role]}${samplePhrase}生成${scenarioName(scenario)}大屏`
}

const safeReasonLabel = (reason: DashboardDomainChatClarificationReason): string => {
  const labels: Record<DashboardDomainChatClarificationReason, string> = {
    'missing-role': '还需要确认使用角色',
    'missing-project-scope': '还需要确认项目范围',
    'metric-definition-conflict': '指标定义存在冲突，需要确认采用口径',
    'missing-metric-source': '当前数据尚不足以计算所需指标',
    'missing-tailoring-baseline': '还需要确认受控裁剪基线',
    'insufficient-permission': '还需要确认项目与过程证据读取授权',
    'invalid-data-quality': '当前数据质量需要先刷新或核验',
    'role-not-applicable': '当前角色不适用于该领域场景',
    'scenario-not-active': '该领域场景尚未启用'
  }
  return labels[reason]
}

const promptForPlannerOption = (input: {
  reason: DashboardDomainChatClarificationReason
  optionId: string
  optionLabel: string
  role?: DashboardDomainRole
  scenario: string
}): { prompt: string; action: 'submit' | 'compose' } => {
  const { reason, optionId, optionLabel, role, scenario } = input
  const name = scenarioName(scenario)

  if (reason === 'missing-role') {
    const selectedRole = roleFromOptionId(optionId)
    return {
      prompt: selectedRole
        ? businessPrompt(selectedRole, scenario)
        : `请确认${optionLabel}后，基于受控样例生成${name}大屏`,
      action: 'submit'
    }
  }

  if (reason === 'role-not-applicable') {
    const selectedRole = roleFromOptionId(optionId)
    return {
      prompt: selectedRole
        ? businessPrompt(selectedRole, scenario)
        : `请确认${optionLabel}后，基于受控样例生成${name}大屏`,
      action: 'submit'
    }
  }

  if (reason === 'missing-tailoring-baseline') {
    if (optionId === 'provide-tailoring-baseline' && role) {
      return { prompt: businessPrompt(role, scenario), action: 'submit' }
    }
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return {
      prompt: `请查看受控样例裁剪基线后，再确认生成${name}大屏`,
      action: 'compose'
    }
  }

  if (reason === 'missing-project-scope') {
    if (/portfolio|组合|scope-portfolio/.test(optionId + optionLabel)) {
      return { prompt: `请选择项目组合后，生成${name}大屏`, action: 'compose' }
    }
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return { prompt: `请选择项目后，生成${name}大屏`, action: 'compose' }
  }

  if (reason === 'missing-metric-source') {
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return { prompt: `请补充${name}所需的数据来源后，重新生成大屏`, action: 'compose' }
  }

  if (reason === 'insufficient-permission') {
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return { prompt: `请确认项目与过程证据读取授权后，重新生成${name}大屏`, action: 'compose' }
  }

  if (reason === 'invalid-data-quality') {
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return { prompt: `请刷新并核验项目数据质量后，重新生成${name}大屏`, action: 'compose' }
  }

  if (reason === 'metric-definition-conflict') {
    if (/cancel|暂不/.test(optionId + optionLabel)) {
      return { prompt: `暂不生成${name}大屏`, action: 'submit' }
    }
    return { prompt: `请确认${optionLabel}后，重新生成${name}大屏`, action: 'compose' }
  }

  return { prompt: `请确认${optionLabel}后，再处理${name}大屏请求`, action: 'compose' }
}

const clarificationOptionsFromGeneration = (
  generation: DashboardDomainGenerationResult,
  request: DashboardDomainRequestResult
): readonly AssistantClarificationOption[] => {
  const reason = (generation.reason ?? generation.clarification?.reason) as
    | DashboardDomainChatClarificationReason
    | undefined
  if (!reason) return []
  const scenario = generation.scenario ?? request.scenario ?? 'project-overview'
  const plannerOptions = generation.clarification?.options ?? []
  return plannerOptions.slice(0, 3).map((option) => {
    const prompt = promptForPlannerOption({
      reason,
      optionId: option.id,
      optionLabel: option.label,
      role: request.role,
      scenario
    })
    return {
      id: option.id,
      label: option.label,
      prompt: prompt.prompt,
      action: prompt.action,
      recommended: option.recommended
    }
  })
}

const plannedScenarioOptions = (
  request: DashboardDomainRequestResult
): readonly AssistantClarificationOption[] => {
  const scenario = request.scenario ?? 'project-overview'
  const name = scenarioName(scenario)
  const fallbackRole = request.role ?? 'project-owner'
  return [
    {
      id: 'wait-for-scenario-activation',
      label: `等待${name}启用`,
      prompt: `保留${name}需求，待该场景启用后再生成`,
      action: 'submit',
      recommended: true
    },
    {
      id: 'use-active-project-overview',
      label: '改用项目综合态势预览',
      prompt: businessPrompt(fallbackRole, 'project-overview'),
      action: 'compose',
      recommended: false
    }
  ]
}

const clarificationResult = (
  request: DashboardDomainRequestResult,
  generation: DashboardDomainGenerationResult
): DashboardDomainChatResult => {
  const reason = (generation.reason ?? generation.clarification?.reason) as
    | DashboardDomainChatClarificationReason
    | undefined
  const safeReason = reason ?? 'missing-metric-source'
  return {
    recognized: true,
    status: 'clarification',
    needsClarification: true,
    reason: safeReason,
    scenario: generation.scenario ?? request.scenario,
    answer: `${safeReasonLabel(safeReason)}，请从下面的业务选项中选择。`,
    clarificationOptions: clarificationOptionsFromGeneration(generation, request)
  }
}

const normalizeReceipt = (
  receipt: DashboardDomainReceipt | undefined
): DashboardDomainReceipt => ({
  adoptedMetricIds: receipt?.adoptedMetricIds ?? [],
  missingMetricIds: receipt?.missingMetricIds ?? [],
  evidenceMissing: receipt?.evidenceMissing ?? [],
  evidenceInsufficient: receipt?.evidenceInsufficient ?? [],
  confidence: typeof receipt?.confidence === 'number' ? receipt.confidence : 0,
  warnings: receipt?.warnings ?? [],
  confirmations: receipt?.confirmations ?? [],
  vetoCodes: receipt?.vetoCodes ?? []
})

const readyResult = (
  request: DashboardDomainRequestResult,
  generation: DashboardDomainGenerationResult
): DashboardDomainChatResult => {
  const dashboard = generation.dashboard
  if (!dashboard) {
    return {
      recognized: true,
      status: 'rejected',
      reason: 'missing-dashboard',
      scenario: generation.scenario ?? request.scenario
    }
  }
  const receipt = normalizeReceipt(generation.receipt ?? dashboard.domainReceipt)
  const name = scenarioName(generation.scenario ?? request.scenario)
  const platformMode = generation.dataMode === 'platform-adapter'
  return {
    recognized: true,
    status: 'ready',
    needsClarification: false,
    answer: platformMode
      ? `已生成 ${name} 平台数据预览：使用适配器 ${generation.adapterId ?? 'unknown'} 映射 ${generation.sourceSystem ?? '平台'} 数据，并由受控 QuerySpec 在本地计算；正式发布前仍需复核字段口径和过程证据。`
      : `已生成 ${name} 受控样例预览：组件使用受控 QuerySpec 查询，数据由本地计算得出；当前仅供预览，待真实数据适配与证据核验后再评估正式使用。`,
    scenario: generation.scenario ?? request.scenario,
    dashboard,
    receipt
  }
}

/**
 * Run the host-only domain chat path. Request recognition precedes any
 * profiling. Planned scenarios are surfaced as clarification and never
 * silently routed to the active project-overview scenario.
 */
export const runDashboardDomainChatRequest = async (
  input: DashboardDomainChatInput,
  queryEngine: QueryEngine
): Promise<DashboardDomainChatResult> => {
  const request = resolveDashboardDomainRequest(input.question, input.scope)

  if (!request.recognized) {
    return {
      recognized: false,
      status: 'clarification',
      needsClarification: false,
      answer: '该请求不属于受控领域大屏，将继续交由通用可视化链路处理。'
    }
  }

  if (input.platformAdapterConfigurationErrors?.length) {
    return {
      recognized: true,
      status: 'rejected',
      reason: 'invalid-platform-adapter-configuration',
      scenario: request.scenario,
      answer: `平台适配器配置无效：${input.platformAdapterConfigurationErrors.join('；')}`
    }
  }

  if (request.scenarioStatus === 'planned') {
    const scenario = request.scenario ?? 'project-overview'
    return {
      recognized: true,
      status: 'clarification',
      needsClarification: true,
      reason: 'scenario-not-active',
      scenario,
      answer: `${scenarioName(scenario)}当前尚未启用，暂不生成领域大屏。`,
      clarificationOptions: plannedScenarioOptions(request)
    }
  }

  const platformAdapter = input.platformAdapter ?? (!request.tailoringBaselineId
    ? input.platformAdapters?.find((adapter) => adapter.scenarioId === request.scenario)
    : undefined)
  const requestedPermissions = input.permissions ?? request.permissions
  const adapterAccess = platformAdapter
    ? validateDashboardDomainAdapterAccess(request.scope, requestedPermissions, platformAdapter)
    : undefined
  if (adapterAccess && !adapterAccess.ok) {
    if (adapterAccess.reason === 'insufficient-permission') {
      return {
        recognized: true,
        status: 'clarification',
        needsClarification: true,
        reason: 'insufficient-permission',
        scenario: request.scenario,
        answer: `${adapterAccess.message}，请补充授权后再生成大屏。`,
        clarificationOptions: [
          {
            id: 'confirm-platform-permissions',
            label: '确认平台读取授权',
            prompt: `请确认项目与过程证据读取授权后，重新生成${scenarioName(request.scenario)}大屏`,
            action: 'compose',
            recommended: true
          },
          {
            id: 'cancel-platform-permission-request',
            label: '暂不生成',
            prompt: `暂不生成${scenarioName(request.scenario)}大屏`,
            action: 'submit'
          }
        ]
      }
    }
    return {
      recognized: true,
      status: 'rejected',
      reason: adapterAccess.reason,
      scenario: request.scenario,
      answer: `${adapterAccess.message}，未执行平台数据查询。`
    }
  }
  const generation = await generateDashboardDomainArtifact({
    request: request.request,
    scope: adapterAccess?.ok ? adapterAccess.scope : request.scope,
    role: request.role,
    scenario: request.scenario,
    tailoringBaselineId: request.tailoringBaselineId,
    permissions: adapterAccess?.ok ? adapterAccess.permissions : requestedPermissions,
    generatedAt: input.generatedAt,
    platformAdapter
  }, queryEngine)

  if (generation.status === 'ready') return readyResult(request, generation)
  if (generation.status === 'clarification') return clarificationResult(request, generation)

  return {
    recognized: true,
    status: 'rejected',
    reason: generation.reason,
    scenario: generation.scenario ?? request.scenario,
    receipt: generation.receipt
  }
}

export default runDashboardDomainChatRequest
