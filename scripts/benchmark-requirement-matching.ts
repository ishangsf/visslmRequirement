import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../src/main/database'
import { HybridRequirementRetriever, type RequirementDenseRetriever } from '../src/main/requirements/hybrid-retrieval'
import { buildRequirementSourceView } from '../src/main/requirements/requirement-match-card'
import type { KnowledgeRecordMatch } from '../src/main/knowledge'
import type { RequirementReranker } from '../src/main/requirements/cross-encoder-reranker'

interface Options {
  records: number
  iterations: number
  warmup: number
  maxP95Ms: number
  includeReranker: boolean
  reportOnly: boolean
}

const parseArgs = (): Options => {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--report-only' || arg === '--include-reranker') {
      flags.add(arg)
      continue
    }
    if (!arg?.startsWith('--') || !args[index + 1] || args[index + 1]?.startsWith('--')) throw new Error(`参数无效：${arg}`)
    values.set(arg, args[index + 1]!)
    index += 1
  }
  const numberValue = (name: string, fallback: number): number => {
    const value = Number(values.get(name) ?? fallback)
    if (!Number.isFinite(value)) throw new Error(`${name} 不是有效数字`)
    return value
  }
  return {
    records: Math.max(100, Math.trunc(numberValue('--records', 5000))),
    iterations: Math.max(3, Math.trunc(numberValue('--iterations', 10))),
    warmup: Math.max(0, Math.trunc(numberValue('--warmup', 2))),
    maxP95Ms: Math.max(1, numberValue('--max-p95-ms', 30000)),
    includeReranker: flags.has('--include-reranker'),
    reportOnly: flags.has('--report-only')
  }
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[index] ?? 0
}

const main = async (): Promise<void> => {
  const options = parseArgs()
  const directory = await mkdtemp(join(tmpdir(), 'visslm-requirement-matching-benchmark-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'benchmark.db'), join(directory, 'assets'))
    for (let index = 0; index < options.records; index += 1) {
      db.upsertRecord({
        uid: `benchmark-${index}`,
        projectId: 'benchmark-project',
        nodeType: index % 7 === 0 ? 'Defect' : 'Requirement',
        itemId: `BENCH-${index}`,
        parentId: '',
        name: `配置管理需求 ${index}`,
        lastModifyTime: new Date().toISOString(),
        raw: {
          IssueType: index % 7 === 0 ? 'Defect' : 'Requirement',
          _valm_Module: index % 2 ? '配置管理' : '需求管理',
          _valm_Description: `在配置管理页面支持按编号查询第 ${index} 条记录，并显示当前状态。`
        },
        normalizedText: `配置管理需求 ${index}\n在配置管理页面支持按编号查询第 ${index} 条记录，并显示当前状态。`
      })
    }
    const base = db.getRecord('benchmark-0', false)
    if (!base) throw new Error('benchmark base record missing')
    let indexedRecords: ReturnType<AppDatabase['listKnowledgeIndexedRecordDetails']> = []
    const dense: RequirementDenseRetriever = {
      modelVersion: 'requirement-benchmark-index-v1',
      async listRequirementIndexedRecords() {
        return indexedRecords
      },
      async rankRequirementRecordMatches(
        _question: string,
        limit = 100,
        allowedRecordUids?: ReadonlySet<string>
      ): Promise<KnowledgeRecordMatch[]> {
        return Array.from({ length: Math.min(limit, options.records - 1) }, (_, index) => ({
          recordUid: `benchmark-${index + 1}`,
          recordName: `配置管理需求 ${index + 1}`,
          nodeType: 'Requirement',
          itemId: `BENCH-${index + 1}`,
          score: 100 - index / 10,
          chunkId: `benchmark-chunk-${index + 1}`,
          snippet: 'benchmark source-only record'
        })).filter((item) => !allowedRecordUids || allowedRecordUids.has(item.recordUid))
      }
    }
    for (let index = 1; index < options.records; index += 1) {
      const record = db.getRecord(`benchmark-${index}`, false)
      if (!record) throw new Error(`benchmark record missing: ${index}`)
      const chunkId = `benchmark-chunk-${index}`
      db.replaceKnowledgeRecordChunks(record.uid, [{
        id: chunkId,
        recordUid: record.uid,
        sourceType: 'record',
        sourceName: record.name,
        sourceHash: `benchmark-hash-${index}`,
        content: record.normalizedText ?? record.description,
        chunkIndex: 0
      }], [{
        chunkId,
        vector: new Float32Array([1, 0]),
        modelVersion: dense.modelVersion
      }])
    }
    indexedRecords = db.listKnowledgeIndexedRecordDetails(dense.modelVersion)
    if (indexedRecords.length !== options.records - 1) {
      throw new Error(`source-only benchmark index incomplete: ${indexedRecords.length}/${options.records - 1}`)
    }
    const baseCard = buildRequirementSourceView(base)
    const retriever = new HybridRequirementRetriever(db, dense)
    const times: number[] = []
    const reranker: RequirementReranker | null = options.includeReranker
      ? (await import('../src/main/requirements/cross-encoder-reranker')).createRequirementReranker()
      : null
    for (let index = 0; index < options.warmup + options.iterations; index += 1) {
      const started = performance.now()
      const candidates = await retriever.retrieve(baseCard, new Set(['benchmark-0']))
      if (candidates.some((candidate) => Object.keys(candidate.card).length !== 9)) {
        throw new Error('benchmark received an unexpected requirement source shape')
      }
      if (reranker) await reranker.rerank(baseCard, candidates)
      const elapsed = performance.now() - started
      if (index >= options.warmup) times.push(elapsed)
    }
    const report = {
      status: percentile(times, 0.95) <= options.maxP95Ms ? 'PASS' : 'GATE_FAIL',
      gateMode: options.reportOnly ? 'report-only' : 'enforced',
      stage: reranker ? 'source-only-retrieval-plus-cross-encoder' : 'source-only-retrieval',
      records: options.records,
      indexedRecords: indexedRecords.length,
      iterations: options.iterations,
      warmup: options.warmup,
      milliseconds: {
        p50: Number(percentile(times, 0.5).toFixed(2)),
        p95: Number(percentile(times, 0.95).toFixed(2)),
        min: Number(Math.min(...times).toFixed(2)),
        max: Number(Math.max(...times).toFixed(2))
      },
      threshold: { maxP95Ms: options.maxP95Ms },
      note: reranker
        ? '包含真实本地 Cross-Encoder；未包含解释模型延迟。'
        : '测量完整当前索引上的 Dense、FTS5/BM25 与 RRF；所有候选均使用清洗原文。'
    }
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'PASS' && !options.reportOnly) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'ERROR', message: error instanceof Error ? error.message : String(error) }, null, 2))
    if (!options.reportOnly) process.exitCode = 1
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main()
