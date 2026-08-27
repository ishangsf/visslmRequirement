# Requirement Matching v1.5 Accuracy Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build VISSLM Agent 1.5.0 as a complete Windows installer, generate a deterministic project-requirement/history dataset, and validate the production matching pipeline with real local models and versioned automated metrics.

**Architecture:** A versioned scenario contract drives a deterministic data generator. A separate evaluator loads the generated corpus into an isolated `AppDatabase`, builds the real local embedding index through `KnowledgeService`, invokes `createRequirementMatchingCore` with explanations disabled, calculates hard safety gates and ranking metrics, and emits JSON evidence. The final installer is built from the integrated code and verified for version, resource provenance, startup, and project-matching availability before an independent testing agent repeats the acceptance checks.

**Tech Stack:** TypeScript 5.9, Node.js/tsx, Electron 43, electron-builder, SQLite/FTS5, `@huggingface/transformers`, local ONNX Embedding and CrossEncoder models, PowerShell on Windows.

**Spec:** `docs/superpowers/specs/2026-08-28-requirement-matching-v1.5-accuracy-validation-design.md`

## Global Constraints

- Target application version is exactly `1.5.0`; do not change the app id or installer naming pattern.
- Build the complete Windows installer with `npm run package`; `npm run build` alone is not an accepted release artifact.
- Generate exactly 24 project requirements and 600 historical candidate records from seed `requirement-matching-v1.5-seed`.
- Use the production matching core with real local Embedding and `Xenova/bge-reranker-base`; a fake reranker or `RERANKER_UNAVAILABLE` invalidates the run.
- Keep explanations disabled; LLM output cannot affect ranking or labels.
- Use only isolated temporary databases and user-data directories.
- Do not create a human evaluation corpus or treat historical links as labels.
- Do not call synthetic metrics open-domain business accuracy.
- Do not close the separate target-machine performance risk in this work.
- Root agent owns integration, acceptance, commits, and user communication. Child agents use `gpt-5.6-luna` with reasoning effort `max`, do not delegate, do not commit, and edit only their assigned scopes.

## File Structure

- Create `docs/requirement-matching-v1.5-scenario-catalog.md`: traceable PRD-style scenario matrix and label rules.
- Modify `package.json`: version `1.5.0` and new generator/evaluator/package-verification scripts.
- Modify `package-lock.json`: root package version `1.5.0` only, preserving dependency resolution.
- Create `scripts/requirement-matching-accuracy.ts`: dataset types, deterministic generator, schema validation, canonical hashing, metric calculation, and gate evaluation.
- Create `scripts/generate-requirement-matching-accuracy-data.ts`: CLI that materializes the versioned JSON dataset.
- Create `scripts/evaluate-requirement-matching-accuracy.ts`: isolated real-model production-core evaluator and JSON report writer.
- Create `scripts/verify-requirement-matching-package.mjs`: installer/unpacked-resource metadata and startup smoke verifier.
- Create `tests/requirement-matching/accuracy-dataset-regression.ts`: deterministic dataset and schema contract.
- Create `tests/requirement-matching/accuracy-metrics-regression.ts`: Recall/MRR/NDCG and gate-boundary tests.
- Create `tests/requirement-matching/package-version-regression.ts`: source/lock/artifact-name version contract.
- Create `test-data/requirement-matching/v1.5/accuracy-dataset.json`: generated 24-query/600-candidate corpus and labels.
- Create `test-data/requirement-matching/v1.5/accuracy-result.json`: final raw evaluation evidence.
- Create `docs/requirement-matching-v1.5-accuracy-report.md`: human-readable build and evaluation report.
- Create under ignored `release/`: `VISSLM-Agent-Setup-1.5.0.exe`, unpacked application, and package smoke output.

---

### Task 1: Freeze the business scenario contract (`prd`)

**Files:**
- Create: `docs/requirement-matching-v1.5-scenario-catalog.md`
- Read: `docs/superpowers/specs/2026-08-28-requirement-matching-v1.5-accuracy-validation-design.md`
- Read: `src/main/requirements/requirement-match-policy.ts`
- Read: `src/main/requirements/requirement-business-normalization.ts`

**Interfaces:**
- Consumes: approved design sections 6 and 8.
- Produces: six domain ids, 24 query ids, candidate scenario names, deterministic relevance grades `0..4`, hard-conflict flags, expected decision boundaries, and traceability to each acceptance metric.

- [ ] **Step 1: Write the catalog header and immutable generation contract**

Use these exact constants in the document:

```text
datasetVersion=requirement-matching-accuracy-v1.5
seed=requirement-matching-v1.5-seed
queryCount=24
candidateCount=600
domains=requirement_management,configuration_management,defect_management,data_sync,permission_approval,query_reporting
```

- [ ] **Step 2: Define the relation grade table**

Document grades `4=eligible_exact_duplicate`, `3=highly_similar`, `2=partial_overlap`, `1=same_pattern_or_topic_only`, and `0=unrelated_or_hard_conflict`. State that semantic grades are facts of the construction protocol, not human judgments about open-domain data.

- [ ] **Step 3: Define four query templates per domain and 25 candidate slots per query**

Each query must receive one eligible exact duplicate, one format-only equivalent, at least two grade-3 candidates, at least two grade-2 candidates, at least two grade-1 candidates, the five hard-conflict classes, and unrelated/cross-domain distractors filling the remaining slots. Cross-query records remain globally searchable so retrieval sees all 600 candidates.

- [ ] **Step 4: Map every catalog scenario to an acceptance check**

The matrix must map exact/format cases to Recall@50 and confirmed precision; conflicts to false-confirmation rate; semantic grades to Recall@K/MRR/NDCG; repeated queries to stability; and suggested/ambiguous/rejected cases to zero business writes.

- [ ] **Step 5: Validate the catalog**

Run:

```powershell
rg -n "datasetVersion|queryCount=24|candidateCount=600|eligible_exact_duplicate|hard-conflict|Recall@50|NDCG@10" docs/requirement-matching-v1.5-scenario-catalog.md
```

Expected: every required contract term is present and no unresolved marker or question remains.

- [ ] **Step 6: Return the PRD handoff**

Report changed files, scenario counts, traceability gaps, risks, and blockers. Do not edit code, tests, or package metadata and do not commit.

### Task 2: Add failing contracts for version, data, metrics, and package evidence (`testing`)

**Files:**
- Create: `tests/requirement-matching/package-version-regression.ts`
- Create: `tests/requirement-matching/accuracy-dataset-regression.ts`
- Create: `tests/requirement-matching/accuracy-metrics-regression.ts`
- Read: `docs/requirement-matching-v1.5-scenario-catalog.md`

**Interfaces:**
- Consumes: Task 1 dataset constants and grade semantics.
- Produces: executable contracts expected by Task 3; tests import `buildRequirementMatchingAccuracyDataset`, `validateRequirementMatchingAccuracyDataset`, `calculateRequirementMatchingAccuracyMetrics`, and `evaluateRequirementMatchingAccuracyGates` from `scripts/requirement-matching-accuracy.ts`.

- [ ] **Step 1: Write the failing package version contract**

```ts
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
assert.equal(pkg.version, '1.5.0')
assert.equal(lock.version, '1.5.0')
assert.equal(lock.packages[''].version, '1.5.0')
assert.equal(pkg.build.artifactName, 'VISSLM-Agent-Setup-${version}.${ext}')
console.log(JSON.stringify({ ok: true, version: pkg.version }))
```

- [ ] **Step 2: Run it and verify RED**

Run: `npx tsx ./tests/requirement-matching/package-version-regression.ts`

Expected: FAIL because the current version is `1.4.15`.

- [ ] **Step 3: Write the failing deterministic dataset contract**

Assert exact constants, unique query/candidate ids, six domains, 24 queries, 600 candidates, at least one grade-4 candidate per query, every hard-conflict class, stable canonical hash, and byte-identical output from two generator calls with the same seed.

```ts
const first = buildRequirementMatchingAccuracyDataset('requirement-matching-v1.5-seed')
const second = buildRequirementMatchingAccuracyDataset('requirement-matching-v1.5-seed')
assert.deepEqual(first, second)
assert.equal(first.queries.length, 24)
assert.equal(first.candidates.length, 600)
assert.equal(validateRequirementMatchingAccuracyDataset(first).ok, true)
```

- [ ] **Step 4: Write the failing metric-boundary contract**

Use a three-query miniature result with known ranks and verify Recall@1/5/10/50, reciprocal rank, DCG/IDCG, confirmed precision, false confirmations, degradation count, stability, and business-write count. Include explicit pass and fail boundaries:

```ts
assert.equal(evaluateRequirementMatchingAccuracyGates({
  exactRecallAt50: 1,
  confirmedPrecision: 1,
  hardConflictFalseConfirmationRate: 0,
  businessWriteCount: 0,
  rerankerDegradationCount: 0,
  rankingStability: 1,
  entrypointConsistency: 1,
  semanticRecallAt5: 0.90,
  mrr: 0.80,
  ndcgAt10: 0.85
}).ok, true)
```

Then lower each threshold one at a time and assert the corresponding gate error.

- [ ] **Step 5: Run dataset and metric tests and verify RED**

Run:

```powershell
npx tsx ./tests/requirement-matching/accuracy-dataset-regression.ts
npx tsx ./tests/requirement-matching/accuracy-metrics-regression.ts
```

Expected: both FAIL because `scripts/requirement-matching-accuracy.ts` does not exist.

- [ ] **Step 6: Return the testing handoff**

Report changed files, exact RED outputs, asserted boundaries, ambiguities, and blockers. Do not modify production code or package files and do not commit.

### Task 3: Implement versioning, deterministic data generation, metrics, and CLIs (`backend`)

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/requirement-matching-accuracy.ts`
- Create: `scripts/generate-requirement-matching-accuracy-data.ts`
- Create: `scripts/evaluate-requirement-matching-accuracy.ts`
- Create: `scripts/verify-requirement-matching-package.mjs`
- Test: `tests/requirement-matching/package-version-regression.ts`
- Test: `tests/requirement-matching/accuracy-dataset-regression.ts`
- Test: `tests/requirement-matching/accuracy-metrics-regression.ts`

**Interfaces:**
- Consumes: Task 1 catalog and Task 2 tests.
- Produces:

```ts
export type RequirementAccuracyGrade = 0 | 1 | 2 | 3 | 4
export interface RequirementMatchingAccuracyDataset {
  schemaVersion: '1.0'
  datasetVersion: 'requirement-matching-accuracy-v1.5'
  seed: 'requirement-matching-v1.5-seed'
  queries: RequirementAccuracyQuery[]
  candidates: RequirementAccuracyCandidate[]
  labels: RequirementAccuracyLabel[]
  snapshotHash: string
}
export function buildRequirementMatchingAccuracyDataset(seed?: string): RequirementMatchingAccuracyDataset
export function validateRequirementMatchingAccuracyDataset(value: unknown): { ok: boolean; errors: string[] }
export function calculateRequirementMatchingAccuracyMetrics(input: RequirementAccuracyMetricInput): RequirementAccuracyMetrics
export function evaluateRequirementMatchingAccuracyGates(metrics: RequirementAccuracyMetrics): { ok: boolean; errors: string[] }
```

- [ ] **Step 1: Change package and lock versions to `1.5.0`**

Only change `package.json.version`, `package-lock.json.version`, and `package-lock.json.packages[""].version`. Add scripts:

```json
"generate:requirement-matching-accuracy": "npx tsx ./scripts/generate-requirement-matching-accuracy-data.ts",
"eval:requirement-matching-accuracy": "npx tsx ./scripts/evaluate-requirement-matching-accuracy.ts",
"verify:requirement-matching-package": "node ./scripts/verify-requirement-matching-package.mjs"
```

- [ ] **Step 2: Run the version test and verify GREEN**

Run: `npx tsx ./tests/requirement-matching/package-version-regression.ts`

Expected: PASS with version `1.5.0`.

- [ ] **Step 3: Implement deterministic data types and generator**

Build six immutable domain templates with four query templates each. Generate exactly 25 uniquely identified candidates for each query, canonicalize objects by sorted keys, and calculate `snapshotHash` as SHA-256 over the dataset without the hash field. Never include `generatedAt` or another volatile value in the dataset.

- [ ] **Step 4: Implement schema validation**

Reject incorrect schema/dataset/seed values, duplicate ids, count mismatches, labels referencing unknown ids, grades outside `0..4`, missing hard-conflict classes, a query without grade 4, and a snapshot hash mismatch. Return all validation errors instead of stopping at the first one.

- [ ] **Step 5: Implement metric calculations**

Treat grade `>=2` as relevant for semantic Recall/MRR. Compute DCG as `sum((2 ** grade - 1) / log2(rank + 1))` and NDCG against each query's ideal ordering. Round only serialized display values; compare unrounded values to gates.

- [ ] **Step 6: Implement gate evaluation**

Require exact Recall@50 and confirmed precision `=== 1`, conflict false confirmation and business writes and reranker degradations `=== 0`, stability and entrypoint consistency `=== 1`, semantic Recall@5 `>= 0.90`, MRR `>= 0.80`, and NDCG@10 `>= 0.85`.

- [ ] **Step 7: Implement the generator CLI**

Support `--output`, defaulting to `test-data/requirement-matching/v1.5/accuracy-dataset.json`. Validate before writing, create only the parent directory, write pretty JSON with a trailing newline, then read it back and revalidate it.

- [ ] **Step 8: Implement the real-model evaluator CLI**

Support `--dataset`, `--output`, and `--repeat` (default `2`). For each run:

1. Create an isolated temp directory, `AppDatabase`, and `KnowledgeService`.
2. Insert all historical records with stable `raw` structured fields and cleaned `normalizedText`.
3. Call `knowledge.initialize()` and `knowledge.assertEmbeddingReady()`; verify all 600 records use `knowledge.modelVersion`.
4. Build the core with `createRequirementMatchingCore(db, knowledge, settings)`.
5. For each query call `core.match` with `explainTopN: 0` and `explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }`.
6. Assert `result.modelVersion === REQUIREMENT_RERANKER_MODEL_VERSION`, `result.degradationCodes` excludes `RERANKER_UNAVAILABLE`, and every reranked candidate contains a reranker rank and score.
7. Calculate metrics, compare repeat rankings, verify project/agent projection consistency, and report business writes as zero by querying link/status provenance before and after.
8. Always close the database, cancel knowledge tasks, and remove the temp directory in `finally`.

Exit nonzero on invalid data, model fallback, a failed hard/engineering gate, incomplete output, or cleanup failure.

- [ ] **Step 9: Implement package verification**

Accept `--installer`, `--unpacked`, `--output`, and `--smoke-timeout-ms`. Verify installer filename/version, calculate SHA-256 and byte size, read unpacked `resources/models/manifest.json`, validate the fixed embedding and CrossEncoder identities/hashes, launch `VISSLM Agent.exe` with an isolated user-data directory, wait for a stable process window, terminate only the launched process, and emit JSON. Do not install over the user's current application.

- [ ] **Step 10: Run Task 2 contracts and TypeScript**

Run:

```powershell
npx tsx ./tests/requirement-matching/package-version-regression.ts
npx tsx ./tests/requirement-matching/accuracy-dataset-regression.ts
npx tsx ./tests/requirement-matching/accuracy-metrics-regression.ts
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 11: Return the backend handoff**

Report changed files, commands and exact results, model/runtime assumptions, risks, and blockers. Do not edit generated JSON, reports, renderer files, or unrelated production code and do not commit.

### Task 4: Integrate and checkpoint the implementation (root)

**Files:**
- Inspect all files from Tasks 1–3.

**Interfaces:**
- Consumes: child handoffs and disjoint file changes from Tasks 1–3.
- Produces: one reviewed integration checkpoint suitable for release building.

- [ ] **Step 1: Inspect all diffs and reconcile contracts**

Verify type names, ids, counts, thresholds, script names, and output paths agree across catalog, tests, scripts, package metadata, and generated data. Reject overlapping or out-of-scope changes.

- [ ] **Step 2: Run focused verification**

```powershell
npm run typecheck
npx tsx ./tests/requirement-matching/package-version-regression.ts
npx tsx ./tests/requirement-matching/accuracy-dataset-regression.ts
npx tsx ./tests/requirement-matching/accuracy-metrics-regression.ts
npm run test:requirement-matching-gates
npm run smoke:project-management
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit the integrated tooling and data**

```powershell
git add -- package.json package-lock.json scripts/requirement-matching-accuracy.ts scripts/generate-requirement-matching-accuracy-data.ts scripts/evaluate-requirement-matching-accuracy.ts scripts/verify-requirement-matching-package.mjs tests/requirement-matching/package-version-regression.ts tests/requirement-matching/accuracy-dataset-regression.ts tests/requirement-matching/accuracy-metrics-regression.ts docs/requirement-matching-v1.5-scenario-catalog.md
git commit -m "test: add requirement matching v1.5 accuracy validation"
```

### Task 5: Build and verify the complete 1.5.0 installer (`testing`)

**Files:**
- Create under ignored directory: `release/VISSLM-Agent-Setup-1.5.0.exe`
- Create under ignored directory: `release/win-unpacked/**`
- Create under ignored directory: `release/requirement-matching-v1.5-package-report.json`
- Do not modify production code.

**Interfaces:**
- Consumes: Task 4 commit, local resource manifest, and package-verifier command.
- Produces: complete installer, package evidence, and a testing handoff before any versioned accuracy dataset is materialized.

- [ ] **Step 1: Verify a clean tracked tree and resource provenance**

Run:

```powershell
git status --short
npm run prepare:model -- --check
npm run verify:runtime-dependencies
```

Expected: no tracked changes, both resource checks pass, and the fixed CrossEncoder hash is present.

- [ ] **Step 2: Run complete pre-package verification**

Run all `tests/requirement-matching/*.ts` except helper-only modules, then `npm run typecheck`, `npm run smoke:project-management`, `npm run smoke:project-matching-run-ui`, and `npm run build`.

Expected: all commands exit 0.

- [ ] **Step 3: Build the complete installer**

Run: `npm run package`

Expected: exit 0 with `release/VISSLM-Agent-Setup-1.5.0.exe` and `release/win-unpacked/VISSLM Agent.exe` present.

- [ ] **Step 4: Verify the package and isolated startup**

Run:

```powershell
npm run verify:requirement-matching-package -- --installer release/VISSLM-Agent-Setup-1.5.0.exe --unpacked release/win-unpacked --output release/requirement-matching-v1.5-package-report.json
```

Expected: version, model-resource hashes, installer SHA-256, startup, and cleanup all pass.

- [ ] **Step 5: Return the package testing handoff**

Report installer path/size/SHA-256, package report, all commands and exact results, startup duration, risks, and blockers. Do not generate the accuracy dataset yet, fix production code, or commit.

### Task 6: Materialize data and execute real-model accuracy validation (`testing`)

**Files:**
- Create: `test-data/requirement-matching/v1.5/accuracy-dataset.json`
- Create: `test-data/requirement-matching/v1.5/accuracy-result.json`
- Modify only if a test contract defect exists: `tests/requirement-matching/accuracy-dataset-regression.ts`
- Read only: `scripts/requirement-matching-accuracy.ts`
- Read only: `scripts/generate-requirement-matching-accuracy-data.ts`
- Read only: `scripts/evaluate-requirement-matching-accuracy.ts`
- Read only: `release/requirement-matching-v1.5-package-report.json`

**Interfaces:**
- Consumes: verified Task 5 installer, Task 3 generator/evaluator, and Task 1 catalog.
- Produces: deterministic dataset, raw real-model accuracy report, and a testing handoff.

- [ ] **Step 1: Generate the dataset after the installer is verified**

Run:

```powershell
npm run generate:requirement-matching-accuracy -- --output test-data/requirement-matching/v1.5/accuracy-dataset.json
```

Expected: exit 0 and a report showing 24 queries, 600 candidates, six domains, seed, and snapshot hash.

- [ ] **Step 2: Verify byte stability and scenario coverage**

Run the generator a second time, verify `git diff --exit-code -- test-data/requirement-matching/v1.5/accuracy-dataset.json`, then run `npx tsx ./tests/requirement-matching/accuracy-dataset-regression.ts`. Produce counts by domain, grade, and conflict class; confirm every query has 25 labels and at least one grade-4 candidate.

- [ ] **Step 3: Run real-model accuracy evaluation**

Run:

```powershell
npm run eval:requirement-matching-accuracy -- --dataset test-data/requirement-matching/v1.5/accuracy-dataset.json --output test-data/requirement-matching/v1.5/accuracy-result.json --repeat 2
```

Expected: exit 0, `status=PASS`, no reranker degradation, all hard gates pass, semantic Recall@5 at least `0.90`, MRR at least `0.80`, and NDCG@10 at least `0.85`.

- [ ] **Step 4: Validate the raw report**

Run the schema/metric regression against the saved report, verify every query has a complete result, and confirm `modelVersion=bge-reranker-base-int8-local-v1`, the pipeline/ranking versions, dataset hash, code commit, and repeat stability are recorded.

- [ ] **Step 5: Return the accuracy testing handoff**

Report dataset path/size/hash and coverage, all commands and exact results, aggregate/relationship metrics, failed scenarios, runtime duration, package-report identity, risks, and blockers. Do not fix production code, rewrite thresholds, or commit.

### Task 7: Diagnose and fix failed acceptance gates if required (`backend`, conditional)

**Files:**
- Modify only the production/backend files directly implicated by a reproducible defect.
- Add or modify only the focused test identified by the root/testing handoff.
- Rebuild outputs remain under `release/`.

**Interfaces:**
- Consumes: an exact failing scenario, command, expected/actual result, and file/line evidence from Task 5 or 6.
- Produces: a minimal TDD fix or a documented non-code model limitation.

- [ ] **Step 1: Reproduce one failure without changing thresholds or data labels**

Run the smallest focused command and preserve the failing output.

- [ ] **Step 2: Add a regression test and verify RED**

The test must fail for the observed production behavior, not because a fixture or model is missing.

- [ ] **Step 3: Implement the minimal root-cause fix**

Do not broaden write permissions, weaken deterministic conflict handling, or make LLM output affect ranking.

- [ ] **Step 4: Verify GREEN and return a handoff**

Run the focused test, full requirement-matching tests, TypeScript, and relevant smoke. If the failure is a model capability limit rather than an implementation defect, make no production change and report `REJECTED/BLOCKED` evidence to the root.

- [ ] **Step 5: Root commits and returns to Tasks 5 and 6**

Use a focused commit message, delete old release outputs through the established safe cleanup path, rebuild from the new commit, and repeat every Task 5 and Task 6 step.

### Task 8: Write the final accuracy report (`testing`)

**Files:**
- Create: `docs/requirement-matching-v1.5-accuracy-report.md`
- Read: `test-data/requirement-matching/v1.5/accuracy-result.json`
- Read: `release/requirement-matching-v1.5-package-report.json`
- Read: `docs/requirement-matching-v1.5-scenario-catalog.md`

**Interfaces:**
- Consumes: final successful Task 5 and Task 6 evidence.
- Produces: traceable Markdown report with no unsupported accuracy claim.

- [ ] **Step 1: Record build provenance**

Include version, commit, timestamp, installer path, byte size, SHA-256, resource model revisions/hashes, Node/Electron versions, and exact build/verification commands with exit codes.

- [ ] **Step 2: Record dataset provenance and coverage**

Include dataset version, seed, snapshot hash, 24/600 counts, six domains, grade/conflict distributions, and the rule-derived-label limitation.

- [ ] **Step 3: Record all metrics and gate decisions**

Include Recall@1/5/10/50, MRR, NDCG@10, exact Recall@50, confirmed precision, conflict false confirmations, business writes, degradation count, stability, entrypoint consistency, per-domain/per-relation metrics, and failed scenario ids.

- [ ] **Step 4: State conclusion boundaries and residual risk**

Use the exact statement: “本报告验证构造业务场景下的技术准确性、安全性和排序稳定性，不代表开放域真实业务准确率。” Retain the target-machine performance gate as an unresolved independent release risk.

- [ ] **Step 5: Return the reporting handoff**

Report changed file, source evidence, any discrepancy between JSON and Markdown, risks, and blockers. Do not edit raw results, test data, thresholds, or production code and do not commit.

### Task 9: Independent acceptance review (`testing`, fresh child)

**Files:**
- Read only: all files changed since `7a0f672` plus final installer/package/evaluation reports.
- Do not edit any file.

**Interfaces:**
- Consumes: final integrated branch and all handoffs.
- Produces: independent findings ordered by Critical/Important/Minor, exact command outputs, and a recommended acceptance status.

- [ ] **Step 1: Review traceability and scope**

Map every design acceptance condition to code, data, command, and evidence. Flag unsupported claims, label leakage, fake-model paths, metric errors, missing query results, and package/source mismatches.

- [ ] **Step 2: Independently rerun critical commands**

Rerun dataset/metric/version contracts, all requirement-matching regressions, TypeScript, project-management smoke, package verification, and the real-model evaluator against the saved dataset using a separate output path.

- [ ] **Step 3: Compare independent and saved results**

Require matching dataset hash, model/pipeline/ranking identities, gate status, exact/safety metrics, and repeat-stable rankings. Explain any floating-point or runtime-only differences.

- [ ] **Step 4: Return the independent review handoff**

List findings first with file/line evidence, then commands/results, remaining risks, and recommendation `ACCEPTED`, `ACCEPTED_WITH_RISKS`, or `REJECTED/BLOCKED`. Do not commit or fix defects.

### Task 10: Final integration and delivery decision (root)

**Files:**
- Inspect all changes and reports.
- Commit accepted result data and Markdown report.

**Interfaces:**
- Consumes: Tasks 6–9 evidence and review.
- Produces: final verified branch, local installer artifact, and user-facing acceptance decision.

- [ ] **Step 1: Resolve all Critical and Important findings**

If fixes are needed, dispatch a scoped backend/testing cycle and repeat Tasks 6–9. Do not accept an unresolved Critical or Important defect.

- [ ] **Step 2: Run final verification from the final tree**

Run version/dataset/metrics contracts, all requirement-matching tests, TypeScript, project-management smoke, project-matching UI smoke, `npm run build`, package verification, and real-model evaluation. Record exact outputs.

- [ ] **Step 3: Commit final evidence**

```powershell
git add -- test-data/requirement-matching/v1.5/accuracy-dataset.json test-data/requirement-matching/v1.5/accuracy-result.json docs/requirement-matching-v1.5-accuracy-report.md
git commit -m "test: verify requirement matching accuracy for v1.5"
```

- [ ] **Step 4: Issue acceptance status**

Use `ACCEPTED` only if all design gates pass and no high-severity finding remains. Use `ACCEPTED_WITH_RISKS` when only explicitly bounded residual risks remain, including the deferred target-machine performance gate. Use `REJECTED/BLOCKED` for missing real models, failed engineering metrics, invalid packaging, or unresolved high-severity defects.
