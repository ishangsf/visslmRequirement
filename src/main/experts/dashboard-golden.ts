import type { DashboardComponentSpec, DashboardSpec } from '../../shared/dashboard'
import type { AnalyticsRecord } from '../database'

export interface DashboardGoldenScenario {
  id: string
  name: string
  description: string
  records: AnalyticsRecord[]
  spec: DashboardSpec
}

const component = (
  id: string,
  type: DashboardComponentSpec['type'],
  title: string,
  layout: DashboardComponentSpec['layout'],
  query: NonNullable<DashboardComponentSpec['query']>,
  encoding: NonNullable<DashboardComponentSpec['encoding']>,
  accent: string
): DashboardComponentSpec => ({
  id,
  type,
  title,
  layout,
  data: [],
  query,
  encoding,
  accent
})

const releaseQualityRecords: AnalyticsRecord[] = [
  ['1', 'open', 'P0', 'R1', '2026-04-03', 8],
  ['2', 'closed', 'P1', 'R1', '2026-04-10', 3],
  ['3', 'open', 'P1', 'R1', '2026-04-17', 5],
  ['4', 'in-progress', 'P2', 'R1', '2026-04-24', 2],
  ['5', 'closed', 'P0', 'R2', '2026-05-01', 13],
  ['6', 'open', 'P1', 'R2', '2026-05-08', 5],
  ['7', 'closed', 'P2', 'R2', '2026-05-15', 3],
  ['8', 'open', 'P0', 'R2', '2026-05-22', 8],
  ['9', 'closed', 'P1', 'R3', '2026-05-29', 2],
  ['10', 'in-progress', 'P1', 'R3', '2026-06-05', 8],
  ['11', 'open', 'P2', 'R3', '2026-06-12', 3],
  ['12', 'closed', 'P0', 'R3', '2026-06-19', 13]
].map(([id, status, severity, release, updatedAt, effort]) => ({
  uid: `issue-${id}`,
  projectId: 'project-alpha',
  nodeType: 'Issue',
  itemId: `ISSUE-${id}`,
  name: `脱敏缺陷 ${id}`,
  lastModifyTime: `${updatedAt}T10:00:00Z`,
  raw: { status, severity, release, updatedAt: `${updatedAt}T10:00:00Z`, effort }
}))

const deliveryRecords: AnalyticsRecord[] = [
  ['1', 'done', '团队 A', '2026-04-04', 5],
  ['2', 'in-progress', '团队 A', '2026-04-11', 8],
  ['3', 'blocked', '团队 B', '2026-04-18', 13],
  ['4', 'done', '团队 B', '2026-04-25', 3],
  ['5', 'in-progress', '团队 C', '2026-05-02', 8],
  ['6', 'done', '团队 C', '2026-05-09', 5],
  ['7', 'blocked', '团队 A', '2026-05-16', 13],
  ['8', 'done', '团队 B', '2026-05-23', 3],
  ['9', 'in-progress', '团队 C', '2026-05-30', 8],
  ['10', 'done', '团队 A', '2026-06-06', 5]
].map(([id, status, owner, dueDate, estimate]) => ({
  uid: `task-${id}`,
  projectId: 'project-beta',
  nodeType: 'Task',
  itemId: `TASK-${id}`,
  name: `脱敏任务 ${id}`,
  lastModifyTime: `${dueDate}T09:00:00Z`,
  raw: { status, owner, dueDate: `${dueDate}T09:00:00Z`, estimate }
}))

const projectHealthRecords: AnalyticsRecord[] = [
  ['1', '项目甲', '低', '负责人甲', '2026-05-01', 92],
  ['2', '项目乙', '中', '负责人乙', '2026-05-08', 78],
  ['3', '项目丙', '高', '负责人丙', '2026-05-15', 61],
  ['4', '项目丁', '低', '负责人甲', '2026-05-22', 88],
  ['5', '项目戊', '中', '负责人乙', '2026-05-29', 74],
  ['6', '项目己', '高', '负责人丙', '2026-06-05', 55]
].map(([id, name, risk, owner, updatedAt, score]) => ({
  uid: `project-${id}`,
  projectId: `project-${id}`,
  nodeType: 'Project',
  itemId: `PROJECT-${id}`,
  name: String(name),
  lastModifyTime: `${updatedAt}T08:00:00Z`,
  raw: { projectName: name, risk, owner, updatedAt: `${updatedAt}T08:00:00Z`, healthScore: score }
}))

const releaseQualitySpec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'golden-release-quality',
  title: '研发质量驾驶舱',
  subtitle: '脱敏发布质量样例',
  businessContext: {
    audience: '项目经理',
    objective: '跟踪缺陷分布与最近趋势',
    scopeDescription: '脱敏项目 Alpha 的 Issue 数据'
  },
  theme: 'technology-dark',
  updatedAt: '2026-07-31T00:00:00.000Z',
  components: [
    component('release-total', 'kpi', '缺陷总数', { x: 0, y: 0, w: 6, h: 2 }, {
      source: 'records', scope: { projectIds: ['project-alpha'], nodeTypes: ['Issue'] },
      measures: [{ id: 'records', aggregation: 'count' }]
    }, { value: 'records' }, '#64dbff'),
    component('release-trend', 'line', '缺陷周趋势', { x: 6, y: 0, w: 10, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-alpha'], nodeTypes: ['Issue'] },
      dimensions: [{ field: 'updatedAt', timeGrain: 'week' }],
      measures: [{ id: 'records', aggregation: 'count' }], limit: 12
    }, { label: 'updatedAt', value: 'records' }, '#50dda4'),
    component('release-severity', 'bar', '严重级别分布', { x: 16, y: 0, w: 8, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-alpha'], nodeTypes: ['Issue'] },
      dimensions: [{ field: 'severity' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'severity', value: 'records' }, '#ffc568'),
    component('release-version', 'pie', '发布版本构成', { x: 0, y: 5, w: 12, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-alpha'], nodeTypes: ['Issue'] },
      dimensions: [{ field: 'release' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'release', value: 'records' }, '#8d7cff'),
    component('release-status', 'table', '状态核查', { x: 12, y: 5, w: 12, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-alpha'], nodeTypes: ['Issue'] },
      dimensions: [{ field: 'status' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'status', value: 'records' }, '#ff7f9d')
  ]
}

const deliverySpec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'golden-delivery-progress',
  title: '交付进度驾驶舱',
  subtitle: '脱敏任务交付样例',
  businessContext: {
    audience: '交付负责人',
    objective: '观察任务状态、团队负载与截止趋势',
    scopeDescription: '脱敏项目 Beta 的 Task 数据'
  },
  theme: 'minimal-light',
  updatedAt: '2026-07-31T00:00:00.000Z',
  components: [
    component('delivery-total', 'kpi', '任务总数', { x: 0, y: 0, w: 6, h: 2 }, {
      source: 'records', scope: { projectIds: ['project-beta'], nodeTypes: ['Task'] },
      measures: [{ id: 'records', aggregation: 'count' }]
    }, { value: 'records' }, '#287f86'),
    component('delivery-status', 'bar', '任务状态', { x: 6, y: 0, w: 8, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-beta'], nodeTypes: ['Task'] },
      dimensions: [{ field: 'status' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'status', value: 'records' }, '#3475b5'),
    component('delivery-owner', 'ranking', '团队任务排行', { x: 14, y: 0, w: 10, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-beta'], nodeTypes: ['Task'] },
      dimensions: [{ field: 'owner' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'owner', value: 'records' }, '#5b8def'),
    component('delivery-trend', 'line', '截止日期趋势', { x: 0, y: 5, w: 14, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-beta'], nodeTypes: ['Task'] },
      dimensions: [{ field: 'dueDate', timeGrain: 'week' }], measures: [{ id: 'records', aggregation: 'count' }], limit: 12
    }, { label: 'dueDate', value: 'records' }, '#50a89c'),
    component('delivery-estimate', 'table', '工时核查', { x: 14, y: 5, w: 10, h: 5 }, {
      source: 'records', scope: { projectIds: ['project-beta'], nodeTypes: ['Task'] },
      dimensions: [{ field: 'owner' }], measures: [{ id: 'estimate', field: 'estimate', aggregation: 'sum' }], limit: 10
    }, { label: 'owner', value: 'estimate' }, '#d38b3c')
  ]
}

const projectHealthSpec: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'golden-project-health',
  title: '项目健康度总览',
  subtitle: '脱敏项目组合样例',
  businessContext: {
    audience: '项目组合负责人',
    objective: '识别风险项目并比较健康度',
    scopeDescription: '脱敏项目级记录'
  },
  theme: 'charcoal-dark',
  updatedAt: '2026-07-31T00:00:00.000Z',
  components: [
    component('health-total', 'kpi', '项目总数', { x: 0, y: 0, w: 6, h: 2 }, {
      source: 'records', scope: { nodeTypes: ['Project'] }, measures: [{ id: 'records', aggregation: 'count' }]
    }, { value: 'records' }, '#e0b36f'),
    component('health-score', 'bar', '项目健康度', { x: 6, y: 0, w: 10, h: 5 }, {
      source: 'records', scope: { nodeTypes: ['Project'] }, dimensions: [{ field: 'projectName' }],
      measures: [{ id: 'healthScore', field: 'healthScore', aggregation: 'avg' }], limit: 10
    }, { label: 'projectName', value: 'healthScore' }, '#d7a45f'),
    component('health-risk', 'pie', '风险等级构成', { x: 16, y: 0, w: 8, h: 5 }, {
      source: 'records', scope: { nodeTypes: ['Project'] }, dimensions: [{ field: 'risk' }],
      measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'risk', value: 'records' }, '#b57c5f'),
    component('health-owner', 'ranking', '负责人项目数', { x: 0, y: 5, w: 12, h: 5 }, {
      source: 'records', scope: { nodeTypes: ['Project'] }, dimensions: [{ field: 'owner' }],
      measures: [{ id: 'records', aggregation: 'count' }], limit: 10
    }, { label: 'owner', value: 'records' }, '#c59662'),
    component('health-trend', 'line', '项目更新时间', { x: 12, y: 5, w: 12, h: 5 }, {
      source: 'records', scope: { nodeTypes: ['Project'] }, dimensions: [{ field: 'updatedAt', timeGrain: 'month' }],
      measures: [{ id: 'records', aggregation: 'count' }], limit: 12
    }, { label: 'updatedAt', value: 'records' }, '#9cbbb1')
  ]
}

export const dashboardGoldenScenarios: DashboardGoldenScenario[] = [
  {
    id: 'release-quality',
    name: '研发质量驾驶舱',
    description: '缺陷状态、严重级别、发布版本和周趋势',
    records: releaseQualityRecords,
    spec: releaseQualitySpec
  },
  {
    id: 'delivery-progress',
    name: '交付进度驾驶舱',
    description: '任务状态、团队负载、截止趋势和工时',
    records: deliveryRecords,
    spec: deliverySpec
  },
  {
    id: 'project-health',
    name: '项目健康度总览',
    description: '组合风险、健康度、负责人和更新时间',
    records: projectHealthRecords,
    spec: projectHealthSpec
  }
]
