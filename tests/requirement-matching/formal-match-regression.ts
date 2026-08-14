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
import {
  buildRequirementSemanticCard,
  buildRequirementSourceView,
  type RequirementAction,
  type RequirementMatchCard,
  type RequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../../src/main/requirements/semanticization-service'
import type { ModelSettings, RecordDetail, ChatResponse } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'generic-formal-match-regression-model',
  thinking: true
}

const semanticContext = {
  analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  modelSignature: requirementSemanticModelSignature(settings)
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
    name: string
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

const aiCard = (
  record: RecordDetail,
  overrides: {
    action?: RequirementAction
    functionalObject?: string
    currentState?: string
    targetState?: string
    constraints?: string
  } = {}
): RequirementSemanticCard => {
  const source = buildRequirementSemanticCard(record)
  const functionalObject = overrides.functionalObject ?? 'generic image import validation'
  const action = overrides.action ?? 'add_capability'
  const currentState = overrides.currentState ?? ''
  const targetState = overrides.targetState ?? 'images are imported and validated on the platform'
  const constraints = overrides.constraints ?? ''
  return {
    ...source,
    functionalObject,
    action,
    currentState,
    targetState,
    constraints,
    matchingText: `${source.evidence}\nFunctional object: ${functionalObject}\nAction: ${action}\nCurrent state: ${currentState}\nTarget state: ${targetState}\nConstraints: ${constraints}`,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: functionalObject, confidence: 0.98, evidence: source.evidence },
      action: { value: action, confidence: 0.98, evidence: source.evidence },
      currentState: { value: currentState, confidence: currentState ? 0.98 : 0, evidence: source.evidence },
      constraints: { value: constraints, confidence: constraints ? 0.98 : 0, evidence: source.evidence },
      targetState: { value: targetState, confidence: 0.98, evidence: source.evidence }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: 'generic formal-match regression fixture'
  }
}

const persistReadyCard = (
  db: AppDatabase,
  record: RecordDetail,
  card: RequirementSemanticCard
): void => {
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash, `fixture record has no content hash: ${record.uid}`)
  assert.equal(
    db.claimRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    true,
    `fixture semantic-card claim failed: ${record.uid}`
  )
  db.completeRequirementSemanticCard(record.uid, card)
  assert.ok(
    db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    `fixture semantic card was not ready: ${record.uid}`
  )
}

const candidateFor = (
  record: RecordDetail,
  card: RequirementMatchCard,
  retrievalScore = 0.5
): HybridRequirementCandidate => ({
  record,
  card,
  denseScore: retrievalScore,
  lexicalScore: retrievalScore,
  structuralScore: retrievalScore,
  retrievalScore,
  snippet: record.description
})

const parsePrompt = (input: ModelChatInput): ExplanationPrompt => {
  const content = input.messages.at(-1)?.content ?? '{}'
  return JSON.parse(content) as ExplanationPrompt
}

const explanationModel = (mode: ExplanationMode = 'valid'): ExplanationModel => {
  const model: ExplanationModel = {
    calls: 0,
    inputs: [],
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        model.inputs.push(input)
        if (mode === 'throw') throw new Error('generic AI review unavailable')
        const payload = parsePrompt(input)
        const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
        const items = (payload.candidates ?? []).map((candidate, index) => {
          const sameTarget = candidate.functionalObject === 'generic image import validation'
          const item: Record<string, unknown> = {
            recordUid: candidate.recordUid,
            relation: sameTarget ? 'duplicate' : 'topic_only',
            similarities: ['Both requirements mention importing images on a platform.'],
            differences: [sameTarget
              ? 'The target behavior is the same.'
              : 'The candidate configures a different target capability.'],
            baseEvidence,
            candidateEvidence: candidate.evidenceSegments?.[0]?.id ?? `C${String(index + 1).padStart(3, '0')}`
          }
          if (mode === 'unknown-uid' && index === 0) item.recordUid = 'generic-unknown-returned-uid'
          if (mode === 'invalid-evidence' && index === 0) {
            item.baseEvidence = 'B999'
            item.candidateEvidence = 'C999'
          }
          if (mode === 'invalid-relation' && index === 0) item.relation = 'not-a-real-relation'
          return item
        })
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({ summary: 'Generic AI semantic review completed.', items })
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
  matchModelSignature: string,
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
    modelClient: model.client,
    semanticContext,
    matchModelSignature,
    embeddingModelVersion: 'generic-formal-match-embedding-v1'
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

const setupFormalFixtures = (db: AppDatabase): {
  base: RecordDetail
  duplicate: RecordDetail
  sharedWordsDifferentTarget: RecordDetail
  candidates: HybridRequirementCandidate[]
} => {
  const base = upsert(db, {
    uid: 'generic-formal-base-uid',
    itemId: 'GENERIC-BASE-001',
    name: 'Generic platform image import validation',
    description: '<p>The platform imports image files and validates dimensions.</p>'
  })
  const duplicate = upsert(db, {
    uid: 'generic-same-target-uid',
    itemId: 'GENERIC-CANDIDATE-SAME-TARGET',
    name: 'Generic same target image import validation',
    description: '<p>The platform imports image files and validates dimensions.</p>'
  })
  const sharedWordsDifferentTarget = upsert(db, {
    uid: 'generic-shared-words-different-target-uid',
    itemId: 'GENERIC-CANDIDATE-DIFFERENT-TARGET',
    name: 'Generic platform image import permission setup',
    description: '<p>The platform imports images into a media library and configures export permissions.</p>'
  })
  persistReadyCard(db, base, aiCard(base))
  persistReadyCard(db, duplicate, aiCard(duplicate))
  const differentTargetCard = buildRequirementSourceView(sharedWordsDifferentTarget)
  return {
    base,
    duplicate,
    sharedWordsDifferentTarget,
    candidates: [
      candidateFor(duplicate, aiCard(duplicate), 0.45),
      candidateFor(sharedWordsDifferentTarget, differentTargetCard, 0.9)
    ]
  }
}

const testRerankerOnlySortAndAiDuplicateDecision = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const fixture = setupFormalFixtures(db)
    const model = explanationModel()
    const rerankerCalls: string[][] = []
    const explainProgress: string[] = []
    const response = await createAgent(
      db,
      fixture.candidates,
      model,
      new Map([
        [fixture.duplicate.uid, 12],
        [fixture.sharedWordsDifferentTarget.uid, 99]
      ]),
      'generic-formal-match-valid-v1',
      rerankerCalls,
      (event) => {
        const status = event as { type?: string; stage?: string; message?: string }
        if (status.type === 'status' && status.stage === 'explain' && status.message) {
          explainProgress.push(status.message)
        }
      }
    ).ask({ question: 'Analyze requirement GENERIC-BASE-001' })

    assert.deepEqual(rerankerCalls, [[fixture.duplicate.uid, fixture.sharedWordsDifferentTarget.uid]])
    assert.equal(model.calls, 1, 'Top10 semantic review must use one batch AI call')
    assert.equal(model.inputs[0]?.forceThinking, true)
    assert.equal(model.inputs[0]?.numPredict, -1, 'deep-thinking review must not use a token ceiling')
    assert.equal(model.inputs[0]?.timeoutMs, 120_000, 'timeout remains the stalled-model safety boundary')
    const format = JSON.stringify(model.inputs[0]?.format ?? {})
    assert.match(format, /relation/, 'AI review schema must require relation')
    assert.doesNotMatch(format, /finalScore/, 'Cross-Encoder/score must not be delegated to AI review')
    const prompt = parsePrompt(model.inputs[0]!)
    assert.deepEqual(
      prompt.candidates?.map((candidate) => candidate.recordUid).sort(),
      [fixture.duplicate.uid, fixture.sharedWordsDifferentTarget.uid].sort(),
      'Top10 AI review must receive every selected candidate'
    )

    const formal = formalRowsOf(response)
    assert.deepEqual(
      formal.map((row) => row.uid),
      [fixture.duplicate.uid],
      'AI duplicate decision may become formal even when its reranker score is lower'
    )
    assert.ok(
      ['duplicate', 'highly_similar'].includes(String(formal[0]?.values.relation)),
      'validated AI relation must remain a formal relation'
    )
    assert.equal(formal[0]?.values.rerankerScore, '12.0%')
    assert.match(
      String(formal[0]?.values.sharedEvidence),
      /Both requirements mention/,
      `explain progress: ${explainProgress.join(' | ')}`
    )
    assert.match(String(formal[0]?.values.evidence), /基准：名称：Generic platform image import validation；候选：名称：Generic same target image import validation/)
    assert.equal(formal[0]?.values.explanationStatus, '实时 AI 语义复核已校验')
    const scoreDetails = JSON.parse(String(formal[0]?.values.scoreDetails)) as {
      decisionPath?: string
      confidenceBasis?: unknown
    }
    assert.equal(typeof scoreDetails.decisionPath, 'string')
    assert.ok(Array.isArray(scoreDetails.confidenceBasis))
    assert.ok(
      !formal.some((row) => row.uid === fixture.sharedWordsDifferentTarget.uid),
      'different target sharing import/image/platform words must not become formal'
    )
    assert.ok(rowsOf(response).every((row) => (
      !/<(?:p|strong|br)\b/i.test(String(row.values.description))
    )), 'output descriptions must not expose HTML tags')
    assert.doesNotMatch(response.answer, /<\/?(?:p|strong|br)\b/i, 'answer descriptions must not expose HTML tags')
  })
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
  const nearCard = buildRequirementSourceView(nearDuplicate)
  const boundaryCard = buildRequirementSourceView(boundary)
  return {
    base,
    nearDuplicate,
    boundary,
    candidates: [
      candidateFor(nearDuplicate, nearCard, 0.45),
      candidateFor(boundary, boundaryCard, 0.9)
    ]
  }
}

const testNearTextDuplicateSurvivesAiFailure = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const fixture = setupNearDuplicateFixtures(db)
    assert.equal(db.getRequirementSemanticCardState(fixture.base.uid), null)
    assert.equal(db.getRequirementSemanticCardState(fixture.nearDuplicate.uid), null)
    const model = explanationModel('throw')
    const response = await createAgent(
      db,
      fixture.candidates,
      model,
      new Map([
        [fixture.nearDuplicate.uid, 12],
        [fixture.boundary.uid, 99]
      ]),
      'generic-near-duplicate-path-v1',
      []
    ).ask({ question: 'Analyze requirement GENERIC-NEAR-BASE' })

    assert.equal(model.calls, 1, 'non-deterministic boundary candidates still use one batch AI review')
    assert.deepEqual(
      formalRowsOf(response).map((row) => row.uid),
      [fixture.nearDuplicate.uid],
      'cleaned near-duplicate text must remain formal when AI fails'
    )
    assert.equal(formalRowsOf(response)[0]?.values.relation, 'duplicate')
    const scoreDetails = JSON.parse(String(formalRowsOf(response)[0]?.values.scoreDetails)) as {
      decisionPath?: string
      confidenceBasis?: unknown
    }
    assert.equal(scoreDetails.decisionPath, 'near_duplicate_text')
    assert.ok(Array.isArray(scoreDetails.confidenceBasis))
    assert.ok(
      !formalRowsOf(response).some((row) => row.uid === fixture.boundary.uid),
      'high reranker score cannot formalize a source-only boundary candidate'
    )
  })
}

const setupStrongSemanticFixtures = (db: AppDatabase): {
  base: RecordDetail
  strongCandidate: RecordDetail
  boundary: RecordDetail
  candidates: HybridRequirementCandidate[]
} => {
  const base = upsert(db, {
    uid: 'generic-semantic-base-uid',
    itemId: 'GENERIC-SEMANTIC-BASE',
    name: 'Generic intake rule definition',
    description: 'Operators submit source files for ingestion.'
  })
  const strongCandidate = upsert(db, {
    uid: 'generic-semantic-strong-uid',
    itemId: 'GENERIC-SEMANTIC-STRONG',
    name: 'Generic media safeguard configuration',
    description: 'The service accepts media payloads and applies validation gates.'
  })
  const boundary = upsert(db, {
    uid: 'generic-semantic-boundary-uid',
    itemId: 'GENERIC-SEMANTIC-BOUNDARY',
    name: 'Generic platform image import permission setup',
    description: 'The platform imports images into a media library and configures export permissions.'
  })
  const semanticFields = {
    functionalObject: 'generic image ingestion validation',
    action: 'add_capability' as const,
    currentState: 'incoming images lack validation',
    targetState: 'incoming images are validated before storage',
    constraints: 'reject unsupported image formats'
  }
  const baseCard = aiCard(base, semanticFields)
  const strongCard = aiCard(strongCandidate, semanticFields)
  persistReadyCard(db, base, baseCard)
  persistReadyCard(db, strongCandidate, strongCard)
  return {
    base,
    strongCandidate,
    boundary,
    candidates: [
      candidateFor(strongCandidate, strongCard, 0.45),
      candidateFor(boundary, buildRequirementSourceView(boundary), 0.9)
    ]
  }
}

const testStrongSemanticCardSurvivesAiFailure = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const fixture = setupStrongSemanticFixtures(db)
    const model = explanationModel('throw')
    const response = await createAgent(
      db,
      fixture.candidates,
      model,
      new Map([
        [fixture.strongCandidate.uid, 14],
        [fixture.boundary.uid, 98]
      ]),
      'generic-strong-semantic-path-v1',
      []
    ).ask({ question: 'Analyze requirement GENERIC-SEMANTIC-BASE' })

    assert.equal(model.calls, 1, 'boundary candidates must still have one batch AI review')
    const formal = formalRowsOf(response)
    assert.deepEqual(
      formal.map((row) => row.uid),
      [fixture.strongCandidate.uid],
      'strong agreement across ready semantic fields must survive AI failure'
    )
    assert.ok(['duplicate', 'highly_similar'].includes(String(formal[0]?.values.relation)))
    const scoreDetails = JSON.parse(String(formal[0]?.values.scoreDetails)) as {
      decisionPath?: string
      confidenceBasis?: unknown
    }
    assert.equal(scoreDetails.decisionPath, 'semantic_card')
    assert.ok(Array.isArray(scoreDetails.confidenceBasis))
    assert.ok(!formal.some((row) => row.uid === fixture.boundary.uid))
  })
}

const testAiFailureAndInvalidReviewFailClosed = async (): Promise<void> => {
  const modes: ExplanationMode[] = ['throw', 'unknown-uid', 'invalid-evidence', 'invalid-relation']
  for (const mode of modes) {
    await withDatabase(async (db) => {
      const fixture = setupFormalFixtures(db)
      const model = explanationModel(mode)
      const response = await createAgent(
        db,
        fixture.candidates,
        model,
        new Map([
          [fixture.duplicate.uid, 95],
          [fixture.sharedWordsDifferentTarget.uid, 10]
        ]),
        `generic-formal-match-invalid-${mode}`,
        []
      ).ask({ question: 'Analyze requirement GENERIC-BASE-001' })

      assert.equal(model.calls, 1, `${mode} must not trigger a repair or second review pass`)
      const formal = formalRowsOf(response)
      assert.equal(
        formal.length,
        1,
        `${mode} must preserve the independent deterministic duplicate path`
      )
      assert.equal(formal[0]?.uid, fixture.duplicate.uid)
      assert.ok(!formal.some((row) => row.uid === fixture.sharedWordsDifferentTarget.uid))
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
      'leak-uid-value',
      'leak-item-value',
      '测试用户',
      '2025-01-01',
      'P1',
      'leak-record-value',
      'UID=',
      'ItemID=',
      '创建人=',
      '创建时间=',
      'Priority=',
      'Record='
    ]) {
      assert.equal(
        searchableText.toLocaleLowerCase().includes(forbidden.toLocaleLowerCase()),
        false,
        `source-only evidence/lexicalTerms must omit metadata: ${forbidden}`
      )
    }
    assert.doesNotMatch(sourceOnly.evidence, /<[^>]+>/, 'source-only evidence must be plain text')
    assert.equal(sourceOnly.action, 'unknown')
    assert.equal(sourceOnly.functionalObject, '')
  })
}

const tests: Array<[string, () => Promise<void>]> = [
  ['Cross-Encoder only sorts and AI duplicate relation controls formal visibility', testRerankerOnlySortAndAiDuplicateDecision],
  ['cleaned near-text duplicate survives AI failure while boundary closes', testNearTextDuplicateSurvivesAiFailure],
  ['strong ready semantic-card agreement survives AI failure', testStrongSemanticCardSurvivesAiFailure],
  ['AI failure and invalid review responses preserve only deterministic confirmation', testAiFailureAndInvalidReviewFailClosed],
  ['source-only evidence and lexical terms omit metadata and HTML', testSourceOnlyCleaningAndMetadataIsolation]
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
