import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
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

  console.log(JSON.stringify({ ok: true, historyRecords: sessions.length, messageCount: sessions[0]?.messageCount }))
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
