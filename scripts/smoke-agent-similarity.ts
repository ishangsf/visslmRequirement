import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import type { KnowledgeRecordMatch } from '../src/main/knowledge'
import { KnowledgeService } from '../src/main/knowledge'
import { OllamaAgent } from '../src/main/ollama'

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message)
}

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-similarity-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    const records = [
      {
        uid: 'record-base',
        projectId: 'project-1',
        nodeType: 'TSIssue',
        itemId: 'VISSLM-TSIS-3959',
        name: '需求条目导出格式优化',
        normalizedText: '需求条目导出 Excel 时需要保留编号、标题和层级格式。'
      },
      {
        uid: 'record-similar-high',
        projectId: 'project-1',
        nodeType: 'TSIssue',
        itemId: 'VISSLM-TSIS-4100',
        name: '需求导出字段与层级保持',
        normalizedText: '导出需求到 Excel 时保留字段和树形层级。'
      },
      {
        uid: 'record-similar-medium',
        projectId: 'project-1',
        nodeType: 'TSIssue',
        itemId: 'VISSLM-TSIS-4200',
        name: '需求编号导出',
        normalizedText: '导出需求列表时显示业务编号。'
      },
      {
        uid: 'record-low-score',
        projectId: 'project-1',
        nodeType: 'TSIssue',
        itemId: 'VISSLM-TSIS-4300',
        name: '低相关记录',
        normalizedText: '用户头像上传。'
      },
      {
        uid: 'record-wrong-type',
        projectId: 'project-1',
        nodeType: 'TestCase',
        itemId: 'VISSLM-TC-100',
        name: '导出测试用例',
        normalizedText: '验证需求导出 Excel 的字段。'
      }
    ]
    for (const record of records) {
      db.upsertRecord({
        ...record,
        parentId: '',
        lastModifyTime: new Date().toISOString(),
        raw: { Summary: record.name }
      })
    }

    const matches: KnowledgeRecordMatch[] = [
      {
        recordUid: 'record-similar-medium',
        recordName: '占位名称不应展示',
        nodeType: 'record',
        itemId: 'record-similar-medium',
        score: 68.24,
        chunkId: 'chunk-medium',
        snippet: '中等相似候选'
      },
      {
        recordUid: 'record-base',
        recordName: '基准记录',
        nodeType: 'record',
        itemId: 'record-base',
        score: 100,
        chunkId: 'chunk-base',
        snippet: '基准记录自身'
      },
      {
        recordUid: 'record-wrong-type',
        recordName: '其他类型',
        nodeType: 'record',
        itemId: 'record-wrong-type',
        score: 96,
        chunkId: 'chunk-wrong-type',
        snippet: '其他类型候选'
      },
      {
        recordUid: 'record-low-score',
        recordName: '低分候选',
        nodeType: 'record',
        itemId: 'record-low-score',
        score: 39.9,
        chunkId: 'chunk-low',
        snippet: '低分候选'
      },
      {
        recordUid: 'record-similar-high',
        recordName: '另一个占位名称',
        nodeType: 'record',
        itemId: 'record-similar-high',
        score: 82.56,
        chunkId: 'chunk-high',
        snippet: '高相似候选'
      }
    ]
    let rankCallCount = 0
    let ragSearchCallCount = 0
    const knowledge = {
      modelVersion: 'test-model',
      rankRecordMatches: async (query: string) => {
        rankCallCount += 1
        assert(query === records[0].normalizedText, 'similarity query should use the base record normalized text')
        return matches
      },
      search: async () => {
        ragSearchCallCount += 1
        throw new Error('generic RAG must not run for record similarity queries')
      }
    } as unknown as KnowledgeService
    const progressStages: string[] = []
    const agent = new OllamaAgent(db, {
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      thinking: false
    }, knowledge, (event) => progressStages.push(event.stage))
    const draftReview = {
      summary: '两条候选都涉及需求导出，但覆盖范围和约束不同。',
      items: [
        {
          recordUid: 'record-similar-high',
          score: 83,
          verdict: 'none',
          sharedEvidence: '都要求需求导出 Excel 时保留字段和层级信息',
          difference: '候选没有明确提及标题字段'
        },
        {
          recordUid: 'record-similar-medium',
          score: 62,
          verdict: 'high',
          sharedEvidence: '都涉及导出需求业务编号',
          difference: '候选只覆盖编号，没有覆盖标题和层级格式'
        }
      ]
    }
    const verifiedReview = {
      summary: '深度复核确认两条记录与基准需求存在实质相似，但第一条覆盖范围更完整。',
      items: [
        {
          recordUid: 'record-similar-high',
          score: 86,
          verdict: 'none',
          sharedEvidence: '都要求需求导出 Excel 时保留字段和树形层级',
          difference: '候选没有明确要求导出标题字段'
        },
        {
          recordUid: 'record-similar-medium',
          score: 58,
          verdict: 'high',
          sharedEvidence: '都要求导出需求业务编号',
          difference: '候选未覆盖 Excel、标题和层级格式要求'
        }
      ]
    }
    let modelCallCount = 0
    Object.defineProperty(agent, 'callModel', {
      configurable: true,
      value: async (input: { think?: boolean; format?: unknown; messages?: unknown[] }) => {
        modelCallCount += 1
        assert(input.think === true, 'similarity analysis should explicitly enable deep thinking')
        assert(!JSON.stringify(input.format).includes('verdict'), 'similarity schema should use score as the single source of truth')
        const serializedInput = JSON.stringify(input)
        assert(!serializedInput.includes('record-wrong-type'), 'wrong-type candidates must not reach the model')
        assert(!serializedInput.includes('record-low-score'), 'low-score candidates must not reach the model')
        const review = modelCallCount === 1 ? draftReview : verifiedReview
        if (modelCallCount > 2) throw new Error('similarity analysis should use exactly two model passes')
        return { message: { role: 'assistant' as const, content: JSON.stringify(review) } }
      }
    })

    const response = await agent.ask({
      question: '@通用数据助手 和编号 VISSLM-TSIS-3959 差不多的需求条目有哪些？'
    })
    assert(rankCallCount === 1, 'similarity ranking should run exactly once')
    assert(ragSearchCallCount === 0, 'similarity query should bypass generic RAG')
    assert(modelCallCount === 2, 'similarity query should run deep analysis and independent verification')
    assert(response.sources.length === 2, 'only same-type candidates above the threshold should remain')
    assert(response.sources[0]?.uid === 'record-similar-high', 'results should sort by score descending')
    assert(response.sources[0]?.itemId === 'VISSLM-TSIS-4100', 'sources should use the real business item ID')
    assert(response.sources[0]?.nodeType === 'TSIssue', 'sources should use the real record type')
    assert(response.sources[0]?.name === '需求导出字段与层级保持', 'sources should use the database record name')
    assert(!response.sources.some((source) => source.uid === 'record-base'), 'base record should be excluded')
    assert(!response.sources.some((source) => source.uid === 'record-wrong-type'), 'other record types should be excluded')
    assert(!response.sources.some((source) => source.uid === 'record-low-score'), 'low-score candidates should be excluded')
    assert(response.answer.includes('86.0%'), 'answer should show the independently verified score')
    assert(!response.answer.includes('分数与相似等级不一致'), 'model-provided verdict must not override the numeric score')
    assert(response.answer.includes('第一条覆盖范围更完整'), 'answer should include the verified model summary')
    assert(response.dataViews.length === 1, 'similarity results should expose a data view')
    assert(response.dataViews[0]?.groups[0]?.rows[0]?.uid === 'record-similar-high', 'data view should preserve result order')
    assert(response.dataViews[0]?.groups[0]?.rows[0]?.values.aiSimilarity === '86.0%', 'data view should expose verified similarity')
    assert(response.dataViews[0]?.groups[0]?.rows[0]?.values.semanticRecall === '82.6%', 'data view should preserve the recall score')
    for (const stage of ['route', 'locate', 'match', 'verify', 'reason', 'critique', 'answer']) {
      assert(progressStages.includes(stage), `agent progress should include ${stage}`)
    }

    const missingReference = await agent.ask({ question: '帮我找一些相似的需求记录' })
    assert(missingReference.answer.includes('请提供一条作为比较基准的业务编号'), 'missing base ID should return a recoverable prompt')
    assert(rankCallCount === 1, 'missing base ID must not run similarity ranking')

    const unknownReference = await agent.ask({ question: '和编号 VISSLM-TSIS-9999 类似的需求有哪些？' })
    assert(unknownReference.answer.includes('不存在编号'), 'unknown base ID should be reported explicitly')
    assert(unknownReference.answer.includes('未执行宽泛检索'), 'unknown base ID should not fall back to broad retrieval')
    assert(rankCallCount === 1, 'unknown base ID must not run similarity ranking')
    assert(ragSearchCallCount === 0, 'all similarity branches should bypass generic RAG')
    assert(modelCallCount === 2, 'missing and unknown base IDs must not call the model')

    const invalidAgent = new OllamaAgent(db, {
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      thinking: false
    }, knowledge)
    let invalidModelCallCount = 0
    Object.defineProperty(invalidAgent, 'callModel', {
      configurable: true,
      value: async () => {
        invalidModelCallCount += 1
        return {
          message: {
            role: 'assistant' as const,
            content: JSON.stringify({
              summary: '包含模型自行添加的候选。',
              items: [{
                recordUid: 'invented-record',
                score: 95,
                verdict: 'high',
                sharedEvidence: '无真实依据',
                difference: '无'
              }]
            })
          }
        }
      }
    })
    const rejectedReview = await invalidAgent.ask({
      question: '和编号 VISSLM-TSIS-3959 相似的需求条目有哪些？'
    })
    assert(invalidModelCallCount === 2, 'invalid first-pass review should retry once before failing closed')
    assert(rejectedReview.sources.length === 0, 'invalid model output must not expose any candidate')
    assert(rejectedReview.dataViews.length === 0, 'invalid model output must not expose a data view')
    assert(rejectedReview.answer.includes('本次不输出相似候选'), 'invalid model output should fail closed')

    console.log(JSON.stringify({
      ok: true,
      matchedItemIds: response.sources.map((source) => source.itemId),
      progressStages
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
