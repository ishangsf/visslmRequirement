import { createHash } from 'node:crypto'
import type { RequirementBusinessFacts } from './requirement-match-domain'
import type { RequirementMatchCard } from './requirement-match-card'

export const REQUIREMENT_NORMALIZATION_VERSION = 'requirement-business-v1'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"'
}

const decodeEntities = (value: string): string => value.replace(
  /&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi,
  (entity, token: string) => {
    if (!token.startsWith('#')) return NAMED_ENTITIES[token.toLocaleLowerCase()] ?? entity
    const hexadecimal = token[1]?.toLocaleLowerCase() === 'x'
    const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return entity
    }
  }
)

/** Canonical text for identity checks. Formatting and transport markup are ignored. */
export const normalizeRequirementBusinessText = (value: unknown): string => decodeEntities(String(value ?? ''))
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .normalize('NFKC')
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')
  .trim()

export const hashRequirementBusinessText = (value: unknown): string => createHash('sha256')
  .update(`${REQUIREMENT_NORMALIZATION_VERSION}\n${normalizeRequirementBusinessText(value)}`)
  .digest('hex')

const ACTIONS = [
  '批量导出', '批量导入', '权限校验', '查询', '检索', '搜索', '查看', '新增', '创建',
  '删除', '编辑', '修改', '配置', '管理', '导入', '导出', '同步', '统计', '展示', '生成',
  '关联', '维护', '上传', '下载', '调用', '接收', '发送', '校验', '认证', '登录', '授权',
  '监控', '告警', '记录', '保存', '分析', '识别', '匹配', '转换', '控制', '调度',
  'validates', 'validate', 'imports', 'import', 'exports', 'export', 'queries', 'query',
  'searches', 'search', 'creates', 'create', 'deletes', 'delete', 'updates', 'update',
  'configures', 'configure', 'manages', 'manage', 'uploads', 'upload', 'downloads', 'download'
] as const

const ACTION_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  查询: 'query', 检索: 'query', 搜索: 'query', 查看: 'query', query: 'query', queries: 'query', search: 'query', searches: 'query',
  新增: 'create', 创建: 'create', create: 'create', creates: 'create',
  删除: 'delete', delete: 'delete', deletes: 'delete',
  编辑: 'update', 修改: 'update', update: 'update', updates: 'update',
  配置: 'configure', configure: 'configure', configures: 'configure',
  导入: 'import', 批量导入: 'import', import: 'import', imports: 'import',
  导出: 'export', 批量导出: 'export', export: 'export', exports: 'export',
  校验: 'validate', 权限校验: 'validate', validate: 'validate', validates: 'validate'
})

export const normalizeRequirementAction = (value: string): string => {
  const normalized = value.normalize('NFKC').toLocaleLowerCase().trim()
  return ACTION_ALIASES[normalized] ?? normalized
}

const NEGATION_PATTERN = /(?:不得|禁止|不允许|不可|不能|无需|不应|不支持|\b(?:must\s+not|shall\s+not|cannot|can't|does\s+not|do\s+not|not\s+allowed)\b)/iu
const LEADING_NOISE_PATTERN = /^(?:(?:系统|平台|软件|用户|管理员|应|需|需要|可以|可|能够|支持|提供|实现|允许)\s*|(?:the\s+)?(?:system|platform|software|user|administrator)\s+)+/iu
const CONSTRAINT_PATTERNS = [
  /响应时间\s*(?:不超过|小于|低于|为|≤|<)?\s*\d+(?:\.\d+)?\s*(?:毫秒|秒|分钟)/gu,
  /(?:至少|最多|不超过|小于|大于|不低于)\s*\d+(?:\.\d+)?\s*(?:条|个|次|人|MB|GB|毫秒|秒|分钟)?/giu,
  /(?:仅限|必须|需要|应当|实时|定时|自动|手动)[^，。；;\n]{0,32}/gu
] as const

const cleanObject = (value: string): string => value
  .replace(CONSTRAINT_PATTERNS[0], ' ')
  .replace(CONSTRAINT_PATTERNS[1], ' ')
  .replace(CONSTRAINT_PATTERNS[2], ' ')
  .split(/[，。；;：:\n]/u)[0]
  ?.replace(/^(?:对|将|把|进行|相关)/u, '')
  .replace(/^(?:the|a|an)\s+/iu, '')
  .replace(/[\s\p{P}\p{S}]+$/gu, '')
  .trim() ?? ''

/** Extract conservative deterministic facts; absent facts remain explicitly missing. */
export const extractRequirementBusinessFacts = (value: unknown): RequirementBusinessFacts => {
  const text = decodeEntities(String(value ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .normalize('NFKC')
    .replace(/[\t\r\f\v ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
  const negated = NEGATION_PATTERN.test(text)
  const withoutNegation = text.replace(NEGATION_PATTERN, '').replace(LEADING_NOISE_PATTERN, '').trim()
  const searchable = withoutNegation.toLocaleLowerCase()
  const action = ACTIONS
    .map((candidate) => ({ candidate, index: searchable.indexOf(candidate.toLocaleLowerCase()) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index || right.candidate.length - left.candidate.length)[0]?.candidate ?? ''
  if (!action) {
    return { action: '', object: '', constraints: [], negated: negated || null, source: 'missing' }
  }
  const actionIndex = searchable.indexOf(action.toLocaleLowerCase())
  const trailingObject = cleanObject(withoutNegation.slice(actionIndex + action.length))
  const leadingObject = cleanObject(withoutNegation.slice(0, actionIndex))
    .replace(/^(?:支持|提供|实现|允许|能够|可以|可|按|根据|通过)/u, '')
    .trim()
  const object = !trailingObject || /^(?:能力|功能|规则|信息|数据)$/u.test(trailingObject)
    ? `${leadingObject}${trailingObject}`.trim()
    : trailingObject
  const constraints = [...new Set(CONSTRAINT_PATTERNS.flatMap((pattern) => text.match(pattern) ?? []))]
  return { action, object, constraints, negated, source: 'deterministic' }
}

export interface NormalizedRequirementBusiness {
  version: typeof REQUIREMENT_NORMALIZATION_VERSION
  title: string
  description: string
  requirementType: string
  productDomain: string
  module: string
  action: string
  object: string
  constraints: string[]
  negated: boolean | null
}

export const normalizeRequirementBusinessCard = (
  card: RequirementMatchCard
): NormalizedRequirementBusiness => ({
  version: REQUIREMENT_NORMALIZATION_VERSION,
  title: normalizeRequirementBusinessText(card.sourceTitle),
  description: normalizeRequirementBusinessText(card.sourceDescription),
  requirementType: normalizeRequirementBusinessText(card.requirementType),
  productDomain: normalizeRequirementBusinessText(card.productDomain),
  module: normalizeRequirementBusinessText(card.module),
  action: normalizeRequirementBusinessText(card.businessFacts.action),
  object: normalizeRequirementBusinessText(card.businessFacts.object),
  constraints: [...new Set(card.businessFacts.constraints.map(normalizeRequirementBusinessText).filter(Boolean))].sort(),
  negated: card.businessFacts.negated
})

export const hashRequirementBusiness = (card: RequirementMatchCard): string => createHash('sha256')
  .update(JSON.stringify(normalizeRequirementBusinessCard(card)))
  .digest('hex')
