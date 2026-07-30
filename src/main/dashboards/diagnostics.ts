import type {
  DashboardComponentDiagnostic,
  DashboardQualityIssue,
  DashboardQualityReport,
  DashboardSpec
} from '../../shared/dashboard'
import type { QueryEngine } from '../analytics/query-engine'
import { validateDashboardSpec } from './validator'

const sensitiveFieldPattern =
  /(^|[._-])(token|password|secret|phone|mobile|email|idcard|身份证|手机号|邮箱)([._-]|$)/i

const issueWeight = { error: 20, warning: 6, info: 1 } as const

export const diagnoseDashboard = (
  spec: DashboardSpec,
  queryEngine: QueryEngine
): DashboardQualityReport => {
  const issues: DashboardQualityIssue[] = validateDashboardSpec(spec, queryEngine).map(
    (message) => ({ code: 'spec-validation', severity: 'error', message })
  )
  const components: DashboardComponentDiagnostic[] = []

  for (const component of spec.components) {
    if (component.title.length > 30) {
      issues.push({
        code: 'long-title',
        severity: 'warning',
        componentId: component.id,
        message: `“${component.title}”标题较长，会议屏可能发生截断`
      })
    }
    if (component.type === 'pie' && component.data.length > 6) {
      issues.push({
        code: 'pie-too-many-categories',
        severity: 'warning',
        componentId: component.id,
        message: `环图包含 ${component.data.length} 个分类，建议改用条形图或排行榜`
      })
    }
    const referencedFields = [
      ...(component.query?.dimensions ?? []).map((dimension) => dimension.field),
      ...(component.query?.measures ?? []).flatMap((measure) => measure.field ? [measure.field] : []),
      ...(component.query?.filters ?? []).map((filter) => filter.field)
    ]
    for (const field of referencedFields.filter((value) => sensitiveFieldPattern.test(value))) {
      issues.push({
        code: 'sensitive-field',
        severity: 'warning',
        componentId: component.id,
        message: `查询引用疑似敏感字段 ${field}，导出前需要确认展示范围`
      })
    }
    if (!component.query) {
      components.push({
        componentId: component.id,
        title: component.title,
        elapsedMs: 0,
        scannedRows: 0,
        matchedRows: 0,
        resultRows: 0,
        truncated: false,
        status: 'error',
        errorMessage: '缺少 QuerySpec'
      })
      continue
    }
    try {
      const dataset = queryEngine.execute(component.query)
      const status = dataset.rows.length ? 'ok' : 'empty'
      components.push({
        componentId: component.id,
        title: component.title,
        elapsedMs: dataset.elapsedMs,
        scannedRows: dataset.scannedRows,
        matchedRows: dataset.matchedRows,
        resultRows: dataset.rows.length,
        truncated: dataset.truncated,
        status
      })
      if (status === 'empty') {
        issues.push({
          code: 'empty-result',
          severity: 'warning',
          componentId: component.id,
          message: `“${component.title}”当前查询结果为空`
        })
      }
      if (dataset.truncated) {
        issues.push({
          code: 'truncated-result',
          severity: 'warning',
          componentId: component.id,
          message: `“${component.title}”结果已达到 ${component.query.limit ?? 100} 行上限`
        })
      }
      if (dataset.elapsedMs > 2_000) {
        issues.push({
          code: 'slow-query',
          severity: 'warning',
          componentId: component.id,
          message: `“${component.title}”查询耗时 ${dataset.elapsedMs} ms，超过 2 秒目标`
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      components.push({
        componentId: component.id,
        title: component.title,
        elapsedMs: 0,
        scannedRows: 0,
        matchedRows: 0,
        resultRows: 0,
        truncated: false,
        status: 'error',
        errorMessage: message
      })
      issues.push({
        code: 'query-error',
        severity: 'error',
        componentId: component.id,
        message: `“${component.title}”查询失败：${message}`
      })
    }
  }

  const queryKeys = spec.components
    .flatMap((component) => component.query ? [JSON.stringify(component.query)] : [])
  const duplicateQueries = queryKeys.length - new Set(queryKeys).size
  if (duplicateQueries > 0) {
    issues.push({
      code: 'duplicate-query',
      severity: 'info',
      message: `${duplicateQueries} 个组件使用了重复查询，可复用查询结果缓存`
    })
  }
  if (!spec.businessContext?.audience || !spec.businessContext.objective) {
    issues.push({
      code: 'missing-business-context',
      severity: 'info',
      message: '未完整记录目标受众与业务目标，试点反馈可能缺少评价基准'
    })
  }

  const score = Math.max(
    0,
    100 - issues.reduce((total, issue) => total + issueWeight[issue.severity], 0)
  )
  return {
    dashboardId: spec.id,
    score,
    checkedAt: new Date().toISOString(),
    queryCount: components.length,
    totalElapsedMs: Number(
      components.reduce((total, component) => total + component.elapsedMs, 0).toFixed(2)
    ),
    issues,
    components
  }
}
