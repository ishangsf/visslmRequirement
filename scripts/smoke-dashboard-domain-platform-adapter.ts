import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import type { DashboardDomainPlatformAdapter } from '../src/shared/dashboard-domain'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import {
  parseDashboardDomainPlatformAdapters,
  validateDashboardDomainPlatformAdapter
} from '../src/main/experts/dashboard-domain-adapter'

const records: readonly AnalyticsRecord[] = [
  {
    uid: 'platform-project-001',
    projectId: 'project-alpha',
    nodeType: 'ProjectStatusRecord',
    itemId: 'PROJECT-ALPHA',
    name: '项目 Alpha',
    lastModifyTime: '2026-08-20T00:00:00.000Z',
    raw: {
      health_indicator: 0.82,
      milestone_ratio: 0.88,
      requirement_ratio: 0.79,
      defect_per_size: 0.12,
      risk_total: 4,
      process_rate: 0.86
    }
  },
  {
    uid: 'platform-project-002',
    projectId: 'project-alpha',
    nodeType: 'ProjectStatusRecord',
    itemId: 'PROJECT-BETA',
    name: '项目 Beta',
    lastModifyTime: '2026-08-20T00:00:00.000Z',
    raw: {
      health_indicator: 0.76,
      milestone_ratio: 0.81,
      requirement_ratio: 0.84,
      defect_per_size: 0.18,
      risk_total: 6,
      process_rate: 0.78
    }
  }
]

const db = {
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType))
    )
  }
} as AppDatabase

const adapter: DashboardDomainPlatformAdapter = {
  schemaVersion: '1.0',
  id: 'visslm-project-overview-v1',
  scenarioId: 'project-overview',
  sourceSystem: 'VISSLM lifecycle platform',
  allowedProjectIds: ['project-alpha'],
  permissions: ['project:read', 'process:evidence:read'],
  nodeTypes: ['ProjectStatusRecord'],
  tailoringBaselineId: 'BL-PROJECT-2026-V3',
  metricBindings: [
    { metricId: 'project-health', field: 'health_indicator', aggregation: 'avg' },
    { metricId: 'milestone-achievement', field: 'milestone_ratio', aggregation: 'avg' },
    { metricId: 'requirement-completion', field: 'requirement_ratio', aggregation: 'avg' },
    { metricId: 'defect-density', field: 'defect_per_size', aggregation: 'avg' },
    { metricId: 'high-risk-count', field: 'risk_total', aggregation: 'sum' },
    { metricId: 'process-compliance', field: 'process_rate', aggregation: 'avg' }
  ],
  questionBindings: [
    { questionId: 'project-overview-defect-question', dimensionFields: ['name'] }
  ],
  evidenceBindings: [
    { processBindingId: 'process.project-health', evidenceStatus: 'sufficient', sourceKey: 'visslm.review.project-health' },
    { processBindingId: 'process.milestone-tracking', evidenceStatus: 'sufficient', sourceKey: 'visslm.plan.milestone' },
    { processBindingId: 'process.requirement-status', evidenceStatus: 'insufficient', sourceKey: 'visslm.requirement.status' },
    { processBindingId: 'process.defect-classification', evidenceStatus: 'sufficient', sourceKey: 'visslm.defect.classification' },
    { processBindingId: 'process.risk-register', evidenceStatus: 'missing', sourceKey: 'visslm.risk.register' },
    { processBindingId: 'process.baseline-evidence', evidenceStatus: 'insufficient', sourceKey: 'visslm.baseline.evidence' }
  ],
  updatedAt: '2026-08-28T00:00:00.000Z'
}

assert.deepEqual(validateDashboardDomainPlatformAdapter(adapter), [])
const parsed = parseDashboardDomainPlatformAdapters(JSON.stringify({ adapters: [adapter] }))
assert.equal(parsed.configured, true)
assert.deepEqual(parsed.errors, [])
assert.equal(parsed.adapters[0]?.id, adapter.id)
assert.equal(parseDashboardDomainPlatformAdapters('{bad json').errors[0], '平台适配器配置不是有效 JSON')

const result = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapters: parsed.adapters
}, new QueryEngine(db))

assert.equal(result.status, 'ready', JSON.stringify(result))
assert.ok(result.dashboard)
const dashboard = result.dashboard!
assert.equal(dashboard.title, '项目综合态势（平台数据预览）')
assert.equal(dashboard.subtitle, 'VISSLM lifecycle platform · mapped data · preview')
assert.equal(dashboard.domainContext?.tailoringBaselineId, adapter.tailoringBaselineId)
assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
assert.match(result.answer ?? '', /平台数据预览/)
assert.match(result.answer ?? '', new RegExp(adapter.id))
assert.ok(dashboard.domainReceipt?.warnings.some((warning) => warning.includes(adapter.sourceSystem)))
assert.deepEqual(dashboard.domainReceipt?.evidenceMissing, ['process.risk-register'])
assert.deepEqual(new Set(dashboard.domainReceipt?.evidenceInsufficient), new Set([
  'process.requirement-status',
  'process.baseline-evidence'
]))
for (const component of dashboard.components) {
  assert.deepEqual(component.query?.scope.nodeTypes, ['ProjectStatusRecord'])
  assert.ok(component.data.length > 0)
  assert.equal(component.semanticBinding?.confidence, 0.75)
}
assert.equal(
  dashboard.components.find((component) => component.id === 'project-overview-health-card')?.query?.measures[0]?.field,
  'health_indicator'
)

const missingMetricAdapter = { ...adapter, metricBindings: adapter.metricBindings.slice(1) }
const missingMetric = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: missingMetricAdapter
}, new QueryEngine(db))
assert.equal(missingMetric.status, 'rejected')
assert.equal(missingMetric.reason, 'invalid-platform-adapter')

const unknownFieldAdapter: DashboardDomainPlatformAdapter = {
  ...adapter,
  metricBindings: adapter.metricBindings.map((binding) =>
    binding.metricId === 'project-health' ? { ...binding, field: 'unknown_health_field' } : binding
  )
}
const unknownField = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: unknownFieldAdapter
}, new QueryEngine(db))
assert.equal(unknownField.status, 'rejected')
assert.equal(unknownField.reason, 'invalid-adapter-field-mapping')

const scopeViolation = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'], nodeTypes: ['UnauthorizedRecord'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: adapter
}, new QueryEngine(db))
assert.equal(scopeViolation.status, 'rejected')
assert.equal(scopeViolation.reason, 'adapter-scope-violation')

const projectScopeViolation = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-not-allowed'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: adapter
}, new QueryEngine(db))
assert.equal(projectScopeViolation.status, 'rejected')
assert.equal(projectScopeViolation.reason, 'adapter-scope-violation')

const missingPermissionAdapter: DashboardDomainPlatformAdapter = {
  ...adapter,
  permissions: ['project:read']
}
const missingPermission = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: missingPermissionAdapter
}, new QueryEngine(db))
assert.equal(missingPermission.status, 'clarification')
assert.equal(missingPermission.reason, 'insufficient-permission')
assert.equal(missingPermission.clarificationOptions?.length, 2)

const callerPermissionMissing = await runDashboardDomainChatRequest({
  question: '项目负责人生成项目综合态势大屏',
  scope: { projectIds: ['project-alpha'] },
  permissions: ['project:read'],
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapter: adapter
}, new QueryEngine(db))
assert.equal(callerPermissionMissing.status, 'clarification')
assert.equal(callerPermissionMissing.reason, 'insufficient-permission')

const missingBoundary = parseDashboardDomainPlatformAdapters(JSON.stringify({
  adapters: [{ ...adapter, allowedProjectIds: undefined }]
}))
assert.ok(missingBoundary.errors.some((error) => /allowedProjectId/.test(error)))

const genericRequest = await runDashboardDomainChatRequest({
  question: '请帮我分析最近导入的数据',
  scope: { projectIds: ['project-not-allowed'] },
  generatedAt: '2026-08-28T00:00:00.000Z',
  platformAdapters: [missingPermissionAdapter]
}, new QueryEngine(db))
assert.equal(genericRequest.recognized, false)

assert.ok(validateDashboardDomainPlatformAdapter({
  ...adapter,
  nodeTypes: ['ProjectOverviewSample']
}).some((error) => /Sample/.test(error)))

console.log(JSON.stringify({
  ok: true,
  adapterId: adapter.id,
  sourceSystem: adapter.sourceSystem,
  scenario: dashboard.domainContext?.scenario,
  title: dashboard.title,
  nodeTypes: dashboard.components[0]?.query?.scope.nodeTypes,
  mappedFields: dashboard.analysisBlueprint?.metrics.map((metric) => ({ id: metric.id, field: metric.field })),
  receipt: dashboard.domainReceipt,
  rejectedCases: [missingMetric.reason, unknownField.reason, scopeViolation.reason, projectScopeViolation.reason],
  permissionCases: {
    missingPermission: missingPermission.reason,
    callerPermissionMissing: callerPermissionMissing.reason,
    missingBoundaryErrors: missingBoundary.errors
  }
}, null, 2))
