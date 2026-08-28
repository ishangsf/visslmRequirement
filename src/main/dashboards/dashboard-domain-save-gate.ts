import type { DashboardSpec } from '../../shared/dashboard'
import type { QueryEngine } from '../analytics/query-engine'
import { diagnoseDashboard } from './diagnostics'
import {
  evaluateDashboardDomainQualityGate,
  type DashboardDomainQualityGateResult
} from './dashboard-domain-quality'

export interface DashboardDomainSaveGateResult {
  allowed: boolean
  status: DashboardDomainQualityGateResult['status'] | 'legacy'
  score: number
  reasons: readonly string[]
}

/**
 * Apply the catalog-owned quality policy at the persistence boundary. Legacy
 * dashboards deliberately bypass this domain gate; dashboards carrying a
 * domain context are scored and matched against their declared artifact
 * status before a caller writes them.
 */
export const evaluateDashboardDomainSaveGate = (
  spec: DashboardSpec,
  queryEngine: QueryEngine
): DashboardDomainSaveGateResult => {
  if (!spec.domainContext) {
    return {
      allowed: true,
      status: 'legacy',
      score: 100,
      reasons: ['legacy dashboard：未声明领域上下文，保持兼容保存。']
    }
  }

  const report = diagnoseDashboard(spec, queryEngine)
  const gate = evaluateDashboardDomainQualityGate({
    score: report.score,
    vetoCodes: spec.domainReceipt?.vetoCodes ?? []
  })
  const reasons: string[] = [
    ...report.issues.map((issue) => `${issue.code}: ${issue.message}`),
    ...gate.reasons
  ]

  const artifactStatus = spec.domainContext.artifactStatus
  let allowed = false
  if (artifactStatus === 'formal') {
    allowed = gate.status === 'formal'
    if (!allowed) {
      reasons.push(`artifactStatus=formal 与质量门禁状态 ${gate.status} 不匹配，正式保存被阻断。`)
    }
  } else if (artifactStatus === 'preview') {
    allowed = gate.status === 'preview' || gate.status === 'formal'
    if (!allowed) {
      reasons.push(`artifactStatus=preview 与质量门禁状态 ${gate.status} 不匹配，预览保存被阻断。`)
    }
  } else {
    reasons.push(`artifactStatus=${String(artifactStatus)} 不是受支持的 formal/preview 状态。`)
  }

  return {
    allowed,
    status: gate.status,
    score: gate.score,
    reasons: [...new Set(reasons)]
  }
}

export default evaluateDashboardDomainSaveGate
