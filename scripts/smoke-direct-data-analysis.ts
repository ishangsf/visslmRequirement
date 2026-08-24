import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { DirectRequirementDataAnalysisAgent } from '../src/main/direct-data-analysis'

const root = mkdtempSync(join(tmpdir(), 'visslm-direct-data-analysis-'))
const database = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))
for (const suffix of ['4101', '4059', '4060', '4061', '4099']) {
  database.upsertRecord({
    uid: `uid-${suffix}`,
    projectId: '',
    nodeType: 'Task',
    itemId: `VISSLM-TSIS-${suffix}`,
    parentId: '',
    name: `测试需求 ${suffix}`,
    lastModifyTime: '2026-08-24T00:00:00.000Z',
    raw: { _valm_Name: `测试需求 ${suffix}`, _valm_Description: `描述 ${suffix}` },
    normalizedText: `描述 ${suffix}`
  })
}

let modelInput = ''
const model = {
  chat: async (input: { messages: Array<{ content: string }> }) => {
    modelInput = input.messages.at(-1)?.content ?? ''
    return { message: { role: 'assistant' as const, content: '已基于本地记录完成分析。' } }
  }
}
const response = await new DirectRequirementDataAnalysisAgent(database, {}, model).ask({
  question: '分析需求 4101、4059-4061、4099，所有编号前面都有前缀VISSLM-TSIS-'
})
database.close()
rmSync(root, { recursive: true, force: true })

assert.equal(response.sources.length, 5)
assert.equal(response.dataViews[0]?.total, 5)
assert.ok(modelInput.includes('VISSLM-TSIS-4099'))
console.log(JSON.stringify({ ok: true, extractedRecords: response.sources.length, completeIndex: true }))
