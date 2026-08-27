import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import * as XLSX from 'xlsx'
import type {
  AssistantIntentDecision,
  AssistantExecutionAgentId,
  ChatResponse,
  ChatRequest,
  ChatDataView,
  ChatSessionDeleteResult,
  ChatSessionSaveInput,
  AssistantArtifactInput,
  AssistantArtifactPreview,
  AssistantRunHistory,
  AssistantArtifactExportRequest,
  AssistantArtifactExportResult,
  AssistantPlanPatch,
  DataImportResult,
  DataImportRunSnapshot,
  DataReviewApplyInput,
  FeatureNavigationOrder,
  FeatureModuleSettings,
  KnowledgeDocumentPreview,
  KnowledgeDocumentQuery,
  ModelSettings,
  PlatformSettingsInput,
  ProjectMatchingSettings,
  SystemSettingsInput,
  PushConfig,
  RecordExportQuery,
  RecordQuery,
  RecordMaintenanceStartInput,
  RequirementSemanticizationStartInput,
  RequirementSemanticizationControl,
  SyncProgress,
  SyncScopeConfig,
  UpdateStatus
} from '../shared/types'
import type {
  ManagedProjectInput,
  ManagedProjectListQuery,
  OrganizationPersonInput,
  OrganizationPersonListQuery,
  ProjectParticipantInput,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectCostEntryInput,
  ProjectAgreementUploadOptions,
  ProjectRequirementInput,
  ProjectRequirementMergeInput,
  ProjectRequirementMatchQuery,
  ProjectRequirementQuery,
  ProjectRequirementReviewStatus,
  ProjectRequirementSplitInput,
  ProjectRequirementStatus
} from '../shared/project-types'
import type {
  DataScope,
  FieldProfileSemanticPatch,
  QuerySpec
} from '../shared/query-spec'
import type {
  DashboardAuditLogInput,
  DashboardSaveInput,
  DashboardSpec,
  VisualizationRunInput
} from '../shared/dashboard'
import type { AgentEvent, AssistantExecutionSummary } from '../shared/expert-types'
import { compareDashboardSpecValues } from '../shared/dashboard'
import { QueryEngine } from './analytics/query-engine'
import { AppDatabase } from './database'
import { validateDashboardSpec } from './dashboards/validator'
import { diagnoseDashboard } from './dashboards/diagnostics'
import { repairDashboardComponent } from './dashboards/component-repair'
import { dashboardSpecHash } from './dashboards/spec-hash'
import { ExpertRouter } from './experts/router'
import { autoRequirementIds } from './experts/auto-routing'
import { resolveAssistantIntent } from './assistant/intent-router'
import {
  validateAssistantExecutionRoute
} from './assistant/agent-registry'
import {
  createAssistantTaskTrace,
  traceContextFromDecision,
  type AssistantTraceContext
} from './assistant/task-trace'
import {
  AssistantRunRegistry,
  getAssistantRunUsage,
  isAssistantRunCancellation,
  runWithAssistantRunContext
} from './assistant/run-controller'
import { AnswerStream } from './assistant/answer-stream'
import { AssistantPlanConfirmationController } from './assistant/plan-confirmation'
import type { AssistantPlanValidationMetadata, ConfirmedAssistantPlan } from './assistant/execution-plan'
import {
  workLogForDelivery,
  workLogForFailure,
  workLogForIntent,
  workLogForSkill,
  workLogForStatus,
  workLogForVerification,
  type AssistantWorkLogDraft
} from './assistant/work-log'
import { buildSafeQueryRecoverySuggestions } from './assistant/recovery-suggestions'
import { buildEvidenceBlocks } from './assistant/evidence-block'
import {
  createAssistantArtifactPreview,
  verifyAssistantArtifactPreview
} from './assistant/artifact-service'
import { renderAssistantArtifact } from './assistant/artifact-exporter'
import { RequirementAnalysisAgent } from './experts/requirement-analysis-agent'
import { RequirementSemanticizationService } from './requirements/semanticization-service'
import { VisualizationAgent } from './experts/visualization-agent'
import { resolveVisualizationRequestMode } from './experts/visualization-intent'
import { OllamaAgent } from './ollama'
import { PlainChatAgent } from './plain-chat'
import { DirectRequirementDataAnalysisAgent } from './direct-data-analysis'
import { chatHistoryFromMessages, contextRefsFromResponse } from './context-budget'
import { SettingsService } from './settings'
import { PushService, SyncService, VisslmClient } from './visslm'
import { KnowledgeService } from './knowledge'
import { RecordMaintenanceService } from './record-maintenance'
import { AsyncMutex } from './record-index-lock'
import {
  detectJsonFirstToken,
  readJsonArrayImportRows,
  readJsonlImportRows,
  type ImportBatchContext,
  type ImportResumeCheckpoint
} from './data-import-stream'
import { ProjectManagementService } from './project-management'
import { exportVisslmPack, importVisslmPack } from './transfer-pack'
import type { UpdateManager } from './updater'
import {
  isUnsupportedWindowsVersion,
  unsupportedWindowsMessage
} from './platform-compat'
import { isNavigationAbortedError } from './navigation-error'
import { createProjectWorkbook } from './project-export'
import {
  createDashboardOfflineArchive,
  offlineViewerResourceNames,
  type DashboardOfflineViewerAssets
} from './dashboards/offline-export'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

protocol.registerSchemesAsPrivileged([{
  scheme: 'visslm-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}, {
  scheme: 'visslm-preview',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}])
let mainWindow: BrowserWindow | null = null
let backendReady = false
let updateManager: UpdateManager | null = null
let updateManagerInitError: string | null = null
let db: AppDatabase
let settings: SettingsService
let syncService: SyncService
let pushService: PushService
let knowledgeService: KnowledgeService
let recordMaintenanceService: RecordMaintenanceService
let recordIndexLock: AsyncMutex
let projectManagementService: ProjectManagementService
let requirementSemanticizationService: RequirementSemanticizationService
let knowledgeInitializationTimer: ReturnType<typeof setTimeout> | null = null
let knowledgeInitializationStarted = false
let isQuitting = false
let legacyDataImportRunning = false
const expertRouter = new ExpertRouter()
const maxKnowledgeDocumentPreviewBytes = 50 * 1024 * 1024
const sourcePreviewExtensions = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.txt'])
const sourcePreviewMimeTypes: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain'
}
const sourcePreviewRenderFormats: Record<string, NonNullable<KnowledgeDocumentPreview['renderFormat']>> = {
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.xlsx': 'xlsx',
  '.xls': 'xlsx',
  '.txt': 'text'
}
const execFileAsync = promisify(execFile)
const previewUrlTtlMs = 5 * 60 * 1000
const maxPreviewUrls = 32
const previewFiles = new Map<string, { filePath: string; byteSize: number; mimeType: string; expiresAt: number }>()
const assistantRunRegistry = new AssistantRunRegistry()
const assistantPlanConfirmation = new AssistantPlanConfirmationController()
const explicitArtifactMentionPattern = /@交付物专家(?=$|[\s，,。！？!?：:；;])/u
const isolatedE2EMode = !app.isPackaged && process.env.VISSLM_E2E_ALLOW_MULTI_INSTANCE === '1'
const isolatedE2EKnowledgeFiles = (() => {
  if (!isolatedE2EMode) return []
  const singleFile = process.env.VISSLM_E2E_KNOWLEDGE_FILE?.trim()
  if (singleFile && isAbsolute(singleFile)) return [singleFile]
  try {
    const parsed = JSON.parse(process.env.VISSLM_E2E_KNOWLEDGE_FILES ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && isAbsolute(value))
  } catch {
    return []
  }
})()

const planValidationMetadata = (
  summary: AssistantExecutionSummary,
  dataScope?: DataScope
): AssistantPlanValidationMetadata => {
  if (summary.sourceMode !== 'records' && summary.sourceMode !== 'mixed') return {}

  const projectIds = db.listProjects()
    .map((project) => project.uid.trim())
    .filter(Boolean)
  const nodeTypes = db.listNodeTypes()
    .map((nodeType) => nodeType.trim())
    .filter(Boolean)
  const scopedNodeTypes = dataScope?.nodeTypes ?? summary.scope.nodeTypes
  // Confirmation metadata must come from the trusted field-definition catalog,
  // not from scanning record JSON or reading evidence before approval.
  const definitions = db.getFieldDefinitions(nodeTypes)
  const fields = new Map<string, {
    field: string
    displayName?: string
    allowed: boolean
    types: string[]
  }>()
  const addField = (field: string, displayName?: string, types: string[] = []): void => {
    const normalized = field.trim()
    if (!normalized) return
    const existing = fields.get(normalized)
    fields.set(normalized, {
      field: normalized,
      ...(displayName?.trim() || existing?.displayName
        ? { displayName: displayName?.trim() || existing?.displayName }
        : {}),
      allowed: existing?.allowed ?? true,
      types: [...new Set([...(existing?.types ?? []), ...types.map((value) => value.trim()).filter(Boolean)])]
    })
  }
  for (const definition of definitions) {
    addField(
      definition.field,
      definition.displayName,
      [definition.nodeType]
    )
  }
  // Existing planner output is already produced from the trusted catalog. If
  // a legacy installation has no persisted field-definition rows, retain only
  // those exact fields for an unedited plan; newly supplied fields still fail
  // closed because they are not added here.
  const fallbackFields = [
    ...(summary.fields ?? []),
    ...(summary.filters ?? []).map((filter) => filter.field),
    ...(summary.scope.baseFilters ?? []).map((filter) => filter.field),
    ...(summary.groupByField ? [summary.groupByField] : []),
    ...(summary.sort?.field ? [summary.sort.field] : [])
  ]
  for (const field of fallbackFields) {
    addField(field, undefined, scopedNodeTypes.length ? scopedNodeTypes : [])
  }
  return {
    projectIds,
    nodeTypes,
    fields: [...fields.values()]
  }
}

const prunePreviewFiles = (): void => {
  const now = Date.now()
  for (const [token, entry] of previewFiles) {
    if (entry.expiresAt <= now) previewFiles.delete(token)
  }
  while (previewFiles.size > maxPreviewUrls) {
    const oldest = previewFiles.keys().next().value as string | undefined
    if (!oldest) break
    previewFiles.delete(oldest)
  }
}

const createPreviewUrl = (filePath: string, mimeType: string): { url: string; byteSize: number } => {
  const stats = statSync(filePath)
  if (!stats.isFile() || stats.size <= 0 || stats.size > maxKnowledgeDocumentPreviewBytes) {
    throw new Error('预览文件不可用或超过 50 MB 限制')
  }
  prunePreviewFiles()
  const token = randomUUID()
  previewFiles.set(token, {
    filePath,
    byteSize: stats.size,
    mimeType,
    expiresAt: Date.now() + previewUrlTtlMs
  })
  prunePreviewFiles()
  return { url: `visslm-preview://${token}`, byteSize: stats.size }
}

const cancelKnowledgeInitialization = (): void => {
  if (!knowledgeInitializationTimer) return
  clearTimeout(knowledgeInitializationTimer)
  knowledgeInitializationTimer = null
}

/**
 * Knowledge startup loads the local embedding model and can rebuild a large
 * index.  Defer it until after the first window has been shown so renderer
 * startup and initial IPC remain responsive.  The timer is unref'ed and
 * cancelled during shutdown/window destruction to avoid starting work against
 * a closing application or a stale BrowserWindow.
 */
const scheduleKnowledgeInitialization = (): void => {
  if (
    knowledgeInitializationStarted ||
    knowledgeInitializationTimer ||
    isQuitting ||
    !knowledgeService
  ) return

  knowledgeInitializationTimer = setTimeout(() => {
    knowledgeInitializationTimer = null
    if (
      isQuitting ||
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !mainWindow.isVisible() ||
      !knowledgeService
    ) return
    knowledgeInitializationStarted = true
    void knowledgeService.initialize().catch((error) => {
      console.error('[knowledge] initialization failed', error)
    })
  }, 750)
  knowledgeInitializationTimer.unref?.()
}

const updateErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error || '未知错误')
}

const mergeDataImportResults = (results: DataImportResult[]): DataImportResult => {
  const duplicates = results.flatMap((result) => result.duplicates)
  const errors = results.flatMap((result) => result.errors).slice(0, 50)
  const recordCount = results.reduce((sum, result) => sum + result.recordCount, 0)
  const imageCount = results.reduce((sum, result) => sum + result.imageCount, 0)
  const skippedCount = results.reduce((sum, result) => sum + result.skippedCount, 0)
  return {
    ok: results.every((result) => result.ok),
    recordCount,
    imageCount,
    skippedCount,
    errors,
    duplicates,
    reviewBatchId: results.find((result) => result.reviewBatchId)?.reviewBatchId,
    message: `导入完成：${recordCount} 条记录，${imageCount} 张图片，跳过 ${skippedCount} 条`
  }
}

type LegacyImportRunSeed = Pick<
  DataImportRunSnapshot,
  | 'batchCount'
  | 'sourceRowCount'
  | 'importedRecordCount'
  | 'skippedCount'
  | 'parseErrorCount'
  | 'reviewBatchId'
>

/**
 * Execute a legacy JSON/JSONL import from a persisted checkpoint. The parser
 * replays only the source prefix needed to establish valid-row/error counts;
 * already committed rows never enter another database batch.
 */
const runLegacyDataImport = async (
  filePath: string,
  importFormat: 'json' | 'jsonl',
  importRunId: string,
  resume?: LegacyImportRunSeed
): Promise<DataImportResult> => {
  if (legacyDataImportRunning) throw new Error('已有旧 JSON/JSONL 导入任务正在运行')
  const seed: LegacyImportRunSeed = {
    batchCount: Math.max(0, Math.trunc(resume?.batchCount ?? 0)),
    sourceRowCount: Math.max(0, Math.trunc(resume?.sourceRowCount ?? 0)),
    importedRecordCount: Math.max(0, Math.trunc(resume?.importedRecordCount ?? 0)),
    skippedCount: Math.max(0, Math.trunc(resume?.skippedCount ?? 0)),
    parseErrorCount: Math.max(0, Math.trunc(resume?.parseErrorCount ?? 0)),
    reviewBatchId: resume?.reviewBatchId?.trim() ?? ''
  }
  legacyDataImportRunning = true
  const parseErrors: string[] = []
  const importStartedAt = Date.now()
  let batchCount = seed.batchCount
  let checkpointSourceRowCount = seed.sourceRowCount
  let checkpointParseErrorCount = seed.parseErrorCount
  let reviewBatchId: string | undefined = seed.reviewBatchId || undefined
  let totalImportedRecordCount = seed.importedRecordCount
  let totalSkippedCount = seed.skippedCount
  let importedRecordCount = 0
  let importedSkippedCount = 0

  try {
    const imported = await recordIndexLock.runExclusive(async () => {
      const batchResults: DataImportResult[] = []
      const importBatch = (batch: unknown[], context?: ImportBatchContext): void => {
        batchCount = context?.batchNumber ?? batchCount + 1
        checkpointSourceRowCount = context?.sourceRowCount ?? checkpointSourceRowCount
        checkpointParseErrorCount = context?.parseErrorCount ?? checkpointParseErrorCount
        const batchResult = db.importRows(batch, {
          reviewBatchId,
          importRunId,
          batchNumber: batchCount,
          sourceRowCount: checkpointSourceRowCount,
          parseErrorCount: checkpointParseErrorCount
        })
        reviewBatchId ??= batchResult.reviewBatchId
        importedRecordCount += batchResult.recordCount
        importedSkippedCount += batchResult.skippedCount
        totalImportedRecordCount += batchResult.recordCount
        totalSkippedCount += batchResult.skippedCount
        batchResults.push(batchResult)
      }
      const firstToken = importFormat === 'json' ? await detectJsonFirstToken(filePath) : ''
      const resumeCheckpoint: ImportResumeCheckpoint = {
        batchCount: seed.batchCount,
        sourceRowCount: seed.sourceRowCount,
        parseErrorCount: seed.parseErrorCount
      }
      const parsed = importFormat === 'json' && firstToken === '['
        ? await readJsonArrayImportRows(filePath, parseErrors, importBatch, resumeCheckpoint)
        : await readJsonlImportRows(filePath, parseErrors, importBatch, resumeCheckpoint)
      if (
        parsed.rowCount < seed.sourceRowCount ||
        parsed.parseErrorCount < seed.parseErrorCount
      ) {
        throw new Error('导入文件内容少于中断时的检查点，无法安全继续')
      }
      checkpointSourceRowCount = parsed.rowCount
      checkpointParseErrorCount = parsed.parseErrorCount
      const result = mergeDataImportResults(batchResults)
      await knowledgeService.syncRecordIndexInLock()
      projectManagementService.markMatchesStale()
      const newParseErrorCount = Math.max(0, parsed.parseErrorCount - seed.parseErrorCount)
      result.path = filePath
      result.format = importFormat
      result.importRunId = importRunId
      result.batchCount = batchCount
      result.sourceRowCount = parsed.rowCount
      result.parseErrorCount = parsed.parseErrorCount
      result.durationMs = Math.max(0, Date.now() - importStartedAt)
      result.skippedCount = importedSkippedCount + newParseErrorCount
      result.errors = [...parseErrors, ...result.errors].slice(0, 50)
      result.ok =
        result.recordCount > 0 ||
        result.duplicates.length > 0 ||
        (parsed.rowCount === seed.sourceRowCount && newParseErrorCount === 0)
      const prefix = seed.batchCount > 0 ? '继续导入完成' : '导入完成'
      result.message =
        `${prefix}：${result.recordCount} 条记录，${result.imageCount} 张图片，` +
        `跳过 ${result.skippedCount} 条` +
        (seed.batchCount > 0 ? `（累计 ${totalImportedRecordCount} 条记录）` : '') +
        (result.duplicates.length
          ? `，发现 ${result.duplicates.length} 条已有 _valm_ItemID，待审查覆盖`
          : '')
      totalSkippedCount += newParseErrorCount
      db.finishDataImportRun(importRunId, 'success', {
        batchCount,
        sourceRowCount: parsed.rowCount,
        importedRecordCount: totalImportedRecordCount,
        skippedCount: totalSkippedCount,
        parseErrorCount: parsed.parseErrorCount,
        reviewBatchId,
        errorMessage: ''
      })
      return result
    })
    return imported
  } catch (error) {
    try {
      const newParseErrorCount = Math.max(0, checkpointParseErrorCount - seed.parseErrorCount)
      db.finishDataImportRun(importRunId, 'failed', {
        batchCount,
        sourceRowCount: checkpointSourceRowCount,
        importedRecordCount: totalImportedRecordCount,
        skippedCount: totalSkippedCount + newParseErrorCount,
        parseErrorCount: checkpointParseErrorCount,
        reviewBatchId,
        errorMessage: updateErrorMessage(error).slice(0, 1000)
      })
    } catch {
      // Preserve the original import error if diagnostics cannot be saved.
    }
    throw error
  } finally {
    legacyDataImportRunning = false
  }
}

const getUpdateFallbackStatus = (): UpdateStatus => ({
  phase: updateManagerInitError ? 'error' : 'idle',
  currentVersion: app.getVersion(),
  message: updateManagerInitError ?? '在线更新服务正在初始化，请稍后重试'
})

const initializeUpdateManager = async (): Promise<void> => {
  if (updateManager || updateManagerInitError) return

  try {
    const { UpdateManager: UpdateManagerClass } = await import('./updater')
    updateManager = new UpdateManagerClass()
    updateManager.attachWindow(mainWindow)
    if (app.isPackaged) {
      setTimeout(() => void updateManager?.checkForUpdates(), 3000)
    }
  } catch (error) {
    updateManagerInitError = updateErrorMessage(error)
    console.error('[updater] initialization failed', error)
  }
}

const wordPreviewScript = `
$ErrorActionPreference = 'Stop'
$sourcePath = [Environment]::GetEnvironmentVariable('VISSLM_DOCX_PREVIEW_SOURCE')
$outputPath = [Environment]::GetEnvironmentVariable('VISSLM_DOCX_PREVIEW_OUTPUT')
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $word.Options.UpdateLinksAtOpen = $false
  $document = $word.Documents.Open($sourcePath, $false, $true)
  $document.ExportAsFixedFormat($outputPath, 17)
} finally {
  if ($document) {
    try { $document.Close($false) } catch {}
    try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null } catch {}
  }
  if ($word) {
    try { $word.Quit() } catch {}
    try { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`

const renderDocxSourceWithWord = async (document: { filePath: string; sha256: string }): Promise<string | null> => {
  const previewDirectory = join(app.getPath('temp'), 'visslm-word-previews')
  const cacheId = document.sha256.replace(/[^a-z0-9]/gi, '').slice(0, 80) || 'document'
  const outputPath = join(previewDirectory, `${cacheId}-word-v1.pdf`)
  mkdirSync(previewDirectory, { recursive: true })

  try {
    const cached = statSync(outputPath)
    if (cached.isFile() && cached.size > 0 && cached.size <= maxKnowledgeDocumentPreviewBytes) {
      const bytes = readFileSync(outputPath)
      if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return outputPath
    }
  } catch {
    // A missing or invalid cache is regenerated from the source document below.
  }

  try {
    try { unlinkSync(outputPath) } catch {}
    await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      wordPreviewScript
    ], {
      env: {
        ...process.env,
        VISSLM_DOCX_PREVIEW_SOURCE: document.filePath,
        VISSLM_DOCX_PREVIEW_OUTPUT: outputPath
      },
      windowsHide: true,
      timeout: 90_000,
      maxBuffer: 1024 * 1024
    })
    const stats = statSync(outputPath)
    if (!stats.isFile() || stats.size === 0 || stats.size > maxKnowledgeDocumentPreviewBytes) return null
    const bytes = readFileSync(outputPath)
    return bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? outputPath : null
  } catch (error) {
    try { unlinkSync(outputPath) } catch {}
    console.warn('[document-preview] Word rendering unavailable, using direct DOCX preview', error)
    return null
  }
}

const recordDashboardAudit = (input: DashboardAuditLogInput): void => {
  try {
    db.recordDashboardAuditLog(input)
  } catch (error) {
    console.error('[dashboard-audit] failed to record', error)
  }
}

const exportSemanticStatuses = new Set(['pending', 'processing', 'ready', 'failed'])

const normalizeDataExportQuery = (input: unknown): RecordExportQuery | undefined => {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('导出筛选条件必须是对象')
  }
  const source = input as Record<string, unknown>
  const normalized: RecordExportQuery = {}
  const readText = (
    key: 'search' | 'projectId' | 'nodeType' | 'releaseText',
    preserveEmpty = false
  ): void => {
    const value = source[key]
    if (value === undefined || value === null) return
    if (typeof value !== 'string') throw new Error(`导出筛选条件 ${key} 必须是字符串`)
    const trimmed = value.trim()
    if (trimmed || preserveEmpty) normalized[key] = trimmed
  }
  readText('search')
  readText('projectId')
  readText('nodeType')
  readText('releaseText', true)
  if (source.semanticStatus !== undefined && source.semanticStatus !== null) {
    if (typeof source.semanticStatus !== 'string' || !exportSemanticStatuses.has(source.semanticStatus)) {
      throw new Error('导出筛选条件 semanticStatus 无效')
    }
    normalized.semanticStatus = source.semanticStatus as NonNullable<RecordExportQuery['semanticStatus']>
  }
  // Unknown fields (including page/pageSize and excludeProjectAssetProjectId)
  // are deliberately ignored instead of being forwarded to the database.
  return Object.keys(normalized).length ? normalized : undefined
}

const exportAuditMetadata = (
  query: RecordExportQuery | undefined,
  recordCount: number
): Record<string, string | number | boolean | null> => ({
  filtered: Boolean(query),
  searchPresent: Boolean(query?.search),
  searchLength: query?.search?.length ?? 0,
  ...(query?.projectId ? { projectId: query.projectId } : {}),
  ...(query?.nodeType ? { nodeType: query.nodeType } : {}),
  ...(query && Object.prototype.hasOwnProperty.call(query, 'releaseText')
    ? { releaseText: query.releaseText ?? '' }
    : {}),
  ...(query?.semanticStatus ? { semanticStatus: query.semanticStatus } : {}),
  recordCount
})

const specAuditMetadata = (
  spec: DashboardSpec | undefined,
  metadata: Record<string, string | number | boolean | null> = {}
): Record<string, string | number | boolean | null> => ({
  ...metadata,
  ...(spec && typeof spec === 'object' ? { specHash: dashboardSpecHash(spec) } : {})
})

const readOfflineViewerAssets = (): DashboardOfflineViewerAssets => {
  const candidateRoots = [
    join(__dirname, '../offline'),
    join(app.getAppPath(), 'out/offline'),
    join(process.cwd(), 'out/offline')
  ]
  const root = [...new Set(candidateRoots)].find((candidate) => {
    try {
      return statSync(candidate).isDirectory()
    } catch {
      return false
    }
  })
  if (!root) throw new Error('离线预览资源尚未构建，请先重新构建应用')

  const readAsset = (name: (typeof offlineViewerResourceNames)[number]): Buffer => {
    const path = join(root, name)
    try {
      if (!statSync(path).isFile()) throw new Error('not a file')
      return readFileSync(path)
    } catch {
      throw new Error(`离线预览资源缺失：${name}`)
    }
  }

  return {
    indexHtml: readAsset('index.html').toString('utf8'),
    viewerScript: readAsset('dashboard-viewer.js'),
    viewerStyle: readAsset('dashboard-viewer.css')
  }
}

const dashboardPatchErrorCode = (run: VisualizationRunInput | undefined): string => {
  const failedTool = [...(run?.toolCalls ?? [])].reverse().find((call) => call.status === 'failed')?.tool
  if (failedTool === 'model-compose') return 'DASHBOARD_AI_MODEL_OUTPUT'
  if (failedTool === 'execute-query') return 'DASHBOARD_AI_QUERY_FAILED'
  if (failedTool === 'apply-patch' || failedTool === 'validate-dashboard') {
    return 'DASHBOARD_AI_VALIDATION_FAILED'
  }
  return 'DASHBOARD_AI_PATCH_FAILED'
}

const startupPageHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>VISSLM Agent</title>
    <style>
      :root { color-scheme: dark; font-family: "Microsoft YaHei", sans-serif; }
      html, body { width: 100%; height: 100%; margin: 0; background: #090b10; color: #eef1f7; }
      body { display: grid; place-items: center; }
      main { width: min(460px, calc(100vw - 48px)); text-align: center; }
      h1 { margin: 0 0 12px; font-size: 22px; font-weight: 600; }
      p { margin: 0; color: #929bad; font-size: 13px; line-height: 1.6; }
      .spinner { width: 24px; height: 24px; margin: 0 auto 20px; border: 3px solid #2b3040; border-top-color: #7c6cff; border-radius: 50%; animation: spin 0.9s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main role="status" aria-live="polite">
      <div class="spinner" aria-hidden="true"></div>
      <h1>VISSLM Agent</h1>
      <p>正在准备本地数据，请稍候…</p>
    </main>
  </body>
</html>`

const showRendererError = (message: string, detail?: string): void => {
  console.error(`[renderer] ${message}${detail ? `: ${detail}` : ''}`)
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) mainWindow.show()
  void dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'VISSLM Agent 界面加载失败',
    message,
    detail: detail || '请重启应用；如果问题持续，请保留此错误信息。'
  }).catch(() => undefined)
}

const loadRendererPage = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const loadTask = process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  void loadTask.catch((error: unknown) => {
    if (isNavigationAbortedError(error)) return
    showRendererError('正式界面无法加载', updateErrorMessage(error))
  })
  scheduleKnowledgeInitialization()
}

const createWindow = ({ loadRenderer = true }: { loadRenderer?: boolean } = {}): void => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: !loadRenderer,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: '#f5f7fb',
    title: 'VISSLM Agent',
    icon: app.isPackaged ? undefined : join(process.cwd(), 'buildResources', 'icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  let showFallback: ReturnType<typeof setTimeout> | undefined
  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (showFallback) {
      clearTimeout(showFallback)
      showFallback = undefined
    }
    if (!mainWindow.isVisible()) mainWindow.show()
    scheduleKnowledgeInitialization()
  }

  mainWindow.on('closed', () => {
    if (showFallback) clearTimeout(showFallback)
    if (!knowledgeInitializationStarted) cancelKnowledgeInitialization()
    updateManager?.attachWindow(null)
    mainWindow = null
  })
  updateManager?.attachWindow(mainWindow)

  mainWindow.once('ready-to-show', showMainWindow)
  mainWindow.webContents.once('did-finish-load', showMainWindow)
  showFallback = setTimeout(showMainWindow, 5_000)
  showFallback.unref()
  mainWindow.on('maximize', () =>
    mainWindow?.webContents.send('window:maximized-changed', true)
  )
  mainWindow.on('unmaximize', () =>
    mainWindow?.webContents.send('window:maximized-changed', false)
  )
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) return
    console.error(`[renderer-load] ${code} ${description} ${url}`)
    showRendererError('正式界面加载失败', `${description} (${code})\n${url}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    showRendererError('界面进程已退出', `原因：${details.reason || '未知'}${details.exitCode ? `，退出码 ${details.exitCode}` : ''}`)
  })
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      console.error(`[renderer:${details.level}] ${details.message}`)
    }
  })
  if (loadRenderer) {
    loadRendererPage()
  } else {
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupPageHtml)}`).catch((error: unknown) => {
      if (isNavigationAbortedError(error)) return
      showRendererError('启动页无法加载', updateErrorMessage(error))
    })
  }
}

const registerIpc = (): void => {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
    return mainWindow.isMaximized()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle('update:get-status', () => updateManager?.getStatus() ?? getUpdateFallbackStatus())
  ipcMain.handle('update:check', () => updateManager?.checkForUpdates() ?? getUpdateFallbackStatus())
  ipcMain.handle('update:download', () => updateManager?.downloadUpdate() ?? getUpdateFallbackStatus())
  ipcMain.handle('update:install', () => updateManager?.installUpdate())

  ipcMain.handle('settings:get', () => settings.getAll())
  ipcMain.handle('settings:save-platform', (_event, input: PlatformSettingsInput) =>
    settings.savePlatform(input)
  )
  ipcMain.handle('settings:save-system', (_event, input: SystemSettingsInput) =>
    settings.saveSystem(input)
  )
  ipcMain.handle('settings:save-model', (_event, input: ModelSettings) =>
    settings.saveModel(input)
  )
  ipcMain.handle('settings:save-project-matching', (_event, input: ProjectMatchingSettings) =>
    settings.saveProjectMatching(input)
  )
  ipcMain.handle('settings:save-features', (_event, input: FeatureModuleSettings) =>
    settings.saveFeatures(input)
  )
  ipcMain.handle('settings:save-navigation-order', (_event, input: FeatureNavigationOrder) =>
    settings.saveNavigationOrder(input)
  )

  ipcMain.handle(
    'connections:test-platform',
    async (_event, input?: PlatformSettingsInput) =>
      new VisslmClient(settings.getPlatformCredentials(input)).test()
  )
  ipcMain.handle('connections:test-model', async (
    _event,
    input?: ModelSettings,
    probeChat = false,
    probeCapabilities = false
  ) => {
    const model = settings.getModelCredentials(input)
    return new OllamaAgent(db, model).test(probeChat, probeCapabilities)
  })

  ipcMain.handle('data:projects', () => db.listProjects())
  ipcMain.handle('data:node-types', () => db.listNodeTypes())
  ipcMain.handle('data:records', (_event, query: RecordQuery) =>
    db.listRecords(query, requirementSemanticizationService.context()))
  ipcMain.handle('data:record-release-values', () => db.listRecordReleaseValues())
  ipcMain.handle(
    'data:record-uids',
    (_event, query: Omit<RecordQuery, 'page' | 'pageSize'>) =>
      db.listRecordUids(query, requirementSemanticizationService.context())
  )
  ipcMain.handle('data:record', (_event, uid: string) =>
    db.getRecord(uid, true, requirementSemanticizationService.context(), knowledgeService.modelVersion))
  ipcMain.handle('chat:record', (_event, uid: string) =>
    db.getRecord(uid, false, requirementSemanticizationService.context(), knowledgeService.modelVersion))
  ipcMain.handle('chat:record-images', (_event, uid: string, page?: number, pageSize?: number) =>
    db.getRecordImagePage(uid, page, pageSize))
  ipcMain.handle(
    'chat:data-view-page',
    (_event, view: Pick<ChatDataView, 'recordUids' | 'fields'>, page?: number, pageSize?: number) =>
      db.getChatDataViewPage(view, page, pageSize)
  )
  ipcMain.handle(
    'data:maintenance-preview',
    (_event, input: Pick<RecordMaintenanceStartInput, 'scope' | 'recordUids'>) =>
      recordMaintenanceService.preview(input)
  )
  ipcMain.handle(
    'data:maintenance-start',
    (_event, input: RecordMaintenanceStartInput) => recordMaintenanceService.start(input)
  )
  ipcMain.handle(
    'data:maintenance-task',
    () => recordMaintenanceService.getTask()
  )
  ipcMain.handle(
    'data:maintenance-stop',
    () => recordMaintenanceService.stop()
  )
  ipcMain.handle(
    'requirements:semanticize',
    (_event, input: RequirementSemanticizationStartInput) => requirementSemanticizationService.start(input)
  )
  ipcMain.handle('requirements:semanticization-task', () => requirementSemanticizationService.getTask())
  ipcMain.handle(
    'requirements:semanticization-control',
    (_event, action: RequirementSemanticizationControl) => requirementSemanticizationService.control(action)
  )
  ipcMain.handle('data:stats', () => db.getStats())
  ipcMain.handle('sync:get-config', () => settings.getSyncConfig())
  ipcMain.handle('sync:save-config', (_event, config: SyncScopeConfig) => {
    settings.saveSyncConfig(config)
  })
  ipcMain.handle('sync:preview', (_event, config?: SyncScopeConfig) => {
    const effectiveConfig = config ?? settings.getSyncConfig()
    if (!effectiveConfig) throw new Error('请先保存采集范围配置')
    return new VisslmClient(settings.getPlatformCredentials()).previewScope(effectiveConfig)
  })
  ipcMain.handle('sync:start', async (_event, config?: SyncScopeConfig) => {
    if (config) settings.saveSyncConfig(config)
    return recordIndexLock.runExclusive(async () => {
      const result = await syncService.run(config ?? settings.getSyncConfig() ?? undefined)
      if (result.ok) {
        await knowledgeService.syncRecordIndexInLock()
        projectManagementService.markMatchesStale()
      }
      return result
    })
  })
  ipcMain.handle(
    'data:apply-review',
    async (_event, input: DataReviewApplyInput) => {
      return recordIndexLock.runExclusive(async () => {
        const result = input.source === 'sync'
          ? await syncService.applyDataReviews(input.batchId, input.reviewIds)
          : db.applyImportDataReviews(input.batchId, input.reviewIds)
        if (result.updatedCount > 0) {
          await knowledgeService.syncRecordIndexInLock()
          projectManagementService.markMatchesStale()
        }
        return result
      })
    }
  )
  ipcMain.handle('sync:request-logs', (_event, page?: number, pageSize?: number) =>
    db.listCollectionRequestLogs(page, pageSize)
  )
  ipcMain.handle('chat:sessions', (_event, limit?: number) => db.listChatSessions(limit))
  ipcMain.handle('chat:session', (_event, id: string) => db.getChatSession(id))
  ipcMain.handle('chat:save-session', (_event, input: ChatSessionSaveInput) =>
    db.saveChatSession(input)
  )
  ipcMain.handle('chat:delete-session', (_event, id: string): ChatSessionDeleteResult =>
    db.deleteChatSession(id)
  )
  ipcMain.handle('assistant-artifacts:preview', (_event, input: AssistantArtifactInput) =>
    createAssistantArtifactPreview(input)
  )
  ipcMain.handle('assistant-artifacts:commit', (_event, preview: AssistantArtifactPreview) =>
    db.saveAssistantArtifact(verifyAssistantArtifactPreview(preview))
  )
  ipcMain.handle('assistant-artifacts:list', (_event, limit?: number) =>
    db.listAssistantArtifacts(limit)
  )
  ipcMain.handle('assistant-artifacts:revert', (_event, id: string) =>
    db.revertAssistantArtifact(id)
  )
  ipcMain.handle('assistant-runs:list', (_event, limit?: number) =>
    db.listAssistantRunHistory(limit)
  )
  ipcMain.handle('assistant-runs:stats', () => db.getAssistantRunHistoryStats())
  ipcMain.handle(
    'assistant-artifacts:export',
    async (ipcEvent, input: AssistantArtifactExportRequest): Promise<AssistantArtifactExportResult> => {
      const artifact = db.getAssistantArtifact(input.artifactId.trim())
      if (!artifact) throw new Error('交付物不存在')
      if (artifact.status !== 'active') throw new Error('交付物已撤销，不能导出')
      const rendered = await renderAssistantArtifact(artifact, input.format, input.instructions)
      const owner = BrowserWindow.fromWebContents(ipcEvent.sender)
      const saveOptions = {
        title: '导出 AI 交付物',
        defaultPath: rendered.fileName,
        filters: [{ name: input.format.toUpperCase(), extensions: [input.format] }]
      }
      const selection = owner
        ? await dialog.showSaveDialog(owner, saveOptions)
        : await dialog.showSaveDialog(saveOptions)
      if (selection.canceled || !selection.filePath) {
        return { ok: false, canceled: true, format: input.format, message: '已取消导出' }
      }
      writeFileSync(selection.filePath, rendered.bytes)
      return {
        ok: true,
        format: input.format,
        filePath: selection.filePath,
        fileName: rendered.fileName,
        mimeType: rendered.mimeType,
        byteSize: rendered.byteSize,
        sha256: rendered.sha256,
        manifest: rendered.manifest,
        message: `已导出 ${rendered.fileName}`
      }
    }
  )
  ipcMain.handle('agent:cancel', (ipcEvent, runId: unknown) =>
    assistantRunRegistry.cancel(ipcEvent.sender, runId)
  )
  ipcMain.handle('agent:confirm-plan', (ipcEvent, runId: unknown, patch: unknown) =>
    assistantPlanConfirmation.confirm(
      ipcEvent.sender,
      runId,
      patch as AssistantPlanPatch | undefined
    )
  )
  ipcMain.handle('agent:ask', async (ipcEvent, request: ChatRequest) => {
    // Preserve the renderer's original text before any auto-intent recovery
    // or mention stripping. Artifact generation is gated against this
    // immutable value at the final dispatch boundary below.
    const originalUserQuestion = String(request?.question ?? '')
    const registration = assistantRunRegistry.register(ipcEvent.sender, request?.runId)
    const runStartedAt = new Date().toISOString()
    const runStages: AssistantRunHistory['stages'] = []
    let completedResponse: ChatResponse | undefined
    request = { ...request, runId: registration.runId }
    const fallbackTraceContext: AssistantTraceContext = {
      taskType: 'conversation',
      sourceMode: 'conversation',
      resultMode: 'answer',
      primaryAgent: 'conversation',
      invokedAgents: []
    }
    const cancelledResponse = (response?: ChatResponse): ChatResponse => {
      answerStream?.abandon()
      let context = fallbackTraceContext
      if (response?.taskTrace) {
        context = {
          taskType: response.taskTrace.taskType,
          sourceMode: response.taskTrace.sourceMode,
          resultMode: response.taskTrace.resultMode,
          primaryAgent: response.taskTrace.primaryAgent,
          invokedAgents: response.taskTrace.invokedAgents
        }
      } else if (response?.assistantIntent) {
        try {
          context = traceContextFromDecision(response.assistantIntent)
        } catch {
          // Keep the conversation fallback for an invalid or partial response.
        }
      }
      return {
        answer: '本次助手任务已取消，未保留未完成的证据或产物。',
        sources: [],
        dataViews: [],
        cancelled: true,
        ...(response?.expertId ? { expertId: response.expertId } : {}),
        ...(response?.assistantIntent ? { assistantIntent: response.assistantIntent } : {}),
        taskTrace: createAssistantTaskTrace(context, {
          runId: registration.runId,
          startedAt: runStartedAt,
          status: 'cancelled',
          invokedAgents: response?.taskTrace?.invokedAgents ?? [],
          error: {
            code: 'AGENT_RUN_CANCELLED',
            message: '助手任务已取消'
          }
        }),
        events: [{
          type: 'error' as const,
          code: 'AGENT_RUN_CANCELLED',
          message: '助手任务已取消',
          recoverable: true,
          stage: 'cancelled'
        }]
      }
    }
    let runFinished = false
    let activitySequence = 0
    let lastActivityFingerprint: string | undefined
    const sendAgentEvent = (event: AgentEvent): void => {
      if (runFinished || registration.signal.aborted || ipcEvent.sender.isDestroyed()) return
      if (event.type === 'status') {
        runStages.push({ stage: event.stage, message: event.message, at: new Date().toISOString() })
      }
      try {
        ipcEvent.sender.send('agent:event', {
          runId: registration.runId,
          conversationId: request.conversationId,
          event
        })
      } catch {
        // A renderer can disappear between the destroyed check and send.
      }
    }
    const emitActivity = (draft: AssistantWorkLogDraft): void => {
      const fingerprint = [draft.kind, draft.stage, draft.title ?? '', draft.summary, draft.status].join('|')
      if (fingerprint === lastActivityFingerprint) return
      lastActivityFingerprint = fingerprint
      const sequence = ++activitySequence
      sendAgentEvent({
        type: 'activity',
        activityId: `${registration.runId}:activity:${sequence}`,
        sequence,
        kind: draft.kind,
        stage: draft.stage,
        ...(draft.title ? { title: draft.title } : {}),
        summary: draft.summary,
        status: draft.status,
        createdAt: new Date().toISOString()
      })
    }
    const emitAgentProgress = (event: AgentEvent): void => {
      sendAgentEvent(event)
      if (event.type === 'status') emitActivity(workLogForStatus(event.stage, event.message))
    }
    const answerStream = new AnswerStream({
      emit: (event) => sendAgentEvent(event),
      signal: registration.signal
    })
    let confirmedExecutionSummary: AssistantExecutionSummary | undefined
    const confirmExecutionSummary = async (
      summary: AssistantExecutionSummary,
      dataScope?: DataScope
    ): Promise<ConfirmedAssistantPlan> => {
      const confirmationInput = {
        summary,
        dataScope: dataScope ?? request.dataScope,
        metadata: planValidationMetadata(summary, dataScope ?? request.dataScope)
      }
      emitActivity({
        kind: 'checkpoint',
        stage: 'scope-confirmation',
        title: '确认执行范围',
        summary: '正在等待执行范围确认。',
        status: 'running'
      })
      const confirmation = assistantPlanConfirmation.wait(
        ipcEvent.sender,
        registration.runId,
        registration.signal,
        confirmationInput
      )
      sendAgentEvent({ type: 'plan', summary, requiresConfirmation: true })
      const approved = await confirmation
      if (!approved) throw new Error('执行计划确认未完成')
      confirmedExecutionSummary = approved.effectiveSummary
      request = { ...request, dataScope: approved.effectiveDataScope }
      emitActivity({
        kind: 'checkpoint',
        stage: 'scope-confirmation',
        title: '范围已确认',
        summary: '范围已确认，开始执行。',
        status: 'completed'
      })
      return approved
    }
    return runWithAssistantRunContext(registration.context, async () => {
      try {
        const response = await (async (): Promise<ChatResponse> => {
    const isAutoChat = request.chatMode === 'auto' && request.entrypoint !== 'dashboard'
    let assistantIntent: AssistantIntentDecision | undefined
    const traceStartedAt = new Date().toISOString()
    const fallbackTraceContext: AssistantTraceContext = {
      taskType: 'conversation',
      sourceMode: 'conversation',
      resultMode: 'answer',
      primaryAgent: 'conversation',
      invokedAgents: []
    }
    let selectedTraceContext: AssistantTraceContext = fallbackTraceContext
    const traceContextForResponse = (override?: AssistantTraceContext): AssistantTraceContext => {
      if (override) return override
      if (assistantIntent) {
        try {
          return traceContextFromDecision(assistantIntent)
        } catch {
          // Invalid combinations are handled below before dispatch. A failed
          // response still needs a truthful, non-evidence trace fallback.
        }
      }
      return selectedTraceContext
    }
    const attachAssistantIntent = (
      response: ChatResponse,
      options: Parameters<typeof createAssistantTaskTrace>[1] = {},
      contextOverride?: AssistantTraceContext
    ): ChatResponse => {
      const withSummary = confirmedExecutionSummary && !response.executionSummary
        ? { ...response, executionSummary: confirmedExecutionSummary }
        : response
      const hasRecoverableError = withSummary.events?.some(
        (event) => event.type === 'error' && event.recoverable
      ) === true
      const withRecovery = hasRecoverableError && confirmedExecutionSummary &&
          !withSummary.recoverySuggestions?.length
        ? {
            ...withSummary,
            recoverySuggestions: buildSafeQueryRecoverySuggestions(confirmedExecutionSummary)
          }
        : withSummary
      const evidenceBlocks = withRecovery.evidenceBlocks?.length
        ? withRecovery.evidenceBlocks
        : buildEvidenceBlocks(
            withRecovery.sources,
            withRecovery.dataViews,
            withRecovery.executionSummary ?? confirmedExecutionSummary
          )
      const withEvidence = evidenceBlocks.length
        ? { ...withRecovery, evidenceBlocks }
        : withRecovery
      const enriched = assistantIntent
        ? { ...withEvidence, assistantIntent }
        : withEvidence
      if (enriched.taskTrace) return enriched
      return {
        ...enriched,
        taskTrace: createAssistantTaskTrace(traceContextForResponse(contextOverride), {
          startedAt: traceStartedAt,
          ...options
        })
      }
    }
    // A renderer restart can lose its in-memory history. This recovery is
    // deliberately callable only after the first Auto intent decision and
    // before any evidence agent, field catalog, or index access. If the first
    // decision asks for clarification, the caller returns without touching
    // the persisted session.
    const recoverPersistedHistory = (): boolean => {
      if (!request.conversationId || request.history?.length) return false
      const persisted = db.getChatSession(request.conversationId)
      if (!persisted?.messages.length) return false
      request = {
        ...request,
        history: chatHistoryFromMessages(persisted.messages)
      }
      return true
    }
    if (isAutoChat) {
      const emitIntentStatus = (
        stage: 'classify' | 'skill',
        message: string,
        metadata?: Extract<AgentEvent, { type: 'status' }>['metadata']
      ): void => {
        sendAgentEvent({ type: 'status' as const, stage, message, ...(metadata ? { metadata } : {}) })
        emitActivity(workLogForStatus(stage, message))
      }
      emitIntentStatus('classify', '正在理解目标、上下文与任务类型')
      try {
        // The main process is the trust boundary. Auto-mode decisions supplied
        // by the renderer are ignored and always recomputed before data access.
        assistantIntent = await resolveAssistantIntent(
          request,
          settings.getModelCredentials()
        )
        if (!assistantIntent.needsClarification && recoverPersistedHistory()) {
          // Recompute against recovered bounded user history so follow-ups
          // can ground entities without trusting renderer-provided intent.
          assistantIntent = await resolveAssistantIntent(
            request,
            settings.getModelCredentials()
          )
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        emitIntentStatus('classify', `统一意图判断失败：${errorMessage}`)
        emitActivity(workLogForFailure('task-judgment'))
        return {
          answer: '本次请求无法安全判断任务类型，未访问数据中心或知识库。请补充问题范围后重试。',
          sources: [],
          dataViews: [],
          needsClarification: true,
          clarificationQuestion: '请明确要进行普通对话、数据中心查询、知识库问答、混合分析、可视化或需求匹配中的哪一种任务。',
          expertId: 'general',
          taskTrace: createAssistantTaskTrace(fallbackTraceContext, {
            startedAt: traceStartedAt,
            status: 'failed',
            invokedAgents: [],
            error: {
              code: 'AUTO_INTENT_CLASSIFICATION_FAILED',
              message: errorMessage
            }
          }),
          events: [{
            type: 'error' as const,
            code: 'AUTO_INTENT_CLASSIFICATION_FAILED',
            message: errorMessage,
            recoverable: true,
            stage: 'classify'
          }]
        }
      }
      emitActivity(workLogForIntent(assistantIntent))
      const routeValidation = validateAssistantExecutionRoute(assistantIntent)
      if (!routeValidation.ok) {
        const errorMessage = routeValidation.error
        emitIntentStatus('skill', `任务与来源组合未通过校验：${errorMessage}`)
        emitActivity(workLogForFailure('skill-selection'))
        return {
          ...attachAssistantIntent({
            answer: '本次请求的任务与数据来源组合无法安全执行，未访问数据中心或知识库。请重新说明目标。',
            sources: [],
            dataViews: [],
            needsClarification: true,
            clarificationQuestion: '请重新明确要进行普通对话、数据中心查询、知识库问答、混合分析、可视化或需求匹配中的哪一种任务。',
            expertId: assistantIntent.skillId,
            events: [{
              type: 'error' as const,
              code: 'ASSISTANT_EXECUTION_ROUTE_INVALID',
              message: errorMessage,
              recoverable: true,
              stage: 'route'
            }]
          }, {
            status: 'failed',
            invokedAgents: [],
            error: { code: 'ASSISTANT_EXECUTION_ROUTE_INVALID', message: errorMessage }
          })
        }
      }
      const taskLabels: Record<AssistantIntentDecision['taskType'], string> = {
        conversation: '普通对话',
        record_query: '数据中心查询',
        knowledge_qa: '知识库问答',
        mixed_analysis: '混合分析',
        visualization: '可视化交付',
        requirement_matching: '需求匹配',
        artifact_generation: '交付物生成'
      }
      const skillLabels: Record<AssistantIntentDecision['skillId'], string> = {
        general: '通用数据助手',
        'knowledge-base': '知识库专家',
        visualization: '数据可视化专家',
        'requirement-analysis': '需求分析专家',
        artifact: '交付物专家'
      }
      emitIntentStatus(
        'skill',
        `已选择任务：${taskLabels[assistantIntent.taskType]}；技能：${skillLabels[assistantIntent.skillId]}`,
        {
          expertId: assistantIntent.skillId,
          taskType: assistantIntent.taskType,
          sourceMode: assistantIntent.sourceMode,
          resultMode: assistantIntent.resultMode,
          followUp: Boolean(request.history?.length),
          ...(assistantIntent.clarificationQuestion
            ? { clarificationQuestion: assistantIntent.clarificationQuestion }
            : {})
        }
      )
      emitActivity(workLogForSkill(assistantIntent))
      if (assistantIntent.needsClarification) {
        emitActivity({
          kind: 'checkpoint',
          stage: 'scope-confirmation',
          title: '需要补充范围',
          summary: '当前请求的范围或来源尚未安全确定，等待补充信息。',
          status: 'warning'
        })
        const clarificationQuestion = assistantIntent.clarificationQuestion ||
          '为了避免执行猜测性查询，请补充任务范围或数据来源。'
        return attachAssistantIntent({
          answer: clarificationQuestion,
          sources: [],
          dataViews: [],
          needsClarification: true,
          clarificationQuestion,
          expertId: assistantIntent.skillId,
        }, {
          status: 'clarification',
          invokedAgents: []
        })
      }
      request = {
        ...request,
        question: assistantIntent.resolvedQuestion,
        assistantIntent
      }
    }
    if (!isAutoChat) recoverPersistedHistory()
    const autoRequirementIdsForRequest = isAutoChat && assistantIntent?.taskType === 'requirement_matching'
      ? autoRequirementIds(request.question, request.history)
      : null
    const routedRequest = assistantIntent
      ? {
          ...request,
          expertId: assistantIntent.skillId,
          chatMode: 'expert' as const
        }
      : request
    const route = expertRouter.route(routedRequest)
    if (!isAutoChat) {
      emitActivity({
        kind: 'narrative',
        stage: 'skill-selection',
        title: '执行技能已确定',
        summary: '已根据当前入口与用户选择确定执行技能。',
        status: 'completed'
      })
    }
    const artifactRouteRequested = assistantIntent?.taskType === 'artifact_generation' || route.expert.id === 'artifact'
    if (artifactRouteRequested && !explicitArtifactMentionPattern.test(originalUserQuestion)) {
      const message = '交付物生成必须由用户在原始问题中显式输入 @交付物专家；本次未生成交付物。'
      // Clear any renderer/model decision before attaching the safe response,
      // so neither the response intent nor its trace can claim an artifact
      // execution happened.
      assistantIntent = undefined
      selectedTraceContext = fallbackTraceContext
      return attachAssistantIntent({
        answer: message,
        sources: [],
        dataViews: [],
        needsClarification: true,
        clarificationQuestion: message,
        expertId: 'general'
      }, {
        status: 'clarification',
        invokedAgents: []
      }, fallbackTraceContext)
    }
    selectedTraceContext = assistantIntent
      ? traceContextForResponse()
      : route.expert.id === 'visualization'
        ? {
            taskType: 'visualization',
            sourceMode: 'records',
            resultMode: 'dashboard',
            primaryAgent: 'visualization',
            invokedAgents: []
          }
        : route.expert.id === 'requirement-analysis'
          ? {
              taskType: 'requirement_matching',
              sourceMode: 'records',
              resultMode: 'answer',
              primaryAgent: 'requirement-analysis',
              invokedAgents: []
            }
          : route.expert.id === 'knowledge-base'
            ? {
                taskType: 'knowledge_qa',
                sourceMode: 'knowledge',
                resultMode: 'answer',
                primaryAgent: 'knowledge-base',
                invokedAgents: []
              }
            : route.expert.id === 'artifact'
              ? {
                  taskType: 'artifact_generation',
                  sourceMode: 'mixed',
                  resultMode: 'artifact',
                  primaryAgent: 'artifact',
                  invokedAgents: []
                }
          : route.expert.id === 'general'
            ? fallbackTraceContext
            : fallbackTraceContext
    if (assistantIntent?.taskType === 'artifact_generation' || route.expert.id === 'artifact') {
      const source = request.artifactSource
      if (!source?.evidenceBlocks.length) {
        emitActivity({
          kind: 'checkpoint',
          stage: 'evidence-verification',
          title: '等待可核验证据',
          summary: '交付物需要已有回答中的可核验证据，当前未开始生成。',
          status: 'warning'
        })
        return attachAssistantIntent({
          answer: '请先选择一条包含可核验证据的已完成回答，再生成交付物。',
          sources: [],
          dataViews: [],
          needsClarification: true,
          clarificationQuestion: '请先选择一条包含可核验证据的已完成回答。',
          expertId: 'artifact'
        }, { status: 'clarification', invokedAgents: [] })
      }
      const artifactPreview = createAssistantArtifactPreview({
        ...source,
        type: source.type ?? 'delivery_draft',
        title: source.title || `交付物草稿 · ${source.question}`
      })
      emitActivity(workLogForDelivery())
      return attachAssistantIntent({
        answer: '已基于所选回答的 EvidenceBlock 生成交付物预览。确认影响范围和回滚点后才能保存；当前未写入任何原始数据。',
        sources: source.sources ?? [],
        dataViews: source.dataViews,
        evidenceBlocks: source.evidenceBlocks,
        artifactPreview,
        expertId: 'artifact'
      }, { invokedAgents: ['artifact'] })
    }
    if (
      request.entrypoint !== 'dashboard' &&
      (route.expert.id === 'visualization' || route.expert.id === 'requirement-analysis')
    ) {
      const scope = request.dataScope
      const requirementIds = autoRequirementIds(request.question, request.history) ?? []
      const stringValue = (value: unknown): string | undefined => value === undefined
        ? undefined
        : typeof value === 'string'
          ? value.slice(0, 240)
          : JSON.stringify(value).slice(0, 240)
      const summaryProjectIds = scope?.projectIds !== undefined
        ? [...new Set(scope.projectIds)]
        : request.projectId ? [request.projectId] : []
      await confirmExecutionSummary({
        question: request.question,
        taskType: route.expert.id === 'visualization' ? 'visualization' : 'requirement_matching',
        sourceMode: 'records',
        resultMode: route.expert.id === 'visualization' ? 'dashboard' : 'answer',
        intent: route.expert.id === 'visualization' ? 'visualize_records' : 'match_requirements',
        searchTerms: requirementIds.length ? requirementIds : assistantIntent?.groupEntities ?? [],
        fields: [],
        filters: [],
        limit: scope?.recordUids?.length ?? 50,
        scope: {
          projectIds: [...new Set(summaryProjectIds)],
          nodeTypes: [...new Set(scope?.nodeTypes ?? [])],
          ...(scope?.recordUids ? { recordCount: scope.recordUids.length } : {}),
          baseFilters: (scope?.baseFilters ?? []).map((filter) => ({
            field: filter.field,
            operator: filter.operator,
            ...(filter.value === undefined ? {} : { value: stringValue(filter.value) })
          })),
          ...(scope?.snapshotAt ? { snapshotAt: scope.snapshotAt } : {})
        }
      }, scope)
    }
    if (autoRequirementIdsForRequest?.length) {
      emitActivity({
        kind: 'tool',
        stage: 'query',
        title: '查询需求数据',
        summary: '正在按已确认需求编号查询数据中心记录。',
        status: 'running'
      })
      const agent = new DirectRequirementDataAnalysisAgent(
        db,
        settings.getModelCredentials(),
        undefined,
        (content) => answerStream.push(content)
      )
      return agent.ask({
        ...request,
        question: request.question,
        extractedRequirementIds: autoRequirementIdsForRequest
      }).then((response) => {
        emitActivity(workLogForVerification())
        emitActivity(workLogForDelivery())
        return attachAssistantIntent(response, {
          invokedAgents: ['requirement-analysis']
        })
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        emitActivity(workLogForFailure('query'))
        return attachAssistantIntent({
          answer: `本次需求数据分析没有完成。\n\n${errorMessage}\n\n请检查需求编号对应的本地数据后重试。`,
          sources: [],
          dataViews: [],
          events: [{
            type: 'error' as const,
            code: 'DIRECT_REQUIREMENT_DATA_ANALYSIS_FAILED',
            message: errorMessage,
            recoverable: true,
            stage: 'answer'
          }]
        }, {
          status: 'failed',
          invokedAgents: ['requirement-analysis'],
          error: {
            code: 'DIRECT_REQUIREMENT_DATA_ANALYSIS_FAILED',
            message: errorMessage
          }
        })
      })
    }
    if (request.entrypoint !== 'dashboard' && request.chatMode === 'plain') {
      emitActivity({
        kind: 'narrative',
        stage: 'answer',
        title: '生成对话回答',
        summary: '正在生成普通对话回答。',
        status: 'running'
      })
      const agent = new PlainChatAgent(
        settings.getModelCredentials(),
        undefined,
        (content) => answerStream.push(content)
      )
      return agent.ask({ ...request, question: route.question }).then((response) => {
        emitActivity(workLogForDelivery())
        return attachAssistantIntent(response, {
          invokedAgents: ['conversation']
        })
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        emitActivity(workLogForFailure('answer'))
        return attachAssistantIntent({
          answer: `本次普通对话没有完成。\n\n${errorMessage}\n\n你可以检查模型连接后重试。`,
          sources: [],
          dataViews: [],
          events: [{
            type: 'error' as const,
            code: 'PLAIN_CHAT_FAILED',
            message: errorMessage,
            recoverable: true,
            stage: 'answer'
          }]
        }, {
          status: 'failed',
          invokedAgents: ['conversation'],
          error: {
            code: 'PLAIN_CHAT_FAILED',
            message: errorMessage
          }
        })
      })
    }
    if (route.expert.id === 'visualization') {
      const activeArtifact = request.activeArtifact
      const focusComponentId = request.focusComponentId?.trim() || undefined
      if (activeArtifact && activeArtifact.artifactId !== activeArtifact.dashboard.id) {
        const message = '活动大屏标识与 DashboardSpec 不一致，无法执行修改'
        emitActivity(workLogForFailure('scope-confirmation'))
        return attachAssistantIntent({
          answer: '本次大屏修改未应用，当前画布保持不变。',
          sources: [],
          dataViews: [],
          expertId: route.expert.id,
          events: [{
            type: 'error' as const,
            code: 'DASHBOARD_ARTIFACT_MISMATCH',
            message,
            recoverable: true,
            stage: 'validate'
          }]
        }, {
          status: 'failed',
          invokedAgents: [],
          error: { code: 'DASHBOARD_ARTIFACT_MISMATCH', message }
        })
      }
      if (focusComponentId && !activeArtifact) {
        const message = '指定组件修改需要先打开一个活动大屏'
        emitActivity(workLogForFailure('scope-confirmation'))
        return attachAssistantIntent({
          answer: '本次大屏修改未应用，当前画布保持不变。',
          sources: [],
          dataViews: [],
          expertId: route.expert.id,
          events: [{
            type: 'error' as const,
            code: 'DASHBOARD_ACTIVE_ARTIFACT_REQUIRED',
            message,
            recoverable: true,
            stage: 'validate'
          }]
        }, {
          status: 'failed',
          invokedAgents: [],
          error: { code: 'DASHBOARD_ACTIVE_ARTIFACT_REQUIRED', message }
        })
      }
      if (focusComponentId && activeArtifact &&
          !activeArtifact.dashboard.components.some((component) => component.id === focusComponentId)) {
        const message = `指定组件 ${focusComponentId} 不存在，无法执行修改`
        emitActivity(workLogForFailure('scope-confirmation'))
        return attachAssistantIntent({
          answer: '本次大屏修改未应用，当前画布保持不变。',
          sources: [],
          dataViews: [],
          expertId: route.expert.id,
          events: [{
            type: 'error' as const,
            code: 'DASHBOARD_COMPONENT_NOT_FOUND',
            message,
            recoverable: true,
            stage: 'validate'
          }]
        }, {
          status: 'failed',
          invokedAgents: [],
          error: { code: 'DASHBOARD_COMPONENT_NOT_FOUND', message }
        })
      }
      const scope = request.dataScope ?? activeArtifact?.dashboard.components
        .find((component) => component.query?.scope)?.query?.scope ?? {
        ...(request.projectId ? { projectIds: [request.projectId] } : {})
      }
      const queryEngine = new QueryEngine(db)
      const requestMode = resolveVisualizationRequestMode(
        route.question,
        Boolean(activeArtifact),
        focusComponentId
      )
      const isPatchRequest = requestMode === 'patch'
      emitActivity(workLogForStatus('execute'))
      let latestVisualizationRun: VisualizationRunInput | undefined
      const agent = new VisualizationAgent(
        queryEngine,
        settings.getModelCredentials(),
        (run) => {
          latestVisualizationRun = run
          if (!registration.signal.aborted) db.recordVisualizationRun(run)
        },
        (event) => emitAgentProgress(event)
      )
      const task = activeArtifact && isPatchRequest
        ? agent.patch(
            route.question,
            activeArtifact.dashboard,
            scope,
            focusComponentId,
            request.history
          )
        : agent.generate(route.question, scope)
      return task
        .then((dashboard) => ({
          answer: `已生成“${dashboard.title}”，共 ${dashboard.components.length} 个组件。所有指标均由 QuerySpec 在本地数据范围内计算。`,
          sources: [],
          dataViews: [],
          expertId: route.expert.id,
          dashboard,
          ...(activeArtifact && isPatchRequest && latestVisualizationRun
            ? {
                dashboardChange: {
                  ...compareDashboardSpecValues(activeArtifact.dashboard, dashboard),
                  queryExecutionCount: latestVisualizationRun.toolCalls.filter(
                    (call) => call.tool === 'execute-query' && call.status === 'success'
                  ).length,
                  attemptCount: latestVisualizationRun.attemptCount,
                  durationMs: latestVisualizationRun.durationMs
                }
              }
            : {}),
          events: [
            {
              type: 'status' as const,
              stage: 'validate',
              message: 'DashboardSpec 与查询结果校验通过'
            },
            {
              type: 'artifact' as const,
              artifactId: dashboard.id,
              version: activeArtifact && isPatchRequest && activeArtifact.version !== undefined
                ? activeArtifact.version + 1
                : 1,
              dashboard
            }
          ]
        }))
        .then((response) => activeArtifact && isPatchRequest
          ? {
              ...response,
              answer: `已完成对“${response.dashboard?.title ?? '当前大屏'}”的修改，结果已通过校验，等待保存为新版本。`
            }
          : response)
        .then((response) => {
          emitActivity(workLogForVerification())
          emitActivity(workLogForDelivery())
          return attachAssistantIntent(response, {
            invokedAgents: ['visualization']
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          emitActivity(workLogForFailure('execute'))
          if (message === '当前数据范围没有可用字段，请先采集数据') {
            return attachAssistantIntent({
              answer: '当前数据范围内没有可用于生成大屏的记录。请先完成数据采集，或调整数据范围后重试。',
              sources: [],
              dataViews: [],
              expertId: route.expert.id,
              events: [{
                type: 'error' as const,
                code: 'NO_ANALYTICS_DATA',
                message,
                recoverable: true
              }]
            }, {
              status: 'failed',
              invokedAgents: ['visualization'],
              error: { code: 'NO_ANALYTICS_DATA', message }
            })
          }
          if (activeArtifact && isPatchRequest) {
            const failedTool = [...(latestVisualizationRun?.toolCalls ?? [])]
              .reverse()
              .find((call) => call.status === 'failed')
            return attachAssistantIntent({
              answer: '本次大屏修改未应用，当前画布保持不变。',
              sources: [],
              dataViews: [],
              expertId: route.expert.id,
              events: [{
                type: 'error' as const,
                code: dashboardPatchErrorCode(latestVisualizationRun),
                message,
                recoverable: true,
                stage: failedTool?.tool,
                attemptCount: latestVisualizationRun?.attemptCount
              }]
            }, {
              status: 'failed',
              invokedAgents: ['visualization'],
              error: {
                code: dashboardPatchErrorCode(latestVisualizationRun),
                message
              }
            })
          }
          return attachAssistantIntent({
            answer: '本次可视化任务没有完成。',
            sources: [],
            dataViews: [],
            expertId: route.expert.id,
            events: [{
              type: 'error' as const,
              code: 'VISUALIZATION_FAILED',
              message,
              recoverable: true,
              stage: 'execute'
            }]
          }, {
            status: 'failed',
            invokedAgents: ['visualization'],
            error: { code: 'VISUALIZATION_FAILED', message }
          })
        })
    }
    if (route.expert.id === 'requirement-analysis') {
      emitActivity(workLogForStatus('execute'))
      const agent = new RequirementAnalysisAgent(
        db,
        knowledgeService,
        settings.getModelCredentials(),
        (event: Extract<AgentEvent, { type: 'status' }>) => emitAgentProgress(event)
      )
      return agent.ask({ ...request, question: route.question }).then((response) => {
        emitActivity(workLogForVerification())
        emitActivity(workLogForDelivery())
        return attachAssistantIntent({
          ...response,
          contextRefs: response.contextRefs ?? contextRefsFromResponse(response),
          expertId: route.expert.id
        }, {
          invokedAgents: ['requirement-analysis']
        })
      }).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        emitActivity(workLogForFailure('execute'))
        return attachAssistantIntent({
          answer: `需求分析未完成。\n\n${errorMessage}\n\n请检查需求编号和本地数据索引后重试。`,
          sources: [],
          dataViews: [],
          expertId: route.expert.id,
          events: [{
            type: 'error' as const,
            code: 'REQUIREMENT_ANALYSIS_FAILED',
            message: errorMessage,
            recoverable: true,
            stage: 'error'
          }]
        }, {
          status: 'failed',
          invokedAgents: ['requirement-analysis'],
          error: {
            code: 'REQUIREMENT_ANALYSIS_FAILED',
            message: errorMessage
          }
        })
      })
    }
    const executionRequest = route.expert.id === 'knowledge-base' && !request.assistantIntent
      ? {
          ...request,
          assistantIntent: {
            taskType: 'knowledge_qa' as const,
            skillId: 'knowledge-base' as const,
            sourceMode: 'knowledge' as const,
            resolvedQuestion: route.question,
            resultMode: 'answer' as const,
            groupEntities: [],
            needsClarification: false,
            reason: 'explicit-knowledge-base-skill'
          }
        }
      : request
    const agent = new OllamaAgent(
      db,
      settings.getModelCredentials(),
      knowledgeService,
      (event: Extract<AgentEvent, { type: 'status' }>) => sendAgentEvent(event),
      (content) => answerStream.push(content),
      confirmExecutionSummary,
      emitActivity
    )
    return agent.ask({ ...executionRequest, question: route.question }).then((response) => attachAssistantIntent({
      ...response,
      contextRefs: response.contextRefs ?? contextRefsFromResponse(response),
      expertId: route.expert.id
    })).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      emitActivity(workLogForFailure('execution'))
      const failure = error as {
        invokedAgents?: AssistantExecutionAgentId[]
        traceContext?: AssistantTraceContext
      }
      return attachAssistantIntent({
        answer: `本次任务没有完成。\n\n${errorMessage}\n\n你可以检查模型连接、缩小问题范围后重试。`,
        sources: [],
        dataViews: [],
        expertId: route.expert.id,
        events: [{
          type: 'error' as const,
          code: 'AGENT_REQUEST_FAILED',
          message: errorMessage,
          recoverable: true,
          stage: 'error'
          }]
      }, {
        status: 'failed',
        invokedAgents: failure.invokedAgents ?? [],
        error: {
          code: 'AGENT_REQUEST_FAILED',
          message: errorMessage
        }
      }, failure.traceContext)
        })
        })()
        if (registration.signal.aborted) {
          completedResponse = cancelledResponse(response)
          return completedResponse
        }
        const hasErrorEvent = response.events?.some((event) => event.type === 'error') ?? false
        const failedTrace = response.taskTrace?.status === 'failed' || response.taskTrace?.status === 'cancelled'
        if (response.needsClarification || response.cancelled || hasErrorEvent || failedTrace) {
          answerStream.abandon()
        } else {
          answerStream.complete(response.answer)
        }
        completedResponse = response
        return response
      } catch (error) {
        if (registration.signal.aborted || isAssistantRunCancellation(error)) {
          completedResponse = cancelledResponse()
          return completedResponse
        }
        answerStream.abandon()
        throw error
      } finally {
        runFinished = true
        answerStream.abandon()
        const completedAt = new Date().toISOString()
        const trace = completedResponse?.taskTrace
        const errorEvent = completedResponse?.events?.find((event) => event.type === 'error')
        const taskContext = trace ?? {
          runId: registration.runId,
          status: 'failed' as const,
          ...fallbackTraceContext,
          startedAt: runStartedAt,
          completedAt,
          error: { code: 'AGENT_RUN_FAILED', message: '助手任务在返回响应前失败' }
        }
        const toolStageNames = new Set(['inspect', 'scan', 'retrieve', 'query', 'tool', 'execute'])
        const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(runStartedAt))
        const usage = getAssistantRunUsage(registration.context)
        const inputTokenCount = usage?.inputTokenCount
        const outputTokenCount = usage?.outputTokenCount
        const rateDurationMs = usage?.completionDurationMs !== undefined && usage.completionDurationMs > 0
          ? usage.completionDurationMs
          : durationMs > 0
            ? durationMs
            : undefined
        const tokensPerSecond = outputTokenCount !== undefined && rateDurationMs !== undefined
          ? outputTokenCount / (rateDurationMs / 1_000)
          : undefined
        const history: AssistantRunHistory = {
          runId: registration.runId,
          ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          status: taskContext.status,
          taskType: taskContext.taskType,
          sourceMode: taskContext.sourceMode,
          resultMode: taskContext.resultMode,
          primaryAgent: taskContext.primaryAgent,
          invokedAgents: [...taskContext.invokedAgents],
          startedAt: runStartedAt,
          completedAt,
          durationMs,
          ...(inputTokenCount !== undefined ? { inputTokenCount } : {}),
          ...(outputTokenCount !== undefined ? { outputTokenCount } : {}),
          ...(tokensPerSecond !== undefined && Number.isFinite(tokensPerSecond) && tokensPerSecond >= 0
            ? { tokensPerSecond }
            : {}),
          stages: runStages.slice(0, 100),
          toolCallCount: runStages.filter((stage) => toolStageNames.has(stage.stage.trim().toLocaleLowerCase())).length,
          matchedCount: completedResponse?.dataViews.reduce((sum, view) => sum + view.total, 0) ?? 0,
          recordEvidenceCount: completedResponse?.sources.filter((source) => source.sourceType !== 'document').length ?? 0,
          documentEvidenceCount: completedResponse?.sources.filter((source) => source.sourceType === 'document').length ?? 0,
          ...((taskContext.status === 'failed' || taskContext.status === 'cancelled')
            ? { failedStage: errorEvent?.type === 'error' ? errorEvent.stage : runStages.at(-1)?.stage ?? 'unknown' }
            : {}),
          ...(taskContext.error ? { error: taskContext.error } : {})
        }
        db.saveAssistantRunHistory(history)
        assistantRunRegistry.finish(ipcEvent.sender, registration.runId)
      }
    })
  })
  ipcMain.handle('analytics:field-profiles', (_event, scope?: DataScope) =>
    new QueryEngine(db).profile(scope ?? {})
  )
  ipcMain.handle(
    'analytics:field-profile-semantics',
    (_event, scope: DataScope, field: string, patch: FieldProfileSemanticPatch) =>
      new QueryEngine(db).updateFieldProfileSemantics(scope ?? {}, field, patch)
  )
  ipcMain.handle('analytics:execute-query', (_event, spec: QuerySpec) =>
    new QueryEngine(db).execute(spec)
  )
  ipcMain.handle('dashboards:list', () => db.listDashboards())
  ipcMain.handle('dashboards:get', (_event, id: string, version?: number) =>
    db.getDashboard(id, version)
  )
  ipcMain.handle('dashboards:versions', (_event, id: string) =>
    db.listDashboardVersions(id)
  )
  ipcMain.handle('dashboards:save', (_event, input: DashboardSaveInput) => {
    try {
      const errors = validateDashboardSpec(input.spec, new QueryEngine(db))
      if (errors.length) throw new Error(`大屏校验失败：${errors.join('；')}`)
      const saved = db.saveDashboard(input)
      recordDashboardAudit({
        dashboardId: saved.dashboardId,
        action: 'save',
        status: 'success',
        version: saved.version,
        metadata: specAuditMetadata(saved.spec, {
          componentCount: saved.spec.components.length,
          changeSummary: input.changeSummary.trim().slice(0, 200)
        })
      })
      return saved
    } catch (error) {
      recordDashboardAudit({
        dashboardId: input?.spec?.id,
        action: 'save',
        status: 'failed',
        metadata: input?.spec ? specAuditMetadata(input.spec) : undefined,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle('dashboards:restore', (_event, id: string, version: number) => {
    try {
      const restored = db.restoreDashboard(id, version)
      recordDashboardAudit({
        dashboardId: restored.dashboardId,
        action: 'restore',
        status: 'success',
        version: restored.version,
        metadata: specAuditMetadata(restored.spec, { sourceVersion: version })
      })
      return restored
    } catch (error) {
      recordDashboardAudit({
        dashboardId: id,
        action: 'restore',
        status: 'failed',
        metadata: { sourceVersion: version },
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle('dashboards:diagnose', (_event, spec: DashboardSpec) => {
    try {
      const report = diagnoseDashboard(spec, new QueryEngine(db))
      recordDashboardAudit({
        dashboardId: spec.id,
        action: 'diagnose',
        status: 'success',
        metadata: specAuditMetadata(spec, {
          score: report.score,
          issueCount: report.issues.length,
          queryCount: report.queryCount
        })
      })
      return report
    } catch (error) {
      recordDashboardAudit({
        dashboardId: spec?.id,
        action: 'diagnose',
        status: 'failed',
        metadata: specAuditMetadata(spec),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle(
    'dashboards:repair-component',
    (_event, spec: DashboardSpec, componentId: string) => {
      try {
        const result = repairDashboardComponent(spec, componentId, new QueryEngine(db))
        recordDashboardAudit({
          dashboardId: spec.id,
          action: 'repair-component',
          status: 'success',
          metadata: {
            componentId,
            actionCount: result.actions.length,
            score: result.report.score,
            sourceSpecHash: dashboardSpecHash(spec),
            specHash: dashboardSpecHash(result.spec)
          }
        })
        return result
      } catch (error) {
        recordDashboardAudit({
          dashboardId: spec?.id,
          action: 'repair-component',
          status: 'failed',
          metadata: specAuditMetadata(spec, { componentId }),
          errorMessage: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    }
  )
  ipcMain.handle('dashboards:runs', (_event, limit?: number) =>
    db.listVisualizationRuns(limit)
  )
  ipcMain.handle('dashboards:audit-logs', (_event, dashboardId?: string, limit?: number) =>
    db.listDashboardAuditLogs(dashboardId, limit)
  )
  ipcMain.handle('dashboards:export-json', async (_event, spec: DashboardSpec, version?: number) => {
    try {
      const errors = validateDashboardSpec(spec, new QueryEngine(db))
      if (errors.length) throw new Error(`导出前校验失败：${errors.join('；')}`)
      const safeTitle = spec.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 80)
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出 DashboardSpec JSON',
        defaultPath: `${safeTitle || 'dashboard'}.json`,
        filters: [{ name: 'DashboardSpec JSON', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          dashboardId: spec.id,
          action: 'export-json',
          status: 'canceled',
          format: 'json',
          version,
          metadata: specAuditMetadata(spec, { componentCount: spec.components.length })
        })
        return { ok: false, canceled: true, message: '已取消导出' }
      }
      writeFileSync(result.filePath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8')
      recordDashboardAudit({
        dashboardId: spec.id,
        action: 'export-json',
        status: 'success',
        format: 'json',
        version,
        metadata: specAuditMetadata(spec, { componentCount: spec.components.length })
      })
      return { ok: true, path: result.filePath, message: 'DashboardSpec 已导出' }
    } catch (error) {
      recordDashboardAudit({
        dashboardId: spec?.id,
        action: 'export-json',
        status: 'failed',
        format: 'json',
        version,
        metadata: specAuditMetadata(spec),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle('dashboards:export-offline', async (_event, spec: DashboardSpec, version?: number) => {
    try {
      const errors = validateDashboardSpec(spec, new QueryEngine(db), { allowInlineData: true })
      if (errors.length) throw new Error(`离线导出前校验失败：${errors.join('；')}`)
      if (!mainWindow) throw new Error('主窗口尚未就绪')
      const safeTitle = spec.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 80)
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出离线预览包',
        defaultPath: `${safeTitle || 'dashboard'}-offline.zip`,
        filters: [{ name: '离线预览包', extensions: ['zip'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          dashboardId: spec.id,
          action: 'export-offline',
          status: 'canceled',
          format: 'offline',
          version,
          metadata: specAuditMetadata(spec, {
            componentCount: spec.components.length,
            dataMode: 'snapshot'
          })
        })
        return { ok: false, canceled: true, message: '已取消离线预览包导出' }
      }

      const archive = createDashboardOfflineArchive(
        spec,
        version,
        readOfflineViewerAssets()
      )
      writeFileSync(result.filePath, archive)
      recordDashboardAudit({
        dashboardId: spec.id,
        action: 'export-offline',
        status: 'success',
        format: 'offline',
        version,
        metadata: specAuditMetadata(spec, {
          componentCount: spec.components.length,
          dataMode: 'snapshot',
          byteSize: archive.byteLength,
          networkAccess: 'none'
        })
      })
      return { ok: true, path: result.filePath, message: '离线预览包已导出，解压后打开 index.html 即可预览' }
    } catch (error) {
      recordDashboardAudit({
        dashboardId: spec?.id,
        action: 'export-offline',
        status: 'failed',
        format: 'offline',
        version,
        metadata: specAuditMetadata(spec, { dataMode: 'snapshot' }),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle('dashboards:export-pdf', async (_event, spec: DashboardSpec, version?: number) => {
    try {
      const errors = validateDashboardSpec(spec, new QueryEngine(db))
      if (errors.length) throw new Error(`导出前校验失败：${errors.join('；')}`)
      if (!mainWindow) throw new Error('主窗口尚未就绪')
      const safeTitle = spec.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 80)
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出大屏 PDF',
        defaultPath: `${safeTitle || 'dashboard'}.pdf`,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          dashboardId: spec.id,
          action: 'export-pdf',
          status: 'canceled',
          format: 'pdf',
          version,
          metadata: specAuditMetadata(spec, { componentCount: spec.components.length })
        })
        return { ok: false, canceled: true, message: '已取消导出' }
      }
      const pdf = await mainWindow.webContents.printToPDF({
        landscape: true,
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'none' }
      })
      writeFileSync(result.filePath, pdf)
      recordDashboardAudit({
        dashboardId: spec.id,
        action: 'export-pdf',
        status: 'success',
        format: 'pdf',
        version,
        metadata: specAuditMetadata(spec, { componentCount: spec.components.length })
      })
      return { ok: true, path: result.filePath, message: '大屏 PDF 已导出' }
    } catch (error) {
      recordDashboardAudit({
        dashboardId: spec?.id,
        action: 'export-pdf',
        status: 'failed',
        format: 'pdf',
        version,
        metadata: specAuditMetadata(spec),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })
  ipcMain.handle('dashboards:export-png', async (
    _event,
    spec: DashboardSpec,
    dataUrl: string,
    version?: number
  ) => {
    try {
      const errors = validateDashboardSpec(spec, new QueryEngine(db))
      if (errors.length) throw new Error(`导出前校验失败：${errors.join('；')}`)
      const prefix = 'data:image/png;base64,'
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix)) {
        throw new Error('PNG 数据格式无效')
      }
      const image = Buffer.from(dataUrl.slice(prefix.length), 'base64')
      if (!image.length || image.length > 50 * 1024 * 1024) {
        throw new Error('PNG 文件为空或超过 50 MB 限制')
      }
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      if (image.length < pngSignature.length || !image.subarray(0, 8).equals(pngSignature)) {
        throw new Error('PNG 文件签名无效')
      }
      if (!mainWindow) throw new Error('主窗口尚未就绪')
      const safeTitle = spec.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').slice(0, 80)
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出大屏 PNG',
        defaultPath: `${safeTitle || 'dashboard'}.png`,
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          dashboardId: spec.id,
          action: 'export-png',
          status: 'canceled',
          format: 'png',
          version,
          metadata: specAuditMetadata(spec, { componentCount: spec.components.length })
        })
        return { ok: false, canceled: true, message: '已取消导出' }
      }
      writeFileSync(result.filePath, image)
      recordDashboardAudit({
        dashboardId: spec.id,
        action: 'export-png',
        status: 'success',
        format: 'png',
        version,
        metadata: specAuditMetadata(spec, { componentCount: spec.components.length, byteSize: image.length })
      })
      return { ok: true, path: result.filePath, message: '大屏 PNG 已导出' }
    } catch (error) {
      recordDashboardAudit({
        dashboardId: spec?.id,
        action: 'export-png',
        status: 'failed',
        format: 'png',
        version,
        metadata: specAuditMetadata(spec),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })

  ipcMain.handle('data:export', async (_event, input?: unknown) => {
    let query: RecordExportQuery | undefined
    try {
      query = normalizeDataExportQuery(input)
      if (!mainWindow || mainWindow.isDestroyed()) {
        return {
          ok: false,
          recordCount: 0,
          message: '主窗口不可用，无法导出数据'
        }
      }
      const result = await dialog.showSaveDialog(mainWindow, {
        title: '导出 VISSLM 资源包',
        defaultPath: `visslm-data-${new Date().toISOString().slice(0, 10)}.visslmpack`,
        filters: [{ name: 'VISSLM 二进制资源包', extensions: ['visslmpack'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          action: 'export-data',
          status: 'canceled',
          format: 'visslmpack',
          metadata: exportAuditMetadata(query, 0)
        })
        return { ok: false, canceled: true, recordCount: 0, message: '已取消导出' }
      }
      const exported = await recordIndexLock.runExclusive(async () => {
        // Freeze the complete matching UID set while the index lock prevents
        // concurrent sync/import changes.  The set is passed to the pack
        // iterator, never as a page-limited SQLite IN clause.
        const frozenRecordUids = query
          ? new Set(db.listRecordUids(query, requirementSemanticizationService.context()))
          : undefined
        return exportVisslmPack(db, result.filePath, frozenRecordUids)
      })
      recordDashboardAudit({
        action: 'export-data',
        status: 'success',
        format: 'visslmpack',
        metadata: {
          ...exportAuditMetadata(query, exported.recordCount),
          assetCount: exported.assetCount ?? 0,
          assetBytes: exported.assetBytes ?? 0
        }
      })
      return exported
    } catch (error) {
      recordDashboardAudit({
        action: 'export-data',
        status: 'failed',
        format: 'visslmpack',
        metadata: exportAuditMetadata(query, 0),
        errorMessage: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  })

  ipcMain.handle('data:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '导入数据',
      properties: ['openFile'],
      filters: [
        { name: 'VISSLM 资源包或数据', extensions: ['visslmpack', 'jsonl', 'json'] }
      ]
    })
    if (result.canceled || !result.filePaths[0]) {
      return {
        ok: false,
        canceled: true,
        recordCount: 0,
        imageCount: 0,
        skippedCount: 0,
        errors: [],
        duplicates: [],
        message: '已取消导入'
      }
    }

    const filePath = result.filePaths[0]
    const extension = filePath.toLowerCase().slice(filePath.lastIndexOf('.'))
    const maxImportBytes = extension === '.visslmpack' ? 1024 * 1024 * 1024 : 512 * 1024 * 1024
    const importStats = statSync(filePath)
    if (importStats.size > maxImportBytes) {
      throw new Error(extension === '.visslmpack' ? '资源包不能超过 1 GB' : '导入文件不能超过 512 MB')
    }
    if (extension === '.visslmpack') {
      return recordIndexLock.runExclusive(async () => {
        const imported = await importVisslmPack(db, filePath)
        await knowledgeService.syncRecordIndexInLock()
        projectManagementService.markMatchesStale()
        imported.path = filePath
        imported.message = `${imported.message}，资源包校验通过`
        return imported
      })
    }
    const importFormat = extension === '.json' ? 'json' : 'jsonl'
    if (legacyDataImportRunning) throw new Error('已有旧 JSON/JSONL 导入任务正在运行')
    const importRunId = db.startDataImportRun(filePath, importFormat, importStats.size, importStats.mtimeMs)
    return runLegacyDataImport(filePath, importFormat, importRunId)
  })

  ipcMain.handle('data:import-runs', (_event, limit?: number) =>
    db.listDataImportRuns(limit)
  )
  ipcMain.handle('data:import-run', (_event, id: string) =>
    db.getDataImportRun(typeof id === 'string' ? id : '')
  )
  ipcMain.handle('data:import-resume', async (_event, id: string) => {
    if (legacyDataImportRunning) throw new Error('已有旧 JSON/JSONL 导入任务正在运行')
    const normalizedId = typeof id === 'string' ? id.trim() : ''
    const snapshot = db.getDataImportRun(normalizedId)
    if (!snapshot) throw new Error('导入运行记录不存在')
    if (snapshot.status !== 'failed') throw new Error('只有已中断的旧 JSON/JSONL 导入可以继续')
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(snapshot.path)
    } catch {
      throw new Error('原导入文件已不存在，无法继续')
    }
    if (!stats.isFile()) throw new Error('原导入路径不是文件，无法继续')
    if (stats.size > 512 * 1024 * 1024) throw new Error('导入文件不能超过 512 MB')
    if (snapshot.fileSize <= 0 || snapshot.fileMtimeMs <= 0) {
      throw new Error('该运行缺少源文件指纹，请重新导入以建立安全检查点')
    }
    if (
      stats.size !== snapshot.fileSize ||
      Math.trunc(stats.mtimeMs) !== snapshot.fileMtimeMs
    ) {
      throw new Error('原导入文件大小或修改时间已变化，请重新导入以避免跳过错误内容')
    }
    const resumed = db.resumeDataImportRun(snapshot.id)
    if (!resumed || resumed.status !== 'running') throw new Error('导入运行已被其他操作继续')
    return runLegacyDataImport(resumed.path, resumed.format, resumed.id, resumed)
  })

  ipcMain.handle('data:delete', async (_event, uids?: string[]) => {
    return recordIndexLock.runExclusive(async () => {
      const result = db.deleteData(uids)
      await knowledgeService.syncRecordIndexInLock()
      projectManagementService.markMatchesStale()
      return result
    })
  })
  ipcMain.handle('knowledge:documents', (_event, query: KnowledgeDocumentQuery) =>
    db.listKnowledgeDocuments(query)
  )
  ipcMain.handle('knowledge:document', (_event, id: string) => db.getKnowledgeDocument(id))
  ipcMain.handle('knowledge:document-preview', async (_event, id: string): Promise<KnowledgeDocumentPreview | null> => {
    const document = db.getKnowledgeDocument(id)
    if (!document) return null
    const extension = document.extension.trim().toLocaleLowerCase()
    if (!sourcePreviewExtensions.has(extension)) return { document }
    try {
      const stats = statSync(document.filePath)
      if (!stats.isFile()) return { document, errorMessage: '知识库源文件不可用，请重新上传知识库文档' }
      if (stats.size === 0) return { document, errorMessage: '知识库源文件为空，请重新上传知识库文档' }
      if (stats.size > maxKnowledgeDocumentPreviewBytes) {
        return { document, errorMessage: '知识库源文件超过 50 MB，暂不支持在线预览' }
      }
      if (extension === '.docx') {
        const wordRenderedPdf = await renderDocxSourceWithWord(document)
        if (wordRenderedPdf) {
          const preview = createPreviewUrl(wordRenderedPdf, 'application/pdf')
          return {
            document,
            contentUrl: preview.url,
            contentByteSize: preview.byteSize,
            renderFormat: 'pdf'
          }
        }
        const preview = createPreviewUrl(
          document.filePath,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        )
        return {
          document,
          contentUrl: preview.url,
          contentByteSize: preview.byteSize,
          renderFormat: 'docx'
        }
      }
      const mimeType = sourcePreviewMimeTypes[extension]
      const renderFormat = sourcePreviewRenderFormats[extension]
      if (!mimeType || !renderFormat) {
        return { document, errorMessage: '该文档格式暂不支持在线预览' }
      }
      const preview = createPreviewUrl(document.filePath, mimeType)
      return {
        document,
        contentUrl: preview.url,
        contentByteSize: preview.byteSize,
        renderFormat
      }
    } catch {
      return { document, errorMessage: '知识库源文件不可用，请重新上传知识库文档' }
    }
  })
  ipcMain.handle('knowledge:upload', async () => {
    if (isolatedE2EKnowledgeFiles.length) {
      return knowledgeService.processFiles(isolatedE2EKnowledgeFiles)
    }
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '上传知识库文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{
        name: '知识库文档',
        extensions: ['docx', 'pdf', 'xlsx', 'xls', 'txt']
      }]
    })
    if (result.canceled || !result.filePaths.length) {
      return {
        ok: false,
        canceled: true,
        acceptedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        documents: [],
        skipped: [],
        message: '已取消上传'
      }
    }
    return knowledgeService.processFiles(result.filePaths)
  })
  ipcMain.handle('knowledge:retry', (_event, id: string) => knowledgeService.retryDocument(id))
  ipcMain.handle('knowledge:tags', (_event, id: string, tags: string[]) =>
    knowledgeService.updateDocumentTags(id, tags)
  )
  ipcMain.handle('knowledge:delete', (_event, id: string) => knowledgeService.deleteDocument(id))
  ipcMain.handle('knowledge:rebuild', () => knowledgeService.rebuildIndex())
  ipcMain.handle('knowledge:cancel', (_event, taskId: string) => knowledgeService.cancelTask(taskId))
  ipcMain.handle('knowledge:stats', () => db.getKnowledgeStats(knowledgeService.modelVersion))
  ipcMain.handle('projects:list', (_event, query: ManagedProjectListQuery) =>
    projectManagementService.listProjects(query)
  )
  ipcMain.handle('projects:get', (_event, id: string) => projectManagementService.getProject(id))
  ipcMain.handle('projects:documents', (_event, id: string) => projectManagementService.listProjectDocuments(id))
  ipcMain.handle('projects:analysis-logs', (_event, id: string, limit?: number) =>
    projectManagementService.listAnalysisLogs(id, limit)
  )
  ipcMain.handle('projects:create', (_event, input: ManagedProjectInput) =>
    projectManagementService.createProject(input)
  )
  ipcMain.handle('projects:update', (_event, id: string, input: ManagedProjectInput) =>
    projectManagementService.updateProject(id, input)
  )
  ipcMain.handle('projects:delete', (_event, id: string) => projectManagementService.deleteProject(id))
  ipcMain.handle('projects:export-data', async (_event, id: string) => {
    try {
      const snapshot = projectManagementService.exportProjectData(id)
      if (!snapshot) return { ok: false, message: '项目不存在，无法导出' }
      const safeName = snapshot.project.projectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '项目'
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出项目完整数据',
        defaultPath: `${safeName}-项目数据.json`,
        filters: [{ name: 'VISSLM 项目数据', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true, message: '已取消导出' }
      }
      writeFileSync(result.filePath, JSON.stringify(snapshot, null, 2), 'utf8')
      return {
        ok: true,
        path: result.filePath,
        projectId: snapshot.project.id,
        message: '项目完整数据已导出'
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('projects:export-excel', async (_event, id: string) => {
    try {
      const snapshot = projectManagementService.exportProjectData(id)
      if (!snapshot) return { ok: false, message: '项目不存在，无法导出' }
      const safeName = snapshot.project.projectName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || '项目'
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出项目 Excel',
        defaultPath: `${safeName}-项目数据.xlsx`,
        filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }]
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true, message: '已取消导出' }
      }
      const workbook = createProjectWorkbook(snapshot)
      const output = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'buffer',
        compression: true
      })
      writeFileSync(result.filePath, output)
      return {
        ok: true,
        path: result.filePath,
        projectId: snapshot.project.id,
        message: '项目 Excel 已导出'
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('projects:import-data', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '导入项目完整数据',
        properties: ['openFile'],
        filters: [{ name: 'VISSLM 项目数据', extensions: ['json'] }]
      })
      if (result.canceled || !result.filePaths[0]) {
        return { ok: false, canceled: true, message: '已取消导入' }
      }
      const filePath = result.filePaths[0]
      if (statSync(filePath).size > 512 * 1024 * 1024) {
        return { ok: false, message: '项目数据文件不能超过 512 MB' }
      }
      const content = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim()
      if (!content) return { ok: false, message: '项目数据文件为空' }
      const payload = JSON.parse(content) as unknown
      return projectManagementService.importProjectData(payload)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('projects:discard-draft', (_event, id: string) =>
    projectManagementService.discardProjectDraft(id)
  )
  ipcMain.handle('projects:confirm', (_event, id: string) => projectManagementService.confirmProject(id))
  ipcMain.handle('projects:upload-agreement', async (_event, projectId?: string, options?: ProjectAgreementUploadOptions) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: projectId ? '上传技术协议' : '通过技术协议创建项目',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '技术协议', extensions: ['docx', 'pdf', 'xlsx', 'xls', 'txt'] }]
    })
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true, message: '已取消上传' }
    }
    return projectManagementService.startTechnicalAgreement(result.filePaths, projectId, options)
  })
  ipcMain.handle('projects:retry-analysis', (_event, id: string) => projectManagementService.retryAnalysis(id))
  ipcMain.handle('projects:start-matching', (_event, id: string) => projectManagementService.startMatching(id))
  ipcMain.handle('projects:requirements', (_event, query: ProjectRequirementQuery) =>
    projectManagementService.listRequirements(query)
  )
  ipcMain.handle('projects:requirements-all', (_event, projectId: string) =>
    projectManagementService.listAllRequirements(projectId)
  )
  ipcMain.handle('projects:requirement', (_event, id: string) =>
    projectManagementService.getRequirement(id)
  )
  ipcMain.handle('projects:requirement-set', (_event, projectId: string) =>
    projectManagementService.getRequirementSet(projectId)
  )
  ipcMain.handle('projects:requirement-create', (_event, projectId: string, input: ProjectRequirementInput) =>
    projectManagementService.createRequirement(projectId, input)
  )
  ipcMain.handle('projects:requirement-update', (_event, id: string, input: ProjectRequirementInput) =>
    projectManagementService.updateRequirement(id, input)
  )
  ipcMain.handle('projects:requirement-split', (_event, id: string, input: ProjectRequirementSplitInput) =>
    projectManagementService.splitRequirement(id, input)
  )
  ipcMain.handle('projects:requirement-merge', (_event, input: ProjectRequirementMergeInput) =>
    projectManagementService.mergeRequirements(input)
  )
  ipcMain.handle('projects:requirement-review', (_event, ids: string[], status: ProjectRequirementReviewStatus) =>
    projectManagementService.reviewRequirements(ids, status)
  )
  ipcMain.handle('projects:requirements-publish', (_event, projectId: string) =>
    projectManagementService.publishRequirements(projectId)
  )
  ipcMain.handle('projects:requirement-delete', (_event, id: string) =>
    projectManagementService.deleteRequirement(id)
  )
  ipcMain.handle('projects:requirement-status', (_event, id: string, status: ProjectRequirementStatus) =>
    projectManagementService.updateRequirementStatus(id, status)
  )
  ipcMain.handle('projects:requirement-key-info-terms', (_event, id: string, terms: string[]) =>
    projectManagementService.updateRequirementKeyInfoTerms(id, terms)
  )
  ipcMain.handle('projects:start-requirement-matching', (_event, id: string) =>
    projectManagementService.startRequirementMatching(id)
  )
  ipcMain.handle('projects:matches', (_event, query: ProjectRequirementMatchQuery) =>
    projectManagementService.listMatches(query)
  )
  ipcMain.handle('projects:costs', (_event, projectId: string) => projectManagementService.listCostEntries(projectId))
  ipcMain.handle('projects:cost-add', (_event, projectId: string, input: ProjectCostEntryInput) =>
    projectManagementService.addCostEntry(projectId, input)
  )
  ipcMain.handle('projects:cost-update', (_event, id: string, input: ProjectCostEntryInput) =>
    projectManagementService.updateCostEntry(id, input)
  )
  ipcMain.handle('projects:cost-delete', (_event, id: string) => projectManagementService.deleteCostEntry(id))
  ipcMain.handle('projects:assets', (_event, projectId: string) => projectManagementService.listAssets(projectId))
  ipcMain.handle('projects:asset-link', (_event, projectId: string, recordUid: string, requirementId?: string) =>
    projectManagementService.linkAsset(projectId, recordUid, requirementId)
  )
  ipcMain.handle('projects:asset-unlink', (_event, projectId: string, recordUid: string) =>
    projectManagementService.unlinkAsset(projectId, recordUid)
  )
  ipcMain.handle('projects:asset-requirement-unlink', (_event, projectId: string, recordUid: string, requirementId: string) =>
    projectManagementService.unlinkAssetRequirement(projectId, recordUid, requirementId)
  )
  ipcMain.handle('organization:people', (_event, query: OrganizationPersonListQuery) =>
    projectManagementService.listOrganizationPeople(query)
  )
  ipcMain.handle('organization:person-create', (_event, input: OrganizationPersonInput) =>
    projectManagementService.createOrganizationPerson(input)
  )
  ipcMain.handle('organization:person-update', (_event, id: string, input: OrganizationPersonInput) =>
    projectManagementService.updateOrganizationPerson(id, input)
  )
  ipcMain.handle('organization:person-delete', (_event, id: string) =>
    projectManagementService.deleteOrganizationPerson(id)
  )
  ipcMain.handle('projects:participants', (_event, projectId: string) =>
    projectManagementService.listProjectParticipants(projectId)
  )
  ipcMain.handle('projects:participant-add', (_event, projectId: string, input: ProjectParticipantInput) =>
    projectManagementService.addProjectParticipant(projectId, input)
  )
  ipcMain.handle('projects:participant-update', (_event, id: string, input: ProjectParticipantInput) =>
    projectManagementService.updateProjectParticipant(id, input)
  )
  ipcMain.handle('projects:participant-delete', (_event, id: string) =>
    projectManagementService.deleteProjectParticipant(id)
  )
  ipcMain.handle('projects:tasks', (_event, projectId: string) =>
    projectManagementService.listProjectTasks(projectId)
  )
  ipcMain.handle('projects:task-add', (_event, projectId: string, input: ProjectPlanTaskInput) =>
    projectManagementService.addProjectTask(projectId, input)
  )
  ipcMain.handle('projects:task-update', (_event, id: string, input: ProjectPlanTaskInput) =>
    projectManagementService.updateProjectTask(id, input)
  )
  ipcMain.handle('projects:task-move', (_event, id: string, input: ProjectPlanTaskMoveInput) =>
    projectManagementService.moveProjectTask(id, input)
  )
  ipcMain.handle('projects:task-delete', (_event, id: string) =>
    projectManagementService.deleteProjectTask(id)
  )
  ipcMain.handle('push:preview', (_event, config: PushConfig) => pushService.preview(config))
  ipcMain.handle('push:start', (_event, config: PushConfig) => pushService.push(config))
  ipcMain.handle('push:logs', (_event, page?: number, pageSize?: number) =>
    db.listPushLogs(page, pageSize)
  )
}

// Visual smoke tests run an unpackaged build against an isolated user-data
// directory while the installed application may remain open.  Keep the
// production single-instance guarantee, but allow that explicit test-only
// process to coexist without interrupting the user's active app.
const hasSingleInstanceLock = isolatedE2EMode || app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    const systemVersion = process.platform === 'win32' ? process.getSystemVersion() : ''
    if (process.platform === 'win32' && isUnsupportedWindowsVersion(systemVersion)) {
      const message = unsupportedWindowsMessage(systemVersion)
      console.error(`[startup] ${message}`)
      dialog.showErrorBox('VISSLM Agent 无法启动', message)
      app.quit()
      return
    }

    // Paint a native startup page before synchronous database migrations.  A
    // large legacy asset store can otherwise keep the process busy with no
    // visible window for several minutes.
    createWindow({ loadRenderer: false })
    setTimeout(() => {
      if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return
      try {
      const dataDir = app.getPath('userData')
      mkdirSync(dataDir, { recursive: true })
      db = new AppDatabase(join(dataDir, 'visslm-agent.db'), join(dataDir, 'assets'))
      protocol.handle('visslm-preview', async (request) => {
      try {
        prunePreviewFiles()
        const token = new URL(request.url).hostname.trim()
        const entry = previewFiles.get(token)
        if (!entry || entry.expiresAt <= Date.now()) {
          previewFiles.delete(token)
          return new Response('Not Found', { status: 404 })
        }
        const stats = statSync(entry.filePath)
        if (!stats.isFile() || stats.size !== entry.byteSize) {
          previewFiles.delete(token)
          return new Response('Not Found', { status: 404 })
        }
        const stream = Readable.toWeb(createReadStream(entry.filePath)) as unknown as BodyInit
        return new Response(stream, {
          headers: {
            'content-type': entry.mimeType,
            'content-length': String(entry.byteSize),
            'cache-control': 'private, max-age=60'
          }
        })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    })
      protocol.handle('visslm-asset', async (request) => {
      try {
        const url = new URL(request.url)
        const sha256 = url.hostname.trim().toLowerCase()
        if (!/^[a-f0-9]{64}$/.test(sha256)) return new Response('Not Found', { status: 404 })
        const blob = db.getAssetBlob(sha256)
        if (!blob) return new Response('Not Found', { status: 404 })
        const fileStats = statSync(blob.filePath)
        if (!fileStats.isFile() || fileStats.size !== blob.byteSize) {
          return new Response('Not Found', { status: 404 })
        }
        const stream = Readable.toWeb(createReadStream(blob.filePath)) as unknown as BodyInit
        return new Response(stream, {
          headers: {
            'content-type': blob.mimeType,
            'content-length': String(blob.byteSize),
            'cache-control': 'private, max-age=31536000, immutable'
          }
        })
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    })
      recordIndexLock = new AsyncMutex()
      settings = new SettingsService(db)
      requirementSemanticizationService = new RequirementSemanticizationService(
      db,
      () => settings.getModelCredentials(),
      (progress) => mainWindow?.webContents.send('requirements:semanticization-progress', progress)
    )
      knowledgeService = new KnowledgeService(
      db,
      (progress) => mainWindow?.webContents.send('knowledge:progress', progress),
      recordIndexLock
    )
      projectManagementService = new ProjectManagementService(
      db,
      knowledgeService,
      () => settings.getModelCredentials(),
      (progress) => mainWindow?.webContents.send('project:progress', progress),
      () => settings.getAll().projectMatching
    )
      recordMaintenanceService = new RecordMaintenanceService(
      db,
      knowledgeService,
      recordIndexLock,
      (snapshot) => mainWindow?.webContents.send('data:maintenance-progress', snapshot),
      () => projectManagementService.markMatchesStale()
    )
      syncService = new SyncService(
      db,
      () => new VisslmClient(settings.getPlatformCredentials()),
      (progress: SyncProgress) => mainWindow?.webContents.send('sync:progress', progress)
    )
      pushService = new PushService(
      db,
      () => new VisslmClient(settings.getPlatformCredentials())
    )
      registerIpc()
      backendReady = true
      loadRendererPage()
      void initializeUpdateManager()

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow(backendReady ? {} : { loadRenderer: false })
        }
      })
    } catch (error) {
      const message = updateErrorMessage(error)
      console.error(`[startup] ${message}`, error)
      dialog.showErrorBox(
        'VISSLM Agent 启动失败',
        `应用初始化失败：${message}\n\n请重启应用；如果问题持续，请保留此错误信息。`
      )
      app.quit()
      }
    }, 100)
  }).catch((error: unknown) => {
    const message = updateErrorMessage(error)
    console.error(`[startup] ${message}`, error)
    dialog.showErrorBox(
      'VISSLM Agent 启动失败',
      `应用窗口无法创建：${message}\n\n请重启应用；如果问题持续，请保留此错误信息。`
    )
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    assistantRunRegistry.abortAll()
    assistantPlanConfirmation.clearAll()
    cancelKnowledgeInitialization()
    knowledgeService?.cancelAllTasks()
    previewFiles.clear()
    db?.close()
  })
}
