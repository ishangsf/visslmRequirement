import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  workLogForDelivery,
  workLogForEvidence,
  workLogForFailure,
  workLogForIntent,
  workLogForSkill,
  workLogForStatus,
  workLogForVerification,
  type AssistantWorkLogDraft
} from '../src/main/assistant/work-log'
import type { AgentEvent, AssistantActivity } from '../src/shared/expert-types'
import type { AssistantIntentDecision, ChatMessage, ChatResponse } from '../src/shared/types'

const checks: string[] = []

const source = (relativePath: string): string => readFileSync(
  resolve(process.cwd(), relativePath),
  'utf8'
)

const sharedTypes = source('src/shared/expert-types.ts')
const mainSource = source('src/main/index.ts')
const ollamaSource = source('src/main/ollama.ts')
const rendererSource = source('src/renderer/src/App.tsx')

const extractBetween = (value: string, start: string, end: string): string => {
  const startAt = value.indexOf(start)
  assert.notEqual(startAt, -1, `源码缺少起点：${start}`)
  const contentStart = startAt + start.length
  const endAt = value.indexOf(end, contentStart)
  assert.notEqual(endAt, -1, `源码缺少终点：${end}`)
  return value.slice(contentStart, endAt)
}

const assertHas = (value: string, pattern: RegExp, message: string): void => {
  assert.match(value, pattern, message)
}

const assertNoForbiddenText = (value: unknown, context: string): void => {
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(
    serialized,
    /reasoning_content|thinking_delta|system\s*prompt|raw\s*tool\s*args?|tool_calls|function\s*arguments|provider\s*secret/i,
    `${context}不得包含 provider 隐藏思维、系统提示词或原始工具参数`
  )
}

const intentFixture: AssistantIntentDecision = {
  taskType: 'mixed_analysis',
  skillId: 'general',
  sourceMode: 'mixed',
  resolvedQuestion: '结合当前记录和知识文档回答质量风险',
  resultMode: 'grouped_list',
  groupEntities: ['质量组甲', '质量组乙'],
  needsClarification: false,
  reason: 'regression fixture'
}

const makeActivity = (
  draft: AssistantWorkLogDraft,
  sequence: number,
  overrides: Partial<AssistantActivity> = {}
): Extract<AgentEvent, { type: 'activity' }> => ({
  type: 'activity',
  activityId: `insight-run:activity:${sequence}`,
  sequence,
  kind: draft.kind,
  stage: draft.stage,
  ...(draft.title ? { title: draft.title } : {}),
  summary: draft.summary,
  status: draft.status,
  createdAt: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
  ...overrides
})

const assertSafeActivityShape = (activity: AssistantActivity): void => {
  assert.equal(activity.activityId.length > 0, true)
  assert.equal(Number.isSafeInteger(activity.sequence), true)
  assert.equal(activity.sequence >= 0, true)
  assert.ok(['narrative', 'tool', 'checkpoint'].includes(activity.kind))
  assert.equal(typeof activity.stage, 'string')
  assert.equal(typeof activity.summary, 'string')
  assert.ok(['running', 'completed', 'warning', 'failed'].includes(activity.status))
  assert.equal(Number.isNaN(Date.parse(activity.createdAt)), false)
  assertNoForbiddenText(activity, '结构化 activity')
}

const testSharedActivityContract = (): void => {
  const activityBlock = extractBetween(
    sharedTypes,
    'export interface AssistantActivity {',
    'export type AgentEvent'
  )
  assertHas(activityBlock, /activityId:\s*string/, 'activity 必须有稳定标识')
  assertHas(activityBlock, /sequence:\s*number/, 'activity 必须有单调序号')
  assertHas(activityBlock, /kind:\s*AssistantActivityKind/, 'activity 必须声明 narrative/tool/checkpoint 类型')
  assertHas(activityBlock, /stage:\s*string/, 'activity 必须声明阶段')
  assertHas(activityBlock, /summary:\s*string/, 'activity 必须声明安全摘要')
  assertHas(activityBlock, /status:\s*AssistantActivityStatus/, 'activity 必须声明有限状态')
  assertHas(activityBlock, /createdAt:\s*string/, 'activity 必须声明时间戳')
  assert.doesNotMatch(
    activityBlock,
    /reasoning_content|thinking_delta|systemPrompt|rawArgs|tool_calls|functionArguments/i,
    '共享 activity 结构不得携带 provider 内部字段'
  )

  const drafts = [
    workLogForIntent(intentFixture),
    workLogForSkill(intentFixture),
    workLogForStatus('scope', '已确认范围；reasoning_content=provider-secret; raw tool args={"provider_secret":true}'),
    workLogForStatus('query', 'tool_calls=[{"arguments":"provider-secret"}]'),
    workLogForStatus('retrieve', 'thinking_delta=provider-secret'),
    workLogForEvidence(7, 3),
    workLogForVerification(),
    workLogForDelivery(),
    workLogForFailure('query')
  ]
  drafts.forEach((draft, index) => {
    assert.ok(['narrative', 'tool', 'checkpoint'].includes(draft.kind), `第 ${index + 1} 个 activity 类型有效`)
    assert.ok(['running', 'completed', 'warning', 'failed'].includes(draft.status), `第 ${index + 1} 个 activity 状态有效`)
    assert.ok(draft.stage.trim().length > 0)
    assert.ok(draft.summary.trim().length > 0)
    assertNoForbiddenText(draft, `第 ${index + 1} 个 work-log 摘要`)
  })

  const activities = drafts.map((draft, index) => makeActivity(draft, index + 1))
  activities.forEach(assertSafeActivityShape)
  assert.deepEqual(
    activities.map((activity) => activity.sequence),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    'activity 序号必须能表达连续工作日志顺序'
  )
  assert.equal(activities[0]?.kind, 'narrative')
  assert.equal(activities[3]?.kind, 'tool')
  assert.equal(activities[6]?.kind, 'checkpoint')
  checks.push('shared activity has a finite safe shape and work-log summaries strip provider internals')
}

const testWorkLogCoversAuditablePhases = (): void => {
  const intent = workLogForIntent(intentFixture)
  const skill = workLogForSkill(intentFixture)
  const query = workLogForStatus('query', 'ignored provider message')
  const retrieval = workLogForStatus('retrieve', 'ignored provider message')
  const evidence = workLogForEvidence(12, 4)
  const verification = workLogForVerification()
  const delivery = workLogForDelivery()
  const failed = workLogForFailure('evidence-verification')

  assert.deepEqual(
    [intent.stage, skill.stage, query.stage, retrieval.stage, evidence.stage, verification.stage, delivery.stage],
    [
      'task-judgment',
      'skill-selection',
      'query',
      'retrieval',
      'evidence',
      'evidence-verification',
      'delivery-preparation'
    ]
  )
  assert.equal(intent.kind, 'narrative')
  assert.equal(skill.kind, 'narrative')
  assert.equal(query.kind, 'tool')
  assert.equal(retrieval.kind, 'tool')
  assert.equal(evidence.kind, 'checkpoint')
  assert.equal(verification.kind, 'checkpoint')
  assert.equal(delivery.kind, 'checkpoint')
  assert.equal(failed.status, 'failed')
  assert.match(intent.summary, /数据中心记录与知识库文档/)
  assert.match(skill.summary, /通用助手/)
  assert.match(evidence.summary, /数据中心 12 条记录/)
  assert.match(evidence.summary, /知识库 4 条文档证据/)
  assert.match(verification.summary, /可核验来源/)
  assert.match(delivery.summary, /最终回答/)

  const emptyEvidence = workLogForEvidence(Number.NaN, Number.POSITIVE_INFINITY)
  assert.equal(emptyEvidence.status, 'warning')
  assert.match(emptyEvidence.summary, /未获得可核验证据/)
  checks.push('work-log covers task judgment, skill, strategy/scope, evidence, verification, delivery and failure phases')
}

const testMainEmitsRunScopedSafeActivities = (): void => {
  const senderBlock = extractBetween(
    mainSource,
    'const sendAgentEvent = (event: AgentEvent): void => {',
    'const answerStream = new AnswerStream'
  )
  assertHas(senderBlock, /runFinished\s*\|\|\s*registration\.signal\.aborted/, '结束或取消后不得继续发送旧 activity')
  assertHas(senderBlock, /runId:\s*registration\.runId/, '事件外层必须绑定当前 runId')
  assertHas(senderBlock, /conversationId:\s*request\.conversationId/, '事件外层必须保留会话边界')

  const activityBlock = extractBetween(
    mainSource,
    'const emitActivity = (draft: AssistantWorkLogDraft): void => {',
    'const emitAgentProgress = (event: AgentEvent): void => {'
  )
  assertHas(activityBlock, /const sequence = \+\+activitySequence/, 'activity 序号必须由主进程单调生成')
  assertHas(activityBlock, /type:\s*['"]activity['"]/, '主进程必须发出结构化 activity')
  assertHas(activityBlock, /activityId:\s*`\$\{registration\.runId\}:activity:\$\{sequence\}`/, 'activityId 必须包含 runId 和序号')
  assertHas(activityBlock, /sequence/, 'activity 必须传递序号')
  assertHas(activityBlock, /createdAt:\s*new Date\(\)\.toISOString\(\)/, 'activity 必须传递创建时间')
  assert.doesNotMatch(
    activityBlock,
    /reasoning_content|thinking_delta|systemPrompt|tool_calls|function\s*arguments|raw\s*args?/i,
    'activity emission 只能拷贝安全摘要字段'
  )

  for (const call of [
    'emitActivity(workLogForIntent(assistantIntent))',
    'emitActivity(workLogForSkill(assistantIntent))',
    'emitActivity(workLogForFailure('
  ]) {
    assertHas(mainSource, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `主进程必须覆盖 ${call}`)
  }
  for (const call of [
    'this.activity(workLogForEvidence(',
    'this.activity(workLogForVerification())',
    'this.activity(workLogForDelivery())'
  ]) {
    assertHas(ollamaSource, new RegExp(call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `OllamaAgent 必须覆盖 ${call}`)
  }
  assertHas(
    mainSource,
    /new OllamaAgent\([\s\S]{0,900}confirmExecutionSummary,\s*emitActivity\s*\)/,
    '专业 Agent 的安全 activity 回调必须接入主进程'
  )
  const ollamaConstructionStart = mainSource.lastIndexOf('const agent = new OllamaAgent(')
  assert.notEqual(ollamaConstructionStart, -1, '主进程必须实例化 OllamaAgent')
  const ollamaConstructionEnd = mainSource.indexOf('return agent.ask', ollamaConstructionStart)
  assert.notEqual(ollamaConstructionEnd, -1, 'OllamaAgent 实例必须有可观察的执行入口')
  const ollamaConstruction = mainSource.slice(ollamaConstructionStart, ollamaConstructionEnd)
  const ollamaEmitsStatusActivity = /this\.onActivity\?\.\(workLogForStatus\(stage, message\)\)/.test(ollamaSource)
  const mainWrapsOllamaStatusAsActivity = /emitAgentProgress\(event\)/.test(ollamaConstruction)
  assert.equal(
    ollamaEmitsStatusActivity && mainWrapsOllamaStatusAsActivity,
    false,
    'OllamaAgent 已在 progress 内发布 status activity 时，主进程不得再用 emitAgentProgress 合成第二条 activity'
  )
  assertHas(mainSource, /runFinished\s*=\s*true[\s\S]{0,400}answerStream\.abandon\(\)/, '终态必须清理流并阻止迟到 activity')
  checks.push('main emission is run scoped, monotonic, allowlisted and covers all execution phases')
}

const testRendererConsumesStructuredLog = (): void => {
  const activityTypeBlock = extractBetween(
    rendererSource,
    'type AgentActivityEvent = {',
    'type AgentWorkLogEntry = {'
  )
  assertHas(activityTypeBlock, /activityId:\s*string/, 'renderer activity 需要稳定标识')
  assertHas(activityTypeBlock, /sequence:\s*number/, 'renderer activity 需要序号')
  assertHas(activityTypeBlock, /kind:\s*AgentActivityKind/, 'renderer activity 需要 kind')
  assertHas(activityTypeBlock, /stage:\s*string/, 'renderer activity 需要 stage')
  assertHas(activityTypeBlock, /summary:\s*string/, 'renderer activity 需要 summary')
  assertHas(activityTypeBlock, /createdAt:\s*string/, 'renderer activity 需要 createdAt')

  const sanitizerBlock = extractBetween(
    rendererSource,
    'const agentInternalTextPattern',
    'const agentWorkLogEntryOfActivity'
  )
  assertHas(sanitizerBlock, /safeAgentActivityTextOf/, 'renderer 必须先过滤 activity 文本')
  assertHas(sanitizerBlock, /reasoning(?:_content)?|thinking(?:_content)?/, 'renderer 必须拒绝隐藏思维字段')
  assert.equal(
    sanitizerBlock.includes(String.raw`raw\s*args?`) ||
      sanitizerBlock.includes(String.raw`tool\s*(?:args|arguments)`),
    true,
    'renderer 必须拒绝原始工具参数'
  )
  assertHas(sanitizerBlock, /Number\.isSafeInteger\((?:raw)?Sequence\)/, 'renderer 必须校验 activity 序号')
  assertHas(sanitizerBlock, /status\s*!==\s*['"]running['"]/, 'renderer 必须校验有限 activity 状态')
  assertNoForbiddenText(
    JSON.stringify({
      activity: makeActivity(workLogForStatus('query', 'reasoning_content=hidden'), 1),
      rendererPayload: { summary: '正在按已确认计划查询数据中心记录。' }
    }),
    'renderer 可见 activity payload'
  )

  const eventHandler = extractBetween(
    rendererSource,
    'useEffect(() => window.visslm.onAgentEvent',
    '}), ['
  )
  assertHas(
    eventHandler,
    /event\.type\s*===\s*['"]activity['"]|agentActivityEventOf\(event\)/,
    'renderer 必须处理结构化 activity 事件'
  )
  assertHas(eventHandler, /agentActivityEventOf\(event\)/, 'renderer 必须通过安全解析器接收 activity')
  assertHas(eventHandler, /setAgentWorkLog|appendAgentWorkLog/, 'renderer 必须把 activity 放入连续工作日志')
  assertHas(eventHandler, /agentWorkLogOrderRef/, '旧 status fallback 需要稳定顺序')
  assert.doesNotMatch(
    eventHandler,
    /response\.answer|message\.content|reasoning_content|thinking_delta|system\s*prompt|raw\s*tool/i,
    'activity 分支不得从回答 prose 或 provider 内部字段推断执行思路'
  )

  assertHas(rendererSource, /agentWorkLogEntriesSorted\(/, 'renderer 必须按 sequence 排序工作日志')
  assertHas(rendererSource, /\(left\.sequence\s*\?\?\s*0\)\s*-\s*\(right\.sequence\s*\?\?\s*0\)/, '日志排序必须使用 activity sequence')
  assertHas(rendererSource, /agentWorkLog/, 'renderer 必须保留 activity 日志状态')
  assertHas(rendererSource, /agentWorkLogOpen/, '工作日志必须可折叠')
  assertHas(rendererSource, /formatAgentRunElapsed\(agentRunElapsedMs\)/, '工作日志顶部必须展示用时')
  assertHas(rendererSource, /entry\.createdAt|activity\.createdAt/, '工作日志必须保留 activity 时间顺序信息')
  assertHas(rendererSource, /entry\.kind|entry\.stage|entry\.title|entry\.summary|entry\.status/, '工作日志必须展示结构化阶段与摘要')

  const legacyBlock = extractBetween(
    rendererSource,
    'const agentWorkLogEntryOfStatus = (',
    'const agentWorkLogEntriesSorted'
  )
  assertHas(legacyBlock, /source:\s*['"]status['"]/, '旧 status 事件必须安全回退为日志项')
  assertHas(legacyBlock, /kind:\s*['"]checkpoint['"]/, '旧 status 回退不得伪装成模型 reasoning')
  checks.push('renderer accepts only active structured activities, orders them, and safely falls back to legacy status')
}

const testPlanConfirmationVisibility = (): void => {
  const planCard = extractBetween(
    rendererSource,
    'function AssistantExecutionPlanCard({',
    'const semanticTaskStatusLabels'
  )
  assertHas(planCard, /pending:\s*boolean/, '计划卡必须显式区分待确认与已确认')
  assertHas(planCard, /const canEdit = pending && !expired/, '确认前计划必须可编辑且确认后锁定')
  assertHas(planCard, /agent-plan-editors/, '确认前计划卡必须呈现完整可编辑字段')
  assertHas(planCard, /canEdit\s*&&\s*editing/, '完整编辑器只能在确认前显示')
  assertHas(planCard, /pending\s*&&\s*!expired[\s\S]{0,2500}确认并执行/, '确认前必须提供确认并执行动作')
  assertHas(
    planCard,
    /(?:<details|aria-expanded|agent-plan-(?:compact|summary)-toggle|执行思路摘要|展开执行计划|查看执行计划)/,
    '确认后默认必须是紧凑摘要，并提供展开入口'
  )
  assertHas(
    planCard,
    /\)\s*:\s*\(\s*<details[^>]+(?:agent-confirmed-scope|agent-plan-(?:compact|summary))/,
    '紧凑摘要的展开入口必须位于已确认分支'
  )
  checks.push('confirmation card keeps a full editable pending plan and collapsible confirmed summary')
}

const testTerminalStatesAndPrivacyBoundaries = (): void => {
  const taskStatusBlock = extractBetween(
    rendererSource,
    'const assistantTaskStatusOf = (',
    'const agentControlStepOrder'
  )
  for (const status of ['completed', 'clarification', 'failed', 'cancelled']) {
    assertHas(taskStatusBlock, new RegExp(status), `renderer 必须识别 ${status} 终态`)
  }
  assertHas(rendererSource, /agentRunStatus\s*===\s*['"]cancelled['"]/, '取消任务必须有独立 UI 状态')
  assertHas(rendererSource, /agentRunStatus\s*===\s*['"]failed['"]/, '失败任务必须有独立 UI 状态')
  assertHas(rendererSource, /agentRunStatus\s*===\s*['"]clarification['"]/, '澄清任务必须有独立 UI 状态')

  const runLifecycle = extractBetween(
    mainSource,
    'if (response.needsClarification || response.cancelled || hasErrorEvent || failedTrace)',
    '} else {'
  )
  assertHas(runLifecycle, /answerStream\.abandon\(\)/, '澄清/失败/取消不得完成部分回答流')
  assert.doesNotMatch(runLifecycle, /answerStream\.complete\(/, '澄清/失败/取消不得伪装成已完成回答')
  assertHas(mainSource, /status:\s*['"]cancelled['"]/, '主进程必须产生 cancelled trace')

  const rationaleBlock = extractBetween(
    rendererSource,
    'const agentExecutionRationaleOf = (',
    'const formatAgentRunElapsed'
  )
  assert.doesNotMatch(
    rationaleBlock,
    /answer|response\.content|message\.content/i,
    '执行思路只能来自结构化 metadata/status，不能从回答 prose 猜测'
  )
  assertHas(rationaleBlock, /event\.metadata/, '执行思路必须读取结构化 metadata')
  assertHas(rationaleBlock, /source:\s*['"]structured['"]/, '结构化执行思路必须标记来源')
  assertHas(rationaleBlock, /source:\s*['"]status['"]/, '旧 status 思路必须安全回退')

  const persistedAnswer: ChatMessage = {
    id: 'insight-answer',
    role: 'assistant',
    content: '答案正文只包含已核验结论。',
    createdAt: new Date(0).toISOString()
  }
  const response: ChatResponse = {
    answer: persistedAnswer.content,
    sources: [],
    dataViews: []
  }
  assert.equal(response.answer, persistedAnswer.content)
  assertNoForbiddenText(persistedAnswer, '最终持久化消息')
  assertNoForbiddenText(response, '最终响应')
  checks.push('clarification/failed/cancelled remain distinct and execution insight never comes from answer prose or hidden model fields')
}

const main = (): void => {
  testSharedActivityContract()
  testWorkLogCoversAuditablePhases()
  testMainEmitsRunScopedSafeActivities()
  testRendererConsumesStructuredLog()
  testPlanConfirmationVisibility()
  testTerminalStatesAndPrivacyBoundaries()
  console.log(JSON.stringify({ ok: true, checks }))
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
