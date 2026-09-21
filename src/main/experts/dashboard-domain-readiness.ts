import type { DataScope, FieldProfile } from '../../shared/query-spec'
import type {
  DashboardDomainPlatformAdapter,
  DashboardDomainRole,
  DashboardGoldenScenario,
  MetricCatalogEntry,
  DashboardMetricAvailability,
  DashboardScenarioDataMode,
  DashboardScenarioMetricReadiness,
  DashboardScenarioReadiness
} from '../../shared/dashboard-domain'
import {
  scopeForDashboardDomainPlatformAdapter,
  validateDashboardDomainAdapterAccess,
  validateDashboardDomainAdapterProfiles,
  validateDashboardDomainPlatformAdapter
} from './dashboard-domain-adapter'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

export interface DashboardDomainReadinessInput {
  scenarioId: string
  role: DashboardDomainRole
  dataMode: DashboardScenarioDataMode
  scope?: DataScope
  adapter?: DashboardDomainPlatformAdapter
  requestedPermissions?: readonly string[]
  /** Used by deterministic tests; production callers should provide queryEngine. */
  profiles?: readonly FieldProfile[]
  checkedAt?: string
}

export interface DashboardDomainReadinessDependencies {
  profile?: (scope: DataScope) => readonly FieldProfile[]
}

const uniqueStrings = (values: readonly unknown[] | undefined): string[] => [
  ...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))
]

const normalizeScope = (scope: DataScope | undefined): DataScope => ({
  ...(scope?.projectIds ? { projectIds: uniqueStrings(scope.projectIds) } : {}),
  ...(scope?.nodeTypes ? { nodeTypes: uniqueStrings(scope.nodeTypes) } : {}),
  ...(scope?.recordUids ? { recordUids: uniqueStrings(scope.recordUids) } : {}),
  ...(scope?.baseFilters ? { baseFilters: [...scope.baseFilters] } : {}),
  ...(typeof scope?.snapshotAt === 'string' && scope.snapshotAt.trim()
    ? { snapshotAt: scope.snapshotAt.trim() }
    : {})
})

const profileByField = (profiles: readonly FieldProfile[]): Map<string, FieldProfile> =>
  new Map(profiles.map((profile) => [profile.field.trim().toLocaleLowerCase(), profile]))

const requiredProcessBindingIds = (scenario: DashboardGoldenScenario): string[] => [
  ...new Set(dashboardDomainCatalog.processBindings
    .filter((binding) => binding.metricIds.some((metricId) => scenario.metricIds.includes(metricId)))
    .map((binding) => binding.id))
]

const metricStatus = (
  metricId: string,
  availability: DashboardMetricAvailability,
  reason?: string,
  resolvedField?: string
): DashboardScenarioMetricReadiness => ({
  metricId,
  availability,
  ...(resolvedField ? { resolvedField } : {}),
  ...(reason ? { reason } : {})
})

const readinessLevel = (
  blockers: readonly unknown[],
  metricStatuses: readonly DashboardScenarioMetricReadiness[],
  missingEvidence: readonly string[]
): DashboardScenarioReadiness['level'] => {
  if (blockers.length) return 'blocked'
  if (missingEvidence.length || metricStatuses.some((status) => status.availability !== 'ready')) {
    return 'partial'
  }
  return 'ready'
}

const addBlocker = (
  target: Array<{ code: DashboardScenarioReadiness['blockers'][number]['code']; message: string }>,
  code: DashboardScenarioReadiness['blockers'][number]['code'],
  message: string
): void => {
  if (!target.some((item) => item.code === code && item.message === message)) {
    target.push({ code, message })
  }
}

const matchingSampleField = (
  metric: MetricCatalogEntry,
  profiles: readonly FieldProfile[]
): FieldProfile | undefined => {
  const byField = profileByField(profiles)
  return metric.sourceFields
    .map((source) => byField.get(source.field.trim().toLocaleLowerCase()))
    .find((profile): profile is FieldProfile => Boolean(profile))
}

/**
 * Compute a safe, explainable readiness result before any domain generation.
 * This function deliberately does not execute analytical queries and never
 * returns field values, samples or record payloads.
 */
export const evaluateDashboardDomainReadiness = (
  input: DashboardDomainReadinessInput,
  dependencies: DashboardDomainReadinessDependencies = {}
): DashboardScenarioReadiness => {
  const checkedAt = input.checkedAt?.trim() || new Date().toISOString()
  const scopeInput = normalizeScope(input.scope)
  const blockers: DashboardScenarioReadiness['blockers'] = []
  const warnings: string[] = []
  const missingPermissions: string[] = []
  const missingEvidence: string[] = []
  let effectiveScope = scopeInput
  let profiles: readonly FieldProfile[] = input.profiles ?? []
  let adapterId: string | undefined
  let tailoringBaselineId: string | undefined

  const scenario = dashboardDomainCatalog.scenarios.find((candidate) => candidate.id === input.scenarioId)
  if (!scenario) {
    addBlocker(blockers, 'scenario-not-found', `黄金场景不存在：${input.scenarioId}`)
    return {
      scenarioId: input.scenarioId,
      role: input.role,
      dataMode: input.dataMode,
      level: 'blocked',
      metricStatuses: [],
      projectIds: uniqueStrings(scopeInput.projectIds),
      nodeTypes: uniqueStrings(scopeInput.nodeTypes),
      missingPermissions,
      missingEvidence,
      warnings,
      blockers,
      checkedAt,
      profiledFieldCount: 0
    }
  }
  if (scenario.status !== 'active') {
    addBlocker(blockers, 'scenario-not-active', `黄金场景当前未启用：${scenario.name}`)
  }
  if (!scenario.roleIds.includes(input.role)) {
    addBlocker(blockers, 'role-not-supported', `角色“${input.role}”不适用场景：${scenario.name}`)
  }

  if (input.dataMode === 'platform-adapter') {
    const adapter = input.adapter
    if (!adapter) {
      addBlocker(blockers, 'adapter-required', '平台数据模式必须选择有效的平台适配器。')
    } else {
      adapterId = adapter.id
      tailoringBaselineId = adapter.tailoringBaselineId
      const adapterErrors = validateDashboardDomainPlatformAdapter(adapter)
      if (adapter.scenarioId !== scenario.id) {
        adapterErrors.push(`平台适配器场景 ${adapter.scenarioId} 与当前场景 ${scenario.id} 不一致`)
      }
      if (adapterErrors.length) {
        adapterErrors.forEach((error) => addBlocker(blockers, 'adapter-invalid', error))
      } else if (!uniqueStrings(scopeInput.projectIds).length) {
        addBlocker(blockers, 'adapter-scope-violation', '平台数据模式必须明确至少一个项目范围。')
      } else {
        const access = validateDashboardDomainAdapterAccess(
          scopeInput,
          input.requestedPermissions,
          adapter
        )
        if (!access.ok) {
          addBlocker(blockers, access.reason, access.message)
          if (access.reason === 'insufficient-permission') {
            missingPermissions.push(...adapter.permissions.filter(
              (permission) => !input.requestedPermissions?.includes(permission)
            ))
          }
        } else {
          effectiveScope = scopeForDashboardDomainPlatformAdapter(access.scope, adapter)
          if (!profiles.length && dependencies.profile) {
            try {
              profiles = dependencies.profile(effectiveScope)
            } catch (error) {
              addBlocker(
                blockers,
                'profile-failed',
                `字段画像读取失败：${error instanceof Error ? error.message : String(error)}`
              )
            }
          }
          if (profiles.length) {
            const profileErrors = validateDashboardDomainAdapterProfiles(adapter, profiles)
            profileErrors.forEach((error) => addBlocker(blockers, 'metric-field-invalid', error))
          }
        }
      }
    }
  } else if (!profiles.length && dependencies.profile) {
    try {
      profiles = dependencies.profile(effectiveScope)
    } catch (error) {
      addBlocker(
        blockers,
        'profile-failed',
        `字段画像读取失败：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const byMetricBinding = new Map(
    (input.adapter?.metricBindings ?? []).map((binding) => [binding.metricId, binding])
  )
  const byProfile = profileByField(profiles)
  const metricStatuses = scenario.metricIds.map((metricId) => {
    const metric = dashboardDomainCatalog.metrics.find((candidate) => candidate.id === metricId)
    if (!metric) return metricStatus(metricId, 'missing', '场景引用了未登记指标。')

    if (input.dataMode === 'platform-adapter') {
      const binding = byMetricBinding.get(metricId)
      if (!binding) {
        addBlocker(blockers, 'metric-field-missing', `指标未配置平台字段：${metric.label}`)
        return metricStatus(metricId, 'missing', '平台适配器缺少指标字段映射。')
      }
      const profile = byProfile.get(binding.field.trim().toLocaleLowerCase())
      if (!profile) {
        addBlocker(blockers, 'metric-field-missing', `指标字段不存在：${binding.field}`)
        return metricStatus(metricId, 'missing', `字段画像中不存在 ${binding.field}。`)
      }
      if (profile.inferredType !== 'number' || profile.sensitivity === 'sensitive') {
        addBlocker(blockers, 'metric-field-invalid', `指标字段不可安全计算：${binding.field}`)
        return metricStatus(metricId, 'insufficient', '字段必须为非敏感数值字段。', binding.field)
      }
      return metricStatus(metricId, 'ready', undefined, binding.field)
    }

    const sampleProfile = matchingSampleField(metric, profiles)
    if (metric.availability === 'missing') {
      return metricStatus(metricId, 'missing', metric.notes?.join('；') ?? '目录未提供可用数据来源。')
    }
    if (sampleProfile && sampleProfile.sensitivity === 'sensitive') {
      return metricStatus(metricId, 'insufficient', `受控来源字段 ${sampleProfile.field} 被标记为敏感。`)
    }
    if (metric.availability === 'partial') {
      return metricStatus(
        metricId,
        'partial',
        metric.notes?.join('；') ?? '受控样例或真实平台来源仍需业务复核。',
        sampleProfile?.field
      )
    }
    return metricStatus(metricId, 'ready', undefined, sampleProfile?.field)
  })

  const processBindings = requiredProcessBindingIds(scenario)
  const evidenceById = new Map(
    (input.adapter?.evidenceBindings ?? []).map((binding) => [binding.processBindingId, binding])
  )
  for (const processBindingId of processBindings) {
    const evidenceStatus = input.dataMode === 'platform-adapter'
      ? evidenceById.get(processBindingId)?.evidenceStatus ?? 'missing'
      : dashboardDomainCatalog.processBindings.find((binding) => binding.id === processBindingId)?.evidenceStatus ?? 'missing'
    if (evidenceStatus === 'missing') missingEvidence.push(processBindingId)
    if (evidenceStatus === 'insufficient') warnings.push(`过程证据不足：${processBindingId}`)
  }
  if (missingEvidence.length) {
    warnings.push(`缺少 ${missingEvidence.length} 项过程证据；当前结果只能作为预览。`)
  }
  if (!uniqueStrings(effectiveScope.projectIds).length) {
    warnings.push('尚未限定项目范围，生成前需要确认组织或项目边界。')
  }
  if (input.dataMode === 'controlled-sample') {
    warnings.push('当前为受控样例模式，不代表真实平台数据或正式合规结论。')
  }

  return {
    scenarioId: scenario.id,
    role: input.role,
    dataMode: input.dataMode,
    level: readinessLevel(blockers, metricStatuses, missingEvidence),
    metricStatuses,
    projectIds: uniqueStrings(effectiveScope.projectIds),
    nodeTypes: uniqueStrings(effectiveScope.nodeTypes),
    missingPermissions: uniqueStrings(missingPermissions),
    missingEvidence: uniqueStrings(missingEvidence),
    warnings: uniqueStrings(warnings),
    blockers,
    checkedAt,
    ...(adapterId ? { adapterId } : {}),
    ...(tailoringBaselineId ? { tailoringBaselineId } : {}),
    profiledFieldCount: profiles.length
  }
}
