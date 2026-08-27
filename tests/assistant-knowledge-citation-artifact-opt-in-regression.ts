import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { AssistantIntentRouter, resolveAssistantIntent } from '../src/main/assistant/intent-router'
import { OllamaAgent } from '../src/main/ollama'
import type { AssistantIntentModelClient } from '../src/main/assistant/intent-router'
import type {
  AssistantArtifactInput,
  ChatSource,
  ModelSettings
} from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'

const checks: string[] = []

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-knowledge-citation-artifact-opt-in-regression-model',
  thinking: false,
  apiKey: 'assistant-knowledge-citation-artifact-opt-in-regression-key'
}

const answerResponse = (content: string): ModelResponse => ({
  message: { role: 'assistant', content }
})

const verifiedDocumentSource: ChatSource = {
  // This is intentionally opaque. It must never leak into the user-facing answer.
  uid: 'document:opaque-source-uid-should-not-leak',
  name: '知识库实施指南',
  nodeType: 'knowledge_document',
  itemId: 'opaque-source-item',
  sourceType: 'document',
  documentId: 'doc-42',
  chunkId: 'chunk-7',
  fileName: '知识库实施指南.pdf',
  location: '第 7 页 · 发布流程',
  pageNumber: 7,
  snippet: '发布流程必须先完成审批与回滚点确认。'
}

const artifactSource: AssistantArtifactInput = {
  type: 'delivery_draft',
  conversationId: 'conversation-artifact-opt-in',
  messageId: 'message-evidence-1',
  title: '已验证回答交付草稿',
  question: '请整理已验证结论',
  answer: '已验证结论：发布流程必须先完成审批。',
  evidenceBlocks: [{
    id: 'evidence:document-1',
    kind: 'document',
    title: '知识库实施指南',
    summary: '发布流程证据',
    count: 1,
    sourceIndexes: [0]
  }],
  dataViews: [],
  sources: [verifiedDocumentSource],
  outputFormat: 'docx'
}

const modelArtifactSpoof = JSON.stringify({
  taskType: 'artifact_generation',
  skillId: 'artifact',
  sourceMode: 'mixed',
  resolvedQuestion: '请把已验证回答导出为报告',
  resultMode: 'artifact',
  groupEntities: [],
  needsClarification: false,
  reason: 'untrusted model fixture'
})

const fakeArtifactClassifier = (calls: ModelChatInput[]): AssistantIntentModelClient => ({
  chat: async (input: ModelChatInput): Promise<ModelResponse> => {
    calls.push(input)
    return answerResponse(modelArtifactSpoof)
  }
})

const sourceLinkFrom = (answer: string): RegExpMatchArray | undefined => (
  [...answer.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)]
    .find((match) => match[1]?.includes(verifiedDocumentSource.name) && match[1]?.includes('第 7 页'))
)

const testKnowledgeCitationConversion = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-knowledge-citation-opt-in-'))
  const db = new AppDatabase(join(directory, 'citation.db'), join(directory, 'assets'))
  try {
    const agent = new OllamaAgent(db, settings)
    const privateAgent = agent as unknown as Record<string, unknown>
    const converter = privateAgent.ensureVerifiableCitations
    assert.equal(typeof converter, 'function', 'OllamaAgent must expose its final-answer citation boundary')

    const answer = [
      '发布流程需要先完成审批。',
      `[UID:${verifiedDocumentSource.uid}]`,
      '[UID:unknown-document-uid-should-be-removed]'
    ].join(' ')
    const converted = (converter as (content: string, sources: ChatSource[]) => string).call(
      agent,
      answer,
      [verifiedDocumentSource]
    )

    assert.doesNotMatch(converted, /opaque-source-uid-should-not-leak/)
    assert.doesNotMatch(converted, /unknown-document-uid-should-be-removed/)
    assert.doesNotMatch(converted, /\[UID:[^\]]+\]/)
    const citationLink = sourceLinkFrom(converted)
    assert.ok(citationLink, 'knowledge answers must contain a Markdown source fragment')
    assert.match(citationLink[1] ?? '', /知识库实施指南/)
    assert.match(citationLink[1] ?? '', /第 7 页/)
    assert.match(`${citationLink[1]} ${citationLink[2]}`, /doc-42/)
    assert.match(`${citationLink[1]} ${citationLink[2]}`, /chunk-7/)

    const convertedAgain = (converter as (content: string, sources: ChatSource[]) => string).call(
      agent,
      converted,
      [verifiedDocumentSource]
    )
    assert.equal(convertedAgain, converted, 'citation conversion must be idempotent')
    assert.equal((converted.match(/知识库实施指南/g) ?? []).length, 1)
    checks.push('final knowledge answers hide opaque UIDs and expose one document/location Markdown citation with documentId/chunkId')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const testArtifactRoutingOptIn = async (): Promise<void> => {
  const automaticCalls: ModelChatInput[] = []
  const automatic = await resolveAssistantIntent({
    question: '请总结这份已完成回答',
    chatMode: 'auto',
    entrypoint: 'chat',
    artifactSource
  }, settings, fakeArtifactClassifier(automaticCalls))
  assert.ok(automaticCalls.length > 0, 'automatic routing fixture must exercise the model decision path')
  assert.doesNotMatch(
    JSON.stringify(automaticCalls[0]?.format ?? {}),
    /artifact_generation|"artifact"/u,
    'Auto classifier schema must not spend output space on artifact-only routes'
  )
  assert.notEqual(automatic.taskType, 'artifact_generation', 'a model-only artifact decision must not open delivery routing')
  assert.notEqual(automatic.skillId, 'artifact', 'a model-only artifact decision must not select the artifact agent')
  assert.notEqual(automatic.resultMode, 'artifact', 'a model-only artifact decision must not select artifact result mode')

  const explicitCalls: ModelChatInput[] = []
  const explicit = await resolveAssistantIntent({
    question: '@交付物专家 请导出为 DOCX',
    chatMode: 'expert',
    entrypoint: 'chat',
    artifactSource
  }, settings, fakeArtifactClassifier(explicitCalls))
  assert.equal(explicitCalls.length, 0, 'an explicit artifact mention should not be delegated to model classification')
  assert.equal(explicit.taskType, 'artifact_generation')
  assert.equal(explicit.skillId, 'artifact')
  assert.equal(explicit.resultMode, 'artifact')
  assert.equal(explicit.needsClarification, false)

  const noEvidence = await resolveAssistantIntent({
    question: '@交付物专家 请导出为 DOCX',
    chatMode: 'expert',
    entrypoint: 'chat',
    artifactSource: { ...artifactSource, evidenceBlocks: [], sources: [] }
  }, settings, fakeArtifactClassifier([]))
  assert.equal(noEvidence.taskType, 'artifact_generation')
  assert.equal(noEvidence.resultMode, 'artifact')
  assert.equal(noEvidence.needsClarification, true)
  checks.push('automatic model output cannot opt into artifacts; explicit @交付物专家 remains available and evidence-free requests clarify')
}

const testFinalMentionBoundaries = async (): Promise<void> => {
  const router = new AssistantIntentRouter(settings, {
    chat: async (): Promise<ModelResponse> => answerResponse(JSON.stringify({
      taskType: 'conversation',
      skillId: 'general',
      sourceMode: 'conversation',
      resolvedQuestion: '普通问题',
      resultMode: 'answer',
      groupEntities: [],
      needsClarification: false,
      reason: 'boundary fixture'
    }))
  })
  const nearMiss = await router.resolve({
    question: '@交付物专家后缀 请回答',
    chatMode: 'auto',
    entrypoint: 'chat'
  })
  assert.notEqual(nearMiss.taskType, 'artifact_generation')
  assert.notEqual(nearMiss.skillId, 'artifact')
  checks.push('artifact specialist matching keeps a trailing-token boundary')
}

const testUiAndMainOptInContracts = async (): Promise<void> => {
  const [mainSource, rendererSource, knowledgePreviewerSource] = await Promise.all([
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/knowledge/KnowledgeDocumentPreviewer.tsx', import.meta.url), 'utf8')
  ])

  // The final main-process trust boundary must recognize the exact mention,
  // independent of what an automatic classifier returns.
  assert.match(mainSource, /@交付物专家[^\r\n]{0,120}(?:\\s|\[\\s|\$)/)
  const artifactBranchOffset = mainSource.indexOf("if (assistantIntent?.taskType === 'artifact_generation'")
  assert.ok(artifactBranchOffset >= 0, 'main process must keep an explicit artifact handling boundary')
  // The guard may be placed immediately before the artifact branch so the
  // selected trace and route are cleared before the safe clarification.
  const artifactBranch = mainSource.slice(Math.max(0, artifactBranchOffset - 6_000), artifactBranchOffset + 2_000)
  assert.match(
    artifactBranch,
    /(?:explicit|mention|requested|requestsArtifact|artifactMention|交付物专家)/i,
    'the final artifact branch must be gated by an explicit user mention'
  )

  // A proactive action area is allowed only when its render condition carries
  // an explicit-artifact/request gate. Removing the block entirely is also a
  // valid implementation as long as the explicit entrypoint remains wired.
  const actionOffset = rendererSource.indexOf('className="chat-artifact-actions"')
  if (actionOffset >= 0) {
    const conditionWindow = rendererSource.slice(Math.max(0, actionOffset - 500), actionOffset)
    assert.doesNotMatch(
      conditionWindow,
      /message\.role === 'assistant' && message\.contextOutcome === 'success' && message\.evidenceBlocks\?\.length \?/,
      'artifact actions must not render for every successful evidence answer'
    )
    assert.match(
      conditionWindow,
      /(?:explicit|mention|requested|request|artifact|delivery|export|expert)/i,
      'artifact action rendering must include an explicit/request gate'
    )
  }
  assert.match(rendererSource, /@交付物专家[^\r\n]{0,120}(?:\\s|\[\\s|\$)/)
  assert.match(rendererSource, /response\.artifactPreview/)
  assert.match(rendererSource, /params\.get\('knowledge-document'\)/)
  assert.match(rendererSource, /params\.get\('chunk'\)/)
  assert.match(rendererSource, /openKnowledgeDetail\(citation\.documentId, citation\.chunkId\)/)
  assert.match(rendererSource, /targetChunkId=\{activeKnowledgeChunkId\}/)
  assert.match(knowledgePreviewerSource, /document\.chunks\.find\(\(chunk\) => chunk\.id === targetChunkId\)/)
  assert.match(knowledgePreviewerSource, /is-target/)
  checks.push(actionOffset >= 0
    ? 'renderer proactive artifact actions are mention-gated while explicit artifact preview remains wired'
    : 'renderer has no proactive artifact action area and retains the explicit artifact preview entrypoint')
}

await testKnowledgeCitationConversion()
await testArtifactRoutingOptIn()
await testFinalMentionBoundaries()
await testUiAndMainOptInContracts()

console.log(JSON.stringify({ ok: true, checks }, null, 2))
