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
  nodeType: 'Gjb5000bComplianceSample',
  itemId,
  name,
  lastModifyTime,
  raw
})

/** Synthetic internal process-audit evidence; it is not an official compliance conclusion. */
const records: readonly AnalyticsRecord[] = [
  baseRecord('sample-compliance-summary', 'SAMPLE-GJB-SUMMARY', '最新内部检查摘要', '2026-08-15T00:00:00.000Z', {
    activityExecutionRate: 0.89,
    workProductCompletenessRate: 0.86
  }),
  baseRecord('sample-evidence-domain-001', 'SAMPLE-GJB-EVIDENCE-001', '项目策划过程域', '2026-08-15T00:00:00.000Z', { evidenceSufficiencyRate: 0.92 }),
  baseRecord('sample-evidence-domain-002', 'SAMPLE-GJB-EVIDENCE-002', '需求开发过程域', '2026-08-15T00:00:00.000Z', { evidenceSufficiencyRate: 0.81 }),
  baseRecord('sample-evidence-domain-003', 'SAMPLE-GJB-EVIDENCE-003', '技术解决过程域', '2026-08-15T00:00:00.000Z', { evidenceSufficiencyRate: 0.78 }),
  baseRecord('sample-evidence-domain-004', 'SAMPLE-GJB-EVIDENCE-004', '验证确认过程域', '2026-08-15T00:00:00.000Z', { evidenceSufficiencyRate: 0.84 }),
  baseRecord('sample-evidence-domain-005', 'SAMPLE-GJB-EVIDENCE-005', '配置管理过程域', '2026-08-15T00:00:00.000Z', { evidenceSufficiencyRate: 0.57 }),
  baseRecord('sample-deviation-snapshot-001', 'SAMPLE-GJB-DEV-001', '检查快照 1', '2026-07-11T00:00:00.000Z', { processDeviationCount: 12 }),
  baseRecord('sample-deviation-snapshot-002', 'SAMPLE-GJB-DEV-002', '检查快照 2', '2026-07-18T00:00:00.000Z', { processDeviationCount: 9 }),
  baseRecord('sample-deviation-snapshot-003', 'SAMPLE-GJB-DEV-003', '检查快照 3', '2026-07-25T00:00:00.000Z', { processDeviationCount: 7 }),
  baseRecord('sample-deviation-snapshot-004', 'SAMPLE-GJB-DEV-004', '检查快照 4', '2026-08-01T00:00:00.000Z', { processDeviationCount: 6 }),
  baseRecord('sample-deviation-snapshot-005', 'SAMPLE-GJB-DEV-005', '检查快照 5', '2026-08-08T00:00:00.000Z', { processDeviationCount: 5 }),
  baseRecord('sample-deviation-snapshot-006', 'SAMPLE-GJB-DEV-006', '检查快照 6', '2026-08-15T00:00:00.000Z', { processDeviationCount: 4 }),
  baseRecord('sample-nonconformity-domain-001', 'SAMPLE-GJB-NC-001', '项目策划过程域', '2026-08-15T00:00:00.000Z', { nonconformityClosureRate: 1 }),
  baseRecord('sample-nonconformity-domain-002', 'SAMPLE-GJB-NC-002', '需求开发过程域', '2026-08-15T00:00:00.000Z', { nonconformityClosureRate: 0.83 }),
  baseRecord('sample-nonconformity-domain-003', 'SAMPLE-GJB-NC-003', '技术解决过程域', '2026-08-15T00:00:00.000Z', { nonconformityClosureRate: 0.78 }),
  baseRecord('sample-nonconformity-domain-004', 'SAMPLE-GJB-NC-004', '验证确认过程域', '2026-08-15T00:00:00.000Z', { nonconformityClosureRate: 0.84 }),
  baseRecord('sample-nonconformity-domain-005', 'SAMPLE-GJB-NC-005', '配置管理过程域', '2026-08-15T00:00:00.000Z', { nonconformityClosureRate: 0.57 })
]

export const gjb5000bComplianceGoldenFixture = {
  role: 'qa-epg' as const,
  scenario: 'gjb5000b-compliance',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: 'QA/EPG 基于受控样例生成 GJB5000B 过程符合度与证据审计大屏',
  metricIds: [
    'process-activity-execution-rate',
    'work-product-completeness-rate',
    'evidence-sufficiency-rate',
    'process-deviation-count',
    'nonconformity-closure-rate'
  ] as const,
  componentIds: [
    'gjb5000b-compliance-activity-card',
    'gjb5000b-compliance-work-product-card',
    'gjb5000b-compliance-evidence-card',
    'gjb5000b-compliance-deviation-card',
    'gjb5000b-compliance-nonconformity-card'
  ] as const,
  records
}

export default gjb5000bComplianceGoldenFixture
