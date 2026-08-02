import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppApi,
  ChatRequest,
  ChatSessionDeleteResult,
  ChatSessionSaveInput,
  DataReviewApplyInput,
  KnowledgeDocumentDetail,
  KnowledgeDocumentPage,
  KnowledgeDocumentQuery,
  KnowledgeIndexProgress,
  KnowledgeRebuildResult,
  KnowledgeStats,
  KnowledgeUploadResult,
  FeatureNavigationOrder,
  FeatureModuleSettings,
  ModelSettings,
  PlatformSettingsInput,
  PushConfig,
  RecordQuery,
  SyncProgress,
  SyncScopeConfig,
  KnowledgeDocumentPreview
} from '../shared/types'
import type {
  DataScope,
  FieldProfileSemanticPatch,
  QuerySpec
} from '../shared/query-spec'
import type { DashboardSaveInput, DashboardSpec } from '../shared/dashboard'
import type { DashboardAuditLog } from '../shared/dashboard'
import type { AgentProgressUpdate } from '../shared/expert-types'
import type {
  ManagedProjectInput,
  ManagedProjectListQuery,
  OrganizationPersonInput,
  OrganizationPersonListQuery,
  ProjectAnalysisLogEntry,
  ProjectAnalysisProgress,
  ProjectCostEntryInput,
  ProjectDocumentSnapshot,
  ProjectParticipantInput,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectRequirementInput,
  ProjectRequirementMergeInput,
  ProjectRequirementMatchQuery,
  ProjectRequirementQuery,
  ProjectRequirementReviewStatus,
  ProjectRequirementSplitInput,
  ProjectAgreementUploadOptions,
  ProjectRequirementStatus
} from '../shared/project-types'

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
  saveFeatureSettings: (input: FeatureModuleSettings) =>
    ipcRenderer.invoke('settings:save-features', input),
  saveNavigationOrder: (input: FeatureNavigationOrder) =>
    ipcRenderer.invoke('settings:save-navigation-order', input),
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
  applyDataReview: (input: DataReviewApplyInput) =>
    ipcRenderer.invoke('data:apply-review', input),
  listCollectionRequestLogs: (page?: number, pageSize?: number) =>
    ipcRenderer.invoke('sync:request-logs', page, pageSize),
  askAgent: (request: ChatRequest) => ipcRenderer.invoke('agent:ask', request),
  listChatSessions: (limit?: number) => ipcRenderer.invoke('chat:sessions', limit),
  getChatSession: (id: string) => ipcRenderer.invoke('chat:session', id),
  saveChatSession: (input: ChatSessionSaveInput) =>
    ipcRenderer.invoke('chat:save-session', input),
  deleteChatSession: (id: string): Promise<ChatSessionDeleteResult> =>
    ipcRenderer.invoke('chat:delete-session', id),
  onAgentEvent: (callback: (update: AgentProgressUpdate) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, update: AgentProgressUpdate): void =>
      callback(update)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  listFieldProfiles: (scope?: DataScope) =>
    ipcRenderer.invoke('analytics:field-profiles', scope),
  saveFieldProfileSemantics: (
    scope: DataScope,
    field: string,
    patch: FieldProfileSemanticPatch
  ) => ipcRenderer.invoke('analytics:field-profile-semantics', scope, field, patch),
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
  repairDashboardComponent: (spec: DashboardSpec, componentId: string) =>
    ipcRenderer.invoke('dashboards:repair-component', spec, componentId),
  listVisualizationRuns: (limit?: number) =>
    ipcRenderer.invoke('dashboards:runs', limit),
  listDashboardAuditLogs: (dashboardId?: string, limit?: number): Promise<DashboardAuditLog[]> =>
    ipcRenderer.invoke('dashboards:audit-logs', dashboardId, limit),
  exportDashboardJson: (spec: DashboardSpec, version?: number) =>
    ipcRenderer.invoke('dashboards:export-json', spec, version),
  exportDashboardPdf: (spec: DashboardSpec, version?: number) =>
    ipcRenderer.invoke('dashboards:export-pdf', spec, version),
  exportDashboardPng: (spec: DashboardSpec, dataUrl: string, version?: number) =>
    ipcRenderer.invoke('dashboards:export-png', spec, dataUrl, version),
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
  },
  listKnowledgeDocuments: (query: KnowledgeDocumentQuery): Promise<KnowledgeDocumentPage> =>
    ipcRenderer.invoke('knowledge:documents', query),
  getKnowledgeDocument: (id: string): Promise<KnowledgeDocumentDetail | null> =>
    ipcRenderer.invoke('knowledge:document', id),
  getKnowledgeDocumentPreview: (id: string): Promise<KnowledgeDocumentPreview | null> =>
    ipcRenderer.invoke('knowledge:document-preview', id),
  uploadKnowledgeDocuments: (): Promise<KnowledgeUploadResult> =>
    ipcRenderer.invoke('knowledge:upload'),
  retryKnowledgeDocument: (id: string) =>
    ipcRenderer.invoke('knowledge:retry', id),
  updateKnowledgeDocumentTags: (id: string, tags: string[]) =>
    ipcRenderer.invoke('knowledge:tags', id, tags),
  deleteKnowledgeDocument: (id: string) =>
    ipcRenderer.invoke('knowledge:delete', id),
  rebuildKnowledgeIndex: (): Promise<KnowledgeRebuildResult> =>
    ipcRenderer.invoke('knowledge:rebuild'),
  getKnowledgeStats: (): Promise<KnowledgeStats> =>
    ipcRenderer.invoke('knowledge:stats'),
  onKnowledgeProgress: (callback: (progress: KnowledgeIndexProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: KnowledgeIndexProgress): void =>
      callback(progress)
    ipcRenderer.on('knowledge:progress', listener)
    return () => ipcRenderer.removeListener('knowledge:progress', listener)
  },
  listManagedProjects: (query: ManagedProjectListQuery) => ipcRenderer.invoke('projects:list', query),
  getManagedProject: (id: string) => ipcRenderer.invoke('projects:get', id),
  listManagedProjectDocuments: (id: string): Promise<ProjectDocumentSnapshot[]> => ipcRenderer.invoke('projects:documents', id),
  listProjectAnalysisLogs: (id: string, limit?: number): Promise<ProjectAnalysisLogEntry[]> => ipcRenderer.invoke('projects:analysis-logs', id, limit),
  createManagedProject: (input: ManagedProjectInput) => ipcRenderer.invoke('projects:create', input),
  updateManagedProject: (id: string, input: ManagedProjectInput) => ipcRenderer.invoke('projects:update', id, input),
  deleteManagedProject: (id: string) => ipcRenderer.invoke('projects:delete', id),
  exportManagedProjectData: (id: string) => ipcRenderer.invoke('projects:export-data', id),
  exportManagedProjectExcel: (id: string) => ipcRenderer.invoke('projects:export-excel', id),
  importManagedProjectData: () => ipcRenderer.invoke('projects:import-data'),
  discardManagedProjectDraft: (id: string) => ipcRenderer.invoke('projects:discard-draft', id),
  startProjectTechnicalAgreementUpload: (projectId?: string, options?: ProjectAgreementUploadOptions) =>
    ipcRenderer.invoke('projects:upload-agreement', projectId, options),
  confirmManagedProject: (id: string) => ipcRenderer.invoke('projects:confirm', id),
  retryProjectAnalysis: (id: string) => ipcRenderer.invoke('projects:retry-analysis', id),
  startProjectMatching: (id: string) => ipcRenderer.invoke('projects:start-matching', id),
  listProjectRequirements: (query: ProjectRequirementQuery) =>
    ipcRenderer.invoke('projects:requirements', query),
  getProjectRequirementSet: (projectId: string) => ipcRenderer.invoke('projects:requirement-set', projectId),
  createProjectRequirement: (projectId: string, input: ProjectRequirementInput) =>
    ipcRenderer.invoke('projects:requirement-create', projectId, input),
  updateProjectRequirement: (id: string, input: ProjectRequirementInput) =>
    ipcRenderer.invoke('projects:requirement-update', id, input),
  splitProjectRequirement: (id: string, input: ProjectRequirementSplitInput) =>
    ipcRenderer.invoke('projects:requirement-split', id, input),
  mergeProjectRequirements: (input: ProjectRequirementMergeInput) =>
    ipcRenderer.invoke('projects:requirement-merge', input),
  reviewProjectRequirements: (ids: string[], status: ProjectRequirementReviewStatus) =>
    ipcRenderer.invoke('projects:requirement-review', ids, status),
  publishProjectRequirements: (projectId: string) => ipcRenderer.invoke('projects:requirements-publish', projectId),
  deleteProjectRequirement: (id: string) => ipcRenderer.invoke('projects:requirement-delete', id),
  updateProjectRequirementStatus: (id: string, status: ProjectRequirementStatus) =>
    ipcRenderer.invoke('projects:requirement-status', id, status),
  updateProjectRequirementKeyInfoTerms: (id: string, terms: string[]) =>
    ipcRenderer.invoke('projects:requirement-key-info-terms', id, terms),
  startProjectRequirementMatching: (id: string) =>
    ipcRenderer.invoke('projects:start-requirement-matching', id),
  listProjectRequirementMatches: (query: ProjectRequirementMatchQuery) =>
    ipcRenderer.invoke('projects:matches', query),
  listProjectCostEntries: (projectId: string) => ipcRenderer.invoke('projects:costs', projectId),
  addProjectCostEntry: (projectId: string, input: ProjectCostEntryInput) =>
    ipcRenderer.invoke('projects:cost-add', projectId, input),
  updateProjectCostEntry: (id: string, input: ProjectCostEntryInput) =>
    ipcRenderer.invoke('projects:cost-update', id, input),
  deleteProjectCostEntry: (id: string) => ipcRenderer.invoke('projects:cost-delete', id),
  listProjectAssets: (projectId: string) => ipcRenderer.invoke('projects:assets', projectId),
  linkProjectAsset: (projectId: string, recordUid: string) =>
    ipcRenderer.invoke('projects:asset-link', projectId, recordUid),
  unlinkProjectAsset: (projectId: string, recordUid: string) =>
    ipcRenderer.invoke('projects:asset-unlink', projectId, recordUid),
  onProjectProgress: (callback: (progress: ProjectAnalysisProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ProjectAnalysisProgress): void =>
      callback(progress)
    ipcRenderer.on('project:progress', listener)
    return () => ipcRenderer.removeListener('project:progress', listener)
  },
  listOrganizationPeople: (query: OrganizationPersonListQuery) =>
    ipcRenderer.invoke('organization:people', query),
  createOrganizationPerson: (input: OrganizationPersonInput) =>
    ipcRenderer.invoke('organization:person-create', input),
  updateOrganizationPerson: (id: string, input: OrganizationPersonInput) =>
    ipcRenderer.invoke('organization:person-update', id, input),
  deleteOrganizationPerson: (id: string) => ipcRenderer.invoke('organization:person-delete', id),
  listProjectParticipants: (projectId: string) => ipcRenderer.invoke('projects:participants', projectId),
  addProjectParticipant: (projectId: string, input: ProjectParticipantInput) =>
    ipcRenderer.invoke('projects:participant-add', projectId, input),
  updateProjectParticipant: (id: string, input: ProjectParticipantInput) =>
    ipcRenderer.invoke('projects:participant-update', id, input),
  deleteProjectParticipant: (id: string) => ipcRenderer.invoke('projects:participant-delete', id),
  listProjectTasks: (projectId: string) => ipcRenderer.invoke('projects:tasks', projectId),
  addProjectTask: (projectId: string, input: ProjectPlanTaskInput) =>
    ipcRenderer.invoke('projects:task-add', projectId, input),
  updateProjectTask: (id: string, input: ProjectPlanTaskInput) =>
    ipcRenderer.invoke('projects:task-update', id, input),
  moveProjectTask: (id: string, input: ProjectPlanTaskMoveInput) =>
    ipcRenderer.invoke('projects:task-move', id, input),
  deleteProjectTask: (id: string) => ipcRenderer.invoke('projects:task-delete', id)
}

contextBridge.exposeInMainWorld('visslm', api)
