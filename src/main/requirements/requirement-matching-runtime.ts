import type { ModelSettings } from '../../shared/types'
import { AppDatabase } from '../database'
import { KnowledgeService } from '../knowledge'
import { ModelClient } from '../model-client'
import { createRequirementReranker } from './cross-encoder-reranker'
import { HybridRequirementRetriever } from './hybrid-retrieval'
import { hashRequirementBusiness } from './requirement-business-normalization'
import { buildRequirementSourceView } from './requirement-match-card'
import { explainRequirementMatches } from './requirement-match-explainer'
import { RequirementMatchingCore } from './requirement-matching-core'
import type { RequirementMatchRequest } from './requirement-match-domain'

type RequirementMatchRequestWithCurrentProject = RequirementMatchRequest & {
  currentProjectId?: string
}

export const createRequirementMatchingCore = (
  db: AppDatabase,
  knowledge: KnowledgeService,
  settings: () => ModelSettings
): RequirementMatchingCore => {
  const retriever = new HybridRequirementRetriever(db, knowledge)
  const reranker = createRequirementReranker()
  return new RequirementMatchingCore({
    retriever,
    reranker,
    explainer: {
      mode: () => settings().source === 'local' ? 'local' : 'online',
      async explain(base, candidates) {
        const current = settings()
        const result = await explainRequirementMatches(
          new ModelClient(current),
          { base, candidates },
          {
            think: current.thinking,
            forceThinking: current.thinking,
            temperature: 0,
            numPredict: current.source === 'local' && current.thinking ? -1 : Math.max(2_400, candidates.length * 260),
            numCtx: 32_768,
            timeoutMs: 120_000
          }
        )
        return new Map(result.items.map((item) => [item.recordUid, JSON.stringify(item)]))
      }
    },
    async exactBusinessHashCandidates(businessHash) {
      const records = await knowledge.listRequirementIndexedRecords()
      return records.flatMap((record) => {
        const card = buildRequirementSourceView(record)
        if (hashRequirementBusiness(card) !== businessHash) return []
        return [{ record, card, denseScore: 0, lexicalScore: 0, retrievalScore: 0, snippet: card.evidence }]
      })
    },
    candidateEligible(_candidate, request) {
      const scopedRequest = request as RequirementMatchRequestWithCurrentProject
      if (scopedRequest.includeCurrentProjectRecords) return true
      const currentProjectId = scopedRequest.currentProjectId?.trim()
      return !currentProjectId || _candidate.record.projectId !== currentProjectId
    }
  })
}
