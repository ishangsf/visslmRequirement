/**
 * Small, lossless helpers for finding image URLs in rich-text HTML.
 *
 * This deliberately does not parse and re-serialise a DOM.  Rich text coming
 * from VISSLM frequently contains editor-specific attributes and whitespace;
 * replacing only the value spans keeps the original bytes intact.
 */

export interface RichTextImageSource {
  source: string
  attribute: 'src' | 'srcset'
  /** Start/end offsets of the URL value in the original HTML. */
  start: number
  end: number
  occurrence: number
}

export interface RichTextImageReplacement {
  source: string
  token: string
  attribute: 'src' | 'srcset'
  occurrence: number
}

const imageTagPattern = /<(img|source)\b[^>]*>/gi
const attributePattern = /(?:^|\s)(srcset|src)\s*=\s*(["'])([\s\S]*?)\2/gi
const controlCharacterPattern = /[\u0000-\u001f\u007f]/

const decodeHtmlAttribute = (value: string): string => value
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')

/**
 * Split one srcset value without treating the commas inside a data URI as
 * candidate separators.  Descriptors (2x/640w) are retained by callers.
 */
const sourceSpansInSrcset = (value: string): Array<{ start: number; end: number }> => {
  const spans: Array<{ start: number; end: number }> = []
  let cursor = 0
  while (cursor < value.length) {
    while (cursor < value.length && /[\s,]/.test(value[cursor])) cursor += 1
    if (cursor >= value.length) break
    const start = cursor
    const isData = /^data:/i.test(value.slice(cursor))
    if (isData) {
      // Data URLs have a comma separating metadata and payload.  The next
      // comma after the base64 payload is the srcset candidate separator when
      // there is no width/density descriptor, so do not swallow it into the
      // URL.  (Base64 payloads cannot contain commas.)
      const metadataComma = value.indexOf(',', cursor)
      if (metadataComma < 0) break
      cursor = metadataComma + 1
      while (cursor < value.length && !/[\s,]/.test(value[cursor])) cursor += 1
    } else {
      while (cursor < value.length && !/[\s,]/.test(value[cursor])) cursor += 1
    }
    if (cursor > start) spans.push({ start, end: cursor })
    while (cursor < value.length && !/[,]/.test(value[cursor])) cursor += 1
    if (cursor < value.length && value[cursor] === ',') cursor += 1
  }
  return spans
}

/** Return all image URL spans in `<img src>` and `<source srcset>` tags. */
export const findRichTextImageSources = (html: string): RichTextImageSource[] => {
  if (!html || typeof html !== 'string') return []
  const results: RichTextImageSource[] = []
  let occurrence = 0
  for (const tagMatch of html.matchAll(imageTagPattern)) {
    const tag = tagMatch[0]
    const tagStart = tagMatch.index ?? 0
    const tagName = String(tagMatch[1]).toLowerCase()
    attributePattern.lastIndex = 0
    for (const attributeMatch of tag.matchAll(attributePattern)) {
      const attribute = String(attributeMatch[1]).toLowerCase() as 'src' | 'srcset'
      if (tagName === 'img' && attribute !== 'src' && attribute !== 'srcset') continue
      if (tagName === 'source' && attribute !== 'srcset' && attribute !== 'src') continue
      const quote = attributeMatch[2]
      const fullMatchOffset = attributeMatch.index ?? 0
      const quoteOffset = tag.indexOf(quote, fullMatchOffset)
      if (quoteOffset < 0) continue
      const valueOffset = quoteOffset + quote.length
      const value = String(attributeMatch[3])
      if (attribute === 'srcset') {
        for (const span of sourceSpansInSrcset(value)) {
          const source = decodeHtmlAttribute(value.slice(span.start, span.end)).trim()
          if (!source) continue
          results.push({
            source,
            attribute,
            start: tagStart + valueOffset + span.start,
            end: tagStart + valueOffset + span.end,
            occurrence: occurrence++
          })
        }
      } else {
        const leadingWhitespace = value.search(/\S|$/)
        const trailingWhitespace = value.length - value.replace(/\s+$/, '').length
        const source = decodeHtmlAttribute(value.slice(leadingWhitespace, value.length - trailingWhitespace))
        if (!source) continue
        results.push({
          source,
          attribute,
          start: tagStart + valueOffset + leadingWhitespace,
          end: tagStart + valueOffset + value.length - trailingWhitespace,
          occurrence: occurrence++
        })
      }
    }
  }
  return results
}

/**
 * Replace only URL value spans.  The resolver may return undefined to leave a
 * source untouched (for example, when a remote image could not be fetched).
 */
export const replaceRichTextImageSources = (
  html: string,
  resolver: (source: RichTextImageSource) => string | undefined
): { html: string; replacements: RichTextImageReplacement[]; unresolved: RichTextImageSource[] } => {
  const sources = findRichTextImageSources(html)
  const ranges: Array<{ start: number; end: number; value: string }> = []
  const replacements: RichTextImageReplacement[] = []
  const unresolved: RichTextImageSource[] = []
  for (const source of sources) {
    const token = resolver(source)
    if (!token) {
      unresolved.push(source)
      continue
    }
    ranges.push({ start: source.start, end: source.end, value: token })
    replacements.push({
      source: source.source,
      token,
      attribute: source.attribute,
      occurrence: source.occurrence
    })
  }
  let result = html
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + range.value + result.slice(range.end)
  }
  return { html: result, replacements, unresolved }
}

export interface ParsedAssetToken {
  sha256: string
  referenceId: string
}

const assetTokenPattern = /^visslm-asset:\/\/([a-f0-9]{64})\/([A-Za-z0-9_-]{1,128})$/i

export const parseAssetToken = (value: string): ParsedAssetToken | null => {
  const match = assetTokenPattern.exec(value.trim())
  if (!match) return null
  return { sha256: match[1].toLowerCase(), referenceId: match[2] }
}

export const containsUnsafeAssetPath = (value: string): boolean =>
  controlCharacterPattern.test(value) || /[\\]/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)
