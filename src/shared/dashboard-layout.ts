import type {
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardLayout
} from './dashboard'

interface LayoutProfile {
  minimumWidth: number
  preferredWidth: number
  minimumHeight: number
  preferredHeight: number
}

export const dashboardGridColumns = 24
export const dashboardGridRows = 20

export const dashboardLayoutProfiles: Record<DashboardComponentType, LayoutProfile> = {
  kpi: { minimumWidth: 4, preferredWidth: 6, minimumHeight: 2, preferredHeight: 3 },
  line: { minimumWidth: 8, preferredWidth: 10, minimumHeight: 4, preferredHeight: 5 },
  bar: { minimumWidth: 7, preferredWidth: 8, minimumHeight: 4, preferredHeight: 5 },
  pie: { minimumWidth: 6, preferredWidth: 8, minimumHeight: 4, preferredHeight: 5 },
  ranking: { minimumWidth: 6, preferredWidth: 7, minimumHeight: 4, preferredHeight: 5 },
  progress: { minimumWidth: 5, preferredWidth: 6, minimumHeight: 2, preferredHeight: 3 },
  table: { minimumWidth: 10, preferredWidth: 12, minimumHeight: 5, preferredHeight: 5 },
  insight: { minimumWidth: 6, preferredWidth: 8, minimumHeight: 3, preferredHeight: 3 },
  gauge: { minimumWidth: 6, preferredWidth: 8, minimumHeight: 4, preferredHeight: 5 },
  funnel: { minimumWidth: 7, preferredWidth: 9, minimumHeight: 4, preferredHeight: 5 },
  radar: { minimumWidth: 7, preferredWidth: 9, minimumHeight: 4, preferredHeight: 5 },
  scatter: { minimumWidth: 8, preferredWidth: 10, minimumHeight: 4, preferredHeight: 5 }
}

const rowCost = (components: DashboardComponentSpec[]): number => {
  const profiles = components.map((component) => dashboardLayoutProfiles[component.type])
  const minimumWidth = profiles.reduce((total, profile) => total + profile.minimumWidth, 0)
  if (minimumWidth > 24) return Number.POSITIVE_INFINITY

  const preferredWidth = profiles.reduce((total, profile) => total + profile.preferredWidth, 0)
  const heights = profiles.map((profile) => profile.preferredHeight)
  const heightMismatch = Math.max(...heights) - Math.min(...heights)
  const singletonPenalty = components.length === 1 ? 14 : 0
  return Math.abs(24 - preferredWidth) + heightMismatch * 2 + singletonPenalty
}

const partitionRows = (components: DashboardComponentSpec[]): DashboardComponentSpec[][] => {
  const best = Array.from(
    { length: components.length + 1 },
    () => ({ cost: Number.POSITIVE_INFINITY, rows: [] as DashboardComponentSpec[][] })
  )
  best[0] = { cost: 0, rows: [] }

  for (let end = 1; end <= components.length; end += 1) {
    for (let count = 1; count <= Math.min(4, end); count += 1) {
      const start = end - count
      const row = components.slice(start, end)
      const cost = best[start].cost + rowCost(row)
      if (cost < best[end].cost) {
        best[end] = { cost, rows: [...best[start].rows, row] }
      }
    }
  }

  return best[components.length].rows
}

const distributeRowWidths = (components: DashboardComponentSpec[]): number[] => {
  const profiles = components.map((component) => dashboardLayoutProfiles[component.type])
  const widths = profiles.map((profile) => profile.minimumWidth)
  let remaining = 24 - widths.reduce((total, width) => total + width, 0)

  while (remaining > 0) {
    let target = 0
    let largestNeed = Number.NEGATIVE_INFINITY
    for (let index = 0; index < widths.length; index += 1) {
      const need = profiles[index].preferredWidth - widths[index]
      if (need > largestNeed) {
        largestNeed = need
        target = index
      }
    }
    widths[target] += 1
    remaining -= 1
  }

  return widths
}

export const arrangeDashboardComponents = (
  components: DashboardComponentSpec[]
): DashboardComponentSpec[] => {
  if (!components.length) return []

  const rows = partitionRows(components)
  let y = 0
  return rows.flatMap((row) => {
    const widths = distributeRowWidths(row)
    const height = Math.max(
      ...row.map((component) => dashboardLayoutProfiles[component.type].preferredHeight)
    )
    let x = 0
    const arranged = row.map((component, index) => {
      const layout: DashboardLayout = { x, y, w: widths[index], h: height }
      x += widths[index]
      return { ...component, layout }
    })
    y += height
    return arranged
  })
}

export const dashboardRowCount = (components: DashboardComponentSpec[]): number =>
  Math.max(1, ...components.map((component) => component.layout.y + component.layout.h))

const overlaps = (
  left: DashboardLayout,
  right: DashboardLayout
): boolean =>
  left.x < right.x + right.w &&
  left.x + left.w > right.x &&
  left.y < right.y + right.h &&
  left.y + left.h > right.y

export interface DashboardLayoutSwapResult {
  targetId: string
  draggedLayout: DashboardLayout
  targetLayout: DashboardLayout
  errors: string[]
}

const overlapRatio = (left: DashboardLayout, right: DashboardLayout): number => {
  const width = Math.max(0, Math.min(left.x + left.w, right.x + right.w) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.h, right.y + right.h) - Math.max(left.y, right.y))
  const referenceArea = Math.min(left.w * left.h, right.w * right.h)
  return referenceArea > 0 ? (width * height) / referenceArea : 0
}

export const validateDashboardLayout = (
  components: DashboardComponentSpec[],
  componentId: string,
  layout: DashboardLayout
): string[] => {
  const component = components.find((item) => item.id === componentId)
  if (!component) return [`组件 ${componentId} 不存在`]
  const errors: string[] = []
  const profile = dashboardLayoutProfiles[component.type]
  if (![layout.x, layout.y, layout.w, layout.h].every(Number.isInteger)) {
    errors.push('布局必须使用整数')
  } else {
    if (layout.x < 0 || layout.y < 0 || layout.x + layout.w > dashboardGridColumns || layout.y + layout.h > dashboardGridRows) {
      errors.push(`布局必须位于 ${dashboardGridColumns} 列、${dashboardGridRows} 行网格内`)
    }
    if (layout.w < profile.minimumWidth || layout.h < profile.minimumHeight) {
      errors.push(`组件 ${component.title} 至少需要 ${profile.minimumWidth}×${profile.minimumHeight}`)
    }
  }
  for (const other of components) {
    if (other.id !== componentId && overlaps(layout, other.layout)) {
      errors.push(`组件 ${component.title} 与 ${other.title} 重叠`)
      break
    }
  }
  return errors
}

/**
 * Swaps complete grid slots when a dragged component substantially overlaps another component.
 * Slot dimensions are exchanged only when both component minimum sizes remain valid.
 */
export const swapDashboardComponentLayouts = (
  components: DashboardComponentSpec[],
  componentId: string,
  candidate: DashboardLayout
): DashboardLayoutSwapResult | null => {
  const dragged = components.find((component) => component.id === componentId)
  if (!dragged) return null
  const target = components
    .filter((component) => component.id !== componentId)
    .map((component) => ({ component, ratio: overlapRatio(candidate, component.layout) }))
    .filter((item) => item.ratio >= 0.25)
    .sort((left, right) => right.ratio - left.ratio)[0]?.component
  if (!target) return null

  const draggedLayout: DashboardLayout = { ...target.layout }
  const targetLayout: DashboardLayout = { ...dragged.layout }
  const nextComponents = components.map((component) =>
    component.id === componentId
      ? { ...component, layout: draggedLayout }
      : component.id === target.id
        ? { ...component, layout: targetLayout }
        : component
  )
  return {
    targetId: target.id,
    draggedLayout,
    targetLayout,
    errors: [
      ...validateDashboardLayout(nextComponents, componentId, draggedLayout),
      ...validateDashboardLayout(nextComponents, target.id, targetLayout)
    ]
  }
}
