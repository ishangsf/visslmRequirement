import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  buildRequirementMatchingAccuracyDataset,
  validateRequirementMatchingAccuracyDataset
} from '../../scripts/requirement-matching-accuracy'

const DATASET_VERSION = 'requirement-matching-accuracy-v1.5'
const SEED = 'requirement-matching-v1.5-seed'
const DOMAINS = [
  'requirement_management',
  'configuration_management',
  'defect_management',
  'data_sync',
  'permission_approval',
  'query_reporting'
] as const
const QUERY_IDS_BY_DOMAIN = {
  requirement_management: ['q-rm-01', 'q-rm-02', 'q-rm-03', 'q-rm-04'],
  configuration_management: ['q-cm-01', 'q-cm-02', 'q-cm-03', 'q-cm-04'],
  defect_management: ['q-dm-01', 'q-dm-02', 'q-dm-03', 'q-dm-04'],
  data_sync: ['q-ds-01', 'q-ds-02', 'q-ds-03', 'q-ds-04'],
  permission_approval: ['q-pa-01', 'q-pa-02', 'q-pa-03', 'q-pa-04'],
  query_reporting: ['q-qr-01', 'q-qr-02', 'q-qr-03', 'q-qr-04']
} as const
const HARD_CONFLICT_CLASSES = [
  'action_conflict',
  'object_conflict',
  'negation_conflict',
  'identifier_conflict',
  'key_constraint_conflict'
] as const

const SLOT_CONTRACTS = [
  { slot: 'S01', scenario: 'eligible_exact_duplicate', relevanceGrade: 4, relation: 'duplicate', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'confirmed', expectedReasonCode: 'EXACT_BUSINESS_HASH', mayConfirm: true },
  { slot: 'S02', scenario: 'format_only_equivalent', relevanceGrade: 4, relation: 'duplicate', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'confirmed', expectedReasonCode: 'EXACT_BUSINESS_HASH', mayConfirm: true },
  { slot: 'S03', scenario: 'highly_similar_same_object', relevanceGrade: 3, relation: 'highly_similar', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S04', scenario: 'highly_similar_adjacent_object', relevanceGrade: 3, relation: 'highly_similar', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S05', scenario: 'partial_overlap_shared_object', relevanceGrade: 2, relation: 'partial_overlap', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S06', scenario: 'partial_overlap_shared_constraint', relevanceGrade: 2, relation: 'partial_overlap', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S07', scenario: 'same_pattern_or_topic_only', relevanceGrade: 1, relation: 'same_pattern', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S08', scenario: 'topic_only', relevanceGrade: 1, relation: 'topic_only', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S09', scenario: 'action_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'action_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'ACTION_CONFLICT', mayConfirm: false },
  { slot: 'S10', scenario: 'object_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'object_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'OBJECT_CONFLICT', mayConfirm: false },
  { slot: 'S11', scenario: 'negation_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'negation_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'NEGATION_CONFLICT', mayConfirm: false },
  { slot: 'S12', scenario: 'identifier_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'identifier_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CONSTRAINT_CONFLICT', mayConfirm: false },
  { slot: 'S13', scenario: 'key_constraint_conflict', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'key_constraint_conflict', candidateEligible: true, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CONSTRAINT_CONFLICT', mayConfirm: false },
  { slot: 'S14', scenario: 'missing_required_field', relevanceGrade: 0, relation: null, hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'ambiguous', expectedReasonCode: 'MISSING_REQUIRED_FIELD', mayConfirm: false },
  { slot: 'S15', scenario: 'candidate_ineligible', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: false, expectedDecisionStatus: 'rejected', expectedReasonCode: 'CANDIDATE_INELIGIBLE', mayConfirm: false },
  { slot: 'S16', scenario: 'same_title_description_diff', relevanceGrade: 1, relation: 'same_pattern', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S17', scenario: 'long_unrelated_noise', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S18', scenario: 'cross_domain_distractor_01', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S19', scenario: 'cross_domain_distractor_02', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S20', scenario: 'cross_domain_distractor_03', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S21', scenario: 'cross_domain_distractor_04', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S22', scenario: 'unrelated_distractor_01', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S23', scenario: 'unrelated_distractor_02', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S24', scenario: 'unrelated_distractor_03', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false },
  { slot: 'S25', scenario: 'unrelated_distractor_04', relevanceGrade: 0, relation: 'unrelated', hardConflictClass: 'none', candidateEligible: true, expectedDecisionStatus: 'suggested', expectedReasonCode: 'none', mayConfirm: false }
] as const

type JsonObject = Record<string, unknown>

const asObjectList = (value: unknown, name: string): JsonObject[] => {
  assert.ok(Array.isArray(value), `${name} must be an array`)
  return value as JsonObject[]
}

const stringField = (value: JsonObject, field: string): string => {
  assert.equal(typeof value[field], 'string', `${field} must be a string`)
  return value[field] as string
}

const objectField = (value: JsonObject, field: string): JsonObject => {
  assert.ok(value[field] && typeof value[field] === 'object' && !Array.isArray(value[field]), `${field} must be an object`)
  return value[field] as JsonObject
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)])
  )
}

const snapshotHashFor = (dataset: JsonObject): string => {
  const withoutHash = { ...dataset }
  delete withoutHash.snapshotHash
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(withoutHash)))
    .digest('hex')
}

const first = buildRequirementMatchingAccuracyDataset(SEED)
const second = buildRequirementMatchingAccuracyDataset(SEED)

assert.equal(first.schemaVersion, '1.0')
assert.equal(first.datasetVersion, DATASET_VERSION)
assert.equal(first.seed, SEED)
assert.deepEqual(first, second, 'the same seed must produce the same dataset object')
assert.equal(JSON.stringify(first), JSON.stringify(second), 'the same seed must produce byte-identical JSON')

assert.equal(first.queries.length, 24)
assert.equal(first.candidates.length, 600)
assert.equal(first.labels.length, 600, 'only 24 x 25 local construction labels may be persisted')
assert.notEqual(first.labels.length, 14_400, 'cross-query relationships must not be materialized as stored labels')
assert.equal(first.snapshotHash, second.snapshotHash)
assert.match(first.snapshotHash, /^[0-9a-f]{64}$/)
// A literal golden hash cannot be derived before the generator freezes every candidate's canonical text bytes.
// At RED time, independently recomputing the canonical hash plus requiring byte-identical repeated output catches
// volatile data and hashing mistakes without copying an implementation-produced value back into its own test.
assert.equal(
  first.snapshotHash,
  snapshotHashFor(first as unknown as JsonObject),
  'snapshotHash must be the canonical SHA-256 of the dataset without the hash field'
)

const queries = asObjectList(first.queries, 'queries')
const candidates = asObjectList(first.candidates, 'candidates')
const labels = asObjectList(first.labels, 'labels')
const queryIds = queries.map((query) => stringField(query, 'queryId'))
const candidateUids = candidates.map((candidate) => stringField(candidate, 'candidateUid'))
const expectedQueryIds = Object.values(QUERY_IDS_BY_DOMAIN).flat()
const expectedCandidateUids = expectedQueryIds.flatMap((queryId) =>
  SLOT_CONTRACTS.map(({ slot }) => `c-${queryId}-${slot}`)
)
const LOCAL_LABELS_PER_QUERY = 25
const DERIVED_CROSS_QUERY_RELATIONSHIPS_PER_QUERY = 575
const DERIVED_CROSS_QUERY_RELATIONSHIP_COUNT = 13_800
const TOTAL_RUNTIME_RELATIONSHIP_COUNT = 14_400
const DERIVED_CROSS_QUERY_RELEVANCE_GRADE = 0
const DERIVED_CROSS_QUERY_RELATION = 'unrelated' as const

assert.equal(first.labels.length, first.queries.length * LOCAL_LABELS_PER_QUERY)
assert.equal(first.candidates.length - LOCAL_LABELS_PER_QUERY, DERIVED_CROSS_QUERY_RELATIONSHIPS_PER_QUERY)
assert.equal(first.queries.length * DERIVED_CROSS_QUERY_RELATIONSHIPS_PER_QUERY, DERIVED_CROSS_QUERY_RELATIONSHIP_COUNT)
assert.equal(first.labels.length + DERIVED_CROSS_QUERY_RELATIONSHIP_COUNT, TOTAL_RUNTIME_RELATIONSHIP_COUNT)

assert.equal(new Set(queryIds).size, queryIds.length, 'query ids must be unique')
assert.equal(new Set(candidateUids).size, candidateUids.length, 'candidate UIDs must be unique')
assert.deepEqual([...queryIds].sort(), [...expectedQueryIds].sort(), 'all 24 catalog query ids must be frozen')
assert.deepEqual([...candidateUids].sort(), [...expectedCandidateUids].sort(), 'candidate UIDs must follow c-{queryId}-{slotId}')
assert.deepEqual(
  [...new Set(queries.map((query) => stringField(query, 'domain')))].sort(),
  [...DOMAINS].sort(),
  'the dataset must cover exactly the six approved domains'
)

for (const domain of DOMAINS) {
  const actualDomainQueryIds = queries
    .filter((query) => stringField(query, 'domain') === domain)
    .map((query) => stringField(query, 'queryId'))
    .sort()
  assert.deepEqual(
    actualDomainQueryIds,
    [...QUERY_IDS_BY_DOMAIN[domain]].sort(),
    `${domain} must contain its four frozen query ids`
  )
}

const queryIdSet = new Set(queryIds)
const candidateUidSet = new Set(candidateUids)
const labelsByQuery = new Map<string, JsonObject[]>()
const labeledCandidateUids: string[] = []

for (const label of labels) {
  assert.equal(label.datasetVersion, DATASET_VERSION, 'every label must retain datasetVersion')
  assert.equal(label.seed, SEED, 'every label must retain seed')
  const queryId = stringField(label, 'queryId')
  const candidateUid = stringField(label, 'candidateUid')
  stringField(label, 'domain')
  stringField(label, 'candidateSlot')
  stringField(label, 'scenario')
  stringField(label, 'hardConflictClass')
  assert.ok(label.relation === null || typeof label.relation === 'string', 'relation must be a supported relation or null')
  assert.equal(typeof label.candidateEligible, 'boolean', 'candidateEligible must be a boolean')
  assert.equal(typeof label.mayConfirm, 'boolean', 'mayConfirm must be a boolean')
  stringField(label, 'expectedDecisionStatus')
  stringField(label, 'expectedReasonCode')
  assert.ok(queryIdSet.has(queryId), `label references unknown query ${queryId}`)
  assert.ok(candidateUidSet.has(candidateUid), `label references unknown candidate ${candidateUid}`)
  assert.ok(
    Number.isInteger(label.relevanceGrade) && Number(label.relevanceGrade) >= 0 && Number(label.relevanceGrade) <= 4,
    'relevanceGrade must be an integer from 0 to 4'
  )
  labeledCandidateUids.push(candidateUid)
  const queryLabels = labelsByQuery.get(queryId) ?? []
  queryLabels.push(label)
  labelsByQuery.set(queryId, queryLabels)
}

assert.equal(new Set(labeledCandidateUids).size, labeledCandidateUids.length, 'each candidate must have one deterministic label')
assert.deepEqual(new Set(labeledCandidateUids), candidateUidSet, 'labels must cover the complete candidate corpus')

for (const queryId of queryIds) {
  const queryLabels = labelsByQuery.get(queryId) ?? []
  assert.equal(queryLabels.length, 25, `query ${queryId} must have exactly 25 labeled candidates`)
  const crossQueryCandidateUids = candidateUids.filter((candidateUid) => !candidateUid.startsWith(`c-${queryId}-`))
  assert.equal(crossQueryCandidateUids.length, DERIVED_CROSS_QUERY_RELATIONSHIPS_PER_QUERY)
  assert.equal(
    queryLabels.filter((label) => crossQueryCandidateUids.includes(String(label.candidateUid))).length,
    0,
    `query ${queryId} must derive its ${DERIVED_CROSS_QUERY_RELATIONSHIPS_PER_QUERY} cross-query ` +
      `grade-${DERIVED_CROSS_QUERY_RELEVANCE_GRADE}/${DERIVED_CROSS_QUERY_RELATION} relationships at evaluation time`
  )
  const query = queries.find((item) => item.queryId === queryId)!
  const labelsBySlot = new Map(queryLabels.map((label) => [stringField(label, 'candidateSlot'), label]))
  assert.deepEqual(
    [...labelsBySlot.keys()].sort(),
    SLOT_CONTRACTS.map(({ slot }) => slot),
    `query ${queryId} must contain every slot from S01 through S25 exactly once`
  )

  for (const expected of SLOT_CONTRACTS) {
    const label = labelsBySlot.get(expected.slot)
    assert.ok(label, `query ${queryId} is missing ${expected.slot}`)
    assert.equal(label.datasetVersion, DATASET_VERSION)
    assert.equal(label.seed, SEED)
    assert.equal(label.queryId, queryId)
    assert.equal(label.candidateUid, `c-${queryId}-${expected.slot}`)
    assert.equal(label.domain, query.domain)
    assert.equal(label.candidateSlot, expected.slot)
    assert.equal(label.scenario, expected.scenario)
    assert.equal(label.relevanceGrade, expected.relevanceGrade)
    assert.equal(label.relation, expected.relation)
    assert.equal(label.hardConflictClass, expected.hardConflictClass)
    assert.equal(label.candidateEligible, expected.candidateEligible)
    assert.equal(label.expectedDecisionStatus, expected.expectedDecisionStatus)
    assert.equal(label.expectedReasonCode, expected.expectedReasonCode)
    assert.equal(label.mayConfirm, expected.mayConfirm)
  }

  const gradeDistribution = queryLabels.reduce<Record<number, number>>((counts, label) => {
    const grade = Number(label.relevanceGrade)
    counts[grade] = (counts[grade] ?? 0) + 1
    return counts
  }, {})
  assert.deepEqual(gradeDistribution, { 0: 16, 1: 3, 2: 2, 3: 2, 4: 2 }, `query ${queryId} grade distribution must be 2/2/2/3/16`)
}

const hardConflictClasses = new Set(
  labels
    .map((label) => label.hardConflictClass)
    .filter((value): value is string => typeof value === 'string' && value !== 'none')
)
assert.deepEqual(
  [...hardConflictClasses].sort(),
  [...HARD_CONFLICT_CLASSES].sort(),
  'all five hard-conflict classes must be represented'
)

assert.equal(validateRequirementMatchingAccuracyDataset(first).ok, true)

const assertAuditLeakRejected = (
  field: 'name' | 'raw' | 'normalizedText',
  inject: (candidate: JsonObject, label: JsonObject) => void
): void => {
  const leakingDataset = structuredClone(first) as unknown as JsonObject
  const leakingCandidate = asObjectList(leakingDataset.candidates, 'candidates')[0]!
  const auditLabel = asObjectList(leakingDataset.labels, 'labels')[0]!
  inject(leakingCandidate, auditLabel)
  leakingDataset.snapshotHash = snapshotHashFor(leakingDataset)

  const result = validateRequirementMatchingAccuracyDataset(leakingDataset)
  assert.equal(result.ok, false, `audit-label leakage through ${field} must invalidate the dataset`)
  assert.ok(
    result.errors.some((error) => error.includes(field) && /audit|label|leak/i.test(error)),
    `${field} leakage must return a field-specific audit-label error`
  )
}

assertAuditLeakRejected('name', (candidate, label) => {
  candidate.name = `${stringField(candidate, 'name')} ${stringField(label, 'candidateUid')}`
})
assertAuditLeakRejected('raw', (candidate, label) => {
  candidate.raw = {
    ...objectField(candidate, 'raw'),
    sourceDescription: stringField(label, 'scenario')
  }
})
assertAuditLeakRejected('normalizedText', (candidate, label) => {
  candidate.normalizedText = `${stringField(candidate, 'normalizedText')} ${stringField(label, 'expectedReasonCode')}`
})

console.log(JSON.stringify({
  ok: true,
  datasetVersion: first.datasetVersion,
  seed: first.seed,
  queryCount: first.queries.length,
  candidateCount: first.candidates.length,
  persistedLocalLabelCount: first.labels.length,
  derivedCrossQueryRelationshipCount: DERIVED_CROSS_QUERY_RELATIONSHIP_COUNT,
  derivedCrossQueryRelevanceGrade: DERIVED_CROSS_QUERY_RELEVANCE_GRADE,
  derivedCrossQueryRelation: DERIVED_CROSS_QUERY_RELATION,
  totalRuntimeRelationshipCount: TOTAL_RUNTIME_RELATIONSHIP_COUNT,
  domains: DOMAINS,
  hardConflictClasses: HARD_CONFLICT_CLASSES,
  snapshotHash: first.snapshotHash
}))
