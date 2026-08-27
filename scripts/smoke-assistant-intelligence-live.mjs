import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import {
  buildOnlinePlan,
  shouldRunUiPreparation,
  summarizeCoverage,
  selectOnlineCases,
  withTimeout
} from './assistant-intelligence-live-plan.mjs'

const cdpPort = process.env.VISSLM_CDP_PORT ?? '9223'
const outputDirectory = process.env.VISSLM_ASSISTANT_LIVE_AUDIT_DIR
  ?? join(process.cwd(), 'artifacts', 'assistant-intelligence-audit', 'live')
const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'assistant-intelligence-eval-set.json')
const fixtureVersion = 'assistant-intelligence-eval-v2'
const expectedProvider = 'rawchat-codex'
const expectedBaseUrl = 'https://rawchat.cn/codex'
const expectedModel = 'gpt-5.6-sol'
const forbiddenInternalWording = /统一意图决策|任务类型|数据来源|结果形式|taskType|sourceMode|resultMode|skillId/iu
const zeroCountPattern = /(?:零|0)\s*(?:条|个|项|记录|需求)|没有找到|未找到|未命中|没有命中/iu
const sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration))

const integerEnv = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, value))
}

const requestedRepetitions = integerEnv('VISSLM_ASSISTANT_LIVE_REPETITIONS', 3, 1, 5)
const cdpCallTimeoutMs = integerEnv('VISSLM_ASSISTANT_CDP_CALL_TIMEOUT_MS', 900_000, 5_000, 3_600_000)
const caseRequestTimeoutMs = integerEnv('VISSLM_ASSISTANT_LIVE_CASE_TIMEOUT_MS', 240_000, 5_000, cdpCallTimeoutMs)
const skipModelProbe = process.env.VISSLM_ASSISTANT_LIVE_SKIP_MODEL_PROBE === '1'
const skipUiProbes = process.env.VISSLM_ASSISTANT_LIVE_SKIP_UI_PROBES === '1'
const requestedMode = String(process.env.VISSLM_ASSISTANT_LIVE_MODE ?? 'standard').trim().toLowerCase()
const liveMode = ['coverage', 'stability', 'standard'].includes(requestedMode) ? requestedMode : 'standard'
const requestedIds = new Set(
  (process.env.VISSLM_ASSISTANT_LIVE_CASE_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
)

const safeHash = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex').slice(0, 16)

const safeErrorCategory = (error) => {
  const name = String(error?.name ?? '').toLocaleLowerCase()
  if (name.includes('abort') || name.includes('timeout')) return 'dependency-timeout'
  if (name.includes('network') || name.includes('fetch') || name.includes('socket')) return 'dependency-unavailable'
  return 'runtime-error'
}

const safeStatus = (item) => {
  if (!item || typeof item !== 'object') return 'unknown'
  const status = String(item.status ?? '').trim()
  return ['supported', 'limited', 'unsupported', 'unknown', 'error'].includes(status) ? status : 'unknown'
}

const safeCapability = (item) => {
  if (!item || typeof item !== 'object') return { status: 'unknown' }
  const result = { status: safeStatus(item) }
  if (item.evidence === 'metadata' || item.evidence === 'active-probe' || item.evidence === 'provider-contract') {
    result.evidence = item.evidence
  }
  if (typeof item.value === 'boolean' || typeof item.value === 'number' || typeof item.value === 'string') {
    result.value = item.value
  }
  return result
}

const safeRunId = () => crypto.randomUUID()

let fixture = []
try {
  const parsed = JSON.parse(readFileSync(fixturePath, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error('fixture-not-array')
  fixture = parsed
} catch {
  // The report is still written below. Do not print a parser error that could
  // accidentally include a local path or an untrusted fixture value.
  fixture = []
}

const selectedCases = selectOnlineCases(fixture, [...requestedIds])
const selectedStabilityCases = selectedCases.filter((item) => item.onlineTracks.includes('stability') || item.onlineTracks.includes('both'))
const executionPlan = buildOnlinePlan(fixture, {
  mode: liveMode,
  requestedIds: [...requestedIds],
  stabilityRepetitions: requestedRepetitions
}).executions

mkdirSync(outputDirectory, { recursive: true })

const report = {
  schemaVersion: 'assistant-intelligence-live-v2',
  track: 'online-live',
  fixtureVersion,
  status: 'blocked',
  ok: false,
  cdpPort,
  startedAt: new Date().toISOString(),
  mode: liveMode,
  requestedRepetitions,
  samplePolicy: {
    minimumUniqueQuestions: 18,
    minimumScenarioCategories: 10,
    stabilityRepetitions: requestedRepetitions,
    caseRequestTimeoutMs,
    stability: requestedRepetitions >= 3 ? 'eligible' : 'exploratory-only',
    coverage: liveMode === 'stability' ? 'not-requested' : 'requested',
    independentQuestionCount: selectedCases.length,
    executionSampleCount: executionPlan.length
  },
  model: {
    provider: '',
    baseUrl: '',
    model: '',
    hasApiKey: false
  },
  checks: {},
  runtimeTruth: {
    recordTotal: null,
    status: 'not-assessed'
  },
  coverage: summarizeCoverage(selectedCases),
  stability: summarizeCoverage(selectedStabilityCases, {
    repetitionCount: requestedRepetitions
  }),
  cases: [],
  groups: [],
  screenshots: {}
}

let sequence = 0
let socket
const pending = new Map()

const call = (method, params = {}) => new Promise((resolve, reject) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    reject(new Error('cdp-unavailable'))
    return
  }
  const id = ++sequence
  const timer = setTimeout(() => {
    pending.delete(id)
    const error = new Error('cdp-call-timeout')
    error.name = 'TimeoutError'
    reject(error)
  }, cdpCallTimeoutMs)
  const settle = (message) => {
    clearTimeout(timer)
    if (message.error) reject(new Error('cdp-evaluation-failed'))
    else resolve(message)
  }
  pending.set(id, { reject, settle, timer })
  socket.send(JSON.stringify({ id, method, params }), (error) => {
    if (!error || !pending.has(id)) return
    clearTimeout(timer)
    pending.delete(id)
    reject(new Error('cdp-send-failed'))
  })
})

const rejectPendingCalls = (reason) => {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.reject(new Error(reason))
  }
}

const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (response.result?.exceptionDetails) throw new Error('renderer-evaluation-failed')
  return response.result?.result?.value
}

const waitFor = async (probe, description, timeoutMs = 300_000) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await evaluate(probe)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`wait-timeout:${description}`)
}

const capture = async (name) => {
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const path = join(outputDirectory, name)
  writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
  return path
}

const connectToRenderer = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
  const target = targets.find((item) => item.type === 'page' && item.title === 'VISSLM Agent')
  if (!target?.webSocketDebuggerUrl) throw new Error('cdp-target-unavailable')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('cdp-socket-unavailable')))
  })
  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString('utf8'))
    } catch {
      return
    }
    if (!message.id || !pending.has(message.id)) return
    pending.get(message.id).settle(message)
    pending.delete(message.id)
  })
  socket.on('close', () => rejectPendingCalls('cdp-socket-disconnected'))
  socket.on('error', () => rejectPendingCalls('cdp-socket-unavailable'))
}

const modelMetadata = async () => evaluate(`(async () => {
  const settings = await window.visslm.getSettings()
  const model = settings?.model ?? {}
  return {
    provider: typeof model.provider === 'string' ? model.provider : '',
    baseUrl: typeof model.baseUrl === 'string' ? model.baseUrl : '',
    model: typeof model.model === 'string' ? model.model : '',
    hasApiKey: model.hasApiKey === true
  }
})()`)

const readRuntimeRecordTotal = async () => {
  try {
    const total = await evaluate(`(async () => {
      const page = await window.visslm.listRecords({ page: 1, pageSize: 1 })
      const value = Number(page?.total)
      return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
    })()`)
    return Number.isInteger(total) && total >= 0 ? total : null
  } catch {
    return null
  }
}

const modelProbe = async () => {
  const startedAt = Date.now()
  const connectionRunId = safeRunId()
  const probe = await evaluate(`(async () => {
    const capability = (item) => {
      if (!item || typeof item !== 'object') return { status: 'unknown' }
      const status = ['supported', 'limited', 'unsupported', 'unknown', 'error'].includes(String(item.status ?? ''))
        ? String(item.status)
        : 'unknown'
      const result = { status }
      if (item.evidence === 'metadata' || item.evidence === 'active-probe' || item.evidence === 'provider-contract') {
        result.evidence = item.evidence
      }
      if (typeof item.value === 'boolean' || typeof item.value === 'number' || typeof item.value === 'string') {
        result.value = item.value
      }
      return result
    }
    try {
      const result = await window.visslm.testModel({
        source: 'online',
        provider: ${JSON.stringify(expectedProvider)},
        baseUrl: ${JSON.stringify(expectedBaseUrl)},
        model: ${JSON.stringify(expectedModel)},
        thinking: false
      }, true, true)
      const checks = result?.capabilityReport?.checks ?? {}
      return {
        ok: result?.ok === true,
        httpStatus: Number.isFinite(Number(result?.details?.status)) ? Number(result.details.status) : null,
        connection: capability(checks.connection),
        minimalChat: capability(checks.minimalChat),
        structuredOutput: capability(checks.structuredOutput),
        toolCalling: capability(checks.toolCalling)
      }
    } catch (error) {
      const name = String(error?.name ?? '').toLocaleLowerCase()
      return { ok: false, errorCategory: name.includes('abort') ? 'dependency-timeout' : 'dependency-unavailable' }
    }
  })()`)
  return {
    connectionRunId,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(probe && typeof probe === 'object' ? probe : { ok: false, errorCategory: 'runtime-error' })
  }
}

const uiFailureStages = new Set([
  'composer',
  'sendable',
  'user-render',
  'assistant-render',
  'dark-summary',
  'light-summary',
  'capture'
])

const uiFailure = (failureStage, error) => {
  const failure = new Error('ui-probe-failed')
  failure.failureStage = uiFailureStages.has(failureStage) ? failureStage : 'assistant-render'
  failure.errorCategory = safeErrorCategory(error)
  return failure
}

const uiFailureStageOf = (error, fallback = 'assistant-render') => (
  uiFailureStages.has(error?.failureStage) ? error.failureStage : fallback
)

const uiErrorCategoryOf = (error) => (
  ['dependency-timeout', 'dependency-unavailable', 'runtime-error'].includes(error?.errorCategory)
    ? error.errorCategory
    : safeErrorCategory(error)
)

const waitForUiStage = async (probe, description, timeoutMs, failureStage) => {
  try {
    return await waitFor(probe, description, timeoutMs)
  } catch (error) {
    throw uiFailure(failureStage, error)
  }
}

const ensureTheme = async (theme, failureStage) => {
  try {
    const toggledOrReady = await evaluate(`(() => {
      const root = document.documentElement
      if (root.dataset.theme === ${JSON.stringify(theme)}) return true
      const toggle = document.querySelector('button.window-theme-toggle')
      if (!(toggle instanceof HTMLButtonElement)) return false
      toggle.click()
      return true
    })()`)
    if (!toggledOrReady) throw new Error('theme-toggle-unavailable')
    await waitFor(
      `document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      `theme-${theme}`,
      5_000
    )
    await sleep(240)
  } catch (error) {
    throw uiFailure(failureStage, error)
  }
}

const restoreTheme = async (theme) => {
  if (theme !== 'dark' && theme !== 'light') return
  try {
    const current = await evaluate('document.documentElement.dataset.theme || "dark"')
    if (current === theme) return
    const toggled = await evaluate(`(() => {
      const toggle = document.querySelector('button.window-theme-toggle')
      if (!(toggle instanceof HTMLButtonElement)) return false
      toggle.click()
      return true
    })()`)
    if (!toggled) return
    await waitFor(`document.documentElement.dataset.theme === ${JSON.stringify(theme)}`, `restore-theme-${theme}`, 5_000)
  } catch {
    // Theme restoration is best effort and must never replace the diagnostic
    // stage or expose renderer error text in the report.
  }
}

const safeUiSummary = async (theme) => evaluate(`(() => {
  const rows = [...document.querySelectorAll('.chat-page .message-row.assistant')]
  const latest = rows.reverse().find((row) => {
    const bubble = row.querySelector('.message-bubble')
    return Boolean(bubble && !bubble.classList.contains('thinking') && !bubble.classList.contains('streaming-answer-bubble'))
  })
  const answer = latest?.querySelector('.message-bubble')?.textContent?.trim() ?? ''
  const input = document.querySelector('.chat-page .composer textarea[aria-label="输入问题"]')
  const send = document.querySelector('.chat-page button.chat-send-button')
  const messageList = document.querySelector('.chat-page .message-list[role="log"]')
  const bubble = latest?.querySelector('.message-bubble')
  const rgb = (value) => (String(value).match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number)
  const luminance = (value) => {
    const [red = 0, green = 0, blue = 0] = rgb(value).map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
  }
  const style = bubble ? getComputedStyle(bubble) : null
  const foreground = style?.color ?? 'rgb(0, 0, 0)'
  const background = style?.backgroundColor ?? getComputedStyle(document.body).backgroundColor
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
   const countMatch = answer.match(/(?:共|总计|合计|命中|匹配|找到|有|一共有|当前|本次|返回|展示|载入|加载)?\\s*[（(]?\\s*(\\d{1,9})\\s*[）)]?\\s*(?:条|个|项|记录|需求)?/u)
   return {
     theme: ${JSON.stringify(theme)},
     themeMatches: document.documentElement.dataset.theme === ${JSON.stringify(theme)},
    answerPresent: answer.length > 0,
    answerLength: answer.length,
    answerCount: countMatch ? Number(countMatch[1]) : null,
    answerHasZeroPhrase: /(?:零|0)\\s*(?:条|个|项|记录|需求)|没有找到|未找到|未命中|没有命中/iu.test(answer),
    internalWordingVisible: ${forbiddenInternalWording}.test(answer),
    hasEvidenceLabel: Boolean(latest?.textContent?.includes('回答依据') || latest?.querySelector('[aria-label*="回答依据"]')),
    contrastRatio: Number(((light + 0.05) / (dark + 0.05)).toFixed(2)),
    inputAccessibleName: input?.getAttribute('aria-label') ?? '',
    sendAccessibleName: send?.getAttribute('aria-label') ?? '',
    messageRole: messageList?.getAttribute('role') ?? '',
    messageAccessibleName: messageList?.getAttribute('aria-label') ?? '',
    pageFitsViewport: Boolean(document.querySelector('.chat-page')?.getBoundingClientRect().bottom <= innerHeight),
    composerVisible: Boolean(document.querySelector('.chat-page .composer')?.getBoundingClientRect().bottom <= innerHeight)
  }
})()`)

const submitInComposer = async (question, before) => {
  let submitted
  try {
    submitted = await evaluate(`(() => {
      const input = document.querySelector('.chat-page .composer textarea[aria-label="输入问题"]')
      const button = document.querySelector('.chat-page button.chat-send-button')
      if (!(input instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (!setter) return false
      setter.call(input, ${JSON.stringify(question)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.focus()
      return true
    })()`)
  } catch (error) {
    throw uiFailure('composer', error)
  }
  if (!submitted) throw uiFailure('composer')
  await waitForUiStage(
    `(() => {
      const input = document.querySelector('.chat-page .composer textarea[aria-label="输入问题"]')
      const button = document.querySelector('.chat-page button.chat-send-button')
      return Boolean(input instanceof HTMLTextAreaElement && button instanceof HTMLButtonElement &&
        input.value.trim() && !button.disabled && button.getAttribute('aria-label') === '发送')
    })()`,
    'question-sendable',
    10_000,
    'sendable'
  )
  let clicked
  try {
    clicked = await evaluate(`(() => {
      const button = document.querySelector('.chat-page button.chat-send-button')
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false
      button.click()
      return true
    })()`)
  } catch (error) {
    throw uiFailure('sendable', error)
  }
  if (!clicked) throw uiFailure('sendable')
  await waitForUiStage(
    `document.querySelectorAll('.chat-page .message-row.user').length > ${before.userCount}`,
    'user-message-rendered',
    15_000,
    'user-render'
  )
  await waitForUiStage(
    `(() => {
      const rows = [...document.querySelectorAll('.chat-page .message-row.assistant')]
      const newRows = rows.slice(${before.assistantCount})
      const rendered = newRows.some((row) => {
        const bubble = row.querySelector('.message-bubble')
        if (!bubble || bubble.classList.contains('thinking') || bubble.classList.contains('streaming-answer-bubble')) return false
        return Boolean(row.querySelector('.message-body')?.textContent?.trim() || row.querySelector('.chat-clarification'))
       })
       const button = document.querySelector('.chat-page button.chat-send-button')
       return rendered && Boolean(button instanceof HTMLButtonElement && button.getAttribute('aria-label') === '发送')
     })()`,
    'assistant-message-rendered',
    300_000,
    'assistant-render'
  )
  try {
    await evaluate(`(() => { const list = document.querySelector('.chat-page .message-list[role="log"]'); if (list) list.scrollTop = list.scrollHeight; return true })()`)
  } catch {
    // Scrolling is helpful for screenshots but not a completion criterion.
  }
  await sleep(300)
}

const runUiProbe = async (item) => {
  const startedAt = Date.now()
  let originalTheme
  try {
    let before
    try {
      before = await evaluate(`(() => ({
        userCount: document.querySelectorAll('.chat-page .message-row.user').length,
        assistantCount: document.querySelectorAll('.chat-page .message-row.assistant').length
      }))()`)
    } catch (error) {
      throw uiFailure('composer', error)
    }
    await submitInComposer(item.question, before)
    try {
      originalTheme = await evaluate('document.documentElement.dataset.theme || "dark"')
    } catch (error) {
      throw uiFailure('composer', error)
    }
    await ensureTheme('dark', 'dark-summary')
    let darkScreenshot
    try {
      darkScreenshot = await capture('02-live-count-answer-dark.png')
    } catch (error) {
      throw uiFailure('capture', error)
    }
    let dark
    try {
      dark = await safeUiSummary('dark')
    } catch (error) {
      throw uiFailure('dark-summary', error)
    }
    await ensureTheme('light', 'light-summary')
    let lightScreenshot
    try {
      lightScreenshot = await capture('03-live-count-answer-light.png')
    } catch (error) {
      throw uiFailure('capture', error)
    }
    let light
    try {
      light = await safeUiSummary('light')
    } catch (error) {
      throw uiFailure('light-summary', error)
    }
    return {
      status: 'observed',
      durationMs: Math.max(0, Date.now() - startedAt),
      dark,
      light,
      screenshots: { dark: darkScreenshot, light: lightScreenshot }
    }
  } catch (error) {
    return {
      status: 'not-assessed',
      durationMs: Math.max(0, Date.now() - startedAt),
      failureStage: uiFailureStageOf(error),
      errorCategory: uiErrorCategoryOf(error)
    }
  } finally {
    await restoreTheme(originalTheme)
  }
}

const runClarificationUiProbe = async () => {
  const startedAt = Date.now()
  let originalTheme
  try {
    let before
    try {
      before = await evaluate(`(() => ({
        userCount: document.querySelectorAll('.chat-page .message-row.user').length,
        assistantCount: document.querySelectorAll('.chat-page .message-row.assistant').length
      }))()`)
    } catch (error) {
      throw uiFailure('composer', error)
    }
    await submitInComposer('请处理一下', before)
    try {
      originalTheme = await evaluate('document.documentElement.dataset.theme || "dark"')
    } catch (error) {
      throw uiFailure('composer', error)
    }
    let clarification
    try {
      clarification = await evaluate(`(() => {
      const latest = [...document.querySelectorAll('.chat-page .message-row.assistant')].reverse().find((row) => row.querySelector('.chat-clarification'))
      const group = latest?.querySelector('.chat-clarification')
      const optionButtons = [...(group?.querySelectorAll('button') ?? [])]
      return {
        questionPresent: Boolean(group?.textContent?.trim()),
        optionCount: optionButtons.length,
        hasAccessibleGroup: Boolean(group?.getAttribute('role') === 'group' && group?.getAttribute('aria-labelledby')),
        hasPlanCard: Boolean(latest?.querySelector('.agent-plan-card, [aria-label="执行计划确认卡片"]')),
        internalWordingVisible: ${forbiddenInternalWording}.test(latest?.textContent ?? '')
      }
    })()`)
    } catch (error) {
      throw uiFailure('assistant-render', error)
    }
    await ensureTheme('dark', 'dark-summary')
    try {
      await evaluate(`(() => { const list = document.querySelector('.chat-page .message-list[role="log"]'); if (list) list.scrollTop = list.scrollHeight; return true })()`)
    } catch {
      // Scrolling is best effort for the clarification screenshot.
    }
    let clarificationScreenshot
    try {
      clarificationScreenshot = await capture('04-live-clarification-choices-dark.png')
    } catch (error) {
      throw uiFailure('capture', error)
    }
    return { status: 'observed', clarification, screenshots: { clarification: clarificationScreenshot } }
  } catch (error) {
    return {
      status: 'not-assessed',
      durationMs: Math.max(0, Date.now() - startedAt),
      failureStage: uiFailureStageOf(error),
      errorCategory: uiErrorCategoryOf(error)
    }
  } finally {
    await restoreTheme(originalTheme)
  }
}

const assistantCaseExpression = (item, runId) => {
  const serializedCase = JSON.stringify({
    id: item.id,
    track: item.track,
    repetition: item.repetition,
    onlineScenario: item.onlineScenario,
    evaluationGroup: item.evaluationGroup,
    question: item.question,
    history: item.history,
    expectedGroupEntities: item.expectedGroupEntities,
    expectedGroundedTerms: item.expectedGroundedTerms
  })
  const serializedRunId = JSON.stringify(runId)
  return `(async () => {
    const item = ${serializedCase}
    const forbidden = ${forbiddenInternalWording}
    const zeroPhrase = ${zeroCountPattern}
    const countFrom = (answer) => {
      const match = String(answer ?? '').match(/(?:共|总计|合计|命中|匹配|找到|有|一共有|当前|本次|返回|展示|载入|加载)?\\s*[（(]?\\s*(\\d{1,9})\\s*[）)]?\\s*(?:条|个|项|记录|需求)?/u)
      return match ? Number(match[1]) : null
    }
    const zeroFrom = (answer) => zeroPhrase.test(String(answer ?? ''))
    const digest = (values) => {
      const source = [...new Set(values.map((value) => String(value)).filter(Boolean))].sort().join('|')
      let hash = 2166136261
      for (const character of source) {
        hash ^= character.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
      }
      return (hash >>> 0).toString(16).padStart(8, '0')
    }
    const errorCategory = (error) => {
      const name = String(error?.name ?? '').toLocaleLowerCase()
      return name.includes('abort') || name.includes('timeout') ? 'dependency-timeout' : 'assistant-request-failed'
    }
    const summarize = (item, repetition, response, runId, durationMs) => {
      const answer = String(response?.answer ?? '')
      const trace = response?.taskTrace && typeof response.taskTrace === 'object' ? response.taskTrace : {}
      const intent = response?.assistantIntent && typeof response.assistantIntent === 'object' ? response.assistantIntent : {}
      const views = Array.isArray(response?.dataViews) ? response.dataViews : []
      const sources = Array.isArray(response?.sources) ? response.sources : []
      const evidence = Array.isArray(response?.evidenceBlocks) ? response.evidenceBlocks : []
      const uids = views.flatMap((view) => Array.isArray(view?.recordUids) ? view.recordUids : [])
      const groundedScopeTerms = [
        ...(Array.isArray(intent.searchTerms) ? intent.searchTerms : []),
        ...(Array.isArray(intent.groupEntities) ? intent.groupEntities : []),
        ...(Array.isArray(response?.executionSummary?.searchTerms) ? response.executionSummary.searchTerms : []),
        ...(Array.isArray(response?.executionSummary?.groupEntities) ? response.executionSummary.groupEntities : [])
      ]
        .map((value) => String(value).trim())
        .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
      const expectedEntities = item.expectedGroupEntities ?? []
      const expectedTerms = item.expectedGroundedTerms ?? []
      return {
        id: item.id,
        track: item.track ?? 'coverage',
        repetition,
        runId,
        status: 'observed',
        durationMs,
        answerPresent: answer.trim().length > 0,
        answerLength: answer.length,
        answerCount: countFrom(answer),
        answerHasZeroPhrase: zeroFrom(answer),
        internalWordingVisible: forbidden.test(answer) || forbidden.test(String(response?.clarificationQuestion ?? '')),
        needsClarification: response?.needsClarification === true,
        clarificationOptionCount: Array.isArray(response?.clarificationOptions) ? response.clarificationOptions.length : 0,
        clarificationQuestionPresent: String(response?.clarificationQuestion ?? '').trim().length > 0,
         traceStatus: String(trace.status ?? ''),
         taskType: String(trace.taskType ?? intent.taskType ?? ''),
         skillId: String(intent.skillId ?? ''),
         sourceMode: String(trace.sourceMode ?? intent.sourceMode ?? ''),
        resultMode: String(trace.resultMode ?? intent.resultMode ?? ''),
        invokedAgentCount: Array.isArray(trace.invokedAgents) ? trace.invokedAgents.length : 0,
        recordEvidenceCount: sources.filter((source) => source?.sourceType !== 'document').length,
        documentEvidenceCount: sources.filter((source) => source?.sourceType === 'document').length,
        dataViewCount: views.length,
        matchedCount: views.reduce((sum, view) => sum + (Number.isFinite(Number(view?.total)) ? Number(view.total) : 0), 0),
        returnedCount: views.reduce((sum, view) => sum + (Number.isFinite(Number(view?.loadedRows)) ? Number(view.loadedRows) : 0), 0),
        preview: views.some((view) => view?.isPreview === true),
        recordUidCount: [...new Set(uids.map((value) => String(value)))].length,
        recordUidDigest: digest(uids),
        evidenceBlockCount: evidence.length,
        aggregateEvidenceCount: evidence.filter((block) => block?.kind === 'aggregate').length,
        truncatedEvidenceCount: evidence.filter((block) => block?.truncated === true).length,
        expectedEntityCount: expectedEntities.length,
        groundedExpectedEntityCount: expectedEntities.filter((expected) => groundedScopeTerms.includes(expected)).length,
        expectedGroundedTermCount: expectedTerms.length,
        groundedExpectedTermCount: expectedTerms.filter((expected) => groundedScopeTerms.includes(expected)).length
      }
    }
    const repetition = item.repetition ?? 1
    const startedAt = performance.now()
    try {
      const response = await window.visslm.askAgent({
        runId: ${serializedRunId},
        conversationId: crypto.randomUUID(),
        question: item.question,
        history: item.history,
        entrypoint: 'chat',
        expertId: 'general',
        chatMode: 'auto',
        thinkingMode: 'off'
      })
      return summarize(item, repetition, response, ${serializedRunId}, Math.max(0, Math.round(performance.now() - startedAt)))
    } catch (error) {
      return {
        id: item.id,
        track: item.track,
        repetition,
        runId: ${serializedRunId},
        status: 'not-assessed',
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        failureStage: 'assistant-request',
        errorCategory: errorCategory(error)
      }
    }
  })()`
}

const cancelAssistantRun = async (runId) => {
  try {
    await withTimeout(
      () => evaluate(`(async () => {
        const cancel = window.visslm?.cancelAgentRun
        if (typeof cancel !== 'function') return false
        await cancel(${JSON.stringify(runId)})
        return true
      })()`),
      Math.min(10_000, cdpCallTimeoutMs)
    )
  } catch {
    // Cancellation is best effort. The timed-out CDP evaluation remains
    // tracked so it can settle later without blocking the rest of the plan.
  }
}

const runAssistantCases = async () => {
  const results = []
  for (const item of executionPlan) {
    const runId = safeRunId()
    const startedAt = Date.now()
    try {
      const outcome = await withTimeout(
        () => evaluate(assistantCaseExpression(item, runId)),
        caseRequestTimeoutMs
      )
      if (outcome.timedOut) {
        await cancelAssistantRun(runId)
        results.push({
          id: item.id,
          track: item.track,
          repetition: item.repetition,
          runId,
          status: 'not-assessed',
          durationMs: Math.max(0, Date.now() - startedAt),
          failureStage: 'assistant-request',
          errorCategory: 'dependency-timeout'
        })
        await sleep(500)
        continue
      }
      results.push(outcome.value)
    } catch (error) {
      results.push({
        id: item.id,
        track: item.track,
        repetition: item.repetition,
        runId,
        status: 'not-assessed',
        durationMs: Math.max(0, Date.now() - startedAt),
        failureStage: 'assistant-request',
        errorCategory: safeErrorCategory(error)
      })
    }
  }
  return results
}

const hasEvidence = (result) => Boolean(
  result.recordEvidenceCount || result.documentEvidenceCount || result.dataViewCount || result.evidenceBlockCount
)

const shouldRequireCount = (item) => [
  'count',
  'keyword-count',
  'status-count',
  'date-count',
  'zero-result',
  'record-pagination'
].includes(item.onlineScenario) || item.expected.answerCountRequired === true

const clarificationExpectation = (item) => item.onlineScenario === 'clarification' || item.expected.needsClarification === true

const countCasePasses = (item, result, runtimeRecordTotal) => {
  if (result.status !== 'observed') return { status: 'not-assessed', failures: [result.failureStage ?? 'assistant-request'] }
  if (item.evaluationGroup === 'synonymous_total_count' && runtimeRecordTotal === null) {
    return { status: 'not-assessed', failures: ['runtime-record-total-unavailable'] }
  }
  const failures = []
  for (const field of ['taskType', 'skillId', 'sourceMode', 'resultMode']) {
    if (item.expected[field] && result[field] !== item.expected[field]) failures.push(`route:${field}`)
  }
  if (item.expected.needsClarification === false && result.needsClarification) failures.push('unexpected-clarification')
  if (result.traceStatus !== 'completed') failures.push('trace-not-completed')
  if (!result.answerPresent) failures.push('empty-answer')
  if (result.internalWordingVisible || item.expected.noInternalWording && result.internalWordingVisible) failures.push('internal-wording')
  if (item.expected.evidenceRequired && !hasEvidence(result) && !item.expected.allowZero) failures.push('missing-evidence')
  if (item.expected.recordEvidenceRequired && !result.recordEvidenceCount && !result.dataViewCount) failures.push('missing-record-evidence')
  if (item.expected.documentEvidenceRequired && !result.documentEvidenceCount) {
    if (item.expected.capability) return { status: 'not-assessed', failures: [`capability:${item.expected.capability}-unavailable`] }
    failures.push('missing-document-evidence')
  }
  if (item.expected.noEvidence && hasEvidence(result)) failures.push('evidence-before-clarification')
  if (shouldRequireCount(item) && result.answerCount === null && !result.answerHasZeroPhrase && !item.expected.allowZero) failures.push('missing-count')
  if (result.dataViewCount > 0 && result.answerCount !== null && result.answerCount !== result.matchedCount && shouldRequireCount(item)) failures.push('count-does-not-match-evidence')
  if (item.expected.maxReturnedCount !== undefined && result.returnedCount > Number(item.expected.maxReturnedCount)) failures.push('returned-count-exceeds-request')
  if (item.expectedGroupEntities?.length && result.groundedExpectedEntityCount !== item.expectedGroupEntities.length) {
    failures.push('ungrounded-expected-scope')
  }
  if (item.expectedGroundedTerms?.length && result.groundedExpectedTermCount !== item.expectedGroundedTerms.length) {
    failures.push('ungrounded-expected-term')
  }
  if (item.evaluationGroup === 'synonymous_total_count' && runtimeRecordTotal !== null) {
    if (result.answerCount !== runtimeRecordTotal) failures.push('count-does-not-match-runtime-total')
    if (result.matchedCount !== runtimeRecordTotal) failures.push('evidence-does-not-match-runtime-total')
  }
  return { status: failures.length ? 'fail' : 'pass', failures }
}

const clarificationCasePasses = (result) => {
  if (result.status !== 'observed') return { status: 'not-assessed', failures: [result.failureStage ?? 'assistant-request'] }
  const failures = []
  if (!result.needsClarification) failures.push('missing-user-clarification')
  if (result.traceStatus !== 'clarification') failures.push('trace-not-clarification')
  if (!result.clarificationQuestionPresent) failures.push('missing-clarification-question')
  if (result.clarificationOptionCount < 2 || result.clarificationOptionCount > 3) failures.push('clarification-options-not-2-to-3')
  if (result.invokedAgentCount !== 0) failures.push('tool-agent-before-clarification')
  if (result.recordEvidenceCount || result.documentEvidenceCount || result.dataViewCount || result.evidenceBlockCount) failures.push('evidence-before-clarification')
  if (result.internalWordingVisible) failures.push('internal-wording')
  return { status: failures.length ? 'fail' : 'pass', failures }
}

const assessCases = (rawResults, runtimeRecordTotal) => {
  const byId = new Map(selectedCases.map((item) => [item.id, item]))
  const cases = rawResults.map((result) => {
    const item = byId.get(result.id)
    const assessment = item && clarificationExpectation(item)
      ? clarificationCasePasses(result)
      : item ? countCasePasses(item, result, runtimeRecordTotal) : { status: 'fail', failures: ['unknown-fixture-case'] }
    return { ...result, assessment }
  })
  const groups = [...new Set(selectedCases.map((item) => item.evaluationGroup))].map((group) => {
    const members = cases.filter((item) => byId.get(item.id)?.evaluationGroup === group)
    const itemDefinitions = selectedCases.filter((item) => item.evaluationGroup === group)
    const observed = members.filter((item) => item.status === 'observed')
    const stabilityMembers = members.filter((item) => item.track === 'stability')
    const stabilityDefinitions = itemDefinitions.filter((item) => item.onlineTracks.includes('stability') || item.onlineTracks.includes('both'))
    const fingerprints = [...new Set(observed.map((item) => [item.taskType, item.skillId, item.sourceMode, item.resultMode, item.needsClarification].join('|')))]
    const minimumSamples = stabilityDefinitions.length
      ? Math.max(3, ...stabilityDefinitions.map((item) => item.minimumOnlineSamples))
      : 1
    const sampleCount = itemDefinitions.length ? Math.min(...itemDefinitions.map((item) => (
      members.filter((member) => member.id === item.id && member.track === 'coverage').length ||
        members.filter((member) => member.id === item.id && member.track === 'stability').length
    ))) : 0
    const stabilitySampleCount = stabilityDefinitions.length ? Math.min(...stabilityDefinitions.map((item) => (
      stabilityMembers.filter((member) => member.id === item.id).length
    ))) : 0
    const hasFailure = members.some((item) => item.assessment.status === 'fail')
    const hasUnavailable = members.some((item) => item.assessment.status === 'not-assessed')
    return {
      id: group,
      caseCount: itemDefinitions.length,
      sampleCount,
      stabilitySampleCount,
      coverageQuestionCount: new Set(itemDefinitions.map((item) => item.question)).size,
      stabilityCaseCount: stabilityDefinitions.length,
      minimumSamples,
      routeFingerprintCount: fingerprints.length,
      routeConsistent: fingerprints.length <= 1,
      status: hasFailure || fingerprints.length > 1
        ? 'fail'
        : hasUnavailable || (stabilityDefinitions.length && stabilitySampleCount < minimumSamples)
          ? 'not-assessed'
          : 'pass'
    }
  })
  return { cases, groups }
}

const assertUiGate = (summary) => {
  if (!summary || summary.status !== 'observed') return false
  const views = [summary.dark, summary.light]
  return views.every((item) => item && item.themeMatches && item.answerPresent && !item.internalWordingVisible && item.contrastRatio >= 4.5 &&
    item.inputAccessibleName === '输入问题' && item.sendAccessibleName === '发送' &&
    ['log', 'region'].includes(item.messageRole) && item.messageAccessibleName && item.pageFitsViewport && item.composerVisible)
}

let exitCode = 2
try {
  await connectToRenderer()
  await call('Page.enable')
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  if (shouldRunUiPreparation(skipUiProbes)) {
    await evaluate(`(async () => {
      [...document.querySelectorAll('.ant-menu-item')]
        .find((element) => element.textContent?.trim() === 'AI 助手')
        ?.click()
      const startedAt = Date.now()
      while (!document.querySelector('.chat-page') && Date.now() - startedAt < 15_000) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return Boolean(document.querySelector('.chat-page'))
    })()`)
    await waitFor(`Boolean(document.querySelector('.chat-page button.chat-send-button[aria-label="发送"]'))`, 'assistant-idle', 15_000)
  }

  const runtimeRecordTotal = await readRuntimeRecordTotal()
  report.runtimeTruth = {
    recordTotal: runtimeRecordTotal,
    status: runtimeRecordTotal === null ? 'not-assessed' : 'observed'
  }

  const metadata = await modelMetadata()
  if (metadata && typeof metadata === 'object') {
    report.model = {
      provider: String(metadata.provider ?? ''),
      baseUrl: String(metadata.baseUrl ?? ''),
      model: String(metadata.model ?? ''),
      hasApiKey: metadata.hasApiKey === true
    }
  }
  const metadataMatches = report.model.provider === expectedProvider &&
    report.model.baseUrl.replace(/\/+$/u, '') === expectedBaseUrl &&
    report.model.model === expectedModel && report.model.hasApiKey
  report.checks.metadata = { status: metadataMatches ? 'pass' : 'blocked' }
  if (!metadataMatches) {
    report.failureStage = 'configuration'
    report.failureCategory = 'configured-model-does-not-match-required-rawchat-profile'
    throw new Error('configuration-mismatch')
  }

  if (skipModelProbe) {
    report.connection = { status: 'not-assessed', reason: 'skipped-by-explicit-test-split' }
    report.checks.connection = { status: 'not-assessed' }
    report.checks.minimalChat = { status: 'not-assessed' }
    report.checks.structuredOutput = { status: 'not-assessed' }
  } else {
    const probe = await modelProbe()
    report.connection = {
      runId: probe.connectionRunId,
      durationMs: probe.durationMs,
      httpStatus: probe.httpStatus ?? null,
      ok: probe.ok === true,
      checks: {
        connection: safeCapability(probe.connection),
        minimalChat: safeCapability(probe.minimalChat),
        structuredOutput: safeCapability(probe.structuredOutput),
        toolCalling: safeCapability(probe.toolCalling)
      }
    }
    const connectionPass = probe.ok === true && safeStatus(probe.connection) === 'supported'
    const minimalChatPass = safeStatus(probe.minimalChat) === 'supported'
    const structuredOutputPass = safeStatus(probe.structuredOutput) === 'supported'
    report.checks.connection = { status: connectionPass ? 'pass' : 'fail' }
    report.checks.minimalChat = { status: minimalChatPass ? 'pass' : 'fail' }
    report.checks.structuredOutput = { status: structuredOutputPass ? 'pass' : 'fail' }
    if (!connectionPass || !minimalChatPass) {
      report.failureStage = 'connection'
      report.failureCategory = probe.errorCategory ?? 'rawchat-connection-or-minimal-probe-failed'
      throw new Error('connection-not-assessed')
    }
  }

  const ownerCase = selectedCases.find((item) => item.id === 'owner-count-001') ?? selectedCases.find((item) => item.onlineScenario === 'count')
  const skippedUiProbe = { status: 'not-assessed', failureStage: 'skipped', errorCategory: 'not-requested' }
  const uiProbe = skipUiProbes
    ? skippedUiProbe
    : ownerCase ? await runUiProbe(ownerCase) : { status: 'not-assessed', failureStage: 'composer', errorCategory: 'runtime-error' }
  report.ui = {
    status: assertUiGate(uiProbe) ? 'pass' : uiProbe.status === 'not-assessed' ? 'not-assessed' : 'fail',
    countProbe: uiProbe,
    accessibility: uiProbe.status === 'observed'
      ? { dark: assertUiGate({ ...uiProbe, light: uiProbe.dark }), light: assertUiGate({ ...uiProbe, dark: uiProbe.light }) }
      : { status: 'not-assessed' }
  }
  const clarificationUi = skipUiProbes ? skippedUiProbe : await runClarificationUiProbe()
  report.ui.clarification = {
    status: clarificationUi.status === 'observed' && clarificationUi.clarification?.questionPresent &&
      clarificationUi.clarification.optionCount >= 2 && clarificationUi.clarification.optionCount <= 3 &&
      clarificationUi.clarification.hasAccessibleGroup && !clarificationUi.clarification.hasPlanCard &&
      !clarificationUi.clarification.internalWordingVisible
      ? 'pass'
      : clarificationUi.status === 'not-assessed' ? 'not-assessed' : 'fail',
    ...(clarificationUi.status === 'observed'
      ? { optionCount: clarificationUi.clarification.optionCount, screenshots: clarificationUi.screenshots }
      : { failureStage: clarificationUi.failureStage, errorCategory: clarificationUi.errorCategory })
  }
  if (uiProbe.screenshots) Object.assign(report.screenshots, uiProbe.screenshots)
  if (clarificationUi.screenshots) Object.assign(report.screenshots, clarificationUi.screenshots)

  const rawResults = await runAssistantCases()
  const assessed = assessCases(rawResults, runtimeRecordTotal)
  report.cases = assessed.cases.map((item) => ({
    id: item.id,
    track: item.track ?? 'coverage',
    repetition: item.repetition,
    runId: item.runId,
    status: item.assessment.status,
    durationMs: item.durationMs,
    ...(item.status === 'not-assessed'
      ? { failureStage: item.failureStage, errorCategory: item.errorCategory }
      : {
          route: {
            taskType: item.taskType,
            skillId: item.skillId,
            sourceMode: item.sourceMode,
            resultMode: item.resultMode,
            needsClarification: item.needsClarification,
            traceStatus: item.traceStatus
          },
          answer: {
            present: item.answerPresent,
            length: item.answerLength,
            count: item.answerCount,
            hasZeroPhrase: item.answerHasZeroPhrase,
            internalWordingVisible: item.internalWordingVisible
          },
          evidence: {
            recordCount: item.recordEvidenceCount,
            documentCount: item.documentEvidenceCount,
            dataViewCount: item.dataViewCount,
            matchedCount: item.matchedCount,
            returnedCount: item.returnedCount,
            preview: item.preview,
            recordUidCount: item.recordUidCount,
            recordUidDigest: item.recordUidDigest,
            evidenceBlockCount: item.evidenceBlockCount,
            aggregateEvidenceCount: item.aggregateEvidenceCount,
            truncatedEvidenceCount: item.truncatedEvidenceCount
          },
          clarificationOptionCount: item.clarificationOptionCount,
            invokedAgentCount: item.invokedAgentCount,
          grounding: {
            expectedGroundedTermCount: item.expectedGroundedTermCount,
            groundedExpectedTermCount: item.groundedExpectedTermCount,
            expectedEntityCount: item.expectedEntityCount,
            groundedExpectedEntityCount: item.groundedExpectedEntityCount
          },
            failures: item.assessment.failures
        })
  }))
  report.groups = assessed.groups
  const coverageSummary = summarizeCoverage(selectedCases)
  const stabilitySummary = summarizeCoverage(selectedStabilityCases, {
    repetitionCount: requestedRepetitions,
    executionSampleCount: rawResults.filter((item) => item.track === 'stability').length
  })
  report.coverage = {
    ...coverageSummary,
    observedQuestionCount: new Set(rawResults
      .filter((item) => item.track === 'coverage' && item.status === 'observed')
      .map((item) => selectedCases.find((candidate) => candidate.id === item.id)?.question ?? item.id)
    ).size,
    passCount: assessed.cases.filter((item) => item.track === 'coverage' && item.assessment.status === 'pass').length,
    failCount: assessed.cases.filter((item) => item.track === 'coverage' && item.assessment.status === 'fail').length,
    notAssessedCount: assessed.cases.filter((item) => item.track === 'coverage' && item.assessment.status === 'not-assessed').length
  }
  report.stability = {
    ...stabilitySummary,
    passCount: assessed.cases.filter((item) => item.track === 'stability' && item.assessment.status === 'pass').length,
    failCount: assessed.cases.filter((item) => item.track === 'stability' && item.assessment.status === 'fail').length,
    notAssessedCount: assessed.cases.filter((item) => item.track === 'stability' && item.assessment.status === 'not-assessed').length
  }
  report.checks.liveCases = {
    status: assessed.cases.some((item) => item.assessment.status === 'fail')
      ? 'fail'
      : assessed.groups.some((group) => group.status === 'not-assessed')
        ? 'not-assessed'
        : 'pass',
    caseCount: selectedCases.length,
    uniqueQuestionCount: coverageSummary.uniqueQuestionCount,
    executionSampleCount: rawResults.length,
    stabilitySampleCount: stabilitySummary.executionSampleCount,
    coverageExecutionSampleCount: rawResults.filter((item) => item.track === 'coverage').length,
    sampleCount: requestedRepetitions,
    runtimeRecordTotal
  }
  const hasFailure = report.checks.liveCases.status === 'fail' || report.ui.status === 'fail' || report.ui.clarification.status === 'fail'
  const hasUnavailable = report.checks.liveCases.status === 'not-assessed' || report.ui.status === 'not-assessed' || report.ui.clarification.status === 'not-assessed' || (liveMode !== 'coverage' && requestedRepetitions < 3)
  report.status = hasFailure ? 'fail' : hasUnavailable ? 'not-assessed' : 'pass'
  report.ok = report.status === 'pass'
  exitCode = report.ok ? 0 : report.status === 'not-assessed' ? 2 : 1
} catch (error) {
  if (!report.failureStage) report.failureStage = 'bootstrap'
  if (!report.failureCategory) report.failureCategory = safeErrorCategory(error)
  if (report.status !== 'fail') report.status = report.failureStage === 'configuration' ? 'blocked' : 'not-assessed'
  report.ok = false
  exitCode = report.status === 'fail' ? 1 : 2
} finally {
  report.finishedAt = new Date().toISOString()
  report.durationMs = Math.max(0, Date.parse(report.finishedAt) - Date.parse(report.startedAt))
  const reportPath = join(outputDirectory, 'live-assistant-intelligence-results.json')
  writeFileSync(reportPath, JSON.stringify({ ...report, reportPath }, null, 2), 'utf8')
  console.log(JSON.stringify({ ...report, reportPath }, null, 2))
  try { socket?.close() } catch { /* best effort */ }
}

process.exitCode = exitCode
