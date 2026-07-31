export interface ProjectRequirementTextInput {
  module?: unknown
  title?: unknown
  content?: unknown
}

export interface NormalizedProjectRequirementText {
  module: string
  title: string
  content: string
}

const chapterNumberPattern = /^(?:(?:第\s*[0-9一二三四五六七八九十百千万]+\s*[章节条])|(?:\d+(?:\.\d+){1,5}|[一二三四五六七八九十百千万]+)[、.．]?)(?:\s+|$)/u
const functionalLeadPattern = /(?:系统|平台|软件|用户|支持|提供|实现|优化|完善|应|需|可|能够|允许|完成|具备|通过|对|按照|查询|新增|删除|编辑|配置|管理|导入|导出|同步|查看|统计|展示|生成|关联|维护|上传|下载|调用|接收|发送|校验|认证|登录|授权|监控|告警|记录|保存|检索|搜索|分析|识别|匹配|转换|控制|调度)/u

const normalizeText = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim()

const isEmptyModule = (value: string): boolean => (
  !value || ['无', '无模块', '未分类', '未命名', 'unknown', 'n/a'].includes(value.toLocaleLowerCase())
)

const stripModuleTail = (value: string): string => value
  .replace(/[\s:：|·—–-]+$/u, '')
  .trim()

const compactText = (value: string): string => value.replace(/\s+/g, '')

const findCompactTextStart = (source: string, target: string): number => {
  const compactSource = compactText(source)
  const compactTarget = compactText(target)
  const compactIndex = compactTarget.length >= 6 ? compactSource.indexOf(compactTarget) : -1
  if (compactIndex < 0) return -1
  let compactIndexSeen = 0
  for (let index = 0; index < source.length; index += 1) {
    if (/\s/u.test(source[index] ?? '')) continue
    if (compactIndexSeen === compactIndex) return index
    compactIndexSeen += 1
  }
  return -1
}

const summarizeContent = (content: string): string => {
  const firstSentence = normalizeText(content).split(/[。！？!?；;\n]/u)[0]?.trim() ?? ''
  if (!firstSentence) return ''
  return firstSentence.length > 64 ? `${firstSentence.slice(0, 63)}…` : firstSentence
}

const stripExplicitModule = (title: string, module: string): string => {
  const normalizedTitle = normalizeText(title)
  const normalizedModule = normalizeText(module)
  if (!normalizedTitle || !normalizedModule) return normalizedTitle
  if (normalizedTitle === normalizedModule) return ''
  if (!normalizedTitle.toLocaleLowerCase().startsWith(normalizedModule.toLocaleLowerCase())) return normalizedTitle
  return normalizedTitle.slice(normalizedModule.length).replace(/^[\s:：|·—–-]+/u, '').trim()
}

const inferFromChapterTitle = (title: string, content: string): { module: string; title: string } => {
  const chapterMatch = chapterNumberPattern.exec(title)
  if (!chapterMatch) return { module: '', title }

  const chapterPrefix = chapterMatch[0].trim()
  const rest = title.slice(chapterMatch[0].length).trim()
  if (!rest) return { module: chapterPrefix, title: '' }

  const contentStart = findCompactTextStart(title, content)
  if (contentStart > chapterPrefix.length) {
    const candidateModule = stripModuleTail(title.slice(0, contentStart))
    const candidateTitle = title.slice(contentStart).trim()
    if (candidateModule && candidateTitle) return { module: candidateModule, title: candidateTitle }
  }

  const functionalLead = functionalLeadPattern.exec(rest)
  if (functionalLead && functionalLead.index > 0 && functionalLead.index <= 40) {
    const candidateModule = stripModuleTail(`${chapterPrefix} ${rest.slice(0, functionalLead.index)}`)
    const candidateTitle = rest.slice(functionalLead.index).trim()
    if (candidateModule && candidateTitle) return { module: candidateModule, title: candidateTitle }
  }

  if (rest.length <= 32 && !/[。！？!?；;]/u.test(rest)) {
    return { module: title, title: '' }
  }
  return { module: chapterPrefix, title: rest }
}

export const normalizeProjectRequirementText = (
  input: ProjectRequirementTextInput
): NormalizedProjectRequirementText => {
  const content = String(input.content ?? '').trim()
  let title = normalizeText(input.title)
  let module = normalizeText(input.module)
  if (isEmptyModule(module)) module = ''

  if (module) {
    const contentStart = findCompactTextStart(title, content)
    if (contentStart > 0) {
      const titlePrefix = stripModuleTail(title.slice(0, contentStart))
      if (titlePrefix && chapterNumberPattern.test(titlePrefix)) {
        module = titlePrefix
        title = title.slice(contentStart).trim()
      }
    }
    if (title) title = stripExplicitModule(title, module)
  } else if (title) {
    const inferred = inferFromChapterTitle(title, content)
    module = inferred.module
    title = inferred.title
  }

  if (!title && content) title = summarizeContent(content)
  if (module && title && title.toLocaleLowerCase() === module.toLocaleLowerCase()) {
    title = summarizeContent(content)
  }
  return { module, title, content }
}
