import { createHash, randomUUID } from 'node:crypto'
import type {
  AssistantArtifactInput,
  AssistantArtifactPreview
} from '../../shared/types'

const MAX_TITLE = 120
const MAX_ANSWER = 20_000

const normalizeInput = (input: AssistantArtifactInput): AssistantArtifactInput => {
  const title = input.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TITLE)
  const question = input.question.trim().slice(0, 2_000)
  const answer = input.answer.trim().slice(0, MAX_ANSWER)
  if (!title || !question || !answer) throw new Error('交付物标题、问题和已验证回答不能为空')
  if (!['analysis_snapshot', 'saved_filter', 'report_draft', 'delivery_draft'].includes(input.type)) {
    throw new Error('不支持的交付物类型')
  }
  if (!input.conversationId.trim() || !input.messageId.trim()) throw new Error('交付物必须关联真实会话消息')
  if (!input.evidenceBlocks.length) throw new Error('没有 EvidenceBlock，禁止创建确定性交付物')
  return {
    ...input,
    conversationId: input.conversationId.trim(),
    messageId: input.messageId.trim(),
    title,
    question,
    answer,
    evidenceBlocks: structuredClone(input.evidenceBlocks),
    dataViews: structuredClone(input.dataViews),
    ...(input.sources ? { sources: structuredClone(input.sources) } : {}),
    ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    ...(input.instructions ? { instructions: input.instructions.trim().slice(0, 8_000) } : {})
  }
}

const payloadHashOf = (input: AssistantArtifactInput): string => createHash('sha256')
  .update(JSON.stringify(input))
  .digest('hex')

export const createAssistantArtifactPreview = (
  rawInput: AssistantArtifactInput
): AssistantArtifactPreview => {
  const input = normalizeInput(rawInput)
  const recordEvidenceCount = input.evidenceBlocks
    .filter((block) => block.kind === 'record')
    .reduce((sum, block) => sum + block.count, 0)
  const documentEvidenceCount = input.evidenceBlocks
    .filter((block) => block.kind === 'document')
    .reduce((sum, block) => sum + block.count, 0)
  const queryMatchedCount = input.evidenceBlocks
    .filter((block) => block.kind === 'aggregate' || block.kind === 'query_detail')
    .reduce((sum, block) => sum + (block.matchedCount ?? block.count), 0)
  return {
    previewId: randomUUID(),
    type: input.type,
    title: input.title,
    contentPreview: input.type === 'saved_filter'
      ? `保存本轮字段、筛选、分组和数据范围：${input.executionSummary?.question ?? input.question}`
      : input.answer.slice(0, 600),
    impact: {
      recordEvidenceCount,
      documentEvidenceCount,
      queryMatchedCount,
      sourceWriteCount: 0
    },
    rollbackPoint: '仅新增本地交付物版本，不修改数据中心或知识库；保存后可在交付物记录中撤销。',
    input,
    payloadHash: payloadHashOf(input)
  }
}

export const verifyAssistantArtifactPreview = (
  preview: AssistantArtifactPreview
): AssistantArtifactInput => {
  const input = normalizeInput(preview.input)
  if (preview.payloadHash !== payloadHashOf(input)) throw new Error('交付物预览已变化，请重新预览后确认')
  return input
}
