import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DashboardSpec } from '../../shared/dashboard'
import type { DashboardRenderPreview, DashboardRenderIssue } from '../../shared/dashboard-generation'

/** Isolated actual renderer: no preload, app IPC, persisted profile or external network. */
export const renderDashboardPreview = async (spec: DashboardSpec, signal?: AbortSignal, rendererFile?: string): Promise<DashboardRenderPreview> => {
  signal?.throwIfAborted()
  const window = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, partition: `dashboard-preview-${randomUUID()}` } })
  const issues: DashboardRenderIssue[] = []
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const allowedOrigin = devUrl ? new URL(devUrl).origin : undefined
  window.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url)
    callback({ cancel: !['file:', 'data:', 'blob:'].includes(url.protocol) && url.origin !== allowedOrigin })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) issues.push({ code: 'renderer-error', severity: 'error', message: message.slice(0, 500) })
  })
  const abort = () => { if (!window.isDestroyed()) window.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 25_000)
  try {
    if (devUrl) await window.loadURL(new URL('/dashboard-preview.html', devUrl).toString())
    else await window.loadFile(rendererFile ?? join(__dirname, '../renderer/dashboard-preview.html'))
    signal?.throwIfAborted()
    const result = await window.webContents.executeJavaScript(`window.dashboardPreview.render(${JSON.stringify(spec)})`) as DashboardRenderPreview
    signal?.throwIfAborted()
    const screenshot = await window.webContents.capturePage()
    return { ...result, issues: [...result.issues, ...issues], screenshot: { mimeType: 'image/png', data: screenshot.toPNG().toString('base64') } }
  } finally {
    clearTimeout(timeout); signal?.removeEventListener('abort', abort)
    if (!window.isDestroyed()) window.destroy()
  }
}
