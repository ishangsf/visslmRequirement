import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HybridRequirementCandidate } from './hybrid-retrieval'
import type { RequirementMatchCard } from './requirement-match-card'

export interface RequirementRerankItem {
  recordUid: string
  score: number
}

export interface RequirementReranker {
  readonly modelId: string
  /** Stable, pinned identity used for audit/config provenance. */
  readonly modelVersion?: string
  readonly modelProvenance?: string
  rerank(base: RequirementMatchCard, candidates: HybridRequirementCandidate[]): Promise<RequirementRerankItem[]>
}

export const REQUIREMENT_RERANKER_MODEL_ID = 'Xenova/bge-reranker-base'
export const REQUIREMENT_RERANKER_MODEL_VERSION = 'bge-reranker-base-int8-local-v1'
export const REQUIREMENT_RERANKER_MODEL_PROVENANCE = [
  REQUIREMENT_RERANKER_MODEL_VERSION,
  'revision=280bcc27a84e0b898c251e06fddb25171bd9b101',
  'model_int8_sha256=2059d8ef0b6e935b4845e11b38c9af9e9e2e7b91f69fc99efe03254e0a7da8d3',
  'license=Apache-2.0'
].join(';')

const locateResource = (...parts: string[]): string | null => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const roots = [
    process.env.VISSLM_RESOURCE_ROOT,
    process.resourcesPath,
    join(process.cwd(), 'buildResources'),
    join(moduleDir, '..', '..', 'buildResources'),
    join(moduleDir, '..', '..', '..', 'buildResources')
  ].filter((value): value is string => Boolean(value))
  for (const root of roots) {
    const candidate = join(root, ...parts)
    if (existsSync(candidate)) return candidate
  }
  return null
}

const modelPath = (): string | null => locateResource('models', ...REQUIREMENT_RERANKER_MODEL_ID.split('/'))
const BATCH_SIZE = 8

const scoreFromLogits = (result: any, index: number): number => {
  const data = result?.logits?.data as ArrayLike<number> | undefined
  const dims = result?.logits?.dims as number[] | undefined
  if (!data || !dims?.length) throw new Error('Cross-Encoder 未返回 logits')
  const width = Number(dims[dims.length - 1])
  if (!width || data.length < (index + 1) * width) throw new Error('Cross-Encoder logits 维度无效')
  if (width === 1) {
    const logit = Number(data[index])
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit)))) * 100
  }
  const values = Array.from({ length: width }, (_, offset) => Number(data[index * width + offset]))
  const max = Math.max(...values)
  const probabilities = values.map((value) => Math.exp(value - max))
  const positive = probabilities[probabilities.length - 1] ?? 0
  return positive / Math.max(1e-9, probabilities.reduce((sum, value) => sum + value, 0)) * 100
}

export class LocalRequirementReranker implements RequirementReranker {
  readonly modelId = REQUIREMENT_RERANKER_MODEL_ID
  readonly modelVersion = REQUIREMENT_RERANKER_MODEL_VERSION
  readonly modelProvenance = REQUIREMENT_RERANKER_MODEL_PROVENANCE
  private tokenizer: any | null = null
  private model: any | null = null
  private preparing: Promise<void> | null = null

  async rerank(base: RequirementMatchCard, candidates: HybridRequirementCandidate[]): Promise<RequirementRerankItem[]> {
    if (!candidates.length) return []
    await this.prepare()
    if (!this.tokenizer || !this.model) throw new Error('本地 Cross-Encoder 重排模型不可用')
    const results: RequirementRerankItem[] = []
    for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + BATCH_SIZE)
      const left = batch.map(() => base.matchingText.slice(0, 6000))
      const right = batch.map((candidate) => candidate.card.matchingText.slice(0, 6000))
      const inputs = this.tokenizer(left, {
        text_pair: right,
        padding: true,
        truncation: true,
        max_length: 512
      })
      const output = await this.model(inputs)
      results.push(...batch.map((candidate, index) => ({
        recordUid: candidate.record.uid,
        score: Number(Math.max(0, Math.min(100, scoreFromLogits(output, index))).toFixed(2))
      })))
    }
    return results.sort((leftItem, rightItem) => rightItem.score - leftItem.score || leftItem.recordUid.localeCompare(rightItem.recordUid))
  }

  private async prepare(): Promise<void> {
    if (this.tokenizer && this.model) return
    if (this.preparing) return this.preparing
    this.preparing = this.load().finally(() => { this.preparing = null })
    return this.preparing
  }

  private async load(): Promise<void> {
    const root = modelPath()
    if (!root) {
      throw new Error(`本地 Cross-Encoder 资源未找到：${REQUIREMENT_RERANKER_MODEL_ID}`)
    }
    const runtime = await import('@huggingface/transformers') as any
    runtime.env.allowRemoteModels = false
    runtime.env.allowLocalModels = true
    const cacheRoot = join(process.env.LOCALAPPDATA || tmpdir(), 'VISSLM Agent', 'model-cache')
    mkdirSync(cacheRoot, { recursive: true })
    runtime.env.cacheDir = cacheRoot
    const [tokenizer, model] = await Promise.all([
      runtime.AutoTokenizer.from_pretrained(root, { local_files_only: true }),
      runtime.AutoModelForSequenceClassification.from_pretrained(root, {
        dtype: 'int8',
        local_files_only: true,
        model_file_name: 'model'
      })
    ])
    this.tokenizer = tokenizer
    this.model = model
  }
}

export const createRequirementReranker = (): RequirementReranker => new LocalRequirementReranker()
