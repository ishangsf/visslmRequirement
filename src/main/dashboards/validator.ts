import type { DashboardComponentSpec, DashboardSpec } from '../../shared/dashboard'
import { dashboardLayoutProfiles } from '../../shared/dashboard-layout'
import type { QueryEngine } from '../analytics/query-engine'

const componentTypes = new Set(['kpi', 'bar', 'line', 'pie', 'ranking', 'table', 'progress', 'insight'])
const themes = new Set(['technology-dark', 'business-light'])

export const validateDashboardSpec = (
  input: unknown,
  queryEngine?: QueryEngine
): string[] => {
  const errors: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['DashboardSpec 必须是对象']
  }
  const spec = input as Partial<DashboardSpec>
  if (spec.schemaVersion !== '1.0') errors.push('schemaVersion 必须是 1.0')
  if (!spec.id?.trim()) errors.push('id 不能为空')
  if (!spec.title?.trim()) errors.push('title 不能为空')
  if (!themes.has(String(spec.theme))) errors.push(`不支持的主题: ${String(spec.theme)}`)
  if (!Array.isArray(spec.components) || !spec.components.length) {
    errors.push('components 至少包含一个组件')
    return errors
  }
  if (spec.components.length > 10) errors.push('首屏组件不能超过 10 个')
  const ids = new Set<string>()
  const occupied = new Set<string>()
  for (const component of spec.components as DashboardComponentSpec[]) {
    if (!component.id?.trim()) errors.push('组件 id 不能为空')
    if (ids.has(component.id)) errors.push(`组件 id 重复: ${component.id}`)
    ids.add(component.id)
    if (!componentTypes.has(component.type)) errors.push(`不支持的组件类型: ${component.type}`)
    if (!component.title?.trim()) errors.push(`组件 ${component.id} 的 title 不能为空`)
    const { x, y, w, h } = component.layout ?? {}
    if (![x, y, w, h].every(Number.isInteger)) {
      errors.push(`组件 ${component.id} 的 layout 必须使用整数`)
      continue
    }
    if (x < 0 || y < 0 || w < 2 || h < 2 || x + w > 24 || y + h > 20) {
      errors.push(`组件 ${component.id} 的 layout 越界或尺寸过小`)
    }
    const minimum = dashboardLayoutProfiles[component.type]
    if (minimum && (w < minimum.minimumWidth || h < minimum.minimumHeight)) {
      errors.push(
        `组件 ${component.id} 尺寸不足，${component.type} 至少需要 ${minimum.minimumWidth}×${minimum.minimumHeight}`
      )
    }
    for (let column = x; column < x + w; column += 1) {
      for (let row = y; row < y + h; row += 1) {
        const cell = `${column}:${row}`
        if (occupied.has(cell)) errors.push(`组件 ${component.id} 与其他组件重叠`)
        occupied.add(cell)
      }
    }
    if (!component.query) errors.push(`组件 ${component.id} 缺少 query`)
    else if (queryEngine) {
      errors.push(...queryEngine.validate(component.query).map(
        (error) => `组件 ${component.id}: ${error}`
      ))
    }
    if (!component.encoding?.value) errors.push(`组件 ${component.id} 缺少 encoding.value`)
    if (component.query && component.encoding?.value) {
      const measureIds = new Set(component.query.measures.map((measure) => measure.id))
      const dimensionFields = new Set(
        (component.query.dimensions ?? []).map((dimension) => dimension.field)
      )
      if (!measureIds.has(component.encoding.value)) {
        errors.push(`组件 ${component.id} 的 encoding.value 必须引用 measure.id`)
      }
      if (component.encoding.label && !dimensionFields.has(component.encoding.label)) {
        errors.push(`组件 ${component.id} 的 encoding.label 必须引用 dimension.field`)
      }
      if (['kpi', 'progress'].includes(component.type) && dimensionFields.size > 0) {
        errors.push(`组件 ${component.id} 是单值组件，不能包含维度`)
      }
      if (['bar', 'line', 'pie', 'ranking'].includes(component.type) &&
          dimensionFields.size === 0) {
        errors.push(`组件 ${component.id} 至少需要一个维度`)
      }
    }
  }
  return [...new Set(errors)]
}
