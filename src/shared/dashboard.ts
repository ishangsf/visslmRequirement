import type { QuerySpec } from './query-spec'

export type DashboardComponentType =
  | 'kpi'
  | 'bar'
  | 'line'
  | 'pie'
  | 'ranking'
  | 'table'
  | 'progress'
  | 'insight'

export type DashboardThemeId = 'technology-dark' | 'business-light'

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
