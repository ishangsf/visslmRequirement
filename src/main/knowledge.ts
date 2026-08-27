import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import iconv from 'iconv-lite'
import * as mammoth from 'mammoth'
import * as XLSX from 'xlsx'
import type {
  ChatSource,
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeIndexProgress,
  KnowledgeRebuildResult,
  KnowledgeUploadResult,
  RecordDetail
} from '../shared/types'
import {
  AppDatabase,
  type KnowledgeChunkInput,
  type KnowledgeVectorInput
} from './database'
import type { RecordMaintenanceOperation } from '../shared/types'
import { AsyncMutex } from './record-index-lock'
import {
  BackgroundTaskRunner,
  TaskCancelledError,
  type BackgroundTaskHandle
} from './background-task-runner'

export const MAX_KNOWLEDGE_FILE_BYTES = 100 * 1024 * 1024
export const EMBEDDING_MODEL_ID = 'Xenova/bge-small-zh-v1.5'
export const EMBEDDING_MODEL_VERSION = 'bge-small-zh-v1.5-local-v1'
const FALLBACK_MODEL_VERSION = 'local-hash-v1'
const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 20
const EMBEDDING_DIMENSION = 384
export const VECTOR_PREFILTER_THRESHOLD = 4_096
export const VECTOR_PREFILTER_MAX_CANDIDATES = 2_048
export const VECTOR_COARSE_STEP = 8
export const KNOWLEDGE_MAX_CONCURRENT_TASKS = 2
const SEARCH_RESULT_CACHE_TTL_MS = 15_000
const SEARCH_RESULT_CACHE_MAX_ENTRIES = 64
const OCR_RENDER_SCALE = 2.5
const OCR_PAGE_SEGMENTATION_MODE = '3'
const SUPPORTED_EXTENSIONS = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.txt'])

export interface KnowledgeSearchHit {
  source: ChatSource
  chunk: KnowledgeChunk
  score: number
}

export interface KnowledgeSearchOptions {
  /** Restrict semantic search to one provenance class; legacy callers may omit it. */
  sourceType?: 'document' | 'record' | 'all'
}

export interface KnowledgeRecordMatch {
  recordUid: string
  recordName: string
  nodeType: string
  itemId: string
  score: number
  chunkId: string
  snippet: string
}

type KnowledgeVectorSearchRow = ReturnType<AppDatabase['listKnowledgeVectorRows']>[number] & {
  norm: number
  coarse: Float32Array
}

export interface CoarseVectorCandidate {
  coarse: Float32Array
}

type KnowledgeLexicalTermKind =
  | 'word'
  | 'compact-word'
  | 'cjk-unigram'
  | 'cjk-bigram'
  | 'cjk-trigram'

export interface KnowledgeLexicalTerm {
  term: string
  weight: number
  kind: KnowledgeLexicalTermKind
}

/**
 * A small, language-agnostic lexical representation used alongside dense
 * retrieval.  Han text is represented by overlapping n-grams because a
 * contiguous Chinese sentence is not a useful word boundary.  Non-Han
 * letters and numbers retain word boundaries, with a compact form for text
 * where PDF/OCR extraction inserted spaces inside an identifier.
 */
export interface KnowledgeLexicalProfile {
  normalized: string
  terms: readonly KnowledgeLexicalTerm[]
  cjkRuns: readonly string[]
  totalWeight: number
  phraseWeight: number
}

const knowledgeHanPattern = /\p{Script=Han}/u
const knowledgeWordPattern = /[\p{L}\p{N}]/u
const knowledgeHanWhitespacePattern = /(\p{Script=Han})\s+(?=\p{Script=Han})/gu
const KNOWLEDGE_CJK_UNIGRAM_WEIGHT = 0.14
const KNOWLEDGE_CJK_BIGRAM_WEIGHT = 0.9
const KNOWLEDGE_CJK_TRIGRAM_WEIGHT = 1.2
const KNOWLEDGE_WORD_WEIGHT = 1.35
const KNOWLEDGE_COMPACT_WORD_WEIGHT = 1
const KNOWLEDGE_MAX_COMPACT_WORD_LENGTH = 64

const isKnowledgeHan = (value: string): boolean => knowledgeHanPattern.test(value)

const isKnowledgeWordCharacter = (value: string): boolean => knowledgeWordPattern.test(value)

/**
 * Normalize equivalent user/document text before lexical matching.  NFKC
 * handles full-width forms, while removing whitespace between Han characters
 * handles PDF/OCR output that puts one space between every CJK glyph.  Word
 * boundaries outside Han text remain intact and are handled by the feature
 * extractor below.
 */
export const normalizeKnowledgeLexicalText = (value: string): string => {
  let normalized = value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
  let compacted = normalized
  do {
    normalized = compacted
    compacted = normalized.replace(knowledgeHanWhitespacePattern, '$1')
  } while (compacted !== normalized)
  return compacted
}

interface KnowledgeLexicalFeatureData {
  normalized: string
  features: Map<string, KnowledgeLexicalTerm>
  cjkRuns: string[]
}

const addKnowledgeLexicalFeature = (
  features: Map<string, KnowledgeLexicalTerm>,
  term: string,
  weight: number,
  kind: KnowledgeLexicalTermKind
): void => {
  if (!term) return
  const existing = features.get(term)
  // Keep the strongest interpretation when a compact word happens to equal a
  // regular word or an n-gram occurs in more than one overlapping window.
  if (!existing || weight > existing.weight) features.set(term, { term, weight, kind })
}

const buildKnowledgeLexicalFeatureData = (value: string): KnowledgeLexicalFeatureData => {
  const normalized = normalizeKnowledgeLexicalText(value)
  const features = new Map<string, KnowledgeLexicalTerm>()
  const cjkRuns: string[] = []
  let wordToken = ''
  let wordSequence: string[] = []
  let cjkRun = ''

  const flushWordSequence = (): void => {
    if (wordSequence.length > 1) {
      const compact = wordSequence.join('')
      if (compact.length <= KNOWLEDGE_MAX_COMPACT_WORD_LENGTH) {
        addKnowledgeLexicalFeature(features, compact, KNOWLEDGE_COMPACT_WORD_WEIGHT, 'compact-word')
      }
    }
    wordSequence = []
  }

  const flushWordToken = (): void => {
    if (!wordToken) return
    const components = wordToken.match(/[\p{L}]+|\p{N}+/gu) ?? [wordToken]
    if (components.length > 1) {
      addKnowledgeLexicalFeature(features, wordToken, KNOWLEDGE_COMPACT_WORD_WEIGHT, 'compact-word')
      for (const component of components) {
        addKnowledgeLexicalFeature(features, component, KNOWLEDGE_WORD_WEIGHT, 'word')
      }
    } else {
      addKnowledgeLexicalFeature(features, wordToken, KNOWLEDGE_WORD_WEIGHT, 'word')
    }
    wordSequence.push(wordToken)
    wordToken = ''
  }

  const flushCjkRun = (): void => {
    if (!cjkRun) return
    const characters = Array.from(cjkRun)
    cjkRuns.push(cjkRun)
    for (const character of characters) {
      addKnowledgeLexicalFeature(features, character, KNOWLEDGE_CJK_UNIGRAM_WEIGHT, 'cjk-unigram')
    }
    for (let ngramLength = 2; ngramLength <= Math.min(3, characters.length); ngramLength += 1) {
      const weight = ngramLength === 2
        ? KNOWLEDGE_CJK_BIGRAM_WEIGHT
        : KNOWLEDGE_CJK_TRIGRAM_WEIGHT
      const kind = ngramLength === 2 ? 'cjk-bigram' as const : 'cjk-trigram' as const
      for (let index = 0; index + ngramLength <= characters.length; index += 1) {
        addKnowledgeLexicalFeature(
          features,
          characters.slice(index, index + ngramLength).join(''),
          weight,
          kind
        )
      }
    }
    cjkRun = ''
  }

  const flushAll = (): void => {
    flushWordToken()
    flushWordSequence()
    flushCjkRun()
  }

  for (const character of normalized) {
    if (isKnowledgeHan(character)) {
      flushWordToken()
      flushWordSequence()
      cjkRun += character
      continue
    }
    if (isKnowledgeWordCharacter(character)) {
      flushCjkRun()
      wordToken += character
      continue
    }
    if (/\s/u.test(character)) {
      flushCjkRun()
      // Whitespace separates ordinary words but is deliberately retained in
      // wordSequence so "GJB 5000B" also yields the compact identifier.
      flushWordToken()
      continue
    }
    flushCjkRun()
    flushWordToken()
    flushWordSequence()
  }
  flushAll()
  return { normalized, features, cjkRuns }
}

export const buildKnowledgeLexicalProfile = (value: string): KnowledgeLexicalProfile => {
  const data = buildKnowledgeLexicalFeatureData(value)
  const terms = [...data.features.values()]
  const totalWeight = terms.reduce((sum, item) => sum + item.weight, 0)
  const phraseWeight = terms
    .filter((item) => item.kind === 'cjk-bigram' || item.kind === 'cjk-trigram')
    .reduce((sum, item) => sum + item.weight, 0)
  return {
    normalized: data.normalized,
    terms,
    cjkRuns: data.cjkRuns,
    totalWeight,
    phraseWeight
  }
}

const scoreKnowledgeLexicalFeatures = (
  query: KnowledgeLexicalProfile,
  documentFeatures: ReadonlySet<string>
): number => {
  if (!query.terms.length || query.totalWeight <= 0) return 0
  let matchedWeight = 0
  let matchedPhraseWeight = 0
  for (const item of query.terms) {
    if (!documentFeatures.has(item.term)) continue
    matchedWeight += item.weight
    if (item.kind === 'cjk-bigram' || item.kind === 'cjk-trigram') {
      matchedPhraseWeight += item.weight
    }
  }
  const weightedCoverage = matchedWeight / query.totalWeight
  if (!query.phraseWeight) return Math.max(0, Math.min(1, weightedCoverage))

  // A long matching CJK span is stronger evidence than a bag of isolated
  // characters.  This also makes a relevant paragraph resilient to an added
  // identifier or natural-language question suffix that is absent in it.
  let cjkRunLength = 0
  let cjkRunMatchLength = 0
  for (const run of query.cjkRuns) {
    const characters = Array.from(run)
    if (!characters.length) continue
    cjkRunLength += characters.length
    let current = documentFeatures.has(characters[0]) ? 1 : 0
    let longest = current
    for (let index = 1; index < characters.length; index += 1) {
      if (documentFeatures.has(`${characters[index - 1]}${characters[index]}`)) {
        current += 1
      } else {
        current = documentFeatures.has(characters[index]) ? 1 : 0
      }
      if (current > longest) longest = current
    }
    cjkRunMatchLength += longest
  }
  const phraseCoverage = matchedPhraseWeight / query.phraseWeight
  const spanCoverage = cjkRunLength ? cjkRunMatchLength / cjkRunLength : phraseCoverage
  return Math.max(0, Math.min(1,
    weightedCoverage * 0.55 + phraseCoverage * 0.25 + spanCoverage * 0.2
  ))
}

/**
 * Score literal relevance in [0, 1].  The overload accepts either profiles
 * (for repeated scoring during retrieval) or raw strings (for small callers
 * and deterministic tests).
 */
export const scoreKnowledgeLexicalRelevance = (
  query: KnowledgeLexicalProfile | string,
  document: KnowledgeLexicalProfile | string
): number => {
  const queryProfile = typeof query === 'string' ? buildKnowledgeLexicalProfile(query) : query
  if (typeof document === 'string') {
    const documentProfile = buildKnowledgeLexicalFeatureData(document)
    return scoreKnowledgeLexicalFeatures(queryProfile, new Set<string>(documentProfile.features.keys()))
  }
  return scoreKnowledgeLexicalFeatures(
    queryProfile,
    new Set<string>(document.terms.map((item) => item.term))
  )
}

const selectTopScoredCandidates = <T>(
  candidates: readonly T[],
  requestedLimit: number,
  scoreOf: (candidate: T, index: number) => number
): T[] => {
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.trunc(requestedLimit))
    : candidates.length
  if (candidates.length <= safeLimit) return [...candidates]

  type ScoredCandidate = { row: T; score: number; index: number }
  const heap: ScoredCandidate[] = []
  const isWorse = (left: ScoredCandidate, right: ScoredCandidate): boolean => (
    left.score < right.score || (left.score === right.score && left.index > right.index)
  )
  const siftUp = (index: number): void => {
    let current = index
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2)
      if (!isWorse(heap[current], heap[parent])) break
      ;[heap[current], heap[parent]] = [heap[parent], heap[current]]
      current = parent
    }
  }
  const siftDown = (index: number): void => {
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      if (left < heap.length && isWorse(heap[left], heap[smallest])) smallest = left
      if (right < heap.length && isWorse(heap[right], heap[smallest])) smallest = right
      if (smallest === current) break
      ;[heap[current], heap[smallest]] = [heap[smallest], heap[current]]
      current = smallest
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const rawScore = scoreOf(candidates[index], index)
    const scored = {
      row: candidates[index],
      score: Number.isFinite(rawScore) ? rawScore : 0,
      index
    }
    if (heap.length < safeLimit) {
      heap.push(scored)
      siftUp(heap.length - 1)
    } else if (isWorse(heap[0], scored)) {
      heap[0] = scored
      siftDown(0)
    }
  }
  return heap
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ row }) => row)
}

const knowledgeHybridShortlistLimit = (candidateCount: number, requestedLimit: number): number => {
  if (candidateCount <= VECTOR_PREFILTER_THRESHOLD) return candidateCount
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.trunc(requestedLimit))
    : VECTOR_PREFILTER_MAX_CANDIDATES
  return Math.min(
    candidateCount,
    Math.max(256, Math.min(VECTOR_PREFILTER_MAX_CANDIDATES, safeLimit * 16))
  )
}

const buildKnowledgeLexicalScores = <T>(
  query: KnowledgeLexicalProfile,
  candidates: readonly T[],
  contentOf: (candidate: T) => string
): Map<T, number> => {
  const scores = new Map<T, number>()
  for (const candidate of candidates) {
    const document = buildKnowledgeLexicalFeatureData(contentOf(candidate))
    scores.set(candidate, scoreKnowledgeLexicalFeatures(query, new Set<string>(document.features.keys())))
  }
  return scores
}

const mergeKnowledgeCandidates = <T>(...groups: readonly T[][]): T[] => {
  const seen = new Set<T>()
  const merged: T[] = []
  for (const group of groups) {
    for (const candidate of group) {
      if (seen.has(candidate)) continue
      seen.add(candidate)
      merged.push(candidate)
    }
  }
  return merged
}

export const buildCoarseVector = (vector: Float32Array): Float32Array => {
  const coarse = new Float32Array(Math.ceil(vector.length / VECTOR_COARSE_STEP))
  for (let index = 0, coarseIndex = 0; index < vector.length; index += VECTOR_COARSE_STEP, coarseIndex += 1) {
    coarse[coarseIndex] = vector[index]
  }
  let norm = 0
  for (const value of coarse) norm += value * value
  if (norm > 0) {
    const inverseNorm = 1 / Math.sqrt(norm)
    for (let index = 0; index < coarse.length; index += 1) coarse[index] *= inverseNorm
  }
  return coarse
}

/**
 * Select a bounded exact-scoring shortlist for a large vector corpus. The
 * caller can use the returned rows with the full-dimensional cosine scorer.
 * Corpora below the threshold retain the exact all-candidate behavior.
 */
export const prefilterVectorCandidates = <T extends CoarseVectorCandidate>(
  queryVector: Float32Array,
  candidates: T[],
  requestedLimit: number
): T[] => {
  if (candidates.length <= VECTOR_PREFILTER_THRESHOLD) return candidates
  const queryCoarse = buildCoarseVector(queryVector)
  const safeLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.trunc(requestedLimit))
    : VECTOR_PREFILTER_MAX_CANDIDATES
  const exactLimit = Math.min(
    candidates.length,
    Math.max(256, Math.min(VECTOR_PREFILTER_MAX_CANDIDATES, safeLimit * 16))
  )

  // Keep only the best exactLimit coarse scores while scanning. The previous
  // implementation allocated and sorted one scored object per candidate,
  // making a large corpus pay O(N log N) before exact ranking. A bounded
  // min-heap keeps the same stable score order with O(N log K) work and O(K)
  // temporary memory, where K is the exact-ranking shortlist size.
  type ScoredCandidate = { row: T; score: number; index: number }
  const heap: ScoredCandidate[] = []
  const isWorse = (left: ScoredCandidate, right: ScoredCandidate): boolean => (
    left.score < right.score || (left.score === right.score && left.index > right.index)
  )
  const siftUp = (index: number): void => {
    let current = index
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2)
      if (!isWorse(heap[current], heap[parent])) break
      ;[heap[current], heap[parent]] = [heap[parent], heap[current]]
      current = parent
    }
  }
  const siftDown = (index: number): void => {
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      if (left < heap.length && isWorse(heap[left], heap[smallest])) smallest = left
      if (right < heap.length && isWorse(heap[right], heap[smallest])) smallest = right
      if (smallest === current) break
      ;[heap[current], heap[smallest]] = [heap[smallest], heap[current]]
      current = smallest
    }
  }

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const row = candidates[candidateIndex]
    const length = Math.min(queryCoarse.length, row.coarse.length)
    let score = 0
    for (let index = 0; index < length; index += 1) score += queryCoarse[index] * row.coarse[index]
    const scored = { row, score, index: candidateIndex }
    if (heap.length < exactLimit) {
      heap.push(scored)
      siftUp(heap.length - 1)
    } else if (isWorse(heap[0], scored)) {
      heap[0] = scored
      siftDown(0)
    }
  }

  return heap
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ row }) => row)
}

interface ParsedPage {
  text: string
  pageNumber?: number
  sheetName?: string
  location: string
}

interface ParsedDocument {
  pages: ParsedPage[]
  pageCount: number
}

interface TransformerRuntime {
  env: {
    allowRemoteModels?: boolean
    allowLocalModels?: boolean
    localModelPath?: string
    cacheDir?: string
  }
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>
}

const extensionFor = (filePath: string): string => extname(filePath).toLocaleLowerCase()

const mimeFor = (extension: string): string => ({
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.txt': 'text/plain'
}[extension] ?? 'application/octet-stream')

const fileHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const validateDocumentSignature = (bytes: Buffer, extension: string): void => {
  const startsWith = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value)
  if (extension === '.pdf' && bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('文件内容不是有效的 PDF')
  }
  if ((extension === '.docx' || extension === '.xlsx') && !startsWith(0x50, 0x4b)) {
    throw new Error(`文件内容不是有效的 ${extension.slice(1).toUpperCase()} 压缩文档`)
  }
  if (extension === '.xls' && !startsWith(0xd0, 0xcf, 0x11, 0xe0)) {
    throw new Error('文件内容不是有效的 XLS 文档')
  }
  if (extension === '.txt') {
    const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
    const nullCount = [...sample].filter((value) => value === 0).length
    if (sample.length && nullCount > sample.length / 10) throw new Error('文本文件包含过多二进制内容')
  }
}

const cleanText = (value: string): string => value
  .replace(/\u0000/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

const decodeText = (bytes: Buffer): string => {
  if (bytes.length === 0) return ''
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return cleanText(bytes.subarray(3).toString('utf8'))
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return cleanText(new TextDecoder('utf-16le').decode(bytes.subarray(2)))
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return cleanText(new TextDecoder('utf-16be').decode(bytes.subarray(2)))
  }
  const utf8 = bytes.toString('utf8')
  const replacementCount = (utf8.match(/\ufffd/g) ?? []).length
  if (replacementCount > 2 && replacementCount > utf8.length / 80) {
    return cleanText(iconv.decode(bytes, 'gb18030'))
  }
  return cleanText(utf8)
}

const pageText = (text: string, pageNumber?: number, sheetName?: string): ParsedPage[] => {
  const pieces = text.split('\f').map(cleanText).filter(Boolean)
  if (!pieces.length) return []
  return pieces.map((piece, index) => ({
    text: piece,
    ...(pageNumber === undefined ? {} : { pageNumber: pageNumber + index }),
    ...(sheetName ? { sheetName } : {}),
    location: sheetName
      ? `工作表: ${sheetName}`
      : pageNumber === undefined
        ? '文档正文'
        : `第 ${pageNumber + index} 页`
  }))
}

export const chunkKnowledgePages = (
  pages: ParsedPage[],
  chunkSize = CHUNK_SIZE,
  overlap = CHUNK_OVERLAP
): Array<ParsedPage & { chunkIndex: number; charStart: number; charEnd: number }> => {
  const chunks: Array<ParsedPage & { chunkIndex: number; charStart: number; charEnd: number }> = []
  const safeSize = Math.max(100, Math.floor(chunkSize))
  const safeOverlap = Math.min(Math.floor(overlap), safeSize - 1)
  let chunkIndex = 0
  for (const page of pages) {
    const text = cleanText(page.text)
    if (!text) continue
    if (text.length <= safeSize) {
      chunks.push({ ...page, text, chunkIndex, charStart: 0, charEnd: text.length })
      chunkIndex += 1
      continue
    }
    let offset = 0
    while (offset < text.length) {
      const end = Math.min(text.length, offset + safeSize)
      const content = cleanText(text.slice(offset, end))
      if (content) {
        const contentStart = text.indexOf(content, offset)
        chunks.push({
          ...page,
          text: content,
          chunkIndex,
          charStart: contentStart >= 0 ? contentStart : offset,
          charEnd: Math.min(text.length, (contentStart >= 0 ? contentStart : offset) + content.length)
        })
        chunkIndex += 1
      }
      if (end >= text.length) break
      offset = Math.max(offset + 1, end - safeOverlap)
    }
  }
  return chunks
}

const locateResource = (...parts: string[]): string | null => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.env.VISSLM_RESOURCE_ROOT,
    process.resourcesPath,
    join(process.cwd(), 'buildResources'),
    join(moduleDir, '..', '..', 'buildResources')
  ].filter((value): value is string => Boolean(value))
  for (const root of candidates) {
    const path = join(root, ...parts)
    if (existsSync(path)) return path
  }
  return null
}

const modelRoot = (): string | null => {
  const explicit = process.env.VISSLM_EMBEDDING_MODEL_PATH
  const candidates = [
    ...(explicit ? [explicit] : []),
    locateResource('models')
  ].filter((value): value is string => Boolean(value))
  const modelParts = EMBEDDING_MODEL_ID.split('/')
  return candidates.find((candidate) =>
    existsSync(join(candidate, 'config.json')) ||
    existsSync(join(candidate, ...modelParts, 'config.json'))
  ) ?? null
}

class DocumentParser {
  async parse(filePath: string): Promise<ParsedDocument> {
    const extension = extensionFor(filePath)
    const bytes = readFileSync(filePath)
    if (!bytes.length) throw new Error('文件内容为空，无法建立知识索引')
    if (extension === '.txt') return this.parseText(bytes)
    if (extension === '.docx') return this.parseDocx(bytes)
    if (extension === '.xlsx' || extension === '.xls') return this.parseSpreadsheet(bytes)
    if (extension === '.pdf') return this.parsePdf(bytes)
    throw new Error(`不支持的文件格式: ${extension || '无扩展名'}`)
  }

  private parseText(bytes: Buffer): ParsedDocument {
    const text = decodeText(bytes)
    if (!text) throw new Error('文本文件为空，无法建立知识索引')
    const pages = pageText(text)
    return { pages, pageCount: pages.length || 1 }
  }

  private async parseDocx(bytes: Buffer): Promise<ParsedDocument> {
    const result = await mammoth.extractRawText({ buffer: bytes })
    const text = cleanText(result.value)
    if (!text) throw new Error('Word 文档未解析出正文内容')
    const pages = pageText(text)
    return { pages, pageCount: pages.length || 1 }
  }

  private parseSpreadsheet(bytes: Buffer): ParsedDocument {
    const workbook = XLSX.read(bytes, { type: 'buffer', cellDates: true })
    const pages: ParsedPage[] = []
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: false,
        defval: ''
      })
      const text = rows
        .map((row, rowIndex) => {
          const cells = Array.isArray(row) ? row : []
          return `第 ${rowIndex + 1} 行: ${cells.map((cell, columnIndex) =>
            `${String.fromCharCode(65 + Math.min(columnIndex, 25))}列=${String(cell ?? '').trim()}`
          ).filter((cell) => !cell.endsWith('=')).join(' | ')}`
        })
        .filter((row) => !row.endsWith(': '))
        .join('\n')
      if (cleanText(text)) {
        pages.push({
          text: cleanText(text),
          sheetName,
          location: `工作表: ${sheetName}`
        })
      }
    }
    if (!pages.length) throw new Error('Excel 文件没有可解析的工作表内容')
    return { pages, pageCount: pages.length }
  }

  private async parsePdf(bytes: Buffer): Promise<ParsedDocument> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as {
      getDocument: (options: Record<string, unknown>) => { promise: Promise<any> }
    }
    const pdf = await pdfjs.getDocument({
      data: new Uint8Array(bytes),
      disableWorker: true,
      useWorkerFetch: false,
      isEvalSupported: false
    }).promise
    const pagesByNumber = new Map<number, ParsedPage>()
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = cleanText((content.items as Array<{ str?: string }>)
        .map((item) => item.str ?? '')
        .join(' '))
      if (text) pagesByNumber.set(pageNumber, { text, pageNumber, location: `第 ${pageNumber} 页` })
    }
    const missingPageNumbers = Array.from({ length: pdf.numPages }, (_value, index) => index + 1)
      .filter((pageNumber) => !pagesByNumber.has(pageNumber))
    if (missingPageNumbers.length) {
      const ocrPages = await this.ocrPdf(pdf, missingPageNumbers)
      ocrPages.forEach((page) => pagesByNumber.set(page.pageNumber!, page))
    }
    const pages = [...pagesByNumber.values()].sort((left, right) => (left.pageNumber ?? 0) - (right.pageNumber ?? 0))
    if (!pages.length) throw new Error('扫描 PDF OCR 未识别出正文内容')
    return { pages, pageCount: pdf.numPages }
  }

  private async ocrPdf(pdf: any, pageNumbers: number[]): Promise<ParsedPage[]> {
    const canvasModule = await import('@napi-rs/canvas') as unknown as {
      createCanvas: (width: number, height: number) => {
        getContext: (type: '2d') => unknown
        toBuffer: (mime: string) => Buffer
      }
    }
    const tesseract = await import('tesseract.js') as unknown as {
      createWorker: (...args: unknown[]) => Promise<any>
    }
    const tessdata = locateResource('ocr', 'tessdata')
    if (!tessdata) throw new Error('扫描 PDF 未找到 OCR 语言资源，请重新安装完整资源包')
    const worker = await tesseract.createWorker(['chi_sim', 'eng'], 1, {
      langPath: tessdata,
      cachePath: this.ocrCachePath(),
      gzip: true
    })
    await worker.setParameters({
      tessedit_pageseg_mode: OCR_PAGE_SEGMENTATION_MODE,
      preserve_interword_spaces: '1',
      user_defined_dpi: String(Math.round(OCR_RENDER_SCALE * 72))
    })
    const pages: ParsedPage[] = []
    try {
      for (const pageNumber of pageNumbers) {
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: OCR_RENDER_SCALE })
        const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport,
          intent: 'print'
        }).promise
        const result = await worker.recognize(canvas.toBuffer('image/png'))
        const text = cleanText(String(result?.data?.text ?? ''))
        if (text) pages.push({ text, pageNumber, location: `第 ${pageNumber} 页（OCR）` })
      }
    } finally {
      await worker.terminate()
    }
    return pages
  }

  private ocrCachePath(): string {
    const root = process.env.LOCALAPPDATA || tmpdir()
    const cachePath = join(root, 'VISSLM Agent', 'ocr-cache')
    mkdirSync(cachePath, { recursive: true })
    return cachePath
  }
}

class EmbeddingService {
  private extractor: ((texts: string[], options?: Record<string, unknown>) => Promise<any>) | null = null
  private attempted = false
  private preparationPromise: Promise<void> | null = null
  private actualModelVersion = FALLBACK_MODEL_VERSION
  private failureReason = '本地 embedding 模型尚未加载'

  get modelVersion(): string {
    return this.actualModelVersion
  }

  get available(): boolean {
    return Boolean(this.extractor) || this.allowFallback()
  }

  get unavailableReason(): string {
    return this.failureReason
  }

  async prepare(): Promise<void> {
    await this.ensureExtractor()
  }

  async embedMany(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return []
    await this.ensureExtractor()
    if (this.extractor) {
      try {
        const result = await this.extractor(texts, { pooling: 'mean', normalize: true })
        const rows = this.toRows(result, texts.length)
        if (rows.length === texts.length) return rows
        throw new Error('本地 embedding 模型返回的向量数量无效')
      } catch (error) {
        console.warn('[knowledge] local embedding failed:', error)
        this.extractor = null
        this.actualModelVersion = FALLBACK_MODEL_VERSION
        this.failureReason = error instanceof Error ? error.message : String(error)
      }
    }
    if (this.allowFallback()) return texts.map((text) => this.hashEmbedding(text))
    return []
  }

  private async ensureExtractor(): Promise<void> {
    if (this.extractor || (this.attempted && !this.preparationPromise)) return
    if (this.preparationPromise) return this.preparationPromise
    this.attempted = true
    this.preparationPromise = this.loadExtractor().finally(() => {
      this.preparationPromise = null
    })
    return this.preparationPromise
  }

  private async loadExtractor(): Promise<void> {
    const root = modelRoot()
    if (!root) {
      this.failureReason = '本地 embedding 模型资源未找到，请先执行 npm run prepare:model 完成资源准备'
      return
    }
    try {
      const runtime = await import('@huggingface/transformers') as unknown as TransformerRuntime
      runtime.env.allowRemoteModels = false
      runtime.env.allowLocalModels = true
      runtime.env.localModelPath = root
      runtime.env.cacheDir = join(root, 'cache')
      const loaded = await runtime.pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        dtype: 'q8',
        local_files_only: true
      })
      if (typeof loaded !== 'function') throw new Error('embedding pipeline 不可用')
      this.extractor = loaded as (texts: string[], options?: Record<string, unknown>) => Promise<any>
      this.actualModelVersion = EMBEDDING_MODEL_VERSION
      this.failureReason = ''
    } catch (error) {
      console.warn('[knowledge] local embedding model unavailable:', error)
      this.failureReason = error instanceof Error ? error.message : String(error)
    }
  }

  private allowFallback(): boolean {
    return process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK === '1'
  }

  private toRows(result: any, expected: number): Float32Array[] {
    if (typeof result?.tolist === 'function') {
      const values = result.tolist() as unknown
      if (Array.isArray(values)) {
        const rows = Array.isArray(values[0]) ? values : [values]
        return rows.map((row) => this.normalizeRow(row as unknown[]))
      }
    }
    const data = result?.data as ArrayLike<number> | undefined
    const dims = result?.dims as number[] | undefined
    if (!data || !dims?.length) return []
    const dimension = Number(dims[dims.length - 1])
    if (!dimension || data.length !== expected * dimension) return []
    return Array.from({ length: expected }, (_, index) =>
      this.normalizeRow(Array.from(data).slice(index * dimension, (index + 1) * dimension))
    )
  }

  private normalizeRow(values: unknown[]): Float32Array {
    const vector = new Float32Array(values.map((value) => Number(value) || 0))
    let norm = 0
    for (const value of vector) norm += value * value
    const scale = norm > 0 ? 1 / Math.sqrt(norm) : 1
    for (let index = 0; index < vector.length; index += 1) vector[index] *= scale
    return vector
  }

  private hashEmbedding(text: string): Float32Array {
    const vector = new Float32Array(EMBEDDING_DIMENSION)
    const normalized = text.toLocaleLowerCase().replace(/\s+/g, ' ')
    const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
    const units = tokens.length ? tokens : Array.from(normalized)
    for (const token of units) {
      let hash = 2166136261
      for (const char of token) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
      }
      vector[Math.abs(hash) % vector.length] += 1
    }
    for (let index = 0; index + 1 < normalized.length; index += 1) {
      const pair = normalized.slice(index, index + 2)
      let hash = 2166136261
      for (const char of pair) {
        hash ^= char.codePointAt(0) ?? 0
        hash = Math.imul(hash, 16777619)
      }
      vector[Math.abs(hash) % vector.length] += 0.35
    }
    return this.normalizeRow(Array.from(vector))
  }
}

export class KnowledgeService {
  private readonly parser = new DocumentParser()
  private readonly embeddings = new EmbeddingService()
  private readonly taskRunner = new BackgroundTaskRunner(KNOWLEDGE_MAX_CONCURRENT_TASKS)
  private initializationPromise: Promise<void> | null = null
  private indexingPromise: Promise<void> | null = null
  private vectorRowsCache: {
    modelVersion: string
    createdAt: number
    rows: KnowledgeVectorSearchRow[]
  } | null = null
  private readonly searchResultCache = new Map<string, {
    createdAt: number
    result: KnowledgeSearchHit[]
  }>()
  private readonly taskStartedAt = new Map<string, number>()

  constructor(
    private readonly db: AppDatabase,
    private readonly progress?: (progress: KnowledgeIndexProgress) => void,
    private readonly recordIndexLock: AsyncMutex = new AsyncMutex()
  ) {}

  private clearVectorCaches(): void {
    this.vectorRowsCache = null
    this.searchResultCache.clear()
  }

  private rememberSearchResult(cacheKey: string, result: KnowledgeSearchHit[]): void {
    this.searchResultCache.set(cacheKey, { createdAt: Date.now(), result })
    while (this.searchResultCache.size > SEARCH_RESULT_CACHE_MAX_ENTRIES) {
      const oldestKey = this.searchResultCache.keys().next().value as string | undefined
      if (!oldestKey) break
      this.searchResultCache.delete(oldestKey)
    }
  }

  get modelVersion(): string {
    return this.embeddings.modelVersion
  }

  cancelTask(taskId: string): boolean {
    const normalized = taskId.trim()
    const cancelled = this.taskRunner.cancel(normalized)
    if (cancelled) {
      this.emit({
        taskId: normalized,
        phase: 'error',
        message: '知识库后台任务已请求停止',
        current: 0,
        total: 0,
        status: 'failed'
      })
    }
    return cancelled
  }

  cancelAllTasks(): void {
    this.taskRunner.cancelAll()
  }

  async initialize(): Promise<void> {
    if (!this.initializationPromise) this.initializationPromise = this.initializeInternal()
    return this.initializationPromise
  }

  private async initializeInternal(): Promise<void> {
    await this.embeddings.prepare()
    if (!this.embeddings.available) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: this.embeddings.unavailableReason,
        current: 0,
        total: 0,
        status: 'failed'
      })
      return
    }
    try {
      await this.resumePendingDocuments()
      if (this.db.knowledgeDocumentsNeedReindex(this.modelVersion)) await this.rebuildIndex()
      await this.syncRecordIndex()
    } catch (error) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        current: 0,
        total: 0,
        status: 'failed'
      })
    }
  }

  /**
   * A restart converts interrupted documents back to `queued`. Replaying the
   * parser/embedding pipeline is safe because document chunks are replaced in
   * one transaction, and it lets the delayed startup recovery finish work
   * without requiring the user to discover each failed document manually.
   */
  private async resumePendingDocuments(): Promise<void> {
    const documents = this.db.listKnowledgeDocumentsForResume()
    if (!documents.length) return
    const taskId = randomUUID()
    const task = this.taskRunner.begin(taskId)
    try {
      for (let index = 0; index < documents.length; index += 1) {
        await task.checkpoint()
        await this.processDocument(
          documents[index],
          taskId,
          index + 1,
          documents.length,
          undefined,
          task
        )
      }
    } finally {
      task.dispose()
    }
  }

  async processFiles(
    filePaths: string[],
    onProgress?: (progress: KnowledgeIndexProgress) => void
  ): Promise<KnowledgeUploadResult> {
    const taskId = randomUUID()
    const task = this.taskRunner.begin(taskId)
    try {
      const documents: KnowledgeDocument[] = []
      const skipped: Array<{ fileName: string; reason: string }> = []
      let failedCount = 0
      let acceptedCount = 0
      let reusedCount = 0
      for (const filePath of [...new Set(filePaths)]) {
        await task.checkpoint()
        const fileName = filePath.split(/[\\/]/).pop() ?? filePath
        const extension = extensionFor(filePath)
        if (!SUPPORTED_EXTENSIONS.has(extension)) {
          skipped.push({ fileName, reason: `不支持 ${extension || '无扩展名'} 文件` })
          continue
        }
        let bytes: Buffer
        let byteSize: number
        try {
          const stats = statSync(filePath)
          byteSize = stats.size
          if (!stats.isFile()) throw new Error('路径不是文件')
          if (byteSize > MAX_KNOWLEDGE_FILE_BYTES) throw new Error('文件超过 100 MB 限制')
          bytes = readFileSync(filePath)
        } catch (error) {
          skipped.push({ fileName, reason: error instanceof Error ? error.message : String(error) })
          continue
        }
        const sha256 = fileHash(bytes)
        const existing = this.db.findKnowledgeDocumentByHash(sha256)
        if (existing) {
          const managedPath = this.db.storeKnowledgeDocumentFile(bytes, sha256, extension)
          this.db.updateKnowledgeDocumentFilePath(existing.id, managedPath)
          const managedDocument = { ...existing, filePath: managedPath }
          const reused = existing.status === 'ready'
            ? managedDocument
            : await this.processDocument(
                managedDocument,
                taskId,
                documents.length + 1,
                filePaths.length,
                onProgress,
                task
              )
          documents.push(reused)
          reusedCount += 1
          if (reused.status === 'failed') failedCount += 1
          if (existing.status === 'ready') {
            this.emitAndNotify(onProgress, {
              taskId,
              phase: 'done',
              documentId: reused.id,
              fileName: reused.fileName,
              message: `${reused.fileName} 已复用现有知识库索引`,
              current: documents.length,
              total: filePaths.length,
              status: 'success'
            })
          }
          skipped.push({ fileName, reason: `重复文件，已复用知识库索引（${existing.fileName}）` })
          continue
        }
        const managedPath = this.db.storeKnowledgeDocumentFile(bytes, sha256, extension)
        const document = this.db.insertKnowledgeDocument({
          id: randomUUID(),
          fileName,
          filePath: managedPath,
          extension,
          mimeType: mimeFor(extension),
          byteSize,
          sha256,
          modelVersion: this.modelVersion
        })
        this.emitAndNotify(onProgress, {
          taskId,
          phase: 'queued',
          documentId: document.id,
          fileName,
          message: `已加入解析队列: ${fileName}`,
          current: documents.length,
          total: filePaths.length,
          status: 'running'
        })
        documents.push(document)
        acceptedCount += 1
        let processed: KnowledgeDocument
        try {
          if (!bytes.length) throw new Error('文件内容为空')
          validateDocumentSignature(bytes, extension)
          processed = await this.processDocument(
            document,
            taskId,
            documents.length,
            filePaths.length,
            onProgress,
            task
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          processed = this.db.updateKnowledgeDocument(document.id, {
            status: 'failed',
            errorMessage: message,
            processedAt: ''
          }) ?? { ...document, status: 'failed', errorMessage: message }
          this.emitAndNotify(onProgress, {
            taskId,
            phase: 'error',
            documentId: document.id,
            fileName,
            message: `${fileName}: ${message}`,
            current: documents.length,
            total: filePaths.length,
            status: 'failed'
          })
        }
        if (processed.status === 'failed') failedCount += 1
      }
      return {
        ok: failedCount === 0 && (documents.length > 0 || skipped.length === 0),
        acceptedCount,
        reusedCount,
        skippedCount: skipped.length,
        failedCount,
        documents: documents.map((document) => this.db.getKnowledgeDocument(document.id) as KnowledgeDocument),
        skipped,
        message: `知识库处理完成：${acceptedCount} 个新增，${reusedCount} 个复用，${failedCount} 个失败，${skipped.length - reusedCount} 个跳过`
      }
    } finally {
      task.dispose()
    }
  }

  async retryDocument(id: string): Promise<KnowledgeDocument | null> {
    const document = this.db.getKnowledgeDocument(id)
    if (!document) return null
    const taskId = randomUUID()
    const task = this.taskRunner.begin(taskId)
    try {
      return await this.processDocument(document, taskId, 1, 1, undefined, task)
    } finally {
      task.dispose()
    }
  }

  updateDocumentTags(id: string, tags: string[]): KnowledgeDocument | null {
    const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20)
    return this.db.updateKnowledgeDocument(id, { tags: normalized })
  }

  deleteDocument(id: string): { ok: boolean; message: string } {
    const result = this.db.deleteKnowledgeDocument(id)
    if (result.deleted) this.clearVectorCaches()
    return result.deleted
      ? { ok: true, message: `已从知识库删除 ${id}` }
      : { ok: false, message: '文档不存在或已经删除' }
  }

  async rebuildIndex(): Promise<KnowledgeRebuildResult> {
    return this.recordIndexLock.runExclusive(async () => {
      await this.syncRecordIndexInternal()
      return this.rebuildIndexInternal()
    })
  }

  async rebuildIndexInLock(): Promise<KnowledgeRebuildResult> {
    return this.rebuildIndexInternal()
  }

  private async rebuildIndexInternal(): Promise<KnowledgeRebuildResult> {
    const taskId = randomUUID()
    const task = this.taskRunner.begin(taskId)
    try {
      await this.embeddings.prepare()
      if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
      this.clearVectorCaches()
      const chunks = this.db.listKnowledgeChunksForRebuild()
      this.db.deleteKnowledgeVectors()
      const vectors: KnowledgeVectorInput[] = []
      for (let index = 0; index < chunks.length; index += 32) {
        await task.checkpoint()
        const batch = chunks.slice(index, index + 32)
        const embeddings = await this.embeddings.embedMany(batch.map((chunk) => chunk.content))
        if (embeddings.length !== batch.length) throw new Error(this.embeddings.unavailableReason)
        vectors.push(...batch.map((chunk, batchIndex) => ({
          chunkId: chunk.id,
          vector: embeddings[batchIndex],
          modelVersion: this.modelVersion
        })))
        this.emit({
          taskId,
          phase: 'embedding',
          message: `正在重建向量索引（${Math.min(index + batch.length, chunks.length)}/${chunks.length}）`,
          current: Math.min(index + batch.length, chunks.length),
          total: chunks.length,
          status: 'running'
        })
      }
      this.db.saveKnowledgeVectors(vectors)
      this.clearVectorCaches()
      this.db.markKnowledgeDocumentsModelVersion(this.modelVersion)
      const stats = this.db.getKnowledgeStats(this.modelVersion)
      this.emit({
        taskId,
        phase: 'done',
        message: '知识库向量索引已重建',
        current: chunks.length,
        total: chunks.length,
        status: 'success'
      })
      return {
        ok: true,
        taskId,
        documentCount: stats.documentCount,
        recordCount: stats.recordCount,
        chunkCount: chunks.length,
        message: '知识库向量索引已重建'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({
        taskId,
        phase: 'error',
        message: `索引重建失败：${message}`,
        current: 0,
        total: 0,
        status: 'failed'
      })
      throw error
    } finally {
      task.dispose()
    }
  }

  async syncRecordIndex(): Promise<void> {
    if (this.indexingPromise) return this.indexingPromise
    this.indexingPromise = this.recordIndexLock.runExclusive(() => this.syncRecordIndexInternal()).finally(() => {
      this.indexingPromise = null
    })
    return this.indexingPromise
  }

  async syncRecordIndexInLock(): Promise<void> {
    return this.syncRecordIndexInternal()
  }

  async rebuildRecordIndexInLock(
    recordUid: string,
    taskId = '',
    operation: RecordMaintenanceOperation | '' = ''
  ): Promise<number> {
    const activeTaskId = taskId || randomUUID()
    const task = this.taskRunner.begin(activeTaskId)
    try {
      await this.embeddings.prepare()
      if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
      const row = this.db.getKnowledgeRecordIndexRow(recordUid)
      if (!row) throw new Error('记录不存在或已被删除')
      const pages: ParsedPage[] = [{ text: row.content, location: '采集记录' }]
      const chunks = chunkKnowledgePages(pages)
      await task.checkpoint()
      const embeddings = await this.embeddings.embedMany(chunks.map((chunk) => chunk.text))
      if (embeddings.length !== chunks.length) throw new Error(this.embeddings.unavailableReason)
      const inputs: KnowledgeChunkInput[] = []
      const vectors: KnowledgeVectorInput[] = []
      chunks.forEach((chunk, chunkIndex) => {
        const chunkId = randomUUID()
        inputs.push({
          id: chunkId,
          recordUid: row.uid,
          sourceType: 'record',
          sourceName: row.name,
          sourceHash: row.contentHash,
          content: chunk.text,
          chunkIndex,
          location: chunk.location,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd
        })
        vectors.push({ chunkId, vector: embeddings[chunkIndex], modelVersion: this.modelVersion })
      })
      this.db.replaceKnowledgeRecordChunks(row.uid, inputs, vectors, taskId, operation)
      this.clearVectorCaches()
      return inputs.length
    } finally {
      task.dispose()
    }
  }

  private vectorRowsForSearch(): KnowledgeVectorSearchRow[] {
    const modelVersion = this.modelVersion
    const now = Date.now()
    if (
      this.vectorRowsCache &&
      this.vectorRowsCache.modelVersion === modelVersion &&
      now - this.vectorRowsCache.createdAt <= 30_000
    ) {
      return this.vectorRowsCache.rows
    }
    // Existing databases may not have coarse blobs yet. Backfill a bounded
    // batch on each cache refresh; the remaining rows still use the exact
    // in-memory fallback and are progressively prepared for future sharding.
    this.db.backfillKnowledgeVectorCoarseIndex(modelVersion, 512)
    const rows = this.db.listKnowledgeVectorRows(modelVersion).map((row) => ({
      ...row,
      // Vectors written by the current embedding service are normalized, but
      // older databases may contain unnormalized blobs.  Cache the norm once
      // per refresh so each query only performs a dot product per candidate.
      norm: this.vectorNorm(row.vector),
      coarse: row.coarse ?? buildCoarseVector(row.vector)
    }))
    this.vectorRowsCache = { modelVersion, createdAt: now, rows }
    return rows
  }

  async search(
    question: string,
    limitOrOptions: number | KnowledgeSearchOptions = 8,
    options?: KnowledgeSearchOptions
  ): Promise<KnowledgeSearchHit[]> {
    const query = question.trim()
    if (!query) return []
    const limit = typeof limitOrOptions === 'number' ? limitOrOptions : 8
    const searchOptions = typeof limitOrOptions === 'number' ? options : limitOrOptions
    const sourceType = searchOptions?.sourceType === 'document' || searchOptions?.sourceType === 'record'
      ? searchOptions.sourceType
      : 'all'
    const safeLimit = Math.min(20, Math.max(1, Math.trunc(Number.isFinite(limit) ? limit : 8)))
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) return []
    const cacheKey = `${this.modelVersion}:${sourceType}:${safeLimit}:${normalizeKnowledgeLexicalText(query)}`
    const cached = this.searchResultCache.get(cacheKey)
    if (cached && Date.now() - cached.createdAt <= SEARCH_RESULT_CACHE_TTL_MS) {
      return cached.result
    }
    if (cached) this.searchResultCache.delete(cacheKey)
    const [queryVector] = await this.embeddings.embedMany([query])
    await this.waitForIndexReady()
    const allCandidates = this.vectorRowsForSearch().filter(({ chunk }) => (
      sourceType === 'all' || chunk.sourceType === sourceType
    ))
    if (!queryVector || !allCandidates.length) {
      this.rememberSearchResult(cacheKey, [])
      return []
    }
    const queryLexicalProfile = buildKnowledgeLexicalProfile(query)
    const lexicalScores = buildKnowledgeLexicalScores(
      queryLexicalProfile,
      allCandidates,
      (candidate) => candidate.chunk.content
    )
    const vectorCandidates = prefilterVectorCandidates(queryVector, allCandidates, safeLimit)
    const lexicalCandidates = selectTopScoredCandidates(
      allCandidates,
      knowledgeHybridShortlistLimit(allCandidates.length, safeLimit),
      (candidate) => lexicalScores.get(candidate) ?? 0
    )
    // Large indexes must retain both dense and literal evidence.  A pure
    // vector prefilter can discard an exact CJK/topic hit before hybrid
    // scoring gets a chance to see it.
    const candidates = mergeKnowledgeCandidates(vectorCandidates, lexicalCandidates)
    const queryNorm = this.vectorNorm(queryVector)
    const ranked = candidates.map((candidate) => {
      const { chunk, vector, norm } = candidate
      const cosine = this.cosine(queryVector, vector, norm, queryNorm)
      const lexical = lexicalScores.get(candidate) ?? 0
      const score = cosine * 0.75 + lexical * 0.25
      const source: ChatSource = chunk.sourceType === 'document'
        ? {
            uid: `document:${chunk.documentId ?? chunk.id}`,
            name: chunk.sourceName,
            nodeType: 'knowledge_document',
            itemId: chunk.documentId ?? chunk.id,
            sourceType: 'document',
            documentId: chunk.documentId,
            chunkId: chunk.id,
            fileName: chunk.sourceName,
            location: chunk.location,
            pageNumber: chunk.pageNumber,
            sheetName: chunk.sheetName,
            snippet: chunk.content.slice(0, 320),
            score
          }
        : {
            uid: chunk.recordUid ?? chunk.id,
            name: chunk.sourceName,
            nodeType: 'record',
            itemId: chunk.recordUid ?? chunk.id,
            sourceType: 'record',
            chunkId: chunk.id,
            location: chunk.location,
            snippet: chunk.content.slice(0, 320),
            score
          }
      return { source, chunk, score }
    })
      .filter((item) => item.score >= 0.18)
      .sort((left, right) => right.score - left.score)
      .slice(0, safeLimit)
    this.rememberSearchResult(cacheKey, ranked)
    return ranked
  }

  private async waitForIndexReady(): Promise<void> {
    if (this.initializationPromise) {
      try {
        await this.initializationPromise
      } catch {
        // A failed startup index should not prevent structured record queries.
      }
    }
    if (this.indexingPromise) {
      try {
        await this.indexingPromise
      } catch {
        // A failed incremental index should fall back to the records table.
      }
    }
  }

  async rankRecordMatches(question: string, limit = 100_000): Promise<KnowledgeRecordMatch[]> {
    const query = question.trim()
    if (!query) return []
    await this.embeddings.prepare()
    if (!this.embeddings.available) return []
    const [queryVector] = await this.embeddings.embedMany([query])
    const allCandidates = this.vectorRowsForSearch()
      .filter(({ chunk }) => chunk.sourceType === 'record' && Boolean(chunk.recordUid))
    const queryLexicalProfile = buildKnowledgeLexicalProfile(query)
    const lexicalScores = buildKnowledgeLexicalScores(
      queryLexicalProfile,
      allCandidates,
      (candidate) => candidate.chunk.content
    )
    const vectorCandidates = queryVector
      ? prefilterVectorCandidates(queryVector, allCandidates, limit)
      : []
    const lexicalCandidates = selectTopScoredCandidates(
      allCandidates,
      knowledgeHybridShortlistLimit(allCandidates.length, limit),
      (candidate) => lexicalScores.get(candidate) ?? 0
    )
    const candidates = mergeKnowledgeCandidates(vectorCandidates, lexicalCandidates)
    if (!queryVector || !candidates.length) return []
    const queryNorm = this.vectorNorm(queryVector)

    const bestByRecord = new Map<string, KnowledgeRecordMatch>()
    for (const candidate of candidates) {
      const { chunk, vector, norm } = candidate
      const recordUid = chunk.recordUid as string
      const cosine = Math.max(0, this.cosine(queryVector, vector, norm, queryNorm))
      const lexical = lexicalScores.get(candidate) ?? 0
      // Full-requirement semantics drive recall; literal overlap is only a small supporting signal.
      const score = Math.max(0, Math.min(1, cosine * 0.85 + lexical * 0.15)) * 100
      const existing = bestByRecord.get(recordUid)
      if (existing && existing.score >= score) continue
      bestByRecord.set(recordUid, {
        recordUid,
        recordName: chunk.sourceName,
        nodeType: 'record',
        itemId: recordUid,
        score,
        chunkId: chunk.id,
        snippet: chunk.content.slice(0, 600)
      })
    }
    return [...bestByRecord.values()]
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
      .slice(0, Math.max(1, Math.trunc(limit)))
  }

  async rankRequirementRecordMatches(
    question: string,
    limit = 100,
    allowedRecordUids?: ReadonlySet<string>
  ): Promise<KnowledgeRecordMatch[]> {
    const query = question.trim()
    if (!query) return []
    await this.initialize()
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
    const [queryVector] = await this.embeddings.embedMany([query])
    if (!queryVector) throw new Error(this.embeddings.unavailableReason || '本地 embedding 未返回查询向量')
    const allCandidates = this.vectorRowsForSearch()
      .filter(({ chunk }) =>
        chunk.sourceType === 'record' &&
        Boolean(chunk.recordUid) &&
        (!allowedRecordUids || allowedRecordUids.has(chunk.recordUid as string))
      )
    const candidates = prefilterVectorCandidates(queryVector, allCandidates, limit)
    if (!candidates.length) {
      throw new Error(`数据中心记录向量索引不可用或尚未使用模型 ${this.modelVersion} 建立`)
    }
    const queryNorm = this.vectorNorm(queryVector)
    const bestByRecord = new Map<string, KnowledgeRecordMatch>()
    for (const { chunk, vector, norm } of candidates) {
      const recordUid = chunk.recordUid as string
      if (allowedRecordUids && !allowedRecordUids.has(recordUid)) continue
      const score = Math.max(0, Math.min(1, this.cosine(queryVector, vector, norm, queryNorm))) * 100
      const existing = bestByRecord.get(recordUid)
      if (existing && existing.score >= score) continue
      bestByRecord.set(recordUid, {
        recordUid,
        recordName: chunk.sourceName,
        nodeType: 'record',
        itemId: recordUid,
        score,
        chunkId: chunk.id,
        snippet: chunk.content.slice(0, 600)
      })
    }
    return [...bestByRecord.values()]
      .sort((left, right) => right.score - left.score || left.recordUid.localeCompare(right.recordUid))
      .slice(0, Math.min(100, Math.max(1, Math.trunc(limit))))
  }

  async listRequirementIndexedRecords(): Promise<RecordDetail[]> {
    await this.initialize()
    await this.waitForIndexReady()
    await this.embeddings.prepare()
    if (!this.embeddings.available) throw new Error(this.embeddings.unavailableReason)
    const records = this.db.listKnowledgeIndexedRecordDetails(this.modelVersion)
    if (!records.length) {
      throw new Error(`数据中心记录向量索引不可用或尚未使用模型 ${this.modelVersion} 建立`)
    }
    return records
  }

  private async processDocument(
    document: KnowledgeDocument,
    taskId: string,
    current: number,
    total: number,
    onProgress?: (progress: KnowledgeIndexProgress) => void,
    task?: BackgroundTaskHandle
  ): Promise<KnowledgeDocument> {
    this.db.updateKnowledgeDocument(document.id, {
      status: 'processing',
      errorMessage: '',
      processedAt: ''
    })
    this.clearVectorCaches()
    this.db.clearKnowledgeDocumentChunks(document.id)
    try {
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'parsing',
        documentId: document.id,
        fileName: document.fileName,
        message: `正在解析 ${document.fileName}`,
        current,
        total,
        status: 'running'
      })
      const parsed = await this.parser.parse(document.filePath)
      const chunks = chunkKnowledgePages(parsed.pages)
      if (!chunks.length) throw new Error('解析结果没有可索引的正文分块')
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'embedding',
        documentId: document.id,
        fileName: document.fileName,
        message: `正在生成 ${chunks.length} 个本地向量分块`,
        current: 0,
        total: chunks.length,
        status: 'running'
      })
      const vectors: KnowledgeVectorInput[] = []
      const inputs: KnowledgeChunkInput[] = []
      for (let index = 0; index < chunks.length; index += 32) {
        await task?.checkpoint()
        const batch = chunks.slice(index, index + 32)
        const embeddings = await this.embeddings.embedMany(batch.map((chunk) => chunk.text))
        if (embeddings.length !== batch.length) throw new Error(this.embeddings.unavailableReason)
        for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
          const chunk = batch[batchIndex]
          const chunkId = randomUUID()
          inputs.push({
            id: chunkId,
            documentId: document.id,
            sourceType: 'document',
            sourceName: document.fileName,
            sourceHash: document.sha256,
            content: chunk.text,
            chunkIndex: chunk.chunkIndex,
            pageNumber: chunk.pageNumber,
            sheetName: chunk.sheetName,
            location: chunk.location,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd
          })
          vectors.push({ chunkId, vector: embeddings[batchIndex], modelVersion: this.modelVersion })
        }
        this.emitAndNotify(onProgress, {
          taskId,
          phase: 'embedding',
          documentId: document.id,
          fileName: document.fileName,
          message: `已生成 ${Math.min(index + batch.length, chunks.length)}/${chunks.length} 个向量`,
          current: Math.min(index + batch.length, chunks.length),
          total: chunks.length,
          status: 'running'
        })
      }
      this.db.replaceKnowledgeDocumentChunks(document.id, inputs, vectors)
      const updated = this.db.updateKnowledgeDocument(document.id, {
        status: 'ready',
        errorMessage: '',
        chunkCount: inputs.length,
        pageCount: parsed.pageCount,
        modelVersion: this.modelVersion,
        processedAt: new Date().toISOString()
      })
      const result = updated ?? document
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'done',
        documentId: document.id,
        fileName: document.fileName,
        message: `${document.fileName} 已完成解析和索引`,
        current,
        total,
        status: 'success'
      })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const interrupted = error instanceof TaskCancelledError
      const updated = this.db.updateKnowledgeDocument(document.id, {
        status: interrupted ? 'queued' : 'failed',
        errorMessage: interrupted ? '知识库任务已取消，文档保留在恢复队列' : message,
        processedAt: ''
      })
      this.emitAndNotify(onProgress, {
        taskId,
        phase: 'error',
        documentId: document.id,
        fileName: document.fileName,
        message: `${document.fileName}: ${interrupted ? '任务已取消，可在下次启动时自动恢复' : message}`,
        current,
        total,
        status: 'failed'
      })
      return updated ?? {
        ...document,
        status: interrupted ? 'queued' : 'failed',
        errorMessage: interrupted ? '知识库任务已取消，文档保留在恢复队列' : message
      }
    }
  }

  private async syncRecordIndexInternal(): Promise<void> {
    await this.embeddings.prepare()
    if (!this.embeddings.available) {
      this.emit({
        taskId: randomUUID(),
        phase: 'error',
        message: this.embeddings.unavailableReason,
        current: 0,
        total: 0,
        status: 'failed'
      })
      return
    }
    this.clearVectorCaches()
    const taskId = randomUUID()
    const task = this.taskRunner.begin(taskId)
    let current = 0
    let total = 0
    try {
      const rows = this.db.listKnowledgeRecordIndexRows()
      total = rows.length
      const known = new Set(rows.map((row) => row.uid))
      for (const uid of this.db.listKnowledgeIndexedRecordUids()) {
        await task.checkpoint()
        if (!known.has(uid)) this.db.deleteKnowledgeRecordIndex(uid)
      }
      if (!rows.length) return
      for (let index = 0; index < rows.length; index += 1) {
        await task.checkpoint()
        const row = rows[index]
        if (
          this.db.getKnowledgeRecordIndexHash(row.uid) === row.contentHash &&
          this.db.getKnowledgeRecordIndexModelVersion(row.uid) === this.modelVersion
        ) {
          this.db.markRecordMaintenanceVectorReady(
            row.uid,
            this.modelVersion,
            this.db.getKnowledgeRecordIndexChunkCount(row.uid, this.modelVersion)
          )
          continue
        }
        const pages: ParsedPage[] = [{
          // row.content is already restricted to business evidence. Keep
          // identity and audit metadata out of embedding input.
          text: row.content,
          location: '采集记录'
        }]
        const chunks = chunkKnowledgePages(pages)
        const embeddings = await this.embeddings.embedMany(chunks.map((chunk) => chunk.text))
        if (embeddings.length !== chunks.length) throw new Error(this.embeddings.unavailableReason)
        const inputs: KnowledgeChunkInput[] = []
        const vectors: KnowledgeVectorInput[] = []
        chunks.forEach((chunk, chunkIndex) => {
          const chunkId = randomUUID()
          inputs.push({
            id: chunkId,
            recordUid: row.uid,
            sourceType: 'record',
            sourceName: row.name,
            sourceHash: row.contentHash,
            content: chunk.text,
            chunkIndex,
            location: chunk.location,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd
          })
          vectors.push({ chunkId, vector: embeddings[chunkIndex], modelVersion: this.modelVersion })
        })
        this.db.replaceKnowledgeRecordChunks(row.uid, inputs, vectors)
        this.clearVectorCaches()
        this.emit({
          taskId,
          phase: 'records',
          message: `采集记录向量索引 ${index + 1}/${rows.length}`,
          current: index + 1,
          total: rows.length,
          status: 'running'
        })
        current = index + 1
      }
      this.emit({
        taskId,
        phase: 'done',
        message: '采集记录向量索引已同步',
        current: rows.length,
        total: rows.length,
        status: 'success'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({
        taskId,
        phase: 'error',
        message: `采集记录索引失败：${message}`,
        current,
        total,
        status: 'failed'
      })
      throw error
    } finally {
      task.dispose()
    }
  }

  private vectorNorm(vector: Float32Array): number {
    let norm = 0
    for (const value of vector) norm += value * value
    return norm > 0 ? Math.sqrt(norm) : 0
  }

  private cosine(
    left: Float32Array,
    right: Float32Array,
    rightNorm = this.vectorNorm(right),
    leftNorm = this.vectorNorm(left)
  ): number {
    const length = Math.min(left.length, right.length)
    let dot = 0
    for (let index = 0; index < length; index += 1) {
      dot += left[index] * right[index]
    }
    return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0
  }

  private emit(progress: KnowledgeIndexProgress): KnowledgeIndexProgress {
    const now = Date.now()
    const startedAt = this.taskStartedAt.get(progress.taskId) ?? now
    this.taskStartedAt.set(progress.taskId, startedAt)
    const elapsedMs = Math.max(0, now - startedAt)
    const completed = Math.max(0, Math.trunc(progress.current))
    const enriched: KnowledgeIndexProgress = {
      ...progress,
      elapsedMs,
      ...(completed > 0 && elapsedMs > 0
        ? { throughputPerSecond: Number((completed / (elapsedMs / 1000)).toFixed(2)) }
        : {})
    }
    this.db.saveKnowledgeIndexProgress(enriched)
    this.progress?.(enriched)
    if (progress.status !== 'running') this.taskStartedAt.delete(progress.taskId)
    return enriched
  }

  private emitAndNotify(
    onProgress: ((progress: KnowledgeIndexProgress) => void) | undefined,
    progress: KnowledgeIndexProgress
  ): void {
    const enriched = this.emit(progress)
    onProgress?.(enriched)
  }
}
