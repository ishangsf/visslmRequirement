import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ChatRequest,
  ModelSettings,
  PlatformSettingsInput,
  PushConfig,
  RecordQuery,
  SyncProgress,
  SyncScopeConfig
} from '../shared/types'
import { AppDatabase } from './database'
import { OllamaAgent } from './ollama'
import { SettingsService } from './settings'
import { PushService, SyncService, VisslmClient } from './visslm'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
let mainWindow: BrowserWindow | null = null
let db: AppDatabase
let settings: SettingsService
let syncService: SyncService
let pushService: PushService

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
  ipcMain.handle('settings:save-model', (_event, input: ModelSettings) =>
    settings.saveModel(input)
  )

  ipcMain.handle(
    'connections:test-platform',
    async (_event, input?: PlatformSettingsInput) =>
      new VisslmClient(settings.getPlatformCredentials(input)).test()
  )
  ipcMain.handle('connections:test-model', async (_event, input?: ModelSettings) => {
    const model = input ?? settings.getAll().model
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
  ipcMain.handle('sync:start', (_event, config?: SyncScopeConfig) => {
    if (config) settings.saveSyncConfig(config)
    return syncService.run(config ?? settings.getSyncConfig() ?? undefined)
  })
  ipcMain.handle('sync:request-logs', (_event, page?: number, pageSize?: number) =>
    db.listCollectionRequestLogs(page, pageSize)
  )
  ipcMain.handle('agent:ask', (_event, request: ChatRequest) => {
    const agent = new OllamaAgent(db, settings.getAll().model)
    return agent.ask(request)
  })

  ipcMain.handle('data:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: '导出数据 JSONL',
      defaultPath: `visslm-data-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, recordCount: 0, message: '已取消导出' }
    }
    const rows = db.exportRows()
    const lines = rows.map((row) => JSON.stringify(row)).join('\n')
    writeFileSync(result.filePath, lines, 'utf8')
    return {
      ok: true,
      path: result.filePath,
      recordCount: rows.length,
      message: `已导出 ${rows.length} 条数据`
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
    imported.path = filePath
    imported.skippedCount += parseErrors.length
    imported.errors = [...parseErrors, ...imported.errors].slice(0, 50)
    imported.ok = imported.recordCount > 0 || (rows.length === 0 && !parseErrors.length)
    imported.message =
      `导入完成：${imported.recordCount} 条记录，${imported.imageCount} 张图片，` +
      `跳过 ${imported.skippedCount} 条`
    return imported
  })

  ipcMain.handle('data:delete', (_event, uids?: string[]) => db.deleteData(uids))
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
