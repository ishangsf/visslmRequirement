import type { AnalyticsRecord } from '../database'

/** Deterministic, synthetic snapshots for the plan/milestone golden scene. */
const records: readonly AnalyticsRecord[] = [
  {
    uid: 'sample-plan-milestone-001',
    projectId: 'sample-project-001',
    nodeType: 'PlanMilestoneSample',
    itemId: 'SAMPLE-PM-001',
    name: '方案评审里程碑',
    lastModifyTime: '2026-08-01T00:00:00.000Z',
    raw: {
      planCompletionRate: 0.64,
      scheduleVarianceDays: 9,
      delayedTaskCount: 5,
      criticalPathRiskScore: 0.88,
      milestoneForecastDelayDays: 12
    }
  },
  {
    uid: 'sample-plan-milestone-002',
    projectId: 'sample-project-001',
    nodeType: 'PlanMilestoneSample',
    itemId: 'SAMPLE-PM-002',
    name: '测试准入里程碑',
    lastModifyTime: '2026-08-08T00:00:00.000Z',
    raw: {
      planCompletionRate: 0.76,
      scheduleVarianceDays: 6,
      delayedTaskCount: 3,
      criticalPathRiskScore: 0.72,
      milestoneForecastDelayDays: 7
    }
  },
  {
    uid: 'sample-plan-milestone-003',
    projectId: 'sample-project-001',
    nodeType: 'PlanMilestoneSample',
    itemId: 'SAMPLE-PM-003',
    name: '发布评审里程碑',
    lastModifyTime: '2026-08-15T00:00:00.000Z',
    raw: {
      planCompletionRate: 0.85,
      scheduleVarianceDays: 3,
      delayedTaskCount: 2,
      criticalPathRiskScore: 0.58,
      milestoneForecastDelayDays: 3
    }
  }
]

export const planMilestoneGoldenFixture = {
  role: 'project-owner' as const,
  scenario: 'plan-milestone',
  projectId: 'sample-project-001',
  tailoringBaselineId: 'sample-tailoring-baseline-v1',
  generatedAt: '2026-08-28T00:00:00.000Z',
  request: '项目负责人基于受控样例生成计划与里程碑执行大屏',
  metricIds: [
    'plan-completion-rate',
    'schedule-variance-days',
    'delayed-task-count',
    'critical-path-risk-score',
    'milestone-forecast-delay-days'
  ] as const,
  componentIds: [
    'plan-milestone-completion-card',
    'plan-milestone-delayed-card',
    'plan-milestone-variance-card',
    'plan-milestone-critical-path-card',
    'plan-milestone-forecast-card'
  ] as const,
  records
}

export default planMilestoneGoldenFixture
