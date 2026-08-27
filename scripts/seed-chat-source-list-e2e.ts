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
    content: '设备接口协议的总体要求是什么？',
    createdAt
  },
  {
    id: 'source-list-e2e-assistant',
    role: 'assistant',
    content: [
      '设备接口协议用于描述系统边界、交互约束和异常处理规则。',
      '',
      '- 接口定义、状态转换和时序约束应保持一致。',
      '- 异常处理需要明确重试、恢复和告警边界。'
    ].join('\n'),
    createdAt,
    sources: [{
      uid: 'document:doc-e2e-primary',
      name: '设备接口规范.pdf',
      nodeType: 'knowledge_document',
      itemId: 'doc-e2e-primary',
      sourceType: 'document',
      documentId: 'doc-e2e-primary',
      chunkId: 'chunk-e2e-primary-19',
      fileName: '设备接口规范.pdf',
      pageNumber: 19,
      location: '第 19 页',
      snippet: '设备接口协议描述系统边界和接口定义。'
    }, {
      uid: 'document:doc-e2e-primary',
      name: '设备接口规范.pdf',
      nodeType: 'knowledge_document',
      itemId: 'doc-e2e-primary',
      sourceType: 'document',
      documentId: 'doc-e2e-primary',
      chunkId: 'chunk-e2e-primary-20',
      fileName: '设备接口规范.pdf',
      pageNumber: 20,
      location: '第 20 页',
      snippet: '设备接口协议描述时序约束和异常处理。'
    }, {
      uid: 'document:doc-e2e-secondary',
      name: '接口测试记录.pdf',
      nodeType: 'knowledge_document',
      itemId: 'doc-e2e-secondary',
      sourceType: 'document',
      documentId: 'doc-e2e-secondary',
      chunkId: 'chunk-e2e-secondary-4',
      fileName: '接口测试记录.pdf',
      pageNumber: 4,
      location: '第 4 页',
      snippet: '接口测试记录汇总验证结果。'
    }, {
      uid: 'record:e2e-validation',
      name: '接口验证任务',
      nodeType: 'Task',
      itemId: 'task-e2e-validation',
      sourceType: 'record',
      location: '任务说明',
      snippet: '接口验证任务记录当前跟踪状态。'
    }]
  }
]

try {
  database.saveChatSession({
    id: 'source-list-e2e-session',
    title: '回答依据分组验收',
    messages
  })
  console.log(JSON.stringify({ ok: true, userData, sessionId: 'source-list-e2e-session' }))
} finally {
  database.close()
}
