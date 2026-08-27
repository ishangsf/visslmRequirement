# Requirement Matching Phase 1 Safety and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop score-driven business writes, preserve existing links and statuses with explicit legacy provenance, and prove that semantic suggestions cannot mutate business state.

**Architecture:** Keep the current matching read model operational, but separate candidate persistence from asset/status mutation. Add provenance columns additively, backfill legacy values without unlinking or resetting records, and make all user-initiated links explicitly manual.

**Tech Stack:** TypeScript, Electron IPC, better-sqlite3, TSX regression scripts, Node assert

**Spec:** `docs/superpowers/specs/2026-08-28-requirement-asset-matching-v1.1-design.md`

## Global Constraints

- Do not auto-link an asset from `finalScore`, `rankingScore`, model output, or a configurable threshold.
- Do not auto-change a requirement to `satisfied` from a match result.
- Preserve existing links and status values; migration changes provenance only.
- Existing unknown links become `legacy_unknown`; existing AI status provenance becomes `legacy_unverified`.
- A user link uses `manual`; an exact-hash system link is reserved for Phase 2.
- Do not edit unrelated dirty-worktree files or reverse existing user changes.

---

### Task 1: Add provenance contracts and additive migration

**Files:**
- Modify: `src/shared/project-types.ts:1-6,223-240`
- Modify: `src/main/database.ts:1583-1698,1860-1910,5360-5370`
- Test: `tests/requirement-matching/safety-stopgap-regression.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `ProjectRequirementStatusSource = 'ai' | 'manual' | 'system_rule' | 'legacy_unverified'`
- Produces: `ProjectAssetLinkSource = 'manual' | 'exact_business_hash' | 'legacy_unknown'`
- Produces: `ProjectAsset.linkSource`, `ProjectAsset.confirmedBy`, `ProjectAsset.confirmedAt`, `ProjectAsset.matchRunId`
- Produces: the same provenance fields on `ProjectAssetRequirement`
- Produces: one-time migration marker `requirementMatching.provenanceMigration = 'v1'`

- [ ] **Step 1: Write the migration regression and make it fail**

Create `tests/requirement-matching/safety-stopgap-regression.ts` with a temporary database that inserts one legacy project asset, one requirement association, and one `status_source = 'ai'` requirement before reopening the database. Assert:

```ts
assert.equal(asset.linkSource, 'legacy_unknown')
assert.equal(asset.confirmedBy, '')
assert.equal(asset.requirements[0]?.linkSource, 'legacy_unknown')
assert.equal(requirement.status, 'satisfied')
assert.equal(requirement.statusSource, 'legacy_unverified')
```

Add the script:

```json
"test:requirement-matching-safety": "npx tsx ./tests/requirement-matching/safety-stopgap-regression.ts"
```

- [ ] **Step 2: Run the new test and confirm the missing contract**

Run: `npm run test:requirement-matching-safety`

Expected: FAIL because provenance fields and `legacy_unverified` do not exist.

- [ ] **Step 3: Add types, columns, and idempotent backfill**

Add shared contracts:

```ts
export type ProjectRequirementStatusSource = 'ai' | 'manual' | 'system_rule' | 'legacy_unverified'
export type ProjectAssetLinkSource = 'manual' | 'exact_business_hash' | 'legacy_unknown'
```

Add these columns through the existing idempotent migration block, then run the provenance backfill only when `requirementMatching.provenanceMigration` is not `v1`:

```sql
ALTER TABLE pm_project_assets ADD COLUMN link_source TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE pm_project_assets ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE pm_project_assets ADD COLUMN confirmed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE pm_project_assets ADD COLUMN match_run_id TEXT;
ALTER TABLE pm_project_asset_requirements ADD COLUMN link_source TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE pm_project_asset_requirements ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE pm_project_asset_requirements ADD COLUMN confirmed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE pm_project_asset_requirements ADD COLUMN match_run_id TEXT;
UPDATE pm_requirements SET status_source = 'legacy_unverified' WHERE status_source = 'ai';
```

Set the migration marker only after the columns and backfill succeed. On later startups, skip the backfill so a future explicit `ai` value cannot be silently reclassified. Map the new columns in `listProjectAssets()` without changing status or deleting links. Extend the regression to reopen the database twice and verify manual/system provenance remains unchanged.

- [ ] **Step 4: Run the migration regression**

Run: `npm run test:requirement-matching-safety`

Expected: PASS with the original `satisfied` status and links preserved.

- [ ] **Step 5: Commit the provenance migration**

```powershell
git add -- src/shared/project-types.ts src/main/database.ts tests/requirement-matching/safety-stopgap-regression.ts package.json
git commit -m "refactor: add requirement link provenance"
```

---

### Task 2: Make user asset links explicitly manual

**Files:**
- Modify: `src/main/database.ts:6135-6156`
- Modify: `src/main/project-management.ts:754-763`
- Test: `tests/requirement-matching/safety-stopgap-regression.ts`

**Interfaces:**
- Consumes: `ProjectAssetLinkSource` from Task 1
- Produces: `AppDatabase.linkProjectAsset(projectId, recordUid, requirementId?, provenance?)`
- Produces: default provenance `{ linkSource: 'manual', confirmedBy: 'local-user' }`

- [ ] **Step 1: Add failing manual-link assertions**

Extend the regression to call the public project service link method and assert:

```ts
assert.equal(linked?.linkSource, 'manual')
assert.equal(linked?.confirmedBy, 'local-user')
assert.ok(linked?.confirmedAt)
assert.equal(linked?.requirements[0]?.linkSource, 'manual')
```

- [ ] **Step 2: Run the focused regression**

Run: `npm run test:requirement-matching-safety`

Expected: FAIL because newly inserted links retain the legacy default.

- [ ] **Step 3: Write provenance on both association tables**

Use this optional database input:

```ts
type ProjectAssetLinkProvenance = {
  linkSource: ProjectAssetLinkSource
  confirmedBy: string
  confirmedAt?: string
  matchRunId?: string
}
```

Default the service call to:

```ts
const provenance = {
  linkSource: 'manual' as const,
  confirmedBy: 'local-user'
}
return this.db.linkProjectAsset(projectId, recordUid, normalizedRequirementId, provenance)
```

Insert identical provenance into `pm_project_assets` and `pm_project_asset_requirements`. On conflict, do not overwrite a pre-existing manual confirmation with weaker provenance.

- [ ] **Step 4: Run focused and project smoke tests**

Run:

```powershell
npm run test:requirement-matching-safety
npm run smoke:project-management
```

Expected: both commands PASS.

- [ ] **Step 5: Commit manual provenance writes**

```powershell
git add -- src/main/database.ts src/main/project-management.ts tests/requirement-matching/safety-stopgap-regression.ts
git commit -m "refactor: mark project asset links as manual"
```

---

### Task 3: Remove score-triggered asset and requirement mutations

**Files:**
- Modify: `src/main/project-management.ts:1761-1794`
- Test: `scripts/smoke-project-management.ts:541-580`
- Test: `tests/requirement-matching/safety-stopgap-regression.ts`

**Interfaces:**
- Preserves: `replaceRequirementMatches(requirementId, matches)` for the Phase 1 read model
- Removes from matching execution: `linkRequirementMatchesAboveScore(...)`
- Removes from matching execution: `updateProjectRequirementAiStatus(...)`

- [ ] **Step 1: Replace the unsafe smoke expectation with zero-write assertions**

For a candidate with `finalScore = 80` and no model review, assert after matching:

```ts
assert.equal(db.listProjectAssets(projectId).length, 0)
const after = db.getProjectRequirement(requirementId)
assert.equal(after?.status, before?.status)
assert.equal(after?.statusSource, before?.statusSource)
assert.equal(db.listProjectRequirementMatches({ requirementId, page: 1, pageSize: 20 }).total, 1)
```

- [ ] **Step 2: Run the smoke test and verify it exposes current behavior**

Run: `npm run smoke:project-management`

Expected: FAIL because the current pipeline auto-links the 80-point candidate or changes status provenance.

- [ ] **Step 3: Remove both business-write calls from matching execution**

Keep candidate persistence, but end `matchRequirement()` after:

```ts
this.db.replaceRequirementMatches(requirement.id, matches)
```

Do not call the score-threshold linker or AI status updater from matching. Leave those database methods temporarily present for compatibility; mark them unused and remove them in Phase 3 after the new run model is active.

- [ ] **Step 4: Run safety, project, and type checks**

Run:

```powershell
npm run test:requirement-matching-safety
npm run smoke:project-management
npm run typecheck
```

Expected: all commands PASS; candidate rows remain available and business state remains unchanged.

- [ ] **Step 5: Commit the safety stopgap**

```powershell
git add -- src/main/project-management.ts scripts/smoke-project-management.ts tests/requirement-matching/safety-stopgap-regression.ts
git commit -m "fix: prevent semantic matches from mutating project state"
```

---

### Task 4: Surface legacy status provenance without changing workflows

**Files:**
- Modify: `src/renderer/src/project-management/ProjectManagementPage.tsx:3514-3519`
- Modify: `src/renderer/src/styles.css`
- Test: `scripts/smoke-project-management-ui.mjs`

**Interfaces:**
- Consumes: `ProjectRequirement.statusSource`
- Produces: user-facing source labels `人工标记`, `系统规则`, `历史 AI 结果待复核`, `AI 初判`

- [ ] **Step 1: Add failing UI source-label checks**

Extend the static UI smoke to assert the source mapping contains:

```js
assert.match(source, /legacy_unverified.*历史 AI 结果待复核/s)
assert.match(source, /system_rule.*系统规则/s)
```

- [ ] **Step 2: Run the UI smoke and confirm failure**

Run: `npm run smoke:project-management-ui`

Expected: FAIL because the two provenance labels are not rendered.

- [ ] **Step 3: Add an explicit source-label mapping and warning style**

Use a total mapping:

```ts
const requirementStatusSourceLabel: Record<ProjectRequirementStatusSource, string> = {
  manual: '人工标记',
  system_rule: '系统规则',
  legacy_unverified: '历史 AI 结果待复核',
  ai: 'AI 初判'
}
```

Render `legacy_unverified` with `--state-warning`, `--surface-soft`, and `--stroke`; do not introduce fixed light backgrounds.

- [ ] **Step 4: Run UI smoke, project smoke, and typecheck**

Run:

```powershell
npm run smoke:project-management-ui
npm run smoke:project-management
npm run typecheck
```

Expected: all commands PASS.

- [ ] **Step 5: Commit Phase 1 UI provenance**

```powershell
git add -- src/renderer/src/project-management/ProjectManagementPage.tsx src/renderer/src/styles.css scripts/smoke-project-management-ui.mjs
git commit -m "feat: show legacy requirement status provenance"
```

## Phase 1 Completion Gate

Run:

```powershell
npm run typecheck
npm run test:requirement-matching-safety
npm run smoke:project-management
npm run smoke:project-management-ui
```

Accept Phase 1 only when all commands exit 0 and the regression proves that an 80-point semantic candidate creates no asset link and changes no requirement status.
