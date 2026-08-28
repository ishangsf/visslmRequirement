import type {
  DashboardComponentType,
  DashboardSlotRole
} from './dashboard'

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
