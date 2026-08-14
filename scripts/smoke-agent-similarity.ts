import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../src/main/database'
import { RequirementAnalysisAgent } from '../src/main/experts/requirement-analysis-agent'
import type { KnowledgeService } from '../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import type { RequirementReranker } from '../src/main/requirements/cross-encoder-reranker'
import type { HybridRequirementCandidate } from '../src/main/requirements/hybrid-retrieval'
import {
  buildRequirementSemanticCard,
  type RequirementSemanticCard
} from '../src/main/requirements/semantic-card'
import {
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../src/main/requirements/semanticization-service'
import type { ModelSettings, RecordDetail } from '../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'requirement-analysis-smoke-model',
  thinking: false
}

const semanticContext = {
  analyzerVersion: REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  modelSignature: requirementSemanticModelSignature(settings)
}

type ExplanationMode = 'valid' | 'different' | 'forbidden' | 'unknown-uid' | 'invalid-evidence'

type ExplanationPayload = {
  requirement?: { evidenceSegments?: Array<{ id: string }> }
  candidates?: Array<{ recordUid: string; evidenceSegments?: Array<{ id: string }> }>
}

type ExplanationModel = {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  inputs: ModelChatInput[]
  calls: number
}

const upsert = (db: AppDatabase, input: {
  uid: string
  itemId: string
  name: string
  description: string
}): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'requirement-analysis-similarity-smoke',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date().toISOString(),
    raw: {
      _valm_Description: input.description,
      IssueType: 'Enhancement',
      _valm_Module: '报表管理'
    },
    normalizedText: `${input.name}\n${input.description}\n报表管理`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `record was not persisted: ${input.uid}`)
  return record
}

const aiCard = (record: RecordDetail): RequirementSemanticCard => {
  const source = buildRequirementSemanticCard(record)
  const functionalObject = '报表导出'
  const action = 'add_capability' as const
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
    analysisSummary: 'similarity smoke 的 AI 语义卡片'
  }
}

const persistReadyCard = (db: AppDatabase, record: RecordDetail): RequirementSemanticCard => {
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash, `record has no content hash: ${record.uid}`)
  assert.equal(
    db.claimRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    true,
    `semantic-card claim failed: ${record.uid}`
  )
  const card = aiCard(record)
  db.completeRequirementSemanticCard(record.uid, card)
  assert.ok(
    db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...semanticContext }),
    `semantic card was not ready: ${record.uid}`
  )
  return card
}

const candidateFor = (db: AppDatabase, uid: string): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `candidate was not persisted: ${uid}`)
  const contentHash = db.getRecordContentHash(uid)
  assert.ok(contentHash, `candidate has no content hash: ${uid}`)
  const card = db.getReadyRequirementSemanticCard({ recordUid: uid, contentHash, ...semanticContext })
  assert.ok(card, `candidate semantic card was not ready: ${uid}`)
  return {
    record,
    card,
    denseScore: 96,
    lexicalScore: 94,
    structuralScore: 92,
    retrievalScore: 1,
    snippet: record.description
  }
}

const createReranker = (onInput?: (count: number) => void): RequirementReranker => ({
  modelId: 'similarity-smoke-cross-encoder',
  async rerank(_base, candidates) {
    onInput?.(candidates.length)
    return candidates.map((candidate, index) => ({
      recordUid: candidate.record.uid,
      score: 100 - index
    }))
  }
})

const explanationPayload = (input: ModelChatInput): ExplanationPayload => (
  JSON.parse(input.messages.at(-1)?.content ?? '{}') as ExplanationPayload
)

const explanationResponse = (
  input: ModelChatInput,
  mode: ExplanationMode
): ModelResponse => {
  const payload = explanationPayload(input)
  const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
  const candidates = payload.candidates ?? []
  const items = candidates.map((candidate, index) => ({
    recordUid: mode === 'unknown-uid' && index === 0 ? 'unknown-record-uid' : candidate.recordUid,
    relation: 'partial_overlap',
    similarities: [mode === 'different'
      ? '解释文本发生变化，但它不参与匹配决策。'
      : '两条需求都描述报表导出能力。'],
    differences: [mode === 'different'
      ? '解释文本变化不能改变确定性关系或分数。'
      : '候选记录的业务范围需要结合原文核对。'],
    baseEvidence: mode === 'invalid-evidence' ? 'B999' : baseEvidence,
    candidateEvidence: mode === 'invalid-evidence'
      ? 'C999'
      : candidate.evidenceSegments?.[0]?.id ?? 'C001',
    ...(mode === 'forbidden' ? { relation: 'duplicate', score: 99 } : {})
  }))
  return {
    message: {
      role: 'assistant',
      content: JSON.stringify({
        summary: mode === 'different'
          ? '另一种解释文本，仅用于验证解释与决策解耦。'
          : '单次批量解释完成。',
        items
      })
    }
  }
}

const createExplanationModel = (mode: ExplanationMode = 'valid'): ExplanationModel => {
  const model: ExplanationModel = {
    inputs: [],
    calls: 0,
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        model.inputs.push(input)
        return explanationResponse(input, mode)
      }
    }
  }
  return model
}

const createAgent = (
  db: AppDatabase,
  candidates: HybridRequirementCandidate[],
  model: ExplanationModel,
  matchModelSignature: string,
  onRerankInput?: (count: number) => void
): RequirementAnalysisAgent => new RequirementAnalysisAgent(
  db,
  {} as KnowledgeService,
  settings,
  undefined,
  {
    retriever: {
      async retrieve(_base, excludedUids): Promise<HybridRequirementCandidate[]> {
        return candidates.filter((candidate) => !excludedUids.has(candidate.record.uid))
      }
    },
    reranker: createReranker(onRerankInput),
    modelClient: model.client,
    semanticContext,
    matchModelSignature,
    embeddingModelVersion: 'similarity-smoke-embedding-v1'
  }
)

const rowsOf = (response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>) => (
  response.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows))
)

const rowFor = (
  response: Awaited<ReturnType<RequirementAnalysisAgent['ask']>>,
  uid: string
) => rowsOf(response).find((row) => row.uid === uid)

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-similarity-v2-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    const base = upsert(db, {
      uid: 'similarity-base-uid',
      itemId: 'BASE-ALPHA',
      name: '报表导出配置',
      description: '报表页面支持导出订单明细，并保留字段与层级。'
    })
    const genericBaseOne = upsert(db, {
      uid: 'generic-base-one-uid',
      itemId: 'GENERIC-BASE-ONE',
      name: '通用报表基准一',
      description: '报表页面支持导出订单明细，并保留字段与层级。'
    })
    const genericBaseTwo = upsert(db, {
      uid: 'generic-base-two-uid',
      itemId: 'GENERIC-BASE-TWO',
      name: '通用报表基准二',
      description: '报表页面支持导出订单明细，并保留字段与层级。'
    })
    persistReadyCard(db, base)
    persistReadyCard(db, genericBaseOne)
    persistReadyCard(db, genericBaseTwo)

    const candidateUids: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const candidate = upsert(db, {
        uid: `similarity-candidate-${index + 1}-uid`,
        itemId: `CANDIDATE-${String(index + 1).padStart(2, '0')}`,
        name: `报表导出候选 ${index + 1}`,
        description: '报表页面支持导出订单明细，并保留字段与层级。'
      })
      persistReadyCard(db, candidate)
      candidateUids.push(candidate.uid)
    }
    const candidates = candidateUids.map((uid) => candidateFor(db!, uid))

    let rerankerInputCount = 0
    const model = createExplanationModel('valid')
    const agent = createAgent(db, candidates, model, 'similarity-smoke-explanation-v1', (count) => {
      rerankerInputCount = count
    })
    const response = await agent.ask({ question: '分析需求编号 BASE-ALPHA' })
    assert.equal(rerankerInputCount, 12, 'Cross-Encoder must receive the full retrieved candidate set')
    assert.equal(model.calls, 1, 'one base must use one batch explanation call')
    assert.equal(model.inputs[0]?.format && JSON.stringify(model.inputs[0].format).includes('relation'), true)
    assert.equal(model.inputs[0]?.format && JSON.stringify(model.inputs[0].format).includes('score'), false)
    assert.equal(explanationPayload(model.inputs[0]!).candidates?.length, 10, 'only Top10 may enter explanation')
    assert.ok(response.sources.length > 0, 'deterministic scoring must keep visible matches')
    assert.equal(rowsOf(response).length, 10, 'visible results must be limited to deterministic Top20/AI Top10')
    assert.match(response.answer, /一次批量 AI 语义复核/)
    const baselineRow = rowFor(response, candidates[0]!.record.uid)
    assert.ok(baselineRow, 'the highest-ranked candidate must remain visible')
    const baselineDecision = {
      relation: baselineRow.values.relation,
      matchScore: baselineRow.values.matchScore
    }

    const changedExplanationModel = createExplanationModel('different')
    const changedExplanation = await createAgent(
      db,
      candidates,
      changedExplanationModel,
      'similarity-smoke-explanation-v2'
    ).ask({ question: '分析需求编号 BASE-ALPHA' })
    const changedRow = rowFor(changedExplanation, candidates[0]!.record.uid)
    assert.ok(changedRow)
    assert.deepEqual(
      { relation: changedRow.values.relation, matchScore: changedRow.values.matchScore },
      baselineDecision,
      'explanation text must not alter deterministic relation or score'
    )
    assert.equal(changedExplanationModel.calls, 1, 'changed explanation signature still uses one batch call')

    for (const mode of ['forbidden', 'unknown-uid', 'invalid-evidence'] as const) {
      const invalidModel = createExplanationModel(mode)
      const invalidResponse = await createAgent(
        db,
        candidates,
        invalidModel,
        `similarity-smoke-invalid-${mode}`
      ).ask({ question: '分析需求编号 BASE-ALPHA' })
      const invalidRow = rowFor(invalidResponse, candidates[0]!.record.uid)
      assert.ok(invalidRow, `${mode} explanation failure must retain deterministic output`)
      assert.deepEqual(
        { relation: invalidRow.values.relation, matchScore: invalidRow.values.matchScore },
        baselineDecision,
        `${mode} explanation failure must not alter deterministic relation or score`
      )
      assert.equal(invalidModel.calls, 1, `${mode} must fail closed without a repair pass`)
      assert.equal(invalidRow.values.explanationStatus, 'AI 语义复核暂不可用，正式关系已降级并保留召回审计')
    }

    const cachedAgain = await agent.ask({ question: '分析需求编号 BASE-ALPHA' })
    assert.equal(model.calls, 1, 'repeated verified input must hit persistent cache with zero model calls')
    assert.equal(rowFor(cachedAgain, candidates[0]!.record.uid)?.values.explanationStatus, '已复核缓存命中')
    await agent.ask({ question: '请分析需求编号 BASE-ALPHA' })
    assert.equal(model.calls, 2, 'query changes must invalidate the explanation cache')

    const genericCandidate = candidates[0]!
    const genericModel = createExplanationModel('valid')
    const genericResponse = await createAgent(
      db,
      [genericCandidate],
      genericModel,
      'similarity-smoke-generic-v1'
    ).ask({ question: '分析需求编号 GENERIC-BASE-ONE、GENERIC-BASE-TWO' })
    assert.equal(genericModel.calls, 2, 'generic IDs must use the same one-batch branch independently')
    assert.deepEqual(
      genericModel.inputs.map((input) => explanationPayload(input).candidates?.length),
      [1, 1]
    )
    assert.equal(genericResponse.sources.length, 2)

    console.log(JSON.stringify({
      ok: true,
      matchedCandidates: response.sources.map((source) => source.itemId),
      explanationCalls: model.calls,
      cachedExplanationCalls: 1,
      genericExplanationCalls: genericModel.calls
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
