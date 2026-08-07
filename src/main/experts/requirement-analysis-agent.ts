import type {
  ChatDataRow,
  ChatDataView,
  ChatRequest,
  ChatResponse,
  ChatSource,
  ModelSettings,
  RecordDetail
} from '../../shared/types'
import type { AgentEvent } from '../../shared/expert-types'
import { AppDatabase } from '../database'
import { KnowledgeService, type KnowledgeRecordMatch } from '../knowledge'
import { ModelClient } from '../model-client'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

const REQUIREMENT_MATCH_MIN_SCORE = 40
const REQUIREMENT_MATCH_CANDIDATE_LIMIT = 20
const REQUIREMENT_MATCH_RESULT_LIMIT = 20
const REQUIREMENT_ANALYSIS_MAX_IDS = 20
const REQUIREMENT_ANSWER_RESULT_LIMIT = 8

const requirementReviewFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'matches'],
  properties: {
    summary: { type: 'string' },
    matches: {
      type: 'array',
      maxItems: REQUIREMENT_MATCH_CANDIDATE_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordUid', 'score', 'reason'],
        properties: {
          recordUid: { type: 'string' },
          score: { type: 'number', minimum: 0, maximum: 100 },
          reason: { type: 'string' }
        }
      }
    }
  }
}

interface RequirementRecordProfile {
  record: RecordDetail
  category: string
  module: string
  description: string
  terms: string[]
  matchingText: string
}

interface RequirementMatchCandidate {
  match: KnowledgeRecordMatch
  profile: RequirementRecordProfile
}

interface RequirementReview {
  summary: string
  matches: Array<{
    recordUid: string
    score: number
    reason: string
  }>
}

interface RequirementAnalysisEntry {
  requestedItemId: string
  base?: RequirementRecordProfile
  matches: RequirementMatchCandidate[]
  reviewSummary?: string
  error?: string
}

const toPlainText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(toPlainText).filter(Boolean).join('、')
  if (typeof value === 'object') return ''
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const clampScore = (value: unknown): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Number(Math.min(100, Math.max(0, numeric)).toFixed(2))
}

const truncate = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

const rawFieldValue = (raw: Record<string, unknown>, aliases: readonly string[]): string => {
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
      if (wanted.has(key.toLocaleLowerCase())) {
        const found = toPlainText(child)
        if (found) return found
      }
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = visit(child, depth + 1)
      if (found) return found
    }
    return ''
  }
  return visit(raw, 0)
}

const rawTerms = (raw: Record<string, unknown>): string[] => {
  const value = rawFieldValue(raw, [
    '_valm_KeyInfoTerms',
    'keyInfoTerms',
    'keywords',
    'keyword',
    'tags',
    'tag',
    '信息词',
    '关键字',
    '关键词'
  ])
  return [...new Set(value.split(/[，,、；;\n]+/).map((item) => item.trim()).filter((item) => item.length >= 2))]
    .slice(0, 12)
}

const profileOf = (record: RecordDetail): RequirementRecordProfile => {
  const module = rawFieldValue(record.raw, [
    '_valm_Module',
    '_valm_ModuleName',
    'module',
    'moduleName',
    'Module',
    'ModuleName',
    'featureModule',
    'featureModuleName',
    'requirementModule',
    '业务模块',
    '功能模块',
    '模块'
  ])
  const category = rawFieldValue(record.raw, [
    '_valm_Category',
    'category',
    'Category',
    'requirementCategory',
    'requirementType',
    '需求分类',
    '需求类型'
  ]) || record.nodeType
  const description = toPlainText(record.description) || rawFieldValue(record.raw, [
    '_valm_Description',
    'description',
    'Description',
    'content',
    'Content',
    '需求描述',
    '描述'
  ])
  const terms = rawTerms(record.raw)
  const matchingText = [
    `需求分类：${category}`,
    module ? `业务模块：${module}` : '',
    `需求标题：${record.name.trim()}`,
    `需求描述：${description || record.normalizedText?.trim() || ''}`,
    terms.length ? `补充信息词：${terms.join('、')}` : ''
  ].filter(Boolean).join('\n')
  return {
    record,
    category,
    module,
    description,
    terms,
    matchingText
  }
}

export const extractRequirementAnalysisIds = (question: string): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    const normalized = value.trim().replace(/^[#【\[（(]+|[#】\]）)]+$/g, '')
    if (!normalized || seen.has(normalized.toLocaleLowerCase())) return
    seen.add(normalized.toLocaleLowerCase())
    ids.push(normalized)
  }

  for (const match of question.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g)) {
    add(match[0])
  }
  for (const match of question.matchAll(/(?:需求编号|编号|\bID\b)\s*(?:为|是|[:：#])?\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:\s*[、,，;；]\s*[A-Za-z0-9][A-Za-z0-9._-]*)*)/gi)) {
    match[1].split(/[、,，;；]/).forEach(add)
  }
  return ids.slice(0, REQUIREMENT_ANALYSIS_MAX_IDS)
}

const parseReviewJson = (content: string): Record<string, unknown> => {
  const cleaned = content
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('需求匹配复核结果不是有效 JSON')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('需求匹配复核结果格式无效')
  }
  return parsed as Record<string, unknown>
}

export class RequirementAnalysisAgent {
  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge: KnowledgeService,
    private readonly settings: ModelSettings,
    private readonly onProgress?: (event: AgentStatusEvent) => void
  ) {}

  async ask(request: ChatRequest): Promise<ChatResponse> {
    this.progress('route', '正在识别需求编号并准备分析')
    const requestedItemIds = extractRequirementAnalysisIds(request.question)
    if (!requestedItemIds.length) {
      return {
        answer: '请提供一个或多个数据中心需求编号，例如：`@需求分析专家 分析需求编号 VISSLM-TSIS-3959、VISSLM-TSIS-4100`。',
        sources: [],
        dataViews: []
      }
    }

    const entries: RequirementAnalysisEntry[] = []
    for (let index = 0; index < requestedItemIds.length; index += 1) {
      const requestedItemId = requestedItemIds[index]
      this.progress('locate', `正在定位第 ${index + 1}/${requestedItemIds.length} 条需求：${requestedItemId}`)
      const baseRecord = this.db.findRecordByItemId(requestedItemId) ??
        this.db.findRecordByItemId(requestedItemId.toLocaleUpperCase())
      if (!baseRecord) {
        entries.push({ requestedItemId, matches: [], error: '数据中心不存在该需求编号' })
        continue
      }
      const detail = this.db.getRecord(baseRecord.uid, false)
      if (!detail) {
        entries.push({ requestedItemId, matches: [], error: '对应记录详情无法读取' })
        continue
      }
      const base = profileOf(detail)
      if (!base.matchingText.trim()) {
        entries.push({ requestedItemId, base, matches: [], error: '对应记录没有可用于匹配的需求内容' })
        continue
      }

      try {
        this.progress('match', `正在将 ${base.record.itemId} 与数据中心全部记录进行相似度匹配`)
        const vectorMatches = await this.knowledge.rankRecordMatches(base.matchingText)
        const excludedUids = new Set(
          requestedItemIds
            .map((itemId) => this.db.findRecordByItemId(itemId) ?? this.db.findRecordByItemId(itemId.toLocaleUpperCase()))
            .filter(Boolean)
            .map((record) => record!.uid)
        )
        const candidates = vectorMatches
          .filter((match) => !excludedUids.has(match.recordUid))
          .filter((match) => Number.isFinite(match.score) && match.score >= REQUIREMENT_MATCH_MIN_SCORE)
          .slice(0, REQUIREMENT_MATCH_CANDIDATE_LIMIT)
          .map((match): RequirementMatchCandidate | null => {
            const record = this.db.getRecord(match.recordUid, false)
            return record ? { match, profile: profileOf(record) } : null
          })
          .filter((candidate): candidate is RequirementMatchCandidate => Boolean(candidate))

        this.progress('verify', `正在核对 ${base.record.itemId} 的候选记录字段`)
        let review: RequirementReview = { summary: '', matches: [] }
        if (candidates.length) {
          this.progress('reason', `正在复核 ${base.record.itemId} 的 ${candidates.length} 条候选记录`)
          review = await this.reviewMatches(request.question, base, candidates)
        }
        const reviewByUid = new Map(review.matches.map((item) => [item.recordUid, item]))
        const matches = candidates
          .map((candidate) => {
            const reviewed = reviewByUid.get(candidate.match.recordUid)
            const finalScore = reviewed ? clampScore(reviewed.score) : clampScore(candidate.match.score)
            return {
              ...candidate,
              match: {
                ...candidate.match,
                score: finalScore,
                snippet: candidate.match.snippet
              },
              ...(reviewed ? { reviewReason: reviewed.reason, scoreSource: 'ai' as const } : { scoreSource: 'vector' as const })
            }
          })
          .filter((candidate) => candidate.match.score >= REQUIREMENT_MATCH_MIN_SCORE)
          .sort((left, right) => right.match.score - left.match.score || left.profile.record.uid.localeCompare(right.profile.record.uid))
          .slice(0, REQUIREMENT_MATCH_RESULT_LIMIT)
          .map((candidate) => candidate as RequirementMatchCandidate & { reviewReason?: string; scoreSource: 'ai' | 'vector' })
        entries.push({ requestedItemId, base, matches, reviewSummary: review.summary })
      } catch (error) {
        entries.push({
          requestedItemId,
          base,
          matches: [],
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return this.buildResponse(entries, requestedItemIds)
  }

  private async reviewMatches(
    question: string,
    base: RequirementRecordProfile,
    candidates: RequirementMatchCandidate[]
  ): Promise<RequirementReview> {
    try {
      const response = await new ModelClient(this.settings).chat({
        messages: [
          {
            role: 'system',
            content: [
              '你是技术需求与数据资产语义匹配评审器。请综合需求分类、业务模块、标题和完整需求描述理解真实意图，再评审候选记录。',
              '补充信息词只是帮助理解行业术语、缩写和重点概念，不是硬约束；不能因为候选没有逐字命中就直接判为不匹配。',
              '逐条比较业务目标、作用对象、触发条件、输入输出、功能行为和约束；只允许使用输入中的真实证据，不得虚构字段或业务背景。',
              '为每个候选记录给出 0 到 100 的匹配分数和简短理由。字面词相同但目标不同应降低分数，能力和约束整体一致可以提高分数。',
              '只输出 JSON：{"summary":"","matches":[{"recordUid":"","score":0,"reason":""}]}，不要输出思维过程。'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify({
              question,
              requirement: {
                itemId: base.record.itemId,
                category: base.category,
                module: base.module,
                title: base.record.name,
                content: base.description || base.record.normalizedText,
                keyInfoTerms: base.terms
              },
              candidates: candidates.map(({ match, profile }) => ({
                recordUid: profile.record.uid,
                itemId: profile.record.itemId,
                name: profile.record.name,
                category: profile.category,
                module: profile.module,
                description: profile.description || profile.record.normalizedText,
                semanticRecallScore: Number(match.score.toFixed(2))
              }))
            })
          }
        ],
        format: requirementReviewFormat,
        think: false,
        temperature: 0.1,
        numPredict: 2048
      })
      const parsed = parseReviewJson(response.message?.content ?? '')
      const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
      const expectedUids = new Set(candidates.map(({ profile }) => profile.record.uid))
      const matches = Array.isArray(parsed.matches)
        ? parsed.matches.flatMap((item): RequirementReview['matches'] => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return []
            const value = item as Record<string, unknown>
            const recordUid = typeof value.recordUid === 'string' ? value.recordUid.trim() : ''
            const score = Number(value.score)
            const reason = typeof value.reason === 'string' ? value.reason.trim() : ''
            if (!expectedUids.has(recordUid) || !Number.isFinite(score)) return []
            return [{ recordUid, score: clampScore(score), reason }]
          })
        : []
      return { summary, matches }
    } catch (error) {
      this.progress('verify', 'AI 复核暂不可用，当前使用向量匹配度返回结果')
      return {
        summary: 'AI 复核不可用，当前匹配度使用本地向量召回分。',
        matches: []
      }
    }
  }

  private buildResponse(entries: RequirementAnalysisEntry[], requestedItemIds: string[]): ChatResponse {
    const matchedEntries = entries.filter((entry) => entry.base && entry.matches.length)
    const rows = matchedEntries.flatMap((entry) => entry.matches.map((candidate) => {
      const enriched = candidate as RequirementMatchCandidate & { reviewReason?: string; scoreSource: 'ai' | 'vector' }
      const values: ChatDataRow['values'] = {
        description: candidate.profile.description || '—',
        module: candidate.profile.module || '—',
        matchScore: `${candidate.match.score.toFixed(1)}%`,
        scoreSource: enriched.scoreSource === 'ai' ? 'AI 复核' : '向量召回',
        matchReason: enriched.reviewReason || '未返回 AI 复核说明'
      }
      return {
        uid: candidate.profile.record.uid,
        name: candidate.profile.record.name,
        nodeType: candidate.profile.record.nodeType,
        itemId: candidate.profile.record.itemId,
        values
      }
    }))
    const groups: ChatDataView['groups'] = matchedEntries.map((entry) => ({
      name: `${entry.base!.record.itemId} · ${entry.base!.record.name}`,
      count: entry.matches.length,
      rows: entry.matches.map((candidate) => {
        const enriched = candidate as RequirementMatchCandidate & { reviewReason?: string; scoreSource: 'ai' | 'vector' }
        return {
          uid: candidate.profile.record.uid,
          name: candidate.profile.record.name,
          nodeType: candidate.profile.record.nodeType,
          itemId: candidate.profile.record.itemId,
          values: {
            description: candidate.profile.description || '—',
            module: candidate.profile.module || '—',
            matchScore: `${candidate.match.score.toFixed(1)}%`,
            scoreSource: enriched.scoreSource === 'ai' ? 'AI 复核' : '向量召回',
            matchReason: enriched.reviewReason || '未返回 AI 复核说明'
          }
        }
      })
    }))
    const dataViews: ChatDataView[] = rows.length ? [{
      id: `requirement-analysis:${requestedItemIds.join(',')}`,
      title: '需求分析匹配结果',
      description: '已按项目管理需求匹配口径扫描全部数据中心记录；表格展示达到 40% 阈值的最高匹配结果。',
      total: rows.length,
      fields: ['description', 'module', 'matchScore', 'scoreSource', 'matchReason'],
      fieldLabels: {
        description: '描述',
        module: '模块',
        matchScore: '匹配度',
        scoreSource: '分数来源',
        matchReason: '匹配说明'
      },
      groups
    }] : []

    const answerSections = entries.map((entry) => {
      if (!entry.base) {
        return `#### ${entry.requestedItemId}\n\n- **结果**：${entry.error ?? '未找到数据中心记录'}。`
      }
      const base = entry.base
      const header = [
        `#### ${base.record.itemId} · ${base.record.name}`,
        `- **描述**：${truncate(base.description || '暂无描述', 320)}`,
        `- **模块**：${base.module || '未标注'}`
      ]
      if (entry.error) {
        return [...header, `- **匹配结果**：${entry.error}。`].join('\n')
      }
      if (!entry.matches.length) {
        return [...header, `- **匹配结果**：没有达到 ${REQUIREMENT_MATCH_MIN_SCORE}% 阈值的其他数据。`].join('\n')
      }
      const resultLines = entry.matches.slice(0, REQUIREMENT_ANSWER_RESULT_LIMIT).flatMap((candidate, index) => {
        const enriched = candidate as RequirementMatchCandidate & { reviewReason?: string; scoreSource: 'ai' | 'vector' }
        return [
          `${index + 1}. **${candidate.profile.record.itemId} · ${candidate.profile.record.name}** · 匹配度 **${candidate.match.score.toFixed(1)}%**`,
          `   - 描述：${truncate(candidate.profile.description || '暂无描述', 240)}`,
          `   - 模块：${candidate.profile.module || '未标注'} · ${enriched.scoreSource === 'ai' ? 'AI 复核' : '向量召回'}`
        ]
      })
      if (entry.matches.length > REQUIREMENT_ANSWER_RESULT_LIMIT) {
        resultLines.push(`   - 其余 ${entry.matches.length - REQUIREMENT_ANSWER_RESULT_LIMIT} 条结果可在“查看查询数据”中展开。`)
      }
      return [...header, `- **匹配结果**：共 ${entry.matches.length} 条。`, '', ...resultLines].join('\n')
    })
    const foundCount = entries.filter((entry) => entry.base).length
    const summary = `需求分析完成：已处理 ${foundCount}/${requestedItemIds.length} 个编号，匹配口径为“完整需求文本向量召回 + AI 字段语义复核”，其他记录类型不会被预先排除。`
    return {
      answer: [summary, ...answerSections, dataViews.length ? '匹配结果已整理为结构化表格，可展开查看完整描述、模块和匹配说明。' : ''].filter(Boolean).join('\n\n'),
      sources: this.sourcesOf(matchedEntries),
      dataViews
    }
  }

  private sourcesOf(entries: RequirementAnalysisEntry[]): ChatSource[] {
    return entries.flatMap((entry) => entry.matches.map((candidate) => ({
      uid: candidate.profile.record.uid,
      name: candidate.profile.record.name,
      nodeType: candidate.profile.record.nodeType,
      itemId: candidate.profile.record.itemId,
      sourceType: 'record' as const,
      snippet: candidate.profile.description || candidate.match.snippet,
      score: candidate.match.score
    })))
  }

  private progress(stage: string, message: string): void {
    this.onProgress?.({ type: 'status', stage, message })
  }
}
