import type { ModelChatInput, ModelResponse } from '../model-client'
import type { HybridRequirementCandidate } from './hybrid-retrieval'
import type { RequirementMatchCard } from './semantic-card'
import {
  REQUIREMENT_MATCH_RELATIONS,
  type RequirementMatchRelation
} from './requirement-match-scoring'

export const REQUIREMENT_MATCH_EXPLANATION_SCHEMA_VERSION = 'requirement-match-explanation-v1'

export interface RequirementMatchExplanationRequest {
  question?: string
  base: RequirementMatchCard
  candidates: HybridRequirementCandidate[]
}

export interface RequirementMatchExplanation {
  recordUid: string
  relation: RequirementMatchRelation
  similarities: string[]
  differences: string[]
  baseEvidence: string
  candidateEvidence: string
}

export interface RequirementMatchExplanationBatchResult {
  summary: string
  items: RequirementMatchExplanation[]
}

export interface RequirementMatchExplainerOptions {
  think?: boolean
  forceThinking?: boolean
  temperature?: number
  numPredict?: number
  numCtx?: number
  timeoutMs?: number
}

export type RequirementMatchExplanationProtocolErrorCode =
  | 'empty_body'
  | 'length'
  | 'non_json'
  | 'schema'
  | 'uid'
  | 'coverage'
  | 'evidence'
  | 'forbidden_decision'

export class RequirementMatchExplanationProtocolError extends Error {
  readonly code: RequirementMatchExplanationProtocolErrorCode
  readonly recordUid?: string

  constructor(
    code: RequirementMatchExplanationProtocolErrorCode,
    message: string,
    recordUid?: string
  ) {
    super(message)
    this.name = 'RequirementMatchExplanationProtocolError'
    this.code = code
    this.recordUid = recordUid
  }
}

export interface RequirementMatchExplanationModelClient {
  chat(input: ModelChatInput): Promise<ModelResponse>
}

export const REQUIREMENT_MATCH_EXPLANATION_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordUid', 'relation', 'similarities', 'differences', 'baseEvidence', 'candidateEvidence'],
        properties: {
          recordUid: { type: 'string', minLength: 1 },
          relation: { type: 'string', enum: [...REQUIREMENT_MATCH_RELATIONS] },
          similarities: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 }
          },
          differences: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', minLength: 1 }
          },
          baseEvidence: { type: 'string', minLength: 1 },
          candidateEvidence: { type: 'string', minLength: 1 }
        }
      }
    }
  }
}

const EXPLANATION_SYSTEM_PROMPT = [
  '你是需求匹配结果的解释器，只负责根据本次提供的原始需求证据生成可读解释。',
  '输出一个 summary，以及每个候选的 similarities（相似点数组）、differences（主要差异数组）、baseEvidence 和 candidateEvidence。',
  'relation 必须从 duplicate、highly_similar、partial_overlap、same_pattern、topic_only、unrelated 中选择；它只用于约束程序的确定性本地分数区间。不要输出、推断、修改或复核 score、finalScore 或任何百分比字段。',
  'similarities 和 differences 必须是面向用户的自然语言数组，每个数组至少包含一条内容，不得只写关系名称，也不得只写内部证据编号。',
  'baseEvidence 必须填写基准需求 evidenceSegments 中的一个 B 开头片段 ID，candidateEvidence 必须填写对应候选 evidenceSegments 中的一个 C 开头片段 ID。只输出片段 ID，不要改写证据。',
  '每个候选 UID 必须且只能输出一次，不得遗漏、重复、编造或改变 UID。',
  '只输出符合 JSON schema 的 JSON，不输出 Markdown、解释文字、思维过程或隐藏推理。'
].join('\n')

const CARD_FIELDS: readonly (keyof RequirementMatchCard)[] = [
  'requirementType',
  'productDomain',
  'module',
  'functionalObject',
  'action',
  'currentState',
  'targetState',
  'trigger',
  'input',
  'output',
  'behavior',
  'constraints',
  'acceptance',
  'businessScene'
]

export interface RequirementMatchEvidenceSegment {
  id: string
  text: string
}

// The explanation model only needs a bounded, auditable evidence window. The
// full source remains in the request objects and is used for final evidence
// validation; these limits keep ten candidates inside the model context.
const PROMPT_FIELD_MAX_CHARS = 96
const PROMPT_EVIDENCE_MAX_CHARS = 1_000
const PROMPT_EVIDENCE_SEGMENT_LIMIT = 5

const promptText = (value: string, maxLength: number): string => {
  const normalized = value.trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized
}

const trimString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const normalizedEvidence = (value: string): string => value
  .toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '')

const addEvidenceSegment = (
  segments: string[],
  seen: Set<string>,
  value: string
): void => {
  const text = value.trim()
  if (text.length < 2 || seen.has(text)) return
  seen.add(text)
  segments.push(text)
}

export const requirementMatchEvidenceSegments = (
  source: string,
  prefix: 'B' | 'C',
  limit = 80
): RequirementMatchEvidenceSegment[] => {
  const segments: string[] = []
  const seen = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const normalizedLine = line.trim()
    if (!normalizedLine) continue
    if (normalizedLine.length <= 280) addEvidenceSegment(segments, seen, normalizedLine)
    for (const sentence of normalizedLine.split(/(?<=[。！？；;])/u)) {
      const normalizedSentence = sentence.trim()
      if (!normalizedSentence) continue
      if (normalizedSentence.length <= 280) {
        addEvidenceSegment(segments, seen, normalizedSentence)
        continue
      }
      for (let offset = 0; offset < normalizedSentence.length; offset += 220) {
        addEvidenceSegment(segments, seen, normalizedSentence.slice(offset, offset + 220))
      }
    }
    if (segments.length >= Math.max(1, Math.min(80, Math.trunc(limit)))) break
  }
  return segments.slice(0, Math.max(1, Math.min(80, Math.trunc(limit)))).map((text, index) => ({
    id: `${prefix}${String(index + 1).padStart(3, '0')}`,
    text
  }))
}

const cardPayload = (card: RequirementMatchCard, prefix: 'B' | 'C'): Record<string, unknown> => {
  const fields = Object.fromEntries(CARD_FIELDS.map((field) => [
    field,
    typeof card[field] === 'string' ? promptText(card[field], PROMPT_FIELD_MAX_CHARS) : card[field]
  ]))
  return {
    semanticCardStatus: card.analysisStatus,
    ...fields,
    evidence: promptText(card.evidence, PROMPT_EVIDENCE_MAX_CHARS),
    evidenceSegments: requirementMatchEvidenceSegments(
      card.evidence,
      prefix,
      PROMPT_EVIDENCE_SEGMENT_LIMIT
    )
  }
}

const candidatePayload = (candidate: HybridRequirementCandidate): Record<string, unknown> => ({
  recordUid: candidate.record.uid,
  ...cardPayload(candidate.card, 'C')
})

export interface RequirementMatchExplanationPrompt {
  system: string
  user: string
}

export const buildRequirementMatchExplanationPrompt = (
  request: RequirementMatchExplanationRequest
): RequirementMatchExplanationPrompt => {
  const payload = {
    schemaVersion: REQUIREMENT_MATCH_EXPLANATION_SCHEMA_VERSION,
    ...(request.question?.trim() ? { question: request.question.trim() } : {}),
    requirement: cardPayload(request.base, 'B'),
    candidates: request.candidates.map(candidatePayload)
  }
  return {
    system: EXPLANATION_SYSTEM_PROMPT,
    user: JSON.stringify(payload)
  }
}

export const buildRequirementMatchExplanationMessages = (
  request: RequirementMatchExplanationRequest
): ModelChatInput['messages'] => {
  const prompt = buildRequirementMatchExplanationPrompt(request)
  return [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user }
  ]
}

export const buildRequirementMatchExplanationInput = (
  request: RequirementMatchExplanationRequest,
  options: RequirementMatchExplainerOptions = {}
): ModelChatInput => ({
  messages: buildRequirementMatchExplanationMessages(request),
  format: REQUIREMENT_MATCH_EXPLANATION_RESPONSE_SCHEMA,
  think: options.think ?? true,
  forceThinking: options.forceThinking ?? true,
  temperature: options.temperature ?? 0,
  numPredict: options.numPredict ?? Math.max(1024, request.candidates.length * 180),
  ...(options.numCtx === undefined ? {} : { numCtx: options.numCtx }),
  ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
})

const responseContentOf = (response: ModelResponse | string): { content: string; doneReason?: string } => {
  if (typeof response === 'string') return { content: response }
  return {
    content: typeof response.message?.content === 'string' ? response.message.content : '',
    doneReason: response.done_reason
  }
}

const stripThinkingAndCodeFence = (content: string): string => {
  const withoutThinking = content.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  const fenced = withoutThinking.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fenced?.[1] ?? withoutThinking).trim()
}

const protocolError = (
  code: RequirementMatchExplanationProtocolErrorCode,
  message: string,
  recordUid?: string
): RequirementMatchExplanationProtocolError => (
  new RequirementMatchExplanationProtocolError(code, message, recordUid)
)

const assertOnlyKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  recordUid?: string
): void => {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key))
  if (unexpected.length) {
    const decisionKey = unexpected.find((key) => (
      key === 'score' || key === 'finalScore'
    ))
    if (decisionKey) throw protocolError('forbidden_decision', `解释结果不得包含 ${decisionKey}`, recordUid)
    throw protocolError('schema', `解释结果包含未声明字段：${unexpected.join('、')}`, recordUid)
  }
}

const resolveEvidenceReference = (
  reference: string,
  source: string,
  prefix: 'B' | 'C'
): string | null => {
  const segment = requirementMatchEvidenceSegments(source, prefix).find((item) => item.id === reference)
  return segment?.text ?? null
}

const isEvidenceIdOnly = (value: string): boolean => (
  /^(?:[BC]\d{3}\s*[,，/;；]?\s*)+$/i.test(value)
)

const parseJsonContent = (content: string): unknown => {
  const cleaned = stripThinkingAndCodeFence(content)
  if (!cleaned) throw protocolError('empty_body', '模型未返回解释正文')
  try {
    return JSON.parse(cleaned) as unknown
  } catch {
    throw protocolError('non_json', '模型解释结果不是有效 JSON')
  }
}

const expectedCandidatesOf = (
  request: RequirementMatchExplanationRequest
): Map<string, HybridRequirementCandidate> => {
  const expected = new Map<string, HybridRequirementCandidate>()
  for (const candidate of request.candidates) {
    const uid = trimString(candidate.record.uid)
    if (!uid || uid !== candidate.record.uid || expected.has(uid)) {
      throw protocolError('uid', `候选输入包含无效或重复 UID：${uid || '空'}`)
    }
    expected.set(uid, candidate)
  }
  return expected
}

export const parseRequirementMatchExplanationResponse = (
  response: ModelResponse | string,
  request: RequirementMatchExplanationRequest
): RequirementMatchExplanationBatchResult => {
  const { content, doneReason } = responseContentOf(response)
  if (doneReason === 'length') throw protocolError('length', '模型解释输出达到 Token 上限')
  if (!content.trim()) throw protocolError('empty_body', '模型未返回解释正文')

  const expected = expectedCandidatesOf(request)
  const parsed = parseJsonContent(content)
  if (!isRecord(parsed)) throw protocolError('schema', '解释结果必须是 JSON 对象')
  assertOnlyKeys(parsed, ['summary', 'items'])
  const summary = trimString(parsed.summary)
  if (!summary) throw protocolError('schema', '解释结果缺少 summary')
  if (!Array.isArray(parsed.items)) throw protocolError('schema', '解释结果缺少 items 数组')
  if (parsed.items.length !== expected.size) {
    throw protocolError('coverage', `解释结果未覆盖全部候选 UID：期望 ${expected.size} 条，实际 ${parsed.items.length} 条`)
  }

  const seen = new Set<string>()
  const items: RequirementMatchExplanation[] = []
  for (const rawItem of parsed.items) {
    if (!isRecord(rawItem)) throw protocolError('schema', '候选解释必须是对象')
    const uidValue = rawItem.recordUid
    const recordUid = trimString(uidValue)
    if (typeof uidValue !== 'string' || !recordUid || recordUid !== uidValue) {
      throw protocolError('uid', '候选解释包含无效 UID')
    }
    if (!expected.has(recordUid)) throw protocolError('uid', `解释结果包含未知 UID：${recordUid}`, recordUid)
    if (seen.has(recordUid)) throw protocolError('uid', `解释结果包含重复 UID：${recordUid}`, recordUid)
    assertOnlyKeys(rawItem, [
      'recordUid', 'relation', 'similarities', 'differences', 'baseEvidence', 'candidateEvidence'
    ], recordUid)

    const relationValue = trimString(rawItem.relation)
    if (!REQUIREMENT_MATCH_RELATIONS.includes(relationValue as RequirementMatchRelation)) {
      throw protocolError('schema', `UID ${recordUid} 的 relation 无效`, recordUid)
    }

    const readNaturalLanguageList = (value: unknown, field: string): string[] => {
      if (!Array.isArray(value) || !value.length) {
        throw protocolError('schema', `UID ${recordUid} 缺少 ${field} 数组`, recordUid)
      }
      const values = value.map((item) => trimString(item))
      if (values.some((item) => !item || isEvidenceIdOnly(item))) {
        throw protocolError('schema', `UID ${recordUid} 的 ${field} 必须是自然语言数组`, recordUid)
      }
      return values
    }
    const similarities = readNaturalLanguageList(rawItem.similarities, 'similarities')
    const differences = readNaturalLanguageList(rawItem.differences, 'differences')
    const baseReference = trimString(rawItem.baseEvidence)
    const candidateReference = trimString(rawItem.candidateEvidence)
    if (!baseReference || !candidateReference) {
      throw protocolError('schema', `UID ${recordUid} 缺少原文证据`, recordUid)
    }

    const candidate = expected.get(recordUid)
    if (!candidate) throw protocolError('uid', `解释结果包含未知 UID：${recordUid}`, recordUid)
    const baseEvidence = resolveEvidenceReference(baseReference, request.base.evidence, 'B')
    const candidateEvidence = resolveEvidenceReference(candidateReference, candidate.card.evidence, 'C')
    if (!baseEvidence) throw protocolError('evidence', `UID ${recordUid} 的基准证据不在原文中`, recordUid)
    if (!candidateEvidence) throw protocolError('evidence', `UID ${recordUid} 的候选证据不在原文中`, recordUid)

    seen.add(recordUid)
    items.push({
      recordUid,
      relation: relationValue as RequirementMatchRelation,
      similarities,
      differences,
      baseEvidence,
      candidateEvidence
    })
  }
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].filter((uid) => !seen.has(uid))
    throw protocolError('coverage', `解释结果遗漏候选 UID：${missing.join('、')}`)
  }
  return { summary, items }
}

export type RequirementMatchExplanationParseResult =
  | { ok: true; result: RequirementMatchExplanationBatchResult }
  | { ok: false; error: RequirementMatchExplanationProtocolError }

export const tryParseRequirementMatchExplanationResponse = (
  response: ModelResponse | string,
  request: RequirementMatchExplanationRequest
): RequirementMatchExplanationParseResult => {
  try {
    return { ok: true, result: parseRequirementMatchExplanationResponse(response, request) }
  } catch (error) {
    if (error instanceof RequirementMatchExplanationProtocolError) return { ok: false, error }
    return {
      ok: false,
      error: protocolError('schema', error instanceof Error ? error.message : String(error))
    }
  }
}

export const classifyRequirementMatchExplanationProtocolError = (
  value: unknown
): RequirementMatchExplanationProtocolErrorCode | null => {
  if (value instanceof RequirementMatchExplanationProtocolError) return value.code
  if (isRecord(value) && value.done_reason === 'length') return 'length'
  if (typeof value === 'string') {
    if (!value.trim()) return 'empty_body'
    const cleaned = stripThinkingAndCodeFence(value)
    if (!cleaned) return 'empty_body'
    try {
      JSON.parse(cleaned)
      return null
    } catch {
      return 'non_json'
    }
  }
  if (isRecord(value) && isRecord(value.message)) {
    const content = typeof value.message.content === 'string' ? value.message.content : ''
    if (value.done_reason === 'length') return 'length'
    if (!content.trim()) return 'empty_body'
    const cleaned = stripThinkingAndCodeFence(content)
    if (!cleaned) return 'empty_body'
    try {
      JSON.parse(cleaned)
      return null
    } catch {
      return 'non_json'
    }
  }
  if (isRecord(value)) return 'empty_body'
  return null
}

export const isRequirementMatchExplanationProtocolError = (
  value: unknown
): value is RequirementMatchExplanationProtocolError => (
  value instanceof RequirementMatchExplanationProtocolError
)

export const isRequirementMatchProtocolError = isRequirementMatchExplanationProtocolError

/** Perform exactly one batch model call; no response or request cache is kept. */
export const explainRequirementMatches = async (
  client: RequirementMatchExplanationModelClient,
  request: RequirementMatchExplanationRequest,
  options: RequirementMatchExplainerOptions = {}
): Promise<RequirementMatchExplanationBatchResult> => {
  if (!request.candidates.length) return { summary: '没有候选需求需要解释。', items: [] }
  const response = await client.chat(buildRequirementMatchExplanationInput(request, options))
  return parseRequirementMatchExplanationResponse(response, request)
}
