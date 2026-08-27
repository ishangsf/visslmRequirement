import { createHash } from 'node:crypto'
import type { RequirementReranker } from './cross-encoder-reranker'
import type { HybridRequirementCandidate } from './hybrid-retrieval'
import {
  hashRequirementBusiness,
  normalizeRequirementBusinessText,
  REQUIREMENT_NORMALIZATION_VERSION
} from './requirement-business-normalization'
import type {
  RequirementMatchDegradationCode,
  RequirementMatchRequest,
  RequirementMatchResult,
  RequirementMatchStageScores
} from './requirement-match-domain'
import { evaluateRequirementMatchPolicy } from './requirement-match-policy'
import {
  FALLBACK_REQUIREMENT_RANKING_MANIFEST,
  FULL_REQUIREMENT_RANKING_MANIFEST,
  hashRequirementRankingManifest,
  type RequirementRankingManifest
} from './requirement-ranking-manifest'
import { rankRequirementCandidates, type RequirementRankingInput } from './requirement-ranking'

export const REQUIREMENT_MATCH_PIPELINE_VERSION = 'requirement-matching-pipeline-v1'
const RETRIEVAL_LIMIT = 50
const RERANK_LIMIT = 20
const EXPLANATION_LIMIT = 10

export interface RequirementMatchingRetriever {
  retrieve(base: RequirementMatchRequest['base'], excludedUids: Set<string>): Promise<HybridRequirementCandidate[]>
}

export interface RequirementMatchingExplainer {
  mode: 'local' | 'online'
  explain(
    base: RequirementMatchRequest['base'],
    candidates: HybridRequirementCandidate[]
  ): Promise<ReadonlyMap<string, string>>
}

export interface RequirementMatchingDependencies {
  retriever: RequirementMatchingRetriever
  reranker: RequirementReranker
  explainer?: RequirementMatchingExplainer
  exactBusinessHashCandidates(
    businessHash: string,
    request: RequirementMatchRequest
  ): Promise<HybridRequirementCandidate[]>
  candidateEligible(candidate: HybridRequirementCandidate, request: RequirementMatchRequest): boolean
}

const finiteScore = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
)

const rankByScore = (
  candidates: HybridRequirementCandidate[],
  scoreOf: (candidate: HybridRequirementCandidate) => number
): Map<string, number> => new Map([...candidates]
  .sort((left, right) => scoreOf(right) - scoreOf(left) || left.record.uid.localeCompare(right.record.uid))
  .map((candidate, index) => [candidate.record.uid, index + 1]))

const deterministicAgreement = (
  base: RequirementMatchRequest['base'],
  candidate: HybridRequirementCandidate
): number => {
  const left = base.businessFacts
  const right = candidate.card.businessFacts
  let score = 0
  let weight = 0
  const equal = (a: string, b: string): boolean => (
    Boolean(a && b) && normalizeRequirementBusinessText(a) === normalizeRequirementBusinessText(b)
  )
  if (left.action && right.action) { weight += 0.4; if (equal(left.action, right.action)) score += 0.4 }
  if (left.object && right.object) { weight += 0.4; if (equal(left.object, right.object)) score += 0.4 }
  if (left.negated !== null && right.negated !== null) { weight += 0.1; if (left.negated === right.negated) score += 0.1 }
  if (left.constraints.length || right.constraints.length) {
    weight += 0.1
    const a = JSON.stringify(left.constraints.map(normalizeRequirementBusinessText).sort())
    const b = JSON.stringify(right.constraints.map(normalizeRequirementBusinessText).sort())
    if (a === b) score += 0.1
  }
  return weight ? score / weight : 0
}

const configHash = (manifest: RequirementRankingManifest, modelVersion: string | null): string => createHash('sha256')
  .update(JSON.stringify({
    normalizationVersion: REQUIREMENT_NORMALIZATION_VERSION,
    pipelineVersion: REQUIREMENT_MATCH_PIPELINE_VERSION,
    rankingManifestHash: hashRequirementRankingManifest(manifest),
    modelVersion
  }))
  .digest('hex')

export class RequirementMatchingCore {
  constructor(private readonly deps: RequirementMatchingDependencies) {}

  async match(request: RequirementMatchRequest): Promise<RequirementMatchResult> {
    const baseBusinessHash = hashRequirementBusiness(request.base)
    const [retrieved, exactCandidates] = await Promise.all([
      this.deps.retriever.retrieve(request.base, new Set(request.excludedUids)),
      this.deps.exactBusinessHashCandidates(baseBusinessHash, request)
    ])
    const candidatesByUid = new Map<string, HybridRequirementCandidate>()
    for (const candidate of [...exactCandidates, ...retrieved]) {
      const uid = candidate.record.uid
      if (!uid || request.excludedUids.has(uid) || candidatesByUid.has(uid)) continue
      candidatesByUid.set(uid, candidate)
      if (candidatesByUid.size >= RETRIEVAL_LIMIT) break
    }
    const candidates = [...candidatesByUid.values()]
    const fusedRanks = new Map(candidates.map((candidate, index) => [candidate.record.uid, index + 1]))
    const denseRanks = rankByScore(candidates, (candidate) => finiteScore(candidate.denseScore))
    const lexicalRanks = rankByScore(candidates, (candidate) => finiteScore(candidate.lexicalScore))
    const maximumRetrieval = Math.max(0, ...candidates.map((candidate) => candidate.retrievalScore))

    const degradationCodes: RequirementMatchDegradationCode[] = []
    const rerankTarget = candidates.slice(0, RERANK_LIMIT)
    let rerankerByUid = new Map<string, { rank: number; score: number }>()
    let manifest: RequirementRankingManifest = FULL_REQUIREMENT_RANKING_MANIFEST
    if (rerankTarget.length) {
      try {
        const reranked = await this.deps.reranker.rerank(request.base, rerankTarget)
        const expected = new Set(rerankTarget.map((candidate) => candidate.record.uid))
        const seen = new Set<string>()
        for (const [index, item] of reranked.entries()) {
          if (!expected.has(item.recordUid) || seen.has(item.recordUid) || !Number.isFinite(item.score)) {
            throw new Error(`Cross-Encoder 返回无效 UID 或分数：${item.recordUid}`)
          }
          seen.add(item.recordUid)
          rerankerByUid.set(item.recordUid, { rank: index + 1, score: finiteScore(item.score) })
        }
        if (seen.size !== expected.size) throw new Error('Cross-Encoder 未覆盖全部 Top20 候选')
      } catch {
        degradationCodes.push('RERANKER_UNAVAILABLE')
        rerankerByUid = new Map()
        manifest = FALLBACK_REQUIREMENT_RANKING_MANIFEST
      }
    }

    const inputs: RequirementRankingInput[] = candidates.map((candidate) => {
      const eligible = this.deps.candidateEligible(candidate, request)
      const candidateBusinessHash = hashRequirementBusiness(candidate.card)
      const normalizedTextMatches = normalizeRequirementBusinessText(request.base.matchingText) ===
        normalizeRequirementBusinessText(candidate.card.matchingText)
      const policy = evaluateRequirementMatchPolicy(request.base, candidate.card, {
        baseBusinessHash,
        candidateBusinessHash,
        normalizationVersionMatches: true,
        candidateEligible: eligible,
        normalizedTextMatches
      })
      const reranker = rerankerByUid.get(candidate.record.uid)
      const fusedRank = fusedRanks.get(candidate.record.uid) ?? RETRIEVAL_LIMIT
      const stageScores: RequirementMatchStageScores = {
        denseRank: denseRanks.get(candidate.record.uid) ?? null,
        denseScore: finiteScore(candidate.denseScore),
        lexicalRank: lexicalRanks.get(candidate.record.uid) ?? null,
        lexicalScore: finiteScore(candidate.lexicalScore),
        fusedRank,
        fusedScore: maximumRetrieval > 0 ? finiteScore(candidate.retrievalScore / maximumRetrieval * 100) : 0,
        rerankerRank: reranker?.rank ?? null,
        rerankerScore: reranker?.score ?? null
      }
      return {
        recordUid: candidate.record.uid,
        policy,
        stageScores,
        deterministicAgreement: deterministicAgreement(request.base, candidate),
        degradationCodes: [...degradationCodes],
        explanation: null
      }
    })

    let ranked = rankRequirementCandidates(inputs, manifest)
    const explainLimit = Math.max(0, Math.min(EXPLANATION_LIMIT, Math.floor(request.explainTopN)))
    const shouldExplain = Boolean(this.deps.explainer) && request.explanationPolicy.mode !== 'disabled' &&
      (this.deps.explainer?.mode === 'local' || request.explanationPolicy.allowExternalProcessing)
    if (shouldExplain && explainLimit > 0) {
      const candidateByUid = new Map(candidates.map((candidate) => [candidate.record.uid, candidate]))
      const explainCandidates = ranked
        .filter((candidate) => candidate.decisionStatus !== 'rejected')
        .slice(0, explainLimit)
        .flatMap((result) => candidateByUid.get(result.recordUid) ?? [])
      try {
        const explanations = await this.deps.explainer!.explain(request.base, explainCandidates)
        const expected = new Set(explainCandidates.map((candidate) => candidate.record.uid))
        if ([...explanations.keys()].some((uid) => !expected.has(uid))) {
          throw new Error('解释器返回未知候选 UID')
        }
        for (const input of inputs) input.explanation = explanations.get(input.recordUid) ?? null
        ranked = rankRequirementCandidates(inputs, manifest)
      } catch (error) {
        const code: RequirementMatchDegradationCode = error instanceof Error &&
          error.name === 'RequirementMatchExplanationProtocolError'
          ? 'EXPLANATION_PROTOCOL_ERROR'
          : 'EXPLAINER_UNAVAILABLE'
        degradationCodes.push(code)
        for (const input of inputs) input.degradationCodes = [...degradationCodes]
        ranked = rankRequirementCandidates(inputs, manifest)
      }
    } else if (request.explanationPolicy.mode !== 'disabled' && !this.deps.explainer) {
      degradationCodes.push('EXPLAINER_UNAVAILABLE')
      for (const input of inputs) input.degradationCodes = [...degradationCodes]
      ranked = rankRequirementCandidates(inputs, manifest)
    }

    const modelVersion = manifest === FULL_REQUIREMENT_RANKING_MANIFEST ? this.deps.reranker.modelId : null
    return {
      normalizationVersion: REQUIREMENT_NORMALIZATION_VERSION,
      pipelineVersion: REQUIREMENT_MATCH_PIPELINE_VERSION,
      rankingVersion: manifest.rankingVersion,
      configHash: configHash(manifest, modelVersion),
      modelVersion,
      degradationCodes,
      candidates: ranked
    }
  }
}
