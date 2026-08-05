import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { KnowledgeService } from '../src/main/knowledge'
import { OllamaAgent } from '../src/main/ollama'

const assert = (condition: unknown, message: string): asserts condition => {
  if (!condition) throw new Error(message)
}

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-rag-fallback-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    db.upsertRecord({
      uid: 'record-performance-1',
      projectId: 'project-1',
      nodeType: 'Requirement',
      itemId: 'REQ-1',
      parentId: '',
      name: '性能优化需求',
      lastModifyTime: new Date().toISOString(),
      raw: { IssueType: 'Requirement', Summary: '性能优化' },
      normalizedText: '性能优化需求：响应时间需要降低。'
    })

    const knowledge = {
      modelVersion: 'test-model',
      search: async () => []
    } as unknown as KnowledgeService
    const progressStages: string[] = []
    const agent = new OllamaAgent(db, {
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      thinking: false
    }, knowledge, (event) => progressStages.push(event.stage))
    const responses = [
      {
        message: {
          role: 'assistant' as const,
          content: JSON.stringify({
            intent: 'search_content',
            explanation: '查找性能相关记录',
            searchTerms: ['性能'],
            searchMode: 'any',
            filters: [],
            fields: [],
            limit: 10
          })
        }
      },
      {
        message: {
          role: 'assistant' as const,
          content: '请依据查询结果回答。'
        }
      }
    ]
    let modelCallCount = 0
    Object.defineProperty(agent, 'callModel', {
      configurable: true,
      value: async () => {
        const response = responses[modelCallCount]
        modelCallCount += 1
        if (!response) throw new Error('mock model called more times than expected')
        return response
      }
    })

    const result = await agent.ask({ question: '请查找性能相关记录' })
    assert(modelCallCount === 2, 'RAG miss should fall back to the structured planner')
    assert(result.answer.includes('性能优化需求'), 'fallback answer should include the matched data-center record')
    assert(result.dataViews.length === 1, 'fallback should expose a structured data view')
    assert(result.sources.some((source) => source.uid === 'record-performance-1'), 'fallback should expose the record source')
    for (const stage of ['route', 'retrieve', 'plan', 'query', 'verify']) {
      assert(progressStages.includes(stage), `agent progress should include ${stage}`)
    }
    console.log(JSON.stringify({ ok: true, progressStages }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
