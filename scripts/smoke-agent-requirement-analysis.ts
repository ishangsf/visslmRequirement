import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { AppDatabase } from '../src/main/database'
import type { KnowledgeRecordMatch, KnowledgeService } from '../src/main/knowledge'
import { RequirementAnalysisAgent, extractRequirementAnalysisIds } from '../src/main/experts/requirement-analysis-agent'

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-requirement-analysis-'))
  let db: AppDatabase | null = null
  const originalFetch = globalThis.fetch
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    const records = [
      {
        uid: 'base-1',
        itemId: 'REQ-1',
        name: '订单查询',
        description: '支持按订单编号查询订单详情。',
        module: '订单管理'
      },
      {
        uid: 'base-2',
        itemId: 'REQ-2',
        name: '库存查询',
        description: '支持按库存编号查询库存详情。',
        module: '库存管理'
      },
      {
        uid: 'match-1',
        itemId: 'DATA-1',
        name: '订单详情检索',
        description: '用户可以按订单号检索订单详情和状态。',
        module: '订单管理'
      },
      {
        uid: 'match-2',
        itemId: 'DATA-2',
        name: '库存明细查询',
        description: '按库存编号查看库存明细和状态。',
        module: '库存管理'
      }
    ]
    for (const record of records) {
      db.upsertRecord({
        uid: record.uid,
        projectId: 'project-1',
        nodeType: 'Requirement',
        itemId: record.itemId,
        parentId: '',
        name: record.name,
        lastModifyTime: new Date().toISOString(),
        raw: {
          _valm_Description: record.description,
          Module: record.module
        },
        normalizedText: `${record.name}\n${record.description}\n${record.module}`
      })
    }

    assert.deepEqual(
      extractRequirementAnalysisIds('@需求分析专家 分析需求编号 REQ-1、REQ-2'),
      ['REQ-1', 'REQ-2']
    )

    let rankCallCount = 0
    let modelCallCount = 0
    const knowledge = {
      rankRecordMatches: async (query: string): Promise<KnowledgeRecordMatch[]> => {
        rankCallCount += 1
        assert.match(query, /需求标题：/)
        assert.match(query, /业务模块：/)
        assert.match(query, /需求描述：/)
        return query.includes('订单查询')
          ? [
              { recordUid: 'base-2', recordName: '库存查询', nodeType: 'record', itemId: 'base-2', score: 99, chunkId: 'base-2-chunk', snippet: 'base' },
              { recordUid: 'match-1', recordName: '占位名称', nodeType: 'record', itemId: 'match-1', score: 82, chunkId: 'match-1-chunk', snippet: '订单详情' }
            ]
          : [
              { recordUid: 'base-1', recordName: '订单查询', nodeType: 'record', itemId: 'base-1', score: 99, chunkId: 'base-1-chunk', snippet: 'base' },
              { recordUid: 'match-2', recordName: '占位名称', nodeType: 'record', itemId: 'match-2', score: 76, chunkId: 'match-2-chunk', snippet: '库存明细' }
            ]
      }
    } as unknown as KnowledgeService
    globalThis.fetch = async () => {
      modelCallCount += 1
      const match = modelCallCount === 1
        ? { recordUid: 'match-1', score: 91, reason: '业务目标、订单检索方式和订单模块一致。' }
        : { recordUid: 'match-2', score: 88, reason: '业务目标、库存检索方式和库存模块一致。' }
      return new Response(JSON.stringify({
        message: {
          role: 'assistant',
          content: JSON.stringify({ summary: '候选与目标需求的业务能力一致。', matches: [match] })
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const progressStages: string[] = []
    const agent = new RequirementAnalysisAgent(db, knowledge, {
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'test-model',
      thinking: false
    }, (event) => progressStages.push(event.stage))
    const response = await agent.ask({
      question: '@需求分析专家 分析需求编号 REQ-1、REQ-2'
    })

    assert.equal(rankCallCount, 2)
    assert.equal(modelCallCount, 2)
    assert.equal(response.dataViews.length, 1)
    assert.equal(response.dataViews[0]?.groups.length, 2)
    assert.equal(response.dataViews[0]?.groups[0]?.rows[0]?.itemId, 'DATA-1')
    assert.equal(response.dataViews[0]?.groups[0]?.rows[0]?.values.matchScore, '91.0%')
    assert.equal(response.dataViews[0]?.groups[0]?.rows[0]?.values.module, '订单管理')
    assert.equal(response.dataViews[0]?.groups[1]?.rows[0]?.values.description, '按库存编号查看库存明细和状态。')
    assert.equal(response.sources.length, 2)
    assert.match(response.answer, /REQ-1 · 订单查询/)
    assert.match(response.answer, /DATA-1 · 订单详情检索/)
    assert.match(response.answer, /91\.0%/)
    assert.match(response.answer, /订单管理/)
    for (const stage of ['route', 'locate', 'match', 'verify', 'reason']) {
      assert.ok(progressStages.includes(stage), `missing progress stage ${stage}`)
    }

    const missing = await agent.ask({ question: '@需求分析专家 分析需求编号 REQ-404' })
    assert.equal(missing.dataViews.length, 0)
    assert.match(missing.answer, /REQ-404/)
    assert.match(missing.answer, /不存在/)
    assert.equal(rankCallCount, 2)
    assert.equal(modelCallCount, 2)

    console.log(JSON.stringify({ ok: true, matched: response.sources.map((source) => source.itemId), progressStages }))
  } finally {
    globalThis.fetch = originalFetch
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
