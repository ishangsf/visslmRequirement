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

export interface RequirementSemanticCard {
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
  evidence: string
  matchingText: string
  lexicalTerms: string[]
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  hellip: '…',
  ldquo: '“',
  lsquo: '‘',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  rdquo: '”',
  rsquo: '’'
}

export const decodeHtmlEntities = (value: string): string => {
  let decoded = value
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decoded.replace(
      /&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi,
      (entity, token: string) => {
        if (token[0] !== '#') return NAMED_ENTITIES[token.toLocaleLowerCase()] ?? entity
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

const firstMatch = (text: string, patterns: RegExp[]): string => {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const value = match?.[1]?.trim().replace(/[，。；;：:]$/g, '') ?? ''
    if (value) return value.slice(0, 240)
  }
  return ''
}

const inferDomain = (text: string): string => {
  const domains = [
    '配置管理', '需求管理', '项目管理', '评审管理', '测试管理', '质量管理',
    '资产管理', '权限管理', '文档管理', '计划管理', '缺陷管理', '数据管理',
    '代码模型', '受控库', '开发库', '产品库'
  ]
  return domains.find((domain) => text.includes(domain)) ?? ''
}

const inferAction = (title: string, description: string, requirementType: string): RequirementAction => {
  const text = `${title}\n${description}`
  if (/(?:名称|文案|显示文字|展示名称).{0,18}(?:修改|变更|调整)|(?:修改|改|替换)为[“”‘’"']/.test(text) ||
      /[“‘"'][^”’"']+[”’"'].{0,10}(?:按钮)?(?:建议)?(?:修改|改|替换)为/.test(text)) return 'rename_label'
  if (/(?:权限|授权).{0,24}(?:配置|设置|控制|不可设置|支持)/.test(text)) return 'configure_permission'
  if (/(?:比较|对比|差异).{0,16}(?:功能|展示|查看|支持)|(?:支持|提供).{0,16}(?:比较|对比)/.test(text)) return 'compare'
  if (/(?:支持|能够|允许).{0,20}选择|选择.{0,20}(?:支持|功能)/.test(text)) return 'enable_selection'
  if (/(?:删除|隐藏|去掉|移除|取消).{0,16}(?:按钮|功能|入口|字段)|(?:按钮|功能|入口|字段).{0,16}(?:删除|隐藏|去掉|移除|取消)/.test(text)) return 'remove_capability'
  if (/(?:允许|可选|不应影响|无需|不需要).{0,28}(?:建立|创建|执行|操作)|放宽|不再限制/.test(text)) return 'relax_constraint'
  if (/(?:必须|仅允许|不允许|禁止|限制).{0,32}(?:建立|创建|执行|操作|选择|访问)/.test(text)) return 'tighten_constraint'
  if (/(?:流程|申请单|审批).{0,28}(?:调整|修改|新增|支持|发起)/.test(text)) return 'change_flow'
  if (/(?:界面|页面|布局|样式|位置).{0,20}(?:优化|调整|突出|改进)/.test(text)) return 'optimize_ui'
  if (requirementType.toLocaleLowerCase() === 'defect' || /(?:缺陷|异常|报错|无法|失败|不生效|错误)/.test(text)) {
    return 'fix_defect'
  }
  if (/(?:新增|增加|添加|提供|支持|实现).{0,40}(?:功能|能力|按钮|入口|机制|展示|查看|创建|建立)/.test(text)) {
    return 'add_capability'
  }
  return 'unknown'
}

const quotedRename = (text: string): { currentState: string; targetState: string } => {
  const match = /[“‘"']([^”’"']{1,80})[”’"'](?:按钮|字段|名称|文字)?\s*(?:建议)?\s*(?:修改|改|替换)为\s*[“‘"']([^”’"']{1,80})[”’"']/.exec(text)
  if (match) return { currentState: match[1].trim(), targetState: match[2].trim() }
  const unquoted = /([^，。；;\n]{1,40})(?:按钮|字段|名称|文字)?\s*(?:建议)?\s*(?:修改|改|替换)为\s*([^，。；;\n]{1,40})/.exec(text)
  return {
    currentState: unquoted?.[1]?.trim() ?? '',
    targetState: unquoted?.[2]?.trim() ?? ''
  }
}

const inferFunctionalObject = (
  title: string,
  description: string,
  domain: string,
  action: RequirementAction,
  currentState: string
): string => {
  const text = `${title}。${description}`
  if (action === 'rename_label' && currentState) {
    const prefix = firstMatch(text, [
      /(?:在|中|进入)?([^，。；;\n]{1,30}(?:界面|页面|预设子页|库))[^，。；;\n]{0,30}[“‘"'][^”’"']+[”’"'](?:按钮|字段|名称|文字)/,
      /([^，。；;\n]{1,24})[“‘"'][^”’"']+[”’"'](?:按钮|字段|名称|文字)/
    ])
    return [prefix, `${currentState}按钮`].filter(Boolean).join(' · ')
  }
  return firstMatch(text, [
    /([^，。；;\n]{2,36}(?:按钮|字段|页面|界面|子页|申请单|基线|配置项|文档|版本|流程))(?=.{0,24}(?:支持|新增|增加|修改|调整|无法|不能|允许|比较|对比))/,
    /(?:针对|对于|在)([^，。；;\n]{2,36})(?:中|上|下|时|进行)/
  ])
}

const lexicalTermsOf = (values: string[]): string[] => {
  const terms = values.flatMap((value) => value
    .split(/[\s，。；;：:、/|·（）()\[\]【】]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 32))
  return [...new Set(terms)].slice(0, 40)
}

const compactEvidence = (description: string, fallback: string): string =>
  (description || fallback).replace(/\n+/g, ' ').trim().slice(0, 1200)

const removeRequirementNoise = (value: string): string => value
  .replace(/(?:^|[\n。；;])\s*(?:发布版本|创建人|创建时间|客户来源|来源客户|处理意见|历史回复|历史回复记录)\s*[：:]?[^\n。；;]*/gi, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

export const buildRequirementSemanticCard = (record: RecordDetail): RequirementSemanticCard => {
  const requirementType = requirementRawField(record.raw, [
    'IssueType', 'issueType', '_valm_IssueType', 'requirementType', '需求类型', '问题类型'
  ])
  const module = requirementRawField(record.raw, [
    '_valm_Module', '_valm_ModuleName', 'module', 'moduleName', 'Module', 'ModuleName',
    'featureModule', 'featureModuleName', 'requirementModule', '业务模块', '功能模块', '模块'
  ])
  const explicitProductDomain = requirementRawField(record.raw, [
    '_valm_ProductDomain', '_valm_Product', 'productDomain', 'product', 'domain',
    '产品域', '产品领域', '产品'
  ])
  const description = removeRequirementNoise(toRequirementPlainText(record.description) || requirementRawField(record.raw, [
    '_valm_Description', 'description', 'Description', 'content', 'Content', '需求描述', '描述'
  ]))
  const title = toRequirementPlainText(record.name)
  const sourceText = `${title}\n${description}`.trim()
  const productDomain = explicitProductDomain || inferDomain(sourceText)
  const action = inferAction(title, description, requirementType)
  const rename = action === 'rename_label' ? quotedRename(sourceText) : { currentState: '', targetState: '' }
  const currentState = rename.currentState || firstMatch(description, [
    /(?:当前|目前|现状)[：:]?\s*([^。；;\n]{2,160})/
  ])
  const targetState = rename.targetState || firstMatch(description, [
    /(?:期望结果|预期结果|客户希望|建议|需求)[：:]?\s*([^。；;\n]{2,200})/
  ])
  const trigger = firstMatch(description, [
    /(?:当|在)([^。；;\n]{2,100}?)(?:时|后|情况下)[，,]?/,
    /(?:触发条件|使用场景|场景操作描述)[：:]\s*([^。；;\n]{2,160})/
  ])
  const input = firstMatch(description, [
    /(?:输入|选择|填写|导入)[：:]?\s*([^。；;\n]{2,120})/
  ])
  const output = firstMatch(description, [
    /(?:输出|生成|导出|返回|显示)[：:]?\s*([^。；;\n]{2,120})/
  ])
  const constraints = firstMatch(description, [
    /((?:必须|仅允许|不允许|禁止|限制|至少|最多|无需|不能)[^。；;\n]{2,180})/
  ])
  const acceptance = firstMatch(description, [
    /(?:期望结果|预期结果|验收标准|正常现象)[：:]\s*([^\n]{2,240})/,
    /((?:应当|应该|需要|能够|支持)[^。；;\n]{2,180})/
  ])
  const businessScene = firstMatch(description, [
    /(?:客户使用场景|用户场景描述|使用场景|场景操作描述)[：:]\s*([^\n]{2,240})/
  ]) || trigger
  const functionalObject = inferFunctionalObject(title, description, productDomain, action, currentState)
  const evidenceFallback = removeRequirementNoise(toRequirementPlainText(record.normalizedText ?? ''))
  const evidence = compactEvidence(
    removeRequirementNoise([title, description].filter(Boolean).join('。')),
    evidenceFallback || title
  )
  const behavior = (description || title).slice(0, 1600)
  const matchingText = [
    `需求类型：${requirementType}`,
    productDomain ? `产品域：${productDomain}` : '',
    module ? `业务模块：${module}` : '',
    functionalObject ? `功能对象：${functionalObject}` : '',
    `需求动作：${action}`,
    currentState ? `当前状态：${currentState}` : '',
    targetState ? `目标状态：${targetState}` : '',
    trigger ? `触发条件：${trigger}` : '',
    input ? `输入：${input}` : '',
    output ? `输出：${output}` : '',
    constraints ? `业务约束：${constraints}` : '',
    acceptance ? `验收结果：${acceptance}` : '',
    businessScene ? `业务场景：${businessScene}` : '',
    `需求标题：${title}`,
    `功能行为：${behavior}`
  ].filter(Boolean).join('\n')
  return {
    requirementType,
    productDomain,
    module,
    functionalObject,
    action,
    currentState,
    targetState,
    trigger,
    input,
    output,
    behavior,
    constraints,
    acceptance,
    businessScene,
    evidence,
    matchingText,
    lexicalTerms: lexicalTermsOf([
      title, productDomain, module, functionalObject, currentState, targetState, trigger, acceptance
    ])
  }
}

const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

export const semanticTextSimilarity = (left: string, right: string): number => {
  const a = normalized(left)
  const b = normalized(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const grams = (value: string): Set<string> => {
    if (value.length <= 2) return new Set([value])
    return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)))
  }
  const ag = grams(a)
  const bg = grams(b)
  const overlap = [...ag].filter((gram) => bg.has(gram)).length
  return overlap / Math.max(1, ag.size + bg.size - overlap)
}

export const structuralRequirementScore = (
  base: RequirementSemanticCard,
  candidate: RequirementSemanticCard
): number => {
  const weighted: Array<[number, number]> = []
  const add = (weight: number, left: string, right: string): void => {
    if (!left || !right) return
    weighted.push([weight, semanticTextSimilarity(left, right)])
  }
  add(0.3, base.functionalObject, candidate.functionalObject)
  if (base.action !== 'unknown' && candidate.action !== 'unknown') {
    weighted.push([0.25, base.action === candidate.action ? 1 : 0])
  }
  add(0.15, base.currentState, candidate.currentState)
  add(0.15, base.targetState, candidate.targetState)
  add(0.08, base.productDomain, candidate.productDomain)
  add(0.05, base.module, candidate.module)
  add(0.02, base.requirementType, candidate.requirementType)
  const totalWeight = weighted.reduce((sum, [weight]) => sum + weight, 0)
  if (!totalWeight) return 0
  return weighted.reduce((sum, [weight, score]) => sum + weight * score, 0) / totalWeight * 100
}
