import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import { RequirementAnalysisAgent, extractRequirementAnalysisIds } from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import { buildRequirementSourceView, buildRequirementBusinessText } from '../../src/main/requirements/requirement-match-card'
import { explainRequirementMatches, tryParseRequirementMatchExplanationResponse } from '../../src/main/requirements/requirement-match-explainer'
import {
  REQUIREMENT_MATCH_DECISION_PATHS,
  scoreRequirementCandidate
} from '../../src/main/requirements/requirement-match-scoring'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'requirement-contract-regression-model',
  thinking: false
}

const addRecord = (db: AppDatabase, input: {
  uid: string
  itemId: string
  name: string
  description: string
  module?: string
}): RecordDetail => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'requirement-contract-regression-project',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: '2026-08-14T00:00:00.000Z',
    raw: {
      IssueType: 'Enhancement',
      _valm_Module: input.module ?? '订单管理',
      _valm_Description: input.description
    },
    normalizedText: `${input.name}\n${input.description}`
  })
  const record = db.getRecord(input.uid, false)
  assert.ok(record, `record was not persisted: ${input.uid}`)
  return record
}

const candidateFor = (record: RecordDetail, denseScore = 80): HybridRequirementCandidate => ({
  record,
  card: buildRequirementSourceView(record),
  denseScore,
  lexicalScore: denseScore - 2,
  retrievalScore: denseScore / 100,
  snippet: record.description
} as HybridRequirementCandidate)

const validModel = (onInput?: (input: ModelChatInput) => void): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: number
} => {
  const model = {
    calls: 0,
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        model.calls += 1
        onInput?.(input)
        const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
          requirement?: { evidenceSegments?: Array<{ id: string }> }
          candidates?: Array<{ recordUid: string; evidenceSegments?: Array<{ id: string }> }>
        }
        const baseEvidence = payload.requirement?.evidenceSegments?.[0]?.id ?? 'B001'
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              summary: 'source-only explanation',
              items: (payload.candidates ?? []).map((candidate) => ({
                recordUid: candidate.recordUid,
                relation: 'partial_overlap',
                similarities: ['业务原文存在相近场景。'],
                differences: ['操作范围需要结合完整原文核对。'],
                baseEvidence,
                candidateEvidence: candidate.evidenceSegments?.[0]?.id ?? 'C001'
              }))
            })
          }
        }
      }
    }
  }
  return model
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'requirement-contract-regression-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'contract.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const testSourceCardContract = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const record = addRecord(db, {
      uid: 'source-card-record',
      itemId: 'SOURCE-CARD-001',
      name: '<span>订单明细导出</span>',
      description: '<p>支持按<strong>订单编号</strong>查询 &quot;订单&quot; &amp; 详情。<br/><script>alert(1)</script></p>'
    })
    const card = buildRequirementSourceView(record)
    assert.equal(card.evidence, buildRequirementBusinessText(record))
    assert.ok(card.evidence.includes('订单编号'))
    assert.ok(card.evidence.includes('"订单" & 详情'))
    assert.doesNotMatch(card.evidence, /<[^>]+>/)
    assert.doesNotMatch(card.evidence, /alert\(1\)/)
    assert.equal(card.matchingText, card.evidence)
    assert.ok(card.lexicalTerms.length > 0)
    assert.deepEqual(Object.keys(card).sort(), [
      'artifactType', 'businessFacts', 'evidence', 'lexicalTerms', 'matchingText', 'module', 'productDomain',
      'requirementType', 'sourceDescription', 'sourceTitle'
    ].sort())
  })
}

const testScoringUsesSupportedDecisionPath = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'score-base', itemId: 'SCORE-BASE', name: '订单明细导出',
      description: '订单管理页面支持导出订单明细。'
    })
    const candidate = addRecord(db, {
      uid: 'score-candidate', itemId: 'SCORE-CANDIDATE', name: '订单明细导出规则',
      description: '订单管理页面支持导出订单明细。'
    })
    const result = scoreRequirementCandidate(
      buildRequirementSourceView(base),
      candidateFor(candidate),
      { rerankerScore: 61, weights: { reranker: 1 } }
    )
    assert.ok(REQUIREMENT_MATCH_DECISION_PATHS.includes(result.decisionPath))
    assert.ok(['exact_text', 'near_duplicate_text', 'deterministic_score'].includes(result.decisionPath))
  })
}

const testExplanationPayloadIsSourceOnlyAndValidated = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'explain-base', itemId: 'EXPLAIN-BASE', name: '订单查询',
      description: '订单管理页面支持查询订单详情。'
    })
    const candidate = addRecord(db, {
      uid: 'explain-candidate', itemId: 'EXPLAIN-CANDIDATE', name: '订单明细查询',
      description: '订单管理页面支持查询订单明细。'
    })
    const request = {
      base: buildRequirementSourceView(base),
      candidates: [candidateFor(candidate)]
    }
    const model = validModel()
    const result = await explainRequirementMatches(model.client, request)
    assert.equal(model.calls, 1)
    assert.equal(result.items[0]?.recordUid, candidate.uid)
    assert.ok(result.items[0]?.baseEvidence.includes('名称：'))
    assert.deepEqual(Object.keys(request.base).sort(), Object.keys(request.candidates[0]!.card).sort())

    const unknownUid = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({ ...result, items: [{ ...result.items[0], recordUid: 'unknown-uid' }] }),
      request
    )
    assert.equal(unknownUid.ok, false)
    if (!unknownUid.ok) assert.equal(unknownUid.error.code, 'uid')
    const invalidEvidence = tryParseRequirementMatchExplanationResponse(
      JSON.stringify({ ...result, items: [{ ...result.items[0], baseEvidence: 'B999', candidateEvidence: 'C999' }] }),
      request
    )
    assert.equal(invalidEvidence.ok, false)
    if (!invalidEvidence.ok) assert.equal(invalidEvidence.error.code, 'evidence')
  })
}

const testAgentUsesSourceOnlyWithoutGeneration = async (): Promise<void> => {
  await withDatabase(async (db) => {
    const base = addRecord(db, {
      uid: 'agent-base', itemId: 'AGENT-BASE', name: '库存查询',
      description: '库存管理页面支持查询库存详情。'
    })
    const candidate = addRecord(db, {
      uid: 'agent-candidate', itemId: 'AGENT-CANDIDATE', name: '库存明细查询',
      description: '库存管理页面支持查询库存明细。'
    })
    let calls = 0
    const model = validModel((input) => {
      calls += 1
      const content = input.messages.at(-1)?.content ?? ''
      assert.match(content, /"evidence"/)
    })
    const response = await new RequirementAnalysisAgent(
      db,
      {} as KnowledgeService,
      settings,
      undefined,
      {
        retriever: {
          async retrieve(_base, excludedUids) {
            return excludedUids.has(base.uid) ? [candidateFor(candidate)] : []
          }
        },
        reranker: {
          modelId: 'contract-reranker',
          async rerank(_base, candidates) {
            return candidates.map((item) => ({ recordUid: item.record.uid, score: 80 }))
          }
        },
        modelClient: model.client
      }
    ).ask({ question: '分析需求编号 AGENT-BASE' })
    assert.equal(calls, 1, 'matching must issue only the explanation call')
    assert.ok(response.sources.some((source) => source.uid === candidate.uid))
  })
}

const testGenericIds = (): void => {
  assert.deepEqual(
    extractRequirementAnalysisIds('分析需求编号 GENERIC-ONE、GENERIC-TWO、GENERIC-ONE'),
    ['GENERIC-ONE', 'GENERIC-TWO']
  )
  assert.deepEqual(
    extractRequirementAnalysisIds('帮我分析需求:4101, 4095，4085'),
    ['4101', '4095', '4085']
  )
  assert.deepEqual(
    extractRequirementAnalysisIds('按区域分析：PM：4101、4095；华东区：4059-4063；所有编号前面都有前缀VISSLM-TSIS-', 200),
    ['VISSLM-TSIS-4101', 'VISSLM-TSIS-4095', 'VISSLM-TSIS-4059', 'VISSLM-TSIS-4060', 'VISSLM-TSIS-4061', 'VISSLM-TSIS-4062', 'VISSLM-TSIS-4063']
  )
}

const tests: Array<[string, () => Promise<void> | void]> = [
  ['source-only card preserves cleaned business evidence', testSourceCardContract],
  ['deterministic scoring uses a supported decision path', testScoringUsesSupportedDecisionPath],
  ['explanation payload uses source evidence and validates UID/evidence', testExplanationPayloadIsSourceOnlyAndValidated],
  ['requirement agent matches source-only records', testAgentUsesSourceOnlyWithoutGeneration],
  ['generic and numeric requirement IDs retain the common path', testGenericIds]
]

const main = async (): Promise<void> => {
  const results: Array<{ name: string; status: 'passed' | 'failed'; error?: string }> = []
  for (const [name, test] of tests) {
    try {
      await test()
      results.push({ name, status: 'passed' })
    } catch (error) {
      results.push({ name, status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
  }
  const failed = results.filter((result) => result.status === 'failed')
  console.log(JSON.stringify({ ok: failed.length === 0, contract: 'requirement-analysis-source-only', results }, null, 2))
  if (failed.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
