export type ManagedProjectLifecycle = 'draft' | 'active'
export type ProjectAnalysisStatus = 'idle' | 'processing' | 'ready' | 'failed'
export type ProjectMatchStatus = 'idle' | 'processing' | 'ready' | 'stale' | 'failed'
export type ProjectRequirementStatus = 'unmarked' | 'satisfied' | 'to_develop' | 'to_negotiate'
export type ProjectRequirementStatusSource = 'ai' | 'manual' | 'system_rule' | 'legacy_unverified'
export type ProjectAssetLinkSource = 'manual' | 'exact_business_hash' | 'legacy_unknown'
/** The state of a requirement link when the source baseline is compared with the current one. */
export type ProjectTraceStatus = 'valid' | 'suspect' | 'invalid'
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

export interface ProjectPlanTaskRequirement {
  requirementId: string
  /** Stable identity shared by requirement versions. */
  logicalId: string
  /** Phase 2 compatibility alias for consumers that use trace terminology. */
  logicalRequirementId: string
  requirementNo: number
  title: string
  status: ProjectRequirementStatus
  linkedAt: string
  sourceBaselineVersion: number
  /** Stable source baseline/set identifier (empty for legacy links). */
  sourceBaselineId: string
  sourceRequirementVersion: number
  targetCurrentVersion: number | null
  /** Phase 2 compatibility alias for the current target requirement version. */
  targetVersion: number | null
  traceStatus: ProjectTraceStatus
  validatedBy: string
  validatedAt: string
  traceMetadata: ProjectRequirementTraceMetadata
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
  requirements: ProjectPlanTaskRequirement[]
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
  requirementIds?: string[]
}

export interface ProjectPlanTaskMoveInput {
  parentTaskId?: string
  sortOrder?: number
}

export interface ProjectAssetRequirement {
  requirementId: string
  /** Stable identity shared by requirement versions. */
  logicalId: string
  /** Phase 2 compatibility alias for consumers that use trace terminology. */
  logicalRequirementId: string
  requirementNo: number
  title: string
  linkedAt: string
  linkSource: ProjectAssetLinkSource
  confirmedBy: string
  confirmedAt: string
  matchRunId: string | null
  matchScore?: number
  sourceBaselineVersion: number
  /** Stable source baseline/set identifier (empty for legacy links). */
  sourceBaselineId: string
  sourceRequirementVersion: number
  targetCurrentVersion: number | null
  /** Phase 2 compatibility alias for the current target requirement version. */
  targetVersion: number | null
  traceStatus: ProjectTraceStatus
  validatedBy: string
  validatedAt: string
  traceMetadata: ProjectRequirementTraceMetadata
}

/** Audit metadata retained with task/asset links across requirement releases. */
export interface ProjectRequirementTraceMetadata {
  sourceRequirementId: string
  sourceSetId: string
  sourceBaselineVersion: number
  sourceRequirementVersion: number
  targetRequirementId: string | null
  targetCurrentVersion: number | null
  validatedAt: string
  validationReason: string
  /** Actor that last validated the link; legacy rows may not have one. */
  validatedBy?: string
}

export interface ProjectAsset {
  projectId: string
  recordUid: string
  name: string
  nodeType: string
  itemId: string
  description: string
  linkedAt: string
  linkSource: ProjectAssetLinkSource
  confirmedBy: string
  confirmedAt: string
  matchRunId: string | null
  requirements: ProjectAssetRequirement[]
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
  /** v1 is retained for import/export compatibility; v2 carries immutable run/set history. */
  version: 1 | 2
  exportedAt: string
  project: ManagedProject & { baseEstimatedCost: number }
  documents: ProjectDocumentSnapshot[]
  people: OrganizationPerson[]
  participants: ProjectParticipant[]
  costs: ProjectCostEntry[]
  assets: ProjectAsset[]
  tasks: ProjectPlanTask[]
  requirements: ProjectRequirement[]
  matches: LegacyProjectRequirementMatch[]
  /** v2: all requirement-set versions, including superseded/reviewing sets. */
  requirementSets?: ProjectRequirementSetSnapshot[]
  /** v2: immutable match-run metadata for every requirement version. */
  matchRuns?: ProjectRequirementMatchRunSnapshot[]
  /** v2: persisted candidates, including evidence and ranking provenance. */
  matchCandidates?: ProjectRequirementMatchCandidateSnapshot[]
  /** v2: normalized link trace records for consumers that do not traverse task/assets. */
  traceMetadata?: ProjectRequirementTraceSnapshot[]
}

export interface ProjectRequirementSetSnapshot {
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
  fingerprint: string
  externalProcessing?: boolean
  modelName?: string
}

export interface ProjectRequirementMatchRunSnapshot {
  id: string
  requirementId: string
  requirementLogicalId: string
  requirementVersion: number
  baselineVersion: number
  requirementSnapshotHash: string
  requirementBusinessHash: string
  normalizationVersion: string
  indexVersion: string
  pipelineVersion: string
  rankingVersion: string
  configHash: string
  modelVersion: string | null
  status: 'running' | 'succeeded' | 'failed' | 'stale'
  degradationCodes: string[]
  failureCode: string | null
  startedAt: string
  createdAt: string
  completedAt: string | null
}

/** JSON-safe candidate snapshot; score/evidence fields intentionally remain opaque for forward compatibility. */
export interface ProjectRequirementMatchCandidateSnapshot {
  runId: string
  requirementId: string
  recordUid: string
  finalRank: number
  rankingScore: number
  similarityScore: number | null
  rankingVersion: string
  relation: string | null
  decisionStatus: string
  confidenceStatus: string
  confidenceReasons: string[]
  evidenceLevel: string
  reasonCodes: string[]
  degradationCodes: string[]
  stageScores: unknown
  scoreBreakdown: unknown
  evidenceJson: unknown
  explanationStatus: string
  explanation: string | null
  recordSnapshotHash: string
}

export interface ProjectRequirementTraceSnapshot extends ProjectRequirementTraceMetadata {
  entityType: 'task' | 'asset'
  taskId?: string
  recordUid?: string
  projectId: string
  requirementId: string
  logicalId: string
  traceStatus: ProjectTraceStatus
  linkSource?: ProjectAssetLinkSource
  confirmedBy?: string
  confirmedAt?: string
  linkedAt: string
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
  /** Stable identity shared by versions unless a split/merge creates a new logical item. */
  logicalId: string
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
  /** Legacy score retained for import/export compatibility. */
  highestMatchScore: number
  highestSimilarityScore: number | null
  latestSimilarityRunId: string | null
  similarCandidateCount: number
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
  status?: ProjectRequirementStatus
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
  fingerprint: string
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

export interface LegacyProjectRequirementMatch {
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
  requirementLinked: boolean
}

export interface ProjectRequirementMatchPage {
  run: ProjectRequirementMatchRunSummary | null
  rows: ProjectRequirementMatchCandidate[]
  total: number
}

export interface ProjectRequirementMatchQuery {
  requirementId: string
  runId?: string
  page: number
  pageSize: number
  diagnostics?: boolean
}

export interface ProjectRequirementMatchRunSummary {
  id: string
  requirementId: string
  requirementLogicalId: string
  requirementVersion: number
  baselineVersion: number
  requirementBusinessHash: string
  indexVersion: string
  normalizationVersion: string
  pipelineVersion: string
  rankingVersion: string
  configHash: string
  modelVersion: string | null
  degradationCodes: string[]
  status: 'running' | 'succeeded' | 'failed' | 'stale'
  failureCode: string | null
  startedAt: string
  completedAt: string
}

export interface ProjectRequirementMatchCandidate {
  requirementId: string
  runId: string
  recordUid: string
  recordName: string
  nodeType: string
  itemId: string
  description: string
  finalRank: number
  similarityScore: number
  /** Compatibility alias for older integrations. */
  rankingScore: number
  rankingVersion: string
  scoreBreakdown: {
    formulaVersion: string
    dense: { rawScore: number | null; normalizedScore: number; weight: number; contribution: number; available: boolean }
    lexical: { rawScore: number | null; normalizedScore: number; weight: number; contribution: number; available: boolean }
    reranker: { rawScore: number | null; normalizedScore: number; weight: number; contribution: number; available: boolean }
    businessAlignment: { rawScore: number | null; normalizedScore: number; weight: number; contribution: number; available: boolean }
    total: number
  }
  relation: 'duplicate' | 'highly_similar' | 'partial_overlap' | 'same_pattern' | 'topic_only' | 'unrelated' | null
  decisionStatus: 'confirmed' | 'suggested' | 'ambiguous' | 'rejected'
  confidenceStatus: 'high' | 'medium' | 'low' | 'abstain'
  confidenceReasons: string[]
  evidenceLevel: 'exact_business_hash' | 'exact_normalized_text' | 'deterministic_rule' | 'model_supported' | 'retrieval_only'
  reasonCodes: string[]
  degradationCodes: string[]
  evidenceJson?: unknown
  explanationStatus: 'not_requested' | 'pending' | 'available' | 'unavailable'
  explanation: string | null
  deterministicAnalysis: {
    similarities: string[]
    differences: string[]
    basis: 'business_facts_and_terms'
  }
  denseScore: number | null
  lexicalScore: number | null
  fusedScore: number
  rerankerScore: number | null
  assetLinked: boolean
  requirementLinked: boolean
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
  status: 'running' | 'success' | 'failed' | 'cancelled'
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
  status: 'running' | 'success' | 'failed' | 'cancelled'
  createdAt: string
}

export interface ProjectAnalysisStartResult {
  ok: boolean
  canceled?: boolean
  projectId?: string
  taskId?: string
  message: string
}
