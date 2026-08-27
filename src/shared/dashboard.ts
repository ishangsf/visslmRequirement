import type {
  FilterOperator,
  QueryAggregation,
  QueryCalculation,
  QuerySpec,
  TimeGrain
} from './query-spec'

export type DashboardComponentType =
  | 'kpi'
  | 'bar'
  | 'line'
  | 'pie'
  | 'ranking'
  | 'table'
  | 'progress'
  | 'insight'
  | 'gauge'
  | 'funnel'
  | 'radar'
  | 'scatter'
  | 'treemap'
  | 'combo'

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

export type DashboardSlotRole =
  | 'headline'
  | 'trend'
  | 'comparison'
  | 'breakdown'
  | 'diagnosis'
  | 'detail'
  | 'insight'

export type DashboardMetricSource = 'catalog' | 'inferred' | 'user'

export interface DashboardMetricDefinition {
  id: string
  label: string
  description?: string
  measureId: string
  field?: string
  aggregation: QueryAggregation
  calculation?: QueryCalculation
  unit?: string
  format?: 'number' | 'percent' | 'duration' | 'currency'
  positiveDirection?: 'up' | 'down' | 'neutral'
  source: DashboardMetricSource
  confidence: number
}

export interface DashboardAnalysisQuestion {
  id: string
  question: string
  metricIds: string[]
  dimensionFields: string[]
  timeGrain?: TimeGrain
  preferredComponentTypes: DashboardComponentType[]
  slotRole: DashboardSlotRole
  priority: number
  required: boolean
}

export interface DashboardAnalysisBlueprint {
  version: '1.0'
  request: string
  audience: string
  objective: string
  scopeDescription: string
  metrics: DashboardMetricDefinition[]
  questions: DashboardAnalysisQuestion[]
  assumptions: string[]
  unresolvedAmbiguities: string[]
  generatedAt: string
}

export interface DashboardSemanticBinding {
  questionId: string
  metricIds: string[]
  dimensionFields: string[]
  titleMode: 'auto' | 'custom'
  titleTemplate?: string
  confidence: number
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
  style?: DashboardComponentStyle
  semanticBinding?: DashboardSemanticBinding
  slotRole?: DashboardSlotRole
}

export interface DashboardComponentStyle {
  titleFontSize?: number
  subtitleFontSize?: number
  valueFontSize?: number
  bodyFontSize?: number
  borderRadius?: number
  padding?: number
  showLegend?: boolean
  showGrid?: boolean
  lineWidth?: number
  orientation?: 'horizontal' | 'vertical'
  donut?: boolean
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
  /** Optional P0 semantic sidecar. Legacy v1 dashboards remain valid without it. */
  analysisBlueprint?: DashboardAnalysisBlueprint
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

export type DashboardSpecDiff = Omit<DashboardVersionDiff, 'fromVersion' | 'toVersion'>

export interface DashboardAiChangeSummary extends DashboardSpecDiff {
  queryExecutionCount: number
  attemptCount: number
  durationMs: number
}

export type DashboardAiEditMode = 'full' | 'presentation-only'

export const dashboardAiEditMode = (spec: DashboardSpec): DashboardAiEditMode =>
  spec.components.every((component) => Boolean(component.query && component.encoding?.value))
    ? 'full'
    : 'presentation-only'

export interface DashboardSaveInput {
  spec: DashboardSpec
  changeSummary: string
  baseVersion?: number
}

export interface DashboardExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  message: string
}

export interface DashboardOfflineExportPayload {
  spec: DashboardSpec
  version: number | null
  exportedAt: string
}

export interface DashboardOfflineManifest {
  format: 'visslm-dashboard-offline'
  schemaVersion: '1.0'
  generatedAt: string
  dashboardId: string
  dashboardTitle: string
  dashboardVersion: number | null
  theme: DashboardThemeId
  componentCount: number
  dataMode: 'snapshot'
  networkAccess: 'none'
  specHash: string
}

export type DashboardAuditAction =
  | 'save'
  | 'restore'
  | 'diagnose'
  | 'repair-component'
  | 'export-json'
  | 'export-pdf'
  | 'export-png'
  | 'export-offline'
  | 'export-data'

export type DashboardAuditStatus = 'success' | 'canceled' | 'failed'

export interface DashboardAuditLogInput {
  dashboardId?: string
  action: DashboardAuditAction
  status: DashboardAuditStatus
  version?: number
  format?: 'json' | 'pdf' | 'png' | 'offline' | 'jsonl' | 'visslmpack'
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

export interface DashboardComponentRepairResult {
  spec: DashboardSpec
  componentId: string
  actions: string[]
  report: DashboardQualityReport
}

export interface VisualizationRunInput {
  dashboardId?: string
  requestSummary: string
  modelName: string
  promptVersion: string
  mode: 'generate' | 'patch'
  status: 'success' | 'failed'
  attemptCount: number
  componentCount: number
  queryCount: number
  durationMs: number
  toolCalls: VisualizationToolCall[]
  errorMessage?: string
}

export type VisualizationToolName =
  | 'plan-analysis'
  | 'profile-fields'
  | 'model-compose'
  | 'validate-dashboard'
  | 'validate-semantics'
  | 'execute-query'
  | 'apply-patch'
  | 'repair-attempt'

export interface VisualizationToolCall {
  sequence: number
  tool: VisualizationToolName
  status: 'success' | 'failed'
  attempt: number
  durationMs: number
  componentId?: string
  metadata?: Record<string, number | boolean>
}

export interface VisualizationRun extends VisualizationRunInput {
  id: string
  createdAt: string
}

export type DashboardComponentDataShape =
  | 'single-value'
  | 'category-value'
  | 'time-series'
  | 'dual-measure'
  | 'table'
  | 'detail'
  | 'text'

export interface DashboardComponentDefinition {
  manifestVersion: '1.0'
  type: DashboardComponentType
  name: string
  description: string
  category: '指标' | '趋势' | '比较' | '构成' | '明细' | '洞察'
  minimumSize: { w: number; h: number }
  preferredSize: { w: number; h: number }
  supportedDataShapes: DashboardComponentDataShape[]
  compatibleSlotRoles: DashboardSlotRole[]
  supportsManualAdd: boolean
  requiresQuery: boolean
}

export const compareDashboardSpecValues = (
  from: DashboardSpec,
  to: DashboardSpec
): DashboardSpecDiff => {
  const changedFields: string[] = []
  const comparableFields: Array<keyof DashboardSpec> = [
    'title',
    'subtitle',
    'theme',
    'businessContext',
    'globalFilters',
    'analysisBlueprint'
  ]
  for (const field of comparableFields) {
    if (JSON.stringify(from[field]) !== JSON.stringify(to[field])) {
      changedFields.push(field)
    }
  }
  if (JSON.stringify(from.viewport) !== JSON.stringify(to.viewport)) {
    changedFields.push('viewport')
  }

  const fromMap = new Map(from.components.map((component) => [component.id, component]))
  const toMap = new Map(to.components.map((component) => [component.id, component]))
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
    changedFields,
    addedComponents,
    removedComponents,
    updatedComponents,
    queryChanges
  }
}

export const compareDashboardSpecs = (
  from: DashboardVersion,
  to: DashboardVersion
): DashboardVersionDiff => ({
  fromVersion: from.version,
  toVersion: to.version,
  ...compareDashboardSpecValues(from.spec, to.spec)
})
