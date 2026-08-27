const controlCharacterPattern = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu
const inlineHeadingPattern = /(?:^|\s)(#{2,4})\s+(?=\S)/gu
const inlineNumberedItemPattern = /(?:^|\s)(\d{1,3}[.、])\s+(?=\S)/gu
const inlineBulletItemPattern = /(?:^|\s)([-*])\s+(?=\S)/gu
const standaloneCitationSectionPattern = /(?:^|\n)[ \t]*(?:>[ \t]*)?(?:#{1,6}[ \t]+)?(?:来源|依据)[：:][ \t]*(?=$|\n|\[)/gu
const markdownCitationPattern = /\[[^\]\n]+\]\([^)\n]+\)/gu
const verifiableCitationTokenPattern = /#knowledge-document=|\[UID:[^\]]+\]|\[[^\]\n]+\]\([^)\n]+\)/u
const knowledgeCitationMarkdownPattern = /\[[^\]\n]+\]\(#knowledge-document=[^)\n]+\)/gu
const recordCitationPattern = /\[UID:[^\]\n]+\]/gu
const citationSectionScaffoldingPattern = /(?:来源|依据)[：:]?|\[\d{1,3}\]|\d{1,3}[.)、]|[\s>#*`、,，.。;；:：|\\-]/gu

/**
 * Keep user-visible chat formatting intact while removing control characters
 * and enforcing the persisted message size limit.
 */
export const sanitizeChatMessageContent = (value: unknown, maxChars = 8_000): string => {
  const normalized = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(controlCharacterPattern, '')
    .trim()

  if (normalized.length <= maxChars) return normalized
  return `${Array.from(normalized).slice(0, Math.max(0, maxChars - 1)).join('')}…`
}

/**
 * Older releases flattened message newlines while loading chat history. Recover
 * only strongly signalled Markdown so ordinary prose, decimals and IDs remain
 * untouched. New messages bypass this compatibility path.
 */
export const restoreLegacyAssistantMarkdown = (value: string): string => {
  if (!value || value.includes('\n')) return value

  const headingCount = [...value.matchAll(inlineHeadingPattern)].length
  const numberedItemCount = [...value.matchAll(inlineNumberedItemPattern)].length
  const bulletItemCount = [...value.matchAll(inlineBulletItemPattern)].length
  const hasStructuredAnswer = headingCount > 0 || numberedItemCount >= 3 || bulletItemCount >= 2

  if (!hasStructuredAnswer) return value

  let restored = value
  if (headingCount > 0) {
    restored = restored.replace(/\s+(#{2,4})\s+(?=\S)/gu, '\n\n$1 ')
  }
  if (numberedItemCount >= 3) {
    restored = restored.replace(/\s+(\d{1,3}[.、])\s+(?=\S)/gu, '\n$1 ')
  }
  if (bulletItemCount >= 2) {
    restored = restored.replace(/\s+([-*])\s+(?=\S)/gu, '\n$1 ')
  }

  return restored.trim()
}

/**
 * Completed assistant turns already expose their trusted records/documents in
 * the structured “回答依据” list. Remove only a trailing standalone Markdown
 * 来源/依据 section that repeats those same machine-verifiable citations.
 * Ordinary prose such as “依据标准第 3 条” is intentionally left untouched.
 */
export const stripRedundantAssistantCitationSections = (
  value: string,
  hasStructuredSources: boolean
): string => {
  if (!value || !hasStructuredSources) return value

  for (const match of value.matchAll(standaloneCitationSectionPattern)) {
    const start = match.index ?? 0
    const tail = value.slice(start)
    if (!verifiableCitationTokenPattern.test(tail)) continue
    const nonCitationText = tail
      .replace(markdownCitationPattern, '')
      .replace(knowledgeCitationMarkdownPattern, '')
      .replace(recordCitationPattern, '')
      .replace(citationSectionScaffoldingPattern, '')
    if (nonCitationText) continue
    return value.slice(0, start).trimEnd()
  }
  return value
}
