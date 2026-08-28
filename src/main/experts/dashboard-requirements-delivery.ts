import type { AnalyticsRecord } from '../database'

/**
 * Controlled benchmark for the requirements-to-delivery golden scenario.
 * Values are synthetic snapshots, not production evidence or a compliance
 * conclusion.  They exist to keep planning, QuerySpec and rendering behavior
 * deterministic until a verified lifecycle-platform adapter is connected.
 */
const records: readonly AnalyticsRecord[] = [
  {
    uid: 'sample-requirements-delivery-001',
    projectId: 'sample-project-001',
    nodeType: 'RequirementsDeliverySample',
    itemId: 'SAMPLE-RD-001',
    name: '需求基线 B1',
    lastModifyTime: '2026-08-01T00:00:00.000Z',
    raw: {
      requirementStability: 0.82,
      reviewCompletion: 0.76,
      requirementChangeRate: 0.18,
      developmentCompletion: 0.58,
      testCoverage: 0.44,
      traceabilityCompleteness: 0.61
    }
  },
  {
    uid: 'sample-requirements-delivery-002',
    projectId: 'sample-project-001',
    nodeType: 'RequirementsDeliverySample',
    itemId: 'SAMPLE-RD-002',
    name: '需求基线 B2',
    lastModifyTime: '2026-08-08T00:00:00.000Z',
    raw: {
      requirementStability: 0.88,
      reviewCompletion: 0.9,
      requirementChangeRate: 0.12,
      developmentCompletion: 0.72,
      testCoverage: 0.68,
      traceabilityCompleteness: 0.79
    }
  },
  {
    uid: 'sample-requirements-delivery-003',
    projectId: 'sample-project-001',
    nodeType: 'RequirementsDeliverySample',
    itemId: 'SAMPLE-RD-003',
    name: '需求基线 B3',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      requirementStability: 0.93,
      reviewCompletion: 0.96,
      requirementChangeRate: 0.07,
      developmentCompletion: 0.86,
      testCoverage: 0.91,
      traceabilityCompleteness: 0.94
    }
  }
]

export const requirementsDeliveryGoldenFixture = {
  role: 'project-owner' as const,
  scenario: 'requirements-delivery',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: '项目负责人基于受控样例生成需求到交付全链路大屏',
  metricIds: [
    'requirement-stability',
    'requirement-review-completion',
    'requirement-change-rate',
    'development-completion',
    'requirement-test-coverage',
    'bidirectional-traceability'
  ] as const,
  componentIds: [
    'requirements-delivery-stability-card',
    'requirements-delivery-review-card',
    'requirements-delivery-change-card',
    'requirements-delivery-development-card',
    'requirements-delivery-test-card',
    'requirements-delivery-trace-card'
  ] as const,
  records
}

export default requirementsDeliveryGoldenFixture
