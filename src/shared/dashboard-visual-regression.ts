import type { DashboardSpec } from './dashboard'
import { dashboardGridColumns, dashboardRowCount } from './dashboard-layout'

export const dashboardVisualViewports = [
  { id: 'hd', width: 1366, height: 768 },
  { id: 'full-hd', width: 1920, height: 1080 },
  { id: '4k', width: 3840, height: 2160 }
] as const

export interface DashboardProjectedRect {
  id: string
  left: number
  top: number
  width: number
  height: number
}

export const projectDashboardLayout = (
  spec: DashboardSpec,
  viewport: { width: number; height: number }
): DashboardProjectedRect[] => {
  const horizontalPadding = 24
  const verticalHeader = 118
  const gridGap = 8
  const gridWidth = viewport.width - horizontalPadding
  const gridHeight = Math.max(1, viewport.height - verticalHeader - horizontalPadding)
  const rows = dashboardRowCount(spec.components)
  const cellWidth = (gridWidth - gridGap * (dashboardGridColumns - 1)) / dashboardGridColumns
  const cellHeight = (gridHeight - gridGap * (rows - 1)) / rows
  return spec.components.map((component) => ({
    id: component.id,
    left: 12 + component.layout.x * (cellWidth + gridGap),
    top: verticalHeader / 2 + component.layout.y * (cellHeight + gridGap),
    width: component.layout.w * cellWidth + (component.layout.w - 1) * gridGap,
    height: component.layout.h * cellHeight + (component.layout.h - 1) * gridGap
  }))
}

export const validateProjectedLayout = (
  spec: DashboardSpec,
  viewport: { width: number; height: number }
): string[] => {
  const errors: string[] = []
  const rects = projectDashboardLayout(spec, viewport)
  const rightBoundary = viewport.width - 12
  const bottomBoundary = viewport.height - 12
  for (const rect of rects) {
    if (rect.left < 0 || rect.top < 0 || rect.left + rect.width > rightBoundary + 1) {
      errors.push(`${rect.id} 在 ${viewport.width}x${viewport.height} 横向越界`)
    }
    if (rect.top + rect.height > bottomBoundary + 1) {
      errors.push(`${rect.id} 在 ${viewport.width}x${viewport.height} 纵向越界`)
    }
    if (rect.width < 120 || rect.height < 52) {
      errors.push(`${rect.id} 在 ${viewport.width}x${viewport.height} 可视尺寸过小`)
    }
    const title = spec.components.find((component) => component.id === rect.id)?.title ?? ''
    if (title.length > Math.floor(rect.width / 7)) {
      errors.push(`${rect.id} 在 ${viewport.width}x${viewport.height} 标题可能截断`)
    }
  }
  for (let leftIndex = 0; leftIndex < rects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rects.length; rightIndex += 1) {
      const left = rects[leftIndex]
      const right = rects[rightIndex]
      if (
        left.left < right.left + right.width &&
        left.left + left.width > right.left &&
        left.top < right.top + right.height &&
        left.top + left.height > right.top
      ) {
        errors.push(`${left.id} 与 ${right.id} 在 ${viewport.width}x${viewport.height} 重叠`)
      }
    }
  }
  return errors
}
