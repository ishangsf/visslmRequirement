import type { ChatContextRef, ChatDataView, ChatHistoryTurn, ChatMessage } from '../shared/types'

/**
 * Small, provider-independent context budgeting primitives used by the
 * desktop agents.  We intentionally use a conservative estimator instead of
 * pretending that every provider shares one tokenizer.  The goal is to keep
 * requests below the configured window and to make whole evidence blocks
 * removable; callers must never cut a record or JSON document in half.
 */

export interface ContextBlock {
  id: string
  content: string
  priority: number
  required?: boolean
}

export interface ContextPackOptions {
  /** Maximum estimated input tokens, excluding the reserved output budget. */
  maxInputTokens: number
  /** Tokens reserved for the model's visible answer and hidden reasoning. */
  reservedOutputTokens?: number
  /** Safety margin for provider-specific tokenization differences. */
  safetyTokens?: number
}

export interface ContextPackResult {
  text: string
  keptBlockIds: string[]
  omittedBlockIds: string[]
  estimatedTokens: number
  availableTokens: number
}

const imageDataUriPattern = /data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/giu
const imageTagPattern = /<img\b[^>]*>/giu
const imageSourceAttributePattern = /\s(?:src|srcset|data-src|data-original)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu
const assetTokenPattern = /visslm-asset:\/\/[^\s"'<>]+/giu
const scriptStylePattern = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/giu
const htmlTagPattern = /<[^>]+>/gu
const whitespacePattern = /\s+/gu

/**
 * Estimate tokens without importing a heavyweight tokenizer into the main
 * process.  Latin runs are discounted (roughly four characters per token),
 * while CJK, emoji and punctuation are counted conservatively one by one.
 */
export const estimateContextTokens = (value: string): number => {
  let tokens = 0
  let latinRun = 0
  const flushLatin = (): void => {
    if (!latinRun) return
    tokens += Math.ceil(latinRun / 4)
    latinRun = 0
  }
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0
    const isLatin = (
      (codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a) ||
      char === ' ' || char === '\t' || char === '\n' || char === '\r' ||
      char === '-' || char === '_' || char === '.' || char === '/' || char === ':'
    )
    if (isLatin) {
      latinRun += 1
      continue
    }
    flushLatin()
    tokens += 1
  }
  flushLatin()
  return tokens
}

/** Convert rich text and image-bearing strings into model-safe plain text. */
export const compactEvidenceText = (value: unknown, maxChars = 2_000): string => {
  let text = String(value ?? '')
  text = text.replace(scriptStylePattern, ' ')
  text = text.replace(imageDataUriPattern, ' [图片二进制已省略] ')
  text = text.replace(imageTagPattern, ' [图片已省略] ')
  text = text.replace(imageSourceAttributePattern, ' ')
  text = text.replace(assetTokenPattern, ' [图片资源引用已省略] ')
  text = text.replace(htmlTagPattern, ' ')
  text = text.replace(whitespacePattern, ' ').trim()
  if (text.length <= maxChars) return text
  return `${Array.from(text).slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

const compactJsonValue = (value: unknown, depth: number, maxChars: number): unknown => {
  if (depth > 4) return '[嵌套字段已省略]'
  if (typeof value === 'string') return compactEvidenceText(value, maxChars)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    const items = value.slice(0, 30).map((item) => compactJsonValue(item, depth + 1, maxChars))
    return value.length > items.length ? [...items, `[其余 ${value.length - items.length} 项已省略]`] : items
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 80)
    const result: Record<string, unknown> = {}
    for (const [key, item] of entries) result[key] = compactJsonValue(item, depth + 1, maxChars)
    if (Object.keys(value as Record<string, unknown>).length > entries.length) {
      result.__omittedFields = '[其余字段已省略]'
    }
    return result
  }
  return String(value)
}

/** JSON that is safe to place in an evidence block. */
export const compactEvidenceJson = (value: unknown, maxChars = 2_000): string => {
  try {
    const limit = Math.max(64, Math.floor(maxChars))
    const compacted = compactJsonValue(value, 0, Math.min(limit, 1_000))
    const serialize = (input: unknown): string => JSON.stringify(input)
    let text = serialize(compacted)
    if (text.length <= limit) return text
    if (Array.isArray(compacted)) {
      const items = [...compacted]
      while (items.length) {
        items.pop()
        text = serialize([...items, '[其余项目因上下文预算已省略]'])
        if (text.length <= limit) return text
      }
    } else if (compacted && typeof compacted === 'object') {
      const entries = Object.entries(compacted as Record<string, unknown>)
      while (entries.length) {
        entries.pop()
        text = serialize(Object.fromEntries([
          ...entries,
          ['__omittedFields', '[其余字段因上下文预算已省略]']
        ]))
        if (text.length <= limit) return text
      }
    } else if (typeof compacted === 'string') {
      return serialize(compactEvidenceText(compacted, Math.max(16, limit - 4)))
    }
    return '{"__omitted":"上下文预算不足，原始字段已省略"}'
  } catch {
    return '[原始字段无法序列化]'
  }
}

export interface ContextValueOptions {
  maxStringChars?: number
  maxArrayItems?: number
  maxObjectEntries?: number
  maxDepth?: number
}

/** Compatibility helper for evidence adapters that need a bounded value. */
export const compactContextValue = (
  value: unknown,
  options: ContextValueOptions = {}
): unknown => {
  const maxStringChars = Math.max(32, Math.floor(options.maxStringChars ?? 1_000))
  const maxArrayItems = Math.max(1, Math.floor(options.maxArrayItems ?? 20))
  const maxObjectEntries = Math.max(1, Math.floor(options.maxObjectEntries ?? 40))
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 3))
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[嵌套字段已省略]'
    if (typeof input === 'string') return compactEvidenceText(input, maxStringChars)
    if (typeof input === 'number' || typeof input === 'boolean' || input === null) return input
    if (Array.isArray(input)) {
      const values = input.slice(0, maxArrayItems).map((item) => visit(item, depth + 1))
      if (input.length > values.length) values.push(`[其余 ${input.length - values.length} 项已省略]`)
      return values
    }
    if (input && typeof input === 'object') {
      const entries = Object.entries(input as Record<string, unknown>).slice(0, maxObjectEntries)
      const output: Record<string, unknown> = {}
      for (const [key, item] of entries) output[key] = visit(item, depth + 1)
      if (Object.keys(input as Record<string, unknown>).length > entries.length) {
        output.__omittedFields = '[其余字段已省略]'
      }
      return output
    }
    return String(input)
  }
  return visit(value, 0)
}

export const compactContextJson = (value: unknown, maxChars = 2_000): string => (
  compactEvidenceJson(value, maxChars)
)

export const sanitizeContextText = compactEvidenceText

/** Keep record paging indexes unique, normalized, and bounded. */
export const compactRecordUids = (
  uids: readonly unknown[] | undefined,
  limit = 10_000
): string[] => {
  const safeLimit = Math.max(0, Math.min(10_000, Math.trunc(limit)))
  if (!safeLimit) return []
  return [...new Set((uids ?? [])
    .map((uid) => sanitizeContextText(String(uid ?? '').trim(), 180))
    .filter(Boolean))]
    .slice(0, safeLimit)
}

const contextRefText = (ref: ChatContextRef): string => {
  const label = sanitizeContextText(ref.label ?? '', 120)
  if (ref.kind === 'record') {
    const item = sanitizeContextText(ref.itemId ?? '', 120)
    return `记录 ${item || ref.id}${label ? `（${label}）` : ''}`
  }
  if (ref.kind === 'dataView') {
    const total = Number.isFinite(ref.total) ? `，共 ${Math.max(0, Math.trunc(ref.total!))} 条` : ''
    return `数据视图 ${label || ref.id}${total}`
  }
  const version = Number.isFinite(ref.version) ? ` v${Math.max(1, Math.trunc(ref.version!))}` : ''
  return `大屏 ${label || ref.id}${version}`
}

/** Add bounded, reference-only metadata to a history turn. */
export const formatHistoryTurnContent = (
  content: unknown,
  contextRefs: readonly ChatContextRef[] | undefined,
  maxChars = 1_200
): string => {
  const text = compactEvidenceText(content, maxChars)
  const refs = (contextRefs ?? [])
    .slice(0, 12)
    .map(contextRefText)
    .filter(Boolean)
  if (!refs.length) return text
  return `${text}\n[上下文引用（仅用于定位，不是新事实）：${refs.join('；')}]`
}

/** Build references from a response without serializing its full payload. */
export const contextRefsFromResponse = (response: {
  sources?: Array<{ uid: string; itemId?: string; name?: string }>
  dataViews?: Array<{ id: string; title?: string; total?: number; fields?: string[] }>
  dashboard?: { id: string; title?: string }
  dashboardVersion?: number
}): ChatContextRef[] => {
  const refs: ChatContextRef[] = []
  for (const source of response.sources ?? []) {
    if (!source.uid) continue
    refs.push({
      kind: 'record',
      id: source.uid,
      itemId: sanitizeContextText(source.itemId ?? '', 120),
      label: sanitizeContextText(source.name ?? '', 120)
    })
  }
  for (const view of response.dataViews ?? []) {
    if (!view.id) continue
    refs.push({
      kind: 'dataView',
      id: view.id,
      label: sanitizeContextText(view.title ?? '', 120),
      total: Number.isFinite(view.total) ? Math.max(0, Math.trunc(view.total!)) : undefined,
      fields: (view.fields ?? []).slice(0, 20).map((field) => sanitizeContextText(field, 80))
    })
  }
  if (response.dashboard?.id) {
    refs.push({
      kind: 'dashboard',
      id: response.dashboard.id,
      label: sanitizeContextText(response.dashboard.title ?? '', 120),
      version: Number.isFinite(response.dashboardVersion)
        ? Math.max(1, Math.trunc(response.dashboardVersion!))
        : undefined
    })
  }
  return refs.slice(0, 40)
}

/** Keep saved chat payloads bounded; large rows remain available through IDs. */
export const compactChatContextRefs = (refs: readonly ChatContextRef[] | undefined): ChatContextRef[] => (
  (refs ?? []).slice(0, 40).flatMap((ref): ChatContextRef[] => {
    if (!ref || !ref.id || !['record', 'dataView', 'dashboard'].includes(ref.kind)) return []
    return [{
      kind: ref.kind,
      id: sanitizeContextText(ref.id, 180),
      ...(ref.label ? { label: sanitizeContextText(ref.label, 120) } : {}),
      ...(ref.itemId ? { itemId: sanitizeContextText(ref.itemId, 120) } : {}),
      ...(Number.isFinite(ref.total) ? { total: Math.max(0, Math.trunc(ref.total!)) } : {}),
      ...(Number.isFinite(ref.version) ? { version: Math.max(1, Math.trunc(ref.version!)) } : {}),
      ...(ref.fields?.length ? { fields: ref.fields.slice(0, 20).map((field) => sanitizeContextText(field, 80)) } : {})
    }]
  })
)

/** Bound persisted data views so reopening a session cannot hydrate huge rows. */
export const compactChatDataViews = (views: readonly ChatDataView[] | undefined): ChatDataView[] => (
  (views ?? []).slice(0, 8).map((view) => ({
    ...view,
    title: sanitizeContextText(view.title, 160),
    description: sanitizeContextText(view.description, 1_000),
    loadedRows: view.loadedRows ?? view.groups.reduce((sum, group) => sum + group.rows.length, 0),
    isPreview: view.isPreview ?? true,
    recordUids: view.recordUids === undefined
      ? undefined
      : compactRecordUids(view.recordUids),
    fields: view.fields.slice(0, 40).map((field) => sanitizeContextText(field, 120)),
    fieldLabels: view.fieldLabels
      ? Object.fromEntries(Object.entries(view.fieldLabels).slice(0, 40).map(([field, label]) => [
          sanitizeContextText(field, 120),
          sanitizeContextText(label, 160)
        ]))
      : undefined,
    groups: view.groups.slice(0, 12).map((group) => ({
       ...group,
       name: sanitizeContextText(group.name, 160),
       recordUids: group.recordUids === undefined
         ? undefined
         : compactRecordUids(group.recordUids),
       rows: group.rows.slice(0, 100).map((row) => ({
        ...row,
        name: sanitizeContextText(row.name, 240),
        nodeType: sanitizeContextText(row.nodeType, 120),
        itemId: sanitizeContextText(row.itemId, 160),
        values: Object.fromEntries(Object.entries(row.values).slice(0, 40).map(([field, value]) => [
          sanitizeContextText(field, 120),
          Array.isArray(value)
            ? value.slice(0, 12).map((item) => sanitizeContextText(item, 512))
            : sanitizeContextText(value, 512)
        ]))
      }))
    }))
  }))
)

export const compactChatMessageForPersistence = (message: ChatMessage): ChatMessage => ({
  ...message,
  content: sanitizeContextText(message.content, 8_000),
  ...(message.contextRefs?.length ? { contextRefs: compactChatContextRefs(message.contextRefs) } : {}),
  ...(message.dataViews?.length ? { dataViews: compactChatDataViews(message.dataViews) } : {})
})

/** Convert persisted messages into safe model history without carrying rows or dashboard payloads. */
export const chatHistoryFromMessages = (
  messages: readonly ChatMessage[]
): ChatHistoryTurn[] => messages
  .filter((message) => (
    message.contextOutcome !== 'failed' &&
    message.contextOutcome !== 'undone' &&
    message.taskTrace?.status !== 'cancelled'
  ))
  .slice(-16)
  .map((message) => ({
    role: message.role,
    content: sanitizeContextText(message.content, 8_000),
    ...(message.contextRefs?.length ? { contextRefs: compactChatContextRefs(message.contextRefs) } : {})
  }))

export interface ContextBudget {
  contextTokens: number
  outputTokens: number
  safetyTokens: number
  systemTokens: number
  historyTokens: number
  evidenceTokens: number
}

export const createContextBudget = (input: {
  contextTokens?: number
  outputTokens?: number
  safetyTokens?: number
  systemTokens?: number
  historyTokens?: number
}): ContextBudget => {
  const contextTokens = Math.max(4_096, Math.floor(input.contextTokens ?? 32_768))
  const outputTokens = Math.max(256, Math.floor(input.outputTokens ?? 2_400))
  const safetyTokens = Math.max(512, Math.floor(input.safetyTokens ?? 1_500))
  const systemTokens = Math.max(256, Math.floor(input.systemTokens ?? 2_000))
  const historyTokens = Math.max(0, Math.floor(input.historyTokens ?? 2_000))
  return {
    contextTokens,
    outputTokens,
    safetyTokens,
    systemTokens,
    historyTokens,
    evidenceTokens: Math.max(
      512,
      contextTokens - outputTokens - safetyTokens - systemTokens - historyTokens
    )
  }
}

/** Select recent successful dialogue without allowing one huge turn to win. */
export const selectHistoryMessages = <T extends { role: string; content: string; outcome?: string }>(
  history: readonly T[] | undefined,
  maxMessages = 4,
  maxChars = 4_000
): T[] => (history ?? [])
  .filter((message) => message.outcome !== 'failed' && message.outcome !== 'undone')
  .slice(-Math.max(0, maxMessages))
  .map((message) => ({
    ...message,
    content: formatHistoryTurnContent(
      message.content,
      'contextRefs' in message && Array.isArray(message.contextRefs)
        ? message.contextRefs as ChatContextRef[]
        : undefined,
      maxChars
    )
  }))

/**
 * Preserve early-session decisions as a compact memory turn, then append the
 * recent dialogue verbatim. This avoids the old behavior where every turn
 * outside slice(-N) silently disappeared.
 */
export const selectHistoryWithSummary = <T extends {
  role: string
  content: string
  outcome?: string
  contextRefs?: ChatContextRef[]
}>(
  history: readonly T[] | undefined,
  recentMessages = 8,
  maxRecentChars = 1_200,
  maxSummaryChars = 1_800
): Array<{ role: string; content: string }> => {
  const successful = (history ?? []).filter(
    (message) => message.outcome !== 'failed' && message.outcome !== 'undone'
  )
  const recent = selectHistoryMessages(successful, recentMessages, maxRecentChars)
    .map(({ role, content }) => ({ role, content }))
  const earlier = successful.slice(0, Math.max(0, successful.length - recentMessages))
  if (!earlier.length) return recent
  const facts = earlier.slice(-24).map((message) => {
    const prefix = message.role === 'user' ? '用户' : '助手'
    return `${prefix}：${formatHistoryTurnContent(message.content, message.contextRefs, 240)}`
  })
  const summary = compactEvidenceText(
    `较早会话摘要（用于延续约束和指代，不可作为新的数据事实）：\n${facts.join('\n')}`,
    maxSummaryChars
  )
  return [{ role: 'system', content: summary }, ...recent]
}

/** Pack evidence blocks into the evidence portion of a known budget. */
export const selectWholeContextBlocks = (
  blocks: readonly ContextBlock[],
  budget: ContextBudget
): ContextPackResult => packContextBlocks(blocks, {
  maxInputTokens: budget.evidenceTokens,
  reservedOutputTokens: 0,
  safetyTokens: 0
})

/**
 * Pack complete blocks in priority order.  Required blocks are retained even
 * when they exceed the remaining budget; callers should keep required blocks
 * compact (for example, an ID-only index) and use the omitted IDs as a
 * continuation signal.
 */
export const packContextBlocks = (
  blocks: readonly ContextBlock[],
  options: ContextPackOptions
): ContextPackResult => {
  const maxInputTokens = Math.max(1_024, Math.floor(options.maxInputTokens))
  const reservedOutputTokens = Math.max(0, Math.floor(options.reservedOutputTokens ?? 2_400))
  const safetyTokens = Math.max(0, Math.floor(options.safetyTokens ?? 1_500))
  const availableTokens = Math.max(512, maxInputTokens - reservedOutputTokens - safetyTokens)
  const ordered = blocks
    .map((block, index) => ({ block, index, tokens: estimateContextTokens(block.content) }))
    .sort((left, right) => right.block.priority - left.block.priority || left.index - right.index)
  const kept: Array<{ block: ContextBlock; index: number }> = []
  const omitted: string[] = []
  let used = 0
  for (const item of ordered) {
    if (item.block.required || used + item.tokens <= availableTokens) {
      kept.push({ block: item.block, index: item.index })
      used += item.tokens
    } else {
      omitted.push(item.block.id)
    }
  }
  kept.sort((left, right) => left.index - right.index)
  return {
    text: kept.map((item) => item.block.content).filter(Boolean).join('\n\n'),
    keptBlockIds: kept.map((item) => item.block.id),
    omittedBlockIds: omitted,
    estimatedTokens: used,
    availableTokens
  }
}
