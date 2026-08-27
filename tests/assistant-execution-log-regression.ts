import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

console.log(JSON.stringify({ ok: true, checks }, null, 2))
