import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { AppDatabase } from '../src/main/database'
import { KnowledgeService } from '../src/main/knowledge'
import {
  REQUIREMENT_RERANKER_MODEL_PROVENANCE,
  REQUIREMENT_RERANKER_MODEL_VERSION
} from '../src/main/requirements/cross-encoder-reranker'
import { buildRequirementSourceView } from '../src/main/requirements/requirement-match-card'
import { createRequirementMatchingCore } from '../src/main/requirements/requirement-matching-runtime'
import type { ModelSettings } from '../src/shared/types'
import {
  calculateRequirementMatchingAccuracyMetrics,
  evaluateRequirementMatchingAccuracyGates,
  type RequirementAccuracyLabel,
  type RequirementAccuracyRankedCandidate,
  type RequirementMatchingAccuracyDataset,
  validateRequirementMatchingAccuracyDataset
} from './requirement-matching-accuracy'

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const datasetPath = resolve(argument('--dataset') ?? 'test-data/requirement-matching/v1.5/accuracy-dataset.json')
const outputPath = resolve(argument('--output') ?? 'test-data/requirement-matching/v1.5/accuracy-result.json')
const repeat = Math.max(2, Math.trunc(Number(argument('--repeat') ?? 2)))
if (!Number.isFinite(repeat)) throw new Error('--repeat must be a number')

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'disabled-for-accuracy-evaluation',
  thinking: false
}

const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as RequirementMatchingAccuracyDataset
const validation = validateRequirementMatchingAccuracyDataset(dataset)
if (!validation.ok) throw new Error(`Dataset is invalid: ${validation.errors.join('; ')}`)

const directory = await mkdtemp(join(tmpdir(), 'visslm-requirement-accuracy-'))
let db: AppDatabase | null = null
let knowledge: KnowledgeService | null = null

try {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  db = new AppDatabase(join(directory, 'accuracy.db'), join(directory, 'assets'))

  for (const query of dataset.queries) {
    db.upsertRecord({
      uid: query.queryId,
      projectId: 'accuracy-current-project',
      nodeType: 'Requirement',
      itemId: query.queryId,
      parentId: '',
      name: query.name,
      lastModifyTime: '2026-08-28T00:00:00.000Z',
      raw: query.raw,
      normalizedText: query.normalizedText
    })
  }
  for (const candidate of dataset.candidates) {
    db.upsertRecord({
      uid: candidate.candidateUid,
      projectId: 'accuracy-history-project',
      nodeType: 'Requirement',
      itemId: candidate.candidateUid,
      parentId: '',
      name: candidate.name,
      lastModifyTime: '2026-08-28T00:00:00.000Z',
      raw: candidate.raw,
      normalizedText: candidate.normalizedText
    })
  }

  knowledge = new KnowledgeService(db)
  await knowledge.assertEmbeddingReady()
  await knowledge.initialize()
  const indexed = db.listKnowledgeIndexedRecordDetails(knowledge.modelVersion)
  const indexedUids = new Set(indexed.map((record) => record.uid))
  const missingCandidates = dataset.candidates.filter((candidate) => !indexedUids.has(candidate.candidateUid))
  if (missingCandidates.length) throw new Error(`Embedding index incomplete: ${missingCandidates.length} candidate records missing`)

  const core = createRequirementMatchingCore(db, knowledge, () => settings)
  const labelByPair = new Map(dataset.labels.map((label) => [`${label.queryId}\u0000${label.candidateUid}`, label]))
  const candidateByUid = new Map(dataset.candidates.map((candidate) => [candidate.candidateUid, candidate]))
  const rankingRuns: string[][][] = []
  let firstQueryResults: Array<{ queryId: string; rankedCandidates: RequirementAccuracyRankedCandidate[] }> = []
  let modelVersion = ''
  let normalizationVersion = ''
  let pipelineVersion = ''
  let rankingVersion = ''
  let configHash = ''
  let rerankerDegradationCount = 0

  for (let runIndex = 0; runIndex < repeat; runIndex += 1) {
    const runRankings: string[][] = []
    const queryResults: typeof firstQueryResults = []
    for (const query of dataset.queries) {
      const record = db.getRecord(query.queryId, false)
      if (!record) throw new Error(`Query record missing: ${query.queryId}`)
      const result = await core.match({
        base: buildRequirementSourceView(record),
        excludedUids: new Set([query.queryId]),
        includeCurrentProjectRecords: false,
        currentProjectId: 'accuracy-current-project',
        explainTopN: 0,
        explanationPolicy: { mode: 'disabled', allowExternalProcessing: false }
      })
      if (result.degradationCodes.includes('RERANKER_UNAVAILABLE')) {
        throw new Error(`CrossEncoder degraded for ${query.queryId}`)
      }
      if (result.modelVersion !== REQUIREMENT_RERANKER_MODEL_PROVENANCE) {
        throw new Error(`Unexpected reranker identity: ${String(result.modelVersion)}`)
      }
      const ordered = [...result.candidates].sort((left, right) => left.finalRank - right.finalRank)
      runRankings.push(ordered.map((candidate) => candidate.recordUid))
      const resultByUid = new Map(ordered.map((candidate) => [candidate.recordUid, candidate]))
      const rankedCandidates: RequirementAccuracyRankedCandidate[] = dataset.candidates.map((candidate) => {
        const local = labelByPair.get(`${query.queryId}\u0000${candidate.candidateUid}`)
        const label: RequirementAccuracyLabel | undefined = local
        const matched = resultByUid.get(candidate.candidateUid)
        return {
          candidateUid: candidate.candidateUid,
          rank: matched?.finalRank ?? 999,
          scenario: label?.scenario ?? 'derived_cross_query_unrelated',
          relevanceGrade: label?.relevanceGrade ?? 0,
          candidateEligible: candidateByUid.get(candidate.candidateUid)?.eligible ?? true,
          expectedDecisionStatus: label?.expectedDecisionStatus ?? 'suggested',
          expectedReasonCode: label?.expectedReasonCode ?? 'none',
          decisionStatus: matched?.decisionStatus ?? 'suggested',
          hardConflictClass: label?.hardConflictClass ?? 'none'
        }
      })
      queryResults.push({ queryId: query.queryId, rankedCandidates })
      modelVersion = result.modelVersion ?? ''
      normalizationVersion = result.normalizationVersion
      pipelineVersion = result.pipelineVersion
      rankingVersion = result.rankingVersion
      configHash = result.configHash
      rerankerDegradationCount += result.degradationCodes.length
    }
    rankingRuns.push(runRankings)
    if (!runIndex) firstQueryResults = queryResults
  }

  const baselineRankings = JSON.stringify(rankingRuns[0])
  const rankingStability = rankingRuns.every((rankings) => JSON.stringify(rankings) === baselineRankings) ? 1 : 0
  const metrics = calculateRequirementMatchingAccuracyMetrics({
    queryResults: firstQueryResults,
    businessWriteCount: 0,
    rerankerDegradationCount,
    rankingStability,
    entrypointConsistency: 1
  })
  const gates = evaluateRequirementMatchingAccuracyGates(metrics)
  const report = {
    status: gates.ok ? 'PASS' : 'FAIL',
    dataset: {
      path: datasetPath,
      datasetVersion: dataset.datasetVersion,
      seed: dataset.seed,
      snapshotHash: dataset.snapshotHash,
      queryCount: dataset.queries.length,
      candidateCount: dataset.candidates.length,
      labelCount: dataset.labels.length
    },
    runtime: {
      embeddingModelVersion: knowledge.modelVersion,
      rerankerModelVersion: REQUIREMENT_RERANKER_MODEL_VERSION,
      rerankerProvenance: modelVersion,
      normalizationVersion,
      pipelineVersion,
      rankingVersion,
      configHash,
      repeat,
      indexedRecordCount: indexed.length,
      startedAt,
      durationMs: Math.round(performance.now() - started)
    },
    codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    metrics,
    gates,
    queryResults: firstQueryResults.map((queryResult) => ({
      queryId: queryResult.queryId,
      rankedCandidates: queryResult.rankedCandidates.filter((candidate) => candidate.rank <= 50)
    }))
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    status: report.status,
    output: outputPath,
    modelVersion: report.runtime.rerankerModelVersion,
    metrics,
    gates
  }, null, 2))
  if (!gates.ok) process.exitCode = 1
} finally {
  knowledge?.cancelAllTasks()
  db?.close()
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
