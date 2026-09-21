import type {
  DataScope,
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
  | 'data-matrix'
  | 'description-list'
  | 'comparison-bars'

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
  /** Optional process/evidence links for domain-aware dashboards. */
  processBindingIds?: string[]
  titleMode: 'auto' | 'custom'
  titleTemplate?: string
  confidence: number
}

/**
 * Auditable domain-generation outcome persisted with a dashboard.  The
 * fields are optional so legacy v1 dashboards and rejected/partial receipts
 * remain representable; ready domain artifacts populate the complete set.
 */
export interface DashboardDomainReceipt {
  adoptedMetricIds?: readonly string[]
  missingMetricIds?: readonly string[]
  evidenceMissing?: readonly string[]
  evidenceInsufficient?: readonly string[]
  confidence?: number
  warnings?: readonly string[]
  confirmations?: readonly string[]
  vetoCodes?: readonly string[]
}

export interface DashboardDataPoint {
  name: string
  value: number
  secondaryValue?: number
}

export type DashboardStatusTone = 'success' | 'info' | 'warning' | 'error' | 'neutral'

export interface DashboardDataMatrixCell {
  id: string
  label: string
  value?: string
  caption?: string
  tone?: DashboardStatusTone
}

export interface DashboardDataMatrixRow {
  id: string
  label: string
  caption?: string
  tone?: DashboardStatusTone
  cells: DashboardDataMatrixCell[]
  expanded?: {
    label: string
    nodes: DashboardDataMatrixCell[]
  }
}

export interface DashboardDataMatrixContent {
  kind: 'data-matrix'
  leadingLabel: string
  columns: string[]
  rows: DashboardDataMatrixRow[]
  selectedRowId?: string
  /** Maximum visible rows per page. The widget itself never grows with row count. */
  pageSize?: number
  /** Inline is intended for short traces; linked-detail keeps large matrices compact. */
  expansionMode?: 'inline' | 'linked-detail' | 'none'
  /** Generic interaction channel shared with one or more detail primitives. */
  selectionChannel?: string
  legend?: Array<{ label: string; tone: DashboardStatusTone }>
}

export interface DashboardDescriptionListVariant {
  selectionId: string
  heading?: string
  status?: { label: string; tone: DashboardStatusTone }
  sections?: Array<{
    id: string
    label: string
    value: string
    help?: string
    tone?: DashboardStatusTone
  }>
  fields: Array<{
    id: string
    label: string
    value: string
    tone?: DashboardStatusTone
  }>
  summary?: { label: string; value: string; tone?: DashboardStatusTone }
}

export interface DashboardDescriptionListContent {
  kind: 'description-list'
  heading?: string
  status?: { label: string; tone: DashboardStatusTone }
  sections?: Array<{
    id: string
    label: string
    value: string
    help?: string
    tone?: DashboardStatusTone
  }>
  fields: Array<{
    id: string
    label: string
    value: string
    tone?: DashboardStatusTone
  }>
  summary?: { label: string; value: string; tone?: DashboardStatusTone }
  /** When set, this component renders the variant selected by the source channel. */
  selectionChannel?: string
  variants?: DashboardDescriptionListVariant[]
}

export interface DashboardComparisonBarsContent {
  kind: 'comparison-bars'
  valueLabel?: string
  secondaryLabel?: string
  items: Array<{
    id: string
    label: string
    value: number
    secondaryValue?: number
    unit?: string
    secondaryUnit?: string
    tone?: DashboardStatusTone
  }>
}

export type DashboardComponentContent =
  | DashboardDataMatrixContent
  | DashboardDescriptionListContent
  | DashboardComparisonBarsContent

export interface DashboardComponentSpec {
  id: string
  type: DashboardComponentType
  title: string
  subtitle?: string
  layout: DashboardLayout
  data: DashboardDataPoint[]
  /** Generic structured content for public non-chart primitives. */
  content?: DashboardComponentContent
  query?: QuerySpec
  encoding?: {
    label?: string
    value?: string
    secondaryValue?: string
    /** Optional display scaling applied after query execution (for example 100 for ratios). */
    valueScale?: number
    secondaryValueScale?: number
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
  /** Component-specific presentation primitives shared by the inspector, renderer and AI editor. */
  decimalPlaces?: number
  maxItems?: number
  showLabels?: boolean
  showValues?: boolean
  smooth?: boolean
  showArea?: boolean
  showSymbols?: boolean
  showIndex?: boolean
  showStatus?: boolean
  showStatusLegend?: boolean
  targetValue?: number
  showIcon?: boolean
  minimumValue?: number
  maximumValue?: number
  showPointer?: boolean
  symbolSize?: number
  barWidth?: number
  legendPosition?: 'top' | 'right' | 'bottom'
  sortOrder?: 'none' | 'ascending' | 'descending'
  radarShape?: 'polygon' | 'circle'
  areaOpacity?: number
  itemGap?: number
}

export type DashboardPresentationMode = 'standard' | 'immersive'

export type DashboardGjb5000bEvidenceStatus =
  | 'sufficient'
  | 'insufficient'
  | 'missing'
  | 'not-applicable'

export interface DashboardGjb5000bProcessDomain {
  id: string
  label: string
  requirementCount?: number
  activityCount?: number
  activityExecutionRate?: number
  workProductCount?: number
  workProductCompletenessRate?: number
  evidenceCount?: number
  evidenceSufficiencyRate: number
  status: DashboardGjb5000bEvidenceStatus
}

export interface DashboardGjb5000bTraceNode {
  id: string
  stage: 'requirement' | 'activity' | 'work-product' | 'evidence' | 'conclusion'
  label: string
  caption?: string
  status: DashboardGjb5000bEvidenceStatus
}

export interface DashboardGjb5000bEvidenceDetail {
  domainId: string
  title: string
  expectedEvidence: string[]
  currentEvidence: string[]
  sourceSystem: string
  owner: string
  dueDate: string
  ruleId: string
  relatedRequirements: string[]
  summary: string
}

export interface DashboardGjb5000bTrend {
  labels: string[]
  overall: number[]
  selectedDomain: number[]
  target: number
}

export interface DashboardGjb5000bAgingBucket {
  id: string
  label: string
  count: number
  maximumDays?: number
  tone: 'success' | 'warning' | 'error'
}

export interface DashboardGjb5000bPresentation {
  kind: 'gjb5000b-compliance'
  defaultMode: DashboardPresentationMode
  projectLabel: string
  baselineLabel: string
  auditPeriodLabel: string
  dataModeLabel: string
  conclusion: 'sufficient' | 'insufficient'
  selectedDomainId: string
  processDomains: DashboardGjb5000bProcessDomain[]
  trace: DashboardGjb5000bTraceNode[]
  evidenceDetail: DashboardGjb5000bEvidenceDetail
  trend: DashboardGjb5000bTrend
  aging: DashboardGjb5000bAgingBucket[]
  scene: {
    kind: 'aerospace-situational'
    assetId: string
    assetVersion: string
    source: 'approved-generated-visual'
    classification: 'visual-theme'
    decorativeOnly: true
    disclaimer: string
  }
}

export type DashboardPresentationSpec = DashboardGjb5000bPresentation

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
  /** Stable dashboard-level data range; component deletion must not erase it. */
  dataScope?: DataScope
  globalFilters?: DashboardFilter[]
  /** Optional P0 semantic sidecar. Legacy v1 dashboards remain valid without it. */
  analysisBlueprint?: DashboardAnalysisBlueprint
  /** Optional domain context. Legacy v1 dashboards remain valid without it. */
  domainContext?: {
    role: string
    scenario: string
    catalogVersion: string
    tailoringBaselineId: string
    artifactStatus: 'preview' | 'formal'
    /** Query source used to generate and subsequently validate this artifact. */
    dataMode?: 'controlled-sample' | 'platform-adapter'
  }
  /** Optional auditable domain-generation receipt. Legacy v1 remains valid. */
  domainReceipt?: DashboardDomainReceipt
  /** Optional scene/story-layer contract. Widget data remains authoritative. */
  presentation?: DashboardPresentationSpec
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
    'dataScope',
    'globalFilters',
    'analysisBlueprint',
    'presentation'
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
