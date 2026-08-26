import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QueryEngine } from '../src/main/analytics/query-engine'
import {
  DataCenterAgent,
  findAmbiguousSemanticAliases
} from '../src/main/assistant/agents/data-center-agent'
import { buildSafeQueryRecoverySuggestions } from '../src/main/assistant/recovery-suggestions'
import { AppDatabase } from '../src/main/database'
import type { AssistantExecutionSummary } from '../src/shared/expert-types'

const checks: string[] = []
const directory = await mkdtemp(join(tmpdir(), 'assistant-field-semantics-'))
const db = new AppDatabase(join(directory, 'semantics.db'), join(directory, 'assets'))

try {
  db.upsertRecord({
    uid: 'semantic-record-1',
    projectId: 'project-a',
    nodeType: 'Requirement',
    itemId: 'SEM-1',
    parentId: '',
    name: '字段语义测试',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      OwnerPrimary: '张三',
      OwnerBackup: '李四',
      Amount: 12
    },
    normalizedText: '字段语义测试 张三 李四'
  })
  const engine = new QueryEngine(db)
  const scope = { projectIds: ['project-a'] }
  engine.profile(scope)
  const primary = engine.updateFieldProfileSemantics(scope, 'OwnerPrimary', {
    displayName: '主负责人',
    role: 'dimension',
    synonyms: ['负责人', 'Owner'],
    sensitivity: 'internal'
  })
  engine.updateFieldProfileSemantics(scope, 'OwnerBackup', {
    displayName: '备用负责人',
    role: 'dimension',
    synonyms: ['负责人']
  })
  assert.equal(primary.displayName, '主负责人')
  assert.deepEqual(primary.synonyms, ['负责人', 'Owner'])
  assert.equal(primary.sensitivity, 'internal')
  checks.push('manual display name, role, synonyms and sensitivity persist in the field profile')

  const catalog = new DataCenterAgent(db).inspectCatalog('project-a')
  const owner = catalog.fields.find((field) => field.field === 'OwnerPrimary')
  assert.equal(owner?.displayName, '主负责人')
  assert.equal(owner?.role, 'dimension')
  assert.deepEqual(owner?.synonyms, ['负责人', 'Owner'])
  checks.push('Data Center Agent consumes manually maintained field semantics')

  assert.deepEqual(
    findAmbiguousSemanticAliases('请按负责人分别统计需求', catalog.fields),
    [{ alias: '负责人', fields: ['OwnerBackup', 'OwnerPrimary'] }]
  )
  assert.deepEqual(findAmbiguousSemanticAliases('请按金额统计需求', catalog.fields), [])
  checks.push('a mentioned alias mapped to multiple fields is detected deterministically')

  const summary: AssistantExecutionSummary = {
    question: '统计华东区域的需求',
    taskType: 'record_query',
    sourceMode: 'records',
    resultMode: 'table',
    intent: 'filter_records',
    searchTerms: ['华东'],
    fields: ['OwnerPrimary'],
    filters: [{ field: 'Amount', operator: 'gte', value: '10' }],
    limit: 50,
    scope: { projectIds: [], nodeTypes: [], baseFilters: [] }
  }
  const suggestions = buildSafeQueryRecoverySuggestions(summary)
  const prompts = suggestions.map((suggestion) => suggestion.prompt).join('\n')
  assert.match(prompts, /OwnerPrimary/)
  assert.match(prompts, /Amount/)
  assert.match(prompts, /华东/)
  assert.doesNotMatch(prompts, /负责人字段|日期字段|状态字段/)
  assert.deepEqual(buildSafeQueryRecoverySuggestions(undefined), [])
  checks.push('safe rewrites use only confirmed fields, terms and scope and never invent schema')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const [mainSource, ollamaSource, rendererSource] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/ollama.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
])

assert.match(ollamaSource, /findAmbiguousSemanticAliases\(groundingQuestion, catalog\)/)
assert.match(mainSource, /buildSafeQueryRecoverySuggestions\(confirmedExecutionSummary\)/)
assert.match(rendererSource, /字段语义词典/)
assert.match(rendererSource, /saveFieldProfileSemantics/)
assert.match(rendererSource, /message\.recoverySuggestions\.map/)
checks.push('ambiguity guard, recovery wiring and manual correction UI are integrated')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
