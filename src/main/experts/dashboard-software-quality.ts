import type { AnalyticsRecord } from '../database'

/** Synthetic quality snapshots for deterministic defect-closure acceptance. */
const records: readonly AnalyticsRecord[] = [
  {
    uid: 'sample-software-quality-summary',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-SUMMARY',
    name: '最新质量摘要',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      criticalDefectCount: 1,
      defectReopenRate: 0.04
    }
  },
  {
    uid: 'sample-software-quality-trend-001',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-TREND-001',
    name: '质量快照 1',
    lastModifyTime: '2026-08-01T00:00:00.000Z',
    raw: { openDefectCount: 18 }
  },
  {
    uid: 'sample-software-quality-trend-002',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-TREND-002',
    name: '质量快照 2',
    lastModifyTime: '2026-08-08T00:00:00.000Z',
    raw: { openDefectCount: 12 }
  },
  {
    uid: 'sample-software-quality-trend-003',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-TREND-003',
    name: '质量快照 3',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: { openDefectCount: 7 }
  },
  {
    uid: 'sample-software-quality-module-001',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-MODULE-001',
    name: '核心服务模块',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      defectDensity: 0.14,
      meanRepairHours: 72,
      residualDefectRiskScore: 0.84
    }
  },
  {
    uid: 'sample-software-quality-module-002',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-MODULE-002',
    name: '数据处理模块',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      defectDensity: 0.09,
      meanRepairHours: 49,
      residualDefectRiskScore: 0.66
    }
  },
  {
    uid: 'sample-software-quality-module-003',
    projectId: 'sample-project-001',
    nodeType: 'SoftwareQualitySample',
    itemId: 'SAMPLE-SQ-MODULE-003',
    name: '桌面交互模块',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      defectDensity: 0.05,
      meanRepairHours: 31,
      residualDefectRiskScore: 0.42
    }
  }
]

export const softwareQualityGoldenFixture = {
  role: 'qa-epg' as const,
  scenario: 'software-quality',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: 'QA/EPG 基于受控样例生成软件质量与缺陷闭环大屏',
  metricIds: [
    'critical-defect-count',
    'defect-reopen-rate',
    'defect-density',
    'open-defect-count',
    'mean-defect-repair-hours',
    'residual-defect-risk-score'
  ] as const,
  componentIds: [
    'software-quality-critical-card',
    'software-quality-reopen-card',
    'software-quality-density-card',
    'software-quality-trend-card',
    'software-quality-repair-card',
    'software-quality-residual-risk-card'
  ] as const,
  records
}

export default softwareQualityGoldenFixture
