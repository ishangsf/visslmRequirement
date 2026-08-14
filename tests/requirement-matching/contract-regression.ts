import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { RequirementAnalysisAgent, extractRequirementAnalysisIds } from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import type { RequirementReranker, RequirementRerankItem } from '../../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import {
  buildRequirementSemanticCard,
  type RequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import {
  explainRequirementMatches,
  tryParseRequirementMatchExplanationResponse,
  type RequirementMatchExplanationRequest
} from '../../src/main/requirements/requirement-match-explainer'
import {
  scoreRequirementCards,
  type RequirementMatchRelation
} from '../../src/main/requirements/requirement-match-scoring'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../../src/main/requirements/semanticization-service'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'requirement-analysis-contract-model',
  thinking: false
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
  module?: string
  issueType?: string
}

const upsert = (db: AppDatabase, input: FixtureInput): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'requirement-analysis-contracts',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      _valm_Description: input.description,
      IssueType: input.issueType ?? 'Enhancement',
      _valm_Module: input.module ?? '需求管理'
    },
    normalizedText: `${input.name}\n${input.description}\n${input.module ?? '需求管理'}`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `fixture record was not persisted: ${input.uid}`)
  return record
}

const aiCard = (
  record: RecordDetail,
  overrides: Partial<Pick<RequirementSemanticCard, 'functionalObject' | 'action'>> = {}
): RequirementSemanticCard => {
  const source = buildRequirementSemanticCard(record)
  const functionalObject = overrides.functionalObject ?? record.name
  const action = overrides.action ?? 'add_capability'
  return {
    ...source,
    functionalObject,
    action,
    matchingText: `${source.evidence}\n功能对象：${functionalObject}`,
    fieldAssessments: {
      ...source.fieldAssessments,
      functionalObject: { value: functionalObject, confidence: 0.95, evidence: source.evidence },
      action: { value: action, confidence: 0.95, evidence: source.evidence }
    },
    analysisStatus: 'ai_adjudicated',
    analysisSummary: 'contract regression fixture'
  }
}

const persistReadyCard = (db: AppDatabase, record: RecordDetail, card = aiCard(record)): RequirementSemanticCard => {
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash)
  assert.equal(db.claimRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }), true)
  db.completeRequirementSemanticCard(record.uid, card)
  assert.ok(db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }))
  return card
}

const candidateFor = (
  db: AppDatabase,
  uid: string,
  card?: RequirementSemanticCard,
  denseScore = 0.82
): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record)
  return {
    record,
    card: card ?? buildRequirementSemanticCard(record),
    denseScore,
    lexicalScore: denseScore,
    structuralScore: denseScore,
    retrievalScore: denseScore,
    snippet: record.description
  }
}

const deterministicReranker = (scoreByUid: ReadonlyMap<string, number> = new Map()): RequirementReranker => ({
  modelId: 'requirement-analysis-contract-reranker',
  async rerank(_base, candidates): Promise<RequirementRerankItem[]> {
    return candidates
      .map((candidate, index) => ({
        recordUid: candidate.record.uid,
        score: scoreByUid.get(candidate.record.uid) ?? 90 - index
      }))
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
  }
})

const parsePrompt = (input: ModelChatInput): Record<string, unknown> => {
  const content = input.messages.at(-1)?.content ?? '{}'
  return JSON.parse(content) as Record<string, unknown>
}

const evidenceId = (value: unknown, fallback: string): string => {
  if (!Array.isArray(value)) return fallback
  const first = value[0]
  return first && typeof first === 'object' && typeof (first as { id?: unknown }).id === 'string'
    ? (first as { id: string }).id
    : fallback
}

type ModelMode = 'valid' | 'malformed' | 'empty' | 'length' | 'unknown-uid' | 'invalid-evidence' | 'forbidden-decision'

const createExplanationModel = (mode: ModelMode = 'valid'): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: ModelChatInput[]
} => {
  const calls: ModelChatInput[] = []
  return {
    calls,
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls.push(input)
        const payload = parsePrompt(input)
        if (mode === 'malformed') return { message: { role: 'assistant', content: '{not-json' } }
        if (mode === 'empty') return { message: { role: 'assistant', content: '' } }
        if (mode === 'length') return { message: { role: 'assistant', content: '' }, done_reason: 'length' }
        const requirement = (payload.requirement ?? {}) as { evidenceSegments?: unknown }
        const candidates = Array.isArray(payload.candidates) ? payload.candidates as Array<Record<string, unknown>> : []
        const baseEvidence = evidenceId(requirement.evidenceSegments, 'B001')
        const items = candidates.map((candidate) => {
          const candidateEvidence = evidenceId(candidate.evidenceSegments, 'C001')
          const item: Record<string, unknown> = {
            recordUid: mode === 'unknown-uid' ? 'unknown-returned-uid' : candidate.recordUid,
            relation: 'partial_overlap',
            similarities: ['两条需求都涉及同一业务场景。'],
            differences: ['目标范围或操作动作存在差异。'],
            baseEvidence: mode === 'invalid-evidence' ? 'B999' : baseEvidence,
            candidateEvidence: mode === 'invalid-evidence' ? 'C999' : candidateEvidence
          }
          if (mode === 'forbidden-decision') {
            item.relation = 'duplicate'
            item.score = 99
          }
          return item
        })
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({ summary: '契约测试解释完成。', items })
          }
        }
      }
    }
  }
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'requirement-analysis-contract-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'contract.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const makeExplanationRequest = (
  base: RequirementSemanticCard,
  candidates: HybridRequirementCandidate[]
): RequirementMatchExplanationRequest => ({ base, candidates })

const testSemanticSourceCleaning = (): void => {
  const record = {
    uid: 'cleaning-uid',
    projectId: 'contract',
    nodeType: 'Requirement',
    itemId: 'CLEANING-1',
    parentId: '',
    name: '<span>订单查询</span>',
    description: '<p>支持按&nbsp;订单编号查询 &quot;订单&quot; &amp; 展示结果。</p><script>alert(1)</script><br/>验收标准：返回结果。',
    lastModifyTime: new Date(0).toISOString(),
    syncedAt: new Date(0).toISOString(),
    imageCount: 0,
    normalizedText: '',
    pushStatus: 'pending' as const,
    pushMessage: '',
    pushedAt: '',
    pushedUid: '',
    raw: { IssueType: '<b>Enhancement</b>', moduleName: '<i>订单管理</i>' },
    images: []
  }
  const card = buildRequirementSemanticCard(record)
  const text = [card.behavior, card.evidence, card.matchingText].join('\n')
  assert.equal(card.requirementType, 'Enhancement')
  assert.equal(card.module, '订单管理')
  assert.equal(card.action, 'unknown', 'source-only cards must not infer actions from prose')
  assert.equal(card.functionalObject, '', 'source-only cards must not infer objects from prose')
  assert.ok(text.includes('"订单" & 展示结果'))
  assert.ok(!text.includes('<p>') && !text.includes('&quot;') && !text.includes('alert(1)'))
}

const testDeterministicHardRules = (): void => {
  const makeCard = (action: RequirementSemanticCard['action'], object: string): RequirementSemanticCard => aiCard({
    uid: `hard-${action}-${object}`,
    projectId: 'contract',
    nodeType: 'Requirement',
    itemId: 'HARD-RULE',
    parentId: '',
    name: object,
    description: `${object} 需求。`,
    lastModifyTime: new Date(0).toISOString(),
    syncedAt: new Date(0).toISOString(),
    imageCount: 0,
    normalizedText: `${object} 需求。`,
    pushStatus: 'pending',
    pushMessage: '',
    pushedAt: '',
    pushedUid: '',
    raw: {},
    images: []
  }, { action, functionalObject: object })
  const add = makeCard('add_capability', '基线管理页面')
  const fix = makeCard('fix_defect', '基线管理页面')
  const conflicting = scoreRequirementCards(add, fix, { dimensionScores: { behavior: 94 }, weights: { behavior: 1 } })
  assert.equal(conflicting.relation, 'topic_only')
  assert.ok(conflicting.finalScore <= 39)

  const differentObject = makeCard('add_capability', '测试报告页面')
  const samePattern = scoreRequirementCards(add, differentObject, { dimensionScores: { behavior: 94 }, weights: { behavior: 1 } })
  assert.equal(samePattern.relation, 'same_pattern')
  assert.ok(samePattern.finalScore <= 59)
}

const testExplanationProtocol = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = upsert(db, {
      uid: 'protocol-base-uid', itemId: 'PROTOCOL-BASE', name: '协议基准',
      description: '需求管理页面支持查询订单详情。', module: '需求管理'
    })
    const candidate = upsert(db, {
      uid: 'protocol-candidate-uid', itemId: 'PROTOCOL-CANDIDATE', name: '协议候选',
      description: '需求管理页面支持查询订单明细。', module: '需求管理'
    })
    const request = makeExplanationRequest(aiCard(base), [candidateFor(db, candidate.uid, buildRequirementSemanticCard(candidate))])
    const model = createExplanationModel()
    const result = await explainRequirementMatches(model.client, request)
    assert.equal(model.calls.length, 1, 'explainer must make exactly one model call')
    assert.ok(result.summary)
    assert.deepEqual(result.items.map((item) => item.recordUid), [candidate.uid])
    assert.equal('relation' in result.items[0]!, true)
    assert.equal(result.items[0]?.relation, 'partial_overlap')
    assert.equal('score' in result.items[0]!, false)

    const valid = JSON.stringify({ summary: result.summary, items: result.items })
    const unknown = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({ summary: result.summary, items: [{ ...result.items[0], recordUid: 'unknown-uid' }] }), request
    )
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.error.code, 'uid')
    const evidence = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({ summary: result.summary, items: [{ ...result.items[0], baseEvidence: 'B999', candidateEvidence: 'C999' }] }), request
    )
    assert.equal(evidence.ok, false)
    if (!evidence.ok) assert.equal(evidence.error.code, 'evidence')
    const forbidden = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({ summary: result.summary, items: [{ ...result.items[0], score: 99 }] }), request
    )
    assert.equal(forbidden.ok, false)
    if (!forbidden.ok) assert.equal(forbidden.error.code, 'forbidden_decision')
    assert.ok(valid.includes(candidate.uid))
  })
}

const createAgent = (
  db: AppDatabase,
  retriever: Pick<HybridRequirementCandidateRetriever, 'retrieve'>,
  model: { client: { chat(input: ModelChatInput): Promise<ModelResponse> } },
  options: {
    reranker?: RequirementReranker
    semanticContext?: { analyzerVersion: string; modelSignature: string }
    embeddingModelVersion?: string
    matchModelSignature?: string
    onProgress?: (event: unknown) => void
  } = {}
): RequirementAnalysisAgent => new RequirementAnalysisAgent(
  db,
  {} as KnowledgeService,
  settings,
  options.onProgress,
  {
    retriever,
    reranker: options.reranker ?? deterministicReranker(),
    modelClient: model.client,
    semanticContext: options.semanticContext ?? semanticContext,
    embeddingModelVersion: options.embeddingModelVersion,
    matchModelSignature: options.matchModelSignature
  }
)

type HybridRequirementCandidateRetriever = {
  retrieve(base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]>
}

const testAgentSingleBatchAndFallback = async (): Promise<void> => {
  for (const mode of ['valid', 'malformed', 'empty', 'length', 'unknown-uid', 'invalid-evidence', 'forbidden-decision'] as const) {
    await withDatabase(async (db) => {
      const base = upsert(db, {
        uid: `agent-${mode}-base-uid`, itemId: `AGENT-${mode.toUpperCase()}-BASE`, name: '订单查询基准',
        description: '需求管理页面支持查询订单详情。', module: '需求管理'
      })
      const candidate = upsert(db, {
        uid: `agent-${mode}-candidate-uid`, itemId: `AGENT-${mode.toUpperCase()}-CANDIDATE`, name: '订单查询候选',
        description: '需求管理页面支持查询订单详情和明细。', module: '需求管理'
      })
      const baseCard = persistReadyCard(db, base, aiCard(base, { functionalObject: '订单详情' }))
      const candidateCard = persistReadyCard(db, candidate, aiCard(candidate, { functionalObject: '订单详情' }))
      const model = createExplanationModel(mode)
      const response = await createAgent(db, {
        async retrieve(_base, excludedUids) {
          return excludedUids.has(base.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
        }
      }, model).ask({ question: `分析需求编号 ${base.itemId}` })

      assert.equal(model.calls.length, 1, `${mode} must use one batch call with no repair or second review pass`)
      assert.ok(response.sources.some((source) => source.uid === candidate.uid), `${mode} must preserve deterministic match output`)
      const row = response.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows)).find((item) => item.uid === candidate.uid)
      assert.ok(row)
      if (mode === 'valid') {
        assert.equal(row.values.explanationStatus, '实时 AI 语义复核已校验')
      } else {
        assert.equal(row.values.explanationStatus, 'AI 语义复核暂不可用，正式关系已降级并保留召回审计')
      }
      assert.equal(baseCard.analysisStatus, 'ai_adjudicated')
    })
  }
}

const testSourceOnlyMatchingNeedsNoSemanticizationCall = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = upsert(db, {
      uid: 'source-only-base-uid', itemId: 'SOURCE-ONLY-BASE', name: '原文基准',
      description: '需求管理页面支持查询订单详情。', module: '需求管理'
    })
    const candidate = upsert(db, {
      uid: 'source-only-candidate-uid', itemId: 'SOURCE-ONLY-CANDIDATE', name: '原文候选',
      description: '需求管理页面支持查询订单明细。', module: '需求管理'
    })
    const candidateCard = buildRequirementSemanticCard(candidate)
    const model = createExplanationModel()
    const prompts: Record<string, unknown>[] = []
    const response = await createAgent(db, {
      async retrieve(baseCard, excludedUids) {
        assert.equal(baseCard.analysisStatus, 'source_only')
        assert.ok(baseCard.evidence.includes('查询订单详情'))
        return excludedUids.has(base.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
      }
    }, {
      client: {
        async chat(input) {
          prompts.push(parsePrompt(input))
          return model.client.chat(input)
        }
      }
    }).ask({ question: '分析需求编号 SOURCE-ONLY-BASE' })
    assert.equal(db.getRequirementSemanticCardState(base.uid), null, 'matching must not create a persisted semantic card for the base')
    assert.equal(db.getRequirementSemanticCardState(candidate.uid), null, 'source-only candidates must remain unpersisted')
    assert.equal(
      prompts[0]?.requirement && (prompts[0].requirement as { semanticCardStatus?: string }).semanticCardStatus,
      'source_only'
    )
    assert.equal((prompts[0]?.candidates as Array<{ semanticCardStatus?: string }>)[0]?.semanticCardStatus, 'source_only')
    assert.ok(response.sources.some((source) => source.itemId === candidate.itemId))
  })
}

const testAgentTop20Top10Bounds = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = upsert(db, {
      uid: 'bounds-base-uid', itemId: 'BOUNDS-BASE', name: '边界基准',
      description: '需求管理页面支持查询订单详情。', module: '需求管理'
    })
    persistReadyCard(db, base, aiCard(base, { functionalObject: '订单详情' }))
    const candidateUids: string[] = []
    for (let index = 0; index < 25; index += 1) {
      const candidate = upsert(db, {
        uid: `bounds-candidate-${index}-uid`, itemId: `BOUNDS-CANDIDATE-${index}`,
        name: `订单候选 ${index}`, description: `需求管理页面支持查询订单详情 ${index}。`, module: '需求管理'
      })
      candidateUids.push(candidate.uid)
      persistReadyCard(db, candidate, aiCard(candidate, { functionalObject: '订单详情' }))
    }
    const rerankInputs: HybridRequirementCandidate[][] = []
    const reranker: RequirementReranker = {
      modelId: 'bounds-reranker',
      async rerank(_base, candidates) {
        rerankInputs.push(candidates)
        return candidates.map((candidate, index) => ({ recordUid: candidate.record.uid, score: 100 - index }))
      }
    }
    const model = createExplanationModel()
    let prompt: Record<string, unknown> | undefined
    const response = await createAgent(db, {
      async retrieve(_base, excludedUids) {
        return candidateUids.filter((uid) => !excludedUids.has(uid)).map((uid) => candidateFor(db, uid))
      }
    }, {
      client: {
        async chat(input) {
          prompt = parsePrompt(input)
          return model.client.chat(input)
        }
      }
    }, { reranker }).ask({ question: '分析需求编号 BOUNDS-BASE' })
    assert.equal(rerankInputs[0]?.length, 25, 'Cross-Encoder must see the full hybrid candidate set')
    assert.equal(model.calls.length, 1, 'the top-ten explanation must be one batch call')
    assert.equal((prompt?.candidates as unknown[]).length, 10, 'only top ten of Cross-Encoder Top20 may enter explanation')
    assert.ok(response.sources.every((source) => candidateUids.slice(0, 10).includes(source.uid)), 'visible results must come from the explained top-ten set')
  })
}

const testPersistentCacheAndInvalidation = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = upsert(db, {
      uid: 'cache-base-uid', itemId: 'CACHE-BASE', name: '缓存基准',
      description: '需求管理页面支持查询订单详情。', module: '需求管理'
    })
    const candidate = upsert(db, {
      uid: 'cache-candidate-uid', itemId: 'CACHE-CANDIDATE', name: '缓存候选',
      description: '需求管理页面支持查询订单明细。', module: '需求管理'
    })
    persistReadyCard(db, base, aiCard(base, { functionalObject: '订单详情' }))
    const candidateCard = persistReadyCard(db, candidate, aiCard(candidate, { functionalObject: '订单详情' }))
    const model = createExplanationModel()
    const retriever = {
      async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>) {
        return excludedUids.has(base.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
      }
    }
    const makeAgent = (matchModelSignature?: string): RequirementAnalysisAgent => createAgent(db, retriever, model, {
      embeddingModelVersion: 'contract-embedding-v1',
      matchModelSignature
    })
    const agent = makeAgent('contract-match-v1')
    await agent.ask({ question: '分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 1)
    const cached = await agent.ask({ question: '分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 1, 'repeated verified input must be a zero-model cache hit')
    assert.ok(cached.sources.some((source) => source.itemId === candidate.itemId))
    await agent.ask({ question: '请分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 2, 'query changes must invalidate persistent cache')
    await makeAgent('contract-match-v2').ask({ question: '分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 3, 'explanation model signature changes must invalidate persistent cache')
    // The current match-cache contract tracks every stored source field.
    // Even a normalizedText-only source change therefore invalidates it.
    db.updateRecordNormalizedText(candidate.uid, `${candidate.normalizedText}\n纯元数据变化`)
    await agent.ask({ question: '分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 4, 'normalizedText-only source changes must invalidate the persistent cache')
    upsert(db, {
      uid: candidate.uid,
      itemId: candidate.itemId,
      name: '缓存候选已变更',
      description: '需求管理页面现在支持查询订单明细和状态。',
      module: '需求管理'
    })
    await agent.ask({ question: '分析需求编号 CACHE-BASE' })
    assert.equal(model.calls.length, 5, 'candidate business content changes must invalidate persistent cache')
  })
}

const testProgressAndRerankerFailClosed = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = upsert(db, {
      uid: 'progress-base-uid', itemId: 'PROGRESS-BASE', name: '进度基准',
      description: '需求管理页面支持查询订单详情。', module: '需求管理'
    })
    const candidate = upsert(db, {
      uid: 'progress-candidate-uid', itemId: 'PROGRESS-CANDIDATE', name: '进度候选',
      description: '需求管理页面支持查询订单明细。', module: '需求管理'
    })
    persistReadyCard(db, base)
    const candidateCard = persistReadyCard(db, candidate)
    const model = createExplanationModel()
    const events: Array<{ stage?: string; progress?: { percent?: number } }> = []
    await createAgent(db, {
      async retrieve(_base, excludedUids) {
        return excludedUids.has(base.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
      }
    }, model, { onProgress: (event) => { if (event && typeof event === 'object') events.push(event as typeof events[number]) } }).ask({
      question: '分析需求编号 PROGRESS-BASE'
    })
    assert.deepEqual([...new Set(events.map((event) => event.stage))], ['route', 'locate', 'recall', 'rerank', 'score', 'explain', 'summary'])
    assert.ok(events.every((event) => Number.isFinite(event.progress?.percent)))
    assert.ok(!events.some((event) => ['match', 'reason', 'critique', 'review'].includes(event.stage ?? '')))

    let modelCalls = 0
    const failed = await createAgent(db, {
      async retrieve(_base, excludedUids) {
        return excludedUids.has(base.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
      }
    }, {
      client: {
        async chat() {
          modelCalls += 1
          throw new Error('model must not run after reranker validation failure')
        }
      }
    }, {
      reranker: {
        modelId: 'broken-reranker',
        async rerank(): Promise<RequirementRerankItem[]> {
          return [{ recordUid: 'unknown-reranker-uid', score: 99 }]
        }
      }
    }).ask({ question: '分析需求编号 PROGRESS-BASE' })
    assert.equal(modelCalls, 0)
    assert.equal(failed.dataViews.length, 0)
    assert.match(failed.answer, /匹配流程失败/)
  })
}

const testGenericIdsFollowTheSameBranch = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const first = upsert(db, { uid: 'generic-base-one', itemId: 'GENERIC-BASE-ONE', name: '通用基准一', description: '需求页面支持查询详情。' })
    const second = upsert(db, { uid: 'generic-base-two', itemId: 'GENERIC-BASE-TWO', name: '通用基准二', description: '需求页面支持查询详情。' })
    const candidate = upsert(db, { uid: 'generic-candidate', itemId: 'GENERIC-CANDIDATE', name: '通用候选', description: '需求页面支持查询明细。' })
    persistReadyCard(db, first)
    persistReadyCard(db, second)
    const candidateCard = persistReadyCard(db, candidate)
    const model = createExplanationModel()
    const retriever = {
      async retrieve(base: RequirementSemanticCard, excludedUids: Set<string>) {
        return excludedUids.has(first.uid) || excludedUids.has(second.uid) ? [candidateFor(db, candidate.uid, candidateCard)] : []
      }
    }
    const response = await createAgent(db, retriever, model).ask({ question: '分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO' })
    assert.equal(model.calls.length, 2, 'generic base IDs must use the same one-call branch independently')
    assert.equal(response.sources.length, 2)
    assert.deepEqual(extractRequirementAnalysisIds('分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO、GENERIC-BASE-ONE'), [
      'GENERIC-BASE-ONE', 'GENERIC-BASE-TWO'
    ])
  })
}

const main = async (): Promise<void> => {
  testSemanticSourceCleaning()
  testDeterministicHardRules()
  await testExplanationProtocol()
  await testAgentSingleBatchAndFallback()
  await testSourceOnlyMatchingNeedsNoSemanticizationCall()
  await testAgentTop20Top10Bounds()
  await testPersistentCacheAndInvalidation()
  await testProgressAndRerankerFailClosed()
  await testGenericIdsFollowTheSameBranch()
  console.log(JSON.stringify({
    ok: true,
    contract: 'requirement-analysis-v2',
    checks: [
      'source-only cleaning does not infer regex semantics',
      'deterministic action/object hard rules',
      'strict explanation UID/evidence/decision validation',
      'single batch explanation with deterministic fallback',
      'source-only records participate without query-time semanticization',
      'Cross-Encoder Top20 and explanation Top10 bounds',
      'persistent explanation cache hit and invalidation',
      'new structured progress stages and reranker fail-closed handling',
      'generic IDs use the same matching branch'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
