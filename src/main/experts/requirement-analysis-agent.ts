import { createHash } from 'node:crypto'
import type {
  ChatDataRow,
  ChatDataView,
  ChatRequest,
  ChatResponse,
  ChatSource,
  ModelSettings,
  RecordDetail
} from '../../shared/types'
import type { AgentEvent, AgentMatchProgress, AgentProgress } from '../../shared/expert-types'
import {
  AppDatabase,
  type RequirementMatchCache,
  type RequirementMatchCacheInput
} from '../database'
import { KnowledgeService } from '../knowledge'
import { ModelClient } from '../model-client'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate
} from '../requirements/hybrid-retrieval'
import {
  createRequirementReranker,
  REQUIREMENT_RERANKER_MODEL_VERSION,
  type RequirementRerankItem,
  type RequirementReranker
} from '../requirements/cross-encoder-reranker'
import {
  buildRequirementSourceView,
  removeRequirementNoise,
  toRequirementPlainText,
  type RequirementMatchCard
} from '../requirements/semantic-card'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../requirements/semanticization-service'
import {
  REQUIREMENT_MATCH_DIMENSIONS,
  REQUIREMENT_MATCH_RELATIONS,
  scoreFitsRequirementRelation,
  constrainRequirementMatchToRelation,
  downgradeRequirementMatchForUnavailableReview,
  isDeterministicRequirementMatch,
  REQUIREMENT_MATCH_DECISION_PATHS,
  scoreRequirementCandidate,
  type RequirementMatchDimension,
  type RequirementMatchRelation,
  type RequirementMatchScoreResult
} from '../requirements/requirement-match-scoring'
import {
  explainRequirementMatches,
  type RequirementMatchExplanation,
  type RequirementMatchExplanationModelClient
} from '../requirements/requirement-match-explainer'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

const MAX_REQUIREMENT_IDS = 20
export const MAX_DIRECT_REQUIREMENT_IDS = 200
const HYBRID_CANDIDATE_LIMIT = 50
const RERANK_CANDIDATE_LIMIT = 20
const EXPLANATION_CANDIDATE_LIMIT = 10
const ANSWER_RESULT_LIMIT = 8
const MATCH_STRATEGY_VERSION = 'requirement-match-v4-multipath-confidence'
const EXPLANATION_TIMEOUT_MS = 120_000
const EXPLANATION_MAX_CONTEXT = 32_768

const FORMAL_RELATIONS = new Set<RequirementMatchRelation>(['duplicate', 'highly_similar'])
const REFERENCE_RELATIONS = new Set<RequirementMatchRelation>([
  'partial_overlap', 'same_pattern', 'topic_only', 'unrelated'
])

interface RequirementAnalysisAgentOptions {
  reranker?: RequirementReranker
  retriever?: Pick<HybridRequirementRetriever, 'retrieve'>
  modelClient?: RequirementMatchExplanationModelClient
  semanticContext?: { analyzerVersion: string; modelSignature: string }
  embeddingModelVersion?: string
  matchModelSignature?: string
}

interface RequirementProfile {
  record: RecordDetail
  card: RequirementMatchCard
}

interface RankedCandidate extends HybridRequirementCandidate {
  rerankerScore: number
}

interface MatchExplanationState {
  sharedEvidence: string
  difference: string
  baseEvidence: string
  candidateEvidence: string
}

interface ExplanationMergeResult {
  matches: MatchedCandidate[]
  summary?: string
}

interface MatchedCandidate extends RankedCandidate {
  score: RequirementMatchScoreResult
  explanation: MatchExplanationState
  explanationStatus: 'live_verified' | 'cache_verified' | 'unavailable'
}

interface RequirementAnalysisEntry {
  requestedItemId: string
  base?: RequirementProfile
  formal: MatchedCandidate[]
  references: MatchedCandidate[]
  reviewSummary?: string
  reviewWarnings?: string[]
  error?: string
}

interface RequirementProgressState {
  totalRequirements: number
  currentRequirement: number
  completedRequirements: number
  stage: string
  stageCurrent: number
  stageTotal: number
  lastPercent: number
  match: AgentMatchProgress
}

const emptyMatchProgress = (): AgentMatchProgress => ({
  hasMatch: false,
  recallTotal: 0,
  rerankCurrent: 0,
  rerankTotal: 0,
  scoredCurrent: 0,
  scoredTotal: 0,
  explanationDone: 0,
  explanationTotal: 0,
  cacheHits: 0,
  isolated: 0
})

const hashText = (value: string): string => createHash('sha256').update(value).digest('hex')
const hashJson = (value: unknown): string => hashText(JSON.stringify(value))
const normalizeQuestion = (value: string): string => value.trim().replace(/\s+/gu, ' ')

/**
 * Cache identity is intentionally broader than matching evidence. It tracks
 * the source record as stored so normalized-text or raw-payload changes
 * invalidate an explanation even when the business embedding text is stable.
 */
const requirementRecordSourceHash = (record: RecordDetail): string => hashJson({
  version: 'requirement-record-source-v1',
  uid: record.uid,
  projectId: record.projectId,
  nodeType: record.nodeType,
  itemId: record.itemId,
  parentId: record.parentId,
  name: record.name,
  description: record.description,
  lastModifyTime: record.lastModifyTime,
  normalizedText: record.normalizedText ?? '',
  raw: record.raw
})

const requirementDisplayName = (record: RecordDetail, card?: RequirementMatchCard): string => (
  toRequirementPlainText(card?.sourceTitle || record.name) || '未命名需求'
)

const requirementDisplayDescription = (record: RecordDetail, card?: RequirementMatchCard): string => {
  const source = card?.sourceDescription || record.description
  const cleaned = removeRequirementNoise(toRequirementPlainText(source))
  if (cleaned) return cleaned
  return removeRequirementNoise(toRequirementPlainText(card?.behavior)) || '暂无描述'
}

const truncate = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

const evidenceExcerpt = (value: string, maxLength = 240): string => (
  value.trim().slice(0, Math.max(2, maxLength))
)

const normalizedEvidence = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const evidenceSupported = (quote: string, source: string): boolean => {
  const normalizedQuote = normalizedEvidence(quote)
  const normalizedSource = normalizedEvidence(source)
  return normalizedQuote.length >= 2 && normalizedSource.includes(normalizedQuote)
}

const clampNumber = (value: unknown, min: number, max: number): number | null => {
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : null
}

const safeRelation = (value: unknown): RequirementMatchRelation | null => (
  typeof value === 'string' && (REQUIREMENT_MATCH_RELATIONS as readonly string[]).includes(value)
    ? value as RequirementMatchRelation
    : null
)

const fallbackExplanation = (
  base: RequirementProfile,
  candidate: RankedCandidate
): MatchExplanationState => ({
  sharedEvidence: 'AI 说明暂不可用，已保留程序校验通过的确定性匹配结果。',
  difference: 'AI 说明暂不可用，请以两条需求的原文证据和匹配分明细为准。',
  // Keep fallback evidence as an exact source substring. An ellipsis is a
  // display marker, not evidence, and must never be persisted as one.
  baseEvidence: evidenceExcerpt(base.card.evidence),
  candidateEvidence: evidenceExcerpt(candidate.card.evidence)
})

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

const cacheResultOf = (
  score: RequirementMatchScoreResult,
  explanation: MatchExplanationState
): Record<string, unknown> => ({
  relation: score.relation,
  finalScore: score.finalScore,
  downgradeReasons: score.downgradeReasons,
  dimensions: score.dimensions,
  dimensionDetails: score.dimensionDetails,
  validDimensions: score.validDimensions,
  totalWeight: score.totalWeight,
  objectSimilarity: score.objectSimilarity,
  actionComparison: score.actionComparison,
  decisionPath: score.decisionPath,
  confidenceBasis: score.confidenceBasis,
  explanation: {
    sharedEvidence: explanation.sharedEvidence,
    difference: explanation.difference,
    baseEvidence: explanation.baseEvidence,
    candidateEvidence: explanation.candidateEvidence
  }
})

const safeCachedExplanation = (
  value: unknown,
  base: RequirementProfile,
  candidate: RankedCandidate
): MatchExplanationState | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const sharedEvidence = typeof item.sharedEvidence === 'string' ? item.sharedEvidence.trim() : ''
  const difference = typeof item.difference === 'string' ? item.difference.trim() : ''
  const baseEvidence = typeof item.baseEvidence === 'string' ? item.baseEvidence.trim() : ''
  const candidateEvidence = typeof item.candidateEvidence === 'string' ? item.candidateEvidence.trim() : ''
  if (!sharedEvidence || !difference || !baseEvidence || !candidateEvidence) return null
  if (!evidenceSupported(baseEvidence, base.card.evidence) ||
      !evidenceSupported(candidateEvidence, candidate.card.evidence)) return null
  return { sharedEvidence, difference, baseEvidence, candidateEvidence }
}

const parsedCachedResult = (
  cached: RequirementMatchCache,
  base: RequirementProfile,
  candidate: RankedCandidate
): { score: RequirementMatchScoreResult; explanation: MatchExplanationState } | null => {
  try {
    const parsed = JSON.parse(cached.resultJson) as Record<string, unknown>
    const relation = safeRelation(parsed.relation)
    const finalScore = clampNumber(parsed.finalScore, 0, 100)
    if (!relation || finalScore === null || !scoreFitsRequirementRelation(relation, finalScore)) return null
    const explanation = safeCachedExplanation(parsed.explanation, base, candidate)
    if (!explanation) return null
    if (!parsed.dimensions || typeof parsed.dimensions !== 'object' || Array.isArray(parsed.dimensions)) return null
    const allowedDimensions = new Set<string>(REQUIREMENT_MATCH_DIMENSIONS)
    const dimensions: RequirementMatchScoreResult['dimensions'] = {}
    for (const [key, value] of Object.entries(parsed.dimensions as Record<string, unknown>)) {
      if (!allowedDimensions.has(key)) return null
      const score = clampNumber(value, 0, 100)
      if (score === null) return null
      dimensions[key as RequirementMatchDimension] = score
    }
    if (!Object.keys(dimensions).length) return null
    const validDimensions = Array.isArray(parsed.validDimensions)
      ? parsed.validDimensions.filter((item): item is RequirementMatchDimension => (
          typeof item === 'string' && allowedDimensions.has(item)
        ))
      : []
    if (!Array.isArray(parsed.validDimensions) || validDimensions.length !== parsed.validDimensions.length) return null
    if (new Set(validDimensions).size !== validDimensions.length) return null
    if (validDimensions.some((dimension) => dimensions[dimension] === undefined)) return null
    if (Object.keys(dimensions).some((dimension) => !validDimensions.includes(dimension as RequirementMatchDimension))) return null

    if (!Array.isArray(parsed.dimensionDetails) || parsed.dimensionDetails.length !== validDimensions.length) return null
    const dimensionDetails = parsed.dimensionDetails.flatMap((item): RequirementMatchScoreResult['dimensionDetails'] => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const detail = item as Record<string, unknown>
      const dimension = typeof detail.dimension === 'string' && allowedDimensions.has(detail.dimension)
        ? detail.dimension as RequirementMatchDimension
        : null
      const score = clampNumber(detail.score, 0, 100)
      const weight = Number(detail.weight)
      const contribution = clampNumber(detail.contribution, 0, 100)
      if (!dimension || score === null || !Number.isFinite(weight) || weight <= 0 || contribution === null) return []
      return [{ dimension, score, weight, contribution }]
    })
    if (!validDimensions.length || dimensionDetails.length !== parsed.dimensionDetails.length ||
        new Set(dimensionDetails.map((item) => item.dimension)).size !== dimensionDetails.length ||
        dimensionDetails.some((item) => !validDimensions.includes(item.dimension))) return null
    const totalWeight = Number(parsed.totalWeight)
    const objectSimilarity = Number(parsed.objectSimilarity)
    if (!Number.isFinite(totalWeight) || totalWeight <= 0 || !Number.isFinite(objectSimilarity) || objectSimilarity < 0 || objectSimilarity > 1) return null
    const dimensionDetailByName = new Map(dimensionDetails.map((item) => [item.dimension, item]))
    if (validDimensions.some((dimension) => {
      const detail = dimensionDetailByName.get(dimension)
      const score = dimensions[dimension]
      return !detail || score === undefined || Math.abs(detail.score - score) > 0.01
    })) return null
    const detailWeight = dimensionDetails.reduce((sum, item) => sum + item.weight, 0)
    if (Math.abs(detailWeight - totalWeight) > 0.01) return null
    if (dimensionDetails.some((item) => (
      Math.abs(item.contribution - item.score * item.weight / totalWeight) > 0.05
    ))) return null
    const actionComparison = parsed.actionComparison === 'same' || parsed.actionComparison === 'different'
      ? parsed.actionComparison
      : parsed.actionComparison === 'unknown'
        ? 'unknown'
        : null
    if (!actionComparison) return null
    const decisionPath = typeof parsed.decisionPath === 'string' &&
      REQUIREMENT_MATCH_DECISION_PATHS.includes(parsed.decisionPath as typeof REQUIREMENT_MATCH_DECISION_PATHS[number])
      ? parsed.decisionPath as RequirementMatchScoreResult['decisionPath']
      : null
    const confidenceBasis = Array.isArray(parsed.confidenceBasis)
      ? parsed.confidenceBasis.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : null
    if (!decisionPath || !confidenceBasis || !Array.isArray(parsed.confidenceBasis) ||
        confidenceBasis.length !== parsed.confidenceBasis.length) return null
    const downgradeReasons = Array.isArray(parsed.downgradeReasons)
      ? parsed.downgradeReasons.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : null
    if (!downgradeReasons || downgradeReasons.length !== (Array.isArray(parsed.downgradeReasons) ? parsed.downgradeReasons.length : -1)) return null
    return {
      score: {
        recordUid: candidate.record.uid,
        relation,
        finalScore,
        downgradeReasons,
        dimensions,
        dimensionDetails,
        validDimensions,
        totalWeight,
        objectSimilarity,
        actionComparison,
        decisionPath,
        confidenceBasis
      },
      explanation
    }
  } catch {
    return null
  }
}

export const extractRequirementAnalysisIds = (
  question: string,
  maxIds = MAX_REQUIREMENT_IDS
): string[] => {
  const ids: string[] = []
  const seen = new Set<string>()
  const sharedPrefix = question.match(
    /(?:前缀|前面(?:都)?有(?:统一)?前缀)[^A-Za-z0-9]*([A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*-)(?=\s*$)/iu
  )?.[1] ?? ''
  const sharedPrefixStem = sharedPrefix.replace(/[-_.]+$/u, '').toLocaleLowerCase()
  const add = (value: string): void => {
    const normalized = value.trim().replace(/^[#【\[（(]+|[#】\]）)]+$/g, '')
    if (!normalized || seen.has(normalized.toLocaleLowerCase())) return
    if (sharedPrefixStem && normalized.toLocaleLowerCase() === sharedPrefixStem) return
    seen.add(normalized.toLocaleLowerCase())
    ids.push(normalized)
  }

  const addNumericWithPrefix = (rawStart: string, rawEnd?: string): void => {
    const start = Number(rawStart)
    const end = rawEnd === undefined ? start : Number(rawEnd)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return
    // A range in a user request means each requirement in that range. Keep a
    // finite guard so malformed text cannot create an unbounded extraction.
    const rangeEnd = Math.min(end, start + 200)
    for (let value = start; value <= rangeEnd && ids.length < maxIds; value += 1) {
      add(`${sharedPrefix}${value}`)
    }
  }

  for (const match of question.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g)) {
    const token = match[0]
    const range = sharedPrefix
      ? token.match(/^(.*?)(\d+)\s*[-~～至到]\s*(\d+)$/u)
      : null
    if (range) {
      const prefix = range[1].endsWith('-') || range[1].endsWith('_') || range[1].endsWith('.')
        ? range[1]
        : `${range[1]}-`
      // Explicit prefixed ranges are unambiguous even when the shared prefix
      // is stated at the end of the sentence.
      for (let value = Number(range[2]); value <= Math.min(Number(range[3]), Number(range[2]) + 200) && ids.length < maxIds; value += 1) {
        add(`${prefix}${value}`)
      }
      continue
    }
    add(token)
  }

  if (sharedPrefix) {
    // Numeric shorthand is only interpreted as a requirement ID when it is
    // not immediately followed by a Chinese label (e.g. “5000平台”). This
    // avoids treating section numbers and platform names as record IDs.
    for (const match of question.matchAll(/(?<![A-Za-z0-9])(\d+)(?:\s*[-~～至到]\s*(\d+))?(?![A-Za-z0-9])/gu)) {
      const after = question.slice((match.index ?? 0) + match[0].length)
      if (/^\s*[\u3400-\u9fff]/u.test(after)) continue
      if (/^\s*[、,，]\s*\d+\s*[\u3400-\u9fff]+\s*[:：]/u.test(after)) continue
      addNumericWithPrefix(match[1], match[2])
      if (ids.length >= maxIds) break
    }
  }

  if (!sharedPrefix) {
    for (const match of question.matchAll(/(?:需求(?:编号)?|编号|\bID\b)\s*(?:(?:为|是)\s*[:：#]?|[:：#])?\s*([A-Za-z0-9][A-Za-z0-9._-]*(?:\s*[、,，;；]\s*[A-Za-z0-9][A-Za-z0-9._-]*)*)/gi)) {
      match[1].split(/[、,，;；]/).forEach(add)
    }
  }
  return ids.slice(0, maxIds)
}

export class RequirementAnalysisAgent {
  private readonly retriever: Pick<HybridRequirementRetriever, 'retrieve'>
  private readonly reranker: RequirementReranker
  private readonly modelClient: RequirementMatchExplanationModelClient
  private readonly semanticContext: { analyzerVersion: string; modelSignature: string }
  private readonly matchModelSignature: string
  private readonly embeddingModelVersion: string
  private progressState: RequirementProgressState = {
    totalRequirements: 0,
    currentRequirement: 0,
    completedRequirements: 0,
    stage: 'route',
    stageCurrent: 0,
    stageTotal: 0,
    lastPercent: 0,
    match: emptyMatchProgress()
  }

  constructor(
    private readonly db: AppDatabase,
    knowledge: KnowledgeService,
    private readonly settings: ModelSettings,
    private readonly onProgress?: (event: AgentStatusEvent) => void,
    options: RequirementAnalysisAgentOptions = {}
  ) {
    this.semanticContext = options.semanticContext ?? {
      analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
      modelSignature: requirementSemanticModelSignature(settings)
    }
    this.matchModelSignature = options.matchModelSignature ?? hashJson({
      provider: settings.provider,
      source: settings.source,
      baseUrl: settings.baseUrl.replace(/\/+$/, ''),
      model: settings.model,
      thinking: settings.thinking,
      strategy: MATCH_STRATEGY_VERSION
    })
    this.embeddingModelVersion = options.embeddingModelVersion ?? (
      typeof (knowledge as { modelVersion?: unknown }).modelVersion === 'string'
        ? String((knowledge as { modelVersion: string }).modelVersion)
        : 'unknown'
    )
    this.retriever = options.retriever ?? new HybridRequirementRetriever(db, knowledge, this.semanticContext)
    this.reranker = options.reranker ?? createRequirementReranker()
    this.modelClient = options.modelClient ?? new ModelClient(settings)
  }

  async ask(request: ChatRequest): Promise<ChatResponse> {
    const requestedItemIds = extractRequirementAnalysisIds(request.question)
      .map((itemId) => this.resolveRequirementItemId(itemId))
    this.progressState = {
      totalRequirements: requestedItemIds.length,
      currentRequirement: 0,
      completedRequirements: 0,
      stage: 'route',
      stageCurrent: 0,
      stageTotal: requestedItemIds.length,
      lastPercent: 0,
      match: emptyMatchProgress()
    }
    this.progress('route', '正在识别需求编号并准备全库精准匹配')
    if (!requestedItemIds.length) {
      this.progress('summary', '未识别到需求编号，任务已结束', 1, 1)
      return {
        answer: '请提供一个或多个数据中心需求编号，例如：`@需求分析专家 分析需求编号 VISSLM-TSIS-3959、VISSLM-TSIS-4100`。',
        sources: [],
        dataViews: []
      }
    }

    const excludedUids = new Set(requestedItemIds.flatMap((itemId) => {
      const row = this.db.findRecordByItemId(itemId)
      return row ? [row.uid] : []
    }))
    const entries: RequirementAnalysisEntry[] = []
    for (let index = 0; index < requestedItemIds.length; index += 1) {
      const requestedItemId = requestedItemIds[index]!
      this.progressState.currentRequirement = index + 1
      this.progressState.match = emptyMatchProgress()
      this.progress('locate', `正在定位第 ${index + 1}/${requestedItemIds.length} 条需求：${requestedItemId}`, index, requestedItemIds.length)
      const entry = await this.analyzeOne(requestedItemId, request.question, excludedUids)
      entries.push(entry)
      this.progressState.completedRequirements += 1
      this.progress('summary', `${requestedItemId} 已完成需求分析`, 1, 1)
    }
    return this.buildResponse(entries, requestedItemIds)
  }

  private resolveRequirementItemId(requestedItemId: string): string {
    const exact = this.db.findRecordByItemId(requestedItemId)
    if (exact) return exact.itemId
    if (!/^\d+$/.test(requestedItemId)) return requestedItemId
    const suffixMatches = this.db.findRecordsByItemIdSuffix(requestedItemId)
    return suffixMatches.length === 1
      ? suffixMatches[0]!.itemId
      : requestedItemId
  }

  private async analyzeOne(
    requestedItemId: string,
    question: string,
    excludedUids: Set<string>
  ): Promise<RequirementAnalysisEntry> {
    const row = this.db.findRecordByItemId(requestedItemId)
    if (!row) return { requestedItemId, formal: [], references: [], error: '数据中心不存在该需求编号' }
    const record = this.db.getRecord(row.uid, false, this.semanticContext)
    if (!record) return { requestedItemId, formal: [], references: [], error: '对应记录详情无法读取' }
    const contentHash = this.db.getRecordContentHash(record.uid)
    const readyCard = contentHash
      ? this.db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...this.semanticContext })
      : null
    const card = readyCard ?? buildRequirementSourceView(record)
    const base: RequirementProfile = { record, card }
    if (!card.evidence.trim()) return {
      requestedItemId,
      base,
      formal: [],
      references: [],
      error: '记录没有可供匹配分析的完整清洗原文'
    }

    try {
      if (!readyCard) this.progress('recall', `${record.itemId} 未有有效 AI 语义卡片，本次使用完整清洗原文参与召回`)
      this.progress('recall', `${record.itemId}：Dense、BM25、ready 结构化字段三路召回开始`)
      const candidates = (await this.retriever.retrieve(card, excludedUids)).slice(0, HYBRID_CANDIDATE_LIMIT)
      this.progress('recall', `${record.itemId}：三路召回与 RRF 完成，共 ${candidates.length} 条候选`, candidates.length, HYBRID_CANDIDATE_LIMIT)
      if (!candidates.length) return { requestedItemId, base, formal: [], references: [], reviewSummary: '全库混合召回未发现候选记录。' }

      this.progress('rerank', `${record.itemId}：Cross-Encoder 正在重排 ${candidates.length} 条候选`, 0, candidates.length)
      const reranked = validateRerankerOutput(await this.reranker.rerank(card, candidates), candidates)
      const candidateByUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))
      const ranked = reranked.slice(0, RERANK_CANDIDATE_LIMIT).flatMap((item): RankedCandidate[] => {
        const candidate = candidateByUid.get(item.recordUid)
        return candidate ? [{ ...candidate, rerankerScore: item.score }] : []
      })
      this.progress('rerank', `${record.itemId}：Cross-Encoder 重排完成，进入前 ${ranked.length} 条`, ranked.length, RERANK_CANDIDATE_LIMIT)

      const scored = ranked.map((candidate) => ({
        candidate,
        score: scoreRequirementCandidate(card, candidate, { rerankerScore: candidate.rerankerScore })
      })).sort((left, right) => (
        right.score.finalScore - left.score.finalScore ||
        right.candidate.rerankerScore - left.candidate.rerankerScore ||
        right.candidate.retrievalScore - left.candidate.retrievalScore ||
        left.candidate.record.uid.localeCompare(right.candidate.record.uid)
      ))
      const selected = scored.slice(0, EXPLANATION_CANDIDATE_LIMIT)
      this.progress('score', `${record.itemId}：已完成 ${scored.length} 条候选多维业务评分，前 ${selected.length} 条进入批量 AI 语义复核`, scored.length, Math.max(1, scored.length))
      const explained = await this.explainAndMerge(question, base, selected)
      const matched = explained.matches
      const visible = matched.filter((candidate) => (
        FORMAL_RELATIONS.has(candidate.score.relation) || REFERENCE_RELATIONS.has(candidate.score.relation)
      ))
      const warnings = matched
        .filter((candidate) => candidate.explanationStatus === 'unavailable')
        .map((candidate) => isDeterministicRequirementMatch(candidate.score)
          ? `UID ${candidate.record.uid} 的 AI 说明暂不可用，正式关系已由${candidate.score.decisionPath === 'semantic_card' ? '高质量语义卡片' : '清洗原文近重复'}路径独立确认`
          : `UID ${candidate.record.uid} 的 AI 语义复核暂不可用，已降级为非正式关系并保留召回审计`)
      const cacheCount = matched.filter((candidate) => candidate.explanationStatus === 'cache_verified').length
      return {
        requestedItemId,
        base,
        formal: visible.filter((candidate) => FORMAL_RELATIONS.has(candidate.score.relation)),
        references: visible.filter((candidate) => REFERENCE_RELATIONS.has(candidate.score.relation)),
        reviewSummary: [
          `多路径置信融合完成；一次批量 AI 语义复核${cacheCount ? `，缓存命中 ${cacheCount} 条` : ''}`,
          explained.summary ? `AI 总结：${truncate(explained.summary, 240)}` : ''
        ].filter(Boolean).join('；'),
        reviewWarnings: warnings
      }
    } catch (error) {
      return {
        requestedItemId,
        base,
        formal: [],
        references: [],
        error: `匹配流程失败：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  private cacheContext(
    question: string,
    base: RequirementProfile,
    candidate: RankedCandidate
  ): RequirementMatchCacheInput {
    const baseContentHash = requirementRecordSourceHash(base.record)
    const candidateContentHash = requirementRecordSourceHash(candidate.record)
    const baseCardHash = hashJson(base.card)
    const candidateCardHash = hashJson(candidate.card)
    const queryHash = hashText(normalizeQuestion(question))
    const cacheKey = hashJson({
      strategyVersion: MATCH_STRATEGY_VERSION,
      baseRecordUid: base.record.uid,
      candidateRecordUid: candidate.record.uid,
      queryHash,
      baseContentHash,
      candidateContentHash,
      baseCardHash,
      candidateCardHash,
      analyzerVersion: this.semanticContext.analyzerVersion,
      semanticModelSignature: this.semanticContext.modelSignature,
      embeddingModelVersion: this.embeddingModelVersion,
      rerankerVersion: REQUIREMENT_RERANKER_MODEL_VERSION,
      explanationModelSignature: this.matchModelSignature
    })
    return {
      cacheKey,
      baseRecordUid: base.record.uid,
      candidateRecordUid: candidate.record.uid,
      queryHash,
      baseContentHash,
      candidateContentHash,
      baseCardHash,
      candidateCardHash,
      analyzerVersion: this.semanticContext.analyzerVersion,
      semanticModelSignature: this.semanticContext.modelSignature,
      embeddingModelVersion: this.embeddingModelVersion,
      rerankerVersion: REQUIREMENT_RERANKER_MODEL_VERSION,
      strategyVersion: MATCH_STRATEGY_VERSION,
      explanationModelSignature: this.matchModelSignature,
      result: {},
      resultStatus: 'live_verified'
    }
  }

  private readCache(
    context: RequirementMatchCacheInput,
    base: RequirementProfile,
    candidate: RankedCandidate,
    currentScore: RequirementMatchScoreResult
  ): { score: RequirementMatchScoreResult; explanation: MatchExplanationState } | null {
    try {
      const cached = this.db.getRequirementMatchCache(context.cacheKey)
      if (!cached || cached.resultStatus !== 'live_verified' && cached.resultStatus !== 'cache_verified') return null
      if (cached.baseRecordUid !== context.baseRecordUid || cached.candidateRecordUid !== context.candidateRecordUid ||
          cached.queryHash !== context.queryHash || cached.baseContentHash !== context.baseContentHash ||
          cached.candidateContentHash !== context.candidateContentHash || cached.baseCardHash !== context.baseCardHash ||
          cached.candidateCardHash !== context.candidateCardHash || cached.analyzerVersion !== context.analyzerVersion ||
          cached.semanticModelSignature !== context.semanticModelSignature || cached.embeddingModelVersion !== context.embeddingModelVersion ||
          cached.rerankerVersion !== context.rerankerVersion || cached.strategyVersion !== context.strategyVersion ||
          cached.explanationModelSignature !== context.explanationModelSignature) return null
      const parsed = parsedCachedResult(cached, base, candidate)
      if (!parsed) return null
      // Recall and reranking are intentionally recomputed for every query. A
      // cache hit may reuse only the already validated AI relation and
      // explanation. The percentage is recalculated from this query's local
      // score and constrained to the cached relation interval.
      return {
        score: isDeterministicRequirementMatch(currentScore)
          ? currentScore
          : constrainRequirementMatchToRelation(base.card, candidate.card, currentScore, parsed.score.relation),
        explanation: parsed.explanation
      }
    } catch {
      return null
    }
  }

  private saveCache(
    context: RequirementMatchCacheInput,
    score: RequirementMatchScoreResult,
    explanation: MatchExplanationState
  ): void {
    try {
      this.db.saveRequirementMatchCache({ ...context, result: cacheResultOf(score, explanation), resultStatus: 'live_verified' })
    } catch {
      // Cache persistence is an optimization; it cannot invalidate a verified result.
    }
  }

  private async explainAndMerge(
    question: string,
    base: RequirementProfile,
    selected: Array<{ candidate: RankedCandidate; score: RequirementMatchScoreResult }>
  ): Promise<ExplanationMergeResult> {
    if (!selected.length) return { matches: [] }
    const contexts = selected.map(({ candidate }) => this.cacheContext(question, base, candidate))
    const cached = new Map<string, { score: RequirementMatchScoreResult; explanation: MatchExplanationState }>()
    selected.forEach(({ candidate }, index) => {
      const value = this.readCache(contexts[index]!, base, candidate, selected[index]!.score)
      if (value) cached.set(candidate.record.uid, value)
    })
    const pending = selected.filter(({ candidate }) => !cached.has(candidate.record.uid))
    this.progress('explain', `${base.record.itemId}：待 AI 解释 ${pending.length} 条，已复核缓存命中 ${cached.size} 条`, cached.size, selected.length)
    const liveExplanations = new Map<string, RequirementMatchExplanation>()
    let explanationSummary = ''
    if (pending.length) {
      try {
        const explanationBatch = await explainRequirementMatches(
          this.modelClient,
          { question, base: base.card, candidates: pending.map(({ candidate }) => candidate) },
          {
            think: this.settings.thinking,
            forceThinking: this.settings.thinking,
            temperature: 0,
            // Ollama uses -1 for an unlimited generation budget. Deep-thinking
            // models can otherwise consume the whole budget before emitting
            // their structured answer; the request timeout remains the safety
            // boundary for a stalled model.
            numPredict: this.settings.source === 'local' && this.settings.thinking
              ? -1
              : Math.max(2_400, pending.length * 260),
            numCtx: EXPLANATION_MAX_CONTEXT,
            timeoutMs: EXPLANATION_TIMEOUT_MS
          }
        )
        explanationSummary = explanationBatch.summary
        explanationBatch.items.forEach((explanation) => liveExplanations.set(explanation.recordUid, explanation))
        this.progress('explain', `${base.record.itemId}：一次批量 AI 语义复核已通过 UID、关系和证据校验`, selected.length, selected.length)
      } catch (error) {
        const explanationError = error instanceof Error ? error.message : String(error)
        this.progress('explain', `${base.record.itemId}：AI 解释不可用，保留确定性评分（${explanationError}）`, selected.length, selected.length)
      }
    }
    const matches = selected.map(({ candidate, score }) => {
      const cachedValue = cached.get(candidate.record.uid)
      if (cachedValue) return {
        ...candidate,
        score: cachedValue.score,
        explanation: cachedValue.explanation,
        explanationStatus: 'cache_verified' as const
      }
      const modelExplanation = liveExplanations.get(candidate.record.uid)
      const explanation = modelExplanation
        ? {
            sharedEvidence: modelExplanation.similarities.join('；'),
            difference: modelExplanation.differences.join('；'),
            baseEvidence: modelExplanation.baseEvidence,
            candidateEvidence: modelExplanation.candidateEvidence
          }
        : fallbackExplanation(base, candidate)
      const reviewedScore = modelExplanation
        ? isDeterministicRequirementMatch(score)
          ? score
          : constrainRequirementMatchToRelation(base.card, candidate.card, score, modelExplanation.relation)
        : downgradeRequirementMatchForUnavailableReview(score)
      if (modelExplanation) {
        this.saveCache(
          contexts.find((context) => context.candidateRecordUid === candidate.record.uid)!,
          reviewedScore,
          explanation
        )
      }
      return {
        ...candidate,
        score: reviewedScore,
        explanation,
        explanationStatus: modelExplanation ? 'live_verified' as const : 'unavailable' as const
      }
    })
    if (explanationSummary) {
      this.progress('explain', `${base.record.itemId}：AI 解释总结已生成`, selected.length, selected.length)
    }
    return { matches, summary: explanationSummary || undefined }
  }

  private progress(stage: string, message: string, stageCurrent = 0, stageTotal = 0): void {
    this.progressState.stage = stage
    this.progressState.stageCurrent = Math.max(0, stageCurrent)
    this.progressState.stageTotal = Math.max(0, stageTotal)
    if (['recall', 'rerank', 'score', 'explain'].includes(stage)) {
      this.progressState.match.hasMatch = true
    }
    if (stage === 'recall' && stageTotal > 0) {
      this.progressState.match.recallTotal = Math.max(this.progressState.match.recallTotal ?? 0, stageCurrent)
    }
    if (stage === 'rerank') {
      this.progressState.match.rerankCurrent = Math.max(this.progressState.match.rerankCurrent ?? 0, stageCurrent)
      this.progressState.match.rerankTotal = Math.max(this.progressState.match.rerankTotal ?? 0, stageTotal)
    }
    if (stage === 'score') {
      this.progressState.match.scoredCurrent = Math.max(this.progressState.match.scoredCurrent ?? 0, stageCurrent)
      this.progressState.match.scoredTotal = Math.max(this.progressState.match.scoredTotal ?? 0, stageTotal)
    }
    const explanationStart = message.match(/待 AI 解释 (\d+) 条，已复核缓存命中 (\d+) 条/u)
    if (stage === 'explain' && explanationStart) {
      const pending = Number(explanationStart[1])
      const cacheHits = Number(explanationStart[2])
      this.progressState.match.explanationTotal = Math.max(
        this.progressState.match.explanationTotal ?? 0,
        pending + cacheHits
      )
      this.progressState.match.explanationDone = Math.max(this.progressState.match.explanationDone ?? 0, cacheHits)
      this.progressState.match.cacheHits = Math.max(this.progressState.match.cacheHits ?? 0, cacheHits)
    }
    if (stage === 'explain' && /批量 AI 解释已通过|AI 解释总结已生成/u.test(message)) {
      this.progressState.match.explanationDone = this.progressState.match.explanationTotal ?? stageCurrent
    }
    const stageBase: Record<string, number> = {
      route: 0,
      locate: 5,
      recall: 18,
      rerank: 42,
      score: 62,
      explain: 78,
      summary: 96
    }
    const stageStart = stageBase[stage] ?? 0
    const stageProgress = stageTotal > 0 ? Math.min(1, Math.max(0, stageCurrent / stageTotal)) : 0
    const total = this.progressState.totalRequirements
    const completed = Math.min(total, Math.max(0, this.progressState.completedRequirements))
    const currentItemProgress = stage === 'summary'
      ? 0
      : Math.min(0.98, Math.max(0, (stageStart / 100) + stageProgress * 0.02))
    const rawPercent = total > 0
      ? ((completed + (completed < total ? currentItemProgress : 0)) / total) * 100
      : 0
    const percent = Math.min(100, Math.max(this.progressState.lastPercent, Math.round(rawPercent)))
    this.progressState.lastPercent = percent
    const progress: AgentProgress = {
      percent,
      currentItem: this.progressState.currentRequirement,
      totalItems: this.progressState.totalRequirements,
      completedItems: this.progressState.completedRequirements,
      match: structuredClone(this.progressState.match),
      ...(stageTotal > 0 ? { stageCurrent, stageTotal } : {})
    }
    this.onProgress?.({ type: 'status', stage, message, progress })
  }

  private buildResponse(entries: RequirementAnalysisEntry[], requestedItemIds: string[]): ChatResponse {
    const visibleEntries = entries.filter((entry) => entry.base && (entry.formal.length || entry.references.length))
    const groups: ChatDataView['groups'] = visibleEntries.flatMap((entry) => {
      const makeGroup = (label: string, candidates: MatchedCandidate[]): ChatDataView['groups'][number] => ({
        name: `${entry.base!.record.itemId} · ${label}`,
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
      description: 'Dense/BM25/结构化召回经 RRF 合并后，由 Cross-Encoder 排序，再通过清洗原文、语义卡片和一次批量 AI 语义复核进行多路径置信融合。',
      total,
      fields: [
        'description', 'module', 'requirementType', 'relation', 'matchScore', 'scoreDetails',
        'sharedEvidence', 'difference', 'evidence', 'denseScore', 'lexicalScore',
        'structuralScore', 'rerankerScore',
        'semanticStatus', 'explanationStatus'
      ],
      fieldLabels: {
        description: '描述', module: '模块', requirementType: '需求类型', relation: '匹配关系',
        matchScore: '综合匹配度', scoreDetails: '评分明细', sharedEvidence: '相似点',
        difference: '主要差异', evidence: '原文证据', denseScore: '向量召回分',
        lexicalScore: 'BM25 召回分', structuralScore: '结构化召回分',
        rerankerScore: 'Cross-Encoder 重排分', semanticStatus: '语义资产状态',
        explanationStatus: 'AI 复核状态'
      },
      groups
    }] : []
    const foundCount = entries.filter((entry) => entry.base).length
    return {
      answer: [
        `需求分析完成：已处理 ${foundCount}/${requestedItemIds.length} 个编号。匹配流程为“Dense/BM25/结构化召回 → RRF → Cross-Encoder 排序 → 清洗原文/语义卡片/AI 语义复核多路径置信融合”。`,
        ...entries.map((entry) => this.answerSection(entry)),
        dataViews.length ? '结果已整理为结构化表格；综合匹配度是程序评分结果，不代表统计概率。' : ''
      ].filter(Boolean).join('\n\n'),
      sources: visibleEntries.flatMap((entry) => [...entry.formal, ...entry.references]).map((candidate): ChatSource => ({
        uid: candidate.record.uid,
        name: requirementDisplayName(candidate.record, candidate.card),
        nodeType: candidate.record.nodeType,
        itemId: candidate.record.itemId,
        sourceType: 'record',
        snippet: requirementDisplayDescription(candidate.record, candidate.card),
        score: candidate.score.finalScore
      })),
      dataViews
    }
  }

  private dataRow(candidate: MatchedCandidate): ChatDataRow {
    return {
      uid: candidate.record.uid,
      name: requirementDisplayName(candidate.record, candidate.card),
      nodeType: candidate.record.nodeType,
      itemId: candidate.record.itemId,
      values: {
        description: requirementDisplayDescription(candidate.record, candidate.card),
        module: candidate.card.module || '—',
        requirementType: candidate.card.requirementType || '—',
        relation: candidate.score.relation,
        matchScore: `${candidate.score.finalScore.toFixed(1)}%`,
        scoreDetails: JSON.stringify({
          dimensions: candidate.score.dimensions,
          dimensionDetails: candidate.score.dimensionDetails,
          downgradeReasons: candidate.score.downgradeReasons,
          objectSimilarity: candidate.score.objectSimilarity,
          actionComparison: candidate.score.actionComparison,
          decisionPath: candidate.score.decisionPath,
          confidenceBasis: candidate.score.confidenceBasis
        }),
        sharedEvidence: candidate.explanation.sharedEvidence,
        difference: candidate.explanation.difference,
        evidence: `基准：${candidate.explanation.baseEvidence}；候选：${candidate.explanation.candidateEvidence}`,
        denseScore: `${candidate.denseScore.toFixed(1)}%`,
        lexicalScore: `${candidate.lexicalScore.toFixed(1)}%`,
        structuralScore: `${candidate.structuralScore.toFixed(1)}%`,
        rerankerScore: `${candidate.rerankerScore.toFixed(1)}%`,
        semanticStatus: candidate.card.analysisStatus === 'ai_adjudicated'
          ? 'AI 语义卡片已就绪'
          : '未语义化，使用完整原文匹配',
        explanationStatus: candidate.explanationStatus === 'cache_verified'
          ? '已复核缓存命中'
          : candidate.explanationStatus === 'live_verified'
            ? '实时 AI 语义复核已校验'
            : isDeterministicRequirementMatch(candidate.score)
              ? 'AI 说明暂不可用，确定性路径已独立确认'
              : 'AI 语义复核暂不可用，正式关系已降级并保留召回审计'
      }
    }
  }

  private answerSection(entry: RequirementAnalysisEntry): string {
    if (!entry.base) return `#### ${entry.requestedItemId}\n\n- **结果**：${entry.error ?? '未找到数据中心记录'}。`
    const { record, card } = entry.base
    const header = [
      `#### ${record.itemId} · ${requirementDisplayName(record, card)}`,
      `- **描述**：${truncate(requirementDisplayDescription(record, card), 320)}`,
      `- **模块**：${card.module || '未标注'}`,
      `- **需求类型**：${card.requirementType || '未标注'}`,
      `- **语义资产状态**：${card.analysisStatus === 'ai_adjudicated'
        ? 'AI 语义卡片已就绪'
        : '未语义化，本次使用完整清洗原文继续匹配'}`
    ]
    if (entry.error) return [...header, `- **匹配结果**：${entry.error}。`].join('\n')
    const render = (candidate: MatchedCandidate, index: number): string[] => [
      `${index + 1}. **${candidate.record.itemId} · ${requirementDisplayName(candidate.record, candidate.card)}** · ${candidate.score.relation} · 综合匹配度 **${candidate.score.finalScore.toFixed(1)}%**`,
      `   - 相似点：${candidate.explanation.sharedEvidence}`,
      `   - 主要差异：${candidate.explanation.difference}`
    ]
    const formal = entry.formal.slice(0, ANSWER_RESULT_LIMIT).flatMap(render)
    const references = entry.references.slice(0, ANSWER_RESULT_LIMIT).flatMap(render)
    const warnings = entry.reviewWarnings?.length ? [`- **说明**：${entry.reviewWarnings.join('；')}`] : []
    return [
      ...header,
      entry.reviewSummary ? `- **分析状态**：${entry.reviewSummary}` : '',
      formal.length ? '**正式匹配**' : '',
      ...formal,
      references.length ? '**参考关联**' : '',
      ...references,
      ...warnings,
      !formal.length ? '未发现业务目标一致的高度相似或重复需求。检索到的记录仅存在主题、模块或操作模式上的关联。' : `确认 ${entry.formal.length} 条高度相似或重复需求。`
    ].filter(Boolean).join('\n')
  }
}
