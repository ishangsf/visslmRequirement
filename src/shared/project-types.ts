export type ManagedProjectLifecycle = 'draft' | 'active'
export type ProjectAnalysisStatus = 'idle' | 'processing' | 'ready' | 'failed'
export type ProjectMatchStatus = 'idle' | 'processing' | 'ready' | 'stale' | 'failed'
export type ProjectRequirementStatus = 'unmarked' | 'satisfied' | 'to_develop' | 'to_negotiate'
export type ProjectRequirementStatusSource = 'ai' | 'manual'
export type ProjectRequirementKeyInfoTermsSource = 'ai' | 'manual'
export type ProjectRequirementCategory =
  | 'functional'
  | 'interface'
  | 'data'
  | 'performance'
  | 'security'
  | 'deployment'
  | 'operations'
  | 'acceptance'
  | 'business'
export type ProjectRequirementReviewStatus = 'pending' | 'approved' | 'rejected'
export type ProjectRequirementSetStatus = 'reviewing' | 'published' | 'superseded'
export type ProjectCostType = 'estimated' | 'actual'
export type OrganizationPersonStatus = 'active' | 'inactive'
export type ProjectPlanTaskType = 'milestone' | 'phase' | 'task'
export type ProjectPlanTaskStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked'

export interface ManagedProject {
  id: string
  projectName: string
  customerName: string
  contractAmount: number
  riskFactor: number
  deliveryReminderDays: number
  plannedDeliveryDate: string
  salesOwner: string
  technicalOwner: string
  developmentOwner: string
  estimatedCost: number
  laborEstimatedCost: number
  actualCost: number
  remainingQuota: number
  estimatedDurationDays: number
  lifecycle: ManagedProjectLifecycle
  source: 'manual' | 'technical_agreement'
  analysisStatus: ProjectAnalysisStatus
  analysisMessage: string
  matchStatus: ProjectMatchStatus
  matchMessage: string
  requirementCount: number
  satisfiedCount: number
  toDevelopCount: number
  toNegotiateCount: number
  unmarkedCount: number
  assetCount: number
  participantCount: number
  taskCount: number
  documentCount: number
  reviewSetId?: string
  reviewVersion: number
  reviewRequirementCount: number
  pendingReviewCount: number
  currentDocumentId?: string
  currentDocumentName?: string
  createdAt: string
  updatedAt: string
}

export interface ManagedProjectInput {
  projectName: string
  customerName?: string
  contractAmount?: number
  riskFactor?: number
  deliveryReminderDays?: number
  plannedDeliveryDate?: string
  salesOwner?: string
  technicalOwner?: string
  developmentOwner?: string
  estimatedCost?: number
  estimatedDurationDays?: number
}

export interface ManagedProjectListQuery {
  page: number
  pageSize: number
  search?: string
}

export interface ManagedProjectPage {
  rows: ManagedProject[]
  total: number
}

export interface ProjectCostEntry {
  id: string
  projectId: string
  type: ProjectCostType
  category: string
  description: string
  amount: number
  occurredAt: string
  assetRecordUid?: string
  responsibleParticipantId?: string
  responsiblePersonName?: string
  createdAt: string
  updatedAt: string
}

export interface ProjectCostEntryInput {
  type: ProjectCostType
  category: string
  description?: string
  amount: number
  occurredAt?: string
  assetRecordUid?: string
  responsibleParticipantId?: string
}

export interface OrganizationPerson {
  id: string
  name: string
  employeeNo: string
  department: string
  role: string
  hourlyRate: number
  status: OrganizationPersonStatus
  notes: string
  createdAt: string
  updatedAt: string
}

export interface OrganizationPersonInput {
  name: string
  employeeNo?: string
  department?: string
  role?: string
  hourlyRate?: number
  status?: OrganizationPersonStatus
  notes?: string
}

export interface OrganizationPersonListQuery {
  page: number
  pageSize: number
  search?: string
  status?: OrganizationPersonStatus
}

export interface OrganizationPersonPage {
  rows: OrganizationPerson[]
  total: number
}

export interface ProjectParticipant {
  id: string
  projectId: string
  personId: string
  personName: string
  employeeNo: string
  department: string
  role: string
  hourlyRate: number
  startDate: string
  endDate: string
  durationDays: number
  estimatedCost: number
  notes: string
  createdAt: string
  updatedAt: string
}

export interface ProjectParticipantInput {
  personId: string
  startDate: string
  endDate: string
  notes?: string
}

export interface ProjectPlanTask {
  id: string
  projectId: string
  taskType: ProjectPlanTaskType
  title: string
  description: string
  parentTaskId?: string
  startDate: string
  endDate: string
  ownerPersonId?: string
  ownerName?: string
  status: ProjectPlanTaskStatus
  progressPercent: number
  sortOrder: number
  depth: number
  hasChildren: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectPlanTaskInput {
  taskType: ProjectPlanTaskType
  title: string
  description?: string
  parentTaskId?: string
  startDate: string
  endDate: string
  ownerPersonId?: string
  status?: ProjectPlanTaskStatus
  progressPercent?: number
  sortOrder?: number
}

export interface ProjectPlanTaskMoveInput {
  parentTaskId?: string
  sortOrder?: number
}

export interface ProjectAsset {
  projectId: string
  recordUid: string
  name: string
  nodeType: string
  itemId: string
  description: string
  linkedAt: string
}

export interface ProjectDocumentSnapshot {
  id: string
  fileName: string
  filePath: string
  extension: string
  mimeType: string
  byteSize: number
  sha256: string
  tags: string[]
  status: string
  errorMessage: string
  chunkCount: number
  pageCount: number
  modelVersion: string
  createdAt: string
  updatedAt: string
  processedAt: string
  version: number
  isCurrent: boolean
  linkedAt: string
}

export interface ProjectDataSnapshot {
  format: 'visslm-project'
  version: 1
  exportedAt: string
  project: ManagedProject & { baseEstimatedCost: number }
  documents: ProjectDocumentSnapshot[]
  people: OrganizationPerson[]
  participants: ProjectParticipant[]
  costs: ProjectCostEntry[]
  assets: ProjectAsset[]
  tasks: ProjectPlanTask[]
  requirements: ProjectRequirement[]
  matches: ProjectRequirementMatch[]
}

export interface ProjectDataTransferResult {
  ok: boolean
  canceled?: boolean
  path?: string
  projectId?: string
  warningCount?: number
  warnings?: string[]
  message: string
}

export interface ProjectRequirement {
  id: string
  projectId: string
  documentId: string
  setId: string
  version: number
  requirementNo: number
  category: ProjectRequirementCategory
  module: string
  title: string
  content: string
  keyInfoTerms: string[]
  keyInfoTermsSource: ProjectRequirementKeyInfoTermsSource
  sourceLocation: string
  sourceChunkId: string
  evidenceQuote: string
  confidence: number
  reviewStatus: ProjectRequirementReviewStatus
  reviewNote: string
  status: ProjectRequirementStatus
  statusSource: ProjectRequirementStatusSource
  statusReason: string
  highestMatchScore: number
  matchCount: number
  createdAt: string
  updatedAt: string
}

export interface ProjectRequirementPage {
  rows: ProjectRequirement[]
  total: number
}

export interface ProjectRequirementQuery {
  projectId: string
  page: number
  pageSize: number
  scope?: 'active' | 'published'
}

export interface ProjectRequirementSetSummary {
  id: string
  projectId: string
  documentId: string
  version: number
  status: ProjectRequirementSetStatus
  totalChunks: number
  analyzedChunks: number
  warnings: string[]
  requirementCount: number
  pendingCount: number
  approvedCount: number
  rejectedCount: number
  createdAt: string
  publishedAt: string
}

export interface ProjectRequirementInput {
  category: ProjectRequirementCategory
  module?: string
  title: string
  content: string
  keyInfoTerms?: string[]
  sourceLocation?: string
  sourceChunkId?: string
  evidenceQuote?: string
  confidence?: number
  reviewNote?: string
}

export interface ProjectRequirementMergeInput extends ProjectRequirementInput {
  requirementIds: string[]
}

export interface ProjectRequirementSplitInput {
  parts: ProjectRequirementInput[]
}

export interface ProjectAgreementUploadOptions {
  allowExternalProcessing?: boolean
}

export interface ProjectRequirementMatch {
  requirementId: string
  recordUid: string
  recordName: string
  nodeType: string
  itemId: string
  description: string
  vectorScore: number
  aiScore?: number
  finalScore: number
  scoreSource: 'vector' | 'ai'
  reason: string
  bestChunkId: string
  assetLinked: boolean
}

export interface ProjectRequirementMatchPage {
  rows: ProjectRequirementMatch[]
  total: number
}

export interface ProjectRequirementMatchQuery {
  requirementId: string
  page: number
  pageSize: number
}

export type ProjectAnalysisPhase =
  | 'queued'
  | 'parsing'
  | 'embedding'
  | 'extracting'
  | 'matching'
  | 'done'
  | 'error'

export type ProjectAnalysisLogKind = 'stage' | 'model_request'

export interface ProjectAnalysisLogMetrics {
  logKind?: ProjectAnalysisLogKind
  requestId?: string
  batchNumber?: string
  attempt?: number
  elapsedMs?: number
  inputChars?: number
  outputChars?: number
  doneReason?: string
  modelName?: string
}

export interface ProjectAnalysisProgress extends ProjectAnalysisLogMetrics {
  taskId: string
  projectId: string
  phase: ProjectAnalysisPhase
  message: string
  detail?: string
  documentId?: string
  fileName?: string
  current: number
  total: number
  status: 'running' | 'success' | 'failed'
}

export interface ProjectAnalysisLogEntry extends ProjectAnalysisLogMetrics {
  id: string
  taskId: string
  projectId: string
  taskType: 'agreement' | 'matching'
  phase: ProjectAnalysisPhase
  message: string
  detail: string
  documentId?: string
  fileName?: string
  current: number
  total: number
  status: 'running' | 'success' | 'failed'
  createdAt: string
}

export interface ProjectAnalysisStartResult {
  ok: boolean
  canceled?: boolean
  projectId?: string
  taskId?: string
  message: string
}
