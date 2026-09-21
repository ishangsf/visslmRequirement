import type {
  DashboardDomainReceipt,
  DashboardSpec,
  DashboardComponentType,
  DashboardSlotRole
} from './dashboard'
import type { DataScope } from './query-spec'

/**
 * Stable domain vocabulary used by the first dashboard slice.
 *
 * The sourceKey, process and evidence identifiers in this file are internal
 * controlled-sample identifiers. They are not a claim of official GJB
 * conformity. A real platform adapter must replace these references with
 * verified source records, tailoring baselines and evidence before a metric
 * can be treated as available for production use.
 */

export type DashboardDomainRole =
  | 'project-owner'
  | 'qa-epg'
  | 'rd-lead'
  | 'model-org-manager'

export type DashboardScenarioStatus = 'active' | 'planned'

export type DashboardDomainLine =
  | 'execution'
  | 'process'
  | 'quality'
  | 'organization'
  | 'configuration'

export type DashboardMetricAvailability =
  | 'ready'
  | 'partial'
  | 'insufficient'
  | 'missing'

export type DashboardEvidenceStatus = 'missing' | 'insufficient' | 'sufficient'

export type DashboardThresholdOperator =
  | 'eq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'

export interface DashboardMetricThreshold {
  id: string
  label: string
  operator: DashboardThresholdOperator
  value: number | readonly [number, number]
  /** Human-readable interpretation of this controlled sample threshold. */
  interpretation: string
}

export interface DashboardMetricSourceField {
  /** Stable, non-sensitive reference understood by a platform adapter. */
  sourceKey: string
  /** Table/entity or synchronized node type containing the field. */
  nodeType: string
  field: string
  /** Explicit relation key; never infer a join from a display label. */
  relationKey: string
  availability: DashboardMetricAvailability
  note?: string
}

export interface MetricCatalogEntry {
  id: string
  label: string
  definition: string
  formulaVersion: string
  sourceFields: readonly DashboardMetricSourceField[]
  timeSemantics: string
  applicableScopes: readonly string[]
  thresholds: readonly DashboardMetricThreshold[]
  ownerRoles: readonly DashboardDomainRole[]
  processRequirementIds: readonly string[]
  availability?: DashboardMetricAvailability
  unit?: string
  format?: 'number' | 'percent' | 'duration' | 'currency'
  numerator?: string
  denominator?: string
  notes?: readonly string[]
}

export interface ProcessBinding {
  id: string
  metricIds: readonly string[]
  requirementId: string
  tailoringBaselineId: string
  activityId: string
  workProductId: string
  evidenceId: string
  evidenceStatus: DashboardEvidenceStatus
  sourceKey: string
  evidenceRule: string
  notes?: string
}

export interface DashboardDomainQuestion {
  id: string
  question: string
  metricIds: readonly string[]
  line: DashboardDomainLine
  slotRole: DashboardSlotRole
  preferredComponentTypes: readonly DashboardComponentType[]
  required: boolean
  priority: number
  clarificationKeys?: readonly string[]
}

export interface DashboardDomainComponent {
  id: string
  label: string
  type: DashboardComponentType
  metricIds: readonly string[]
  questionIds: readonly string[]
  line: DashboardDomainLine
  slotRole: DashboardSlotRole
}

export interface DashboardGoldenScenario {
  id: string
  name: string
  description: string
  status: DashboardScenarioStatus
  roleIds: readonly DashboardDomainRole[]
  metricIds: readonly string[]
  questionIds: readonly string[]
  componentIds: readonly string[]
  lines: readonly DashboardDomainLine[]
  clarificationKeys?: readonly string[]
}

/** Entry point used by the guided scenario flow. */
export type DashboardScenarioEntry = 'gallery' | 'assistant' | 'blank'

/** Data source selected for a scenario draft. */
export type DashboardScenarioDataMode = 'controlled-sample' | 'platform-adapter'

/** Coarse readiness state shown before the generator is invoked. */
export type DashboardReadinessLevel = 'ready' | 'partial' | 'blocked'

export type DashboardReadinessBlockerCode =
  | 'scenario-not-found'
  | 'scenario-not-active'
  | 'role-not-supported'
  | 'adapter-required'
  | 'adapter-invalid'
  | 'adapter-scope-violation'
  | 'insufficient-permission'
  | 'profile-failed'
  | 'metric-field-missing'
  | 'metric-field-invalid'
  | 'evidence-unavailable'

export interface DashboardScenarioMetricReadiness {
  metricId: string
  availability: DashboardMetricAvailability
  /** Resolved only after a non-sensitive numeric platform field is verified. */
  resolvedField?: string
  reason?: string
}

/**
 * Explainable, non-sensitive readiness result used by the scenario gallery and
 * wizard. It is intentionally separate from DashboardDomainGenerationResult:
 * readiness must be available before a query or model generation is attempted.
 */
export interface DashboardScenarioReadiness {
  scenarioId: string
  role: DashboardDomainRole
  dataMode: DashboardScenarioDataMode
  level: DashboardReadinessLevel
  metricStatuses: DashboardScenarioMetricReadiness[]
  projectIds: string[]
  nodeTypes: string[]
  missingPermissions: string[]
  missingEvidence: string[]
  warnings: string[]
  blockers: Array<{ code: DashboardReadinessBlockerCode; message: string }>
  checkedAt: string
  adapterId?: string
  tailoringBaselineId?: string
  /** Number of profiled fields; never contains field values or record payloads. */
  profiledFieldCount: number
}

/** Result returned by the structured scenario entry; mirrors the chat path. */
export interface DashboardScenarioGenerationResult {
  status: 'ready' | 'clarification' | 'rejected'
  dashboard?: DashboardSpec
  scenario?: string
  dataMode?: DashboardScenarioDataMode
  adapterId?: string
  sourceSystem?: string
  receipt?: DashboardDomainReceipt
  reason?: string
  answer?: string
  clarification?: {
    reason?: string
    options?: readonly { id: string; label: string; recommended: boolean }[]
  }
}

/**
 * Draft exchanged between the gallery/wizard and the main process. It carries
 * no credentials; the adapter is revalidated in the main process on every
 * readiness or generation request.
 */
export interface DashboardScenarioDraft {
  entry: DashboardScenarioEntry
  scenarioId: string
  role: DashboardDomainRole
  dataMode: DashboardScenarioDataMode
  scope: DataScope
  adapter?: DashboardDomainPlatformAdapter
  requestedPermissions?: readonly string[]
  metricOverrides?: Record<string, unknown>
  componentOverrides?: Record<string, unknown>
  generatedAt: string
}

export interface DashboardQualityWeights {
  businessMetric: 30
  processCompliance: 20
  semanticConsistency: 20
  layoutReadability: 15
  dataTrust: 10
  accessibilityInteraction: 5
}

export type DashboardQualityVetoCode =
  | 'metric-definition-error'
  | 'fabricated-data'
  | 'permission-violation'
  | 'invalid-tailoring-baseline'

export interface DashboardQualityPolicy {
  weights: DashboardQualityWeights
  formalAcceptanceThreshold: 90
  previewThreshold: 80
  vetoCodes: readonly DashboardQualityVetoCode[]
  notes?: readonly string[]
}

export interface DashboardDomainCatalog {
  version: '1.0'
  domainId: string
  roles: readonly DashboardDomainRole[]
  scenarios: readonly DashboardGoldenScenario[]
  metrics: readonly MetricCatalogEntry[]
  questions: readonly DashboardDomainQuestion[]
  components: readonly DashboardDomainComponent[]
  processBindings: readonly ProcessBinding[]
  qualityPolicy: DashboardQualityPolicy
}

export interface DashboardDomainAdapterMetricBinding {
  metricId: string
  field: string
  aggregation: 'count' | 'countDistinct' | 'sum' | 'avg' | 'min' | 'max'
}

export interface DashboardDomainAdapterQuestionBinding {
  questionId: string
  dimensionFields: readonly string[]
}

export interface DashboardDomainAdapterEvidenceBinding {
  processBindingId: string
  evidenceStatus: DashboardEvidenceStatus
  /** Stable reference to the verified platform evidence source. */
  sourceKey: string
}

/**
 * Explicit, fail-closed mapping from one golden scenario to synchronized
 * platform records. Adapter configuration never contains credentials.
 */
export interface DashboardDomainPlatformAdapter {
  schemaVersion: '1.0'
  id: string
  scenarioId: string
  sourceSystem: string
  /** Explicit project boundary for this adapter; an empty list is invalid and fails closed. */
  allowedProjectIds: readonly string[]
  /** Capabilities granted to the adapter runtime (never credentials). */
  permissions: readonly string[]
  nodeTypes: readonly string[]
  tailoringBaselineId: string
  metricBindings: readonly DashboardDomainAdapterMetricBinding[]
  questionBindings: readonly DashboardDomainAdapterQuestionBinding[]
  evidenceBindings: readonly DashboardDomainAdapterEvidenceBinding[]
  updatedAt: string
}
