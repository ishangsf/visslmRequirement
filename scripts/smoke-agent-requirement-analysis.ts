import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

type ReviewRelation = 'duplicate' | 'highly_similar' | 'partial_overlap' | 'same_pattern' | 'topic_only' | 'unrelated'

interface FixedOutcome {
  candidateItemId: string
  allowedRelations: ReviewRelation[]
}

interface FixedOutcomeFixture {
  baseItemId: string
  expected: FixedOutcome[]
  noFormalMatch: boolean
}

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

const readFixedOutcomes = async (): Promise<FixedOutcomeFixture> => {
  const path = join(process.cwd(), 'test-data', 'requirement-matching', 'fixed-outcomes.json')
  return JSON.parse(await readFile(path, 'utf8')) as FixedOutcomeFixture
}

const upsert = (db: AppDatabase, input: {
  uid: string
  itemId: string
  name: string
  description: string
  issueType?: string
  module?: string
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
  persistReadySemanticCard(db, input.uid)
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
  assert.ok(card, `missing ready semantic card ${uid}`)
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

const reviewContent = (input: ModelChatInput, relationByItemId: ReadonlyMap<string, ReviewRelation>): string => {
  const message = input.messages.at(-1)?.content ?? '{}'
  const payload = JSON.parse(message) as {
    requirement?: { evidence?: string }
    candidates?: Array<{ recordUid: string; itemId: string; evidence?: string }>
  }
  const baseEvidence = payload.requirement?.evidence?.slice(0, 32) || '需求内容'
  const items = (payload.candidates ?? []).map((candidate) => {
    const relation = relationByItemId.get(candidate.itemId) ?? 'topic_only'
    const score: Record<ReviewRelation, number> = {
      duplicate: 90,
      highly_similar: 82,
      partial_overlap: 55,
      same_pattern: 45,
      topic_only: 25,
      unrelated: 10
    }
    return {
      recordUid: candidate.recordUid,
      relation,
      score: score[relation],
      sharedEvidence: '需求都涉及需求管理场景',
      difference: '业务目标、功能对象或动作范围存在差异',
      baseEvidence,
      candidateEvidence: candidate.evidence?.slice(0, 32) || '候选需求内容'
    }
  })
  return JSON.stringify({ summary: '固定 smoke fixture 的业务关系复核完成。', items })
}

const fakeModel = (
  relationByItemId: ReadonlyMap<string, ReviewRelation>,
  onInput?: (input: ModelChatInput) => void
): { client: { chat(input: ModelChatInput): Promise<ModelResponse> }; getCallCount: () => number } => {
  let callCount = 0
  return {
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        callCount += 1
        onInput?.(input)
        return { message: { role: 'assistant', content: reviewContent(input, relationByItemId) } }
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

const runHappyPath = async (db: AppDatabase): Promise<void> => {
  let orderIssueType = ''
  let orderEvidence = ''
  const retriever = createRetriever(db, new Map([
    ['REQ-1', ['match-order', 'match-topic']],
    ['REQ-2', ['match-stock', 'match-pattern']]
  ]))
  const model = fakeModel(new Map([
    ['DATA-1', 'duplicate'],
    ['DATA-2', 'topic_only'],
    ['DATA-3', 'highly_similar'],
    ['DATA-4', 'partial_overlap']
  ]), (input) => {
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
  assert.equal(model.getCallCount(), 4, 'each base must receive draft and independent verification calls')
  assert.equal(orderIssueType, 'Enhancement', 'IssueType must come from the real raw field')
  assert.ok(orderEvidence.includes('"订单" & 详情'), 'HTML entities/tags must be normalized before model evidence')
  assert.ok(!orderEvidence.includes('&quot;') && !orderEvidence.includes('<p>'), 'raw HTML must not reach the model')
  assert.equal(response.dataViews.length, 1)
  assert.equal(response.dataViews[0]?.groups.length, 3, 'formal and reference results must remain grouped per base')
  assert.deepEqual(
    response.dataViews[0]?.groups.map((group) => group.name),
    ['REQ-1 · 正式匹配', 'REQ-2 · 正式匹配', 'REQ-2 · 参考关联需求']
  )
  assert.equal(response.dataViews[0]?.groups[0]?.rows[0]?.itemId, 'DATA-1')
  assert.equal(response.dataViews[0]?.groups[0]?.rows[0]?.values.requirementType, 'Enhancement')
  assert.ok(!response.dataViews[0]?.groups.some((group) => group.rows.some((row) => row.itemId === 'DATA-2')), 'topic_only candidates must be hidden')
  assert.match(response.answer, /REQ-1 · 订单查询/)
  assert.match(response.answer, /DATA-1 · 订单详情检索/)
  assert.match(response.answer, /确认 1 条高度相似或重复需求/)
}

const runFixedOutcomes = async (db: AppDatabase, fixture: FixedOutcomeFixture): Promise<void> => {
  const byItemId = new Map(fixture.expected.map((item) => [item.candidateItemId, item.allowedRelations[0]!]))
  const uidByItemId = new Map([
    ['VISSLM-TSIS-889', 'fixed-889'],
    ['VISSLM-TSIS-376', 'fixed-376'],
    ['VISSLM-TSIS-613', 'fixed-613'],
    ['VISSLM-TSIS-395', 'fixed-395'],
    ['VISSLM-TSIS-528', 'fixed-528'],
    ['VISSLM-TSIS-1837', 'fixed-1837']
  ])
  const retriever = {
    async retrieve(_base: ReturnType<typeof buildRequirementSemanticCard>, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return [...uidByItemId.values()]
        .filter((uid) => !excludedUids.has(uid))
        .map((uid, index) => candidateFor(db, uid, 90 - index))
    }
  }
  const model = fakeModel(byItemId)
  const agent = new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    { retriever, reranker: deterministicReranker(new Map()), modelClient: model.client, semanticContext }
  )
  const response = await agent.ask({ question: `分析需求编号 ${fixture.baseItemId}` })
  assert.equal(model.getCallCount(), 4, 'fixed outcome should use two independent passes across two candidate batches')
  const rows = response.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows))
  for (const expected of fixture.expected) {
    const row = rows.find((candidate) => candidate.itemId === expected.candidateItemId)
    const suppliedRelation = expected.allowedRelations[0]
    if (suppliedRelation === 'topic_only' || suppliedRelation === 'unrelated') {
      assert.equal(row, undefined, `non-visible ${suppliedRelation} candidate ${expected.candidateItemId} must be filtered`)
    } else {
      assert.ok(row, `fixed candidate ${expected.candidateItemId} should be visible in the result`)
      assert.ok(expected.allowedRelations.includes(String(row.values.relation) as ReviewRelation), `unexpected relation for ${expected.candidateItemId}`)
    }
  }
  assert.ok(!rows.some((row) => row.values.relation === 'duplicate' || row.values.relation === 'highly_similar'), 'fixed fixture must have no formal matches')
  if (fixture.noFormalMatch) {
    assert.match(response.answer, /未发现业务目标一致的高度相似或重复需求/)
    assert.ok(!response.dataViews.some((view) => view.groups.some((group) => group.name.endsWith('正式匹配'))))
  }
}

const runInvalidReview = async (db: AppDatabase, mode: 'missing' | 'unknown' | 'duplicate'): Promise<void> => {
  const retriever = {
    async retrieve(_base: ReturnType<typeof buildRequirementSemanticCard>, _excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return [candidateFor(db, 'invalid-candidate-a'), candidateFor(db, 'invalid-candidate-b')]
    }
  }
  let callCount = 0
  const model = {
    async chat(input: ModelChatInput): Promise<ModelResponse> {
      callCount += 1
      const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
        requirement?: { evidence?: string }
        candidates?: Array<{ recordUid: string; evidence?: string }>
      }
      const candidates = payload.candidates ?? []
      const item = (candidate: { recordUid: string; evidence?: string }) => ({
        recordUid: candidate.recordUid,
        relation: 'topic_only',
        score: 20,
        sharedEvidence: '同属需求场景',
        difference: '功能对象不同',
        baseEvidence: payload.requirement?.evidence?.slice(0, 20) || '需求',
        candidateEvidence: candidate.evidence?.slice(0, 20) || '候选'
      })
      const first = candidates[0]
      const second = candidates[1]
      const items = mode === 'missing'
        ? (first ? [item(first)] : [])
        : mode === 'unknown'
          ? [item({ recordUid: 'unknown-uid', evidence: '未知候选' })]
          : (first ? [item(first), item(first), ...(second ? [item(second)] : [])] : [])
      return { message: { role: 'assistant', content: JSON.stringify({ summary: `invalid ${mode}`, items }) } }
    }
  }
  const agent = new RequirementAnalysisAgent(
    db,
    {} as KnowledgeService,
    settings,
    undefined,
    { retriever, reranker: deterministicReranker(new Map()), modelClient: model, semanticContext }
  )
  const response = await agent.ask({ question: '分析需求编号 UNKNOWN-BASE' })
  assert.equal(callCount, 0, 'unknown base IDs must not call the model')
  assert.equal(response.dataViews.length, 0)
  assert.match(response.answer, /不存在/)

  const validResponse = await agent.ask({ question: '分析需求编号 VALID-BASE' })
  assert.equal(callCount, 2, `${mode} model output should retry exactly once before failing closed`)
  assert.equal(validResponse.dataViews.length, 0)
  assert.equal(validResponse.sources.length, 0)
  assert.match(validResponse.answer, /精准匹配失败关闭/)
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
  assert.match(response.answer, /精准匹配失败关闭/)
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

    const fixedFixture = await readFixedOutcomes()
    upsert(db, {
      uid: 'fixed-base-779',
      itemId: fixedFixture.baseItemId,
      name: '基线管理名称修改',
      description: '1、配置管理中基线管理界面第二次创建基线时“变更基线”按钮建议改为“创建基线”，因为点击“变更基线”后创建的仍然是“基线创建申请单”。',
      issueType: 'Enhancement',
      module: '配置管理'
    })
    for (const expected of fixedFixture.expected) {
      const uid = expected.candidateItemId.replace('VISSLM-TSIS-', 'fixed-')
      const actionText = expected.candidateItemId === 'VISSLM-TSIS-1837'
        ? '测试报告页面中的“生成报告”按钮建议改为“导出报告”，以便用户明确当前操作是生成测试报告。'
        : expected.candidateItemId === 'VISSLM-TSIS-889'
          ? '基线管理支持直接查看两条基线之间的变更情况和差异；选择不同版本基线后显示配置项及配置项版本的差异，并高亮提醒。'
          : expected.candidateItemId === 'VISSLM-TSIS-376'
            ? '客户要求基线管理预设子页中的“创建基线”按钮支持权限设置，由项目负责人完成创建。'
            : expected.candidateItemId === 'VISSLM-TSIS-613'
              ? '建立分配基线时支持选择上溯的功能基线及对应版本，建立产品基线时支持选择上溯的分配基线版本。'
              : expected.candidateItemId === 'VISSLM-TSIS-395'
                ? '基于某个基线创建新基线时，申请单中仍保留已经从基线裁剪删除的配置项，导致用户无法创建基线。'
                : '基线建立申请单支持删除尚未入受控库的配置项，在部分配置项未完成时仍允许建立基线。'
      upsert(db, {
        uid,
        itemId: expected.candidateItemId,
        name: expected.candidateItemId === 'VISSLM-TSIS-889'
          ? '基线管理的基线比较功能'
          : expected.candidateItemId === 'VISSLM-TSIS-376'
            ? '基线管理预设子页中的创建基线按钮不可设置权限'
            : expected.candidateItemId === 'VISSLM-TSIS-1837'
              ? '测试报告生成按钮名称修改'
              : `基线管理相关能力 ${expected.candidateItemId}`,
        description: actionText,
        issueType: expected.candidateItemId === 'VISSLM-TSIS-1837' ? 'Defect' : 'Enhancement',
        module: expected.candidateItemId === 'VISSLM-TSIS-1837' ? '测试管理' : '配置管理'
      })
    }
    upsert(db, { uid: 'invalid-candidate-a', itemId: 'INVALID-A', name: '候选 A', description: '需求管理模块的候选内容。' })
    upsert(db, { uid: 'invalid-candidate-b', itemId: 'INVALID-B', name: '候选 B', description: '需求管理模块的另一候选内容。' })
    upsert(db, { uid: 'valid-base', itemId: 'VALID-BASE', name: '有效基准', description: '有效基准需求内容。' })
    upsert(db, { uid: 'invalid-base', itemId: 'INVALID-BASE', name: '无效测试基准', description: '无效测试基准需求内容。' })
    upsert(db, { uid: 'reranker-base', itemId: 'RERANKER-BASE', name: '重排基准', description: '重排失败关闭测试需求。' })
    upsert(db, { uid: 'reranker-candidate', itemId: 'RERANKER-CANDIDATE', name: '重排候选', description: '重排失败关闭测试候选。' })

    assert.deepEqual(
      extractRequirementAnalysisIds('@需求分析专家 分析需求编号 REQ-1、REQ-2、REQ-1'),
      ['REQ-1', 'REQ-2'],
      'multi-ID parser must preserve order and remove duplicate IDs'
    )
    await runHappyPath(db)
    await runFixedOutcomes(db, fixedFixture)
    for (const mode of ['missing', 'unknown', 'duplicate'] as const) await runInvalidReview(db, mode)
    await runRerankerFailure(db)

    console.log(JSON.stringify({
      ok: true,
      checks: [
        'multi-id grouping',
        'HTML entity normalization',
        'IssueType extraction',
        'two model passes',
        'fixed VISSLM-TSIS-779 outcomes',
        'missing/unknown/duplicate UID fail-closed validation',
        'reranker fail-closed validation'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
