import { createHash } from 'node:crypto'

export type RequirementAccuracyGrade = 0 | 1 | 2 | 3 | 4

export type RequirementAccuracyRelation =
  | 'duplicate'
  | 'highly_similar'
  | 'partial_overlap'
  | 'same_pattern'
  | 'topic_only'
  | 'unrelated'
  | null

export interface RequirementAccuracyQuery {
  queryId: string
  domain: string
  name: string
  description: string
  raw: Record<string, unknown>
  normalizedText: string
}

export interface RequirementAccuracyCandidate {
  candidateUid: string
  name: string
  raw: Record<string, unknown>
  normalizedText: string
  eligible: boolean
}

export interface RequirementAccuracyLabel {
  datasetVersion: 'requirement-matching-accuracy-v1.5'
  seed: 'requirement-matching-v1.5-seed'
  queryId: string
  candidateUid: string
  domain: string
  candidateSlot: string
  scenario: string
  relevanceGrade: RequirementAccuracyGrade
  relation: RequirementAccuracyRelation
  hardConflictClass: string
  candidateEligible: boolean
  expectedDecisionStatus: string
  expectedReasonCode: string
  mayConfirm: boolean
}

export interface RequirementMatchingAccuracyDataset {
  schemaVersion: '1.0'
  datasetVersion: 'requirement-matching-accuracy-v1.5'
  seed: 'requirement-matching-v1.5-seed'
  queries: RequirementAccuracyQuery[]
  candidates: RequirementAccuracyCandidate[]
  labels: RequirementAccuracyLabel[]
  snapshotHash: string
}

export interface RequirementAccuracyRankedCandidate {
  candidateUid: string
  rank: number
  scenario: string
  relevanceGrade: RequirementAccuracyGrade
  candidateEligible: boolean
  expectedDecisionStatus: string
  expectedReasonCode: string
  decisionStatus: string
  hardConflictClass: string
}

export interface RequirementAccuracyMetricInput {
  queryResults: Array<{
    queryId: string
    rankedCandidates: RequirementAccuracyRankedCandidate[]
  }>
  businessWriteCount: number
  rerankerDegradationCount: number
  rankingStability: number
  entrypointConsistency: number
}

export interface RequirementAccuracyMetrics {
  exactRecallAt1: number
  exactRecallAt5: number
  exactRecallAt10: number
  exactRecallAt50: number
  exactRecallAt50Gate: number
  semanticRecallAt1: number
  semanticRecallAt5: number
  semanticRecallAt10: number
  semanticRecallAt50: number
  mrr: number
  dcgAt10: number
  idcgAt10: number
  ndcgAt10: number
  confirmedPrecision: number
  hardConflictFalseConfirmationRate: number
  businessWriteCount: number
  rerankerDegradationCount: number
  rankingStability: number
  entrypointConsistency: number
}

const DATASET_VERSION = 'requirement-matching-accuracy-v1.5' as const
const DEFAULT_SEED = 'requirement-matching-v1.5-seed' as const

const DOMAIN_TEMPLATES = [
  { id: 'requirement_management', alias: 'rm', title: '需求管理', objects: ['需求评审', '需求基线', '需求变更', '需求追踪'] },
  { id: 'configuration_management', alias: 'cm', title: '配置管理', objects: ['配置项', '版本基线', '变更记录', '发布清单'] },
  { id: 'defect_management', alias: 'dm', title: '缺陷管理', objects: ['缺陷登记', '缺陷分派', '缺陷验证', '缺陷统计'] },
  { id: 'data_sync', alias: 'ds', title: '数据同步', objects: ['增量采集', '定时同步', '失败重试', '同步监控'] },
  { id: 'permission_approval', alias: 'pa', title: '权限审批', objects: ['访问申请', '多级审批', '权限回收', '审批审计'] },
  { id: 'query_reporting', alias: 'qr', title: '查询报表', objects: ['组合查询', '统计报表', '状态看板', '结果导出'] }
] as const

type SlotTemplate = Omit<RequirementAccuracyLabel, 'datasetVersion' | 'seed' | 'queryId' | 'candidateUid' | 'domain'> & {
  slot: string
}

const SLOT_TEMPLATES: SlotTemplate[] = [
  { slot: 'S01', candidateSlot: 'S01', scenario: 'eligible_exact_duplicate', relevanceGrade: 4, relation: 'duplicate', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'confirmed', expectedReasonCode: 'EXACT_BUSINESS_HASH', mayConfirm: true },
  { slot: 'S02', candidateSlot: 'S02', scenario: 'format_only_equivalent', relevanceGrade: 4, relation: 'duplicate', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'confirmed', expectedReasonCode: 'EXACT_BUSINESS_HASH', mayConfirm: true },
  { slot: 'S03', candidateSlot: 'S03', scenario: 'highly_similar_same_object', relevanceGrade: 3, relation: 'highly_similar', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S04', candidateSlot: 'S04', scenario: 'highly_similar_adjacent_object', relevanceGrade: 3, relation: 'highly_similar', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S05', candidateSlot: 'S05', scenario: 'partial_overlap_shared_object', relevanceGrade: 2, relation: 'partial_overlap', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S06', candidateSlot: 'S06', scenario: 'partial_overlap_shared_constraint', relevanceGrade: 2, relation: 'partial_overlap', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S07', candidateSlot: 'S07', scenario: 'same_pattern_or_topic_only', relevanceGrade: 1, relation: 'same_pattern', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S08', candidateSlot: 'S08', scenario: 'topic_only', relevanceGrade: 1, relation: 'topic_only', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S09', candidateSlot: 'S09', scenario: 'action_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'action_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'ACTION_CONFLICT', mayConfirm: false },
  { slot: 'S10', candidateSlot: 'S10', scenario: 'object_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'object_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'OBJECT_CONFLICT', mayConfirm: false },
  { slot: 'S11', candidateSlot: 'S11', scenario: 'negation_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'negation_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'NEGATION_CONFLICT', mayConfirm: false },
  { slot: 'S12', candidateSlot: 'S12', scenario: 'identifier_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'identifier_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CONSTRAINT_CONFLICT', mayConfirm: false },
  { slot: 'S13', candidateSlot: 'S13', scenario: 'key_constraint_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'key_constraint_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CONSTRAINT_CONFLICT', mayConfirm: false },
  { slot: 'S14', candidateSlot: 'S14', scenario: 'missing_required_field', relevanceGrade: 0, relation: null, hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'ambiguous', expectedReasonCode: 'MISSING_REQUIRED_FIELD', mayConfirm: false },
  { slot: 'S15', candidateSlot: 'S15', scenario: 'candidate_ineligible', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: false, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CANDIDATE_INELIGIBLE', mayConfirm: false },
  { slot: 'S16', candidateSlot: 'S16', scenario: 'same_title_description_diff', relevanceGrade: 1, relation: 'same_pattern', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  ...Array.from({ length: 9 }, (_, index): SlotTemplate => {
    const n = index + 17
    const crossDomain = n >= 18 && n <= 21
    const scenario = n === 17
      ? 'long_unrelated_noise'
      : `${crossDomain ? 'cross_domain' : 'unrelated'}_distractor_0${crossDomain ? n - 17 : n - 21}`
    return {
      slot: `S${n}`,
      candidateSlot: `S${n}`,
      scenario,
      relevanceGrade: 0,
      relation: 'unrelated',
      hardConflictClass: 'none',
      candidateEligible: true,
      expectedDecisionStatus: 'suggested',
      expectedReasonCode: 'none',
      mayConfirm: false
    }
  })
]

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)])
  )
}

const snapshotHashFor = (dataset: Omit<RequirementMatchingAccuracyDataset, 'snapshotHash'>): string =>
  createHash('sha256').update(JSON.stringify(canonicalize(dataset))).digest('hex')

const candidateContent = (
  domainTitle: string,
  object: string,
  ordinal: number,
  slot: SlotTemplate
): { name: string; description: string } => {
  const base = `${domainTitle}${object}`
  const focus = `核心对象是${object}，所有处理均围绕${object}`
  const variants: Record<string, string> = {
    S01: `支持${base}。${focus}，记录责任人、时间和处理结果，并保留完整审计记录。`,
    S02: `<p>支持 ${base}；${focus}；记录责任人、时间与处理结果，并保留完整审计记录。</p>`,
    S03: `实现${base}流程。${focus}，保存经办人、处理时间、结论及审计信息。`,
    S04: `实现${domainTitle}中的${object}协同流程。${focus}，并记录处理过程和结论。`,
    S05: `${focus}，支持${object}的处理结果记录和查询。`,
    S06: `${focus}，支持${base}并保留处理时间，响应时间不超过三秒。`,
    S07: `提供${domainTitle}事项的标准化办理流程。`,
    S08: `建设${domainTitle}主题的数据服务。`,
    S09: `禁止执行${base}，不保存任何处理结果。`,
    S10: `支持${domainTitle}中的其他业务对象处理，与${object}无关。`,
    S11: `系统不得支持${base}，且必须删除历史处理记录。`,
    S12: `处理编号为REQ-${ordinal + 100}的${base}，编号不得变更。`,
    S13: `支持${base}，响应时间必须控制在十秒以内。`,
    S14: `记录责任人和处理结果，但业务对象信息缺失。`,
    S15: `已归档停用的${base}历史记录。`,
    S16: `${base}：用于另一个完全不同的展示说明。`
  }
  const description = variants[slot.slot] ?? `通用业务资料第${ordinal}项，用于其他部门的独立归档与查询。`
  return { name: `${base}历史记录${ordinal}`, description }
}

export const buildRequirementMatchingAccuracyDataset = (seed = DEFAULT_SEED): RequirementMatchingAccuracyDataset => {
  if (seed !== DEFAULT_SEED) throw new Error(`Unsupported dataset seed: ${seed}`)

  const queries: RequirementAccuracyQuery[] = []
  const candidates: RequirementAccuracyCandidate[] = []
  const labels: RequirementAccuracyLabel[] = []

  for (const domain of DOMAIN_TEMPLATES) {
    domain.objects.forEach((object, index) => {
      const ordinal = index + 1
      const queryId = `q-${domain.alias}-${String(ordinal).padStart(2, '0')}`
      const description = `支持${domain.title}${object}。核心对象是${object}，所有处理均围绕${object}，记录责任人、时间和处理结果，并保留完整审计记录。`
      queries.push({
        queryId,
        domain: domain.id,
        name: `${domain.title}${object}`,
        description,
        raw: { IssueType: 'Enhancement', _valm_ProductDomain: domain.title, _valm_Module: object, _valm_Description: description },
        normalizedText: `${domain.title} ${object} ${description}`
      })

      SLOT_TEMPLATES.forEach((slot, slotIndex) => {
        const candidateUid = `c-${queryId}-${slot.slot}`
        const content = candidateContent(domain.title, object, slotIndex + 1, slot)
        candidates.push({
          candidateUid,
          name: content.name,
          raw: {
            IssueType: 'Enhancement',
            _valm_ProductDomain: domain.title,
            _valm_Module: object,
            _valm_Name: content.name,
            _valm_Description: content.description,
            status: slot.candidateEligible ? 'active' : 'archived'
          },
          normalizedText: `${content.name} ${content.description}`,
          eligible: slot.candidateEligible
        })
        labels.push({
          datasetVersion: DATASET_VERSION,
          seed: DEFAULT_SEED,
          queryId,
          candidateUid,
          domain: domain.id,
          candidateSlot: slot.candidateSlot,
          scenario: slot.scenario,
          relevanceGrade: slot.relevanceGrade,
          relation: slot.relation,
          hardConflictClass: slot.hardConflictClass,
          candidateEligible: slot.candidateEligible,
          expectedDecisionStatus: slot.expectedDecisionStatus,
          expectedReasonCode: slot.expectedReasonCode,
          mayConfirm: slot.mayConfirm
        })
      })
    })
  }

  const withoutHash = {
    schemaVersion: '1.0' as const,
    datasetVersion: DATASET_VERSION,
    seed: DEFAULT_SEED,
    queries,
    candidates,
    labels
  }
  return { ...withoutHash, snapshotHash: snapshotHashFor(withoutHash) }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const searchableText = (candidate: Record<string, unknown>, field: 'name' | 'raw' | 'normalizedText'): string => {
  const value = candidate[field]
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

export const validateRequirementMatchingAccuracyDataset = (value: unknown): { ok: boolean; errors: string[] } => {
  const errors: string[] = []
  if (!isObject(value)) return { ok: false, errors: ['dataset must be an object'] }
  if (value.schemaVersion !== '1.0') errors.push('schemaVersion must be 1.0')
  if (value.datasetVersion !== DATASET_VERSION) errors.push(`datasetVersion must be ${DATASET_VERSION}`)
  if (value.seed !== DEFAULT_SEED) errors.push(`seed must be ${DEFAULT_SEED}`)

  const queries = Array.isArray(value.queries) ? value.queries.filter(isObject) : []
  const candidates = Array.isArray(value.candidates) ? value.candidates.filter(isObject) : []
  const labels = Array.isArray(value.labels) ? value.labels.filter(isObject) : []
  if (queries.length !== 24) errors.push('queries must contain exactly 24 records')
  if (candidates.length !== 600) errors.push('candidates must contain exactly 600 records')
  if (labels.length !== 600) errors.push('labels must contain exactly 600 local records')

  const queryIds = queries.map((query) => String(query.queryId ?? ''))
  const candidateUids = candidates.map((candidate) => String(candidate.candidateUid ?? ''))
  if (new Set(queryIds).size !== queryIds.length) errors.push('queryId values must be unique')
  if (new Set(candidateUids).size !== candidateUids.length) errors.push('candidateUid values must be unique')
  const querySet = new Set(queryIds)
  const candidateSet = new Set(candidateUids)

  for (const label of labels) {
    const queryId = String(label.queryId ?? '')
    const candidateUid = String(label.candidateUid ?? '')
    if (!querySet.has(queryId)) errors.push(`label references unknown queryId ${queryId}`)
    if (!candidateSet.has(candidateUid)) errors.push(`label references unknown candidateUid ${candidateUid}`)
    const grade = Number(label.relevanceGrade)
    if (!Number.isInteger(grade) || grade < 0 || grade > 4) errors.push(`invalid relevanceGrade for ${candidateUid}`)
  }

  const labelByCandidate = new Map(labels.map((label) => [String(label.candidateUid ?? ''), label]))
  for (const candidate of candidates) {
    const label = labelByCandidate.get(String(candidate.candidateUid ?? ''))
    if (!label) continue
    const forbidden = [
      label.candidateUid,
      label.queryId,
      label.candidateSlot,
      label.scenario,
      label.expectedReasonCode,
      label.hardConflictClass,
      value.datasetVersion,
      value.seed
    ].filter((item): item is string => typeof item === 'string' && item.length > 4 && item !== 'none')
    for (const field of ['name', 'raw', 'normalizedText'] as const) {
      const text = searchableText(candidate, field)
      if (forbidden.some((token) => text.includes(token))) {
        errors.push(`${field} contains audit label leak for ${String(candidate.candidateUid ?? '')}`)
      }
    }
  }

  const grade4ByQuery = new Set(labels.filter((label) => label.relevanceGrade === 4).map((label) => String(label.queryId)))
  for (const queryId of queryIds) {
    if (!grade4ByQuery.has(queryId)) errors.push(`query ${queryId} has no grade-4 candidate`)
  }
  const conflicts = new Set(labels.map((label) => String(label.hardConflictClass ?? '')))
  for (const required of ['action_conflict', 'object_conflict', 'negation_conflict', 'identifier_conflict', 'key_constraint_conflict']) {
    if (!conflicts.has(required)) errors.push(`missing hard-conflict class ${required}`)
  }

  if (typeof value.snapshotHash !== 'string') {
    errors.push('snapshotHash must be a string')
  } else {
    const { snapshotHash: _snapshotHash, ...withoutHash } = value
    const actual = createHash('sha256').update(JSON.stringify(canonicalize(withoutHash))).digest('hex')
    if (actual !== value.snapshotHash) errors.push('snapshotHash mismatch')
  }
  return { ok: errors.length === 0, errors }
}

const recallAt = (
  queryResults: RequirementAccuracyMetricInput['queryResults'],
  limit: number,
  relevant: (candidate: RequirementAccuracyRankedCandidate) => boolean
): number => {
  const candidates = queryResults.flatMap((result) => result.rankedCandidates)
  const relevantCandidates = candidates.filter(relevant)
  if (!relevantCandidates.length) return 0
  return relevantCandidates.filter((candidate) => candidate.rank <= limit).length / relevantCandidates.length
}

const queryHitRecallAt = (
  queryResults: RequirementAccuracyMetricInput['queryResults'],
  limit: number,
  relevant: (candidate: RequirementAccuracyRankedCandidate) => boolean
): number => {
  if (!queryResults.length) return 0
  return queryResults.filter((result) =>
    result.rankedCandidates.some((candidate) => candidate.rank <= limit && relevant(candidate))
  ).length / queryResults.length
}

const gain = (grade: number, rank: number): number => (2 ** grade - 1) / Math.log2(rank + 1)

export const calculateRequirementMatchingAccuracyMetrics = (input: RequirementAccuracyMetricInput): RequirementAccuracyMetrics => {
  const exact = (candidate: RequirementAccuracyRankedCandidate): boolean =>
    candidate.relevanceGrade === 4 && candidate.candidateEligible
  const semantic = (candidate: RequirementAccuracyRankedCandidate): boolean =>
    candidate.relevanceGrade >= 2 && candidate.candidateEligible

  const reciprocalRanks = input.queryResults.map((result) => {
    const first = result.rankedCandidates.filter(semantic).sort((left, right) => left.rank - right.rank)[0]
    return first ? 1 / first.rank : 0
  })
  const dcgValues = input.queryResults.map((result) =>
    result.rankedCandidates.filter((candidate) => candidate.rank <= 10).reduce((sum, candidate) => sum + gain(candidate.relevanceGrade, candidate.rank), 0)
  )
  const idcgValues = input.queryResults.map((result) =>
    [...result.rankedCandidates]
      .sort((left, right) => right.relevanceGrade - left.relevanceGrade)
      .slice(0, 10)
      .reduce((sum, candidate, index) => sum + gain(candidate.relevanceGrade, index + 1), 0)
  )
  const ndcgValues = dcgValues.map((dcg, index) => idcgValues[index] ? dcg / idcgValues[index]! : 0)
  const average = (values: number[]): number => values.length
    ? [...values].sort((left, right) => Math.abs(left) - Math.abs(right)).reduce((sum, value) => sum + value, 0) / values.length
    : 0

  const all = input.queryResults.flatMap((result) => result.rankedCandidates)
  const confirmed = all.filter((candidate) => candidate.decisionStatus === 'confirmed')
  const validConfirmed = confirmed.filter(exact)
  const hardConflicts = all.filter((candidate) => candidate.hardConflictClass !== 'none')
  const falseConfirmedConflicts = hardConflicts.filter((candidate) => candidate.decisionStatus === 'confirmed')
  const exactRecallAt50 = recallAt(input.queryResults, 50, exact)

  return {
    exactRecallAt1: recallAt(input.queryResults, 1, exact),
    exactRecallAt5: recallAt(input.queryResults, 5, exact),
    exactRecallAt10: recallAt(input.queryResults, 10, exact),
    exactRecallAt50,
    exactRecallAt50Gate: exactRecallAt50,
    semanticRecallAt1: queryHitRecallAt(input.queryResults, 1, semantic),
    semanticRecallAt5: queryHitRecallAt(input.queryResults, 5, semantic),
    semanticRecallAt10: queryHitRecallAt(input.queryResults, 10, semantic),
    semanticRecallAt50: queryHitRecallAt(input.queryResults, 50, semantic),
    mrr: average(reciprocalRanks),
    dcgAt10: average(dcgValues),
    idcgAt10: average(idcgValues),
    ndcgAt10: average(ndcgValues),
    confirmedPrecision: confirmed.length ? validConfirmed.length / confirmed.length : 1,
    hardConflictFalseConfirmationRate: hardConflicts.length ? falseConfirmedConflicts.length / hardConflicts.length : 0,
    businessWriteCount: input.businessWriteCount,
    rerankerDegradationCount: input.rerankerDegradationCount,
    rankingStability: input.rankingStability,
    entrypointConsistency: input.entrypointConsistency
  }
}

type GateMetrics = Pick<RequirementAccuracyMetrics,
  | 'exactRecallAt50'
  | 'confirmedPrecision'
  | 'hardConflictFalseConfirmationRate'
  | 'businessWriteCount'
  | 'rerankerDegradationCount'
  | 'rankingStability'
  | 'entrypointConsistency'
  | 'semanticRecallAt5'
  | 'mrr'
  | 'ndcgAt10'
>

export const evaluateRequirementMatchingAccuracyGates = (metrics: GateMetrics): { ok: boolean; errors: string[] } => {
  const errors: string[] = []
  if (metrics.exactRecallAt50 !== 1) errors.push('exactRecallAt50 must equal 1')
  if (metrics.confirmedPrecision !== 1) errors.push('confirmedPrecision must equal 1')
  if (metrics.hardConflictFalseConfirmationRate !== 0) errors.push('hardConflictFalseConfirmationRate must equal 0')
  if (metrics.businessWriteCount !== 0) errors.push('businessWriteCount must equal 0')
  if (metrics.rerankerDegradationCount !== 0) errors.push('rerankerDegradationCount must equal 0')
  if (metrics.rankingStability !== 1) errors.push('rankingStability must equal 1')
  if (metrics.entrypointConsistency !== 1) errors.push('entrypointConsistency must equal 1')
  if (metrics.semanticRecallAt5 < 0.9) errors.push('semanticRecallAt5 must be at least 0.90')
  if (metrics.mrr < 0.8) errors.push('mrr must be at least 0.80')
  if (metrics.ndcgAt10 < 0.85) errors.push('ndcgAt10 must be at least 0.85')
  return { ok: errors.length === 0, errors }
}
