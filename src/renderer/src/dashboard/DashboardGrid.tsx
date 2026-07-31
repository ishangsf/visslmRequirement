import ReactGridLayout, {
  useContainerWidth,
  type EventCallback,
  type Layout as GridLayout,
  type LayoutItem,
  type ResizeHandleAxis
} from 'react-grid-layout'
import { noOverlapCompactor } from 'react-grid-layout/core'
import { InfoCircleOutlined } from '@ant-design/icons'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import type {
  DashboardComponentSpec,
  DashboardLayout,
  DashboardThemeId
} from '../../../shared/dashboard'
import {
  dashboardGridColumns,
  dashboardGridRows,
  dashboardLayoutProfiles,
  dashboardRowCount,
  swapDashboardComponentLayouts,
  validateDashboardLayout
} from '../../../shared/dashboard-layout'
import { DashboardComponentRenderer } from './DashboardComponentRenderer'

type DashboardGridProps = {
  components: DashboardComponentSpec[]
  theme: DashboardThemeId
  preview: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onProvenance: (component: DashboardComponentSpec) => void
  onLayoutCommit: (layouts: Record<string, DashboardLayout>) => void
  onInteractionError: (message: string) => void
}

type GridInteraction = {
  id: string
  mode: 'move' | 'resize'
  origin: Record<string, DashboardLayout>
  accepted: Record<string, DashboardLayout>
  rejected: boolean
}

const toDashboardLayout = (item: LayoutItem): DashboardLayout => ({
  x: item.x,
  y: item.y,
  w: item.w,
  h: item.h
})

const toGridLayout = (components: DashboardComponentSpec[]): GridLayout =>
  components.map((component) => {
    const profile = dashboardLayoutProfiles[component.type]
    return {
      i: component.id,
      ...component.layout,
      minW: profile.minimumWidth,
      minH: profile.minimumHeight,
      maxH: dashboardGridRows
    }
  })

const toDashboardLayouts = (
  components: DashboardComponentSpec[],
  layout: GridLayout
): Record<string, DashboardLayout> => {
  const layoutById = new Map(layout.map((item) => [item.i, item]))
  return Object.fromEntries(components.map((component) => [
    component.id,
    layoutById.has(component.id)
      ? toDashboardLayout(layoutById.get(component.id)!)
      : component.layout
  ]))
}

const toLayoutComponents = (
  components: DashboardComponentSpec[],
  layouts: Record<string, DashboardLayout>
): DashboardComponentSpec[] => components.map((component) => ({
  ...component,
  layout: layouts[component.id] ?? component.layout
}))

const layoutsChanged = (
  components: DashboardComponentSpec[],
  nextLayouts: Record<string, DashboardLayout>
): boolean => components.some((component) => {
  const next = nextLayouts[component.id]
  return Boolean(next) && (
    next.x !== component.layout.x ||
    next.y !== component.layout.y ||
    next.w !== component.layout.w ||
    next.h !== component.layout.h
  )
})

const resizeHandle = (
  axis: ResizeHandleAxis,
  ref: Ref<HTMLElement>
): React.JSX.Element => (
  <span
    ref={ref}
    className={`dashboard-resize-handle react-resizable-handle-${axis}`}
    role="separator"
    aria-label="调整组件大小"
  />
)

export function DashboardGrid({
  components,
  theme,
  preview,
  selectedId,
  onSelect,
  onProvenance,
  onLayoutCommit,
  onInteractionError
}: DashboardGridProps): React.JSX.Element {
  const { width, containerRef, mounted } = useContainerWidth({ initialWidth: 1280 })
  const [containerHeight, setContainerHeight] = useState(0)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [swapTargetId, setSwapTargetId] = useState<string | null>(null)
  const [layoutResetKey, setLayoutResetKey] = useState(0)
  const interactionRef = useRef<GridInteraction | null>(null)
  const rowCount = dashboardRowCount(components)
  const initialGridLayout = useMemo(() => toGridLayout(components), [components])
  const gridSpacing = theme === 'business-light'
    ? { gap: 10, padding: 14 }
    : theme === 'minimal-light'
      ? { gap: 12, padding: 14 }
      : { gap: 8, padding: 12 }
  const rowHeight = Math.max(
    1,
    (containerHeight - gridSpacing.padding * 2 - gridSpacing.gap * (rowCount - 1)) / rowCount
  )

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const updateHeight = (): void => {
      const nextHeight = Math.round(node.getBoundingClientRect().height)
      setContainerHeight((current) => current === nextHeight ? current : nextHeight)
    }
    updateHeight()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    return () => observer.disconnect()
  }, [containerRef])

  const setError = (message: string): void => {
    onInteractionError(message)
  }

  const beginInteraction = (mode: GridInteraction['mode'], id: string): void => {
    const origin = toDashboardLayouts(components, initialGridLayout)
    interactionRef.current = {
      id,
      mode,
      origin,
      accepted: origin,
      rejected: false
    }
    setActiveDragId(id)
    setSwapTargetId(null)
    setError('')
    onSelect(id)
  }

  const evaluateLayout = (nextLayout: GridLayout): void => {
    const interaction = interactionRef.current
    if (!interaction) return
    const nextItem = nextLayout.find((item) => item.i === interaction.id)
    if (!nextItem) return
    const candidate = toDashboardLayout(nextItem)
    const acceptedComponents = toLayoutComponents(components, interaction.accepted)

    if (interaction.mode === 'move') {
      const swap = swapDashboardComponentLayouts(acceptedComponents, interaction.id, candidate)
      if (swap) {
        if (swap.errors.length) {
          interaction.rejected = true
          setSwapTargetId(null)
          setError(swap.errors[0])
          return
        }
        interaction.accepted = {
          ...interaction.accepted,
          [interaction.id]: swap.draggedLayout,
          [swap.targetId]: swap.targetLayout
        }
        interaction.rejected = false
        setSwapTargetId(swap.targetId)
        setError('')
        return
      }
    }

    const errors = validateDashboardLayout(acceptedComponents, interaction.id, candidate)
    if (errors.length) {
      interaction.rejected = true
      setSwapTargetId(null)
      setError(errors[0])
      return
    }
    interaction.accepted = {
      ...interaction.accepted,
      [interaction.id]: candidate
    }
    interaction.rejected = false
    setSwapTargetId(null)
    setError('')
  }

  const finishInteraction = (finalLayout: GridLayout): void => {
    const interaction = interactionRef.current
    if (!interaction) return
    evaluateLayout(finalLayout)
    const finished = interactionRef.current
    if (!finished) return
    const accepted = finished.accepted
    const rejected = finished.rejected
    interactionRef.current = null
    setActiveDragId(null)
    setSwapTargetId(null)
    setError('')
    if (rejected) setLayoutResetKey((current) => current + 1)
    if (layoutsChanged(components, accepted)) onLayoutCommit(accepted)
  }

  const handleDragStart: EventCallback = (_layout, oldItem) => {
    if (oldItem && !preview) beginInteraction('move', oldItem.i)
  }

  const handleDrag: EventCallback = (layout) => {
    if (!preview && interactionRef.current?.mode === 'move') evaluateLayout(layout)
  }

  const handleDragStop: EventCallback = (layout) => {
    if (!preview) finishInteraction(layout)
  }

  const handleResizeStart: EventCallback = (_layout, oldItem) => {
    if (oldItem && !preview) beginInteraction('resize', oldItem.i)
  }

  const handleResize: EventCallback = (layout) => {
    if (!preview && interactionRef.current?.mode === 'resize') evaluateLayout(layout)
  }

  const handleResizeStop: EventCallback = (layout) => {
    if (!preview) finishInteraction(layout)
  }

  const gridConfig = useMemo(() => ({
    cols: dashboardGridColumns,
    rowHeight,
    margin: [gridSpacing.gap, gridSpacing.gap] as const,
    containerPadding: [gridSpacing.padding, gridSpacing.padding] as const,
    maxRows: dashboardGridRows
  }), [gridSpacing.gap, gridSpacing.padding, rowHeight])
  const dragConfig = useMemo(() => ({
    enabled: !preview,
    bounded: true,
    handle: '.dashboard-widget > header',
    cancel: 'button, .react-resizable-handle',
    threshold: 3
  }), [preview])
  const resizeConfig = useMemo(() => ({
    enabled: !preview,
    handles: ['se'] as const,
    handleComponent: resizeHandle
  }), [preview])

  return (
    <div
      className="dashboard-grid-shell"
      ref={containerRef}
    >
      {mounted && containerHeight > 0 && (
        <ReactGridLayout
          key={layoutResetKey}
          width={width}
          layout={initialGridLayout}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          compactor={noOverlapCompactor}
          autoSize={false}
          className="dashboard-grid"
          style={{ height: '100%' }}
          onDragStart={handleDragStart}
          onDrag={handleDrag}
          onDragStop={handleDragStop}
          onResizeStart={handleResizeStart}
          onResize={handleResize}
          onResizeStop={handleResizeStop}
        >
          {components.map((component) => {
            const isDragging = !preview && activeDragId === component.id
            const isSwapTarget = !preview && swapTargetId === component.id
            return (
              <section
                className={[
                  'dashboard-widget',
                  `widget-${component.type}`,
                  !preview && selectedId === component.id ? 'selected' : '',
                  isDragging ? 'is-dragging' : '',
                  isSwapTarget ? 'is-swap-target' : ''
                ].filter(Boolean).join(' ')}
                key={component.id}
                onClick={() => !preview && onSelect(component.id)}
              >
                <header>
                  <div>
                    <h3>{component.title}</h3>
                    {component.subtitle && <p>{component.subtitle}</p>}
                  </div>
                  <div className="dashboard-widget-tools">
                    {!preview && component.query && (
                      <button
                        type="button"
                        className="dashboard-provenance-button"
                        aria-label={`鏌ョ湅${component.title}鏁版嵁鍙ｅ緞`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onProvenance(component)
                        }}
                      >
                        <InfoCircleOutlined />
                      </button>
                    )}
                    <span className="widget-corner" />
                  </div>
                </header>
                <div className="dashboard-widget-content">
                  <DashboardComponentRenderer component={component} theme={theme} />
                </div>
              </section>
            )
          })}
        </ReactGridLayout>
      )}
    </div>
  )
}
