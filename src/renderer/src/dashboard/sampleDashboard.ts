import type { DashboardSpec } from '../../../shared/dashboard'
import type { DashboardStats } from '../../../shared/types'

const fallback = (value: number, alternative: number): number => value || alternative

export const buildSampleDashboard = (stats: DashboardStats): DashboardSpec => {
  const byType = stats.byType.slice(0, 6)
  const byProject = stats.byProject.slice(0, 5)
  const byRelease = stats.byRelease.slice(0, 6)
  const collectedRate = stats.recordCount
    ? Math.round((stats.collectedCount / stats.recordCount) * 100)
    : 0

  return {
    schemaVersion: '1.0',
    id: 'local-overview',
    title: 'VISSLM 数据运营驾驶舱',
    subtitle: '基于本地已采集数据 · 实时概览',
    theme: 'technology-dark',
    updatedAt: new Date().toISOString(),
    components: [
      {
        id: 'record-total',
        type: 'kpi',
        title: '数据记录',
        subtitle: '当前知识库',
        layout: { x: 0, y: 0, w: 6, h: 2 },
        data: [{ name: '记录数', value: stats.recordCount }],
        unit: '条',
        accent: '#69e6ff'
      },
      {
        id: 'project-total',
        type: 'kpi',
        title: '覆盖项目',
        subtitle: '已同步项目',
        layout: { x: 6, y: 0, w: 6, h: 2 },
        data: [{ name: '项目数', value: stats.projectCount }],
        unit: '个',
        accent: '#8b7cff'
      },
      {
        id: 'image-total',
        type: 'kpi',
        title: '图片资产',
        subtitle: '关联附件',
        layout: { x: 12, y: 0, w: 6, h: 2 },
        data: [{ name: '图片数', value: stats.imageCount }],
        unit: '张',
        accent: '#54dfa6'
      },
      {
        id: 'push-total',
        type: 'kpi',
        title: '推送成功',
        subtitle: '平台回写',
        layout: { x: 18, y: 0, w: 6, h: 2 },
        data: [{ name: '推送数', value: stats.pushedCount }],
        unit: '条',
        accent: '#ffc66d'
      },
      {
        id: 'type-distribution',
        type: 'bar',
        title: '数据类型分布',
        subtitle: '按对象类型统计',
        layout: { x: 0, y: 2, w: 10, h: 5 },
        data: byType.length ? byType : [{ name: '暂无分类', value: 0 }],
        accent: '#65d9ff'
      },
      {
        id: 'release-distribution',
        type: 'pie',
        title: '发布版本构成',
        subtitle: '按 Release 字段统计',
        layout: { x: 10, y: 2, w: 7, h: 5 },
        data: byRelease.length ? byRelease : [{ name: '未设置', value: 1 }],
        accent: '#8f7dff'
      },
      {
        id: 'collection-progress',
        type: 'progress',
        title: '数据采集覆盖',
        subtitle: '本地采集完成度',
        layout: { x: 17, y: 2, w: 7, h: 2 },
        data: [{ name: '覆盖率', value: collectedRate }],
        unit: '%',
        accent: '#54dfa6'
      },
      {
        id: 'project-ranking',
        type: 'ranking',
        title: '项目数据量排行',
        subtitle: '记录数 Top 5',
        layout: { x: 17, y: 4, w: 7, h: 5 },
        data: byProject.length
          ? byProject
          : [
              { name: '示例项目 A', value: fallback(stats.recordCount, 36) },
              { name: '示例项目 B', value: 24 }
            ],
        accent: '#69e6ff'
      },
      {
        id: 'data-insight',
        type: 'insight',
        title: '数据洞察',
        subtitle: '规则生成的首版摘要',
        layout: { x: 0, y: 7, w: 17, h: 2 },
        data: [{ name: '对象类型', value: stats.byType.length }],
        insight: stats.recordCount
          ? `当前共沉淀 ${stats.recordCount} 条数据，覆盖 ${stats.projectCount} 个项目。${
              byType[0] ? `${byType[0].name} 是数量最多的对象类型。` : ''
            }`
          : '当前尚未采集到数据。完成数据采集后，可视化专家会根据真实字段生成业务看板。'
      }
    ]
  }
}
