import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  ChatRequest,
  ModelSettings,
  PlatformSettingsInput,
  PushConfig,
  RecordQuery,
  SyncProgress,
  SyncScopeConfig
} from '../shared/types'
import type { DataScope, QuerySpec } from '../shared/query-spec'
import type { DashboardSaveInput, DashboardSpec } from '../shared/dashboard'

const api: AppApi = {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean): void =>
      callback(maximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  savePlatformSettings: (input: PlatformSettingsInput) =>
    ipcRenderer.invoke('settings:save-platform', input),
  saveModelSettings: (input: ModelSettings) =>
    ipcRenderer.invoke('settings:save-model', input),
  testPlatform: (input?: PlatformSettingsInput) =>
    ipcRenderer.invoke('connections:test-platform', input),
  testModel: (input?: ModelSettings) =>
    ipcRenderer.invoke('connections:test-model', input),
  listProjects: () => ipcRenderer.invoke('data:projects'),
  listNodeTypes: () => ipcRenderer.invoke('data:node-types'),
  listRecords: (query: RecordQuery) => ipcRenderer.invoke('data:records', query),
  getRecord: (uid: string) => ipcRenderer.invoke('data:record', uid),
  getStats: () => ipcRenderer.invoke('data:stats'),
  getSyncConfig: () => ipcRenderer.invoke('sync:get-config'),
  saveSyncConfig: (config: SyncScopeConfig) => ipcRenderer.invoke('sync:save-config', config),
  previewSync: (config?: SyncScopeConfig) => ipcRenderer.invoke('sync:preview', config),
  startSync: (config?: SyncScopeConfig) => ipcRenderer.invoke('sync:start', config),
  listCollectionRequestLogs: (page?: number, pageSize?: number) =>
    ipcRenderer.invoke('sync:request-logs', page, pageSize),
  askAgent: (request: ChatRequest) => ipcRenderer.invoke('agent:ask', request),
  listFieldProfiles: (scope?: DataScope) =>
    ipcRenderer.invoke('analytics:field-profiles', scope),
  executeQuery: (spec: QuerySpec) =>
    ipcRenderer.invoke('analytics:execute-query', spec),
  listDashboards: () => ipcRenderer.invoke('dashboards:list'),
  getDashboard: (id: string, version?: number) =>
    ipcRenderer.invoke('dashboards:get', id, version),
  listDashboardVersions: (id: string) =>
    ipcRenderer.invoke('dashboards:versions', id),
  saveDashboard: (input: DashboardSaveInput) =>
    ipcRenderer.invoke('dashboards:save', input),
  restoreDashboard: (id: string, version: number) =>
    ipcRenderer.invoke('dashboards:restore', id, version),
  diagnoseDashboard: (spec: DashboardSpec) =>
    ipcRenderer.invoke('dashboards:diagnose', spec),
  listVisualizationRuns: (limit?: number) =>
    ipcRenderer.invoke('dashboards:runs', limit),
  exportDashboardJson: (spec: DashboardSpec) =>
    ipcRenderer.invoke('dashboards:export-json', spec),
  exportDashboardPdf: (spec: DashboardSpec) =>
    ipcRenderer.invoke('dashboards:export-pdf', spec),
  importData: () => ipcRenderer.invoke('data:import'),
  exportData: () => ipcRenderer.invoke('data:export'),
  deleteData: (uids?: string[]) => ipcRenderer.invoke('data:delete', uids),
  previewPush: (config: PushConfig) => ipcRenderer.invoke('push:preview', config),
  startPush: (config: PushConfig) => ipcRenderer.invoke('push:start', config),
  listPushLogs: (page?: number, pageSize?: number) =>
    ipcRenderer.invoke('push:logs', page, pageSize),
  onSyncProgress: (callback: (progress: SyncProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress): void =>
      callback(progress)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  }
}

contextBridge.exposeInMainWorld('visslm', api)
