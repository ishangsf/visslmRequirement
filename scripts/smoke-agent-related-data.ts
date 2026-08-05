import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import type { KnowledgeSearchHit } from '../src/main/knowledge'
import { KnowledgeService } from '../src/main/knowledge'
import { OllamaAgent } from '../src/main/ollama'

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message)
}

const makeHit = (
  uid: string,
  name: string,
  content: string,
  score: number
): KnowledgeSearchHit => ({
  source: {
    uid,
    name,
    nodeType: 'knowledge_document',
    itemId: uid,
    sourceType: 'document',
    fileName: uid + '.txt',
    snippet: content,
    score
  },
  chunk: {
    id: 'chunk-' + uid,
    documentId: uid,
    sourceType: 'document',
    sourceName: name,
    content,
    chunkIndex: 0,
    location: '第 1 页',
    charStart: 0,
    charEnd: content.length
  },
  score
})

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-related-data-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    const hits = [
      makeHit(
        'doc-signing-improvement',
        'PDF 签署功能改进',
        '签署功能改进：开发库入库单签署逻辑和受控库签署入库工作流。',
        0.91
      ),
      makeHit(
        'doc-signing-config',
        '文档签署时的配置项关联',
        '签署前需查看关联的配置项文档内容。',
        0.84
      ),
      makeHit(
        'doc-archive-sync',
        '档案数据同步与权限',
        '用户填写的档案数据需同步至各层级档案，权限配置控制访问。',
        0.79
      ),
      makeHit(
        'doc-usage-statistics',
        '文档使用统计',
        '统计文档的使用时间，并提供查询报表。',
        0.72
      ),
      makeHit(
        'doc-search',
        '搜索功能优化',
        '优化全文搜索和结果排序。',
        0.61
      )
    ]
    let searchQuery = ''
    let modelCallCount = 0
    const knowledge = {
      modelVersion: 'test-model',
      search: async (query: string) => {
        searchQuery = query
        return hits
      }
    } as unknown as KnowledgeService
    const progressStages: string[] = []
    const agent = new OllamaAgent(db, {
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      thinking: false
    }, knowledge, (event) => progressStages.push(event.stage))

    const draftItems = hits.map((hit, index) => ({
      sourceIndex: index + 1,
      relation: 'direct',
      claim: hit.source.name,
      evidence: hit.chunk.content
    }))
    const verifiedItems = [
      {
        sourceIndex: 1,
        relation: 'direct',
        claim: '证据明确提到签署功能改进。',
        evidence: '签署功能改进：开发库入库单签署逻辑'
      },
      {
        sourceIndex: 2,
        relation: 'direct',
        claim: '证据明确提到文档签署和配置项文档。',
        evidence: '签署前需查看关联的配置项文档内容。'
      },
      {
        sourceIndex: 3,
        relation: 'direct',
        claim: '模型试图把档案同步归入签署功能，但原文没有签署主题词。',
        evidence: '用户填写的档案数据需同步至各层级档案'
      },
      {
        sourceIndex: 4,
        relation: 'indirect',
        claim: '文档使用统计最多只能作为语义相近的候选。',
        evidence: '统计文档的使用时间，并提供查询报表。'
      },
      {
        sourceIndex: 5,
        relation: 'none',
        claim: '证据没有足够关系。',
        evidence: ''
      }
    ]

    Object.defineProperty(agent, 'callModel', {
      configurable: true,
      value: async (input: { think?: boolean; format?: unknown }) => {
        modelCallCount += 1
        assert(input.think === true, 'related-data review must enable deep thinking')
        assert(JSON.stringify(input.format).includes('direct'), 'related-data review must use relation schema')
        if (modelCallCount === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({ summary: '初审把所有语义候选都判为直接相关。', items: draftItems })
            }
          }
        }
        if (modelCallCount === 2) {
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({ summary: '复核仍试图把档案同步作为直接相关，但需要由服务端主题证据规则拦截。', items: verifiedItems })
            }
          }
        }
        throw new Error('related-data review called more than twice')
      }
    })

    const result = await agent.ask({ question: '与签署功能相关的数据有哪些？' })
    assert(searchQuery === '签署功能', 'related-data route should search the extracted topic')
    assert(modelCallCount === 2, 'related-data route should perform analysis and independent review')
    assert(result.answer.includes('直接相关的数据（2 条）'), 'only two explicit signing sources should be direct')
    assert(result.answer.includes('PDF 签署功能改进'), 'direct result should include the PDF signing source')
    assert(result.answer.includes('文档签署时的配置项关联'), 'direct result should include the configuration source')
    assert(!result.answer.includes('档案数据同步与权限'), 'a model direct label without topic evidence must be rejected')
    assert(result.answer.includes('可能间接相关的候选'), 'indirect results should be separated from direct results')
    assert(result.answer.includes('文档使用统计'), 'validated indirect evidence should remain visibly separated')
    assert(result.sources.length === 3, 'sources should include only validated direct and indirect items')
    assert(result.dataViews.length === 1, 'related-data route should expose a structured data view')
    assert(result.dataViews[0]?.groups[0]?.name === '直接相关', 'data view direct group should be first')
    assert(result.dataViews[0]?.groups[0]?.rows.length === 2, 'data view should contain two direct rows')
    assert(result.dataViews[0]?.groups[1]?.name === '可能间接相关', 'data view should separate indirect group')
    for (const stage of ['route', 'retrieve', 'reason', 'critique']) {
      assert(progressStages.includes(stage), 'agent progress should include ' + stage)
    }

    console.log(JSON.stringify({
      ok: true,
      directSources: result.dataViews[0]?.groups[0]?.rows.map((row) => row.name),
      indirectSources: result.dataViews[0]?.groups[1]?.rows.map((row) => row.name),
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
