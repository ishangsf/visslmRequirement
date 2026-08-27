import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

import { AppDatabase } from '../src/main/database'
import { RequirementAnalysisAgent, extractRequirementAnalysisIds } from '../src/main/experts/requirement-analysis-agent'
import type { RequirementReranker, RequirementRerankItem } from '../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../src/main/requirements/hybrid-retrieval'
import { buildRequirementSourceView } from '../src/main/requirements/requirement-match-card'
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

type ExplanationMode = 'valid' | 'missing' | 'unknown' | 'duplicate' | 'forbidden' | 'invalid-evidence' | 'empty'

const upsert = (db: AppDatabase, input: {
  uid: string
  itemId: string
  name: string
  description: string
  issueType?: string
  module?: string
}): RecordDetail => {
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
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `missing fixture record ${input.uid}`)
  return record
}

const candidateFor = (db: AppDatabase, uid: string, score = 82): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `missing candidate ${uid}`)
  return {
    record,
    card: buildRequirementSourceView(record),
    denseScore: score,
    lexicalScore: score - 3,
    retrievalScore: score / 100,
    snippet: record.description
  } as HybridRequirementCandidate
}

const deterministicReranker = (scoreByUid: ReadonlyMap<string, number>): RequirementReranker => ({
  modelId: 'smoke-reranker',
  async rerank(_base, candidates): Promise<RequirementRerankItem[]> {
    return candidates
      .map((candidate) => ({ recordUid: candidate.record.uid, score: scoreByUid.get(candidate.record.uid) ?? 50 }))
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
  }
})

const explanationContent = (input: ModelChatInput, mode: ExplanationMode): string => {
  const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
    requirement?: { evidenceSegments?: Array<{ id: string }> }
    candidates?: Array<{ recordUid: string; evidenceSegments?: Array<{ id: string }> }>
  }
  if (mode === 'empty') return ''
  const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
  const item = (candidate: { recordUid: string; evidenceSegments?: Array<{ id: string }> }) => ({
    recordUid: candidate.recordUid,
    relation: 'partial_overlap',
    similarities: ['两条需求都涉及同一业务场景。'],
    differences: ['目标范围或操作动作存在差异。'],
    baseEvidence,
    candidateEvidence: candidate.evidenceSegments?.[0]?.id ?? 'C001'
  })
  const candidates = payload.candidates ?? []
  if (mode === 'missing') return JSON.stringify({ summary: '缺少候选解释。', items: candidates.slice(0, 1).map(item) })
  if (mode === 'unknown') return JSON.stringify({ summary: '包含未知 UID。', items: [{ ...item(candidates[0] ?? { recordUid: 'missing' }), recordUid: 'unknown-smoke-uid' }] })
  if (mode === 'duplicate') {
    const first = candidates[0] ? item(candidates[0]) : item({ recordUid: 'missing' })
    return JSON.stringify({ summary: '包含重复 UID。', items: [first, first] })
  }
  if (mode === 'forbidden') {
    return JSON.stringify({ summary: '包含禁止的决策字段。', items: candidates.map((candidate) => ({ ...item(candidate), score: 99 })) })
  }
  if (mode === 'invalid-evidence') {
    return JSON.stringify({ summary: '包含不在原文中的证据。', items: candidates.map((candidate) => ({ ...item(candidate), baseEvidence: 'B999', candidateEvidence: 'C999' })) })
  }
  return JSON.stringify({ summary: '固定 smoke fixture 的批量解释完成。', items: candidates.map(item) })
}

const fakeModel = (mode: ExplanationMode = 'valid', onInput?: (input: ModelChatInput) => void): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: number
} => {
  const model = {
    calls: 0,
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        onInput?.(input)
        return { message: { role: 'assistant', content: explanationContent(input, mode) } }
      }
    }
  }
  return model
}

const createRetriever = (
  db: AppDatabase,
  candidatesByBaseItemId: ReadonlyMap<string, string[]>
): { retrieve: (base: HybridRequirementCandidate['card'], excludedUids: Set<string>) => Promise<HybridRequirementCandidate[]>; calls: number } => {
  const retriever = {
    calls: 0,
    async retrieve(base: HybridRequirementCandidate['card'], excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      retriever.calls += 1
      const baseItemId = base.evidence.includes('订单编号') ? 'REQ-1' : 'REQ-2'
      return (candidatesByBaseItemId.get(baseItemId) ?? [])
        .filter((uid) => !excludedUids.has(uid))
        .map((uid, index) => candidateFor(db, uid, 90 - index))
    }
  }
  return retriever
}

type SmokeRetriever = {
  retrieve(base: HybridRequirementCandidate['card'], excludedUids: Set<string>): Promise<HybridRequirementCandidate[]>
}

const createAgent = (
  db: AppDatabase,
  retriever: SmokeRetriever,
  model: { client: { chat(input: ModelChatInput): Promise<ModelResponse> } },
  options: {
    reranker?: RequirementReranker
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
    modelClient: model.client
  }
)

const rowsOf = (response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>) => (
  response.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows))
)

const rowFor = (
  response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>,
  itemId: string
): ReturnType<typeof rowsOf>[number] | undefined => rowsOf(response).find((row) => row.itemId === itemId)

const runMultiIdAndSourceOnly = async (db: AppDatabase): Promise<void> => {
  const baseOrder = upsert(db, {
    uid: 'base-order', itemId: 'REQ-1', name: '订单查询',
    description: '<p>支持按<strong>订单编号</strong>查询 &quot;订单&quot; &amp; 详情<br/>。</p>', module: '订单管理'
  })
  upsert(db, { uid: 'base-stock', itemId: 'REQ-2', name: '库存查询', description: '支持按库存编号查询库存详情。', module: '库存管理' })
  const matchOrder = upsert(db, { uid: 'match-order', itemId: 'DATA-1', name: '订单详情检索', description: '用户可以按订单号检索订单详情和状态。', module: '订单管理' })
  const matchTopic = upsert(db, { uid: 'match-topic', itemId: 'DATA-2', name: '订单模块配置', description: '订单管理模块支持配置字段展示。', module: '订单管理' })
  const matchStock = upsert(db, { uid: 'match-stock', itemId: 'DATA-3', name: '库存明细查询', description: '按库存编号查看库存明细和状态。', module: '库存管理' })
  const matchPattern = upsert(db, { uid: 'match-pattern', itemId: 'DATA-4', name: '库存状态展示', description: '支持按库存编号展示库存状态。', module: '库存管理' })
  const modelInputs: ModelChatInput[] = []
  const model = fakeModel('valid', (input) => {
    modelInputs.push(input)
    const content = input.messages.at(-1)?.content ?? ''
    assert.match(content, /"evidence"/)
  })
  const retriever = createRetriever(db, new Map([
    ['REQ-1', [matchOrder.uid, matchTopic.uid]],
    ['REQ-2', [matchStock.uid, matchPattern.uid]]
  ]))
  const response = await new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    {
      retriever,
      reranker: deterministicReranker(new Map([[matchOrder.uid, 95], [matchTopic.uid, 72], [matchStock.uid, 94], [matchPattern.uid, 70]])),
      modelClient: model.client
    }
  ).ask({ question: '@需求分析专家 分析需求编号 REQ-1、REQ-2' })
  assert.equal(retriever.calls, 2)
  assert.equal(model.calls, 2)
  assert.equal(response.dataViews.length, 1)
  assert.ok(rowFor(response, 'DATA-1'))
  assert.equal(rowFor(response, 'DATA-1')?.values.requirementType, 'Enhancement')
  assert.ok(rowsOf(response).every((row) => typeof row.values.relation === 'string' && typeof row.values.matchScore === 'string'))
  const orderPrompt = JSON.parse(modelInputs[0]?.messages.at(-1)?.content ?? '{}') as { requirement?: { evidence?: string } }
  assert.ok(orderPrompt.requirement?.evidence?.includes('"订单" & 详情'))
  assert.ok(!orderPrompt.requirement?.evidence?.includes('<p>'))
  assert.ok(baseOrder)
}

const runExplanationFallbackAndTopBounds = async (db: AppDatabase): Promise<void> => {
  const base = upsert(db, { uid: 'fallback-base', itemId: 'FALLBACK-BASE', name: '边界基准', description: '需求管理页面支持查询订单详情。' })
  const candidates: RecordDetail[] = []
  for (let index = 0; index < 25; index += 1) {
    candidates.push(upsert(db, {
      uid: `fallback-candidate-${index}`, itemId: `FALLBACK-CANDIDATE-${index}`,
      name: `订单候选 ${index}`, description: `需求管理页面支持查询订单详情 ${index}。`
    }))
  }
  let rerankerInputLength = 0
  let explanationCandidateCount = 0
  const model = fakeModel('valid', (input) => {
    const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as { candidates?: unknown[] }
    explanationCandidateCount = payload.candidates?.length ?? 0
  })
  const reranker: RequirementReranker = {
    modelId: 'smoke-bounds-reranker',
    async rerank(_base, input) {
      rerankerInputLength = input.length
      return input.map((candidate, index) => ({ recordUid: candidate.record.uid, score: 100 - index }))
    }
  }
  const retriever = {
    async retrieve(_base: HybridRequirementCandidate['card'], excludedUids: Set<string>) {
      return candidates.filter((record) => !excludedUids.has(record.uid)).map((record) => candidateFor(db, record.uid, 80))
    }
  }
  const response = await createAgent(db, retriever, model, { reranker }).ask({ question: '分析需求编号 FALLBACK-BASE' })
  assert.equal(rerankerInputLength, 25)
  assert.equal(explanationCandidateCount, 10)
  assert.equal(model.calls, 1)
  assert.ok(response.sources.length > 0)
}

const runRepeatedAndGenericIds = async (db: AppDatabase): Promise<void> => {
  const baseOne = upsert(db, { uid: 'generic-base-one', itemId: 'GENERIC-BASE-ONE', name: '通用基准一', description: '需求页面支持查询详情。' })
  const baseTwo = upsert(db, { uid: 'generic-base-two', itemId: 'GENERIC-BASE-TWO', name: '通用基准二', description: '需求页面支持查询详情。' })
  const candidate = upsert(db, { uid: 'generic-candidate', itemId: 'GENERIC-CANDIDATE', name: '通用候选', description: '需求页面支持查询明细。' })
  const model = fakeModel()
  const retriever = {
    async retrieve(_base: HybridRequirementCandidate['card'], excludedUids: Set<string>) {
      return (excludedUids.has(baseOne.uid) || excludedUids.has(baseTwo.uid)) ? [candidateFor(db, candidate.uid, 90)] : []
    }
  }
  const agent = createAgent(db, retriever, model)
  const first = await agent.ask({ question: '分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.calls, 1)
  const second = await agent.ask({ question: '分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.calls, 2)
  assert.ok(second.sources.some((source) => source.uid === candidate.uid))
  await agent.ask({ question: '请分析需求编号 GENERIC-BASE-ONE' })
  assert.equal(model.calls, 3)
  const multiModel = fakeModel()
  const multi = await createAgent(db, retriever, multiModel)
    .ask({ question: '分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO' })
  assert.equal(multiModel.calls, 2)
  assert.equal(multi.sources.length, 2)
  assert.ok(first.sources.some((source) => source.uid === candidate.uid))
}

const runRerankerFailure = async (db: AppDatabase): Promise<void> => {
  const base = upsert(db, { uid: 'reranker-base', itemId: 'RERANKER-BASE', name: '重排基准', description: '重排失败关闭测试需求。' })
  const candidate = upsert(db, { uid: 'reranker-candidate', itemId: 'RERANKER-CANDIDATE', name: '重排候选', description: '重排失败关闭测试候选。' })
  let modelCallCount = 0
  const response = await new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    {
      retriever: { async retrieve(_base, _excluded) { return [candidateFor(db, candidate.uid)] } },
      reranker: {
        modelId: 'broken-smoke-reranker',
        async rerank(): Promise<RequirementRerankItem[]> { return [{ recordUid: 'unknown-reranker-uid', score: 99 }] }
      },
      modelClient: {
        async chat(): Promise<ModelResponse> {
          modelCallCount += 1
          throw new Error('model must not be called after reranker validation failure')
        }
      }
    }
  ).ask({ question: '分析需求编号 RERANKER-BASE' })
  assert.equal(modelCallCount, 0)
  assert.equal(response.sources.length, 0)
  assert.match(response.answer, /匹配流程失败：Cross-Encoder 返回未知 UID/)
  assert.ok(base)
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-requirement-analysis-source-only-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    assert.deepEqual(extractRequirementAnalysisIds('@需求分析专家 分析需求编号 REQ-1、REQ-2、REQ-1'), ['REQ-1', 'REQ-2'])
    assert.deepEqual(extractRequirementAnalysisIds('帮我分析需求:4101, 4095，4085'), ['4101', '4095', '4085'])
    assert.deepEqual(
      extractRequirementAnalysisIds('按区域分析：PM：4101、4095；华东区：4059-4063；所有编号前面都有前缀VISSLM-TSIS-', 200),
      ['VISSLM-TSIS-4101', 'VISSLM-TSIS-4095', 'VISSLM-TSIS-4059', 'VISSLM-TSIS-4060', 'VISSLM-TSIS-4061', 'VISSLM-TSIS-4062', 'VISSLM-TSIS-4063']
    )
    await runMultiIdAndSourceOnly(db)
    await runExplanationFallbackAndTopBounds(db)
    await runRepeatedAndGenericIds(db)
    await runRerankerFailure(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'multi-id grouping and generic numeric ID parsing',
        'HTML entity normalization and source-only evidence',
        'one explanation call per base using cleaned source evidence',
        'UID/evidence/forbidden-decision fallback validation',
        'Cross-Encoder Top20 and explanation Top10 bounds',
        'repeated and multi-ID explanation execution',
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
