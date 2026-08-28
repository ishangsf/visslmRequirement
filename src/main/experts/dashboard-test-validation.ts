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
  nodeType: 'TestValidationSample',
  itemId,
  name,
  lastModifyTime,
  raw
})

/** Synthetic test evidence split by summary, trend and breakdown semantics. */
const records: readonly AnalyticsRecord[] = [
  baseRecord('sample-test-summary', 'SAMPLE-TV-SUMMARY', '最新测试摘要', '2026-08-15T00:00:00.000Z', {
    testExecutionRate: 0.92,
    testPassRate: 0.88,
    testAutomationRate: 0.63
  }),
  baseRecord('sample-code-coverage-001', 'SAMPLE-TV-CODE-001', '构建 1', '2026-08-01T00:00:00.000Z', { codeCoverageRate: 0.61 }),
  baseRecord('sample-code-coverage-002', 'SAMPLE-TV-CODE-002', '构建 2', '2026-08-08T00:00:00.000Z', { codeCoverageRate: 0.72 }),
  baseRecord('sample-code-coverage-003', 'SAMPLE-TV-CODE-003', '构建 3', '2026-08-15T00:00:00.000Z', { codeCoverageRate: 0.81 }),
  baseRecord('sample-requirement-coverage-001', 'SAMPLE-TV-REQ-001', '核心需求集', '2026-08-15T00:00:00.000Z', { testCoverage: 0.96 }),
  baseRecord('sample-requirement-coverage-002', 'SAMPLE-TV-REQ-002', '接口需求集', '2026-08-15T00:00:00.000Z', { testCoverage: 0.82 }),
  baseRecord('sample-requirement-coverage-003', 'SAMPLE-TV-REQ-003', '安全需求集', '2026-08-15T00:00:00.000Z', { testCoverage: 0.75 }),
  baseRecord('sample-blocked-suite-001', 'SAMPLE-TV-BLOCK-001', '系统测试', '2026-08-15T00:00:00.000Z', { blockedTestCaseCount: 3 }),
  baseRecord('sample-blocked-suite-002', 'SAMPLE-TV-BLOCK-002', '集成测试', '2026-08-15T00:00:00.000Z', { blockedTestCaseCount: 1 }),
  baseRecord('sample-blocked-suite-003', 'SAMPLE-TV-BLOCK-003', '回归测试', '2026-08-15T00:00:00.000Z', { blockedTestCaseCount: 0 })
]

export const testValidationGoldenFixture = {
  role: 'qa-epg' as const,
  scenario: 'test-validation',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: 'QA/EPG 基于受控样例生成测试与验证充分性大屏',
  metricIds: [
    'test-case-execution-rate',
    'test-pass-rate',
    'requirement-test-coverage',
    'code-coverage-rate',
    'test-automation-rate',
    'blocked-test-case-count'
  ] as const,
  componentIds: [
    'test-validation-execution-card',
    'test-validation-pass-card',
    'test-validation-requirement-coverage-card',
    'test-validation-code-coverage-card',
    'test-validation-automation-card',
    'test-validation-blocked-card'
  ] as const,
  records
}

export default testValidationGoldenFixture
