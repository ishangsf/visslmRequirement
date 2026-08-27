# Requirement Matching Phase 3 Runs IPC and UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist immutable matching runs and candidate snapshots, expose them through versioned IPC contracts, and present ranked evidence-based suggestions in the project matching drawer.

**Architecture:** Replace destructive candidate replacement with append-only run/candidate tables and explicit run lifecycle methods. Project management starts a run and reads the latest compatible successful run; renderer APIs return run metadata plus paged candidates ordered by `finalRank`.

**Tech Stack:** TypeScript, better-sqlite3, Electron IPC/preload, React, Ant Design, existing `ResizableTable`, Node/Electron smoke scripts

**Spec:** `docs/superpowers/specs/2026-08-28-requirement-asset-matching-v1.1-design.md`

## Global Constraints

- Runs and candidate snapshots are append-only; rerunning never overwrites a prior run.
- Default reads use the latest successful, non-stale run compatible with the current requirement snapshot.
- Result order is `finalRank ASC`; rejected candidates are hidden unless diagnostics are explicitly requested.
- UI displays “综合匹配分”, never probability or accuracy language.
- LLM failure or reranker degradation is visible through run degradation codes.
- Tables keep resizable business columns, versioned width cache, responsive `scroll.y`, keyboard resize, and dark/light theme compatibility.
- The record-detail modal preserves drawer context and follows existing safe HTML rendering rules.

---

### Task 1: Add immutable run and candidate tables

**Files:**
- Modify: `src/main/database.ts:1669-1698,1860-1910`
- Modify: `src/main/requirements/requirement-match-domain.ts`
- Test: `tests/requirement-matching/run-repository-regression.ts`

**Interfaces:**
- Produces: `AppDatabase.createRequirementMatchRun(input): RequirementMatchRun`
- Produces: `AppDatabase.completeRequirementMatchRun(runId, candidates, degradationCodes): void`
- Produces: `AppDatabase.failRequirementMatchRun(runId, failureCode): void`
- Produces: `AppDatabase.markRequirementMatchRunsStale(requirementId?): void`
- Produces: `AppDatabase.getLatestCompatibleRequirementMatchRun(query): RequirementMatchRun | null`

- [ ] **Step 1: Write failing repository lifecycle tests**

Assert a new run is `running`, completion stores ordered candidates atomically, failure stores no partial candidates, a second run does not overwrite the first, and stale runs are excluded:

```ts
assert.equal(first.status, 'running')
db.completeRequirementMatchRun(first.id, candidates, [])
assert.equal(db.listRequirementMatchCandidates({ runId: first.id, page: 1, pageSize: 20 }).rows[0]?.finalRank, 1)
assert.equal(db.getRequirementMatchRun(first.id)?.status, 'succeeded')
assert.notEqual(second.id, first.id)
db.markRequirementMatchRunsStale(requirementId)
assert.equal(db.getLatestCompatibleRequirementMatchRun(query), null)
```

- [ ] **Step 2: Run the repository test**

Run: `npx tsx ./tests/requirement-matching/run-repository-regression.ts`

Expected: FAIL because run-level tables and methods are absent.

- [ ] **Step 3: Add tables and atomic lifecycle methods**

Create `pm_requirement_match_runs` with every version/hash/status field from the spec and `pm_requirement_match_candidates` with stage ranks/scores, final ranking, relation, decision, evidence, reason/evidence JSON, explanation, and record snapshot hash. Add indexes:

```sql
CREATE INDEX idx_pm_requirement_match_runs_latest
  ON pm_requirement_match_runs(requirement_id, status, completed_at DESC);
CREATE UNIQUE INDEX idx_pm_requirement_match_candidates_rank
  ON pm_requirement_match_candidates(run_id, final_rank);
CREATE UNIQUE INDEX idx_pm_requirement_match_candidates_record
  ON pm_requirement_match_candidates(run_id, record_uid);
```

Write candidates and transition `running -> succeeded` in one `BEGIN IMMEDIATE` transaction. On error, roll back the candidate insert and write `failed` in a separate statement.

- [ ] **Step 4: Run repository, migration, and type checks**

Run:

```powershell
npx tsx ./tests/requirement-matching/run-repository-regression.ts
npm run test:requirement-matching-safety
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit run-level persistence**

```powershell
git add -- src/main/database.ts src/main/requirements/requirement-match-domain.ts tests/requirement-matching/run-repository-regression.ts
git commit -m "feat: persist immutable requirement match runs"
```

---

### Task 2: Persist core results through an explicit run service

**Files:**
- Create: `src/main/requirements/requirement-match-run-service.ts`
- Modify: `src/main/project-management.ts:617-646,1677-1797`
- Modify: `src/main/record-maintenance.ts`
- Test: `tests/requirement-matching/run-service-regression.ts`

**Interfaces:**
- Consumes: `RequirementMatchingCore`, run repository methods
- Produces: `RequirementMatchRunService.start(input): Promise<{ runId: string }>`
- Produces: `RequirementMatchRunService.execute(runId): Promise<void>`
- Produces: `RequirementMatchRunService.markStaleForRecordChange(): void`

- [ ] **Step 1: Write failing success, failure, and snapshot-race tests**

Assert:

```ts
assert.equal(await repository.get(runId)?.status, 'succeeded')
assert.equal(repository.listCandidates(runId).length, coreResult.candidates.length)
assert.equal(repository.countFormalLinkWrites(runId), 0)
assert.equal(await runWithChangedRequirement().status, 'failed')
assert.equal(await runWithChangedRequirement().failureCode, 'REQUIREMENT_SNAPSHOT_CHANGED')
```

- [ ] **Step 2: Run the focused service test**

Run: `npx tsx ./tests/requirement-matching/run-service-regression.ts`

Expected: FAIL because the run service is absent.

- [ ] **Step 3: Implement start/execute lifecycle and compatibility checks**

At start, snapshot the requirement and all version/hash values, then persist `running`. Before completion, recompute the requirement snapshot hash; if changed, fail the run and store no candidates. Map core candidates directly without rescoring.

Replace project matching's legacy `replaceRequirementMatches()` call with:

```ts
const { runId } = await this.requirementMatchRuns.start(input)
void this.requirementMatchRuns.execute(runId)
return { ok: true, projectId, taskId: runId, message: '该需求的匹配任务已启动' }
```

Make record maintenance mark successful runs stale whenever the searchable record index changes.

- [ ] **Step 4: Run service and project smoke tests**

Run:

```powershell
npx tsx ./tests/requirement-matching/run-service-regression.ts
npm run smoke:project-management
npm run test:record-maintenance
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit run orchestration**

```powershell
git add -- src/main/requirements/requirement-match-run-service.ts src/main/project-management.ts src/main/record-maintenance.ts tests/requirement-matching/run-service-regression.ts
git commit -m "refactor: execute matching through immutable runs"
```

---

### Task 3: Replace the legacy IPC result contract

**Files:**
- Modify: `src/shared/project-types.ts:372-399,453-459`
- Modify: `src/shared/types.ts:1505-1527`
- Modify: `src/preload/index.ts:299-315`
- Modify: `src/main/index.ts:2760-2765`
- Modify: `src/main/project-management.ts:641-646`
- Test: `tests/requirement-matching/ipc-contract-regression.ts`

**Interfaces:**
- Produces: `ProjectRequirementMatchRunSummary`
- Produces: `ProjectRequirementMatchCandidate`
- Produces: `ProjectRequirementMatchPage { run, rows, total }`
- Produces: `ProjectRequirementMatchQuery { requirementId, runId?, page, pageSize, diagnostics? }`
- Removes after migration: `minScore` filtering and legacy `vectorScore/aiScore/scoreSource` from the renderer DTO

- [ ] **Step 1: Write a failing shared/preload contract test**

Assert result DTOs contain:

```ts
assert.equal(page.run.rankingVersion, 'requirement-ranking-v1-cross-encoder')
assert.equal(page.rows[0]?.finalRank, 1)
assert.equal(page.rows[0]?.rankingScore, 87.4)
assert.equal(page.rows[0]?.decisionStatus, 'suggested')
assert.deepEqual(page.rows[0]?.degradationCodes, [])
assert.equal('finalScore' in page.rows[0]!, false)
```

- [ ] **Step 2: Run the IPC contract test**

Run: `npx tsx ./tests/requirement-matching/ipc-contract-regression.ts`

Expected: FAIL because the legacy page has no run summary or final rank.

- [ ] **Step 3: Implement versioned query and result mapping**

Keep IPC channel names stable, but change payload types. Query `final_rank ASC`, exclude rejected rows unless `diagnostics === true`, and return the latest compatible run when `runId` is absent. Return `{ run: null, rows: [], total: 0 }` when no compatible successful run exists.

- [ ] **Step 4: Run IPC, project smoke, and typecheck**

Run:

```powershell
npx tsx ./tests/requirement-matching/ipc-contract-regression.ts
npm run smoke:project-management
npm run typecheck
```

Expected: all PASS with no renderer-facing legacy score fields.

- [ ] **Step 5: Commit IPC contracts**

```powershell
git add -- src/shared/project-types.ts src/shared/types.ts src/preload/index.ts src/main/index.ts src/main/project-management.ts tests/requirement-matching/ipc-contract-regression.ts
git commit -m "feat: expose requirement match run results"
```

---

### Task 4: Update the matching drawer to ranked evidence suggestions

**Files:**
- Modify: `src/renderer/src/project-management/ProjectManagementPage.tsx:690-1237,3295-3323,3508-3519`
- Modify: `src/renderer/src/styles.css`
- Test: `scripts/smoke-project-management-ui.mjs`
- Test: `scripts/smoke-project-matching-run-ui.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ProjectRequirementMatchPage { run, rows, total }`
- Displays: rank, comprehensive score, relation, decision status, evidence, degradation, link state
- Persists widths under `project-requirement-match-runs:v1`

- [ ] **Step 1: Add failing static UI contract checks**

Create `scripts/smoke-project-matching-run-ui.mjs` and assert source contains:

```js
assert.match(source, /综合匹配分/)
assert.match(source, /当前算法版本内的相对匹配程度，不代表统计概率/)
assert.match(source, /finalRank/)
assert.match(source, /decisionStatus/)
assert.match(source, /degradationCodes/)
assert.match(source, /project-requirement-match-runs:v1/)
assert.doesNotMatch(source, /匹配度\s*&gt;|minScore/)
```

Add:

```json
"smoke:project-matching-run-ui": "node ./scripts/smoke-project-matching-run-ui.mjs"
```

- [ ] **Step 2: Run the UI smoke and verify legacy UI fails**

Run: `npm run smoke:project-matching-run-ui`

Expected: FAIL because the drawer still uses threshold-oriented legacy fields.

- [ ] **Step 3: Implement the new drawer columns and run banner**

Use columns:

```ts
type MatchTableColumnKey = 'rank' | 'record' | 'score' | 'relation' | 'evidence' | 'asset'
```

Render score as `rankingScore.toFixed(1)` with Tooltip text explaining version-local relativity. Render decision status with text plus theme-state color. Show run version, completion time, and degradation warning above the table. Keep the existing record-detail opening behavior and manual link button.

Configure:

```tsx
scroll={{ x: computedWidth, y: 'clamp(280px, calc(100vh - 360px), 620px)' }}
```

Use theme variables only, preserve keyboard column resizing, and keep quantity plus unit on one line.

- [ ] **Step 4: Run UI smoke and typecheck**

Run:

```powershell
npm run smoke:project-matching-run-ui
npm run smoke:project-management-ui
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit the ranked evidence UI**

```powershell
git add -- src/renderer/src/project-management/ProjectManagementPage.tsx src/renderer/src/styles.css scripts/smoke-project-matching-run-ui.mjs scripts/smoke-project-management-ui.mjs package.json
git commit -m "feat: show ranked requirement match evidence"
```

---

### Task 5: Remove legacy match replacement and score-threshold storage

**Files:**
- Modify: `src/main/database.ts:4816-4862,5455-5562`
- Modify: `src/shared/project-types.ts:372-399`
- Modify: `src/main/project-management.ts`
- Modify: `scripts/smoke-project-management.ts`
- Test: `tests/requirement-matching/run-repository-regression.ts`

**Interfaces:**
- Removes: project-management uses of `replaceRequirementMatches`, `linkRequirementMatchesAboveScore`, `updateProjectRequirementAiStatus`
- Preserves: legacy table read only for export/history compatibility during one release cycle
- Makes current reads depend only on run/candidate tables

- [ ] **Step 1: Add a failing no-legacy-write assertion**

After a successful new run, assert:

```ts
assert.equal(db.countLegacyRequirementMatches(requirementId), 0)
assert.ok(db.listRequirementMatchCandidates({ runId, page: 1, pageSize: 20 }).total > 0)
assert.equal(db.listProjectAssets(projectId).length, 0)
```

- [ ] **Step 2: Run the repository regression**

Run: `npx tsx ./tests/requirement-matching/run-repository-regression.ts`

Expected: FAIL while the project adapter still dual-writes the legacy table.

- [ ] **Step 3: Remove new-run writes to legacy methods**

Delete production call sites for legacy replacement, auto-link, and AI status methods. Retain a clearly named `listLegacyRequirementMatchesForExport()` query only where historical export requires it; do not use it for current UI or Agent results.

- [ ] **Step 4: Run full Phase 3 verification**

Run:

```powershell
npm run typecheck
npm run test:requirement-matching-safety
npx tsx ./tests/requirement-matching/run-repository-regression.ts
npx tsx ./tests/requirement-matching/run-service-regression.ts
npx tsx ./tests/requirement-matching/ipc-contract-regression.ts
npm run smoke:project-management
npm run smoke:project-management-ui
npm run smoke:project-matching-run-ui
```

Expected: all PASS.

- [ ] **Step 5: Commit legacy write removal**

```powershell
git add -- src/main/database.ts src/shared/project-types.ts src/main/project-management.ts scripts/smoke-project-management.ts tests/requirement-matching/run-repository-regression.ts
git commit -m "refactor: retire legacy requirement match writes"
```

## Phase 3 Completion Gate

Accept Phase 3 only when a rerun creates a second immutable run, the UI defaults to the latest compatible successful run, historical runs remain queryable, a stale run is excluded, and no semantic candidate creates a formal link or status update.
