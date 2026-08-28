import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import type { DashboardSpec } from '../src/shared/dashboard'
import type { DataScope } from '../src/shared/query-spec'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'

type ChatInput = {
  question: string
  scope: DataScope
  generatedAt: string
}

type DomainReceipt = {
  adoptedMetricIds?: readonly string[]
  missingMetricIds?: readonly string[]
  evidenceMissing?: readonly string[]
  evidenceInsufficient?: readonly string[]
  confidence?: number
  warnings?: readonly string[]
  confirmations?: readonly string[]
  [key: string]: unknown
}

type ChatClarificationOption = {
  id: string
  label: string
  prompt: string
  action: 'submit' | 'compose'
  recommended?: boolean
}

type ChatDashboard = DashboardSpec & {
  domainReceipt?: DomainReceipt
  receipt?: DomainReceipt
}

type ChatResult = {
  recognized: boolean
  status: 'ready' | 'clarification' | 'rejected'
  answer?: string
  needsClarification?: boolean
  reason?: string
  scenario?: string
  dashboard?: ChatDashboard
  receipt?: DomainReceipt
  clarificationOptions?: readonly ChatClarificationOption[]
}

const runChat = runDashboardDomainChatRequest as unknown as (
  input: ChatInput,
  queryEngine: QueryEngine
) => ChatResult | Promise<ChatResult>

const sampleScope: DataScope = { projectIds: ['sample-project-001'] }
const generatedAt = '2026-08-28T00:00:00.000Z'

const makeDb = (
  records: readonly AnalyticsRecord[],
  onScan: () => void = () => undefined
): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    onScan()
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const makeEngine = (
  records: readonly AnalyticsRecord[],
  onScan: () => void = () => undefined
): QueryEngine => new QueryEngine(makeDb(records, onScan))

const chatInput = (question: string): ChatInput => ({
  question,
  scope: { ...sampleScope },
  generatedAt
})

const assertClarification = (
  result: ChatResult,
  reason: string
): readonly ChatClarificationOption[] => {
  assert.equal(result.recognized, true, `领域澄清 ${reason} 必须先识别请求`)
  assert.equal(result.status, 'clarification')
  assert.equal(result.needsClarification, true)
  assert.equal(result.reason, reason)
  assert.equal(result.dashboard, undefined, `${reason} 不得交付领域 dashboard`)
  const options = result.clarificationOptions
  assert.ok(Array.isArray(options), `${reason} 必须返回 AssistantClarificationOption[]`)
  assert.ok(options.length >= 2 && options.length <= 3,
    `${reason} 必须提供 2-3 个业务澄清选项`)
  for (const option of options) {
    assert.ok(option.id.trim(), `${reason} 选项必须有 id`)
    assert.ok(option.label.trim(), `${reason} 选项必须有可读 label`)
    assert.ok(option.prompt.trim(), `${reason} 选项必须有可执行 prompt`)
    assert.ok(['submit', 'compose'].includes(option.action), `${reason} 选项 action 不受支持`)
    assert.ok(!/[{}]/.test(option.prompt), `${reason} prompt 不得暴露内部 JSON`)
    assert.ok(!/analysisBlueprint|semanticBinding|processBindingIds|QuerySpec|SQL|javascript/i.test(option.prompt),
      `${reason} prompt 不得暴露内部实现字段`)
  }
  return options
}

const assertReceipt = (
  result: ChatResult,
  dashboard: ChatDashboard
): void => {
  assert.ok(result.receipt, 'ready 结果必须返回顶层 receipt')
  const receipt = result.receipt!
  for (const field of ['evidenceMissing', 'evidenceInsufficient', 'warnings', 'confirmations']) {
    assert.ok(Array.isArray(receipt[field]), `receipt 必须包含 ${field}`)
  }
  assert.equal(typeof receipt.confidence, 'number', 'receipt 必须包含 confidence')
  const embedded = dashboard.domainReceipt ?? dashboard.receipt
  assert.ok(embedded, 'dashboard 必须携带可持久化 domainReceipt（或等价 receipt）')
  for (const field of ['evidenceMissing', 'evidenceInsufficient', 'confidence', 'warnings', 'confirmations']) {
    assert.deepEqual(
      embedded?.[field],
      receipt[field],
      `dashboard domainReceipt.${field} 必须与顶层 receipt 一致`
    )
  }
}

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('领域聊天 helper 不得调用模型')
}) as typeof globalThis.fetch

try {
  const controlledEngine = makeEngine(projectOverviewGoldenFixture.records)
  const controlled = await runChat(
    chatInput('项目负责人基于受控样例生成项目综合态势大屏'),
    controlledEngine
  )
  assert.equal(controlled.recognized, true)
  assert.equal(controlled.status, 'ready')
  assert.equal(controlled.needsClarification, false)
  assert.ok(controlled.dashboard, '完整领域请求必须返回 dashboard')
  const dashboard = controlled.dashboard!
  assert.match(controlled.answer ?? '', /受控样例/, 'answer 必须明确标明受控样例')
  assert.match(controlled.answer ?? '', /预览/, 'answer 必须明确标明 preview/预览状态')
  assert.match(controlled.answer ?? '', /QuerySpec/, 'answer 必须说明使用 QuerySpec')
  assert.match(controlled.answer ?? '', /本地计算/, 'answer 必须说明结果来自本地计算')
  assert.equal(dashboard.domainContext?.role, 'project-owner')
  assert.equal(dashboard.domainContext?.scenario, 'project-overview')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.equal(dashboard.components.length, 6)
  assert.ok(dashboard.analysisBlueprint)
  assert.deepEqual(
    new Set(dashboard.analysisBlueprint?.metrics.map((metric) => metric.id)),
    new Set(['project-health', 'milestone-achievement', 'requirement-completion', 'defect-density', 'high-risk-count', 'process-compliance'])
  )
  for (const component of dashboard.components) {
    assert.ok(component.query, `组件 ${component.id} 必须带 QuerySpec`)
    assert.ok(component.semanticBinding, `组件 ${component.id} 必须带 semanticBinding`)
    assert.ok(component.semanticBinding?.processBindingIds?.length,
      `组件 ${component.id} 必须带 processBindingIds`)
    assert.ok(component.slotRole, `组件 ${component.id} 必须带 slotRole`)
  }
  assert.deepEqual(validateDashboardSpec(dashboard, controlledEngine), [],
    'ready dashboard 必须通过现有 DashboardSpec 校验')
  assertReceipt(controlled, dashboard)

  const roleAmbiguous = await runChat(chatInput('生成项目综合态势大屏'), controlledEngine)
  assertClarification(roleAmbiguous, 'missing-role')

  const baselineAmbiguous = await runChat(
    chatInput('项目负责人生成项目综合态势大屏'),
    controlledEngine
  )
  const baselineOptions = assertClarification(baselineAmbiguous, 'missing-tailoring-baseline')
  const recommendedBaselineOptions = baselineOptions.filter((option) => option.recommended === true)
  assert.equal(recommendedBaselineOptions.length, 1,
    'missing-tailoring-baseline 必须恰好有一个推荐选项')
  assert.match(recommendedBaselineOptions[0].prompt, /受控样例/,
    '推荐的裁剪基线选项必须明确指向受控样例')
  const followUp = await runChat(chatInput(recommendedBaselineOptions[0].prompt), controlledEngine)
  assert.equal(followUp.status, 'ready', '点击推荐选项后 prompt 必须可解析为下一轮 ready 请求')

  const planned = await runChat(
    chatInput('QA/EPG 生成 GJB5000B 过程证据符合度大屏'),
    controlledEngine
  )
  assertClarification(planned, 'scenario-not-active')
  assert.equal(planned.scenario, 'gjb5000b-compliance')
  assert.notEqual(planned.scenario, 'project-overview',
    'planned 场景不得静默回退到 project-overview')

  let genericScans = 0
  const generic = await runChat(
    chatInput('生成销售大屏，关注销售额和客户转化率'),
    makeEngine(projectOverviewGoldenFixture.records, () => { genericScans += 1 })
  )
  assert.equal(generic.recognized, false, '泛经营请求必须交给通用可视化链路')
  assert.equal(generic.dashboard, undefined)
  assert.equal(genericScans, 0, '非领域请求不得扫描领域 QueryEngine')

  const missingDefectRecords = projectOverviewGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'defectDensity'))
  }))
  const missingMetric = await runChat(
    chatInput('项目负责人基于受控样例生成项目综合态势大屏'),
    makeEngine(missingDefectRecords)
  )
  assertClarification(missingMetric, 'missing-metric-source')
  assert.ok(!JSON.stringify(missingMetric).includes('缺陷总数'),
    '缺少 defectDensity 时不得降级为缺陷总数伪结论')

  assert.equal(modelCalls, 0, '领域聊天 helper 全流程不得调用模型')
  console.log(JSON.stringify({
    ok: true,
    ready: {
      role: dashboard.domainContext?.role,
      scenario: dashboard.domainContext?.scenario,
      artifactStatus: dashboard.domainContext?.artifactStatus,
      componentCount: dashboard.components.length,
      receiptPersisted: true
    },
    clarifications: ['missing-role', 'missing-tailoring-baseline', 'scenario-not-active', 'missing-metric-source'],
    generic: { recognized: generic.recognized, queryEngineScans: genericScans },
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
