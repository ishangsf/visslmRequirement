import { strict as assert } from 'node:assert'
import { performance } from 'node:perf_hooks'
import {
  buildCoarseVector,
  prefilterVectorCandidates,
  VECTOR_PREFILTER_MAX_CANDIDATES,
  VECTOR_PREFILTER_THRESHOLD
} from '../src/main/knowledge'

const DIMENSION = 384
let seed = 0x51f15e

const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x1_0000_0000
}

const normalize = (values: Float32Array): Float32Array => {
  let norm = 0
  for (const value of values) norm += value * value
  const inverseNorm = norm > 0 ? 1 / Math.sqrt(norm) : 1
  for (let index = 0; index < values.length; index += 1) values[index] *= inverseNorm
  return values
}

const randomVector = (): Float32Array => {
  const values = new Float32Array(DIMENSION)
  for (let index = 0; index < values.length; index += 1) values[index] = random() * 2 - 1
  return normalize(values)
}

const nearVector = (source: Float32Array, noise: number): Float32Array => {
  const values = new Float32Array(source.length)
  for (let index = 0; index < values.length; index += 1) {
    values[index] = source[index] + (random() - 0.5) * noise
  }
  return normalize(values)
}

type Candidate = { id: string; vector: Float32Array; coarse: Float32Array }

const cosine = (left: Float32Array, right: Float32Array): number => {
  let score = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    score += left[index] * right[index]
  }
  return score
}

const run = (): void => {
  const query = randomVector()
  const relevant = Array.from({ length: 40 }, (_, index) => {
    const vector = nearVector(query, 0.08)
    return { id: `relevant-${index}`, vector, coarse: buildCoarseVector(vector) }
  })
  const distractors = Array.from({ length: 5_000 }, (_, index) => {
    const vector = randomVector()
    return { id: `distractor-${index}`, vector, coarse: buildCoarseVector(vector) }
  })
  const candidates: Candidate[] = [...relevant, ...distractors]
  assert.equal(candidates.length > VECTOR_PREFILTER_THRESHOLD, true)

  const exactTopK = [...candidates]
    .sort((left, right) => cosine(query, right.vector) - cosine(query, left.vector))
    .slice(0, relevant.length)
  const startedAt = performance.now()
  const shortlist = prefilterVectorCandidates(query, candidates, 100)
  const elapsedMs = Number((performance.now() - startedAt).toFixed(2))
  const shortlistIds = new Set(shortlist.map((candidate) => candidate.id))
  const recall = exactTopK.filter((candidate) => shortlistIds.has(candidate.id)).length / exactTopK.length

  assert.equal(shortlist.length, 1_600)
  assert.ok(recall >= 0.95, `粗向量预筛 recall@40 过低：${recall}`)
  assert.ok(shortlist.length <= VECTOR_PREFILTER_MAX_CANDIDATES)
  const smallCandidates = candidates.slice(0, VECTOR_PREFILTER_THRESHOLD)
  assert.strictEqual(
    prefilterVectorCandidates(query, smallCandidates, 10),
    smallCandidates,
    '小索引应保持精确全候选行为'
  )
  const invalidLimit = prefilterVectorCandidates(query, candidates, Number.NaN)
  assert.ok(invalidLimit.length <= VECTOR_PREFILTER_MAX_CANDIDATES)

  console.log(JSON.stringify({
    ok: true,
    candidateCount: candidates.length,
    shortlistCount: shortlist.length,
    exactTopK: exactTopK.length,
    recallAt40: Number(recall.toFixed(3)),
    prefilterMs: elapsedMs,
    threshold: VECTOR_PREFILTER_THRESHOLD,
    maxShortlist: VECTOR_PREFILTER_MAX_CANDIDATES
  }, null, 2))
}

run()
