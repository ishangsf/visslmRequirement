import type {
  DashboardExportResult,
  DashboardQualityReport,
  DashboardSaveInput,
  DashboardSpec,
  DashboardSummary,
  DashboardVersion,
  VisualizationRun
} from './dashboard'
import type { AgentEvent, ExpertId } from './expert-types'
import type { DataScope, FieldProfile, QueryDataset, QuerySpec } from './query-spec'

export interface PlatformSettings {
  baseUrl: string
  username: string
  hasToken: boolean
}

export interface PlatformSettingsInput {
  baseUrl: string
  username: string
  token?: string
}

export interface ModelSettings {
  baseUrl: string
  model: string
  thinking: boolean
}

export interface AppSettings {
  platform: PlatformSettings
  model: ModelSettings
}

export interface ConnectionResult {
  ok: boolean
  message: string
  details?: Record<string, unknown>
}

export interface ProjectRow {
  uid: string
  name: string
  itemId: string
  lastModifyTime: string
  recordCount: number
}

export interface RecordRow {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  parentId: string
  name: string
  description: string
  lastModifyTime: string
  syncedAt: string
  imageCount: number
  normalizedText?: string
  pushStatus: 'pending' | 'success' | 'failed'
  pushMessage: string
  pushedAt: string
  pushedUid: string
}

export interface RecordDetail extends RecordRow {
  raw: Record<string, unknown>
  images: ImageAsset[]
}

export interface ImageAsset {
  id: string
  recordUid: string
  name: string
  mimeType: string
  sourceUrl: string
  sha256: string
  byteSize: number
  dataUri?: string
}

export interface RecordQuery {
  page: number
  pageSize: number
  search?: string
  projectId?: string
  nodeType?: string
}

export interface RecordPage {
  rows: RecordRow[]
  total: number
}

export interface DataImportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  recordCount: number
  imageCount: number
  skippedCount: number
  errors: string[]
  message: string
}

export interface DataExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  recordCount: number
  message: string
}

export interface DataDeleteResult {
  ok: boolean
  recordCount: number
  imageCount: number
  message: string
}

export interface PushFieldMapping {
  id: string
  sourceField: string
  targetField: string
}

export interface PushConfig {
  recordUids: string[]
  nodeType: string
  projectId: string
  componentId?: string
  parentId?: string
  insertAfterId?: string
  insertBeforeId?: string
  fieldMappings?: PushFieldMapping[]
}

export interface PushRequestTrace {
  id: number
  recordUid: string
  recordName: string
  method: 'POST'
  endpoint: string
  params: Record<string, string>
  body: Record<string, unknown>
  response?: unknown
  error?: string
}

export interface PushResult {
  preview: boolean
  total: number
  successCount: number
  failedCount: number
  requests: PushRequestTrace[]
}

export type PushLogStatus = 'sending' | 'success' | 'failed'

export interface PushLogRow {
  id: number
  recordUid: string
  recordName: string
  method: 'POST'
  endpoint: string
  params: Record<string, string>
  body: Record<string, unknown>
  status: PushLogStatus
  httpStatus: number
  response?: unknown
  errorMessage: string
  remoteUid: string
  createdAt: string
  finishedAt: string
}

export interface PushLogPage {
  rows: PushLogRow[]
  total: number
}

export type CollectionRequestLogStatus = 'running' | 'success' | 'failed'

export interface CollectionRequestLogRow {
  id: number
  nodeType: string
  method: 'GET'
  endpoint: string
  params: Record<string, string>
  status: CollectionRequestLogStatus
  httpStatus: number
  recordCount: number
  response?: unknown
  errorMessage: string
  createdAt: string
  finishedAt: string
}

export interface CollectionRequestLogPage {
  rows: CollectionRequestLogRow[]
  total: number
}

export interface DashboardStats {
  projectCount: number
  recordCount: number
  collectedCount: number
  pushedCount: number
  imageCount: number
  byType: Array<{ name: string; value: number }>
  byProject: Array<{ name: string; value: number }>
  byRelease: Array<{ name: string; value: number }>
}

export interface SyncRun {
  id: number
  startedAt: string
  finishedAt: string
  status: string
  projectCount: number
  recordCount: number
  imageCount: number
  errorMessage: string
}

export interface SyncProgress {
  phase: string
  message: string
  current: number
  total: number
}

export interface SyncResult {
  ok: boolean
  projectCount: number
  recordCount: number
  imageCount: number
  message: string
}

export type SyncFilterOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'empty'
  | 'notEmpty'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'

export interface SyncFieldFilter {
  id: string
  field: string
  operator: SyncFilterOperator
  value: string
}

export interface SyncTypeRule {
  nodeType: string
  returnProperty?: string
  filters: SyncFieldFilter[]
}

export interface SyncScopeConfig {
  selectedTypes: string[]
  rules: SyncTypeRule[]
}

export interface SyncPreviewRecord {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  name: string
  description: string
}

export interface SyncPreviewResult {
  scannedCount: number
  matchedCount: number
  byType: Array<{ name: string; value: number }>
  samples: SyncPreviewRecord[]
  requests: SyncPreviewRequest[]
}

export interface SyncPreviewRequest {
  id: number
  method: 'GET'
  endpoint: string
  params: Record<string, string>
  response?: unknown
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  sources?: ChatSource[]
  dataViews?: ChatDataView[]
  dashboard?: DashboardSpec
  expertId?: ExpertId
}

export interface ChatSource {
  uid: string
  name: string
  nodeType: string
  itemId: string
}

export interface ChatDataRow {
  uid: string
  name: string
  nodeType: string
  itemId: string
  values: Record<string, string | string[]>
}

export interface ChatDataGroup {
  name: string
  count: number
  rows: ChatDataRow[]
}

export interface ChatDataView {
  id: string
  title: string
  description: string
  total: number
  fields: string[]
  groups: ChatDataGroup[]
}

export interface ChatRequest {
  question: string
  projectId?: string
  conversationId?: string
  expertId?: ExpertId
  entrypoint?: 'chat' | 'dashboard'
  dataScope?: DataScope
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}

export interface ChatResponse {
  answer: string
  sources: ChatSource[]
  dataViews: ChatDataView[]
  expertId?: ExpertId
  dashboard?: DashboardSpec
  events?: AgentEvent[]
}

export interface AppApi {
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<boolean>
  closeWindow(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  getSettings(): Promise<AppSettings>
  savePlatformSettings(input: PlatformSettingsInput): Promise<AppSettings>
  saveModelSettings(input: ModelSettings): Promise<AppSettings>
  testPlatform(input?: PlatformSettingsInput): Promise<ConnectionResult>
  testModel(input?: ModelSettings): Promise<ConnectionResult>
  listProjects(): Promise<ProjectRow[]>
  listNodeTypes(): Promise<string[]>
  listRecords(query: RecordQuery): Promise<RecordPage>
  getRecord(uid: string): Promise<RecordDetail | null>
  getStats(): Promise<DashboardStats>
  getSyncConfig(): Promise<SyncScopeConfig | null>
  saveSyncConfig(config: SyncScopeConfig): Promise<void>
  previewSync(config?: SyncScopeConfig): Promise<SyncPreviewResult>
  startSync(config?: SyncScopeConfig): Promise<SyncResult>
  listCollectionRequestLogs(page?: number, pageSize?: number): Promise<CollectionRequestLogPage>
  askAgent(request: ChatRequest): Promise<ChatResponse>
  listFieldProfiles(scope?: DataScope): Promise<FieldProfile[]>
  executeQuery(spec: QuerySpec): Promise<QueryDataset>
  listDashboards(): Promise<DashboardSummary[]>
  getDashboard(id: string, version?: number): Promise<DashboardVersion | null>
  listDashboardVersions(id: string): Promise<DashboardVersion[]>
  saveDashboard(input: DashboardSaveInput): Promise<DashboardVersion>
  restoreDashboard(id: string, version: number): Promise<DashboardVersion>
  exportDashboardJson(spec: DashboardSpec): Promise<DashboardExportResult>
  exportDashboardPdf(spec: DashboardSpec): Promise<DashboardExportResult>
  diagnoseDashboard(spec: DashboardSpec): Promise<DashboardQualityReport>
  listVisualizationRuns(limit?: number): Promise<VisualizationRun[]>
  importData(): Promise<DataImportResult>
  exportData(): Promise<DataExportResult>
  deleteData(uids?: string[]): Promise<DataDeleteResult>
  previewPush(config: PushConfig): Promise<PushResult>
  startPush(config: PushConfig): Promise<PushResult>
  listPushLogs(page?: number, pageSize?: number): Promise<PushLogPage>
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void
}
