import type {
  DashboardAiChangeSummary,
  DashboardExportResult,
  DashboardAuditLog,
  DashboardComponentRepairResult,
  DashboardQualityReport,
  DashboardSaveInput,
  DashboardSpec,
  DashboardSummary,
  DashboardVersion,
  VisualizationRun
} from './dashboard'
import type { AgentEvent, AgentProgressUpdate, ExpertId } from './expert-types'
import type {
  DataScope,
  FieldProfile,
  FieldProfileSemanticPatch,
  QueryDataset,
  QuerySpec
} from './query-spec'
import type {
  ManagedProject,
  ManagedProjectInput,
  ManagedProjectListQuery,
  OrganizationPerson,
  OrganizationPersonInput,
  OrganizationPersonListQuery,
  OrganizationPersonPage,
  ManagedProjectPage,
  ProjectAnalysisLogEntry,
  ProjectAnalysisProgress,
  ProjectAnalysisStartResult,
  ProjectAsset,
  ProjectCostEntry,
  ProjectCostEntryInput,
  ProjectDataTransferResult,
  ProjectDocumentSnapshot,
  ProjectParticipant,
  ProjectParticipantInput,
  ProjectPlanTask,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectRequirement,
  ProjectRequirementInput,
  ProjectRequirementMergeInput,
  ProjectRequirementMatchPage,
  ProjectRequirementMatchQuery,
  ProjectRequirementPage,
  ProjectRequirementQuery,
  ProjectRequirementReviewStatus,
  ProjectRequirementSetSummary,
  ProjectRequirementSplitInput,
  ProjectAgreementUploadOptions,
  ProjectRequirementStatus
} from './project-types'

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

export interface SystemSettings {
  userPropertyKeys: string[]
}

export interface SystemSettingsInput {
  userPropertyKeys?: string[]
}

export type ModelSource = 'local' | 'online'

export type ModelProvider =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'qwen'
  | 'zhipu'
  | 'moonshot'
  | 'minimax'
  | 'openai-compatible'

export interface ModelSettings {
  source: ModelSource
  provider: ModelProvider
  baseUrl: string
  model: string
  thinking: boolean
  apiKey?: string
  hasApiKey?: boolean
}

export type FeatureModuleKey =
  | 'dashboard'
  | 'visualization'
  | 'projects'
  | 'data'
  | 'chat'
  | 'sync'
  | 'push'

export type FeatureModuleSettings = Record<FeatureModuleKey, boolean>

export type FeatureNavigationOrder = FeatureModuleKey[]

export interface ProjectMatchingSettings {
  minScore: number
}

export const DEFAULT_PROJECT_MATCHING_SETTINGS: ProjectMatchingSettings = {
  minScore: 40
}

export const normalizeProjectMatchScore = (value: unknown): number => {
  if (value === null || value === undefined || value === '') {
    return DEFAULT_PROJECT_MATCHING_SETTINGS.minScore
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return DEFAULT_PROJECT_MATCHING_SETTINGS.minScore
  return Math.max(0, Math.min(100, Math.round(numeric)))
}

export const DEFAULT_FEATURE_MODULE_SETTINGS: FeatureModuleSettings = {
  dashboard: true,
  visualization: true,
  projects: true,
  data: true,
  chat: true,
  sync: true,
  push: false
}

export const DEFAULT_FEATURE_NAVIGATION_ORDER: FeatureNavigationOrder = [
  'dashboard',
  'visualization',
  'projects',
  'data',
  'chat',
  'sync',
  'push'
]

export interface AppSettings {
  platform: PlatformSettings
  system: SystemSettings
  model: ModelSettings
  projectMatching: ProjectMatchingSettings
  features: FeatureModuleSettings
  navigationOrder: FeatureNavigationOrder
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

export interface FieldDefinition {
  nodeType: string
  field: string
  displayName: string
  updatedAt?: string
}

export interface RecordDetail extends RecordRow {
  raw: Record<string, unknown>
  images: ImageAsset[]
  fieldLabels?: Record<string, string>
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
  excludeProjectAssetProjectId?: string
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
  reviewBatchId?: string
  duplicates: DataReviewItem[]
}

export type DataReviewSource = 'sync' | 'import'

export interface DataReviewSummary {
  uid: string
  projectId: string
  nodeType: string
  name: string
  lastModifyTime: string
}

export interface DataReviewItem {
  id: string
  source: DataReviewSource
  itemId: string
  existing: DataReviewSummary
  incoming: DataReviewSummary
}

export interface DataReviewApplyInput {
  source: DataReviewSource
  batchId: string
  reviewIds?: string[]
}

export interface DataReviewApplyResult {
  ok: boolean
  source: DataReviewSource
  updatedCount: number
  imageCount: number
  resolvedReviewIds: string[]
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

export interface DashboardProjectManagementStats {
  projectCount: number
  activeProjectCount: number
  processingProjectCount: number
  requirementCount: number
  pendingReviewCount: number
  linkedAssetCount: number
}

export interface DashboardAssetCenterStats {
  recordCount: number
  projectCount: number
  typeCount: number
  imageCount: number
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
  projectManagement: DashboardProjectManagementStats
  assetCenter: DashboardAssetCenterStats
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
  skippedCount: number
  invalidItemIdCount: number
  reviewBatchId?: string
  duplicates: DataReviewItem[]
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
  invalidItemIdCount: number
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
  dashboardVersion?: number
  expertId?: ExpertId
  contextOutcome?: 'success' | 'failed' | 'undone'
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
  outcome?: 'success' | 'failed' | 'undone'
}

export interface ChatSessionSummary {
  id: string
  title: string
  preview: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[]
}

export interface ChatSessionSaveInput {
  id: string
  title?: string
  messages: ChatMessage[]
}

export interface ChatSessionDeleteResult {
  ok: boolean
  message: string
}

export interface ChatSource {
  uid: string
  name: string
  nodeType: string
  itemId: string
  sourceType?: 'record' | 'document'
  documentId?: string
  chunkId?: string
  fileName?: string
  location?: string
  pageNumber?: number
  sheetName?: string
  snippet?: string
  score?: number
}

export type KnowledgeDocumentStatus = 'queued' | 'processing' | 'ready' | 'failed'

export interface KnowledgeDocument {
  id: string
  fileName: string
  filePath: string
  extension: string
  mimeType: string
  byteSize: number
  sha256: string
  tags: string[]
  status: KnowledgeDocumentStatus
  errorMessage: string
  chunkCount: number
  pageCount: number
  modelVersion: string
  createdAt: string
  updatedAt: string
  processedAt: string
}

export interface KnowledgeChunk {
  id: string
  documentId?: string
  recordUid?: string
  sourceType: 'document' | 'record'
  sourceName: string
  content: string
  chunkIndex: number
  pageNumber?: number
  sheetName?: string
  location: string
  charStart: number
  charEnd: number
}

export interface KnowledgeDocumentDetail extends KnowledgeDocument {
  chunks: KnowledgeChunk[]
}

export interface KnowledgeDocumentPreview {
  document: KnowledgeDocumentDetail
  contentBase64?: string
  errorMessage?: string
}

export interface KnowledgeDocumentQuery {
  page: number
  pageSize: number
  search?: string
  status?: KnowledgeDocumentStatus
  extension?: string
  tag?: string
}

export interface KnowledgeDocumentPage {
  rows: KnowledgeDocument[]
  total: number
}

export interface KnowledgeUploadResult {
  ok: boolean
  canceled?: boolean
  acceptedCount: number
  reusedCount?: number
  skippedCount: number
  failedCount: number
  documents: KnowledgeDocument[]
  skipped: Array<{ fileName: string; reason: string }>
  message: string
}

export interface KnowledgeIndexProgress {
  taskId: string
  phase: 'queued' | 'parsing' | 'embedding' | 'records' | 'done' | 'error'
  documentId?: string
  fileName?: string
  message: string
  current: number
  total: number
  status: 'running' | 'success' | 'failed'
}

export interface KnowledgeStats {
  documentCount: number
  readyCount: number
  processingCount: number
  failedCount: number
  chunkCount: number
  indexedChunkCount: number
  recordCount: number
  modelVersion: string
}

export interface KnowledgeRebuildResult {
  ok: boolean
  taskId: string
  documentCount: number
  recordCount: number
  chunkCount: number
  message: string
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
  fieldLabels?: Record<string, string>
  groups: ChatDataGroup[]
}

export interface ChatRequest {
  question: string
  projectId?: string
  conversationId?: string
  expertId?: ExpertId
  entrypoint?: 'chat' | 'dashboard'
  dataScope?: DataScope
  focusComponentId?: string
  activeArtifact?: {
    artifactId: string
    version?: number
    dashboard: DashboardSpec
  }
  history?: ChatHistoryTurn[]
}

export interface ChatResponse {
  answer: string
  sources: ChatSource[]
  dataViews: ChatDataView[]
  expertId?: ExpertId
  dashboard?: DashboardSpec
  dashboardChange?: DashboardAiChangeSummary
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
  saveSystemSettings(input: SystemSettingsInput): Promise<AppSettings>
  saveModelSettings(input: ModelSettings): Promise<AppSettings>
  saveProjectMatchingSettings(input: ProjectMatchingSettings): Promise<AppSettings>
  saveFeatureSettings(input: FeatureModuleSettings): Promise<AppSettings>
  saveNavigationOrder(input: FeatureNavigationOrder): Promise<AppSettings>
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
  applyDataReview(input: DataReviewApplyInput): Promise<DataReviewApplyResult>
  listCollectionRequestLogs(page?: number, pageSize?: number): Promise<CollectionRequestLogPage>
  askAgent(request: ChatRequest): Promise<ChatResponse>
  listChatSessions(limit?: number): Promise<ChatSessionSummary[]>
  getChatSession(id: string): Promise<ChatSession | null>
  saveChatSession(input: ChatSessionSaveInput): Promise<ChatSession>
  deleteChatSession(id: string): Promise<ChatSessionDeleteResult>
  onAgentEvent(callback: (update: AgentProgressUpdate) => void): () => void
  listFieldProfiles(scope?: DataScope): Promise<FieldProfile[]>
  saveFieldProfileSemantics(
    scope: DataScope,
    field: string,
    patch: FieldProfileSemanticPatch
  ): Promise<FieldProfile>
  executeQuery(spec: QuerySpec): Promise<QueryDataset>
  listDashboards(): Promise<DashboardSummary[]>
  getDashboard(id: string, version?: number): Promise<DashboardVersion | null>
  listDashboardVersions(id: string): Promise<DashboardVersion[]>
  saveDashboard(input: DashboardSaveInput): Promise<DashboardVersion>
  restoreDashboard(id: string, version: number): Promise<DashboardVersion>
  exportDashboardJson(spec: DashboardSpec, version?: number): Promise<DashboardExportResult>
  exportDashboardPdf(spec: DashboardSpec, version?: number): Promise<DashboardExportResult>
  exportDashboardPng(spec: DashboardSpec, dataUrl: string, version?: number): Promise<DashboardExportResult>
  exportDashboardOffline(spec: DashboardSpec, version?: number): Promise<DashboardExportResult>
  diagnoseDashboard(spec: DashboardSpec): Promise<DashboardQualityReport>
  repairDashboardComponent(
    spec: DashboardSpec,
    componentId: string
  ): Promise<DashboardComponentRepairResult>
  listVisualizationRuns(limit?: number): Promise<VisualizationRun[]>
  listDashboardAuditLogs(dashboardId?: string, limit?: number): Promise<DashboardAuditLog[]>
  importData(): Promise<DataImportResult>
  exportData(): Promise<DataExportResult>
  deleteData(uids?: string[]): Promise<DataDeleteResult>
  previewPush(config: PushConfig): Promise<PushResult>
  startPush(config: PushConfig): Promise<PushResult>
  listPushLogs(page?: number, pageSize?: number): Promise<PushLogPage>
  onSyncProgress(callback: (progress: SyncProgress) => void): () => void
  listKnowledgeDocuments(query: KnowledgeDocumentQuery): Promise<KnowledgeDocumentPage>
  getKnowledgeDocument(id: string): Promise<KnowledgeDocumentDetail | null>
  getKnowledgeDocumentPreview(id: string): Promise<KnowledgeDocumentPreview | null>
  uploadKnowledgeDocuments(): Promise<KnowledgeUploadResult>
  retryKnowledgeDocument(id: string): Promise<KnowledgeDocument | null>
  updateKnowledgeDocumentTags(id: string, tags: string[]): Promise<KnowledgeDocument | null>
  deleteKnowledgeDocument(id: string): Promise<{ ok: boolean; message: string }>
  rebuildKnowledgeIndex(): Promise<KnowledgeRebuildResult>
  getKnowledgeStats(): Promise<KnowledgeStats>
  onKnowledgeProgress(callback: (progress: KnowledgeIndexProgress) => void): () => void
  listManagedProjects(query: ManagedProjectListQuery): Promise<ManagedProjectPage>
  getManagedProject(id: string): Promise<ManagedProject | null>
  listManagedProjectDocuments(id: string): Promise<ProjectDocumentSnapshot[]>
  createManagedProject(input: ManagedProjectInput): Promise<ManagedProject>
  updateManagedProject(id: string, input: ManagedProjectInput): Promise<ManagedProject | null>
  deleteManagedProject(id: string): Promise<{ ok: boolean; message: string }>
  exportManagedProjectData(id: string): Promise<ProjectDataTransferResult>
  exportManagedProjectExcel(id: string): Promise<ProjectDataTransferResult>
  importManagedProjectData(): Promise<ProjectDataTransferResult>
  discardManagedProjectDraft(id: string): Promise<{ ok: boolean; message: string }>
  startProjectTechnicalAgreementUpload(projectId?: string, options?: ProjectAgreementUploadOptions): Promise<ProjectAnalysisStartResult>
  listProjectAnalysisLogs(projectId: string, limit?: number): Promise<ProjectAnalysisLogEntry[]>
  confirmManagedProject(id: string): Promise<ManagedProject | null>
  retryProjectAnalysis(id: string): Promise<ProjectAnalysisStartResult>
  startProjectMatching(id: string): Promise<ProjectAnalysisStartResult>
  listProjectRequirements(query: ProjectRequirementQuery): Promise<ProjectRequirementPage>
  listAllProjectRequirements(projectId: string): Promise<ProjectRequirement[]>
  getProjectRequirement(id: string): Promise<ProjectRequirement | null>
  getProjectRequirementSet(projectId: string): Promise<ProjectRequirementSetSummary | null>
  createProjectRequirement(projectId: string, input: ProjectRequirementInput): Promise<ProjectRequirement>
  updateProjectRequirement(id: string, input: ProjectRequirementInput): Promise<ProjectRequirement | null>
  splitProjectRequirement(id: string, input: ProjectRequirementSplitInput): Promise<ProjectRequirement[]>
  mergeProjectRequirements(input: ProjectRequirementMergeInput): Promise<ProjectRequirement | null>
  reviewProjectRequirements(ids: string[], status: ProjectRequirementReviewStatus): Promise<{ ok: boolean; message: string }>
  publishProjectRequirements(projectId: string): Promise<ProjectAnalysisStartResult>
  deleteProjectRequirement(id: string): Promise<{ ok: boolean; message: string }>
  updateProjectRequirementStatus(id: string, status: ProjectRequirementStatus): Promise<ProjectRequirement | null>
  updateProjectRequirementKeyInfoTerms(id: string, terms: string[]): Promise<ProjectRequirement | null>
  startProjectRequirementMatching(id: string): Promise<ProjectAnalysisStartResult>
  listProjectRequirementMatches(query: ProjectRequirementMatchQuery): Promise<ProjectRequirementMatchPage>
  listProjectCostEntries(projectId: string): Promise<ProjectCostEntry[]>
  addProjectCostEntry(projectId: string, input: ProjectCostEntryInput): Promise<ProjectCostEntry>
  updateProjectCostEntry(id: string, input: ProjectCostEntryInput): Promise<ProjectCostEntry | null>
  deleteProjectCostEntry(id: string): Promise<{ ok: boolean; message: string }>
  listProjectAssets(projectId: string): Promise<ProjectAsset[]>
  linkProjectAsset(projectId: string, recordUid: string, requirementId?: string): Promise<ProjectAsset | null>
  unlinkProjectAsset(projectId: string, recordUid: string): Promise<{ ok: boolean; message: string }>
  unlinkProjectAssetRequirement(projectId: string, recordUid: string, requirementId: string): Promise<{ ok: boolean; message: string }>
  onProjectProgress(callback: (progress: ProjectAnalysisProgress) => void): () => void
  listOrganizationPeople(query: OrganizationPersonListQuery): Promise<OrganizationPersonPage>
  createOrganizationPerson(input: OrganizationPersonInput): Promise<OrganizationPerson>
  updateOrganizationPerson(id: string, input: OrganizationPersonInput): Promise<OrganizationPerson | null>
  deleteOrganizationPerson(id: string): Promise<{ ok: boolean; message: string }>
  listProjectParticipants(projectId: string): Promise<ProjectParticipant[]>
  addProjectParticipant(projectId: string, input: ProjectParticipantInput): Promise<ProjectParticipant>
  updateProjectParticipant(id: string, input: ProjectParticipantInput): Promise<ProjectParticipant | null>
  deleteProjectParticipant(id: string): Promise<{ ok: boolean; message: string }>
  listProjectTasks(projectId: string): Promise<ProjectPlanTask[]>
  addProjectTask(projectId: string, input: ProjectPlanTaskInput): Promise<ProjectPlanTask>
  updateProjectTask(id: string, input: ProjectPlanTaskInput): Promise<ProjectPlanTask | null>
  moveProjectTask(id: string, input: ProjectPlanTaskMoveInput): Promise<ProjectPlanTask | null>
  deleteProjectTask(id: string): Promise<{ ok: boolean; message: string }>
}
