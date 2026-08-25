import {
  AppstoreOutlined,
  AuditOutlined,
  BgColorsOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileImageOutlined,
  FileZipOutlined,
  FullscreenOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  UndoOutlined
} from '@ant-design/icons'
import {
  App,
  Alert,
  ColorPicker,
  Button,
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import type {
  DashboardComponentSpec,
  DashboardComponentType,
  DashboardFilter,
  DashboardLayout,
  DashboardQualityReport,
  DashboardSpec,
  DashboardSummary,
  DashboardThemeId,
  DashboardVersion,
  DashboardVersionDiff,
  DashboardAuditLog,
  VisualizationRun
} from '../../../shared/dashboard'
import { compareDashboardSpecs } from '../../../shared/dashboard'
import type { DashboardStats } from '../../../shared/types'
import type {
  FieldProfile,
  FilterOperator,
  FilterSpec,
  QueryAggregation,
  QueryCalculation,
  QueryComparisonMode,
  QueryDataset,
  QueryDimension,
  QueryMeasure,
  QuerySpec
} from '../../../shared/query-spec'
import {
  dashboardLayoutProfiles,
  validateDashboardLayout
} from '../../../shared/dashboard-layout'
import {
  analyzeComponentProvenance,
  analyzeDashboardExport
} from '../../../shared/dashboard-governance'
import { dashboardComponentRegistry } from './componentRegistry'
import {
  dashboardComponentDataShape,
  planDashboardComponentTypeChange
} from './componentTypeAdapter'
import { DashboardGrid } from './DashboardGrid'
import { DashboardAiDrawer } from './DashboardAiDrawer'
import {
  dashboardDraftStorageKey,
  parseDashboardDraft,
  serializeDashboardDraft
} from './dashboardDraft'
import { buildSampleDashboard } from './sampleDashboard'

const { Text } = Typography

const componentTypeIcons: Record<DashboardComponentType, string> = {
  kpi: '01',
  line: '02',
  bar: '03',
  pie: '04',
  ranking: '05',
  progress: '06',
  table: '07',
  insight: 'AI',
  gauge: '08',
  funnel: '09',
  radar: '10',
  scatter: '11'
}

const repairableQualityIssueCodes = new Set(['spec-validation', 'query-error'])

const visualizationToolLabels: Record<VisualizationRun['toolCalls'][number]['tool'], string> = {
  'profile-fields': '字段画像',
  'model-compose': '模型编排',
  'validate-dashboard': '结构校验',
  'execute-query': '执行查询',
  'apply-patch': '应用修改',
  'repair-attempt': '自动修复'
}

const visualizationToolMetadataLabels: Record<string, string> = {
  fieldCount: '字段',
  errorCount: '错误',
  componentCount: '组件',
  resultRows: '返回',
  scannedRows: '扫描',
  matchedRows: '命中',
  truncated: '截断',
  operationCount: '操作',
  nextAttempt: '下一轮',
  validationIssueCount: '问题'
}

const formatComponentRepairError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const detail = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
  if (detail.includes('修复后整屏校验失败')) {
    return '修复后的整屏校验仍有其他未解决问题，请先处理其余错误组件后重试。'
  }
  return detail.length > 240 ? `${detail.slice(0, 240)}…` : detail
}

const aggregationOptions: Array<{ label: string; value: QueryAggregation }> = [
  { label: 'count', value: 'count' },
  { label: 'countDistinct', value: 'countDistinct' },
  { label: 'sum', value: 'sum' },
  { label: 'avg', value: 'avg' },
  { label: 'min', value: 'min' },
  { label: 'max', value: 'max' }
]

const calculationOptions: Array<{ label: string; value: QueryCalculation | '' }> = [
  { label: 'base', value: '' },
  { label: 'YoY %', value: 'yoy' },
  { label: 'MoM %', value: 'mom' },
  { label: 'share %', value: 'share' },
  { label: 'cumulative', value: 'cumulative' }
]

const comparisonModeOptions: Array<{ label: string; value: QueryComparisonMode }> = [
  { label: '百分比变化', value: 'percent' },
  { label: '差值', value: 'difference' }
]

const filterOperatorOptions: Array<{ label: string; value: FilterOperator }> = [
  { label: '=', value: 'equals' },
  { label: '≠', value: 'notEquals' },
  { label: 'contains', value: 'contains' },
  { label: 'not contains', value: 'notContains' },
  { label: 'in', value: 'in' },
  { label: 'not in', value: 'notIn' },
  { label: 'empty', value: 'empty' },
  { label: 'not empty', value: 'notEmpty' },
  { label: '>', value: 'gt' },
  { label: '≥', value: 'gte' },
  { label: '<', value: 'lt' },
  { label: '≤', value: 'lte' }
]

const timeGrainOptions = [
  { label: 'day', value: 'day' },
  { label: 'week', value: 'week' },
  { label: 'month', value: 'month' },
  { label: 'quarter', value: 'quarter' }
]

const dashboardThemeBackgrounds: Record<DashboardThemeId, string> = {
  'technology-dark': '#080d16',
  'business-light': '#e8edf4',
  'charcoal-dark': '#171717',
  'minimal-light': '#f4f6f5'
}

const filterValueToText = (value: FilterSpec['value']): string => {
  if (Array.isArray(value)) return value.map(String).join(', ')
  if (value === undefined) return ''
  return String(value)
}

const parseFilterValue = (
  rawValue: string,
  operator: FilterOperator,
  inferredType?: FieldProfile['inferredType']
): FilterSpec['value'] => {
  const raw = rawValue.trim()
  if (!raw) return undefined
  const parseScalar = (value: string): string | number | boolean => {
    if (inferredType === 'number') {
      const number = Number(value)
      if (Number.isFinite(number)) return number
    }
    if (inferredType === 'boolean') {
      if (value.toLocaleLowerCase() === 'true') return true
      if (value.toLocaleLowerCase() === 'false') return false
    }
    return value
  }
  if (operator === 'in' || operator === 'notIn') {
    return raw.split(',').map((value) => parseScalar(value.trim())).filter((value) => String(value))
  }
  return parseScalar(raw)
}

const dashboardFilterQuerySpecs = (filters: DashboardFilter[]): FilterSpec[] =>
  filters.flatMap((filter) => {
    const value = filter.value
    if (value === undefined || (Array.isArray(value) && value.length === 0)) return []
    return [{
      field: filter.field,
      operator: filter.operator,
      value,
      source: 'dashboard' as const
    }]
  })

const filterValueArray = (value: DashboardFilter['value']): string[] => {
  if (Array.isArray(value)) return value.map(String)
  return value === undefined ? [] : [String(value)]
}

const cloneSpec = (spec: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(spec)) as DashboardSpec

const cloneQuery = (query: QuerySpec): QuerySpec =>
  JSON.parse(JSON.stringify(query)) as QuerySpec

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const queryDataPoints = (
  component: DashboardComponentSpec,
  dataset: QueryDataset
): DashboardComponentSpec['data'] => {
  const labelField = component.encoding?.label
  const valueField = component.encoding?.value
  const secondaryField = component.encoding?.secondaryValue
  if (!valueField) return []
  return dataset.rows.map((row, index) => ({
    name: String(labelField ? row[labelField] ?? `Data ${index + 1}` : component.title),
    value: Number(row[valueField] ?? 0),
    ...(secondaryField ? { secondaryValue: Number(row[secondaryField] ?? 0) } : {})
  }))
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const dashboardInspectorWidthStorageKey = 'visslm:dashboard-inspector-width:v1'
const dashboardInspectorDefaultWidth = 200
const dashboardInspectorMinimumWidth = 200
const dashboardInspectorMaximumWidth = 420

const clampDashboardInspectorWidth = (value: number): number =>
  Math.min(
    dashboardInspectorMaximumWidth,
    Math.max(dashboardInspectorMinimumWidth, Math.round(value))
  )

const readDashboardInspectorWidth = (): number => {
  if (typeof window === 'undefined') return dashboardInspectorDefaultWidth
  try {
    const stored = Number(window.localStorage.getItem(dashboardInspectorWidthStorageKey))
    return Number.isFinite(stored) && stored > 0
      ? clampDashboardInspectorWidth(stored)
      : dashboardInspectorDefaultWidth
  } catch {
    return dashboardInspectorDefaultWidth
  }
}

const persistDashboardInspectorWidth = (width: number): void => {
  try {
    window.localStorage.setItem(
      dashboardInspectorWidthStorageKey,
      String(clampDashboardInspectorWidth(width))
    )
  } catch {
    // The inspector remains resizable when local storage is unavailable.
  }
}

export function DashboardStudio({
  generatedDashboard,
  generatedDashboardVersion,
  onDashboardChange
}: {
  generatedDashboard?: DashboardSpec | null
  generatedDashboardVersion?: number
  onDashboardChange?: (dashboard: DashboardSpec, version?: number) => void
}): React.JSX.Element {
  const { message } = App.useApp()
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [dashboard, setDashboard] = useState<DashboardSpec | null>(null)
  const [dashboards, setDashboards] = useState<DashboardSummary[]>([])
  const [versions, setVersions] = useState<DashboardVersion[]>([])
  const [versionDiff, setVersionDiff] = useState<DashboardVersionDiff | null>(null)
  const [currentVersion, setCurrentVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [history, setHistory] = useState<DashboardSpec[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLogs, setAuditLogs] = useState<DashboardAuditLog[]>([])
  const [qualityOpen, setQualityOpen] = useState(false)
  const [provenanceComponent, setProvenanceComponent] = useState<DashboardComponentSpec | null>(null)
  const [pendingExport, setPendingExport] = useState<'png' | 'pdf' | 'json' | 'offline' | null>(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  const [qualityReport, setQualityReport] = useState<DashboardQualityReport | null>(null)
  const [visualizationRuns, setVisualizationRuns] = useState<VisualizationRun[]>([])
  const [diagnosing, setDiagnosing] = useState(false)
  const [repairingComponentId, setRepairingComponentId] = useState<string | null>(null)
  const [repairError, setRepairError] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [printMode, setPrintMode] = useState(false)
  const [captureMode, setCaptureMode] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiArtifactVersion, setAiArtifactVersion] = useState<number | undefined>(generatedDashboardVersion)
  const [fieldProfiles, setFieldProfiles] = useState<FieldProfile[]>([])
  const [queryLoading, setQueryLoading] = useState(false)
  const generatedIdRef = useRef<string | null>(null)
  const sampleDashboardRef = useRef(false)
  const publishedDashboardSignatureRef = useRef<string | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const studioBodyRef = useRef<HTMLDivElement>(null)
  const inspectorResizeCleanupRef = useRef<(() => void) | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(readDashboardInspectorWidth)
  const inspectorWidthRef = useRef(inspectorWidth)
  const [interactionError, setInteractionError] = useState('')

  useEffect(() => () => {
    inspectorResizeCleanupRef.current?.()
  }, [])

  const applyInspectorWidth = (value: number, commit: boolean): void => {
    const nextWidth = clampDashboardInspectorWidth(value)
    inspectorWidthRef.current = nextWidth
    studioBodyRef.current?.style.setProperty('--dashboard-inspector-width', `${nextWidth}px`)
    if (!commit) return
    setInspectorWidth(nextWidth)
    persistDashboardInspectorWidth(nextWidth)
  }

  const beginInspectorResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    inspectorResizeCleanupRef.current?.()

    const startX = event.clientX
    const startWidth = inspectorWidthRef.current
    const pointerId = event.pointerId
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    studioBodyRef.current?.classList.add('is-inspector-resizing')

    const widthAt = (clientX: number): number =>
      clampDashboardInspectorWidth(startWidth + startX - clientX)
    const handlePointerMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== pointerId) return
      applyInspectorWidth(widthAt(moveEvent.clientX), false)
    }
    const handlePointerUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== pointerId) return
      applyInspectorWidth(widthAt(upEvent.clientX), true)
      inspectorResizeCleanupRef.current?.()
    }
    const handlePointerCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId !== pointerId) return
      applyInspectorWidth(inspectorWidthRef.current, true)
      inspectorResizeCleanupRef.current?.()
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      studioBodyRef.current?.classList.remove('is-inspector-resizing')
      inspectorResizeCleanupRef.current = null
    }

    inspectorResizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerCancel)
  }

  const adjustInspectorWidthByKeyboard = (
    event: ReactKeyboardEvent<HTMLDivElement>
  ): void => {
    const delta = event.key === 'ArrowLeft' ? 12 : event.key === 'ArrowRight' ? -12 : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    applyInspectorWidth(inspectorWidthRef.current + delta, true)
  }

  const restoreDraft = (spec: DashboardSpec): DashboardSpec => {
    const draft = parseDashboardDraft(
      window.localStorage.getItem(dashboardDraftStorageKey(spec.id)),
      spec.id
    )
    setDraftSavedAt(draft?.savedAt ?? null)
    return draft?.spec ?? spec
  }

  const refreshDashboards = async (): Promise<void> => {
    setDashboards(await window.visslm.listDashboards())
  }

  useEffect(() => {
    void Promise.all([window.visslm.getStats(), window.visslm.listDashboards()]).then(
      ([nextStats, saved]) => {
        setStats(nextStats)
        setDashboards(saved)
      }
    )
  }, [])

  useEffect(() => {
    if (!generatedDashboard || generatedIdRef.current === generatedDashboard.id) return
    generatedIdRef.current = generatedDashboard.id
    sampleDashboardRef.current = false
    const nextDashboard = restoreDraft(cloneSpec(generatedDashboard))
    setDashboard(nextDashboard)
    setSelectedId(nextDashboard.components[0]?.id ?? null)
    setHistory([])
    setCurrentVersion(0)
    setAiArtifactVersion(generatedDashboardVersion)
  }, [generatedDashboard, generatedDashboardVersion])

  useEffect(() => {
    if (!dashboard && stats) {
      sampleDashboardRef.current = true
      const sample = restoreDraft(buildSampleDashboard(stats))
      setDashboard(sample)
      setSelectedId(sample.components[0]?.id ?? null)
    }
  }, [dashboard, stats])

  useEffect(() => {
    if (!dashboard || sampleDashboardRef.current) return
    const signature = JSON.stringify(dashboard)
    if (publishedDashboardSignatureRef.current === signature) return
    publishedDashboardSignatureRef.current = signature
    onDashboardChange?.(dashboard, aiArtifactVersion)
  }, [aiArtifactVersion, dashboard, onDashboardChange])

  useEffect(() => {
    if (!dashboard) return
    const timer = window.setTimeout(() => {
      const savedAt = new Date().toISOString()
      window.localStorage.setItem(
        dashboardDraftStorageKey(dashboard.id),
        serializeDashboardDraft(dashboard, savedAt)
      )
      setDraftSavedAt(savedAt)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [dashboard])

  const selectedComponent = useMemo(
    () => dashboard?.components.find((component) => component.id === selectedId) ?? null,
    [dashboard, selectedId]
  )

  const applyAgentDashboard = (nextDashboard: DashboardSpec, version?: number): void => {
    if (dashboard) setHistory((items) => [...items.slice(-29), cloneSpec(dashboard)])
    setDashboard(nextDashboard)
    setAiArtifactVersion(version ?? aiArtifactVersion)
    setSelectedId((current) => nextDashboard.components.some((component) => component.id === current)
      ? current
      : nextDashboard.components[0]?.id ?? null)
  }

  const undoAgentDashboard = (
    previous: DashboardSpec,
    applied: DashboardSpec,
    previousVersion?: number
  ): boolean => {
    if (!dashboard || JSON.stringify(dashboard) !== JSON.stringify(applied)) return false
    const restored = cloneSpec(previous)
    setDashboard(restored)
    setAiArtifactVersion(previousVersion)
    setHistory((items) => {
      const latest = items.at(-1)
      return latest && JSON.stringify(latest) === JSON.stringify(previous)
        ? items.slice(0, -1)
        : items
    })
    setSelectedId((current) => restored.components.some((component) => component.id === current)
      ? current
      : restored.components[0]?.id ?? null)
    return true
  }
  const fieldProfileScope = selectedComponent?.query?.scope
    ?? dashboard?.components.find((component) => component.query)?.query?.scope
  const fieldProfileScopeKey = JSON.stringify(fieldProfileScope ?? null)

  useEffect(() => {
    const scope = fieldProfileScope
    if (!scope) {
      setFieldProfiles([])
      return
    }
    let canceled = false
    void window.visslm.listFieldProfiles(scope)
      .then((profiles) => {
        if (!canceled) setFieldProfiles(profiles)
      })
      .catch(() => {
        if (!canceled) setFieldProfiles([])
      })
    return () => {
      canceled = true
    }
  }, [fieldProfileScopeKey])
  const exportReview = useMemo(
    () => dashboard ? analyzeDashboardExport(dashboard) : null,
    [dashboard]
  )
  const provenance = useMemo(
    () => provenanceComponent ? analyzeComponentProvenance(provenanceComponent) : null,
    [provenanceComponent]
  )

  const executeComponentQuery = async (
    query: QuerySpec,
    encodingPatch?: DashboardComponentSpec['encoding']
  ): Promise<void> => {
    if (!selectedComponent) return
    const componentId = selectedComponent.id
    setQueryLoading(true)
    try {
      const dataset = await window.visslm.executeQuery(query)
      mutateDashboard((draft) => {
        const component = draft.components.find((item) => item.id === componentId)
        if (!component) return
        component.query = query
        if (encodingPatch) component.encoding = { ...component.encoding, ...encodingPatch }
        component.data = queryDataPoints(component, dataset)
      })
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setQueryLoading(false)
    }
  }

  const applyDashboardFilters = async (nextFilters: DashboardFilter[]): Promise<void> => {
    if (!dashboard || queryLoading) return
    const queryComponents = dashboard.components.filter((component) => component.query)
    const globalFilters = dashboardFilterQuerySpecs(nextFilters)
    setQueryLoading(true)
    try {
      const results: Array<{
        id: string
        query: QuerySpec
        dataset: QueryDataset
      }> = []
      for (let offset = 0; offset < queryComponents.length; offset += 4) {
        const batch = queryComponents.slice(offset, offset + 4)
        const nextBatch = await Promise.all(batch.map(async (component) => {
          const query = component.query!
          const filteredQuery: QuerySpec = {
            ...cloneQuery(query),
            filters: [
              ...(query.filters ?? []).filter((filter) => filter.source !== 'dashboard'),
              ...globalFilters
            ]
          }
          return {
            id: component.id,
            query: filteredQuery,
            dataset: await window.visslm.executeQuery(filteredQuery)
          }
        }))
        results.push(...nextBatch)
      }
      mutateDashboard((draft) => {
        draft.globalFilters = nextFilters.map((filter) => ({
          ...filter,
          options: [...filter.options],
          ...(Array.isArray(filter.value) ? { value: [...filter.value] } : {})
        }))
        for (const result of results) {
          const component = draft.components.find((item) => item.id === result.id)
          if (!component) continue
          component.query = result.query
          component.data = queryDataPoints(component, result.dataset)
        }
      })
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setQueryLoading(false)
    }
  }

  const updateQuery = (
    mutate: (query: QuerySpec) => QuerySpec,
    encodingPatch?: DashboardComponentSpec['encoding']
  ): void => {
    const query = selectedComponent?.query
    if (!query || queryLoading) return
    void executeComponentQuery(mutate(cloneQuery(query)), encodingPatch)
  }

  const updateEncoding = (patch: DashboardComponentSpec['encoding']): void => {
    const query = selectedComponent?.query
    if (!query || queryLoading) return
    void executeComponentQuery(cloneQuery(query), patch)
  }

  const mutateDashboard = (mutate: (draft: DashboardSpec) => void): void => {
    setDashboard((current) => {
      if (!current) return current
      setHistory((items) => [...items.slice(-29), cloneSpec(current)])
      const draft = cloneSpec(current)
      mutate(draft)
      draft.updatedAt = new Date().toISOString()
      return draft
    })
  }

  const commitCanvasLayout = useCallback((layouts: Record<string, DashboardLayout>): void => {
    if (!dashboard) return
    if (!dashboard.components.some((component) => {
      const next = layouts[component.id]
      return next && (
        next.x !== component.layout.x ||
        next.y !== component.layout.y ||
        next.w !== component.layout.w ||
        next.h !== component.layout.h
      )
    })) return
    mutateDashboard((draft) => {
      for (const component of draft.components) {
        const next = layouts[component.id]
        if (next) component.layout = next
      }
    })
  }, [dashboard])

  const updateComponent = (patch: Partial<DashboardComponentSpec>): void => {
    if (!selectedId) return
    mutateDashboard((draft) => {
      const index = draft.components.findIndex((component) => component.id === selectedId)
      if (index >= 0) draft.components[index] = { ...draft.components[index], ...patch }
    })
  }

  const changeComponentType = async (type: DashboardComponentType): Promise<void> => {
    if (!dashboard || !selectedComponent || queryLoading || selectedComponent.type === type) return
    const componentId = selectedComponent.id
    const plan = planDashboardComponentTypeChange(
      dashboard.components,
      componentId,
      type,
      fieldProfiles
    )
    if ('error' in plan) {
      message.warning(plan.error)
      return
    }
    if (!plan.refreshData || !plan.component.query) {
      mutateDashboard((draft) => {
        const index = draft.components.findIndex((component) => component.id === componentId)
        if (index >= 0) draft.components[index] = plan.component
      })
      return
    }

    setQueryLoading(true)
    try {
      const dataset = await window.visslm.executeQuery(plan.component.query)
      const nextComponent: DashboardComponentSpec = {
        ...plan.component,
        data: queryDataPoints(plan.component, dataset)
      }
      mutateDashboard((draft) => {
        const index = draft.components.findIndex((component) => component.id === componentId)
        if (index >= 0) draft.components[index] = nextComponent
      })
    } catch (error) {
      message.error(`图表类型切换失败，已保留原组件：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setQueryLoading(false)
    }
  }

  const updateComponentStyle = (
    patch: NonNullable<DashboardComponentSpec['style']>
  ): void => {
    if (!selectedComponent) return
    updateComponent({ style: { ...selectedComponent.style, ...patch } })
  }

  const updateInlineDataPoint = (
    index: number,
    patch: Partial<DashboardComponentSpec['data'][number]>
  ): void => {
    if (!selectedComponent || selectedComponent.query) return
    const data = selectedComponent.data.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...patch } : item
    )
    updateComponent({ data })
  }

  const addInlineDataPoint = (): void => {
    if (!selectedComponent || selectedComponent.query || selectedComponent.data.length >= 20) return
    const shape = dashboardComponentDataShape(selectedComponent.type)
    updateComponent({
      data: [
        ...selectedComponent.data,
        {
          name: `数据项 ${selectedComponent.data.length + 1}`,
          value: 0,
          ...(shape === 'dual-measure' ? { secondaryValue: 0 } : {})
        }
      ]
    })
  }

  const removeInlineDataPoint = (index: number): void => {
    if (!selectedComponent || selectedComponent.query || selectedComponent.data.length <= 1) return
    updateComponent({
      data: selectedComponent.data.filter((_item, itemIndex) => itemIndex !== index)
    })
  }

  const updateLayout = (
    field: keyof DashboardComponentSpec['layout'],
    value: number | null
  ): void => {
    if (!selectedComponent || value === null) return
    const layout = { ...selectedComponent.layout, [field]: value }
    const errors = dashboard
      ? validateDashboardLayout(dashboard.components, selectedComponent.id, layout)
      : []
    if (errors.length) {
      message.warning(errors[0])
      return
    }
    updateComponent({ layout })
  }

  const fieldOptions = fieldProfiles.map((profile) => ({
    value: profile.field,
    label: `${profile.displayName ?? profile.field} · ${profile.field} (${profile.inferredType}${
      profile.sensitivity === 'sensitive' ? ' · 敏感' : profile.sensitivity === 'internal' ? ' · 内部' : ''})`
  }))
  const profileByField = new Map(fieldProfiles.map((profile) => [profile.field, profile]))

  const updateDimension = (index: number, field?: string): void => {
    if (field && selectedComponent?.query?.dimensions?.some((dimension, dimensionIndex) =>
      dimensionIndex !== index && dimension.field === field
    )) {
      message.warning('同一查询不能重复使用相同维度')
      return
    }
    updateQuery((query) => {
      const dimensions = [...(query.dimensions ?? [])]
      if (!field) {
        dimensions.splice(index, 1)
      } else {
        const previous = dimensions[index]
        const profile = profileByField.get(field)
        dimensions[index] = {
          field,
          ...(profile?.inferredType === 'date' && previous?.timeGrain
            ? { timeGrain: previous.timeGrain }
            : {})
        }
      }
      const resultFields = new Set([
        ...dimensions.map((dimension) => dimension.field),
        ...query.measures.map((measure) => measure.id)
      ])
      return {
        ...query,
        dimensions: dimensions.length ? dimensions : undefined,
        sort: query.sort?.filter((sort) => resultFields.has(sort.field))
      }
    }, {
      label: field
    })
  }

  const addDimension = (): void => {
    const field = fieldProfiles.find((profile) => profile.inferredType === 'date')?.field
      ?? fieldProfiles[0]?.field
    if (!field || (selectedComponent?.query?.dimensions?.length ?? 0) >= 2) return
    updateDimension(selectedComponent?.query?.dimensions?.length ?? 0, field)
  }

  const updateDimensionTimeGrain = (
    index: number,
    timeGrain?: QueryDimension['timeGrain']
  ): void => {
    updateQuery((query) => {
      const dimensions = [...(query.dimensions ?? [])]
      const dimension = dimensions[index]
      if (!dimension) return query
      dimensions[index] = {
        field: dimension.field,
        ...(timeGrain ? { timeGrain } : {})
      }
      return { ...query, dimensions }
    })
  }

  const updateMeasure = (index: number, patch: Partial<QueryMeasure>): void => {
    const previous = selectedComponent?.query?.measures[index]
    if (!previous) return
    if (patch.id && patch.id !== previous.id && selectedComponent?.query?.measures.some(
      (measure, measureIndex) => measureIndex !== index && measure.id === patch.id
    )) {
      message.warning('指标名称必须唯一')
      return
    }
    const encodingPatch = previous && patch.id && previous.id !== patch.id
      ? {
          ...(selectedComponent?.encoding?.value === previous.id ? { value: patch.id } : {}),
          ...(selectedComponent?.encoding?.secondaryValue === previous.id
            ? { secondaryValue: patch.id }
            : {})
        }
      : undefined
    updateQuery((query) => {
      const measures = query.measures.map((measure, measureIndex) =>
        measureIndex === index
          ? { ...measure, ...patch }
          : patch.id && previous.id !== patch.id && measure.formula
            ? {
                ...measure,
                formula: measure.formula.replace(
                  new RegExp(`\\b${escapeRegExp(previous.id)}\\b`, 'g'),
                  patch.id
                )
              }
            : measure
      )
      const sort = patch.id && previous && patch.id !== previous.id
        ? query.sort?.map((item) => item.field === previous.id
          ? { ...item, field: patch.id as string }
          : item)
        : query.sort
      return { ...query, measures, sort }
    }, encodingPatch)
  }

  const addMeasure = (): void => {
    if (!selectedComponent?.query || selectedComponent.query.measures.length >= 8) return
    const existing = new Set(selectedComponent.query.measures.map((measure) => measure.id))
    let index = selectedComponent.query.measures.length + 1
    while (existing.has(`metric${index}`)) index += 1
    const numericField = fieldProfiles.find((profile) => profile.inferredType === 'number')?.field
    updateQuery((query) => ({
      ...query,
      measures: [
        ...query.measures,
        {
          id: `metric${index}`,
          aggregation: numericField ? 'sum' : 'count',
          ...(numericField ? { field: numericField } : {})
        }
      ]
    }))
  }

  const removeMeasure = (index: number): void => {
    if (!selectedComponent?.query || selectedComponent.query.measures.length <= 1) {
      message.warning('至少保留一个指标')
      return
    }
    const removed = selectedComponent.query.measures[index]
    const remaining = selectedComponent.query.measures.filter((_measure, measureIndex) => measureIndex !== index)
    const encodingPatch = removed
      ? {
          ...(selectedComponent.encoding?.value === removed.id
            ? { value: remaining[0]?.id }
            : {}),
          ...(selectedComponent.encoding?.secondaryValue === removed.id
            ? { secondaryValue: remaining[1]?.id ?? remaining[0]?.id }
            : {})
        }
      : undefined
    updateQuery((query) => ({
      ...query,
      measures: query.measures.filter((_measure, measureIndex) => measureIndex !== index),
      sort: query.sort?.filter((sort) => query.measures.some(
        (measure, measureIndex) => measureIndex !== index && measure.id === sort.field
      ))
    }), encodingPatch)
  }

  const updateFilter = (index: number, patch: Partial<FilterSpec>): void => {
    updateQuery((query) => ({
      ...query,
      filters: (query.filters ?? []).map((filter, filterIndex) =>
        filterIndex === index ? { ...filter, ...patch } : filter
      )
    }))
  }

  const addFilter = (): void => {
    const field = fieldProfiles[0]?.field
    if (!field || (selectedComponent?.query?.filters?.length ?? 0) >= 12) return
    updateQuery((query) => ({
      ...query,
      filters: [
        ...(query.filters ?? []),
        { field, operator: 'equals' }
      ]
    }))
  }

  const removeFilter = (index: number): void => {
    updateQuery((query) => ({
      ...query,
      filters: (query.filters ?? []).filter((_filter, filterIndex) => filterIndex !== index)
    }))
  }

  const globalFilterProfiles = fieldProfiles.filter((profile) =>
    profile.inferredType === 'string' ||
    profile.inferredType === 'enum' ||
    profile.inferredType === 'boolean' ||
    profile.inferredType === 'date' ||
    profile.inferredType === 'number'
  )

  const parseGlobalFilterValues = (field: string, values: string[]): DashboardFilter['value'] => {
    const inferredType = profileByField.get(field)?.inferredType
    return values.map((value) => parseFilterValue(value, 'equals', inferredType)).filter(
      (value): value is string | number | boolean => value !== undefined
    )
  }

  const addGlobalFilter = (): void => {
    if (!dashboard || queryLoading) return
    const profile = globalFilterProfiles[0]
    if (!profile || (dashboard.globalFilters?.length ?? 0) >= 8) return
    const nextFilter: DashboardFilter = {
      id: `global-filter-${Date.now()}`,
      field: profile.field,
      label: profile.displayName ?? profile.field,
      operator: 'in',
      options: profile.samples.slice(0, 50)
    }
    void applyDashboardFilters([...(dashboard.globalFilters ?? []), nextFilter])
  }

  const updateGlobalFilter = (
    id: string,
    patch: Partial<DashboardFilter>,
    rerun = true
  ): void => {
    if (!dashboard || queryLoading) return
    const current = dashboard.globalFilters ?? []
    const next = current.map((filter) => filter.id === id ? { ...filter, ...patch } : filter)
    if (rerun) {
      void applyDashboardFilters(next)
      return
    }
    mutateDashboard((draft) => {
      draft.globalFilters = next
    })
  }

  const removeGlobalFilter = (id: string): void => {
    if (!dashboard || queryLoading) return
    void applyDashboardFilters((dashboard.globalFilters ?? []).filter((filter) => filter.id !== id))
  }

  const updateSort = (field: string | undefined, direction: 'asc' | 'desc' = 'desc'): void => {
    updateQuery((query) => ({
      ...query,
      sort: field ? [{ field, direction }] : undefined
    }))
  }

  const undo = (): void => {
    const previous = history.at(-1)
    if (!previous) return
    setDashboard(previous)
    setHistory((items) => items.slice(0, -1))
  }

  const save = async (): Promise<void> => {
    if (!dashboard) return
    setSaving(true)
    try {
      const saved = await window.visslm.saveDashboard({
        spec: dashboard,
        changeSummary: currentVersion ? '画布编辑' : '创建大屏',
        baseVersion: currentVersion
      })
      sampleDashboardRef.current = false
      setDashboard(saved.spec)
      setCurrentVersion(saved.version)
      setAiArtifactVersion(saved.version)
      setHistory([])
      await refreshDashboards()
      message.success(`已保存为 V${saved.version}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const openDashboard = async (id: string): Promise<void> => {
    const saved = await window.visslm.getDashboard(id)
    if (!saved) return
    sampleDashboardRef.current = false
    // Keep the persisted artifact from being reclassified as a new AI result
    // when onDashboardChange publishes the opened Spec to the parent.
    generatedIdRef.current = saved.spec.id
    const nextDashboard = restoreDraft(saved.spec)
    setDashboard(nextDashboard)
    setCurrentVersion(saved.version)
    setAiArtifactVersion(saved.version)
    setSelectedId(nextDashboard.components[0]?.id ?? null)
    setHistory([])
  }

  const discardDraft = (): void => {
    if (!dashboard) return
    window.localStorage.removeItem(dashboardDraftStorageKey(dashboard.id))
    setDraftSavedAt(null)
    message.success('已清除本地草稿')
  }

  const openHistory = async (): Promise<void> => {
    if (!dashboard) return
    setVersions(await window.visslm.listDashboardVersions(dashboard.id))
    setVersionDiff(null)
    setHistoryOpen(true)
  }

  const openAudit = async (): Promise<void> => {
    setAuditOpen(true)
    try {
      setAuditLogs(await window.visslm.listDashboardAuditLogs(undefined, 100))
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    }
  }

  const openQuality = async (): Promise<void> => {
    if (!dashboard) return
    setQualityOpen(true)
    setRepairError('')
    setDiagnosing(true)
    try {
      const [report, runs] = await Promise.all([
        window.visslm.diagnoseDashboard(dashboard),
        window.visslm.listVisualizationRuns(20)
      ])
      setQualityReport(report)
      setVisualizationRuns(runs)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setDiagnosing(false)
    }
  }

  const repairComponent = async (componentId: string): Promise<void> => {
    if (!dashboard || repairingComponentId) return
    const previous = cloneSpec(dashboard)
    setRepairError('')
    setRepairingComponentId(componentId)
    try {
      const result = await window.visslm.repairDashboardComponent(previous, componentId)
      setHistory((items) => [...items.slice(-29), previous])
      setDashboard(result.spec)
      setSelectedId(componentId)
      setQualityReport(result.report)
      message.success(`组件已修复：完成 ${result.actions.length} 项调整`)
    } catch (error) {
      setRepairError(`组件修复失败，原大屏未变更：${formatComponentRepairError(error)}`)
    } finally {
      setRepairingComponentId(null)
    }
  }

  const restore = async (version: number): Promise<void> => {
    if (!dashboard || restoringVersion !== null) return
    setRestoringVersion(version)
    try {
      const restored = await window.visslm.restoreDashboard(dashboard.id, version)
      sampleDashboardRef.current = false
      setDashboard(restored.spec)
      setCurrentVersion(restored.version)
      setAiArtifactVersion(restored.version)
      setHistory([])
      setVersions(await window.visslm.listDashboardVersions(dashboard.id))
      await refreshDashboards()
      message.success(`已从 V${version} 恢复，并保存为 V${restored.version}`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setRestoringVersion(null)
    }
  }

  const exportDashboard = async (format: 'json' | 'pdf' | 'png' | 'offline'): Promise<void> => {
    if (!dashboard) return
    setExporting(true)
    try {
      if (format === 'pdf') {
        setPrintMode(true)
        await nextFrame()
      }
      let result
      if (format === 'png') {
        setCaptureMode(true)
        await nextFrame()
        if (!canvasRef.current) throw new Error('大屏画布尚未就绪')
        // PNG export is an infrequent action; keep html-to-image out of the
        // initial dashboard editor chunk and load it only when requested.
        const { toPng } = await import('html-to-image')
        const dataUrl = await toPng(canvasRef.current, {
          width: 1920,
          height: 1080,
          pixelRatio: 1,
          cacheBust: true,
          backgroundColor: dashboardThemeBackgrounds[dashboard.theme]
        })
        result = await window.visslm.exportDashboardPng(dashboard, dataUrl, currentVersion || undefined)
      } else if (format === 'offline') {
        result = await window.visslm.exportDashboardOffline(dashboard, currentVersion || undefined)
      } else {
        result = format === 'json'
          ? await window.visslm.exportDashboardJson(dashboard, currentVersion || undefined)
          : await window.visslm.exportDashboardPdf(dashboard, currentVersion || undefined)
      }
      if (result.ok) message.success(result.message)
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPrintMode(false)
      setCaptureMode(false)
      setExporting(false)
      setPendingExport(null)
    }
  }

  const renderQueryEditor = (query: QuerySpec): React.JSX.Element => {
    const dimensions = query.dimensions ?? []
    const filters = query.filters ?? []
    const numericFieldOptions = fieldProfiles
      .filter((profile) => profile.inferredType === 'number')
      .map((profile) => ({
        value: profile.field,
        label: `${profile.displayName ?? profile.field} · ${profile.field} (number${
          profile.sensitivity === 'sensitive' ? ' · 敏感' : ''})`
      }))
    const measureFieldOptions = [
      { value: '', label: '全部记录（count）' },
      ...fieldOptions
    ]
    const resultFieldOptions = [
      ...dimensions.map((dimension) => ({
        value: dimension.field,
        label: `维度 · ${dimension.field}`
      })),
      ...query.measures.map((measure) => ({
        value: measure.id,
        label: `指标 · ${measure.id}`
      }))
    ]
    const sort = query.sort?.[0]

    return (
      <Collapse
        className="dashboard-query-collapse"
        defaultActiveKey={['query']}
        items={[{
          key: 'query',
          label: (
            <span className="dashboard-query-collapse-label">
              <span>查询配置</span>
              <Space size={4}>
                <Tag color={queryLoading ? 'processing' : 'default'}>
                  {queryLoading ? '执行中' : `${fieldProfiles.length} 个字段`}
                </Tag>
                <Tooltip title="刷新字段画像">
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    aria-label="刷新字段画像"
                    onClick={(event) => {
                      event.stopPropagation()
                      void window.visslm.listFieldProfiles(query.scope)
                        .then(setFieldProfiles)
                        .catch((error) => message.error(error instanceof Error ? error.message : String(error)))
                    }}
                  />
                </Tooltip>
              </Space>
            </span>
          ),
          children: (
            <div className="dashboard-query-editor">
              {!fieldProfiles.length && (
                <Alert
                  type="warning"
                  showIcon
                  title="当前数据范围没有可编辑字段"
                />
              )}

              <section className="dashboard-query-section">
                <div className="dashboard-query-section-header">
                  <strong>维度</strong>
                  <Button
                    type="link"
                    size="small"
                    icon={<PlusOutlined />}
                    disabled={queryLoading || dimensions.length >= 2 || !fieldProfiles.length}
                    onClick={addDimension}
                  >
                    添加
                  </Button>
                </div>
                {dimensions.length ? dimensions.map((dimension, index) => {
                  const profile = profileByField.get(dimension.field)
                  return (
                    <div className="dashboard-query-row dashboard-query-dimension-row" key={`${dimension.field}-${index}`}>
                      <Select
                        value={dimension.field}
                        options={fieldOptions}
                        showSearch
                        optionFilterProp="label"
                        disabled={queryLoading || !fieldProfiles.length}
                        onChange={(field) => updateDimension(index, field)}
                      />
                      {profile?.inferredType === 'date' && (
                        <Select
                          allowClear
                          placeholder="时间粒度"
                          value={dimension.timeGrain}
                          options={timeGrainOptions}
                          disabled={queryLoading}
                          onChange={(grain) => updateDimensionTimeGrain(
                            index,
                            grain as QueryDimension['timeGrain'] | undefined
                          )}
                        />
                      )}
                      <Tooltip title="移除维度">
                        <Button
                          type="text"
                          danger
                          icon={<MinusCircleOutlined />}
                          aria-label={`移除维度 ${dimension.field}`}
                          disabled={queryLoading}
                          onClick={() => updateDimension(index)}
                        />
                      </Tooltip>
                    </div>
                  )
                }) : (
                  <Text type="secondary">未设置分组维度，结果将聚合为单值。</Text>
                )}
              </section>

              <section className="dashboard-query-section">
                <div className="dashboard-query-section-header">
                  <strong>指标</strong>
                  <Button
                    type="link"
                    size="small"
                    icon={<PlusOutlined />}
                    disabled={queryLoading || query.measures.length >= 8}
                    onClick={addMeasure}
                  >
                    添加
                  </Button>
                </div>
                <div className="dashboard-query-measures">
                  {query.measures.map((measure, index) => (
                    <div className="dashboard-query-row dashboard-query-measure-row" key={`${measure.id}-${index}`}>
                      <Input
                        key={`${measure.id}-${index}`}
                        defaultValue={measure.id}
                        placeholder="指标名称"
                        disabled={queryLoading}
                        onPressEnter={(event) => event.currentTarget.blur()}
                        onBlur={(event) => {
                          const id = event.target.value.trim()
                          if (!id) {
                            event.currentTarget.value = measure.id
                          } else if (id !== measure.id) {
                            if (query.measures.some((item, itemIndex) => itemIndex !== index && item.id === id)) {
                              event.currentTarget.value = measure.id
                              message.warning('指标名称必须唯一')
                            } else {
                              updateMeasure(index, { id })
                            }
                          }
                        }}
                      />
                      <Select
                        value={measure.field ?? ''}
                        options={measureFieldOptions}
                        showSearch
                        optionFilterProp="label"
                        disabled={queryLoading || !fieldProfiles.length}
                        onChange={(field) => {
                          const profile = field ? profileByField.get(field) : undefined
                          const numericAggregation = ['sum', 'avg', 'min', 'max'].includes(measure.aggregation)
                          if (numericAggregation && (!profile || profile.inferredType !== 'number')) {
                            message.warning('sum、avg、min、max 需要数值字段')
                            return
                          }
                          if (measure.aggregation === 'countDistinct' && !field) {
                            message.warning('countDistinct 需要指定字段')
                            return
                          }
                          updateMeasure(index, { field: field || undefined })
                        }}
                      />
                      <Select
                        value={measure.aggregation}
                        options={aggregationOptions}
                        disabled={queryLoading}
                        onChange={(aggregation) => {
                          const nextAggregation = aggregation as QueryAggregation
                          const numericAggregation = ['sum', 'avg', 'min', 'max'].includes(nextAggregation)
                          const nextField = measure.field
                            ?? (numericAggregation
                              ? numericFieldOptions[0]?.value
                              : fieldProfiles[0]?.field)
                          if (nextAggregation !== 'count' && !nextField) {
                            message.warning(numericAggregation
                              ? '该聚合方式需要数值字段'
                              : '该聚合方式需要指定字段')
                            return
                          }
                          updateMeasure(index, {
                            aggregation: nextAggregation,
                            field: nextAggregation === 'count' ? measure.field : nextField
                          })
                        }}
                      />
                      <Select
                        value={measure.calculation ?? ''}
                        options={calculationOptions}
                        disabled={queryLoading}
                        onChange={(calculation) => {
                          const next = calculation as QueryCalculation | ''
                          if (next && ['yoy', 'mom', 'cumulative'].includes(next) &&
                              !dimensions.some((dimension) => Boolean(dimension.timeGrain))) {
                            message.warning('同比、环比和累计需要先设置时间粒度')
                            return
                          }
                          updateMeasure(index, {
                            calculation: next || undefined,
                            ...(next ? { formula: undefined, comparison: undefined } : {})
                          })
                        }}
                      />
                      <Input
                        key={`${measure.id}-${measure.formula ?? ''}`}
                        defaultValue={measure.formula ?? ''}
                        placeholder="自定义公式"
                        disabled={queryLoading}
                        onPressEnter={(event) => event.currentTarget.blur()}
                        onBlur={(event) => {
                          const formula = event.target.value.trim()
                          updateMeasure(index, {
                            formula: formula || undefined,
                            ...(formula ? { calculation: undefined, comparison: undefined } : {})
                          })
                        }}
                      />
                      <Tooltip title="向前 N 个当前时间粒度周期对比">
                        <InputNumber
                          min={1}
                          max={24}
                          precision={0}
                          placeholder="周期"
                          value={measure.comparison?.offset}
                          disabled={queryLoading || Boolean(measure.calculation || measure.formula?.trim()) ||
                            !dimensions.some((dimension) => Boolean(dimension.timeGrain))}
                          onChange={(offset) => updateMeasure(index, {
                            comparison: offset === null
                              ? undefined
                              : {
                                  offset,
                                  mode: measure.comparison?.mode ?? 'percent'
                                },
                            ...(offset === null
                              ? {}
                              : { calculation: undefined, formula: undefined })
                          })}
                        />
                      </Tooltip>
                      {measure.comparison && (
                        <Select
                          value={measure.comparison.mode}
                          options={comparisonModeOptions}
                          disabled={queryLoading}
                          onChange={(mode) => updateMeasure(index, {
                            comparison: {
                              ...measure.comparison!,
                              mode: mode as QueryComparisonMode
                            }
                          })}
                        />
                      )}
                      <Tooltip title="移除指标">
                        <Button
                          type="text"
                          danger
                          icon={<MinusCircleOutlined />}
                          aria-label={`移除指标 ${measure.id}`}
                          disabled={queryLoading || query.measures.length <= 1}
                          onClick={() => removeMeasure(index)}
                        />
                      </Tooltip>
                    </div>
                  ))}
                </div>
              </section>

              <section className="dashboard-query-section">
                <div className="dashboard-query-section-header">
                  <strong>筛选</strong>
                  <Button
                    type="link"
                    size="small"
                    icon={<PlusOutlined />}
                    disabled={queryLoading || filters.length >= 12 || !fieldProfiles.length}
                    onClick={addFilter}
                  >
                    添加
                  </Button>
                </div>
                {filters.length ? filters.map((filter, index) => (
                  <div
                    className={`dashboard-query-row dashboard-query-filter-row ${filter.source === 'dashboard' ? 'is-global' : ''}`}
                    key={`${filter.field}-${index}`}
                  >
                    <Select
                      value={filter.field}
                      options={fieldOptions}
                      showSearch
                      optionFilterProp="label"
                      disabled={queryLoading || !fieldProfiles.length || filter.source === 'dashboard'}
                      onChange={(field) => updateFilter(index, { field, value: undefined })}
                    />
                    <Select
                      value={filter.operator}
                      options={filterOperatorOptions}
                      disabled={queryLoading || filter.source === 'dashboard'}
                      onChange={(operator) => {
                        const nextOperator = operator as FilterOperator
                        updateFilter(index, {
                          operator: nextOperator,
                          ...(nextOperator === 'empty' || nextOperator === 'notEmpty'
                            ? { value: undefined }
                            : {})
                        })
                      }}
                    />
                    {filter.operator !== 'empty' && filter.operator !== 'notEmpty' && (
                      <Input
                        key={`${filter.field}-${index}-${filterValueToText(filter.value)}`}
                        defaultValue={filterValueToText(filter.value)}
                        placeholder={filter.operator === 'in' || filter.operator === 'notIn'
                          ? '逗号分隔多个值'
                          : '筛选值'}
                        disabled={queryLoading || filter.source === 'dashboard'}
                        onPressEnter={(event) => event.currentTarget.blur()}
                        onBlur={(event) => updateFilter(index, {
                          value: parseFilterValue(
                            event.target.value,
                            filter.operator,
                            profileByField.get(filter.field)?.inferredType
                          )
                        })}
                      />
                    )}
                    <Tooltip title="移除筛选">
                      <Button
                        type="text"
                        danger
                        icon={<MinusCircleOutlined />}
                        aria-label={`移除筛选 ${filter.field}`}
                        disabled={queryLoading || filter.source === 'dashboard'}
                        onClick={() => removeFilter(index)}
                      />
                    </Tooltip>
                  </div>
                )) : (
                  <Text type="secondary">未设置附加筛选。</Text>
                )}
              </section>

              <section className="dashboard-query-section">
                <div className="dashboard-query-section-header">
                  <strong>排序与行数</strong>
                </div>
                <div className="dashboard-query-row dashboard-query-sort-row">
                  <Select
                    allowClear
                    placeholder="不排序"
                    value={sort?.field}
                    options={resultFieldOptions}
                    disabled={queryLoading || !resultFieldOptions.length}
                    onChange={(field) => updateSort(field, sort?.direction ?? 'desc')}
                  />
                  <Select
                    value={sort?.direction ?? 'desc'}
                    options={[{ label: '降序', value: 'desc' }, { label: '升序', value: 'asc' }]}
                    disabled={queryLoading || !sort}
                    onChange={(direction) => updateSort(sort?.field, direction as 'asc' | 'desc')}
                  />
                  <InputNumber
                    min={1}
                    max={500}
                    precision={0}
                    value={query.limit ?? 100}
                    disabled={queryLoading}
                    addonBefore="Limit"
                    onChange={(limit) => updateQuery((nextQuery) => ({
                      ...nextQuery,
                      limit: limit ?? undefined
                    }))}
                  />
                </div>
              </section>
            </div>
          )
        }]}
      />
    )
  }

  const renderComponentDataEditor = (
    component: DashboardComponentSpec
  ): React.JSX.Element | null => {
    const shape = dashboardComponentDataShape(component.type)
    if (shape === 'text') return null
    const query = component.query

    if (query) {
      const dimensions = query.dimensions ?? []
      const measureOptions = query.measures.map((measure) => ({
        value: measure.id,
        label: `${measure.id} · ${measure.aggregation}`
      }))
      const dimensionOptions = dimensions.map((dimension) => ({
        value: dimension.field,
        label: profileByField.get(dimension.field)?.displayName ?? dimension.field
      }))
      const valueField = component.encoding?.value ?? query.measures[0]?.id
      const secondaryOptions = measureOptions.filter((item) => item.value !== valueField)
      const needsDimension = ['category-value', 'time-series', 'dual-measure'].includes(shape)
      const supportsComparison = component.type === 'bar' || component.type === 'line' || shape === 'detail'
      const dimensionIndex = dimensions.findIndex((item) => item.field === component.encoding?.label)
      const activeDimension = dimensions[dimensionIndex >= 0 ? dimensionIndex : 0]

      return (
        <section className="dashboard-component-data-editor">
          <div className="dashboard-query-section-header">
            <strong>组件数据</strong>
            <Tag>{queryLoading ? '刷新中' : '查询数据'}</Tag>
          </div>
          {needsDimension && (
            <>
              <label>{shape === 'time-series' ? '时间维度' : '分类维度'}</label>
              <Select
                placeholder="选择维度"
                value={component.encoding?.label ?? dimensions[0]?.field}
                options={dimensionOptions}
                disabled={queryLoading || !dimensionOptions.length}
                onChange={(label) => updateEncoding({ label })}
              />
            </>
          )}
          {shape === 'time-series' && activeDimension && (
            <>
              <label>时间粒度</label>
              <Select
                allowClear
                placeholder="原始粒度"
                value={activeDimension.timeGrain}
                options={timeGrainOptions}
                disabled={queryLoading || profileByField.get(activeDimension.field)?.inferredType !== 'date'}
                onChange={(timeGrain) => updateDimensionTimeGrain(
                  dimensionIndex >= 0 ? dimensionIndex : 0,
                  timeGrain as QueryDimension['timeGrain'] | undefined
                )}
              />
            </>
          )}
          <label>{shape === 'dual-measure' ? 'X 轴指标' : '主指标'}</label>
          <Select
            value={valueField}
            options={measureOptions}
            disabled={queryLoading || !measureOptions.length}
            onChange={(value) => updateEncoding({ value })}
          />
          {(supportsComparison || shape === 'dual-measure') && (
            <>
              <label>{shape === 'dual-measure' ? 'Y 轴指标' : '对比指标'}</label>
              <Select
                allowClear={shape !== 'dual-measure'}
                placeholder={shape === 'dual-measure' ? '选择第二指标' : '不显示对比指标'}
                value={component.encoding?.secondaryValue}
                options={secondaryOptions}
                disabled={queryLoading || secondaryOptions.length === 0}
                onChange={(secondaryValue) => updateEncoding({
                  secondaryValue: secondaryValue || undefined
                })}
              />
            </>
          )}
          {shape !== 'single-value' && (
            <>
              <label>{shape === 'detail' ? '显示行数' : '数据项数量'}</label>
              <InputNumber
                min={1}
                max={shape === 'detail' ? 100 : 60}
                precision={0}
                value={query.limit ?? (shape === 'detail' ? 100 : 20)}
                disabled={queryLoading}
                onChange={(limit) => updateQuery((nextQuery) => ({
                  ...nextQuery,
                  limit: limit ?? undefined
                }))}
              />
            </>
          )}
        </section>
      )
    }

    const usesSecondary = shape === 'dual-measure' || shape === 'time-series' || shape === 'detail'
    const visibleData = shape === 'single-value' ? component.data.slice(0, 1) : component.data
    return (
      <section className="dashboard-component-data-editor">
        <div className="dashboard-query-section-header">
          <strong>组件数据</strong>
          <Tag>手动数据</Tag>
        </div>
        {component.type === 'radar' && component.data.length < 3 && (
          <Alert
            type="warning"
            showIcon
            message="雷达图建议至少配置 3 个指标项。"
          />
        )}
        {visibleData.map((item, index) => (
          <div
            className={[
              'dashboard-inline-data-row',
              usesSecondary ? 'has-secondary' : '',
              shape === 'single-value' ? 'is-single' : ''
            ].filter(Boolean).join(' ')}
            key={`${component.id}-data-${index}`}
          >
            <Input
              aria-label={`数据项 ${index + 1} 名称`}
              value={item.name}
              placeholder="名称"
              onChange={(event) => updateInlineDataPoint(index, { name: event.target.value })}
            />
            <InputNumber
              aria-label={shape === 'dual-measure' ? `数据项 ${index + 1} X 值` : `数据项 ${index + 1} 数值`}
              value={item.value}
              placeholder={shape === 'dual-measure' ? 'X 值' : '数值'}
              onChange={(value) => updateInlineDataPoint(index, { value: value ?? 0 })}
            />
            {usesSecondary && (
              <InputNumber
                aria-label={shape === 'dual-measure' ? `数据项 ${index + 1} Y 值` : `数据项 ${index + 1} 对比值`}
                value={item.secondaryValue}
                placeholder={shape === 'dual-measure' ? 'Y 值' : '对比值'}
                onChange={(secondaryValue) => updateInlineDataPoint(index, {
                  secondaryValue: secondaryValue ?? undefined
                })}
              />
            )}
            {shape !== 'single-value' && (
              <Tooltip title="移除数据项">
                <Button
                  type="text"
                  danger
                  icon={<MinusCircleOutlined />}
                  aria-label={`移除数据项 ${index + 1}`}
                  disabled={component.data.length <= 1}
                  onClick={() => removeInlineDataPoint(index)}
                />
              </Tooltip>
            )}
          </div>
        ))}
        {shape !== 'single-value' && (
          <Button
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            disabled={component.data.length >= 20}
            onClick={addInlineDataPoint}
          >
            添加数据项
          </Button>
        )}
      </section>
    )
  }

  const renderComponentStyleEditor = (component: DashboardComponentSpec): React.JSX.Element => {
    const style = component.style ?? {}
    const isValueComponent = ['kpi', 'progress', 'gauge'].includes(component.type)
    const supportsLegend = ['bar', 'line', 'pie', 'funnel', 'radar'].includes(component.type)
    const supportsGrid = ['bar', 'line', 'scatter'].includes(component.type)
    const supportsLineWidth = ['line', 'radar'].includes(component.type)
    const supportsOrientation = ['bar', 'funnel'].includes(component.type)

    return (
      <section className="dashboard-component-style-editor">
        <div className="dashboard-query-section-header">
          <strong>组件样式</strong>
          <Tag>{dashboardComponentRegistry.find((item) => item.type === component.type)?.name}</Tag>
        </div>
        <div className="dashboard-style-grid">
          <label className="dashboard-style-wide-control dashboard-style-color-control">
            <span>强调色</span>
            <ColorPicker
              value={component.accent ?? '#64dbff'}
              showText
              onChange={(color) => updateComponent({ accent: color.toHexString() })}
            />
          </label>
          <label>
            <span>标题字号</span>
            <InputNumber
              min={9}
              max={24}
              value={style.titleFontSize ?? 11}
              onChange={(value) => updateComponentStyle({ titleFontSize: value ?? 11 })}
            />
          </label>
          <label>
            <span>副标题字号</span>
            <InputNumber
              min={8}
              max={18}
              value={style.subtitleFontSize ?? 8}
              onChange={(value) => updateComponentStyle({ subtitleFontSize: value ?? 8 })}
            />
          </label>
          <label>
            <span>内容字号</span>
            <InputNumber
              min={9}
              max={20}
              value={style.bodyFontSize ?? 10}
              onChange={(value) => updateComponentStyle({ bodyFontSize: value ?? 10 })}
            />
          </label>
          <label>
            <span>内容边距</span>
            <InputNumber
              min={4}
              max={20}
              value={style.padding ?? 9}
              onChange={(value) => updateComponentStyle({ padding: value ?? 9 })}
            />
          </label>
          <label>
            <span>圆角</span>
            <InputNumber
              min={0}
              max={12}
              value={style.borderRadius ?? 8}
              onChange={(value) => updateComponentStyle({ borderRadius: value ?? 8 })}
            />
          </label>
          {isValueComponent && (
            <label>
              <span>数值字号</span>
              <InputNumber
                min={14}
                max={48}
                value={style.valueFontSize ?? (component.type === 'kpi' ? 30 : 18)}
                onChange={(value) => updateComponentStyle({ valueFontSize: value ?? 18 })}
              />
            </label>
          )}
          {supportsLineWidth && (
            <label>
              <span>线条宽度</span>
              <InputNumber
                min={1}
                max={8}
                value={style.lineWidth ?? 3}
                onChange={(value) => updateComponentStyle({ lineWidth: value ?? 3 })}
              />
            </label>
          )}
          {supportsOrientation && (
            <label className="dashboard-style-wide-control">
              <span>排列方向</span>
              <Segmented
                value={style.orientation ?? (component.type === 'bar' ? 'horizontal' : 'vertical')}
                options={[
                  { label: '横向', value: 'horizontal' },
                  { label: '纵向', value: 'vertical' }
                ]}
                onChange={(orientation) => updateComponentStyle({
                  orientation: orientation as 'horizontal' | 'vertical'
                })}
              />
            </label>
          )}
        </div>
        <div className="dashboard-style-switches">
          {supportsLegend && (
            <label>
              <span>显示图例</span>
              <Switch
                size="small"
                checked={style.showLegend ?? true}
                onChange={(showLegend) => updateComponentStyle({ showLegend })}
              />
            </label>
          )}
          {supportsGrid && (
            <label>
              <span>显示网格</span>
              <Switch
                size="small"
                checked={style.showGrid ?? true}
                onChange={(showGrid) => updateComponentStyle({ showGrid })}
              />
            </label>
          )}
          {component.type === 'pie' && (
            <label>
              <span>环形模式</span>
              <Switch
                size="small"
                checked={style.donut ?? true}
                onChange={(donut) => updateComponentStyle({ donut })}
              />
            </label>
          )}
        </div>
      </section>
    )
  }

  const renderGlobalFilterEditor = (): React.JSX.Element | null => {
    if (!dashboard) return null
    const filters = dashboard.globalFilters ?? []
    const optionsFor = (filter: DashboardFilter): Array<{ label: string; value: string }> => {
      const profile = profileByField.get(filter.field)
      return [...new Set([...filter.options, ...(profile?.samples ?? [])].map(String))]
        .slice(0, 50)
        .map((value) => ({ label: value, value }))
    }
    return (
      <section className="dashboard-global-filter-editor">
        <div className="dashboard-query-section-header">
          <strong>全局筛选器</strong>
          <Button
            type="link"
            size="small"
            icon={<PlusOutlined />}
            disabled={queryLoading || filters.length >= 8 || !globalFilterProfiles.length}
            onClick={addGlobalFilter}
          >
            添加
          </Button>
        </div>
        {!filters.length ? (
          <Text type="secondary">
            {globalFilterProfiles.length ? '筛选器会同时作用于所有图表。' : '选择带查询的组件后可添加筛选器。'}
          </Text>
        ) : filters.map((filter) => (
          <div className="dashboard-global-filter-row" key={filter.id}>
            <Input
              key={`${filter.id}-${filter.label}`}
              defaultValue={filter.label}
              placeholder="显示名称"
              disabled={queryLoading}
              onBlur={(event) => updateGlobalFilter(
                filter.id,
                { label: event.target.value.trim() || filter.field },
                false
              )}
            />
            <Select
              value={filter.field}
              options={globalFilterProfiles.map((profile) => ({
                value: profile.field,
                label: profile.displayName ?? profile.field
              }))}
              showSearch
              optionFilterProp="label"
              disabled={queryLoading}
              onChange={(field) => {
                const profile = profileByField.get(field)
                updateGlobalFilter(filter.id, {
                  field,
                  label: profile?.displayName ?? field,
                  options: profile?.samples.slice(0, 50) ?? [],
                  value: undefined
                })
              }}
            />
            <Select
              mode="tags"
              value={filterValueArray(filter.value)}
              options={optionsFor(filter)}
              placeholder="选择或输入值"
              tokenSeparators={[',']}
              maxTagCount="responsive"
              disabled={queryLoading}
              onChange={(values) => updateGlobalFilter(filter.id, {
                value: parseGlobalFilterValues(filter.field, values as string[])
              })}
            />
            <Tooltip title="移除全局筛选器">
              <Button
                type="text"
                danger
                icon={<MinusCircleOutlined />}
                aria-label={`移除全局筛选器 ${filter.label}`}
                disabled={queryLoading}
                onClick={() => removeGlobalFilter(filter.id)}
              />
            </Tooltip>
          </div>
        ))}
      </section>
    )
  }

  const renderDashboardFilters = (preview: boolean): React.JSX.Element | null => {
    const filters = dashboard?.globalFilters ?? []
    if (!filters.length) return null
    const optionsFor = (filter: DashboardFilter): Array<{ label: string; value: string }> => {
      const profile = profileByField.get(filter.field)
      return [...new Set([...filter.options, ...(profile?.samples ?? [])].map(String))]
        .slice(0, 50)
        .map((value) => ({ label: value, value }))
    }
    return (
      <div
        className="dashboard-filter-bar"
        onPointerDown={(event) => event.stopPropagation()}
        aria-label="大屏全局筛选器"
      >
        <span className="dashboard-filter-bar-label">筛选</span>
        {filters.map((filter) => (
          <label className="dashboard-filter-control" key={filter.id}>
            <span>{filter.label}</span>
            <Select
              mode="tags"
              value={filterValueArray(filter.value)}
              options={optionsFor(filter)}
              placeholder="全部"
              tokenSeparators={[',']}
              maxTagCount={preview ? 2 : 'responsive'}
              disabled={queryLoading}
              onChange={(values) => updateGlobalFilter(filter.id, {
                value: parseGlobalFilterValues(filter.field, values as string[])
              })}
            />
          </label>
        ))}
        <span className="dashboard-filter-bar-hint">
          {queryLoading ? '正在刷新图表' : '空值表示全部'}
        </span>
      </div>
    )
  }

  const renderCanvas = (preview = false): React.JSX.Element => (
    <div
      className={`dashboard-preview ${preview ? 'is-full-preview' : ''}`}
      ref={preview ? undefined : canvasRef}
      title={!preview && interactionError ? interactionError : undefined}
      onPointerDown={(event) => {
        if (preview || !(event.target instanceof HTMLElement)) return
        if (event.target.closest('.dashboard-widget, .dashboard-filter-bar')) return
        setSelectedId(null)
      }}
    >
      <header className="dashboard-preview-header">
        <div className="dashboard-title-mark" />
        <div>
          <h2>{dashboard?.title}</h2>
          <p>{dashboard?.subtitle}</p>
        </div>
        <div className="dashboard-preview-meta">
          <span className="live-dot" />
          本地数据
          <time>{dashboard ? new Date(dashboard.updatedAt).toLocaleTimeString('zh-CN') : ''}</time>
        </div>
      </header>
      {renderDashboardFilters(preview)}
      <DashboardGrid
        components={dashboard?.components ?? []}
        theme={dashboard?.theme ?? 'technology-dark'}
        preview={preview}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onProvenance={setProvenanceComponent}
        onLayoutCommit={commitCanvasLayout}
        onInteractionError={setInteractionError}
      />
    </div>
  )

  return (
    <div className={[
      'dashboard-studio',
      printMode ? 'dashboard-print-mode' : '',
      captureMode ? 'dashboard-capture-mode' : ''
    ].filter(Boolean).join(' ')}>
      <div className="dashboard-studio-toolbar">
        <div>
          <div className="dashboard-studio-heading">
            <RobotOutlined />
            <span>数据可视化专家工作台</span>
            <Tag color={currentVersion ? 'blue' : 'default'}>
              {currentVersion ? `V${currentVersion}` : '未保存'}
            </Tag>
            {draftSavedAt && (
              <Tooltip title={`本地草稿已于 ${new Date(draftSavedAt).toLocaleTimeString('zh-CN')} 自动保存`}>
                <Tag color="cyan">草稿</Tag>
              </Tooltip>
            )}
          </div>
          <Text type="secondary">结构化画布 · 本地版本 · 可追溯导出</Text>
        </div>
        <div className="dashboard-studio-actions">
          <Segmented
            value={dashboard?.theme}
            onChange={(value) => mutateDashboard((draft) => {
              draft.theme = value as DashboardThemeId
            })}
            options={[
              { label: '深色科技', value: 'technology-dark', icon: <BgColorsOutlined /> },
              { label: '明亮商务', value: 'business-light', icon: <AppstoreOutlined /> },
              { label: '深色稳重', value: 'charcoal-dark', icon: <BgColorsOutlined /> },
              { label: '明亮简洁', value: 'minimal-light', icon: <AppstoreOutlined /> }
            ]}
          />
          <Tooltip title="撤销本次编辑">
            <Button icon={<UndoOutlined />} disabled={!history.length} onClick={undo} />
          </Tooltip>
          <Tooltip title="清除本地草稿">
            <Button icon={<DeleteOutlined />} disabled={!draftSavedAt} onClick={discardDraft} />
          </Tooltip>
          <Button
            icon={<SafetyCertificateOutlined />}
            loading={diagnosing}
            onClick={() => void openQuality()}
          >
            质量
          </Button>
          <Button
            icon={<MessageOutlined />}
            onClick={() => setAiOpen(true)}
            disabled={!dashboard}
          >
            AI 修改
          </Button>
          <Button icon={<HistoryOutlined />} disabled={!currentVersion} onClick={() => void openHistory()}>
            版本
          </Button>
          <Button icon={<AuditOutlined />} onClick={() => void openAudit()}>
            审计
          </Button>
          <Button icon={<FullscreenOutlined />} onClick={() => setPreviewOpen(true)}>预览</Button>
          <Dropdown
            trigger={['click']}
            open={exportMenuOpen && !pendingExport}
            onOpenChange={(open, info) => {
              if (info.source === 'trigger') setExportMenuOpen(open)
            }}
            menu={{
              items: [
                { key: 'png', label: 'PNG 图片', icon: <FileImageOutlined /> },
                { key: 'json', label: 'DashboardSpec JSON' },
                { key: 'pdf', label: 'PDF 文档' },
                { key: 'offline', label: '离线预览包（ZIP）', icon: <FileZipOutlined /> }
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation()
                window.setTimeout(() => {
                  setExportMenuOpen(false)
                  setPendingExport(key as 'png' | 'json' | 'pdf' | 'offline')
                }, 0)
              }
            }}
          >
            <Button icon={<DownloadOutlined />} loading={exporting}>导出</Button>
          </Dropdown>
          <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>
            保存
          </Button>
        </div>
      </div>

      <div
        ref={studioBodyRef}
        className="dashboard-studio-body"
        style={{ '--dashboard-inspector-width': `${inspectorWidth}px` } as CSSProperties}
      >
        <aside className="dashboard-library">
          <div className="dashboard-panel-title">
            <span>已保存大屏</span>
            <small>{dashboards.length} 个</small>
          </div>
          <Select
            className="dashboard-selector"
            value={currentVersion ? dashboard?.id : undefined}
            placeholder="打开大屏"
            options={dashboards.map((item) => ({
              value: item.id,
              label: `${item.title} · V${item.currentVersion}`
            }))}
            onChange={(id) => void openDashboard(id)}
          />
          <Divider />
          <div className="dashboard-panel-title">
            <span>看板组件</span>
            <small>{dashboard?.components.length ?? 0} 个</small>
          </div>
          <div className="dashboard-component-list">
            {dashboard?.components.map((component) => (
              <button
                type="button"
                key={component.id}
                className={selectedId === component.id ? 'selected' : ''}
                onClick={() => setSelectedId(component.id)}
              >
                <span className="dashboard-component-icon">{componentTypeIcons[component.type]}</span>
                <span>
                  <strong>{component.title}</strong>
                  <small>{dashboardComponentRegistry.find((item) => item.type === component.type)?.name}</small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className={`dashboard-preview-shell theme-${dashboard?.theme ?? 'technology-dark'}`}>
          {!dashboard ? <div className="dashboard-loading"><Skeleton active paragraph={{ rows: 8 }} /></div> : renderCanvas()}
        </main>

        <aside className="dashboard-inspector">
          <div
            className="dashboard-inspector-resizer"
            role="separator"
            tabIndex={0}
            aria-label="调整属性面板宽度"
            aria-orientation="vertical"
            aria-valuemin={dashboardInspectorMinimumWidth}
            aria-valuemax={dashboardInspectorMaximumWidth}
            aria-valuenow={inspectorWidth}
            title="拖拽调整属性面板宽度；使用左右方向键微调"
            onPointerDown={beginInspectorResize}
            onKeyDown={adjustInspectorWidthByKeyboard}
          />
          <div className="dashboard-inspector-scroll">
          <div className="dashboard-panel-title">
            <span><EditOutlined /> {selectedComponent ? '组件属性' : '大屏属性'}</span>
            <small>{selectedComponent?.id ?? '未选择组件'}</small>
          </div>
          {!selectedComponent && dashboard && (
            <>
              <section className="dashboard-dashboard-info-editor" aria-label="大屏信息编辑">
                <div className="dashboard-query-section-header">
                  <strong>大屏信息</strong>
                  <Text type="secondary">点击组件可切换到组件属性</Text>
                </div>
                <label htmlFor="dashboard-title-editor">主标题</label>
                <Input
                  id="dashboard-title-editor"
                  aria-label="大屏主标题"
                  value={dashboard.title}
                  placeholder="输入大屏主标题"
                  onChange={(event) => mutateDashboard((draft) => {
                    draft.title = event.target.value
                  })}
                />
                <label htmlFor="dashboard-subtitle-editor">副标题</label>
                <Input
                  id="dashboard-subtitle-editor"
                  aria-label="大屏副标题"
                  value={dashboard.subtitle}
                  placeholder="输入大屏副标题"
                  onChange={(event) => mutateDashboard((draft) => {
                    draft.subtitle = event.target.value
                  })}
                />
              </section>
              {renderGlobalFilterEditor()}
            </>
          )}
          {selectedComponent && (
            <div className="dashboard-inspector-form">
              <label>组件标题</label>
              <Input
                value={selectedComponent.title}
                onChange={(event) => updateComponent({ title: event.target.value })}
              />
              <label>副标题</label>
              <Input
                value={selectedComponent.subtitle}
                onChange={(event) => updateComponent({ subtitle: event.target.value })}
              />
              <label>图表类型</label>
              <Select
                value={selectedComponent.type}
                options={dashboardComponentRegistry.map((item) => ({
                  value: item.type,
                  label: item.name
                }))}
                disabled={queryLoading}
                onChange={(type) => void changeComponentType(type)}
              />
              {['kpi', 'progress', 'gauge'].includes(selectedComponent.type) && (
                <>
                  <label>单位</label>
                  <Input
                    value={selectedComponent.unit}
                    placeholder="条、个、%"
                    onChange={(event) => updateComponent({ unit: event.target.value })}
                  />
                </>
              )}
              {selectedComponent.type === 'insight' && (
                <>
                  <label>洞察内容</label>
                  <Input.TextArea
                    value={selectedComponent.insight}
                    autoSize={{ minRows: 3, maxRows: 6 }}
                    onChange={(event) => updateComponent({ insight: event.target.value })}
                  />
                </>
              )}
              {renderComponentDataEditor(selectedComponent)}
              {renderComponentStyleEditor(selectedComponent)}
              <Divider>24 列网格</Divider>
              <div className="dashboard-layout-inputs">
                {(['x', 'y', 'w', 'h'] as const).map((field) => (
                  <label key={field}>
                    <span>{field.toUpperCase()}</span>
                    <InputNumber
                      min={field === 'w'
                        ? dashboardLayoutProfiles[selectedComponent.type].minimumWidth
                        : field === 'h'
                          ? dashboardLayoutProfiles[selectedComponent.type].minimumHeight
                          : 0}
                      max={field === 'x' || field === 'w' ? 24 : 20}
                      value={selectedComponent.layout[field]}
                      onChange={(value) => updateLayout(field, value)}
                    />
                  </label>
                ))}
              </div>
              <Text type="secondary">
                保存前会检查组件越界、重叠、查询字段与图表编码。
              </Text>
              {selectedComponent.query && renderQueryEditor(selectedComponent.query)}
            </div>
          )}
          </div>
        </aside>
      </div>

      <DashboardAiDrawer
        open={aiOpen}
        onClose={() => setAiOpen(false)}
        dashboard={dashboard}
        selectedComponent={selectedComponent}
        artifactVersion={aiArtifactVersion}
        onDashboardChange={applyAgentDashboard}
        onUndoDashboardChange={undoAgentDashboard}
      />

      <Drawer title="版本历史" open={historyOpen} size={420} onClose={() => setHistoryOpen(false)}>
        <List
          locale={{ emptyText: '暂无版本' }}
          dataSource={versions}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="compare"
                  size="small"
                  disabled={item.version === currentVersion}
                  onClick={() => {
                    const current = versions.find((version) => version.version === currentVersion)
                    if (current) setVersionDiff(compareDashboardSpecs(item, current))
                  }}
                >
                  对比
                </Button>,
                <Popconfirm
                  key="restore"
                  title="确认恢复此版本？"
                  description="当前画布内容将被替换，并创建新的版本；未保存的修改会被覆盖。"
                  okText="确认恢复"
                  cancelText="取消"
                  placement="left"
                  onConfirm={() => void restore(item.version)}
                >
                  <Button
                    size="small"
                    loading={restoringVersion === item.version}
                    disabled={item.version === currentVersion || restoringVersion !== null}
                  >
                    恢复
                  </Button>
                </Popconfirm>
              ]}
            >
              <List.Item.Meta
                title={<Space><Tag>V{item.version}</Tag>{item.changeSummary}</Space>}
                description={new Date(item.createdAt).toLocaleString('zh-CN')}
              />
            </List.Item>
          )}
        />
      </Drawer>

      <Drawer
        title="操作审计"
        open={auditOpen}
        size={520}
        onClose={() => setAuditOpen(false)}
        extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void openAudit()}>刷新</Button>}
      >
        <List
          size="small"
          locale={{ emptyText: '暂无审计记录' }}
          dataSource={auditLogs}
          renderItem={(item) => {
            const actionLabels: Record<DashboardAuditLog['action'], string> = {
              save: '保存版本',
              restore: '恢复版本',
              diagnose: '质量诊断',
              'repair-component': '修复组件',
              'export-json': '导出 JSON',
              'export-pdf': '导出 PDF',
              'export-png': '导出 PNG',
              'export-offline': '导出离线预览包',
              'export-data': '导出数据'
            }
            const statusLabels: Record<DashboardAuditLog['status'], string> = {
              success: '成功',
              canceled: '已取消',
              failed: '失败'
            }
            const statusColors: Record<DashboardAuditLog['status'], string> = {
              success: 'success',
              canceled: 'default',
              failed: 'error'
            }
            const metadata = item.metadata ?? {}
            const detail = [
              item.version === undefined ? '' : `V${item.version}`,
              item.format?.toUpperCase() ?? '',
              metadata.componentCount === undefined ? '' : `${metadata.componentCount} 个组件`,
              metadata.queryCount === undefined ? '' : `${metadata.queryCount} 个查询`,
              metadata.recordCount === undefined ? '' : `${metadata.recordCount} 条数据`,
              typeof metadata.specHash === 'string' ? `Spec ${metadata.specHash.slice(0, 12)}…` : '',
              item.errorMessage ?? ''
            ].filter(Boolean).join(' · ')
            return (
              <List.Item>
                <List.Item.Meta
                  title={(
                    <Space>
                      <Tag color={statusColors[item.status]}>{statusLabels[item.status]}</Tag>
                      <Text strong>{actionLabels[item.action] ?? item.action}</Text>
                    </Space>
                  )}
                  description={(
                    <Space direction="vertical" size={2}>
                      <Text type="secondary">
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                        {item.dashboardId ? ` · ${item.dashboardId}` : ' · 全局数据'}
                      </Text>
                      {detail && <Text type={item.status === 'failed' ? 'danger' : 'secondary'}>{detail}</Text>}
                    </Space>
                  )}
                />
              </List.Item>
            )
          }}
        />
      </Drawer>

      <Modal
        title={versionDiff
          ? `V${versionDiff.fromVersion} → V${versionDiff.toVersion} 版本对比`
          : '版本对比'}
        open={Boolean(versionDiff)}
        footer={null}
        onCancel={() => setVersionDiff(null)}
      >
        {versionDiff && (
          <div className="dashboard-version-diff">
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="大屏字段">
                {versionDiff.changedFields.join('、') || '无'}
              </Descriptions.Item>
              <Descriptions.Item label="新增组件">
                {versionDiff.addedComponents.join('、') || '无'}
              </Descriptions.Item>
              <Descriptions.Item label="移除组件">
                {versionDiff.removedComponents.join('、') || '无'}
              </Descriptions.Item>
              <Descriptions.Item label="修改组件">
                {versionDiff.updatedComponents.join('、') || '无'}
              </Descriptions.Item>
              <Descriptions.Item label="查询口径变化">
                {versionDiff.queryChanges.join('、') || '无'}
              </Descriptions.Item>
            </Descriptions>
          </div>
        )}
      </Modal>

      <Drawer
        title="组件数据口径"
        open={Boolean(provenanceComponent)}
        size={500}
        rootClassName="dashboard-provenance-drawer"
        onClose={() => setProvenanceComponent(null)}
      >
        {provenanceComponent && provenance ? (
          <div className="dashboard-provenance">
            <div className="dashboard-provenance-heading">
              <InfoCircleOutlined />
              <div>
                <Text strong>{provenanceComponent.title}</Text>
                <Text type="secondary">{provenanceComponent.id}</Text>
              </div>
            </div>
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="来源范围">
                <Space wrap>{provenance.scopes.map((item) => <Tag key={item}>{item}</Tag>)}</Space>
              </Descriptions.Item>
              <Descriptions.Item label="维度">
                {provenance.dimensions.join('、') || '无分组维度'}
              </Descriptions.Item>
              <Descriptions.Item label="指标">
                {provenance.measures.join('；') || '未声明指标'}
              </Descriptions.Item>
              <Descriptions.Item label="筛选条件">
                {provenance.filters.join('；') || '无附加筛选'}
              </Descriptions.Item>
              <Descriptions.Item label="结果上限">
                {provenance.limit ?? 100} 行
              </Descriptions.Item>
              <Descriptions.Item label="刷新时间">
                {dashboard ? new Date(dashboard.updatedAt).toLocaleString('zh-CN') : '—'}
              </Descriptions.Item>
            </Descriptions>
            <Collapse
              className="dashboard-provenance-query-collapse"
              size="small"
              items={[{
                key: 'query-spec',
                label: 'QuerySpec',
                children: (
                  <pre className="dashboard-query-spec">
                    {JSON.stringify(provenanceComponent.query, null, 2)}
                  </pre>
                )
              }]}
            />
          </div>
        ) : <Empty description="当前组件没有受控查询" />}
      </Drawer>

      <Drawer
        title="大屏质量诊断"
        open={qualityOpen}
        size={520}
        onClose={() => setQualityOpen(false)}
      >
        {!qualityReport ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <div className="dashboard-quality" aria-busy={Boolean(repairingComponentId)}>
            {repairError && (
              <Alert
                className="dashboard-quality-repair-alert"
                type="error"
                showIcon
                closable
                message="修复未完成"
                description={repairError}
                onClose={() => setRepairError('')}
              />
            )}
            <div className="dashboard-quality-score">
              <div>
                <strong>{qualityReport.score}</strong>
                <span>质量分</span>
              </div>
              <div>
                <Text strong>{qualityReport.queryCount} 个受控查询</Text>
                <Text type="secondary">
                  合计 {qualityReport.totalElapsedMs.toFixed(2)} ms ·
                  {qualityReport.issues.length
                    ? ` ${qualityReport.issues.length} 项待处理`
                    : ' 未发现问题'}
                </Text>
              </div>
            </div>
            <Divider titlePlacement="start">检查结果</Divider>
            <List
              size="small"
              locale={{ emptyText: '未发现结构、数据或性能问题' }}
              dataSource={qualityReport.issues}
              renderItem={(issue) => (
                <List.Item
                  actions={issue.componentId && repairableQualityIssueCodes.has(issue.code)
                    ? [
                        <Button
                          key="repair"
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={repairingComponentId === issue.componentId}
                          disabled={Boolean(repairingComponentId && repairingComponentId !== issue.componentId)}
                          aria-label={`修复组件 ${issue.componentId}`}
                          onClick={() => void repairComponent(issue.componentId!)}
                        >
                          修复组件
                        </Button>
                      ]
                    : undefined}
                >
                  <List.Item.Meta
                    title={(
                      <Space>
                        <Tag color={
                          issue.severity === 'error'
                            ? 'error'
                            : issue.severity === 'warning'
                              ? 'warning'
                              : 'default'
                        }>
                          {issue.severity === 'error'
                            ? '错误'
                            : issue.severity === 'warning'
                              ? '警告'
                              : '建议'}
                        </Tag>
                        {issue.componentId && <Text code>{issue.componentId}</Text>}
                      </Space>
                    )}
                    description={issue.message}
                  />
                </List.Item>
              )}
            />
            <Divider titlePlacement="start">查询性能</Divider>
            <div className="dashboard-quality-queries">
              {qualityReport.components.map((component) => (
                <div key={component.componentId}>
                  <div>
                    <Text strong ellipsis>{component.title}</Text>
                    <Space size={8}>
                      <Tag color={
                        component.status === 'ok'
                          ? 'success'
                          : component.status === 'empty'
                            ? 'warning'
                            : 'error'
                      }>
                        {component.status === 'ok'
                          ? `${component.elapsedMs} ms`
                          : component.status === 'empty'
                            ? '空结果'
                            : '失败'}
                      </Tag>
                      {component.status === 'error' && (
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          loading={repairingComponentId === component.componentId}
                          disabled={Boolean(repairingComponentId && repairingComponentId !== component.componentId)}
                          aria-label={`修复失败查询组件 ${component.componentId}`}
                          onClick={() => void repairComponent(component.componentId)}
                        >
                          修复
                        </Button>
                      )}
                    </Space>
                  </div>
                  <Text type="secondary">
                    扫描 {component.scannedRows} · 命中 {component.matchedRows} ·
                    返回 {component.resultRows}
                  </Text>
                  {component.errorMessage && (
                    <Text className="dashboard-quality-query-error" type="danger">
                      {component.errorMessage}
                    </Text>
                  )}
                </div>
              ))}
            </div>
            <Divider titlePlacement="start">最近生成运行</Divider>
            <List
              size="small"
              locale={{ emptyText: '暂无生成运行记录' }}
              dataSource={visualizationRuns}
              renderItem={(run) => (
                <List.Item>
                  <List.Item.Meta
                    title={(
                      <Space>
                        <Tag color={run.status === 'success' ? 'success' : 'error'}>
                          {run.status === 'success' ? '成功' : '失败'}
                        </Tag>
                        <Tag>{run.mode === 'patch' ? '修改' : '生成'}</Tag>
                        <Text>{run.modelName}</Text>
                        <Text type="secondary">{run.durationMs} ms</Text>
                      </Space>
                    )}
                    description={(
                      <div className="dashboard-run-detail">
                        <Text type="secondary">
                          {new Date(run.createdAt).toLocaleString('zh-CN')} · {run.requestSummary}
                        </Text>
                        <Collapse
                          ghost
                          size="small"
                          items={[{
                            key: 'tools',
                            label: `${run.toolCalls.length} 次受控工具调用`,
                            children: run.toolCalls.length ? (
                              <div className="dashboard-tool-audit" role="list">
                                {run.toolCalls.map((call) => (
                                  <div key={`${call.sequence}-${call.tool}-${call.componentId ?? ''}`} role="listitem">
                                    <span>{call.sequence}</span>
                                    <Text strong>{visualizationToolLabels[call.tool]}</Text>
                                    {call.componentId
                                      ? <Text code ellipsis>{call.componentId}</Text>
                                      : <span className="dashboard-tool-audit-component" aria-hidden="true" />}
                                    <Tag color={call.status === 'success' ? 'success' : 'error'}>
                                      {call.status === 'success' ? '成功' : '失败'}
                                    </Tag>
                                    <Text type="secondary">{call.durationMs.toFixed(2)} ms</Text>
                                    {call.metadata && (
                                      <Text type="secondary" className="dashboard-tool-audit-metadata">
                                        {Object.entries(call.metadata).map(([key, value]) =>
                                          `${visualizationToolMetadataLabels[key] ?? key} ${typeof value === 'boolean' ? (value ? '是' : '否') : value}`
                                        ).join(' · ')}
                                      </Text>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : <Text type="secondary">该历史运行没有工具明细</Text>
                          }]}
                        />
                      </div>
                    )}
                  />
                </List.Item>
              )}
            />
          </div>
        )}
      </Drawer>

      <Modal
        className="dashboard-preview-modal"
        title={dashboard?.title}
        open={previewOpen}
        footer={null}
        width="96vw"
        onCancel={() => setPreviewOpen(false)}
      >
        <div className={`dashboard-modal-canvas theme-${dashboard?.theme ?? 'technology-dark'}`}>
          {dashboard && renderCanvas(true)}
        </div>
      </Modal>

      <Modal
        title="确认导出大屏"
        open={Boolean(pendingExport)}
        okText={`确认导出 ${pendingExport === 'offline' ? '离线预览包' : pendingExport?.toUpperCase() ?? ''}`}
        cancelText="取消"
        confirmLoading={exporting}
        onCancel={() => !exporting && setPendingExport(null)}
        onOk={() => pendingExport && void exportDashboard(pendingExport)}
      >
        {exportReview && (
          <div className="dashboard-export-review">
            <Alert
              showIcon
              type={
                exportReview.sensitiveFields.length || exportReview.uncontrolledComponentCount
                  ? 'warning'
                  : 'info'
              }
              title={
                exportReview.sensitiveFields.length
                  ? `检测到 ${exportReview.sensitiveFields.length} 个可能的敏感字段`
                  : exportReview.uncontrolledComponentCount
                    ? `${exportReview.uncontrolledComponentCount} 个组件缺少受控查询口径`
                  : '未检测到明显敏感字段'
              }
              description={
                exportReview.sensitiveFields.length
                  ? `请确认导出范围。敏感字段：${exportReview.sensitiveFields.join('、')}${
                    exportReview.uncontrolledComponentCount
                      ? `；另有 ${exportReview.uncontrolledComponentCount} 个组件缺少受控查询口径。`
                      : ''
                  }`
                  : exportReview.uncontrolledComponentCount
                    ? '这些组件无法提供可追溯的数据范围和筛选条件。'
                  : '仍需确认当前数据范围符合使用和分享要求。'
              }
            />
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label="大屏">
                {dashboard?.title}
              </Descriptions.Item>
              <Descriptions.Item label="内容规模">
                {exportReview.componentCount} 个组件 · {exportReview.queryCount} 个受控查询
                {exportReview.uncontrolledComponentCount
                  ? ` · ${exportReview.uncontrolledComponentCount} 个未绑定查询`
                  : ''}
              </Descriptions.Item>
              <Descriptions.Item label="数据范围">
                <Space wrap>
                  {exportReview.scopeDescriptions.map((item) => <Tag key={item}>{item}</Tag>)}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="导出格式">
                {pendingExport === 'offline' ? '离线预览包（ZIP）' : pendingExport?.toUpperCase()}
              </Descriptions.Item>
              {pendingExport === 'offline' && (
                <Descriptions.Item label="离线行为">
                  解压后直接打开 index.html；查看器只展示导出时的快照数据，不会重新查询或访问网络。
                </Descriptions.Item>
              )}
            </Descriptions>
          </div>
        )}
      </Modal>
    </div>
  )
}
