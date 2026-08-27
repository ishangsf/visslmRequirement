import type { RecordDetail } from '../../shared/types'

/**
 * The source view used by requirement matching.
 *
 * This is deliberately limited to fields read from the cleaned data-centre
 * source.  It must not contain model-inferred actions, objects, states, or
 * business rules, and it is never persisted as a generated asset.
 */
export interface RequirementMatchCard {
  requirementType: string
  productDomain: string
  module: string
  sourceTitle: string
  sourceDescription: string
  evidence: string
  matchingText: string
  lexicalTerms: string[]
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", gt: '>', hellip: '…', ldquo: '“', lsquo: '‘', lt: '<',
  nbsp: ' ', quot: '"', rdquo: '”', rsquo: '’'
}

export const decodeHtmlEntities = (value: string): string => {
  let decoded = value
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, token: string) => {
      if (token[0] !== '#') return NAMED_ENTITIES[token.toLocaleLowerCase()] ?? entity
      const hexadecimal = token[1]?.toLocaleLowerCase() === 'x'
      const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return entity
      }
    })
    if (next === decoded) break
    decoded = next
  }
  return decoded
}

/** Convert a platform value (including rich text) to readable plain text. */
export const toRequirementPlainText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(toRequirementPlainText).filter(Boolean).join('、')
  if (typeof value === 'object') return ''
  return decodeHtmlEntities(String(value))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const requirementRawField = (
  raw: Record<string, unknown>,
  aliases: readonly string[]
): string => {
  const wanted = new Set(aliases.map((alias) => alias.toLocaleLowerCase()))
  const visit = (value: unknown, depth: number): string => {
    if (depth > 5 || !value || typeof value !== 'object') return ''
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return ''
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!wanted.has(key.toLocaleLowerCase())) continue
      const found = toRequirementPlainText(child)
      if (found) return found
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = visit(child, depth + 1)
      if (found) return found
    }
    return ''
  }
  return visit(raw, 0)
}

export const removeRequirementNoise = (value: string): string => value
  .replace(/(?:^|[\n。；;])\s*(?:发布版本|创建人|创建时间|客户来源|来源客户|处理意见|历史回复|历史回复记录)\s*[：:]?[^\n。；;]*/gi, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

export interface RequirementBusinessSource {
  name?: unknown
  description?: unknown
  raw?: Record<string, unknown>
  /** Node-type scoped platform field labels used to resolve source fields. */
  fieldLabels?: Record<string, string>
}

const REQUIREMENT_DESCRIPTION_ALIASES = [
  '_valm_Description', 'description', 'Description', 'content', 'Content', '需求描述', '描述'
] as const

const normalizeRequirementFieldLabel = (value: unknown): string => (
  toRequirementPlainText(value)
    .replace(/[\s_\-:：/\\（）()\[\]【】]/g, '')
    .toLocaleLowerCase()
)

/** Resolve a source field through the deployment-specific field catalogue. */
export const requirementFieldByDisplayName = (
  raw: Record<string, unknown>,
  fieldLabels: Record<string, string> | undefined,
  displayNameAliases: readonly string[]
): string => {
  if (!fieldLabels || !Object.keys(fieldLabels).length) return ''
  const wanted = new Set(displayNameAliases.map(normalizeRequirementFieldLabel).filter(Boolean))
  if (!wanted.size) return ''
  const rawEntries = new Map(
    Object.entries(raw).map(([key, value]) => [key.toLocaleLowerCase(), value])
  )
  for (const [field, displayName] of Object.entries(fieldLabels)) {
    if (!wanted.has(normalizeRequirementFieldLabel(displayName))) continue
    const direct = rawEntries.get(field.toLocaleLowerCase())
    const text = toRequirementPlainText(direct)
    if (text) return text
  }
  return ''
}

const requirementField = (
  source: RequirementBusinessSource,
  keyAliases: readonly string[],
  displayNameAliases: readonly string[]
): string => (
  requirementRawField(source.raw ?? {}, keyAliases) ||
  requirementFieldByDisplayName(source.raw ?? {}, source.fieldLabels, displayNameAliases)
)

const requirementDescriptionOf = (source: RequirementBusinessSource): string => (
  removeRequirementNoise(
    toRequirementPlainText(source.description) ||
    requirementField(source, REQUIREMENT_DESCRIPTION_ALIASES, [
      '需求描述', '详细描述', '描述', '需求内容', '内容', '正文'
    ])
  )
)

/**
 * Return the cleaned business source used by recall and embedding. Identity,
 * audit fields, and generic normalized_text are deliberately excluded.
 */
export const buildRequirementBusinessText = (source: RequirementBusinessSource): string => {
  const mappedTitle = requirementField(source, [
    '_valm_Name', 'requirementTitle', 'requirementName', 'title', '需求标题', '需求名称', '标题'
  ], [
    '需求标题', '需求名称', '标题', '主题', '名称'
  ])
  const title = mappedTitle || toRequirementPlainText(source.name)
  const requirementType = requirementField(source, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ], [
    '需求类型', '问题类型', '类型'
  ])
  const productDomain = requirementField(source, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ], [
    '产品域', '产品领域', '所属产品', '产品'
  ])
  const module = requirementField(source, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
  ], [
    '业务模块', '功能模块', '需求模块', '所属模块', '模块'
  ])
  const description = requirementDescriptionOf(source)
  return [
    title ? `名称：${title}` : '',
    requirementType ? `明确需求类型：${requirementType}` : '',
    productDomain ? `明确产品域：${productDomain}` : '',
    module ? `明确模块：${module}` : '',
    description ? `描述：${description}` : ''
  ].filter(Boolean).join('\n')
}

export const requirementLexicalTermsOf = (values: string[]): string[] => {
  const terms = values.flatMap((value) => value
    .split(/[\s，。；;：:、/|·（）()\[\]【】]+/)
    .flatMap((rawItem) => {
      const item = rawItem.trim()
      if (!item) return []
      const technicalTerms = item.match(/[A-Za-z][A-Za-z0-9_.+-]{1,31}/g) ?? []
      const hanRuns = item.match(/[\p{Script=Han}]{3,}/gu) ?? []
      const hanTerms = hanRuns.flatMap((run) => {
        const clipped = run.slice(0, 48)
        const windows: string[] = []
        for (let index = 0; index <= clipped.length - 3; index += 1) {
          windows.push(clipped.slice(index, index + 3))
        }
        return [clipped, ...windows]
      })
      return [
        ...(item.length >= 2 && item.length <= 32 ? [item] : []),
        ...technicalTerms,
        ...hanTerms
      ]
    }))
  return [...new Set(terms)].slice(0, 80)
}

/** Build a read-only source view for every matching request. */
export const buildRequirementSourceView = (record: RecordDetail): RequirementMatchCard => {
  const source: RequirementBusinessSource = record
  const requirementType = requirementField(source, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ], [
    '需求类型', '问题类型', '类型'
  ])
  const productDomain = requirementField(source, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ], [
    '产品域', '产品领域', '所属产品', '产品'
  ])
  const module = requirementField(source, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
  ], [
    '业务模块', '功能模块', '需求模块', '所属模块', '模块'
  ])
  const sourceTitle = toRequirementPlainText(record.name)
  const sourceDescription = requirementDescriptionOf(source)
  const evidence = buildRequirementBusinessText(source)
  return {
    requirementType,
    productDomain,
    module,
    sourceTitle,
    sourceDescription,
    evidence,
    matchingText: evidence,
    lexicalTerms: requirementLexicalTermsOf([
      sourceTitle, sourceDescription, requirementType, productDomain, module
    ])
  }
}

const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

/** Generic normalized character n-gram similarity for deterministic scoring. */
export const textSimilarity = (left: string, right: string): number => {
  const a = normalized(left)
  const b = normalized(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const grams = (value: string): Set<string> => value.length <= 2
    ? new Set([value])
    : new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)))
  const ag = grams(a)
  const bg = grams(b)
  const overlap = [...ag].filter((gram) => bg.has(gram)).length
  return overlap / Math.max(1, ag.size + bg.size - overlap)
}

export const requirementLexicalTerms = (values: string[]): string[] => requirementLexicalTermsOf(values)
