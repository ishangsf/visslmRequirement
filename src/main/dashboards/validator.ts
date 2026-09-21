import type { DashboardComponentSpec, DashboardSpec } from '../../shared/dashboard'
import { validateDashboardSemanticConsistency } from '../../shared/dashboard-semantics'
import { dashboardLayoutProfiles } from '../../shared/dashboard-layout'
import {
  dashboardComponentOptionDefinitions,
  dashboardComponentOptionKeys,
  dashboardComponentSupportsOption
} from '../../shared/dashboard-component-options'
import type { QueryEngine } from '../analytics/query-engine'

const componentTypes = new Set([
  'kpi', 'bar', 'line', 'pie', 'ranking', 'table', 'progress', 'insight',
  'gauge', 'funnel', 'radar', 'scatter', 'treemap', 'combo',
  'data-matrix', 'description-list', 'comparison-bars'
])
const statusTones = new Set(['success', 'info', 'warning', 'error', 'neutral'])
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

const hasCompleteDashboardShape = (
  spec: Partial<DashboardSpec>
): spec is DashboardSpec => Boolean(
  spec.schemaVersion === '1.0' &&
  typeof spec.id === 'string' && spec.id.trim() &&
  typeof spec.title === 'string' && spec.title.trim() &&
  typeof spec.subtitle === 'string' &&
  themes.has(String(spec.theme)) &&
  typeof spec.updatedAt === 'string' &&
  Array.isArray(spec.components) && spec.components.length > 0
)

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
  if (spec.dataScope !== undefined) {
    if (!spec.dataScope || typeof spec.dataScope !== 'object' || Array.isArray(spec.dataScope)) {
      errors.push('dataScope 必须是对象')
    } else {
      for (const field of ['projectIds', 'nodeTypes', 'recordUids'] as const) {
        const values = spec.dataScope[field]
        if (values !== undefined && (!Array.isArray(values) || values.some((value) =>
          typeof value !== 'string' || !value.trim()
        ))) {
          errors.push(`dataScope.${field} 必须是非空字符串数组`)
        }
      }
      if (spec.dataScope.baseFilters !== undefined && !Array.isArray(spec.dataScope.baseFilters)) {
        errors.push('dataScope.baseFilters 必须是数组')
      }
      if (spec.dataScope.snapshotAt !== undefined &&
          (typeof spec.dataScope.snapshotAt !== 'string' || !spec.dataScope.snapshotAt.trim())) {
        errors.push('dataScope.snapshotAt 必须是非空字符串')
      }
    }
  }
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

  const domainReceipt = spec.domainReceipt
  if (domainReceipt !== undefined) {
    if (!domainReceipt || typeof domainReceipt !== 'object' || Array.isArray(domainReceipt)) {
      errors.push('domainReceipt 必须是对象')
    } else {
      const confidence = domainReceipt.confidence
      if (confidence !== undefined &&
          (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
        errors.push('domainReceipt confidence 必须是 0-1 范围内的有限数值')
      }
      if (Array.isArray(domainReceipt.vetoCodes) && domainReceipt.vetoCodes.length) {
        errors.push(`领域质量一票否决: ${domainReceipt.vetoCodes.join(', ')}`)
      }
    }
  }

  const domainContext = spec.domainContext
  const artifactStatus = domainContext?.artifactStatus
  if (artifactStatus === 'formal') {
    if (!domainReceipt || typeof domainReceipt !== 'object' || Array.isArray(domainReceipt)) {
      errors.push('formal 领域 dashboard 必须包含 domainReceipt 回执')
    } else {
      const confidence = domainReceipt.confidence
      if (typeof confidence !== 'number' ||
          !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        errors.push('formal 领域 dashboard 的 domainReceipt confidence 必须是 0-1 范围内的有限数值')
      } else if (confidence !== 1) {
        errors.push('formal 领域 dashboard 的 domainReceipt confidence 必须为 1')
      }
      if (!Array.isArray(domainReceipt.evidenceMissing) || domainReceipt.evidenceMissing.length) {
        errors.push('formal 领域 dashboard 仍存在缺失证据，不能通过正式门禁')
      }
      if (!Array.isArray(domainReceipt.evidenceInsufficient) || domainReceipt.evidenceInsufficient.length) {
        errors.push('formal 领域 dashboard 仍存在不足证据，不能通过正式门禁')
      }
    }
  }

  const presentation = spec.presentation
  if (presentation !== undefined) {
    if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
      errors.push('presentation 必须是对象')
    } else if (presentation.kind !== 'gjb5000b-compliance') {
      errors.push(`不支持的 presentation.kind: ${String((presentation as { kind?: unknown }).kind)}`)
    } else {
      if (domainContext?.scenario !== 'gjb5000b-compliance') {
        errors.push('GJB5000B presentation 只能用于 gjb5000b-compliance 场景')
      }
      if (!['standard', 'immersive'].includes(presentation.defaultMode)) {
        errors.push('GJB5000B presentation.defaultMode 不受支持')
      }
      if (!presentation.projectLabel?.trim() || !presentation.baselineLabel?.trim() ||
          !presentation.auditPeriodLabel?.trim() || !presentation.dataModeLabel?.trim()) {
        errors.push('GJB5000B presentation 缺少项目、基线、审计周期或数据模式')
      }
      if (!Array.isArray(presentation.processDomains) || !presentation.processDomains.length) {
        errors.push('GJB5000B presentation.processDomains 不能为空')
      } else {
        const domainIds = new Set<string>()
        for (const domain of presentation.processDomains) {
          if (!domain.id?.trim() || !domain.label?.trim()) {
            errors.push('GJB5000B 过程域必须包含 id 和 label')
            continue
          }
          if (domainIds.has(domain.id)) errors.push(`GJB5000B 过程域 id 重复: ${domain.id}`)
          domainIds.add(domain.id)
          if (!Number.isFinite(domain.evidenceSufficiencyRate) ||
              domain.evidenceSufficiencyRate < 0 || domain.evidenceSufficiencyRate > 100) {
            errors.push(`GJB5000B 过程域 ${domain.id} 的证据充分率必须位于 0-100`)
          }
        }
        if (!domainIds.has(presentation.selectedDomainId)) {
          errors.push('GJB5000B presentation.selectedDomainId 必须引用有效过程域')
        }
      }
      if (!Array.isArray(presentation.trace) || presentation.trace.length !== 5) {
        errors.push('GJB5000B presentation.trace 必须完整覆盖五个证据阶段')
      }
      const trendLengths = [
        presentation.trend?.labels?.length,
        presentation.trend?.overall?.length,
        presentation.trend?.selectedDomain?.length
      ]
      if (!trendLengths[0] || new Set(trendLengths).size !== 1) {
        errors.push('GJB5000B presentation.trend 的标签和序列长度必须一致')
      }
      if (!Array.isArray(presentation.aging) || presentation.aging.some((bucket) =>
        !bucket.id?.trim() || !bucket.label?.trim() || !Number.isInteger(bucket.count) || bucket.count < 0
      )) {
        errors.push('GJB5000B presentation.aging 必须包含非负整数桶')
      }
      if (presentation.scene?.kind !== 'aerospace-situational' ||
          presentation.scene?.source !== 'approved-generated-visual' ||
          presentation.scene?.classification !== 'visual-theme' ||
          presentation.scene?.decorativeOnly !== true ||
          !presentation.scene?.assetId?.trim() || !presentation.scene?.assetVersion?.trim() ||
          !presentation.scene?.disclaimer?.trim()) {
        errors.push('GJB5000B scene 必须声明可治理的视觉主题资产和免责声明')
      }
    }
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
      for (const key of dashboardComponentOptionKeys) {
        if (component.style[key] !== undefined && !dashboardComponentSupportsOption(component.type, key)) {
          errors.push(`组件 ${component.id} 不支持专属配置 style.${key}`)
        }
      }
      for (const definition of dashboardComponentOptionDefinitions[component.type]) {
        const value = component.style[definition.key]
        if (value === undefined) continue
        if (definition.control === 'boolean' && typeof value !== 'boolean') {
          errors.push(`组件 ${component.id} 的 style.${definition.key} 必须是布尔值`)
        }
        if (definition.control === 'number' && (
          typeof value !== 'number' || !Number.isFinite(value) ||
          (definition.min !== undefined && value < definition.min) ||
          (definition.max !== undefined && value > definition.max)
        )) {
          errors.push(
            `组件 ${component.id} 的 style.${definition.key} 必须位于 ${definition.min}-${definition.max}`
          )
        }
        if (definition.control === 'select' &&
            (typeof value !== 'string' || !definition.options?.some((option) => option.value === value))) {
          errors.push(`组件 ${component.id} 的 style.${definition.key} 不受支持`)
        }
      }
      if (component.type === 'gauge' &&
          component.style.minimumValue !== undefined &&
          component.style.maximumValue !== undefined &&
          component.style.maximumValue <= component.style.minimumValue) {
        errors.push(`组件 ${component.id} 的仪表最大值必须大于最小值`)
      }
    }
    if (component.content) {
      if (component.content.kind !== component.type) {
        errors.push(`组件 ${component.id} 的 content.kind 必须与组件类型一致`)
      } else if (component.content.kind === 'data-matrix') {
        const matrixContent = component.content
        if (!matrixContent.leadingLabel?.trim() || !matrixContent.columns.length || !matrixContent.rows.length) {
          errors.push(`组件 ${component.id} 的数据矩阵必须包含表头、列和行`)
        }
        if (matrixContent.rows.some((row) =>
          !row.id?.trim() || !row.label?.trim() || row.cells.length !== matrixContent.columns.length
        )) {
          errors.push(`组件 ${component.id} 的数据矩阵行必须完整覆盖全部列`)
        }
        if (new Set(matrixContent.rows.map((row) => row.id)).size !== matrixContent.rows.length) {
          errors.push(`组件 ${component.id} 的数据矩阵行 id 不能重复`)
        }
        if (matrixContent.selectedRowId &&
            !matrixContent.rows.some((row) => row.id === matrixContent.selectedRowId)) {
          errors.push(`组件 ${component.id} 的默认选中行不存在`)
        }
        if (matrixContent.pageSize !== undefined &&
            (!Number.isInteger(matrixContent.pageSize) || matrixContent.pageSize < 3 || matrixContent.pageSize > 20)) {
          errors.push(`组件 ${component.id} 的 pageSize 必须是 3-20 的整数`)
        }
        if (matrixContent.expansionMode !== undefined &&
            !['inline', 'linked-detail', 'none'].includes(matrixContent.expansionMode)) {
          errors.push(`组件 ${component.id} 的 expansionMode 不受支持`)
        }
        if (matrixContent.expansionMode === 'linked-detail' && !matrixContent.selectionChannel?.trim()) {
          errors.push(`组件 ${component.id} 使用联动详情时必须配置 selectionChannel`)
        }
        const tones = [
          ...(matrixContent.legend ?? []).map((item) => item.tone),
          ...matrixContent.rows.flatMap((row) => [
            row.tone,
            ...row.cells.map((cell) => cell.tone),
            ...(row.expanded?.nodes.map((node) => node.tone) ?? [])
          ])
        ].filter(Boolean)
        if (tones.some((tone) => !statusTones.has(String(tone)))) {
          errors.push(`组件 ${component.id} 的阶段矩阵包含不支持的状态色`)
        }
      } else if (component.content.kind === 'description-list') {
        if (!Array.isArray(component.content.fields) || !component.content.fields.length ||
            component.content.fields.some((field) => !field.id?.trim() || !field.label?.trim())) {
          errors.push(`组件 ${component.id} 的描述列表必须包含有效字段`)
        }
        const variants = component.content.variants ?? []
        if (new Set(variants.map((variant) => variant.selectionId)).size !== variants.length ||
            variants.some((variant) =>
              !variant.selectionId?.trim() || !variant.fields.length ||
              variant.fields.some((field) => !field.id?.trim() || !field.label?.trim())
            )) {
          errors.push(`组件 ${component.id} 的联动详情变体必须包含唯一选择 id 和有效字段`)
        }
        if (variants.length && !component.content.selectionChannel?.trim()) {
          errors.push(`组件 ${component.id} 包含联动详情变体时必须配置 selectionChannel`)
        }
      } else if (component.content.kind === 'comparison-bars') {
        if (!component.content.items.length || component.content.items.some((item) =>
          !item.id?.trim() || !item.label?.trim() || !Number.isFinite(item.value) ||
          (item.secondaryValue !== undefined && !Number.isFinite(item.secondaryValue))
        )) {
          errors.push(`组件 ${component.id} 的比较条形必须包含有效数值项`)
        }
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
    for (const scaleField of ['valueScale', 'secondaryValueScale'] as const) {
      const scale = component.encoding?.[scaleField]
      if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0 || scale > 1_000_000)) {
        errors.push(`组件 ${component.id} 的 encoding.${scaleField} 必须是 0-1000000 范围内的有限正数`)
      }
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
      if (['bar', 'line', 'pie', 'ranking', 'funnel', 'radar', 'scatter', 'treemap', 'combo', 'data-matrix', 'description-list', 'comparison-bars'].includes(component.type) &&
          dimensionFields.size === 0) {
        errors.push(`组件 ${component.id} 至少需要一个维度`)
      }
      if (['scatter', 'combo'].includes(component.type)) {
        const secondaryValue = component.encoding.secondaryValue
        if (!secondaryValue) {
          errors.push(`组件 ${component.id} 必须配置第二指标映射`)
        } else if (!measureIds.has(secondaryValue)) {
          errors.push(`组件 ${component.id} 的 encoding.secondaryValue 必须引用 measure.id`)
        } else if (secondaryValue === component.encoding.value) {
          errors.push(`组件 ${component.id} 的两个指标映射必须不同`)
        }
        if (component.query.measures.length !== 2) {
          errors.push(`组件 ${component.id} 类型 ${component.type} 必须恰好包含两个指标`)
        }
        if (component.type === 'scatter' && component.query.measures.length === 2) {
          const scatterFields = component.query.measures.map((measure) => measure.field?.trim())
          if (scatterFields.some((field) => !field)) {
            errors.push(`组件 ${component.id} 的 scatter 两个指标都必须指定字段`)
          } else if (new Set(scatterFields).size !== 2) {
            errors.push(`组件 ${component.id} 的 scatter 两个指标字段必须不同`)
          }
          if (queryEngine) {
            const profiles = new Map(queryEngine.profile(component.query.scope)
              .map((profile) => [profile.field, profile]))
            for (const field of scatterFields) {
              const profile = field ? profiles.get(field) : undefined
              if (!profile || profile.sensitivity === 'sensitive' || profile.inferredType !== 'number') {
                errors.push(`组件 ${component.id} 的 scatter 指标必须来自安全 number 字段`)
              }
            }
          }
        }
      }
    }
  }
  for (const component of spec.components as DashboardComponentSpec[]) {
    const content = component.content
    if (content?.kind !== 'data-matrix' || content.expansionMode !== 'linked-detail') continue
    const target = spec.components.find((candidate) =>
      candidate.content?.kind === 'description-list' &&
      candidate.content.selectionChannel === content.selectionChannel
    )
    if (!target || target.content?.kind !== 'description-list') {
      errors.push(`组件 ${component.id} 的联动通道 ${content.selectionChannel} 缺少详情组件`)
      continue
    }
    const variantIds = new Set((target.content.variants ?? []).map((variant) => variant.selectionId))
    const missing = content.rows.filter((row) => !variantIds.has(row.id)).map((row) => row.label)
    if (missing.length) {
      errors.push(`组件 ${component.id} 的联动详情缺少：${missing.join('、')}`)
    }
  }
  if (queryEngine && spec.globalFilters?.length) {
    const scope = spec.dataScope
      ?? spec.components.find((component) => component.query)?.query?.scope
    if (scope) {
      const catalog = new Set(queryEngine.profile(scope).map((profile) => profile.field.toLocaleLowerCase()))
      for (const filter of spec.globalFilters) {
        if (!catalog.has(filter.field.toLocaleLowerCase())) {
          errors.push(`全局筛选器 ${filter.id} 引用了不存在的字段: ${filter.field}`)
        }
      }
    }
  }
  if (spec.analysisBlueprint) {
    const blueprint = spec.analysisBlueprint
    if (blueprint.version !== '1.0') errors.push('analysisBlueprint.version 必须是 1.0')
    if (!blueprint.request?.trim()) errors.push('analysisBlueprint.request 不能为空')
    if (!blueprint.audience?.trim()) errors.push('analysisBlueprint.audience 不能为空')
    if (!blueprint.objective?.trim()) errors.push('analysisBlueprint.objective 不能为空')
    if (!blueprint.scopeDescription?.trim()) errors.push('analysisBlueprint.scopeDescription 不能为空')
    if (!Array.isArray(blueprint.metrics) || !blueprint.metrics.length) {
      errors.push('analysisBlueprint.metrics 至少包含一个指标')
    }
    if (!Array.isArray(blueprint.questions) || !blueprint.questions.length) {
      errors.push('analysisBlueprint.questions 至少包含一个业务问题')
    }
    for (const component of spec.components as DashboardComponentSpec[]) {
      if (!component.slotRole) {
        errors.push(`组件 ${component.id} 缺少 slotRole`)
      }
    }
    if (hasCompleteDashboardShape(spec)) {
      try {
        errors.push(...validateDashboardSemanticConsistency(spec)
          .filter((issue) => issue.severity === 'error')
          .map((issue) => `语义一致性 ${issue.code}: ${issue.message}`))
      } catch (error) {
        errors.push(`语义一致性校验失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return [...new Set(errors)]
}
