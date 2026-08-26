import type { ChatSource } from '../../../shared/types'
import { AppDatabase } from '../../database'
import { KnowledgeService, type KnowledgeSearchHit } from '../../knowledge'
import { assertAssistantAgentToolAllowed } from '../agent-registry'

export interface KnowledgeBaseExecution {
  hits: KnowledgeSearchHit[]
  missingReason?: string
}

export interface KnowledgeBaseAgentOptions {
  onProgress?: (message: string) => void
}

/** The only execution boundary allowed to search uploaded document chunks. */
export class KnowledgeBaseAgent {
  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge?: KnowledgeService,
    private readonly options: KnowledgeBaseAgentOptions = {}
  ) {}

  async search(
    question: string,
    evidenceLimit = 8
  ): Promise<KnowledgeBaseExecution> {
    assertAssistantAgentToolAllowed('knowledge-base', 'search_document_chunks')
    if (!this.knowledge) return { hits: [], missingReason: '知识库服务未配置' }
    this.options.onProgress?.('正在检索上传文档知识库')
    const limit = Math.min(20, Math.max(1, Math.trunc(evidenceLimit)))
    const hits = await this.knowledge.search(
      question,
      limit,
      { sourceType: 'document' }
    )
    // Keep this second boundary check for older adapters that do not yet
    // implement source filtering correctly.
    const documentHits = hits.filter((hit) => (
      hit.source.sourceType === 'document' && hit.chunk.sourceType === 'document'
    ))
    if (documentHits.length) return { hits: documentHits.slice(0, limit) }
    const stats = this.db.getKnowledgeStats(this.knowledge.modelVersion)
    const missingReason = !stats.documentCount || !stats.indexedChunkCount
      ? '知识库文档尚未完成可用索引'
      : '知识库文档中没有检索到足够匹配的证据'
    return { hits: [], missingReason }
  }

  hasDocumentEvidence(hits: readonly KnowledgeSearchHit[]): boolean {
    return hits.some((hit) => (
      hit.source.sourceType === 'document' &&
      hit.chunk.sourceType === 'document' &&
      Boolean((hit.source as ChatSource).uid)
    ))
  }
}
