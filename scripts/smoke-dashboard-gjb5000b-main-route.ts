import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const mainSource = readFileSync(
  new URL('../src/main/index.ts', import.meta.url),
  'utf8'
)

const assertSource = (pattern: RegExp, message: string): RegExpMatchArray => {
  const match = mainSource.match(pattern)
  assert.ok(match, message)
  return match
}

assertSource(
  /import\s*\{\s*runDashboardDomainChatRequest\s*\}\s*from\s*['"]\.\/experts\/dashboard-domain-chat['"]/,
  '主进程必须导入 runDashboardDomainChatRequest'
)

const visualizationStart = mainSource.indexOf("if (route.expert.id === 'visualization')")
assert.ok(visualizationStart >= 0, '主进程必须保留 visualization 专家分支')
const visualizationEnd = mainSource.indexOf("if (route.expert.id === 'requirement-analysis')", visualizationStart)
assert.ok(visualizationEnd > visualizationStart, 'visualization 分支边界缺失')
const visualizationBranch = mainSource.slice(visualizationStart, visualizationEnd)

const scopeIndex = visualizationBranch.indexOf('const scope =')
const queryEngineIndex = visualizationBranch.indexOf('const queryEngine = new QueryEngine(db)')
assert.ok(scopeIndex >= 0, '领域 helper 调用前必须解析数据 scope')
assert.ok(queryEngineIndex > scopeIndex, '领域 helper 调用前必须创建 QueryEngine')

const helperAssignment = visualizationBranch.match(
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?runDashboardDomainChatRequest\s*\(/s
)
assert.ok(helperAssignment, 'visualization 分支必须通过局部变量调用领域 chat helper')
const helperName = helperAssignment[1]
const helperCallIndex = helperAssignment.index ?? -1
assert.ok(helperCallIndex > queryEngineIndex,
  '领域 chat helper 必须在 scope 与 QueryEngine 均确定后调用')

const helperCallWindow = visualizationBranch.slice(helperCallIndex, helperCallIndex + 700)
assert.match(helperCallWindow, /question\s*:\s*route\.question/,
  '领域 chat helper 必须接收 route.question')
assert.match(helperCallWindow, /\bscope\b/, '领域 chat helper 必须接收 scope')
assert.match(helperCallWindow, /generatedAt/, '领域 chat helper 必须接收 generatedAt')
assert.match(helperCallWindow, /\}\s*,\s*queryEngine\s*\)/s,
  '领域 chat helper 必须接收当前 QueryEngine')

const generationIndex = visualizationBranch.indexOf('agent.generate(route.question, scope)')
assert.ok(generationIndex > helperCallIndex,
  '领域 chat helper 必须在 VisualizationAgent.generate 之前执行')

const patchGuardPrefix = visualizationBranch.slice(Math.max(0, helperCallIndex - 1600), helperCallIndex)
assert.match(patchGuardPrefix, /!isPatchRequest|isPatchRequest\s*===\s*false/,
  '领域 chat helper 只能用于生成路径，必须排除 patch 请求')
assert.match(
  visualizationBranch,
  /activeArtifact\s*&&\s*isPatchRequest[\s\S]*?agent\.patch\s*\(/,
  '现有 activeArtifact patch 请求必须继续走 VisualizationAgent.patch'
)

const recognizedFalseIndex = visualizationBranch.indexOf(`!${helperName}.recognized`)
assert.ok(recognizedFalseIndex >= 0, 'recognized=false 必须保留通用可视化生成分支')
const recognizedFalseRegion = visualizationBranch.slice(recognizedFalseIndex, generationIndex + 120)
assert.match(recognizedFalseRegion, /agent\.generate\(route\.question,\s*scope\)/,
  'recognized=false 必须继续既有 VisualizationAgent.generate')

const readyIndex = visualizationBranch.indexOf(`${helperName}.status === 'ready'`)
assert.ok(readyIndex >= 0, '领域 chat ready 结果必须单独分流')
const clarificationIndex = visualizationBranch.indexOf(`${helperName}.status === 'clarification'`)
assert.ok(clarificationIndex > readyIndex, 'ready 分流后必须处理 clarification')
const rejectedIndex = visualizationBranch.indexOf(`${helperName}.status === 'rejected'`)
assert.ok(rejectedIndex > clarificationIndex, 'clarification 分流后必须处理 rejected')

const readyRegion = visualizationBranch.slice(readyIndex, clarificationIndex)
assert.match(readyRegion, new RegExp(`dashboard\\s*:\\s*${helperName}\\.dashboard`),
  'ready 结果必须交付 helper 返回的 dashboard')
assert.match(readyRegion, new RegExp(`answer\\s*:\\s*${helperName}\\.answer`),
  'ready 结果 answer 不得覆盖 helper 的受控样例/预览说明')
assert.match(readyRegion, /type:\s*['"]artifact['"]/,
  'ready 结果必须发出 dashboard artifact event')
assert.match(readyRegion, new RegExp(`artifactId\\s*:\\s*${helperName}\\.dashboard\\.id`),
  'artifact event 必须引用 helper dashboard id')
assert.match(readyRegion, new RegExp(`dashboard\\s*:\\s*${helperName}\\.dashboard`),
  'artifact event 必须携带 helper dashboard')

const clarificationRegion = visualizationBranch.slice(clarificationIndex, rejectedIndex)
assert.match(clarificationRegion, /needsClarification\s*:\s*true/,
  '领域 clarification 必须标记 needsClarification')
assert.match(clarificationRegion, /clarificationQuestion\s*:/,
  '领域 clarification 必须返回 clarificationQuestion')
assert.match(clarificationRegion, /clarificationOptions\s*:/,
  '领域 clarification 必须返回 clarificationOptions')
assert.match(clarificationRegion, /attachAssistantIntent\s*\(/,
  '领域 clarification 必须经过 attachAssistantIntent')
assert.match(clarificationRegion, /status\s*:\s*['"]clarification['"]/,
  '领域 clarification task trace 必须标记 clarification')

const rejectedRegion = visualizationBranch.slice(rejectedIndex, generationIndex)
assert.match(rejectedRegion, /recoverable\s*:\s*true/,
  '领域 rejected 必须返回可恢复错误')
assert.match(rejectedRegion, /type\s*:\s*['"]error['"]/,
  '领域 rejected 必须返回 error event')
assert.match(rejectedRegion, /dashboard\s*:\s*undefined/,
  '领域 rejected 不得交付 dashboard')
assert.match(rejectedRegion, /attachAssistantIntent\s*\(/,
  '领域 rejected 必须经过统一响应/trace 封装')

assert.ok(
  (visualizationBranch.match(/runDashboardDomainChatRequest\s*\(/g) ?? []).length === 1,
  'visualization 分支只应有一个领域 chat helper 调用点'
)

console.log(JSON.stringify({
  ok: true,
  checked: {
    helper: 'runDashboardDomainChatRequest',
    helperVariable: helperName,
    scopeBeforeHelper: true,
    queryEngineBeforeHelper: true,
    helperBeforeGenericGenerate: true,
    genericFallback: true,
    readyArtifact: true,
    clarificationTrace: true,
    rejectedRecoverable: true,
    patchRemainsVisualizationAgent: true
  }
}, null, 2))
