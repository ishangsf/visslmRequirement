# Requirement Matching Phase 4 Automated Quality and Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce zero-human automated safety, determinism, consistency, and performance gates, then switch both product entry points from shadow execution to the v1.1 read path.

**Architecture:** Use deterministic fact fixtures and generated metamorphic variants rather than human labels. Add a persisted rollout mode under project matching settings, run the new core in shadow mode without changing reads, compare safe technical contracts, and permit `v1_1` cutover only after all hard gates pass.

**Tech Stack:** TypeScript, TSX regression scripts, JSON fixtures, existing SettingsService, benchmark scripts, Electron/React settings UI

**Spec:** `docs/superpowers/specs/2026-08-28-requirement-asset-matching-v1.1-design.md`

## Global Constraints

- Automated gates do not claim real business semantic accuracy.
- Exact eligible duplicate `Recall@50` must equal 100%.
- Protocol, UID, evidence, index-version, and snapshot failures produce zero formal business writes.
- Replays with identical data and versions produce identical ranking and decisions.
- P95 end-to-end latency regression is at most 20%; peak memory regression is at most 25% against a fixed baseline profile.
- Synthetic paraphrase, weak supervision, and model consensus are trend metrics only.
- Rollout order is `legacy_safe -> shadow -> v1_1`; rollback from `v1_1` targets `legacy_safe` and never restores unsafe auto-writes.

---

### Task 1: Create deterministic fact fixtures and metamorphic variants

**Files:**
- Create: `test-data/requirement-matching/v1.1/deterministic-facts.json`
- Create: `tests/requirement-matching/metamorphic-fixtures.ts`
- Create: `tests/requirement-matching/metamorphic-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: fixture facts `exact_duplicate`, `format_only`, `action_conflict`, `object_conflict`, `negation_conflict`, `constraint_conflict`, `missing_required_field`, `irrelevant_padding`
- Produces: `buildMetamorphicCases(seed): MetamorphicRequirementCase[]`

- [ ] **Step 1: Write the failing metamorphic test harness**

Load fixed facts and assert:

```ts
assert.equal(exactDuplicate.decisionStatus, 'confirmed')
assert.equal(exactDuplicate.rankingScore, 100)
assert.equal(formatOnly.businessHash, seed.businessHash)
assert.notEqual(actionConflict.businessHash, seed.businessHash)
assert.equal(actionConflict.decisionStatus, 'rejected')
assert.notEqual(missingRequiredField.decisionStatus, 'confirmed')
```

Add:

```json
"test:requirement-matching-metamorphic": "npx tsx ./tests/requirement-matching/metamorphic-regression.ts"
```

- [ ] **Step 2: Run the metamorphic test**

Run: `npm run test:requirement-matching-metamorphic`

Expected: FAIL because fixture generation is absent.

- [ ] **Step 3: Implement deterministic transformations**

Generate format-only changes by HTML wrapping, whitespace, punctuation, and field-order changes. Generate semantic conflicts by replacing only the declared action, object, negation, or numeric constraint field. Never use an LLM to generate hard-gate fixtures.

- [ ] **Step 4: Run metamorphic, policy, and normalization tests**

Run:

```powershell
npm run test:requirement-matching-metamorphic
npx tsx ./tests/requirement-matching/policy-regression.ts
npx tsx ./tests/requirement-matching/business-normalization-regression.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit deterministic fixtures**

```powershell
git add -- test-data/requirement-matching/v1.1/deterministic-facts.json tests/requirement-matching/metamorphic-fixtures.ts tests/requirement-matching/metamorphic-regression.ts package.json
git commit -m "test: add deterministic requirement match fixtures"
```

---

### Task 2: Enforce safety, replay, Recall@50, and entrypoint consistency gates

**Files:**
- Create: `tests/requirement-matching/automated-quality-gates.ts`
- Modify: `tests/requirement-matching/entrypoint-consistency-regression.ts`
- Modify: `tests/requirement-matching/core-regression.ts`
- Modify: `src/main/requirements/requirement-match-domain.ts`
- Modify: `src/main/requirements/requirement-matching-core.ts`
- Modify: `src/main/requirements/requirement-match-run-service.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run test:requirement-matching-gates`
- Consumes: immutable run repository and deterministic fixtures

- [ ] **Step 1: Write failing aggregate hard gates**

Implement assertions:

```ts
assert.equal(exactEligibleRetrieved / exactEligibleTotal, 1)
assert.equal(formalBusinessWritesAfterProtocolFailures, 0)
assert.equal(successfulRunsWithIndexMismatch, 0)
assert.deepEqual(replayA.candidates, replayB.candidates)
assert.deepEqual(projectProjection, agentProjection)
assert.equal(unversionedManifestAccepted, false)
```

Inject unknown UID, invalid evidence, malformed JSON, index mismatch, changed requirement snapshot, missing reranker, and missing explainer cases.

- [ ] **Step 2: Run the aggregate gate and verify uncovered failures**

Run: `npx tsx ./tests/requirement-matching/automated-quality-gates.ts`

Expected: FAIL until every hard-gate branch has explicit handling.

- [ ] **Step 3: Wire missing fault codes without weakening assertions**

Add only the production guards required by failing cases. Each failure maps to one stable code and zero formal writes:

```ts
type RequirementMatchFailureCode =
  | 'INDEX_VERSION_MISMATCH'
  | 'REQUIREMENT_SNAPSHOT_CHANGED'
  | 'NORMALIZATION_VERSION_UNAVAILABLE'
  | 'RANKING_VERSION_UNAVAILABLE'
  | 'CANDIDATE_PERSISTENCE_FAILED'
  | 'ACCESS_DENIED'
```

Do not catch these errors and report success.

- [ ] **Step 4: Add and run the aggregate package script**

Add:

```json
"test:requirement-matching-gates": "npx tsx ./tests/requirement-matching/automated-quality-gates.ts"
```

Run:

```powershell
npm run test:requirement-matching-gates
npm run test:requirement-matching-metamorphic
npm run test:requirement-matching-safety
```

Expected: all PASS.

- [ ] **Step 5: Commit automated hard gates**

```powershell
git add -- tests/requirement-matching/automated-quality-gates.ts tests/requirement-matching/entrypoint-consistency-regression.ts tests/requirement-matching/core-regression.ts src/main/requirements/requirement-match-domain.ts src/main/requirements/requirement-matching-core.ts src/main/requirements/requirement-match-run-service.ts package.json
git commit -m "test: enforce requirement matching quality gates"
```

---

### Task 3: Turn the benchmark into an end-to-end versioned performance gate

**Files:**
- Modify: `scripts/benchmark-requirement-matching.ts`
- Create: `test-data/requirement-matching/v1.1/performance-baseline.json`
- Create: `tests/requirement-matching/performance-contract-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: benchmark modes `retrieval`, `rerank`, `end-to-end-local`, `end-to-end-with-explainer`
- Produces: report fields `hardwareProfile`, `dataSnapshotHash`, `pipelineVersion`, `rankingVersion`, `modelHash`, `includesModelLoad`, `p50Ms`, `p95Ms`, `peakMemoryMb`
- Produces: `--baseline`, `--write-baseline`, and `--enforce` options

- [ ] **Step 1: Write a failing benchmark report contract test**

Assert the report rejects missing phase declarations and enforces relative regressions:

```ts
assert.equal(validateReport(reportWithoutModelFlags).ok, false)
assert.equal(compare({ p95Ms: 121 }, { p95Ms: 100 }).ok, false)
assert.equal(compare({ peakMemoryMb: 126 }, { peakMemoryMb: 100 }).ok, false)
assert.equal(compare({ p95Ms: 120, peakMemoryMb: 125 }, baseline).ok, true)
```

- [ ] **Step 2: Run the performance contract test**

Run: `npx tsx ./tests/requirement-matching/performance-contract-regression.ts`

Expected: FAIL because benchmark metadata and enforcement are incomplete.

- [ ] **Step 3: Implement explicit benchmark phases and baseline comparison**

Make report-only mode non-gating. Make `--enforce` require a baseline with matching hardware, data, pipeline, ranking, and model hashes. Exit nonzero when P95 exceeds 120% or memory exceeds 125% of baseline. A synthetic run without a real reranker must identify itself as `retrieval` and cannot satisfy the end-to-end gate.

- [ ] **Step 4: Record the baseline and verify enforcement**

Run on the designated target hardware:

```powershell
npm run benchmark:requirement-matching -- --mode end-to-end-local --records 5000 --write-baseline test-data/requirement-matching/v1.1/performance-baseline.json
npm run benchmark:requirement-matching -- --mode end-to-end-local --records 5000 --baseline test-data/requirement-matching/v1.1/performance-baseline.json --enforce
npx tsx ./tests/requirement-matching/performance-contract-regression.ts
```

Expected: baseline file contains all required hashes; enforcement and contract test PASS.

- [ ] **Step 5: Commit performance gates**

```powershell
git add -- scripts/benchmark-requirement-matching.ts test-data/requirement-matching/v1.1/performance-baseline.json tests/requirement-matching/performance-contract-regression.ts package.json
git commit -m "test: gate requirement matching performance"
```

---

### Task 4: Add safe rollout settings and shadow comparisons

**Files:**
- Modify: `src/shared/types.ts:120-132`
- Modify: `src/main/settings.ts:30,108-110,196-198`
- Modify: `src/main/project-management.ts`
- Modify: `src/main/experts/requirement-analysis-agent.ts`
- Modify: `src/renderer/src/App.tsx:10068-10303`
- Test: `tests/requirement-matching/rollout-regression.ts`

**Interfaces:**
- Produces: `RequirementMatchingRolloutMode = 'legacy_safe' | 'shadow' | 'v1_1'`
- Produces: `ProjectMatchingSettings.rolloutMode`
- Produces: shadow comparison fields `candidateOverlapAt20`, `rankCorrelation`, `decisionDriftCount`, `businessWriteCount`

- [ ] **Step 1: Write failing rollout-state tests**

Assert:

```ts
assert.equal(normalizeRolloutMode('invalid'), 'legacy_safe')
assert.equal(shadow.primaryReadPath, 'legacy_safe')
assert.equal(shadow.newPipelinePersisted, true)
assert.equal(shadow.businessWriteCount, 0)
assert.equal(v11.primaryReadPath, 'v1_1')
assert.equal(rollback.primaryReadPath, 'legacy_safe')
```

- [ ] **Step 2: Run the rollout regression**

Run: `npx tsx ./tests/requirement-matching/rollout-regression.ts`

Expected: FAIL because rollout mode is absent.

- [ ] **Step 3: Persist and enforce safe rollout modes**

Store `projectMatching.rolloutMode`. In `shadow`, run and persist v1.1 results but return the legacy-safe read result; record only technical comparison metrics and no business writes. In `v1_1`, both project management and Agent read the latest compatible v1.1 run. Rollback changes only the read mode and never re-enables Phase 1 removed auto-writes.

Add a settings select with labels “安全旧链路”“影子验证”“v1.1 正式链路” and an explanatory warning that mode changes do not alter historical links.

- [ ] **Step 4: Run rollout, settings, and entrypoint checks**

Run:

```powershell
npx tsx ./tests/requirement-matching/rollout-regression.ts
npx tsx ./tests/requirement-matching/entrypoint-consistency-regression.ts
npm run smoke:project-management
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit safe rollout control**

```powershell
git add -- src/shared/types.ts src/main/settings.ts src/main/project-management.ts src/main/experts/requirement-analysis-agent.ts src/renderer/src/App.tsx tests/requirement-matching/rollout-regression.ts
git commit -m "feat: add safe requirement matching rollout"
```

---

### Task 5: Document evidence limits and execute the cutover gate

**Files:**
- Modify: `README.md:229-241`
- Modify: `docs/02-requirements.md:378-379`
- Modify: `docs/04-module-design.md:128,206`
- Modify: `docs/05-database-design.md:526-593`
- Modify: `docs/06-api-design.md:121-151`
- Modify: `docs/07-development-guide.md:136-142`
- Modify: `src/shared/types.ts:120-132`
- Modify: `src/main/settings.ts:30,108-110,196-198`
- Modify: `tests/requirement-matching/rollout-regression.ts`
- Create: `docs/requirement-matching-v1.1-verification-report.md`

**Interfaces:**
- Produces: a verification report containing exact commands, exit codes, hard-gate results, performance baseline identifiers, risks, and rollout decision
- Sets rollout to `v1_1` only after every gate below passes

- [ ] **Step 1: Update documentation to match shipped behavior**

Document:

- automatic history retrieval and version-local `rankingScore` ordering;
- no semantic score auto-linking or auto-satisfied status;
- immutable runs and latest-compatible-run reads;
- the exact-hash confirmation exception;
- automated gates prove deterministic facts and safety, not open-domain business accuracy;
- rollout and rollback modes.

- [ ] **Step 2: Run the full functional and hard-gate suite**

Run:

```powershell
npm run typecheck
npm run test:requirement-matching-safety
npm run test:requirement-matching-domain
npm run test:requirement-matching-metamorphic
npm run test:requirement-matching-gates
npx tsx ./tests/requirement-matching/run-repository-regression.ts
npx tsx ./tests/requirement-matching/run-service-regression.ts
npx tsx ./tests/requirement-matching/ipc-contract-regression.ts
npx tsx ./tests/requirement-matching/rollout-regression.ts
npx tsx ./tests/requirement-matching/contract-regression.ts
npx tsx ./tests/requirement-matching/current-index-regression.ts
npx tsx ./tests/requirement-matching/formal-match-regression.ts
npx tsx ./tests/requirement-matching/v2-regression.ts
npm run smoke:project-management
npm run smoke:project-management-ui
npm run smoke:project-matching-run-ui
npm run smoke:agent-requirement-analysis
```

Expected: every command exits 0.

- [ ] **Step 3: Run the end-to-end performance gate**

Run:

```powershell
npm run benchmark:requirement-matching -- --mode end-to-end-local --records 5000 --baseline test-data/requirement-matching/v1.1/performance-baseline.json --enforce
```

Expected: exit 0, matching baseline identities, P95 regression at most 20%, and memory regression at most 25%.

- [ ] **Step 4: Write the verification report and switch mode**

Record each command, exit code, run timestamp, commit, pipeline/ranking/model hashes, Recall@50, zero-write checks, P95, memory, remaining risks, and acceptance status in `docs/requirement-matching-v1.1-verification-report.md`. Only after the report records all gates as passing, change the default for an unset rollout setting to `v1_1`; preserve an explicitly saved `legacy_safe` or `shadow` choice. Invalid stored values must still fail safe to `legacy_safe`.

- [ ] **Step 5: Commit documentation and verification evidence**

```powershell
git add -- README.md docs/02-requirements.md docs/04-module-design.md docs/05-database-design.md docs/06-api-design.md docs/07-development-guide.md docs/requirement-matching-v1.1-verification-report.md src/shared/types.ts src/main/settings.ts tests/requirement-matching/rollout-regression.ts
git commit -m "docs: record requirement matching v1.1 verification"
```

## Phase 4 Completion Gate

Accept the overall refactor only when the verification report proves all hard gates and target-hardware performance gates passed, both entry points use the same v1.1 results, rollout mode is `v1_1`, rollback remains `legacy_safe`, and no unresolved high-severity defect exists. Because no human evaluation set is used, report semantic quality as an explicit residual risk rather than as a measured accuracy percentage.
