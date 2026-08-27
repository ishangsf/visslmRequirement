# Requirement Matching Phase 2 Unified Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one deterministic, versioned matching core used by project management and the requirement-analysis Agent while preserving automatic retrieval and ranking.

**Architecture:** Introduce focused domain, normalization, policy, ranking, and orchestration modules around the existing Dense/BM25/RRF and CrossEncoder components. The core returns immutable in-memory results; Phase 2 adapts them to the existing read storage until Phase 3 adds run-level persistence.

**Tech Stack:** TypeScript, Node crypto, existing FTS5/vector retrieval, `@huggingface/transformers`, TSX contract regressions

**Spec:** `docs/superpowers/specs/2026-08-28-requirement-asset-matching-v1.1-design.md`

## Global Constraints

- Project management and the Agent must call the same `RequirementMatchingCore.match()` method.
- LLM output cannot change `rankingScore`, `finalRank`, or upgrade a decision to `confirmed`.
- Only an eligible exact business hash can produce `confirmed + duplicate`.
- `rankingScore` is `[0, 100]`, versioned, deterministic, and comparable only within one `rankingVersion`.
- CrossEncoder degradation uses a different `rankingVersion`.
- A hard conflict produces `rejected`, score 0, and no default-list entry.
- Phase 1 zero-business-write behavior remains in force.

---

### Task 1: Define the shared domain and input/output contracts

**Files:**
- Create: `src/main/requirements/requirement-match-domain.ts`
- Test: `tests/requirement-matching/domain-contract-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `MatchRelation`, `MatchDecisionStatus`, `MatchEvidenceLevel`
- Produces: `RequirementMatchRequest`, `RequirementMatchResult`, `RequirementMatchCandidateResult`
- Produces: `RequirementBusinessFacts`
- Produces: `RequirementMatchDegradationCode`

- [ ] **Step 1: Write the failing domain contract test**

Assert the exported enum arrays reject unknown values and the result shape supports stage ranks, score, decision, evidence, and explanation:

```ts
assert.deepEqual(MATCH_DECISION_STATUSES, ['confirmed', 'suggested', 'ambiguous', 'rejected'])
assert.equal(isMatchRelation('topic_only'), true)
assert.equal(isMatchRelation('related'), false)
assert.equal(isRankingScore(100), true)
assert.equal(isRankingScore(101), false)
```

Add:

```json
"test:requirement-matching-domain": "npx tsx ./tests/requirement-matching/domain-contract-regression.ts"
```

- [ ] **Step 2: Run the test and verify missing exports**

Run: `npm run test:requirement-matching-domain`

Expected: FAIL because `requirement-match-domain.ts` does not exist.

- [ ] **Step 3: Implement exact domain types**

Define:

```ts
export interface RequirementMatchRequest {
  base: RequirementMatchCard
  excludedUids: ReadonlySet<string>
  includeCurrentProjectRecords: boolean
  explainTopN: number
  explanationPolicy: {
    mode: 'disabled' | 'local' | 'online'
    allowExternalProcessing: boolean
  }
}

export interface RequirementBusinessFacts {
  action: string
  object: string
  constraints: string[]
  negated: boolean | null
  source: 'structured' | 'deterministic' | 'missing'
}

export interface RequirementMatchCandidateResult {
  recordUid: string
  finalRank: number
  rankingScore: number
  rankingVersion: string
  relation: MatchRelation
  decisionStatus: MatchDecisionStatus
  evidenceLevel: MatchEvidenceLevel
  reasonCodes: string[]
  degradationCodes: RequirementMatchDegradationCode[]
  stageScores: RequirementMatchStageScores
  explanation: string | null
}
```

Use readonly arrays as runtime validators for all string unions.

- [ ] **Step 4: Run the domain test and typecheck**

Run:

```powershell
npm run test:requirement-matching-domain
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 5: Commit the domain contract**

```powershell
git add -- src/main/requirements/requirement-match-domain.ts tests/requirement-matching/domain-contract-regression.ts package.json
git commit -m "feat: define requirement matching domain contract"
```

---

### Task 2: Version normalized business content and hashes

**Files:**
- Create: `src/main/requirements/requirement-business-normalization.ts`
- Modify: `src/main/requirements/requirement-match-card.ts:10-18,218-254`
- Modify: `src/main/database.ts:508-530,2032,2658`
- Test: `tests/requirement-matching/business-normalization-regression.ts`

**Interfaces:**
- Produces: `REQUIREMENT_NORMALIZATION_VERSION = 'requirement-business-v1'`
- Produces: `normalizeRequirementBusinessCard(card): NormalizedRequirementBusiness`
- Produces: `hashRequirementBusiness(normalized): string`
- Produces: `buildProjectRequirementMatchCard(requirement): RequirementMatchCard`
- Produces: `extractRequirementBusinessFacts(source): RequirementBusinessFacts`

- [ ] **Step 1: Write normalization invariance and conflict tests**

Cover HTML, whitespace, punctuation, field order, action changes, object changes, negation, and constraints:

```ts
assert.equal(hashOf('<p>查询 订单</p>'), hashOf('查询订单'))
assert.notEqual(hashOf('查询订单'), hashOf('删除订单'))
assert.notEqual(hashOf('允许导出'), hashOf('禁止导出'))
assert.notEqual(hashOf('响应时间 2 秒'), hashOf('响应时间 5 秒'))
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npx tsx ./tests/requirement-matching/business-normalization-regression.ts`

Expected: FAIL because the versioned normalization API is absent.

- [ ] **Step 3: Implement canonical serialization and SHA-256 hashing**

Return a fixed-key object:

```ts
type NormalizedRequirementBusiness = {
  title: string
  description: string
  requirementType: string
  productDomain: string
  module: string
  action: string
  object: string
  constraints: string[]
  negated: boolean | null
}
```

Extend `RequirementMatchCard` with `businessFacts: RequirementBusinessFacts`. Populate facts only from reviewed structured fields or a versioned deterministic alias/parser; never call a model. When action or object cannot be derived, set it to an empty string and `source: 'missing'`. Serialize keys in this declared order, sort normalized constraint values, and hash `version + '\n' + JSON.stringify(normalized)` with SHA-256. Move database uses of the private `requirementSourceHash` to the shared versioned function.

- [ ] **Step 4: Run normalization and current-index regressions**

Run:

```powershell
npx tsx ./tests/requirement-matching/business-normalization-regression.ts
npx tsx ./tests/requirement-matching/current-index-regression.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit versioned business hashing**

```powershell
git add -- src/main/requirements/requirement-business-normalization.ts src/main/requirements/requirement-match-card.ts src/main/database.ts tests/requirement-matching/business-normalization-regression.ts
git commit -m "refactor: version requirement business hashing"
```

---

### Task 3: Implement hard rules and the decision policy

**Files:**
- Create: `src/main/requirements/requirement-match-policy.ts`
- Modify: `src/main/requirements/requirement-match-scoring.ts:290-346,442-519`
- Test: `tests/requirement-matching/policy-regression.ts`
- Modify: `tests/requirement-matching/contract-regression.ts`

**Interfaces:**
- Produces: `evaluateRequirementMatchPolicy(base, candidate, context): RequirementMatchPolicyDecision`
- Produces: reason codes `EXACT_BUSINESS_HASH`, `MISSING_REQUIRED_FIELD`, `ACTION_CONFLICT`, `OBJECT_CONFLICT`, `NEGATION_CONFLICT`, `CONSTRAINT_CONFLICT`
- Replaces: no-op `applyRequirementMatchHardRules`

- [ ] **Step 1: Write failing policy matrix tests**

Use table cases that assert:

```ts
assertDecision(exactEligible, { relation: 'duplicate', decisionStatus: 'confirmed', rankingCap: 100 })
assertDecision(actionConflict, { relation: 'unrelated', decisionStatus: 'rejected', rankingCap: 0 })
assertDecision(missingAction, { decisionStatus: 'ambiguous', mayConfirm: false })
assertDecision(normalizedTextOnly, { relation: 'duplicate', decisionStatus: 'suggested', rankingCap: 99 })
```

- [ ] **Step 2: Run tests and verify the current no-op fails**

Run: `npx tsx ./tests/requirement-matching/policy-regression.ts`

Expected: FAIL because hard rules currently return the input decision unchanged.

- [ ] **Step 3: Implement explicit downgrade-only rules**

Use this context boundary:

```ts
export interface RequirementMatchPolicyContext {
  baseBusinessHash: string
  candidateBusinessHash: string
  normalizationVersionMatches: boolean
  candidateEligible: boolean
}
```

Evaluate candidate eligibility first, deterministic conflicts second, missing required fields third, and exact business hash last. Non-exact paths can return only `suggested`, `ambiguous`, or `rejected`.

- [ ] **Step 4: Run policy, contract, and v2 regressions**

Run:

```powershell
npx tsx ./tests/requirement-matching/policy-regression.ts
npx tsx ./tests/requirement-matching/contract-regression.ts
npx tsx ./tests/requirement-matching/v2-regression.ts
```

Expected: all PASS with updated explicit decision expectations.

- [ ] **Step 5: Commit the decision policy**

```powershell
git add -- src/main/requirements/requirement-match-policy.ts src/main/requirements/requirement-match-scoring.ts tests/requirement-matching/policy-regression.ts tests/requirement-matching/contract-regression.ts
git commit -m "feat: enforce requirement match decision policy"
```

---

### Task 4: Add the versioned ranking manifest and deterministic scorer

**Files:**
- Create: `src/main/requirements/requirement-ranking.ts`
- Create: `src/main/requirements/requirement-ranking-manifest.ts`
- Test: `tests/requirement-matching/ranking-regression.ts`

**Interfaces:**
- Produces: `RequirementRankingManifest`
- Produces: `hashRequirementRankingManifest(manifest): string`
- Produces: `FULL_RERANK_RANKING_VERSION = 'requirement-ranking-v1-cross-encoder'`
- Produces: `FALLBACK_RANKING_VERSION = 'requirement-ranking-v1-rrf-fallback'`
- Produces: `rankRequirementCandidates(inputs, manifest): RankedRequirementMatch[]`

- [ ] **Step 1: Write failing score-boundary and stability tests**

Assert:

```ts
assert.equal(score(exactConfirmed).rankingScore, 100)
assert.equal(score(rejected).rankingScore, 0)
assert.ok(score(normalizedTextOnly).rankingScore <= 99)
assert.ok(score(highReranker).rankingScore >= score(lowReranker).rankingScore)
assert.deepEqual(rank(tied).map((x) => x.recordUid), ['a', 'b'])
assert.notEqual(full.rankingVersion, fallback.rankingVersion)
```

- [ ] **Step 2: Run the focused ranking test**

Run: `npx tsx ./tests/requirement-matching/ranking-regression.ts`

Expected: FAIL because the ranking modules are absent.

- [ ] **Step 3: Implement a manifest-driven scorer**

Define all component transforms and weights in one frozen manifest. Compute:

```ts
const base = weightedRrf + weightedReranker + deterministicAgreement
const rankingScore = clamp(0, policy.rankingCap, Math.round(base * 10) / 10)
```

Apply exact/rejected fixed values before normal scoring. Sort by score descending, reranker rank ascending, fused rank ascending, then UID ascending; assign contiguous `finalRank` values.
Canonicalize and SHA-256 hash the manifest. Expose that hash to the run layer as part of `configHash`; a weight, transform, cap, tie-break, or model change without a `rankingVersion` change must fail the ranking contract test.

- [ ] **Step 4: Run ranking and policy tests**

Run:

```powershell
npx tsx ./tests/requirement-matching/ranking-regression.ts
npx tsx ./tests/requirement-matching/policy-regression.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit ranking contracts**

```powershell
git add -- src/main/requirements/requirement-ranking.ts src/main/requirements/requirement-ranking-manifest.ts tests/requirement-matching/ranking-regression.ts
git commit -m "feat: add versioned requirement ranking"
```

---

### Task 5: Build the unified orchestration core

**Files:**
- Create: `src/main/requirements/requirement-matching-core.ts`
- Modify: `src/main/requirements/hybrid-retrieval.ts:36-80`
- Modify: `src/main/requirements/requirement-match-explainer.ts:11-31,333-482`
- Test: `tests/requirement-matching/core-regression.ts`

**Interfaces:**
- Consumes: retriever, reranker, policy, ranking manifest, optional explainer
- Consumes: exact-business-hash lookup and candidate eligibility callback
- Produces: `RequirementMatchingCore.match(request): Promise<RequirementMatchResult>`
- Produces: `degradationCodes` values `RERANKER_UNAVAILABLE`, `EXPLAINER_UNAVAILABLE`, `EXPLANATION_PROTOCOL_ERROR`

- [ ] **Step 1: Write a failing end-to-end core test with fakes**

Construct deterministic fake retriever, reranker, and explainer. Assert Top50 retrieval, Top20 rerank, Top10 explanation, stable ranking, and explanation non-authority:

```ts
assert.equal(result.candidates.length, 50)
assert.equal(rerankedUids.length, 20)
assert.equal(explainedUids.length, 10)
assert.equal(result.candidates[0]?.finalRank, 1)
assert.equal(result.candidates[0]?.rankingScore, scoreBeforeExplanation)
assert.notEqual(result.candidates[0]?.decisionStatus, 'confirmed')
```

Add separate cases proving an eligible exact-hash candidate omitted by both retrieval branches is injected into Top50, an ineligible candidate is rejected, and online explanation is skipped without explicit external-processing consent.

- [ ] **Step 2: Run the core regression**

Run: `npx tsx ./tests/requirement-matching/core-regression.ts`

Expected: FAIL because `RequirementMatchingCore` is absent.

- [ ] **Step 3: Implement the pipeline in one orchestration method**

Use dependency injection:

```ts
export class RequirementMatchingCore {
  constructor(private readonly deps: RequirementMatchingDependencies) {}
  async match(request: RequirementMatchRequest): Promise<RequirementMatchResult> { /* pipeline */ }
}
```

Catch reranker failure and switch to the fallback manifest. Catch explanation failure, append a degradation code, and preserve candidate ordering and decisions. Reject unknown explanation UIDs through the existing strict parser.

Before retrieval, resolve exact-hash candidates and inject eligible records into the fused candidate map. Apply only filters backed by current record/project fields: record existence, current searchable index membership, explicit UID exclusions, and the request's current-project policy. Do not invent permission or lifecycle columns.

Invoke an online explainer only when both `mode === 'online'` and `allowExternalProcessing === true`; otherwise add no online request. Pass only normalized business fields and bounded evidence segments to the explainer, excluding raw JSON and unrelated metadata.

- [ ] **Step 4: Run core, v2, and Agent smoke tests**

Run:

```powershell
npx tsx ./tests/requirement-matching/core-regression.ts
npx tsx ./tests/requirement-matching/v2-regression.ts
npm run smoke:agent-requirement-analysis
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit the unified core**

```powershell
git add -- src/main/requirements/requirement-matching-core.ts src/main/requirements/hybrid-retrieval.ts src/main/requirements/requirement-match-explainer.ts tests/requirement-matching/core-regression.ts
git commit -m "feat: add unified requirement matching core"
```

---

### Task 6: Route project management and Agent through the same core

**Files:**
- Modify: `src/main/experts/requirement-analysis-agent.ts:343-454`
- Modify: `src/main/project-management.ts:353-361,1761-1797`
- Modify: `src/main/index.ts:2955-2961`
- Test: `tests/requirement-matching/entrypoint-consistency-regression.ts`
- Modify: `scripts/smoke-project-management.ts`
- Modify: `scripts/smoke-agent-requirement-analysis.ts`

**Interfaces:**
- Consumes: singleton `RequirementMatchingCore`
- Project adapter persists `rankingScore` temporarily into legacy `final_score` only until Phase 3
- Agent adapter maps the same candidate results to its answer/data-view format without rescoring

- [ ] **Step 1: Write a failing cross-entry consistency test**

Feed the same base requirement, candidates, exclusions, and core fakes into both adapters. Assert:

```ts
assert.deepEqual(
  projectRows.map(({ recordUid, finalRank, rankingScore, relation }) => ({ recordUid, finalRank, rankingScore, relation })),
  agentRows.map(({ recordUid, finalRank, rankingScore, relation }) => ({ recordUid, finalRank, rankingScore, relation }))
)
```

- [ ] **Step 2: Run the consistency test and expose divergent pipelines**

Run: `npx tsx ./tests/requirement-matching/entrypoint-consistency-regression.ts`

Expected: FAIL because project management still calls `rankRecordMatches()` and performs separate model review.

- [ ] **Step 3: Inject and use one core instance**

Construct the core once in `src/main/index.ts`. Replace project management's `buildRequirementMatchQuery -> rankRecordMatches -> reviewRequirementMatches` flow with `core.match()`. Replace the Agent's local retrieve/rerank/score/explain sequence with the same call and adapter-only formatting.

Keep the Phase 1 rule:

```ts
await this.matchingCore.match(request)
// persist suggestion rows only; no asset link or requirement status write
```

- [ ] **Step 4: Run all matching entrypoint checks**

Run:

```powershell
npx tsx ./tests/requirement-matching/entrypoint-consistency-regression.ts
npm run smoke:project-management
npm run smoke:agent-requirement-analysis
npx tsx ./tests/requirement-matching/contract-regression.ts
npm run typecheck
```

Expected: all PASS and both entry points return identical ranking contracts.

- [ ] **Step 5: Commit shared entrypoint routing**

```powershell
git add -- src/main/experts/requirement-analysis-agent.ts src/main/project-management.ts src/main/index.ts tests/requirement-matching/entrypoint-consistency-regression.ts scripts/smoke-project-management.ts scripts/smoke-agent-requirement-analysis.ts
git commit -m "refactor: unify requirement matching entrypoints"
```

## Phase 2 Completion Gate

Run:

```powershell
npm run typecheck
npm run test:requirement-matching-domain
npx tsx ./tests/requirement-matching/business-normalization-regression.ts
npx tsx ./tests/requirement-matching/policy-regression.ts
npx tsx ./tests/requirement-matching/ranking-regression.ts
npx tsx ./tests/requirement-matching/core-regression.ts
npx tsx ./tests/requirement-matching/entrypoint-consistency-regression.ts
npx tsx ./tests/requirement-matching/contract-regression.ts
npx tsx ./tests/requirement-matching/current-index-regression.ts
npx tsx ./tests/requirement-matching/v2-regression.ts
npm run smoke:project-management
npm run smoke:agent-requirement-analysis
```

Accept Phase 2 only when the same fixture produces the same `recordUid`, `finalRank`, `rankingScore`, relation, and decision status through both entry points.
