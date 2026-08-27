import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChatMessage,
  ChatDataView,
  ChatDataViewPage,
  ChatSession,
  ChatSessionDeleteResult,
  ChatSessionSaveInput,
  ChatSessionSummary,
  ChatSource,
  AssistantArtifact,
  AssistantArtifactInput,
  AssistantRunHistory,
  AssistantRunHistoryStats,
  CollectionRequestLogPage,
  CollectionRequestLogRow,
  CollectionRequestLogStatus,
  DataReviewApplyResult,
  DataReviewItem,
  DataReviewSource,
  DataReviewSummary,
  DataDeleteResult,
  DataImportResult,
  DataImportRunSnapshot,
  DataImportRunStatus,
  DashboardStats,
  FieldDefinition,
  FieldDefinitionNormalizedType,
  ImageAsset,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeDocumentPage,
  KnowledgeDocumentQuery,
  KnowledgeDocumentStatus,
  KnowledgeIndexProgress,
  KnowledgeStats,
  ProjectRow,
  PushLogPage,
  PushLogRow,
  PushLogStatus,
  RecordDetail,
  RecordImagePage,
  RecordMaintenanceFailedItem,
  RecordMaintenanceIndexStatus,
  RecordMaintenanceOperation,
  RecordMaintenancePreview,
  RecordMaintenanceScope,
  RecordMaintenanceStage,
  RecordMaintenanceState,
  RecordMaintenanceTaskSnapshot,
  RecordMaintenanceTaskStatus,
  RecordPage,
  RecordReleaseValue,
  RecordQuery,
  RecordRow,
  RequirementSemanticizationStatus,
  RequirementSemanticizationStatusReason,
  RequirementSemanticizationAnalysisTrace,
  SyncRun
} from '../shared/types'
import {
  compactChatContextRefs,
  compactChatDataViews,
  compactRecordUids,
  sanitizeContextText
} from './context-budget'
import { sanitizeChatMessageContent } from '../shared/chat-message-format'
import {
  buildRequirementBusinessText,
  isAiRequirementSemanticCard,
  type RequirementSemanticCard
} from './requirements/semantic-card'
import type {
  ManagedProject,
  ManagedProjectInput,
  ManagedProjectListQuery,
  ManagedProjectPage,
  OrganizationPerson,
  OrganizationPersonInput,
  OrganizationPersonListQuery,
  OrganizationPersonPage,
  ProjectAnalysisLogEntry,
  ProjectAsset,
  ProjectAnalysisProgress,
  ProjectCostEntry,
  ProjectCostEntryInput,
  ProjectDataSnapshot,
  ProjectDocumentSnapshot,
  ProjectParticipant,
  ProjectParticipantInput,
  ProjectPlanTask,
  ProjectPlanTaskRequirement,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectRequirement,
  ProjectRequirementCategory,
  ProjectRequirementInput,
  ProjectRequirementMergeInput,
  ProjectRequirementMatch,
  ProjectRequirementMatchPage,
  ProjectRequirementMatchQuery,
  ProjectRequirementPage,
  ProjectRequirementQuery,
  ProjectRequirementReviewStatus,
  ProjectRequirementSetSummary,
  ProjectRequirementSplitInput,
  ProjectRequirementStatus,
  ProjectRequirementStatusSource
} from '../shared/project-types'
import { normalizeProjectRequirementText } from '../shared/project-requirement-utils'
import {
  RECORD_LEXICAL_INDEX_VERSION,
  RECORD_NORMALIZER_VERSION,
  RECORD_VECTOR_INDEX_VERSION
} from './record-maintenance-constants'
import {
  findRichTextImageSources,
  parseAssetToken,
  replaceRichTextImageSources
} from './rich-text-assets'
import type {
  DataScope,
  FieldProfile,
  FieldProfileRole,
  FieldProfileSemanticPatch,
  FieldSensitivity,
  QueryDataset
} from '../shared/query-spec'
import type {
  DashboardAuditAction,
  DashboardAuditLog,
  DashboardAuditLogInput,
  DashboardAuditStatus,
  DashboardSaveInput,
  DashboardSpec,
  DashboardSummary,
  DashboardVersion,
  VisualizationRun,
  VisualizationRunInput,
  VisualizationToolCall,
  VisualizationToolName
} from '../shared/dashboard'

export interface RecordInput {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  parentId: string
  name: string
  lastModifyTime: string
  raw: Record<string, unknown>
  normalizedText: string
}

export interface ImageInput {
  recordUid: string
  name: string
  mimeType: string
  sourceUrl: string
  /** Original candidate URL used to key an unresolved marker, when download normalizes sourceUrl. */
  unresolvedSourceUrl?: string
  bytes: Buffer
}

export interface AssetBlob {
  sha256: string
  mimeType: string
  byteSize: number
  filePath: string
}

export interface RecordImageReference {
  id: string
  recordUid: string
  fieldPath: string
  occurrence: number
  ordinal: number
  assetSha256: string
  sourceType: string
  sourceName: string
  originalSource: string
  createdAt: string
}

export interface PushAssetUpload {
  cacheKey: string
  baseUrl: string
  projectId: string
  sha256: string
  remotePath: string
  createdAt: string
}

export interface PendingDataReview extends DataReviewItem {
  payload: unknown
}

type SqlRow = Record<string, unknown>
type SqlStatement = ReturnType<DatabaseSync['prepare']>

const nowIso = (): string => new Date().toISOString()
const KNOWLEDGE_VECTOR_COARSE_STEP = 8
const TASK_RETENTION_DAYS = 30
const KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE = 256
const KNOWLEDGE_RECORD_REPLACEMENT_MAX = 64
const KNOWLEDGE_RECORD_REPLACEMENT_MAX_CHUNKS = 4096
const RECORD_MAINTENANCE_UID_BATCH_SIZE = 400

const normalizeAssistantRunHistoryMetric = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
)

/** Keep older payloads readable while dropping malformed newly optional metrics. */
const normalizeAssistantRunHistoryPayload = (value: unknown): AssistantRunHistory | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const {
    inputTokenCount: rawInputTokenCount,
    outputTokenCount: rawOutputTokenCount,
    tokensPerSecond: rawTokensPerSecond,
    ...legacyFields
  } = record
  const inputTokenCount = normalizeAssistantRunHistoryMetric(rawInputTokenCount)
  const outputTokenCount = normalizeAssistantRunHistoryMetric(rawOutputTokenCount)
  const tokensPerSecond = normalizeAssistantRunHistoryMetric(rawTokensPerSecond)
  return {
    ...legacyFields,
    ...(inputTokenCount === undefined ? {} : { inputTokenCount }),
    ...(outputTokenCount === undefined ? {} : { outputTokenCount }),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond })
  } as AssistantRunHistory
}

const buildKnowledgeCoarseVector = (vector: Float32Array): Float32Array => {
  const coarse = new Float32Array(Math.ceil(vector.length / KNOWLEDGE_VECTOR_COARSE_STEP))
  for (let index = 0, coarseIndex = 0; index < vector.length; index += KNOWLEDGE_VECTOR_COARSE_STEP, coarseIndex += 1) {
    coarse[coarseIndex] = vector[index]
  }
  let norm = 0
  for (const value of coarse) norm += value * value
  if (norm > 0) {
    const inverseNorm = 1 / Math.sqrt(norm)
    for (let index = 0; index < coarse.length; index += 1) coarse[index] *= inverseNorm
  }
  return coarse
}

const knowledgeCoarseBucket = (coarse: Float32Array): number => {
  // Four sign bits are deliberately small and stable.  They are only a
  // future shard hint; exact ranking remains in the service layer.
  let bucket = 0
  for (let index = 0; index < Math.min(4, coarse.length); index += 1) {
    if (coarse[index] >= 0) bucket |= 1 << index
  }
  return bucket
}

const float32FromBlob = (value: unknown): Float32Array | undefined => {
  if (!value) return undefined
  const bytes = Uint8Array.from(value as Uint8Array)
  if (!bytes.byteLength || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return undefined
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT)
}

const normalizeMimeType = (input: unknown): string => {
  const candidate = String(input ?? '').trim().toLowerCase().split(';', 1)[0]
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(candidate)
    ? candidate
    : 'application/octet-stream'
}

const compactImageSource = (sourceInput: unknown, sha256: string): string => {
  const source = String(sourceInput ?? '')
  return /^data:image\//i.test(source) ? `inline:data-uri:${sha256}` : source
}

const unresolvedImageMarker = (recordUid: string, name: string, sourceUrl: string): string =>
  createHash('sha256')
    .update(`unresolved\u0000${recordUid}\u0000${name}\u0000${sourceUrl}`)
    .digest('hex')

const decodeLegacyBase64File = (
  sourcePath: string,
  temporaryPath: string
): { sha256: string; byteSize: number } | null => {
  let inputFd: number | undefined
  let outputFd: number | undefined
  let quartet = ''
  let sawPadding = false
  let byteSize = 0
  const hash = createHash('sha256')
  const writeFully = (bytes: Buffer): void => {
    let offset = 0
    while (offset < bytes.byteLength) {
      offset += writeSync(outputFd as number, bytes, offset, bytes.byteLength - offset)
    }
  }
  try {
    mkdirSync(dirname(temporaryPath), { recursive: true })
    inputFd = openSync(sourcePath, 'r')
    outputFd = openSync(temporaryPath, 'w')
    const chunk = Buffer.allocUnsafe(64 * 1024)
    let bytesRead = 0
    const pushQuartet = (value: string): boolean => {
      if (value.length !== 4 || value[0] === '=' || value[1] === '=' ||
        (value[2] === '=' && value[3] !== '=')) return false
      const decoded = Buffer.from(value, 'base64')
      if (!decoded.length) return false
      writeFully(decoded)
      hash.update(decoded)
      byteSize += decoded.byteLength
      if (value.includes('=')) sawPadding = true
      return true
    }
    while ((bytesRead = readSync(inputFd, chunk, 0, chunk.byteLength, null)) > 0) {
      const text = chunk.subarray(0, bytesRead).toString('ascii')
      for (const character of text) {
        if (/\s/.test(character)) continue
        if (!/[A-Za-z0-9+/=]/.test(character) || sawPadding) return null
        quartet += character
        if (quartet.length === 4) {
          if (!pushQuartet(quartet)) return null
          quartet = ''
        }
      }
    }
    if (quartet.length === 1 || (quartet.length > 1 && !pushQuartet(quartet.padEnd(4, '=')))) {
      return null
    }
    if (!byteSize) return null
    return { sha256: hash.digest('hex'), byteSize }
  } catch {
    return null
  } finally {
    if (inputFd !== undefined) {
      try { closeSync(inputFd) } catch {}
    }
    if (outputFd !== undefined) {
      try { closeSync(outputFd) } catch {}
    }
  }
}

const parseJsonValue = (input: unknown, fallback: unknown): unknown => {
  if (!input) return fallback
  try {
    return JSON.parse(String(input)) as unknown
  } catch {
    return fallback
  }
}

const visualizationToolNames = new Set<VisualizationToolName>([
  'profile-fields',
  'model-compose',
  'validate-dashboard',
  'execute-query',
  'apply-patch',
  'repair-attempt'
])

const normalizeVisualizationToolCalls = (input: unknown): VisualizationToolCall[] => {
  if (!Array.isArray(input)) return []
  return input.slice(0, 100).flatMap((value, index): VisualizationToolCall[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const call = value as Partial<VisualizationToolCall>
    if (!visualizationToolNames.has(call.tool as VisualizationToolName)) return []
    const rawMetadata = call.metadata && typeof call.metadata === 'object' && !Array.isArray(call.metadata)
      ? call.metadata
      : {}
    const metadata = Object.fromEntries(
      Object.entries(rawMetadata)
        .filter(([, item]) => typeof item === 'boolean' || Number.isFinite(item))
        .slice(0, 12)
    ) as Record<string, number | boolean>
    const durationMs = Number(call.durationMs)
    const attempt = Number(call.attempt)
    return [{
      sequence: index + 1,
      tool: call.tool as VisualizationToolName,
      status: call.status === 'failed' ? 'failed' : 'success',
      attempt: Number.isFinite(attempt) ? Math.max(0, Math.min(10, Math.floor(attempt))) : 0,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, Number(durationMs.toFixed(2))) : 0,
      ...(call.componentId?.trim() ? { componentId: call.componentId.trim().slice(0, 120) } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {})
    }]
  })
}

export interface KnowledgeDocumentInput {
  id: string
  fileName: string
  filePath: string
  extension: string
  mimeType: string
  byteSize: number
  sha256: string
  tags?: string[]
  status?: KnowledgeDocumentStatus
  modelVersion?: string
}

export interface KnowledgeChunkInput {
  id: string
  documentId?: string
  recordUid?: string
  sourceType: 'document' | 'record'
  sourceName: string
  sourceHash: string
  content: string
  chunkIndex: number
  pageNumber?: number
  sheetName?: string
  location?: string
  charStart?: number
  charEnd?: number
}

export interface KnowledgeVectorInput {
  chunkId: string
  vector: Float32Array
  modelVersion: string
}

export interface RecordMaintenanceTarget {
  uid: string
  name: string
}

export interface RecordMaintenanceTaskItem {
  uid: string
  name: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'stopped'
  stage: RecordMaintenanceStage
  error?: string
}

export interface KnowledgeRecordIndexRow {
  uid: string
  name: string
  nodeType: string
  itemId: string
  content: string
  contentHash: string
}

export interface KnowledgeRecordIndexSnapshotOptions {
  /** Cursor for the candidate records branch; records are ordered by uid. */
  recordCursor?: string
  /** Cursor for the orphaned record-index rows branch; rows are ordered by uid. */
  deletedCursor?: string
  /** Maximum rows returned by each branch. */
  limit?: number
  /** Disable a branch after its cursor has reached the end. */
  includeRecords?: boolean
  includeDeleted?: boolean
}

export interface KnowledgeRecordIndexSnapshot {
  rows: KnowledgeRecordIndexRow[]
  deletedRecordUids: string[]
  hasMoreRecords: boolean
  hasMoreDeletedRecords: boolean
  nextRecordCursor?: string
  nextDeletedCursor?: string
}

export interface KnowledgeRecordChunkReplacement {
  recordUid: string
  chunks: readonly KnowledgeChunkInput[]
  vectors: readonly KnowledgeVectorInput[]
}

export interface KnowledgeRecordChunkReplacementResult {
  recordUid: string
  chunkCount?: number
  error?: string
}

export interface RequirementLexicalMatch {
  recordUid: string
  recordName: string
  nodeType: string
  itemId: string
  score: number
  snippet: string
}

export interface RequirementSemanticCardState {
  recordUid: string
  contentHash: string
  analyzerVersion: string
  modelSignature: string
  status: RequirementSemanticizationStatus
  card: RequirementSemanticCard | null
  errorMessage: string
  startedAt: string
  completedAt: string
  updatedAt: string
  analysisTrace: Record<string, unknown>
}

export interface RequirementSemanticizationCandidate {
  recordUid: string
  itemId: string
  name: string
  contentHash: string
}

export interface RequirementSemanticizationContext {
  analyzerVersion: string
  modelSignature: string
}

export interface RequirementMatchCache {
  cacheKey: string
  baseRecordUid: string
  candidateRecordUid: string
  queryHash: string
  baseContentHash: string
  candidateContentHash: string
  baseCardHash: string
  candidateCardHash: string
  analyzerVersion: string
  semanticModelSignature: string
  embeddingModelVersion: string
  rerankerVersion: string
  strategyVersion: string
  explanationModelSignature: string
  resultJson: string
  resultStatus: 'live_verified' | 'cache_verified'
  createdAt: string
  updatedAt: string
}

export interface RequirementMatchCacheInput {
  cacheKey: string
  baseRecordUid: string
  candidateRecordUid: string
  queryHash: string
  baseContentHash: string
  candidateContentHash: string
  baseCardHash: string
  candidateCardHash: string
  analyzerVersion: string
  semanticModelSignature: string
  embeddingModelVersion: string
  rerankerVersion: string
  strategyVersion: string
  explanationModelSignature: string
  result: unknown
  resultStatus: 'live_verified' | 'cache_verified'
}

const requirementMatchCacheStatuses = new Set<RequirementMatchCache['resultStatus']>([
  'live_verified',
  'cache_verified'
])

const requirementMatchCacheMax = {
  cacheKey: 512,
  recordUid: 256,
  hash: 256,
  version: 256,
  resultJson: 512 * 1024
} as const

const normalizeRequirementMatchCacheString = (
  value: unknown,
  field: string,
  maxLength: number
): string => {
  if (typeof value !== 'string') throw new Error(`${field} 必须是文本`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} 不能为空`)
  if (normalized.length > maxLength) throw new Error(`${field} 超过 ${maxLength} 字符限制`)
  return normalized
}

const normalizeRequirementMatchCacheJson = (value: unknown): string => {
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value.trim()) : value
  } catch {
    throw new Error('result 必须是有效 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('result 必须是结构化 JSON 对象')
  }
  const serialized = JSON.stringify(parsed)
  if (!serialized || serialized.length > requirementMatchCacheMax.resultJson) {
    throw new Error(`result 超过 ${requirementMatchCacheMax.resultJson} 字符限制`)
  }
  return serialized
}

const mapRequirementMatchCacheRow = (row: SqlRow): RequirementMatchCache | null => {
  const resultStatus = String(row.result_status ?? '').trim() as RequirementMatchCache['resultStatus']
  if (!requirementMatchCacheStatuses.has(resultStatus)) return null
  try {
    return {
      cacheKey: normalizeRequirementMatchCacheString(row.cache_key, 'cacheKey', requirementMatchCacheMax.cacheKey),
      baseRecordUid: normalizeRequirementMatchCacheString(row.base_record_uid, 'baseRecordUid', requirementMatchCacheMax.recordUid),
      candidateRecordUid: normalizeRequirementMatchCacheString(row.candidate_record_uid, 'candidateRecordUid', requirementMatchCacheMax.recordUid),
      queryHash: normalizeRequirementMatchCacheString(row.query_hash, 'queryHash', requirementMatchCacheMax.hash),
      baseContentHash: normalizeRequirementMatchCacheString(row.base_content_hash, 'baseContentHash', requirementMatchCacheMax.hash),
      candidateContentHash: normalizeRequirementMatchCacheString(row.candidate_content_hash, 'candidateContentHash', requirementMatchCacheMax.hash),
      baseCardHash: normalizeRequirementMatchCacheString(row.base_card_hash, 'baseCardHash', requirementMatchCacheMax.hash),
      candidateCardHash: normalizeRequirementMatchCacheString(row.candidate_card_hash, 'candidateCardHash', requirementMatchCacheMax.hash),
      analyzerVersion: normalizeRequirementMatchCacheString(row.analyzer_version, 'analyzerVersion', requirementMatchCacheMax.version),
      semanticModelSignature: normalizeRequirementMatchCacheString(row.semantic_model_signature, 'semanticModelSignature', requirementMatchCacheMax.version),
      embeddingModelVersion: normalizeRequirementMatchCacheString(row.embedding_model_version, 'embeddingModelVersion', requirementMatchCacheMax.version),
      rerankerVersion: normalizeRequirementMatchCacheString(row.reranker_version, 'rerankerVersion', requirementMatchCacheMax.version),
      strategyVersion: normalizeRequirementMatchCacheString(row.strategy_version, 'strategyVersion', requirementMatchCacheMax.version),
      explanationModelSignature: normalizeRequirementMatchCacheString(row.explanation_model_signature, 'explanationModelSignature', requirementMatchCacheMax.version),
      resultJson: normalizeRequirementMatchCacheJson(String(row.result_json ?? '')),
      resultStatus,
      createdAt: normalizeRequirementMatchCacheString(row.created_at, 'createdAt', 64),
      updatedAt: normalizeRequirementMatchCacheString(row.updated_at, 'updatedAt', 64)
    }
  } catch {
    return null
  }
}

const requirementSemanticContentSql = (alias: string): string => `${alias}.semantic_hash`

const REQUIREMENT_BUSINESS_INDEX_MIGRATION_KEY = 'migration:requirement-business-index'
const REQUIREMENT_BUSINESS_INDEX_VERSION = 'requirement-business-index-v3'

const requirementSemanticSourceHash = (input: {
  name: string
  lastModifyTime: string
  rawJson: string
  normalizedText: string
  fieldLabels?: Record<string, string>
}): string => {
  let raw: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(input.rawJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    }
  } catch {
    raw = {}
  }
  return createHash('sha256')
    .update(`requirement-business-source-v3\n${buildRequirementBusinessText({
      name: input.name,
      raw,
      fieldLabels: input.fieldLabels
    })}`)
    .digest('hex')
}

export interface KnowledgeVectorRow {
  chunk: KnowledgeChunk
  vector: Float32Array
  coarse?: Float32Array
}

const fieldProfileRoles = new Set<FieldProfileRole>([
  'dimension',
  'measure',
  'time',
  'identifier'
])

const fieldSensitivities = new Set<FieldSensitivity>(['normal', 'internal', 'sensitive'])

const parseJsonArray = (value: unknown): string[] => {
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed)
      ? parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 12)
      : []
  } catch {
    return []
  }
}

const mapFieldProfileRow = (row: SqlRow): FieldProfile => {
  const role = String(row.role ?? '')
  const sensitivity = String(row.sensitivity ?? 'normal')
  const displayName = String(row.display_name ?? '').trim()
  const profiledAt = String(row.profiled_at ?? '').trim()
  return {
    field: String(row.field),
    inferredType: String(row.inferred_type) as FieldProfile['inferredType'],
    sensitivity: fieldSensitivities.has(sensitivity as FieldSensitivity)
      ? sensitivity as FieldSensitivity
      : 'normal',
    nonNullRate: Number(row.non_null_rate),
    distinctCount: Number(row.distinct_count),
    samples: parseJsonArray(row.samples_json),
    ...(displayName ? { displayName } : {}),
    ...(fieldProfileRoles.has(role as FieldProfileRole)
      ? { role: role as FieldProfileRole }
      : {}),
    synonyms: parseJsonArray(row.synonyms_json),
    ...(profiledAt ? { profiledAt } : {})
  }
}

const fieldDefinitionNormalizedTypes = new Set<FieldDefinitionNormalizedType>([
  'string',
  'rich_text',
  'log',
  'integer',
  'number',
  'boolean',
  'date',
  'datetime',
  'enum',
  'system_enum',
  'reference',
  'relation',
  'url',
  'special',
  'unknown'
])

const fieldDefinitionSourceTypeMap: Readonly<Record<string, FieldDefinitionNormalizedType>> = {
  SINGLELINETEXT: 'string',
  MULTILINETEXT: 'string',
  RICH: 'rich_text',
  LOG: 'log',
  INTEGER: 'integer',
  FLOAT: 'number',
  BOOL: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  DATAENUM: 'enum',
  SYSTEMENUM: 'system_enum',
  REFERENCE: 'reference',
  RELATION: 'relation',
  URL: 'url',
  SPECIALTYPE: 'special'
}

const normalizeStoredFieldDefinitionType = (
  sourceType: unknown,
  declaredType: unknown
): FieldDefinitionNormalizedType => {
  const normalized = String(declaredType ?? '').trim().toLocaleLowerCase() as FieldDefinitionNormalizedType
  if (fieldDefinitionNormalizedTypes.has(normalized)) return normalized
  return fieldDefinitionSourceTypeMap[String(sourceType ?? '').trim().toLocaleUpperCase()] ?? 'unknown'
}

const storedFieldDefinitionBoolean = (input: unknown): boolean => {
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') return Number.isFinite(input) && input !== 0
  if (typeof input !== 'string') return false
  return ['1', 'true', 'yes', 'y', 'on', 't', '是', '真']
    .includes(input.trim().toLocaleLowerCase())
}

const mapFieldDefinitionRow = (row: SqlRow): FieldDefinition => {
  const sourceType = String(row.source_type ?? '').trim()
  return {
    nodeType: String(row.node_type ?? '').trim(),
    field: String(row.field ?? '').trim(),
    displayName: String(row.display_name ?? '').trim(),
    sourceType,
    normalizedType: normalizeStoredFieldDefinitionType(sourceType, row.normalized_type),
    attrType: String(row.attr_type ?? '').trim(),
    sourceUid: String(row.source_uid ?? '').trim(),
    internalMember: String(row.internal_member ?? '').trim(),
    conditionUid: String(row.condition_uid ?? '').trim(),
    isSystem: storedFieldDefinitionBoolean(row.is_system),
    isEditable: storedFieldDefinitionBoolean(row.is_editable),
    isRemovable: storedFieldDefinitionBoolean(row.is_removable),
    updatedAt: String(row.updated_at ?? '').trim()
  }
}

export interface FieldAggregateOptions {
  field: string
  projectId?: string
  projectIds?: string[]
  nodeType?: string
  nodeTypes?: string[]
  recordUids?: string[]
  baseFilters?: FieldQueryFilter[]
  filters?: FieldQueryFilter[]
  limit?: number
  splitMultiValue?: boolean
}

export interface FieldAggregateResult {
  field: string
  totalRecords: number
  matchedRecords: number
  emptyRecords: number
  valueOccurrences: number
  splitMultiValue: boolean
  items: Array<{
    name: string
    value: number
    examples: Array<{ source: ChatSource }>
  }>
}

export interface FieldInspectionOptions {
  projectId?: string
  projectIds?: string[]
  nodeType?: string
  nodeTypes?: string[]
  recordUids?: string[]
  search?: string
  limit?: number
}

export interface FieldInspectionResult {
  totalRecords: number
  fields: Array<{
    field: string
    displayName?: string
    /** Declared application type from the VISSLM member catalog. */
    declaredType?: FieldDefinitionNormalizedType
    /** Original VISSLM MemberType from the member catalog. */
    sourceType?: string
    /** Original localized VISSLM AttrType from the member catalog. */
    attrType?: string
    nonEmptyRecords: number
    coverageRate: number
    types: string[]
    samples: string[]
  }>
}

export type FieldQueryOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export interface FieldQueryFilter {
  field: string
  operator: FieldQueryOperator
  value?: string
}

export interface FieldQueryOptions {
  projectId?: string
  /** Multi-project scope; when present it takes precedence over projectId. */
  projectIds?: string[]
  nodeType?: string
  /** Multi-type scope; when present it takes precedence over nodeType. */
  nodeTypes?: string[]
  /** Immutable record scope; an explicitly empty list matches no rows. */
  recordUids?: string[]
  search?: string
  searchTerms?: string[]
  searchMode?: 'any' | 'all'
  /** Inherited filters applied together with filters using AND. */
  baseFilters?: FieldQueryFilter[]
  filters?: FieldQueryFilter[]
  fields?: string[]
  sort?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
}

export interface FieldQueryResult {
  totalScanned: number
  matchedCount: number
  returnedCount: number
  /** Complete matched UID index for UI paging, capped to a bounded safety limit. */
  recordUids: string[]
  /**
   * Complete UID snapshots for each normalized search term. The index is
   * derived from the full matched set rather than preview rows, so a grouped
   * view can page each group independently when more than 50 rows match.
   * Optional only for compatibility with older planner/test results; database
   * queries always provide it.
   */
  recordUidsByTerm?: Record<string, string[]>
  fields: string[]
  fieldLabels?: Record<string, string>
  records: Array<{
    source: ChatSource
    values: Record<string, string | string[]>
    /** Search terms from the request that matched this record. */
    matchedTerms?: string[]
  }>
}

export const FIELD_QUERY_UID_LIMIT = 10_000

export interface AnalyticsRecord {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  name: string
  lastModifyTime: string
  raw: Record<string, unknown>
}

const fieldValuesAtPath = (raw: Record<string, unknown>, fieldPath: string): unknown[] => {
  const direct = raw[fieldPath]
  if (direct !== undefined) return [direct]

  const segments = fieldPath.split('.').map((segment) => segment.trim()).filter(Boolean)
  const descend = (current: unknown, remaining: string[]): unknown[] => {
    if (!remaining.length) return [current]
    if (Array.isArray(current)) {
      return current.flatMap((item) => descend(item, remaining))
    }
    if (!current || typeof current !== 'object') return []
    const object = current as Record<string, unknown>
    const [segment, ...rest] = remaining
    const actualKey = Object.keys(object).find(
      (key) => key.localeCompare(segment, undefined, { sensitivity: 'accent' }) === 0
    )
    return actualKey ? descend(object[actualKey], rest) : []
  }
  return descend(raw, segments)
}

const scalarFieldValues = (value: unknown): string[] => {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(scalarFieldValues)
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['name', 'Name', 'label', 'Label', 'value', 'Value']) {
      if (object[key] !== undefined) return scalarFieldValues(object[key])
    }
    return []
  }
  const text = String(value).trim()
  return text ? [text] : []
}

const normalizedFieldValues = (value: unknown, splitMultiValue: boolean): string[] => {
  const values = scalarFieldValues(value).flatMap((item) =>
    splitMultiValue ? item.split(/[，,；;\n\r、|]+/) : [item]
  )
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))]
}

const dateLikePattern =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/

const scalarType = (value: unknown): string => {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (
    typeof value === 'string' &&
    dateLikePattern.test(value.trim()) &&
    Number.isFinite(Date.parse(value))
  ) return 'date'
  return typeof value
}

const collectRecordFieldValues = (
  input: Record<string, unknown>,
  maxDepth = 3
): Map<string, unknown[]> => {
  const collected = new Map<string, unknown[]>()
  const add = (path: string, value: unknown): void => {
    const values = collected.get(path) ?? []
    values.push(value)
    collected.set(path, values)
  }
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      const scalarItems = value.filter(
        (item) => item === null || typeof item !== 'object'
      )
      if (scalarItems.length) add(path, scalarItems)
      if (depth < maxDepth) {
        value
          .filter((item) => item && typeof item === 'object')
          .forEach((item) => visit(item, path, depth + 1))
      }
      return
    }
    if (typeof value === 'object') {
      if (depth >= maxDepth) return
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1)
      }
      return
    }
    add(path, value)
  }
  visit(input, '', 0)
  return collected
}

const comparisonValue = (value: string): number | string => {
  const numeric = Number(value)
  if (value.trim() && Number.isFinite(numeric)) return numeric
  if (dateLikePattern.test(value.trim())) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) return date
  }
  return value.toLocaleLowerCase()
}

const matchesFieldFilter = (values: string[], filter: FieldQueryFilter): boolean => {
  if (filter.operator === 'is_empty') return values.length === 0
  if (filter.operator === 'not_empty') return values.length > 0
  if (!values.length) return false
  const expected = String(filter.value ?? '').trim()
  const expectedLower = expected.toLocaleLowerCase()
  if (filter.operator === 'equals') {
    return values.some((value) => value.toLocaleLowerCase() === expectedLower)
  }
  if (filter.operator === 'not_equals') {
    return values.every((value) => value.toLocaleLowerCase() !== expectedLower)
  }
  if (filter.operator === 'contains') {
    return values.some((value) => value.toLocaleLowerCase().includes(expectedLower))
  }
  if (filter.operator === 'not_contains') {
    return values.every((value) => !value.toLocaleLowerCase().includes(expectedLower))
  }
  const right = comparisonValue(expected)
  return values.some((value) => {
    const left = comparisonValue(value)
    if (typeof left !== typeof right) return false
    if (filter.operator === 'gt') return left > right
    if (filter.operator === 'gte') return left >= right
    if (filter.operator === 'lt') return left < right
    return left <= right
  })
}

const fieldSearchTerms = (search?: string): string[] => {
  const input = search?.trim().toLocaleLowerCase()
  if (!input) return []
  const terms = [input]
  const aliases: Array<[RegExp, string[]]> = [
    [/负责人|责任人|处理人/, ['assigned', 'assignee', 'owner', 'username']],
    [/来源|来源单位/, ['source']],
    [/状态/, ['state', 'status']],
    [/版本|发布/, ['release', 'version']],
    [/创建时间/, ['createtime', 'created']],
    [/修改时间|更新时间/, ['lastmodifytime', 'updated']],
    [/操作人|执行人|活动人/, ['record.username', 'username']]
  ]
  for (const [pattern, mapped] of aliases) {
    if (pattern.test(input)) terms.push(...mapped)
  }
  return [...new Set(terms)]
}

const releaseNameFromRaw = (raw: Record<string, unknown>): string => {
  const displayValue = raw._valm_Release_text
  const releaseValue =
    displayValue !== undefined && displayValue !== null && String(displayValue).trim() !== ''
      ? displayValue
      : raw._valm_Release
  if (releaseValue === undefined || releaseValue === null || String(releaseValue).trim() === '') {
    return '未设置'
  }
  return typeof releaseValue === 'object' ? JSON.stringify(releaseValue) : String(releaseValue)
}

const releaseTextFromRaw = (raw: Record<string, unknown>): string => {
  const releaseValue = raw._valm_Release_text
  if (releaseValue === undefined || releaseValue === null) return ''
  const value = typeof releaseValue === 'object' ? JSON.stringify(releaseValue) : String(releaseValue)
  return value.trim()
}

const releaseTextSql = (tableAlias: string): string => `TRIM(CASE
  WHEN json_valid(${tableAlias}.raw_json) THEN CASE json_type(${tableAlias}.raw_json, '$._valm_Release_text')
    WHEN 'true' THEN 'true'
    WHEN 'false' THEN 'false'
    WHEN 'null' THEN NULL
    ELSE CAST(json_extract(${tableAlias}.raw_json, '$._valm_Release_text') AS TEXT)
  END
  ELSE NULL
END)`

export class AppDatabase {
  private readonly db: DatabaseSync
  private readonly assetDir: string
  private readonly binaryAssetDir: string
  private transactionDepth = 0
  // Dashboard stats include project-management aggregates as well as record
  // aggregates.  The analytics revision only changes for record writes, so a
  // short TTL prevents a project-management mutation from leaving a stale
  // dashboard indefinitely while still coalescing concurrent IPC reads.
  private statsCache: { revision: number; createdAt: number; value: DashboardStats } | null = null
  private recordWriteStatements: {
    conflict: SqlStatement
    previous: SqlStatement
    deleteImageRefs: SqlStatement
    upsert: SqlStatement
  } | null = null
  private requirementSearchStatements: {
    delete: SqlStatement
    select: SqlStatement
    insert: SqlStatement
  } | null = null
  private maintenanceWriteStatements: {
    ensure: SqlStatement
    update: SqlStatement
  } | null = null
  private readonly fieldDefinitionFingerprintCache = new Map<string, string>()

  constructor(databasePath: string, assetDir: string) {
    mkdirSync(assetDir, { recursive: true })
    this.assetDir = assetDir
    // The current bootstrap still passes the historical `assets/base64`
    // directory.  Keep documents/legacy files there, while putting new
    // content-addressed bytes at the plan's `assets/blobs/<prefix>/<sha>`.
    const assetRoot = basename(assetDir).toLocaleLowerCase() === 'base64'
      ? dirname(assetDir)
      : assetDir
    this.binaryAssetDir = join(assetRoot, 'blobs')
    mkdirSync(this.binaryAssetDir, { recursive: true })
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        preview TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated
        ON chat_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS assistant_artifacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_artifacts_updated
        ON assistant_artifacts(updated_at DESC);

      CREATE TABLE IF NOT EXISTS assistant_run_history (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_assistant_run_history_completed
        ON assistant_run_history(completed_at DESC);

      CREATE TABLE IF NOT EXISTS projects (
        uid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_id TEXT NOT NULL DEFAULT '',
        last_modify_time TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        uid TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        node_type TEXT NOT NULL DEFAULT '',
        item_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        last_modify_time TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL,
        normalized_text TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        semantic_hash TEXT NOT NULL DEFAULT '',
        synced_at TEXT NOT NULL,
        push_status TEXT NOT NULL DEFAULT 'pending',
        push_message TEXT NOT NULL DEFAULT '',
        pushed_at TEXT NOT NULL DEFAULT '',
        pushed_uid TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
      CREATE INDEX IF NOT EXISTS idx_records_type ON records(node_type);
      CREATE INDEX IF NOT EXISTS idx_records_parent ON records(parent_id);
      CREATE INDEX IF NOT EXISTS idx_records_modify ON records(last_modify_time);
      CREATE INDEX IF NOT EXISTS idx_records_item_id ON records(item_id);

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        record_uid TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        source_url TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        base64_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'ready',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(record_uid, sha256),
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_images_record ON images(record_uid);
      CREATE INDEX IF NOT EXISTS idx_images_hash ON images(sha256);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        project_count INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS push_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_uid TEXT NOT NULL DEFAULT '',
        record_name TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT 'POST',
        endpoint TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        body_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'sending',
        http_status INTEGER NOT NULL DEFAULT 0,
        response_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        remote_uid TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_push_logs_created ON push_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_push_logs_record ON push_logs(record_uid);
      CREATE INDEX IF NOT EXISTS idx_push_logs_status ON push_logs(status);

      CREATE TABLE IF NOT EXISTS collection_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT 'GET',
        endpoint TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'running',
        http_status INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        response_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_collection_logs_created
        ON collection_request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collection_logs_status
        ON collection_request_logs(status);

      CREATE TABLE IF NOT EXISTS data_review_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        source TEXT NOT NULL,
        item_id TEXT NOT NULL,
        existing_uid TEXT NOT NULL,
        existing_project_id TEXT NOT NULL DEFAULT '',
        existing_node_type TEXT NOT NULL DEFAULT '',
        existing_name TEXT NOT NULL DEFAULT '',
        existing_last_modify_time TEXT NOT NULL DEFAULT '',
        incoming_uid TEXT NOT NULL,
        incoming_project_id TEXT NOT NULL DEFAULT '',
        incoming_node_type TEXT NOT NULL DEFAULT '',
        incoming_name TEXT NOT NULL DEFAULT '',
        incoming_last_modify_time TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_data_review_batch
        ON data_review_items(batch_id, source, created_at);
      CREATE INDEX IF NOT EXISTS idx_data_review_item
        ON data_review_items(item_id);

      CREATE TABLE IF NOT EXISTS data_import_runs (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        format TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        file_mtime_ms INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'running',
        batch_count INTEGER NOT NULL DEFAULT 0,
        source_row_count INTEGER NOT NULL DEFAULT 0,
        imported_record_count INTEGER NOT NULL DEFAULT 0,
        skipped_count INTEGER NOT NULL DEFAULT 0,
        parse_error_count INTEGER NOT NULL DEFAULT 0,
        review_batch_id TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_data_import_runs_status
        ON data_import_runs(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_data_import_runs_updated
        ON data_import_runs(updated_at DESC);

      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        component_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dashboard_versions (
        dashboard_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(dashboard_id, version),
        FOREIGN KEY(dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dashboards_updated ON dashboards(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_versions_created
        ON dashboard_versions(dashboard_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS visualization_runs (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL DEFAULT '',
        request_summary TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        prompt_version TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'generate',
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        component_count INTEGER NOT NULL DEFAULT 0,
        query_count INTEGER NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0,
        tool_calls_json TEXT NOT NULL DEFAULT '[]',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_visualization_runs_created
        ON visualization_runs(created_at DESC);

      CREATE TABLE IF NOT EXISTS dashboard_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dashboard_id TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER,
        format TEXT NOT NULL DEFAULT '',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dashboard_audit_created
        ON dashboard_audit_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_audit_dashboard
        ON dashboard_audit_logs(dashboard_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS field_profiles (
        scope_key TEXT NOT NULL,
        field TEXT NOT NULL,
        inferred_type TEXT NOT NULL,
        non_null_rate REAL NOT NULL,
        distinct_count INTEGER NOT NULL,
        samples_json TEXT NOT NULL DEFAULT '[]',
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        synonyms_json TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL DEFAULT 'normal',
        profiled_at TEXT NOT NULL,
        data_revision INTEGER NOT NULL,
        PRIMARY KEY(scope_key, field)
      );

      CREATE INDEX IF NOT EXISTS idx_field_profiles_revision
        ON field_profiles(data_revision);

      CREATE TABLE IF NOT EXISTS field_definitions (
        node_type TEXT NOT NULL,
        field TEXT NOT NULL,
        display_name TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT '',
        normalized_type TEXT NOT NULL DEFAULT 'unknown',
        attr_type TEXT NOT NULL DEFAULT '',
        source_uid TEXT NOT NULL DEFAULT '',
        internal_member TEXT NOT NULL DEFAULT '',
        condition_uid TEXT NOT NULL DEFAULT '',
        is_system INTEGER NOT NULL DEFAULT 0,
        is_editable INTEGER NOT NULL DEFAULT 0,
        is_removable INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(node_type, field)
      );

      CREATE INDEX IF NOT EXISTS idx_field_definitions_field
        ON field_definitions(field);

      CREATE TABLE IF NOT EXISTS query_cache (
        cache_key TEXT PRIMARY KEY,
        data_revision INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_query_cache_revision
        ON query_cache(data_revision);

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        extension TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        byte_size INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL UNIQUE,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        error_message TEXT NOT NULL DEFAULT '',
        chunk_count INTEGER NOT NULL DEFAULT 0,
        page_count INTEGER NOT NULL DEFAULT 0,
        model_version TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        processed_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_status
        ON knowledge_documents(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_extension
        ON knowledge_documents(extension);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT,
        record_uid TEXT,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL DEFAULT '',
        source_hash TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        page_number INTEGER,
        sheet_name TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        char_start INTEGER NOT NULL DEFAULT 0,
        char_end INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, chunk_index),
        UNIQUE(record_uid, chunk_index),
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
        ON knowledge_chunks(document_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_record
        ON knowledge_chunks(record_uid, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_record_source
        ON knowledge_chunks(record_uid, source_type, chunk_index);

      CREATE TABLE IF NOT EXISTS knowledge_vectors (
        chunk_id TEXT PRIMARY KEY,
        vector_blob BLOB NOT NULL,
        dimension INTEGER NOT NULL,
        model_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(chunk_id) REFERENCES knowledge_chunks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_vectors_model
        ON knowledge_vectors(model_version);

      CREATE TABLE IF NOT EXISTS knowledge_index_tasks (
        id TEXT PRIMARY KEY,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        current_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        throughput_per_second REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requirement_semantic_cards (
        record_uid TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        model_signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        card_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        completed_at TEXT NOT NULL DEFAULT '',
        analysis_trace_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_requirement_semantic_cards_status
        ON requirement_semantic_cards(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS requirement_match_cache (
        cache_key TEXT PRIMARY KEY,
        base_record_uid TEXT NOT NULL,
        candidate_record_uid TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        base_content_hash TEXT NOT NULL,
        candidate_content_hash TEXT NOT NULL,
        base_card_hash TEXT NOT NULL,
        candidate_card_hash TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        semantic_model_signature TEXT NOT NULL,
        embedding_model_version TEXT NOT NULL,
        reranker_version TEXT NOT NULL,
        strategy_version TEXT NOT NULL,
        explanation_model_signature TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        result_status TEXT NOT NULL CHECK (result_status IN ('live_verified', 'cache_verified')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_requirement_match_cache_updated
        ON requirement_match_cache(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_requirement_match_cache_lookup
        ON requirement_match_cache(base_record_uid, candidate_record_uid, query_hash, updated_at DESC);

      CREATE TABLE IF NOT EXISTS record_maintenance_states (
        record_uid TEXT PRIMARY KEY,
        clean_status TEXT NOT NULL DEFAULT 'pending',
        clean_version TEXT NOT NULL DEFAULT '',
        clean_updated_at TEXT NOT NULL DEFAULT '',
        clean_error TEXT NOT NULL DEFAULT '',
        lexical_status TEXT NOT NULL DEFAULT 'pending',
        lexical_version TEXT NOT NULL DEFAULT '',
        lexical_updated_at TEXT NOT NULL DEFAULT '',
        lexical_error TEXT NOT NULL DEFAULT '',
        vector_status TEXT NOT NULL DEFAULT 'pending',
        vector_version TEXT NOT NULL DEFAULT '',
        vector_model_version TEXT NOT NULL DEFAULT '',
        vector_chunk_count INTEGER NOT NULL DEFAULT 0,
        vector_updated_at TEXT NOT NULL DEFAULT '',
        vector_error TEXT NOT NULL DEFAULT '',
        last_task_id TEXT NOT NULL DEFAULT '',
        last_operation TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_record_maintenance_states_status
        ON record_maintenance_states(clean_status, lexical_status, vector_status);

      CREATE TABLE IF NOT EXISTS record_maintenance_tasks (
        task_id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        record_uids_json TEXT NOT NULL DEFAULT '[]',
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '',
        current_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        succeeded_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        current_uid TEXT NOT NULL DEFAULT '',
        current_name TEXT NOT NULL DEFAULT '',
        failed_items_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_record_maintenance_tasks_updated
        ON record_maintenance_tasks(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_record_maintenance_tasks_status
        ON record_maintenance_tasks(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS record_maintenance_items (
        task_id TEXT NOT NULL,
        record_uid TEXT NOT NULL,
        record_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        stage TEXT NOT NULL DEFAULT 'scanning',
        error_message TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_id, record_uid),
        FOREIGN KEY(task_id) REFERENCES record_maintenance_tasks(task_id) ON DELETE CASCADE,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_record_maintenance_items_status
        ON record_maintenance_items(task_id, status, updated_at);

      CREATE TABLE IF NOT EXISTS org_people (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        employee_no TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT '',
        hourly_rate REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_org_people_name
        ON org_people(name COLLATE NOCASE, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_org_people_status
        ON org_people(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pm_projects (
        id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        customer_name TEXT NOT NULL DEFAULT '',
        contract_amount REAL NOT NULL DEFAULT 0,
        risk_factor REAL NOT NULL DEFAULT 0,
        delivery_reminder_days INTEGER NOT NULL DEFAULT 0,
        planned_delivery_date TEXT NOT NULL DEFAULT '',
        sales_owner TEXT NOT NULL DEFAULT '',
        technical_owner TEXT NOT NULL DEFAULT '',
        development_owner TEXT NOT NULL DEFAULT '',
        estimated_cost REAL NOT NULL DEFAULT 0,
        actual_cost REAL NOT NULL DEFAULT 0,
        estimated_duration_days INTEGER NOT NULL DEFAULT 0,
        lifecycle TEXT NOT NULL DEFAULT 'draft',
        source TEXT NOT NULL DEFAULT 'manual',
        analysis_status TEXT NOT NULL DEFAULT 'idle',
        analysis_message TEXT NOT NULL DEFAULT '',
        match_status TEXT NOT NULL DEFAULT 'idle',
        match_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pm_projects_updated
        ON pm_projects(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pm_projects_analysis
        ON pm_projects(analysis_status, match_status);

      CREATE TABLE IF NOT EXISTS pm_cost_entries (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        cost_type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        amount REAL NOT NULL DEFAULT 0,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        asset_record_uid TEXT,
        responsible_participant_id TEXT,
        responsible_person_name TEXT NOT NULL DEFAULT '',
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_cost_entries_project
        ON pm_cost_entries(project_id, cost_type, occurred_at DESC);

      CREATE TABLE IF NOT EXISTS pm_project_documents (
        project_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        is_current INTEGER NOT NULL DEFAULT 1,
        linked_at TEXT NOT NULL,
        PRIMARY KEY(project_id, document_id),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_documents_current
        ON pm_project_documents(project_id, is_current, version DESC);

      CREATE TABLE IF NOT EXISTS pm_requirement_sets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'reviewing',
        total_chunks INTEGER NOT NULL DEFAULT 0,
        analyzed_chunks INTEGER NOT NULL DEFAULT 0,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        external_processing INTEGER NOT NULL DEFAULT 0,
        model_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        published_at TEXT NOT NULL DEFAULT '',
        UNIQUE(project_id, version),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_requirement_sets_project
        ON pm_requirement_sets(project_id, status, version DESC);

      CREATE TABLE IF NOT EXISTS pm_project_assets (
        project_id TEXT NOT NULL,
        record_uid TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY(project_id, record_uid),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_assets_record
        ON pm_project_assets(record_uid);

      CREATE TABLE IF NOT EXISTS pm_project_participants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        hourly_rate REAL NOT NULL DEFAULT 0,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        duration_days INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, person_id),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(person_id) REFERENCES org_people(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_participants_project
        ON pm_project_participants(project_id, start_date, end_date);

      CREATE TABLE IF NOT EXISTS pm_project_tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'task',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        parent_task_id TEXT,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        owner_person_id TEXT,
        status TEXT NOT NULL DEFAULT 'not_started',
        progress_percent REAL NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_task_id) REFERENCES pm_project_tasks(id) ON DELETE SET NULL,
        FOREIGN KEY(owner_person_id) REFERENCES org_people(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_tasks_project
        ON pm_project_tasks(project_id, start_date, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS pm_requirements (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        set_id TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1,
        requirement_no INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'functional',
        module TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        key_info_terms_json TEXT NOT NULL DEFAULT '[]',
        key_info_terms_source TEXT NOT NULL DEFAULT 'ai',
        source_location TEXT NOT NULL DEFAULT '',
        source_chunk_id TEXT NOT NULL DEFAULT '',
        evidence_quote TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1,
        review_status TEXT NOT NULL DEFAULT 'approved',
        review_note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unmarked',
        status_source TEXT NOT NULL DEFAULT 'ai',
        status_reason TEXT NOT NULL DEFAULT '',
        highest_match_score REAL NOT NULL DEFAULT 0,
        match_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_requirements_project
        ON pm_requirements(project_id, requirement_no);
      CREATE INDEX IF NOT EXISTS idx_pm_requirements_status
        ON pm_requirements(project_id, status);

      CREATE TABLE IF NOT EXISTS pm_requirement_matches (
        requirement_id TEXT NOT NULL,
        record_uid TEXT NOT NULL,
        vector_score REAL NOT NULL DEFAULT 0,
        ai_score REAL,
        final_score REAL NOT NULL DEFAULT 0,
        score_source TEXT NOT NULL DEFAULT 'vector',
        reason TEXT NOT NULL DEFAULT '',
        best_chunk_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(requirement_id, record_uid),
        FOREIGN KEY(requirement_id) REFERENCES pm_requirements(id) ON DELETE CASCADE,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_requirement_matches_rank
        ON pm_requirement_matches(requirement_id, final_score DESC, record_uid);

      CREATE TABLE IF NOT EXISTS pm_project_asset_requirements (
        project_id TEXT NOT NULL,
        record_uid TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY(project_id, record_uid, requirement_id),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE,
        FOREIGN KEY(requirement_id) REFERENCES pm_requirements(id) ON DELETE CASCADE,
        FOREIGN KEY(project_id, record_uid) REFERENCES pm_project_assets(project_id, record_uid) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_asset_requirements_requirement
        ON pm_project_asset_requirements(requirement_id);

      CREATE TABLE IF NOT EXISTS pm_project_task_requirements (
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY(task_id, requirement_id),
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE,
        FOREIGN KEY(task_id) REFERENCES pm_project_tasks(id) ON DELETE CASCADE,
        FOREIGN KEY(requirement_id) REFERENCES pm_requirements(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_project_task_requirements_requirement
        ON pm_project_task_requirements(project_id, requirement_id);

      CREATE TABLE IF NOT EXISTS pm_analysis_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        current_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        output_json TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_analysis_runs_project
        ON pm_analysis_runs(project_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS pm_analysis_logs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        current_count INTEGER NOT NULL DEFAULT 0,
        total_count INTEGER NOT NULL DEFAULT 0,
        message TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        document_id TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL DEFAULT '',
        log_kind TEXT NOT NULL DEFAULT 'stage',
        request_id TEXT NOT NULL DEFAULT '',
        batch_number TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        elapsed_ms INTEGER NOT NULL DEFAULT 0,
        input_chars INTEGER NOT NULL DEFAULT 0,
        output_chars INTEGER NOT NULL DEFAULT 0,
        done_reason TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES pm_projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_pm_analysis_logs_project
        ON pm_analysis_logs(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_pm_analysis_logs_task
        ON pm_analysis_logs(task_id, created_at ASC);
    `)
    // Persist the low-dimensional vector representation used by the coarse
    // candidate pass.  Older databases are upgraded lazily; NULL coarse blobs
    // are backfilled in bounded batches instead of blocking startup.
    for (const statement of [
      'ALTER TABLE knowledge_vectors ADD COLUMN coarse_vector_blob BLOB',
      'ALTER TABLE knowledge_vectors ADD COLUMN coarse_dimension INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE knowledge_vectors ADD COLUMN coarse_bucket INTEGER NOT NULL DEFAULT -1'
    ]) {
      try {
        this.db.exec(statement)
      } catch {
        // Existing databases may already contain the vector shard columns.
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_knowledge_vectors_model_bucket
        ON knowledge_vectors(model_version, coarse_bucket);
    `)
    // v1.5 stores image bytes once under a content-addressed path.  Keep the
    // legacy base64_path column so existing databases can be migrated lazily
    // and old imports remain readable.
    try {
      this.db.exec("ALTER TABLE images ADD COLUMN binary_path TEXT NOT NULL DEFAULT ''")
    } catch {
      // The migration has already run for this database.
    }
    try {
      this.db.exec("ALTER TABLE images ADD COLUMN state TEXT NOT NULL DEFAULT 'ready'")
    } catch {
      // The migration has already run for this database.
    }
    try {
      this.db.exec("ALTER TABLE images ADD COLUMN error_message TEXT NOT NULL DEFAULT ''")
    } catch {
      // The migration has already run for this database.
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asset_blobs (
        sha256 TEXT PRIMARY KEY,
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        byte_size INTEGER NOT NULL DEFAULT 0,
        binary_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS record_image_refs (
        id TEXT PRIMARY KEY,
        record_uid TEXT NOT NULL,
        field_path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        asset_sha256 TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'rich-text',
        source_name TEXT NOT NULL DEFAULT '',
        original_source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(record_uid, field_path, ordinal),
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE,
        FOREIGN KEY(asset_sha256) REFERENCES asset_blobs(sha256) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_record_image_refs_record
        ON record_image_refs(record_uid, field_path, ordinal);
      CREATE INDEX IF NOT EXISTS idx_record_image_refs_hash
        ON record_image_refs(asset_sha256);
      CREATE TABLE IF NOT EXISTS push_asset_uploads (
        cache_key TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        project_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        remote_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(base_url, project_id, sha256)
      );
    `)
    this.migrateLegacyImageFiles()
    try {
      this.db.exec("ALTER TABLE requirement_semantic_cards ADD COLUMN analysis_trace_json TEXT NOT NULL DEFAULT '{}'")
    } catch {
      // Existing databases may already contain the audit trace column.
    }
    const maintenanceTimestamp = nowIso()
    this.db.prepare(`
      INSERT OR IGNORE INTO record_maintenance_states(
        record_uid, updated_at
      )
      SELECT uid, ? FROM records
    `).run(maintenanceTimestamp)
    this.db.prepare(`
      UPDATE record_maintenance_tasks
      SET status = 'stopped', stage = 'idle',
          message = '应用在数据维护任务中断，未处理记录可重新选择重试',
          current_uid = '', current_name = '', updated_at = ?, finished_at = ?
      WHERE status IN ('queued', 'scanning', 'running', 'stopping')
    `).run(maintenanceTimestamp, maintenanceTimestamp)
    this.db.prepare(`
      UPDATE record_maintenance_items
      SET status = 'stopped', stage = 'idle',
          error_message = CASE WHEN status = 'running' THEN '应用在数据维护任务中断' ELSE error_message END,
          updated_at = ?
      WHERE status IN ('pending', 'running')
        AND task_id IN (
          SELECT task_id FROM record_maintenance_tasks WHERE status = 'stopped'
        )
    `).run(maintenanceTimestamp)
    const interruptedAt = nowIso()
    this.db.prepare(`
      UPDATE requirement_semantic_cards
      SET status = 'failed', error_message = '应用在语义化处理中断，请重试',
          analysis_trace_json = CASE
            WHEN json_valid(analysis_trace_json) AND json_extract(analysis_trace_json, '$.version') = 1
              THEN json_set(analysis_trace_json, '$.outcome', 'failed', '$.completedAt', ?)
            ELSE analysis_trace_json
          END,
          completed_at = ?, updated_at = ?
      WHERE status = 'processing'
    `).run(interruptedAt, interruptedAt, interruptedAt)
    this.reconcileInterruptedKnowledgeTasks()
    this.reconcileInterruptedDataImports()
    this.reconcileInterruptedExternalRuns()

    for (const statement of [
      "ALTER TABLE records ADD COLUMN push_status TEXT NOT NULL DEFAULT 'pending'",
      "ALTER TABLE records ADD COLUMN push_message TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE records ADD COLUMN pushed_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE records ADD COLUMN pushed_uid TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE records ADD COLUMN semantic_hash TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_profiles ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'",
      "ALTER TABLE field_definitions ADD COLUMN source_type TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_definitions ADD COLUMN normalized_type TEXT NOT NULL DEFAULT 'unknown'",
      "ALTER TABLE field_definitions ADD COLUMN attr_type TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_definitions ADD COLUMN source_uid TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_definitions ADD COLUMN internal_member TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_definitions ADD COLUMN condition_uid TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE field_definitions ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE field_definitions ADD COLUMN is_editable INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE field_definitions ADD COLUMN is_removable INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE visualization_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'generate'",
      "ALTER TABLE visualization_runs ADD COLUMN tool_calls_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE pm_requirements ADD COLUMN key_info_terms_json TEXT NOT NULL DEFAULT '[]'",
      "ALTER TABLE pm_requirements ADD COLUMN key_info_terms_source TEXT NOT NULL DEFAULT 'ai'",
      "ALTER TABLE pm_requirements ADD COLUMN module TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_requirements ADD COLUMN set_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_requirements ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
      "ALTER TABLE pm_requirements ADD COLUMN category TEXT NOT NULL DEFAULT 'functional'",
      "ALTER TABLE pm_requirements ADD COLUMN evidence_quote TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_requirements ADD COLUMN confidence REAL NOT NULL DEFAULT 1",
      "ALTER TABLE pm_requirements ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved'",
      "ALTER TABLE pm_requirements ADD COLUMN review_note TEXT NOT NULL DEFAULT ''",
      "UPDATE pm_requirements SET status = 'unmarked', status_reason = '待人工标记' WHERE status_source = 'ai' AND status <> 'satisfied'",
      "ALTER TABLE pm_cost_entries ADD COLUMN responsible_participant_id TEXT",
      "ALTER TABLE pm_cost_entries ADD COLUMN responsible_person_name TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_analysis_logs ADD COLUMN log_kind TEXT NOT NULL DEFAULT 'stage'",
      "ALTER TABLE pm_analysis_logs ADD COLUMN request_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_analysis_logs ADD COLUMN batch_number TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_analysis_logs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pm_analysis_logs ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pm_analysis_logs ADD COLUMN input_chars INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pm_analysis_logs ADD COLUMN output_chars INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE pm_analysis_logs ADD COLUMN done_reason TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pm_analysis_logs ADD COLUMN model_name TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE knowledge_index_tasks ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE knowledge_index_tasks ADD COLUMN throughput_per_second REAL NOT NULL DEFAULT 0",
      "ALTER TABLE data_import_runs ADD COLUMN file_size INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE data_import_runs ADD COLUMN file_mtime_ms INTEGER NOT NULL DEFAULT 0"
    ]) {
      try {
        this.db.exec(statement)
      } catch {
        // Existing databases may already contain the migration column.
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_records_push_status ON records(push_status)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pm_cost_entries_responsible ON pm_cost_entries(responsible_participant_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pm_requirements_set ON pm_requirements(set_id, requirement_no)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pm_requirements_review ON pm_requirements(project_id, review_status)')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_pm_analysis_logs_kind ON pm_analysis_logs(project_id, log_kind, created_at DESC)')

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          name,
          item_id,
          node_type,
          normalized_text,
          content='records',
          content_rowid='rowid',
          tokenize='trigram'
        );
      `)
    } catch {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          name,
          item_id,
          node_type,
          normalized_text,
          content='records',
          content_rowid='rowid'
        );
      `)
    }

    this.db.exec('DROP TRIGGER IF EXISTS records_au;')
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
        INSERT INTO records_fts(rowid, name, item_id, node_type, normalized_text)
        VALUES (new.rowid, new.name, new.item_id, new.node_type, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, name, item_id, node_type, normalized_text)
        VALUES ('delete', old.rowid, old.name, old.item_id, old.node_type, old.normalized_text);
      END;
      CREATE TRIGGER records_au AFTER UPDATE OF name, item_id, node_type, normalized_text ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, name, item_id, node_type, normalized_text)
        VALUES ('delete', old.rowid, old.name, old.item_id, old.node_type, old.normalized_text);
        INSERT INTO records_fts(rowid, name, item_id, node_type, normalized_text)
        VALUES (new.rowid, new.name, new.item_id, new.node_type, new.normalized_text);
      END;
    `)
    const recordCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM records').get() as SqlRow).count ?? 0)
    const indexedCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM records_fts').get() as SqlRow).count ?? 0)
    if (recordCount !== indexedCount) {
      this.db.exec("INSERT INTO records_fts(records_fts) VALUES ('rebuild')")
    }
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS requirement_records_fts USING fts5(
          record_uid UNINDEXED,
          business_text,
          tokenize='trigram'
        );
      `)
    } catch {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS requirement_records_fts USING fts5(
          record_uid UNINDEXED,
          business_text
        );
      `)
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS requirement_records_ad AFTER DELETE ON records BEGIN
        DELETE FROM requirement_records_fts WHERE record_uid = old.uid;
      END;
    `)
    // The migration updates the business search index, so run it only after
    // requirement_records_fts exists on a fresh database.
    this.migrateRichTextAssetTokens()

    const businessIndexStats = this.db.prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT record_uid) AS distinct_count
      FROM requirement_records_fts
    `).get() as SqlRow
    const businessIndexCount = Number(businessIndexStats.count ?? 0)
    const businessIndexDistinctCount = Number(businessIndexStats.distinct_count ?? 0)
    const missingSemanticHashCount = Number((this.db.prepare(`
      SELECT COUNT(*) AS count FROM records WHERE semantic_hash = ''
    `).get() as SqlRow).count ?? 0)
    const migrationVersion = this.getSetting(REQUIREMENT_BUSINESS_INDEX_MIGRATION_KEY)
    const completeBusinessIndex = missingSemanticHashCount === 0 &&
      businessIndexCount === recordCount && businessIndexDistinctCount === recordCount

    const runBusinessIndexMigration = (recomputeHashes: boolean): void => {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (recomputeHashes) {
          const semanticHashRows = this.db.prepare(`
            SELECT uid, name, node_type, last_modify_time, raw_json, normalized_text
            FROM records
          `).all() as SqlRow[]
          const updateSemanticHash = this.db.prepare('UPDATE records SET semantic_hash = ? WHERE uid = ?')
          for (const row of semanticHashRows) {
            updateSemanticHash.run(requirementSemanticSourceHash({
              name: String(row.name ?? ''),
              lastModifyTime: String(row.last_modify_time ?? ''),
              rawJson: String(row.raw_json ?? '{}'),
              normalizedText: String(row.normalized_text ?? ''),
              fieldLabels: this.getFieldDisplayNames(String(row.node_type ?? ''))
            }), String(row.uid))
          }
        }
        this.rebuildRequirementSearchIndex()
        this.setSetting(REQUIREMENT_BUSINESS_INDEX_MIGRATION_KEY, REQUIREMENT_BUSINESS_INDEX_VERSION)
        this.db.exec('COMMIT')
      } catch (error) {
        try { this.db.exec('ROLLBACK') } catch {}
        throw error
      }
    }

    if (migrationVersion !== REQUIREMENT_BUSINESS_INDEX_VERSION) {
      // Business extraction semantics changed. Recompute even when the old
      // index was structurally complete so deployment-specific field labels
      // participate in semantic hashes and invalidate stale vectors.
      runBusinessIndexMigration(true)
    } else if (!completeBusinessIndex) {
      runBusinessIndexMigration(false)
    }
  }

  close(): void {
    this.db.close()
  }

  getRecordMaintenanceTargets(
    scope: RecordMaintenanceScope,
    recordUids?: string[]
  ): RecordMaintenanceTarget[] {
    if (scope === 'all') {
      return (this.db.prepare(`
        SELECT uid, name FROM records ORDER BY uid
      `).all() as SqlRow[]).map((row) => ({
        uid: String(row.uid),
        name: String(row.name ?? '')
      }))
    }
    const selected = [...new Set((recordUids ?? [])
      .map((uid) => String(uid).trim())
      .filter(Boolean))]
    if (!selected.length) return []
    const placeholders = selected.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT uid, name FROM records
      WHERE uid IN (${placeholders})
      ORDER BY uid
    `).all(...selected) as SqlRow[]
    const byUid = new Map(rows.map((row) => [String(row.uid), String(row.name ?? '')]))
    return selected.flatMap((uid) => {
      const name = byUid.get(uid)
      return name === undefined ? [] : [{ uid, name }]
    })
  }

  getRecordMaintenancePreview(
    scope: RecordMaintenanceScope,
    recordUids: string[] | undefined,
    modelVersion: string
  ): RecordMaintenancePreview {
    let cleanPendingCount = 0
    let lexicalPendingCount = 0
    let vectorPendingCount = 0
    let semanticInvalidationCount = 0
    let totalCount = 0
    const countRow = (row: SqlRow): void => {
      const state = this.mapRecordMaintenanceStateRow(row, modelVersion)
      totalCount += 1
      if (state.clean.status !== 'ready') cleanPendingCount += 1
      if (state.lexical.status !== 'ready') lexicalPendingCount += 1
      if (state.vector.status !== 'ready') vectorPendingCount += 1
      if (String(row.semantic_record_uid ?? '') &&
        String(row.semantic_status ?? '') === 'ready' &&
        String(row.semantic_content_hash ?? '') !== String(row.record_semantic_hash ?? '')) {
        semanticInvalidationCount += 1
      }
    }
    if (scope === 'all') {
      let cursor = ''
      while (true) {
        const rows = this.listRecordMaintenanceStateRows(undefined, modelVersion, cursor)
        if (!rows.length) break
        rows.forEach(countRow)
        const lastUid = String(rows[rows.length - 1]?.record_uid_for_maintenance ?? '')
        if (rows.length < KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE || !lastUid) break
        cursor = lastUid
      }
    } else {
      const selected = [...new Set((recordUids ?? [])
        .map((uid) => String(uid).trim())
        .filter(Boolean))]
      for (let index = 0; index < selected.length; index += RECORD_MAINTENANCE_UID_BATCH_SIZE) {
        const batch = selected.slice(index, index + RECORD_MAINTENANCE_UID_BATCH_SIZE)
        this.listRecordMaintenanceStateRows(batch, modelVersion).forEach(countRow)
      }
    }
    return {
      scope,
      totalCount,
      cleanPendingCount,
      lexicalPendingCount,
      vectorPendingCount,
      semanticInvalidationCount,
      modelVersion,
      normalizerVersion: RECORD_NORMALIZER_VERSION,
      lexicalVersion: RECORD_LEXICAL_INDEX_VERSION,
      scannedAt: nowIso()
    }
  }

  getRecordMaintenanceStates(
    recordUids: readonly string[],
    modelVersion = ''
  ): Map<string, RecordMaintenanceState> {
    const selected = [...new Set(recordUids.map((uid) => String(uid).trim()).filter(Boolean))]
    const states = new Map<string, RecordMaintenanceState>()
    for (let index = 0; index < selected.length; index += RECORD_MAINTENANCE_UID_BATCH_SIZE) {
      const rows = this.listRecordMaintenanceStateRows(
        selected.slice(index, index + RECORD_MAINTENANCE_UID_BATCH_SIZE),
        modelVersion
      )
      for (const row of rows) {
        const uid = String(row.record_uid_for_maintenance ?? '')
        if (uid) states.set(uid, this.mapRecordMaintenanceStateRow(row, modelVersion))
      }
    }
    return states
  }

  getRecordMaintenanceState(uid: string, modelVersion = ''): RecordMaintenanceState {
    const recordUid = uid.trim()
    const rows = this.listRecordMaintenanceStateRows([recordUid], modelVersion)
    if (rows.length) return this.mapRecordMaintenanceStateRow(rows[0], modelVersion)
    const stateRow = this.db.prepare(`
      SELECT * FROM record_maintenance_states WHERE record_uid = ?
    `).get(recordUid) as SqlRow | undefined
    return this.mapRecordMaintenanceStateRow({
      ...(stateRow ?? {}),
      record_uid_for_maintenance: '',
      record_name_for_maintenance: '',
      record_node_type_for_maintenance: '',
      record_raw_json_for_maintenance: '',
      record_semantic_hash: ''
    }, modelVersion)
  }

  private listRecordMaintenanceStateRows(
    recordUids: readonly string[] | undefined,
    _modelVersion: string,
    cursor = '',
    limit = KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE
  ): SqlRow[] {
    const selected = recordUids
      ? [...new Set(recordUids.map((uid) => String(uid).trim()).filter(Boolean))]
      : []
    if (recordUids && !selected.length) return []
    const safeLimit = Math.min(
      RECORD_MAINTENANCE_UID_BATCH_SIZE,
      Math.max(1, Math.trunc(limit || KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE))
    )
    const targetWhere = recordUids
      ? `WHERE r.uid IN (${selected.map(() => '?').join(', ')})`
      : 'WHERE r.uid > ?'
    const params = recordUids ? [...selected, safeLimit] : [cursor, safeLimit]
    return this.db.prepare(`
      WITH target_records AS (
        SELECT r.uid, r.name, r.node_type, r.raw_json, r.semantic_hash
        FROM records r
        ${targetWhere}
        ORDER BY r.uid
        LIMIT ?
      ),
      vector_stats AS (
        SELECT c.record_uid,
               COUNT(*) AS actual_vector_chunk_count,
               COUNT(DISTINCT v.model_version) AS actual_vector_model_count,
               MAX(v.model_version) AS actual_vector_model_version,
               COUNT(DISTINCT c.source_hash) AS actual_vector_source_hash_count,
               MAX(c.source_hash) AS actual_vector_source_hash
        FROM knowledge_chunks c
        JOIN knowledge_vectors v ON v.chunk_id = c.id
        JOIN target_records t ON t.uid = c.record_uid
        WHERE c.source_type = 'record'
        GROUP BY c.record_uid
      )
      SELECT t.uid AS record_uid_for_maintenance,
             t.name AS record_name_for_maintenance,
             t.node_type AS record_node_type_for_maintenance,
             t.raw_json AS record_raw_json_for_maintenance,
             t.semantic_hash AS record_semantic_hash,
             s.*,
             v.actual_vector_chunk_count,
             v.actual_vector_model_count,
             v.actual_vector_model_version,
             v.actual_vector_source_hash_count,
             v.actual_vector_source_hash,
             semantic.record_uid AS semantic_record_uid,
             semantic.content_hash AS semantic_content_hash,
             semantic.status AS semantic_status
      FROM target_records t
      LEFT JOIN record_maintenance_states s ON s.record_uid = t.uid
      LEFT JOIN vector_stats v ON v.record_uid = t.uid
      LEFT JOIN requirement_semantic_cards semantic ON semantic.record_uid = t.uid
      ORDER BY t.uid
    `).all(...params) as SqlRow[]
  }

  private mapRecordMaintenanceStateRow(row: SqlRow, modelVersion: string): RecordMaintenanceState {
    const stateRow = row.record_uid ? row : {
      clean_status: 'pending',
      clean_version: '',
      clean_updated_at: '',
      clean_error: '',
      lexical_status: 'pending',
      lexical_version: '',
      lexical_updated_at: '',
      lexical_error: '',
      vector_status: 'pending',
      vector_version: '',
      vector_model_version: '',
      vector_chunk_count: 0,
      vector_updated_at: '',
      vector_error: '',
      last_task_id: '',
      last_operation: ''
    } as SqlRow
    const hasRecord = Boolean(String(row.record_uid_for_maintenance ?? ''))
    const currentBusinessText = hasRecord
      ? this.requirementBusinessTextFromRow({
          name: row.record_name_for_maintenance,
          node_type: row.record_node_type_for_maintenance,
          raw_json: row.record_raw_json_for_maintenance
        })
      : ''
    const currentVectorSourceHash = hasRecord
      ? createHash('sha256')
        .update(
          `${String(row.record_semantic_hash ?? '')}\n` +
          `${this.getFieldDefinitionFingerprint(String(row.record_node_type_for_maintenance ?? ''))}\n` +
          currentBusinessText
        )
        .digest('hex')
      : ''
    const vectorChunkCount = Number(row.actual_vector_chunk_count ?? 0)
    const actualVectorModel = String(row.actual_vector_model_version ?? '')
    const vectorModelCount = Number(row.actual_vector_model_count ?? 0)
    const vectorSourceHashCount = Number(row.actual_vector_source_hash_count ?? 0)
    const actualVectorSourceHash = String(row.actual_vector_source_hash ?? '')
    const effectiveModelVersion = actualVectorModel || String(stateRow.vector_model_version ?? '') || modelVersion.trim()
    const cleanStatus = this.maintenanceVersionedStatus(
      stateRow.clean_status,
      String(stateRow.clean_version ?? ''),
      RECORD_NORMALIZER_VERSION
    )
    const lexicalStatus = this.maintenanceVersionedStatus(
      stateRow.lexical_status,
      String(stateRow.lexical_version ?? ''),
      RECORD_LEXICAL_INDEX_VERSION
    )
    let vectorStatus = this.maintenanceVersionedStatus(
      stateRow.vector_status,
      String(stateRow.vector_version ?? ''),
      RECORD_VECTOR_INDEX_VERSION
    )
    if (vectorStatus !== 'failed' && vectorStatus !== 'running') {
      if (!vectorChunkCount || vectorModelCount !== 1 || vectorSourceHashCount !== 1 ||
        !currentVectorSourceHash || actualVectorSourceHash !== currentVectorSourceHash) {
        vectorStatus = 'pending'
      } else if (modelVersion.trim() && actualVectorModel !== modelVersion.trim()) {
        vectorStatus = 'stale'
      } else if (vectorStatus !== 'pending' && vectorStatus !== 'stale') {
        vectorStatus = 'ready'
      }
    }
    const statuses = [cleanStatus, lexicalStatus, vectorStatus]
    const overallStatus: RecordMaintenanceIndexStatus = statuses.includes('failed')
      ? 'failed'
      : statuses.includes('running')
        ? 'running'
        : statuses.includes('stale')
          ? 'stale'
          : statuses.includes('pending')
            ? 'pending'
            : 'ready'
    const operation = String(stateRow.last_operation ?? '')
    const lastOperation = operation === 'clean' || operation === 'rebuild_indexes' || operation === 'optimize'
      ? operation as RecordMaintenanceOperation
      : undefined
    return {
      overallStatus,
      clean: {
        status: cleanStatus,
        version: RECORD_NORMALIZER_VERSION,
        updatedAt: String(stateRow.clean_updated_at ?? ''),
        ...(String(stateRow.clean_error ?? '') ? { error: String(stateRow.clean_error) } : {})
      },
      lexical: {
        status: lexicalStatus,
        version: RECORD_LEXICAL_INDEX_VERSION,
        updatedAt: String(stateRow.lexical_updated_at ?? ''),
        ...(String(stateRow.lexical_error ?? '') ? { error: String(stateRow.lexical_error) } : {})
      },
      vector: {
        status: vectorStatus,
        version: RECORD_VECTOR_INDEX_VERSION,
        modelVersion: effectiveModelVersion,
        chunkCount: vectorChunkCount || Number(stateRow.vector_chunk_count ?? 0),
        updatedAt: String(stateRow.vector_updated_at ?? ''),
        ...(String(stateRow.vector_error ?? '') ? { error: String(stateRow.vector_error) } : {})
      },
      ...(String(stateRow.last_task_id ?? '') ? { lastTaskId: String(stateRow.last_task_id) } : {}),
      ...(lastOperation ? { lastOperation } : {})
    }
  }

  invalidateRequirementMatchCacheForRecords(recordUids: string[]): number {
    const selected = [...new Set(recordUids.map((uid) => uid.trim()).filter(Boolean))]
    if (!selected.length) return 0
    const placeholders = selected.map(() => '?').join(', ')
    const result = this.db.prepare(`
      DELETE FROM requirement_match_cache
      WHERE base_record_uid IN (${placeholders})
         OR candidate_record_uid IN (${placeholders})
    `).run(...selected, ...selected)
    return Number(result.changes)
  }

  private maintenanceVersionedStatus(
    rawStatus: unknown,
    version: string,
    expectedVersion: string
  ): RecordMaintenanceIndexStatus {
    const status = String(rawStatus ?? '') as RecordMaintenanceIndexStatus
    if (status === 'failed') return 'failed'
    if (status === 'running') return 'running'
    if (status === 'ready' && version === expectedVersion) return 'ready'
    return version && version !== expectedVersion ? 'stale' : 'pending'
  }

  createRecordMaintenanceTask(
    snapshot: RecordMaintenanceTaskSnapshot,
    targets: RecordMaintenanceTarget[]
  ): void {
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO record_maintenance_tasks(
          task_id, scope, record_uids_json, operation, status, stage, message,
          current_count, total_count, succeeded_count, failed_count,
          current_uid, current_name, failed_items_json, started_at, updated_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.taskId,
        snapshot.scope,
        JSON.stringify(targets.map((target) => target.uid)),
        snapshot.operation,
        snapshot.status,
        snapshot.stage,
        snapshot.message,
        snapshot.current,
        snapshot.total,
        snapshot.succeeded,
        snapshot.failed,
        snapshot.currentUid ?? '',
        snapshot.currentName ?? '',
        JSON.stringify(snapshot.failedItems),
        snapshot.startedAt,
        timestamp,
        snapshot.finishedAt ?? ''
      )
      const insertItem = this.db.prepare(`
        INSERT INTO record_maintenance_items(
          task_id, record_uid, record_name, status, stage, error_message, updated_at
        ) VALUES (?, ?, ?, 'pending', 'scanning', '', ?)
      `)
      for (const target of targets) insertItem.run(snapshot.taskId, target.uid, target.name, timestamp)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  getRecordMaintenanceTask(activeOnly = false): RecordMaintenanceTaskSnapshot | null {
    const activeClause = activeOnly
      ? "WHERE status IN ('queued', 'scanning', 'running', 'stopping')"
      : ''
    const row = this.db.prepare(`
      SELECT * FROM record_maintenance_tasks
      ${activeClause}
      ORDER BY updated_at DESC, task_id DESC
      LIMIT 1
    `).get() as SqlRow | undefined
    return row ? this.mapRecordMaintenanceTask(row) : null
  }

  saveRecordMaintenanceTask(snapshot: RecordMaintenanceTaskSnapshot): void {
    this.db.prepare(`
      UPDATE record_maintenance_tasks
      SET status = ?, stage = ?, message = ?, current_count = ?, total_count = ?,
          succeeded_count = ?, failed_count = ?, current_uid = ?, current_name = ?,
          failed_items_json = ?, updated_at = ?, finished_at = ?
      WHERE task_id = ?
    `).run(
      snapshot.status,
      snapshot.stage,
      snapshot.message,
      snapshot.current,
      snapshot.total,
      snapshot.succeeded,
      snapshot.failed,
      snapshot.currentUid ?? '',
      snapshot.currentName ?? '',
      JSON.stringify(snapshot.failedItems),
      snapshot.updatedAt,
      snapshot.finishedAt ?? '',
      snapshot.taskId
    )
  }

  saveRecordMaintenanceItem(
    taskId: string,
    item: RecordMaintenanceTaskItem
  ): void {
    this.db.prepare(`
      UPDATE record_maintenance_items
      SET status = ?, stage = ?, error_message = ?, updated_at = ?
      WHERE task_id = ? AND record_uid = ?
    `).run(
      item.status,
      item.stage,
      item.error ?? '',
      nowIso(),
      taskId,
      item.uid
    )
  }

  getRecordMaintenanceItems(taskId: string): RecordMaintenanceTaskItem[] {
    const rows = this.db.prepare(`
      SELECT record_uid, record_name, status, stage, error_message
      FROM record_maintenance_items
      WHERE task_id = ? ORDER BY rowid
    `).all(taskId) as SqlRow[]
    return rows.map((row) => ({
      uid: String(row.record_uid),
      name: String(row.record_name ?? ''),
      status: ['pending', 'running', 'succeeded', 'failed', 'stopped'].includes(String(row.status))
        ? String(row.status) as RecordMaintenanceTaskItem['status']
        : 'pending',
      stage: this.recordMaintenanceStage(row.stage),
      ...(String(row.error_message ?? '') ? { error: String(row.error_message) } : {})
    }))
  }

  private mapRecordMaintenanceTask(row: SqlRow): RecordMaintenanceTaskSnapshot {
    const failedFromItems = this.getRecordMaintenanceItems(String(row.task_id))
      .filter((item) => item.status === 'failed')
      .map((item): RecordMaintenanceFailedItem => ({
        uid: item.uid,
        name: item.name,
        stage: item.stage,
        error: item.error ?? ''
      }))
    const parsedFailed = parseJsonValue(row.failed_items_json, [])
    const persistedFailedItems: unknown[] = Array.isArray(parsedFailed) ? parsedFailed : []
    const failedItems = failedFromItems.length
      ? failedFromItems
      : persistedFailedItems.flatMap((item: unknown): RecordMaintenanceFailedItem[] => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return []
          const value = item as Record<string, unknown>
          const uid = String(value.uid ?? '').trim()
          const name = String(value.name ?? '')
          const error = String(value.error ?? '')
          if (!uid || !error) return []
          return [{ uid, name, stage: this.recordMaintenanceStage(value.stage), error }]
        })
    const status = String(row.status) as RecordMaintenanceTaskStatus
    return {
      taskId: String(row.task_id),
      scope: String(row.scope) === 'selected' ? 'selected' : 'all',
      operation: ['clean', 'rebuild_indexes', 'optimize'].includes(String(row.operation))
        ? String(row.operation) as RecordMaintenanceOperation
        : 'clean',
      status: ['queued', 'scanning', 'running', 'stopping', 'stopped', 'completed', 'completed_with_errors', 'failed'].includes(status)
        ? status
        : 'failed',
      stage: this.recordMaintenanceStage(row.stage),
      message: String(row.message ?? ''),
      current: Number(row.current_count ?? 0),
      total: Number(row.total_count ?? 0),
      succeeded: Number(row.succeeded_count ?? 0),
      failed: Number(row.failed_count ?? failedItems.length),
      ...(String(row.current_uid ?? '') ? { currentUid: String(row.current_uid) } : {}),
      ...(String(row.current_name ?? '') ? { currentName: String(row.current_name) } : {}),
      failedItems,
      startedAt: String(row.started_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      ...(String(row.finished_at ?? '') ? { finishedAt: String(row.finished_at) } : {})
    }
  }

  private recordMaintenanceStage(value: unknown): RecordMaintenanceStage {
    return ['scanning', 'cleaning', 'lexical', 'vector', 'finalizing', 'idle'].includes(String(value))
      ? String(value) as RecordMaintenanceStage
      : 'idle'
  }

  private ensureRecordMaintenanceState(recordUid: string): void {
    this.getMaintenanceWriteStatements().ensure.run(recordUid, nowIso())
  }

  markRecordMaintenanceDataWritten(recordUid: string): void {
    this.ensureRecordMaintenanceState(recordUid)
    const timestamp = nowIso()
    this.getMaintenanceWriteStatements().update.run(
      RECORD_NORMALIZER_VERSION,
      timestamp,
      RECORD_LEXICAL_INDEX_VERSION,
      timestamp,
      timestamp,
      recordUid
    )
  }

  markRecordMaintenanceVectorReady(
    recordUid: string,
    modelVersion: string,
    chunkCount: number,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): void {
    this.ensureRecordMaintenanceState(recordUid)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE record_maintenance_states
      SET vector_status = 'ready', vector_version = ?, vector_model_version = ?,
          vector_chunk_count = ?, vector_updated_at = ?, vector_error = '',
          last_task_id = CASE WHEN ? <> '' THEN ? ELSE last_task_id END,
          last_operation = CASE WHEN ? <> '' THEN ? ELSE last_operation END,
          updated_at = ?
      WHERE record_uid = ?
    `).run(
      RECORD_VECTOR_INDEX_VERSION,
      modelVersion,
      Math.max(0, Math.trunc(chunkCount)),
      timestamp,
      taskId,
      taskId,
      operation,
      operation,
      timestamp,
      recordUid
    )
  }

  markRecordMaintenanceVectorFailed(
    recordUid: string,
    error: string,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): void {
    this.ensureRecordMaintenanceState(recordUid)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE record_maintenance_states
      SET vector_status = 'failed', vector_error = ?, vector_updated_at = ?,
          last_task_id = CASE WHEN ? <> '' THEN ? ELSE last_task_id END,
          last_operation = CASE WHEN ? <> '' THEN ? ELSE last_operation END,
          updated_at = ?
      WHERE record_uid = ?
    `).run(
      error.slice(0, 2000),
      timestamp,
      taskId,
      taskId,
      operation,
      operation,
      timestamp,
      recordUid
    )
  }

  markRecordMaintenanceStageFailed(
    recordUid: string,
    stage: RecordMaintenanceStage,
    error: string,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): void {
    if (stage === 'vector') {
      this.markRecordMaintenanceVectorFailed(recordUid, error, taskId, operation)
      return
    }
    const statusColumns = stage === 'cleaning'
      ? { status: 'clean_status', updatedAt: 'clean_updated_at', error: 'clean_error' }
      : stage === 'lexical'
        ? { status: 'lexical_status', updatedAt: 'lexical_updated_at', error: 'lexical_error' }
        : undefined
    if (!statusColumns) return
    this.ensureRecordMaintenanceState(recordUid)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE record_maintenance_states
      SET ${statusColumns.status} = 'failed', ${statusColumns.updatedAt} = ?, ${statusColumns.error} = ?,
          last_task_id = CASE WHEN ? <> '' THEN ? ELSE last_task_id END,
          last_operation = CASE WHEN ? <> '' THEN ? ELSE last_operation END,
          updated_at = ?
      WHERE record_uid = ?
    `).run(
      timestamp,
      error.slice(0, 2000),
      taskId,
      taskId,
      operation,
      operation,
      timestamp,
      recordUid
    )
  }

  cleanRecordNormalizedText(
    recordUid: string,
    normalizedText: string,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = 'clean'
  ): boolean {
    const row = this.db.prepare(`
      SELECT name, node_type, last_modify_time, raw_json FROM records WHERE uid = ?
    `).get(recordUid) as SqlRow | undefined
    if (!row) return false
    const semanticHash = requirementSemanticSourceHash({
      name: String(row.name ?? ''),
      lastModifyTime: String(row.last_modify_time ?? ''),
      rawJson: String(row.raw_json ?? '{}'),
      normalizedText,
      fieldLabels: this.getFieldDisplayNames(String(row.node_type ?? ''))
    })
    this.db.prepare(`
      UPDATE records SET normalized_text = ?, semantic_hash = ? WHERE uid = ?
    `).run(normalizedText, semanticHash, recordUid)
    this.syncRequirementSearchIndex(recordUid)
    this.ensureRecordMaintenanceState(recordUid)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE record_maintenance_states
      SET clean_status = 'ready', clean_version = ?, clean_updated_at = ?, clean_error = '',
          lexical_status = 'ready', lexical_version = ?, lexical_updated_at = ?, lexical_error = '',
          last_task_id = CASE WHEN ? <> '' THEN ? ELSE last_task_id END,
          last_operation = CASE WHEN ? <> '' THEN ? ELSE last_operation END,
          updated_at = ?
      WHERE record_uid = ?
    `).run(
      RECORD_NORMALIZER_VERSION,
      timestamp,
      RECORD_LEXICAL_INDEX_VERSION,
      timestamp,
      taskId,
      taskId,
      operation,
      operation,
      timestamp,
      recordUid
    )
    return true
  }

  rebuildRequirementRecordLexicalIndex(
    recordUid: string,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = 'rebuild_indexes'
  ): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        SELECT uid, name, node_type, raw_json FROM records WHERE uid = ?
      `).get(recordUid) as SqlRow | undefined
      if (!row) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.prepare('DELETE FROM requirement_records_fts WHERE record_uid = ?').run(recordUid)
      const businessText = this.requirementBusinessTextFromRow(row)
      if (businessText) {
        this.db.prepare(`
          INSERT INTO requirement_records_fts(record_uid, business_text) VALUES (?, ?)
        `).run(recordUid, businessText)
      }
      this.ensureRecordMaintenanceState(recordUid)
      const timestamp = nowIso()
      this.db.prepare(`
        UPDATE record_maintenance_states
        SET lexical_status = 'ready', lexical_version = ?, lexical_updated_at = ?, lexical_error = '',
            last_task_id = CASE WHEN ? <> '' THEN ? ELSE last_task_id END,
            last_operation = CASE WHEN ? <> '' THEN ? ELSE last_operation END,
            updated_at = ?
        WHERE record_uid = ?
      `).run(
        RECORD_LEXICAL_INDEX_VERSION,
        timestamp,
        taskId,
        taskId,
        operation,
        operation,
        timestamp,
        recordUid
      )
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  optimizeRecordMaintenance(): void {
    this.db.exec('PRAGMA optimize')
  }

  private parseChatMessages(value: unknown): ChatMessage[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(value ?? '[]'))
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is ChatMessage => {
      if (!item || typeof item !== 'object') return false
      const message = item as Partial<ChatMessage>
      return (
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        typeof message.id === 'string' &&
        typeof message.createdAt === 'string'
      )
    }).map((message) => ({
      ...message,
      content: sanitizeChatMessageContent(message.content, 8_000),
      ...(message.contextRefs?.length
        ? { contextRefs: compactChatContextRefs(message.contextRefs) }
        : {}),
      ...(message.dataViews?.length
        ? { dataViews: compactChatDataViews(message.dataViews) }
        : {})
    }))
  }

  private mapChatSessionSummary(row: SqlRow): ChatSessionSummary {
    return {
      id: String(row.id),
      title: String(row.title || '新会话'),
      preview: String(row.preview || ''),
      messageCount: Number(row.message_count || 0),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  listChatSessions(limit = 50): ChatSessionSummary[] {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)))
    return (this.db.prepare(`
      SELECT id, title, preview, message_count, created_at, updated_at
      FROM chat_sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(safeLimit) as SqlRow[]).map((row) => this.mapChatSessionSummary(row))
  }

  getChatSession(id: string): ChatSession | null {
    const row = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) return null
    return {
      ...this.mapChatSessionSummary(row),
      messages: this.parseChatMessages(row.messages_json)
    }
  }

  saveChatSession(input: ChatSessionSaveInput): ChatSession {
    const id = input.id.trim()
    if (!id) throw new Error('会话标识不能为空')
    const messages = this.parseChatMessages(JSON.stringify(input.messages))
    if (!messages.length) throw new Error('至少需要一条消息才能保存会话')
    const firstUserMessage = messages.find((message) => message.role === 'user')
    const lastMessage = messages.at(-1)
    const title = (input.title?.trim() || firstUserMessage?.content.trim() || '新会话')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
    const preview = (lastMessage?.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
    const timestamp = nowIso()
    const existing = this.db
      .prepare('SELECT created_at FROM chat_sessions WHERE id = ?')
      .get(id) as SqlRow | undefined
    this.db.prepare(`
      INSERT INTO chat_sessions(
        id, title, preview, messages_json, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        preview = excluded.preview,
        messages_json = excluded.messages_json,
        message_count = excluded.message_count,
        updated_at = excluded.updated_at
    `).run(
      id,
      title,
      preview,
      JSON.stringify(messages),
      messages.length,
      existing ? String(existing.created_at) : timestamp,
      timestamp
    )
    return this.getChatSession(id)!
  }

  deleteChatSession(id: string): ChatSessionDeleteResult {
    const normalizedId = id.trim()
    if (!normalizedId) return { ok: false, message: '会话标识不能为空' }
    const result = this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(normalizedId)
    return Number(result.changes) > 0
      ? { ok: true, message: '历史会话已删除' }
      : { ok: false, message: '历史会话不存在' }
  }

  private mapAssistantArtifact(row: SqlRow): AssistantArtifact {
    const payload = JSON.parse(String(row.payload_json)) as AssistantArtifactInput
    return {
      id: String(row.id),
      type: String(row.type) as AssistantArtifact['type'],
      status: String(row.status) === 'reverted' ? 'reverted' : 'active',
      version: Number(row.version),
      conversationId: String(row.conversation_id),
      messageId: String(row.message_id),
      title: String(row.title),
      payload,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }
  }

  saveAssistantArtifact(input: AssistantArtifactInput): AssistantArtifact {
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO assistant_artifacts(
        id, type, status, version, conversation_id, message_id,
        title, payload_json, created_at, updated_at
      ) VALUES (?, ?, 'active', 1, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.conversationId,
      input.messageId,
      input.title,
      JSON.stringify(input),
      timestamp,
      timestamp
    )
    return this.getAssistantArtifact(id)!
  }

  getAssistantArtifact(id: string): AssistantArtifact | null {
    const row = this.db.prepare('SELECT * FROM assistant_artifacts WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapAssistantArtifact(row) : null
  }

  listAssistantArtifacts(limit = 50): AssistantArtifact[] {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)))
    return (this.db.prepare(`
      SELECT * FROM assistant_artifacts ORDER BY updated_at DESC LIMIT ?
    `).all(safeLimit) as SqlRow[]).map((row) => this.mapAssistantArtifact(row))
  }

  revertAssistantArtifact(id: string): AssistantArtifact {
    const current = this.getAssistantArtifact(id)
    if (!current) throw new Error('交付物不存在')
    if (current.status === 'reverted') return current
    this.db.prepare(`
      UPDATE assistant_artifacts
      SET status = 'reverted', version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), id)
    return this.getAssistantArtifact(id)!
  }

  saveAssistantRunHistory(history: AssistantRunHistory): AssistantRunHistory {
    this.db.prepare(`
      INSERT INTO assistant_run_history(run_id, status, started_at, completed_at, payload_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        completed_at = excluded.completed_at,
        payload_json = excluded.payload_json
    `).run(
      history.runId,
      history.status,
      history.startedAt,
      history.completedAt,
      JSON.stringify(history)
    )
    return history
  }

  listAssistantRunHistory(limit = 100): AssistantRunHistory[] {
    const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit)))
    return (this.db.prepare(`
      SELECT payload_json FROM assistant_run_history
      ORDER BY completed_at DESC LIMIT ?
    `).all(safeLimit) as SqlRow[]).flatMap((row) => {
      try {
        const normalized = normalizeAssistantRunHistoryPayload(JSON.parse(String(row.payload_json)))
        return normalized ? [normalized] : []
      } catch {
        return []
      }
    })
  }

  getAssistantRunHistoryStats(): AssistantRunHistoryStats {
    const runs = this.listAssistantRunHistory(500)
    const totalDuration = runs.reduce((sum, run) => sum + run.durationMs, 0)
    return {
      total: runs.length,
      completed: runs.filter((run) => run.status === 'completed').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      cancelled: runs.filter((run) => run.status === 'cancelled').length,
      clarification: runs.filter((run) => run.status === 'clarification').length,
      averageDurationMs: runs.length ? Math.round(totalDuration / runs.length) : 0,
      totalToolCalls: runs.reduce((sum, run) => sum + run.toolCallCount, 0),
      totalMatchedCount: runs.reduce((sum, run) => sum + run.matchedCount, 0)
    }
  }

  private mapKnowledgeDocument(row: SqlRow): KnowledgeDocument {
    let tags: string[] = []
    try {
      const parsed = JSON.parse(String(row.tags_json ?? '[]')) as unknown
      if (Array.isArray(parsed)) tags = parsed.map(String).filter(Boolean)
    } catch {
      tags = []
    }
    return {
      id: String(row.id),
      fileName: String(row.file_name),
      filePath: String(row.file_path),
      extension: String(row.extension),
      mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size),
      sha256: String(row.sha256),
      tags,
      status: String(row.status) as KnowledgeDocumentStatus,
      errorMessage: String(row.error_message ?? ''),
      chunkCount: Number(row.chunk_count ?? 0),
      pageCount: Number(row.page_count ?? 0),
      modelVersion: String(row.model_version ?? ''),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      processedAt: String(row.processed_at ?? '')
    }
  }

  private mapKnowledgeChunk(row: SqlRow): KnowledgeChunk {
    const pageNumber = row.page_number === null || row.page_number === undefined
      ? undefined
      : Number(row.page_number)
    const sheetName = String(row.sheet_name ?? '')
    return {
      id: String(row.id),
      ...(row.document_id ? { documentId: String(row.document_id) } : {}),
      ...(row.record_uid ? { recordUid: String(row.record_uid) } : {}),
      sourceType: String(row.source_type) as KnowledgeChunk['sourceType'],
      sourceName: String(row.source_name ?? ''),
      content: String(row.content ?? ''),
      chunkIndex: Number(row.chunk_index ?? 0),
      ...(pageNumber === undefined ? {} : { pageNumber }),
      ...(sheetName ? { sheetName } : {}),
      location: String(row.location ?? ''),
      charStart: Number(row.char_start ?? 0),
      charEnd: Number(row.char_end ?? 0)
    }
  }

  findKnowledgeDocumentByHash(sha256: string): KnowledgeDocument | null {
    const row = this.db
      .prepare('SELECT * FROM knowledge_documents WHERE sha256 = ?')
      .get(sha256) as SqlRow | undefined
    return row ? this.mapKnowledgeDocument(row) : null
  }

  storeKnowledgeDocumentFile(bytes: Buffer, sha256: string, extension: string): string {
    const documentDir = join(this.assetDir, 'documents')
    mkdirSync(documentDir, { recursive: true })
    const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extension) ? extension.toLowerCase() : '.bin'
    const target = join(documentDir, `${sha256}${safeExtension}`)
    writeFileSync(target, bytes)
    return target
  }

  updateKnowledgeDocumentFilePath(id: string, filePath: string): void {
    this.db.prepare('UPDATE knowledge_documents SET file_path = ?, updated_at = ? WHERE id = ?')
      .run(filePath, nowIso(), id)
  }

  insertKnowledgeDocument(input: KnowledgeDocumentInput): KnowledgeDocument {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO knowledge_documents(
        id, file_name, file_path, extension, mime_type, byte_size, sha256,
        tags_json, status, model_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.fileName,
      input.filePath,
      input.extension,
      input.mimeType,
      input.byteSize,
      input.sha256,
      JSON.stringify(input.tags ?? []),
      input.status ?? 'queued',
      input.modelVersion ?? '',
      timestamp,
      timestamp
    )
    return this.getKnowledgeDocument(input.id) as KnowledgeDocument
  }

  updateKnowledgeDocument(
    id: string,
    patch: Partial<Pick<KnowledgeDocument, 'status' | 'errorMessage' | 'chunkCount' | 'pageCount' | 'modelVersion' | 'processedAt' | 'tags'>>
  ): KnowledgeDocument | null {
    const fields: string[] = []
    const values: Array<string | number | null> = []
    const add = (column: string, value: string | number | null): void => {
      fields.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.errorMessage !== undefined) add('error_message', patch.errorMessage)
    if (patch.chunkCount !== undefined) add('chunk_count', patch.chunkCount)
    if (patch.pageCount !== undefined) add('page_count', patch.pageCount)
    if (patch.modelVersion !== undefined) add('model_version', patch.modelVersion)
    if (patch.processedAt !== undefined) add('processed_at', patch.processedAt)
    if (patch.tags !== undefined) add('tags_json', JSON.stringify(patch.tags))
    if (fields.length) {
      fields.push('updated_at = ?')
      values.push(nowIso())
      values.push(id)
      this.db.prepare(`UPDATE knowledge_documents SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getKnowledgeDocument(id)
  }

  listKnowledgeDocuments(query: KnowledgeDocumentQuery): KnowledgeDocumentPage {
    const clauses: string[] = []
    const params: Array<string | number | null> = []
    const search = query.search?.trim()
    if (search) {
      clauses.push('(file_name LIKE ? OR extension LIKE ? OR error_message LIKE ?)')
      const pattern = `%${search}%`
      params.push(pattern, pattern, pattern)
    }
    if (query.status) {
      clauses.push('status = ?')
      params.push(query.status)
    }
    if (query.extension) {
      clauses.push('extension = ?')
      params.push(query.extension.toLowerCase())
    }
    if (query.tag?.trim()) {
      clauses.push('tags_json LIKE ?')
      params.push(`%${JSON.stringify(query.tag.trim()).slice(1, -1)}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM knowledge_documents ${where}`).get(...params) as SqlRow).count)
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)))
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_documents
      ${where}
      ORDER BY updated_at DESC, file_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return { rows: rows.map((row) => this.mapKnowledgeDocument(row)), total }
  }

  /**
   * Return documents that can be safely resumed after an interrupted startup.
   * The migration changes `processing` to `queued`; the extra status predicate
   * keeps this method safe for databases opened before that cleanup ran.
   */
  listKnowledgeDocumentsForResume(limit = 1000): KnowledgeDocument[] {
    const safeLimit = Math.min(2000, Math.max(1, Math.trunc(limit || 1000)))
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_documents
      WHERE status IN ('queued', 'processing')
      ORDER BY updated_at ASC, created_at ASC
      LIMIT ?
    `).all(safeLimit) as SqlRow[]
    return rows.map((row) => this.mapKnowledgeDocument(row))
  }

  getKnowledgeDocument(id: string): KnowledgeDocumentDetail | null {
    const row = this.db.prepare('SELECT * FROM knowledge_documents WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) return null
    const chunks = this.db.prepare(`
      SELECT * FROM knowledge_chunks
      WHERE document_id = ?
      ORDER BY chunk_index ASC
    `).all(id) as SqlRow[]
    return { ...this.mapKnowledgeDocument(row), chunks: chunks.map((item) => this.mapKnowledgeChunk(item)) }
  }

  deleteKnowledgeDocument(id: string): { filePath: string; deleted: boolean } {
    const row = this.db.prepare('SELECT file_path FROM knowledge_documents WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) return { filePath: '', deleted: false }
    this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
    return { filePath: String(row.file_path), deleted: true }
  }

  replaceKnowledgeDocumentChunks(
    documentId: string,
    chunks: readonly KnowledgeChunkInput[],
    vectors: readonly KnowledgeVectorInput[]
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId)
      this.insertKnowledgeChunks(chunks)
      this.insertKnowledgeVectors(vectors)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  clearKnowledgeDocumentChunks(documentId: string): void {
    this.db.prepare('DELETE FROM knowledge_chunks WHERE document_id = ?').run(documentId)
  }

  replaceKnowledgeRecordChunks(
    recordUid: string,
    chunks: readonly KnowledgeChunkInput[],
    vectors: readonly KnowledgeVectorInput[],
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): void {
    const [result] = this.replaceKnowledgeRecordChunksBatch(
      [{ recordUid, chunks, vectors }],
      taskId,
      operation
    )
    if (result?.error) throw new Error(result.error)
  }

  replaceKnowledgeRecordChunksBatch(
    replacements: readonly KnowledgeRecordChunkReplacement[],
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): KnowledgeRecordChunkReplacementResult[] {
    if (!replacements.length) return []
    if (replacements.length > KNOWLEDGE_RECORD_REPLACEMENT_MAX) {
      throw new Error(`单次记录向量替换不得超过 ${KNOWLEDGE_RECORD_REPLACEMENT_MAX} 条`)
    }
    const results: KnowledgeRecordChunkReplacementResult[] = []
    this.runInTransaction(() => {
      for (let index = 0; index < replacements.length; index += 1) {
        const replacement = replacements[index]
        const recordUid = String(replacement.recordUid ?? '').trim()
        const savepoint = `knowledge_record_replace_${index}`
        let savepointActive = false
        let recordExists = false
        try {
          this.db.exec(`SAVEPOINT ${savepoint}`)
          savepointActive = true
          recordExists = Boolean(this.db.prepare(
            'SELECT 1 FROM records WHERE uid = ? LIMIT 1'
          ).get(recordUid))
          if (!recordUid || !recordExists) throw new Error('记录不存在或已被删除')
          this.validateKnowledgeRecordReplacement(recordUid, replacement.chunks, replacement.vectors)
          this.db.prepare('DELETE FROM knowledge_chunks WHERE record_uid = ?').run(recordUid)
          this.insertKnowledgeChunks(replacement.chunks)
          this.insertKnowledgeVectors(replacement.vectors)
          this.markRecordMaintenanceVectorReady(
            recordUid,
            replacement.vectors[0]?.modelVersion ?? '',
            replacement.chunks.length,
            taskId,
            operation
          )
          this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
          savepointActive = false
          results.push({ recordUid, chunkCount: replacement.chunks.length })
        } catch (error) {
          if (savepointActive) {
            this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
            this.db.exec(`RELEASE SAVEPOINT ${savepoint}`)
            savepointActive = false
          }
          const message = error instanceof Error ? error.message : String(error)
          if (recordExists) {
            this.markRecordMaintenanceVectorFailed(recordUid, message, taskId, operation)
          }
          results.push({ recordUid, error: message.slice(0, 2000) })
        }
      }
    })
    return results
  }

  private validateKnowledgeRecordReplacement(
    recordUid: string,
    chunks: readonly KnowledgeChunkInput[],
    vectors: readonly KnowledgeVectorInput[]
  ): void {
    if (chunks.length !== vectors.length) {
      throw new Error('记录向量索引分块与向量数量不一致')
    }
    if (chunks.length > KNOWLEDGE_RECORD_REPLACEMENT_MAX_CHUNKS) {
      throw new Error(`单条记录向量分块不得超过 ${KNOWLEDGE_RECORD_REPLACEMENT_MAX_CHUNKS} 个`)
    }
    const chunkIds = new Set<string>()
    for (const chunk of chunks) {
      if (chunk.recordUid !== recordUid || chunk.sourceType !== 'record') {
        throw new Error('记录向量索引分块归属无效')
      }
      const chunkId = String(chunk.id ?? '').trim()
      if (!chunkId || chunkIds.has(chunkId)) throw new Error('记录向量索引分块 ID 无效或重复')
      chunkIds.add(chunkId)
    }
    const vectorIds = new Set<string>()
    for (const item of vectors) {
      const chunkId = String(item.chunkId ?? '').trim()
      if (!chunkIds.has(chunkId) || vectorIds.has(chunkId)) {
        throw new Error('记录向量索引向量与分块不匹配')
      }
      if (!(item.vector instanceof Float32Array) || !item.vector.length ||
        item.vector.some((value) => !Number.isFinite(value))) {
        throw new Error('记录向量索引包含无效向量')
      }
      if (!String(item.modelVersion ?? '').trim()) throw new Error('记录向量索引缺少模型版本')
      vectorIds.add(chunkId)
    }
  }

  private insertKnowledgeChunks(chunks: readonly KnowledgeChunkInput[]): void {
    const insert = this.db.prepare(`
      INSERT INTO knowledge_chunks(
        id, document_id, record_uid, source_type, source_name, source_hash,
        content, chunk_index, page_number, sheet_name, location,
        char_start, char_end, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const timestamp = nowIso()
    for (const chunk of chunks) {
      insert.run(
        chunk.id,
        chunk.documentId ?? null,
        chunk.recordUid ?? null,
        chunk.sourceType,
        chunk.sourceName,
        chunk.sourceHash,
        chunk.content,
        chunk.chunkIndex,
        chunk.pageNumber ?? null,
        chunk.sheetName ?? '',
        chunk.location ?? '',
        chunk.charStart ?? 0,
        chunk.charEnd ?? chunk.content.length,
        timestamp
      )
    }
  }

  private insertKnowledgeVectors(vectors: readonly KnowledgeVectorInput[]): void {
    const insert = this.db.prepare(`
      INSERT INTO knowledge_vectors(
        chunk_id, vector_blob, dimension, model_version, created_at,
        coarse_vector_blob, coarse_dimension, coarse_bucket
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const timestamp = nowIso()
    for (const item of vectors) {
      const bytes = Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength)
      const coarse = buildKnowledgeCoarseVector(item.vector)
      const coarseBytes = Buffer.from(coarse.buffer, coarse.byteOffset, coarse.byteLength)
      insert.run(
        item.chunkId,
        bytes,
        item.vector.length,
        item.modelVersion,
        timestamp,
        coarseBytes,
        coarse.length,
        knowledgeCoarseBucket(coarse)
      )
    }
  }

  saveKnowledgeVectors(vectors: readonly KnowledgeVectorInput[]): void {
    this.insertKnowledgeVectors(vectors)
  }

  getKnowledgeRecordIndexHash(recordUid: string): string | null {
    const row = this.db.prepare(`
      SELECT source_hash FROM knowledge_chunks
      WHERE record_uid = ?
      ORDER BY chunk_index ASC LIMIT 1
    `).get(recordUid) as SqlRow | undefined
    return row ? String(row.source_hash) : null
  }

  getKnowledgeRecordIndexModelVersion(recordUid: string): string | null {
    const row = this.db.prepare(`
      SELECT v.model_version
      FROM knowledge_chunks c
      JOIN knowledge_vectors v ON v.chunk_id = c.id
      WHERE c.record_uid = ?
      ORDER BY c.chunk_index ASC LIMIT 1
    `).get(recordUid) as SqlRow | undefined
    return row ? String(row.model_version) : null
  }

  getKnowledgeRecordIndexChunkCount(recordUid: string, modelVersion?: string): number {
    const row = modelVersion
      ? this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM knowledge_chunks c
          JOIN knowledge_vectors v ON v.chunk_id = c.id
          WHERE c.source_type = 'record' AND c.record_uid = ? AND v.model_version = ?
        `).get(recordUid, modelVersion) as SqlRow
      : this.db.prepare(`
          SELECT COUNT(*) AS count
          FROM knowledge_chunks c
          JOIN knowledge_vectors v ON v.chunk_id = c.id
          WHERE c.source_type = 'record' AND c.record_uid = ?
        `).get(recordUid) as SqlRow
    return Number(row.count ?? 0)
  }

  listKnowledgeRecordIndexRows(): KnowledgeRecordIndexRow[] {
    return (this.db.prepare(`
      SELECT uid, name, node_type, item_id, raw_json, semantic_hash
      FROM records ORDER BY uid
    `).all() as SqlRow[]).map((row) => this.mapKnowledgeRecordIndexRow(row))
  }

  listKnowledgeRecordIndexRowsByUids(recordUids: readonly string[]): KnowledgeRecordIndexRow[] {
    const selected = [...new Set(recordUids.map((uid) => String(uid).trim()).filter(Boolean))]
    if (!selected.length) return []
    const rows: KnowledgeRecordIndexRow[] = []
    for (let index = 0; index < selected.length; index += RECORD_MAINTENANCE_UID_BATCH_SIZE) {
      const batch = selected.slice(index, index + RECORD_MAINTENANCE_UID_BATCH_SIZE)
      const placeholders = batch.map(() => '?').join(', ')
      const batchRows = this.db.prepare(`
        SELECT uid, name, node_type, item_id, raw_json, semantic_hash
        FROM records WHERE uid IN (${placeholders})
        ORDER BY uid
      `).all(...batch) as SqlRow[]
      rows.push(...batchRows.map((row) => this.mapKnowledgeRecordIndexRow(row)))
    }
    return rows
  }

  getKnowledgeRecordIndexSnapshot(
    modelVersion: string,
    options: KnowledgeRecordIndexSnapshotOptions = {}
  ): KnowledgeRecordIndexSnapshot {
    const safeLimit = Math.min(
      KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE,
      Math.max(1, Math.trunc(options.limit || KNOWLEDGE_RECORD_SNAPSHOT_PAGE_SIZE))
    )
    const includeRecords = options.includeRecords !== false
    const includeDeleted = options.includeDeleted !== false
    const recordCursor = String(options.recordCursor ?? '')
    const deletedCursor = String(options.deletedCursor ?? '')
    // Keep candidate selection ahead of any chunk inspection.  The previous
    // query grouped every record's chunks before applying the UID cursor and
    // page limit, which made a multi-page sync repeat a full-table GROUP BY.
    // Ready/current rows use indexed correlated checks for legacy or damaged
    // state; only the bounded candidate set reaches the result projection.
    const candidateSourceRows = includeRecords
      ? this.db.prepare(`
          WITH target_records AS MATERIALIZED (
            SELECT r.uid, r.name, r.node_type, r.item_id, r.raw_json, r.semantic_hash
            FROM records r
            LEFT JOIN record_maintenance_states s ON s.record_uid = r.uid
            WHERE r.uid > ?
              AND (
                s.record_uid IS NULL
                OR COALESCE(s.vector_status, 'pending') <> 'ready'
                OR COALESCE(s.vector_version, '') <> ?
                OR COALESCE(s.vector_model_version, '') <> ?
                OR (
                  s.vector_status = 'ready'
                  AND s.vector_version = ?
                  AND s.vector_model_version = ?
                  AND (
                    NOT EXISTS (
                      SELECT 1
                      FROM knowledge_chunks c
                      JOIN knowledge_vectors v ON v.chunk_id = c.id
                      WHERE c.record_uid = r.uid AND c.source_type = 'record'
                    )
                    OR COALESCE(s.vector_chunk_count, 0) <> (
                      SELECT COUNT(*)
                      FROM knowledge_chunks c
                      JOIN knowledge_vectors v ON v.chunk_id = c.id
                      WHERE c.record_uid = r.uid AND c.source_type = 'record'
                    )
                    OR EXISTS (
                      SELECT 1
                      FROM knowledge_chunks c
                      JOIN knowledge_vectors v ON v.chunk_id = c.id
                      WHERE c.record_uid = r.uid
                        AND c.source_type = 'record'
                        AND v.model_version <> ?
                    )
                    OR (
                      SELECT COUNT(DISTINCT c.source_hash)
                      FROM knowledge_chunks c
                      JOIN knowledge_vectors v ON v.chunk_id = c.id
                      WHERE c.record_uid = r.uid AND c.source_type = 'record'
                    ) <> 1
                  )
                )
              )
            ORDER BY r.uid
            LIMIT ?
          )
          SELECT uid, name, node_type, item_id, raw_json, semantic_hash
          FROM target_records
          ORDER BY uid
        `).all(
          recordCursor,
          RECORD_VECTOR_INDEX_VERSION,
          modelVersion,
          RECORD_VECTOR_INDEX_VERSION,
          modelVersion,
          modelVersion,
          safeLimit + 1
        ) as SqlRow[]
      : []
    const deletedSourceRows = includeDeleted
      ? this.db.prepare(`
          SELECT DISTINCT c.record_uid AS uid
          FROM knowledge_chunks c
          WHERE c.source_type = 'record'
            AND c.record_uid IS NOT NULL
            AND c.record_uid > ?
            AND NOT EXISTS (
              SELECT 1 FROM records r WHERE r.uid = c.record_uid
            )
          ORDER BY c.record_uid
          LIMIT ?
        `).all(deletedCursor, safeLimit + 1) as SqlRow[]
      : []
    const candidateRows = candidateSourceRows
      .slice(0, safeLimit)
      .map((row) => this.mapKnowledgeRecordIndexRow(row))
    const deletedRows = deletedSourceRows.slice(0, safeLimit)
    const hasMoreRecords = candidateSourceRows.length > safeLimit
    const hasMoreDeletedRecords = deletedSourceRows.length > safeLimit
    return {
      rows: candidateRows,
      deletedRecordUids: deletedRows.map((row) => String(row.uid)),
      hasMoreRecords,
      hasMoreDeletedRecords,
      ...(hasMoreRecords && candidateRows.length
        ? { nextRecordCursor: candidateRows[candidateRows.length - 1].uid }
        : {}),
      ...(hasMoreDeletedRecords && deletedRows.length
        ? { nextDeletedCursor: String(deletedRows[deletedRows.length - 1].uid) }
        : {})
    }
  }

  countKnowledgeRecordIndexRecords(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM records').get() as SqlRow
    return Math.max(0, Number(row.count ?? 0))
  }

  private mapKnowledgeRecordIndexRow(row: SqlRow): KnowledgeRecordIndexRow {
    const content = this.requirementBusinessTextFromRow(row)
    const fieldDefinitionFingerprint = this.getFieldDefinitionFingerprint(
      String(row.node_type ?? '')
    )
    return {
      uid: String(row.uid),
      name: String(row.name ?? ''),
      nodeType: String(row.node_type ?? ''),
      itemId: String(row.item_id ?? ''),
      content,
      contentHash: createHash('sha256')
        .update(`${String(row.semantic_hash ?? '')}\n${fieldDefinitionFingerprint}\n${content}`)
        .digest('hex')
    }
  }

  getKnowledgeRecordIndexRow(recordUid: string): KnowledgeRecordIndexRow | null {
    const row = this.db.prepare(`
      SELECT uid, name, node_type, item_id, raw_json, semantic_hash
      FROM records WHERE uid = ? LIMIT 1
    `).get(recordUid) as SqlRow | undefined
    if (!row) return null
    return this.mapKnowledgeRecordIndexRow(row)
  }

  deleteKnowledgeRecordIndex(recordUid: string): void {
    this.db.prepare('DELETE FROM knowledge_chunks WHERE record_uid = ?').run(recordUid)
  }

  deleteKnowledgeRecordIndexes(recordUids: readonly string[]): number {
    const selected = [...new Set(recordUids.map((uid) => String(uid).trim()).filter(Boolean))]
    if (!selected.length) return 0
    const deleted = this.runInTransaction(() => {
      const statement = this.db.prepare('DELETE FROM knowledge_chunks WHERE record_uid = ?')
      let count = 0
      for (const recordUid of selected) count += Number(statement.run(recordUid).changes)
      return count
    })
    return deleted
  }

  listKnowledgeIndexedRecordUids(modelVersion?: string): string[] {
    const rows = modelVersion
      ? this.db.prepare(`
          SELECT DISTINCT c.record_uid
          FROM knowledge_chunks c
          JOIN knowledge_vectors v ON v.chunk_id = c.id
          WHERE c.source_type = 'record'
            AND c.record_uid IS NOT NULL
            AND v.model_version = ?
          ORDER BY c.record_uid
        `).all(modelVersion) as SqlRow[]
      : this.db.prepare(`
          SELECT DISTINCT record_uid FROM knowledge_chunks
          WHERE source_type = 'record' AND record_uid IS NOT NULL
          ORDER BY record_uid
        `).all() as SqlRow[]
    return rows.map((row) => String(row.record_uid))
  }

  listKnowledgeIndexedRecordDetails(modelVersion: string): RecordDetail[] {
    const rows = this.db.prepare(`
      SELECT r.*, 0 AS image_count
      FROM records r
      WHERE EXISTS (
        SELECT 1
        FROM knowledge_chunks c
        JOIN knowledge_vectors v ON v.chunk_id = c.id
        WHERE c.source_type = 'record'
          AND c.record_uid = r.uid
          AND v.model_version = ?
      )
      ORDER BY r.uid
    `).all(modelVersion) as SqlRow[]
    const maintenanceStates = this.getRecordMaintenanceStates(
      rows.map((row) => String(row.uid)),
      modelVersion
    )
    return rows.map((row): RecordDetail => {
      let raw: Record<string, unknown> = {}
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        // A legacy raw payload may be corrupt; normalizedText remains usable for matching.
      }
      return {
        ...this.mapRecord(row),
        normalizedText: String(row.normalized_text ?? ''),
        raw,
        images: [],
        matchingText: this.requirementBusinessTextFromRow(row),
        maintenance: maintenanceStates.get(String(row.uid)) ??
          this.getRecordMaintenanceState(String(row.uid), modelVersion)
      }
    })
  }

  getRequirementSemanticCardState(recordUid: string): RequirementSemanticCardState | null {
    const row = this.db.prepare(`
      SELECT * FROM requirement_semantic_cards WHERE record_uid = ? LIMIT 1
    `).get(recordUid) as SqlRow | undefined
    if (!row) return null
    let card: RequirementSemanticCard | null = null
    try {
      const parsed = String(row.card_json ?? '').trim() ? JSON.parse(String(row.card_json)) : null
      card = isAiRequirementSemanticCard(parsed) ? parsed : null
    } catch {
      card = null
    }
    let analysisTrace: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(String(row.analysis_trace_json ?? '{}'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        analysisTrace = parsed as Record<string, unknown>
      }
    } catch {
      analysisTrace = {}
    }
    return {
      recordUid: String(row.record_uid),
      contentHash: String(row.content_hash),
      analyzerVersion: String(row.analyzer_version),
      modelSignature: String(row.model_signature),
      status: this.semanticStatus(row.status),
      card,
      errorMessage: String(row.error_message ?? ''),
      startedAt: String(row.started_at ?? ''),
      completedAt: String(row.completed_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      analysisTrace
    }
  }

  getRecordContentHash(recordUid: string): string | null {
    const row = this.db.prepare(`
      SELECT ${requirementSemanticContentSql('r')} AS semantic_content_hash
      FROM records r WHERE r.uid = ?
    `).get(recordUid) as SqlRow | undefined
    return row ? String(row.semantic_content_hash ?? '') : null
  }

  getReadyRequirementSemanticCard(input: {
    recordUid: string
    contentHash: string
    analyzerVersion: string
    modelSignature: string
  }): RequirementSemanticCard | null {
    const state = this.getRequirementSemanticCardState(input.recordUid)
    return state?.status === 'ready' && state.card &&
      state.contentHash === input.contentHash &&
      state.analyzerVersion === input.analyzerVersion &&
      state.modelSignature === input.modelSignature
      ? state.card
      : null
  }

  listReadyRequirementSemanticCards(input: {
    recordUids?: string[]
    analyzerVersion: string
    modelSignature: string
  }): Map<string, RequirementSemanticCard> {
    const recordUids = [...new Set(input.recordUids ?? [])]
    if (input.recordUids && !recordUids.length) return new Map()
    const where = [
      "s.status = 'ready'",
      `s.content_hash = ${requirementSemanticContentSql('r')}`,
      's.analyzer_version = ?',
      's.model_signature = ?'
    ]
    const params: Array<string | number> = [input.analyzerVersion, input.modelSignature]
    if (recordUids.length) {
      where.push(`s.record_uid IN (${recordUids.map(() => '?').join(', ')})`)
      params.push(...recordUids)
    }
    const rows = this.db.prepare(`
      SELECT s.record_uid, s.card_json
      FROM requirement_semantic_cards s
      JOIN records r ON r.uid = s.record_uid
      WHERE ${where.join(' AND ')}
    `).all(...params) as SqlRow[]
    return new Map(rows.flatMap((row) => {
      try {
        const parsed: unknown = JSON.parse(String(row.card_json))
        return isAiRequirementSemanticCard(parsed) ? [[String(row.record_uid), parsed]] : []
      } catch {
        return []
      }
    }))
  }

  listRequirementSemanticizationCandidates(input: {
    analyzerVersion: string
    modelSignature: string
  }): { available: number; candidates: RequirementSemanticizationCandidate[] } {
    const rows = this.db.prepare(`
      SELECT r.uid, r.item_id, r.name,
             ${requirementSemanticContentSql('r')} AS semantic_content_hash,
             s.status AS semantic_status, s.content_hash, s.analyzer_version,
             s.model_signature,
             CASE
               WHEN s.status = 'ready'
                AND s.content_hash = ${requirementSemanticContentSql('r')}
                AND s.analyzer_version = ?
                AND s.model_signature = ?
               THEN s.card_json
               ELSE NULL
             END AS card_json
      FROM records r
      LEFT JOIN requirement_semantic_cards s ON s.record_uid = r.uid
      WHERE s.record_uid IS NULL OR s.status <> 'processing'
      ORDER BY r.last_modify_time ASC, r.uid ASC
    `).all(input.analyzerVersion, input.modelSignature) as SqlRow[]
    const candidates = rows.flatMap((row): RequirementSemanticizationCandidate[] => {
      const contentHash = String(row.semantic_content_hash ?? '')
      const metadataReady = String(row.semantic_status ?? '') === 'ready' &&
        String(row.content_hash ?? '') === contentHash &&
        String(row.analyzer_version ?? '') === input.analyzerVersion &&
        String(row.model_signature ?? '') === input.modelSignature
      let validCard = false
      // Most rows are pending, failed, or stale. Avoid parsing a potentially
      // large card/trace payload unless its cheap metadata checks already say
      // it could be a reusable ready card.
      if (metadataReady) {
        try {
          validCard = isAiRequirementSemanticCard(JSON.parse(String(row.card_json ?? '')))
        } catch {
          validCard = false
        }
      }
      const validReady = metadataReady && validCard
      return validReady ? [] : [{
        recordUid: String(row.uid),
        itemId: String(row.item_id ?? ''),
        name: String(row.name ?? ''),
        contentHash
      }]
    })
    return {
      available: candidates.length,
      candidates
    }
  }

  claimRequirementSemanticCard(input: {
    recordUid: string
    contentHash: string
    analyzerVersion: string
    modelSignature: string
    force?: boolean
  }): boolean {
    if (!input.force) {
      const current = this.getRequirementSemanticCardState(input.recordUid)
      const isValidReady = current?.status === 'ready' && current.card &&
        current.contentHash === input.contentHash &&
        current.analyzerVersion === input.analyzerVersion &&
        current.modelSignature === input.modelSignature
      if (isValidReady) return false
    }
    const timestamp = nowIso()
    const result = this.db.prepare(`
      INSERT INTO requirement_semantic_cards(
        record_uid, content_hash, analyzer_version, model_signature, status,
        card_json, error_message, started_at, completed_at, analysis_trace_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'processing', '', '', ?, '', '{}', ?, ?)
      ON CONFLICT(record_uid) DO UPDATE SET
        content_hash = excluded.content_hash,
        analyzer_version = excluded.analyzer_version,
        model_signature = excluded.model_signature,
        status = 'processing', card_json = '', error_message = '',
        started_at = excluded.started_at, completed_at = '', analysis_trace_json = '{}',
        updated_at = excluded.updated_at
      WHERE requirement_semantic_cards.status <> 'processing'
    `).run(
      input.recordUid, input.contentHash, input.analyzerVersion, input.modelSignature,
      timestamp, timestamp, timestamp
    )
    return result.changes > 0
  }

  completeRequirementSemanticCard(
    recordUid: string,
    card: RequirementSemanticCard,
    analysisTrace: object = {},
    expected?: {
      contentHash: string
      analyzerVersion: string
      modelSignature: string
    }
  ): boolean {
    const timestamp = nowIso()
    const expectedWhere = expected
      ? `
        AND content_hash = ?
        AND analyzer_version = ?
        AND model_signature = ?
        AND content_hash = (
          SELECT ${requirementSemanticContentSql('r')}
          FROM records r
          WHERE r.uid = requirement_semantic_cards.record_uid
        )
      `
      : ''
    const result = this.db.prepare(`
      UPDATE requirement_semantic_cards
      SET status = 'ready', card_json = ?, analysis_trace_json = ?, error_message = '',
          completed_at = ?, updated_at = ?
      WHERE record_uid = ? AND status = 'processing'${expectedWhere}
    `).run(
      JSON.stringify(card), JSON.stringify(analysisTrace), timestamp, timestamp, recordUid,
      ...(expected ? [expected.contentHash, expected.analyzerVersion, expected.modelSignature] : [])
    )
    return result.changes > 0
  }

  updateRequirementSemanticCardTrace(
    recordUid: string,
    analysisTrace: RequirementSemanticizationAnalysisTrace
  ): void {
    this.db.prepare(`
      UPDATE requirement_semantic_cards
      SET analysis_trace_json = ?, updated_at = ?
      WHERE record_uid = ? AND status = 'processing'
    `).run(JSON.stringify(analysisTrace), nowIso(), recordUid)
  }

  failRequirementSemanticCard(
    recordUid: string,
    message: string,
    analysisTrace: object = {}
  ): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE requirement_semantic_cards
      SET status = 'failed', card_json = '', analysis_trace_json = ?, error_message = ?,
          completed_at = ?, updated_at = ?
      WHERE record_uid = ? AND status = 'processing'
    `).run(JSON.stringify(analysisTrace), message.slice(0, 2000), timestamp, timestamp, recordUid)
  }

  releaseRequirementSemanticCard(recordUid: string, analysisTrace?: object): void {
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE requirement_semantic_cards
      SET status = 'pending', card_json = '', error_message = '',
          started_at = '', completed_at = '', analysis_trace_json = ?, updated_at = ?
      WHERE record_uid = ? AND status = 'processing'
    `).run(JSON.stringify(analysisTrace ?? {}), timestamp, recordUid)
  }

  getRequirementMatchCache(cacheKey: string): RequirementMatchCache | null {
    const normalizedKey = normalizeRequirementMatchCacheString(
      cacheKey,
      'cacheKey',
      requirementMatchCacheMax.cacheKey
    )
    const row = this.db.prepare(`
      SELECT * FROM requirement_match_cache WHERE cache_key = ? LIMIT 1
    `).get(normalizedKey) as SqlRow | undefined
    if (!row) return null
    const mapped = mapRequirementMatchCacheRow(row)
    if (mapped) return mapped
    this.db.prepare('DELETE FROM requirement_match_cache WHERE cache_key = ?').run(normalizedKey)
    return null
  }

  saveRequirementMatchCache(input: RequirementMatchCacheInput): void {
    const normalized = {
      cacheKey: normalizeRequirementMatchCacheString(input.cacheKey, 'cacheKey', requirementMatchCacheMax.cacheKey),
      baseRecordUid: normalizeRequirementMatchCacheString(input.baseRecordUid, 'baseRecordUid', requirementMatchCacheMax.recordUid),
      candidateRecordUid: normalizeRequirementMatchCacheString(input.candidateRecordUid, 'candidateRecordUid', requirementMatchCacheMax.recordUid),
      queryHash: normalizeRequirementMatchCacheString(input.queryHash, 'queryHash', requirementMatchCacheMax.hash),
      baseContentHash: normalizeRequirementMatchCacheString(input.baseContentHash, 'baseContentHash', requirementMatchCacheMax.hash),
      candidateContentHash: normalizeRequirementMatchCacheString(input.candidateContentHash, 'candidateContentHash', requirementMatchCacheMax.hash),
      baseCardHash: normalizeRequirementMatchCacheString(input.baseCardHash, 'baseCardHash', requirementMatchCacheMax.hash),
      candidateCardHash: normalizeRequirementMatchCacheString(input.candidateCardHash, 'candidateCardHash', requirementMatchCacheMax.hash),
      analyzerVersion: normalizeRequirementMatchCacheString(input.analyzerVersion, 'analyzerVersion', requirementMatchCacheMax.version),
      semanticModelSignature: normalizeRequirementMatchCacheString(input.semanticModelSignature, 'semanticModelSignature', requirementMatchCacheMax.version),
      embeddingModelVersion: normalizeRequirementMatchCacheString(input.embeddingModelVersion, 'embeddingModelVersion', requirementMatchCacheMax.version),
      rerankerVersion: normalizeRequirementMatchCacheString(input.rerankerVersion, 'rerankerVersion', requirementMatchCacheMax.version),
      strategyVersion: normalizeRequirementMatchCacheString(input.strategyVersion, 'strategyVersion', requirementMatchCacheMax.version),
      explanationModelSignature: normalizeRequirementMatchCacheString(input.explanationModelSignature, 'explanationModelSignature', requirementMatchCacheMax.version),
      resultJson: normalizeRequirementMatchCacheJson(input.result),
      resultStatus: input.resultStatus
    }
    if (!requirementMatchCacheStatuses.has(normalized.resultStatus)) {
      throw new Error('resultStatus 必须是 live_verified 或 cache_verified')
    }
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO requirement_match_cache(
        cache_key, base_record_uid, candidate_record_uid, query_hash,
        base_content_hash, candidate_content_hash, base_card_hash, candidate_card_hash,
        analyzer_version, semantic_model_signature, embedding_model_version,
        reranker_version, strategy_version, explanation_model_signature,
        result_json, result_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        base_record_uid = excluded.base_record_uid,
        candidate_record_uid = excluded.candidate_record_uid,
        query_hash = excluded.query_hash,
        base_content_hash = excluded.base_content_hash,
        candidate_content_hash = excluded.candidate_content_hash,
        base_card_hash = excluded.base_card_hash,
        candidate_card_hash = excluded.candidate_card_hash,
        analyzer_version = excluded.analyzer_version,
        semantic_model_signature = excluded.semantic_model_signature,
        embedding_model_version = excluded.embedding_model_version,
        reranker_version = excluded.reranker_version,
        strategy_version = excluded.strategy_version,
        explanation_model_signature = excluded.explanation_model_signature,
        result_json = excluded.result_json,
        result_status = excluded.result_status,
        updated_at = excluded.updated_at
    `).run(
      normalized.cacheKey,
      normalized.baseRecordUid,
      normalized.candidateRecordUid,
      normalized.queryHash,
      normalized.baseContentHash,
      normalized.candidateContentHash,
      normalized.baseCardHash,
      normalized.candidateCardHash,
      normalized.analyzerVersion,
      normalized.semanticModelSignature,
      normalized.embeddingModelVersion,
      normalized.rerankerVersion,
      normalized.strategyVersion,
      normalized.explanationModelSignature,
      normalized.resultJson,
      normalized.resultStatus,
      timestamp,
      timestamp
    )
  }

  deleteRequirementMatchCache(cacheKey: string): void {
    const normalizedKey = normalizeRequirementMatchCacheString(
      cacheKey,
      'cacheKey',
      requirementMatchCacheMax.cacheKey
    )
    this.db.prepare('DELETE FROM requirement_match_cache WHERE cache_key = ?').run(normalizedKey)
  }

  pruneRequirementMatchCache(olderThanIso?: string): number {
    const cutoff = olderThanIso === undefined
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      : normalizeRequirementMatchCacheString(olderThanIso, 'olderThanIso', 64)
    if (!Number.isFinite(Date.parse(cutoff))) throw new Error('olderThanIso 必须是有效时间')
    const result = this.db.prepare('DELETE FROM requirement_match_cache WHERE updated_at < ?').run(cutoff)
    return Number(result.changes)
  }

  deleteKnowledgeVectors(): void {
    this.db.prepare('DELETE FROM knowledge_vectors').run()
  }

  listKnowledgeChunksForRebuild(): KnowledgeChunk[] {
    return (this.db.prepare(`
      SELECT c.* FROM knowledge_chunks c
      LEFT JOIN knowledge_documents d ON d.id = c.document_id
      WHERE c.source_type = 'record' OR d.status = 'ready'
      ORDER BY c.source_type, c.source_name, c.chunk_index
    `).all() as SqlRow[]).map((row) => this.mapKnowledgeChunk(row))
  }

  knowledgeDocumentsNeedReindex(modelVersion: string): boolean {
    const row = this.db.prepare(`
      SELECT EXISTS(
        SELECT 1
        FROM knowledge_documents d
        WHERE d.status = 'ready'
          AND (
            d.model_version <> ?
            OR EXISTS(
              SELECT 1
              FROM knowledge_chunks c
              LEFT JOIN knowledge_vectors v ON v.chunk_id = c.id
              WHERE c.document_id = d.id
                AND (v.chunk_id IS NULL OR v.model_version <> ?)
            )
          )
      ) AS needs_reindex
    `).get(modelVersion, modelVersion) as SqlRow | undefined
    return Number(row?.needs_reindex ?? 0) === 1
  }

  markKnowledgeDocumentsModelVersion(modelVersion: string): void {
    this.db.prepare(`
      UPDATE knowledge_documents
      SET model_version = ?, updated_at = ?
      WHERE status = 'ready'
    `).run(modelVersion, nowIso())
  }

  listKnowledgeVectorRows(modelVersion: string): KnowledgeVectorRow[] {
    const rows = this.db.prepare(`
      SELECT c.*, v.vector_blob, v.coarse_vector_blob, v.coarse_dimension
      FROM knowledge_chunks c
      JOIN knowledge_vectors v ON v.chunk_id = c.id
      LEFT JOIN knowledge_documents d ON d.id = c.document_id
      WHERE v.model_version = ?
        AND (c.source_type = 'record' OR d.status = 'ready')
      ORDER BY c.source_name, c.chunk_index
    `).all(modelVersion) as SqlRow[]
    return rows.map((row) => {
      const bytes = Uint8Array.from(row.vector_blob as Uint8Array)
      return {
        chunk: this.mapKnowledgeChunk(row),
        vector: new Float32Array(bytes.buffer),
        coarse: float32FromBlob(row.coarse_vector_blob)
      }
    })
  }

  /**
   * Backfill the persisted coarse representation in small write batches. This
   * is intentionally incremental so opening an old database never requires a
   * full-vector rewrite before the UI becomes usable.
   */
  backfillKnowledgeVectorCoarseIndex(
    modelVersion: string,
    limit = 512
  ): { updatedCount: number; remainingCount: number } {
    const safeLimit = Math.min(2048, Math.max(1, Math.trunc(limit || 512)))
    const rows = this.db.prepare(`
      SELECT chunk_id, vector_blob
      FROM knowledge_vectors
      WHERE model_version = ? AND coarse_vector_blob IS NULL
      ORDER BY chunk_id
      LIMIT ?
    `).all(modelVersion, safeLimit) as SqlRow[]
    if (rows.length) {
      this.runInTransaction(() => {
        const update = this.db.prepare(`
          UPDATE knowledge_vectors
          SET coarse_vector_blob = ?, coarse_dimension = ?, coarse_bucket = ?
          WHERE chunk_id = ? AND model_version = ? AND coarse_vector_blob IS NULL
        `)
        for (const row of rows) {
          const bytes = Uint8Array.from(row.vector_blob as Uint8Array)
          if (!bytes.byteLength || bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) continue
          const vector = new Float32Array(bytes.buffer)
          const coarse = buildKnowledgeCoarseVector(vector)
          const coarseBytes = Buffer.from(coarse.buffer, coarse.byteOffset, coarse.byteLength)
          update.run(coarseBytes, coarse.length, knowledgeCoarseBucket(coarse), String(row.chunk_id), modelVersion)
        }
      })
    }
    const remaining = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM knowledge_vectors
      WHERE model_version = ? AND coarse_vector_blob IS NULL
    `).get(modelVersion) as SqlRow
    return { updatedCount: rows.length, remainingCount: Number(remaining.count ?? 0) }
  }

  searchRequirementRecordsLexical(
    terms: string[],
    modelVersion: string,
    limit = 100,
    semanticContext?: RequirementSemanticizationContext
  ): RequirementLexicalMatch[] {
    const normalizedTerms = [...new Set(terms
      .map((term) => String(term).trim().replaceAll('"', '""'))
      .filter((term) => term.length >= 2))].slice(0, 80)
    if (!normalizedTerms.length) return []
    const matchQuery = normalizedTerms.map((term) => `"${term}"`).join(' OR ')
    try {
      const rows = this.db.prepare(`
        SELECT r.uid, r.name, r.node_type, r.item_id, f.business_text,
               bm25(requirement_records_fts) AS rank
        FROM requirement_records_fts f
        JOIN records r ON r.uid = f.record_uid
        ${semanticContext ? 'JOIN requirement_semantic_cards s ON s.record_uid = r.uid' : ''}
        WHERE requirement_records_fts MATCH ?
          ${semanticContext ? `AND s.status = 'ready'
          AND s.content_hash = ${requirementSemanticContentSql('r')}
          AND s.analyzer_version = ?
          AND s.model_signature = ?` : ''}
          AND EXISTS (
            SELECT 1
            FROM knowledge_chunks c
            JOIN knowledge_vectors v ON v.chunk_id = c.id
            WHERE c.source_type = 'record'
              AND c.record_uid = r.uid
              AND v.model_version = ?
          )
        ORDER BY rank ASC, r.uid ASC
        LIMIT ?
      `).all(
        matchQuery,
        ...(semanticContext ? [semanticContext.analyzerVersion, semanticContext.modelSignature] : []),
        modelVersion,
        Math.min(100, Math.max(1, Math.trunc(limit)))
      ) as SqlRow[]
      return rows.map((row) => ({
        recordUid: String(row.uid),
        recordName: String(row.name ?? ''),
        nodeType: String(row.node_type ?? ''),
        itemId: String(row.item_id ?? ''),
        score: Number.isFinite(Number(row.rank)) ? Math.max(0, -Number(row.rank)) : 0,
        snippet: String(row.business_text ?? '').slice(0, 600)
      }))
    } catch (error) {
      throw new Error(
        `需求 FTS5/BM25 召回不可用：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      )
    }
  }

  /**
   * Mark in-flight knowledge work as retryable after a process restart and
   * bound the progress table so long-running desktop usage does not grow it
   * without limit. Document chunks are intentionally left intact: the next
   * idempotent document/record pass replaces them in one transaction.
   */
  reconcileInterruptedKnowledgeTasks(): number {
    const timestamp = nowIso()
    const cutoff = new Date(Date.now() - TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const taskResult = this.db.prepare(`
        UPDATE knowledge_index_tasks
        SET status = 'failed',
            message = CASE
              WHEN message = '' THEN '应用在知识库索引任务中断，可重试'
              ELSE message || '（应用重启中断，可重试）'
            END,
            updated_at = ?
        WHERE status = 'running'
      `).run(timestamp)
      const documentResult = this.db.prepare(`
        UPDATE knowledge_documents
        SET status = 'queued',
            error_message = '应用在知识库处理中断，已重新加入恢复队列',
            processed_at = '',
            updated_at = ?
        WHERE status = 'processing'
      `).run(timestamp)
      this.db.prepare(`
        DELETE FROM knowledge_index_tasks
        WHERE status IN ('success', 'failed') AND updated_at < ?
      `).run(cutoff)
      this.db.exec('COMMIT')
      return Number(taskResult.changes ?? 0) + Number(documentResult.changes ?? 0)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  private mapKnowledgeIndexProgress(row: SqlRow): KnowledgeIndexProgress {
    const elapsedMs = Number(row.elapsed_ms ?? 0)
    const throughputPerSecond = Number(row.throughput_per_second ?? 0)
    return {
      taskId: String(row.id),
      phase: String(row.phase) as KnowledgeIndexProgress['phase'],
      message: String(row.message ?? ''),
      current: Number(row.current_count ?? 0),
      total: Number(row.total_count ?? 0),
      status: String(row.status) as KnowledgeIndexProgress['status'],
      ...(Number.isFinite(elapsedMs) && elapsedMs > 0 ? { elapsedMs } : {}),
      ...(Number.isFinite(throughputPerSecond) && throughputPerSecond > 0 ? { throughputPerSecond } : {})
    }
  }

  getKnowledgeIndexProgress(taskId: string): KnowledgeIndexProgress | null {
    const row = this.db.prepare(`
      SELECT id, phase, status, current_count, total_count, message,
             elapsed_ms, throughput_per_second
      FROM knowledge_index_tasks WHERE id = ? LIMIT 1
    `).get(taskId.trim()) as SqlRow | undefined
    if (!row) return null
    return this.mapKnowledgeIndexProgress(row)
  }

  listKnowledgeIndexProgress(limit = 100): KnowledgeIndexProgress[] {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit || 100)))
    const rows = this.db.prepare(`
      SELECT id, phase, status, current_count, total_count, message,
             elapsed_ms, throughput_per_second
      FROM knowledge_index_tasks
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(safeLimit) as SqlRow[]
    return rows.map((row) => this.mapKnowledgeIndexProgress(row))
  }

  getKnowledgeStats(modelVersion: string): KnowledgeStats {
    const scalar = (sql: string, ...params: Array<string | number | null>): number =>
      Number((this.db.prepare(sql).get(...params) as SqlRow).count ?? 0)
    const documentCount = scalar('SELECT COUNT(*) AS count FROM knowledge_documents')
    return {
      documentCount,
      readyCount: scalar("SELECT COUNT(*) AS count FROM knowledge_documents WHERE status = 'ready'"),
      processingCount: scalar("SELECT COUNT(*) AS count FROM knowledge_documents WHERE status IN ('queued', 'processing')"),
      failedCount: scalar("SELECT COUNT(*) AS count FROM knowledge_documents WHERE status = 'failed'"),
      chunkCount: scalar('SELECT COUNT(*) AS count FROM knowledge_chunks'),
      indexedChunkCount: scalar('SELECT COUNT(*) AS count FROM knowledge_vectors WHERE model_version = ?', modelVersion),
      recordCount: scalar("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE source_type = 'record'"),
      modelVersion,
      latestTask: this.listKnowledgeIndexProgress(1)[0]
    }
  }

  saveKnowledgeIndexProgress(progress: KnowledgeIndexProgress): void {
    const timestamp = nowIso()
    const elapsedMs = Number.isFinite(progress.elapsedMs)
      ? Math.max(0, Math.trunc(progress.elapsedMs as number))
      : 0
    const throughputPerSecond = Number.isFinite(progress.throughputPerSecond)
      ? Math.max(0, progress.throughputPerSecond as number)
      : 0
    this.db.prepare(`
      INSERT INTO knowledge_index_tasks(
        id, phase, status, current_count, total_count, message,
        elapsed_ms, throughput_per_second, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase,
        status = excluded.status,
        current_count = excluded.current_count,
        total_count = excluded.total_count,
        message = excluded.message,
        elapsed_ms = excluded.elapsed_ms,
        throughput_per_second = excluded.throughput_per_second,
        updated_at = excluded.updated_at
    `).run(
      progress.taskId,
      progress.phase,
      progress.status,
      progress.current,
      progress.total,
      progress.message,
      elapsedMs,
      throughputPerSecond,
      timestamp,
      timestamp
    )
  }

  private mapManagedProject(row: SqlRow): ManagedProject {
    const plannedDeliveryDate = String(row.planned_delivery_date ?? '')
    const contractAmount = Number(row.contract_amount ?? 0)
    const baseEstimatedCost = Number(row.estimated_cost ?? 0)
    const laborEstimatedCost = Number(row.labor_estimated_cost ?? 0)
    const estimatedCost = baseEstimatedCost + laborEstimatedCost
    return {
      id: String(row.id),
      projectName: String(row.project_name ?? ''),
      customerName: String(row.customer_name ?? ''),
      contractAmount,
      riskFactor: Number(row.risk_factor ?? 0),
      deliveryReminderDays: Number(row.delivery_reminder_days ?? 0),
      plannedDeliveryDate,
      salesOwner: String(row.sales_owner ?? ''),
      technicalOwner: String(row.technical_owner ?? ''),
      developmentOwner: String(row.development_owner ?? ''),
      estimatedCost,
      laborEstimatedCost,
      actualCost: Number(row.actual_cost ?? 0),
      remainingQuota: contractAmount - estimatedCost,
      estimatedDurationDays: Number(row.estimated_duration_days ?? 0),
      lifecycle: String(row.lifecycle ?? 'draft') as ManagedProject['lifecycle'],
      source: String(row.source ?? 'manual') as ManagedProject['source'],
      analysisStatus: String(row.analysis_status ?? 'idle') as ManagedProject['analysisStatus'],
      analysisMessage: String(row.analysis_message ?? ''),
      matchStatus: String(row.match_status ?? 'idle') as ManagedProject['matchStatus'],
      matchMessage: String(row.match_message ?? ''),
      requirementCount: Number(row.requirement_count ?? 0),
      satisfiedCount: Number(row.satisfied_count ?? 0),
      toDevelopCount: Number(row.to_develop_count ?? 0),
      toNegotiateCount: Number(row.to_negotiate_count ?? 0),
      unmarkedCount: Number(row.unmarked_count ?? 0),
      assetCount: Number(row.asset_count ?? 0),
      participantCount: Number(row.participant_count ?? 0),
      taskCount: Number(row.task_count ?? 0),
      documentCount: Number(row.document_count ?? 0),
      ...(row.review_set_id ? { reviewSetId: String(row.review_set_id) } : {}),
      reviewVersion: Number(row.review_version ?? 0),
      reviewRequirementCount: Number(row.review_requirement_count ?? 0),
      pendingReviewCount: Number(row.pending_review_count ?? 0),
      ...(row.current_document_id ? { currentDocumentId: String(row.current_document_id) } : {}),
      ...(row.current_document_name ? { currentDocumentName: String(row.current_document_name) } : {}),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  private managedProjectSelect(): string {
    return `
      SELECT p.*,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.project_id = p.id AND q.review_status = 'approved'
          AND (q.set_id = '' OR q.set_id IN (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'published'))) AS requirement_count,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.project_id = p.id AND q.review_status = 'approved' AND q.status = 'satisfied'
          AND (q.set_id = '' OR q.set_id IN (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'published'))) AS satisfied_count,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.project_id = p.id AND q.review_status = 'approved' AND q.status = 'to_develop'
          AND (q.set_id = '' OR q.set_id IN (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'published'))) AS to_develop_count,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.project_id = p.id AND q.review_status = 'approved' AND q.status = 'to_negotiate'
          AND (q.set_id = '' OR q.set_id IN (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'published'))) AS to_negotiate_count,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.project_id = p.id AND q.review_status = 'approved' AND q.status = 'unmarked'
          AND (q.set_id = '' OR q.set_id IN (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'published'))) AS unmarked_count,
        (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'reviewing' ORDER BY version DESC LIMIT 1) AS review_set_id,
        (SELECT version FROM pm_requirement_sets WHERE project_id = p.id AND status = 'reviewing' ORDER BY version DESC LIMIT 1) AS review_version,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.set_id = (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'reviewing' ORDER BY version DESC LIMIT 1)) AS review_requirement_count,
        (SELECT COUNT(*) FROM pm_requirements q WHERE q.review_status = 'pending' AND q.set_id = (SELECT id FROM pm_requirement_sets WHERE project_id = p.id AND status = 'reviewing' ORDER BY version DESC LIMIT 1)) AS pending_review_count,
        (SELECT COUNT(*) FROM pm_project_assets a WHERE a.project_id = p.id) AS asset_count,
        (SELECT COUNT(*) FROM pm_project_participants pp WHERE pp.project_id = p.id) AS participant_count,
        (SELECT COALESCE(SUM(pp.estimated_cost), 0) FROM pm_project_participants pp WHERE pp.project_id = p.id) AS labor_estimated_cost,
        (SELECT COUNT(*) FROM pm_project_tasks pt WHERE pt.project_id = p.id) AS task_count,
        (SELECT COUNT(*) FROM pm_project_documents pd WHERE pd.project_id = p.id) AS document_count,
        (SELECT d.id FROM pm_project_documents pd JOIN knowledge_documents d ON d.id = pd.document_id
          WHERE pd.project_id = p.id AND pd.is_current = 1 ORDER BY pd.version DESC LIMIT 1) AS current_document_id,
        (SELECT d.file_name FROM pm_project_documents pd JOIN knowledge_documents d ON d.id = pd.document_id
          WHERE pd.project_id = p.id AND pd.is_current = 1 ORDER BY pd.version DESC LIMIT 1) AS current_document_name
      FROM pm_projects p`
  }

  createManagedProject(
    id: string,
    input: ManagedProjectInput,
    source: ManagedProject['source'] = 'manual',
    lifecycle: ManagedProject['lifecycle'] = 'active'
  ): ManagedProject {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO pm_projects(
        id, project_name, customer_name, contract_amount, risk_factor,
        delivery_reminder_days, planned_delivery_date, sales_owner,
        technical_owner, development_owner, estimated_cost,
        estimated_duration_days, lifecycle, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.projectName.trim(),
      input.customerName?.trim() ?? '',
      Number(input.contractAmount ?? 0),
      Number(input.riskFactor ?? 0),
      Math.max(0, Math.trunc(input.deliveryReminderDays ?? 0)),
      input.plannedDeliveryDate?.trim() ?? '',
      input.salesOwner?.trim() ?? '',
      input.technicalOwner?.trim() ?? '',
      input.developmentOwner?.trim() ?? '',
      Math.max(0, Number(input.estimatedCost ?? 0)),
      Math.max(0, Math.trunc(input.estimatedDurationDays ?? 0)),
      lifecycle,
      source,
      timestamp,
      timestamp
    )
    const estimatedCost = Number(input.estimatedCost ?? 0)
    if (estimatedCost > 0) {
      this.insertProjectCostEntry(id, {
        type: 'estimated',
        category: '项目预估',
        description: '项目创建时的预计成本',
        amount: estimatedCost,
        occurredAt: timestamp
      })
    }
    return this.getManagedProject(id) as ManagedProject
  }

  updateManagedProject(id: string, input: ManagedProjectInput): ManagedProject | null {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE pm_projects SET
        project_name = ?, customer_name = ?, contract_amount = ?, risk_factor = ?,
        delivery_reminder_days = ?, planned_delivery_date = ?, sales_owner = ?,
        technical_owner = ?, development_owner = ?, estimated_duration_days = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      input.projectName.trim(),
      input.customerName?.trim() ?? '',
      Number(input.contractAmount ?? 0),
      Number(input.riskFactor ?? 0),
      Math.max(0, Math.trunc(input.deliveryReminderDays ?? 0)),
      input.plannedDeliveryDate?.trim() ?? '',
      input.salesOwner?.trim() ?? '',
      input.technicalOwner?.trim() ?? '',
      input.developmentOwner?.trim() ?? '',
      Math.max(0, Math.trunc(input.estimatedDurationDays ?? 0)),
      timestamp,
      id
    )
    return Number(result.changes) ? this.getManagedProject(id) : null
  }

  listManagedProjects(query: ManagedProjectListQuery): ManagedProjectPage {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)))
    const search = query.search?.trim() ?? ''
    const where = search ? 'WHERE p.project_name LIKE ? OR p.customer_name LIKE ?' : ''
    const params = search ? [`%${search}%`, `%${search}%`] : []
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM pm_projects p ${where}`).get(...params) as SqlRow).count)
    const rows = this.db.prepare(`
      ${this.managedProjectSelect()}
      ${where}
      ORDER BY p.updated_at DESC, p.project_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return { rows: rows.map((row) => this.mapManagedProject(row)), total }
  }

  getManagedProject(id: string): ManagedProject | null {
    const row = this.db.prepare(`${this.managedProjectSelect()} WHERE p.id = ?`).get(id) as SqlRow | undefined
    return row ? this.mapManagedProject(row) : null
  }

  listOrganizationPeople(query: OrganizationPersonListQuery): OrganizationPersonPage {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 20)))
    const search = query.search?.trim() ?? ''
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (search) {
      conditions.push('(name LIKE ? OR employee_no LIKE ? OR department LIKE ? OR role LIKE ?)')
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
    }
    if (query.status) {
      conditions.push('status = ?')
      params.push(query.status)
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS count FROM org_people ${where}`).get(...params) as SqlRow).count)
    const rows = this.db.prepare(`
      SELECT * FROM org_people
      ${where}
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return { rows: rows.map((row) => this.mapOrganizationPerson(row)), total }
  }

  getOrganizationPerson(id: string): OrganizationPerson | null {
    const row = this.db.prepare('SELECT * FROM org_people WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapOrganizationPerson(row) : null
  }

  createOrganizationPerson(input: OrganizationPersonInput, id = randomUUID()): OrganizationPerson {
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO org_people(
        id, name, employee_no, department, role, hourly_rate, status, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name.trim(),
      input.employeeNo?.trim() ?? '',
      input.department?.trim() ?? '',
      input.role?.trim() ?? '',
      Math.max(0, Number(input.hourlyRate ?? 0)),
      input.status ?? 'active',
      input.notes?.trim() ?? '',
      timestamp,
      timestamp
    )
    return this.getOrganizationPerson(id) as OrganizationPerson
  }

  updateOrganizationPerson(id: string, input: OrganizationPersonInput): OrganizationPerson | null {
    const result = this.db.prepare(`
      UPDATE org_people SET
        name = ?, employee_no = ?, department = ?, role = ?, hourly_rate = ?,
        status = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.name.trim(),
      input.employeeNo?.trim() ?? '',
      input.department?.trim() ?? '',
      input.role?.trim() ?? '',
      Math.max(0, Number(input.hourlyRate ?? 0)),
      input.status ?? 'active',
      input.notes?.trim() ?? '',
      nowIso(),
      id
    )
    return Number(result.changes) ? this.getOrganizationPerson(id) : null
  }

  deleteOrganizationPerson(id: string): { ok: boolean; message: string } {
    const participantCount = Number((this.db.prepare(
      'SELECT COUNT(*) AS count FROM pm_project_participants WHERE person_id = ?'
    ).get(id) as SqlRow).count)
    if (participantCount > 0) return { ok: false, message: '该人员已绑定项目，请先解除项目参与关系' }
    const result = this.db.prepare('DELETE FROM org_people WHERE id = ?').run(id)
    return Number(result.changes)
      ? { ok: true, message: '组织人员已删除' }
      : { ok: false, message: '组织人员不存在' }
  }

  private mapOrganizationPerson(row: SqlRow): OrganizationPerson {
    return {
      id: String(row.id),
      name: String(row.name ?? ''),
      employeeNo: String(row.employee_no ?? ''),
      department: String(row.department ?? ''),
      role: String(row.role ?? ''),
      hourlyRate: Number(row.hourly_rate ?? 0),
      status: String(row.status ?? 'active') as OrganizationPerson['status'],
      notes: String(row.notes ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  updateManagedProjectState(
    id: string,
    patch: Partial<Pick<ManagedProject, 'lifecycle' | 'analysisStatus' | 'analysisMessage' | 'matchStatus' | 'matchMessage'>>
  ): ManagedProject | null {
    const fields: string[] = []
    const values: Array<string | number> = []
    const add = (field: string, value: string): void => {
      fields.push(`${field} = ?`)
      values.push(value)
    }
    if (patch.lifecycle !== undefined) add('lifecycle', patch.lifecycle)
    if (patch.analysisStatus !== undefined) add('analysis_status', patch.analysisStatus)
    if (patch.analysisMessage !== undefined) add('analysis_message', patch.analysisMessage)
    if (patch.matchStatus !== undefined) add('match_status', patch.matchStatus)
    if (patch.matchMessage !== undefined) add('match_message', patch.matchMessage)
    if (!fields.length) return this.getManagedProject(id)
    fields.push('updated_at = ?')
    values.push(nowIso(), id)
    this.db.prepare(`UPDATE pm_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    return this.getManagedProject(id)
  }

  saveProjectAnalysisProgress(progress: ProjectAnalysisProgress): void {
    const timestamp = nowIso()
    const existingRun = this.db.prepare(
      'SELECT task_type FROM pm_analysis_runs WHERE id = ?'
    ).get(progress.taskId) as SqlRow | undefined
    const taskType = existingRun?.task_type === 'matching' || progress.phase === 'matching' ? 'matching' : 'agreement'
    this.db.prepare(`
      INSERT INTO pm_analysis_runs(
        id, project_id, task_type, phase, status, current_count, total_count,
        message, output_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase = excluded.phase, status = excluded.status,
        current_count = excluded.current_count, total_count = excluded.total_count,
        message = excluded.message, updated_at = excluded.updated_at
    `).run(
      progress.taskId, progress.projectId, taskType, progress.phase, progress.status,
      progress.current, progress.total, progress.message, timestamp, timestamp
    )
    this.db.prepare(`
      INSERT INTO pm_analysis_logs(
        id, task_id, project_id, task_type, phase, status, current_count, total_count,
        message, detail, document_id, file_name, log_kind, request_id, batch_number,
        attempt, elapsed_ms, input_chars, output_chars, done_reason, model_name, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      progress.taskId,
      progress.projectId,
      taskType,
      progress.phase,
      progress.status,
      Math.max(0, Math.trunc(progress.current)),
      Math.max(0, Math.trunc(progress.total)),
      progress.message,
      progress.detail ?? '',
      progress.documentId ?? '',
      progress.fileName ?? '',
      progress.logKind ?? 'stage',
      progress.requestId ?? '',
      progress.batchNumber ?? '',
      Math.max(0, Math.trunc(Number(progress.attempt ?? 0))),
      Math.max(0, Math.trunc(Number(progress.elapsedMs ?? 0))),
      Math.max(0, Math.trunc(Number(progress.inputChars ?? 0))),
      Math.max(0, Math.trunc(Number(progress.outputChars ?? 0))),
      progress.doneReason ?? '',
      progress.modelName ?? '',
      timestamp
    )
  }

  listProjectAnalysisLogs(projectId: string, limit = 2000): ProjectAnalysisLogEntry[] {
    const safeLimit = Math.min(5000, Math.max(1, Math.trunc(Number(limit) || 2000)))
    const rows = this.db.prepare(`
      SELECT * FROM pm_analysis_logs
      WHERE project_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `).all(projectId, safeLimit) as SqlRow[]
    return rows.map((row): ProjectAnalysisLogEntry => {
      const logKind = String(row.log_kind ?? 'stage') === 'model_request' ? 'model_request' : 'stage'
      return {
        id: String(row.id),
        taskId: String(row.task_id),
        projectId: String(row.project_id),
        taskType: String(row.task_type ?? 'agreement') === 'matching' ? 'matching' : 'agreement',
        phase: String(row.phase ?? 'queued') as ProjectAnalysisLogEntry['phase'],
        message: String(row.message ?? ''),
        detail: String(row.detail ?? ''),
        ...(String(row.document_id ?? '').trim() ? { documentId: String(row.document_id) } : {}),
        ...(String(row.file_name ?? '').trim() ? { fileName: String(row.file_name) } : {}),
        logKind,
        ...(String(row.request_id ?? '').trim() ? { requestId: String(row.request_id) } : {}),
        ...(String(row.batch_number ?? '').trim() ? { batchNumber: String(row.batch_number) } : {}),
        ...(Number(row.attempt ?? 0) > 0 ? { attempt: Number(row.attempt) } : {}),
        ...(logKind === 'model_request' || Number(row.elapsed_ms ?? 0) > 0 ? { elapsedMs: Number(row.elapsed_ms ?? 0) } : {}),
        ...(logKind === 'model_request' || Number(row.input_chars ?? 0) > 0 ? { inputChars: Number(row.input_chars ?? 0) } : {}),
        ...(logKind === 'model_request' || Number(row.output_chars ?? 0) > 0 ? { outputChars: Number(row.output_chars ?? 0) } : {}),
        ...(String(row.done_reason ?? '').trim() ? { doneReason: String(row.done_reason) } : {}),
        ...(String(row.model_name ?? '').trim() ? { modelName: String(row.model_name) } : {}),
        current: Number(row.current_count ?? 0),
        total: Number(row.total_count ?? 0),
        status: String(row.status ?? 'running') as ProjectAnalysisLogEntry['status'],
        createdAt: String(row.created_at ?? '')
      }
    })
  }

  reconcileInterruptedProjectAnalysis(): number {
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE pm_projects SET
          analysis_status = CASE WHEN analysis_status = 'processing' THEN 'failed' ELSE analysis_status END,
          analysis_message = CASE WHEN analysis_status = 'processing' THEN '上次协议解析因应用退出而中断，请重新执行' ELSE analysis_message END,
          match_status = CASE WHEN match_status = 'processing' THEN 'failed' ELSE match_status END,
          match_message = CASE WHEN match_status = 'processing' THEN '上次需求匹配因应用退出而中断，请重新执行' ELSE match_message END,
          updated_at = ?
        WHERE analysis_status = 'processing' OR match_status = 'processing'
      `).run(timestamp)
      this.db.prepare(`
        UPDATE pm_analysis_runs SET status = 'failed', message = message || '（应用退出中断）', updated_at = ?
        WHERE status = 'running'
      `).run(timestamp)
      this.db.prepare(`
        UPDATE pm_analysis_logs SET status = 'failed', message = message || '（应用退出中断）'
        WHERE status = 'running'
      `).run()
      this.db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteManagedProject(id: string): { ok: boolean; message: string } {
    const normalizedId = id.trim()
    if (!normalizedId) return { ok: false, message: '项目标识不能为空' }
    const exists = this.db.prepare('SELECT id FROM pm_projects WHERE id = ?').get(normalizedId) as SqlRow | undefined
    if (!exists) return { ok: false, message: '项目不存在' }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Project-owned tables use ON DELETE CASCADE. The linked knowledge document
      // and data-center records are shared resources, so only their project links
      // and project-scoped analysis rows are removed here.
      const result = this.db.prepare('DELETE FROM pm_projects WHERE id = ?').run(normalizedId)
      if (!Number(result.changes)) {
        this.db.exec('ROLLBACK')
        return { ok: false, message: '项目不存在' }
      }
      this.db.exec('COMMIT')
      return { ok: true, message: '项目及其项目数据已删除' }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listManagedProjectDocuments(projectId: string): ProjectDocumentSnapshot[] {
    return (this.db.prepare(`
      SELECT d.*, pd.version, pd.is_current, pd.linked_at
      FROM pm_project_documents pd
      JOIN knowledge_documents d ON d.id = pd.document_id
      WHERE pd.project_id = ?
      ORDER BY pd.version DESC, d.created_at DESC
    `).all(projectId) as SqlRow[]).map((row): ProjectDocumentSnapshot => ({
      id: String(row.id),
      fileName: String(row.file_name ?? ''),
      filePath: String(row.file_path ?? ''),
      extension: String(row.extension ?? ''),
      mimeType: String(row.mime_type ?? 'application/octet-stream'),
      byteSize: Number(row.byte_size ?? 0),
      sha256: String(row.sha256 ?? ''),
      tags: parseJsonArray(row.tags_json),
      status: String(row.status ?? 'queued'),
      errorMessage: String(row.error_message ?? ''),
      chunkCount: Number(row.chunk_count ?? 0),
      pageCount: Number(row.page_count ?? 0),
      modelVersion: String(row.model_version ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      processedAt: String(row.processed_at ?? ''),
      version: Number(row.version ?? 1),
      isCurrent: Number(row.is_current ?? 0) === 1,
      linkedAt: String(row.linked_at ?? '')
    }))
  }

  exportManagedProjectSnapshot(projectId: string): ProjectDataSnapshot | null {
    const project = this.getManagedProject(projectId)
    if (!project) return null
    const rawProject = this.db.prepare('SELECT estimated_cost FROM pm_projects WHERE id = ?').get(projectId) as SqlRow | undefined
    const documents = (this.db.prepare(`
      SELECT d.*, pd.version, pd.is_current, pd.linked_at
      FROM pm_project_documents pd
      JOIN knowledge_documents d ON d.id = pd.document_id
      WHERE pd.project_id = ?
      ORDER BY pd.version ASC, d.created_at ASC
    `).all(projectId) as SqlRow[]).map((row): ProjectDocumentSnapshot => ({
      id: String(row.id),
      fileName: String(row.file_name ?? ''),
      filePath: String(row.file_path ?? ''),
      extension: String(row.extension ?? ''),
      mimeType: String(row.mime_type ?? 'application/octet-stream'),
      byteSize: Number(row.byte_size ?? 0),
      sha256: String(row.sha256 ?? ''),
      tags: parseJsonArray(row.tags_json),
      status: String(row.status ?? 'queued'),
      errorMessage: String(row.error_message ?? ''),
      chunkCount: Number(row.chunk_count ?? 0),
      pageCount: Number(row.page_count ?? 0),
      modelVersion: String(row.model_version ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      processedAt: String(row.processed_at ?? ''),
      version: Number(row.version ?? 1),
      isCurrent: Number(row.is_current ?? 0) === 1,
      linkedAt: String(row.linked_at ?? '')
    }))
    const people = (this.db.prepare(`
      SELECT op.*
      FROM org_people op
      JOIN pm_project_participants pp ON pp.person_id = op.id
      WHERE pp.project_id = ?
      GROUP BY op.id
      ORDER BY op.name COLLATE NOCASE ASC
    `).all(projectId) as SqlRow[]).map((row) => this.mapOrganizationPerson(row))
    const matches = (this.db.prepare(`
      SELECT m.*, r.name AS record_name, r.node_type, r.item_id, r.normalized_text,
             CASE WHEN a.record_uid IS NULL THEN 0 ELSE 1 END AS asset_linked,
             CASE WHEN ar.requirement_id IS NULL THEN 0 ELSE 1 END AS requirement_linked
      FROM pm_requirement_matches m
      JOIN pm_requirements q ON q.id = m.requirement_id
      LEFT JOIN records r ON r.uid = m.record_uid
      LEFT JOIN pm_project_assets a ON a.project_id = ? AND a.record_uid = m.record_uid
      LEFT JOIN pm_project_asset_requirements ar
        ON ar.project_id = ? AND ar.record_uid = m.record_uid AND ar.requirement_id = m.requirement_id
      WHERE q.project_id = ?
      ORDER BY q.requirement_no ASC, m.final_score DESC, m.record_uid ASC
    `).all(projectId, projectId, projectId) as SqlRow[]).map((row): ProjectRequirementMatch => ({
      requirementId: String(row.requirement_id),
      recordUid: String(row.record_uid),
      recordName: String(row.record_name ?? ''),
      nodeType: String(row.node_type ?? ''),
      itemId: String(row.item_id ?? ''),
      description: String(row.normalized_text ?? ''),
      vectorScore: Number(row.vector_score ?? 0),
      ...(row.ai_score === null || row.ai_score === undefined ? {} : { aiScore: Number(row.ai_score) }),
      finalScore: Number(row.final_score ?? 0),
      scoreSource: String(row.score_source ?? 'vector') === 'ai' ? 'ai' : 'vector',
      reason: String(row.reason ?? ''),
      bestChunkId: String(row.best_chunk_id ?? ''),
      assetLinked: Number(row.asset_linked ?? 0) === 1,
      requirementLinked: Number(row.requirement_linked ?? 0) === 1
    }))
    return {
      format: 'visslm-project',
      version: 1,
      exportedAt: nowIso(),
      project: {
        ...project,
        baseEstimatedCost: Number(rawProject?.estimated_cost ?? 0)
      },
      documents,
      people,
      participants: this.listProjectParticipants(projectId),
      costs: this.listProjectCostEntries(projectId),
      assets: this.listProjectAssets(projectId),
      tasks: this.listProjectTasks(projectId),
      requirements: this.listAllProjectRequirements(projectId),
      matches
    }
  }

  importManagedProjectSnapshot(snapshot: ProjectDataSnapshot): { projectId: string; warnings: string[] } {
    if (snapshot.format !== 'visslm-project' || snapshot.version !== 1) {
      throw new Error('项目数据文件格式或版本不受支持')
    }
    const sourceProject = snapshot.project
    if (!sourceProject || !String(sourceProject.projectName ?? '').trim()) {
      throw new Error('项目数据文件缺少项目名称')
    }
    const warnings: string[] = []
    const projectId = randomUUID()
    const timestamp = nowIso()
    const peopleMap = new Map<string, string>()
    const documentMap = new Map<string, string>()
    const requirementMap = new Map<string, string>()
    const participantMap = new Map<string, string>()
    const taskMap = new Map<string, string>()
    const validValue = <T extends string>(value: unknown, values: readonly T[], fallback: T): T => {
      const normalized = String(value ?? '') as T
      return values.includes(normalized) ? normalized : fallback
    }
    const sourceTimestamp = (value: string | undefined): string => value?.trim() || timestamp
    const recordExists = (recordUid: string): boolean => Boolean(
      this.db.prepare('SELECT uid FROM records WHERE uid = ?').get(recordUid)
    )

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO pm_projects(
          id, project_name, customer_name, contract_amount, risk_factor,
          delivery_reminder_days, planned_delivery_date, sales_owner,
          technical_owner, development_owner, estimated_cost, actual_cost,
          estimated_duration_days, lifecycle, source, analysis_status,
          analysis_message, match_status, match_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        String(sourceProject.projectName).trim(),
        String(sourceProject.customerName ?? '').trim(),
        Number(sourceProject.contractAmount ?? 0),
        Number(sourceProject.riskFactor ?? 0),
        Math.max(0, Math.trunc(Number(sourceProject.deliveryReminderDays ?? 0))),
        String(sourceProject.plannedDeliveryDate ?? '').trim(),
        String(sourceProject.salesOwner ?? '').trim(),
        String(sourceProject.technicalOwner ?? '').trim(),
        String(sourceProject.developmentOwner ?? '').trim(),
        Math.max(0, Number(sourceProject.baseEstimatedCost ?? 0)),
        Math.max(0, Number(sourceProject.actualCost ?? 0)),
        Math.max(0, Math.trunc(Number(sourceProject.estimatedDurationDays ?? 0))),
        validValue(sourceProject.lifecycle, ['draft', 'active'] as const, 'draft'),
        validValue(sourceProject.source, ['manual', 'technical_agreement'] as const, 'manual'),
        validValue(sourceProject.analysisStatus, ['idle', 'processing', 'ready', 'failed'] as const, 'idle'),
        String(sourceProject.analysisMessage ?? ''),
        validValue(sourceProject.matchStatus, ['idle', 'processing', 'ready', 'stale', 'failed'] as const, 'idle'),
        String(sourceProject.matchMessage ?? ''),
        sourceTimestamp(sourceProject.createdAt),
        timestamp
      )

      for (const person of snapshot.people ?? []) {
        const sourcePersonId = String(person.id ?? '').trim()
        const name = String(person.name ?? '').trim()
        if (!sourcePersonId || !name) {
          warnings.push('跳过一条缺少人员标识或姓名的组织人员')
          continue
        }
        if (peopleMap.has(sourcePersonId)) continue
        const existing = this.db.prepare('SELECT name, employee_no FROM org_people WHERE id = ?').get(sourcePersonId) as SqlRow | undefined
        const targetPersonId = existing && (String(existing.name) !== name || String(existing.employee_no ?? '') !== String(person.employeeNo ?? ''))
          ? randomUUID()
          : sourcePersonId
        if (!existing || targetPersonId !== sourcePersonId) {
          this.db.prepare(`
            INSERT INTO org_people(
              id, name, employee_no, department, role, hourly_rate, status, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            targetPersonId,
            name,
            String(person.employeeNo ?? '').trim(),
            String(person.department ?? '').trim(),
            String(person.role ?? '').trim(),
            Math.max(0, Number(person.hourlyRate ?? 0)),
            validValue(person.status, ['active', 'inactive'] as const, 'active'),
            String(person.notes ?? '').trim(),
            sourceTimestamp(person.createdAt),
            timestamp
          )
        }
        peopleMap.set(sourcePersonId, targetPersonId)
      }

      const insertImportedDocument = (document: ProjectDocumentSnapshot, forcedId?: string): string => {
        const sourceDocumentId = String(document.id ?? '').trim()
        if (sourceDocumentId && documentMap.has(sourceDocumentId)) return documentMap.get(sourceDocumentId) as string
        const existingById = sourceDocumentId
          ? this.db.prepare('SELECT id FROM knowledge_documents WHERE id = ?').get(sourceDocumentId) as SqlRow | undefined
          : undefined
        const existingByHash = document.sha256
          ? this.db.prepare('SELECT id FROM knowledge_documents WHERE sha256 = ?').get(document.sha256) as SqlRow | undefined
          : undefined
        const targetDocumentId = String(existingById?.id ?? existingByHash?.id ?? forcedId ?? randomUUID())
        if (!existingById && !existingByHash) {
          const sha256 = String(document.sha256 ?? '').trim() || randomUUID()
          this.db.prepare(`
            INSERT INTO knowledge_documents(
              id, file_name, file_path, extension, mime_type, byte_size, sha256,
              tags_json, status, error_message, chunk_count, page_count,
              model_version, created_at, updated_at, processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            targetDocumentId,
            String(document.fileName ?? '').trim() || '导入的技术协议',
            String(document.filePath ?? ''),
            String(document.extension ?? '').trim(),
            String(document.mimeType ?? 'application/octet-stream'),
            Math.max(0, Number(document.byteSize ?? 0)),
            sha256,
            JSON.stringify(Array.isArray(document.tags) ? document.tags.map(String).filter(Boolean) : []),
            validValue(document.status, ['queued', 'processing', 'ready', 'failed'] as const, 'failed'),
            String(document.errorMessage ?? ''),
            Math.max(0, Math.trunc(Number(document.chunkCount ?? 0))),
            Math.max(0, Math.trunc(Number(document.pageCount ?? 0))),
            String(document.modelVersion ?? ''),
            sourceTimestamp(document.createdAt),
            timestamp,
            String(document.processedAt ?? '')
          )
          warnings.push(`已恢复协议“${String(document.fileName ?? '未命名协议')}”的索引元数据，原始附件未随 JSON 快照复制`)
        }
        if (sourceDocumentId) documentMap.set(sourceDocumentId, targetDocumentId)
        return targetDocumentId
      }

      for (const document of snapshot.documents ?? []) insertImportedDocument(document)
      let fallbackDocumentId: string | null = null
      const getFallbackDocumentId = (): string => {
        if (fallbackDocumentId) return fallbackDocumentId
        fallbackDocumentId = insertImportedDocument({
          id: '__imported-missing-document__',
          fileName: `${String(sourceProject.projectName).trim()}（协议元数据）`,
          filePath: '',
          extension: '',
          mimeType: 'application/octet-stream',
          byteSize: 0,
          sha256: randomUUID(),
          tags: ['project-import'],
          status: 'failed',
          errorMessage: '导入快照未提供原始协议文件',
          chunkCount: 0,
          pageCount: 0,
          modelVersion: '',
          createdAt: timestamp,
          updatedAt: timestamp,
          processedAt: '',
          version: 1,
          isCurrent: true,
          linkedAt: timestamp
        })
        return fallbackDocumentId
      }
      for (const document of snapshot.documents ?? []) {
        const targetDocumentId = documentMap.get(String(document.id ?? '').trim())
        if (!targetDocumentId) continue
        this.db.prepare(`
          INSERT INTO pm_project_documents(project_id, document_id, version, is_current, linked_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(project_id, document_id) DO UPDATE SET
            version = excluded.version, is_current = excluded.is_current, linked_at = excluded.linked_at
        `).run(projectId, targetDocumentId, Math.max(1, Number(document.version ?? 1)), document.isCurrent ? 1 : 0, sourceTimestamp(document.linkedAt))
      }
      const hasLinkedDocument = (snapshot.documents ?? []).some((document) => documentMap.has(String(document.id ?? '').trim()))
      if (!hasLinkedDocument) {
        this.db.prepare(`
          INSERT INTO pm_project_documents(project_id, document_id, version, is_current, linked_at)
          VALUES (?, ?, 1, 1, ?)
        `).run(projectId, getFallbackDocumentId(), timestamp)
      }

      for (const requirement of snapshot.requirements ?? []) {
        const sourceRequirementId = String(requirement.id ?? '').trim()
        const targetRequirementId = randomUUID()
        const targetDocumentId = documentMap.get(String(requirement.documentId ?? '').trim()) ?? getFallbackDocumentId()
        if (!documentMap.has(String(requirement.documentId ?? '').trim())) {
          warnings.push(`需求“${String(requirement.title ?? '未命名需求')}”未找到协议引用，已挂载到导入协议元数据`)
        }
        this.db.prepare(`
          INSERT INTO pm_requirements(
            id, project_id, document_id, set_id, version, requirement_no, category, module, title, content,
            key_info_terms_json, key_info_terms_source, source_location, source_chunk_id,
            evidence_quote, confidence, review_status, review_note,
            status, status_source, status_reason, highest_match_score, match_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetRequirementId,
          projectId,
          targetDocumentId,
          '',
          Math.max(1, Math.trunc(Number(requirement.version ?? 1))),
          Math.max(1, Math.trunc(Number(requirement.requirementNo ?? 0))),
          validValue(requirement.category, ['functional', 'interface', 'data', 'performance', 'security', 'deployment', 'operations', 'acceptance', 'business'] as const, 'functional'),
          String(requirement.module ?? '').trim(),
          String(requirement.title ?? '').trim() || '未命名需求',
          String(requirement.content ?? '').trim(),
          JSON.stringify(Array.isArray(requirement.keyInfoTerms) ? requirement.keyInfoTerms.map(String).filter(Boolean) : []),
          validValue(requirement.keyInfoTermsSource, ['ai', 'manual'] as const, 'ai'),
          String(requirement.sourceLocation ?? ''),
          String(requirement.sourceChunkId ?? ''),
          String(requirement.evidenceQuote ?? ''),
          Math.max(0, Math.min(1, Number(requirement.confidence ?? 1))),
          'approved',
          String(requirement.reviewNote ?? ''),
          validValue(requirement.status, ['unmarked', 'satisfied', 'to_develop', 'to_negotiate'] as const, 'unmarked'),
          validValue(requirement.statusSource, ['ai', 'manual'] as const, 'ai'),
          String(requirement.statusReason ?? ''),
          Math.max(0, Number(requirement.highestMatchScore ?? 0)),
          Math.max(0, Math.trunc(Number(requirement.matchCount ?? 0))),
          sourceTimestamp(requirement.createdAt),
          timestamp
        )
        if (sourceRequirementId) requirementMap.set(sourceRequirementId, targetRequirementId)
      }

      for (const participant of snapshot.participants ?? []) {
        const targetPersonId = peopleMap.get(String(participant.personId ?? '').trim())
        if (!targetPersonId) {
          warnings.push(`跳过参与人“${String(participant.personName ?? '未命名人员')}”：未找到组织人员`)
          continue
        }
        const sourceParticipantId = String(participant.id ?? '').trim()
        const targetParticipantId = randomUUID()
        try {
          this.db.prepare(`
            INSERT INTO pm_project_participants(
              id, project_id, person_id, hourly_rate, start_date, end_date,
              duration_days, estimated_cost, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            targetParticipantId,
            projectId,
            targetPersonId,
            Math.max(0, Number(participant.hourlyRate ?? 0)),
            String(participant.startDate ?? ''),
            String(participant.endDate ?? ''),
            Math.max(0, Math.trunc(Number(participant.durationDays ?? 0))),
            Math.max(0, Number(participant.estimatedCost ?? 0)),
            String(participant.notes ?? ''),
            sourceTimestamp(participant.createdAt),
            timestamp
          )
          if (sourceParticipantId) participantMap.set(sourceParticipantId, targetParticipantId)
        } catch (error) {
          if (String(error).includes('UNIQUE')) warnings.push(`跳过重复项目参与人“${String(participant.personName ?? '未命名人员')}”`)
          else throw error
        }
      }

      for (const task of snapshot.tasks ?? []) {
        const sourceTaskId = String(task.id ?? '').trim()
        if (sourceTaskId && !taskMap.has(sourceTaskId)) taskMap.set(sourceTaskId, randomUUID())
      }
      for (const task of snapshot.tasks ?? []) {
        const targetTaskId = taskMap.get(String(task.id ?? '').trim()) ?? randomUUID()
        const sourceParentId = String(task.parentTaskId ?? '').trim()
        const targetParentId = sourceParentId ? taskMap.get(sourceParentId) : undefined
        if (sourceParentId && !targetParentId) warnings.push(`任务“${String(task.title ?? '未命名任务')}”的父任务不存在，已移动到顶层`)
        const targetOwnerId = task.ownerPersonId ? peopleMap.get(String(task.ownerPersonId).trim()) : undefined
        if (task.ownerPersonId && !targetOwnerId) warnings.push(`任务“${String(task.title ?? '未命名任务')}”的负责人不存在，已清空负责人`)
        this.db.prepare(`
          INSERT INTO pm_project_tasks(
            id, project_id, task_type, title, description, parent_task_id,
            start_date, end_date, owner_person_id, status, progress_percent,
            sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetTaskId,
          projectId,
          validValue(task.taskType, ['milestone', 'phase', 'task'] as const, 'task'),
          String(task.title ?? '').trim() || '未命名任务',
          String(task.description ?? ''),
          targetParentId ?? null,
          String(task.startDate ?? ''),
          String(task.endDate ?? ''),
          targetOwnerId ?? null,
          validValue(task.status, ['not_started', 'in_progress', 'completed', 'blocked'] as const, 'not_started'),
          Math.min(100, Math.max(0, Number(task.progressPercent ?? 0))),
          Math.max(0, Math.trunc(Number(task.sortOrder ?? 0))),
          sourceTimestamp(task.createdAt),
          timestamp
        )
        for (const linkedRequirement of task.requirements ?? []) {
          const sourceRequirementId = String(linkedRequirement.requirementId ?? '').trim()
          const targetRequirementId = requirementMap.get(sourceRequirementId)
          if (!targetRequirementId) {
            warnings.push(`任务“${String(task.title ?? '未命名任务')}”的关联需求未找到对应记录，已跳过`)
            continue
          }
          this.db.prepare(`
            INSERT INTO pm_project_task_requirements(project_id, task_id, requirement_id, linked_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(task_id, requirement_id) DO NOTHING
          `).run(projectId, targetTaskId, targetRequirementId, sourceTimestamp(linkedRequirement.linkedAt || task.updatedAt || task.createdAt))
        }
      }

      const linkedRecordIds = new Set<string>()
      for (const asset of snapshot.assets ?? []) {
        const recordUid = String(asset.recordUid ?? '').trim()
        if (!recordUid || linkedRecordIds.has(recordUid)) continue
        if (!recordExists(recordUid)) {
          warnings.push(`项目资产“${String(asset.name ?? recordUid)}”未找到数据中心记录，已跳过关联`)
          continue
        }
        this.db.prepare(`
          INSERT INTO pm_project_assets(project_id, record_uid, linked_at)
          VALUES (?, ?, ?)
        `).run(projectId, recordUid, sourceTimestamp(asset.linkedAt))
        linkedRecordIds.add(recordUid)
      }

      for (const asset of snapshot.assets ?? []) {
        const recordUid = String(asset.recordUid ?? '').trim()
        if (!recordUid || !linkedRecordIds.has(recordUid)) continue
        for (const linkedRequirement of asset.requirements ?? []) {
          const sourceRequirementId = String(linkedRequirement.requirementId ?? '').trim()
          const targetRequirementId = requirementMap.get(sourceRequirementId)
          if (!targetRequirementId) {
            warnings.push(`项目资产“${String(asset.name ?? recordUid)}”的需求关联未找到对应需求，已跳过`)
            continue
          }
          this.db.prepare(`
            INSERT INTO pm_project_asset_requirements(project_id, record_uid, requirement_id, linked_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(project_id, record_uid, requirement_id) DO NOTHING
          `).run(projectId, recordUid, targetRequirementId, sourceTimestamp(linkedRequirement.linkedAt || asset.linkedAt))
        }
      }

      for (const cost of snapshot.costs ?? []) {
        const targetParticipantId = cost.responsibleParticipantId
          ? participantMap.get(String(cost.responsibleParticipantId).trim())
          : undefined
        const assetRecordUid = cost.assetRecordUid && recordExists(String(cost.assetRecordUid).trim())
          ? String(cost.assetRecordUid).trim()
          : null
        if (cost.assetRecordUid && !assetRecordUid) warnings.push(`成本“${String(cost.description ?? cost.category ?? '未命名成本')}”的资产不存在，已清空资产关联`)
        this.db.prepare(`
          INSERT INTO pm_cost_entries(
            id, project_id, cost_type, category, description, amount,
            occurred_at, created_at, updated_at, asset_record_uid,
            responsible_participant_id, responsible_person_name
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          projectId,
          validValue(cost.type, ['estimated', 'actual'] as const, 'estimated'),
          String(cost.category ?? ''),
          String(cost.description ?? ''),
          Math.max(0, Number(cost.amount ?? 0)),
          String(cost.occurredAt ?? timestamp),
          sourceTimestamp(cost.createdAt),
          timestamp,
          assetRecordUid,
          targetParticipantId ?? null,
          targetParticipantId ? String(cost.responsiblePersonName ?? '') : ''
        )
      }

      for (const match of snapshot.matches ?? []) {
        const targetRequirementId = requirementMap.get(String(match.requirementId ?? '').trim())
        const recordUid = String(match.recordUid ?? '').trim()
        if (!targetRequirementId || !recordUid || !recordExists(recordUid)) {
          if (recordUid && !recordExists(recordUid)) warnings.push(`需求匹配记录“${String(match.recordName ?? recordUid)}”未找到数据中心数据，已跳过`)
          continue
        }
        this.db.prepare(`
          INSERT INTO pm_requirement_matches(
            requirement_id, record_uid, vector_score, ai_score, final_score,
            score_source, reason, best_chunk_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetRequirementId,
          recordUid,
          Number(match.vectorScore ?? 0),
          match.aiScore === undefined ? null : Number(match.aiScore),
          Number(match.finalScore ?? 0),
          match.scoreSource === 'ai' ? 'ai' : 'vector',
          String(match.reason ?? ''),
          String(match.bestChunkId ?? ''),
          timestamp
        )
      }
      this.db.prepare(`
        UPDATE pm_requirements
        SET highest_match_score = COALESCE((SELECT MAX(m.final_score) FROM pm_requirement_matches m WHERE m.requirement_id = pm_requirements.id), 0),
            match_count = (SELECT COUNT(*) FROM pm_requirement_matches m WHERE m.requirement_id = pm_requirements.id)
        WHERE project_id = ?
      `).run(projectId)
      this.refreshProjectCostTotals(projectId)
      for (const task of snapshot.tasks ?? []) {
        const targetTaskId = taskMap.get(String(task.id ?? '').trim())
        if (targetTaskId) this.refreshProjectTaskDates(projectId, targetTaskId)
      }
      this.db.exec('COMMIT')
      return { projectId, warnings }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  discardManagedProjectDraft(id: string): { ok: boolean; message: string } {
    const result = this.db.prepare("DELETE FROM pm_projects WHERE id = ? AND lifecycle = 'draft'").run(id)
    return Number(result.changes)
      ? { ok: true, message: '已放弃项目草稿' }
      : { ok: false, message: '项目不存在或已经确认' }
  }

  clearProjectRequirements(projectId: string): number {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        DELETE FROM pm_requirement_matches
        WHERE requirement_id IN (
          SELECT id FROM pm_requirements WHERE project_id = ?
        )
      `).run(projectId)
      const result = this.db.prepare('DELETE FROM pm_requirements WHERE project_id = ?').run(projectId)
      this.db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  confirmManagedProject(id: string): ManagedProject | null {
    return this.updateManagedProjectState(id, { lifecycle: 'active' })
  }

  linkProjectDocument(projectId: string, documentId: string): void {
    const versionRow = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM pm_project_documents WHERE project_id = ?'
    ).get(projectId) as SqlRow
    this.db.prepare('UPDATE pm_project_documents SET is_current = 0 WHERE project_id = ?').run(projectId)
    this.db.prepare(`
      INSERT INTO pm_project_documents(project_id, document_id, version, is_current, linked_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(project_id, document_id) DO UPDATE SET
        version = excluded.version, is_current = 1, linked_at = excluded.linked_at
    `).run(projectId, documentId, Number(versionRow.version) + 1, nowIso())
  }

  createProjectRequirementSet(input: {
    projectId: string
    documentId: string
    totalChunks: number
    analyzedChunks: number
    warnings: string[]
    externalProcessing: boolean
    modelName: string
  }): ProjectRequirementSetSummary {
    const timestamp = nowIso()
    const versionRow = this.db.prepare(
      'SELECT COALESCE(MAX(version), 0) AS version FROM pm_requirement_sets WHERE project_id = ?'
    ).get(input.projectId) as SqlRow
    const id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        "UPDATE pm_requirement_sets SET status = 'superseded' WHERE project_id = ? AND status = 'reviewing'"
      ).run(input.projectId)
      this.db.prepare(`
        INSERT INTO pm_requirement_sets(
          id, project_id, document_id, version, status, total_chunks, analyzed_chunks,
          warnings_json, external_processing, model_name, created_at, published_at
        ) VALUES (?, ?, ?, ?, 'reviewing', ?, ?, ?, ?, ?, ?, '')
      `).run(
        id,
        input.projectId,
        input.documentId,
        Number(versionRow.version) + 1,
        Math.max(0, Math.trunc(input.totalChunks)),
        Math.max(0, Math.trunc(input.analyzedChunks)),
        JSON.stringify(input.warnings),
        input.externalProcessing ? 1 : 0,
        input.modelName,
        timestamp
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProjectRequirementSetById(id)!
  }

  updateProjectRequirementSetProgress(
    setId: string,
    analyzedChunks: number,
    warnings: string[]
  ): ProjectRequirementSetSummary | null {
    const set = this.getProjectRequirementSetById(setId)
    if (!set || set.status !== 'reviewing') return null
    this.db.prepare(`
      UPDATE pm_requirement_sets
      SET analyzed_chunks = ?, warnings_json = ?
      WHERE id = ? AND status = 'reviewing'
    `).run(
      Math.max(0, Math.trunc(Number(analyzedChunks))),
      JSON.stringify([...new Set(warnings)].slice(0, 100)),
      setId
    )
    return this.getProjectRequirementSetById(setId)
  }

  getReviewProjectRequirementSet(projectId: string): ProjectRequirementSetSummary | null {
    const row = this.db.prepare(`
      SELECT s.*,
        COUNT(q.id) AS requirement_count,
        SUM(CASE WHEN q.review_status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN q.review_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN q.review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
      FROM pm_requirement_sets s
      LEFT JOIN pm_requirements q ON q.set_id = s.id
      WHERE s.project_id = ? AND s.status = 'reviewing'
      GROUP BY s.id
      ORDER BY s.version DESC LIMIT 1
    `).get(projectId) as SqlRow | undefined
    return row ? this.mapProjectRequirementSet(row) : null
  }

  private getProjectRequirementSetById(id: string): ProjectRequirementSetSummary | null {
    const row = this.db.prepare(`
      SELECT s.*,
        COUNT(q.id) AS requirement_count,
        SUM(CASE WHEN q.review_status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN q.review_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN q.review_status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
      FROM pm_requirement_sets s
      LEFT JOIN pm_requirements q ON q.set_id = s.id
      WHERE s.id = ? GROUP BY s.id
    `).get(id) as SqlRow | undefined
    return row ? this.mapProjectRequirementSet(row) : null
  }

  replaceReviewProjectRequirements(
    setId: string,
    projectId: string,
    documentId: string,
    requirements: Array<{
      id: string
      documentId?: string
      requirementNo: number
      category: ProjectRequirementCategory
      module?: string
      title: string
      content: string
      keyInfoTerms?: string[]
      sourceLocation: string
      sourceChunkId: string
      evidenceQuote: string
      confidence: number
    }>
  ): void {
    const set = this.getProjectRequirementSetById(setId)
    if (!set || set.projectId !== projectId || set.status !== 'reviewing') {
      throw new Error('待审核需求版本不存在或已发布')
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirements WHERE set_id = ?').run(setId)
      const insert = this.db.prepare(`
        INSERT INTO pm_requirements(
          id, project_id, document_id, set_id, version, requirement_no, category, module,
          title, content, key_info_terms_json, key_info_terms_source, source_location,
          source_chunk_id, evidence_quote, confidence, review_status, review_note,
          status, status_source, status_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, 'pending', '', 'unmarked', 'ai', '待人工审核', ?, ?)
      `)
      const timestamp = nowIso()
      requirements.forEach((item, index) => insert.run(
        item.id,
        projectId,
        item.documentId ?? documentId,
        setId,
        set.version,
        index + 1,
        item.category,
        item.module ?? '',
        item.title,
        item.content,
        JSON.stringify(item.keyInfoTerms ?? []),
        item.sourceLocation,
        item.sourceChunkId,
        item.evidenceQuote,
        Math.max(0, Math.min(1, item.confidence)),
        timestamp,
        timestamp
      ))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  publishReviewProjectRequirementSet(projectId: string): ProjectRequirementSetSummary {
    const set = this.getReviewProjectRequirementSet(projectId)
    if (!set) throw new Error('当前没有待发布的审核版本')
    if (set.pendingCount > 0) throw new Error(`仍有 ${set.pendingCount} 条需求未完成审核`)
    if (set.approvedCount < 1) throw new Error('至少需要审核通过一条需求后才能发布')
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(
        "UPDATE pm_requirement_sets SET status = 'superseded' WHERE project_id = ? AND status = 'published'"
      ).run(projectId)
      this.db.prepare(`
        UPDATE pm_requirements SET review_status = 'rejected', review_note = ?, updated_at = ?
        WHERE project_id = ? AND set_id = ''
      `).run(`已由需求版本 V${set.version} 替代`, timestamp, projectId)
      this.db.prepare(
        "UPDATE pm_requirement_sets SET status = 'published', published_at = ? WHERE id = ? AND status = 'reviewing'"
      ).run(timestamp, set.id)
      this.db.prepare(`
        DELETE FROM pm_requirement_matches WHERE requirement_id IN (
          SELECT id FROM pm_requirements WHERE project_id = ? AND set_id <> ?
        )
      `).run(projectId, set.id)
      this.db.prepare(`
        UPDATE pm_projects SET analysis_status = 'ready', analysis_message = ?,
          match_status = 'idle', match_message = '审核已发布，等待开始匹配', updated_at = ?
        WHERE id = ?
      `).run(`已发布 V${set.version}，共 ${set.approvedCount} 条审核通过需求`, timestamp, projectId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProjectRequirementSetById(set.id)!
  }

  replaceProjectRequirements(
    projectId: string,
    documentId: string,
    requirements: Array<{
      id: string
      requirementNo: number
      module?: string
      title: string
      content: string
      keyInfoTerms?: string[]
      sourceLocation: string
      sourceChunkId: string
      status?: ProjectRequirementStatus
      statusReason?: string
    }>
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirements WHERE project_id = ?').run(projectId)
      const insert = this.db.prepare(`
        INSERT INTO pm_requirements(
          id, project_id, document_id, requirement_no, module, title, content,
          key_info_terms_json, key_info_terms_source, source_location, source_chunk_id,
          status, status_source, status_reason,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, 'ai', ?, ?, ?)
      `)
      const timestamp = nowIso()
      for (const item of requirements) {
        insert.run(
          item.id,
          projectId,
          documentId,
          item.requirementNo,
          item.module ?? '',
          item.title,
          item.content,
          JSON.stringify(item.keyInfoTerms ?? []),
          item.sourceLocation,
          item.sourceChunkId,
          item.status ?? 'unmarked',
          item.statusReason ?? '',
          timestamp,
          timestamp
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listProjectRequirements(query: ProjectRequirementQuery): ProjectRequirementPage {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize || 20)))
    const reviewSet = query.scope === 'published' ? null : this.getReviewProjectRequirementSet(query.projectId)
    const statusClause = query.status ? ' AND status = ?' : ''
    const where = reviewSet
      ? `project_id = ? AND set_id = ?${statusClause}`
      : `project_id = ? AND review_status = 'approved' AND (
          set_id = '' OR set_id IN (
            SELECT id FROM pm_requirement_sets WHERE project_id = ? AND status = 'published'
          )
        )${statusClause}`
    const params = reviewSet ? [query.projectId, reviewSet.id] : [query.projectId, query.projectId]
    if (query.status) params.push(query.status)
    const total = Number((this.db.prepare(
      `SELECT COUNT(*) AS count FROM pm_requirements WHERE ${where}`
    ).get(...params) as SqlRow).count)
    const rows = this.db.prepare(`
      SELECT * FROM pm_requirements
      WHERE ${where}
      ORDER BY requirement_no ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return { rows: rows.map((row) => this.mapProjectRequirement(row)), total }
  }

  listAllProjectRequirements(projectId: string, scope: ProjectRequirementQuery['scope'] = 'published'): ProjectRequirement[] {
    const reviewSet = scope === 'published' ? null : this.getReviewProjectRequirementSet(projectId)
    const where = reviewSet
      ? 'project_id = ? AND set_id = ?'
      : `project_id = ? AND review_status = 'approved' AND (
          set_id = '' OR set_id IN (
            SELECT id FROM pm_requirement_sets WHERE project_id = ? AND status = 'published'
          )
        )`
    const params = reviewSet ? [projectId, reviewSet.id] : [projectId, projectId]
    const rows = this.db.prepare(`
      SELECT * FROM pm_requirements
      WHERE ${where}
      ORDER BY requirement_no ASC, id ASC
    `).all(...params) as SqlRow[]
    return rows.map((row) => this.mapProjectRequirement(row))
  }

  createReviewProjectRequirement(projectId: string, input: ProjectRequirementInput): ProjectRequirement {
    const set = this.getReviewProjectRequirementSet(projectId)
    if (!set) throw new Error('当前没有待审核需求版本')
    const nextNo = Number((this.db.prepare(
      'SELECT COALESCE(MAX(requirement_no), 0) + 1 AS next_no FROM pm_requirements WHERE set_id = ?'
    ).get(set.id) as SqlRow).next_no)
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO pm_requirements(
        id, project_id, document_id, set_id, version, requirement_no, category, module,
        title, content, key_info_terms_json, key_info_terms_source, source_location,
        source_chunk_id, evidence_quote, confidence, review_status, review_note,
        status, status_source, status_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 'pending', ?, 'unmarked', 'manual', '人工补录，待审核', ?, ?)
    `).run(
      id, projectId, set.documentId, set.id, set.version, nextNo, input.category,
      input.module ?? '', input.title, input.content, JSON.stringify(input.keyInfoTerms ?? []),
      input.sourceLocation ?? '', input.sourceChunkId ?? '', input.evidenceQuote ?? '',
      Math.max(0, Math.min(1, input.confidence ?? 1)), input.reviewNote ?? '', timestamp, timestamp
    )
    return this.getProjectRequirement(id)!
  }

  updateReviewProjectRequirement(id: string, input: ProjectRequirementInput): ProjectRequirement | null {
    const timestamp = nowIso()
    const result = this.db.prepare(`
      UPDATE pm_requirements SET category = ?, module = ?, title = ?, content = ?,
        key_info_terms_json = ?, key_info_terms_source = 'manual', source_location = ?,
        source_chunk_id = ?, evidence_quote = ?, confidence = ?, review_status = 'pending',
        review_note = ?, updated_at = ?
      WHERE id = ? AND set_id IN (SELECT id FROM pm_requirement_sets WHERE status = 'reviewing')
    `).run(
      input.category, input.module ?? '', input.title, input.content,
      JSON.stringify(input.keyInfoTerms ?? []), input.sourceLocation ?? '', input.sourceChunkId ?? '',
      input.evidenceQuote ?? '', Math.max(0, Math.min(1, input.confidence ?? 1)),
      input.reviewNote ?? '', timestamp, id
    )
    return Number(result.changes) ? this.getProjectRequirement(id) : null
  }

  reviewProjectRequirements(ids: string[], status: ProjectRequirementReviewStatus): number {
    const normalized = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    if (!normalized.length) return 0
    const placeholders = normalized.map(() => '?').join(', ')
    const result = this.db.prepare(`
      UPDATE pm_requirements SET review_status = ?, updated_at = ?
      WHERE id IN (${placeholders})
        AND set_id IN (SELECT id FROM pm_requirement_sets WHERE status = 'reviewing')
    `).run(status, nowIso(), ...normalized)
    return Number(result.changes)
  }

  splitReviewProjectRequirement(id: string, input: ProjectRequirementSplitInput): ProjectRequirement[] {
    const current = this.getProjectRequirement(id)
    if (!current || !current.setId || !input.parts.length) return []
    const set = this.getProjectRequirementSetById(current.setId)
    if (!set || set.status !== 'reviewing') return []
    const timestamp = nowIso()
    const createdIds: string[] = []
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirements WHERE id = ?').run(id)
      const insert = this.db.prepare(`
        INSERT INTO pm_requirements(
          id, project_id, document_id, set_id, version, requirement_no, category, module,
          title, content, key_info_terms_json, key_info_terms_source, source_location,
          source_chunk_id, evidence_quote, confidence, review_status, review_note,
          status, status_source, status_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 'pending', ?, 'unmarked', 'manual', '人工拆分，待审核', ?, ?)
      `)
      input.parts.forEach((part, index) => {
        const childId = randomUUID()
        createdIds.push(childId)
        insert.run(
          childId, current.projectId, current.documentId, current.setId, current.version,
          current.requirementNo + index, part.category, part.module ?? current.module,
          part.title, part.content, JSON.stringify(part.keyInfoTerms ?? current.keyInfoTerms),
          part.sourceLocation ?? current.sourceLocation, part.sourceChunkId ?? current.sourceChunkId,
          part.evidenceQuote ?? current.evidenceQuote, Math.max(0, Math.min(1, part.confidence ?? current.confidence)),
          part.reviewNote ?? '', timestamp, timestamp
        )
      })
      this.renumberRequirementSet(current.setId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return createdIds.map((childId) => this.getProjectRequirement(childId)!).filter(Boolean)
  }

  mergeReviewProjectRequirements(input: ProjectRequirementMergeInput): ProjectRequirement | null {
    const ids = [...new Set(input.requirementIds.map((id) => id.trim()).filter(Boolean))]
    if (ids.length < 2) throw new Error('至少选择两条需求进行合并')
    const rows = ids.map((id) => this.getProjectRequirement(id)).filter((item): item is ProjectRequirement => Boolean(item))
    const first = rows[0]
    if (!first || rows.some((item) => item.setId !== first.setId)) throw new Error('只能合并同一审核版本中的需求')
    const set = this.getProjectRequirementSetById(first.setId)
    if (!set || set.status !== 'reviewing') throw new Error('已发布需求不能合并')
    const placeholders = ids.map(() => '?').join(', ')
    const mergedId = randomUUID()
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`DELETE FROM pm_requirements WHERE id IN (${placeholders})`).run(...ids)
      this.db.prepare(`
        INSERT INTO pm_requirements(
          id, project_id, document_id, set_id, version, requirement_no, category, module,
          title, content, key_info_terms_json, key_info_terms_source, source_location,
          source_chunk_id, evidence_quote, confidence, review_status, review_note,
          status, status_source, status_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, 'pending', ?, 'unmarked', 'manual', '人工合并，待审核', ?, ?)
      `).run(
        mergedId, first.projectId, first.documentId, first.setId, first.version,
        Math.min(...rows.map((item) => item.requirementNo)), input.category, input.module ?? '',
        input.title, input.content, JSON.stringify(input.keyInfoTerms ?? []), input.sourceLocation ?? '',
        input.sourceChunkId ?? '', input.evidenceQuote ?? '', Math.max(0, Math.min(1, input.confidence ?? 1)),
        input.reviewNote ?? '', timestamp, timestamp
      )
      this.renumberRequirementSet(first.setId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProjectRequirement(mergedId)
  }

  private renumberRequirementSet(setId: string): void {
    const rows = this.db.prepare(
      'SELECT id FROM pm_requirements WHERE set_id = ? ORDER BY requirement_no ASC, created_at ASC, id ASC'
    ).all(setId) as SqlRow[]
    const update = this.db.prepare('UPDATE pm_requirements SET requirement_no = ? WHERE id = ?')
    rows.forEach((row, index) => update.run(index + 1, String(row.id)))
  }

  deleteProjectRequirement(id: string): { ok: boolean; message: string } {
    const current = this.db.prepare('SELECT id FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return { ok: false, message: '功能需求不存在' }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirement_matches WHERE requirement_id = ?').run(id)
      const result = this.db.prepare('DELETE FROM pm_requirements WHERE id = ?').run(id)
      if (!Number(result.changes)) {
        this.db.exec('ROLLBACK')
        return { ok: false, message: '功能需求不存在' }
      }
      this.db.exec('COMMIT')
      return { ok: true, message: '功能需求已删除，匹配结果已清除' }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private mapProjectRequirement(row: SqlRow): ProjectRequirement {
    const normalizedText = normalizeProjectRequirementText({
      module: row.module,
      title: row.title,
      content: row.content
    })
    const rawStatus = String(row.status ?? 'unmarked')
    const status: ProjectRequirementStatus = ['unmarked', 'satisfied', 'to_develop', 'to_negotiate'].includes(rawStatus)
      ? rawStatus as ProjectRequirementStatus
      : 'unmarked'
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      documentId: String(row.document_id),
      setId: String(row.set_id ?? ''),
      version: Number(row.version ?? 1),
      requirementNo: Number(row.requirement_no ?? 0),
      category: String(row.category ?? 'functional') as ProjectRequirementCategory,
      module: normalizedText.module,
      title: normalizedText.title,
      content: normalizedText.content,
      keyInfoTerms: parseJsonArray(row.key_info_terms_json),
      keyInfoTermsSource: String(row.key_info_terms_source ?? 'ai') === 'manual' ? 'manual' : 'ai',
      sourceLocation: String(row.source_location ?? ''),
      sourceChunkId: String(row.source_chunk_id ?? ''),
      evidenceQuote: String(row.evidence_quote ?? ''),
      confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 1))),
      reviewStatus: String(row.review_status ?? 'approved') as ProjectRequirementReviewStatus,
      reviewNote: String(row.review_note ?? ''),
      status,
      statusSource: String(row.status_source ?? 'ai') as ProjectRequirementStatusSource,
      statusReason: String(row.status_reason ?? ''),
      highestMatchScore: Number(row.highest_match_score ?? 0),
      matchCount: Number(row.match_count ?? 0),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  private mapProjectRequirementSet(row: SqlRow): ProjectRequirementSetSummary {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      documentId: String(row.document_id),
      version: Number(row.version ?? 1),
      status: String(row.status ?? 'reviewing') as ProjectRequirementSetSummary['status'],
      totalChunks: Number(row.total_chunks ?? 0),
      analyzedChunks: Number(row.analyzed_chunks ?? 0),
      warnings: parseJsonArray(row.warnings_json),
      requirementCount: Number(row.requirement_count ?? 0),
      pendingCount: Number(row.pending_count ?? 0),
      approvedCount: Number(row.approved_count ?? 0),
      rejectedCount: Number(row.rejected_count ?? 0),
      createdAt: String(row.created_at ?? ''),
      publishedAt: String(row.published_at ?? '')
    }
  }

  updateProjectRequirementStatus(id: string, status: ProjectRequirementStatus): ProjectRequirement | null {
    const result = this.db.prepare(`
      UPDATE pm_requirements
      SET status = ?, status_source = 'manual', updated_at = ?
      WHERE id = ?
    `).run(status, nowIso(), id)
    if (!Number(result.changes)) return null
    const row = this.db.prepare('SELECT * FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapProjectRequirement(row) : null
  }

  getProjectRequirement(id: string): ProjectRequirement | null {
    const row = this.db.prepare('SELECT * FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapProjectRequirement(row) : null
  }

  updateProjectRequirementKeyInfoTerms(id: string, terms: string[]): ProjectRequirement | null {
    const current = this.db.prepare('SELECT project_id FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return null
    const projectId = String(current.project_id)
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirement_matches WHERE requirement_id = ?').run(id)
      this.db.prepare(`
        UPDATE pm_requirements
        SET key_info_terms_json = ?, key_info_terms_source = 'manual',
            highest_match_score = 0, match_count = 0, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(terms), timestamp, id)
      this.db.prepare(`
        UPDATE pm_projects
        SET match_status = 'stale', match_message = '关键功能信息词已修改，请重新匹配', updated_at = ?
        WHERE id = ?
      `).run(timestamp, projectId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getProjectRequirement(id)
  }

  updateProjectRequirementAiStatus(
    id: string,
    status: ProjectRequirementStatus,
    reason: string
  ): ProjectRequirement | null {
    const result = this.db.prepare(`
      UPDATE pm_requirements
      SET status = ?, status_source = 'ai', status_reason = ?, updated_at = ?
      WHERE id = ? AND status_source <> 'manual'
    `).run(status, reason, nowIso(), id)
    if (!Number(result.changes)) {
      const current = this.db.prepare('SELECT * FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
      return current ? this.mapProjectRequirement(current) : null
    }
    const row = this.db.prepare('SELECT * FROM pm_requirements WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapProjectRequirement(row) : null
  }

  replaceRequirementMatches(
    requirementId: string,
    matches: Array<{
      recordUid: string
      vectorScore: number
      aiScore?: number
      finalScore: number
      scoreSource: 'vector' | 'ai'
      reason: string
      bestChunkId: string
    }>
  ): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM pm_requirement_matches WHERE requirement_id = ?').run(requirementId)
      const insert = this.db.prepare(`
        INSERT INTO pm_requirement_matches(
          requirement_id, record_uid, vector_score, ai_score, final_score,
          score_source, reason, best_chunk_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const timestamp = nowIso()
      for (const match of matches) {
        insert.run(
          requirementId,
          match.recordUid,
          match.vectorScore,
          match.aiScore ?? null,
          match.finalScore,
          match.scoreSource,
          match.reason,
          match.bestChunkId,
          timestamp
        )
      }
      const highest = matches.reduce((value, item) => Math.max(value, item.finalScore), 0)
      this.db.prepare(`
        UPDATE pm_requirements
        SET highest_match_score = ?, match_count = ?, updated_at = ?
        WHERE id = ?
      `).run(highest, matches.length, timestamp, requirementId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  linkRequirementMatchesAboveScore(requirementId: string, minScore: number): number {
    const requirement = this.db.prepare(
      'SELECT id FROM pm_requirements WHERE id = ?'
    ).get(requirementId) as SqlRow | undefined
    if (!requirement) return 0
    const threshold = Math.max(
      0,
      Math.min(100, Number.isFinite(Number(minScore)) ? Number(minScore) : 80)
    )
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO pm_project_assets(project_id, record_uid, linked_at)
        SELECT q.project_id, m.record_uid, ?
        FROM pm_requirement_matches m
        JOIN pm_requirements q ON q.id = m.requirement_id
        JOIN records r ON r.uid = m.record_uid
        WHERE m.requirement_id = ? AND m.final_score >= ?
      `).run(timestamp, requirementId, threshold)
      const linked = this.db.prepare(`
        INSERT OR IGNORE INTO pm_project_asset_requirements(
          project_id, record_uid, requirement_id, linked_at
        )
        SELECT q.project_id, m.record_uid, m.requirement_id, ?
        FROM pm_requirement_matches m
        JOIN pm_requirements q ON q.id = m.requirement_id
        JOIN records r ON r.uid = m.record_uid
        WHERE m.requirement_id = ? AND m.final_score >= ?
      `).run(timestamp, requirementId, threshold)
      this.db.exec('COMMIT')
      return Number(linked.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listProjectRequirementMatches(query: ProjectRequirementMatchQuery): ProjectRequirementMatchPage {
    const page = Math.max(1, Math.floor(query.page || 1))
    const pageSize = Math.min(200, Math.max(1, Math.floor(query.pageSize || 20)))
    const minScore = query.minScore === undefined
      ? -1
      : Math.max(0, Math.min(100, Number.isFinite(Number(query.minScore)) ? Number(query.minScore) : 0))
    const total = Number((this.db.prepare(
      'SELECT COUNT(*) AS count FROM pm_requirement_matches WHERE requirement_id = ? AND final_score > ?'
    ).get(query.requirementId, minScore) as SqlRow).count)
    const rows = this.db.prepare(`
      SELECT m.*, r.uid AS uid, r.name, r.node_type, r.item_id, r.raw_json, r.normalized_text,
             r.last_modify_time, r.project_id, r.parent_id, r.synced_at,
             r.content_hash, r.push_status, r.push_message, r.pushed_at, r.pushed_uid,
             COUNT(i.id) AS image_count,
             CASE WHEN a.record_uid IS NULL THEN 0 ELSE 1 END AS asset_linked,
             CASE WHEN ar.requirement_id IS NULL THEN 0 ELSE 1 END AS requirement_linked
      FROM pm_requirement_matches m
      JOIN records r ON r.uid = m.record_uid
      LEFT JOIN images i ON i.record_uid = r.uid
      JOIN pm_requirements q ON q.id = m.requirement_id
      LEFT JOIN pm_project_assets a ON a.project_id = q.project_id AND a.record_uid = r.uid
      LEFT JOIN pm_project_asset_requirements ar
        ON ar.project_id = q.project_id AND ar.record_uid = r.uid AND ar.requirement_id = m.requirement_id
      WHERE m.requirement_id = ? AND m.final_score > ?
      GROUP BY r.uid, m.requirement_id
      ORDER BY m.final_score DESC, m.record_uid ASC
      LIMIT ? OFFSET ?
    `).all(query.requirementId, minScore, pageSize, (page - 1) * pageSize) as SqlRow[]
    return {
      total,
      rows: rows.map((row) => {
        const record = this.mapRecord(row)
      return {
          requirementId: query.requirementId,
          recordUid: record.uid,
          recordName: record.name,
          nodeType: record.nodeType,
          itemId: record.itemId,
          description: record.description,
          vectorScore: Number(row.vector_score ?? 0),
          ...(row.ai_score === null || row.ai_score === undefined ? {} : { aiScore: Number(row.ai_score) }),
          finalScore: Number(row.final_score ?? 0),
          scoreSource: String(row.score_source ?? 'vector') as ProjectRequirementMatch['scoreSource'],
          reason: String(row.reason ?? ''),
          bestChunkId: String(row.best_chunk_id ?? ''),
          assetLinked: Number(row.asset_linked ?? 0) === 1,
          requirementLinked: Number(row.requirement_linked ?? 0) === 1
        }
      })
    }
  }

  listProjectParticipants(projectId: string): ProjectParticipant[] {
    const rows = this.db.prepare(`
      SELECT pp.*, op.name AS person_name, op.employee_no, op.department, op.role
      FROM pm_project_participants pp
      JOIN org_people op ON op.id = pp.person_id
      WHERE pp.project_id = ?
      ORDER BY pp.start_date ASC, op.name COLLATE NOCASE ASC
    `).all(projectId) as SqlRow[]
    return rows.map((row) => this.mapProjectParticipant(row))
  }

  insertProjectParticipant(projectId: string, input: ProjectParticipantInput, id = randomUUID()): ProjectParticipant {
    const person = this.getOrganizationPerson(input.personId)
    if (!person) throw new Error('组织人员不存在')
    const durationDays = this.calculateCalendarDays(input.startDate, input.endDate)
    if (durationDays < 1) throw new Error('参与人员结束时间不能早于开始时间')
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO pm_project_participants(
        id, project_id, person_id, hourly_rate, start_date, end_date,
        duration_days, estimated_cost, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      person.id,
      person.hourlyRate,
      input.startDate.trim(),
      input.endDate.trim(),
      durationDays,
      durationDays * 8 * person.hourlyRate,
      input.notes?.trim() ?? '',
      timestamp,
      timestamp
    )
    return this.listProjectParticipants(projectId).find((item) => item.id === id) as ProjectParticipant
  }

  updateProjectParticipant(id: string, input: ProjectParticipantInput): ProjectParticipant | null {
    const current = this.db.prepare('SELECT project_id FROM pm_project_participants WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return null
    const person = this.getOrganizationPerson(input.personId)
    if (!person) throw new Error('组织人员不存在')
    const durationDays = this.calculateCalendarDays(input.startDate, input.endDate)
    if (durationDays < 1) throw new Error('参与人员结束时间不能早于开始时间')
    const projectId = String(current.project_id)
    const result = this.db.prepare(`
      UPDATE pm_project_participants SET
        person_id = ?, hourly_rate = ?, start_date = ?, end_date = ?,
        duration_days = ?, estimated_cost = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `).run(
      person.id,
      person.hourlyRate,
      input.startDate.trim(),
      input.endDate.trim(),
      durationDays,
      durationDays * 8 * person.hourlyRate,
      input.notes?.trim() ?? '',
      nowIso(),
      id
    )
    if (!Number(result.changes)) return null
    return this.listProjectParticipants(projectId).find((item) => item.id === id) ?? null
  }

  deleteProjectParticipant(id: string): { ok: boolean; message: string } {
    const result = this.db.prepare('DELETE FROM pm_project_participants WHERE id = ?').run(id)
    return Number(result.changes)
      ? { ok: true, message: '项目参与人员已移除' }
      : { ok: false, message: '项目参与人员不存在' }
  }

  private mapProjectParticipant(row: SqlRow): ProjectParticipant {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      personId: String(row.person_id),
      personName: String(row.person_name ?? ''),
      employeeNo: String(row.employee_no ?? ''),
      department: String(row.department ?? ''),
      role: String(row.role ?? ''),
      hourlyRate: Number(row.hourly_rate ?? 0),
      startDate: String(row.start_date ?? ''),
      endDate: String(row.end_date ?? ''),
      durationDays: Number(row.duration_days ?? 0),
      estimatedCost: Number(row.estimated_cost ?? 0),
      notes: String(row.notes ?? ''),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  listProjectTasks(projectId: string): ProjectPlanTask[] {
    const rows = this.db.prepare(`
      SELECT pt.*, op.name AS owner_name
      FROM pm_project_tasks pt
      LEFT JOIN org_people op ON op.id = pt.owner_person_id
      WHERE pt.project_id = ?
      ORDER BY pt.sort_order ASC, pt.start_date ASC, pt.created_at ASC
    `).all(projectId) as SqlRow[]
    const requirementRows = this.db.prepare(`
      SELECT tr.task_id, tr.linked_at, q.id AS requirement_id,
             q.requirement_no, q.title, q.status
      FROM pm_project_task_requirements tr
      JOIN pm_requirements q ON q.id = tr.requirement_id
      WHERE tr.project_id = ? AND q.project_id = ?
      ORDER BY q.requirement_no ASC, q.title COLLATE NOCASE ASC
    `).all(projectId, projectId) as SqlRow[]
    const requirementsByTask = new Map<string, ProjectPlanTaskRequirement[]>()
    for (const row of requirementRows) {
      const taskId = String(row.task_id ?? '')
      const requirements = requirementsByTask.get(taskId) ?? []
      requirements.push({
        requirementId: String(row.requirement_id ?? ''),
        requirementNo: Number(row.requirement_no ?? 0),
        title: String(row.title ?? ''),
        status: String(row.status ?? 'unmarked') as ProjectPlanTaskRequirement['status'],
        linkedAt: String(row.linked_at ?? '')
      })
      requirementsByTask.set(taskId, requirements)
    }
    const tasks = rows.map((row) => this.mapProjectPlanTask(row, requirementsByTask.get(String(row.id)) ?? []))
    const taskMap = new Map(tasks.map((task) => [task.id, task]))
    const childrenMap = new Map<string, ProjectPlanTask[]>()
    for (const task of tasks) {
      if (!task.parentTaskId || !taskMap.has(task.parentTaskId)) continue
      const children = childrenMap.get(task.parentTaskId) ?? []
      children.push(task)
      childrenMap.set(task.parentTaskId, children)
    }
    const ordered: ProjectPlanTask[] = []
    const visited = new Set<string>()
    const visit = (task: ProjectPlanTask, depth: number): void => {
      if (visited.has(task.id)) return
      visited.add(task.id)
      const children = childrenMap.get(task.id) ?? []
      ordered.push({ ...task, depth, hasChildren: children.length > 0 })
      for (const child of children) visit(child, depth + 1)
    }
    for (const task of tasks) {
      if (!task.parentTaskId || !taskMap.has(task.parentTaskId)) visit(task, 0)
    }
    for (const task of tasks) visit(task, 0)
    return ordered
  }

  getProjectTask(id: string): ProjectPlanTask | null {
    const row = this.db.prepare('SELECT project_id FROM pm_project_tasks WHERE id = ?').get(id) as SqlRow | undefined
    if (!row) return null
    return this.listProjectTasks(String(row.project_id)).find((task) => task.id === id) ?? null
  }

  insertProjectTask(projectId: string, input: ProjectPlanTaskInput, id = randomUUID()): ProjectPlanTask {
    const durationDays = this.calculateCalendarDays(input.startDate, input.endDate)
    if (durationDays < 1) throw new Error('任务结束时间不能早于开始时间')
    const parentTaskId = input.parentTaskId?.trim() || null
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO pm_project_tasks(
          id, project_id, task_type, title, description, parent_task_id,
          start_date, end_date, owner_person_id, status, progress_percent,
          sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        projectId,
        input.taskType,
        input.title.trim(),
        input.description?.trim() ?? '',
        parentTaskId,
        input.startDate.trim(),
        input.endDate.trim(),
        input.ownerPersonId?.trim() || null,
        input.status ?? 'not_started',
        Math.min(100, Math.max(0, Number(input.progressPercent ?? 0))),
        Math.max(0, Math.trunc(Number(input.sortOrder ?? 0))),
        timestamp,
        timestamp
      )
      this.replaceProjectTaskRequirements(projectId, id, input.requirementIds ?? [], timestamp)
      this.refreshProjectTaskDates(projectId, parentTaskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listProjectTasks(projectId).find((item) => item.id === id) as ProjectPlanTask
  }

  updateProjectTask(id: string, input: ProjectPlanTaskInput): ProjectPlanTask | null {
    const current = this.db.prepare('SELECT project_id, parent_task_id FROM pm_project_tasks WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return null
    const durationDays = this.calculateCalendarDays(input.startDate, input.endDate)
    if (durationDays < 1) throw new Error('任务结束时间不能早于开始时间')
    const projectId = String(current.project_id)
    const previousParentTaskId = current.parent_task_id ? String(current.parent_task_id) : null
    const parentTaskId = input.parentTaskId?.trim() || null
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE pm_project_tasks SET
          task_type = ?, title = ?, description = ?, parent_task_id = ?,
          start_date = ?, end_date = ?, owner_person_id = ?, status = ?,
          progress_percent = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.taskType,
        input.title.trim(),
        input.description?.trim() ?? '',
        parentTaskId,
        input.startDate.trim(),
        input.endDate.trim(),
        input.ownerPersonId?.trim() || null,
        input.status ?? 'not_started',
        Math.min(100, Math.max(0, Number(input.progressPercent ?? 0))),
        Math.max(0, Math.trunc(Number(input.sortOrder ?? 0))),
        timestamp,
        id
      )
      if (!Number(result.changes)) {
        this.db.exec('ROLLBACK')
        return null
      }
      this.replaceProjectTaskRequirements(projectId, id, input.requirementIds ?? [], timestamp)
      this.refreshProjectTaskDates(projectId, id)
      this.refreshProjectTaskDates(projectId, previousParentTaskId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.listProjectTasks(projectId).find((item) => item.id === id) ?? null
  }

  moveProjectTask(id: string, input: ProjectPlanTaskMoveInput): ProjectPlanTask | null {
    const current = this.db.prepare('SELECT project_id, parent_task_id FROM pm_project_tasks WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return null
    const projectId = String(current.project_id)
    const previousParentTaskId = current.parent_task_id ? String(current.parent_task_id) : null
    const parentTaskId = input.parentTaskId?.trim() || null
    const sortOrder = Math.max(0, Math.trunc(Number(input.sortOrder ?? 0)))
    const listSiblingIds = (parentId: string | null): string[] => {
      const rows = parentId
        ? this.db.prepare(`SELECT id FROM pm_project_tasks WHERE project_id = ? AND parent_task_id = ? ORDER BY sort_order ASC, start_date ASC, created_at ASC`).all(projectId, parentId) as SqlRow[]
        : this.db.prepare(`SELECT id FROM pm_project_tasks WHERE project_id = ? AND parent_task_id IS NULL ORDER BY sort_order ASC, start_date ASC, created_at ASC`).all(projectId) as SqlRow[]
      return rows.map((row) => String(row.id)).filter((taskId) => taskId !== id)
    }
    const destinationSiblings = listSiblingIds(parentTaskId)
    const destinationOrder = [...destinationSiblings]
    destinationOrder.splice(Math.min(sortOrder, destinationOrder.length), 0, id)
    const previousOrder = listSiblingIds(previousParentTaskId)
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (previousParentTaskId !== parentTaskId) {
        this.db.prepare(`
          UPDATE pm_project_tasks
          SET parent_task_id = ?, sort_order = ?, updated_at = ?
          WHERE id = ? AND project_id = ?
        `).run(parentTaskId, destinationOrder.indexOf(id), timestamp, id, projectId)
        previousOrder.forEach((taskId, index) => {
          this.db.prepare('UPDATE pm_project_tasks SET sort_order = ? WHERE id = ? AND project_id = ?').run(index, taskId, projectId)
        })
      }
      destinationOrder.forEach((taskId, index) => {
        this.db.prepare('UPDATE pm_project_tasks SET sort_order = ?, updated_at = ? WHERE id = ? AND project_id = ?').run(index, timestamp, taskId, projectId)
      })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    this.refreshProjectTaskDates(projectId, id)
    this.refreshProjectTaskDates(projectId, previousParentTaskId)
    return this.listProjectTasks(projectId).find((item) => item.id === id) ?? null
  }

  deleteProjectTask(id: string): { ok: boolean; message: string } {
    const current = this.db.prepare('SELECT project_id, parent_task_id FROM pm_project_tasks WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return { ok: false, message: '项目计划任务不存在' }
    const projectId = String(current.project_id)
    const parentTaskId = current.parent_task_id ? String(current.parent_task_id) : null
    this.db.prepare('DELETE FROM pm_project_task_requirements WHERE task_id = ?').run(id)
    const result = this.db.prepare('DELETE FROM pm_project_tasks WHERE id = ?').run(id)
    this.refreshProjectTaskDates(projectId, parentTaskId)
    return Number(result.changes)
      ? { ok: true, message: '项目计划任务已删除' }
      : { ok: false, message: '项目计划任务不存在' }
  }

  private mapProjectPlanTask(row: SqlRow, requirements: ProjectPlanTaskRequirement[] = []): ProjectPlanTask {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      taskType: String(row.task_type ?? 'task') as ProjectPlanTask['taskType'],
      title: String(row.title ?? ''),
      description: String(row.description ?? ''),
      ...(row.parent_task_id ? { parentTaskId: String(row.parent_task_id) } : {}),
      startDate: String(row.start_date ?? ''),
      endDate: String(row.end_date ?? ''),
      ...(row.owner_person_id ? { ownerPersonId: String(row.owner_person_id) } : {}),
      ...(row.owner_name ? { ownerName: String(row.owner_name) } : {}),
      status: String(row.status ?? 'not_started') as ProjectPlanTask['status'],
      progressPercent: Number(row.progress_percent ?? 0),
      sortOrder: Number(row.sort_order ?? 0),
      depth: 0,
      hasChildren: false,
      requirements,
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  private replaceProjectTaskRequirements(
    projectId: string,
    taskId: string,
    requirementIds: string[],
    linkedAt: string
  ): void {
    const normalizedIds = [...new Set(requirementIds.map((id) => String(id).trim()).filter(Boolean))]
    if (normalizedIds.length) {
      const placeholders = normalizedIds.map(() => '?').join(', ')
      const rows = this.db.prepare(`
        SELECT id
        FROM pm_requirements
        WHERE project_id = ? AND id IN (${placeholders})
      `).all(projectId, ...normalizedIds) as SqlRow[]
      const validIds = new Set(rows.map((row) => String(row.id)))
      const invalidId = normalizedIds.find((id) => !validIds.has(id))
      if (invalidId) throw new Error('计划任务关联的需求不存在或不属于当前项目')
    }
    this.db.prepare('DELETE FROM pm_project_task_requirements WHERE project_id = ? AND task_id = ?').run(projectId, taskId)
    const insert = this.db.prepare(`
      INSERT INTO pm_project_task_requirements(project_id, task_id, requirement_id, linked_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const requirementId of normalizedIds) insert.run(projectId, taskId, requirementId, linkedAt)
  }

  private refreshProjectTaskDates(projectId: string, taskId: string | null): void {
    if (!taskId) return
    const visited = new Set<string>()
    let currentTaskId: string | null = taskId
    while (currentTaskId && !visited.has(currentTaskId)) {
      visited.add(currentTaskId)
      const aggregate = this.db.prepare(`
        SELECT COUNT(*) AS count, MIN(start_date) AS start_date, MAX(end_date) AS end_date
        FROM pm_project_tasks
        WHERE parent_task_id = ? AND project_id = ?
      `).get(currentTaskId, projectId) as SqlRow
      if (Number(aggregate.count ?? 0) > 0 && aggregate.start_date && aggregate.end_date) {
        this.db.prepare(`
          UPDATE pm_project_tasks
          SET start_date = ?, end_date = ?, updated_at = ?
          WHERE id = ? AND project_id = ?
        `).run(String(aggregate.start_date), String(aggregate.end_date), nowIso(), currentTaskId, projectId)
      }
      const parent = this.db.prepare('SELECT parent_task_id FROM pm_project_tasks WHERE id = ? AND project_id = ?').get(currentTaskId, projectId) as SqlRow | undefined
      currentTaskId = parent?.parent_task_id ? String(parent.parent_task_id) : null
    }
  }

  private calculateCalendarDays(startDate: string, endDate: string): number {
    const start = Date.parse(`${startDate.trim()}T00:00:00Z`)
    const end = Date.parse(`${endDate.trim()}T00:00:00Z`)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
    return Math.floor((end - start) / 86_400_000) + 1
  }

  listProjectCostEntries(projectId: string): ProjectCostEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM pm_cost_entries
      WHERE project_id = ?
      ORDER BY occurred_at DESC, created_at DESC
    `).all(projectId) as SqlRow[]
    return rows.map((row) => this.mapProjectCostEntry(row))
  }

  getProjectCostEntry(id: string): ProjectCostEntry | null {
    const row = this.db.prepare('SELECT * FROM pm_cost_entries WHERE id = ?').get(id) as SqlRow | undefined
    return row ? this.mapProjectCostEntry(row) : null
  }

  private mapProjectCostEntry(row: SqlRow): ProjectCostEntry {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      type: String(row.cost_type) as ProjectCostEntry['type'],
      category: String(row.category ?? ''),
      description: String(row.description ?? ''),
      amount: Number(row.amount ?? 0),
      occurredAt: String(row.occurred_at ?? ''),
      ...(row.asset_record_uid ? { assetRecordUid: String(row.asset_record_uid) } : {}),
      ...(row.responsible_participant_id ? { responsibleParticipantId: String(row.responsible_participant_id) } : {}),
      ...(row.responsible_person_name ? { responsiblePersonName: String(row.responsible_person_name) } : {}),
      createdAt: String(row.created_at ?? ''),
      updatedAt: String(row.updated_at ?? '')
    }
  }

  insertProjectCostEntry(projectId: string, input: ProjectCostEntryInput, id = randomUUID()): ProjectCostEntry {
    const timestamp = nowIso()
    const responsible = this.resolveProjectCostResponsible(projectId, input.responsibleParticipantId)
    this.db.prepare(`
      INSERT INTO pm_cost_entries(
        id, project_id, cost_type, category, description, amount,
        occurred_at, created_at, updated_at, asset_record_uid,
        responsible_participant_id, responsible_person_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      projectId,
      input.type,
      input.category.trim(),
      input.description?.trim() ?? '',
      Math.max(0, Number(input.amount ?? 0)),
      input.occurredAt?.trim() || timestamp,
      timestamp,
      timestamp,
      input.assetRecordUid?.trim() || null,
      responsible.participantId,
      responsible.personName
    )
    this.refreshProjectCostTotals(projectId)
    return this.getProjectCostEntry(id) ?? this.mapProjectCostEntry({ id, project_id: projectId, ...input, cost_type: input.type, occurred_at: timestamp, created_at: timestamp, updated_at: timestamp, responsible_participant_id: responsible.participantId, responsible_person_name: responsible.personName })
  }

  updateProjectCostEntry(id: string, input: ProjectCostEntryInput): ProjectCostEntry | null {
    const current = this.db.prepare('SELECT project_id FROM pm_cost_entries WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return null
    const projectId = String(current.project_id)
    const responsible = this.resolveProjectCostResponsible(projectId, input.responsibleParticipantId)
    const result = this.db.prepare(`
      UPDATE pm_cost_entries SET
        cost_type = ?, category = ?, description = ?, amount = ?,
        occurred_at = ?, updated_at = ?, asset_record_uid = ?,
        responsible_participant_id = ?, responsible_person_name = ?
      WHERE id = ?
    `).run(
      input.type,
      input.category.trim(),
      input.description?.trim() ?? '',
      Math.max(0, Number(input.amount ?? 0)),
      input.occurredAt?.trim() || nowIso(),
      nowIso(),
      input.assetRecordUid?.trim() || null,
      responsible.participantId,
      responsible.personName,
      id
    )
    if (!Number(result.changes)) return null
    this.refreshProjectCostTotals(projectId)
    return this.mapProjectCostEntry(this.db.prepare('SELECT * FROM pm_cost_entries WHERE id = ?').get(id) as SqlRow)
  }

  private resolveProjectCostResponsible(projectId: string, participantId?: string): { participantId: string | null; personName: string } {
    const normalizedId = participantId?.trim()
    if (!normalizedId) return { participantId: null, personName: '' }
    const row = this.db.prepare(`
      SELECT pp.id, op.name
      FROM pm_project_participants pp
      JOIN org_people op ON op.id = pp.person_id
      WHERE pp.id = ? AND pp.project_id = ?
    `).get(normalizedId, projectId) as SqlRow | undefined
    if (!row) return { participantId: null, personName: '' }
    return { participantId: String(row.id), personName: String(row.name ?? '') }
  }

  deleteProjectCostEntry(id: string): { ok: boolean; message: string } {
    const current = this.db.prepare('SELECT project_id FROM pm_cost_entries WHERE id = ?').get(id) as SqlRow | undefined
    if (!current) return { ok: false, message: '成本明细不存在' }
    const projectId = String(current.project_id)
    this.db.prepare('DELETE FROM pm_cost_entries WHERE id = ?').run(id)
    this.refreshProjectCostTotals(projectId)
    return { ok: true, message: '成本明细已删除' }
  }

  private refreshProjectCostTotals(projectId: string): void {
    this.db.prepare(`
      UPDATE pm_projects SET
        estimated_cost = COALESCE((SELECT SUM(amount) FROM pm_cost_entries WHERE project_id = ? AND cost_type = 'estimated'), 0),
        actual_cost = COALESCE((SELECT SUM(amount) FROM pm_cost_entries WHERE project_id = ? AND cost_type = 'actual'), 0),
        updated_at = ?
      WHERE id = ?
    `).run(projectId, projectId, nowIso(), projectId)
  }

  listProjectAssets(projectId: string): ProjectAsset[] {
    const rows = this.db.prepare(`
      SELECT a.project_id, a.record_uid, a.linked_at, r.uid AS uid, r.name, r.node_type, r.item_id,
             r.raw_json, r.normalized_text, r.last_modify_time, r.project_id AS source_project_id,
             r.parent_id, r.synced_at, r.content_hash, r.push_status, r.push_message,
             r.pushed_at, r.pushed_uid, COUNT(i.id) AS image_count
      FROM pm_project_assets a
      JOIN records r ON r.uid = a.record_uid
      LEFT JOIN images i ON i.record_uid = r.uid
      WHERE a.project_id = ?
      GROUP BY r.uid
      ORDER BY a.linked_at DESC, r.name ASC
    `).all(projectId) as SqlRow[]
    const requirementRows = this.db.prepare(`
      SELECT ar.record_uid, ar.linked_at, q.id AS requirement_id,
             q.requirement_no, q.title, m.final_score AS match_score
      FROM pm_project_asset_requirements ar
      JOIN pm_requirements q ON q.id = ar.requirement_id
      LEFT JOIN pm_requirement_matches m
        ON m.requirement_id = ar.requirement_id AND m.record_uid = ar.record_uid
      WHERE ar.project_id = ?
      ORDER BY q.requirement_no ASC, q.title COLLATE NOCASE ASC
    `).all(projectId) as SqlRow[]
    const requirementsByRecord = new Map<string, ProjectAsset['requirements']>()
    for (const row of requirementRows) {
      const recordUid = String(row.record_uid ?? '')
      const requirements = requirementsByRecord.get(recordUid) ?? []
      requirements.push({
        requirementId: String(row.requirement_id ?? ''),
        requirementNo: Number(row.requirement_no ?? 0),
        title: String(row.title ?? ''),
        linkedAt: String(row.linked_at ?? ''),
        ...(row.match_score === null || row.match_score === undefined ? {} : { matchScore: Number(row.match_score) })
      })
      requirementsByRecord.set(recordUid, requirements)
    }
    return rows.map((row) => {
      const record = this.mapRecord(row)
      return {
        projectId,
        recordUid: record.uid,
        name: record.name,
        nodeType: record.nodeType,
        itemId: record.itemId,
        description: record.description,
        linkedAt: String(row.linked_at ?? ''),
        requirements: requirementsByRecord.get(record.uid) ?? []
      }
    })
  }

  linkProjectAsset(projectId: string, recordUid: string, requirementId?: string): ProjectAsset | null {
    const exists = this.db.prepare('SELECT uid FROM records WHERE uid = ?').get(recordUid)
    if (!exists) return null
    if (requirementId) {
      const requirement = this.db.prepare(
        'SELECT id FROM pm_requirements WHERE id = ? AND project_id = ?'
      ).get(requirementId, projectId)
      if (!requirement) return null
    }
    this.db.prepare(`
      INSERT INTO pm_project_assets(project_id, record_uid, linked_at)
      VALUES (?, ?, ?)
      ON CONFLICT(project_id, record_uid) DO NOTHING
    `).run(projectId, recordUid, nowIso())
    if (requirementId) {
      this.db.prepare(`
        INSERT INTO pm_project_asset_requirements(project_id, record_uid, requirement_id, linked_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, record_uid, requirement_id) DO NOTHING
      `).run(projectId, recordUid, requirementId, nowIso())
    }
    return this.listProjectAssets(projectId).find((asset) => asset.recordUid === recordUid) ?? null
  }

  unlinkProjectAssetRequirement(projectId: string, recordUid: string, _requirementId: string): { ok: boolean; message: string } {
    const result = this.db.prepare(`
      DELETE FROM pm_project_assets
      WHERE project_id = ? AND record_uid = ?
    `).run(projectId, recordUid)
    return Number(result.changes)
      ? { ok: true, message: '当前需求已取消数据关联' }
      : { ok: false, message: '当前需求与数据的关联不存在' }
  }

  unlinkProjectAsset(projectId: string, recordUid: string): { ok: boolean; message: string } {
    this.db.prepare(
      'DELETE FROM pm_project_asset_requirements WHERE project_id = ? AND record_uid = ?'
    ).run(projectId, recordUid)
    const result = this.db.prepare(
      'DELETE FROM pm_project_assets WHERE project_id = ? AND record_uid = ?'
    ).run(projectId, recordUid)
    return Number(result.changes)
      ? { ok: true, message: '项目资产已取消关联' }
      : { ok: false, message: '项目资产关联不存在' }
  }

  markManagedProjectMatchesStale(): void {
    this.db.prepare(`
      UPDATE pm_projects
      SET match_status = CASE WHEN match_status = 'processing' THEN match_status ELSE 'stale' END,
          match_message = '数据中心已更新，请重新匹配',
          updated_at = ?
      WHERE EXISTS (SELECT 1 FROM pm_requirements q WHERE q.project_id = pm_projects.id)
    `).run(nowIso())
  }

  getAnalyticsRevision(): number {
    const value = Number(this.getSetting('analytics:data-revision') ?? 0)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  bumpAnalyticsRevision(): number {
    const next = this.getAnalyticsRevision() + 1
    this.setSetting('analytics:data-revision', String(next))
    this.db.prepare('DELETE FROM query_cache WHERE data_revision < ?').run(next)
    this.statsCache = null
    return next
  }

  replaceFieldDefinitions(definitions: FieldDefinition[]): boolean {
    const grouped = new Map<string, Map<string, FieldDefinition>>()
    for (const definition of definitions) {
      const nodeType = String(definition.nodeType ?? '').trim()
      const field = String(definition.field ?? '').trim()
      const displayName = String(definition.displayName ?? '').trim()
      if (!nodeType || !field || !displayName) continue
      const fields = grouped.get(nodeType) ?? new Map<string, FieldDefinition>()
      const sourceType = String(definition.sourceType ?? '').trim().slice(0, 120)
      fields.set(field, {
        nodeType,
        field,
        displayName: displayName.slice(0, 200),
        sourceType,
        normalizedType: normalizeStoredFieldDefinitionType(sourceType, definition.normalizedType),
        attrType: String(definition.attrType ?? '').trim().slice(0, 200),
        sourceUid: String(definition.sourceUid ?? '').trim().slice(0, 240),
        internalMember: String(definition.internalMember ?? '').trim().slice(0, 240),
        conditionUid: String(definition.conditionUid ?? '').trim().slice(0, 240),
        isSystem: storedFieldDefinitionBoolean(definition.isSystem),
        isEditable: storedFieldDefinitionBoolean(definition.isEditable),
        isRemovable: storedFieldDefinitionBoolean(definition.isRemovable)
      })
      grouped.set(nodeType, fields)
    }
    if (!grouped.size) return false

    const existing = new Map(
      this.getFieldDefinitions([...grouped.keys()]).map((definition) => [
        `${definition.nodeType}\u0000${definition.field}`,
        definition
      ])
    )
    const comparable = (definition: FieldDefinition): string => JSON.stringify([
      definition.nodeType,
      definition.field,
      definition.displayName,
      definition.sourceType,
      definition.normalizedType,
      definition.attrType,
      definition.sourceUid,
      definition.internalMember,
      definition.conditionUid,
      definition.isSystem,
      definition.isEditable,
      definition.isRemovable
    ])
    const incoming = new Map(
      [...grouped.values()].flatMap((fields) => [...fields.values()]).map((definition) => [
        `${definition.nodeType}\u0000${definition.field}`,
        definition
      ])
    )
    const changed = incoming.size !== existing.size || [...incoming].some(([key, definition]) => {
      const previous = existing.get(key)
      return !previous || comparable(previous) !== comparable(definition)
    })
    if (!changed) return false

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const deleteDefinitions = this.db.prepare(
        'DELETE FROM field_definitions WHERE node_type = ?'
      )
      const insertDefinition = this.db.prepare(`
        INSERT INTO field_definitions(
          node_type, field, display_name, source_type, normalized_type, attr_type,
          source_uid, internal_member, condition_uid, is_system, is_editable,
          is_removable, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const updatedAt = nowIso()
      for (const [nodeType, fields] of grouped) {
        deleteDefinitions.run(nodeType)
        for (const definition of fields.values()) {
          insertDefinition.run(
            nodeType,
            definition.field,
            definition.displayName,
            definition.sourceType,
            definition.normalizedType,
            definition.attrType,
            definition.sourceUid,
            definition.internalMember,
            definition.conditionUid,
            definition.isSystem ? 1 : 0,
            definition.isEditable ? 1 : 0,
            definition.isRemovable ? 1 : 0,
            updatedAt
          )
        }
      }
      const nodeTypes = [...grouped.keys()]
      for (const nodeType of nodeTypes) this.fieldDefinitionFingerprintCache.delete(nodeType)
      const placeholders = nodeTypes.map(() => '?').join(', ')
      const affectedRows = this.db.prepare(`
        SELECT uid, name, node_type, last_modify_time, raw_json, normalized_text, semantic_hash
        FROM records
        WHERE node_type IN (${placeholders})
      `).all(...nodeTypes) as SqlRow[]
      const updateSemanticHash = this.db.prepare(
        'UPDATE records SET semantic_hash = ? WHERE uid = ?'
      )
      for (const row of affectedRows) {
        const semanticHash = requirementSemanticSourceHash({
          name: String(row.name ?? ''),
          lastModifyTime: String(row.last_modify_time ?? ''),
          rawJson: String(row.raw_json ?? '{}'),
          normalizedText: String(row.normalized_text ?? ''),
          fieldLabels: this.getFieldDisplayNames(String(row.node_type ?? ''))
        })
        if (semanticHash === String(row.semantic_hash ?? '')) continue
        updateSemanticHash.run(semanticHash, String(row.uid))
        this.syncRequirementSearchIndex(String(row.uid))
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getFieldDefinitions(
    nodeType: string | string[],
    fields?: string[]
  ): FieldDefinition[] {
    const nodeTypes = [...new Set(
      (Array.isArray(nodeType) ? nodeType : [nodeType])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
    )]
    const requestedFields = [...new Set(
      (fields ?? [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
    )]
    const conditions: string[] = []
    const params: string[] = []
    if (nodeTypes.length) {
      conditions.push(`node_type IN (${nodeTypes.map(() => '?').join(', ')})`)
      params.push(...nodeTypes)
    }
    if (requestedFields.length) {
      conditions.push(`field IN (${requestedFields.map(() => '?').join(', ')})`)
      params.push(...requestedFields)
    }
    const rows = this.db.prepare(`
      SELECT node_type, field, display_name, source_type, normalized_type, attr_type,
             source_uid, internal_member, condition_uid, is_system, is_editable,
             is_removable, updated_at
      FROM field_definitions
      WHERE ${conditions.length ? conditions.join(' AND ') : '1 = 1'}
      ORDER BY node_type ASC, field ASC
    `).all(...params) as SqlRow[]
    return rows.map(mapFieldDefinitionRow)
  }

  private getFieldDefinitionFingerprint(nodeType: string): string {
    const normalizedNodeType = nodeType.trim()
    if (!normalizedNodeType) return ''
    const cached = this.fieldDefinitionFingerprintCache.get(normalizedNodeType)
    if (cached !== undefined) return cached
    const definitions = this.getFieldDefinitions(normalizedNodeType).map((definition) => ({
      field: definition.field,
      displayName: definition.displayName,
      sourceType: definition.sourceType,
      normalizedType: definition.normalizedType,
      attrType: definition.attrType,
      sourceUid: definition.sourceUid,
      internalMember: definition.internalMember,
      conditionUid: definition.conditionUid,
      isSystem: definition.isSystem,
      isEditable: definition.isEditable,
      isRemovable: definition.isRemovable
    }))
    const fingerprint = definitions.length
      ? createHash('sha256').update(JSON.stringify(definitions)).digest('hex')
      : ''
    this.fieldDefinitionFingerprintCache.set(normalizedNodeType, fingerprint)
    return fingerprint
  }

  getFieldDisplayNames(
    nodeType: string | string[],
    fields?: string[]
  ): Record<string, string> {
    const nodeTypes = [...new Set(
      (Array.isArray(nodeType) ? nodeType : [nodeType])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
    )]
    const requestedFields = [...new Set(
      (fields ?? [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
    )]
    const labels: Record<string, string> = {}
    for (const currentNodeType of nodeTypes.length ? nodeTypes : [null]) {
      const conditions: string[] = []
      const params: string[] = []
      if (currentNodeType !== null) {
        conditions.push('node_type = ?')
        params.push(currentNodeType)
      }
      if (requestedFields.length) {
        conditions.push(`field IN (${requestedFields.map(() => '?').join(', ')})`)
      }
      if (requestedFields.length) params.push(...requestedFields)
      const rows = this.db.prepare(`
        SELECT field, display_name
        FROM field_definitions
        WHERE ${conditions.length ? conditions.join(' AND ') : '1 = 1'}
        ORDER BY node_type ASC, field ASC
      `).all(...params) as SqlRow[]
      for (const row of rows) {
        const field = String(row.field ?? '').trim()
        const displayName = String(row.display_name ?? '').trim()
        if (field && displayName && !Object.prototype.hasOwnProperty.call(labels, field)) {
          labels[field] = displayName
        }
      }
    }
    return labels
  }

  getFieldProfiles(scopeKey: string, dataRevision: number): FieldProfile[] | null {
    const rows = this.db.prepare(`
      SELECT field, inferred_type, non_null_rate, distinct_count, samples_json,
             display_name, role, synonyms_json, sensitivity, profiled_at
      FROM field_profiles
      WHERE scope_key = ? AND data_revision = ?
      ORDER BY non_null_rate DESC, field ASC
    `).all(scopeKey, dataRevision) as SqlRow[]
    return rows.length ? rows.map(mapFieldProfileRow) : null
  }

  saveFieldProfiles(
    scopeKey: string,
    dataRevision: number,
    profiles: FieldProfile[]
  ): void {
    const profiledAt = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const upsert = this.db.prepare(`
        INSERT INTO field_profiles(
          scope_key, field, inferred_type, non_null_rate, distinct_count,
          samples_json, display_name, role, synonyms_json, sensitivity, profiled_at, data_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, field) DO UPDATE SET
          inferred_type = excluded.inferred_type,
          non_null_rate = excluded.non_null_rate,
          distinct_count = excluded.distinct_count,
          samples_json = excluded.samples_json,
          display_name = CASE
            WHEN field_profiles.display_name <> '' THEN field_profiles.display_name
            ELSE excluded.display_name
          END,
          role = CASE
            WHEN field_profiles.role <> '' THEN field_profiles.role
            ELSE excluded.role
          END,
          synonyms_json = CASE
            WHEN field_profiles.synonyms_json <> '[]' THEN field_profiles.synonyms_json
            ELSE excluded.synonyms_json
          END,
          sensitivity = CASE
            WHEN field_profiles.sensitivity <> 'normal' THEN field_profiles.sensitivity
            ELSE excluded.sensitivity
          END,
          profiled_at = excluded.profiled_at,
          data_revision = excluded.data_revision
      `)
      for (const profile of profiles) {
        upsert.run(
          scopeKey,
          profile.field,
          profile.inferredType,
          profile.nonNullRate,
          profile.distinctCount,
          JSON.stringify(profile.samples.slice(0, 5)),
          profile.displayName ?? '',
          profile.role ?? '',
          JSON.stringify((profile.synonyms ?? []).slice(0, 12)),
          profile.sensitivity ?? 'normal',
          profiledAt,
          dataRevision
        )
      }
      this.db.prepare(
        'DELETE FROM field_profiles WHERE scope_key = ? AND data_revision <> ?'
      ).run(scopeKey, dataRevision)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  updateFieldProfileSemantics(
    scopeKey: string,
    field: string,
    patch: FieldProfileSemanticPatch
  ): FieldProfile | null {
    const normalizedField = field.trim()
    const row = this.db.prepare(`
      SELECT field, inferred_type, non_null_rate, distinct_count, samples_json,
             display_name, role, synonyms_json, sensitivity, profiled_at
      FROM field_profiles
      WHERE scope_key = ? AND field = ?
    `).get(scopeKey, normalizedField) as SqlRow | undefined
    if (!row) return null

    const updates: string[] = []
    const params: Array<string | number> = []
    if (patch.displayName !== undefined) {
      if (typeof patch.displayName !== 'string') throw new Error('字段显示名必须是文本')
      updates.push('display_name = ?')
      params.push(patch.displayName.trim().slice(0, 80))
    }
    if (patch.role !== undefined) {
      if (!fieldProfileRoles.has(patch.role)) throw new Error('字段语义角色无效')
      updates.push('role = ?')
      params.push(patch.role)
    }
    if (patch.synonyms !== undefined) {
      if (!Array.isArray(patch.synonyms)) throw new Error('字段语义别名必须是数组')
      updates.push('synonyms_json = ?')
      params.push(JSON.stringify([...new Set(
        patch.synonyms
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      )].slice(0, 12)))
    }
    if (patch.sensitivity !== undefined) {
      if (!fieldSensitivities.has(patch.sensitivity)) throw new Error('字段敏感级别无效')
      updates.push('sensitivity = ?')
      params.push(patch.sensitivity)
    }
    if (updates.length) {
      this.db.prepare(`
        UPDATE field_profiles
        SET ${updates.join(', ')}, profiled_at = ?
        WHERE scope_key = ? AND field = ?
      `).run(...params, nowIso(), scopeKey, normalizedField)
    }
    const updated = this.db.prepare(`
      SELECT field, inferred_type, non_null_rate, distinct_count, samples_json,
             display_name, role, synonyms_json, sensitivity, profiled_at
      FROM field_profiles
      WHERE scope_key = ? AND field = ?
    `).get(scopeKey, normalizedField) as SqlRow | undefined
    return updated ? mapFieldProfileRow(updated) : null
  }

  getQueryCache(cacheKey: string, dataRevision: number): QueryDataset | null {
    const row = this.db.prepare(`
      SELECT result_json, expires_at
      FROM query_cache
      WHERE cache_key = ? AND data_revision = ?
    `).get(cacheKey, dataRevision) as SqlRow | undefined
    if (!row) return null
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      this.db.prepare('DELETE FROM query_cache WHERE cache_key = ?').run(cacheKey)
      return null
    }
    try {
      return JSON.parse(String(row.result_json)) as QueryDataset
    } catch {
      this.db.prepare('DELETE FROM query_cache WHERE cache_key = ?').run(cacheKey)
      return null
    }
  }

  saveQueryCache(
    cacheKey: string,
    dataRevision: number,
    dataset: QueryDataset,
    ttlMs = 5 * 60 * 1000
  ): void {
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + Math.max(1_000, ttlMs)).toISOString()
    this.db.prepare(`
      INSERT INTO query_cache(cache_key, data_revision, result_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        data_revision = excluded.data_revision,
        result_json = excluded.result_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(cacheKey, dataRevision, JSON.stringify(dataset), createdAt, expiresAt)
  }

  listDashboards(): DashboardSummary[] {
    return this.db.prepare(`
      SELECT id, title, subtitle, theme, current_version, component_count, created_at, updated_at
      FROM dashboards
      ORDER BY updated_at DESC
    `).all().map((row) => {
      const value = row as SqlRow
      return {
        id: String(value.id),
        title: String(value.title),
        subtitle: String(value.subtitle),
        theme: String(value.theme) as DashboardSummary['theme'],
        currentVersion: Number(value.current_version),
        componentCount: Number(value.component_count),
        createdAt: String(value.created_at),
        updatedAt: String(value.updated_at)
      }
    })
  }

  getDashboard(id: string, version?: number): DashboardVersion | null {
    const row = version === undefined
      ? this.db.prepare(`
          SELECT v.dashboard_id, v.version, v.spec_json, v.change_summary, v.created_at
          FROM dashboard_versions v
          JOIN dashboards d ON d.id = v.dashboard_id AND d.current_version = v.version
          WHERE v.dashboard_id = ?
        `).get(id)
      : this.db.prepare(`
          SELECT dashboard_id, version, spec_json, change_summary, created_at
          FROM dashboard_versions
          WHERE dashboard_id = ? AND version = ?
        `).get(id, version)
    if (!row) return null
    const value = row as SqlRow
    return {
      dashboardId: String(value.dashboard_id),
      version: Number(value.version),
      spec: JSON.parse(String(value.spec_json)) as DashboardSpec,
      changeSummary: String(value.change_summary),
      createdAt: String(value.created_at)
    }
  }

  listDashboardVersions(id: string): DashboardVersion[] {
    return this.db.prepare(`
      SELECT dashboard_id, version, spec_json, change_summary, created_at
      FROM dashboard_versions
      WHERE dashboard_id = ?
      ORDER BY version DESC
    `).all(id).map((row) => {
      const value = row as SqlRow
      return {
        dashboardId: String(value.dashboard_id),
        version: Number(value.version),
        spec: JSON.parse(String(value.spec_json)) as DashboardSpec,
        changeSummary: String(value.change_summary),
        createdAt: String(value.created_at)
      }
    })
  }

  saveDashboard(input: DashboardSaveInput): DashboardVersion {
    const timestamp = nowIso()
    const existing = this.db.prepare(
      'SELECT current_version, created_at FROM dashboards WHERE id = ?'
    ).get(input.spec.id) as SqlRow | undefined
    const currentVersion = existing ? Number(existing.current_version) : 0
    if (input.baseVersion !== undefined) {
      if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) {
        throw new Error('大屏基础版本号无效，无法保存')
      }
      if (input.baseVersion !== currentVersion) {
        throw new Error(
          `大屏版本冲突：当前已是 V${currentVersion}，本次编辑基于 V${input.baseVersion}。` +
          '请重新打开最新版本后再修改。'
        )
      }
    }
    const version = currentVersion + 1
    const spec: DashboardSpec = { ...input.spec, updatedAt: timestamp }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO dashboards (
          id, title, subtitle, theme, current_version, component_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          subtitle = excluded.subtitle,
          theme = excluded.theme,
          current_version = excluded.current_version,
          component_count = excluded.component_count,
          updated_at = excluded.updated_at
      `).run(
        spec.id,
        spec.title,
        spec.subtitle,
        spec.theme,
        version,
        spec.components.length,
        existing ? String(existing.created_at) : timestamp,
        timestamp
      )
      this.db.prepare(`
        INSERT INTO dashboard_versions (
          dashboard_id, version, spec_json, change_summary, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        spec.id,
        version,
        JSON.stringify(spec),
        input.changeSummary.trim() || (version === 1 ? '创建大屏' : '保存编辑'),
        timestamp
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getDashboard(spec.id, version)!
  }

  restoreDashboard(id: string, version: number): DashboardVersion {
    const source = this.getDashboard(id, version)
    if (!source) throw new Error(`找不到大屏 ${id} 的版本 ${version}`)
    return this.saveDashboard({
      spec: source.spec,
      changeSummary: `恢复自版本 V${version}`
    })
  }

  recordVisualizationRun(input: VisualizationRunInput): VisualizationRun {
    const toolCalls = normalizeVisualizationToolCalls(input.toolCalls)
    const run: VisualizationRun = {
      ...input,
      mode: input.mode === 'patch' ? 'patch' : 'generate',
      toolCalls,
      id: randomUUID(),
      requestSummary: input.requestSummary.slice(0, 500),
      errorMessage: input.errorMessage?.slice(0, 1000),
      createdAt: nowIso()
    }
    this.db.prepare(`
      INSERT INTO visualization_runs (
        id, dashboard_id, request_summary, model_name, prompt_version, mode, status,
        attempt_count, component_count, query_count, duration_ms, tool_calls_json,
        error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.dashboardId ?? '',
      run.requestSummary,
      run.modelName,
      run.promptVersion,
      run.mode,
      run.status,
      run.attemptCount,
      run.componentCount,
      run.queryCount,
      run.durationMs,
      JSON.stringify(run.toolCalls),
      run.errorMessage ?? '',
      run.createdAt
    )
    return run
  }

  listVisualizationRuns(limit = 30): VisualizationRun[] {
    return this.db.prepare(`
      SELECT *
      FROM visualization_runs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.min(100, Math.max(1, limit))).map((row) => {
      const value = row as SqlRow
      const toolCalls = normalizeVisualizationToolCalls(
        parseJsonValue(value.tool_calls_json, [])
      )
      return {
        id: String(value.id),
        dashboardId: String(value.dashboard_id) || undefined,
        requestSummary: String(value.request_summary),
        modelName: String(value.model_name),
        promptVersion: String(value.prompt_version),
        mode: String(value.mode) === 'patch' ? 'patch' : 'generate',
        status: String(value.status) as VisualizationRun['status'],
        attemptCount: Number(value.attempt_count),
        componentCount: Number(value.component_count),
        queryCount: Number(value.query_count),
        durationMs: Number(value.duration_ms),
        toolCalls,
        errorMessage: String(value.error_message) || undefined,
        createdAt: String(value.created_at)
      }
    })
  }

  recordDashboardAuditLog(input: DashboardAuditLogInput): DashboardAuditLog {
    const actions = new Set<DashboardAuditAction>([
      'save',
      'restore',
      'diagnose',
      'repair-component',
      'export-json',
      'export-pdf',
      'export-png',
      'export-offline',
      'export-data'
    ])
    const statuses = new Set<DashboardAuditStatus>(['success', 'canceled', 'failed'])
    if (!actions.has(input.action)) throw new Error(`审计动作无效: ${String(input.action)}`)
    if (!statuses.has(input.status)) throw new Error(`审计状态无效: ${String(input.status)}`)
    const metadata = Object.fromEntries(
      Object.entries(input.metadata ?? {})
        .filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value))
        .filter(([key, value]) => key !== 'specHash' && key !== 'sourceSpecHash'
          || typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value))
        .map(([key, value]) => [key.slice(0, 80), typeof value === 'string' ? value.slice(0, 500) : value])
    )
    const createdAt = nowIso()
    const result = this.db.prepare(`
      INSERT INTO dashboard_audit_logs (
        dashboard_id, action, status, version, format, metadata_json, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.dashboardId ?? '',
      input.action,
      input.status,
      input.version ?? null,
      input.format ?? '',
      JSON.stringify(metadata),
      (input.errorMessage ?? '').slice(0, 1000),
      createdAt
    )
    return {
      id: Number(result.lastInsertRowid),
      dashboardId: input.dashboardId,
      action: input.action,
      status: input.status,
      ...(input.version === undefined ? {} : { version: input.version }),
      ...(input.format === undefined ? {} : { format: input.format }),
      ...(Object.keys(metadata).length ? { metadata } : {}),
      ...((input.errorMessage ?? '').trim() ? { errorMessage: input.errorMessage!.slice(0, 1000) } : {}),
      createdAt
    }
  }

  listDashboardAuditLogs(dashboardId?: string, limit = 100): DashboardAuditLog[] {
    const normalizedLimit = Math.min(200, Math.max(1, Math.floor(limit || 100)))
    const rows = dashboardId?.trim()
      ? this.db.prepare(`
          SELECT id, dashboard_id, action, status, version, format, metadata_json, error_message, created_at
          FROM dashboard_audit_logs
          WHERE dashboard_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(dashboardId.trim(), normalizedLimit)
      : this.db.prepare(`
          SELECT id, dashboard_id, action, status, version, format, metadata_json, error_message, created_at
          FROM dashboard_audit_logs
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `).all(normalizedLimit)
    return (rows as SqlRow[]).map((row) => {
      let metadata: Record<string, string | number | boolean | null> | undefined
      try {
        const parsed = JSON.parse(String(row.metadata_json ?? '{}')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, string | number | boolean | null>
        }
      } catch {
        metadata = undefined
      }
      const version = row.version === null || row.version === undefined ? undefined : Number(row.version)
      const format = String(row.format ?? '')
      const errorMessage = String(row.error_message ?? '')
      return {
        id: Number(row.id),
        dashboardId: String(row.dashboard_id) || undefined,
        action: String(row.action) as DashboardAuditAction,
        status: String(row.status) as DashboardAuditStatus,
        ...(version === undefined ? {} : { version }),
        ...(format ? { format: format as DashboardAuditLog['format'] } : {}),
        ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        createdAt: String(row.created_at)
      }
    })
  }

  scanAnalyticsRecords(scope: DataScope, maximumRows = 100_000): AnalyticsRecord[] {
    const clauses: string[] = []
    const params: string[] = []
    const addListFilter = (column: string, values?: string[]): void => {
      const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
      if (!normalized.length) return
      if (normalized.length > 200) throw new Error(`数据范围 ${column} 最多允许 200 个值`)
      clauses.push(`${column} IN (${normalized.map(() => '?').join(', ')})`)
      params.push(...normalized)
    }
    addListFilter('project_id', scope.projectIds)
    addListFilter('node_type', scope.nodeTypes)
    addListFilter('uid', scope.recordUids)
    if (scope.snapshotAt) {
      const timestamp = Date.parse(scope.snapshotAt)
      if (!Number.isFinite(timestamp)) throw new Error('snapshotAt 不是有效时间')
      clauses.push('synced_at <= ?')
      params.push(new Date(timestamp).toISOString())
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(100_000, Math.max(1, Math.trunc(maximumRows)))
    const rows = this.db.prepare(
      `SELECT uid, project_id, node_type, item_id, name, last_modify_time, raw_json
       FROM records${where}
       ORDER BY uid
       LIMIT ?`
    ).all(...params, limit + 1) as SqlRow[]
    if (rows.length > limit) {
      throw new Error(`查询扫描行数超过安全上限 ${limit}，请缩小 DataScope`)
    }
    return rows.flatMap((row) => {
      try {
        return [{
          uid: String(row.uid),
          projectId: String(row.project_id),
          nodeType: String(row.node_type),
          itemId: String(row.item_id),
          name: String(row.name),
          lastModifyTime: String(row.last_modify_time),
          raw: JSON.parse(String(row.raw_json)) as Record<string, unknown>
        }]
      } catch {
        return []
      }
    })
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | SqlRow
      | undefined
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  upsertProject(input: {
    uid: string
    name: string
    itemId: string
    lastModifyTime: string
    raw: Record<string, unknown>
  }): void {
    this.statsCache = null
    this.db
      .prepare(
        `INSERT INTO projects(uid, name, item_id, last_modify_time, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           name=excluded.name,
           item_id=excluded.item_id,
           last_modify_time=excluded.last_modify_time,
           raw_json=excluded.raw_json,
           synced_at=excluded.synced_at`
    )
      .run(
        input.uid,
        input.name,
        input.itemId,
        input.lastModifyTime,
        JSON.stringify(input.raw),
        nowIso()
      )
  }

  private requirementBusinessTextFromRow(row: SqlRow): string {
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(String(row.raw_json ?? '{}')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      raw = {}
    }
    const nodeType = String(row.node_type ?? '').trim()
    const fieldLabels = nodeType
      ? this.getFieldDisplayNames(nodeType, Object.keys(raw))
      : undefined
    return buildRequirementBusinessText({ name: row.name, raw, fieldLabels })
  }

  private getRecordWriteStatements(): NonNullable<AppDatabase['recordWriteStatements']> {
    if (!this.recordWriteStatements) {
      this.recordWriteStatements = {
        conflict: this.db.prepare('SELECT uid FROM records WHERE item_id = ? AND uid <> ? LIMIT 1'),
        previous: this.db.prepare('SELECT raw_json FROM records WHERE uid = ?'),
        deleteImageRefs: this.db.prepare('DELETE FROM record_image_refs WHERE record_uid = ?'),
        upsert: this.db.prepare(`
          INSERT INTO records(
             uid, project_id, node_type, item_id, parent_id, name,
             last_modify_time, raw_json, normalized_text, content_hash, semantic_hash, synced_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uid) DO UPDATE SET
             project_id=excluded.project_id,
             node_type=excluded.node_type,
             item_id=excluded.item_id,
             parent_id=excluded.parent_id,
             name=excluded.name,
             last_modify_time=excluded.last_modify_time,
             raw_json=excluded.raw_json,
             normalized_text=excluded.normalized_text,
             content_hash=excluded.content_hash,
             semantic_hash=excluded.semantic_hash,
             push_status=CASE
               WHEN records.content_hash <> excluded.content_hash THEN 'pending'
               ELSE records.push_status
             END,
             push_message=CASE
               WHEN records.content_hash <> excluded.content_hash THEN ''
               ELSE records.push_message
             END,
             pushed_at=CASE
               WHEN records.content_hash <> excluded.content_hash THEN ''
               ELSE records.pushed_at
             END,
             pushed_uid=CASE
               WHEN records.content_hash <> excluded.content_hash THEN ''
               ELSE records.pushed_uid
             END,
             synced_at=excluded.synced_at`
        )
      }
    }
    return this.recordWriteStatements
  }

  private getRequirementSearchStatements(): NonNullable<AppDatabase['requirementSearchStatements']> {
    if (!this.requirementSearchStatements) {
      this.requirementSearchStatements = {
        delete: this.db.prepare('DELETE FROM requirement_records_fts WHERE record_uid = ?'),
        select: this.db.prepare('SELECT uid, name, node_type, raw_json FROM records WHERE uid = ?'),
        insert: this.db.prepare(
          'INSERT INTO requirement_records_fts(record_uid, business_text) VALUES (?, ?)'
        )
      }
    }
    return this.requirementSearchStatements
  }

  private getMaintenanceWriteStatements(): NonNullable<AppDatabase['maintenanceWriteStatements']> {
    if (!this.maintenanceWriteStatements) {
      this.maintenanceWriteStatements = {
        ensure: this.db.prepare(`
          INSERT OR IGNORE INTO record_maintenance_states(record_uid, updated_at)
          VALUES (?, ?)
        `),
        update: this.db.prepare(`
          UPDATE record_maintenance_states
          SET clean_status = 'ready', clean_version = ?, clean_updated_at = ?, clean_error = '',
              lexical_status = 'ready', lexical_version = ?, lexical_updated_at = ?, lexical_error = '',
              vector_status = 'pending', vector_version = '', vector_model_version = '',
              vector_error = '', updated_at = ?
          WHERE record_uid = ?
        `)
      }
    }
    return this.maintenanceWriteStatements
  }

  private syncRequirementSearchIndex(recordUid: string): void {
    const statements = this.getRequirementSearchStatements()
    statements.delete.run(recordUid)
    const row = statements.select.get(recordUid) as SqlRow | undefined
    if (!row) return
    const businessText = this.requirementBusinessTextFromRow(row)
    if (businessText) {
      statements.insert.run(recordUid, businessText)
    }
  }

  private rebuildRequirementSearchIndex(): void {
    this.db.prepare('DELETE FROM requirement_records_fts').run()
    const rows = this.db.prepare('SELECT uid, name, node_type, raw_json FROM records ORDER BY uid').all() as SqlRow[]
    const insert = this.db.prepare(`
      INSERT INTO requirement_records_fts(record_uid, business_text) VALUES (?, ?)
    `)
    for (const row of rows) {
      const businessText = this.requirementBusinessTextFromRow(row)
      if (businessText) insert.run(String(row.uid), businessText)
    }
  }

  /** Persist a batch with one SQLite transaction and reusable write statements. */
  upsertRecords(inputs: readonly RecordInput[]): number {
    if (!inputs.length) return 0
    this.runInTransaction(() => {
      for (const input of inputs) this.upsertRecord(input)
    })
    return inputs.length
  }

  upsertRecord(input: RecordInput): void {
    this.statsCache = null
    const itemId = input.itemId.trim()
    if (!itemId) throw new Error('记录缺少 _valm_ItemID，不能写入本地数据')
    const statements = this.getRecordWriteStatements()
    const conflict = statements.conflict.get(itemId, input.uid) as SqlRow | undefined
    if (conflict) {
      throw new Error(`_valm_ItemID ${itemId} 已存在，不能直接覆盖`)
    }
    const rawJson = JSON.stringify(input.raw)
    const previous = statements.previous.get(input.uid) as SqlRow | undefined
    if (previous) {
      let previousRaw: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(String(previous.raw_json ?? '{}')) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          previousRaw = parsed as Record<string, unknown>
        }
      } catch {
        previousRaw = {}
      }
      if (JSON.stringify(previousRaw._valm_Description) !== JSON.stringify(input.raw._valm_Description)) {
        statements.deleteImageRefs.run(input.uid)
      }
    }
    const contentHash = createHash('sha256').update(rawJson).digest('hex')
    const semanticHash = requirementSemanticSourceHash({
      name: input.name,
      lastModifyTime: input.lastModifyTime,
      rawJson,
      normalizedText: input.normalizedText,
      fieldLabels: this.getFieldDisplayNames(input.nodeType, Object.keys(input.raw))
    })
    statements.upsert.run(
        input.uid,
        input.projectId,
        input.nodeType,
        itemId,
        input.parentId,
        input.name,
        input.lastModifyTime,
        rawJson,
        input.normalizedText,
        contentHash,
        semanticHash,
        nowIso()
      )
    this.syncRequirementSearchIndex(input.uid)
    this.markRecordMaintenanceDataWritten(input.uid)
  }

  updateRecordNormalizedText(uid: string, normalizedText: string): void {
    const row = this.db.prepare(`
      SELECT name, node_type, last_modify_time, raw_json FROM records WHERE uid = ?
    `).get(uid) as SqlRow | undefined
    if (!row) return
    const semanticHash = requirementSemanticSourceHash({
      name: String(row.name ?? ''),
      lastModifyTime: String(row.last_modify_time ?? ''),
      rawJson: String(row.raw_json ?? '{}'),
      normalizedText,
      fieldLabels: this.getFieldDisplayNames(String(row.node_type ?? ''))
    })
    this.db.prepare(`
      UPDATE records
      SET normalized_text = ?, semantic_hash = ?
      WHERE uid = ?
    `).run(normalizedText, semanticHash, uid)
    this.ensureRecordMaintenanceState(uid)
    const timestamp = nowIso()
    this.db.prepare(`
      UPDATE record_maintenance_states
      SET clean_status = 'ready', clean_version = ?, clean_updated_at = ?, clean_error = '',
          updated_at = ?
      WHERE record_uid = ?
    `).run(RECORD_NORMALIZER_VERSION, timestamp, timestamp, uid)
  }

  updateRecordRawAndNormalizedText(
    uid: string,
    raw: Record<string, unknown>,
    normalizedText: string
  ): void {
    const rawJson = JSON.stringify(raw)
    const contentHash = createHash('sha256').update(rawJson).digest('hex')
    const row = this.db.prepare(`
      SELECT name, node_type, last_modify_time FROM records WHERE uid = ?
    `).get(uid) as SqlRow | undefined
    if (!row) return
    const semanticHash = requirementSemanticSourceHash({
      name: String(row.name ?? ''),
      lastModifyTime: String(row.last_modify_time ?? ''),
      rawJson,
      normalizedText,
      fieldLabels: this.getFieldDisplayNames(String(row.node_type ?? ''), Object.keys(raw))
    })
    this.db.prepare(`
      UPDATE records
      SET raw_json = ?, normalized_text = ?, content_hash = ?, semantic_hash = ?
      WHERE uid = ?
    `).run(rawJson, normalizedText, contentHash, semanticHash, uid)
    this.syncRequirementSearchIndex(uid)
    this.markRecordMaintenanceDataWritten(uid)
  }

  findRecordByItemId(itemId: string): RecordRow | null {
    const normalized = itemId.trim()
    if (!normalized) return null
    const row = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count
         FROM records r
         LEFT JOIN images i ON i.record_uid = r.uid
         WHERE r.item_id = ? COLLATE NOCASE
         GROUP BY r.uid
         ORDER BY r.synced_at DESC, r.uid DESC
         LIMIT 1`
      )
      .get(normalized) as SqlRow | undefined
    return row ? this.mapRecord(row) : null
  }

  /**
   * Resolve the numeric shorthand commonly copied from a requirement list,
   * e.g. `4101` -> `VISSLM-TSIS-4101`. Keep this separate from exact item-ID
   * lookup so imports and other callers never silently accept an ambiguous
   * suffix match.
   */
  findRecordsByItemIdSuffix(suffix: string): RecordRow[] {
    const normalized = suffix.trim()
    if (!/^\d+$/.test(normalized)) return []
    const rows = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count
         FROM records r
         LEFT JOIN images i ON i.record_uid = r.uid
         WHERE LOWER(r.item_id) LIKE LOWER('%-' || ?)
         GROUP BY r.uid
         ORDER BY r.synced_at DESC, r.uid DESC
         LIMIT 20`
      )
      .all(normalized) as SqlRow[]
    return rows.map((row) => this.mapRecord(row))
  }

  stageDataReview(input: {
    batchId: string
    source: DataReviewSource
    itemId: string
    existing: DataReviewSummary
    incoming: DataReviewSummary
    payload: unknown
  }): DataReviewItem {
    const itemId = input.itemId.trim()
    if (!itemId) throw new Error('待审查记录缺少 _valm_ItemID')
    const review: DataReviewItem = {
      id: randomUUID(),
      source: input.source,
      itemId,
      existing: input.existing,
      incoming: input.incoming
    }
    this.db
      .prepare(
        `INSERT INTO data_review_items(
          id, batch_id, source, item_id,
          existing_uid, existing_project_id, existing_node_type,
          existing_name, existing_last_modify_time,
          incoming_uid, incoming_project_id, incoming_node_type,
          incoming_name, incoming_last_modify_time, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        review.id,
        input.batchId,
        review.source,
        review.itemId,
        review.existing.uid,
        review.existing.projectId,
        review.existing.nodeType,
        review.existing.name,
        review.existing.lastModifyTime,
        review.incoming.uid,
        review.incoming.projectId,
        review.incoming.nodeType,
        review.incoming.name,
        review.incoming.lastModifyTime,
        JSON.stringify(input.payload),
        nowIso()
      )
    return review
  }

  listDataReviews(batchId: string, source: DataReviewSource): DataReviewItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM data_review_items
         WHERE batch_id = ? AND source = ?
         ORDER BY created_at, id`
      )
      .all(batchId, source) as SqlRow[]
    return rows.map((row) => this.mapDataReview(row))
  }

  getPendingDataReviews(
    batchId: string,
    source: DataReviewSource,
    reviewIds?: string[]
  ): PendingDataReview[] {
    const selected = [...new Set((reviewIds ?? []).map((id) => id.trim()).filter(Boolean))]
    const params: string[] = [batchId, source]
    const conditions = ['batch_id = ?', 'source = ?']
    if (selected.length) {
      conditions.push(`id IN (${selected.map(() => '?').join(',')})`)
      params.push(...selected)
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM data_review_items
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at, id`
      )
      .all(...params) as SqlRow[]
    return rows.map((row) => ({
      ...this.mapDataReview(row),
      payload: parseJsonValue(row.payload_json, {})
    }))
  }

  resolveDataReviews(batchId: string, source: DataReviewSource, reviewIds: string[]): void {
    const selected = [...new Set(reviewIds.map((id) => id.trim()).filter(Boolean))]
    if (!selected.length) return
    this.db
      .prepare(
        `DELETE FROM data_review_items
         WHERE batch_id = ? AND source = ? AND id IN (${selected.map(() => '?').join(',')})`
      )
      .run(batchId, source, ...selected)
  }

  retainRecords(uids: string[]): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS sync_record_keep (
        uid TEXT PRIMARY KEY
      );
      DELETE FROM sync_record_keep;
    `)
    const insert = this.db.prepare('INSERT OR IGNORE INTO sync_record_keep(uid) VALUES (?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const uid of uids) insert.run(uid)
      this.db.exec(`
        DELETE FROM records
        WHERE uid NOT IN (SELECT uid FROM sync_record_keep);
        COMMIT;
      `)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.db.exec('DELETE FROM sync_record_keep')
    }
    this.cleanupOrphanAssetBlobs()
  }

  private cleanupOrphanAssetBlobs(): void {
    const rows = this.db.prepare(`
      SELECT b.sha256, b.binary_path
      FROM asset_blobs b
      LEFT JOIN images i ON i.sha256 = b.sha256
      LEFT JOIN record_image_refs r ON r.asset_sha256 = b.sha256
      WHERE i.sha256 IS NULL AND r.asset_sha256 IS NULL
    `).all() as SqlRow[]
    for (const row of rows) {
      const sha256 = String(row.sha256 ?? '')
      this.db.prepare('DELETE FROM asset_blobs WHERE sha256 = ?').run(sha256)
      const filePath = String(row.binary_path ?? '')
      if (filePath) {
        try { unlinkSync(filePath) } catch { /* best-effort orphan cleanup */ }
      }
    }
  }

  private binaryPathForSha(sha256: string): string {
    const normalized = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('图片 SHA-256 无效')
    return join(this.binaryAssetDir, normalized.slice(0, 2), normalized)
  }

  private migrateLegacyImageFiles(): void {
    const rows = this.db.prepare(`
      SELECT id, sha256, mime_type, byte_size, source_url, base64_path, binary_path
      FROM images
      WHERE COALESCE(base64_path, '') <> '' OR COALESCE(binary_path, '') = ''
    `).all() as SqlRow[]
    if (!rows.length) return
    const legacyPaths = new Set(
      rows.map((row) => String(row.base64_path ?? '').trim()).filter(Boolean)
    )
    const insertBlob = this.db.prepare(`
      INSERT INTO asset_blobs(sha256, mime_type, byte_size, binary_path, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        binary_path = excluded.binary_path
    `)
    for (const row of rows) {
      const sha256 = String(row.sha256 ?? '').trim().toLowerCase()
      const legacyPath = String(row.base64_path ?? '').trim()
      let decodedTempPath = ''
      try {
        if (!/^[a-f0-9]{64}$/.test(sha256)) continue
        const existingBinary = String(row.binary_path ?? '').trim()
        let bytes: Buffer | null = null
        let byteSize = 0
        if (existingBinary && existsSync(existingBinary)) {
          const candidate = readFileSync(existingBinary)
          if (createHash('sha256').update(candidate).digest('hex') === sha256) {
            bytes = candidate
            byteSize = candidate.byteLength
          }
        }
        if (!bytes && legacyPath && existsSync(legacyPath)) {
          const binaryPath = this.binaryPathForSha(sha256)
          decodedTempPath = `${binaryPath}.${randomUUID()}.decode.tmp`
          const decoded = decodeLegacyBase64File(legacyPath, decodedTempPath)
          if (decoded?.sha256 === sha256) byteSize = decoded.byteSize
        }
        if (!bytes && !byteSize) continue
        const binaryPath = this.binaryPathForSha(sha256)
        mkdirSync(join(this.binaryAssetDir, sha256.slice(0, 2)), { recursive: true })
        let binaryIsValid = false
        if (existsSync(binaryPath)) {
          try {
            const existing = readFileSync(binaryPath)
            binaryIsValid = existing.byteLength === byteSize &&
              createHash('sha256').update(existing).digest('hex') === sha256
          } catch {
            binaryIsValid = false
          }
        }
        if (!binaryIsValid) {
          if (decodedTempPath && existsSync(decodedTempPath)) {
            renameSync(decodedTempPath, binaryPath)
            decodedTempPath = ''
          } else if (bytes) {
            const temporaryPath = `${binaryPath}.${randomUUID()}.tmp`
            writeFileSync(temporaryPath, bytes)
            renameSync(temporaryPath, binaryPath)
          }
        } else if (decodedTempPath) {
          try { unlinkSync(decodedTempPath) } catch {}
          decodedTempPath = ''
        }
        const mimeType = normalizeMimeType(row.mime_type)
        insertBlob.run(sha256, mimeType, byteSize, binaryPath, nowIso())
        this.db.prepare('UPDATE images SET binary_path = ?, base64_path = \'\', byte_size = ?, source_url = ? WHERE id = ?')
          .run(binaryPath, byteSize, compactImageSource(row.source_url, sha256), String(row.id))
      } catch {
        // One damaged legacy image must not make the database unusable.  It
        // remains available for a later repair/import operation.
      } finally {
        if (decodedTempPath) {
          try { unlinkSync(decodedTempPath) } catch {}
        }
      }
    }
    for (const legacyPath of legacyPaths) {
      const pending = this.db.prepare(`
        SELECT 1 FROM images WHERE base64_path = ? LIMIT 1
      `).get(legacyPath)
      if (!pending) {
        try { unlinkSync(legacyPath) } catch { /* best-effort cleanup */ }
      }
    }
  }

  /** Upgrade already-collected descriptions to lossless binary asset tokens. */
  private migrateRichTextAssetTokens(): void {
    const rows = this.db.prepare(`
      SELECT uid, node_type, raw_json, normalized_text FROM records
      WHERE raw_json LIKE '%_valm_Description%'
        AND raw_json LIKE '%<img%'
        AND NOT EXISTS (
          SELECT 1 FROM record_image_refs refs
          WHERE refs.record_uid = records.uid
            AND refs.field_path = '_valm_Description'
        )
    `).all() as SqlRow[]
    for (const row of rows) {
      let raw: Record<string, unknown>
      try {
        const parsed = JSON.parse(String(row.raw_json)) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        raw = parsed as Record<string, unknown>
      } catch {
        continue
      }
      const description = typeof raw._valm_Description === 'string' ? raw._valm_Description : ''
      if (!description || !findRichTextImageSources(description).length) continue
      const images = this.db.prepare(`
        SELECT id, name, source_url, sha256, mime_type
        FROM images WHERE record_uid = ? ORDER BY created_at, id
      `).all(String(row.uid)) as SqlRow[]
      const findImage = (source: string, sha256?: string): SqlRow | undefined => images.find((image) => {
        if (sha256 && String(image.sha256).toLowerCase() === sha256.toLowerCase()) return true
        const sourceUrl = String(image.source_url ?? '')
        return sourceUrl === source || sourceUrl.includes(source) ||
          (/^data:image\//i.test(source) && sourceUrl.startsWith('inline:data-uri'))
      })
      const tokenized = replaceRichTextImageSources(description, (source) => {
        const parsed = parseAssetToken(source.source)
        const image = findImage(source.source, parsed?.sha256)
        const sha256 = parsed?.sha256 || String(image?.sha256 ?? '').toLowerCase()
        if (!/^[a-f0-9]{64}$/.test(sha256) || !this.getAssetBlob(sha256)) return undefined
        const referenceId = parsed?.referenceId || randomUUID()
        this.saveRecordImageReference({
          id: referenceId,
          recordUid: String(row.uid),
          fieldPath: '_valm_Description',
          ordinal: source.occurrence,
          assetSha256: sha256,
          sourceType: parsed ? 'token' : 'legacy',
          sourceName: String(image?.name ?? ''),
          originalSource: source.source
        })
        return parsed ? source.source : `visslm-asset://${sha256}/${referenceId}`
      })
      if (!tokenized.replacements.length || tokenized.html === description) continue
      const nextRaw = { ...raw, _valm_Description: tokenized.html }
      const normalizedText = String(row.normalized_text ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      this.updateRecordRawAndNormalizedText(String(row.uid), nextRaw, normalizedText)
      if (String(row.node_type ?? '') === 'Project') {
        this.db.prepare('UPDATE projects SET raw_json = ? WHERE uid = ?')
          .run(JSON.stringify(nextRaw), String(row.uid))
      }
    }
  }

  private ensureAssetBlob(input: {
    sha256: string
    mimeType: string
    bytes: Buffer
  }): AssetBlob {
    const sha256 = input.sha256.trim().toLowerCase()
    const expected = createHash('sha256').update(input.bytes).digest('hex')
    if (expected !== sha256) throw new Error('图片内容 SHA-256 校验失败')
    const filePath = this.binaryPathForSha(sha256)
    mkdirSync(join(this.binaryAssetDir, sha256.slice(0, 2)), { recursive: true })
    let fileIsValid = false
    if (existsSync(filePath)) {
      try {
        const existing = readFileSync(filePath)
        fileIsValid = existing.byteLength === input.bytes.byteLength &&
          createHash('sha256').update(existing).digest('hex') === sha256
      } catch {
        fileIsValid = false
      }
    }
    if (!fileIsValid) {
      const temporaryPath = `${filePath}.${randomUUID()}.tmp`
      writeFileSync(temporaryPath, input.bytes)
      renameSync(temporaryPath, filePath)
    }
    const mimeType = normalizeMimeType(input.mimeType)
    this.db.prepare(`
      INSERT INTO asset_blobs(sha256, mime_type, byte_size, binary_path, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(sha256) DO UPDATE SET
        mime_type = CASE WHEN asset_blobs.mime_type = 'application/octet-stream'
          THEN excluded.mime_type ELSE asset_blobs.mime_type END,
        byte_size = excluded.byte_size,
        binary_path = excluded.binary_path
    `).run(sha256, mimeType, input.bytes.byteLength, filePath, nowIso())
    return { sha256, mimeType, byteSize: input.bytes.byteLength, filePath }
  }

  /** Store a content-addressed blob without associating it with a record yet. */
  saveAssetBlob(input: {
    sha256: string
    mimeType: string
    bytes: Buffer
  }): AssetBlob {
    const sha256 = input.sha256.trim().toLowerCase()
    return this.ensureAssetBlob({ sha256, mimeType: input.mimeType, bytes: input.bytes })
  }

  runInTransaction<T>(action: () => T): T {
    // Importing a resource pack already runs the whole apply phase inside one
    // transaction.  Keep nested callers in that same SQLite transaction
    // instead of issuing a second BEGIN, while the outermost caller retains
    // the commit/rollback boundary.
    if (this.transactionDepth > 0) return action()
    this.db.exec('BEGIN IMMEDIATE')
    this.transactionDepth = 1
    try {
      const result = action()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.transactionDepth = 0
    }
  }

  removeAssetBlob(sha256: string): void {
    const normalized = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) return
    const hasImage = this.db.prepare('SELECT 1 FROM images WHERE sha256 = ? LIMIT 1').get(normalized)
    const hasReference = this.db.prepare('SELECT 1 FROM record_image_refs WHERE asset_sha256 = ? LIMIT 1').get(normalized)
    if (hasImage || hasReference) return
    const blob = this.db.prepare('SELECT binary_path FROM asset_blobs WHERE sha256 = ?').get(normalized) as SqlRow | undefined
    this.db.prepare('DELETE FROM asset_blobs WHERE sha256 = ?').run(normalized)
    const filePath = String(blob?.binary_path ?? '')
    if (filePath) {
      try { unlinkSync(filePath) } catch { /* best-effort cleanup */ }
    }
  }

  saveImage(input: ImageInput): ImageAsset {
    this.statsCache = null
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const unresolvedMarker = unresolvedImageMarker(
      input.recordUid,
      input.name,
      input.unresolvedSourceUrl ?? input.sourceUrl
    )
    this.db.prepare('DELETE FROM images WHERE record_uid = ? AND sha256 = ? AND state = \'unresolved\'')
      .run(input.recordUid, unresolvedMarker)
    const existing = this.db
      .prepare('SELECT * FROM images WHERE record_uid = ? AND sha256 = ?')
      .get(input.recordUid, sha256) as SqlRow | undefined
    if (existing) {
      if (!this.getAssetBlob(sha256)) {
        const blob = this.ensureAssetBlob({
          sha256,
          mimeType: input.mimeType,
          bytes: input.bytes
        })
        this.db.prepare('UPDATE images SET binary_path = ?, byte_size = ? WHERE id = ?')
          .run(blob.filePath, blob.byteSize, String(existing.id))
        existing.binary_path = blob.filePath
        existing.byte_size = blob.byteSize
      }
      return this.mapImage(existing)
    }

    const id = randomUUID()
    const blob = this.ensureAssetBlob({
      sha256,
      mimeType: input.mimeType,
      bytes: input.bytes
    })
    const createdAt = nowIso()
    const sourceUrl = compactImageSource(input.sourceUrl, sha256)
    this.db
      .prepare(
        `INSERT INTO images(
           id, record_uid, name, mime_type, source_url, sha256,
           base64_path, binary_path, byte_size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)`
      )
      .run(
        id,
        input.recordUid,
        input.name,
        normalizeMimeType(input.mimeType),
        sourceUrl,
        sha256,
        blob.filePath,
        input.bytes.byteLength,
        createdAt
      )
    return {
      id,
      recordUid: input.recordUid,
      name: input.name,
      mimeType: normalizeMimeType(input.mimeType),
      sourceUrl,
      sha256,
      byteSize: input.bytes.byteLength,
      assetUrl: `visslm-asset://${sha256}/${id}`,
      state: 'ready'
    } as ImageAsset
  }

  attachImageAsset(input: {
    recordUid: string
    name: string
    mimeType: string
    sourceUrl: string
    sha256: string
  }): ImageAsset {
    this.statsCache = null
    const sha256 = input.sha256.trim().toLowerCase()
    const blob = this.getAssetBlob(sha256)
    if (!blob || !this.readAssetBytes(sha256)) throw new Error('图片资源不存在或已损坏')
    const existing = this.db.prepare(
      'SELECT * FROM images WHERE record_uid = ? AND sha256 = ?'
    ).get(input.recordUid, sha256) as SqlRow | undefined
    if (existing) return this.mapImage(existing)
    const id = randomUUID()
    const sourceUrl = compactImageSource(input.sourceUrl, sha256)
    this.db.prepare(`
      INSERT INTO images(
        id, record_uid, name, mime_type, source_url, sha256,
        base64_path, binary_path, byte_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?)
    `).run(
      id,
      input.recordUid,
      input.name,
      normalizeMimeType(input.mimeType || blob.mimeType),
      sourceUrl,
      sha256,
      blob.filePath,
      blob.byteSize,
      nowIso()
    )
    return {
      id,
      recordUid: input.recordUid,
      name: input.name,
      mimeType: normalizeMimeType(input.mimeType || blob.mimeType),
      sourceUrl,
      sha256,
      byteSize: blob.byteSize,
      assetUrl: `visslm-asset://${sha256}/${id}`,
      state: 'ready'
    } as ImageAsset
  }

  saveUnresolvedImage(input: {
    recordUid: string
    name: string
    mimeType?: string
    sourceUrl: string
    errorMessage: string
  }): ImageAsset {
    const marker = unresolvedImageMarker(input.recordUid, input.name, input.sourceUrl)
    const sourceUrl = compactImageSource(input.sourceUrl, marker)
    const existing = this.db.prepare(
      'SELECT * FROM images WHERE record_uid = ? AND sha256 = ?'
    ).get(input.recordUid, marker) as SqlRow | undefined
    if (existing) {
      this.db.prepare('UPDATE images SET state = \'unresolved\', error_message = ?, source_url = ? WHERE id = ?')
        .run(input.errorMessage, sourceUrl, String(existing.id))
      existing.state = 'unresolved'
      existing.error_message = input.errorMessage
      existing.source_url = sourceUrl
      return this.mapImage(existing)
    }
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO images(
        id, record_uid, name, mime_type, source_url, sha256,
        base64_path, binary_path, byte_size, state, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', '', 0, 'unresolved', ?, ?)
    `).run(
      id,
      input.recordUid,
      input.name,
      normalizeMimeType(input.mimeType),
      sourceUrl,
      marker,
      input.errorMessage,
      nowIso()
    )
    return {
      id,
      recordUid: input.recordUid,
      name: input.name,
      mimeType: normalizeMimeType(input.mimeType),
      sourceUrl,
      sha256: marker,
      byteSize: 0,
      state: 'unresolved',
      errorMessage: input.errorMessage
    }
  }

  private mapImage(row: SqlRow): ImageAsset {
    const mimeType = normalizeMimeType(row.mime_type)
    const sha256 = String(row.sha256)
    const sourceUrl = compactImageSource(row.source_url, sha256)
    const storedState = String(row.state ?? 'ready')
    // Verify the content-addressed file before exposing a local URL.  This
    // keeps corrupted or partially copied files in the explicit `missing`
    // state instead of letting the renderer receive a broken image stream.
    if (storedState === 'unresolved') {
      return {
        id: String(row.id),
        recordUid: String(row.record_uid),
        name: String(row.name),
        mimeType,
        sourceUrl,
        sha256,
        byteSize: Number(row.byte_size ?? 0),
        state: 'unresolved',
        errorMessage: String(row.error_message ?? '图片资源未解析')
      }
    }
    const assetReady = Boolean(this.readAssetBytes(sha256))
    return {
      id: String(row.id),
      recordUid: String(row.record_uid),
      name: String(row.name),
      mimeType,
      sourceUrl,
      sha256,
      byteSize: Number(row.byte_size),
      ...(assetReady
        ? { assetUrl: `visslm-asset://${sha256}/${String(row.id)}`, state: 'ready' as const }
        : { state: 'missing' as const, errorMessage: String(row.error_message ?? '') || '本地图片二进制资源不存在或校验失败' })
    } as ImageAsset
  }

  getAssetBlob(sha256: string): AssetBlob | null {
    const normalized = sha256.trim().toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) return null
    const row = this.db.prepare(`
      SELECT sha256, mime_type, byte_size, binary_path
      FROM asset_blobs WHERE sha256 = ?
    `).get(normalized) as SqlRow | undefined
    if (!row) return null
    const filePath = String(row.binary_path ?? '')
    if (!filePath || !existsSync(filePath)) return null
    return {
      sha256: normalized,
      mimeType: normalizeMimeType(row.mime_type),
      byteSize: Number(row.byte_size ?? 0),
      filePath
    }
  }

  readAssetBytes(sha256: string): Buffer | null {
    const blob = this.getAssetBlob(sha256)
    if (!blob) return null
    try {
      const bytes = readFileSync(blob.filePath)
      if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256) return null
      return bytes
    } catch {
      return null
    }
  }

  listAssetBlobs(recordUids?: string[]): Array<AssetBlob & { bytes: Buffer }> {
    const selected = [...new Set((recordUids ?? []).map((uid) => uid.trim()).filter(Boolean))]
    const rows = selected.length
      ? this.db.prepare(`
          SELECT DISTINCT b.* FROM asset_blobs b
          JOIN images i ON i.sha256 = b.sha256
          WHERE i.record_uid IN (${selected.map(() => '?').join(',')})
          ORDER BY b.sha256
        `).all(...selected)
      : this.db.prepare('SELECT * FROM asset_blobs ORDER BY sha256').all()
    const assets: Array<AssetBlob & { bytes: Buffer }> = []
    for (const row of rows as SqlRow[]) {
      const blob = this.getAssetBlob(String(row.sha256 ?? ''))
      const bytes = blob ? this.readAssetBytes(blob.sha256) : null
      if (blob && bytes) assets.push({ ...blob, bytes })
    }
    return assets
  }

  listRecordImageReferences(recordUid: string, fieldPath?: string): RecordImageReference[] {
    const rows = fieldPath === undefined
      ? this.db.prepare(`
          SELECT * FROM record_image_refs
          WHERE record_uid = ? ORDER BY field_path, ordinal
        `).all(recordUid)
      : this.db.prepare(`
          SELECT * FROM record_image_refs
          WHERE record_uid = ? AND field_path = ? ORDER BY ordinal
        `).all(recordUid, fieldPath)
    return (rows as SqlRow[]).map((row) => ({
      id: String(row.id),
      recordUid: String(row.record_uid),
      fieldPath: String(row.field_path),
      occurrence: Number(row.ordinal),
      ordinal: Number(row.ordinal),
      assetSha256: String(row.asset_sha256),
      sourceType: String(row.source_type),
      sourceName: String(row.source_name),
      originalSource: String(row.original_source),
      createdAt: String(row.created_at)
    }))
  }

  saveRecordImageReference(input: {
    id?: string
    recordUid: string
    fieldPath: string
    ordinal: number
    assetSha256: string
    sourceType?: string
    sourceName?: string
    originalSource?: string
  }): RecordImageReference {
    const id = input.id?.trim() || randomUUID()
    const fieldPath = input.fieldPath.trim() || '_valm_Description'
    const ordinal = Math.max(0, Math.floor(input.ordinal))
    const assetSha256 = input.assetSha256.trim().toLowerCase()
    if (!this.getAssetBlob(assetSha256)) throw new Error('图片资源不存在或已损坏')
    const createdAt = nowIso()
    this.db.prepare(`
      INSERT INTO record_image_refs(
        id, record_uid, field_path, ordinal, asset_sha256,
        source_type, source_name, original_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_uid, field_path, ordinal) DO UPDATE SET
        id = excluded.id,
        asset_sha256 = excluded.asset_sha256,
        source_type = excluded.source_type,
        source_name = excluded.source_name,
        original_source = excluded.original_source
    `).run(
      id,
      input.recordUid,
      fieldPath,
      ordinal,
      assetSha256,
      input.sourceType?.trim() || 'rich-text',
      input.sourceName?.trim() || '',
      compactImageSource(input.originalSource, assetSha256),
      createdAt
    )
    const row = this.db.prepare(`
      SELECT * FROM record_image_refs
      WHERE record_uid = ? AND field_path = ? AND ordinal = ?
    `).get(input.recordUid, fieldPath, ordinal) as SqlRow
    return {
      id: String(row.id),
      recordUid: String(row.record_uid),
      fieldPath: String(row.field_path),
      occurrence: Number(row.ordinal),
      ordinal: Number(row.ordinal),
      assetSha256: String(row.asset_sha256),
      sourceType: String(row.source_type),
      sourceName: String(row.source_name),
      originalSource: String(row.original_source),
      createdAt: String(row.created_at)
    }
  }

  getPushAssetUpload(baseUrl: string, projectId: string, sha256: string): PushAssetUpload | null {
    const key = `${baseUrl.replace(/\/+$/, '')}\u0000${projectId.trim()}\u0000${sha256.trim().toLowerCase()}`
    const row = this.db.prepare('SELECT * FROM push_asset_uploads WHERE cache_key = ?').get(key) as SqlRow | undefined
    if (!row) return null
    return {
      cacheKey: String(row.cache_key),
      baseUrl: String(row.base_url),
      projectId: String(row.project_id),
      sha256: String(row.sha256),
      remotePath: String(row.remote_path),
      createdAt: String(row.created_at)
    }
  }

  savePushAssetUpload(input: {
    baseUrl: string
    projectId: string
    sha256: string
    remotePath: string
  }): PushAssetUpload {
    const baseUrl = input.baseUrl.replace(/\/+$/, '')
    const projectId = input.projectId.trim()
    const sha256 = input.sha256.trim().toLowerCase()
    const cacheKey = `${baseUrl}\u0000${projectId}\u0000${sha256}`
    const createdAt = nowIso()
    this.db.prepare(`
      INSERT INTO push_asset_uploads(
        cache_key, base_url, project_id, sha256, remote_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET remote_path = excluded.remote_path
    `).run(cacheKey, baseUrl, projectId, sha256, input.remotePath, createdAt)
    return {
      cacheKey,
      baseUrl,
      projectId,
      sha256,
      remotePath: input.remotePath,
      createdAt
    }
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.uid, p.name, p.item_id, p.last_modify_time,
                COUNT(r.uid) AS record_count
         FROM projects p
         LEFT JOIN records r ON r.project_id = p.uid
         GROUP BY p.uid
         ORDER BY p.name`
      )
      .all() as SqlRow[]
    return rows.map((row) => ({
      uid: String(row.uid),
      name: String(row.name),
      itemId: String(row.item_id),
      lastModifyTime: String(row.last_modify_time),
      recordCount: Number(row.record_count)
    }))
  }

  listNodeTypes(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT node_type FROM records WHERE node_type <> '' ORDER BY node_type")
        .all() as SqlRow[]
    ).map((row) => String(row.node_type))
  }

  listRecordReleaseValues(): RecordReleaseValue[] {
    const counts = new Map<string, number>()
    try {
      const valueSql = releaseTextSql('r')
      const rows = this.db
        .prepare(
          `WITH release_values AS (
             SELECT r.uid, ${valueSql} AS value
             FROM records r
           )
           SELECT value, COUNT(DISTINCT uid) AS count
           FROM release_values
           WHERE value IS NOT NULL AND value <> ''
           GROUP BY value
           ORDER BY count DESC, value COLLATE NOCASE ASC`
        )
        .all() as SqlRow[]
      return rows.map((row) => ({
        value: String(row.value),
        count: Number(row.count ?? 0)
      }))
    } catch {
      // Keep compatibility with SQLite builds without JSON1.  The normal
      // application build has JSON1, but legacy environments can still
      // enumerate release values by parsing the stored payloads.
      const rows = this.db.prepare('SELECT raw_json FROM records').all() as SqlRow[]
      for (const row of rows) {
        let raw: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(String(row.raw_json)) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>
          }
        } catch {
          // Corrupt legacy raw JSON has no release text value.
        }
        const value = releaseTextFromRaw(raw)
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            left.value.localeCompare(right.value, undefined, { sensitivity: 'base' }) ||
            left.value.localeCompare(right.value)
        )
    }
  }

  private recordFilters(query: RecordQuery, semanticContext?: RequirementSemanticizationContext): {
    join: string
    where: string
    params: Array<string | number>
  } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    let join = 'LEFT JOIN requirement_semantic_cards s ON s.record_uid = r.uid'
    if (query.search?.trim()) {
      const search = query.search.trim()
      if (search.length >= 3) {
        join += ' JOIN records_fts f ON f.rowid = r.rowid'
        clauses.push('records_fts MATCH ?')
        params.push(`"${search.replaceAll('"', '""')}"`)
      } else {
        clauses.push('(r.name LIKE ? OR r.item_id LIKE ? OR r.normalized_text LIKE ?)')
        params.push(`%${search}%`, `%${search}%`, `%${search}%`)
      }
    }
    if (query.projectId) {
      clauses.push('r.project_id = ?')
      params.push(query.projectId)
    }
    if (query.nodeType) {
      clauses.push('r.node_type = ?')
      params.push(query.nodeType)
    }
    if (query.releaseText !== undefined) {
      clauses.push(`${releaseTextSql('r')} = ?`)
      params.push(String(query.releaseText).trim())
    }
    if (query.excludeProjectAssetProjectId) {
      clauses.push(`NOT EXISTS (
        SELECT 1 FROM pm_project_assets pa
        WHERE pa.project_id = ? AND pa.record_uid = r.uid
      )`)
      params.push(query.excludeProjectAssetProjectId)
    }
    if (query.semanticStatus && semanticContext) {
      const valid = `s.content_hash = ${requirementSemanticContentSql('r')}
        AND s.analyzer_version = ? AND s.model_signature = ?`
      if (query.semanticStatus === 'pending') {
        clauses.push(`(s.record_uid IS NULL OR s.status = 'pending' OR NOT (${valid}))`)
      } else {
        clauses.push(`s.status = ? AND ${valid}`)
        params.push(query.semanticStatus)
      }
      params.push(semanticContext.analyzerVersion, semanticContext.modelSignature)
    }
    return {
      join,
      where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    }
  }

  listRecords(query: RecordQuery, semanticContext?: RequirementSemanticizationContext): RecordPage {
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(200, Math.max(1, query.pageSize || 20))
    const filters = this.recordFilters(query, semanticContext)
    const totalRow = this.db
      .prepare(`SELECT COUNT(DISTINCT r.uid) AS total FROM records r ${filters.join} ${filters.where}`)
      .get(...filters.params) as SqlRow
    const rows = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count,
                ${requirementSemanticContentSql('r')} AS semantic_current_content_hash,
                s.status AS semantic_raw_status,
                s.content_hash AS semantic_content_hash,
                s.analyzer_version AS semantic_analyzer_version,
                s.model_signature AS semantic_model_signature,
                s.error_message AS semantic_error_message,
                s.updated_at AS semantic_updated_at
         FROM records r
         ${filters.join}
         LEFT JOIN images i ON i.record_uid = r.uid
         ${filters.where}
         GROUP BY r.uid
         ORDER BY r.last_modify_time DESC, r.uid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...filters.params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return {
      total: Number(totalRow.total),
      rows: rows.map((row) => this.mapRecord(row, semanticContext))
    }
  }

  listRecordUids(
    query: Omit<RecordQuery, 'page' | 'pageSize'>,
    semanticContext?: RequirementSemanticizationContext
  ): string[] {
    const filters = this.recordFilters({ page: 1, pageSize: 1, ...query }, semanticContext)
    const rows = this.db
      .prepare(
        `SELECT r.uid
         FROM records r
         ${filters.join}
         ${filters.where}
         GROUP BY r.uid
         ORDER BY r.last_modify_time DESC, r.uid DESC`
      )
      .all(...filters.params) as SqlRow[]
    return rows.map((row) => String(row.uid))
  }

  getChatDataViewPage(
    view: Pick<ChatDataView, 'recordUids' | 'fields'>,
    page = 1,
    pageSize = 20
  ): ChatDataViewPage {
    const ids = compactRecordUids(view.recordUids)
    const safePage = Math.max(1, Math.trunc(page || 1))
    const safePageSize = Math.min(100, Math.max(1, Math.trunc(pageSize || 20)))
    const selectedFields = [...new Set((view.fields ?? []).map((field) => field.trim()).filter(Boolean))].slice(0, 40)
    if (!ids.length) return { page: safePage, pageSize: safePageSize, total: 0, rows: [] }
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.db.prepare(`
      SELECT uid, name, node_type, item_id, raw_json
      FROM records
      WHERE uid IN (${placeholders})
      ORDER BY last_modify_time DESC, uid DESC
      LIMIT ? OFFSET ?
    `).all(...ids, safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM records WHERE uid IN (${placeholders})`).get(...ids) as SqlRow
    const fieldValue = (raw: Record<string, unknown>, path: string): string | string[] => {
      const value = path.split('.').reduce<unknown>((current, key) => (
        current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined
      ), raw)
      if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitizeContextText(item, 512))
      return sanitizeContextText(value, 512)
    }
    return {
      page: safePage,
      pageSize: safePageSize,
      total: Number(totalRow.total ?? ids.length),
      rows: rows.map((row) => {
        let raw: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(String(row.raw_json ?? '{}')) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>
        } catch { /* malformed raw fields remain empty */ }
        return {
          uid: String(row.uid),
          name: sanitizeContextText(row.name, 240),
          nodeType: sanitizeContextText(row.node_type, 120),
          itemId: sanitizeContextText(row.item_id, 160),
          values: Object.fromEntries(selectedFields.map((field) => [field, fieldValue(raw, field)]))
        }
      })
    }
  }

  getRecordImagePage(uid: string, page = 1, pageSize = 12): RecordImagePage {
    const normalizedUid = uid.trim()
    const safePage = Math.max(1, Math.trunc(page || 1))
    const safePageSize = Math.min(48, Math.max(1, Math.trunc(pageSize || 12)))
    if (!normalizedUid) return { page: safePage, pageSize: safePageSize, total: 0, images: [] }
    const totalRow = this.db.prepare('SELECT COUNT(*) AS total FROM images WHERE record_uid = ?')
      .get(normalizedUid) as SqlRow
    const rows = this.db.prepare(`
      SELECT * FROM images
      WHERE record_uid = ?
      ORDER BY created_at, id
      LIMIT ? OFFSET ?
    `).all(normalizedUid, safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    return {
      page: safePage,
      pageSize: safePageSize,
      total: Number(totalRow.total ?? 0),
      images: rows.map((row) => this.mapImage(row))
    }
  }

  getRecord(
    uid: string,
    includeImages = true,
    semanticContext?: RequirementSemanticizationContext,
    maintenanceModelVersion = ''
  ): RecordDetail | null {
    const row = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count,
                ${requirementSemanticContentSql('r')} AS semantic_current_content_hash,
                s.status AS semantic_raw_status,
                s.content_hash AS semantic_content_hash,
                s.analyzer_version AS semantic_analyzer_version,
                s.model_signature AS semantic_model_signature,
                s.error_message AS semantic_error_message,
                s.analysis_trace_json AS semantic_analysis_trace_json,
                s.updated_at AS semantic_updated_at
         FROM records r
         LEFT JOIN images i ON i.record_uid = r.uid
         LEFT JOIN requirement_semantic_cards s ON s.record_uid = r.uid
         WHERE r.uid = ? GROUP BY r.uid`
      )
      .get(uid) as SqlRow | undefined
    if (!row) return null
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(String(row.raw_json)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>
      }
    } catch {
      raw = {}
    }
    const fieldLabels = this.getFieldDisplayNames(
      String(row.node_type ?? ''),
      Object.keys(raw)
    )
    const images = includeImages
      ? (
          this.db
            .prepare('SELECT * FROM images WHERE record_uid = ? ORDER BY created_at')
            .all(uid) as SqlRow[]
        ).map((image) => this.mapImage(image))
      : []
    let semanticAnalysisTrace: RequirementSemanticizationAnalysisTrace | undefined
    try {
      const parsed: unknown = JSON.parse(String(row.semantic_analysis_trace_json ?? '{}'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
        Number((parsed as Record<string, unknown>).version) === 1) {
        semanticAnalysisTrace = parsed as RequirementSemanticizationAnalysisTrace
      }
    } catch {
      semanticAnalysisTrace = undefined
    }
    return {
      ...this.mapRecord(row, semanticContext),
      normalizedText: String(row.normalized_text),
      raw,
      images,
      matchingText: this.requirementBusinessTextFromRow(row),
      maintenance: this.getRecordMaintenanceState(uid, maintenanceModelVersion),
      ...(semanticAnalysisTrace ? { semanticAnalysisTrace } : {}),
      ...(Object.keys(fieldLabels).length ? { fieldLabels } : {})
    }
  }

  markPushResult(
    uid: string,
    status: 'pending' | 'success' | 'failed',
    message = '',
    pushedUid = ''
  ): void {
    this.statsCache = null
    this.db
      .prepare(
        `UPDATE records
         SET push_status=?, push_message=?, pushed_at=?, pushed_uid=?
         WHERE uid=?`
      )
      .run(
        status,
        message,
        status === 'pending' ? '' : nowIso(),
        pushedUid,
        uid
      )
  }

  beginPushLog(input: {
    recordUid: string
    recordName: string
    endpoint: string
    params: Record<string, string>
    body: Record<string, unknown>
  }): number {
    const redact = (value: unknown, key = ''): unknown => {
      if (typeof value === 'string') {
        if (
          /description/i.test(key) ||
          /(?:data:image\/[^;,\s]+;base64,|visslm-asset:\/\/)/i.test(value)
        ) return '[富文本图片内容已省略]'
        return value.length > 100_000 ? `${value.slice(0, 100_000)}…` : value
      }
      if (Array.isArray(value)) return value.map((item) => redact(item, key))
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
            childKey,
            redact(child, childKey)
          ])
        )
      }
      return value
    }
    const loggedBody = redact(input.body) as Record<string, unknown>
    // Keep diagnostics useful without persisting the complete rich-text body.
    delete loggedBody._valm_Description
    const result = this.db
      .prepare(
        `INSERT INTO push_logs(
          record_uid, record_name, method, endpoint, params_json, body_json,
          status, created_at
        ) VALUES (?, ?, 'POST', ?, ?, ?, 'sending', ?)`
      )
      .run(
        input.recordUid,
        input.recordName,
        input.endpoint,
        JSON.stringify(input.params),
        JSON.stringify(loggedBody),
        nowIso()
      )
    return Number(result.lastInsertRowid)
  }

  finishPushLog(
    id: number,
    status: Exclude<PushLogStatus, 'sending'>,
    input: {
      httpStatus?: number
      response?: unknown
      errorMessage?: string
      remoteUid?: string
    }
  ): void {
    const safeResponse = input.response === undefined
      ? ''
      : JSON.stringify(input.response, (key, value) => {
          if (typeof value === 'string' && (
            /description|base64|token|cookie|authorization/i.test(key) ||
            /(?:data:image\/[^;\s]+;base64,|visslm-asset:\/\/)/i.test(value)
          )) return '[敏感内容已省略]'
          return value
        })
    this.db
      .prepare(
        `UPDATE push_logs
         SET status=?, http_status=?, response_json=?, error_message=?,
             remote_uid=?, finished_at=?
         WHERE id=?`
      )
      .run(
        status,
        input.httpStatus ?? 0,
        safeResponse,
        input.errorMessage ?? '',
        input.remoteUid ?? '',
        nowIso(),
        id
      )
  }

  listPushLogs(page = 1, pageSize = 50): PushLogPage {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(200, Math.max(1, Math.floor(pageSize)))
    const rows = this.db
      .prepare('SELECT * FROM push_logs ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    const total = this.db.prepare('SELECT COUNT(*) AS value FROM push_logs').get() as SqlRow
    return {
      rows: rows.map((row) => this.mapPushLog(row)),
      total: Number(total.value ?? 0)
    }
  }

  private mapPushLog(row: SqlRow): PushLogRow {
    const parseJson = (input: unknown, fallback: unknown): unknown => {
      if (!input) return fallback
      try {
        return JSON.parse(String(input)) as unknown
      } catch {
        return fallback
      }
    }
    const status = String(row.status)
    return {
      id: Number(row.id),
      recordUid: String(row.record_uid),
      recordName: String(row.record_name),
      method: 'POST',
      endpoint: String(row.endpoint),
      params: parseJson(row.params_json, {}) as Record<string, string>,
      body: parseJson(row.body_json, {}) as Record<string, unknown>,
      status: ['success', 'failed'].includes(status)
        ? status as 'success' | 'failed'
        : 'sending',
      httpStatus: Number(row.http_status ?? 0),
      response: parseJson(row.response_json, undefined),
      errorMessage: String(row.error_message ?? ''),
      remoteUid: String(row.remote_uid ?? ''),
      createdAt: String(row.created_at),
      finishedAt: String(row.finished_at)
    }
  }

  beginCollectionRequestLog(input: {
    nodeType: string
    endpoint: string
    params: Record<string, string>
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO collection_request_logs(
          node_type, method, endpoint, params_json, status, created_at
        ) VALUES (?, 'GET', ?, ?, 'running', ?)`
      )
      .run(
        input.nodeType,
        input.endpoint,
        JSON.stringify(input.params),
        nowIso()
      )
    return Number(result.lastInsertRowid)
  }

  finishCollectionRequestLog(
    id: number,
    status: Exclude<CollectionRequestLogStatus, 'running'>,
    input: {
      httpStatus?: number
      recordCount?: number
      response?: unknown
      errorMessage?: string
    }
  ): void {
    this.db
      .prepare(
        `UPDATE collection_request_logs
         SET status=?, http_status=?, record_count=?, response_json=?,
             error_message=?, finished_at=?
         WHERE id=?`
      )
      .run(
        status,
        input.httpStatus ?? 0,
        input.recordCount ?? 0,
        input.response === undefined ? '' : JSON.stringify(input.response),
        input.errorMessage ?? '',
        nowIso(),
        id
      )
  }

  listCollectionRequestLogs(page = 1, pageSize = 50): CollectionRequestLogPage {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(200, Math.max(1, Math.floor(pageSize)))
    const rows = this.db
      .prepare('SELECT * FROM collection_request_logs ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    const total = this.db
      .prepare('SELECT COUNT(*) AS value FROM collection_request_logs')
      .get() as SqlRow
    return {
      rows: rows.map((row) => this.mapCollectionRequestLog(row)),
      total: Number(total.value ?? 0)
    }
  }

  private mapCollectionRequestLog(row: SqlRow): CollectionRequestLogRow {
    const parseJson = (input: unknown, fallback: unknown): unknown => {
      if (!input) return fallback
      try {
        return JSON.parse(String(input)) as unknown
      } catch {
        return fallback
      }
    }
    const status = String(row.status)
    return {
      id: Number(row.id),
      nodeType: String(row.node_type),
      method: 'GET',
      endpoint: String(row.endpoint),
      params: parseJson(row.params_json, {}) as Record<string, string>,
      status: ['success', 'failed'].includes(status)
        ? status as 'success' | 'failed'
        : 'running',
      httpStatus: Number(row.http_status ?? 0),
      recordCount: Number(row.record_count ?? 0),
      response: parseJson(row.response_json, undefined),
      errorMessage: String(row.error_message ?? ''),
      createdAt: String(row.created_at),
      finishedAt: String(row.finished_at)
    }
  }

  private mapDataReview(row: SqlRow): DataReviewItem {
    const source = String(row.source) === 'sync' ? 'sync' : 'import'
    return {
      id: String(row.id),
      source,
      itemId: String(row.item_id),
      existing: {
        uid: String(row.existing_uid),
        projectId: String(row.existing_project_id ?? ''),
        nodeType: String(row.existing_node_type ?? ''),
        name: String(row.existing_name ?? ''),
        lastModifyTime: String(row.existing_last_modify_time ?? '')
      },
      incoming: {
        uid: String(row.incoming_uid),
        projectId: String(row.incoming_project_id ?? ''),
        nodeType: String(row.incoming_node_type ?? ''),
        name: String(row.incoming_name ?? ''),
        lastModifyTime: String(row.incoming_last_modify_time ?? '')
      }
    }
  }

  private semanticStatus(value: unknown): RequirementSemanticizationStatus {
    const normalized = String(value ?? '')
    return ['processing', 'ready', 'failed'].includes(normalized)
      ? normalized as RequirementSemanticizationStatus
      : 'pending'
  }

  private semanticStatusOf(
    row: SqlRow,
    context?: RequirementSemanticizationContext
  ): { status: RequirementSemanticizationStatus; reason: RequirementSemanticizationStatusReason } {
    if (!row.semantic_raw_status) return { status: 'pending', reason: 'missing' }
    if (context) {
      if (String(row.semantic_content_hash ?? '') !== String(row.semantic_current_content_hash ?? '')) {
        return { status: 'pending', reason: 'content_changed' }
      }
      if (String(row.semantic_analyzer_version ?? '') !== context.analyzerVersion) {
        return { status: 'pending', reason: 'analyzer_changed' }
      }
      if (String(row.semantic_model_signature ?? '') !== context.modelSignature) {
        return { status: 'pending', reason: 'model_changed' }
      }
    }
    const status = this.semanticStatus(row.semantic_raw_status)
    if (status === 'processing') return { status, reason: 'processing' }
    if (status === 'ready') return { status, reason: 'ready' }
    if (status === 'failed') return { status, reason: 'failed' }
    return { status: 'pending', reason: 'missing' }
  }

  private mapRecord(row: SqlRow, semanticContext?: RequirementSemanticizationContext): RecordRow {
    let raw: Record<string, unknown> = {}
    try {
      raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
    } catch {
      // Corrupt legacy raw JSON should not prevent the data table from loading.
    }
    const semantic = this.semanticStatusOf(row, semanticContext)
    return {
      uid: String(row.uid),
      projectId: String(row.project_id),
      nodeType: String(row.node_type),
      itemId: String(row.item_id),
      parentId: String(row.parent_id),
      name: String(row.name),
      description:
        raw._valm_Description === undefined || raw._valm_Description === null
          ? ''
          : String(raw._valm_Description),
      releaseText: releaseTextFromRaw(raw),
      lastModifyTime: String(row.last_modify_time),
      syncedAt: String(row.synced_at),
      imageCount: Number(row.image_count ?? 0),
      pushStatus: ['success', 'failed'].includes(String(row.push_status))
        ? String(row.push_status) as 'success' | 'failed'
        : 'pending',
      pushMessage: String(row.push_message ?? ''),
      pushedAt: String(row.pushed_at ?? ''),
      pushedUid: String(row.pushed_uid ?? ''),
      semanticStatus: semantic.status,
      semanticStatusReason: semantic.reason,
      semanticError: semantic.status === 'failed' ? String(row.semantic_error_message ?? '') : '',
      semanticUpdatedAt: String(row.semantic_updated_at ?? '')
    }
  }

  searchForAgent(search: string, projectId?: string, limit = 8): Array<{
    source: ChatSource
    text: string
    raw: Record<string, unknown>
  }> {
    const page = this.listRecords({
      page: 1,
      pageSize: limit,
      search,
      projectId
    })
    return page.rows.map((row) => {
      const detail = this.getRecord(row.uid, false)!
      return {
        source: {
          uid: row.uid,
          name: row.name,
          nodeType: row.nodeType,
          itemId: row.itemId,
          sourceType: 'record' as const
        },
        text: detail.normalizedText ?? '',
        raw: detail.raw
      }
    })
  }

  hasRecords(): boolean {
    const row = this.db
      .prepare('SELECT EXISTS(SELECT 1 FROM records LIMIT 1) AS present')
      .get() as SqlRow | undefined
    return Number(row?.present ?? 0) === 1
  }

  getStats(): DashboardStats {
    const revision = this.getAnalyticsRevision()
    if (
      this.statsCache?.revision === revision &&
      Date.now() - this.statsCache.createdAt < 1_000
    ) return this.statsCache.value
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as SqlRow
      return Number(Object.values(row)[0] ?? 0)
    }
    const byType = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(node_type, ''), 'Unknown') AS name, COUNT(*) AS value
         FROM records GROUP BY node_type ORDER BY value DESC`
      )
      .all() as SqlRow[]
    const byProject = this.db
      .prepare(
        `SELECT p.name AS name, COUNT(r.uid) AS value
         FROM projects p LEFT JOIN records r ON r.project_id = p.uid
         GROUP BY p.uid ORDER BY value DESC`
      )
      .all() as SqlRow[]
    const projectManagement = {
      projectCount: scalar('SELECT COUNT(*) FROM pm_projects'),
      activeProjectCount: scalar("SELECT COUNT(*) FROM pm_projects WHERE lifecycle = 'active'"),
      processingProjectCount: scalar(
        "SELECT COUNT(*) FROM pm_projects WHERE analysis_status = 'processing' OR match_status = 'processing'"
      ),
      requirementCount: scalar(
        `SELECT COUNT(*) FROM pm_requirements q
         WHERE q.review_status = 'approved'
           AND (q.set_id = '' OR q.set_id IN (
             SELECT id FROM pm_requirement_sets WHERE project_id = q.project_id AND status = 'published'
           ))`
      ),
      pendingReviewCount: scalar("SELECT COUNT(*) FROM pm_requirements WHERE review_status = 'pending'"),
      linkedAssetCount: scalar('SELECT COUNT(*) FROM pm_project_assets')
    }
    const assetCenter = {
      recordCount: scalar('SELECT COUNT(*) FROM records'),
      projectCount: scalar(
        "SELECT COUNT(DISTINCT project_id) FROM records WHERE project_id IS NOT NULL AND TRIM(project_id) <> ''"
      ),
      typeCount: byType.length,
      imageCount: scalar('SELECT COUNT(*) FROM images')
    }
    const releaseCounts = new Map<string, number>()
    try {
      // JSON1 keeps the dashboard aggregation in SQLite instead of
      // materializing and parsing every raw record in the main process.
      const releaseRows = this.db.prepare(`
        WITH release_values AS (
          SELECT CASE
            WHEN json_valid(raw_json)
              AND NULLIF(TRIM(CAST(json_extract(raw_json, '$._valm_Release_text') AS TEXT)), '') IS NOT NULL
              THEN CASE json_type(raw_json, '$._valm_Release_text')
                WHEN 'true' THEN 'true'
                WHEN 'false' THEN 'false'
                ELSE CAST(json_extract(raw_json, '$._valm_Release_text') AS TEXT)
              END
            WHEN json_valid(raw_json)
              AND NULLIF(TRIM(CAST(json_extract(raw_json, '$._valm_Release') AS TEXT)), '') IS NOT NULL
              THEN CASE json_type(raw_json, '$._valm_Release')
                WHEN 'true' THEN 'true'
                WHEN 'false' THEN 'false'
                ELSE CAST(json_extract(raw_json, '$._valm_Release') AS TEXT)
              END
            ELSE '未设置'
          END AS name
          FROM records
        )
        SELECT name, COUNT(*) AS value
        FROM release_values
        GROUP BY name
        ORDER BY value DESC, name COLLATE NOCASE ASC
      `).all() as SqlRow[]
      for (const row of releaseRows) {
        releaseCounts.set(String(row.name), Number(row.value ?? 0))
      }
    } catch {
      // Keep compatibility with a SQLite build without JSON1.  This fallback
      // is intentionally isolated to the dashboard release chart.
      const releaseRows = this.db.prepare('SELECT raw_json FROM records').all() as SqlRow[]
      for (const row of releaseRows) {
        let raw: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(String(row.raw_json)) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            raw = parsed as Record<string, unknown>
          }
        } catch {
          // Corrupt legacy raw JSON is grouped under the empty release.
        }
        const name = releaseNameFromRaw(raw)
        releaseCounts.set(name, (releaseCounts.get(name) ?? 0) + 1)
      }
    }
    const value: DashboardStats = {
      projectCount: scalar('SELECT COUNT(*) FROM projects'),
      recordCount: scalar('SELECT COUNT(*) FROM records'),
      collectedCount: scalar('SELECT COUNT(*) FROM records'),
      pushedCount: scalar("SELECT COUNT(*) FROM records WHERE push_status = 'success'"),
      imageCount: scalar('SELECT COUNT(*) FROM images'),
      byType: byType.map((row) => ({ name: String(row.name), value: Number(row.value) })),
      byProject: byProject.map((row) => ({
        name: String(row.name),
        value: Number(row.value)
      })),
      byRelease: [...releaseCounts.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => right.value - left.value),
      projectManagement,
      assetCenter
    }
    this.statsCache = { revision, createdAt: Date.now(), value }
    return value
  }

  aggregate(
    metric: string,
    projectId?: string,
    scope: Pick<FieldQueryOptions, 'projectIds' | 'nodeTypes' | 'recordUids' | 'baseFilters' | 'filters'> = {}
  ): unknown {
    const projectIds = scope.projectIds
      ? [...new Set(scope.projectIds.map((value) => value.trim()).filter(Boolean))]
      : undefined
    const nodeTypes = scope.nodeTypes
      ? [...new Set(scope.nodeTypes.map((value) => value.trim()).filter(Boolean))]
      : undefined
    const clauses: string[] = []
    const params: string[] = []
    if (projectIds !== undefined) {
      if (!projectIds.length) clauses.push('1 = 0')
      else {
        clauses.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`)
        params.push(...projectIds)
      }
    } else if (projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(projectId.trim())
    }
    if (nodeTypes !== undefined) {
      if (!nodeTypes.length) clauses.push('1 = 0')
      else {
        clauses.push(`node_type IN (${nodeTypes.map(() => '?').join(', ')})`)
        params.push(...nodeTypes)
      }
    }
    if (scope.recordUids !== undefined) {
      const recordUids = [...new Set(scope.recordUids.map((value) => value.trim()).filter(Boolean))]
      if (!recordUids.length) clauses.push('1 = 0')
      else {
        clauses.push(`uid IN (${recordUids.map(() => '?').join(', ')})`)
        params.push(...recordUids)
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const scopeFilters = [...(scope.baseFilters ?? []), ...(scope.filters ?? [])]
      .filter((filter) => filter.field?.trim())
    if (scopeFilters.length) {
      const rows = this.db
        .prepare(`SELECT uid, project_id, node_type, raw_json FROM records${where}`)
        .all(...params) as SqlRow[]
      const matchedRows = rows.filter((row) => {
        let raw: Record<string, unknown>
        try {
          raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
        } catch {
          return false
        }
        return scopeFilters.every((filter) => matchesFieldFilter(
          normalizedFieldValues(fieldValuesAtPath(raw, filter.field.trim()), false),
          filter
        ))
      })
      if (metric === 'record_count') return { metric, value: matchedRows.length }
      if (metric === 'image_count') {
        const recordUids = matchedRows.map((row) => String(row.uid)).filter(Boolean)
        if (!recordUids.length) return { metric, value: 0 }
        const placeholders = recordUids.map(() => '?').join(', ')
        const row = this.db
          .prepare(`SELECT COUNT(*) AS value FROM images WHERE record_uid IN (${placeholders})`)
          .get(...recordUids) as SqlRow
        return { metric, value: Number(row.value ?? 0) }
      }
      const grouped = new Map<string, number>()
      const keyName = metric === 'count_by_project' ? 'project_id' : 'node_type'
      for (const row of matchedRows) {
        const name = String(row[keyName] ?? '')
        grouped.set(name, (grouped.get(name) ?? 0) + 1)
      }
      return [...grouped.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
    }
    if (metric === 'record_count') {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS value FROM records${where}`)
        .get(...params) as SqlRow
      return { metric, value: Number(row.value) }
    }
    if (metric === 'image_count') {
      const imageClauses = clauses.map((clause) => clause
        .replace(/\bproject_id\b/g, 'r.project_id')
        .replace(/\bnode_type\b/g, 'r.node_type')
        .replace(/\buid\b/g, 'r.uid'))
      const imageWhere = imageClauses.length ? ` WHERE ${imageClauses.join(' AND ')}` : ''
      const sql = imageClauses.length
        ? `SELECT COUNT(*) AS value FROM images i
           JOIN records r ON r.uid=i.record_uid${imageWhere}`
        : 'SELECT COUNT(*) AS value FROM images'
      const row = this.db.prepare(sql).get(...params) as SqlRow
      return { metric, value: Number(row.value) }
    }
    if (metric === 'count_by_project') {
      // Keep the cached dashboard path for an unscoped request, but execute a
      // real grouped query whenever the confirmation scope narrows projects,
      // types, or records.  This prevents a confirmed patch from changing
      // only the displayed summary while the aggregate still reads all data.
      if (!clauses.length) return this.getStats().byProject
      const rows = this.db
        .prepare(
          `SELECT project_id AS name, COUNT(*) AS value FROM records${where}
           GROUP BY project_id ORDER BY value DESC, name COLLATE NOCASE ASC`
        )
        .all(...params) as SqlRow[]
      return rows.map((row) => ({ name: String(row.name), value: Number(row.value ?? 0) }))
    }
    const rows = this.db
      .prepare(
        `SELECT node_type AS name, COUNT(*) AS value FROM records${where}
         GROUP BY node_type ORDER BY value DESC`
      )
      .all(...params) as SqlRow[]
    return rows.map((row) => ({ name: String(row.name), value: Number(row.value) }))
  }

  aggregateByField(options: FieldAggregateOptions): FieldAggregateResult {
    const field = options.field.trim()
    if (!field || field.length > 160) throw new Error('统计字段不能为空且不能超过 160 个字符')

    const projectIds = options.projectIds
      ? [...new Set(options.projectIds.map((value) => value.trim()).filter(Boolean))]
      : undefined
    const nodeTypes = options.nodeTypes
      ? [...new Set(options.nodeTypes.map((value) => value.trim()).filter(Boolean))]
      : undefined
    const clauses: string[] = []
    const params: string[] = []
    if (projectIds !== undefined) {
      if (!projectIds.length) clauses.push('1 = 0')
      else {
        clauses.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`)
        params.push(...projectIds)
      }
    } else if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    if (nodeTypes !== undefined) {
      if (!nodeTypes.length) clauses.push('1 = 0')
      else {
        clauses.push(`node_type IN (${nodeTypes.map(() => '?').join(', ')})`)
        params.push(...nodeTypes)
      }
    } else if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    if (options.recordUids !== undefined) {
      const recordUids = [...new Set(options.recordUids.map((value) => value.trim()).filter(Boolean))]
      if (!recordUids.length) clauses.push('1 = 0')
      else {
        clauses.push(`uid IN (${recordUids.map(() => '?').join(', ')})`)
        params.push(...recordUids)
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT uid, name, node_type, item_id, raw_json
         FROM records${where}`
      )
       .all(...params) as SqlRow[]

    const splitMultiValue = options.splitMultiValue !== false
    const counts = new Map<string, {
      name: string
      value: number
      examples: Array<{ source: ChatSource }>
    }>()
    let matchedRecords = 0
    let valueOccurrences = 0

    for (const row of rows) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        continue
      }
      const inheritedFilters = [...(options.baseFilters ?? []), ...(options.filters ?? [])]
      if (!inheritedFilters.every((filter) => matchesFieldFilter(
        normalizedFieldValues(fieldValuesAtPath(raw, filter.field.trim()), false),
        filter
      ))) continue
      const values = normalizedFieldValues(fieldValuesAtPath(raw, field), splitMultiValue)
      if (!values.length) continue
      matchedRecords += 1
      valueOccurrences += values.length
      for (const currentValue of values) {
        const normalizedKey = currentValue.toLocaleLowerCase()
        const current = counts.get(normalizedKey) ?? {
          name: currentValue,
          value: 0,
          examples: []
        }
        current.value += 1
        if (current.examples.length < 2) {
          current.examples.push({
            source: {
              uid: String(row.uid),
              name: String(row.name),
              nodeType: String(row.node_type),
              itemId: String(row.item_id),
              sourceType: 'record' as const
            }
          })
        }
        counts.set(normalizedKey, current)
      }
    }

    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 10)))
    const items = [...counts.values()]
      .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name, 'zh-CN'))
      .slice(0, limit)

    return {
      field,
      totalRecords: rows.length,
      matchedRecords,
      emptyRecords: rows.length - matchedRecords,
      valueOccurrences,
      splitMultiValue,
      items
    }
  }

  inspectFields(options: FieldInspectionOptions = {}): FieldInspectionResult {
    const clauses: string[] = []
    const params: string[] = []
    const projectIds = options.projectIds === undefined
      ? undefined
      : [...new Set(options.projectIds.map((value) => value.trim()).filter(Boolean))]
    if (projectIds !== undefined) {
      if (!projectIds.length) clauses.push('1 = 0')
      else {
        clauses.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`)
        params.push(...projectIds)
      }
    } else if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    const nodeTypes = options.nodeTypes === undefined
      ? undefined
      : [...new Set(options.nodeTypes.map((value) => value.trim()).filter(Boolean))]
    if (nodeTypes !== undefined) {
      if (!nodeTypes.length) clauses.push('1 = 0')
      else {
        clauses.push(`node_type IN (${nodeTypes.map(() => '?').join(', ')})`)
        params.push(...nodeTypes)
      }
    } else if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    if (options.recordUids !== undefined) {
      const recordUids = [...new Set(options.recordUids.map((value) => value.trim()).filter(Boolean))]
      if (!recordUids.length) clauses.push('1 = 0')
      else {
        clauses.push(`uid IN (${recordUids.map(() => '?').join(', ')})`)
        params.push(...recordUids)
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT node_type, raw_json FROM records${where}`).all(...params) as SqlRow[]
    const profiles = new Map<string, {
      nonEmptyRecords: number
      types: Set<string>
      samples: string[]
    }>()

    for (const row of rows) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        continue
      }
      for (const [field, rawValues] of collectRecordFieldValues(raw)) {
        const values = normalizedFieldValues(rawValues, false)
        if (!values.length) continue
        const profile = profiles.get(field) ?? {
          nonEmptyRecords: 0,
          types: new Set<string>(),
          samples: []
        }
        profile.nonEmptyRecords += 1
        rawValues.forEach((value) => {
          if (Array.isArray(value)) {
            value.forEach((item) => profile.types.add(scalarType(item)))
          } else {
            profile.types.add(scalarType(value))
          }
        })
        for (const value of values) {
          const sample = value.length > 120 ? `${value.slice(0, 117)}...` : value
          if (!profile.samples.includes(sample) && profile.samples.length < 5) {
            profile.samples.push(sample)
          }
        }
        profiles.set(field, profile)
      }
    }

    const searchTerms = fieldSearchTerms(options.search)
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 40)))
    const displayNames = this.getFieldDisplayNames(
      options.nodeType?.trim() || [...new Set(rows.map((row) => String(row.node_type ?? '').trim()))],
      [...profiles.keys()]
    )
    const declaredDefinitions = new Map<string, FieldDefinition>()
    const definitionNodeTypes = options.nodeType?.trim()
      ? options.nodeType.trim()
      : [...new Set(rows.map((row) => String(row.node_type ?? '').trim()).filter(Boolean))]
    for (const definition of this.getFieldDefinitions(definitionNodeTypes, [...profiles.keys()])) {
      if (!declaredDefinitions.has(definition.field)) declaredDefinitions.set(definition.field, definition)
    }
    const fields = [...profiles.entries()]
      .filter(([field]) =>
        !searchTerms.length ||
        searchTerms.some((term) =>
          field.toLocaleLowerCase().includes(term) ||
          (displayNames[field] ?? '').toLocaleLowerCase().includes(term)
        )
      )
      .sort((left, right) =>
        right[1].nonEmptyRecords - left[1].nonEmptyRecords ||
        left[0].localeCompare(right[0], 'zh-CN')
      )
      .slice(0, limit)
      .map(([field, profile]) => {
        const definition = declaredDefinitions.get(field)
        return {
          field,
          ...(displayNames[field] ? { displayName: displayNames[field] } : {}),
          ...(definition ? {
            declaredType: definition.normalizedType,
            ...(definition.sourceType ? { sourceType: definition.sourceType } : {}),
            ...(definition.attrType ? { attrType: definition.attrType } : {})
          } : {}),
          nonEmptyRecords: profile.nonEmptyRecords,
          coverageRate: rows.length
            ? Number(((profile.nonEmptyRecords / rows.length) * 100).toFixed(2))
            : 0,
          types: [...profile.types].sort(),
          samples: profile.samples
        }
      })

    return { totalRecords: rows.length, fields }
  }

  queryRecordsByFields(options: FieldQueryOptions): FieldQueryResult {
    const clauses: string[] = []
    const params: string[] = []
    const projectIds = options.projectIds === undefined
      ? undefined
      : [...new Set(options.projectIds.map((value) => value.trim()).filter(Boolean))]
    if (projectIds !== undefined) {
      if (!projectIds.length) clauses.push('1 = 0')
      else {
        clauses.push(`project_id IN (${projectIds.map(() => '?').join(', ')})`)
        params.push(...projectIds)
      }
    } else if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    const nodeTypes = options.nodeTypes === undefined
      ? undefined
      : [...new Set(options.nodeTypes.map((value) => value.trim()).filter(Boolean))]
    if (nodeTypes !== undefined) {
      if (!nodeTypes.length) clauses.push('1 = 0')
      else {
        clauses.push(`node_type IN (${nodeTypes.map(() => '?').join(', ')})`)
        params.push(...nodeTypes)
      }
    } else if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    if (options.recordUids !== undefined) {
      const recordUids = [...new Set(options.recordUids.map((value) => value.trim()).filter(Boolean))]
      if (!recordUids.length) clauses.push('1 = 0')
      else {
        clauses.push(`uid IN (${recordUids.map(() => '?').join(', ')})`)
        params.push(...recordUids)
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT uid, name, node_type, item_id, raw_json, normalized_text
         FROM records${where}`
      )
      .all(...params) as SqlRow[]
    const fields = [...new Set((options.fields ?? []).map((field) => field.trim()).filter(Boolean))]
      .slice(0, 20)
    const filters = [...(options.baseFilters ?? []), ...(options.filters ?? [])]
      .filter((filter) => filter.field?.trim())
      .slice(0, 10)
    const normalizeSearchTerm = (value: unknown): string => String(value ?? '')
      .normalize('NFKC')
      .trim()
      .toLocaleLowerCase()
    const searchTerms = [
      ...(options.searchTerms ?? []),
      ...(options.search?.trim() ? [options.search] : [])
    ]
      .map(normalizeSearchTerm)
      .filter(Boolean)
      .filter((term, index, values) => values.indexOf(term) === index)
      .slice(0, 12)
    const searchMode = options.searchMode === 'all' ? 'all' : 'any'

    const matched = rows.flatMap((row) => {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        return []
      }
      let matchedTerms: string[] = []
      if (searchTerms.length) {
        const searchable = [
          String(row.name),
          String(row.item_id),
          String(row.normalized_text)
        ].join('\n').normalize('NFKC').toLocaleLowerCase()
        const termMatches = searchTerms.map((term) => searchable.includes(term))
        if (
          (searchMode === 'all' && !termMatches.every(Boolean)) ||
          (searchMode === 'any' && !termMatches.some(Boolean))
        ) return []
        matchedTerms = searchTerms.filter((_term, index) => termMatches[index])
      }
      const passes = filters.every((filter) => {
        const values = normalizedFieldValues(
          fieldValuesAtPath(raw, filter.field.trim()),
          false
        )
        return matchesFieldFilter(values, filter)
      })
      if (!passes) return []

      const values: Record<string, string | string[]> = {}
      for (const field of fields) {
        const selected = normalizedFieldValues(fieldValuesAtPath(raw, field), false)
        values[field] = selected.length <= 1 ? selected[0] ?? '' : selected
      }
      return [{
        source: {
          uid: String(row.uid),
          name: String(row.name),
          nodeType: String(row.node_type),
          itemId: String(row.item_id),
          sourceType: 'record' as const
        },
        values,
        ...(matchedTerms.length ? { matchedTerms } : {}),
        raw
      }]
    })

    if (options.sort?.field.trim()) {
      const sortField = options.sort.field.trim()
      const direction = options.sort.direction === 'desc' ? -1 : 1
      matched.sort((left, right) => {
        const leftValue = normalizedFieldValues(fieldValuesAtPath(left.raw, sortField), false)[0] ?? ''
        const rightValue = normalizedFieldValues(fieldValuesAtPath(right.raw, sortField), false)[0] ?? ''
        const a = comparisonValue(leftValue)
        const b = comparisonValue(rightValue)
        if (typeof a === typeof b) {
          if (a < b) return -1 * direction
          if (a > b) return 1 * direction
        }
        return 0
      })
    }

    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 10)))
    const records = matched.slice(0, limit).map(({ source, values, matchedTerms }) => ({
      source,
      values,
      ...(matchedTerms?.length ? { matchedTerms } : {})
    }))
    const recordUids = compactRecordUids(
      matched.map(({ source }) => source.uid),
      FIELD_QUERY_UID_LIMIT
    )
    const recordUidsByTerm = Object.fromEntries(
      searchTerms.map((term) => [
        term,
        compactRecordUids(
          matched
            .filter(({ matchedTerms }) => matchedTerms?.includes(term))
            .map(({ source }) => source.uid),
          FIELD_QUERY_UID_LIMIT
        )
      ])
    )
    const fieldLabels = this.getFieldDisplayNames(
      nodeTypes?.length
        ? nodeTypes
        : options.nodeType?.trim() || [...new Set(matched.map((item) => item.source.nodeType))],
      fields
    )
    return {
      totalScanned: rows.length,
      matchedCount: matched.length,
      returnedCount: records.length,
      recordUids,
      recordUidsByTerm,
      fields,
      ...(Object.keys(fieldLabels).length ? { fieldLabels } : {}),
      records
    }
  }

  beginSync(): number {
    const result = this.db
      .prepare("INSERT INTO sync_runs(started_at, status) VALUES (?, 'running')")
      .run(nowIso())
    return Number(result.lastInsertRowid)
  }

  /**
   * A renderer/process crash can leave external request rows in an active
   * state forever.  Mark them failed on the next database open so the UI and
   * diagnostics describe the interruption accurately.  This is intentionally
   * a status repair only; replaying POST writes still requires an explicit
   * user action and a platform idempotency contract.
   */
  reconcileInterruptedExternalRuns(): {
    syncRuns: number
    pushLogs: number
    collectionRequests: number
  } {
    const timestamp = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const syncRuns = this.db.prepare(`
        UPDATE sync_runs
        SET status = 'failed', finished_at = ?,
            error_message = CASE
              WHEN error_message = '' THEN '应用在同步任务中断，可重新执行同步'
              ELSE error_message || '（应用重启中断）'
            END
        WHERE status = 'running'
      `).run(timestamp)
      const pushLogs = this.db.prepare(`
        UPDATE push_logs
        SET status = 'failed', finished_at = ?,
            error_message = CASE
              WHEN error_message = '' THEN '应用在推送请求中断，可根据日志手动重试'
              ELSE error_message || '（应用重启中断）'
            END
        WHERE status = 'sending'
      `).run(timestamp)
      const collectionRequests = this.db.prepare(`
        UPDATE collection_request_logs
        SET status = 'failed', finished_at = ?,
            error_message = CASE
              WHEN error_message = '' THEN '应用在采集请求中断，可重新执行采集'
              ELSE error_message || '（应用重启中断）'
            END
        WHERE status = 'running'
      `).run(timestamp)
      this.db.exec('COMMIT')
      return {
        syncRuns: Number(syncRuns.changes ?? 0),
        pushLogs: Number(pushLogs.changes ?? 0),
        collectionRequests: Number(collectionRequests.changes ?? 0)
      }
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  finishSync(
    id: number,
    status: 'success' | 'failed',
    counts: { projects: number; records: number; images: number },
    errorMessage = ''
  ): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET finished_at=?, status=?, project_count=?,
         record_count=?, image_count=?, error_message=? WHERE id=?`
      )
      .run(
        nowIso(),
        status,
        counts.projects,
        counts.records,
        counts.images,
        errorMessage,
        id
      )
    if (status === 'success' || counts.records > 0) this.bumpAnalyticsRevision()
  }

  listSyncRuns(): SyncRun[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10')
      .all() as SqlRow[]
    return rows.map((row) => ({
      id: Number(row.id),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      status: String(row.status),
      projectCount: Number(row.project_count),
      recordCount: Number(row.record_count),
      imageCount: Number(row.image_count),
      errorMessage: String(row.error_message)
    }))
  }

  private mapExportRow(row: SqlRow, includeBinary = true): Record<string, unknown> {
    const images = (
      this.db.prepare('SELECT * FROM images WHERE record_uid=?').all(String(row.uid)) as SqlRow[]
    ).map((image) => {
      const sha256 = String(image.sha256)
      const bytes = this.readAssetBytes(sha256)
      const storedState = String(image.state ?? 'ready')
      const state = storedState === 'unresolved' ? 'unresolved' : bytes ? 'ready' : 'missing'
      let base64 = ''
      if (includeBinary) {
        if (bytes) base64 = bytes.toString('base64')
        if (!base64) {
          try { base64 = readFileSync(String(image.base64_path), 'utf8').replace(/\s+/g, '') } catch { /* legacy file absent */ }
        }
      }
      return {
        id: String(image.id),
        name: String(image.name),
        mimeType: normalizeMimeType(image.mime_type),
        sourceUrl: String(image.source_url),
        sha256,
        byteSize: Number(image.byte_size ?? 0),
        ...(bytes && state === 'ready' ? { assetUrl: `visslm-asset://${sha256}/${String(image.id)}` } : {}),
        state,
        ...(String(image.error_message ?? '') ? { errorMessage: String(image.error_message) } : {}),
        ...(includeBinary ? { base64 } : {})
      }
    })
    return {
      documentId: `${row.node_type}:${row.uid}`,
      title: String(row.name),
      content: String(row.normalized_text),
      metadata: {
        projectId: String(row.project_id),
        recordType: String(row.node_type),
        sourceId: String(row.uid),
        itemId: String(row.item_id),
        updatedAt: String(row.last_modify_time),
        pushStatus: String(row.push_status ?? 'pending'),
        pushMessage: String(row.push_message ?? ''),
        pushedAt: String(row.pushed_at ?? ''),
        pushedUid: String(row.pushed_uid ?? '')
      },
      raw: (() => {
        try {
          return JSON.parse(String(row.raw_json))
        } catch {
          return {}
        }
      })(),
      images,
      imageReferences: this.listRecordImageReferences(String(row.uid))
    }
  }

  *iterateExportRows(recordUids?: ReadonlySet<string>): Generator<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM records ORDER BY project_id, node_type, uid')
      .iterate() as Iterable<SqlRow>
    for (const row of rows) {
      if (recordUids && !recordUids.has(String(row.uid))) continue
      yield this.mapExportRow(row)
    }
  }

  *iterateExportRowsWithoutBinary(recordUids?: ReadonlySet<string>): Generator<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM records ORDER BY project_id, node_type, uid')
      .iterate() as Iterable<SqlRow>
    for (const row of rows) {
      if (recordUids && !recordUids.has(String(row.uid))) continue
      yield this.mapExportRow(row, false)
    }
  }

  exportRows(recordUids?: ReadonlySet<string>): Array<Record<string, unknown>> {
    return [...this.iterateExportRows(recordUids)]
  }

  private mapDataImportRun(row: SqlRow): DataImportRunSnapshot {
    const rawStatus = String(row.status ?? '')
    const status: DataImportRunStatus = rawStatus === 'running' || rawStatus === 'success' || rawStatus === 'failed'
      ? rawStatus
      : 'failed'
    return {
      id: String(row.id),
      path: String(row.path ?? ''),
      format: String(row.format) === 'json' ? 'json' : 'jsonl',
      fileSize: Math.max(0, Number(row.file_size ?? 0)),
      fileMtimeMs: Math.max(0, Number(row.file_mtime_ms ?? 0)),
      status,
      batchCount: Number(row.batch_count ?? 0),
      sourceRowCount: Number(row.source_row_count ?? 0),
      importedRecordCount: Number(row.imported_record_count ?? 0),
      skippedCount: Number(row.skipped_count ?? 0),
      parseErrorCount: Number(row.parse_error_count ?? 0),
      reviewBatchId: String(row.review_batch_id ?? ''),
      errorMessage: String(row.error_message ?? ''),
      startedAt: String(row.started_at ?? ''),
      updatedAt: String(row.updated_at ?? ''),
      finishedAt: String(row.finished_at ?? '')
    }
  }

  startDataImportRun(
    path: string,
    format: 'json' | 'jsonl',
    fileSize = 0,
    fileMtimeMs = 0
  ): string {
    const id = randomUUID()
    const timestamp = nowIso()
    this.db.prepare(`
      INSERT INTO data_import_runs(
        id, path, format, file_size, file_mtime_ms, status, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      path.trim(),
      format,
      Math.max(0, Math.trunc(Number(fileSize) || 0)),
      Math.max(0, Math.trunc(Number(fileMtimeMs) || 0)),
      timestamp,
      timestamp
    )
    return id
  }

  updateDataImportRun(
    id: string,
    patch: Partial<Pick<DataImportRunSnapshot,
      'batchCount' | 'sourceRowCount' | 'importedRecordCount' | 'skippedCount' |
      'parseErrorCount' | 'reviewBatchId' | 'errorMessage'>>
  ): void {
    const fields: string[] = []
    const values: Array<string | number> = []
    const add = (column: string, value: string | number | undefined): void => {
      if (value === undefined) return
      fields.push(`${column} = ?`)
      values.push(value)
    }
    add('batch_count', patch.batchCount)
    add('source_row_count', patch.sourceRowCount)
    add('imported_record_count', patch.importedRecordCount)
    add('skipped_count', patch.skippedCount)
    add('parse_error_count', patch.parseErrorCount)
    add('review_batch_id', patch.reviewBatchId)
    add('error_message', patch.errorMessage)
    if (!fields.length) return
    fields.push('updated_at = ?')
    values.push(nowIso(), id.trim())
    this.db.prepare(`
      UPDATE data_import_runs SET ${fields.join(', ')} WHERE id = ? AND status = 'running'
    `).run(...values)
  }

  finishDataImportRun(
    id: string,
    status: Exclude<DataImportRunStatus, 'running'>,
    patch: Partial<Pick<DataImportRunSnapshot,
      'batchCount' | 'sourceRowCount' | 'importedRecordCount' | 'skippedCount' |
      'parseErrorCount' | 'reviewBatchId' | 'errorMessage'>> = {}
  ): void {
    const timestamp = nowIso()
    const fields: string[] = ['status = ?', 'updated_at = ?', 'finished_at = ?']
    const values: Array<string | number> = [status, timestamp, timestamp]
    const add = (column: string, value: string | number | undefined): void => {
      if (value === undefined) return
      fields.push(`${column} = ?`)
      values.push(value)
    }
    add('batch_count', patch.batchCount)
    add('source_row_count', patch.sourceRowCount)
    add('imported_record_count', patch.importedRecordCount)
    add('skipped_count', patch.skippedCount)
    add('parse_error_count', patch.parseErrorCount)
    add('review_batch_id', patch.reviewBatchId)
    add('error_message', patch.errorMessage)
    values.push(id.trim())
    this.db.prepare(`
      UPDATE data_import_runs SET ${fields.join(', ')} WHERE id = ? AND status = 'running'
    `).run(...values)
  }

  /** Re-open an interrupted legacy import while retaining its last checkpoint. */
  resumeDataImportRun(id: string): DataImportRunSnapshot | null {
    const normalizedId = id.trim()
    if (!normalizedId) return null
    this.db.prepare(`
      UPDATE data_import_runs
      SET status = 'running',
          error_message = '',
          finished_at = '',
          updated_at = ?
      WHERE id = ? AND status = 'failed'
    `).run(nowIso(), normalizedId)
    return this.getDataImportRun(normalizedId)
  }

  getDataImportRun(id: string): DataImportRunSnapshot | null {
    const row = this.db.prepare('SELECT * FROM data_import_runs WHERE id = ? LIMIT 1').get(id.trim()) as SqlRow | undefined
    return row ? this.mapDataImportRun(row) : null
  }

  listDataImportRuns(limit = 50): DataImportRunSnapshot[] {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit || 50)))
    const rows = this.db.prepare(`
      SELECT * FROM data_import_runs
      ORDER BY updated_at DESC, started_at DESC
      LIMIT ?
    `).all(safeLimit) as SqlRow[]
    return rows.map((row) => this.mapDataImportRun(row))
  }

  /** Mark streamed imports interrupted by a process exit and retain bounded diagnostics. */
  reconcileInterruptedDataImports(): number {
    const timestamp = nowIso()
    const cutoff = new Date(Date.now() - TASK_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db.prepare(`
        UPDATE data_import_runs
        SET status = 'failed',
            error_message = CASE
              WHEN error_message = '' THEN '应用在数据导入中断，已提交批次保留并可据运行记录诊断'
              ELSE error_message || '（应用重启中断）'
            END,
            updated_at = ?, finished_at = ?
        WHERE status = 'running'
      `).run(timestamp, timestamp)
      this.db.prepare(`
        DELETE FROM data_import_runs
        WHERE status IN ('success', 'failed') AND updated_at < ?
      `).run(cutoff)
      this.db.exec('COMMIT')
      return Number(result.changes ?? 0)
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* best effort */ }
      throw error
    }
  }

  importRows(
    rows: unknown[],
    options: {
      overwriteExisting?: boolean
      targetUidByItemId?: ReadonlyMap<string, string>
      /** Reuse one review batch when a streaming import commits multiple chunks. */
      reviewBatchId?: string
      /** Atomically advance a persisted streaming import checkpoint. */
      importRunId?: string
      batchNumber?: number
      sourceRowCount?: number
      parseErrorCount?: number
    } = {}
  ): DataImportResult {
    let recordCount = 0
    let imageCount = 0
    let skippedCount = 0
    const errors: string[] = []
    const duplicates: DataReviewItem[] = []
    let reviewBatchId: string | undefined = options.reviewBatchId
    const asObject = (input: unknown): Record<string, unknown> | null =>
      input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null
    const text = (input: unknown): string =>
      input === undefined || input === null ? '' : String(input)
    const stageDuplicate = (
      row: Record<string, unknown>,
      itemId: string,
      existing: RecordRow,
      incoming: DataReviewSummary
    ): void => {
      reviewBatchId ??= randomUUID()
      duplicates.push(this.stageDataReview({
        batchId: reviewBatchId,
        source: 'import',
        itemId,
        existing: {
          uid: existing.uid,
          projectId: existing.projectId,
          nodeType: existing.nodeType,
          name: existing.name,
          lastModifyTime: existing.lastModifyTime
        },
        incoming,
        payload: row
      }))
    }

    this.runInTransaction(() => {
      rows.forEach((input, index) => {
      try {
        const row = asObject(input)
        if (!row) throw new Error('记录不是 JSON 对象')
        const metadata = asObject(row.metadata) ?? {}
        const raw = asObject(row.raw) ?? {}
        const documentId = text(row.documentId)
        const uid =
          text(metadata.sourceId) ||
          text(raw._valm_Uid) ||
          text(row.uid) ||
          (documentId.includes(':') ? documentId.slice(documentId.lastIndexOf(':') + 1) : '')
        const nodeType =
          text(metadata.recordType) ||
          text(raw._valm_NodeType) ||
          text(row.nodeType) ||
          (documentId.includes(':') ? documentId.slice(0, documentId.indexOf(':')) : '')
        if (!uid || !nodeType) throw new Error('缺少 UID 或数据类型')

        const name = text(row.title) || text(raw._valm_Name) || text(row.name) || uid
        const projectId =
          text(metadata.projectId) ||
          text(raw._valm_ProjectId) ||
          text(raw._valm_ProjectUid) ||
          text(row.projectId)
        const itemIdCandidates = [
          text(metadata.itemId),
          text(raw._valm_ItemID),
          text(row.itemId)
        ].map((candidate) => candidate.trim()).filter(Boolean)
        const itemId = itemIdCandidates[0] ?? ''
        if (!itemId) throw new Error('缺少 _valm_ItemID，不能导入')
        if (itemIdCandidates.some((candidate) => candidate !== itemId)) {
          throw new Error('多个来源的 _valm_ItemID 不一致，不能导入')
        }
        const lastModifyTime =
          text(metadata.updatedAt) ||
          text(raw._valm_LastModifyTime) ||
          text(row.lastModifyTime)
        const parentId = text(raw._valm_ParentId) || text(row.parentId)
        const existing = options.overwriteExisting
          ? null
          : this.findRecordByItemId(itemId)
        if (existing) {
          skippedCount += 1
          stageDuplicate(row, itemId, existing, {
            uid,
            projectId: nodeType === 'Project' ? uid : projectId,
            nodeType,
            name,
            lastModifyTime
          })
          return
        }
        const targetUid = options.targetUidByItemId?.get(itemId) || uid
        let normalizedRaw: Record<string, unknown> = {
          ...raw,
          _valm_Uid: targetUid,
          _valm_NodeType: text(raw._valm_NodeType) || nodeType,
          _valm_Name: text(raw._valm_Name) || name,
          _valm_ItemID: itemId
        }

        if (nodeType === 'Project') {
          this.upsertProject({
            uid: targetUid,
            name,
            itemId,
            lastModifyTime,
            raw: normalizedRaw
          })
        }
        this.upsertRecord({
          uid: targetUid,
          projectId: nodeType === 'Project' ? targetUid : projectId,
          nodeType,
          itemId,
          parentId,
          name,
          lastModifyTime,
          raw: normalizedRaw,
          normalizedText: text(row.content)
        })
        const importedPushStatus = text(metadata.pushStatus)
        if (['pending', 'success', 'failed'].includes(importedPushStatus)) {
          this.markPushResult(
            targetUid,
            importedPushStatus as 'pending' | 'success' | 'failed',
            text(metadata.pushMessage),
            text(metadata.pushedUid)
          )
        }
        recordCount += 1

        const images = Array.isArray(row.images) ? row.images : []
        for (const imageInput of images) {
          const image = asObject(imageInput)
          if (!image) continue
          const assetUrl = text(image.assetUrl)
          const assetToken = /^visslm-asset:\/\/([a-f0-9]{64})\/[A-Za-z0-9_-]{1,128}$/i.exec(assetUrl)
          if (assetToken) {
            const blob = this.getAssetBlob(assetToken[1])
            if (blob) {
              this.attachImageAsset({
                recordUid: targetUid,
                name: text(image.name),
                mimeType: text(image.mimeType) || blob.mimeType,
                sourceUrl: text(image.sourceUrl) || 'imported:asset',
                sha256: assetToken[1]
              })
              imageCount += 1
              continue
            }
            // A .visslmpack importer may provide the binary as a transient
            // legacy base64 field before this database receives the blob.
            // Fall through to the compatibility decoder below.
          }
          const dataUri = text(image.dataUri)
          const legacyEncoded = text(image.base64)
          const dataUriMatch = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/is.exec(dataUri)
          const encodedDataMatch = /^data:([^;,\s]+);base64,([A-Za-z0-9+/]*={0,2})$/is.exec(legacyEncoded)
          const base64 = (encodedDataMatch?.[2] || legacyEncoded || dataUriMatch?.[2] || '').replace(/\s+/g, '')
          if (!base64) continue
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 === 1) {
            skippedCount += 1
            continue
          }
          const bytes = Buffer.from(base64, 'base64')
          if (!bytes.length) {
            skippedCount += 1
            continue
          }
          const declaredSha = text(image.sha256).trim().toLowerCase()
          if (/^[a-f0-9]{64}$/.test(declaredSha) && createHash('sha256').update(bytes).digest('hex') !== declaredSha) {
            skippedCount += 1
            continue
          }
          if (assetToken && createHash('sha256').update(bytes).digest('hex') !== assetToken[1].toLowerCase()) {
            skippedCount += 1
            continue
          }
          this.saveImage({
            recordUid: targetUid,
            name: text(image.name),
            mimeType: text(image.mimeType) || encodedDataMatch?.[1] || dataUriMatch?.[1] || 'application/octet-stream',
            sourceUrl: text(image.sourceUrl) || 'imported:data',
            bytes
          })
          imageCount += 1
        }
        const references = Array.isArray(row.imageReferences) ? row.imageReferences : []
        for (const referenceInput of references) {
          const reference = asObject(referenceInput)
          if (!reference) continue
          const sha256 = text(reference.assetSha256).trim().toLowerCase()
          if (!/^[a-f0-9]{64}$/.test(sha256) || !this.getAssetBlob(sha256)) continue
          this.saveRecordImageReference({
            id: text(reference.id) || undefined,
            recordUid: targetUid,
            fieldPath: text(reference.fieldPath) || '_valm_Description',
            ordinal: Number(reference.ordinal ?? 0),
            assetSha256: sha256,
            sourceType: text(reference.sourceType) || 'rich-text',
            sourceName: text(reference.sourceName),
            originalSource: text(reference.originalSource)
          })
        }
        const importedDescription = text(normalizedRaw._valm_Description)
        if (importedDescription) {
          const importedImages = this.db.prepare(
            'SELECT id, name, sha256, source_url FROM images WHERE record_uid = ?'
          ).all(targetUid) as SqlRow[]
          const tokenized = replaceRichTextImageSources(importedDescription, (source) => {
            const token = parseAssetToken(source.source)
            const image = token
              ? importedImages.find((candidate) => String(candidate.sha256 ?? '').toLowerCase() === token.sha256)
              : importedImages.find((candidate) => {
                  const sourceUrl = String(candidate.source_url ?? '')
                  return sourceUrl === source.source || sourceUrl.includes(source.source) ||
                    (/^data:image\//i.test(source.source) && sourceUrl.startsWith('inline:data-uri'))
                })
            const sha256 = token?.sha256 || String(image?.sha256 ?? '').trim().toLowerCase()
            if (!image || !/^[a-f0-9]{64}$/.test(sha256) || !this.getAssetBlob(sha256)) return undefined
            const reference = this.saveRecordImageReference({
              id: token?.referenceId,
              recordUid: targetUid,
              fieldPath: '_valm_Description',
              ordinal: source.occurrence,
              assetSha256: sha256,
              sourceType: token ? 'token' : 'legacy-import',
              sourceName: String(image.name ?? ''),
              originalSource: source.source
            })
            return token ? source.source : `visslm-asset://${sha256}/${reference.id}`
          })
          if (tokenized.html !== importedDescription) {
            normalizedRaw = { ...normalizedRaw, _valm_Description: tokenized.html }
            this.updateRecordRawAndNormalizedText(targetUid, normalizedRaw, text(row.content))
            if (nodeType === 'Project') {
              this.upsertProject({
                uid: targetUid,
                name,
                itemId,
                lastModifyTime,
                raw: normalizedRaw
              })
            }
          }
        }
      } catch (error) {
        skippedCount += 1
        if (errors.length < 50) {
          errors.push(`第 ${index + 1} 条：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      })
      if (options.importRunId) {
        const timestamp = nowIso()
        this.db.prepare(`
          UPDATE data_import_runs
          SET batch_count = ?,
              source_row_count = ?,
              imported_record_count = imported_record_count + ?,
              skipped_count = skipped_count + ? + MAX(0, ? - parse_error_count),
              parse_error_count = ?,
              review_batch_id = ?,
              updated_at = ?
          WHERE id = ? AND status = 'running'
        `).run(
          Math.max(0, Math.trunc(options.batchNumber ?? 0)),
          Math.max(0, Math.trunc(options.sourceRowCount ?? 0)),
          recordCount,
          skippedCount,
          Math.max(0, Math.trunc(options.parseErrorCount ?? 0)),
          Math.max(0, Math.trunc(options.parseErrorCount ?? 0)),
          reviewBatchId ?? '',
          timestamp,
          options.importRunId.trim()
        )
      }
    })

    if (recordCount > 0) this.bumpAnalyticsRevision()
    return {
      ok: recordCount > 0 || duplicates.length > 0 || (rows.length === 0 && skippedCount === 0),
      recordCount,
      imageCount,
      skippedCount,
      errors,
      reviewBatchId,
      duplicates,
      message:
        `导入完成：${recordCount} 条记录，${imageCount} 张图片，跳过 ${skippedCount} 条` +
        (duplicates.length ? `，发现 ${duplicates.length} 条已有 _valm_ItemID，待审查覆盖` : '')
    }
  }

  applyImportDataReviews(batchId: string, reviewIds?: string[]): DataReviewApplyResult {
    const pending = this.getPendingDataReviews(batchId, 'import', reviewIds)
    let updatedCount = 0
    let imageCount = 0
    const resolvedReviewIds: string[] = []
    const errors: string[] = []
    for (const review of pending) {
      const targetUidByItemId = new Map([[review.itemId, review.existing.uid]])
      const result = this.importRows([review.payload], {
        overwriteExisting: true,
        targetUidByItemId
      })
      if (result.recordCount === 1) {
        updatedCount += 1
        imageCount += result.imageCount
        resolvedReviewIds.push(review.id)
      } else {
        errors.push(...result.errors.slice(0, 3))
      }
    }
    this.resolveDataReviews(batchId, 'import', resolvedReviewIds)
    return {
      ok: updatedCount > 0 && errors.length === 0,
      source: 'import',
      updatedCount,
      imageCount,
      resolvedReviewIds,
      errors: errors.slice(0, 50),
      message:
        `覆盖更新完成：${updatedCount} 条记录，${imageCount} 张图片` +
        (errors.length ? `，${errors.length} 条失败` : '')
    }
  }

  countDataDeleteImages(uids?: string[]): number {
    const selected = [...new Set((uids ?? []).map((uid) => uid.trim()).filter(Boolean))]
    if (uids !== undefined && !selected.length) return 0
    const where = uids === undefined
      ? ''
      : 'WHERE record_uid IN (SELECT value FROM json_each(?))'
    const params = uids === undefined ? [] : [JSON.stringify(selected)]
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM (
           SELECT DISTINCT sha256, binary_path, base64_path
           FROM images ${where}
         ) AS image_rows`
      )
      .get(...params) as SqlRow
    return Number(row.count ?? 0)
  }

  deleteData(uids?: string[]): DataDeleteResult {
    const selected = [...new Set((uids ?? []).map((uid) => uid.trim()).filter(Boolean))]
    const deleteAll = uids === undefined
    if (!deleteAll && !selected.length) {
      return { ok: true, recordCount: 0, imageCount: 0, message: '没有需要删除的数据' }
    }

    const placeholders = selected.map(() => '?').join(',')
    const where = deleteAll ? '' : `WHERE record_uid IN (${placeholders})`
    const imageRows = this.db
      .prepare(`SELECT DISTINCT sha256, binary_path, base64_path FROM images ${where}`)
      .all(...selected) as SqlRow[]

    this.db.exec('BEGIN IMMEDIATE')
    let recordCount = 0
    try {
      if (deleteAll) {
        recordCount = Number(
          (this.db.prepare('SELECT COUNT(*) AS count FROM records').get() as SqlRow).count
        )
        this.db.prepare('DELETE FROM records').run()
        this.db.prepare('DELETE FROM projects').run()
        this.db.prepare('DELETE FROM data_review_items').run()
      } else {
        const recordWhere = `uid IN (${placeholders})`
        recordCount = Number(
          (
            this.db
              .prepare(`SELECT COUNT(*) AS count FROM records WHERE ${recordWhere}`)
              .get(...selected) as SqlRow
          ).count
        )
        this.db.prepare(`DELETE FROM records WHERE ${recordWhere}`).run(...selected)
        this.db.prepare(`DELETE FROM projects WHERE ${recordWhere}`).run(...selected)
        this.db.prepare(
          `DELETE FROM data_review_items WHERE existing_uid IN (${placeholders})`
        ).run(...selected)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    for (const row of imageRows) {
      const sha256 = String(row.sha256 ?? '').trim().toLowerCase()
      const remaining = this.db
        .prepare('SELECT 1 FROM images WHERE sha256 = ? LIMIT 1')
        .get(sha256)
      if (remaining) continue
      const referenced = this.db
        .prepare('SELECT 1 FROM record_image_refs WHERE asset_sha256 = ? LIMIT 1')
        .get(sha256)
      if (referenced) continue
      this.db.prepare('DELETE FROM asset_blobs WHERE sha256 = ?').run(sha256)
      const binaryPath = String(row.binary_path ?? '')
      const legacyPath = String(row.base64_path ?? '')
      try {
        if (binaryPath) unlinkSync(binaryPath)
      } catch {
        // A missing binary file is already effectively deleted.
      }
      if (legacyPath && legacyPath !== binaryPath) {
        try { unlinkSync(legacyPath) } catch { /* best-effort legacy cleanup */ }
      }
    }
    this.cleanupOrphanAssetBlobs()

    if (recordCount > 0) this.bumpAnalyticsRevision()

    return {
      ok: true,
      recordCount,
      imageCount: imageRows.length,
      message: `已删除 ${recordCount} 条记录和 ${imageRows.length} 张图片`
    }
  }
}
