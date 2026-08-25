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
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import * as XLSX from 'xlsx'
import type {
  ChatRequest,
  ChatSessionDeleteResult,
  ChatSessionSaveInput,
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
import type { AgentEvent } from '../shared/expert-types'
import { compareDashboardSpecValues } from '../shared/dashboard'
import { QueryEngine } from './analytics/query-engine'
import { AppDatabase } from './database'
import { validateDashboardSpec } from './dashboards/validator'
import { diagnoseDashboard } from './dashboards/diagnostics'
import { repairDashboardComponent } from './dashboards/component-repair'
import { dashboardSpecHash } from './dashboards/spec-hash'
import { ExpertRouter } from './experts/router'
import { autoRequirementIds, resolveAutoChatRoute } from './experts/auto-routing'
import { RequirementAnalysisAgent } from './experts/requirement-analysis-agent'
import { RequirementSemanticizationService } from './requirements/semanticization-service'
import { VisualizationAgent } from './experts/visualization-agent'
import { resolveVisualizationRequestMode } from './experts/visualization-intent'
import { OllamaAgent } from './ollama'
import { PlainChatAgent } from './plain-chat'
import { DirectRequirementDataAnalysisAgent } from './direct-data-analysis'
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
const sourcePreviewExtensions = new Set(['.docx', '.pdf'])
const execFileAsync = promisify(execFile)
const previewUrlTtlMs = 5 * 60 * 1000
const maxPreviewUrls = 32
const previewFiles = new Map<string, { filePath: string; byteSize: number; mimeType: string; expiresAt: number }>()

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

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    show: false,
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
    console.error(`[renderer-load] ${code} ${description} ${url}`)
  })
  mainWindow.webContents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      console.error(`[renderer:${details.level}] ${details.message}`)
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
  ipcMain.handle('connections:test-model', async (_event, input?: ModelSettings, probeChat = false) => {
    const model = settings.getModelCredentials(input)
    return new OllamaAgent(db, model).test(probeChat)
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
  ipcMain.handle('agent:ask', (ipcEvent, request: ChatRequest) => {
    const autoRequirementIdsForRequest = request.chatMode === 'auto' && request.entrypoint !== 'dashboard'
      ? autoRequirementIds(request.question, request.history)
      : null
    const autoRoute = request.chatMode === 'auto' && request.entrypoint !== 'dashboard'
      ? resolveAutoChatRoute(request.question, request.history)
      : null
    const routedRequest = autoRoute === 'general'
      ? {
          ...request,
          expertId: 'general' as const,
          chatMode: 'expert' as const
        }
      : request
    const route = expertRouter.route(routedRequest)
    if (autoRequirementIdsForRequest?.length) {
      const agent = new DirectRequirementDataAnalysisAgent(db, settings.getModelCredentials())
      return agent.ask({
        ...request,
        question: request.question,
        extractedRequirementIds: autoRequirementIdsForRequest
      }).then((response) => response).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
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
        }
      })
    }
    if (request.entrypoint !== 'dashboard' && (
      request.chatMode === 'plain' ||
      (request.chatMode === 'auto' && autoRoute === 'plain')
    )) {
      const agent = new PlainChatAgent(settings.getModelCredentials())
      return agent.ask({ ...request, question: route.question }).then((response) => response).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
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
        }
      })
    }
    if (route.expert.id === 'visualization') {
      const activeArtifact = request.activeArtifact
      const focusComponentId = request.focusComponentId?.trim() || undefined
      if (activeArtifact && activeArtifact.artifactId !== activeArtifact.dashboard.id) {
        throw new Error('活动大屏标识与 DashboardSpec 不一致，无法执行修改')
      }
      if (focusComponentId && !activeArtifact) {
        throw new Error('指定组件修改需要先打开一个活动大屏')
      }
      if (focusComponentId && activeArtifact &&
          !activeArtifact.dashboard.components.some((component) => component.id === focusComponentId)) {
        throw new Error(`指定组件 ${focusComponentId} 不存在，无法执行修改`)
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
      let latestVisualizationRun: VisualizationRunInput | undefined
      const agent = new VisualizationAgent(
        queryEngine,
        settings.getModelCredentials(),
        (run) => {
          latestVisualizationRun = run
          db.recordVisualizationRun(run)
        },
        (event) => ipcEvent.sender.send('agent:event', {
          conversationId: request.conversationId,
          event
        })
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
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          if (message === '当前数据范围没有可用字段，请先采集数据') {
            return {
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
            }
          }
          if (activeArtifact && isPatchRequest) {
            const failedTool = [...(latestVisualizationRun?.toolCalls ?? [])]
              .reverse()
              .find((call) => call.status === 'failed')
            return {
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
            }
          }
          throw error
        })
    }
    if (route.expert.id === 'requirement-analysis') {
      const agent = new RequirementAnalysisAgent(
        db,
        knowledgeService,
        settings.getModelCredentials(),
        (event: Extract<AgentEvent, { type: 'status' }>) => ipcEvent.sender.send('agent:event', {
          conversationId: request.conversationId,
          event
        })
      )
      return agent.ask({ ...request, question: route.question }).then((response) => ({
        ...response,
        expertId: route.expert.id
      })).catch((error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return {
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
        }
      })
    }
    const agent = new OllamaAgent(
      db,
      settings.getModelCredentials(),
      knowledgeService,
      (event: Extract<AgentEvent, { type: 'status' }>) => ipcEvent.sender.send('agent:event', {
        conversationId: request.conversationId,
        event
      })
    )
    return agent.ask({ ...request, question: route.question }).then((response) => ({
      ...response,
      expertId: route.expert.id
    })).catch((error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
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

  ipcMain.handle('data:export', async () => {
    try {
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
          format: 'visslmpack'
        })
        return { ok: false, canceled: true, recordCount: 0, message: '已取消导出' }
      }
      const exported = await recordIndexLock.runExclusive(() =>
        exportVisslmPack(db, result.filePath)
      )
      recordDashboardAudit({
        action: 'export-data',
        status: 'success',
        format: 'visslmpack',
        metadata: {
          recordCount: exported.recordCount,
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
    if (!sourcePreviewExtensions.has(document.extension)) return { document }
    try {
      const stats = statSync(document.filePath)
      if (!stats.isFile()) return { document, errorMessage: '用户上传的源文件不可用，请重新上传协议附件' }
      if (stats.size === 0) return { document, errorMessage: '用户上传的源文件为空，请重新上传协议附件' }
      if (stats.size > maxKnowledgeDocumentPreviewBytes) {
        return { document, errorMessage: '源文件超过 50 MB，暂不支持在线预览' }
      }
      if (document.extension === '.docx') {
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
      const preview = createPreviewUrl(document.filePath, 'application/pdf')
      return {
        document,
        contentUrl: preview.url,
        contentByteSize: preview.byteSize,
        renderFormat: 'pdf'
      }
    } catch {
      return { document, errorMessage: '用户上传的源文件不可用，请重新上传协议附件' }
    }
  })
  ipcMain.handle('knowledge:upload', async () => {
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

const hasSingleInstanceLock = app.requestSingleInstanceLock()

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
    createWindow()
    void initializeUpdateManager()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    isQuitting = true
    cancelKnowledgeInitialization()
    knowledgeService?.cancelAllTasks()
    previewFiles.clear()
    db?.close()
  })
}
