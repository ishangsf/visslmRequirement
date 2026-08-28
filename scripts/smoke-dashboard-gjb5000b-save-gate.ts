import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import type { DashboardSpec } from '../src/shared/dashboard'

type SaveGateResult = {
  allowed: boolean
  status: 'formal' | 'preview' | 'rejected' | 'legacy'
  score: number
  reasons: readonly string[]
}

type EvaluateSaveGate = (
  spec: DashboardSpec,
  queryEngine: QueryEngine
) => SaveGateResult

const mainSource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
)
const assertSource = (pattern: RegExp, message: string): void => {
  assert.match(mainSource, pattern, message)
}

assertSource(
  /import\s*\{\s*evaluateDashboardDomainSaveGate\s*\}\s*from\s*['"]\.\/dashboards\/dashboard-domain-save-gate['"]/,
  '主进程必须导入 evaluateDashboardDomainSaveGate'
)
const saveStart = mainSource.indexOf("ipcMain.handle('dashboards:save'")
const restoreStart = mainSource.indexOf("ipcMain.handle('dashboards:restore'", saveStart)
assert.ok(saveStart >= 0 && restoreStart > saveStart, 'dashboards:save 路由边界缺失')
const saveRoute = mainSource.slice(saveStart, restoreStart)
const gateCallIndex = saveRoute.indexOf('evaluateDashboardDomainSaveGate(')
const dbSaveIndex = saveRoute.indexOf('db.saveDashboard(input)')
assert.ok(gateCallIndex >= 0, 'dashboards:save 必须调用领域保存质量门禁')
assert.ok(dbSaveIndex > gateCallIndex,
  '保存质量门禁必须在 db.saveDashboard(input) 之前执行')
assert.match(saveRoute.slice(gateCallIndex, gateCallIndex + 500), /input\.spec/,
  '保存质量门禁必须检查待保存的 input.spec')
assert.match(saveRoute.slice(gateCallIndex, gateCallIndex + 500), /new QueryEngine\(db\)/,
  '保存质量门禁必须使用当前数据库 QueryEngine')
assert.match(saveRoute.slice(gateCallIndex, dbSaveIndex), /!\w+\.allowed|allowed\s*===\s*false/,
  '保存质量门禁拒绝时必须在写库前抛错')
assert.match(saveRoute.slice(gateCallIndex, dbSaveIndex), /throw new Error\(/,
  '保存质量门禁拒绝时必须抛出可见错误')

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const cloneDashboard = (dashboard: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(dashboard)) as DashboardSpec

const readyChat = await runDashboardDomainChatRequest({
  question: '项目负责人基于受控样例生成项目综合态势大屏',
  scope: { projectIds: ['sample-project-001'] },
  generatedAt: '2026-08-28T00:00:00.000Z'
}, new QueryEngine(makeDb(projectOverviewGoldenFixture.records)))
assert.equal(readyChat.status, 'ready', '保存门禁必须基于领域 chat ready dashboard')
assert.ok(readyChat.dashboard, '领域 chat ready 必须返回 dashboard')
const readyDashboard = readyChat.dashboard

const saveGateModule = await import('../src/main/dashboards/dashboard-domain-save-gate') as {
  evaluateDashboardDomainSaveGate: EvaluateSaveGate
}
const evaluateSaveGate = saveGateModule.evaluateDashboardDomainSaveGate
const evaluate = (spec: DashboardSpec): SaveGateResult =>
  evaluateSaveGate(spec, new QueryEngine(makeDb(projectOverviewGoldenFixture.records)))

const preview = evaluate(readyDashboard)
assert.equal(preview.allowed, true, '受控样例 preview（score 88）应允许预览保存')
assert.equal(preview.status, 'preview')
assert.equal(preview.score, 88, `受控样例 preview 分数应为 88，实际 ${preview.score}`)

const formal = cloneDashboard(readyDashboard)
formal.domainContext = {
  ...formal.domainContext!,
  artifactStatus: 'formal'
}
formal.domainReceipt = {
  ...formal.domainReceipt!,
  evidenceMissing: [],
  evidenceInsufficient: [],
  confidence: 1
}
const formalResult = evaluate(formal)
assert.equal(formalResult.allowed, true, '证据完整且 confidence=1 的 formal 应允许保存')
assert.equal(formalResult.status, 'formal')
assert.ok(formalResult.score >= 90, `formal 分数应 >=90，实际 ${formalResult.score}`)

const formalWithWarnings = cloneDashboard(formal)
formalWithWarnings.components = formalWithWarnings.components.map((component, index) =>
  index < 2
    ? {
        ...component,
        title: `${component.title} · ${'质量门禁长标题'.repeat(6)}`,
        semanticBinding: component.semanticBinding
          ? { ...component.semanticBinding, titleMode: 'custom' as const }
          : component.semanticBinding
      }
    : component
)
const formalWarningResult = evaluate(formalWithWarnings)
assert.equal(formalWarningResult.allowed, false,
  'formal 降至 preview 分数区间时不得作为 formal 保存')
assert.equal(formalWarningResult.status, 'preview')
assert.ok(formalWarningResult.score >= 80 && formalWarningResult.score <= 89,
  `两个诊断 warning 后分数应在 80-89，实际 ${formalWarningResult.score}`)

const lowPreview = cloneDashboard(formal)
lowPreview.components = lowPreview.components.map((component, index) =>
  index < 4
    ? {
        ...component,
        title: `${component.title} · ${'质量门禁长标题'.repeat(6)}`,
        semanticBinding: component.semanticBinding
          ? { ...component.semanticBinding, titleMode: 'custom' as const }
          : component.semanticBinding
      }
    : component
)
lowPreview.domainContext = {
  ...lowPreview.domainContext!,
  artifactStatus: 'preview'
}
const lowPreviewResult = evaluate(lowPreview)
assert.equal(lowPreviewResult.allowed, false, 'preview 分数低于 80 时必须拒绝保存')
assert.equal(lowPreviewResult.status, 'rejected')
assert.ok(lowPreviewResult.score < 80, `低质量 preview 分数必须 <80，实际 ${lowPreviewResult.score}`)

const vetoed = cloneDashboard(formal)
vetoed.domainReceipt = {
  ...vetoed.domainReceipt!,
  vetoCodes: ['fabricated-data']
}
const vetoResult = evaluate(vetoed)
assert.equal(vetoResult.allowed, false, '命中任意 veto 时必须拒绝保存')
assert.equal(vetoResult.status, 'rejected')
assert.ok(vetoResult.reasons.some((reason) => /veto|否决|fabricated-data|伪造/i.test(reason)),
  'veto 拒绝原因必须保留一票否决语义')

const legacy = cloneDashboard(readyDashboard)
legacy.analysisBlueprint = undefined
legacy.domainContext = undefined
legacy.domainReceipt = undefined
const legacyResult = evaluate(legacy)
assert.equal(legacyResult.allowed, true, 'legacy dashboard 必须保持可保存')
assert.equal(legacyResult.status, 'legacy')

console.log(JSON.stringify({
  ok: true,
  preview: { status: preview.status, allowed: preview.allowed, score: preview.score },
  formal: { status: formalResult.status, allowed: formalResult.allowed, score: formalResult.score },
  formalWithWarnings: {
    status: formalWarningResult.status,
    allowed: formalWarningResult.allowed,
    score: formalWarningResult.score
  },
  lowPreview: { status: lowPreviewResult.status, allowed: lowPreviewResult.allowed, score: lowPreviewResult.score },
  veto: { status: vetoResult.status, allowed: vetoResult.allowed },
  legacy: { status: legacyResult.status, allowed: legacyResult.allowed }
}, null, 2))
