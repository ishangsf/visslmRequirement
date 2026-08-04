import { strToU8, zipSync } from 'fflate'
import type {
  DashboardOfflineExportPayload,
  DashboardOfflineManifest,
  DashboardSpec
} from '../../shared/dashboard'
import { dashboardSpecHash } from './spec-hash'

export const offlineViewerResourceNames = [
  'index.html',
  'dashboard-viewer.js',
  'dashboard-viewer.css'
] as const

export interface DashboardOfflineViewerAssets {
  indexHtml: string
  viewerScript: Uint8Array
  viewerStyle: Uint8Array
}

const serializeForScript = (value: unknown): string => {
  const serialized = JSON.stringify(value)
  if (!serialized) throw new Error('离线预览数据序列化失败')
  return serialized
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

const buildDataScript = (
  spec: DashboardSpec,
  version: number | undefined,
  exportedAt: string
): string => {
  const payload: DashboardOfflineExportPayload = {
    spec,
    version: version ?? null,
    exportedAt
  }
  return `window.__VISSLM_DASHBOARD_EXPORT__ = ${serializeForScript(payload)};\n`
}

export const createDashboardOfflineArchive = (
  spec: DashboardSpec,
  version: number | undefined,
  assets: DashboardOfflineViewerAssets,
  exportedAt = new Date().toISOString()
): Uint8Array => {
  if (!assets.indexHtml.includes('./dashboard-viewer.js')) {
    throw new Error('离线预览入口缺少 viewer 脚本引用')
  }
  if (!assets.indexHtml.includes('./dashboard-viewer.css')) {
    throw new Error('离线预览入口缺少 viewer 样式引用')
  }

  const manifest: DashboardOfflineManifest = {
    format: 'visslm-dashboard-offline',
    schemaVersion: '1.0',
    generatedAt: exportedAt,
    dashboardId: spec.id,
    dashboardTitle: spec.title,
    dashboardVersion: version ?? null,
    theme: spec.theme,
    componentCount: spec.components.length,
    dataMode: 'snapshot',
    networkAccess: 'none',
    specHash: dashboardSpecHash(spec)
  }

  return zipSync({
    'index.html': strToU8(assets.indexHtml),
    'dashboard-data.js': strToU8(buildDataScript(spec, version, exportedAt)),
    'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    'dashboard-viewer.js': assets.viewerScript,
    'dashboard-viewer.css': assets.viewerStyle
  }, { level: 6 })
}
