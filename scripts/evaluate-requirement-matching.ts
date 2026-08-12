import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const RELATIONS = [
  'duplicate',
  'highly_similar',
  'partial_overlap',
  'same_pattern',
  'topic_only',
  'unrelated'
] as const
type Relation = typeof RELATIONS[number]

interface GoldPair {
  candidateItemId: string
  relation: Relation
  relevance: number
  hardNegative?: boolean
}

interface GoldQuery {
  queryId: string
  baseItemId: string
  split: 'train' | 'validation' | 'test'
  pairs: GoldPair[]
}

interface GoldFile {
  schemaVersion: string
  annotationStatus: 'scaffold' | 'ready'
  queries: GoldQuery[]
}

interface PredictionItem {
  candidateItemId: string
  relation?: Relation
  score?: number
  rank?: number
}

interface PredictionQuery {
  queryId: string
  baseItemId?: string
  candidates: PredictionItem[]
}

interface PredictionFile {
  predictions: PredictionQuery[]
}

interface Options {
  gold: string
  predictions: string
  baseline?: string
  split: 'train' | 'validation' | 'test' | 'all'
  reportOnly: boolean
  minQueries: number
  minPairs: number
  minRecall50: number
  minFormalPrecision: number
  maxTopicOnlyFpr: number
  minNdcg10?: number
  minMrr?: number
  minNdcgDelta: number
  minMrrDelta: number
}

const relationSet = new Set<string>(RELATIONS)

const parseArgs = (): Options => {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value.startsWith('--')) throw new Error(`未知参数：${value}`)
    if (value === '--report-only') {
      flags.add(value)
      continue
    }
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`参数缺少值：${value}`)
    values.set(value, next)
    index += 1
  }
  const numberValue = (name: string, fallback: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`${name} 不是有效数字：${raw}`)
    return value
  }
  const split = (values.get('--split') ?? 'test') as Options['split']
  if (!['train', 'validation', 'test', 'all'].includes(split)) throw new Error(`无效 split：${split}`)
  return {
    gold: resolve(values.get('--gold') ?? 'test-data/requirement-matching/gold-scaffold.json'),
    predictions: resolve(values.get('--predictions') ?? 'test-data/requirement-matching/predictions.example.json'),
    baseline: values.has('--baseline') ? resolve(values.get('--baseline')!) : undefined,
    split,
    reportOnly: flags.has('--report-only'),
    minQueries: Math.max(1, Math.trunc(numberValue('--min-queries', 200))),
    minPairs: Math.max(1, Math.trunc(numberValue('--min-pairs', 3000))),
    minRecall50: numberValue('--min-recall50', 0.98),
    minFormalPrecision: numberValue('--min-formal-precision', 0.95),
    maxTopicOnlyFpr: numberValue('--max-topic-only-fpr', 0.05),
    minNdcg10: values.has('--min-ndcg10') ? numberValue('--min-ndcg10', 0) : undefined,
    minMrr: values.has('--min-mrr') ? numberValue('--min-mrr', 0) : undefined,
    minNdcgDelta: numberValue('--min-ndcg-delta', 0.01),
    minMrrDelta: numberValue('--min-mrr-delta', 0.01)
  }
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T

const relationOf = (value: unknown): Relation => {
  const relation = String(value ?? '')
  if (!relationSet.has(relation)) throw new Error(`无效关系：${relation}`)
  return relation as Relation
}

const relevanceOf = (relation: Relation): number => ({
  duplicate: 3,
  highly_similar: 2,
  partial_overlap: 1,
  same_pattern: 1,
  topic_only: 0,
  unrelated: 0
})[relation]

const validateGold = (input: GoldFile): GoldFile => {
  if (input.schemaVersion !== '1.0') throw new Error('金标 schemaVersion 必须为 1.0')
  if (!['scaffold', 'ready'].includes(input.annotationStatus)) throw new Error('金标 annotationStatus 无效')
  if (!Array.isArray(input.queries)) throw new Error('金标 queries 必须是数组')
  const queryIds = new Set<string>()
  for (const query of input.queries) {
    if (!query.queryId || !query.baseItemId || !['train', 'validation', 'test'].includes(query.split)) {
      throw new Error('金标 query 缺少 queryId/baseItemId/split')
    }
    if (queryIds.has(query.queryId)) throw new Error(`金标 queryId 重复：${query.queryId}`)
    queryIds.add(query.queryId)
    if (!Array.isArray(query.pairs)) throw new Error(`金标 pairs 不是数组：${query.queryId}`)
    const candidateIds = new Set<string>()
    for (const pair of query.pairs) {
      if (!pair.candidateItemId) throw new Error(`金标候选缺少编号：${query.queryId}`)
      if (candidateIds.has(pair.candidateItemId)) throw new Error(`金标候选重复：${query.queryId}/${pair.candidateItemId}`)
      candidateIds.add(pair.candidateItemId)
      pair.relation = relationOf(pair.relation)
      if (!Number.isInteger(pair.relevance) || pair.relevance < 0 || pair.relevance > 3) {
        throw new Error(`金标 relevance 无效：${query.queryId}/${pair.candidateItemId}`)
      }
      if (pair.relevance !== relevanceOf(pair.relation)) {
        throw new Error(`金标 relation/relevance 不一致：${query.queryId}/${pair.candidateItemId}`)
      }
    }
  }
  return input
}

const normalizePredictions = (input: PredictionFile): Map<string, PredictionItem[]> => {
  if (!Array.isArray(input.predictions)) throw new Error('预测文件 predictions 必须是数组')
  const result = new Map<string, PredictionItem[]>()
  for (const prediction of input.predictions) {
    if (!prediction.queryId || !Array.isArray(prediction.candidates)) throw new Error('预测项缺少 queryId/candidates')
    if (result.has(prediction.queryId)) throw new Error(`预测 queryId 重复：${prediction.queryId}`)
    const seen = new Set<string>()
    const candidates = prediction.candidates.map((candidate) => {
      if (!candidate.candidateItemId) throw new Error(`预测候选缺少编号：${prediction.queryId}`)
      if (seen.has(candidate.candidateItemId)) throw new Error(`预测候选重复：${prediction.queryId}/${candidate.candidateItemId}`)
      seen.add(candidate.candidateItemId)
      if (candidate.relation !== undefined) candidate.relation = relationOf(candidate.relation)
      if (candidate.score !== undefined && !Number.isFinite(candidate.score)) throw new Error(`预测分数无效：${candidate.candidateItemId}`)
      return candidate
    })
    candidates.sort((left, right) => {
      if (left.rank !== undefined || right.rank !== undefined) return (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
      return (right.score ?? 0) - (left.score ?? 0)
    })
    result.set(prediction.queryId, candidates)
  }
  return result
}

const dcg = (relevances: number[]): number => relevances.reduce((sum, relevance, index) => sum + ((2 ** relevance - 1) / Math.log2(index + 2)), 0)

interface MetricSet {
  queryCount: number
  pairCount: number
  recall50: number
  formalPrecision: number
  formalPredictionCount: number
  topicOnlyFormalFalsePositiveRate: number
  topicOnlyCount: number
  nDcg10: number
  mrr: number
  hardNegativePass: boolean
  missingPredictionQueries: number
}

const calculateMetrics = (queries: GoldQuery[], predictions: Map<string, PredictionItem[]>): MetricSet => {
  let recallSum = 0
  let ndcgSum = 0
  let mrrSum = 0
  let formalPredictions = 0
  let formalTruePositives = 0
  let topicOnlyCount = 0
  let topicOnlyFormalFalsePositives = 0
  let hardNegativePass = true
  let missingPredictionQueries = 0
  for (const query of queries) {
    const goldById = new Map(query.pairs.map((pair) => [pair.candidateItemId, pair]))
    const ranked = predictions.get(query.queryId) ?? []
    if (!predictions.has(query.queryId)) missingPredictionQueries += 1
    const top50 = ranked.slice(0, 50)
    const relevant = query.pairs.filter((pair) => pair.relevance > 0)
    const retrievedRelevant = relevant.filter((pair) => top50.some((candidate) => candidate.candidateItemId === pair.candidateItemId)).length
    recallSum += relevant.length ? retrievedRelevant / relevant.length : 1
    const top10Relevances = ranked.slice(0, 10).map((candidate) => goldById.get(candidate.candidateItemId)?.relevance ?? 0)
    const ideal = query.pairs.map((pair) => pair.relevance).sort((left, right) => right - left).slice(0, 10)
    ndcgSum += dcg(ideal) ? dcg(top10Relevances) / dcg(ideal) : 1
    const firstRelevant = ranked.findIndex((candidate) => (goldById.get(candidate.candidateItemId)?.relevance ?? 0) > 0)
    mrrSum += firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1)
    for (const candidate of ranked) {
      const formal = candidate.relation === 'duplicate' || candidate.relation === 'highly_similar'
      if (!formal) continue
      formalPredictions += 1
      if (goldById.get(candidate.candidateItemId)?.relation === 'duplicate' || goldById.get(candidate.candidateItemId)?.relation === 'highly_similar') formalTruePositives += 1
      const gold = goldById.get(candidate.candidateItemId)
      if (gold?.relation === 'topic_only') topicOnlyFormalFalsePositives += 1
      if (gold?.hardNegative) hardNegativePass = false
    }
    topicOnlyCount += query.pairs.filter((pair) => pair.relation === 'topic_only').length
  }
  return {
    queryCount: queries.length,
    pairCount: queries.reduce((sum, query) => sum + query.pairs.length, 0),
    recall50: queries.length ? recallSum / queries.length : 0,
    formalPrecision: formalPredictions ? formalTruePositives / formalPredictions : 1,
    formalPredictionCount: formalPredictions,
    topicOnlyFormalFalsePositiveRate: topicOnlyCount ? topicOnlyFormalFalsePositives / topicOnlyCount : 0,
    topicOnlyCount,
    nDcg10: queries.length ? ndcgSum / queries.length : 0,
    mrr: queries.length ? mrrSum / queries.length : 0,
    hardNegativePass,
    missingPredictionQueries
  }
}

const main = async (): Promise<void> => {
  const options = parseArgs()
  try {
    const gold = validateGold(await readJson<GoldFile>(options.gold))
    const predictions = normalizePredictions(await readJson<PredictionFile>(options.predictions))
    const queries = options.split === 'all' ? gold.queries : gold.queries.filter((query) => query.split === options.split)
    const metrics = calculateMetrics(queries, predictions)
    let baselineMetrics: MetricSet | undefined
    if (options.baseline) {
      baselineMetrics = calculateMetrics(queries, normalizePredictions(await readJson<PredictionFile>(options.baseline)))
    }
    const checks = {
      annotationReady: gold.annotationStatus === 'ready',
      queryCount: metrics.queryCount >= options.minQueries,
      pairCount: metrics.pairCount >= options.minPairs,
      recall50: metrics.recall50 >= options.minRecall50,
      formalPrecision: metrics.formalPrecision >= options.minFormalPrecision,
      topicOnlyFpr: metrics.topicOnlyFormalFalsePositiveRate <= options.maxTopicOnlyFpr,
      hardNegative: metrics.hardNegativePass,
      predictionsComplete: metrics.missingPredictionQueries === 0,
      ndcg10: options.minNdcg10 === undefined || metrics.nDcg10 >= options.minNdcg10,
      mrr: options.minMrr === undefined || metrics.mrr >= options.minMrr,
      baselineNdcgDelta: !baselineMetrics || metrics.nDcg10 - baselineMetrics.nDcg10 >= options.minNdcgDelta,
      baselineMrrDelta: !baselineMetrics || metrics.mrr - baselineMetrics.mrr >= options.minMrrDelta
    }
    const report = {
      status: Object.values(checks).every(Boolean) ? 'PASS' : 'GATE_FAIL',
      gateMode: options.reportOnly ? 'report-only' : 'enforced',
      input: { gold: options.gold, predictions: options.predictions, baseline: options.baseline ?? null, split: options.split },
      thresholds: {
        minQueries: options.minQueries,
        minPairs: options.minPairs,
        minRecall50: options.minRecall50,
        minFormalPrecision: options.minFormalPrecision,
        maxTopicOnlyFpr: options.maxTopicOnlyFpr,
        minNdcg10: options.minNdcg10 ?? null,
        minMrr: options.minMrr ?? null,
        minNdcgDelta: options.minNdcgDelta,
        minMrrDelta: options.minMrrDelta
      },
      metrics,
      baselineMetrics: baselineMetrics ?? null,
      deltas: baselineMetrics ? { nDcg10: metrics.nDcg10 - baselineMetrics.nDcg10, mrr: metrics.mrr - baselineMetrics.mrr } : null,
      checks,
      note: gold.annotationStatus === 'scaffold' ? '当前金标仍是脚手架，未包含人工标注；本报告不能作为上线质量证据。' : undefined
    }
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'PASS' && !options.reportOnly) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'ERROR', message: error instanceof Error ? error.message : String(error) }, null, 2))
    if (!options.reportOnly) process.exitCode = 1
  }
}

main()
