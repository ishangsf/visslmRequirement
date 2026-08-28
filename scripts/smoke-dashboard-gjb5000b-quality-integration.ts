import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { diagnoseDashboard } from '../src/main/dashboards/diagnostics'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import type { DashboardSpec } from '../src/shared/dashboard'

const scope = { projectIds: ['sample-project-001'] }
const generatedAt = '2026-08-28T00:00:00.000Z'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(queryScope) {
    return records.filter((record) =>
      (!queryScope.projectIds?.length || queryScope.projectIds.includes(record.projectId)) &&
      (!queryScope.nodeTypes?.length || queryScope.nodeTypes.includes(record.nodeType)) &&
      (!queryScope.recordUids?.length || queryScope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const cloneDashboard = (dashboard: DashboardSpec): DashboardSpec =>
  JSON.parse(JSON.stringify(dashboard)) as DashboardSpec

const result = await runDashboardDomainChatRequest({
  question: '项目负责人基于受控样例生成项目综合态势大屏',
  scope,
  generatedAt
}, new QueryEngine(makeDb(projectOverviewGoldenFixture.records)))

assert.equal(result.recognized, true)
assert.equal(result.status, 'ready', '质量集成必须基于领域 chat ready dashboard')
assert.ok(result.dashboard, '领域 chat ready 必须返回 dashboard')
assert.ok(result.receipt, '领域 chat ready 必须返回顶层 receipt')
const dashboard = result.dashboard
const queryEngine = new QueryEngine(makeDb(projectOverviewGoldenFixture.records))
assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
assert.ok(dashboard.domainReceipt, 'ready dashboard 必须持久化 domainReceipt')
assert.deepEqual(dashboard.domainReceipt?.evidenceMissing, result.receipt?.evidenceMissing)
assert.deepEqual(dashboard.domainReceipt?.evidenceInsufficient, result.receipt?.evidenceInsufficient)

const previewReport = diagnoseDashboard(dashboard, queryEngine)
const missingIssues = previewReport.issues.filter((issue) =>
  issue.code === 'domain-evidence-missing' || /证据.*缺失|缺失.*证据/.test(issue.message)
)
const insufficientIssues = previewReport.issues.filter((issue) =>
  issue.code === 'domain-evidence-insufficient' || /证据.*不足|不足.*证据/.test(issue.message)
)
assert.ok(missingIssues.length > 0,
  'preview 领域诊断必须显式报告 domain-evidence-missing')
assert.ok(insufficientIssues.length > 0,
  'preview 领域诊断必须显式报告 domain-evidence-insufficient')
assert.ok(missingIssues.every((issue) => /缺失/.test(issue.message) && !/不符合/.test(issue.message)),
  '证据缺失文案必须区分缺失，不能写成不符合')
assert.ok(insufficientIssues.every((issue) => /不足/.test(issue.message) && !/不符合/.test(issue.message)),
  '证据不足文案必须区分不足，不能写成不符合')
assert.ok(previewReport.score >= 80 && previewReport.score <= 89,
  `preview 受控样例质量分必须在 80-89，实际 ${previewReport.score}`)
assert.deepEqual(validateDashboardSpec(dashboard, queryEngine), [],
  'preview 领域 dashboard 必须允许通过保存校验')

const formalWithEvidenceGap = cloneDashboard(dashboard)
formalWithEvidenceGap.domainContext = {
  ...formalWithEvidenceGap.domainContext!,
  artifactStatus: 'formal'
}
const formalErrors = validateDashboardSpec(formalWithEvidenceGap, queryEngine)
assert.ok(formalErrors.length > 0,
  'formal 仍有 evidenceMissing/evidenceInsufficient 时必须被 validator 阻断')
assert.ok(formalErrors.some((message) => /正式|formal|证据|evidence/i.test(message)),
  'formal 证据门禁错误必须明确说明正式状态或证据问题')

const formalWithVeto = cloneDashboard(dashboard)
formalWithVeto.domainContext = {
  ...formalWithVeto.domainContext!,
  artifactStatus: 'formal'
}
formalWithVeto.domainReceipt = {
  ...formalWithVeto.domainReceipt!,
  vetoCodes: ['fabricated-data']
}
const formalVetoErrors = validateDashboardSpec(formalWithVeto, queryEngine)
assert.ok(formalVetoErrors.length > 0, 'formal 命中 vetoCodes 必须被 validator 阻断')
assert.ok(formalVetoErrors.some((message) => /veto|否决|fabricated-data|伪造/i.test(message)),
  'formal veto 门禁错误必须保留 veto 语义')

const formalWithInvalidConfidence = cloneDashboard(dashboard)
formalWithInvalidConfidence.domainContext = {
  ...formalWithInvalidConfidence.domainContext!,
  artifactStatus: 'formal'
}
formalWithInvalidConfidence.domainReceipt = {
  ...formalWithInvalidConfidence.domainReceipt!,
  confidence: 1.2
}
const invalidConfidenceErrors = validateDashboardSpec(formalWithInvalidConfidence, queryEngine)
assert.ok(invalidConfidenceErrors.length > 0,
  'formal confidence 超出 0-1 时必须被 validator 阻断')
assert.ok(invalidConfidenceErrors.some((message) => /confidence|可信度/i.test(message)),
  'invalid confidence 错误必须明确指出可信度')

const formalWithoutReceipt = cloneDashboard(dashboard)
formalWithoutReceipt.domainContext = {
  ...formalWithoutReceipt.domainContext!,
  artifactStatus: 'formal'
}
formalWithoutReceipt.domainReceipt = undefined
const missingReceiptErrors = validateDashboardSpec(formalWithoutReceipt, queryEngine)
assert.ok(missingReceiptErrors.length > 0,
  'formal 缺少 domainReceipt 时必须被 validator 阻断')
assert.ok(missingReceiptErrors.some((message) => /receipt|回执|证据|evidence/i.test(message)),
  'formal 缺少回执错误必须明确指出回执或证据')

const previewWithVeto = cloneDashboard(dashboard)
previewWithVeto.domainReceipt = {
  ...previewWithVeto.domainReceipt!,
  vetoCodes: ['permission-violation']
}
const previewVetoErrors = validateDashboardSpec(previewWithVeto, queryEngine)
assert.ok(previewVetoErrors.length > 0,
  'preview 命中 vetoCodes 也必须阻断或标记 rejected，不得静默保存')
assert.ok(previewVetoErrors.some((message) => /veto|否决|permission-violation|权限/i.test(message)),
  'preview veto 门禁错误必须保留 veto 语义')

const legacy = cloneDashboard(dashboard)
legacy.analysisBlueprint = undefined
legacy.domainContext = undefined
legacy.domainReceipt = undefined
assert.deepEqual(validateDashboardSpec(legacy, queryEngine), [],
  'legacy 无 domainContext/domainReceipt dashboard 必须保持兼容')

console.log(JSON.stringify({
  ok: true,
  preview: {
    score: previewReport.score,
    issueCodes: previewReport.issues.map((issue) => issue.code),
    evidenceMissing: dashboard.domainReceipt?.evidenceMissing?.length ?? 0,
    evidenceInsufficient: dashboard.domainReceipt?.evidenceInsufficient?.length ?? 0
  },
  formalGuardCases: ['evidence-gap', 'veto', 'invalid-confidence', 'missing-receipt'],
  previewVeto: true,
  legacyCompatible: true
}, null, 2))
