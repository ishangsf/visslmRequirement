import type { DashboardComponentSpec, DashboardSpec } from '../../shared/dashboard'
import { dashboardLayoutProfiles } from '../../shared/dashboard-layout'
import type { QueryEngine } from '../analytics/query-engine'

const componentTypes = new Set([
  'kpi', 'bar', 'line', 'pie', 'ranking', 'table', 'progress', 'insight',
  'gauge', 'funnel', 'radar', 'scatter'
])
const themes = new Set([
  'technology-dark',
  'business-light',
  'charcoal-dark',
  'minimal-light'
])
const filterOperators = new Set(['equals', 'in'])
const safeAccent = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const styleRanges = {
  titleFontSize: [9, 24],
  subtitleFontSize: [8, 18],
  valueFontSize: [14, 48],
  bodyFontSize: [9, 20],
  borderRadius: [0, 12],
  padding: [4, 20],
  lineWidth: [1, 8]
} as const

export interface DashboardValidationOptions {
  allowInlineData?: boolean
}

export const validateDashboardSpec = (
  input: unknown,
  queryEngine?: QueryEngine,
  options: DashboardValidationOptions = {}
): string[] => {
  const errors: string[] = []
  const allowInlineData = options.allowInlineData === true
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['DashboardSpec 必须是对象']
  }
  const spec = input as Partial<DashboardSpec>
  if (spec.schemaVersion !== '1.0') errors.push('schemaVersion 必须是 1.0')
  if (!spec.id?.trim()) errors.push('id 不能为空')
  if (!spec.title?.trim()) errors.push('title 不能为空')
  if (!themes.has(String(spec.theme))) errors.push(`不支持的主题: ${String(spec.theme)}`)
  if (spec.globalFilters !== undefined) {
    if (!Array.isArray(spec.globalFilters)) {
      errors.push('globalFilters 必须是数组')
    } else if (spec.globalFilters.length > 8) {
      errors.push('大屏最多配置 8 个全局筛选器')
    } else {
      const filterIds = new Set<string>()
      for (const filter of spec.globalFilters) {
        if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
          errors.push('全局筛选器必须是对象')
          continue
        }
        const item = filter as NonNullable<DashboardSpec['globalFilters']>[number]
        if (!item.id?.trim()) errors.push('全局筛选器 id 不能为空')
        if (filterIds.has(item.id)) errors.push(`全局筛选器 id 重复: ${item.id}`)
        filterIds.add(item.id)
        if (!item.field?.trim()) errors.push(`全局筛选器 ${item.id} 缺少字段`)
        if (!item.label?.trim()) errors.push(`全局筛选器 ${item.id} 缺少显示名`)
        if (!filterOperators.has(item.operator)) {
          errors.push(`全局筛选器 ${item.id} 的操作符不受支持`)
        }
        if (!Array.isArray(item.options) || item.options.length > 50) {
          errors.push(`全局筛选器 ${item.id} 的选项最多 50 个`)
        }
      }
    }
  }
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
    if (component.accent !== undefined && !safeAccent.test(component.accent)) {
      errors.push(`组件 ${component.id} 的 accent 必须是十六进制颜色`)
    }
    if (component.style) {
      for (const [field, [minimum, maximum]] of Object.entries(styleRanges)) {
        const value = component.style[field as keyof typeof styleRanges]
        if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
          errors.push(`组件 ${component.id} 的 style.${field} 必须位于 ${minimum}-${maximum}`)
        }
      }
      if (component.style.orientation !== undefined &&
          !['horizontal', 'vertical'].includes(component.style.orientation)) {
        errors.push(`组件 ${component.id} 的 style.orientation 不受支持`)
      }
    }
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
    if (!component.query && !allowInlineData) errors.push(`组件 ${component.id} 缺少 query`)
    else if (queryEngine) {
      if (component.query) {
        errors.push(...queryEngine.validate(component.query).map(
          (error) => `组件 ${component.id}: ${error}`
        ))
      }
    }
    if (!component.encoding?.value && (Boolean(component.query) || !allowInlineData)) {
      errors.push(`组件 ${component.id} 缺少 encoding.value`)
    }
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
      if (['kpi', 'progress', 'gauge'].includes(component.type) && dimensionFields.size > 0) {
        errors.push(`组件 ${component.id} 是单值组件，不能包含维度`)
      }
      if (['bar', 'line', 'pie', 'ranking', 'funnel', 'radar', 'scatter'].includes(component.type) &&
          dimensionFields.size === 0) {
        errors.push(`组件 ${component.id} 至少需要一个维度`)
      }
    }
  }
  if (queryEngine && spec.globalFilters?.length) {
    const scope = spec.components.find((component) => component.query)?.query?.scope
    if (scope) {
      const catalog = new Set(queryEngine.profile(scope).map((profile) => profile.field.toLocaleLowerCase()))
      for (const filter of spec.globalFilters) {
        if (!catalog.has(filter.field.toLocaleLowerCase())) {
          errors.push(`全局筛选器 ${filter.id} 引用了不存在的字段: ${filter.field}`)
        }
      }
    }
  }
  return [...new Set(errors)]
}
