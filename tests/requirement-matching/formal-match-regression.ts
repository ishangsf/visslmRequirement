import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { RequirementAnalysisAgent } from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import type { RequirementReranker, RequirementRerankItem } from '../../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import { buildRequirementSourceView } from '../../src/main/requirements/requirement-match-card'
import type { ModelSettings, RecordDetail, ChatResponse } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'generic-formal-match-regression-model',
  thinking: true
}

type FixtureInput = {
  uid: string
  itemId: string
  name: string
  description: string
  normalizedText?: string
  raw?: Record<string, unknown>
}

type ExplanationMode = 'valid' | 'throw' | 'unknown-uid' | 'invalid-evidence' | 'invalid-relation'

type ExplanationPrompt = {
  requirement?: { evidenceSegments?: Array<{ id: string; text: string }> }
  candidates?: Array<{
    recordUid: string
    evidenceSegments?: Array<{ id: string; text: string }>
  }>
}

type ExplanationModel = {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: number
  inputs: ModelChatInput[]
}

const upsert = (db: AppDatabase, input: FixtureInput): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'generic-formal-match-regression-project',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: '2026-08-14T00:00:00.000Z',
    raw: {
      _valm_Description: input.description,
      IssueType: 'Enhancement',
      _valm_Module: 'generic-platform',
      ...(input.raw ?? {})
    },
    normalizedText: input.normalizedText ?? `${input.name}\n${input.description}`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `fixture record was not persisted: ${input.uid}`)
  return record
}

const candidateFor = (
  record: RecordDetail,
  card = buildRequirementSourceView(record),
  retrievalScore = 0.5
): HybridRequirementCandidate => ({
  record,
  card,
  denseScore: retrievalScore,
  lexicalScore: retrievalScore,
  retrievalScore,
  snippet: record.description
} as HybridRequirementCandidate)

const parsePrompt = (input: ModelChatInput): ExplanationPrompt => (
  JSON.parse(input.messages.at(-1)?.content ?? '{}') as ExplanationPrompt
)

const explanationModel = (mode: ExplanationMode = 'valid'): ExplanationModel => {
  const model: ExplanationModel = {
    calls: 0,
    inputs: [],
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        model.inputs.push(input)
        if (mode === 'throw') throw new Error('generic review unavailable')
        const payload = parsePrompt(input)
        const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
        const items = (payload.candidates ?? []).map((candidate, index) => {
          const item: Record<string, unknown> = {
            recordUid: candidate.recordUid,
            relation: mode === 'invalid-relation' && index === 0
              ? 'not-a-real-relation'
              : 'duplicate',
            similarities: ['两条需求的完整原文描述相同。'],
            differences: ['候选名称存在轻微措辞差异。'],
            baseEvidence: mode === 'invalid-evidence' && index === 0 ? 'B999' : baseEvidence,
            candidateEvidence: mode === 'invalid-evidence' && index === 0
              ? 'C999'
              : candidate.evidenceSegments?.[0]?.id ?? `C${String(index + 1).padStart(3, '0')}`
          }
          if (mode === 'unknown-uid' && index === 0) item.recordUid = 'generic-unknown-returned-uid'
          return item
        })
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({ summary: '批量原文解释完成。', items })
          }
        }
      }
    }
  }
  return model
}

const createReranker = (
  scoreByUid: ReadonlyMap<string, number>,
  calls: string[][]
): RequirementReranker => ({
  modelId: 'generic-formal-match-cross-encoder',
  async rerank(_base, candidates): Promise<RequirementRerankItem[]> {
    calls.push(candidates.map((candidate) => candidate.record.uid))
    return candidates
      .map((candidate, index) => ({
        recordUid: candidate.record.uid,
        score: scoreByUid.get(candidate.record.uid) ?? 90 - index
      }))
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
  }
})

const createAgent = (
  db: AppDatabase,
  candidates: HybridRequirementCandidate[],
  model: ExplanationModel,
  scoreByUid: ReadonlyMap<string, number>,
  rerankerCalls: string[][],
  onProgress?: (event: unknown) => void
): RequirementAnalysisAgent => new RequirementAnalysisAgent(
  db,
  {} as KnowledgeService,
  settings,
  onProgress,
  {
    retriever: {
      async retrieve(_base, excludedUids): Promise<HybridRequirementCandidate[]> {
        return candidates.filter((candidate) => !excludedUids.has(candidate.record.uid))
      }
    },
    reranker: createReranker(scoreByUid, rerankerCalls),
    modelClient: model.client
  }
)

const rowsOf = (response: ChatResponse) => response.dataViews.flatMap((view) => (
  view.groups.flatMap((group) => group.rows)
))

const formalRowsOf = (response: ChatResponse) => rowsOf(response).filter((row) => (
  row.values.relation === 'duplicate' || row.values.relation === 'highly_similar'
))

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'generic-formal-match-regression-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'regression.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const setupNearDuplicateFixtures = (db: AppDatabase): {
  base: RecordDetail
  nearDuplicate: RecordDetail
  boundary: RecordDetail
  candidates: HybridRequirementCandidate[]
} => {
  const base = upsert(db, {
    uid: 'generic-near-base-uid',
    itemId: 'GENERIC-NEAR-BASE',
    name: 'Generic image intake validation',
    description: '<p>The platform imports image files and validates dimensions.</p>'
  })
  const nearDuplicate = upsert(db, {
    uid: 'generic-near-duplicate-uid',
    itemId: 'GENERIC-NEAR-DUPLICATE',
    name: 'Generic image intake validation rule',
    description: 'The platform imports image files and validates dimensions.'
  })
  const boundary = upsert(db, {
    uid: 'generic-near-boundary-uid',
    itemId: 'GENERIC-NEAR-BOUNDARY',
    name: 'Generic platform image import permission setup',
    description: 'The platform imports images into a media library and configures export permissions.'
  })
  return {
    base,
    nearDuplicate,
    boundary,
    candidates: [
      candidateFor(nearDuplicate, undefined, 0.45),
      candidateFor(boundary, undefined, 0.9)
    ]
  }
}

const testRerankerSortAndRawDuplicateDecision = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const fixture = setupNearDuplicateFixtures(db)
    const model = explanationModel()
    const rerankerCalls: string[][] = []
    const response = await createAgent(
      db,
      fixture.candidates,
      model,
      new Map([
        [fixture.nearDuplicate.uid, 12],
        [fixture.boundary.uid, 99]
      ]),
      rerankerCalls
    ).ask({ question: 'Analyze requirement GENERIC-NEAR-BASE' })

    assert.deepEqual(rerankerCalls, [[fixture.nearDuplicate.uid, fixture.boundary.uid]])
    assert.equal(model.calls, 1, 'selected candidates must use one batch explanation call')
    const format = JSON.stringify(model.inputs[0]?.format ?? {})
    assert.match(format, /relation/)
    assert.doesNotMatch(format, /finalScore/)
    const prompt = parsePrompt(model.inputs[0]!)
    assert.deepEqual(
      prompt.candidates?.map((candidate) => candidate.recordUid).sort(),
      [fixture.nearDuplicate.uid, fixture.boundary.uid].sort()
    )
    const formal = formalRowsOf(response)
    assert.deepEqual(formal.map((row) => row.uid), [fixture.nearDuplicate.uid])
    const scoreDetails = JSON.parse(String(formal[0]?.values.scoreDetails)) as {
      decisionPath?: string
      confidenceBasis?: unknown
    }
    assert.equal(scoreDetails.decisionPath, 'near_duplicate_text')
    assert.ok(Array.isArray(scoreDetails.confidenceBasis))
    assert.equal(formal[0]?.values.rerankerScore, '12.0%')
    assert.ok(!formal.some((row) => row.uid === fixture.boundary.uid))
    assert.ok(rowsOf(response).every((row) => !/<(?:p|strong|br)\b/i.test(String(row.values.description))))
    assert.doesNotMatch(response.answer, /<\/?(?:p|strong|br)\b/i)
  })
}

const testRawDuplicateSurvivesUnavailableReview = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const fixture = setupNearDuplicateFixtures(db)
    const model = explanationModel('throw')
    const response = await createAgent(
      db,
      fixture.candidates,
      model,
      new Map([
        [fixture.nearDuplicate.uid, 12],
        [fixture.boundary.uid, 99]
      ]),
      []
    ).ask({ question: 'Analyze requirement GENERIC-NEAR-BASE' })

    assert.equal(model.calls, 1)
    assert.deepEqual(formalRowsOf(response).map((row) => row.uid), [fixture.nearDuplicate.uid])
    assert.equal(formalRowsOf(response)[0]?.values.relation, 'duplicate')
    const scoreDetails = JSON.parse(String(formalRowsOf(response)[0]?.values.scoreDetails)) as {
      decisionPath?: string
    }
    assert.equal(scoreDetails.decisionPath, 'near_duplicate_text')
    assert.ok(!formalRowsOf(response).some((row) => row.uid === fixture.boundary.uid))
  })
}

const testInvalidReviewFailsClosed = async (): Promise<void> => {
  const modes: ExplanationMode[] = ['throw', 'unknown-uid', 'invalid-evidence', 'invalid-relation']
  for (const mode of modes) {
    await withDatabase(async (db) => {
      const fixture = setupNearDuplicateFixtures(db)
      const model = explanationModel(mode)
      const response = await createAgent(
        db,
        fixture.candidates,
        model,
        new Map([
          [fixture.nearDuplicate.uid, 95],
          [fixture.boundary.uid, 10]
        ]),
        []
      ).ask({ question: 'Analyze requirement GENERIC-NEAR-BASE' })

      assert.equal(model.calls, 1, `${mode} must not trigger a repair pass`)
      assert.deepEqual(formalRowsOf(response).map((row) => row.uid), [fixture.nearDuplicate.uid])
      assert.ok(!formalRowsOf(response).some((row) => row.uid === fixture.boundary.uid))
    })
  }
}

const testSourceOnlyCleaningAndMetadataIsolation = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const record = upsert(db, {
      uid: 'generic-source-only-uid',
      itemId: 'GENERIC-SOURCE-ONLY-001',
      name: '<span>Generic platform image import</span>',
      description: '<p>Import an image into the platform.</p><script>alert(1)</script>',
      normalizedText: [
        'Generic platform image import',
        'UID=leak-uid-value',
        'ItemID=leak-item-value',
        '创建人=测试用户',
        '创建时间=2025-01-01',
        'Priority=P1',
        'Record=leak-record-value'
      ].join('\n'),
      raw: {
        UID: 'leak-uid-value',
        ItemID: 'leak-item-value',
        Creator: '测试用户',
        CreateTime: '2025-01-01',
        Priority: 'P1',
        Record: 'leak-record-value'
      }
    })
    const sourceOnly = buildRequirementSourceView(record)
    const searchableText = `${sourceOnly.evidence}\n${sourceOnly.lexicalTerms.join('\n')}`
    for (const forbidden of [
      'leak-uid-value', 'leak-item-value', '测试用户', '2025-01-01', 'P1',
      'leak-record-value', 'UID=', 'ItemID=', '创建人=', '创建时间=', 'Priority=', 'Record='
    ]) {
      assert.equal(
        searchableText.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase()),
        false,
        `source evidence/lexicalTerms must omit metadata: ${forbidden}`
      )
    }
    assert.doesNotMatch(sourceOnly.evidence, /<[^>]+>/)
    assert.deepEqual(Object.keys(sourceOnly).sort(), [
      'evidence', 'lexicalTerms', 'matchingText', 'module', 'productDomain',
      'requirementType', 'sourceDescription', 'sourceTitle'
    ].sort())
  })
}

const tests: Array<[string, () => Promise<void>]> = [
  ['Cross-Encoder ordering and source duplicate decision', testRerankerSortAndRawDuplicateDecision],
  ['raw near duplicate survives unavailable explanation', testRawDuplicateSurvivesUnavailableReview],
  ['invalid explanation responses fail closed', testInvalidReviewFailsClosed],
  ['source evidence and lexical terms omit metadata and HTML', testSourceOnlyCleaningAndMetadataIsolation]
]

const main = async (): Promise<void> => {
  const results: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = []
  for (const [name, test] of tests) {
    try {
      await test()
      results.push({ name, status: 'passed' })
    } catch (error) {
      results.push({
        name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  const failed = results.filter((result) => result.status === 'failed')
  console.log(JSON.stringify({
    ok: failed.length === 0,
    contract: 'generic-formal-match-regression',
    results
  }))
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
