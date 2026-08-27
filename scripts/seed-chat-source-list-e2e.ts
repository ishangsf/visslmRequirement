import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import type { ChatMessage } from '../src/shared/types'

const userData = process.env.VISSLM_E2E_USER_DATA?.trim()
if (!userData) throw new Error('VISSLM_E2E_USER_DATA is required')

mkdirSync(userData, { recursive: true })
const database = new AppDatabase(join(userData, 'visslm-agent.db'), join(userData, 'assets'))
const createdAt = new Date().toISOString()
const messages: ChatMessage[] = [
  {
    id: 'source-list-e2e-user',
    role: 'user',
    content: 'GJB5000B 总体架构及基本概念是什么？',
    createdAt
  },
  {
    id: 'source-list-e2e-assistant',
    role: 'assistant',
    content: [
      'GJB5000B 采用分级成熟度模型，用于评价组织的软件研制能力。',
      '',
      '- 模型至少包含二级、三级和四级。',
      '- 四级强调量化分析、过程绩效和目标管理。',
      '',
      '> 来源：',
      '> [GJB5000B实施指南.pdf · 第 3 页](#knowledge-document=doc-e2e&chunk=chunk-e2e)',
      '',
      '依据：[GJB5000B实施指南.pdf · 第 3 页](#knowledge-document=doc-e2e&chunk=chunk-e2e)'
    ].join('\n'),
    createdAt,
    sources: [{
      uid: 'document:doc-e2e',
      name: 'GJB5000B实施指南.pdf',
      nodeType: 'KnowledgeDocument',
      itemId: 'doc-e2e',
      sourceType: 'document',
      documentId: 'doc-e2e',
      chunkId: 'chunk-e2e',
      fileName: 'GJB5000B实施指南.pdf',
      pageNumber: 3,
      location: '文档正文',
      snippet: 'GJB5000B采用分级成熟度模型，用于评价组织的软件研制能力。'
    }]
  }
]

try {
  database.saveChatSession({
    id: 'source-list-e2e-session',
    title: '回答依据折叠验收',
    messages
  })
  console.log(JSON.stringify({ ok: true, userData, sessionId: 'source-list-e2e-session' }))
} finally {
  database.close()
}
