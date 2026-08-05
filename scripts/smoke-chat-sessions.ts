import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import type { ChatMessage } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-chat-sessions-'))
const db = new AppDatabase(join(root, 'chat.db'), join(root, 'assets'))

const message = (id: string, role: ChatMessage['role'], content: string): ChatMessage => ({
  id,
  role,
  content,
  createdAt: new Date().toISOString()
})

try {
  const sessionId = 'chat-session-upsert-smoke'
  const firstMessages = [
    message('user-1', 'user', 'First question'),
    message('assistant-1', 'assistant', 'First answer')
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

  console.log(JSON.stringify({ ok: true, historyRecords: sessions.length, messageCount: sessions[0]?.messageCount }))
} finally {
  db.close()
  rmSync(root, { recursive: true, force: true })
}
