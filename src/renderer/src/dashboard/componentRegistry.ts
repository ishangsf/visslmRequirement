import type {
  DashboardComponentDefinition,
  DashboardComponentType
} from '../../../shared/dashboard'
import { dashboardLayoutProfiles } from '../../../shared/dashboard-layout'

/**
 * The editor consumes this manifest for both the inspector type selector and
 * the add-component library. Keep presentation metadata here instead of
 * duplicating component capabilities in the view.
 */
export const dashboardComponentRegistry: DashboardComponentDefinition[] = [
  {
    manifestVersion: '1.0',
    type: 'kpi',
    name: '核心指标',
    description: '展示总量、同比或目标完成情况',
    category: '指标',
    minimumSize: { w: dashboardLayoutProfiles.kpi.minimumWidth, h: dashboardLayoutProfiles.kpi.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.kpi.preferredWidth, h: dashboardLayoutProfiles.kpi.preferredHeight },
    supportedDataShapes: ['single-value'],
    compatibleSlotRoles: ['headline'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'line',
    name: '趋势折线',
    description: '观察指标随时间的变化趋势',
    category: '趋势',
    minimumSize: { w: dashboardLayoutProfiles.line.minimumWidth, h: dashboardLayoutProfiles.line.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.line.preferredWidth, h: dashboardLayoutProfiles.line.preferredHeight },
    supportedDataShapes: ['time-series'],
    compatibleSlotRoles: ['trend'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'bar',
    name: '分类柱状图',
    description: '比较不同分类之间的指标差异',
    category: '比较',
    minimumSize: { w: dashboardLayoutProfiles.bar.minimumWidth, h: dashboardLayoutProfiles.bar.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.bar.preferredWidth, h: dashboardLayoutProfiles.bar.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['comparison'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'ranking',
    name: '排行列表',
    description: '突出 Top N 对象及其相对差距',
    category: '比较',
    minimumSize: { w: dashboardLayoutProfiles.ranking.minimumWidth, h: dashboardLayoutProfiles.ranking.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.ranking.preferredWidth, h: dashboardLayoutProfiles.ranking.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['comparison'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'pie',
    name: '构成环图',
    description: '展示不超过六个分类的占比构成',
    category: '构成',
    minimumSize: { w: dashboardLayoutProfiles.pie.minimumWidth, h: dashboardLayoutProfiles.pie.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.pie.preferredWidth, h: dashboardLayoutProfiles.pie.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['breakdown'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'progress',
    name: '目标进度',
    description: '展示完成率、覆盖率或达成率',
    category: '指标',
    minimumSize: { w: dashboardLayoutProfiles.progress.minimumWidth, h: dashboardLayoutProfiles.progress.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.progress.preferredWidth, h: dashboardLayoutProfiles.progress.preferredHeight },
    supportedDataShapes: ['single-value'],
    compatibleSlotRoles: ['headline'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'table',
    name: '数据明细',
    description: '用于核查对象、数量和状态明细',
    category: '明细',
    minimumSize: { w: dashboardLayoutProfiles.table.minimumWidth, h: dashboardLayoutProfiles.table.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.table.preferredWidth, h: dashboardLayoutProfiles.table.preferredHeight },
    supportedDataShapes: ['detail'],
    compatibleSlotRoles: ['detail'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'insight',
    name: '智能洞察',
    description: '用自然语言总结关键发现和风险',
    category: '洞察',
    minimumSize: { w: dashboardLayoutProfiles.insight.minimumWidth, h: dashboardLayoutProfiles.insight.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.insight.preferredWidth, h: dashboardLayoutProfiles.insight.preferredHeight },
    supportedDataShapes: ['single-value', 'category-value', 'time-series'],
    compatibleSlotRoles: ['insight', 'diagnosis'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'gauge',
    name: '环形仪表',
    description: '展示目标完成率、健康度和容量利用率',
    category: '指标',
    minimumSize: { w: dashboardLayoutProfiles.gauge.minimumWidth, h: dashboardLayoutProfiles.gauge.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.gauge.preferredWidth, h: dashboardLayoutProfiles.gauge.preferredHeight },
    supportedDataShapes: ['single-value'],
    compatibleSlotRoles: ['headline'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'funnel',
    name: '转化漏斗',
    description: '展示销售、运营或流程各阶段的转化损耗',
    category: '比较',
    minimumSize: { w: dashboardLayoutProfiles.funnel.minimumWidth, h: dashboardLayoutProfiles.funnel.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.funnel.preferredWidth, h: dashboardLayoutProfiles.funnel.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['comparison', 'breakdown'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'radar',
    name: '多维雷达',
    description: '对比多个维度的能力、质量或健康评分',
    category: '比较',
    minimumSize: { w: dashboardLayoutProfiles.radar.minimumWidth, h: dashboardLayoutProfiles.radar.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.radar.preferredWidth, h: dashboardLayoutProfiles.radar.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['comparison'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'scatter',
    name: '分布散点',
    description: '观察两个数值指标之间的分布和相关关系',
    category: '比较',
    minimumSize: { w: dashboardLayoutProfiles.scatter.minimumWidth, h: dashboardLayoutProfiles.scatter.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.scatter.preferredWidth, h: dashboardLayoutProfiles.scatter.preferredHeight },
    supportedDataShapes: ['dual-measure'],
    compatibleSlotRoles: ['diagnosis', 'comparison'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'treemap',
    name: '层级树图',
    description: '按分类层级呈现数量或总量构成',
    category: '构成',
    minimumSize: { w: dashboardLayoutProfiles.treemap.minimumWidth, h: dashboardLayoutProfiles.treemap.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.treemap.preferredWidth, h: dashboardLayoutProfiles.treemap.preferredHeight },
    supportedDataShapes: ['category-value'],
    compatibleSlotRoles: ['breakdown'],
    supportsManualAdd: true,
    requiresQuery: true
  },
  {
    manifestVersion: '1.0',
    type: 'combo',
    name: '组合趋势',
    description: '在同一坐标系中对照两个指标的趋势',
    category: '趋势',
    minimumSize: { w: dashboardLayoutProfiles.combo.minimumWidth, h: dashboardLayoutProfiles.combo.minimumHeight },
    preferredSize: { w: dashboardLayoutProfiles.combo.preferredWidth, h: dashboardLayoutProfiles.combo.preferredHeight },
    supportedDataShapes: ['time-series', 'dual-measure'],
    compatibleSlotRoles: ['trend', 'comparison'],
    supportsManualAdd: true,
    requiresQuery: true
  }
]

export const componentDefinitionByType = new Map<DashboardComponentType, DashboardComponentDefinition>(
  dashboardComponentRegistry.map((definition) => [definition.type, definition])
)
