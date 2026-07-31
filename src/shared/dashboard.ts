import type { FilterOperator, QuerySpec } from './query-spec'

export type DashboardComponentType =
  | 'kpi'
  | 'bar'
  | 'line'
  | 'pie'
  | 'ranking'
  | 'table'
  | 'progress'
  | 'insight'

export type DashboardThemeId =
  | 'technology-dark'
  | 'business-light'
  | 'charcoal-dark'
  | 'minimal-light'

export interface DashboardFilter {
  id: string
  field: string
  label: string
  operator: Extract<FilterOperator, 'equals' | 'in'>
  options: Array<string | number | boolean>
  value?: string | number | boolean | Array<string | number | boolean>
}

export interface DashboardLayout {
  x: number
  y: number
  w: number
  h: number
}

export interface DashboardDataPoint {
  name: string
  value: number
  secondaryValue?: number
}

export interface DashboardComponentSpec {
  id: string
  type: DashboardComponentType
  title: string
  subtitle?: string
  layout: DashboardLayout
  data: DashboardDataPoint[]
  query?: QuerySpec
  encoding?: {
    label?: string
    value?: string
    secondaryValue?: string
  }
  unit?: string
  accent?: string
  insight?: string
}

export interface DashboardSpec {
  schemaVersion: '1.0'
  id: string
  title: string
  subtitle: string
  businessContext?: {
    audience: string
    objective: string
    scopeDescription: string
  }
  viewport?: { width: 1920; height: 1080; columns: 24; rowHeight: number }
  theme: DashboardThemeId
  globalFilters?: DashboardFilter[]
  updatedAt: string
  components: DashboardComponentSpec[]
}

export interface DashboardSummary {
  id: string
  title: string
  subtitle: string
  theme: DashboardThemeId
  currentVersion: number
  componentCount: number
  createdAt: string
  updatedAt: string
}

export interface DashboardVersion {
  dashboardId: string
  version: number
  spec: DashboardSpec
  changeSummary: string
  createdAt: string
}

export interface DashboardVersionDiff {
  fromVersion: number
  toVersion: number
  changedFields: string[]
  addedComponents: string[]
  removedComponents: string[]
  updatedComponents: string[]
  queryChanges: string[]
}

export interface DashboardSaveInput {
  spec: DashboardSpec
  changeSummary: string
}

export interface DashboardExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  message: string
}

export type DashboardAuditAction =
  | 'save'
  | 'restore'
  | 'diagnose'
  | 'export-json'
  | 'export-pdf'
  | 'export-png'
  | 'export-data'

export type DashboardAuditStatus = 'success' | 'canceled' | 'failed'

export interface DashboardAuditLogInput {
  dashboardId?: string
  action: DashboardAuditAction
  status: DashboardAuditStatus
  version?: number
  format?: 'json' | 'pdf' | 'png' | 'jsonl'
  metadata?: Record<string, string | number | boolean | null>
  errorMessage?: string
}

export interface DashboardAuditLog extends DashboardAuditLogInput {
  id: number
  createdAt: string
}

export type DashboardQualitySeverity = 'error' | 'warning' | 'info'

export interface DashboardQualityIssue {
  code: string
  severity: DashboardQualitySeverity
  message: string
  componentId?: string
}

export interface DashboardComponentDiagnostic {
  componentId: string
  title: string
  elapsedMs: number
  scannedRows: number
  matchedRows: number
  resultRows: number
  truncated: boolean
  status: 'ok' | 'empty' | 'error'
  errorMessage?: string
}

export interface DashboardQualityReport {
  dashboardId: string
  score: number
  checkedAt: string
  queryCount: number
  totalElapsedMs: number
  issues: DashboardQualityIssue[]
  components: DashboardComponentDiagnostic[]
}

export interface VisualizationRunInput {
  dashboardId?: string
  requestSummary: string
  modelName: string
  promptVersion: string
  status: 'success' | 'failed'
  attemptCount: number
  componentCount: number
  queryCount: number
  durationMs: number
  errorMessage?: string
}

export interface VisualizationRun extends VisualizationRunInput {
  id: string
  createdAt: string
}

export interface DashboardComponentDefinition {
  type: DashboardComponentType
  name: string
  description: string
  category: '指标' | '趋势' | '比较' | '构成' | '明细' | '洞察'
  minimumSize: { w: number; h: number }
  supportedDataShapes: Array<'single-value' | 'category-value' | 'time-series' | 'table'>
}

export const compareDashboardSpecs = (
  from: DashboardVersion,
  to: DashboardVersion
): DashboardVersionDiff => {
  const changedFields: string[] = []
  const comparableFields: Array<keyof DashboardSpec> = [
    'title',
    'subtitle',
    'theme',
    'businessContext',
    'globalFilters'
  ]
  for (const field of comparableFields) {
    if (JSON.stringify(from.spec[field]) !== JSON.stringify(to.spec[field])) {
      changedFields.push(field)
    }
  }
  if (JSON.stringify(from.spec.viewport) !== JSON.stringify(to.spec.viewport)) {
    changedFields.push('viewport')
  }

  const fromMap = new Map(from.spec.components.map((component) => [component.id, component]))
  const toMap = new Map(to.spec.components.map((component) => [component.id, component]))
  const addedComponents = [...toMap.keys()].filter((id) => !fromMap.has(id))
  const removedComponents = [...fromMap.keys()].filter((id) => !toMap.has(id))
  const updatedComponents: string[] = []
  const queryChanges: string[] = []
  for (const id of [...toMap.keys()].filter((item) => fromMap.has(item))) {
    const previous = fromMap.get(id)!
    const next = toMap.get(id)!
    if (JSON.stringify(previous.query) !== JSON.stringify(next.query)) {
      queryChanges.push(id)
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      updatedComponents.push(id)
    }
  }
  return {
    fromVersion: from.version,
    toVersion: to.version,
    changedFields,
    addedComponents,
    removedComponents,
    updatedComponents,
    queryChanges
  }
}
