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
  AppDatabase
} from '../database'
import { KnowledgeService } from '../knowledge'
import { ModelClient } from '../model-client'
import {
  HybridRequirementRetriever,
  type HybridRequirementCandidate
} from '../requirements/hybrid-retrieval'
import {
  createRequirementReranker,
  type RequirementRerankItem,
  type RequirementReranker
} from '../requirements/cross-encoder-reranker'
import {
  buildRequirementSourceView,
  removeRequirementNoise,
  toRequirementPlainText,
  type RequirementMatchCard
} from '../requirements/requirement-match-card'
import {
  REQUIREMENT_MATCH_RELATIONS,
  isDeterministicRequirementMatch,
  REQUIREMENT_MATCH_DECISION_PATHS,
  scoreRequirementCandidate,
  type RequirementMatchRelation,
  type RequirementMatchScoreResult
} from '../requirements/requirement-match-scoring'
import {
  explainRequirementMatches,
  type RequirementMatchExplanation,
  type RequirementMatchExplanationModelClient
} from '../requirements/requirement-match-explainer'
import type { MatchDecisionStatus, RequirementMatchCandidateResult } from '../requirements/requirement-match-domain'
import { RequirementMatchingCore } from '../requirements/requirement-matching-core'
import { agentRequirementMatchProjection } from '../requirements/requirement-match-adapters'

type AgentStatusEvent = Extract<AgentEvent, { type: 'status' }>

const MAX_REQUIREMENT_IDS = 20
export const MAX_DIRECT_REQUIREMENT_IDS = 200
const HYBRID_CANDIDATE_LIMIT = 50
const RERANK_CANDIDATE_LIMIT = 20
const EXPLANATION_CANDIDATE_LIMIT = 10
const ANSWER_RESULT_LIMIT = 8
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
  matchingCore?: RequirementMatchingCore
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
  explanationStatus: 'live_verified' | 'unavailable'
  decisionStatus: MatchDecisionStatus
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
  isolated: 0
})

const requirementDisplayName = (record: RecordDetail, card?: RequirementMatchCard): string => (
  toRequirementPlainText(card?.sourceTitle || record.name) || '未命名需求'
)

const requirementDisplayDescription = (record: RecordDetail, card?: RequirementMatchCard): string => {
  const source = card?.sourceDescription || record.description
  const cleaned = removeRequirementNoise(toRequirementPlainText(source))
  return cleaned || '暂无描述'
}

const truncate = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

const evidenceExcerpt = (value: string, maxLength = 240): string => (
  value.trim().slice(0, Math.max(2, maxLength))
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
  private readonly matchingCore: RequirementMatchingCore
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
    this.retriever = options.retriever ?? new HybridRequirementRetriever(db, knowledge)
    this.reranker = options.reranker ?? createRequirementReranker()
    this.modelClient = options.modelClient ?? new ModelClient(settings)
    this.matchingCore = options.matchingCore ?? new RequirementMatchingCore({
      retriever: this.retriever,
      reranker: this.reranker,
      explainer: {
        mode: settings.source === 'local' ? 'local' : 'online',
        explain: async (base, candidates) => {
          const batch = await explainRequirementMatches(this.modelClient, { base, candidates }, {
            think: this.settings.thinking,
            forceThinking: this.settings.thinking,
            temperature: 0,
            numPredict: this.settings.source === 'local' && this.settings.thinking
              ? -1
              : Math.max(2_400, candidates.length * 260),
            numCtx: EXPLANATION_MAX_CONTEXT,
            timeoutMs: EXPLANATION_TIMEOUT_MS
          })
          return new Map(batch.items.map((item) => [item.recordUid, JSON.stringify(item)]))
        }
      },
      async exactBusinessHashCandidates() { return [] },
      candidateEligible() { return true }
    })
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
    const record = this.db.getRecord(row.uid, false)
    if (!record) return { requestedItemId, formal: [], references: [], error: '对应记录详情无法读取' }
    const card = buildRequirementSourceView(record)
    const base: RequirementProfile = { record, card }
    if (!card.evidence.trim()) return {
      requestedItemId,
      base,
      formal: [],
      references: [],
      error: '记录没有可供匹配分析的完整清洗原文'
    }

    try {
      this.progress('recall', `${record.itemId}：统一匹配核心开始 Dense/BM25 召回、RRF 与精确哈希补召`)
      const result = await this.matchingCore.match({
        base: card,
        excludedUids,
        includeCurrentProjectRecords: false,
        explainTopN: EXPLANATION_CANDIDATE_LIMIT,
        explanationPolicy: {
          mode: this.settings.source === 'local' ? 'local' : 'online',
          allowExternalProcessing: this.settings.source === 'local'
        }
      })
      this.progress('score', `${record.itemId}：统一核心完成排序，共 ${result.candidates.length} 条候选`, result.candidates.length, HYBRID_CANDIDATE_LIMIT)
      if (!result.candidates.length) return { requestedItemId, base, formal: [], references: [], reviewSummary: '全库混合召回未发现候选记录。' }

      const resultByUid = new Map(result.candidates.map((candidate) => [candidate.recordUid, candidate]))
      const matched = agentRequirementMatchProjection(result).slice(0, EXPLANATION_CANDIDATE_LIMIT).flatMap((projected): MatchedCandidate[] => {
        const candidate = resultByUid.get(projected.recordUid)!
        const candidateRecord = this.db.getRecord(candidate.recordUid, false)
        if (!candidateRecord) return []
        const candidateCard = buildRequirementSourceView(candidateRecord)
        const rankedCandidate: RankedCandidate = {
          record: candidateRecord,
          card: candidateCard,
          denseScore: candidate.stageScores.denseScore ?? 0,
          lexicalScore: candidate.stageScores.lexicalScore ?? 0,
          retrievalScore: candidate.stageScores.fusedScore,
          rerankerScore: candidate.stageScores.rerankerScore ?? 0,
          snippet: candidateCard.evidence
        }
        const explanation = this.explanationState(candidate, base, rankedCandidate)
        return [{
          ...rankedCandidate,
          score: this.legacyScore(candidate),
          explanation,
          explanationStatus: candidate.explanation ? 'live_verified' : 'unavailable',
          decisionStatus: candidate.decisionStatus
        }]
      })
      const visible = matched.filter((candidate) => candidate.decisionStatus !== 'rejected')
      const warnings = [
        ...result.degradationCodes.map((code) => `统一匹配核心降级：${code}`),
        ...matched
          .filter((candidate) => candidate.explanationStatus === 'unavailable')
          .map((candidate) => `UID ${candidate.record.uid} 的 AI 关系解释暂不可用，已保留确定性排序与审计信息`)
      ]
      return {
        requestedItemId,
        base,
        formal: visible.filter((candidate) => candidate.decisionStatus === 'confirmed'),
        references: visible.filter((candidate) => candidate.decisionStatus !== 'confirmed'),
        reviewSummary: `统一核心 ${result.pipelineVersion} 已完成；排序版本 ${result.rankingVersion}`,
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

  private async explainAndMerge(
    question: string,
    base: RequirementProfile,
    selected: Array<{ candidate: RankedCandidate; score: RequirementMatchScoreResult }>
  ): Promise<ExplanationMergeResult> {
    if (!selected.length) return { matches: [] }
    this.progress('explain', `${base.record.itemId}：待 AI 解释 ${selected.length} 条`, 0, selected.length)
    const liveExplanations = new Map<string, RequirementMatchExplanation>()
    let explanationSummary = ''
    try {
      const explanationBatch = await explainRequirementMatches(
        this.modelClient,
        { question, base: base.card, candidates: selected.map(({ candidate }) => candidate) },
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
            : Math.max(2_400, selected.length * 260),
          numCtx: EXPLANATION_MAX_CONTEXT,
          timeoutMs: EXPLANATION_TIMEOUT_MS
        }
      )
      explanationSummary = explanationBatch.summary
      explanationBatch.items.forEach((explanation) => liveExplanations.set(explanation.recordUid, explanation))
      this.progress('explain', `${base.record.itemId}：一次批量 AI 关系解释已通过 UID、关系和证据校验`, selected.length, selected.length)
    } catch (error) {
      const explanationError = error instanceof Error ? error.message : String(error)
      this.progress('explain', `${base.record.itemId}：AI 解释不可用，保留确定性评分（${explanationError}）`, selected.length, selected.length)
    }
    const matches = selected.map(({ candidate, score }) => {
      const modelExplanation = liveExplanations.get(candidate.record.uid)
      const explanation = modelExplanation
        ? {
            sharedEvidence: modelExplanation.similarities.join('；'),
            difference: modelExplanation.differences.join('；'),
            baseEvidence: modelExplanation.baseEvidence,
            candidateEvidence: modelExplanation.candidateEvidence
          }
        : fallbackExplanation(base, candidate)
      return {
        ...candidate,
        score,
        explanation,
        explanationStatus: modelExplanation ? 'live_verified' as const : 'unavailable' as const,
        decisionStatus: 'suggested' as const
      }
    })
    if (explanationSummary) {
      this.progress('explain', `${base.record.itemId}：AI 解释总结已生成`, selected.length, selected.length)
    }
    return { matches, summary: explanationSummary || undefined }
  }

  /** Adapter only: preserve the existing response schema without recalculating the core score. */
  private legacyScore(candidate: RequirementMatchCandidateResult): RequirementMatchScoreResult {
    const dimensions = {
      dense: candidate.stageScores.denseScore ?? undefined,
      lexical: candidate.stageScores.lexicalScore ?? undefined,
      reranker: candidate.stageScores.rerankerScore ?? undefined
    }
    return {
      recordUid: candidate.recordUid,
      relation: candidate.relation ?? 'unrelated',
      finalScore: candidate.rankingScore,
      downgradeReasons: [...candidate.reasonCodes, ...candidate.degradationCodes],
      dimensions,
      dimensionDetails: [],
      validDimensions: (Object.keys(dimensions) as Array<'dense' | 'lexical' | 'reranker'>)
        .filter((key) => dimensions[key] !== undefined),
      totalWeight: 1,
      objectSimilarity: 0,
      actionComparison: 'unknown',
      decisionPath: candidate.evidenceLevel === 'exact_business_hash' ? 'exact_text' : 'deterministic_score',
      confidenceBasis: [`统一核心排序版本：${candidate.rankingVersion}`, ...candidate.reasonCodes]
    }
  }

  private explanationState(
    result: RequirementMatchCandidateResult,
    base: RequirementProfile,
    candidate: RankedCandidate
  ): MatchExplanationState {
    if (!result.explanation) return fallbackExplanation(base, candidate)
    try {
      const parsed = JSON.parse(result.explanation) as RequirementMatchExplanation
      return {
        sharedEvidence: parsed.similarities.join('；'),
        difference: parsed.differences.join('；'),
        baseEvidence: parsed.baseEvidence,
        candidateEvidence: parsed.candidateEvidence
      }
    } catch {
      return {
        sharedEvidence: result.explanation,
        difference: '详细差异请结合原文证据查看。',
        baseEvidence: evidenceExcerpt(base.card.evidence),
        candidateEvidence: evidenceExcerpt(candidate.card.evidence)
      }
    }
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
    const explanationStart = message.match(/待 AI 解释 (\d+) 条/u)
    if (stage === 'explain' && explanationStart) {
      const pending = Number(explanationStart[1])
      this.progressState.match.explanationTotal = Math.max(this.progressState.match.explanationTotal ?? 0, pending)
      this.progressState.match.explanationDone = 0
    }
    if (stage === 'explain' && /批量 AI 关系解释已通过|AI 解释总结已生成/u.test(message)) {
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
      description: '完整清洗原文经 Dense/BM25 两路召回与 RRF 合并后，由 Cross-Encoder 排序、确定性评分，并通过一次批量 AI 关系解释补充证据。',
      total,
      fields: [
        'description', 'module', 'requirementType', 'relation', 'matchScore', 'scoreDetails',
        'sharedEvidence', 'difference', 'evidence', 'denseScore', 'lexicalScore',
        'rerankerScore', 'explanationStatus'
      ],
      fieldLabels: {
        description: '描述', module: '模块', requirementType: '需求类型', relation: '匹配关系',
        matchScore: '综合匹配度', scoreDetails: '评分明细', sharedEvidence: '相似点',
        difference: '主要差异', evidence: '原文证据', denseScore: '向量召回分',
        lexicalScore: 'BM25 召回分', rerankerScore: 'Cross-Encoder 重排分',
        explanationStatus: 'AI 解释状态'
      },
      groups
    }] : []
    const foundCount = entries.filter((entry) => entry.base).length
    return {
      answer: [
        `需求分析完成：已处理 ${foundCount}/${requestedItemIds.length} 个编号。匹配流程为“完整清洗原文 → Dense/BM25 两路召回 → RRF → Cross-Encoder 排序 → 确定性评分 → 批量 AI 关系解释”。`,
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
        rerankerScore: `${candidate.rerankerScore.toFixed(1)}%`,
        explanationStatus: candidate.explanationStatus === 'live_verified'
            ? '实时 AI 关系解释已校验'
            : isDeterministicRequirementMatch(candidate.score)
              ? 'AI 说明暂不可用，确定性路径已独立确认'
              : 'AI 关系解释暂不可用，已保留确定性评分与召回审计'
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
      `- **需求类型**：${card.requirementType || '未标注'}`
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
