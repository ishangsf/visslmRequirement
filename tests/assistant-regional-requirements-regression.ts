import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type RecordInput } from '../src/main/database'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import { OllamaAgent } from '../src/main/ollama'
import type { ChatRequest, ModelSettings } from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-regional-requirements-regression-model',
  thinking: false,
  apiKey: 'assistant-regional-requirements-regression-key'
}

const projectId = 'regional-requirements-project'
const prefix = 'VISSLM-TSIS-'
type RegionalGroups = Readonly<Record<string, readonly string[]>>

const regionSuffixes = {
  华东区: ['4159', '4080', '4116', '4127', '4125', '4126'],
  西北区: ['4122', '4107'],
  西南区: ['4158', '4156', '4157', '4124', '4120', '4118', '4112', '4103', '4025', '4030', '4034', '4164'],
  北方区: ['4132', '3943', '3944', '4141', '4134', '4133', '4121', '3991', '3990', '4108', '4109', '4110', '4152', '4015', '4117', '4153', '4154']
} as const

const regionNames = Object.keys(regionSuffixes) as Array<keyof typeof regionSuffixes>
const requestedSuffixes = regionNames.flatMap((name) => [...regionSuffixes[name]])
const requestedItemIds = requestedSuffixes.map((suffix) => `${prefix}${suffix}`)
const missingSuffix = '4015'
const missingItemId = `${prefix}${missingSuffix}`
const existingItemIds = requestedItemIds.filter((itemId) => itemId !== missingItemId)

const question = `@通用数据助手 按区域分析以下需求：华东区需求：${regionSuffixes.华东区.join('、')} 西北区：${regionSuffixes.西北区.join('、')} 西南区：${regionSuffixes.西南区.join('、')} 北方区：${regionSuffixes.北方区.join('、')}，这些数字都是需求编号后面的具体编号，前缀是 ${prefix}`

const response = (content: string): ModelResponse => ({
  message: { role: 'assistant', content }
})

const installModel = (
  agent: OllamaAgent,
  handler: (input: ModelChatInput) => Promise<ModelResponse> | ModelResponse
): void => {
  Object.defineProperty(agent, 'callModel', {
    configurable: true,
    value: handler
  })
}

const suffixOf = (value: string): string => value
  .replace(/^VISSLM-TSIS-/iu, '')
  .trim()

const itemIdSet = (values: readonly string[]): Set<string> => new Set(values.map((value) => value.toLocaleUpperCase()))

const seedRecords = (db: AppDatabase): void => {
  const records: RecordInput[] = existingItemIds.map((itemId) => {
    const suffix = suffixOf(itemId)
    return {
      uid: `regional-record-${suffix}`,
      projectId,
      nodeType: 'Requirement',
      itemId,
      parentId: '',
      name: `区域分析需求 ${suffix}`,
      lastModifyTime: new Date(0).toISOString(),
      // Deliberately omit a region field. The region is supplied by the
      // user's grouped request and must not be guessed from record metadata.
      raw: {
        Description: `真实检索证据 ${suffix}：完成需求 ${suffix} 的业务交付。`
      },
      normalizedText: `真实检索证据 ${suffix}：完成需求 ${suffix} 的业务交付。`
    }
  })
  records.push({
    uid: 'regional-collision-41590',
    projectId,
    nodeType: 'Requirement',
    itemId: `${prefix}41590`,
    parentId: '',
    name: '相邻编号碰撞记录',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      Description: `这条描述提到了 ${prefix}4159，但它不是该编号。`
    },
    normalizedText: `这条描述提到了 ${prefix}4159，但它不是该编号。`
  })
  records.push({
    uid: 'regional-collision-description',
    projectId,
    nodeType: 'Requirement',
    itemId: `${prefix}4999`,
    parentId: '',
    name: '描述文本碰撞记录',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      Description: `仅描述中包含 ${prefix}4159，业务编号仍为 ${prefix}4999。`
    },
    normalizedText: `仅描述中包含 ${prefix}4159，业务编号仍为 ${prefix}4999。`
  })
  db.upsertRecords(records)
}

const requestFor = (
  assistantIntent: NonNullable<ChatRequest['assistantIntent']>,
  currentQuestion = question,
  dataScope: ChatRequest['dataScope'] = { projectIds: [projectId] }
): ChatRequest => ({
  question: currentQuestion,
  projectId,
  dataScope,
  assistantIntent
})

const viewRows = (answer: Awaited<ReturnType<OllamaAgent['ask']>>): Array<{ itemId: string; name: string; group: string }> => (
  answer.dataViews.flatMap((view) => view.groups.flatMap((group) => group.rows.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    group: group.name
  }))))
)

const assertRegionalEvidence = (
  answer: Awaited<ReturnType<OllamaAgent['ask']>>,
  expectedGroupMembership: RegionalGroups
): void => {
  assert.equal(answer.taskTrace?.status, 'completed')
  assert.equal(answer.needsClarification, undefined)
  assert.equal(answer.dataViews.length, 1, 'regional analysis must expose one grouped evidence view')
  const view = answer.dataViews[0]!
  assert.equal(view.total, existingItemIds.length)
  assert.deepEqual(view.groups.map((group) => group.name), regionNames)
  assert.deepEqual(
    view.groups.map((group) => group.count),
    regionNames.map((name) => expectedGroupMembership[name]
      .filter((suffix) => suffix !== missingSuffix)
      .filter((suffix, index, values) => values.indexOf(suffix) === index)
      .length)
  )

  for (const region of regionNames) {
    const group = view.groups.find((candidate) => candidate.name === region)
    assert.ok(group, `${region} must remain a user-defined group even when a member is missing`)
    assert.deepEqual(
      group.rows.map((row) => suffixOf(row.itemId)),
      expectedGroupMembership[region]
        .filter((suffix) => suffix !== missingSuffix)
        .filter((suffix, index, values) => values.indexOf(suffix) === index)
    )
    assert.equal(new Set(group.rows.map((row) => row.itemId)).size, group.rows.length, `${region} must not duplicate a row internally`)
  }

  const rows = viewRows(answer)
  const expectedGroupedRowCount = regionNames.reduce((sum, name) => sum + expectedGroupMembership[name]
    .filter((suffix) => suffix !== missingSuffix)
    .filter((suffix, index, values) => values.indexOf(suffix) === index)
    .length, 0)
  assert.equal(rows.length, expectedGroupedRowCount)
  assert.deepEqual(
    itemIdSet(rows.map((row) => row.itemId)),
    itemIdSet(existingItemIds),
    'regional lookup must use exact item IDs and exclude adjacent/description-only collisions'
  )
  assert.equal(rows.some((row) => row.itemId === `${prefix}41590`), false)
  assert.equal(rows.some((row) => row.itemId === `${prefix}4999`), false)
  assert.match(answer.answer, new RegExp(missingItemId, 'u'), 'a missing requested ID must be named explicitly')
  assert.match(answer.answer, /未找到|不存在|未命中/u, 'missing IDs must explain the exact lookup miss')
  for (const itemId of existingItemIds) {
    assert.match(answer.answer, new RegExp(itemId, 'u'), `answer must retain retrieved identifier ${itemId}`)
  }
  assert.match(answer.answer, /真实检索证据 4159/u, 'analysis answer must contain retrieved record content, not only a count')
  assert.match(answer.answer, /真实检索证据 4154/u, 'records after the first 30 must remain in the analysis evidence')
  assert.deepEqual(answer.executionSummary?.scope.projectIds, [projectId], 'regional evidence must retain the caller data scope')
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-regional-requirements-'))
  const db = new AppDatabase(join(directory, 'regional.db'), join(directory, 'assets'))
  try {
    seedRecords(db)


    let classifierCalls = 0
    const intent = await new AssistantIntentRouter(settings, { chat: async () => {
      classifierCalls++
      return response(JSON.stringify({ taskType: 'record_query', skillId: 'general', sourceMode: 'records', resultMode: 'grouped_list',
        resolvedQuestion: question, groupEntities: [], needsClarification: false, reason: 'semantic mapping' }))
    } }).resolve({ question })
    assert.equal(classifierCalls, 1, 'region words and IDs must not bypass semantic planning')
    const makePlan = (groups = regionSuffixes) => ({ sourceMode: 'records', intent: 'analyze_records', resultMode: 'grouped_list',
      fields: [], filters: [], groupEntities: [], searchTerms: [], searchMode: 'any', needsClarification: false, explanation: '', limit: 50,
      recordGroups: { identifierPrefix: prefix, groups: Object.entries(groups).map(([name,codes]) => ({ name, codes })) } })
    const ask = async (q: string, plan: unknown, answer = '这些需求均涉及业务交付，应结合各组内容安排实施。', scope?: ChatRequest['dataScope']) => {
      const agent = new OllamaAgent(db, settings)
      let planningCalls = 0
      installModel(agent, async input => { if (input.format) { planningCalls++; return response(JSON.stringify(plan)) } return response(answer) })
      const result = await agent.ask(requestFor(intent, q, scope))
      assert.equal(planningCalls, 1)
      return result
    }
    const analyzed = await ask(question, makePlan())
    assertRegionalEvidence(analyzed, regionSuffixes)
    assert.match(analyzed.answer, /这些需求均涉及业务交付/)
    await assert.rejects(ask(question, makePlan(), ''), /未返回所需分析/)
    const failed = new OllamaAgent(db, settings)
    installModel(failed, async () => { throw new Error('model unavailable') })
    await assert.rejects(failed.ask(requestFor(intent)), /无法确定可验证/)
    const scopedRecordUids = existingItemIds.filter(id => id !== prefix + '4159').map(id => 'regional-record-' + suffixOf(id))
    const scoped = await ask(question, makePlan(), '已分析范围内的需求。', { projectIds: [projectId], recordUids: scopedRecordUids })
    assert.equal(scoped.dataViews[0].total, existingItemIds.length - 1)
    assert.equal(viewRows(scoped).some(row => row.itemId === prefix + '4159'), false)
    const duplicateQuestion = question.replace('北方区：4132', '北方区：4159、4132')
    const duplicateGroups = { ...regionSuffixes, 北方区: ['4159', ...regionSuffixes.北方区] }
    const cross = await ask(duplicateQuestion, makePlan(duplicateGroups as any))
    assertRegionalEvidence(cross, duplicateGroups)
    assert.equal(viewRows(cross).filter(row => row.itemId === prefix + '4159').length, 2)
    console.log(JSON.stringify({ ok: true, checks: ['semantic plan required', 'explicit mappings', 'exact IDs', 'scope', 'shared membership', 'no success on model failure'] }))
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
