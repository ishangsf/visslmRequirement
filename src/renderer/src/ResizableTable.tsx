import { Table } from 'antd'
import type {
  TableColumnGroupType,
  TableColumnsType,
  TableColumnType,
  TableProps
} from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const COLUMN_WIDTH_STORAGE_VERSION = 'v1'
const DEFAULT_COLUMN_WIDTH = 140

type StoredColumnWidths = Record<string, number>

type ResizeHeaderCellProps = Omit<React.ThHTMLAttributes<HTMLTableCellElement>, 'width'> & {
  width?: number
  columnKey?: string
  columnLabel?: string
  minWidth?: number
  maxWidth?: number
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}

const clampWidth = (value: number, minimum: number, maximum: number): number => (
  Math.min(maximum, Math.max(minimum, Math.round(value)))
)

const getStorageKey = (tableKey: string): string => (
  `visslm:table-column-widths:${COLUMN_WIDTH_STORAGE_VERSION}:${tableKey}`
)

const readStoredWidths = (tableKey: string): StoredColumnWidths => {
  if (typeof window === 'undefined') return {}
  try {
    const value = window.localStorage.getItem(getStorageKey(tableKey))
    if (!value) return {}
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, width]) => typeof width === 'number' && Number.isFinite(width))
    )
  } catch {
    return {}
  }
}

const saveStoredWidths = (tableKey: string, widths: StoredColumnWidths): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(getStorageKey(tableKey), JSON.stringify(widths))
  } catch {
    // The table remains usable when local storage is unavailable.
  }
}

const getColumnLabel = (title: unknown, fallback: string): string => {
  if (typeof title === 'string' || typeof title === 'number') return String(title)
  if (Array.isArray(title)) {
    const text = title.filter((item): item is string | number => typeof item === 'string' || typeof item === 'number').join('')
    if (text) return text
  }
  return fallback
}

const getColumnKey = <RecordType,>(
  column: TableColumnType<RecordType>,
  path: string
): string => {
  if (column.key !== undefined && column.key !== null) return String(column.key)
  if (column.dataIndex !== undefined) {
    return Array.isArray(column.dataIndex) ? column.dataIndex.map(String).join('.') : String(column.dataIndex)
  }
  return path
}

const getRecordValue = (record: unknown, dataIndex: unknown): unknown => {
  const path = Array.isArray(dataIndex)
    ? dataIndex
    : dataIndex === undefined || dataIndex === null
      ? []
      : [dataIndex]

  return path.reduce<unknown>((value, key) => {
    if (value === null || value === undefined || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[String(key)]
  }, record)
}

const getCellTitle = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return undefined
  const text = String(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text || undefined
}

const getDefaultWidth = <RecordType,>(column: TableColumnType<RecordType>): number => {
  if (typeof column.width === 'number' && Number.isFinite(column.width) && column.width > 0) return column.width
  const title = getColumnLabel(column.title, '')
  return Math.min(260, Math.max(DEFAULT_COLUMN_WIDTH, 92 + title.length * 16))
}

const getWidthBounds = (defaultWidth: number): { minWidth: number; maxWidth: number } => {
  const minWidth = Math.max(56, Math.min(defaultWidth, Math.round(defaultWidth * 0.55)))
  const maxWidth = Math.max(minWidth, Math.min(720, Math.max(defaultWidth + 160, Math.round(defaultWidth * 2.2))))
  return { minWidth, maxWidth }
}

const getTableWidth = <RecordType,>(columns: TableColumnsType<RecordType>): number => columns.reduce((total, column) => {
  if ('children' in column && column.children) return total + getTableWidth(column.children)
  return total + (typeof column.width === 'number' ? column.width : 0)
}, 0)

function ResizableHeaderCell({
  width,
  columnKey,
  columnLabel,
  minWidth = 56,
  maxWidth = 720,
  onResize,
  onResizeEnd,
  children,
  className,
  style,
  ...restProps
}: ResizeHeaderCellProps): React.JSX.Element {
  const cleanupRef = useRef<(() => void) | null>(null)
  const currentWidth = clampWidth(width ?? DEFAULT_COLUMN_WIDTH, minWidth, maxWidth)

  useEffect(() => () => {
    cleanupRef.current?.()
  }, [])

  const adjustByKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (!onResize) return
    const delta = event.key === 'ArrowRight' ? 12 : event.key === 'ArrowLeft' ? -12 : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    const nextWidth = clampWidth(currentWidth + delta, minWidth, maxWidth)
    onResize(nextWidth)
    onResizeEnd?.(nextWidth)
  }

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!onResize) return
    event.preventDefault()
    event.stopPropagation()

    cleanupRef.current?.()
    const startX = event.clientX
    const startWidth = currentWidth
    const pointerId = event.pointerId
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const getNextWidth = (clientX: number): number => (
      clampWidth(startWidth + clientX - startX, minWidth, maxWidth)
    )
    const handlePointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      onResize(getNextWidth(moveEvent.clientX))
    }
    const handlePointerUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      const nextWidth = getNextWidth(upEvent.clientX)
      onResize(nextWidth)
      onResizeEnd?.(nextWidth)
      cleanupRef.current?.()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      cleanupRef.current = null
    }

    cleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }

  const isFixedCell = className?.includes('ant-table-cell-fix') ?? false

  return (
    <th
      {...restProps}
      className={[className, 'project-resizable-header-cell'].filter(Boolean).join(' ')}
      style={{
        ...style,
        ...(!style?.position && !isFixedCell ? { position: 'relative' } : {}),
        width: currentWidth,
        minWidth: currentWidth
      }}
    >
      {children}
      {onResize && (
        <button
          type="button"
          className="project-table-resize-handle"
          aria-label={`调整${columnLabel ?? columnKey ?? ''}列宽`}
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={currentWidth}
          title="拖拽调整列宽"
          onPointerDown={beginResize}
          onKeyDown={adjustByKeyboard}
        />
      )}
    </th>
  )
}

export interface ResizableTableProps<RecordType = Record<string, unknown>> extends TableProps<RecordType> {
  /** Stable identifier used to isolate and persist this table's column widths. */
  tableKey: string
}

export function ResizableTable<RecordType = Record<string, unknown>>({
  tableKey,
  columns = [],
  components,
  className,
  scroll,
  tableLayout,
  ...restProps
}: ResizableTableProps<RecordType>): React.JSX.Element {
  const [storedWidths, setStoredWidths] = useState<StoredColumnWidths>(() => readStoredWidths(tableKey))
  const storedWidthsRef = useRef(storedWidths)

  useEffect(() => {
    const next = readStoredWidths(tableKey)
    storedWidthsRef.current = next
    setStoredWidths(next)
  }, [tableKey])

  const updateWidth = useCallback((columnKey: string, value: number, minimum: number, maximum: number): void => {
    const next = { ...storedWidthsRef.current, [columnKey]: clampWidth(value, minimum, maximum) }
    storedWidthsRef.current = next
    setStoredWidths(next)
  }, [])

  const commitWidth = useCallback((columnKey: string, value: number, minimum: number, maximum: number): void => {
    const next = { ...storedWidthsRef.current, [columnKey]: clampWidth(value, minimum, maximum) }
    storedWidthsRef.current = next
    setStoredWidths(next)
    saveStoredWidths(tableKey, next)
  }, [tableKey])

  const preparedColumns = useMemo<TableColumnsType<RecordType>>(() => {
    const prepare = (source: TableColumnsType<RecordType>, parentPath = ''): TableColumnsType<RecordType> => source.map((column, index) => {
      const path = parentPath ? `${parentPath}.${index}` : String(index)
      if ('children' in column && column.children) {
        const group = column as TableColumnGroupType<RecordType>
        return { ...group, children: prepare(group.children, path) }
      }

      const leaf = column as TableColumnType<RecordType>
      const columnKey = getColumnKey(leaf, path)
      const defaultWidth = getDefaultWidth(leaf)
      const { minWidth, maxWidth } = getWidthBounds(defaultWidth)
      const width = clampWidth(storedWidths[columnKey] ?? defaultWidth, minWidth, maxWidth)
      const label = getColumnLabel(leaf.title, `第 ${index + 1} 列`)
      const originalOnHeaderCell = leaf.onHeaderCell
      const originalOnCell = leaf.onCell

      return {
        ...leaf,
        width,
        onCell: (record, rowIndex) => {
          const baseProps = originalOnCell?.(record, rowIndex) ?? {}
          const cellTitle = getCellTitle(getRecordValue(record, leaf.dataIndex ?? leaf.key))
          return {
            ...baseProps,
            ...(cellTitle && !baseProps.title ? { title: cellTitle } : {})
          }
        },
        onHeaderCell: (headerColumn, headerIndex) => {
          const baseProps = originalOnHeaderCell?.(headerColumn, headerIndex) ?? {}
          const baseResize = (baseProps as ResizeHeaderCellProps).onResize
          const baseResizeEnd = (baseProps as ResizeHeaderCellProps).onResizeEnd
          return {
            ...baseProps,
            width,
            columnKey,
            columnLabel: label,
            minWidth,
            maxWidth,
            onResize: (nextWidth: number) => {
              updateWidth(columnKey, nextWidth, minWidth, maxWidth)
              baseResize?.(nextWidth)
            },
            onResizeEnd: (nextWidth: number) => {
              commitWidth(columnKey, nextWidth, minWidth, maxWidth)
              baseResizeEnd?.(nextWidth)
            }
          } as React.HTMLAttributes<HTMLTableCellElement> & React.TdHTMLAttributes<HTMLTableCellElement>
        }
      }
    })

    return prepare(columns)
  }, [columns, commitWidth, storedWidths, updateWidth])

  const totalWidth = useMemo(() => getTableWidth(preparedColumns), [preparedColumns])

  const mergedScroll = useMemo(() => {
    const scrollX = typeof scroll?.x === 'number' ? Math.max(scroll.x, totalWidth) : scroll?.x ?? totalWidth
    return { ...scroll, x: scrollX }
  }, [scroll, totalWidth])

  const mergedComponents = useMemo(() => ({
    ...components,
    header: {
      ...components?.header,
      cell: ResizableHeaderCell
    }
  }), [components])

  return (
    <Table<RecordType>
      {...restProps}
      className={[className, 'resizable-table'].filter(Boolean).join(' ')}
      columns={preparedColumns}
      components={mergedComponents}
      scroll={mergedScroll}
      tableLayout={tableLayout ?? 'fixed'}
    />
  )
}
