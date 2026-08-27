import { createHash } from 'node:crypto'
import type { ProjectRequirement } from '../../shared/project-types'
import { AppDatabase } from '../database'
import { buildProjectRequirementMatchCard, buildRequirementSourceView } from './requirement-match-card'
import {
  REQUIREMENT_NORMALIZATION_VERSION,
  hashRequirementBusiness
} from './requirement-business-normalization'
import type { RequirementMatchRequest } from './requirement-match-domain'
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
    const run = this.db.createRequirementMatchRun({
      requirementId: requirement.id,
      requirementSnapshotHash,
      normalizationVersion: REQUIREMENT_NORMALIZATION_VERSION,
      pipelineVersion: REQUIREMENT_MATCH_PIPELINE_VERSION,
      rankingVersion: FULL_RERANK_RANKING_VERSION,
      configHash: 'pending',
      modelVersion: null
    })
    this.pending.set(run.id, { ...input, requirementSnapshotHash })
    return { runId: run.id }
  }

  async execute(runId: string): Promise<void> {
    const run = this.db.getRequirementMatchRun(runId)
    const pending = this.pending.get(runId)
    if (!run || run.status !== 'running' || !pending) throw new Error('待执行的需求匹配运行不存在')
    try {
      const requirement = this.db.getProjectRequirement(run.requirementId)
      if (!requirement || hashProjectRequirementSnapshot(requirement) !== run.requirementSnapshotHash) {
        this.db.failRequirementMatchRun(runId, 'REQUIREMENT_SNAPSHOT_CHANGED')
        return
      }
      const result = await this.core.match({
        base: buildProjectRequirementMatchCard(requirement),
        excludedUids: new Set<string>(),
        includeCurrentProjectRecords: false,
        explainTopN: pending.explainTopN ?? 10,
        explanationPolicy: pending.explanationPolicy
      })
      const current = this.db.getProjectRequirement(run.requirementId)
      if (!current || hashProjectRequirementSnapshot(current) !== run.requirementSnapshotHash) {
        this.db.failRequirementMatchRun(runId, 'REQUIREMENT_SNAPSHOT_CHANGED')
        return
      }
      const candidates = result.candidates.map((candidate) => {
        const record = this.db.getRecord(candidate.recordUid, false)
        const recordSnapshotHash = record ? hashRequirementBusiness(buildRequirementSourceView(record)) : ''
        return { ...candidate, recordSnapshotHash }
      })
      this.db.completeRequirementMatchRun(runId, candidates, result.degradationCodes, result)
    } catch (error) {
      this.db.failRequirementMatchRun(runId, error instanceof Error ? error.name || 'MATCH_RUN_FAILED' : 'MATCH_RUN_FAILED')
      throw error
    } finally {
      this.pending.delete(runId)
    }
  }

  markStaleForRecordChange(): void {
    this.db.markRequirementMatchRunsStale()
  }
}
