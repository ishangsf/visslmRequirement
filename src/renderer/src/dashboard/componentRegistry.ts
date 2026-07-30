import type {
  DashboardComponentDefinition,
  DashboardComponentType
} from '../../../shared/dashboard'
import { dashboardLayoutProfiles } from '../../../shared/dashboard-layout'

export const dashboardComponentRegistry: DashboardComponentDefinition[] = [
  {
    type: 'kpi',
    name: '核心指标',
    description: '展示总量、同比或目标完成情况',
    category: '指标',
    minimumSize: {
      w: dashboardLayoutProfiles.kpi.minimumWidth,
      h: dashboardLayoutProfiles.kpi.minimumHeight
    },
    supportedDataShapes: ['single-value']
  },
  {
    type: 'line',
    name: '趋势折线',
    description: '观察指标随时间的变化趋势',
    category: '趋势',
    minimumSize: {
      w: dashboardLayoutProfiles.line.minimumWidth,
      h: dashboardLayoutProfiles.line.minimumHeight
    },
    supportedDataShapes: ['time-series']
  },
  {
    type: 'bar',
    name: '分类柱状图',
    description: '比较不同分类之间的指标差异',
    category: '比较',
    minimumSize: {
      w: dashboardLayoutProfiles.bar.minimumWidth,
      h: dashboardLayoutProfiles.bar.minimumHeight
    },
    supportedDataShapes: ['category-value']
  },
  {
    type: 'ranking',
    name: '排行列表',
    description: '突出 Top N 对象及其相对差距',
    category: '比较',
    minimumSize: {
      w: dashboardLayoutProfiles.ranking.minimumWidth,
      h: dashboardLayoutProfiles.ranking.minimumHeight
    },
    supportedDataShapes: ['category-value']
  },
  {
    type: 'pie',
    name: '构成环图',
    description: '展示不超过六个分类的占比构成',
    category: '构成',
    minimumSize: {
      w: dashboardLayoutProfiles.pie.minimumWidth,
      h: dashboardLayoutProfiles.pie.minimumHeight
    },
    supportedDataShapes: ['category-value']
  },
  {
    type: 'progress',
    name: '目标进度',
    description: '展示完成率、覆盖率或达成率',
    category: '指标',
    minimumSize: {
      w: dashboardLayoutProfiles.progress.minimumWidth,
      h: dashboardLayoutProfiles.progress.minimumHeight
    },
    supportedDataShapes: ['single-value']
  },
  {
    type: 'table',
    name: '数据明细',
    description: '用于核查对象、数量和状态明细',
    category: '明细',
    minimumSize: {
      w: dashboardLayoutProfiles.table.minimumWidth,
      h: dashboardLayoutProfiles.table.minimumHeight
    },
    supportedDataShapes: ['table', 'category-value']
  },
  {
    type: 'insight',
    name: '智能洞察',
    description: '用自然语言总结关键发现和风险',
    category: '洞察',
    minimumSize: {
      w: dashboardLayoutProfiles.insight.minimumWidth,
      h: dashboardLayoutProfiles.insight.minimumHeight
    },
    supportedDataShapes: ['single-value', 'category-value', 'time-series']
  }
]

export const componentDefinitionByType = new Map<DashboardComponentType, DashboardComponentDefinition>(
  dashboardComponentRegistry.map((definition) => [definition.type, definition])
)
