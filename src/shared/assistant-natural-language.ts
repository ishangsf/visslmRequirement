/**
 * A small, deterministic boundary between a user's natural-language request
 * and the optional file-delivery part of that request.
 *
 * This parser deliberately does not try to infer a file request from a
 * format word alone.  For example, "评审Excel文件" is a normal subject, not
 * an export request.  A delivery action and a supported format (or the
 * unambiguous "打包" action) must occur in the same clause.
 */

export type NaturalLanguageDeliveryFormat = 'docx' | 'xlsx' | 'pptx' | 'zip'

export interface NaturalLanguageDeliveryIntent {
  format: NaturalLanguageDeliveryFormat
  /** The user-authored data/document target with the delivery clause removed. */
  queryText: string
  /** The bounded delivery instruction retained for a later delivery step. */
  instructions: string
  /** True when the request explicitly points at a previously produced result. */
  referencesPriorResult?: boolean
}

interface IndexedMatch {
  index: number
  text: string
  end: number
}

interface FormatMatch extends IndexedMatch {
  format: NaturalLanguageDeliveryFormat
}

const deliveryActionPattern = /(?:生成|导出|输出(?:成|为)?|保存(?:为|成)|整理(?:成|为|一份|一个|一张)|汇总(?:成|为|一份|一个|一张)|梳理(?:成|为|一份|一个|一张)|形成(?:一份|一个|一张)|写(?:成|为|一份|一个)|制作|做(?:成|为|一份|一个|一张|个)|转(?:成|为)|转换(?:成|为)|给我(?:一份|一个|一张)?|提供(?:成|为|一份|一个|一张)?|(?:我)?(?:想要|需要)(?:一份|一个|一张)|打包)/giu

const formatPatterns: ReadonlyArray<{
  format: NaturalLanguageDeliveryFormat
  pattern: RegExp
}> = [
  // Put the explicit English extensions before the broad Chinese aliases so
  // the resulting match is stable when a phrase contains both.
  { format: 'xlsx', pattern: /(?:xlsx?|excel|电子表格|表格(?:文件)?)/giu },
  { format: 'docx', pattern: /(?:docx?|word|报告|文档)/giu },
  { format: 'pptx', pattern: /(?:pptx?|powerpoint|演示文稿|幻灯片|演示)/giu },
  { format: 'zip', pattern: /(?:zip|压缩包|压缩文件|导出包|打包)/giu }
]

const clauseBoundaryPattern = /[，,。！？!?；;：:、\n]/u

const priorResultPattern = /(?:(?:上一轮|上一次|前一轮|上轮|上一条|最近一条|前一条|刚才|刚刚|之前|前面|上述|以上|前述)(?:的)?(?:查询|检索|搜索)?(?:结果|回答|数据|记录|内容)?|这些(?:回答|结果|数据|记录|内容)?|这个(?:回答|结果|数据|记录|内容)|那个(?:回答|结果|数据|记录|内容))/gu

const priorResultReferencePattern = /(?:(?:上一轮|上一次|前一轮|上轮|上一条|最近一条|前一条|刚才|刚刚|之前|前面|上述|以上|前述)(?:的)?(?:查询|检索|搜索)?(?:结果|回答|数据|记录|内容)?|这些(?:回答|结果|数据|记录|内容)?|这个(?:回答|结果|数据|记录|内容)|那个(?:回答|结果|数据|记录|内容))/u

const queryLeadingNoisePattern = /^(?:(?:请问|请|麻烦|帮我|帮忙|想要|想|需要|把|将|让|由|给|为)\s*)+/u

const queryActionLeadingPattern = /^(?:(?:整理|汇总|梳理|收集|归纳|分析|统计|查询|查找|搜索|筛选|列出|查看|看看)(?:一下|下)?|生成|导出|制作|做成|转(?:成|为)|转换(?:成|为)|保存(?:为|成))\s*/u

const leadingQuantityPattern = /^(?:一份|一个|一张|一项|一些|若干|相关的?)\s*/u

const trimQuery = (value: string): string => {
  let query = value
    .normalize('NFKC')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/^[\s，,。！？!?；;：:、]+|[\s，,。！？!?；;：:、]+$/gu, '')
    .replace(queryLeadingNoisePattern, '')
    .replace(queryActionLeadingPattern, '')
    .replace(leadingQuantityPattern, '')
    .trim()

  // "把上一轮结果导出为 Excel" is a delivery-only follow-up.  Do not let
  // the words "上一轮结果" turn into a new record search term.
  query = query.replace(priorResultPattern, '').trim()
  query = query
    .replace(/^(?:的|为|成|和|与|及|以及)\s*/u, '')
    .replace(/(?:的|，|,|；|;)$/u, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  return query
}

const matchesFor = (pattern: RegExp, text: string): IndexedMatch[] => {
  // All patterns above are global.  Recreate the regexp state for callers
  // that may pass a shared instance through a future extension.
  pattern.lastIndex = 0
  return [...text.matchAll(pattern)].map((match) => ({
    index: match.index ?? 0,
    text: match[0],
    end: (match.index ?? 0) + match[0].length
  }))
}

const formatMatchesFor = (text: string): FormatMatch[] => formatPatterns.flatMap(({ format, pattern }) => (
  matchesFor(pattern, text).map((match) => ({ ...match, format }))
))

const clauseRangeAround = (text: string, index: number): { start: number; end: number } => {
  let start = index
  while (start > 0 && !clauseBoundaryPattern.test(text[start - 1] ?? '')) start -= 1
  let end = index
  while (end < text.length && !clauseBoundaryPattern.test(text[end] ?? '')) end += 1
  return { start, end }
}

const actionForFormat = (text: string, formatMatch: FormatMatch): IndexedMatch | undefined => {
  const range = clauseRangeAround(text, formatMatch.index)
  const actions = matchesFor(deliveryActionPattern, text).filter((action) => (
    action.index >= range.start && action.end <= range.end
  ))
  if (!actions.length) return undefined
  return actions
    .sort((left, right) => {
      // The action introducing a format is authoritative.  A trailing
      // "给我" in "生成一份 Excel 给我" is a delivery tail, not the action
      // that determines the target extraction.
      const leftBefore = left.end <= formatMatch.index
      const rightBefore = right.end <= formatMatch.index
      if (leftBefore !== rightBefore) return leftBefore ? -1 : 1
      const leftDistance = left.end <= formatMatch.index
        ? formatMatch.index - left.end
        : left.index - formatMatch.end
      const rightDistance = right.end <= formatMatch.index
        ? formatMatch.index - right.end
        : right.index - formatMatch.end
      return leftDistance - rightDistance
    })[0]
}

const formatName = (format: NaturalLanguageDeliveryFormat): string => ({
  docx: 'DOCX',
  xlsx: 'XLSX',
  pptx: 'PPTX',
  zip: 'ZIP'
}[format])

const deliveryInstructionFor = (
  text: string,
  action: IndexedMatch,
  format: FormatMatch
): string => {
  const range = clauseRangeAround(text, format.index)
  // Keep a leading "上一轮结果/刚才回答" reference in the delivery
  // instruction even though it is removed from queryText below.
  const start = range.start
  const end = Math.min(range.end, Math.max(action.end, format.end) + 48)
  return text
    .slice(start, end)
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, 240)
}

/**
 * Resolve an optional natural-language file-delivery clause.
 *
 * The return value is intentionally independent from the artifact execution
 * gate: recognizing "生成 Excel" never authorizes file creation.  It only
 * gives routing/planning code a safe query text and a bounded format hint.
 */
export const resolveNaturalLanguageDeliveryIntent = (
  question: string
): NaturalLanguageDeliveryIntent | null => {
  const text = String(question ?? '')
    .normalize('NFKC')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  if (!text) return null

  const formats = formatMatchesFor(text)
  if (!formats.length) {
    // "打包" is both a delivery action and an unambiguous ZIP intent.  It is
    // covered by the format alias above, but keep this guard explicit so a
    // future format-pattern change cannot make bare "打包" unsafe.
    return null
  }

  const candidates = formats
    .map((format) => ({ format, action: actionForFormat(text, format) }))
    .filter((candidate): candidate is { format: FormatMatch; action: IndexedMatch } => Boolean(candidate.action))
  if (!candidates.length) return null

  // Multiple distinct formats need an explicit user choice (or a future ZIP
  // policy); selecting the first one would silently discard part of a request.
  const distinctFormats = [...new Set(candidates.map(({ format }) => format.format))]
  if (distinctFormats.length !== 1) return null
  const selected = candidates[0]
  if (!selected) return null

  const format = selected.format
  const action = selected.action
  const beforeAction = text.slice(0, action.index)
  const betweenActionAndFormat = action.end <= format.index
    ? text.slice(action.end, format.index)
    : ''
  const beforeFormat = text.slice(0, format.index)
  // If the action follows the target ("周顺峰导出为 Excel"), the target is
  // before the action.  If it leads the target ("生成周顺峰的 Excel"), the
  // target is between action and format.  With a comma-separated preface,
  // prefer the preface when it contains meaningful text.
  const rawQuery = beforeAction.trim() && trimQuery(beforeAction)
    ? beforeAction
    : betweenActionAndFormat || beforeFormat
  const queryText = trimQuery(rawQuery)
  const instruction = deliveryInstructionFor(text, action, format)
  const referencesPriorResult = priorResultReferencePattern.test(
    `${beforeAction} ${rawQuery}`
  )
  const priorOnly = referencesPriorResult && !queryText

  return {
    format: format.format,
    queryText: priorOnly ? '' : queryText,
    instructions: instruction || `按用户要求整理为 ${formatName(format.format)}`,
    ...(referencesPriorResult ? { referencesPriorResult: true } : {})
  }
}

export default resolveNaturalLanguageDeliveryIntent
