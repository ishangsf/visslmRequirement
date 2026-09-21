import type { DataScope } from '../../shared/query-spec'
import type { DashboardSpec } from '../../shared/dashboard'
import type { AnalyticsRecord, AppDatabase } from '../database'
import { QueryEngine } from '../analytics/query-engine'
import { configurationChangeGoldenFixture } from './dashboard-configuration-change'
import { gjb5000bComplianceGoldenFixture } from './dashboard-gjb5000b-compliance'
import { organizationImprovementGoldenFixture } from './dashboard-organization-improvement'
import { planMilestoneGoldenFixture } from './dashboard-plan-milestone'
import { projectOverviewGoldenFixture } from './dashboard-project-overview'
import { requirementsDeliveryGoldenFixture } from './dashboard-requirements-delivery'
import { softwareQualityGoldenFixture } from './dashboard-software-quality'
import { testValidationGoldenFixture } from './dashboard-test-validation'

export type DashboardDomainControlledScenarioId =
  | 'project-overview'
  | 'requirements-delivery'
  | 'plan-milestone'
  | 'software-quality'
  | 'test-validation'
  | 'configuration-change'
  | 'gjb5000b-compliance'
  | 'organization-improvement'

export interface DashboardDomainControlledScenarioFixture {
  readonly scenario: DashboardDomainControlledScenarioId
  readonly projectId: string
  readonly records: readonly AnalyticsRecord[]
}

export interface DashboardDomainControlledScenarioContext {
  readonly fixture: DashboardDomainControlledScenarioFixture
  readonly queryEngine: QueryEngine
}

const projectIdForRecords = (records: readonly AnalyticsRecord[]): string => {
  const projectIds = [...new Set(records
    .map((record) => record.projectId.trim())
    .filter(Boolean))]
  if (projectIds.length !== 1) {
    throw new Error('受控场景 fixture 必须只包含一个项目范围')
  }
  return projectIds[0]
}

const fixtureFor = <T extends DashboardDomainControlledScenarioId>(
  scenario: T,
  records: readonly AnalyticsRecord[]
): DashboardDomainControlledScenarioFixture => ({
  scenario,
  projectId: projectIdForRecords(records),
  records
})

const controlledScenarioFixtures = {
  'project-overview': fixtureFor('project-overview', projectOverviewGoldenFixture.records),
  'requirements-delivery': fixtureFor('requirements-delivery', requirementsDeliveryGoldenFixture.records),
  'plan-milestone': fixtureFor('plan-milestone', planMilestoneGoldenFixture.records),
  'software-quality': fixtureFor('software-quality', softwareQualityGoldenFixture.records),
  'test-validation': fixtureFor('test-validation', testValidationGoldenFixture.records),
  'configuration-change': fixtureFor('configuration-change', configurationChangeGoldenFixture.records),
  'gjb5000b-compliance': fixtureFor('gjb5000b-compliance', gjb5000bComplianceGoldenFixture.records),
  'organization-improvement': fixtureFor('organization-improvement', organizationImprovementGoldenFixture.records)
} as const satisfies Record<DashboardDomainControlledScenarioId, DashboardDomainControlledScenarioFixture>

const normalizedScopeValues = (values: readonly string[] | undefined): string[] => [
  ...new Set((values ?? [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))
]

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, cloneValue(child)])
  )
}

const cloneRecord = (record: AnalyticsRecord): AnalyticsRecord => ({
  ...record,
  raw: cloneValue(record.raw) as Record<string, unknown>
})

const createFixtureDatabase = (
  fixture: DashboardDomainControlledScenarioFixture
): Pick<AppDatabase, 'scanAnalyticsRecords'> => ({
  scanAnalyticsRecords: (scope: DataScope): AnalyticsRecord[] => {
    const projectIds = normalizedScopeValues(scope.projectIds)
    const nodeTypes = normalizedScopeValues(scope.nodeTypes)
    const recordUids = normalizedScopeValues(scope.recordUids)
    if (projectIds.length && !projectIds.includes(fixture.projectId)) return []

    return fixture.records
      .filter((record) => (
        record.projectId === fixture.projectId &&
        (!nodeTypes.length || nodeTypes.includes(record.nodeType)) &&
        (!recordUids.length || recordUids.includes(record.uid))
      ))
      .map(cloneRecord)
  }
})

export const getDashboardDomainControlledFixture = (
  scenarioId: string
): DashboardDomainControlledScenarioFixture | undefined => {
  if (!Object.prototype.hasOwnProperty.call(controlledScenarioFixtures, scenarioId)) return undefined
  return controlledScenarioFixtures[scenarioId as DashboardDomainControlledScenarioId]
}

/**
 * Build a QueryEngine whose only source is the selected controlled fixture.
 * The source object is deliberately per-request so QueryEngine caches cannot
 * share snapshots with the user's real AppDatabase.
 */
export const createDashboardDomainControlledScenarioContext = (
  scenarioId: string
): DashboardDomainControlledScenarioContext | undefined => {
  const fixture = getDashboardDomainControlledFixture(scenarioId)
  if (!fixture) return undefined
  return {
    fixture,
    queryEngine: new QueryEngine(createFixtureDatabase(fixture))
  }
}

/**
 * Resolve the query engine that owns a dashboard's query contract. Controlled
 * samples must never be revalidated against the user's live database: their
 * fields and records intentionally live in an isolated fixture.
 *
 * The title/subtitle/presentation checks keep dashboards created before the
 * explicit domainContext.dataMode field backward compatible.
 */
export const dashboardDomainDataMode = (
  spec: Pick<DashboardSpec, 'title' | 'subtitle' | 'domainContext' | 'presentation'>
): 'controlled-sample' | 'platform-adapter' | undefined => {
  if (spec.domainContext?.dataMode) return spec.domainContext.dataMode
  const legacyLabel = [
    spec.title,
    spec.subtitle,
    spec.presentation?.kind === 'gjb5000b-compliance'
      ? spec.presentation.dataModeLabel
      : ''
  ].join(' ')
  if (/(受控样例|controlled sample)/i.test(legacyLabel)) return 'controlled-sample'
  if (/(平台数据预览|platform adapter|mapped data)/i.test(legacyLabel)) return 'platform-adapter'
  return undefined
}

export const createDashboardQueryEngineForSpec = (
  spec: DashboardSpec,
  database: AppDatabase
): QueryEngine => {
  if (dashboardDomainDataMode(spec) === 'controlled-sample') {
    const scenarioId = spec.domainContext?.scenario?.trim()
    const controlledContext = scenarioId
      ? createDashboardDomainControlledScenarioContext(scenarioId)
      : undefined
    if (controlledContext) return controlledContext.queryEngine
  }
  return new QueryEngine(database)
}
