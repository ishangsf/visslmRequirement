import type { AnalyticsRecord } from '../database'

const baseRecord = (
  uid: string,
  itemId: string,
  name: string,
  lastModifyTime: string,
  raw: Record<string, number>
): AnalyticsRecord => ({
  uid,
  projectId: 'sample-project-001',
  nodeType: 'OrganizationImprovementSample',
  itemId,
  name,
  lastModifyTime,
  raw
})

/** Synthetic organization-level measurements split by summary, trend and comparison semantics. */
const records: readonly AnalyticsRecord[] = [
  baseRecord('sample-organization-summary', 'SAMPLE-OI-SUMMARY', '最新组织度量摘要', '2026-08-15T00:00:00.000Z', {
    qualityDispersionScore: 0.42,
    estimationDeviationRate: 0.21,
    improvementCompletionRate: 0.78
  }),
  baseRecord('sample-productivity-project-001', 'SAMPLE-OI-PROD-001', '项目 Alpha', '2026-08-15T00:00:00.000Z', { productivityIndex: 1.08 }),
  baseRecord('sample-productivity-project-002', 'SAMPLE-OI-PROD-002', '项目 Beta', '2026-08-15T00:00:00.000Z', { productivityIndex: 0.91 }),
  baseRecord('sample-productivity-project-003', 'SAMPLE-OI-PROD-003', '项目 Gamma', '2026-08-15T00:00:00.000Z', { productivityIndex: 0.76 }),
  baseRecord('sample-defect-escape-001', 'SAMPLE-OI-ESCAPE-001', '质量周期 1', '2026-08-01T00:00:00.000Z', { defectEscapeRate: 0.13 }),
  baseRecord('sample-defect-escape-002', 'SAMPLE-OI-ESCAPE-002', '质量周期 2', '2026-08-08T00:00:00.000Z', { defectEscapeRate: 0.09 }),
  baseRecord('sample-defect-escape-003', 'SAMPLE-OI-ESCAPE-003', '质量周期 3', '2026-08-15T00:00:00.000Z', { defectEscapeRate: 0.06 }),
  baseRecord('sample-baseline-group-001', 'SAMPLE-OI-BASE-001', '研发过程基线组', '2026-08-15T00:00:00.000Z', { baselineStabilityRate: 0.94 }),
  baseRecord('sample-baseline-group-002', 'SAMPLE-OI-BASE-002', '质量度量基线组', '2026-08-15T00:00:00.000Z', { baselineStabilityRate: 0.86 }),
  baseRecord('sample-baseline-group-003', 'SAMPLE-OI-BASE-003', '项目估算基线组', '2026-08-15T00:00:00.000Z', { baselineStabilityRate: 0.72 })
]

export const organizationImprovementGoldenFixture = {
  role: 'model-org-manager' as const,
  scenario: 'organization-improvement',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: '型号组织管理负责人基于受控样例生成组织级度量与过程改进大屏',
  metricIds: [
    'project-quality-dispersion-score',
    'estimation-deviation-rate',
    'delivery-productivity-index',
    'defect-escape-rate',
    'process-improvement-completion-rate',
    'organizational-baseline-stability-rate'
  ] as const,
  componentIds: [
    'organization-improvement-quality-dispersion-card',
    'organization-improvement-estimation-card',
    'organization-improvement-productivity-card',
    'organization-improvement-defect-escape-card',
    'organization-improvement-completion-card',
    'organization-improvement-baseline-card'
  ] as const,
  records
}

export default organizationImprovementGoldenFixture
