import type { DashboardDomainRole } from '../../shared/dashboard-domain'
import {
  dashboardDomainCatalog
} from './dashboard-domain-catalog'

export interface DashboardDomainPlanInput {
  request: string
  /** Role must be supplied by the caller; the planner never infers it from request text. */
  role?: DashboardDomainRole
  scenario?: string
  projectIds?: readonly string[]
  tailoringBaselineId?: string
  permissions?: readonly string[]
  availableMetricIds?: readonly string[]
  dataQuality?: 'reliable' | 'invalid'
  metricConflicts?: readonly string[]
}

export type DashboardDomainPlanClarificationReason =
  | 'missing-role'
  | 'missing-project-scope'
  | 'metric-definition-conflict'
  | 'missing-metric-source'
  | 'missing-tailoring-baseline'
  | 'insufficient-permission'
  | 'invalid-data-quality'
  | 'role-not-applicable'
  | 'scenario-not-active'

export interface DashboardDomainPlanClarificationOption {
  id: string
  label: string
  recommended: boolean
}

export interface DashboardDomainPlanClarification {
  reason: DashboardDomainPlanClarificationReason
  options: readonly DashboardDomainPlanClarificationOption[]
}

export interface DashboardDomainPlan {
  status: 'ready' | 'clarification'
  role?: DashboardDomainRole
  scenario: string
  metricIds: readonly string[]
  processBindingIds: readonly string[]
  reason?: DashboardDomainPlanClarificationReason
  clarification?: DashboardDomainPlanClarification
  catalogVersion: '1.0'
}

const activeScenario = (requestedScenario?: string) => {
  const requested = requestedScenario?.trim()
  const selected = requested
    ? dashboardDomainCatalog.scenarios.find((scenario) =>
      scenario.id === requested && scenario.status === 'active'
    )
    : undefined
  return selected ?? dashboardDomainCatalog.scenarios.find((scenario) => scenario.status === 'active')
}

const selectedScenario = activeScenario()
if (!selectedScenario) {
  throw new Error('领域目录没有可用的 active 场景')
}

const metricIdsForScenario = (scenarioId: string): readonly string[] => {
  const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === scenarioId)
  if (!scenario) return []
  const catalogMetricIds = new Set(dashboardDomainCatalog.metrics.map((metric) => metric.id))
  return scenario.metricIds.filter((metricId) => catalogMetricIds.has(metricId))
}

const processBindingIdsForMetrics = (metricIds: readonly string[]): readonly string[] => {
  const metricSet = new Set(metricIds)
  const selected = dashboardDomainCatalog.processBindings
    .filter((binding) => binding.metricIds.some((metricId) => metricSet.has(metricId)))
  const selectedIds = new Set(selected.map((binding) => binding.id))
  // Preserve the metric order and keep every returned ID inside the catalog.
  return metricIds.flatMap((metricId) => selected
    .filter((binding) => binding.metricIds.includes(metricId) && selectedIds.has(binding.id))
    .map((binding) => binding.id)
  ).filter((id, index, all) => all.indexOf(id) === index)
}

const clarificationOptions: Record<
  DashboardDomainPlanClarificationReason,
  readonly DashboardDomainPlanClarificationOption[]
> = {
  'missing-role': [
    { id: 'role-project-owner', label: '项目负责人', recommended: true },
    { id: 'role-qa-epg', label: '质量与过程负责人', recommended: false },
    { id: 'role-rd-lead', label: '研发负责人', recommended: false }
  ],
  'missing-project-scope': [
    { id: 'scope-project', label: '选择一个项目', recommended: true },
    { id: 'scope-portfolio', label: '选择项目组合', recommended: false },
    { id: 'scope-cancel', label: '暂不生成', recommended: false }
  ],
  'metric-definition-conflict': [
    { id: 'use-catalog-definition', label: '采用目录定义', recommended: true },
    { id: 'review-definition', label: '查看冲突定义', recommended: false },
    { id: 'cancel-conflict', label: '暂不生成', recommended: false }
  ],
  'missing-metric-source': [
    { id: 'connect-metric-source', label: '补充指标来源', recommended: true },
    { id: 'choose-available-metrics', label: '仅选择可用指标', recommended: false },
    { id: 'cancel-missing-source', label: '暂不生成', recommended: false }
  ],
  'missing-tailoring-baseline': [
    { id: 'provide-tailoring-baseline', label: '选择裁剪基线', recommended: true },
    { id: 'review-baseline-options', label: '查看基线选项', recommended: false },
    { id: 'cancel-baseline', label: '暂不生成', recommended: false }
  ],
  'insufficient-permission': [
    { id: 'request-read-permission', label: '申请读取权限', recommended: true },
    { id: 'limit-authorized-scope', label: '缩小授权范围', recommended: false },
    { id: 'cancel-permission', label: '暂不生成', recommended: false }
  ],
  'invalid-data-quality': [
    { id: 'refresh-data-quality', label: '刷新数据质量', recommended: true },
    { id: 'inspect-quality-issues', label: '查看质量问题', recommended: false },
    { id: 'cancel-quality', label: '暂不生成', recommended: false }
  ],
  'role-not-applicable': [
    { id: 'role-project-owner', label: '改用项目负责人视角', recommended: true },
    { id: 'role-qa-epg', label: '改用质量与过程负责人视角', recommended: false },
    { id: 'role-rd-lead', label: '改用研发负责人视角', recommended: false }
  ],
  'scenario-not-active': [
    { id: 'wait-for-scenario-activation', label: '等待场景启用', recommended: true },
    { id: 'use-active-project-overview', label: '改用当前可用的项目综合态势', recommended: false },
    { id: 'cancel-inactive-scenario', label: '暂不生成', recommended: false }
  ]
}

const makeClarification = (
  reason: DashboardDomainPlanClarificationReason
): DashboardDomainPlanClarification => ({
  reason,
  options: clarificationOptions[reason]
})

const normalizedNonEmpty = (values: readonly string[] | undefined): string[] =>
  [...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))]

const roleIsCatalogRole = (role: unknown): role is DashboardDomainRole =>
  typeof role === 'string' &&
  dashboardDomainCatalog.roles.includes(role as DashboardDomainRole)

const clarificationPlan = (
  scenario: string,
  metricIds: readonly string[],
  processBindingIds: readonly string[],
  reason: DashboardDomainPlanClarificationReason,
  role?: DashboardDomainRole
): DashboardDomainPlan => ({
  status: 'clarification',
  ...(role ? { role } : {}),
  scenario,
  metricIds,
  processBindingIds,
  reason,
  clarification: makeClarification(reason),
  catalogVersion: dashboardDomainCatalog.version
})

/**
 * Resolve a domain plan only. This stage never emits QuerySpec, SQL,
 * JavaScript, records or component data; composition remains a later stage.
 */
export const resolveDashboardDomainPlan = (
  input: DashboardDomainPlanInput
): DashboardDomainPlan => {
  const requestedScenario = input?.scenario?.trim()
  const requestedCatalogScenario = requestedScenario
    ? dashboardDomainCatalog.scenarios.find((candidate) => candidate.id === requestedScenario)
    : undefined
  const scenario = requestedCatalogScenario?.status === 'active'
    ? requestedCatalogScenario
    : selectedScenario
  // A planned scenario keeps its own catalog metrics and bindings so the
  // caller can explain exactly what is unavailable. Unknown ids use the
  // active catalog set only as safe, non-executable fallback metadata.
  const unavailableScenario = Boolean(
    requestedScenario && (!requestedCatalogScenario || requestedCatalogScenario.status !== 'active')
  )
  const metricScenario = requestedCatalogScenario && requestedCatalogScenario.status !== 'active'
    ? requestedCatalogScenario
    : scenario
  const metricIds = metricIdsForScenario(metricScenario.id)
  const processBindingIds = processBindingIdsForMetrics(metricIds)
  const role = roleIsCatalogRole(input?.role) ? input.role : undefined

  if (unavailableScenario) {
    return clarificationPlan(
      requestedScenario!,
      metricIds,
      processBindingIds,
      'scenario-not-active',
      role
    )
  }

  // Keep this order stable: callers and audit records rely on the first
  // actionable blocker being deterministic.
  if (!role) {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'missing-role')
  }

  if (!scenario.roleIds.includes(role)) {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'role-not-applicable', role)
  }

  const projectIds = normalizedNonEmpty(input.projectIds)
  if (!projectIds.length) {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'missing-project-scope', role)
  }

  if (normalizedNonEmpty(input.metricConflicts).length) {
    return clarificationPlan(
      scenario.id,
      metricIds,
      processBindingIds,
      'metric-definition-conflict',
      role
    )
  }

  if (input.availableMetricIds !== undefined) {
    const available = new Set(normalizedNonEmpty(input.availableMetricIds))
    if (metricIds.some((metricId) => !available.has(metricId))) {
      return clarificationPlan(scenario.id, metricIds, processBindingIds, 'missing-metric-source', role)
    }
  }

  if (!input.tailoringBaselineId?.trim()) {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'missing-tailoring-baseline', role)
  }

  const permissions = new Set(normalizedNonEmpty(input.permissions))
  if (!permissions.has('project:read') || !permissions.has('process:evidence:read')) {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'insufficient-permission', role)
  }

  if (input.dataQuality === 'invalid') {
    return clarificationPlan(scenario.id, metricIds, processBindingIds, 'invalid-data-quality', role)
  }

  return {
    status: 'ready',
    role,
    scenario: scenario.id,
    metricIds,
    processBindingIds,
    catalogVersion: dashboardDomainCatalog.version
  }
}

export default resolveDashboardDomainPlan
