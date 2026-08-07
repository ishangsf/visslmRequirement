import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

const supportedPlatforms = new Set<NodeJS.Platform>(['win32', 'darwin'])

const normalizeReleaseNotes = (notes: unknown): string | undefined => {
  if (typeof notes === 'string') return notes.trim() || undefined
  if (!Array.isArray(notes)) return undefined

  const normalized = notes
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'note' in entry) {
        return String(entry.note ?? '')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

  return normalized || undefined
}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  return String(error || '未知错误')
}

const clampPercent = (value: number): number =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))

export class UpdateManager {
  private window: BrowserWindow | null = null
  private checkTask: Promise<void> | null = null
  private downloadTask: Promise<void> | null = null
  private status: UpdateStatus = {
    phase: 'idle',
    currentVersion: app.getVersion()
  }

  constructor() {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      this.publish({
        phase: 'checking',
        currentVersion: app.getVersion()
      })
    })

    autoUpdater.on('update-available', (info) => {
      this.publish({
        phase: 'available',
        currentVersion: app.getVersion(),
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes)
      })
    })

    autoUpdater.on('update-not-available', () => {
      this.publish({
        phase: 'not-available',
        currentVersion: app.getVersion(),
        checkedAt: new Date().toISOString()
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      const version = this.status.version
      if (!version) return
      this.publish({
        phase: 'downloading',
        currentVersion: app.getVersion(),
        version,
        releaseDate: this.status.releaseDate,
        releaseNotes: this.status.releaseNotes,
        percent: clampPercent(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      this.publish({
        phase: 'downloaded',
        currentVersion: app.getVersion(),
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes)
      })
    })

    autoUpdater.on('error', (error) => {
      this.publish({
        phase: 'error',
        currentVersion: app.getVersion(),
        message: errorMessage(error)
      })
    })
  }

  attachWindow(window: BrowserWindow | null): void {
    this.window = window
    this.emit(this.status)
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.isSupported()) return this.publish(this.unsupportedStatus())
    if (this.checkTask) {
      await this.checkTask
      return this.getStatus()
    }

    this.publish({
      phase: 'checking',
      currentVersion: app.getVersion()
    })

    const task = (async (): Promise<void> => {
      try {
        const result = await autoUpdater.checkForUpdates()
        if (this.status.phase !== 'checking') return

        const updateInfo = result?.updateInfo
        if (updateInfo && updateInfo.version !== app.getVersion()) {
          this.publish({
            phase: 'available',
            currentVersion: app.getVersion(),
            version: updateInfo.version,
            releaseDate: updateInfo.releaseDate,
            releaseNotes: normalizeReleaseNotes(updateInfo.releaseNotes)
          })
          return
        }

        this.publish({
          phase: 'not-available',
          currentVersion: app.getVersion(),
          checkedAt: new Date().toISOString()
        })
      } catch (error) {
        this.publish({
          phase: 'error',
          currentVersion: app.getVersion(),
          message: errorMessage(error)
        })
      }
    })()

    this.checkTask = task
    await task
    if (this.checkTask === task) this.checkTask = null
    return this.getStatus()
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (!this.isSupported()) return this.publish(this.unsupportedStatus())
    if (this.status.phase === 'downloaded') return this.getStatus()
    if (this.downloadTask) {
      await this.downloadTask
      return this.getStatus()
    }

    const version = this.status.version
    if (this.status.phase !== 'available' || !version) {
      return this.publish({
        phase: 'error',
        currentVersion: app.getVersion(),
        message: '请先检查更新，确认有可用版本后再下载'
      })
    }

    this.publish({
      phase: 'downloading',
      currentVersion: app.getVersion(),
      version,
      releaseDate: this.status.releaseDate,
      releaseNotes: this.status.releaseNotes,
      percent: 0,
      bytesPerSecond: 0,
      transferred: 0,
      total: 0
    })

    const task = (async (): Promise<void> => {
      try {
        await autoUpdater.downloadUpdate()
        if (this.status.phase === 'downloading') {
          this.publish({
            phase: 'downloaded',
            currentVersion: app.getVersion(),
            version,
            releaseDate: this.status.releaseDate,
            releaseNotes: this.status.releaseNotes
          })
        }
      } catch (error) {
        this.publish({
          phase: 'error',
          currentVersion: app.getVersion(),
          version,
          message: errorMessage(error)
        })
      }
    })()

    this.downloadTask = task
    await task
    if (this.downloadTask === task) this.downloadTask = null
    return this.getStatus()
  }

  installUpdate(): void {
    if (!this.isSupported() || this.status.phase !== 'downloaded') return

    this.publish({
      phase: 'installing',
      currentVersion: app.getVersion(),
      version: this.status.version,
      releaseDate: this.status.releaseDate,
      releaseNotes: this.status.releaseNotes
    })
    autoUpdater.quitAndInstall(false, true)
  }

  private isSupported(): boolean {
    return app.isPackaged && supportedPlatforms.has(process.platform)
  }

  private unsupportedStatus(): UpdateStatus {
    return {
      phase: 'unsupported',
      currentVersion: app.getVersion(),
      message: app.isPackaged
        ? '当前平台暂不支持在线更新'
        : '开发模式不执行在线更新，请使用打包安装版'
    }
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status
    this.emit(status)
    return this.getStatus()
  }

  private emit(status: UpdateStatus): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send('update:status', status)
  }
}
