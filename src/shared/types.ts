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
import type { AgentEvent, AgentProgressUpdate, AssistantExecutionSummary, ExpertId } from './expert-types'
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
  hasUploadPassword: boolean
}

export interface PlatformSettingsInput {
  baseUrl: string
  username: string
  token?: string
  uploadPassword?: string
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
  | 'rawchat-codex'
  | 'openai-compatible'

export interface ModelSettingsProfile {
  source: ModelSource
  provider: ModelProvider
  baseUrl: string
  model: string
  thinking: boolean
  hasApiKey?: boolean
}

export interface ModelSettings extends ModelSettingsProfile {
  /** Only present for an explicit save/test request; never returned by settings:get. */
  apiKey?: string
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
  rolloutMode: RequirementMatchingRolloutMode
}

export type RequirementMatchingRolloutMode = 'legacy_safe' | 'shadow' | 'v1_1'

export const DEFAULT_PROJECT_MATCHING_SETTINGS: ProjectMatchingSettings = {
  minScore: 40,
  rolloutMode: 'v1_1'
}

export const normalizeRequirementMatchingRolloutMode = (
  value: unknown,
  fallback: RequirementMatchingRolloutMode = 'legacy_safe'
): RequirementMatchingRolloutMode => (
  value === 'legacy_safe' || value === 'shadow' || value === 'v1_1' ? value : fallback
)

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
  /** The last saved configuration for each model source, without plaintext keys. */
  modelProfiles: Record<ModelSource, ModelSettingsProfile>
  projectMatching: ProjectMatchingSettings
  features: FeatureModuleSettings
  navigationOrder: FeatureNavigationOrder
}

export type ModelCapabilityStatus = 'supported' | 'limited' | 'unsupported' | 'unknown' | 'error'

export type ModelCapabilityEvidence = 'metadata' | 'active-probe' | 'provider-contract'

export interface ModelCapabilityItem {
  status: ModelCapabilityStatus
  summary: string
  evidence: ModelCapabilityEvidence
  value?: number | boolean | string
}

export interface ModelCapabilityReport {
  checkedAt: string
  probeMode: 'metadata' | 'active'
  source: ModelSource
  provider: ModelProvider
  model: string
  checks: {
    connection: ModelCapabilityItem
    minimalChat: ModelCapabilityItem
    structuredOutput: ModelCapabilityItem
    toolCalling: ModelCapabilityItem
    contextWindow: ModelCapabilityItem
    thinking: ModelCapabilityItem
  }
}

export interface ConnectionResult {
  ok: boolean
  message: string
  details?: Record<string, unknown>
  capabilityReport?: ModelCapabilityReport
}

export type UpdateStatusPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdateStatusPhase
  currentVersion: string
  version?: string
  releaseDate?: string
  releaseNotes?: string
  checkedAt?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  message?: string
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
  releaseText: string
  lastModifyTime: string
  syncedAt: string
  imageCount: number
  normalizedText?: string
  pushStatus: 'pending' | 'success' | 'failed'
  pushMessage: string
  pushedAt: string
  pushedUid: string
}

export interface RecordReleaseValue {
  value: string
  count: number
}

export type FieldDefinitionNormalizedType =
  | 'string'
  | 'rich_text'
  | 'log'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'system_enum'
  | 'reference'
  | 'relation'
  | 'url'
  | 'special'
  | 'unknown'

export interface FieldDefinition {
  nodeType: string
  field: string
  displayName: string
  /** Original VISSLM MemberType, retained for round-tripping and diagnostics. */
  sourceType: string
  /** Stable application-level type derived from sourceType. */
  normalizedType: FieldDefinitionNormalizedType
  /** Original localized VISSLM AttrType label. */
  attrType: string
  /** VISSLM field-definition row Uid. */
  sourceUid: string
  /** VISSLM internal Member identifier. */
  internalMember: string
  /** VISSLM MemberConditionUid identifier. */
  conditionUid: string
  isSystem: boolean
  isEditable: boolean
  isRemovable: boolean
  updatedAt?: string
}

export interface RecordDetail extends RecordRow {
  raw: Record<string, unknown>
  images: ImageAsset[]
  matchingText: string
  maintenance: RecordMaintenanceState
  fieldLabels?: Record<string, string>
}

export type RecordMaintenanceScope = 'all' | 'selected'

export type RecordMaintenanceOperation = 'clean' | 'rebuild_indexes' | 'optimize'

export type RecordMaintenanceTaskStatus =
  | 'queued'
  | 'scanning'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'

export type RecordMaintenanceStage =
  | 'scanning'
  | 'cleaning'
  | 'lexical'
  | 'vector'
  | 'finalizing'
  | 'idle'

export type RecordMaintenanceIndexStatus =
  | 'ready'
  | 'pending'
  | 'stale'
  | 'running'
  | 'failed'
  | 'unavailable'

export interface RecordMaintenanceIndexState {
  status: RecordMaintenanceIndexStatus
  version: string
  modelVersion?: string
  chunkCount?: number
  updatedAt: string
  error?: string
}

export interface RecordMaintenanceState {
  overallStatus: RecordMaintenanceIndexStatus
  clean: RecordMaintenanceIndexState
  lexical: RecordMaintenanceIndexState
  vector: RecordMaintenanceIndexState
  lastTaskId?: string
  lastOperation?: RecordMaintenanceOperation
}

export interface RecordMaintenanceStartInput {
  scope: RecordMaintenanceScope
  recordUids?: string[]
  operation: RecordMaintenanceOperation
}

export interface RecordMaintenancePreview {
  scope: RecordMaintenanceScope
  totalCount: number
  cleanPendingCount: number
  lexicalPendingCount: number
  vectorPendingCount: number
  modelVersion: string
  normalizerVersion: string
  lexicalVersion: string
  scannedAt: string
}

export interface RecordMaintenanceFailedItem {
  uid: string
  name: string
  stage: RecordMaintenanceStage
  error: string
}

export interface RecordMaintenanceTaskSnapshot {
  taskId: string
  scope: RecordMaintenanceScope
  operation: RecordMaintenanceOperation
  status: RecordMaintenanceTaskStatus
  stage: RecordMaintenanceStage
  message: string
  current: number
  total: number
  succeeded: number
  failed: number
  currentUid?: string
  currentName?: string
  failedItems: RecordMaintenanceFailedItem[]
  startedAt: string
  updatedAt: string
  finishedAt?: string
}

export interface ImageAsset {
  id: string
  recordUid: string
  name: string
  mimeType: string
  sourceUrl: string
  sha256: string
  byteSize: number
  /** A secure local asset URL; preferred over dataUri for new records. */
  assetUrl?: string
  state: 'ready' | 'unresolved' | 'missing'
  errorMessage?: string
  /** @deprecated New code must not materialize image data as Base64. */
  dataUri?: string
}

export interface RecordImagePage {
  page: number
  pageSize: number
  total: number
  images: ImageAsset[]
}

export interface RecordImageReference {
  id: string
  recordUid: string
  fieldPath: string
  /** Source occurrence in the original field. */
  occurrence: number
  ordinal?: number
  assetSha256: string
  sourceType: string
  sourceName: string
  originalSource: string
  createdAt: string
}

export interface RecordQuery {
  page: number
  pageSize: number
  search?: string
  projectId?: string
  nodeType?: string
  excludeProjectAssetProjectId?: string
  releaseText?: string
}

/** Asset-center filters allowed when exporting the complete filtered result. */
export type RecordExportQuery = Pick<
  RecordQuery,
  'search' | 'projectId' | 'nodeType' | 'releaseText'
>

/** Safe numeric model telemetry; hidden reasoning/content is intentionally excluded. */
export interface ModelUsage {
  promptTokens?: number
  completionTokens?: number
  promptDurationMs?: number
  completionDurationMs?: number
  totalDurationMs?: number
  loadDurationMs?: number
}

export interface RecordPage {
  rows: RecordRow[]
  total: number
}

export interface DataImportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  /** Stable local identifier for diagnostics when a streamed import is interrupted. */
  importRunId?: string
  recordCount: number
  imageCount: number
  skippedCount: number
  errors: string[]
  message: string
  reviewBatchId?: string
  duplicates: DataReviewItem[]
  format?: 'json' | 'jsonl' | 'visslmpack'
  packVersion?: number
  assetCount?: number
  assetBytes?: number
  checksumVerified?: boolean
  /** Streaming legacy import metrics; absent for older/resource-pack callers. */
  batchCount?: number
  sourceRowCount?: number
  parseErrorCount?: number
  durationMs?: number
}

export type DataImportRunStatus = 'running' | 'success' | 'failed'

export interface DataImportRunSnapshot {
  id: string
  path: string
  format: 'json' | 'jsonl'
  fileSize: number
  fileMtimeMs: number
  status: DataImportRunStatus
  batchCount: number
  sourceRowCount: number
  importedRecordCount: number
  skippedCount: number
  parseErrorCount: number
  reviewBatchId: string
  errorMessage: string
  startedAt: string
  updatedAt: string
  finishedAt: string
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
  format?: 'jsonl' | 'visslmpack'
  packVersion?: number
  assetCount?: number
  assetBytes?: number
}

export interface DataDeleteResult {
  ok: boolean
  recordCount: number
  imageCount: number
  message: string
}

export type DataDeleteProgressStatus = 'running' | 'completed' | 'failed'

export type DataDeleteProgressPhase =
  | 'preparing'
  | 'deleting_records'
  | 'rebuilding_index'
  | 'completed'
  | 'failed'

export interface DataDeleteProgress {
  taskId: string
  status: DataDeleteProgressStatus
  phase: DataDeleteProgressPhase
  current: number
  total: number
  percent: number
  message: string
  detail?: string
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
  /** When supplied (including []), only mapped source values are sent in the body. */
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
  imageTotal?: number
  imageUpload?: number
  imageReuse?: number
  imageFailed?: number
  imageErrors?: string[]
  response?: unknown
  error?: string
}

export interface PushResult {
  preview: boolean
  total: number
  successCount: number
  failedCount: number
  requests: PushRequestTrace[]
  imageTotal?: number
  imageUpload?: number
  imageReuse?: number
  imageFailed?: number
  imageErrors?: string[]
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
  updatedCount: number
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

/** Stable, persistence-safe activity entry for a completed assistant turn. */
export type AssistantExecutionLogKind = 'narrative' | 'tool' | 'checkpoint'

export type AssistantExecutionLogStatus = 'running' | 'completed' | 'warning' | 'failed'

export interface AssistantExecutionLogEntry {
  activityId: string
  sequence: number
  kind: AssistantExecutionLogKind
  stage: string
  title?: string
  summary: string
  status: AssistantExecutionLogStatus
  createdAt: string
}

/** Append-only execution facts retained with the assistant message. */
export interface AssistantExecutionLog {
  durationMs: number
  entries: AssistantExecutionLogEntry[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  retryQuestion?: string
  sources?: ChatSource[]
  dataViews?: ChatDataView[]
  dashboard?: DashboardSpec
  dashboardVersion?: number
  expertId?: ExpertId
  contextRefs?: ChatContextRef[]
  contextStats?: ChatContextStats
  /** Persisted Auto-mode control decision for follow-up display and audit. */
  assistantIntent?: AssistantIntentDecision
  /** Persisted structured execution facts for this assistant turn. */
  taskTrace?: AssistantTaskTrace
  /** Actual execution facts retained for evidence and artifact provenance. */
  executionSummary?: AssistantExecutionSummary
  /** Business-facing choices shown only when the assistant truly needs a user decision. */
  clarificationOptions?: AssistantClarificationOption[]
  /** Persisted, safe execution activities for this completed assistant turn. */
  executionLog?: AssistantExecutionLog
  /** Session-level scope carried forward explicitly and restored with history. */
  dataScope?: DataScope
  dataScopeSummary?: string
  recoverySuggestions?: ChatRecoverySuggestion[]
  /** Fixed, source-aware evidence ledger for this completed turn. */
  evidenceBlocks?: EvidenceBlock[]
  contextOutcome?: 'success' | 'failed' | 'undone'
}

/** Lightweight references that let a follow-up resolve prior evidence on demand. */
export interface ChatContextRef {
  kind: 'record' | 'dataView' | 'dashboard'
  id: string
  label?: string
  itemId?: string
  total?: number
  version?: number
  fields?: string[]
}

export interface ChatContextStats {
  budgetTokens: number
  evidenceBudgetTokens: number
  evidenceUsedTokens: number
  requestedCount: number
  requestOmittedCount: number
  resolvedCount: number
  missingCount: number
  detailIncludedCount: number
  detailOmittedCount: number
  detailOmittedFields: number
  recoveryHint?: string
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant'
  content: string
  outcome?: 'success' | 'failed' | 'undone'
  contextRefs?: ChatContextRef[]
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
  /** Prefer the short-lived streaming URL for large source files. */
  contentUrl?: string
  contentByteSize?: number
  contentBase64?: string
  renderFormat?: 'docx' | 'pdf' | 'xlsx' | 'text'
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
  /** Elapsed wall-clock time for the current in-process task. */
  elapsedMs?: number
  /** Completed units per second when a positive progress denominator exists. */
  throughputPerSecond?: number
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
  /** Most recent persisted indexing task, including failures recovered after restart. */
  latestTask?: KnowledgeIndexProgress
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
  /** UID snapshot for this group; kept separate from the view-wide index. */
  recordUids?: string[]
}

export interface ChatDataView {
  id: string
  title: string
  description: string
  total: number
  /** Number of rows actually included in the payload; defaults to total for legacy views. */
  loadedRows?: number
  isPreview?: boolean
  fields: string[]
  fieldLabels?: Record<string, string>
  groups: ChatDataGroup[]
  /** Server-side paging key for large record-backed views. */
  recordUids?: string[]
}

export interface ChatDataViewPage {
  page: number
  pageSize: number
  total: number
  rows: ChatDataRow[]
}

/**
 * The single, source-aware decision produced before an Auto chat request is
 * allowed to touch a database, knowledge index, or specialist skill.
 * Keeping this contract in shared types lets the main process and IPC tests
 * validate the same bounded decision shape.
 */
export type AssistantIntentTaskType =
  | 'conversation'
  | 'record_query'
  | 'knowledge_qa'
  | 'mixed_analysis'
  | 'visualization'
  | 'requirement_matching'
  | 'artifact_generation'

export type AssistantIntentSourceMode = 'conversation' | 'records' | 'knowledge' | 'mixed'

export type AssistantIntentResultMode =
  | 'answer'
  | 'list'
  | 'grouped_list'
  | 'table'
  | 'dashboard'
  | 'artifact'

/** User-selected reasoning policy for the assistant's final answer only. */
export type AssistantThinkingMode = 'auto' | 'on' | 'off'

export interface AssistantIntentDecision {
  taskType: AssistantIntentTaskType
  skillId: ExpertId
  sourceMode: AssistantIntentSourceMode
  resolvedQuestion: string
  resultMode: AssistantIntentResultMode
  /** Entities explicitly grounded in the current question or user history. */
  groupEntities: string[]
  needsClarification: boolean
  clarificationQuestion?: string
  reason: string
}

export type AssistantClarificationOptionAction = 'submit' | 'compose'

export interface AssistantClarificationOption {
  id: string
  label: string
  description?: string
  /** Text to submit immediately or place in the composer, depending on action. */
  prompt: string
  action: AssistantClarificationOptionAction
}

/** Actual execution agents are separate from the UI-facing expert mentions. */
export type AssistantExecutionAgentId =
  | 'conversation'
  | 'data-center'
  | 'knowledge-base'
  | 'requirement-analysis'
  | 'visualization'
  | 'artifact'

export type AssistantTaskTraceStatus = 'completed' | 'clarification' | 'failed' | 'cancelled'

export interface AssistantTaskTrace {
  runId: string
  status: AssistantTaskTraceStatus
  primaryAgent: AssistantExecutionAgentId
  invokedAgents: AssistantExecutionAgentId[]
  taskType: AssistantIntentTaskType
  sourceMode: AssistantIntentSourceMode
  resultMode: AssistantIntentResultMode
  startedAt: string
  completedAt: string
  clarificationQuestion?: string
  error?: {
    code: string
    message: string
  }
}

export interface ChatRequest {
  question: string
  /** Main process validated run identifier used for cancellation and tracing. */
  runId?: string
  projectId?: string
  conversationId?: string
  expertId?: ExpertId
  /**
   * The renderer sets plain mode for messages without an explicit expert
   * mention. Keeping this separate from expertId preserves the IPC contract
   * for callers that intentionally request the general data assistant.
   */
  chatMode?: 'plain' | 'auto' | 'expert'
  /** Optional final-answer reasoning policy; omitted requests remain compatible and default to auto. */
  thinkingMode?: AssistantThinkingMode
  /** Internal IDs extracted for automatic direct data analysis; the model still receives question verbatim. */
  extractedRequirementIds?: string[]
  entrypoint?: 'chat' | 'dashboard'
  dataScope?: DataScope
  focusComponentId?: string
  activeArtifact?: {
    artifactId: string
    version?: number
    dashboard: DashboardSpec
  }
  /** Verified assistant turn selected as the only source for artifact generation. */
  artifactSource?: AssistantArtifactInput
  history?: ChatHistoryTurn[]
  /** Validated Auto-mode intent; direct Ollama callers may omit it. */
  assistantIntent?: AssistantIntentDecision
}

export interface ChatResponse {
  answer: string
  sources: ChatSource[]
  dataViews: ChatDataView[]
  /** True when the active run was cancelled before a usable answer completed. */
  cancelled?: boolean
  /** The planner stopped safely and is asking the user to disambiguate scope/source/fields. */
  needsClarification?: boolean
  clarificationQuestion?: string
  /** Two or three concrete, business-language choices for the user decision. */
  clarificationOptions?: AssistantClarificationOption[]
  /** Validated control decision selected before any Auto-mode evidence access. */
  assistantIntent?: AssistantIntentDecision
  taskTrace?: AssistantTaskTrace
  executionSummary?: AssistantExecutionSummary
  recoverySuggestions?: ChatRecoverySuggestion[]
  evidenceBlocks?: EvidenceBlock[]
  contextRefs?: ChatContextRef[]
  /**
   * Optional diagnostics for bounded/compacted model context.  The field is
   * intentionally additive so older agents and persisted chat messages remain
   * compatible while the renderer can explain omitted evidence and offer a
   * narrower follow-up query.
   */
  contextStats?: ChatContextStats
  expertId?: ExpertId
  dashboard?: DashboardSpec
  dashboardChange?: DashboardAiChangeSummary
  /** Fail-closed preview returned by the artifact skill before local file creation. */
  artifactPreview?: AssistantArtifactPreview
  events?: AgentEvent[]
}

export interface ChatRecoverySuggestion {
  id: 'confirm_fields' | 'narrow_scope' | 'search_content'
  label: string
  prompt: string
  reason: string
}

export type EvidenceBlockKind = 'record' | 'document' | 'aggregate' | 'query_detail'

export interface EvidenceBlock {
  id: string
  kind: EvidenceBlockKind
  title: string
  summary: string
  count: number
  /** Indexes into ChatResponse.sources; keeps the block lightweight and auditable. */
  sourceIndexes?: number[]
  /** Stable ChatDataView entry for full result inspection and pagination. */
  dataViewId?: string
  matchedCount?: number
  returnedCount?: number
  truncated?: boolean
}

export type AssistantArtifactType =
  | 'analysis_snapshot'
  | 'saved_filter'
  | 'report_draft'
  | 'delivery_draft'
export type AssistantArtifactStatus = 'active' | 'reverted'
export type AssistantArtifactOutputFormat = 'docx' | 'xlsx' | 'pptx' | 'zip'

export interface AssistantArtifactInput {
  type: AssistantArtifactType
  conversationId: string
  messageId: string
  title: string
  question: string
  answer: string
  executionSummary?: AssistantExecutionSummary
  evidenceBlocks: EvidenceBlock[]
  dataViews: ChatDataView[]
  /** Sources referenced by EvidenceBlock.sourceIndexes; optional for legacy saved artifacts. */
  sources?: ChatSource[]
  outputFormat?: AssistantArtifactOutputFormat
  instructions?: string
}

export interface AssistantArtifactPreview {
  previewId: string
  type: AssistantArtifactType
  title: string
  contentPreview: string
  impact: {
    recordEvidenceCount: number
    documentEvidenceCount: number
    queryMatchedCount: number
    sourceWriteCount: 0
  }
  rollbackPoint: string
  input: AssistantArtifactInput
  payloadHash: string
}

export interface AssistantArtifact {
  id: string
  type: AssistantArtifactType
  status: AssistantArtifactStatus
  version: number
  conversationId: string
  messageId: string
  title: string
  payload: AssistantArtifactInput
  createdAt: string
  updatedAt: string
}

export interface AssistantArtifactExportFile {
  name: string
  mimeType: string
  byteSize: number
  sha256: string
}

export interface AssistantArtifactExportManifest {
  schemaVersion: '1.0'
  artifactId: string
  title: string
  format: AssistantArtifactOutputFormat
  conversationId: string
  messageId: string
  generatedAt: string
  evidence: {
    blockCount: number
    recordCount: number
    documentCount: number
    queryMatchedCount: number
    dataViewCount: number
    sourceCount: number
  }
  files: AssistantArtifactExportFile[]
}

export interface AssistantArtifactExportRequest {
  artifactId: string
  format: AssistantArtifactOutputFormat
  instructions?: string
}

export interface AssistantArtifactExportResult {
  ok: boolean
  canceled?: boolean
  format: AssistantArtifactOutputFormat
  filePath?: string
  fileName?: string
  mimeType?: string
  byteSize?: number
  sha256?: string
  manifest?: AssistantArtifactExportManifest
  message: string
}

export interface AssistantRunHistory {
  runId: string
  conversationId?: string
  status: AssistantTaskTraceStatus
  taskType: AssistantIntentTaskType
  sourceMode: AssistantIntentSourceMode
  resultMode: AssistantIntentResultMode
  primaryAgent: AssistantExecutionAgentId
  invokedAgents: AssistantExecutionAgentId[]
  startedAt: string
  completedAt: string
  durationMs: number
  /** Total prompt/input tokens reported by model calls in this run. */
  inputTokenCount?: number
  /** Total completion/output tokens reported by model calls in this run. */
  outputTokenCount?: number
  /** Output tokens per second, derived from model completion or run duration. */
  tokensPerSecond?: number
  stages: Array<{ stage: string; message: string; at: string }>
  toolCallCount: number
  matchedCount: number
  recordEvidenceCount: number
  documentEvidenceCount: number
  failedStage?: string
  error?: { code: string; message: string }
}

export interface AssistantRunHistoryStats {
  total: number
  completed: number
  failed: number
  cancelled: number
  clarification: number
  averageDurationMs: number
  totalToolCalls: number
  totalMatchedCount: number
}

export type CancelAgentRunStatus = 'cancel_requested' | 'not_found' | 'invalid'

export interface CancelAgentRunResult {
  ok: boolean
  runId: string
  status: CancelAgentRunStatus
  message?: string
}

export interface AppApi {
  minimizeWindow(): Promise<void>
  toggleMaximizeWindow(): Promise<boolean>
  closeWindow(): Promise<void>
  isWindowMaximized(): Promise<boolean>
  onWindowMaximized(callback: (maximized: boolean) => void): () => void
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void
  getSettings(): Promise<AppSettings>
  savePlatformSettings(input: PlatformSettingsInput): Promise<AppSettings>
  saveSystemSettings(input: SystemSettingsInput): Promise<AppSettings>
  saveModelSettings(input: ModelSettings): Promise<AppSettings>
  saveProjectMatchingSettings(input: ProjectMatchingSettings): Promise<AppSettings>
  saveFeatureSettings(input: FeatureModuleSettings): Promise<AppSettings>
  saveNavigationOrder(input: FeatureNavigationOrder): Promise<AppSettings>
  testPlatform(input?: PlatformSettingsInput): Promise<ConnectionResult>
  testModel(input?: ModelSettings, probeChat?: boolean, probeCapabilities?: boolean): Promise<ConnectionResult>
  listProjects(): Promise<ProjectRow[]>
  listNodeTypes(): Promise<string[]>
  listRecords(query: RecordQuery): Promise<RecordPage>
  listRecordReleaseValues(): Promise<RecordReleaseValue[]>
  listRecordUids(query: Omit<RecordQuery, 'page' | 'pageSize'>): Promise<string[]>
  getRecord(uid: string): Promise<RecordDetail | null>
  getRecordForChat(uid: string): Promise<RecordDetail | null>
  getRecordImagePage(uid: string, page: number, pageSize: number): Promise<RecordImagePage>
  getChatDataViewPage(
    view: Pick<ChatDataView, 'recordUids' | 'fields'>,
    page: number,
    pageSize: number
  ): Promise<ChatDataViewPage>
  previewRecordMaintenance(input: Pick<RecordMaintenanceStartInput, 'scope' | 'recordUids'>): Promise<RecordMaintenancePreview>
  startRecordMaintenance(input: RecordMaintenanceStartInput): Promise<RecordMaintenanceTaskSnapshot>
  getRecordMaintenanceTask(): Promise<RecordMaintenanceTaskSnapshot | null>
  stopRecordMaintenance(): Promise<RecordMaintenanceTaskSnapshot | null>
  onRecordMaintenanceProgress(callback: (snapshot: RecordMaintenanceTaskSnapshot) => void): () => void
  getStats(): Promise<DashboardStats>
  getSyncConfig(): Promise<SyncScopeConfig | null>
  saveSyncConfig(config: SyncScopeConfig): Promise<void>
  previewSync(config?: SyncScopeConfig): Promise<SyncPreviewResult>
  startSync(config?: SyncScopeConfig): Promise<SyncResult>
  applyDataReview(input: DataReviewApplyInput): Promise<DataReviewApplyResult>
  listCollectionRequestLogs(page?: number, pageSize?: number): Promise<CollectionRequestLogPage>
  askAgent(request: ChatRequest): Promise<ChatResponse>
  cancelAgentRun(runId: string): Promise<CancelAgentRunResult>
  previewAssistantArtifact(input: AssistantArtifactInput): Promise<AssistantArtifactPreview>
  commitAssistantArtifact(preview: AssistantArtifactPreview): Promise<AssistantArtifact>
  listAssistantArtifacts(limit?: number): Promise<AssistantArtifact[]>
  revertAssistantArtifact(id: string): Promise<AssistantArtifact>
  exportAssistantArtifact(input: AssistantArtifactExportRequest): Promise<AssistantArtifactExportResult>
  listAssistantRunHistory(limit?: number): Promise<AssistantRunHistory[]>
  getAssistantRunHistoryStats(): Promise<AssistantRunHistoryStats>
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
  listDataImportRuns(limit?: number): Promise<DataImportRunSnapshot[]>
  getDataImportRun(id: string): Promise<DataImportRunSnapshot | null>
  resumeDataImportRun(id: string): Promise<DataImportResult>
  exportData(query?: RecordExportQuery): Promise<DataExportResult>
  deleteData(uids?: string[]): Promise<DataDeleteResult>
  onDataDeleteProgress(callback: (progress: DataDeleteProgress) => void): () => void
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
  cancelKnowledgeTask(taskId: string): Promise<boolean>
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
