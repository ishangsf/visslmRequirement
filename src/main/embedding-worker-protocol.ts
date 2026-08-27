export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-zh-v1.5'
export const EMBEDDING_MODEL_VERSION = 'bge-small-zh-v1.5-local-v1'
export const EMBEDDING_WORKER_FILE_NAME = 'embedding-worker.js'

export type EmbeddingWorkerPrepareRequest = {
  requestId: string
  type: 'prepare'
  modelRoot: string
}

export type EmbeddingWorkerEmbedManyRequest = {
  requestId: string
  type: 'embedMany'
  texts: string[]
}

export type EmbeddingWorkerDisposeRequest = {
  requestId: string
  type: 'dispose'
}

export type EmbeddingWorkerRequest =
  | EmbeddingWorkerPrepareRequest
  | EmbeddingWorkerEmbedManyRequest
  | EmbeddingWorkerDisposeRequest

export type EmbeddingWorkerPreparedResponse = {
  requestId: string
  ok: true
  type: 'prepared'
  modelVersion: typeof EMBEDDING_MODEL_VERSION
}

export type EmbeddingWorkerEmbeddingsResponse = {
  requestId: string
  ok: true
  type: 'embeddings'
  modelVersion: typeof EMBEDDING_MODEL_VERSION
  dimension: number
  vectors: ArrayBuffer[]
}

export type EmbeddingWorkerDisposedResponse = {
  requestId: string
  ok: true
  type: 'disposed'
}

export type EmbeddingWorkerErrorResponse = {
  requestId: string
  ok: false
  error: string
}

export type EmbeddingWorkerResponse =
  | EmbeddingWorkerPreparedResponse
  | EmbeddingWorkerEmbeddingsResponse
  | EmbeddingWorkerDisposedResponse
  | EmbeddingWorkerErrorResponse
