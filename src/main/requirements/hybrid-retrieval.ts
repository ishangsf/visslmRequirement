import type { RecordDetail } from '../../shared/types'
import { AppDatabase } from '../database'
import type { KnowledgeRecordMatch } from '../knowledge'
import {
  buildRequirementSourceView,
  requirementLexicalTermsOf,
  type RequirementMatchCard
} from './requirement-match-card'

export interface HybridRequirementCandidate {
  record: RecordDetail
  card: RequirementMatchCard
  denseScore: number
  lexicalScore: number
  retrievalScore: number
  snippet: string
}

const ROUTE_LIMIT = 100
const CANDIDATE_LIMIT = 50
const RRF_K = 60

export interface RequirementDenseRetriever {
  readonly modelVersion: string
  listRequirementIndexedRecords(): Promise<RecordDetail[]>
  rankRequirementRecordMatches(
    question: string,
    limit?: number,
    allowedRecordUids?: ReadonlySet<string>
  ): Promise<KnowledgeRecordMatch[]>
}

const rankMap = <T extends { recordUid: string }>(items: T[]): Map<string, number> =>
  new Map(items.slice(0, ROUTE_LIMIT).map((item, index) => [item.recordUid, index + 1]))

export class HybridRequirementRetriever {
  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge: RequirementDenseRetriever
  ) {}

  async retrieve(base: RequirementMatchCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
    const indexedRecords = await this.knowledge.listRequirementIndexedRecords()
    const recordByUid = new Map(indexedRecords.map((record) => [record.uid, record]))
    if (!recordByUid.size) throw new Error(`当前模型 ${this.knowledge.modelVersion} 没有可用的数据中心记录索引`)
    const allowedRecordUids = new Set(recordByUid.keys())
    const dense = (await this.knowledge.rankRequirementRecordMatches(base.evidence, ROUTE_LIMIT, allowedRecordUids))
      .filter((item) => recordByUid.has(item.recordUid) && !excludedUids.has(item.recordUid))
      .slice(0, ROUTE_LIMIT)
    const lexical = this.db.searchRequirementRecordsLexical(
      requirementLexicalTermsOf([
        base.requirementType,
        base.productDomain,
        base.module,
        base.sourceTitle,
        base.sourceDescription,
        base.evidence,
        ...base.lexicalTerms
      ]),
      this.knowledge.modelVersion,
      ROUTE_LIMIT
    )
      .filter((item) => recordByUid.has(item.recordUid) && !excludedUids.has(item.recordUid))
      .slice(0, ROUTE_LIMIT)
    const denseRanks = rankMap(dense)
    const lexicalRanks = rankMap(lexical)
    const uidSet = new Set([...denseRanks.keys(), ...lexicalRanks.keys()])
    const ranked = [...uidSet]
      .map((recordUid) => ({
        recordUid,
        retrievalScore: [denseRanks, lexicalRanks]
          .reduce((sum, ranks) => sum + (ranks.has(recordUid) ? 1 / (RRF_K + ranks.get(recordUid)!) : 0), 0)
      }))
      .sort((left, right) => right.retrievalScore - left.retrievalScore || left.recordUid.localeCompare(right.recordUid))
      .slice(0, CANDIDATE_LIMIT)

    const denseByUid = new Map(dense.map((item) => [item.recordUid, item]))
    const lexicalByUid = new Map(lexical.map((item) => [item.recordUid, item]))
    return ranked.flatMap(({ recordUid, retrievalScore }) => {
      const record = recordByUid.get(recordUid)
      if (!record) return []
      const denseMatch = denseByUid.get(recordUid)
      const lexicalMatch = lexicalByUid.get(recordUid)
      const card = buildRequirementSourceView(record)
      return [{
        record,
        card,
        denseScore: denseMatch?.score ?? 0,
        lexicalScore: lexicalMatch?.score ?? 0,
        retrievalScore,
        snippet: denseMatch?.snippet || lexicalMatch?.snippet || card.evidence
      }]
    })
  }
}
