import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase, type RecordInput } from '../src/main/database'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import { parseRegionalRequirementRequest } from '../src/main/assistant/regional-requirements'
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

    const parsed = parseRegionalRequirementRequest(question)
    assert.ok(parsed, 'the explicit region-to-numeric-code request must be recognized')
    assert.deepEqual(parsed?.groups.map((group) => group.name), regionNames)
    assert.deepEqual(
      parsed?.groups.map((group) => group.codes.map(suffixOf)),
      regionNames.map((name) => [...regionSuffixes[name]])
    )
    assert.equal(
      parsed?.groups.reduce((sum, group) => sum + group.codes.length, 0),
      requestedItemIds.length,
      'all 37 requested suffixes, including values beyond the first 30, must survive parsing'
    )

    const duplicateMembership = parseRegionalRequirementRequest(
      question.replace('北方区：4132', '北方区：4159、4132')
    )
    assert.ok(duplicateMembership)
    const duplicateGroups = new Map(duplicateMembership?.groups.map((group) => [group.name, group.codes.map(suffixOf)]))
    assert.equal(duplicateGroups.get('华东区')?.includes('4159'), true)
    assert.equal(duplicateGroups.get('北方区')?.includes('4159'), true, 'the same record may belong to two user-supplied groups')

    let classifierCalls = 0
    const intent = await new AssistantIntentRouter(settings, {
      chat: async () => {
        classifierCalls += 1
        throw new Error('regional classifier must not be called')
      }
    }).resolve({ question, chatMode: 'auto', entrypoint: 'chat' })
    assert.equal(classifierCalls, 0, 'an explicit regional mapping must bypass the classifier')
    assert.equal(intent.taskType, 'record_query')
    assert.equal(intent.sourceMode, 'records')
    assert.equal(intent.resultMode, 'answer')
    assert.deepEqual(intent.groupEntities, regionNames)
    assert.equal(intent.needsClarification, false)

    const modelBehaviors: Array<{ label: string; handler: (input: ModelChatInput) => Promise<ModelResponse> | ModelResponse }> = [
      {
        label: 'empty planner/analysis response',
        handler: async () => response('')
      },
      {
        label: 'invalid planner/analysis response',
        handler: async () => response('not valid JSON')
      },
      {
        label: 'throwing planner/analysis transport',
        handler: async () => { throw new Error('planner transport unavailable') }
      }
    ]

    for (const behavior of modelBehaviors) {
      const prompts: string[] = []
      const agent = new OllamaAgent(db, settings)
      installModel(agent, async (input) => {
        prompts.push(input.messages.map((message) => String(message.content)).join('\n'))
        return behavior.handler(input)
      })
      const answer = await agent.ask(requestFor(intent))
      assertRegionalEvidence(answer, regionSuffixes)
      assert.equal(
        prompts.some((prompt) => /统一任务规划器|意图与数据查询规划器/u.test(prompt)),
        false,
        `${behavior.label} must not send this already-grounded request through classifier/planner recovery`
      )
    }

    const scopedRecordUids = existingItemIds
      .filter((itemId) => itemId !== `${prefix}4159`)
      .map((itemId) => `regional-record-${suffixOf(itemId)}`)
    const scopedAgent = new OllamaAgent(db, settings)
    installModel(scopedAgent, async () => { throw new Error('scoped regional analysis transport unavailable') })
    const scopedAnswer = await scopedAgent.ask(requestFor(
      intent,
      question,
      { projectIds: [projectId], recordUids: scopedRecordUids }
    ))
    assert.equal(scopedAnswer.taskTrace?.status, 'completed')
    assert.equal(scopedAnswer.dataViews.length, 1)
    const scopedView = scopedAnswer.dataViews[0]!
    assert.equal(scopedView.total, existingItemIds.length - 1)
    assert.deepEqual(scopedView.groups.map((group) => group.count), [5, 2, 12, 16])
    assert.equal(viewRows(scopedAnswer).some((row) => row.itemId === `${prefix}4159`), false)
    assert.match(scopedAnswer.answer, new RegExp(`${prefix}4159`, 'u'))
    assert.match(scopedAnswer.answer, /未找到|不存在|未命中/u)
    assert.equal(scopedAnswer.executionSummary?.scope.recordCount, scopedRecordUids.length)

    const allMissingQuestion = `@通用数据助手 按区域分析需求：华东区：7001 西北区：7002，前缀是 ${prefix}`
    const allMissingIntent = await new AssistantIntentRouter(settings, {
      chat: async () => { throw new Error('all-missing regional request must bypass classifier') }
    }).resolve({ question: allMissingQuestion, chatMode: 'auto', entrypoint: 'chat' })
    const allMissingAgent = new OllamaAgent(db, settings)
    const allMissingPrompts: string[] = []
    installModel(allMissingAgent, async (input) => {
      allMissingPrompts.push(input.messages.map((message) => String(message.content)).join('\n'))
      throw new Error('all-missing analysis transport unavailable')
    })
    const allMissingAnswer = await allMissingAgent.ask(requestFor(
      allMissingIntent,
      allMissingQuestion
    ))
    assert.equal(allMissingAnswer.taskTrace?.status, 'completed')
    assert.equal(allMissingAnswer.sources.length, 0)
    assert.equal(allMissingAnswer.dataViews.length, 1, 'an all-missing grouped lookup still needs an explicit zero-result view')
    const allMissingView = allMissingAnswer.dataViews[0]!
    assert.equal(allMissingView.total, 0)
    assert.deepEqual(allMissingView.groups.map((group) => group.name), ['华东区', '西北区'])
    assert.deepEqual(allMissingView.groups.map((group) => group.count), [0, 0])
    assert.deepEqual(allMissingView.groups.map((group) => group.rows.length), [0, 0])
    assert.match(allMissingAnswer.answer, new RegExp(`${prefix}7001`, 'u'))
    assert.match(allMissingAnswer.answer, new RegExp(`${prefix}7002`, 'u'))
    assert.match(allMissingAnswer.answer, /未找到|不存在|未命中/u)
    assert.equal(
      allMissingPrompts.some((prompt) => /统一任务规划器|意图与数据查询规划器/u.test(prompt)),
      false
    )

    const analysisAgent = new OllamaAgent(db, settings)
    let analysisCalls = 0
    installModel(analysisAgent, async (input) => {
      analysisCalls += 1
      const payload = JSON.parse(String(input.messages.at(-1)?.content)) as {
        queryResult: { records: Array<{ source: { itemId: string }; text: string }>; regionalGroups: unknown[] }
      }
      assert.deepEqual(itemIdSet(payload.queryResult.records.map((record) => record.source.itemId)), itemIdSet(existingItemIds))
      assert.equal(payload.queryResult.regionalGroups.length, 4)
      assert.ok(payload.queryResult.records.every((record) => record.text.includes('真实检索证据')))
      return response('这些需求均涉及业务交付，应结合各区域的具体内容进一步安排实施。')
    })
    const analyzed = await analysisAgent.ask(requestFor(intent))
    assert.equal(analysisCalls, 1)
    assertRegionalEvidence(analyzed, regionSuffixes)
    assert.match(analyzed.answer, /这些需求均涉及业务交付/u)
    assert.match(analyzed.answer, /\[UID:regional-record-4154\]/u, 'late-record citations must survive validation beyond the old 20-source cap')

    const duplicateQuestion = question.replace('华东区需求：4159、4080', '华东区需求：4159、4159、4080')
    const duplicateIntent = await new AssistantIntentRouter(settings, {
      chat: async () => { throw new Error('duplicate regional request must bypass classifier') }
    }).resolve({ question: duplicateQuestion, chatMode: 'auto', entrypoint: 'chat' })
    const duplicateAgent = new OllamaAgent(db, settings)
    installModel(duplicateAgent, async () => { throw new Error('analysis transport unavailable') })
    const duplicateAnswer = await duplicateAgent.ask(requestFor(duplicateIntent, duplicateQuestion))
    assertRegionalEvidence(duplicateAnswer, {
      ...regionSuffixes,
      华东区: ['4159', '4159', ...regionSuffixes.华东区.slice(1)]
    })
    const eastGroup = duplicateAnswer.dataViews[0]?.groups.find((group) => group.name === '华东区')
    assert.equal(eastGroup?.rows.length, regionSuffixes.华东区.length, 'a repeated identifier in one region must not duplicate its evidence row')
    const duplicateRows = viewRows(duplicateAnswer).filter((row) => row.itemId === `${prefix}4159`)
    assert.equal(duplicateRows.length, 1, 'the same record should be represented once per grouped evidence view')

    const crossRegionQuestion = question.replace('北方区：4132', `北方区：4159、4132`)
    const crossRegionIntent = await new AssistantIntentRouter(settings, {
      chat: async () => { throw new Error('cross-region duplicate must bypass classifier') }
    }).resolve({ question: crossRegionQuestion, chatMode: 'auto', entrypoint: 'chat' })
    const crossRegionAgent = new OllamaAgent(db, settings)
    installModel(crossRegionAgent, async () => { throw new Error('cross-region analysis transport unavailable') })
    const crossRegionAnswer = await crossRegionAgent.ask(requestFor(crossRegionIntent, crossRegionQuestion))
    assertRegionalEvidence(crossRegionAnswer, {
      ...regionSuffixes,
      北方区: ['4159', ...regionSuffixes.北方区]
    })
    const crossRegionRows = viewRows(crossRegionAnswer).filter((row) => row.itemId === `${prefix}4159`)
    assert.equal(crossRegionRows.length, 2, 'one exact record may appear once in each user-supplied region group')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
