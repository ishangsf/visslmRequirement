import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import { OllamaAgent } from '../src/main/ollama'
import type { ModelSettings } from '../src/shared/types'
import { ModelClient } from '../src/main/model-client'

// Synthetic data only; this never reads or sends production records.
const settings: ModelSettings = { source: 'local', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: process.env.VISSLM_EVAL_MODEL || 'qwen3.8:27b', thinking: false }
const directory = await mkdtemp(join(tmpdir(), 'semantic-live-'))
const db = new AppDatabase(join(directory, 'test.db'), join(directory, 'assets'))
const results: Array<Record<string, unknown>> = []
const modelCalls: Array<Record<string, unknown>> = []
const originalChat = ModelClient.prototype.chat
ModelClient.prototype.chat = async function (input) {
  const response = await originalChat.call(this, input)
  if (input.format) modelCalls.push({ output: response.message?.content })
  return response
}
try {
  for (let i = 0; i < 12; i++) db.upsertRecord({ uid: `synthetic-${i}`, projectId: 'p', nodeType: 'Issue', parentId: '', itemId: `ISS-${i}`, name: `权限校验问题 ${i}`,
    raw: { 分析人: i % 2 ? '李四' : '张三', 状态: i % 3 ? '处理中' : '已关闭', 区域: i % 2 ? '南区' : '北区' }, normalizedText: '权限校验问题，需补充令牌过期检查', lastModifyTime: '' })
  const cases = [
    { question: '基于当前资产中心的所有数据，列出每个分析人各自参与的问题，整理成一个清单给我。', group: '分析人' },
    { question: '按区域分别给我一份问题明细，每个区域都要列出。', group: '区域' },
    { question: '按状态统计各有多少条问题。', aggregate: '状态' },
    { question: '不要生成图表，请解释什么是柱状图。', conversation: true }
  ]
  for (const item of cases) {
    const start = Date.now()
    try {
      const intent = await new AssistantIntentRouter(settings).resolve({ question: item.question })
      assert.equal(intent.needsClarification, false)
      assert.equal(intent.taskType, item.conversation ? 'conversation' : 'record_query')
      const answer = await new OllamaAgent(db, settings).ask({ question: item.question, assistantIntent: intent, dataScope: { projectIds: ['p'] } })
      assert.equal(answer.needsClarification, undefined)
      if (item.group) {
        assert.equal(answer.executionSummary?.groupByField, item.group)
        assert.equal(answer.dataViews[0].total, 12)
        assert.equal(answer.dataViews[0].loadedRows, 12)
        assert.equal(answer.dataViews[0].groups.length, 2)
      }
      if (item.aggregate) {
        assert.equal(answer.executionSummary?.intent, 'field_aggregate')
        assert.equal(answer.executionSummary?.groupByField, item.aggregate)
      }
      results.push({ question: item.question, ok: true, elapsedMs: Date.now() - start, intent, executionSummary: answer.executionSummary, answer: answer.answer })
      console.log(JSON.stringify({ question: item.question, ok: true, elapsedMs: Date.now() - start }))
    } catch (error) {
      results.push({ question: item.question, ok: false, elapsedMs: Date.now() - start, error: String(error) })
      console.log(JSON.stringify(results.at(-1)))
    }
  }
} finally {
  db.close(); await rm(directory, { recursive: true, force: true })
  await mkdir('artifacts/assistant-semantic-refactor', { recursive: true })
  ModelClient.prototype.chat = originalChat
  await writeFile('artifacts/assistant-semantic-refactor/live-evaluation.json', JSON.stringify({ model: settings.model, results, modelCalls }, null, 2))
}
if (results.some((result) => !result.ok)) process.exitCode = 1
