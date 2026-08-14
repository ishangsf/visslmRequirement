import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { AppDatabase } from '../src/main/database'
import { RequirementAnalysisAgent, extractRequirementAnalysisIds } from '../src/main/experts/requirement-analysis-agent'
import type { RequirementReranker, RequirementRerankItem } from '../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../src/main/requirements/hybrid-retrieval'
import { buildRequirementSemanticCard, type RequirementSemanticCard } from '../src/main/requirements/semantic-card'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../src/main/requirements/semanticization-service'
import type { KnowledgeService } from '../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import type { ModelSettings, RecordDetail } from '../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-model',
  thinking: false
}

const semanticContext = {
  analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  modelSignature: requirementSemanticModelSignature(settings)
}

const upsert = (db: AppDatabase, input: {
  uid: string
  itemId: string
  name: string
  description: string
  issueType?: string
  module?: string
  persistCard?: boolean
}): void => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'project-requirement-matching-smoke',
    nodeType: 'TSIssue',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date().toISOString(),
    raw: {
      _valm_Description: input.description,
      IssueType: input.issueType ?? 'Enhancement',
      _valm_Module: input.module ?? '需求管理'
    },
    normalizedText: `${input.name}\n${input.description}\n${input.module ?? '需求管理'}`
  })
  if (input.persistCard !== false) persistReadySemanticCard(db, input.uid)
}

const persistReadySemanticCard = (db: AppDatabase, uid: string): RequirementSemanticCard => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `missing fixture record ${uid}`)
  const source = buildRequirementSemanticCard(record)
  const object = record.name || record.itemId
  const card: RequirementSemanticCard = {
    ...source,
    functionalObject: object,
    matchingText: source.evidence,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: object, confidence: 0.95, evidence: source.evidence.slice(0, 32) }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: '需求分析 smoke 预置的 AI 语义裁决卡片'
  }
  const contentHash = db.getRecordContentHash(uid)
  assert.ok(contentHash)
  assert.equal(db.claimRequirementSemanticCard({ recordUid: uid, contentHash, ...semanticContext }), true)
  db.completeRequirementSemanticCard(uid, card)
  return card
}

const candidateFor = (db: AppDatabase, uid: string, denseScore = 82): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `missing fixture record ${uid}`)
  const contentHash = db.getRecordContentHash(uid)
  assert.ok(contentHash)
  const card = db.getReadyRequirementSemanticCard({ recordUid: uid, contentHash, ...semanticContext })
    ?? buildRequirementSemanticCard(record)
  return {
    record,
    card,
    denseScore,
    lexicalScore: denseScore - 3,
    structuralScore: denseScore - 5,
    retrievalScore: denseScore / 100,
    snippet: record.description
  }
}

const deterministicReranker = (scoreByUid: ReadonlyMap<string, number>): RequirementReranker => ({
  modelId: 'smoke-reranker',
  async rerank(_base, candidates): Promise<RequirementRerankItem[]> {
    return candidates
      .map((candidate) => ({ recordUid: candidate.record.uid, score: scoreByUid.get(candidate.record.uid) ?? 50 }))
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
  }
})

type ExplanationMode = 'missing' | 'unknown' | 'duplicate' | 'forbidden' | 'invalid-evidence' | 'empty'

const explanationContent = (input: ModelChatInput, options: {
  malformed?: ExplanationMode
} = {}): string => {
  const message = input.messages.at(-1)?.content ?? '{}'
  const payload = JSON.parse(message) as {
    requirement?: { evidenceSegments?: Array<{ id: string; text: string }> }
    candidates?: Array<{ recordUid: string; evidenceSegments?: Array<{ id: string; text: string }> }>
  }
  if (options.malformed === 'empty') return ''
  const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
  const item = (candidate: { recordUid: string; evidenceSegments?: Array<{ id: string; text: string }> }) => ({
      recordUid: candidate.recordUid,
      relation: 'partial_overlap',
      similarities: ['两条需求都涉及同一业务场景。'],
      differences: ['目标范围或操作动作存在差异。'],
      baseEvidence,
      candidateEvidence: candidate.evidenceSegments?.[0]?.id ?? 'C001'
    })
  const candidates = payload.candidates ?? []
  if (options.malformed === 'missing') return JSON.stringify({ summary: '缺少候选解释。', items: candidates.slice(0, 1).map(item) })
  if (options.malformed === 'unknown') return JSON.stringify({ summary: '包含未知 UID。', items: [{ ...item(candidates[0] ?? { recordUid: 'missing' }), recordUid: 'unknown-smoke-uid' }] })
  if (options.malformed === 'duplicate') {
    const first = candidates[0] ? item(candidates[0]) : { recordUid: 'missing', similarities: ['相似'], differences: ['差异'], baseEvidence, candidateEvidence: 'C001' }
    return JSON.stringify({ summary: '包含重复 UID。', items: [first, first] })
  }
  if (options.malformed === 'forbidden') {
    return JSON.stringify({
      summary: '包含禁止的决策字段。',
      items: candidates.map((candidate) => ({ ...item(candidate), relation: 'duplicate', score: 99 }))
    })
  }
  if (options.malformed === 'invalid-evidence') {
    return JSON.stringify({
      summary: '包含不在原文中的证据。',
      items: candidates.map((candidate) => ({ ...item(candidate), baseEvidence: 'B999', candidateEvidence: 'C999' }))
    })
  }
  return JSON.stringify({ summary: '固定 smoke fixture 的批量解释完成。', items: candidates.map(item) })
}

const fakeModel = (
  options: { malformed?: ExplanationMode } = {},
  onInput?: (input: ModelChatInput) => void
): { client: { chat(input: ModelChatInput): Promise<ModelResponse> }; getCallCount: () => number } => {
  let callCount = 0
  return {
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        callCount += 1
        onInput?.(input)
        return { message: { role: 'assistant', content: explanationContent(input, options) } }
      }
    },
    getCallCount: () => callCount
  }
}

const createRetriever = (
  db: AppDatabase,
  candidatesByBaseItemId: ReadonlyMap<string, string[]>,
  onRetrieve?: (baseItemId: string, excludedUids: Set<string>) => void
): { retrieve: (base: ReturnType<typeof buildRequirementSemanticCard>, excludedUids: Set<string>) => Promise<HybridRequirementCandidate[]>; getCallCount: () => number } => {
  let callCount = 0
  return {
    async retrieve(base, excludedUids): Promise<HybridRequirementCandidate[]> {
      callCount += 1
      const baseItemId = base.evidence.includes('订单编号') ? 'REQ-1' : 'REQ-2'
      onRetrieve?.(baseItemId, excludedUids)
      return (candidatesByBaseItemId.get(baseItemId) ?? [])
        .filter((uid) => !excludedUids.has(uid))
        .map((uid, index) => candidateFor(db, uid, 90 - index))
    },
    getCallCount: () => callCount
  }
}

type SmokeRetriever = {
  retrieve(base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]>
}

const createAgent = (
  db: AppDatabase,
  retriever: SmokeRetriever,
  model: { client: { chat(input: ModelChatInput): Promise<ModelResponse> } },
  options: {
    reranker?: RequirementReranker
    matchModelSignature?: string
    embeddingModelVersion?: string
    onProgress?: (event: unknown) => void
  } = {}
): RequirementAnalysisAgent => new RequirementAnalysisAgent(
  db,
  {} as KnowledgeService,
  settings,
  options.onProgress,
  {
    retriever,
    reranker: options.reranker ?? deterministicReranker(new Map()),
    modelClient: model.client,
    semanticContext,
    matchModelSignature: options.matchModelSignature,
    embeddingModelVersion: options.embeddingModelVersion
  }
)

const rowsOf = (response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>) => (
  response.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows))
)

const rowFor = (
  response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>,
  itemId: string
): ReturnType<typeof rowsOf>[number] | undefined => rowsOf(response).find((row) => row.itemId === itemId)

const runHappyPath = async (db: AppDatabase): Promise<void> => {
  let orderIssueType = ''
  let orderEvidence = ''
  const modelInputs: ModelChatInput[] = []
  const retriever = createRetriever(db, new Map([
    ['REQ-1', ['match-order', 'match-topic']],
    ['REQ-2', ['match-stock', 'match-pattern']]
  ]))
  const model = fakeModel({}, (input) => {
    modelInputs.push(input)
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
      requirement?: { requirementType?: string; evidence?: string }
    }
    orderIssueType ||= payload.requirement?.requirementType ?? ''
    orderEvidence ||= payload.requirement?.evidence ?? ''
  })
  const reranker = deterministicReranker(new Map([
    ['match-order', 95],
    ['match-topic', 72],
    ['match-stock', 94],
    ['match-pattern', 70]
  ]))
  const agent = new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    { retriever, reranker, modelClient: model.client, semanticContext }
  )
  const response = await agent.ask({ question: '@需求分析专家 分析需求编号 REQ-1、REQ-2' })

  assert.equal(retriever.getCallCount(), 2, 'multi-ID input should retrieve each base independently')
  assert.equal(model.getCallCount(), 2, 'each base must receive one batch explanation call')
  assert.ok(modelInputs.every((input) => {
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as Record<string, unknown>
    return !Object.prototype.hasOwnProperty.call(payload, 'relation') &&
      !Object.prototype.hasOwnProperty.call(payload, 'score')
  }), 'explanation prompts must not carry model-owned relation or score fields')
  assert.equal(orderIssueType, 'Enhancement', 'IssueType must come from the real raw field')
  assert.ok(orderEvidence.includes('"订单" & 详情'), 'HTML entities/tags must be normalized before model evidence')
  assert.ok(!orderEvidence.includes('&quot;') && !orderEvidence.includes('<p>'), 'raw HTML must not reach the model')
  assert.equal(response.dataViews.length, 1)
  assert.ok(response.dataViews[0]?.groups.length >= 1, 'deterministic results must remain grouped per base')
  assert.ok(rowFor(response, 'DATA-1'), 'deterministic scoring must retain the highest-ranked order candidate')
  assert.equal(rowFor(response, 'DATA-1')?.values.requirementType, 'Enhancement')
  assert.ok(rowsOf(response).every((row) => typeof row.values.relation === 'string' && typeof row.values.matchScore === 'string'))
  assert.match(response.answer, /REQ-1 · 订单查询/)
  assert.match(response.answer, /DATA-1 · 订单详情检索/)
  assert.match(response.answer, /一次批量 AI 语义复核/)
}

const runExplanationFallbackAndValidation = async (db: AppDatabase): Promise<void> => {
  const modes: ExplanationMode[] = ['missing', 'unknown', 'duplicate', 'forbidden', 'invalid-evidence', 'empty']
  const base = 'base-order'
  const candidate = 'match-order'
  const retriever = {
    async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return excludedUids.has(base)
        ? [candidateFor(db, candidate, 90), candidateFor(db, 'match-topic', 80)]
        : []
    }
  }
  const validModel = fakeModel()
  const baseline = await createAgent(db, retriever, validModel, { matchModelSignature: 'smoke-baseline-v1' })
    .ask({ question: '分析需求编号 REQ-1' })
  const baselineRow = rowFor(baseline, 'DATA-1')
  assert.ok(baselineRow)
  const baselineDecision = {
    relation: baselineRow.values.relation,
    matchScore: baselineRow.values.matchScore
  }

  for (const mode of modes) {
    const model = fakeModel({ malformed: mode })
    const response = await createAgent(db, retriever, model, {
      matchModelSignature: `smoke-malformed-${mode}`
    }).ask({ question: '分析需求编号 REQ-1' })
    const row = rowFor(response, 'DATA-1')
    assert.ok(row, `${mode} explanation failure must retain deterministic output`)
    assert.deepEqual(
      { relation: row.values.relation, matchScore: row.values.matchScore },
      baselineDecision,
      `${mode} explanation failure must not alter deterministic relation or score`
    )
    assert.equal(model.getCallCount(), 1, `${mode} must use one batch call and no repair pass`)
    assert.equal(row.values.explanationStatus, 'AI 语义复核暂不可用，正式关系已降级并保留召回审计')
  }
}

const runSourceOnlyMatching = async (db: AppDatabase): Promise<void> => {
  upsert(db, {
    uid: 'source-only-base', itemId: 'SOURCE-ONLY-BASE', name: '原文基准',
    description: '需求管理页面支持查询订单详情。', module: '需求管理', persistCard: false
  })
  upsert(db, {
    uid: 'source-only-candidate', itemId: 'SOURCE-ONLY-CANDIDATE', name: '原文候选',
    description: '需求管理页面支持查询订单明细。', module: '需求管理', persistCard: false
  })
  const modelInputs: ModelChatInput[] = []
  const model = fakeModel({}, (input) => modelInputs.push(input))
  const retriever = {
    async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return excludedUids.has('source-only-base') ? [candidateFor(db, 'source-only-candidate', 95)] : []
    }
  }
  const response = await createAgent(db, retriever, model).ask({ question: '分析需求编号 SOURCE-ONLY-BASE' })
  const payload = JSON.parse(modelInputs[0]?.messages.at(-1)?.content ?? '{}') as {
    requirement?: { semanticCardStatus?: string }
    candidates?: Array<{ recordUid: string; semanticCardStatus?: string }>
  }
  assert.equal(payload.requirement?.semanticCardStatus, 'source_only')
  assert.deepEqual(payload.candidates?.map((item) => [item.recordUid, item.semanticCardStatus]), [
    ['source-only-candidate', 'source_only']
  ])
  assert.equal(db.getRequirementSemanticCardState('source-only-base'), null, 'matching must not create a base semantic card')
  assert.equal(db.getRequirementSemanticCardState('source-only-candidate'), null, 'matching must not create a candidate semantic card')
  assert.equal(model.getCallCount(), 1)
  assert.ok(response.sources.some((source) => source.uid === 'source-only-candidate'))
}

const runTopBounds = async (db: AppDatabase): Promise<void> => {
  upsert(db, {
    uid: 'bounds-base', itemId: 'BOUNDS-BASE', name: '边界基准',
    description: '需求管理页面支持查询订单详情。', module: '需求管理'
  })
  const candidateUids: string[] = []
  for (let index = 0; index < 25; index += 1) {
    const uid = `bounds-candidate-${index}`
    candidateUids.push(uid)
    upsert(db, {
      uid, itemId: `BOUNDS-CANDIDATE-${index}`, name: `订单候选 ${index}`,
      description: `需求管理页面支持查询订单详情 ${index}。`, module: '需求管理'
    })
  }
  let rerankerInputLength = 0
  let explanationCandidateCount = 0
  const model = fakeModel({}, (input) => {
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as { candidates?: unknown[] }
    explanationCandidateCount = payload.candidates?.length ?? 0
  })
  const reranker: RequirementReranker = {
    modelId: 'smoke-bounds-reranker',
    async rerank(_base, candidates) {
      rerankerInputLength = candidates.length
      return candidates.map((candidate, index) => ({ recordUid: candidate.record.uid, score: 100 - index }))
    }
  }
  const response = await createAgent(db, {
    async retrieve(_base, excludedUids) {
      return candidateUids.filter((uid) => !excludedUids.has(uid)).map((uid) => candidateFor(db, uid, 80))
    }
  }, model, { reranker }).ask({ question: '分析需求编号 BOUNDS-BASE' })
  assert.equal(rerankerInputLength, 25, 'Cross-Encoder must receive all retrieved candidates')
  assert.equal(explanationCandidateCount, 10, 'only the top ten of deterministic Top20 may enter explanation')
  assert.equal(model.getCallCount(), 1)
  assert.ok(response.sources.every((source) => candidateUids.slice(0, 10).includes(source.uid)))
}

const runCacheAndGenericIds = async (db: AppDatabase): Promise<void> => {
  upsert(db, { uid: 'generic-base-one', itemId: 'GENERIC-BASE-ONE', name: '通用基准一', description: '需求页面支持查询详情。' })
  upsert(db, { uid: 'generic-base-two', itemId: 'GENERIC-BASE-TWO', name: '通用基准二', description: '需求页面支持查询详情。' })
  upsert(db, { uid: 'generic-candidate', itemId: 'GENERIC-CANDIDATE', name: '通用候选', description: '需求页面支持查询明细。' })
  const model = fakeModel()
  const retriever = {
    async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return excludedUids.has('generic-base-one') || excludedUids.has('generic-base-two')
        ? [candidateFor(db, 'generic-candidate', 90)]
        : []
    }
  }
  const agent = createAgent(db, retriever, model, {
    matchModelSignature: 'smoke-cache-v1',
    embeddingModelVersion: 'smoke-embedding-v1'
  })
  const first = await agent.ask({ question: '分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.getCallCount(), 1)
  const second = await agent.ask({ question: '分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.getCallCount(), 1, 'repeated verified input must hit persistent cache without a model call')
  assert.ok(second.sources.some((source) => source.uid === 'generic-candidate'))
  await agent.ask({ question: '请分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.getCallCount(), 2, 'query text changes must invalidate the cache')
  const changedSignature = createAgent(db, retriever, model, {
    matchModelSignature: 'smoke-cache-v2',
    embeddingModelVersion: 'smoke-embedding-v1'
  })
  await changedSignature.ask({ question: '分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.getCallCount(), 3, 'explanation model signature changes must invalidate the cache')
  assert.ok(first.sources.some((source) => source.uid === 'generic-candidate'))
  assert.deepEqual(
    extractRequirementAnalysisIds('分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO、GENERIC-BASE-ONE'),
    ['GENERIC-BASE-ONE', 'GENERIC-BASE-TWO']
  )
  const multiModel = fakeModel()
  const multiAgent = createAgent(db, retriever, multiModel, {
    matchModelSignature: 'smoke-cache-v1',
    embeddingModelVersion: 'smoke-embedding-v1'
  })
  const multi = await multiAgent.ask({ question: '分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO' })
  assert.equal(multiModel.getCallCount(), 2, 'generic IDs must use the same one-batch branch independently')
  assert.equal(multi.sources.length, 2)
}

const runRerankerFailure = async (db: AppDatabase): Promise<void> => {
  let modelCallCount = 0
  const agent = new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    {
      retriever: {
        async retrieve(_base, _excluded): Promise<HybridRequirementCandidate[]> {
          return [candidateFor(db, 'reranker-candidate')]
        }
      },
      reranker: {
        modelId: 'broken-smoke-reranker',
        async rerank(): Promise<RequirementRerankItem[]> {
          return [{ recordUid: 'unknown-reranker-uid', score: 99 }]
        }
      },
      modelClient: {
        async chat(): Promise<ModelResponse> {
          modelCallCount += 1
          throw new Error('model must not be called after reranker validation failure')
        }
      },
      semanticContext
    }
  )
  const response = await agent.ask({ question: '分析需求编号 RERANKER-BASE' })
  assert.equal(modelCallCount, 0)
  assert.equal(response.dataViews.length, 0)
  assert.equal(response.sources.length, 0)
  assert.match(response.answer, /匹配流程失败：Cross-Encoder 返回未知 UID/)
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-requirement-analysis-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    upsert(db, {
      uid: 'base-order',
      itemId: 'REQ-1',
      name: '订单查询',
      description: '<p>支持按<strong>订单编号</strong>查询 &quot;订单&quot; &amp; 详情<br/>。</p>',
      issueType: 'Enhancement',
      module: '订单管理'
    })
    upsert(db, {
      uid: 'base-stock',
      itemId: 'REQ-2',
      name: '库存查询',
      description: '支持按库存编号查询库存详情。',
      issueType: 'Enhancement',
      module: '库存管理'
    })
    upsert(db, { uid: 'match-order', itemId: 'DATA-1', name: '订单详情检索', description: '用户可以按订单号检索订单详情和状态。', module: '订单管理' })
    upsert(db, { uid: 'match-topic', itemId: 'DATA-2', name: '订单模块配置', description: '订单管理模块支持配置字段展示。', module: '订单管理' })
    upsert(db, { uid: 'match-stock', itemId: 'DATA-3', name: '库存明细查询', description: '按库存编号查看库存明细和状态。', module: '库存管理' })
    upsert(db, { uid: 'match-pattern', itemId: 'DATA-4', name: '库存状态展示', description: '支持按库存编号展示库存状态。', module: '库存管理' })

    upsert(db, { uid: 'reranker-base', itemId: 'RERANKER-BASE', name: '重排基准', description: '重排失败关闭测试需求。' })
    upsert(db, { uid: 'reranker-candidate', itemId: 'RERANKER-CANDIDATE', name: '重排候选', description: '重排失败关闭测试候选。' })

    assert.deepEqual(
      extractRequirementAnalysisIds('@需求分析专家 分析需求编号 REQ-1、REQ-2、REQ-1'),
      ['REQ-1', 'REQ-2'],
      'multi-ID parser must preserve order and remove duplicate IDs'
    )
    await runHappyPath(db)
    await runExplanationFallbackAndValidation(db)
    await runSourceOnlyMatching(db)
    await runTopBounds(db)
    await runCacheAndGenericIds(db)
    await runRerankerFailure(db)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'multi-id grouping',
        'HTML entity normalization',
        'IssueType extraction',
        'single batch explanation with deterministic score/relation preservation',
        'strict UID/evidence/forbidden-decision fallback validation',
        'source-only matching without query-time card generation',
        'Cross-Encoder Top20 and explanation Top10 bounds',
        'persistent cache hit and invalidation',
        'generic IDs use the same matching branch',
        'reranker fail-closed validation'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
