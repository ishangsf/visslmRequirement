import { createHash } from 'node:crypto'
import type { ProjectRequirement } from '../../shared/project-types'
import { AppDatabase, REQUIREMENT_BUSINESS_INDEX_VERSION } from '../database'
import { TaskCancelledError } from '../background-task-runner'
import { buildProjectRequirementMatchCard, buildRequirementSourceView } from './requirement-match-card'
import {
  REQUIREMENT_NORMALIZATION_VERSION,
  hashRequirementBusiness
} from './requirement-business-normalization'
import type { RequirementMatchRequest, RequirementMatchCandidateResult } from './requirement-match-domain'
import type { HybridRequirementCandidate } from './hybrid-retrieval'
import { RequirementMatchingCore, REQUIREMENT_MATCH_PIPELINE_VERSION } from './requirement-matching-core'
import { FULL_RERANK_RANKING_VERSION } from './requirement-ranking-manifest'

export interface RequirementMatchRunStartInput {
  requirementId: string
  explanationPolicy: RequirementMatchRequest['explanationPolicy']
  explainTopN?: number
}

interface PendingRunInput extends RequirementMatchRunStartInput {
  requirementSnapshotHash: string
}

const canonicalRequirement = (requirement: ProjectRequirement): Record<string, unknown> => ({
  id: requirement.id,
  projectId: requirement.projectId,
  version: requirement.version,
  category: requirement.category,
  module: requirement.module,
  title: requirement.title,
  content: requirement.content,
  keyInfoTerms: [...requirement.keyInfoTerms].sort(),
  updatedAt: requirement.updatedAt
})

export const hashProjectRequirementSnapshot = (requirement: ProjectRequirement): string => createHash('sha256')
  .update(JSON.stringify(canonicalRequirement(requirement)))
  .digest('hex')

export class RequirementMatchRunService {
  private readonly pending = new Map<string, PendingRunInput>()

  constructor(
    private readonly db: AppDatabase,
    private readonly core: RequirementMatchingCore
  ) {}

  async start(input: RequirementMatchRunStartInput): Promise<{ runId: string }> {
    const requirement = this.db.getProjectRequirement(input.requirementId)
    if (!requirement) throw new Error('功能需求不存在')
    const requirementSnapshotHash = hashProjectRequirementSnapshot(requirement)
    const requirementBusinessHash = hashRequirementBusiness(buildProjectRequirementMatchCard(requirement))
    const run = this.db.createRequirementMatchRun({
      requirementId: requirement.id,
      requirementSnapshotHash,
      requirementBusinessHash,
      normalizationVersion: REQUIREMENT_NORMALIZATION_VERSION,
      indexVersion: REQUIREMENT_BUSINESS_INDEX_VERSION,
      pipelineVersion: REQUIREMENT_MATCH_PIPELINE_VERSION,
      rankingVersion: FULL_RERANK_RANKING_VERSION,
      configHash: 'pending',
      modelVersion: null
    })
    this.pending.set(run.id, { ...input, requirementSnapshotHash })
    return { runId: run.id }
  }

  async execute(runId: string, signal?: AbortSignal): Promise<void> {
    const run = this.db.getRequirementMatchRun(runId)
    const pending = this.pending.get(runId)
    if (!run || run.status !== 'running' || !pending) throw new Error('待执行的需求匹配运行不存在')
    try {
      this.throwIfCancelled(signal)
      const requirement = this.db.getProjectRequirement(run.requirementId)
      if (!requirement || hashProjectRequirementSnapshot(requirement) !== run.requirementSnapshotHash) {
        this.db.failRequirementMatchRun(runId, 'REQUIREMENT_SNAPSHOT_CHANGED')
        return
      }
      if (run.indexVersion !== REQUIREMENT_BUSINESS_INDEX_VERSION) {
        this.db.failRequirementMatchRun(runId, 'INDEX_VERSION_MISMATCH')
        return
      }
      const matchRequest: RequirementMatchRequest = {
        base: buildProjectRequirementMatchCard(requirement),
        excludedUids: new Set<string>(),
        includeCurrentProjectRecords: false,
        currentProjectId: requirement.projectId,
        explainTopN: pending.explainTopN ?? 10,
        explanationPolicy: pending.explanationPolicy
      }
      const deferredExplanation = matchRequest.explainTopN > 0 &&
        (this.core.canExplain?.(matchRequest) ?? false)
      const result = await this.core.match(deferredExplanation ? {
        ...matchRequest,
        explainTopN: 0,
        explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }
      } : matchRequest)
      const explanationUids = new Set(deferredExplanation
        ? result.candidates
          .filter((candidate) => candidate.decisionStatus !== 'rejected')
          .slice(0, Math.min(10, matchRequest.explainTopN))
          .map((candidate) => candidate.recordUid)
        : [])
      if (explanationUids.size) {
        result.candidates = result.candidates.map((candidate) => explanationUids.has(candidate.recordUid)
          ? { ...candidate, explanationStatus: 'pending' }
          : candidate)
      }
      this.throwIfCancelled(signal)
      const current = this.db.getProjectRequirement(run.requirementId)
      if (!current || hashProjectRequirementSnapshot(current) !== run.requirementSnapshotHash) {
        this.db.failRequirementMatchRun(runId, 'REQUIREMENT_SNAPSHOT_CHANGED')
        return
      }
      const deferredCandidates: HybridRequirementCandidate[] = []
      const candidates = result.candidates.map((candidate) => {
        const record = this.db.getRecord(candidate.recordUid, false)
        const recordSnapshotHash = record ? hashRequirementBusiness(buildRequirementSourceView(record)) : ''
        if (record && explanationUids.has(candidate.recordUid)) {
          deferredCandidates.push({
            record,
            card: buildRequirementSourceView(record),
            denseScore: candidate.stageScores.denseScore ?? 0,
            lexicalScore: candidate.stageScores.lexicalScore ?? 0,
            retrievalScore: candidate.stageScores.fusedScore,
            snippet: buildRequirementSourceView(record).evidence
          })
        }
        return {
          ...candidate,
          recordSnapshotHash,
          evidenceJson: {
            baseBusinessHash: run.requirementBusinessHash,
            recordBusinessHash: recordSnapshotHash,
            evidenceLevel: candidate.evidenceLevel,
            reasonCodes: [...candidate.reasonCodes]
          }
        }
      })
      this.throwIfCancelled(signal)
      this.db.completeRequirementMatchRun(runId, candidates, result.degradationCodes, result)
      if (deferredCandidates.length) {
        void this.completeDeferredExplanations(runId, matchRequest, candidates, deferredCandidates)
      }
    } catch (error) {
      this.db.failRequirementMatchRun(
        runId,
        error instanceof TaskCancelledError ? 'MATCH_CANCELLED' : error instanceof Error ? error.name || 'MATCH_RUN_FAILED' : 'MATCH_RUN_FAILED'
      )
      throw error
    } finally {
      this.pending.delete(runId)
    }
  }

  markStaleForRecordChange(): void {
    this.db.markRequirementMatchRunsStale()
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    throw signal.reason instanceof TaskCancelledError ? signal.reason : new TaskCancelledError()
  }

  private async completeDeferredExplanations(
    runId: string,
    request: RequirementMatchRequest,
    persisted: Array<RequirementMatchCandidateResult & { recordSnapshotHash: string }>,
    candidates: HybridRequirementCandidate[]
  ): Promise<void> {
    const outcome = await this.core.explainCandidates(request, candidates)
    const targetUids = new Set(candidates.map((candidate) => candidate.record.uid))
    const degradationCodes = [...new Set(outcome.degradationCodes)]
    const updates = persisted
      .filter((candidate) => targetUids.has(candidate.recordUid))
      .map((candidate) => {
        const explanation = outcome.explanations.get(candidate.recordUid) ?? null
        return {
          recordUid: candidate.recordUid,
          explanation,
          explanationStatus: explanation ? 'available' as const : 'unavailable' as const,
          degradationCodes: [...new Set([...candidate.degradationCodes, ...degradationCodes])]
        }
      })
    try {
      this.db.updateRequirementMatchExplanations(runId, updates, degradationCodes)
    } catch {
      // The ranked result is already durable. Explanation enrichment is best-effort.
    }
  }
}
