import type { DataScope } from '../../shared/query-spec'
import type { DashboardDomainRole, DashboardScenarioStatus } from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from './dashboard-domain-catalog'

export interface DashboardDomainSelection {
  scenario: string
  role?: DashboardDomainRole
  tailoringBaselineId?: string
}
export interface DashboardDomainRequestResult {
  recognized: boolean
  role?: DashboardDomainRole
  scenario?: string
  scenarioStatus?: DashboardScenarioStatus
  tailoringBaselineId?: string
  permissions?: readonly string[]
  provenance?: { source: 'local-single-user-policy' }
  request: string
  scope: DataScope
}

/** Compiles an explicit UI/model selection; never classifies natural-language keywords. */
export const resolveDashboardDomainRequest = (
  question: string, scope: DataScope, selection?: DashboardDomainSelection
): DashboardDomainRequestResult => {
  if (!selection) return { recognized: false, request: question, scope: { ...scope } }
  const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === selection.scenario)
  if (!scenario) throw new Error('业务场景不在已注册目录内')
  if (selection.role && !['project-owner', 'qa-epg', 'rd-lead', 'model-org-manager'].includes(selection.role)) throw new Error('业务角色无效')
  return {
    recognized: true, request: question, scope: { ...scope }, scenario: scenario.id, scenarioStatus: scenario.status,
    ...(selection.role ? { role: selection.role } : {}),
    ...(selection.tailoringBaselineId ? { tailoringBaselineId: selection.tailoringBaselineId } : {}),
    permissions: ['project:read', 'process:evidence:read'], provenance: { source: 'local-single-user-policy' }
  }
}
