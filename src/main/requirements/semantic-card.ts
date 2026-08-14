import type { RecordDetail } from '../../shared/types'

export type RequirementAction =
  | 'rename_label'
  | 'configure_permission'
  | 'compare'
  | 'enable_selection'
  | 'add_capability'
  | 'remove_capability'
  | 'relax_constraint'
  | 'tighten_constraint'
  | 'fix_defect'
  | 'change_flow'
  | 'optimize_ui'
  | 'unknown'

export const REQUIREMENT_ACTIONS: RequirementAction[] = [
  'rename_label', 'configure_permission', 'compare', 'enable_selection', 'add_capability',
  'remove_capability', 'relax_constraint', 'tighten_constraint', 'fix_defect', 'change_flow',
  'optimize_ui', 'unknown'
]

export type RequirementSemanticFieldName =
  | 'requirementType'
  | 'productDomain'
  | 'module'
  | 'functionalObject'
  | 'action'
  | 'currentState'
  | 'targetState'
  | 'trigger'
  | 'input'
  | 'output'
  | 'behavior'
  | 'constraints'
  | 'acceptance'
  | 'businessScene'

export const REQUIREMENT_SEMANTIC_FIELDS: RequirementSemanticFieldName[] = [
  'requirementType', 'productDomain', 'module', 'functionalObject', 'action', 'currentState',
  'targetState', 'trigger', 'input', 'output', 'behavior', 'constraints', 'acceptance', 'businessScene'
]

export interface RequirementSemanticFieldAssessment {
  value: string
  confidence: number
  evidence: string
}

export interface RequirementMatchCard {
  requirementType: string
  productDomain: string
  module: string
  functionalObject: string
  action: RequirementAction
  currentState: string
  targetState: string
  trigger: string
  input: string
  output: string
  behavior: string
  constraints: string
  acceptance: string
  businessScene: string
  /** Clean source fields used by the deterministic exact/near-text path. */
  sourceTitle?: string
  sourceDescription?: string
  evidence: string
  matchingText: string
  lexicalTerms: string[]
  analysisStatus: 'source_only' | 'ai_adjudicated'
  analysisSummary: string
}

export interface RequirementSemanticCard extends RequirementMatchCard {
  fieldAssessments: Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
}

export const isAiRequirementSemanticCard = (value: unknown): value is RequirementSemanticCard => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const card = value as Partial<RequirementSemanticCard>
  if (card.analysisStatus !== 'ai_adjudicated' || !REQUIREMENT_ACTIONS.includes(card.action as RequirementAction)) {
    return false
  }
  if (!card.fieldAssessments || typeof card.fieldAssessments !== 'object') return false
  if (!REQUIREMENT_SEMANTIC_FIELDS.every((field) => {
    const item = card.fieldAssessments?.[field]
    return Boolean(item && typeof item.value === 'string' && typeof item.evidence === 'string' &&
      Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)
  })) return false
  return typeof card.functionalObject === 'string' && Boolean(card.functionalObject.trim()) &&
    typeof card.behavior === 'string' && Boolean(card.behavior.trim()) &&
    typeof card.evidence === 'string' && Boolean(card.evidence.trim()) &&
    typeof card.matchingText === 'string' && Boolean(card.matchingText.trim()) &&
    Array.isArray(card.lexicalTerms)
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
}

const REQUIREMENT_DESCRIPTION_ALIASES = [
  '_valm_Description', 'description', 'Description', 'content', 'Content', '需求描述', '描述'
] as const

const requirementDescriptionOf = (source: RequirementBusinessSource): string => (
  removeRequirementNoise(
    toRequirementPlainText(source.description) ||
    requirementRawField(source.raw ?? {}, REQUIREMENT_DESCRIPTION_ALIASES)
  )
)

/**
 * Return only business text that is safe for requirement recall and embedding.
 * Record identity, audit fields, and generic normalized_text are deliberately
 * excluded because they are metadata rather than requirement evidence.
 */
export const buildRequirementBusinessText = (source: RequirementBusinessSource): string => {
  const title = toRequirementPlainText(source.name)
  const raw = source.raw ?? {}
  const requirementType = requirementRawField(raw, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ])
  const productDomain = requirementRawField(raw, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ])
  const module = requirementRawField(raw, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
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

const assessment = (value = '', evidence = '', confidence = 0): RequirementSemanticFieldAssessment => ({
  value,
  confidence,
  evidence
})

export const buildRequirementMatchingText = (
  card: Pick<RequirementMatchCard,
    'requirementType' | 'productDomain' | 'module' | 'functionalObject' | 'action' |
    'currentState' | 'targetState' | 'trigger' | 'input' | 'output' | 'behavior' |
    'constraints' | 'acceptance' | 'businessScene' | 'evidence'>
): string => [
  card.requirementType ? `需求类型：${card.requirementType}` : '',
  card.productDomain ? `产品域：${card.productDomain}` : '',
  card.module ? `业务模块：${card.module}` : '',
  card.functionalObject ? `功能对象：${card.functionalObject}` : '',
  card.action !== 'unknown' ? `需求动作：${card.action}` : '',
  card.currentState ? `当前状态：${card.currentState}` : '',
  card.targetState ? `目标状态：${card.targetState}` : '',
  card.trigger ? `触发条件：${card.trigger}` : '',
  card.input ? `输入：${card.input}` : '',
  card.output ? `输出：${card.output}` : '',
  card.constraints ? `业务约束：${card.constraints}` : '',
  card.acceptance ? `验收结果：${card.acceptance}` : '',
  card.businessScene ? `业务场景：${card.businessScene}` : '',
  card.behavior ? `功能行为：${card.behavior}` : '',
  `完整需求原文：\n${card.evidence}`
].filter(Boolean).join('\n')

export const buildRequirementSemanticCard = (record: RecordDetail): RequirementSemanticCard => {
  const requirementType = requirementRawField(record.raw, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ])
  const module = requirementRawField(record.raw, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
  ])
  const productDomain = requirementRawField(record.raw, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ])
  const description = requirementDescriptionOf(record)
  const title = toRequirementPlainText(record.name)
  const evidence = buildRequirementBusinessText(record)
  const behavior = description || title
  const fieldAssessments = Object.fromEntries(
    REQUIREMENT_SEMANTIC_FIELDS.map((field) => [field, assessment()])
  ) as Record<RequirementSemanticFieldName, RequirementSemanticFieldAssessment>
  fieldAssessments.requirementType = assessment(requirementType, requirementType, requirementType ? 1 : 0)
  fieldAssessments.productDomain = assessment(productDomain, productDomain, productDomain ? 1 : 0)
  fieldAssessments.module = assessment(module, module, module ? 1 : 0)
  fieldAssessments.behavior = assessment(behavior, description || title, behavior ? 1 : 0)
  const card: RequirementSemanticCard = {
    requirementType,
    productDomain,
    module,
    functionalObject: '',
    action: 'unknown',
    currentState: '',
    targetState: '',
    trigger: '',
    input: '',
    output: '',
    behavior,
    constraints: '',
    acceptance: '',
    businessScene: '',
    sourceTitle: title,
    sourceDescription: description,
    evidence,
    matchingText: '',
    lexicalTerms: requirementLexicalTermsOf([title, description, requirementType, productDomain, module]),
    fieldAssessments,
    analysisStatus: 'source_only',
    analysisSummary: '仅完成原文清洗和明确字段读取，未推断业务语义。'
  }
  card.matchingText = evidence
  return card
}

/**
 * Build the read-only source view used by matching when no valid AI asset exists.
 * It intentionally carries no inferred action, object, state, or business rule.
 */
export const buildRequirementSourceView = (record: RecordDetail): RequirementMatchCard => {
  const requirementType = requirementRawField(record.raw, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ])
  const module = requirementRawField(record.raw, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
  ])
  const productDomain = requirementRawField(record.raw, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ])
  const title = toRequirementPlainText(record.name)
  const description = requirementDescriptionOf(record)
  const evidence = buildRequirementBusinessText(record)
  return {
    requirementType,
    productDomain,
    module,
    functionalObject: '',
    action: 'unknown',
    currentState: '',
    targetState: '',
    trigger: '',
    input: '',
    output: '',
    behavior: description || title,
    constraints: '',
    acceptance: '',
    businessScene: '',
    sourceTitle: title,
    sourceDescription: description,
    evidence,
    matchingText: evidence,
    lexicalTerms: requirementLexicalTermsOf([title, description, requirementType, productDomain, module]),
    analysisStatus: 'source_only',
    analysisSummary: '仅使用数据中心原文，不包含 AI 推断语义。'
  }
}

const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

export const semanticTextSimilarity = (left: string, right: string): number => {
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

export const structuralRequirementScore = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): number => {
  const weighted: Array<[number, number]> = []
  const add = (weight: number, left: string, right: string): void => {
    if (!left || !right) return
    weighted.push([weight, semanticTextSimilarity(left, right)])
  }
  add(0.3, base.functionalObject, candidate.functionalObject)
  if (base.action !== 'unknown' && candidate.action !== 'unknown') weighted.push([0.25, base.action === candidate.action ? 1 : 0])
  add(0.15, base.currentState, candidate.currentState)
  add(0.15, base.targetState, candidate.targetState)
  add(0.08, base.productDomain, candidate.productDomain)
  add(0.05, base.module, candidate.module)
  add(0.02, base.requirementType, candidate.requirementType)
  const totalWeight = weighted.reduce((sum, [weight]) => sum + weight, 0)
  if (!totalWeight) return 0
  return weighted.reduce((sum, [weight, score]) => sum + weight * score, 0) / totalWeight * 100
}

export const requirementLexicalTerms = (values: string[]): string[] => requirementLexicalTermsOf(values)
