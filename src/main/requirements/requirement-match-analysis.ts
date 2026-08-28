import type { ProjectRequirementMatchCandidate } from '../../shared/project-types'
import type { RequirementMatchCard } from './requirement-match-card'
import { normalizeRequirementAction, normalizeRequirementBusinessText } from './requirement-business-normalization'

export type DeterministicRequirementMatchAnalysis = ProjectRequirementMatchCandidate['deterministicAnalysis']

const GENERIC_TERMS = new Set([
  '功能', '需求', '系统', '平台', '软件', '数据', '信息', '内容', '业务', '相关', '支持', '实现',
  '管理', '进行', '提供', '明确', '类型', '模块', '描述', '问题', '能力', '当前', '项目'
])

const ACTION_PATTERN = /批量导出|批量导入|权限校验|覆盖|查询|检索|搜索|查看|新增|创建|删除|编辑|修改|更新|配置|管理|导入|导出|同步|统计|展示|生成|关联|维护|上传|下载|调用|接收|发送|校验|认证|登录|授权|监控|告警|记录|保存|分析|识别|匹配|转换|控制|调度/iu

const clean = (value: string): string => value.normalize('NFKC').replace(/\s+/g, ' ').trim()
const short = (value: string, maximum = 28): string => {
  const normalized = clean(value)
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}…` : normalized
}

const actionOf = (card: RequirementMatchCard): string => (
  clean(card.sourceTitle.match(ACTION_PATTERN)?.[0] ?? '') ||
  clean(card.businessFacts.action) ||
  clean(card.sourceDescription.match(ACTION_PATTERN)?.[0] ?? '')
)

const objectOf = (card: RequirementMatchCard, action: string): string => {
  const title = clean(card.sourceTitle)
  if (title && action) {
    const actionIndex = title.toLocaleLowerCase().indexOf(action.toLocaleLowerCase())
    if (actionIndex >= 0) {
      const trailing = clean(title.slice(actionIndex + action.length)).replace(/^[\s\p{P}\p{S}]+/gu, '')
      if (trailing) return trailing
    }
  }
  if (title && title.length <= 32) return title
  const explicit = clean(card.businessFacts.object).replace(/^[\s\p{P}\p{S}]+/gu, '')
  if (explicit) return explicit
  return title.replace(new RegExp(`^${action}`, 'iu'), '').replace(/^[\s\p{P}\p{S}]+/gu, '')
}

const sameAction = (left: string, right: string): boolean => (
  normalizeRequirementAction(left) === normalizeRequirementAction(right)
)

const salientTerms = (card: RequirementMatchCard): string[] => {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const rawTerm of card.lexicalTerms) {
    const term = clean(rawTerm)
    const normalized = normalizeRequirementBusinessText(term)
    if (!normalized || normalized.length < 2 || normalized.length > 24 || GENERIC_TERMS.has(normalized) || ACTION_PATTERN.test(term)) continue
    if (/^[\p{Script=Han}]{3}$/u.test(term) && card.lexicalTerms.some((candidate) => candidate !== rawTerm && candidate.includes(term) && candidate.length > term.length)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    terms.push(term)
    if (terms.length >= 12) break
  }
  return terms
}

const contained = (text: string, term: string): boolean => (
  normalizeRequirementBusinessText(text).includes(normalizeRequirementBusinessText(term))
)

const formatTerms = (terms: string[]): string => terms.map((term) => `“${short(term, 18)}”`).join('、')

export const buildDeterministicRequirementMatchAnalysis = (
  base: RequirementMatchCard,
  candidate: RequirementMatchCard
): DeterministicRequirementMatchAnalysis => {
  const similarities: string[] = []
  const differences: string[] = []
  const baseText = `${base.sourceTitle}\n${base.sourceDescription}`
  const candidateText = `${candidate.sourceTitle}\n${candidate.sourceDescription}`
  const baseAction = actionOf(base)
  const candidateAction = actionOf(candidate)

  if (baseAction && candidateAction) {
    if (sameAction(baseAction, candidateAction)) similarities.push(`双方动作均为“${short(baseAction)}”`)
    else differences.push(`动作不同：项目需求为“${short(baseAction)}”，候选为“${short(candidateAction)}”`)
  } else if (baseAction && !candidateAction) {
    differences.push(`候选未写明动作；项目需求动作是“${short(baseAction)}”`)
  } else if (!baseAction && candidateAction) {
    differences.push(`项目需求未写明动作；候选动作是“${short(candidateAction)}”`)
  }

  const baseObject = objectOf(base, baseAction)
  const candidateObject = objectOf(candidate, candidateAction)
  if (baseObject && candidateObject) {
    const left = normalizeRequirementBusinessText(baseObject)
    const right = normalizeRequirementBusinessText(candidateObject)
    if (left === right || left.includes(right) || right.includes(left)) {
      similarities.push(`双方业务对象均指向“${short(baseObject)}”`)
    } else {
      differences.push(`业务对象不同：项目需求为“${short(baseObject)}”，候选为“${short(candidateObject)}”`)
    }
  } else if (baseObject && !candidateObject) {
    differences.push(`候选未写明业务对象；项目需求对象是“${short(baseObject)}”`)
  } else if (!baseObject && candidateObject) {
    differences.push(`项目需求未写明业务对象；候选对象是“${short(candidateObject)}”`)
  }

  const baseTerms = salientTerms(base)
  const candidateTerms = salientTerms(candidate)
  const sharedTerms = baseTerms.filter((term) => contained(candidateText, term)).slice(0, 3)
  if (sharedTerms.length) similarities.push(`共同涉及${formatTerms(sharedTerms)}`)

  const missingBaseTerms = baseTerms.filter((term) => !contained(candidateText, term)).slice(0, 3)
  if (missingBaseTerms.length) differences.push(`候选未体现项目需求中的${formatTerms(missingBaseTerms)}`)

  if (!similarities.length) similarities.push('未发现可核验的共同动作、对象或关键业务词')
  if (!differences.length) {
    const candidateOnlyTerms = candidateTerms.filter((term) => !contained(baseText, term)).slice(0, 3)
    differences.push(candidateOnlyTerms.length
      ? `候选额外聚焦${formatTerms(candidateOnlyTerms)}`
      : '未识别出确定性差异，仍需结合双方原文确认范围和约束')
  }

  return {
    similarities: [...new Set(similarities)].slice(0, 2),
    differences: [...new Set(differences)].slice(0, 2),
    basis: 'business_facts_and_terms'
  }
}
