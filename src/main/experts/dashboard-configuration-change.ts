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
  nodeType: 'ConfigurationChangeSample',
  itemId,
  name,
  lastModifyTime,
  raw
})

/** Synthetic configuration evidence split by summary, trend and breakdown semantics. */
const records: readonly AnalyticsRecord[] = [
  baseRecord('sample-configuration-summary', 'SAMPLE-CC-SUMMARY', '最新配置状态', '2026-08-15T00:00:00.000Z', {
    configurationItemControlRate: 0.94,
    baselineCompletenessRate: 0.91
  }),
  baseRecord('sample-change-set-001', 'SAMPLE-CC-APPROVAL-001', '需求变更集', '2026-08-15T00:00:00.000Z', { changeApprovalRate: 1 }),
  baseRecord('sample-change-set-002', 'SAMPLE-CC-APPROVAL-002', '设计变更集', '2026-08-15T00:00:00.000Z', { changeApprovalRate: 0.88 }),
  baseRecord('sample-change-set-003', 'SAMPLE-CC-APPROVAL-003', '代码变更集', '2026-08-15T00:00:00.000Z', { changeApprovalRate: 0.96 }),
  baseRecord('sample-change-snapshot-001', 'SAMPLE-CC-OPEN-001', '变更快照 1', '2026-08-01T00:00:00.000Z', { openChangeCount: 12 }),
  baseRecord('sample-change-snapshot-002', 'SAMPLE-CC-OPEN-002', '变更快照 2', '2026-08-08T00:00:00.000Z', { openChangeCount: 8 }),
  baseRecord('sample-change-snapshot-003', 'SAMPLE-CC-OPEN-003', '变更快照 3', '2026-08-15T00:00:00.000Z', { openChangeCount: 5 }),
  baseRecord('sample-reproducible-build-001', 'SAMPLE-CC-BUILD-001', '发布构建 A', '2026-08-15T00:00:00.000Z', { reproducibleBuildRate: 1 }),
  baseRecord('sample-reproducible-build-002', 'SAMPLE-CC-BUILD-002', '发布构建 B', '2026-08-15T00:00:00.000Z', { reproducibleBuildRate: 0.8 }),
  baseRecord('sample-reproducible-build-003', 'SAMPLE-CC-BUILD-003', '发布构建 C', '2026-08-15T00:00:00.000Z', { reproducibleBuildRate: 0.6 })
]

export const configurationChangeGoldenFixture = {
  role: 'rd-lead' as const,
  scenario: 'configuration-change',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: '研发负责人基于受控样例生成配置管理与变更控制大屏',
  metricIds: [
    'configuration-item-control-rate',
    'baseline-completeness-rate',
    'change-approval-rate',
    'open-change-count',
    'reproducible-build-rate'
  ] as const,
  componentIds: [
    'configuration-change-item-control-card',
    'configuration-change-baseline-card',
    'configuration-change-approval-card',
    'configuration-change-open-trend-card',
    'configuration-change-reproducible-build-card'
  ] as const,
  records
}

export default configurationChangeGoldenFixture
