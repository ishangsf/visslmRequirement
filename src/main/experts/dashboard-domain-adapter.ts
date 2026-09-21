import type { DataScope, FieldProfile } from '../../shared/query-spec'
import type {
  DashboardDomainPlatformAdapter,
  DashboardEvidenceStatus,
  DashboardGoldenScenario
} from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

const allowedAggregations = new Set(['count', 'countDistinct', 'sum', 'avg', 'min', 'max'])
const allowedEvidenceStatuses = new Set<DashboardEvidenceStatus>(['missing', 'insufficient', 'sufficient'])
const allowedPermissions = new Set(['project:read', 'process:evidence:read'])
const sampleNodeType = /sample$/i

export const dashboardDomainPlatformAdaptersSettingKey = 'dashboard.domain-platform-adapters:v1'

export interface DashboardDomainPlatformAdapterParseResult {
  configured: boolean
  adapters: readonly DashboardDomainPlatformAdapter[]
  errors: readonly string[]
}

const uniqueNonEmpty = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean))
]

const duplicates = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    const normalized = value.trim().toLocaleLowerCase()
    if (!normalized) continue
    if (seen.has(normalized)) repeated.add(value.trim())
    seen.add(normalized)
  }
  return [...repeated]
}

const requiredProcessBindingIds = (scenario: DashboardGoldenScenario): string[] => [
  ...new Set(dashboardDomainCatalog.processBindings
    .filter((binding) => binding.metricIds.some((metricId) => scenario.metricIds.includes(metricId)))
    .map((binding) => binding.id))
]

const requiredPermissionsForAdapter = (adapter: DashboardDomainPlatformAdapter): string[] => {
  const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === adapter.scenarioId)
  return [
    'project:read',
    ...(scenario && requiredProcessBindingIds(scenario).length ? ['process:evidence:read'] : [])
  ]
}

export const validateDashboardDomainPlatformAdapter = (
  adapter: DashboardDomainPlatformAdapter
): string[] => {
  const errors: string[] = []
  if (adapter.schemaVersion !== '1.0') errors.push('适配器 schemaVersion 必须为 1.0')
  if (!adapter.id?.trim()) errors.push('适配器 id 不能为空')
  if (!adapter.sourceSystem?.trim()) errors.push('适配器 sourceSystem 不能为空')
  if (!adapter.updatedAt?.trim() || !Number.isFinite(Date.parse(adapter.updatedAt))) {
    errors.push('适配器 updatedAt 必须是有效时间')
  }
  if (!adapter.tailoringBaselineId?.trim()) errors.push('适配器 tailoringBaselineId 不能为空')
  if (/^sample-/i.test(adapter.tailoringBaselineId?.trim() ?? '')) {
    errors.push('平台适配器不得复用 sample 裁剪基线')
  }
  if (!Array.isArray(adapter.allowedProjectIds)) {
    errors.push('适配器 allowedProjectIds 必须是数组')
  } else {
    const allowedProjectIds = uniqueNonEmpty(adapter.allowedProjectIds)
    if (!allowedProjectIds.length) errors.push('适配器至少需要一个 allowedProjectId')
    if (duplicates(adapter.allowedProjectIds).length) errors.push('适配器 allowedProjectIds 不得重复')
  }
  if (!Array.isArray(adapter.permissions)) {
    errors.push('适配器 permissions 必须是数组')
  } else {
    const permissions = uniqueNonEmpty(adapter.permissions)
    if (!permissions.includes('project:read')) errors.push('适配器必须声明 project:read 权限')
    if (permissions.some((permission) => !allowedPermissions.has(permission))) {
      errors.push('适配器 permissions 包含不受支持的权限')
    }
    if (duplicates(adapter.permissions).length) errors.push('适配器 permissions 不得重复')
  }
  const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === adapter.scenarioId)
  if (!scenario || scenario.status !== 'active') {
    errors.push(`适配器场景不存在或未启用: ${adapter.scenarioId}`)
    return errors
  }
  if (requiredPermissionsForAdapter(adapter).includes('process:evidence:read') &&
      !uniqueNonEmpty(adapter.permissions ?? []).includes('process:evidence:read')) {
    errors.push('涉及过程回执的适配器必须声明 process:evidence:read 权限')
  }

  const nodeTypes = uniqueNonEmpty(adapter.nodeTypes ?? [])
  if (!nodeTypes.length) errors.push('适配器至少需要一个 nodeType')
  if (nodeTypes.some((nodeType) => sampleNodeType.test(nodeType))) {
    errors.push('平台适配器不得映射受控 Sample 节点类型')
  }
  if (duplicates(adapter.nodeTypes ?? []).length) errors.push('适配器 nodeTypes 不得重复')

  const metricIds = adapter.metricBindings?.map((binding) => binding.metricId) ?? []
  if (duplicates(metricIds).length) errors.push('适配器 metricBindings.metricId 不得重复')
  const requiredMetricIds = new Set(scenario.metricIds)
  if (metricIds.length !== requiredMetricIds.size || metricIds.some((id) => !requiredMetricIds.has(id))) {
    errors.push('适配器 metricBindings 必须精确覆盖场景指标')
  }
  for (const binding of adapter.metricBindings ?? []) {
    if (!binding.field?.trim()) errors.push(`指标 ${binding.metricId} 的 field 不能为空`)
    if (!allowedAggregations.has(binding.aggregation)) {
      errors.push(`指标 ${binding.metricId} 的 aggregation 不受支持`)
    }
  }

  const questionIds = adapter.questionBindings?.map((binding) => binding.questionId) ?? []
  if (duplicates(questionIds).length) errors.push('适配器 questionBindings.questionId 不得重复')
  const scenarioQuestionIds = new Set(scenario.questionIds)
  for (const binding of adapter.questionBindings ?? []) {
    if (!scenarioQuestionIds.has(binding.questionId)) {
      errors.push(`问题映射不属于场景: ${binding.questionId}`)
    }
    if (duplicates(binding.dimensionFields ?? []).length) {
      errors.push(`问题 ${binding.questionId} 的 dimensionFields 不得重复`)
    }
  }

  const evidenceIds = adapter.evidenceBindings?.map((binding) => binding.processBindingId) ?? []
  if (duplicates(evidenceIds).length) errors.push('适配器 evidenceBindings.processBindingId 不得重复')
  const requiredEvidenceIds = new Set(requiredProcessBindingIds(scenario))
  if (evidenceIds.length !== requiredEvidenceIds.size || evidenceIds.some((id) => !requiredEvidenceIds.has(id))) {
    errors.push('适配器 evidenceBindings 必须精确覆盖场景过程绑定')
  }
  for (const binding of adapter.evidenceBindings ?? []) {
    if (!allowedEvidenceStatuses.has(binding.evidenceStatus)) {
      errors.push(`过程绑定 ${binding.processBindingId} 的 evidenceStatus 无效`)
    }
    if (!binding.sourceKey?.trim()) errors.push(`过程绑定 ${binding.processBindingId} 的 sourceKey 不能为空`)
    if (/^sample\./i.test(binding.sourceKey?.trim() ?? '')) {
      errors.push(`过程绑定 ${binding.processBindingId} 不得复用 sample sourceKey`)
    }
  }
  return errors
}

export const scopeForDashboardDomainPlatformAdapter = (
  scope: DataScope,
  adapter: DashboardDomainPlatformAdapter
): DataScope => {
  const allowedNodeTypes = new Set(adapter.nodeTypes.map((value) => value.trim()))
  const requestedNodeTypes = uniqueNonEmpty(scope.nodeTypes ?? [])
  if (requestedNodeTypes.some((nodeType) => !allowedNodeTypes.has(nodeType))) {
    throw new Error('请求 nodeTypes 超出平台适配器授权范围')
  }
  return {
    ...scope,
    nodeTypes: requestedNodeTypes.length ? requestedNodeTypes : [...allowedNodeTypes]
  }
}

export type DashboardDomainAdapterAccessResult =
  | {
      ok: true
      scope: DataScope
      permissions: string[]
    }
  | {
      ok: false
      reason: 'adapter-scope-violation' | 'insufficient-permission'
      message: string
    }

/**
 * Intersect request capabilities with adapter capabilities and enforce the
 * explicit project boundary before QueryEngine is touched. This is deliberately
 * fail-closed: an omitted or empty adapter boundary never becomes "all projects".
 */
export const validateDashboardDomainAdapterAccess = (
  scope: DataScope,
  requestedPermissions: readonly string[] | undefined,
  adapter: DashboardDomainPlatformAdapter
): DashboardDomainAdapterAccessResult => {
  const requestedProjectIds = uniqueNonEmpty(scope.projectIds ?? [])
  const allowedProjectIds = uniqueNonEmpty(
    Array.isArray(adapter.allowedProjectIds) ? adapter.allowedProjectIds : []
  )
  const allowedProjectSet = new Set(allowedProjectIds)
  if (requestedProjectIds.some((projectId) => !allowedProjectSet.has(projectId))) {
    return {
      ok: false,
      reason: 'adapter-scope-violation',
      message: `请求项目范围超出平台适配器授权范围：${requestedProjectIds
        .filter((projectId) => !allowedProjectSet.has(projectId)).join('、')}`
    }
  }

  const adapterPermissionSet = new Set(uniqueNonEmpty(
    Array.isArray(adapter.permissions) ? adapter.permissions : []
  ))
  const effectivePermissions = uniqueNonEmpty(requestedPermissions ?? [])
    .filter((permission) => adapterPermissionSet.has(permission))
  const requiredPermissions = requiredPermissionsForAdapter(adapter)
  const missingPermissions = requiredPermissions.filter(
    (permission) => !effectivePermissions.includes(permission)
  )
  if (missingPermissions.length) {
    return {
      ok: false,
      reason: 'insufficient-permission',
      message: `平台适配器缺少必要权限：${missingPermissions.join('、')}`
    }
  }

  return {
    ok: true,
    scope: { ...scope, projectIds: requestedProjectIds },
    permissions: effectivePermissions
  }
}

export const validateDashboardDomainAdapterProfiles = (
  adapter: DashboardDomainPlatformAdapter,
  profiles: readonly FieldProfile[]
): string[] => {
  const profileByField = new Map(profiles.map((profile) => [profile.field.toLocaleLowerCase(), profile]))
  const errors: string[] = []
  for (const binding of adapter.metricBindings) {
    const profile = profileByField.get(binding.field.trim().toLocaleLowerCase())
    if (!profile) errors.push(`指标 ${binding.metricId} 的字段不存在: ${binding.field}`)
    else if (profile.inferredType !== 'number') errors.push(`指标 ${binding.metricId} 的字段必须为数值: ${binding.field}`)
    else if (profile.sensitivity === 'sensitive') errors.push(`指标 ${binding.metricId} 不得使用敏感字段: ${binding.field}`)
  }
  for (const binding of adapter.questionBindings) {
    for (const field of uniqueNonEmpty(binding.dimensionFields)) {
      const profile = profileByField.get(field.toLocaleLowerCase())
      if (!profile) errors.push(`问题 ${binding.questionId} 的维度字段不存在: ${field}`)
      else if (profile.sensitivity === 'sensitive') errors.push(`问题 ${binding.questionId} 不得使用敏感维度: ${field}`)
    }
  }
  return errors
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const stringOf = (value: unknown): string => typeof value === 'string' ? value : ''

export const parseDashboardDomainPlatformAdapters = (
  raw: string | undefined
): DashboardDomainPlatformAdapterParseResult => {
  if (!raw?.trim()) return { configured: false, adapters: [], errors: [] }
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return { configured: true, adapters: [], errors: ['平台适配器配置不是有效 JSON'] }
  }
  const root = Array.isArray(decoded) ? decoded : recordOf(decoded)?.adapters
  if (!Array.isArray(root)) {
    return { configured: true, adapters: [], errors: ['平台适配器配置必须是数组或包含 adapters 数组'] }
  }
  const adapters: DashboardDomainPlatformAdapter[] = []
  const errors: string[] = []
  root.forEach((candidate, index) => {
    const value = recordOf(candidate)
    if (!value) {
      errors.push(`平台适配器第 ${index + 1} 项必须是对象`)
      return
    }
    const metricBindings = Array.isArray(value.metricBindings)
      ? value.metricBindings.map(recordOf).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
          metricId: stringOf(item.metricId),
          field: stringOf(item.field),
          aggregation: stringOf(item.aggregation) as DashboardDomainPlatformAdapter['metricBindings'][number]['aggregation']
        }))
      : []
    const questionBindings = Array.isArray(value.questionBindings)
      ? value.questionBindings.map(recordOf).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
          questionId: stringOf(item.questionId),
          dimensionFields: Array.isArray(item.dimensionFields)
            ? item.dimensionFields.filter((field): field is string => typeof field === 'string')
            : []
        }))
      : []
    const evidenceBindings = Array.isArray(value.evidenceBindings)
      ? value.evidenceBindings.map(recordOf).filter((item): item is Record<string, unknown> => Boolean(item)).map((item) => ({
          processBindingId: stringOf(item.processBindingId),
          evidenceStatus: stringOf(item.evidenceStatus) as DashboardEvidenceStatus,
        sourceKey: stringOf(item.sourceKey)
      }))
      : []
    const adapter: DashboardDomainPlatformAdapter = {
      schemaVersion: stringOf(value.schemaVersion) as '1.0',
      id: stringOf(value.id),
      scenarioId: stringOf(value.scenarioId),
      sourceSystem: stringOf(value.sourceSystem),
      allowedProjectIds: Array.isArray(value.allowedProjectIds)
        ? value.allowedProjectIds.filter((projectId): projectId is string => typeof projectId === 'string')
        : [],
      permissions: Array.isArray(value.permissions)
        ? value.permissions.filter((permission): permission is string => typeof permission === 'string')
        : [],
      nodeTypes: Array.isArray(value.nodeTypes)
        ? value.nodeTypes.filter((nodeType): nodeType is string => typeof nodeType === 'string')
        : [],
      tailoringBaselineId: stringOf(value.tailoringBaselineId),
      metricBindings,
      questionBindings,
      evidenceBindings,
      updatedAt: stringOf(value.updatedAt)
    }
    const adapterErrors = validateDashboardDomainPlatformAdapter(adapter)
    if (adapterErrors.length) {
      errors.push(...adapterErrors.map((error) => `适配器 ${adapter.id || index + 1}: ${error}`))
      return
    }
    adapters.push(adapter)
  })
  if (duplicates(adapters.map((adapter) => adapter.id)).length) errors.push('平台适配器 id 不得重复')
  if (duplicates(adapters.map((adapter) => adapter.scenarioId)).length) errors.push('同一场景只能配置一个平台适配器')
  return { configured: true, adapters: errors.length ? [] : adapters, errors }
}
