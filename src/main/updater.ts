import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

const { autoUpdater } = electronUpdater

const supportedPlatforms = new Set<NodeJS.Platform>(['win32', 'darwin'])

const decodeReleaseNoteEntities = (value: string): string => value
  .replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi,
    (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&#39;': "'",
      '&#x27;': "'",
      '&nbsp;': ' '
    }[entity.toLowerCase()] ?? entity)
  )
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (_entity, code: string) => {
    const number = code.toLowerCase().startsWith('x')
      ? Number.parseInt(code.slice(1), 16)
      : Number.parseInt(code, 10)
    return Number.isFinite(number) && number >= 0 && number <= 0x10ffff
      ? String.fromCodePoint(number)
      : ''
  })

const normalizeReleaseNoteText = (value: string): string => {
  const source = /&lt;\s*\/?\s*(?:h[1-6]|ul|ol|li|p|div|br)\b/i.test(value)
    ? decodeReleaseNoteEntities(value)
    : value
  const withLineBreaks = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(/<\s*\/\s*li\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(?:p|div|h[1-6]|ul|ol|blockquote|pre|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')

  return decodeReleaseNoteEntities(withLineBreaks)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const normalizeReleaseNotes = (notes: unknown): string | undefined => {
  const entries = typeof notes === 'string'
    ? [notes]
    : Array.isArray(notes)
      ? notes.map((entry) => {
          if (typeof entry === 'string') return entry
          if (entry && typeof entry === 'object' && 'note' in entry) {
            return String(entry.note ?? '')
          }
          return ''
        })
      : []
  const normalized = entries
    .map(normalizeReleaseNoteText)
    .filter(Boolean)
    .join('\n\n')

  return normalized || undefined
}

type UpdateOperation = 'check' | 'download'

const asErrorRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined

const toStatusCode = (value: unknown): number | undefined => {
  const statusCode =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{3}$/.test(value)
        ? Number(value)
        : undefined

  return statusCode !== undefined && statusCode >= 100 && statusCode <= 599
    ? statusCode
    : undefined
}

const statusCodeFromText = (value: string): number | undefined => {
  const match = value.match(/(?:^|\b(?:status|http|response|error|code))\D*([45]\d{2})\b/i)
  return match ? Number(match[1]) : undefined
}

const normalizeUpdaterError = (error: unknown, operation: UpdateOperation): string => {
  const record = asErrorRecord(error)
  const response = asErrorRecord(record?.response)
  const code = typeof record?.code === 'string' ? record.code.toUpperCase() : ''
  const message =
    typeof record?.message === 'string'
      ? record.message
      : typeof error === 'string'
        ? error
        : ''
  const statusCode =
    toStatusCode(record?.statusCode) ??
    toStatusCode(record?.status) ??
    toStatusCode(response?.statusCode) ??
    toStatusCode(response?.status) ??
    statusCodeFromText(code) ??
    statusCodeFromText(message)

  const isReleaseAccessError =
    (operation === 'check' && statusCode === 404) &&
    (code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === '')
  if (isReleaseAccessError) {
    return '无法读取 GitHub 正式 Release，请确认仓库可访问且已发布正式 Release 后重试'
  }

  const isNoReleaseError =
    code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' ||
    (code !== 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' &&
      /no published (?:versions|release)/i.test(message))
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' || /channel file.*not found/i.test(message)) {
    return '已找到正式 Release，但缺少更新元数据（latest.yml），请重新发布完整版本后重试'
  }
  if (isNoReleaseError) {
    return '当前没有可访问的正式 Release，请管理员发布正式 Release 后重试'
  }

  const isAuthError =
    statusCode === 401 ||
    statusCode === 403 ||
    /(?:AUTH|UNAUTHORIZED|FORBIDDEN|PERMISSION|ACCESS_DENIED)/.test(code) ||
    /unauthorized|forbidden|authentication|authorization|permission|access denied/i.test(message)
  if (isAuthError) {
    return '更新服务认证失败，请联系管理员检查发布权限后重试'
  }

  const isServerError =
    (statusCode !== undefined && statusCode >= 500) ||
    /HTTP_ERROR_5\d{2}/.test(code) ||
    /internal server|service unavailable|bad gateway|gateway timeout|server error/i.test(message)
  if (isServerError) {
    return '更新服务暂时不可用，请稍后重试'
  }

  const isNetworkError =
    /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|EPROTO|ETIMEDOUT|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/.test(
      code
    ) ||
    /ERR_(?:CONNECTION|INTERNET_DISCONNECTED|NETWORK|SOCKET|TLS)/.test(code) ||
    /network|offline|internet|timed out|timeout|connection|socket|dns|certificate|tls|ssl/i.test(message)
  if (isNetworkError) {
    return '更新网络连接失败，请检查网络后重试'
  }

  return operation === 'download' ? '更新文件下载失败，请检查网络后重试' : '检查更新失败，请稍后重试'
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
        message: normalizeUpdaterError(error, this.status.phase === 'downloading' ? 'download' : 'check')
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
          message: normalizeUpdaterError(error, 'check')
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
          message: normalizeUpdaterError(error, 'download')
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
