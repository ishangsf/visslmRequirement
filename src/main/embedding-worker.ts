import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'

import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse
} from './embedding-worker-protocol'

interface TransformerRuntime {
  env: {
    allowRemoteModels?: boolean
    allowLocalModels?: boolean
    localModelPath?: string
    cacheDir?: string
  }
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
}

type EmbeddingExtractor = (texts: string[], options?: Record<string, unknown>) => Promise<unknown>

const port = parentPort
if (!port) throw new Error('embedding worker 未连接到主线程')

let extractor: EmbeddingExtractor | null = null
let preparedModelRoot = ''
let embeddingDimension = 0
let disposed = false

const asErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message
  return String(error || '未知 embedding worker 错误')
}

const modelResourceIsPresent = (root: string): boolean => {
  const modelParts = EMBEDDING_MODEL_ID.split('/')
  return existsSync(join(root, 'config.json')) || existsSync(join(root, ...modelParts, 'config.json'))
}

const prepare = async (root: string): Promise<void> => {
  const modelRoot = root.trim()
  if (!modelRoot || !modelResourceIsPresent(modelRoot)) {
    throw new Error('本地 embedding 模型资源未找到，请先执行 npm run prepare:model 完成资源准备')
  }
  if (extractor) {
    if (preparedModelRoot !== modelRoot) throw new Error('embedding worker 不支持切换模型资源目录')
    return
  }
  const runtime = await import('@huggingface/transformers') as unknown as TransformerRuntime
  runtime.env.allowRemoteModels = false
  runtime.env.allowLocalModels = true
  runtime.env.localModelPath = modelRoot
  runtime.env.cacheDir = join(modelRoot, 'cache')
  const loaded = await runtime.pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: 'q8',
    local_files_only: true
  })
  if (typeof loaded !== 'function') throw new Error('embedding pipeline 不可用')
  extractor = loaded as EmbeddingExtractor
  preparedModelRoot = modelRoot
}

const normalizedVector = (values: ArrayLike<unknown>): Float32Array => {
  if (!values.length) throw new Error('本地 embedding 模型返回了空向量')
  const vector = Float32Array.from(values, (item) => Number(item))
  if (Array.from(vector).some((item) => !Number.isFinite(item))) {
    throw new Error('本地 embedding 模型返回了非有限向量值')
  }
  let norm = 0
  for (const value of vector) norm += value * value
  if (!Number.isFinite(norm)) throw new Error('本地 embedding 模型返回的向量范数无效')
  const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] *= scale
    if (!Number.isFinite(vector[index])) throw new Error('本地 embedding 模型归一化失败')
  }
  return vector
}

const rowsFromResult = (result: any, expected: number): Float32Array[] => {
  const data = result?.data as ArrayLike<unknown> | undefined
  const dims = Array.isArray(result?.dims) ? result.dims.map((value: unknown) => Number(value)) : []
  if (data && dims.length && dims.every((value: number) => Number.isInteger(value) && value > 0)) {
    const dimension = dims[dims.length - 1]
    if (data.length !== expected * dimension) {
      throw new Error('本地 embedding 模型返回的向量数量无效')
    }
    return Array.from({ length: expected }, (_, index) => normalizedVector(
      Array.from(data).slice(index * dimension, (index + 1) * dimension)
    ))
  }
  if (typeof result?.tolist !== 'function') {
    throw new Error('本地 embedding 模型返回的张量格式无效')
  }
  const values = result.tolist() as unknown
  if (!Array.isArray(values)) throw new Error('本地 embedding 模型返回的向量格式无效')
  const rows = values.length > 0 && Array.isArray(values[0]) ? values : [values]
  if (rows.length !== expected) throw new Error('本地 embedding 模型返回的向量数量无效')
  return rows.map((row) => {
    if (!Array.isArray(row)) throw new Error('本地 embedding 模型返回的向量格式无效')
    return normalizedVector(row)
  })
}

const embedMany = async (texts: string[]): Promise<{ dimension: number; vectors: ArrayBuffer[] }> => {
  if (!extractor) throw new Error('本地 embedding worker 尚未完成 prepare')
  if (!texts.length) return { dimension: embeddingDimension, vectors: [] }
  const result = await extractor(texts, { pooling: 'mean', normalize: true })
  const rows = rowsFromResult(result, texts.length)
  const dimension = rows[0]?.length ?? 0
  if (!dimension || rows.some((row) => row.length !== dimension)) {
    throw new Error('本地 embedding 模型返回的向量维度不一致')
  }
  if (embeddingDimension && embeddingDimension !== dimension) {
    throw new Error(`本地 embedding 模型向量维度发生变化：${embeddingDimension} -> ${dimension}`)
  }
  embeddingDimension = dimension
  return { dimension, vectors: rows.map((row) => row.buffer as ArrayBuffer) }
}

const isRequest = (value: unknown): value is EmbeddingWorkerRequest => {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<EmbeddingWorkerRequest>
  if (typeof request.requestId !== 'string' || !request.requestId) return false
  if (request.type === 'prepare') return typeof request.modelRoot === 'string'
  if (request.type === 'embedMany') {
    return Array.isArray(request.texts) && request.texts.every((text) => typeof text === 'string')
  }
  return request.type === 'dispose'
}

const post = (response: EmbeddingWorkerResponse, transferList: ArrayBuffer[] = []): void => {
  port.postMessage(response, transferList)
}

const handleRequest = async (request: EmbeddingWorkerRequest): Promise<void> => {
  if (disposed && request.type !== 'dispose') {
    post({ requestId: request.requestId, ok: false, error: 'embedding worker 已停止' })
    return
  }
  try {
    if (request.type === 'prepare') {
      await prepare(request.modelRoot)
      post({ requestId: request.requestId, ok: true, type: 'prepared', modelVersion: EMBEDDING_MODEL_VERSION })
      return
    }
    if (request.type === 'embedMany') {
      const { dimension, vectors } = await embedMany(request.texts)
      post({
        requestId: request.requestId,
        ok: true,
        type: 'embeddings',
        modelVersion: EMBEDDING_MODEL_VERSION,
        dimension,
        vectors
      }, vectors)
      return
    }
    disposed = true
    extractor = null
    preparedModelRoot = ''
    embeddingDimension = 0
    post({ requestId: request.requestId, ok: true, type: 'disposed' })
    port.close()
  } catch (error) {
    post({ requestId: request.requestId, ok: false, error: asErrorMessage(error) })
  }
}

let requestChain: Promise<void> = Promise.resolve()
port.on('message', (value: unknown) => {
  const requestId = value && typeof value === 'object' &&
    typeof (value as { requestId?: unknown }).requestId === 'string'
    ? (value as { requestId: string }).requestId
    : ''
  if (!isRequest(value)) {
    if (requestId) post({ requestId, ok: false, error: 'embedding worker 请求格式无效' })
    return
  }
  requestChain = requestChain.then(() => handleRequest(value))
})
