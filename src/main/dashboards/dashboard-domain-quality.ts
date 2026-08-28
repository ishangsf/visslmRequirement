import type {
  DashboardQualityVetoCode,
  DashboardQualityPolicy
} from '../../shared/dashboard-domain'
import { dashboardDomainCatalog } from '../experts/dashboard-domain-catalog'

export type DashboardDomainQualityStatus = 'formal' | 'preview' | 'rejected'

export interface DashboardDomainQualityGateInput {
  score: number
  vetoCodes: readonly string[]
}

export interface DashboardDomainQualityGateResult {
  status: DashboardDomainQualityStatus
  score: number
  reasons: readonly string[]
  vetoCodes: readonly string[]
  policy: Pick<DashboardQualityPolicy, 'formalAcceptanceThreshold' | 'previewThreshold'>
}

const supportedVetoCodes = (
  policy: DashboardQualityPolicy,
  vetoCodes: readonly string[]
): DashboardQualityVetoCode[] => [...new Set(vetoCodes)]
  .filter((code): code is DashboardQualityVetoCode =>
    policy.vetoCodes.includes(code as DashboardQualityVetoCode)
  )

/**
 * Applies the catalog-owned quality policy to a computed score. The evaluator
 * intentionally owns no second copy of weights or thresholds: changing the
 * policy in the domain catalog changes this decision contract as one unit.
 */
export const evaluateDashboardDomainQualityGate = (
  input: DashboardDomainQualityGateInput
): DashboardDomainQualityGateResult => {
  const policy = dashboardDomainCatalog.qualityPolicy
  const policyView = {
    formalAcceptanceThreshold: policy.formalAcceptanceThreshold,
    previewThreshold: policy.previewThreshold
  }
  const rawScore = input && typeof input.score === 'number' ? input.score : Number.NaN
  if (!Number.isFinite(rawScore)) {
    return {
      status: 'rejected',
      score: 0,
      reasons: ['score-invalid: score 必须是有限数字'],
      vetoCodes: [],
      policy: policyView
    }
  }

  const score = Math.min(100, Math.max(0, rawScore))
  const reasons: string[] = []
  if (score !== rawScore) {
    reasons.push(`score-clamped: ${rawScore} -> ${score}`)
  }
  const requestedVetoCodes = Array.isArray(input.vetoCodes) ? input.vetoCodes : []
  const vetoCodes = supportedVetoCodes(policy, requestedVetoCodes)
  const unsupportedVetoCodes = [...new Set(requestedVetoCodes)]
    .filter((code) => !policy.vetoCodes.includes(code as DashboardQualityVetoCode))
  if (unsupportedVetoCodes.length) {
    reasons.push(`unsupported-veto-ignored: ${unsupportedVetoCodes.join(',')}`)
  }
  if (vetoCodes.length) {
    reasons.push(`veto: ${vetoCodes.join(',')}`)
    return {
      status: 'rejected',
      score,
      reasons,
      vetoCodes,
      policy: policyView
    }
  }
  if (score >= policy.formalAcceptanceThreshold) {
    reasons.push(`score-${score}>=formal-${policy.formalAcceptanceThreshold}`)
    return { status: 'formal', score, reasons, vetoCodes, policy: policyView }
  }
  if (score >= policy.previewThreshold) {
    reasons.push(`score-${score}>=preview-${policy.previewThreshold}`)
    return { status: 'preview', score, reasons, vetoCodes, policy: policyView }
  }
  reasons.push(`score-${score}<preview-${policy.previewThreshold}`)
  return { status: 'rejected', score, reasons, vetoCodes, policy: policyView }
}

export default evaluateDashboardDomainQualityGate
