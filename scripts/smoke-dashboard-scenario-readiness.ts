import assert from 'node:assert/strict'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { evaluateDashboardDomainReadiness } from '../src/main/experts/dashboard-domain-readiness'
import type {
  DashboardDomainPlatformAdapter,
  DashboardScenarioReadiness
} from '../src/shared/dashboard-domain'
import type { FieldProfile } from '../src/shared/query-spec'

const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === 'project-overview')
if (!scenario) throw new Error('project-overview scenario is missing')

const requiredEvidenceIds = [...new Set(dashboardDomainCatalog.processBindings
  .filter((binding) => binding.metricIds.some((metricId) => scenario.metricIds.includes(metricId)))
  .map((binding) => binding.id))]

const adapter: DashboardDomainPlatformAdapter = {
  schemaVersion: '1.0',
  id: 'platform-project-overview-v1',
  scenarioId: scenario.id,
  sourceSystem: 'VISSLM controlled adapter fixture',
  allowedProjectIds: ['project-1'],
  permissions: ['project:read', 'process:evidence:read'],
  nodeTypes: ['ManagedProject'],
  tailoringBaselineId: 'platform-tailoring-baseline-v1',
  metricBindings: scenario.metricIds.map((metricId, index) => ({
    metricId,
    field: `metric_${index + 1}`,
    aggregation: 'avg' as const
  })),
  questionBindings: scenario.questionIds.map((questionId) => ({
    questionId,
    dimensionFields: []
  })),
  evidenceBindings: requiredEvidenceIds.map((processBindingId) => ({
    processBindingId,
    evidenceStatus: 'sufficient' as const,
    sourceKey: `platform.project-overview.${processBindingId}`
  })),
  updatedAt: '2026-08-28T00:00:00.000Z'
}

const profiles: FieldProfile[] = scenario.metricIds.map((_, index) => ({
  field: `metric_${index + 1}`,
  inferredType: 'number',
  sensitivity: 'normal',
  nonNullRate: 1,
  distinctCount: 1,
  samples: ['1']
}))

const hasBlocker = (result: DashboardScenarioReadiness, code: string): boolean =>
  result.blockers.some((blocker) => blocker.code === code)

const sample = evaluateDashboardDomainReadiness({
  scenarioId: 'project-overview',
  role: 'project-owner',
  dataMode: 'controlled-sample',
  scope: {}
}, { profile: () => [] })
assert.equal(sample.level, 'partial')
assert.equal(sample.metricStatuses.length, scenario.metricIds.length)
assert.ok(sample.warnings.some((warning) => warning.includes('受控样例')))

const unsupportedRole = evaluateDashboardDomainReadiness({
  scenarioId: 'gjb5000b-compliance',
  role: 'project-owner',
  dataMode: 'controlled-sample',
  scope: {}
})
assert.equal(unsupportedRole.level, 'blocked')
assert.ok(hasBlocker(unsupportedRole, 'role-not-supported'))

const missingAdapter = evaluateDashboardDomainReadiness({
  scenarioId: 'project-overview',
  role: 'project-owner',
  dataMode: 'platform-adapter',
  scope: { projectIds: ['project-1'] }
})
assert.equal(missingAdapter.level, 'blocked')
assert.ok(hasBlocker(missingAdapter, 'adapter-required'))

const ready = evaluateDashboardDomainReadiness({
  scenarioId: 'project-overview',
  role: 'project-owner',
  dataMode: 'platform-adapter',
  scope: { projectIds: ['project-1'] },
  adapter,
  requestedPermissions: ['project:read', 'process:evidence:read'],
  profiles
})
assert.equal(ready.level, 'ready')
assert.equal(ready.metricStatuses.every((metric) => metric.availability === 'ready'), true)
assert.equal(ready.profiledFieldCount, profiles.length)

const outOfScope = evaluateDashboardDomainReadiness({
  scenarioId: 'project-overview',
  role: 'project-owner',
  dataMode: 'platform-adapter',
  scope: { projectIds: ['project-2'] },
  adapter,
  requestedPermissions: ['project:read', 'process:evidence:read'],
  profiles
})
assert.equal(outOfScope.level, 'blocked')
assert.ok(hasBlocker(outOfScope, 'adapter-scope-violation'))

const missingPermission = evaluateDashboardDomainReadiness({
  scenarioId: 'project-overview',
  role: 'project-owner',
  dataMode: 'platform-adapter',
  scope: { projectIds: ['project-1'] },
  adapter,
  requestedPermissions: ['project:read'],
  profiles
})
assert.equal(missingPermission.level, 'blocked')
assert.ok(hasBlocker(missingPermission, 'insufficient-permission'))

console.log(JSON.stringify({
  ok: true,
  sample: { level: sample.level, metrics: sample.metricStatuses.length },
  platform: { level: ready.level, metrics: ready.metricStatuses.length },
  blockedCases: [
    unsupportedRole.blockers[0]?.code,
    missingAdapter.blockers[0]?.code,
    outOfScope.blockers[0]?.code,
    missingPermission.blockers[0]?.code
  ]
}, null, 2))

