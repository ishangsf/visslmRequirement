import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import {
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_VERSION,
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse
} from '../src/main/embedding-worker-protocol.ts'

const REQUEST_TIMEOUT_MS = 120_000
const EXIT_TIMEOUT_MS = 10_000

type PendingRequest = {
  reject: (error: Error) => void
  resolve: (response: EmbeddingWorkerResponse) => void
  timer: ReturnType<typeof setTimeout>
}

class EmbeddingWorkerHarness {
  private readonly pending = new Map<string, PendingRequest>()
  private readonly exited: Promise<number>
  private failure: Error | null = null

  constructor(private readonly worker: Worker) {
    this.exited = new Promise<number>((resolve) => {
      this.worker.once('exit', (code) => {
        const error = new Error(`embedding worker 已退出（代码 ${code}）`)
        this.rejectPending(error)
        resolve(code)
      })
    })
    this.worker.on('message', (message: unknown) => this.handleMessage(message))
    this.worker.on('error', (error: Error) => {
      this.failure = error
      this.rejectPending(error)
    })
  }

  request(request: EmbeddingWorkerRequest): Promise<EmbeddingWorkerResponse> {
    if (this.failure) return Promise.reject(this.failure)

    return new Promise<EmbeddingWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error(`embedding worker 请求超时：${request.requestId}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(request.requestId, { resolve, reject, timer })

      try {
        this.worker.postMessage(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(request.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async waitForExit(timeoutMs: number): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exited,
        new Promise<number>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`embedding worker 退出超时（${timeoutMs}ms）`))
          }, timeoutMs)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async terminate(): Promise<void> {
    this.rejectPending(new Error('embedding worker 测试清理'))
    try {
      await this.worker.terminate()
    } catch {
      // Cleanup is best-effort after the assertion that caused the failure.
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const requestId = (message as { requestId?: unknown }).requestId
    if (typeof requestId !== 'string') return
    const pending = this.pending.get(requestId)
    if (!pending) return

    this.pending.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(message as EmbeddingWorkerResponse)
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerPath = resolve(projectRoot, 'out', 'main', 'embedding-worker.js')
const modelRoot = resolve(projectRoot, 'buildResources', 'models')
const modelConfigCandidates = [
  resolve(modelRoot, ...EMBEDDING_MODEL_ID.split('/'), 'config.json'),
  resolve(modelRoot, 'config.json')
]

const readModelHiddenSize = async (): Promise<number> => {
  for (const configPath of modelConfigCandidates) {
    let raw: string
    try {
      raw = await readFile(configPath, 'utf8')
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        continue
      }
      throw error
    }

    const config = JSON.parse(raw) as { hidden_size?: unknown }
    const hiddenSize = config.hidden_size
    if (typeof hiddenSize !== 'number' || !Number.isInteger(hiddenSize) || hiddenSize <= 0) {
      throw new Error(`本地 embedding 模型 config.hidden_size 无效：${configPath}`)
    }
    return hiddenSize
  }
  throw new Error(`本地 embedding 模型 config.json 未找到：${modelRoot}`)
}

const assertPreparedResponse = (
  response: EmbeddingWorkerResponse,
  requestId: string
): void => {
  assert.equal(response.requestId, requestId, 'prepare 响应必须对应请求 ID')
  if (response.ok !== true) throw new Error(`prepare 失败：${response.error}`)
  assert.equal(response.type, 'prepared')
  if (response.type !== 'prepared') throw new Error('prepare 响应类型无效')
  assert.equal(
    response.modelVersion,
    EMBEDDING_MODEL_VERSION,
    'prepare 必须返回当前生产模型版本'
  )
}

const assertEmbeddingResponse = (
  response: EmbeddingWorkerResponse,
  expectedRequest: Extract<EmbeddingWorkerRequest, { type: 'embedMany' }>,
  expectedDimension?: number
): number => {
  assert.equal(response.requestId, expectedRequest.requestId, 'embedMany 响应必须对应请求 ID')
  if (response.ok !== true) throw new Error(`embedMany 失败：${response.error}`)
  assert.equal(response.type, 'embeddings')
  if (response.type !== 'embeddings') throw new Error('embedMany 响应类型无效')
  assert.equal(response.modelVersion, EMBEDDING_MODEL_VERSION)
  assert.ok(
    Number.isInteger(response.dimension) && response.dimension > 0,
    'embedMany 响应维度必须是正整数'
  )
  if (expectedDimension !== undefined) {
    assert.equal(response.dimension, expectedDimension, '同一 Worker 的响应维度必须保持一致')
  }
  assert.ok(Array.isArray(response.vectors), '向量集合必须是数组')
  assert.equal(response.vectors.length, expectedRequest.texts.length, '批量数量必须保持一致')

  for (const [index, buffer] of response.vectors.entries()) {
    assert.ok(buffer instanceof ArrayBuffer, `向量 ${index} 必须是可传输 ArrayBuffer`)
    assert.equal(ArrayBuffer.isView(buffer), false, `向量 ${index} 不应退化为 TypedArray 消息`)
    assert.equal(
      buffer.byteLength,
      response.dimension * Float32Array.BYTES_PER_ELEMENT,
      `向量 ${index} 的缓冲区字节数必须匹配响应维度`
    )

    const vector = new Float32Array(buffer)
    assert.equal(vector.length, response.dimension)
    assert.ok(vector.some((value) => value !== 0), `向量 ${index} 必须可读且不能全为零`)
    assert.ok(
      Array.from(vector).every((value) => Number.isFinite(value)),
      `向量 ${index} 的所有值必须有限`
    )
  }
  return response.dimension
}

const testProductionEmbeddingWorker = async (): Promise<void> => {
  const worker = new Worker(workerPath)
  const harness = new EmbeddingWorkerHarness(worker)

  try {
    const prepareRequest: EmbeddingWorkerRequest = {
      requestId: 'embedding-worker-regression-prepare',
      type: 'prepare',
      modelRoot
    }
    assertPreparedResponse(await harness.request(prepareRequest), prepareRequest.requestId)
    const modelHiddenSize = await readModelHiddenSize()

    const embedRequests: Array<Extract<EmbeddingWorkerRequest, { type: 'embedMany' }>> = [
      {
        requestId: 'embedding-worker-regression-embed-a',
        type: 'embedMany',
        texts: ['第一批本地 embedding 回归文本', '验证批量向量和传输缓冲区']
      },
      {
        requestId: 'embedding-worker-regression-embed-b',
        type: 'embedMany',
        texts: ['第二批并发请求用于 ID 对应校验', '生产模型必须返回配置维度的有限向量', '向量不应序列化为 JSON 数组']
      }
    ]
    const responses = await Promise.all(embedRequests.map((request) => harness.request(request)))
    let expectedDimension: number | undefined
    for (let index = 0; index < embedRequests.length; index += 1) {
      const dimension = assertEmbeddingResponse(
        responses[index],
        embedRequests[index],
        expectedDimension
      )
      expectedDimension ??= dimension
    }
    assert.equal(
      expectedDimension,
      modelHiddenSize,
      '首个成功响应维度必须与本地模型 config.hidden_size 一致'
    )

    const disposeRequest: EmbeddingWorkerRequest = {
      requestId: 'embedding-worker-regression-dispose',
      type: 'dispose'
    }
    const disposeResponse = await harness.request(disposeRequest)
    assert.equal(disposeResponse.requestId, disposeRequest.requestId, 'dispose 响应必须对应请求 ID')
    if (disposeResponse.ok !== true) throw new Error(`dispose 失败：${disposeResponse.error}`)
    assert.equal(disposeResponse.type, 'disposed')
    if (disposeResponse.type !== 'disposed') throw new Error('dispose 响应类型无效')

    assert.equal(await harness.waitForExit(EXIT_TIMEOUT_MS), 0, 'dispose 后 worker 应正常退出')
  } finally {
    await harness.terminate()
  }
}

const main = async (): Promise<void> => {
  await testProductionEmbeddingWorker()
  console.log(JSON.stringify({
    ok: true,
    contract: 'embedding-worker',
    checks: [
      'prepare loads the bundled local model and reports its production version',
      'two concurrent embedMany batches preserve request IDs and counts',
      'responses establish and preserve the local model dimension with finite transferable Float32 ArrayBuffers',
      'dispose acknowledges the request and exits the worker'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
