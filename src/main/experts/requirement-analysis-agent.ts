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
import { KnowledgeService } from '../knowledge'
import { ModelClient, type ModelChatInput, type ModelResponse } from '../model-client'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate
} from '../requirements/hybrid-retrieval'
import {
  createRequirementReranker,
  type RequirementReranker,
  type RequirementRerankItem
} from '../requirements/cross-encoder-reranker'
import {
  buildRequirementSemanticCard,
  semanticTextSimilarity,
  type RequirementSemanticCard
} from '../requirements/semantic-card'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

export type RequirementMatchRelation =
  | 'duplicate'
  | 'highly_similar'
  | 'partial_overlap'
  | 'same_pattern'
  | 'topic_only'
  | 'unrelated'

const RELATIONS: RequirementMatchRelation[] = [
  'duplicate', 'highly_similar', 'partial_overlap', 'same_pattern', 'topic_only', 'unrelated'
]
const FORMAL_RELATIONS = new Set<RequirementMatchRelation>(['duplicate', 'highly_similar'])
const REFERENCE_RELATIONS = new Set<RequirementMatchRelation>(['partial_overlap', 'same_pattern'])
const REQUIREMENT_ANALYSIS_MAX_IDS = 20
const HYBRID_CANDIDATE_LIMIT = 50
const AI_CANDIDATE_LIMIT = 20
const AI_REVIEW_BATCH_SIZE = 5
const ANSWER_RESULT_LIMIT = 8

const requirementReviewFormat = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      maxItems: AI_CANDIDATE_LIMIT,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'recordUid', 'relation', 'score', 'sharedEvidence', 'difference',
          'baseEvidence', 'candidateEvidence'
        ],
        properties: {
          recordUid: { type: 'string' },
          relation: { type: 'string', enum: RELATIONS },
          score: { type: 'number', minimum: 0, maximum: 100 },
          sharedEvidence: { type: 'string' },
          difference: { type: 'string' },
          baseEvidence: { type: 'string' },
          candidateEvidence: { type: 'string' }
        }
      }
    }
  }
}

export interface RequirementReviewItem {
  recordUid: string
  relation: RequirementMatchRelation
  score: number
  sharedEvidence: string
  difference: string
  baseEvidence: string
  candidateEvidence: string
}

interface RequirementReview {
  summary: string
  items: RequirementReviewItem[]
}

interface RequirementProfile {
  record: RecordDetail
  card: RequirementSemanticCard
}

interface ReviewedCandidate extends HybridRequirementCandidate {
  rerankerScore: number
  review: RequirementReviewItem
  reviewStatus: 'independently_verified' | 'conservatively_reconciled'
}

interface RequirementAnalysisEntry {
  requestedItemId: string
  base?: RequirementProfile
  formal: ReviewedCandidate[]
  references: ReviewedCandidate[]
  reviewSummary?: string
  error?: string
}

interface ReviewModelClient {
  chat(input: ModelChatInput): Promise<ModelResponse>
}

interface RequirementAnalysisAgentOptions {
  reranker?: RequirementReranker
  retriever?: Pick<HybridRequirementRetriever, 'retrieve'>
  modelClient?: ReviewModelClient
}

const clampScore = (value: number): number => Number(Math.max(0, Math.min(100, value)).toFixed(1))

const truncate = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

const normalizeEvidence = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const evidenceSupported = (quote: string, source: string): boolean => {
  const normalizedQuote = normalizeEvidence(quote)
  const normalizedSource = normalizeEvidence(source)
  return normalizedQuote.length >= 2 && normalizedSource.includes(normalizedQuote)
}

const scoreFitsRelation = (relation: RequirementMatchRelation, score: number): boolean => {
  if (relation === 'duplicate') return score >= 85
  if (relation === 'highly_similar') return score >= 70 && score < 95
  if (relation === 'partial_overlap') return score >= 40 && score < 70
  if (relation === 'same_pattern') return score >= 25 && score < 60
  if (relation === 'topic_only') return score >= 10 && score < 40
  return score < 25
}

const relationRank = (relation: RequirementMatchRelation): number => ({
  unrelated: 0,
  topic_only: 1,
  same_pattern: 2,
  partial_overlap: 3,
  highly_similar: 4,
  duplicate: 5
})[relation]

const downgrade = (
  item: RequirementReviewItem,
  relation: RequirementMatchRelation,
  maximumScore: number,
  reason: string
): RequirementReviewItem => ({
  ...item,
  ...(relationRank(item.relation) > relationRank(relation)
    ? { relation, score: clampScore(Math.min(item.score, maximumScore)) }
    : {}),
  difference: `${item.difference}；规则校验：${reason}`
})

const reconcileIndependentReviews = (
  draft: RequirementReviewItem,
  verification: RequirementReviewItem
): { review: RequirementReviewItem; status: ReviewedCandidate['reviewStatus'] } => {
  const agreed = draft.relation === verification.relation
  const conservative = relationRank(draft.relation) <= relationRank(verification.relation) ? draft : verification
  const score = clampScore(Math.min(draft.score, verification.score))
  if (!scoreFitsRelation(conservative.relation, score)) {
    throw new Error(`UID ${draft.recordUid} 的两次独立判定无法保守合并`)
  }
  return {
    review: {
      ...conservative,
      score,
      sharedEvidence: agreed
        ? conservative.sharedEvidence
        : `${conservative.sharedEvidence}（两次独立判定：${draft.relation} / ${verification.relation}，按较低置信关系输出）`,
      difference: agreed
        ? conservative.difference
        : `${conservative.difference}；独立复核分歧已保守降级`
    },
    status: agreed ? 'independently_verified' : 'conservatively_reconciled'
  }
}

export const enforceRequirementRelationshipRules = (
  base: RequirementSemanticCard,
  candidate: RequirementSemanticCard,
  item: RequirementReviewItem
): RequirementReviewItem => {
  const objectSimilarity = semanticTextSimilarity(base.functionalObject, candidate.functionalObject)
  const knownActions = base.action !== 'unknown' && candidate.action !== 'unknown'
  if ((base.action === 'rename_label') !== (candidate.action === 'rename_label')) {
    return downgrade(item, 'topic_only', 39, '文案修改不等于权限配置、功能新增或其他业务动作')
  }
  if (knownActions && base.action !== candidate.action) {
    if (objectSimilarity >= 0.55) {
      return downgrade(item, 'partial_overlap', 69, '功能对象相近但目标动作不同，不得判为高度相似')
    }
    return downgrade(item, 'topic_only', 39, '需求动作和功能对象均不一致，仅保留主题关联')
  }
  if (knownActions && base.action === candidate.action && objectSimilarity < 0.5) {
    return downgrade(item, 'same_pattern', 59, '需求动作相同但功能对象不同，只能判为同类模式')
  }
  if (base.requirementType && candidate.requirementType &&
      base.requirementType.toLocaleLowerCase() !== candidate.requirementType.toLocaleLowerCase() &&
      (base.action === 'add_capability' || candidate.action === 'fix_defect' ||
       base.action === 'fix_defect' || candidate.action === 'add_capability')) {
    return downgrade(item, 'topic_only', 39, '功能新增不等于缺陷修复')
  }
  return { ...item, score: clampScore(item.score) }
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
  for (const match of question.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g)) add(match[0])
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需求匹配复核结果格式无效')
  return parsed as Record<string, unknown>
}

const validateRerankerOutput = (
  output: RequirementRerankItem[],
  candidates: HybridRequirementCandidate[]
): RequirementRerankItem[] => {
  const expected = new Set(candidates.map((candidate) => candidate.record.uid))
  const seen = new Set<string>()
  for (const item of output) {
    if (!expected.has(item.recordUid)) throw new Error(`Cross-Encoder 返回未知 UID：${item.recordUid}`)
    if (seen.has(item.recordUid)) throw new Error(`Cross-Encoder 返回重复 UID：${item.recordUid}`)
    if (!Number.isFinite(item.score) || item.score < 0 || item.score > 100) {
      throw new Error(`Cross-Encoder 返回无效分数：${item.recordUid}`)
    }
    seen.add(item.recordUid)
  }
  if (seen.size !== expected.size) throw new Error('Cross-Encoder 未覆盖全部候选 UID')
  return [...output].sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
}

export class RequirementAnalysisAgent {
  private readonly retriever: Pick<HybridRequirementRetriever, 'retrieve'>
  private readonly reranker: RequirementReranker
  private readonly modelClient: ReviewModelClient

  constructor(
    private readonly db: AppDatabase,
    knowledge: KnowledgeService,
    settings: ModelSettings,
    private readonly onProgress?: (event: AgentStatusEvent) => void,
    options: RequirementAnalysisAgentOptions = {}
  ) {
    this.retriever = options.retriever ?? new HybridRequirementRetriever(db, knowledge)
    this.reranker = options.reranker ?? createRequirementReranker()
    this.modelClient = options.modelClient ?? new ModelClient(settings)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    this.progress('route', '正在识别需求编号并准备精准匹配')
    const requestedItemIds = extractRequirementAnalysisIds(request.question)
    if (!requestedItemIds.length) {
      return {
        answer: '请提供一个或多个数据中心需求编号，例如：`@需求分析专家 分析需求编号 VISSLM-TSIS-3959、VISSLM-TSIS-4100`。',
        sources: [],
        dataViews: []
      }
    }
    const excludedUids = new Set(requestedItemIds.flatMap((itemId) => {
      const row = this.db.findRecordByItemId(itemId) ?? this.db.findRecordByItemId(itemId.toLocaleUpperCase())
      return row ? [row.uid] : []
    }))
    const entries: RequirementAnalysisEntry[] = []
    for (let index = 0; index < requestedItemIds.length; index += 1) {
      const requestedItemId = requestedItemIds[index]
      this.progress('locate', `正在定位第 ${index + 1}/${requestedItemIds.length} 条需求：${requestedItemId}`)
      const row = this.db.findRecordByItemId(requestedItemId) ?? this.db.findRecordByItemId(requestedItemId.toLocaleUpperCase())
      if (!row) {
        entries.push({ requestedItemId, formal: [], references: [], error: '数据中心不存在该需求编号' })
        continue
      }
      const record = this.db.getRecord(row.uid, false)
      if (!record) {
        entries.push({ requestedItemId, formal: [], references: [], error: '对应记录详情无法读取' })
        continue
      }
      const base = { record, card: buildRequirementSemanticCard(record) }
      if (!base.card.behavior.trim()) {
        entries.push({ requestedItemId, base, formal: [], references: [], error: '对应记录没有可用于匹配的需求内容' })
        continue
      }
      try {
        this.progress('match', `正在对 ${record.itemId} 执行 Dense、BM25 和结构化字段混合召回`)
        const candidates = (await this.retriever.retrieve(base.card, excludedUids)).slice(0, HYBRID_CANDIDATE_LIMIT)
        if (!candidates.length) {
          entries.push({ requestedItemId, base, formal: [], references: [], reviewSummary: '混合召回未发现候选记录。' })
          continue
        }
        this.progress('rerank', `本地 Cross-Encoder 正在重排 ${candidates.length} 条候选记录`)
        const reranked = validateRerankerOutput(await this.reranker.rerank(base.card, candidates), candidates)
        const rerankerByUid = new Map(reranked.map((item) => [item.recordUid, item.score]))
        const topCandidates = reranked.slice(0, AI_CANDIDATE_LIMIT).flatMap((item) => {
          const candidate = candidates.find((value) => value.record.uid === item.recordUid)
          return candidate ? [{ ...candidate, rerankerScore: item.score }] : []
        })
        this.progress('reason', `AI 正在逐条判定 ${topCandidates.length} 条候选的业务关系`)
        const draft = await this.reviewCandidateBatches(request.question, base, topCandidates, 'initial')
        this.progress('critique', '独立复核正在检查关系、证据和关键词高估风险')
        const verified = await this.reviewCandidateBatches(request.question, base, topCandidates, 'independent')
        const draftByUid = new Map(draft.items.map((item) => [item.recordUid, item]))
        const reviewByUid = new Map(verified.items.map((item) => [item.recordUid, item]))
        const reviewed: ReviewedCandidate[] = topCandidates.map((candidate): ReviewedCandidate => {
          const reconciled = reconcileIndependentReviews(
            draftByUid.get(candidate.record.uid)!,
            reviewByUid.get(candidate.record.uid)!
          )
          return {
            ...candidate,
            rerankerScore: rerankerByUid.get(candidate.record.uid) ?? candidate.rerankerScore,
            review: enforceRequirementRelationshipRules(base.card, candidate.card, reconciled.review),
            reviewStatus: reconciled.status
          }
        }).sort((left, right) => right.review.score - left.review.score || right.rerankerScore - left.rerankerScore)
        entries.push({
          requestedItemId,
          base,
          formal: reviewed.filter((item) => FORMAL_RELATIONS.has(item.review.relation)),
          references: reviewed.filter((item) => REFERENCE_RELATIONS.has(item.review.relation)),
          reviewSummary: verified.summary
        })
      } catch (error) {
        entries.push({
          requestedItemId,
          base,
          formal: [],
          references: [],
          error: `精准匹配失败关闭：${error instanceof Error ? error.message : String(error)}`
        })
      }
    }
    return this.buildResponse(entries, requestedItemIds)
  }

  private async reviewCandidateBatches(
    question: string,
    base: RequirementProfile,
    candidates: Array<HybridRequirementCandidate & { rerankerScore: number }>,
    pass: 'initial' | 'independent'
  ): Promise<RequirementReview> {
    const reviews: RequirementReviewItem[] = []
    const summaries: string[] = []
    for (let offset = 0; offset < candidates.length; offset += AI_REVIEW_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + AI_REVIEW_BATCH_SIZE)
      const review = await this.reviewMatches(question, base, batch, pass)
      reviews.push(...review.items)
      summaries.push(review.summary)
    }
    const seen = new Set(reviews.map((item) => item.recordUid))
    if (reviews.length !== candidates.length || seen.size !== candidates.length) {
      throw new Error(`${pass === 'initial' ? '业务关系初审' : '独立复核'}未完整覆盖全部候选 UID`)
    }
    return { summary: summaries.join('；'), items: reviews }
  }

  private async reviewMatches(
    question: string,
    base: RequirementProfile,
    candidates: Array<HybridRequirementCandidate & { rerankerScore: number }>,
    pass: 'initial' | 'independent'
  ): Promise<RequirementReview> {
    const evidence = {
      question,
      requirement: this.reviewProfile(base.record, base.card),
      candidates: candidates.map((candidate) => ({
        ...this.reviewProfile(candidate.record, candidate.card),
        denseRecallScore: Number(candidate.denseScore.toFixed(2)),
        crossEncoderScore: Number(candidate.rerankerScore.toFixed(2))
      }))
    }
    let lastError: unknown
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await this.modelClient.chat({
          messages: [
            {
              role: 'system',
              content: (pass === 'independent' ? [
                '你是需求相似性结论的独立复核器。请只依据本次提供的原始字段和语义卡重新判定，不参考或猜测任何初审答案。',
                '重点检查是否因关键词或业务主题相同而高估，是否遗漏业务目标、功能对象和目标动作差异。'
              ] : [
                '你是需求相似性深度分析器。请逐条比较真实业务目标、功能对象、需求动作、触发条件、输入输出、当前与目标状态、功能行为、约束和验收结果。'
              ]).concat([
                '关系只能是 duplicate、highly_similar、partial_overlap、same_pattern、topic_only、unrelated。',
                '文案修改不等于权限配置或功能新增；功能新增不等于缺陷修复；相同模块不等于相同需求；动作相同但对象不同只能是 same_pattern。',
                '召回分和 Cross-Encoder 分只提供候选顺序，不能作为最终关系依据。',
                '每个候选必须且只能输出一次。baseEvidence 和 candidateEvidence 必须逐字复制各自 evidence 中的短句，不得改写或虚构。',
                '分数区间：duplicate 85-100；highly_similar 70-94；partial_overlap 40-69；same_pattern 25-59；topic_only 10-39；unrelated 0-24。',
                '只输出符合 schema 的 JSON，不输出思维过程。'
              ]).join('\n')
            },
            {
              role: 'user',
              content: JSON.stringify({ ...evidence, reviewPass: pass, validationAttempt: attempt })
            }
          ],
          format: requirementReviewFormat,
          think: true,
          temperature: 0,
          numPredict: 3200
        })
        return this.parseReview(response.message?.content ?? '', base.card, candidates)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`${pass === 'independent' ? '独立复核' : '业务关系初审'}连续两次未通过结构化校验：${lastError instanceof Error ? lastError.message : String(lastError ?? '')}`)
  }

  private reviewProfile(record: RecordDetail, card: RequirementSemanticCard): Record<string, unknown> {
    return {
      recordUid: record.uid,
      itemId: record.itemId,
      recordType: record.nodeType,
      name: record.name,
      requirementType: card.requirementType,
      productDomain: card.productDomain,
      module: card.module,
      functionalObject: card.functionalObject,
      action: card.action,
      currentState: card.currentState,
      targetState: card.targetState,
      trigger: card.trigger,
      input: card.input,
      output: card.output,
      behavior: card.behavior,
      constraints: card.constraints,
      acceptance: card.acceptance,
      businessScene: card.businessScene,
      evidence: card.evidence
    }
  }

  private parseReview(
    content: string,
    base: RequirementSemanticCard,
    candidates: Array<HybridRequirementCandidate & { rerankerScore: number }>
  ): RequirementReview {
    const parsed = parseReviewJson(content)
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    if (!summary) throw new Error('复核结果缺少总结')
    if (!Array.isArray(parsed.items)) throw new Error('复核结果缺少候选明细')
    const expected = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))
    const seen = new Set<string>()
    const items = parsed.items.map((raw): RequirementReviewItem => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('候选复核格式无效')
      const value = raw as Record<string, unknown>
      const recordUid = typeof value.recordUid === 'string' ? value.recordUid.trim() : ''
      const relation = String(value.relation) as RequirementMatchRelation
      const score = Number(value.score)
      const sharedEvidence = typeof value.sharedEvidence === 'string' ? value.sharedEvidence.trim() : ''
      const difference = typeof value.difference === 'string' ? value.difference.trim() : ''
      const baseEvidence = typeof value.baseEvidence === 'string' ? value.baseEvidence.trim() : ''
      const candidateEvidence = typeof value.candidateEvidence === 'string' ? value.candidateEvidence.trim() : ''
      const candidate = expected.get(recordUid)
      if (!candidate) throw new Error(`复核结果包含未知 UID：${recordUid || '空'}`)
      if (seen.has(recordUid)) throw new Error(`复核结果包含重复 UID：${recordUid}`)
      if (!RELATIONS.includes(relation)) throw new Error(`UID ${recordUid} 的关系无效`)
      if (!Number.isFinite(score) || !scoreFitsRelation(relation, score)) throw new Error(`UID ${recordUid} 的关系与分数不一致`)
      if (!sharedEvidence || !difference) throw new Error(`UID ${recordUid} 缺少相同点或主要差异`)
      if (!evidenceSupported(baseEvidence, base.evidence)) throw new Error(`UID ${recordUid} 的基准证据不受原文支持`)
      if (!evidenceSupported(candidateEvidence, candidate.card.evidence)) throw new Error(`UID ${recordUid} 的候选证据不受原文支持`)
      seen.add(recordUid)
      return {
        recordUid,
        relation,
        score: clampScore(score),
        sharedEvidence,
        difference,
        baseEvidence,
        candidateEvidence
      }
    })
    if (items.length !== expected.size || seen.size !== expected.size) throw new Error('复核结果未完整覆盖全部候选 UID')
    return { summary, items }
  }

  private buildResponse(entries: RequirementAnalysisEntry[], requestedItemIds: string[]): ChatResponse {
    const visibleEntries = entries.filter((entry) => entry.base && (entry.formal.length || entry.references.length))
    const groups: ChatDataView['groups'] = visibleEntries.flatMap((entry) => {
      const makeGroup = (name: string, candidates: ReviewedCandidate[]): ChatDataView['groups'][number] => ({
        name: `${entry.base!.record.itemId} · ${name}`,
        count: candidates.length,
        rows: candidates.map((candidate) => this.dataRow(candidate))
      })
      return [
        ...(entry.formal.length ? [makeGroup('正式匹配', entry.formal)] : []),
        ...(entry.references.length ? [makeGroup('参考关联需求', entry.references)] : [])
      ]
    })
    const total = groups.reduce((sum, group) => sum + group.count, 0)
    const dataViews: ChatDataView[] = total ? [{
      id: `requirement-analysis:${requestedItemIds.join(',')}`,
      title: '需求分析精准匹配结果',
      description: '候选经过混合召回、本地 Cross-Encoder、AI 业务关系初审、独立复核和程序校验。综合匹配度尚未进行概率校准。',
      total,
      fields: [
        'description', 'module', 'requirementType', 'relation', 'matchScore', 'sharedEvidence',
        'difference', 'evidence', 'denseScore', 'rerankerScore', 'reviewStatus'
      ],
      fieldLabels: {
        description: '描述', module: '模块', requirementType: '需求类型', relation: '匹配关系',
        matchScore: '综合匹配度', sharedEvidence: '相同点', difference: '主要差异', evidence: '原文证据',
        denseScore: '向量召回分', rerankerScore: 'Cross-Encoder 重排分', reviewStatus: 'AI 复核状态'
      },
      groups
    }] : []
    const sections = entries.map((entry) => this.answerSection(entry))
    const foundCount = entries.filter((entry) => entry.base).length
    return {
      answer: [
        `需求分析完成：已处理 ${foundCount}/${requestedItemIds.length} 个编号。匹配流程为“需求清洗与语义卡片 + Dense/BM25/结构化字段混合召回 + Cross-Encoder 重排 + AI 初审与独立复核”。`,
        ...sections,
        dataViews.length ? '结果已整理为结构化表格；“综合匹配度”是尚未校准的业务判断分，不代表统计概率。' : ''
      ].filter(Boolean).join('\n\n'),
      sources: visibleEntries.flatMap((entry) => [...entry.formal, ...entry.references]).map((candidate): ChatSource => ({
        uid: candidate.record.uid,
        name: candidate.record.name,
        nodeType: candidate.record.nodeType,
        itemId: candidate.record.itemId,
        sourceType: 'record',
        snippet: candidate.card.evidence || candidate.snippet,
        score: candidate.review.score
      })),
      dataViews
    }
  }

  private dataRow(candidate: ReviewedCandidate): ChatDataRow {
    return {
      uid: candidate.record.uid,
      name: candidate.record.name,
      nodeType: candidate.record.nodeType,
      itemId: candidate.record.itemId,
      values: {
        description: candidate.card.behavior || '—',
        module: candidate.card.module || '—',
        requirementType: candidate.card.requirementType || '—',
        relation: candidate.review.relation,
        matchScore: `${candidate.review.score.toFixed(1)}%`,
        sharedEvidence: candidate.review.sharedEvidence,
        difference: candidate.review.difference,
        evidence: `基准：${candidate.review.baseEvidence}；候选：${candidate.review.candidateEvidence}`,
        denseScore: `${candidate.denseScore.toFixed(1)}%`,
        rerankerScore: `${candidate.rerankerScore.toFixed(1)}%`,
        reviewStatus: candidate.reviewStatus === 'independently_verified' ? '两次独立判定一致' : '两次独立判定分歧，已保守降级'
      }
    }
  }

  private answerSection(entry: RequirementAnalysisEntry): string {
    if (!entry.base) return `#### ${entry.requestedItemId}\n\n- **结果**：${entry.error ?? '未找到数据中心记录'}。`
    const { record, card } = entry.base
    const header = [
      `#### ${record.itemId} · ${record.name}`,
      `- **描述**：${truncate(card.behavior || '暂无描述', 320)}`,
      `- **模块**：${card.module || '未标注'}`,
      `- **需求类型**：${card.requirementType || '未标注'}`
    ]
    if (entry.error) return [...header, `- **匹配结果**：${entry.error}。未输出未经验证的候选结论。`].join('\n')
    const formal = entry.formal.slice(0, ANSWER_RESULT_LIMIT).flatMap((candidate, index) => [
      `${index + 1}. **${candidate.record.itemId} · ${candidate.record.name}** · ${candidate.review.relation} · 综合匹配度 **${candidate.review.score.toFixed(1)}%**`,
      `   - 相同点：${candidate.review.sharedEvidence}`,
      `   - 主要差异：${candidate.review.difference}`
    ])
    const references = entry.references.slice(0, ANSWER_RESULT_LIMIT).flatMap((candidate, index) => [
      `${index + 1}. **${candidate.record.itemId} · ${candidate.record.name}** · ${candidate.review.relation} · 综合匹配度 **${candidate.review.score.toFixed(1)}%**`,
      `   - 相同点：${candidate.review.sharedEvidence}`,
      `   - 主要差异：${candidate.review.difference}`
    ])
    const noFormal = !entry.formal.length
      ? '未发现业务目标一致的高度相似或重复需求。检索到的记录仅存在主题、模块或操作模式上的关联。'
      : `确认 ${entry.formal.length} 条高度相似或重复需求。`
    return [
      ...header,
      `- **匹配结论**：${noFormal}`,
      ...(formal.length ? ['', '**正式匹配**', ...formal] : []),
      ...(references.length ? ['', '**参考关联需求**', ...references] : [])
    ].join('\n')
  }

  private progress(stage: string, message: string): void {
    this.onProgress?.({ type: 'status', stage, message })
  }
}
