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
  sourceType: 'document' | 'record',
  content: string
): KnowledgeSearchHit => ({
  source: {
    uid,
    name: uid,
    nodeType: sourceType === 'document' ? 'knowledge_document' : 'Requirement',
    itemId: uid,
    sourceType,
    ...(sourceType === 'document' ? { documentId: uid, fileName: `${uid}.txt` } : { recordUid: uid }),
    snippet: content,
    score: 0.91
  },
  chunk: {
    id: `chunk-${uid}`,
    ...(sourceType === 'document' ? { documentId: uid } : { recordUid: uid }),
    sourceType,
    sourceName: uid,
    content,
    chunkIndex: 0,
    location: sourceType === 'document' ? '第 1 页' : '数据中心记录',
    charStart: 0,
    charEnd: content.length
  },
  score: 0.91
})

const main = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-related-data-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'agent.db'), join(directory, 'assets'))
    const documentHit = makeHit('doc-signing', 'document', '签署功能的发布和配置说明。')
    const recordHit = makeHit('record-signing', 'record', '数据中心中的签署需求。')
    const searchCalls: Array<{ query: string; limit?: number; sourceType?: string }> = []
    const knowledge = {
      modelVersion: 'test-model',
      search: async (query: string, limit?: number, options?: { sourceType?: string }) => {
        searchCalls.push({ query, limit, sourceType: options?.sourceType })
        // Simulate an older adapter that ignores the filter. The agent boundary
        // must still exclude record vectors from a document-only answer.
        return [documentHit, recordHit]
      }
    } as unknown as KnowledgeService
    const progressStages: string[] = []
    const agent = new OllamaAgent(db, {
      baseUrl: 'http://127.0.0.1:1',
      model: 'test-model',
      thinking: false
    }, knowledge, (event) => progressStages.push(event.stage))

    let modelCallCount = 0
    Object.defineProperty(agent, 'callModel', {
      configurable: true,
      value: async () => {
        modelCallCount += 1
        if (modelCallCount === 1) {
          return {
            message: {
              role: 'assistant' as const,
              content: JSON.stringify({
                sourceMode: 'knowledge',
                needsClarification: false,
                intent: 'search_content'
              })
            }
          }
        }
        if (modelCallCount === 2) {
          return {
            message: {
              role: 'assistant' as const,
              content: '知识库文档说明了签署功能的发布和配置。[UID:doc-signing]'
            }
          }
        }
        throw new Error('unified knowledge route called the model more than twice')
      }
    })

    const question = '知识库中与签署功能相关的资料有哪些？'
    const result = await agent.ask({ question })
    assert(modelCallCount === 2, 'knowledge mode should classify once and answer once')
    assert(searchCalls.length === 1, 'knowledge mode should execute one bounded retrieval')
    assert(searchCalls[0]?.query === question, 'knowledge retrieval should preserve the full user question')
    assert(searchCalls[0]?.limit === 8, 'knowledge evidence must use the bounded Top-K budget')
    assert(searchCalls[0]?.sourceType === 'document', 'knowledge mode must request document vectors only')
    assert(result.sources.length === 1 && result.sources[0]?.uid === 'doc-signing', 'record vectors must not enter a document answer')
    assert(result.dataViews.length === 0, 'document evidence must not fabricate a data-center view')
    assert(result.answer.includes('[UID:doc-signing]'), 'the answer must retain a validated document UID citation')
    for (const stage of ['route', 'plan', 'query', 'retrieve', 'verify']) {
      assert(progressStages.includes(stage), `agent progress should include ${stage}`)
    }

    console.log(JSON.stringify({ ok: true, searchCalls, progressStages }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
