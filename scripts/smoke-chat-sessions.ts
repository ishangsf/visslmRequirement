import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import {
  restoreLegacyAssistantMarkdown,
  sanitizeChatMessageContent,
  stripRedundantAssistantCitationSections
} from '../src/shared/chat-message-format'
import type { ChatContextRef, ChatMessage } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-chat-sessions-'))
const db = new AppDatabase(join(root, 'chat.db'), join(root, 'assets'))

const message = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: new Date().toISOString()
})

const contextRefs: ChatContextRef[] = [
  { kind: 'record', id: 'uid-1', itemId: 'REQ-1', label: '记录一' },
  { kind: 'dataView', id: 'view-1', label: '查询结果', total: 120, fields: ['Status'] }
]

const largeDataView = {
  id: 'view-large',
  title: '大数据视图',
  description: 'x'.repeat(3_000),
  total: 10_000,
  fields: ['HugeField'],
  groups: [{
    name: '全部',
    count: 10_000,
    rows: Array.from({ length: 300 }, (_value, index) => ({
      uid: `uid-${index}`,
      name: `记录 ${index}`,
      nodeType: 'Requirement',
      itemId: `REQ-${index}`,
      values: { HugeField: 'y'.repeat(2_000) }
    }))
  }]
}

try {
  const sessionId = 'chat-session-upsert-smoke'
  const firstMessages = [
    message('user-1', 'user', 'First question'),
    { ...message('assistant-1', 'assistant', 'First answer'), contextRefs, dataViews: [largeDataView] }
  ]
  const secondMessages = [
    ...firstMessages,
    message('user-2', 'user', 'Second question'),
    message('assistant-2', 'assistant', 'Second answer')
  ]

  const formattedAnswer = [
    '查询结果',
    '',
    '### 姚稳（2 条）',
    '',
    '1. 第一条需求',
    '2. 第二条需求'
  ].join('\n')
  assert.equal(
    sanitizeChatMessageContent(formattedAnswer),
    formattedAnswer,
    'chat persistence must preserve Markdown line breaks'
  )
  assert.equal(
    restoreLegacyAssistantMarkdown('查询结果 ### 姚稳（2 条） 1. 第一条需求 2. 第二条需求 3. 第三条需求'),
    '查询结果\n\n### 姚稳（2 条）\n1. 第一条需求\n2. 第二条需求\n3. 第三条需求',
    'legacy flattened answers must recover heading and list boundaries'
  )
  const duplicatedCitationAnswer = [
    '这是有证据支持的正文结论。',
    '',
    '> 来源：',
    '> [规范文档 · 第 3 页](#knowledge-document=doc-1&chunk=chunk-1)',
    '',
    '依据：[规范文档 · 第 3 页](#knowledge-document=doc-1&chunk=chunk-1)'
  ].join('\n')
  assert.equal(
    stripRedundantAssistantCitationSections(duplicatedCitationAnswer, true),
    '这是有证据支持的正文结论。',
    'structured sources must replace repeated standalone 来源/依据 Markdown sections'
  )
  const genericNumberedCitationAnswer = [
    '这是另一条有证据支持的正文结论。',
    '',
    '> 来源：',
    '> `',
    '> 1. [平台技术方案.docx · 正文](https://example.invalid/source-1)',
    '> `',
    '> [2] [平台技术方案.docx · 历史记录](https://example.invalid/source-2)'
  ].join('\n')
  assert.equal(
    stripRedundantAssistantCitationSections(genericNumberedCitationAnswer, true),
    '这是另一条有证据支持的正文结论。',
    'structured sources must replace trailing generic Markdown citation lists and their list scaffolding'
  )
  assert.equal(
    stripRedundantAssistantCitationSections('结论依据：标准第 3 条。', true),
    '结论依据：标准第 3 条。',
    'ordinary prose containing 依据 must remain visible'
  )
  const citationBeforeMoreProse = [
    '第一段结论。',
    '来源：[规范文档](#knowledge-document=doc-1&chunk=chunk-1)',
    '后续仍有业务分析。'
  ].join('\n')
  assert.equal(
    stripRedundantAssistantCitationSections(citationBeforeMoreProse, true),
    citationBeforeMoreProse,
    'a citation section must not hide business prose that follows it'
  )

  db.saveChatSession({ id: sessionId, title: 'First question', messages: firstMessages })
  assert.equal(db.listChatSessions().length, 1)
  assert.equal(db.listChatSessions()[0]?.messageCount, 2)

  db.saveChatSession({ id: sessionId, title: 'First question', messages: secondMessages })
  const sessions = db.listChatSessions()
  assert.equal(sessions.length, 1, 'one conversation must remain one history record')
  assert.equal(sessions[0]?.id, sessionId)
  assert.equal(sessions[0]?.messageCount, 4)
  assert.equal(db.getChatSession(sessionId)?.messages.length, 4)
  assert.deepEqual(db.getChatSession(sessionId)?.messages[1]?.contextRefs, contextRefs)
  const persistedView = db.getChatSession(sessionId)?.messages[1]?.dataViews?.[0]
  assert.ok(persistedView)
  assert.ok((persistedView.description?.length ?? 0) <= 1_000)
  assert.ok((persistedView.groups[0]?.rows.length ?? 0) <= 100)
  assert.ok(String(persistedView.groups[0]?.rows[0]?.values.HugeField ?? '').length <= 512)

  const markdownSessionId = 'chat-session-markdown-smoke'
  db.saveChatSession({
    id: markdownSessionId,
    title: 'Markdown answer',
    messages: [
      message('markdown-user', 'user', 'List requirements'),
      message('markdown-assistant', 'assistant', formattedAnswer)
    ]
  })
  assert.equal(
    db.getChatSession(markdownSessionId)?.messages[1]?.content,
    formattedAnswer,
    'database round-trip must preserve Markdown structure'
  )

  console.log(JSON.stringify({
    ok: true,
    historyRecords: sessions.length,
    messageCount: sessions[0]?.messageCount,
    markdownRoundTrip: true,
    legacyMarkdownRecovery: true
  }))
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
