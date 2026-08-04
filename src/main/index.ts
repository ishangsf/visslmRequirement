import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'
import type {
  ChatRequest,
  ChatSessionDeleteResult,
  ChatSessionSaveInput,
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
  SyncProgress,
  SyncScopeConfig
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
import { compareDashboardSpecValues } from '../shared/dashboard'
import { QueryEngine } from './analytics/query-engine'
import { AppDatabase } from './database'
import { validateDashboardSpec } from './dashboards/validator'
import { diagnoseDashboard } from './dashboards/diagnostics'
import { repairDashboardComponent } from './dashboards/component-repair'
import { dashboardSpecHash } from './dashboards/spec-hash'
import { ExpertRouter } from './experts/router'
import { VisualizationAgent } from './experts/visualization-agent'
import { resolveVisualizationRequestMode } from './experts/visualization-intent'
import { OllamaAgent } from './ollama'
import { SettingsService } from './settings'
import { PushService, SyncService, VisslmClient } from './visslm'
import { KnowledgeService } from './knowledge'
import { ProjectManagementService } from './project-management'
import { createProjectWorkbook } from './project-export'
import {
  createDashboardOfflineArchive,
  offlineViewerResourceNames,
  type DashboardOfflineViewerAssets
} from './dashboards/offline-export'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
let mainWindow: BrowserWindow | null = null
let db: AppDatabase
let settings: SettingsService
let syncService: SyncService
let pushService: PushService
let knowledgeService: KnowledgeService
let projectManagementService: ProjectManagementService
const expertRouter = new ExpertRouter()
const maxKnowledgeDocumentPreviewBytes = 50 * 1024 * 1024

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

  mainWindow.once('ready-to-show', () => mainWindow?.show())
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
  ipcMain.handle('connections:test-model', async (_event, input?: ModelSettings) => {
    const model = settings.getModelCredentials(input)
    return new OllamaAgent(db, model).test()
  })

  ipcMain.handle('data:projects', () => db.listProjects())
  ipcMain.handle('data:node-types', () => db.listNodeTypes())
  ipcMain.handle('data:records', (_event, query: RecordQuery) => db.listRecords(query))
  ipcMain.handle('data:record', (_event, uid: string) => db.getRecord(uid))
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
    const result = await syncService.run(config ?? settings.getSyncConfig() ?? undefined)
    if (result.ok) {
      await knowledgeService.syncRecordIndex()
      projectManagementService.markMatchesStale()
    }
    return result
  })
  ipcMain.handle(
    'data:apply-review',
    async (_event, input: DataReviewApplyInput) => {
      const result = input.source === 'sync'
        ? await syncService.applyDataReviews(input.batchId, input.reviewIds)
        : db.applyImportDataReviews(input.batchId, input.reviewIds)
      if (result.updatedCount > 0) {
        await knowledgeService.syncRecordIndex()
        projectManagementService.markMatchesStale()
      }
      return result
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
    const route = expertRouter.route(request)
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
    const agent = new OllamaAgent(db, settings.getModelCredentials(), knowledgeService)
    return agent.ask({ ...request, question: route.question }).then((response) => ({
      ...response,
      expertId: route.expert.id
    }))
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
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出数据 JSONL',
        defaultPath: `visslm-data-${new Date().toISOString().slice(0, 10)}.jsonl`,
        filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
      })
      if (result.canceled || !result.filePath) {
        recordDashboardAudit({
          action: 'export-data',
          status: 'canceled',
          format: 'jsonl'
        })
        return { ok: false, canceled: true, recordCount: 0, message: '已取消导出' }
      }
      const rows = db.exportRows()
      const lines = rows.map((row) => JSON.stringify(row)).join('\n')
      writeFileSync(result.filePath, lines, 'utf8')
      recordDashboardAudit({
        action: 'export-data',
        status: 'success',
        format: 'jsonl',
        metadata: { recordCount: rows.length }
      })
      return {
        ok: true,
        path: result.filePath,
        recordCount: rows.length,
        message: `已导出 ${rows.length} 条数据`
      }
    } catch (error) {
      recordDashboardAudit({
        action: 'export-data',
        status: 'failed',
        format: 'jsonl',
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
        { name: 'VISSLM 数据', extensions: ['jsonl', 'json'] }
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
    if (statSync(filePath).size > 512 * 1024 * 1024) {
      throw new Error('导入文件不能超过 512 MB')
    }
    const content = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim()
    const parseErrors: string[] = []
    let rows: unknown[] = []
    if (content) {
      if (content.startsWith('[')) {
        const parsed = JSON.parse(content) as unknown
        if (!Array.isArray(parsed)) throw new Error('JSON 文件根节点必须是数组')
        rows = parsed
      } else {
        rows = content
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .flatMap((line, index) => {
            try {
              return [JSON.parse(line) as unknown]
            } catch {
              parseErrors.push(`第 ${index + 1} 行：JSON 格式错误`)
              return []
            }
          })
      }
    }
    const imported = db.importRows(rows)
    await knowledgeService.syncRecordIndex()
    projectManagementService.markMatchesStale()
    imported.path = filePath
    imported.skippedCount += parseErrors.length
    imported.errors = [...parseErrors, ...imported.errors].slice(0, 50)
    imported.ok =
      imported.recordCount > 0 ||
      imported.duplicates.length > 0 ||
      (rows.length === 0 && !parseErrors.length)
    imported.message =
      `导入完成：${imported.recordCount} 条记录，${imported.imageCount} 张图片，` +
      `跳过 ${imported.skippedCount} 条` +
      (imported.duplicates.length
        ? `，发现 ${imported.duplicates.length} 条已有 _valm_ItemID，待审查覆盖`
        : '')
    return imported
  })

  ipcMain.handle('data:delete', async (_event, uids?: string[]) => {
    const result = db.deleteData(uids)
    await knowledgeService.syncRecordIndex()
    projectManagementService.markMatchesStale()
    return result
  })
  ipcMain.handle('knowledge:documents', (_event, query: KnowledgeDocumentQuery) =>
    db.listKnowledgeDocuments(query)
  )
  ipcMain.handle('knowledge:document', (_event, id: string) => db.getKnowledgeDocument(id))
  ipcMain.handle('knowledge:document-preview', (_event, id: string): KnowledgeDocumentPreview | null => {
    const document = db.getKnowledgeDocument(id)
    if (!document) return null
    if (document.extension !== '.pdf') return { document }
    try {
      const stats = statSync(document.filePath)
      if (!stats.isFile()) return { document, errorMessage: '原始 PDF 文件不可用，请重新上传协议附件' }
      if (stats.size === 0) return { document, errorMessage: 'PDF 文件为空，请重新上传协议附件' }
      if (stats.size > maxKnowledgeDocumentPreviewBytes) {
        return { document, errorMessage: 'PDF 文件超过 50 MB，暂不支持在线预览，请下载后查看' }
      }
      return { document, contentBase64: readFileSync(document.filePath).toString('base64') }
    } catch {
      return { document, errorMessage: '原始 PDF 文件不可用，请重新上传协议附件' }
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
    db = new AppDatabase(join(dataDir, 'visslm-agent.db'), join(dataDir, 'assets', 'base64'))
    settings = new SettingsService(db)
    knowledgeService = new KnowledgeService(
      db,
      (progress) => mainWindow?.webContents.send('knowledge:progress', progress)
    )
    projectManagementService = new ProjectManagementService(
      db,
      knowledgeService,
      () => settings.getModelCredentials(),
      (progress) => mainWindow?.webContents.send('project:progress', progress),
      () => settings.getAll().projectMatching
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
    void knowledgeService.initialize().catch((error) => {
      console.error('[knowledge] initialization failed', error)
    })
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    db?.close()
  })
}
