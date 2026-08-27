import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { workLogForStatus } from '../src/main/assistant/work-log'
import type { ChatMessage } from '../src/shared/types'

const checks: string[] = []

const sectionBetween = (value: string, start: string, end: string): string => {
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

const [sharedTypes, rendererSource, stylesSource] = await Promise.all([
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
])

const chatMessageBlock = sectionBetween(
  sharedTypes,
  'export interface ChatMessage {',
  'export interface ChatContextRef {'
)
const executionLogDeclaration = chatMessageBlock.match(/^\s*executionLog\?\s*:\s*([^\n]+)/m)
assert.ok(executionLogDeclaration, 'ChatMessage 必须提供可选 executionLog 字段')
const executionLogType = executionLogDeclaration?.[1]?.trim() ?? ''
const executionLogTypeName = executionLogType.match(/^([A-Za-z_$][\w$]*)/)?.[1]
const executionLogTypeBlock = executionLogTypeName
  ? sharedTypes.slice(sharedTypes.indexOf(`export interface ${executionLogTypeName} {`))
  : ''
if (!/(?:\[\]|Array\s*<|ReadonlyArray\s*<)/.test(executionLogType)) {
  assertHas(executionLogTypeBlock, /durationMs\s*:\s*number/, '执行日志对象必须保存受限的用时信息')
  assertHas(executionLogTypeBlock, /\bentries\s*:/, '执行日志对象必须保存结构化条目')
}
assert.equal(
  /(?:\[\]|Array\s*<|ReadonlyArray\s*<)/.test(executionLogType) ||
    /\bentries\s*:\s*[^\n]*(?:\[\]|Array\s*<|ReadonlyArray\s*<)/.test(executionLogTypeBlock),
  true,
  'executionLog 必须是可持久化的日志数组契约（可直接为数组，或由 entries 数组承载）'
)

const persistedMessage: ChatMessage = {
  id: 'execution-log-contract-message',
  role: 'assistant',
  content: '已完成',
  createdAt: new Date(0).toISOString(),
  executionLog: undefined
}
assert.equal(persistedMessage.executionLog, undefined)
checks.push('ChatMessage exposes an optional array-shaped executionLog that can be persisted')

const appendStart = rendererSource.indexOf('const appendAgentWorkLog = useCallback(')
const appendEnd = rendererSource.indexOf('  const clearActiveRun', appendStart)
const mergeLogStart = rendererSource.indexOf('const agentWorkLogEntriesWithEntry =')
const mergeLogEnd = rendererSource.indexOf('type AgentWorkLogTerminalOutcome', mergeLogStart)
assert.ok(appendStart >= 0 && appendEnd > appendStart, 'renderer 必须有连续执行日志追加入口')
assert.ok(mergeLogStart >= 0 && mergeLogEnd > mergeLogStart, 'renderer 必须有 activity 更新合并逻辑')
const appendBlock = rendererSource.slice(appendStart, appendEnd)
const mergeLogBlock = rendererSource.slice(mergeLogStart, mergeLogEnd)
const appendLogicBlock = `${appendBlock}\n${mergeLogBlock}`
assert.doesNotMatch(
  appendLogicBlock,
  /current\.some\(\(item\)\s*=>[\s\S]{0,600}item\.activityId\s*===\s*entry\.activityId[\s\S]{0,160}return current/,
  '同一 activity 的完成更新不能命中“重复即丢弃”的旧守卫'
)
assertHas(
  appendLogicBlock,
  /(?:findIndex|current\.map|new Map|Map\s*<)/,
  '同一 activity 需要通过索引或映射更新已有日志项'
)
assertHas(
  appendLogicBlock,
  /(?:\.\.\.entry|entry\.status|status\s*:\s*entry)/,
  '日志更新必须保留完成/警告/失败等新状态，而不是只保留首次 running 状态'
)
checks.push('the renderer replaces or merges an activity update instead of dropping its completed state as a duplicate')

const successfulCompletionBlock = sectionBetween(
  rendererSource,
  'const responseTaskStatus:',
  'const completedMessages: ChatMessage[] = ['
)
const assistantMessageStart = Math.max(
  successfulCompletionBlock.lastIndexOf("role: 'assistant'"),
  successfulCompletionBlock.lastIndexOf('role: "assistant"')
)
assert.ok(assistantMessageStart >= 0, '完成消息列表必须包含 assistant message')
const completedAssistantObject = successfulCompletionBlock.slice(assistantMessageStart)
assertHas(
  completedAssistantObject,
  /executionLog/,
  '运行完成后必须把执行日志写入持久化 assistant message'
)
checks.push('successful completion persists the run execution log on the assistant message')

const messageRenderBlock = sectionBetween(
  rendererSource,
  'messages.map((message, messageIndex) => {',
  '{loading && ('
)
const executionLogRenderAt = Math.max(
  messageRenderBlock.indexOf('message.executionLog'),
  messageRenderBlock.indexOf('assistantExecutionLogOfMessage(message)')
)
assert.ok(executionLogRenderAt >= 0, '已完成消息渲染分支必须读取 message.executionLog')
assertHas(
  messageRenderBlock,
  /AgentWorkLogDisclosure|agent-work-log-disclosure|execution-log/i,
  '已完成消息渲染分支必须挂载执行日志展示组件'
)
const executionLogRenderContext = messageRenderBlock.slice(
  Math.max(0, executionLogRenderAt - 900),
  executionLogRenderAt + 5000
)
assertHas(
  executionLogRenderContext,
  /<details\b|aria-expanded|Collapse|agent-(?:work-)?log|execution-log/i,
  '已完成消息中的执行日志必须有可折叠/展开语义，不能只存在 loading 分支'
)
checks.push('completed assistant messages render their persisted log behind a disclosure control')

const statusLogBlock = sectionBetween(
  rendererSource,
  'const agentWorkLogEntryOfStatus = (',
  'const agentWorkLogEntriesSorted'
)
assertHas(statusLogBlock, /source:\s*['"]status['"]/, '旧 status checkpoint 必须保留来源标记')
assertHas(statusLogBlock, /(?:status:\s*['"]running['"]|:\s*['"]running['"])/, '旧 status checkpoint 必须保留 running 回退状态')

const failedAssistantBlock = sectionBetween(
  rendererSource,
  'const failedAssistantMessage',
  'const failedMessages: ChatMessage[] = ['
)
const cancellationBlock = sectionBetween(
  rendererSource,
  'const finalizeCancelledRun =',
  '  const cancelActiveRun'
)
assertHas(failedAssistantBlock, /executionLog/, '失败终态的 assistant message 也必须携带执行日志')
assertHas(cancellationBlock, /executionLog/, '取消终态的 assistant message 也必须携带执行日志')
assertHas(cancellationBlock, /cancelled/, '取消终态必须显式使用 cancelled 状态')

const terminalLogSource = [successfulCompletionBlock, failedAssistantBlock, cancellationBlock].join('\n')
for (const [status, messageBlock] of [
  ['completed', successfulCompletionBlock],
  ['failed', failedAssistantBlock],
  ['cancelled', cancellationBlock]
] as const) {
  assertHas(messageBlock, new RegExp(status), `${status} 终态必须有明确分支`)
}
const terminalOutcomeStart = rendererSource.indexOf('type AgentWorkLogTerminalOutcome')
const terminalOutcomeEnd = rendererSource.indexOf('const executionLogDurationOf', terminalOutcomeStart)
assert.ok(terminalOutcomeStart >= 0 && terminalOutcomeEnd > terminalOutcomeStart, '日志必须有统一终态收敛入口')
const terminalOutcomeBlock = rendererSource.slice(terminalOutcomeStart, terminalOutcomeEnd)
assertHas(terminalOutcomeBlock, /entry\.status\s*===\s*['"]running['"]/, '终态收敛必须识别旧 running checkpoint')
assertHas(terminalOutcomeBlock, /outcome\s*===\s*['"]failed['"]/, '失败终态必须有明确日志状态映射')
assertHas(terminalOutcomeBlock, /outcome\s*===\s*['"]cancelled['"]/, '取消终态必须有明确日志状态映射')
assertHas(terminalOutcomeBlock, /status:\s*['"]completed['"]/, '成功终态必须把未完成 checkpoint 收敛为 completed')
assertHas(
  rendererSource,
  /(?:executionLog|agentWorkLog)[\s\S]{0,2600}(?:\.map\(|\.reduce\(|finali[sz]e)[\s\S]{0,1800}(?:status|running)/i,
  '终态持久化前必须遍历/收敛日志状态，不能让旧 checkpoint 永远停留在 running'
)
assertHas(
  terminalLogSource,
  /(?:completed|failed|cancelled)[\s\S]{0,1800}executionLog|executionLog[\s\S]{0,1800}(?:completed|failed|cancelled)/,
  '成功、失败、取消三种终态都必须与执行日志持久化路径相连'
)
checks.push('legacy running checkpoints are converged before completed, failed and cancelled logs are persisted')

const evidenceCssStart = stylesSource.indexOf('.chat-evidence-block {')
const executionCssStart = stylesSource.indexOf('.chat-workspace-v2 .agent-work-log-disclosure {')
assert.ok(evidenceCssStart >= 0 && executionCssStart > evidenceCssStart, '证据卡与执行日志必须有可定位的主题样式')
const themedCss = stylesSource.slice(evidenceCssStart, executionCssStart + 5000)
assertHas(themedCss, /var\(--(?:surface|stroke|text|accent|focus-ring)/, '执行日志/证据卡必须使用主题变量')
assertHas(themedCss, /:focus-visible/, '执行日志/证据卡的交互入口必须有 focus-visible 样式')
assert.doesNotMatch(
  themedCss,
  /background\s*:\s*(?:white|#fff(?:fff)?|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))/i,
  '执行日志/证据卡不得引入固定浅色背景'
)

const executionCssMobileStart = stylesSource.indexOf('@media (max-width: 680px)', executionCssStart)
assert.ok(executionCssMobileStart >= 0, '执行日志必须提供 680px 窄窗口规则')
const executionCssMobile = stylesSource.slice(executionCssMobileStart, executionCssMobileStart + 1800)
assertHas(
  executionCssMobile,
  /agent-work-log|execution-log|grid-template-columns:\s*1fr/,
  '680px 下执行日志布局必须有明确的收缩/单列处理'
)
const evidenceCssMobileStart = stylesSource.indexOf('@media (max-width: 680px)', evidenceCssStart)
const evidenceCssMobileEnd = stylesSource.indexOf('/* Binary resource pack', evidenceCssMobileStart)
assert.ok(evidenceCssMobileStart >= 0 && evidenceCssMobileEnd > evidenceCssMobileStart, '证据卡必须有 680px 响应式规则')
assertHas(
  stylesSource.slice(evidenceCssMobileStart, evidenceCssMobileEnd),
  /\.chat-evidence-block-grid[\s\S]{0,140}grid-template-columns:\s*1fr/,
  '680px 下查询明细证据卡必须切换为单列'
)
checks.push('execution-log and evidence-card styles stay theme-aware, keyboard-visible and single-column at 680px')

/**
 * Execute the reducer that the renderer actually uses.  Keeping this as a
 * small source extraction makes the lifecycle fixtures exercise production
 * behavior without requiring a browser render or exporting UI-only helpers.
 */
const lifecycleReducerStart = rendererSource.indexOf('const agentWorkLogEntriesSorted =')
const lifecycleReducerEnd = rendererSource.indexOf('const executionLogDurationOf', lifecycleReducerStart)
assert.ok(
  lifecycleReducerStart >= 0 && lifecycleReducerEnd > lifecycleReducerStart,
  'renderer 必须提供可执行的执行日志生命周期 reducer'
)
const stageHelpersStart = rendererSource.indexOf('const agentStageOrder =')
const stageHelpersEnd = rendererSource.indexOf('type ChatSource =', stageHelpersStart)
const recordHelperStart = rendererSource.indexOf('const isRecordObject =')
const recordHelperEnd = rendererSource.indexOf('type AgentControlStepKey =', recordHelperStart)
const activityHelpersStart = rendererSource.indexOf('const agentInternalTextPattern =')
const activityHelpersEnd = rendererSource.indexOf('const executionLogDurationOf', activityHelpersStart)
const executionLogNormalizerStart = rendererSource.indexOf('const assistantExecutionLogOfMessage =')
const executionLogNormalizerEnd = rendererSource.indexOf('type AgentWorkLogDisplayEntry', executionLogNormalizerStart)
assert.ok(
  stageHelpersStart >= 0 && stageHelpersEnd > stageHelpersStart &&
    recordHelperStart >= 0 && recordHelperEnd > recordHelperStart &&
    activityHelpersStart >= 0 && activityHelpersEnd > activityHelpersStart &&
    executionLogNormalizerStart >= 0 && executionLogNormalizerEnd > executionLogNormalizerStart,
  'renderer 必须提供可执行的 activity/status 转换与历史日志 normalizer'
)
const lifecycleReducerSource = `${rendererSource.slice(stageHelpersStart, stageHelpersEnd)}
${rendererSource.slice(recordHelperStart, recordHelperEnd)}
${rendererSource.slice(activityHelpersStart, activityHelpersEnd)}
${rendererSource.slice(executionLogNormalizerStart, executionLogNormalizerEnd)}
module.exports = {
  agentWorkLogEntryOfActivity,
  agentWorkLogEntryOfStatus,
  agentWorkLogEntriesWithEntry,
  settleAgentWorkLogEntries,
  assistantExecutionLogOfMessage
}`
const lifecycleReducerJavaScript = transpileModule(lifecycleReducerSource, {
  compilerOptions: {
    target: ScriptTarget.ES2022,
    module: ModuleKind.CommonJS
  }
}).outputText
const lifecycleReducerModule: { exports: Record<string, unknown> } = { exports: {} }
runInNewContext(lifecycleReducerJavaScript, {
  module: lifecycleReducerModule,
  exports: lifecycleReducerModule.exports
})

type RegressionWorkLogEntry = {
  activityId: string
  sequence: number
  kind: 'narrative' | 'tool' | 'checkpoint'
  stage: string
  title?: string
  summary: string
  status: 'running' | 'completed' | 'warning' | 'failed'
  createdAt: string
  source: 'activity' | 'status'
  order: number
}

type RegressionActivityEvent = {
  type: 'activity'
  activityId: string
  sequence: number
  kind: RegressionWorkLogEntry['kind']
  stage: string
  title?: string
  summary: string
  status: RegressionWorkLogEntry['status']
  createdAt: string
}

type RegressionStatusEvent = {
  type: 'status'
  stage: string
  message: string
}

type RegressionPersistedExecutionLogEntry = Omit<RegressionWorkLogEntry, 'source' | 'order'>

type RegressionExecutionLogView = {
  durationMs: number
  entries: RegressionPersistedExecutionLogEntry[]
}

type LifecycleReducer = {
  agentWorkLogEntriesWithEntry: (
    entries: RegressionWorkLogEntry[],
    entry: RegressionWorkLogEntry,
    maxEntries?: number
  ) => RegressionWorkLogEntry[]
  settleAgentWorkLogEntries: (
    entries: RegressionWorkLogEntry[],
    outcome: 'completed' | 'failed' | 'cancelled' | 'warning'
  ) => RegressionWorkLogEntry[]
  agentWorkLogEntryOfActivity: (
    event: RegressionActivityEvent,
    order: number
  ) => RegressionWorkLogEntry
  agentWorkLogEntryOfStatus: (
    event: RegressionStatusEvent,
    order: number
  ) => RegressionWorkLogEntry | undefined
  assistantExecutionLogOfMessage: (
    message: { executionLog?: unknown }
  ) => RegressionExecutionLogView | undefined
}

const lifecycleReducer = lifecycleReducerModule.exports as unknown as LifecycleReducer
assert.equal(
  typeof lifecycleReducer.agentWorkLogEntriesWithEntry,
  'function',
  '执行日志生命周期 reducer 必须可调用'
)
assert.equal(
  typeof lifecycleReducer.settleAgentWorkLogEntries,
  'function',
  '执行日志终态收敛 helper 必须可调用'
)

let fixtureSequence = 0
const makeRegressionWorkLogEntry = (
  overrides: Partial<RegressionWorkLogEntry> = {}
): RegressionWorkLogEntry => {
  const sequence = overrides.sequence ?? ++fixtureSequence
  return {
    activityId: `regression-activity-${sequence}`,
    sequence,
    kind: 'narrative',
    stage: 'execution',
    title: '执行阶段',
    summary: '正在执行阶段。',
    status: 'running',
    createdAt: new Date(1700000000000 + sequence * 1000).toISOString(),
    source: 'activity',
    order: sequence,
    ...overrides
  }
}

const appendRegressionEntry = (
  entries: RegressionWorkLogEntry[],
  overrides: Partial<RegressionWorkLogEntry>
): RegressionWorkLogEntry[] => lifecycleReducer.agentWorkLogEntriesWithEntry(
  entries,
  makeRegressionWorkLogEntry(overrides)
)

const appendRendererEntry = (
  entries: RegressionWorkLogEntry[],
  entry: RegressionWorkLogEntry
): RegressionWorkLogEntry[] => lifecycleReducer.agentWorkLogEntriesWithEntry(entries, entry)

const rendererActivityEntryOf = (
  event: RegressionActivityEvent,
  order: number
): RegressionWorkLogEntry => lifecycleReducer.agentWorkLogEntryOfActivity(event, order)

const rendererStatusEntryOf = (
  event: RegressionStatusEvent,
  order: number
): RegressionWorkLogEntry => {
  const entry = lifecycleReducer.agentWorkLogEntryOfStatus(event, order)
  assert.ok(entry, `status ${event.stage} 必须转换为执行日志条目`)
  return entry as RegressionWorkLogEntry
}

const rowsForStages = (
  entries: RegressionWorkLogEntry[],
  stages: readonly string[]
): RegressionWorkLogEntry[] => entries.filter((entry) => stages.includes(entry.stage))

const rendererActivityEventOf = (
  activityId: string,
  sequence: number,
  stage: string,
  status: RegressionWorkLogEntry['status'],
  summary: string
): RegressionActivityEvent => ({
  type: 'activity',
  activityId,
  sequence,
  kind: stage === 'query' || stage === 'retrieval' ? 'tool' : 'narrative',
  stage,
  title: '结构化执行阶段',
  summary,
  status,
  createdAt: new Date(1700000000000 + sequence * 1000).toISOString()
})

// Legacy status events may arrive before structured activities.  Once the
// structured task-judgment activity arrives, it is the sole visible row.
let statusBeforeActivityEntries: RegressionWorkLogEntry[] = []
statusBeforeActivityEntries = appendRendererEntry(
  statusBeforeActivityEntries,
  rendererStatusEntryOf({ type: 'status', stage: 'classify', message: '正在识别任务。' }, 1)
)
statusBeforeActivityEntries = appendRendererEntry(
  statusBeforeActivityEntries,
  rendererActivityEntryOf(
    rendererActivityEventOf('run-status-first:activity:2', 2, 'task-judgment', 'running', '正在判断任务。'),
    2
  )
)
const statusBeforeActivityRows = rowsForStages(statusBeforeActivityEntries, ['classify', 'task-judgment'])
assert.equal(statusBeforeActivityRows.length, 1, 'classify status 被 task-judgment activity 更新后只能保留一行')
assert.equal(statusBeforeActivityRows[0]?.source, 'activity', 'structured task-judgment activity 必须优先于 legacy status')

// The reverse arrival order has the same rule: a status duplicate must not be
// appended after a structured activity is already present.
let activityBeforeStatusEntries: RegressionWorkLogEntry[] = []
activityBeforeStatusEntries = appendRendererEntry(
  activityBeforeStatusEntries,
  rendererActivityEntryOf(
    rendererActivityEventOf('run-activity-first:activity:1', 1, 'task-judgment', 'running', '正在判断任务。'),
    1
  )
)
activityBeforeStatusEntries = appendRendererEntry(
  activityBeforeStatusEntries,
  rendererStatusEntryOf({ type: 'status', stage: 'classify', message: '正在识别任务。' }, 2)
)
const activityBeforeStatusRows = rowsForStages(activityBeforeStatusEntries, ['classify', 'task-judgment'])
assert.equal(activityBeforeStatusRows.length, 1, '已有 structured activity 时重复 status 不得追加')
assert.equal(activityBeforeStatusRows[0]?.source, 'activity', '重复 status 必须让位于已有 structured activity')

// Status route/plan/generate updates share the execution-preparation lifecycle. Their
// fallback title must not regress to the generic classify label.
let statusPlanEntries: RegressionWorkLogEntry[] = []
for (const [stage, order] of [
  ['route', 3],
  ['plan', 4],
  ['generate', 5]
] as const) {
  statusPlanEntries = appendRendererEntry(
    statusPlanEntries,
    rendererStatusEntryOf({ type: 'status', stage, message: '正在准备执行。' }, order)
  )
}
const statusPlanRows = rowsForStages(statusPlanEntries, ['route', 'plan', 'generate', 'execution-preparation'])
assert.equal(statusPlanRows.length, 1, 'status route/plan/generate 必须共用一条 execution-preparation 生命周期')
assert.equal(statusPlanRows[0]?.title, '准备执行', '准备 status fallback 必须显示真实生命周期标题')
checks.push('status and structured activities coalesce in either arrival order, and plan fallbacks use a dedicated title')

const makePersistedExecutionLogEntry = (
  overrides: Partial<RegressionPersistedExecutionLogEntry>
): RegressionPersistedExecutionLogEntry => ({
  activityId: 'history:activity:0',
  sequence: 0,
  kind: 'narrative',
  stage: 'execution',
  summary: '历史执行阶段。',
  status: 'running',
  createdAt: new Date(1700000000000).toISOString(),
  ...overrides
})

// Persisted turns do not carry the live source field, so production history
// normalization infers legacy status rows from their status-* ids. It must
// prefer structured activities for a lifecycle, collapse status-only repeats,
// and keep query/retrieval as separate evidence lanes.
const historicalExecutionLogEntries: RegressionPersistedExecutionLogEntry[] = [
  makePersistedExecutionLogEntry({
    activityId: 'status-1',
    sequence: 1,
    kind: 'checkpoint',
    stage: 'classify',
    title: '识别任务',
    summary: '正在识别任务。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'history-run:activity:2',
    sequence: 2,
    kind: 'narrative',
    stage: 'task-judgment',
    title: '任务判断',
    summary: '任务判断已完成。',
    status: 'completed'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'status-3',
    sequence: 3,
    kind: 'checkpoint',
    stage: 'route',
    title: '识别任务',
    summary: '正在路由计划。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'status-4',
    sequence: 4,
    kind: 'checkpoint',
    stage: 'plan',
    title: '识别任务',
    summary: '正在制定计划。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'status-5',
    sequence: 5,
    kind: 'checkpoint',
    stage: 'generate',
    title: '识别任务',
    summary: '生成计划状态（最新）。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'history-run:activity:6',
    sequence: 6,
    kind: 'tool',
    stage: 'query',
    summary: '结构化查询通道。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'status-7',
    sequence: 7,
    kind: 'checkpoint',
    stage: 'query',
    title: '查询数据',
    summary: '重复查询 status。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'history-run:activity:8',
    sequence: 8,
    kind: 'tool',
    stage: 'retrieval',
    summary: '结构化检索通道。'
  }),
  makePersistedExecutionLogEntry({
    activityId: 'status-9',
    sequence: 9,
    kind: 'checkpoint',
    stage: 'retrieval',
    title: '检索依据',
    summary: '重复检索 status。'
  })
]
const normalizedHistoricalLog = lifecycleReducer.assistantExecutionLogOfMessage({
  executionLog: {
    durationMs: 42,
    entries: historicalExecutionLogEntries
  }
})
assert.ok(normalizedHistoricalLog, '持久化 executionLog 必须可被历史消息 normalizer 读取')
const normalizedHistoricalEntries = normalizedHistoricalLog?.entries ?? []
const historyRowsForStages = (stages: readonly string[]): RegressionPersistedExecutionLogEntry[] => (
  normalizedHistoricalEntries.filter((entry) => stages.includes(entry.stage))
)
const historyTaskRows = historyRowsForStages(['classify', 'task-judgment'])
assert.equal(historyTaskRows.length, 1, '历史 status + activity 同任务生命周期只能保留一条')
assert.equal(
  historyTaskRows[0]?.activityId.startsWith('status-'),
  false,
  '历史任务生命周期必须优先展示 structured activity'
)
assert.equal(historyTaskRows[0]?.summary, '任务判断已完成。', '历史 structured activity 摘要必须保留')
const historyPlanRows = historyRowsForStages(['route', 'plan', 'generate', 'execution-preparation'])
assert.equal(historyPlanRows.length, 1, '历史纯 status route/plan/generate 只能保留一条')
assert.equal(historyPlanRows[0]?.summary, '生成计划状态（最新）。', '历史纯 status 重复必须保留最新摘要')
assert.equal(historyPlanRows[0]?.title, '准备执行', '历史准备 status 必须恢复真实生命周期标题')
const historyQueryRows = historyRowsForStages(['query'])
const historyRetrievalRows = historyRowsForStages(['retrieval'])
assert.equal(historyQueryRows.length, 1, '历史 query status/activity 重复只能保留一条')
assert.equal(historyRetrievalRows.length, 1, '历史 retrieval status/activity 重复只能保留一条')
assert.equal(historyQueryRows[0]?.activityId.startsWith('status-'), false, '历史 query 必须优先 structured activity')
assert.equal(historyRetrievalRows[0]?.activityId.startsWith('status-'), false, '历史 retrieval 必须优先 structured activity')
checks.push('persisted execution-log history prefers structured activity, collapses status-only repeats, and preserves separate query/retrieval rows')

// A provider may allocate a new id for the completion event.  The logical
// task-judgment row must still be updated rather than appended as a second row.
let taskJudgmentEntries: RegressionWorkLogEntry[] = []
taskJudgmentEntries = appendRegressionEntry(taskJudgmentEntries, {
  activityId: 'task-judgment-running-id',
  sequence: 101,
  stage: 'task-judgment',
  summary: '正在判断任务。',
  status: 'running'
})
taskJudgmentEntries = appendRegressionEntry(taskJudgmentEntries, {
  activityId: 'task-judgment-completed-id',
  sequence: 102,
  stage: 'task-judgment',
  summary: '任务判断已完成。',
  status: 'completed'
})
const taskJudgmentRows = rowsForStages(taskJudgmentEntries, ['task-judgment'])
assert.equal(taskJudgmentRows.length, 1, '不同 activityId 的 task-judgment 更新必须合并为一行')
assert.equal(taskJudgmentRows[0]?.status, 'completed', 'task-judgment 完成事件必须覆盖 running 状态')
assert.equal(taskJudgmentRows[0]?.summary, '任务判断已完成。', '合并后必须保留完成事件的安全摘要')

// route/plan/generate are three provider updates for one execution-preparation lifecycle. The
// sequence numbers intentionally differ so an id/sequence-only dedupe cannot
// make this test pass accidentally.
let planEntries: RegressionWorkLogEntry[] = []
for (const [stage, sequence] of [
  ['route', 201],
  ['plan', 202],
  ['generate', 203]
] as const) {
  planEntries = appendRegressionEntry(planEntries, {
    activityId: `plan-${stage}-id`,
    sequence,
    stage,
    summary: `${stage} 计划更新。`,
    status: 'running'
  })
}
const planRows = rowsForStages(planEntries, ['route', 'plan', 'generate', 'execution-preparation'])
assert.equal(planRows.length, 1, 'route/plan/generate 重复形成计划必须合并为一行')
assert.equal(planRows[0]?.status, 'running', '计划仍在形成时必须保留 running 状态')
assert.equal(planRows[0]?.summary, 'generate 计划更新。', '计划合并必须保留最新阶段摘要')

// Advancing into scope closes the previous plan row, while the scope
// checkpoint itself remains active until its own completion arrives.
const scopeEntries = appendRegressionEntry(planEntries, {
  activityId: 'scope-running-id',
  sequence: 204,
  kind: 'checkpoint',
  stage: 'scope-confirmation',
  summary: '正在确认执行范围。',
  status: 'running'
})
const scopePlanRows = rowsForStages(scopeEntries, ['route', 'plan', 'generate', 'execution-preparation'])
const scopeRows = rowsForStages(scopeEntries, ['scope', 'scope-confirmation'])
assert.equal(scopePlanRows.length, 1, '进入 scope 后计划行仍应保留以呈现历史')
assert.equal(scopePlanRows[0]?.status, 'completed', '进入 scope 后旧计划 running 必须收敛为 completed')
assert.equal(scopeRows.length, 1, 'scope checkpoint 必须产生一条当前生命周期记录')
assert.equal(scopeRows[0]?.status, 'running', 'scope 尚未确认时必须保留 running 状态')

// Lifecycle status is monotonic: a late duplicate running event must not
// regress a row that has already reached completed.
let monotonicScopeEntries: RegressionWorkLogEntry[] = []
monotonicScopeEntries = appendRegressionEntry(monotonicScopeEntries, {
  activityId: 'scope-completed-id',
  sequence: 205,
  kind: 'checkpoint',
  stage: 'scope-confirmation',
  summary: '范围已确认。',
  status: 'completed'
})
monotonicScopeEntries = appendRegressionEntry(monotonicScopeEntries, {
  activityId: 'scope-late-running-id',
  sequence: 206,
  kind: 'checkpoint',
  stage: 'scope-confirmation',
  summary: '重复的范围状态。',
  status: 'running'
})
const monotonicScopeRows = rowsForStages(monotonicScopeEntries, ['scope', 'scope-confirmation'])
assert.equal(monotonicScopeRows.length, 1, '重复 scope 更新不得产生第二条生命周期记录')
assert.equal(
  monotonicScopeRows[0]?.status,
  'completed',
  '已完成 scope 收到迟到 running 更新时必须保持 completed'
)

// Once verification has started, an out-of-order query update is stale and
// must not reopen the query lane as running.
let lateQueryEntries: RegressionWorkLogEntry[] = []
lateQueryEntries = appendRegressionEntry(lateQueryEntries, {
  activityId: 'late-query-initial-id',
  sequence: 207,
  kind: 'tool',
  stage: 'query',
  summary: '初始查询已完成。',
  status: 'completed'
})
lateQueryEntries = appendRegressionEntry(lateQueryEntries, {
  activityId: 'late-retrieval-initial-id',
  sequence: 208,
  kind: 'tool',
  stage: 'retrieval',
  summary: '初始检索已完成。',
  status: 'completed'
})
lateQueryEntries = appendRegressionEntry(lateQueryEntries, {
  activityId: 'late-evidence-id',
  sequence: 209,
  kind: 'checkpoint',
  stage: 'evidence',
  summary: '证据已返回。',
  status: 'completed'
})
lateQueryEntries = appendRegressionEntry(lateQueryEntries, {
  activityId: 'late-verification-running-id',
  sequence: 210,
  kind: 'checkpoint',
  stage: 'evidence-verification',
  summary: '正在核验证据。',
  status: 'running'
})
lateQueryEntries = appendRegressionEntry(lateQueryEntries, {
  activityId: 'late-query-after-verification-id',
  sequence: 211,
  kind: 'tool',
  stage: 'query',
  summary: '迟到的查询状态。',
  status: 'running'
})
assert.equal(
  rowsForStages(lateQueryEntries, ['query'])[0]?.status,
  'completed',
  'verification 开始后迟到的 query running 不得重新打开查询行'
)
assert.equal(
  rowsForStages(lateQueryEntries, ['evidence-verification'])[0]?.status,
  'running',
  '迟到 query 更新不得覆盖当前 verification running'
)

const rawPlanStatusMessage = 'provider-secret raw arguments must never be copied'
const routeStatus = workLogForStatus('route', `正在路由：${rawPlanStatusMessage}`)
const planStatus = workLogForStatus('plan', `正在形成计划：${rawPlanStatusMessage}`)
const generateStatus = workLogForStatus('generate', `正在生成计划：${rawPlanStatusMessage}`)
for (const [name, draft] of [
  ['route', routeStatus],
  ['plan', planStatus],
  ['generate', generateStatus]
] as const) {
  assert.equal(draft.stage, 'execution-preparation', `${name} 状态必须归一到 execution-preparation 生命周期`)
  assert.equal(draft.status, 'running', `${name} 进行中状态必须保持 running`)
  assert.doesNotMatch(draft.summary, new RegExp(rawPlanStatusMessage), `${name} 摘要不得回显原始状态消息`)
}
const completedPlanStatuses = [
  workLogForStatus('route', '执行准备已完成。'),
  workLogForStatus('plan', '已确定处理方式。'),
  workLogForStatus('generate', '准备已完成。')
]
for (const draft of completedPlanStatuses) {
  assert.equal(draft.stage, 'execution-preparation', '准备完成状态必须保持 execution-preparation 生命周期')
  assert.equal(draft.status, 'completed', '计划已生成/形成/完成消息必须进入 completed')
  assert.equal(draft.summary, '已确定处理方式，准备进入下一阶段。', '执行准备完成摘要必须使用固定安全文案')
}
const failedPlanStatus = workLogForStatus('generate', `执行准备失败：${rawPlanStatusMessage}`)
assert.notEqual(failedPlanStatus.status, 'completed', '失败 wording 不得误判为计划 completed')
assert.doesNotMatch(failedPlanStatus.summary, new RegExp(rawPlanStatusMessage), '失败计划摘要不得回显原始状态消息')
checks.push('lifecycle statuses are monotonic and route/plan/generate status messages normalize safely into execution-preparation')

// Query and retrieval are independent evidence lanes and are allowed to be
// active together.  They must not collapse merely because they share a rank.
let parallelEvidenceEntries: RegressionWorkLogEntry[] = []
parallelEvidenceEntries = appendRegressionEntry(parallelEvidenceEntries, {
  activityId: 'query-running-id',
  sequence: 301,
  kind: 'tool',
  stage: 'query',
  summary: '正在查询数据中心。',
  status: 'running'
})
parallelEvidenceEntries = appendRegressionEntry(parallelEvidenceEntries, {
  activityId: 'retrieval-running-id',
  sequence: 302,
  kind: 'tool',
  stage: 'retrieval',
  summary: '正在检索知识库。',
  status: 'running'
})
const parallelRows = rowsForStages(parallelEvidenceEntries, ['query', 'retrieval'])
assert.equal(parallelRows.length, 2, 'query 与 retrieval 必须保持两条并行证据通道')
assert.equal(
  parallelRows.every((entry) => entry.status === 'running'),
  true,
  'query 与 retrieval 可以同时处于 running'
)

// Entering evidence completes both collection lanes; verification then has
// its own active checkpoint and must remain running independently.
let verificationEntries: RegressionWorkLogEntry[] = []
verificationEntries = appendRegressionEntry(verificationEntries, {
  activityId: 'query-before-evidence-id',
  sequence: 401,
  kind: 'tool',
  stage: 'query',
  summary: '正在查询数据中心。',
  status: 'running'
})
verificationEntries = appendRegressionEntry(verificationEntries, {
  activityId: 'retrieval-before-evidence-id',
  sequence: 402,
  kind: 'tool',
  stage: 'retrieval',
  summary: '正在检索知识库。',
  status: 'running'
})
verificationEntries = appendRegressionEntry(verificationEntries, {
  activityId: 'evidence-completed-id',
  sequence: 403,
  kind: 'checkpoint',
  stage: 'evidence',
  summary: '证据已返回。',
  status: 'completed'
})
verificationEntries = appendRegressionEntry(verificationEntries, {
  activityId: 'verification-running-id',
  sequence: 404,
  kind: 'checkpoint',
  stage: 'evidence-verification',
  summary: '正在核验证据。',
  status: 'running'
})
assert.equal(
  rowsForStages(verificationEntries, ['query'])[0]?.status,
  'completed',
  '进入 evidence 后 query running 必须完成'
)
assert.equal(
  rowsForStages(verificationEntries, ['retrieval'])[0]?.status,
  'completed',
  '进入 evidence 后 retrieval running 必须完成'
)
assert.equal(
  rowsForStages(verificationEntries, ['evidence'])[0]?.status,
  'completed',
  'evidence checkpoint 必须保留 completed 状态'
)
assert.equal(
  rowsForStages(verificationEntries, ['evidence-verification'])[0]?.status,
  'running',
  '进入 verification 后当前核验 checkpoint 仍必须 running'
)

// Twenty realistic progress updates should not leave an obsolete running row
// behind.  The final completed delivery update makes the assertion independent
// of whether the UI keeps historical rows or merges logical lifecycle rows.
const twentyEventFixture: Array<Partial<RegressionWorkLogEntry>> = [
  { stage: 'task-judgment', summary: '判断开始。', status: 'running' },
  { stage: 'task-judgment', summary: '判断完成。', status: 'completed' },
  { stage: 'skill-selection', summary: '选择技能。', status: 'running' },
  { stage: 'route', summary: '路由计划。', status: 'running' },
  { stage: 'plan', summary: '计划步骤。', status: 'running' },
  { stage: 'generate', summary: '生成计划。', status: 'running' },
  { stage: 'scope-confirmation', kind: 'checkpoint', summary: '确认范围。', status: 'running' },
  { stage: 'scope-confirmation', kind: 'checkpoint', summary: '范围已确认。', status: 'completed' },
  { stage: 'query', kind: 'tool', summary: '查询开始。', status: 'running' },
  { stage: 'retrieval', kind: 'tool', summary: '检索开始。', status: 'running' },
  { stage: 'evidence', kind: 'checkpoint', summary: '证据已返回。', status: 'completed' },
  { stage: 'evidence-verification', kind: 'checkpoint', summary: '核验开始。', status: 'running' },
  { stage: 'evidence-verification', kind: 'checkpoint', summary: '核验完成。', status: 'completed' },
  { stage: 'query', kind: 'tool', summary: '补充查询。', status: 'running' },
  { stage: 'retrieval', kind: 'tool', summary: '补充检索。', status: 'running' },
  { stage: 'answer', kind: 'checkpoint', summary: '开始整理回答。', status: 'running' },
  { stage: 'delivery', kind: 'checkpoint', summary: '准备交付。', status: 'running' },
  { stage: 'delivery', kind: 'checkpoint', summary: '交付准备完成。', status: 'completed' },
  { stage: 'summary', kind: 'checkpoint', summary: '整理摘要。', status: 'running' },
  { stage: 'summary', kind: 'checkpoint', summary: '摘要整理完成。', status: 'completed' }
]
assert.equal(twentyEventFixture.length, 20, '回归 fixture 必须包含 20 条生命周期样例')
let twentyEntries: RegressionWorkLogEntry[] = []
twentyEventFixture.forEach((event, index) => {
  twentyEntries = appendRegressionEntry(twentyEntries, {
    ...event,
    activityId: `twenty-event-${index + 1}-id`,
    sequence: 500 + index,
    order: 500 + index
  })
})
assert.equal(
  twentyEntries.some((entry) => entry.status === 'running'),
  false,
  '20 条生命周期样例完成后不得残留旧 running 条目'
)

const terminalFixture = [
  makeRegressionWorkLogEntry({ activityId: 'terminal-old-running', sequence: 601, status: 'running' }),
  makeRegressionWorkLogEntry({ activityId: 'terminal-latest-running', sequence: 602, status: 'running' })
]
assert.equal(
  lifecycleReducer.settleAgentWorkLogEntries(terminalFixture, 'completed')
    .map((entry) => entry.status)
    .join(','),
  'completed,completed',
  '成功终态必须收敛全部 running 条目'
)
assert.equal(
  lifecycleReducer.settleAgentWorkLogEntries(terminalFixture, 'failed')
    .map((entry) => entry.status)
    .join(','),
  'completed,failed',
  '失败终态必须只保留最新 running 条目的 failed 结果'
)
assert.equal(
  lifecycleReducer.settleAgentWorkLogEntries(terminalFixture, 'cancelled')
    .map((entry) => entry.status)
    .join(','),
  'completed,warning',
  '取消终态必须只保留最新 running 条目的 warning 结果'
)
checks.push('renderer lifecycle reducer merges semantic stages, preserves parallel evidence lanes, and clears stale running rows across 20 updates')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
