import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { OllamaAgent } from '../src/main/ollama'
import type {
  AssistantIntentDecision,
  ChatHistoryTurn,
  ChatRequest,
  ModelSettings
} from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import {
  AssistantIntentRouter,
  resolveAssistantIntent
} from '../src/main/assistant/intent-router'

/**
 * This smoke is deliberately limited to the intent boundary.  The fake
 * client never has database, knowledge or skill handles, so a passing test
 * proves the decision can be made before any evidence executor is available.
 */
const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-intent-regression-model',
  thinking: false,
  apiKey: 'assistant-intent-regression-key'
}

class RecordingIntentClient {
  readonly calls: ModelChatInput[] = []

  constructor(private readonly response: Record<string, unknown>) {}

  async chat(input: ModelChatInput): Promise<ModelResponse> {
    this.calls.push(input)
    return {
      message: {
        role: 'assistant',
        content: JSON.stringify(this.response)
      }
    }
  }
}

class ScriptedIntentClient {
  readonly calls: ModelChatInput[] = []
  private responseIndex = 0

  constructor(private readonly responses: readonly ModelResponse[]) {}

  async chat(input: ModelChatInput): Promise<ModelResponse> {
    this.calls.push(input)
    const response = this.responses[this.responseIndex]
    this.responseIndex += 1
    if (!response) throw new Error(`unexpected intent classifier call #${this.responseIndex}`)
    return response
  }
}

const decisionResponse = (input: Partial<AssistantIntentDecision>): Record<string, unknown> => ({
  taskType: input.taskType ?? 'conversation',
  skillId: input.skillId ?? 'general',
  sourceMode: input.sourceMode ?? 'conversation',
  resolvedQuestion: input.resolvedQuestion ?? '处理当前问题',
  resultMode: input.resultMode ?? 'answer',
  groupEntities: input.groupEntities ?? [],
  needsClarification: input.needsClarification ?? false,
  ...(input.clarificationQuestion === undefined
    ? {}
    : { clarificationQuestion: input.clarificationQuestion }),
  reason: input.reason ?? '由当前问题和已提供的历史上下文确定'
})

const modelDecisionResponse = (
  response: Record<string, unknown>,
  doneReason?: string
): ModelResponse => ({
  message: {
    role: 'assistant',
    content: JSON.stringify(response)
  },
  ...(doneReason ? { done_reason: doneReason } : {})
})

const emptyModelResponse = (doneReason = 'stop'): ModelResponse => ({
  message: {
    role: 'assistant',
    content: ''
  },
  done_reason: doneReason
})

const assertIntentClassifierBudgets = (
  calls: readonly ModelChatInput[],
  expectedBudgets: readonly number[]
): void => {
  assert.deepEqual(
    calls.map((call) => call.numPredict),
    expectedBudgets,
    'intent classification retries must use the bounded token budgets'
  )
  for (const call of calls) {
    assert.equal(call.think, false, 'intent classification must keep model thinking disabled')
    assert.equal(call.forceThinking, false, 'intent classification must not force model thinking')
  }
}

const request = (
  question: string,
  history?: readonly ChatHistoryTurn[],
  extra: Partial<Pick<ChatRequest, 'entrypoint' | 'expertId' | 'chatMode'>> = {}
): Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode'> => ({
  question,
  history: history ? [...history] : undefined,
  entrypoint: extra.entrypoint ?? 'chat',
  expertId: extra.expertId,
  chatMode: extra.chatMode ?? 'auto'
})

const textOfCalls = (calls: readonly ModelChatInput[]): string => calls
  .flatMap((call) => call.messages)
  .map((message) => String(message.content))
  .join('\n')

const entityNames = (decision: AssistantIntentDecision): string[] => decision.groupEntities
  .map((entity) => String(entity).trim())
  .filter(Boolean)

const assertDecisionCore = (
  decision: AssistantIntentDecision,
  expected: Partial<Pick<AssistantIntentDecision, 'taskType' | 'skillId' | 'sourceMode' | 'resultMode'>>
): void => {
  for (const [field, value] of Object.entries(expected)) {
    assert.equal(
      decision[field as keyof AssistantIntentDecision],
      value,
      `intent decision ${field} must preserve the semantic route`
    )
  }
  assert.equal(typeof decision.resolvedQuestion, 'string')
  assert.ok(decision.resolvedQuestion.trim().length > 0)
  assert.equal(Array.isArray(decision.groupEntities), true)
  assert.equal(typeof decision.needsClarification, 'boolean')
  assert.equal(typeof decision.reason, 'string')
}

const resolveWithRecordingClient = async (
  response: Record<string, unknown>,
  input: Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode'>
): Promise<{ decision: AssistantIntentDecision; client: RecordingIntentClient }> => {
  const client = new RecordingIntentClient(response)
  const router = new AssistantIntentRouter(settings, client)
  const decision = await router.resolve(input)
  return { decision, client }
}

const testConversationIsFirstAndSourceFree = async (): Promise<void> => {
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'conversation',
      skillId: 'general',
      sourceMode: 'conversation',
      resolvedQuestion: '回答用户的问候并介绍助手能力',
      resultMode: 'answer'
    }),
    request('你好，你是谁？')
  )

  assertDecisionCore(decision, {
    taskType: 'conversation',
    skillId: 'general',
    sourceMode: 'conversation',
    resultMode: 'answer'
  })
  assert.equal(decision.groupEntities.length, 0)
  assert.equal(client.calls.length, 1, 'conversation intent must be decided in one model call')
  assert.equal(client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)
  assert.doesNotMatch(textOfCalls(client.calls), /inspect_fields|query_records|knowledge\.search|execute_query/u)
}

const testVisualizationSelectsSkillBeforeEvidence = async (): Promise<void> => {
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'visualization',
      skillId: 'visualization',
      sourceMode: 'records',
      resolvedQuestion: '基于当前数据生成负责人分布可视化大屏',
      resultMode: 'dashboard'
    }),
    request('请基于当前数据生成负责人分布可视化大屏')
  )

  assertDecisionCore(decision, {
    taskType: 'visualization',
    skillId: 'visualization',
    sourceMode: 'records',
    resultMode: 'dashboard'
  })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)
}

const testExactRequirementIdKeepsRequirementSkill = async (): Promise<void> => {
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'requirement_matching',
      skillId: 'requirement-analysis',
      sourceMode: 'records',
      resolvedQuestion: '直接分析需求编号 REQ-GENERIC-42',
      resultMode: 'table'
    }),
    request('请直接分析需求编号 REQ-GENERIC-42')
  )

  assertDecisionCore(decision, {
    taskType: 'requirement_matching',
    skillId: 'requirement-analysis',
    sourceMode: 'records'
  })
  assert.match(decision.resolvedQuestion, /REQ-GENERIC-42/u)
  assert.equal(client.calls.length, 0, 'an exact requirement ID may use the validated direct route without a second classifier call')
}

const testKnowledgeAndMixedUseDeclaredSources = async (): Promise<void> => {
  const knowledge = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'knowledge_qa',
      skillId: 'general',
      sourceMode: 'knowledge',
      resolvedQuestion: '根据上传的部署规范说明审批流程',
      resultMode: 'answer'
    }),
    request('请根据上传的部署规范说明审批流程')
  )
  assertDecisionCore(knowledge.decision, {
    taskType: 'knowledge_qa',
    sourceMode: 'knowledge',
    resultMode: 'answer'
  })
  assert.equal(knowledge.client.calls.length, 1)

  const mixed = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'mixed_analysis',
      skillId: 'general',
      sourceMode: 'mixed',
      resolvedQuestion: '结合数据中心记录与上传部署规范核对审批状态',
      resultMode: 'table'
    }),
    request('请结合数据中心记录与上传部署规范核对审批状态')
  )
  assertDecisionCore(mixed.decision, {
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'table'
  })
  assert.equal(mixed.client.calls.length, 1)
  assert.equal(mixed.client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)

  const localMixed = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'knowledge_qa',
      skillId: 'knowledge-base',
      sourceMode: 'knowledge',
      resolvedQuestion: '结合本地需求记录和知识库的部署规范说明审批流程',
      resultMode: 'answer'
    }),
    request('请结合本地需求记录和知识库的部署规范说明审批流程')
  )
  assertDecisionCore(localMixed.decision, {
    taskType: 'mixed_analysis',
    sourceMode: 'mixed'
  })
  assert.equal(localMixed.client.calls.length, 1)
}

const testKnowledgeQuestionRoutesWithOneClosedThinkingCall = async (): Promise<void> => {
  const client = new RecordingIntentClient(decisionResponse({
    taskType: 'knowledge_qa',
    skillId: 'general',
    sourceMode: 'knowledge',
    resolvedQuestion: '说明 GJB5000B 的总体架构及基本概念',
    resultMode: 'answer'
  }))
  const decision = await new AssistantIntentRouter(settings, client).resolve(
    request('GJB5000B 总体架构及基本概念是什么？')
  )

  assertDecisionCore(decision, {
    taskType: 'knowledge_qa',
    sourceMode: 'knowledge',
    resultMode: 'answer'
  })
  assert.equal(client.calls.length, 1, 'a normal valid intent response must not trigger a retry')
  assertIntentClassifierBudgets(client.calls, [900])
}

const testEmptyClassifierResponseRetriesOnce = async (): Promise<void> => {
  const client = new ScriptedIntentClient([
    emptyModelResponse(),
    modelDecisionResponse(decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '列出负责人甲的需求记录',
      resultMode: 'list'
    }))
  ])
  const decision = await new AssistantIntentRouter(settings, client).resolve(
    request('列出负责人甲的需求记录')
  )

  assertDecisionCore(decision, {
    taskType: 'record_query',
    sourceMode: 'records',
    resultMode: 'list'
  })
  assert.equal(client.calls.length, 2, 'an empty classifier response may retry exactly once')
  assertIntentClassifierBudgets(client.calls, [900, 1800])
}

const testLengthClassifierResponseRetriesOnce = async (): Promise<void> => {
  const client = new ScriptedIntentClient([
    modelDecisionResponse(decisionResponse({
      taskType: 'conversation',
      skillId: 'general',
      sourceMode: 'conversation',
      resolvedQuestion: '被长度截断的临时分类结果',
      resultMode: 'answer'
    }), 'length'),
    modelDecisionResponse(decisionResponse({
      taskType: 'knowledge_qa',
      skillId: 'general',
      sourceMode: 'knowledge',
      resolvedQuestion: '根据部署规范说明审批流程',
      resultMode: 'answer'
    }))
  ])
  const decision = await new AssistantIntentRouter(settings, client).resolve(
    request('请根据上传的部署规范说明审批流程')
  )

  assertDecisionCore(decision, {
    taskType: 'knowledge_qa',
    sourceMode: 'knowledge',
    resultMode: 'answer'
  })
  assert.equal(client.calls.length, 2, 'a length-truncated classifier response may retry exactly once')
  assertIntentClassifierBudgets(client.calls, [900, 1800])
}

const testClassifierRetryIsCappedAtOneAndFallsBack = async (): Promise<void> => {
  const client = new ScriptedIntentClient([
    emptyModelResponse(),
    emptyModelResponse()
  ])
  const router = new AssistantIntentRouter(settings, client)

  const decision = await router.resolve(request('请处理一下'))
  assert.equal(decision.needsClarification, true)
  assert.match(decision.clarificationQuestion ?? '', /目标|对象/u)
  assert.doesNotMatch(decision.clarificationQuestion ?? '', /任务类型|数据来源|结果形式/u)
  assert.equal(client.calls.length, 2, 'an invalid retry response must not cause a third classifier call')
  assertIntentClassifierBudgets(client.calls, [900, 1800])
}

const testAmbiguousIntentStopsWithClarification = async (): Promise<void> => {
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '处理用户未说明范围的问题',
      resultMode: 'answer',
      needsClarification: true,
      clarificationQuestion: '请补充要查询的记录范围和交付形式。'
    }),
    request('请处理一下')
  )

  assert.equal(decision.needsClarification, true)
  assert.match(decision.clarificationQuestion ?? '', /目标|对象/u)
  assert.doesNotMatch(decision.clarificationQuestion ?? '', /任务类型|数据来源|结果形式|交付形式/u)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)
  assert.doesNotMatch(textOfCalls(client.calls), /inspect_fields|query_records|knowledge\.search|execute_query/u)
}

const testMultiturnGroupingUsesGroundedHistory = async (): Promise<void> => {
  const history: ChatHistoryTurn[] = [
    {
      role: 'user',
      content: '请查询负责人甲和负责人乙各自相关的需求记录。'
    },
    {
      role: 'assistant',
      content: '已找到负责人甲和负责人乙相关记录。'
    }
  ]
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '分别列出负责人甲和负责人乙各自相关的需求记录，不要合并',
      resultMode: 'grouped_list',
      groupEntities: ['负责人甲', '负责人乙']
    }),
    request('分别列出，不要放一起', history)
  )

  assertDecisionCore(decision, {
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resultMode: 'grouped_list'
  })
  assert.deepEqual(entityNames(decision), ['负责人甲', '负责人乙'])
  assert.match(decision.resolvedQuestion, /负责人甲/u)
  assert.match(decision.resolvedQuestion, /负责人乙/u)
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)
}

const testInventedGroupEntityFailsClosed = async (): Promise<void> => {
  const history: ChatHistoryTurn[] = [{
    role: 'user',
    content: '请查询负责人甲和负责人乙的需求记录。'
  }]
  const client = new RecordingIntentClient(decisionResponse({
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: '分别列出负责人甲、负责人乙和负责人丙的需求记录',
    resultMode: 'grouped_list',
    groupEntities: ['负责人甲', '负责人乙', '负责人丙']
  }))
  const router = new AssistantIntentRouter(settings, client)
  try {
    const decision = await router.resolve(request('分别列出，不要放一起', history))
    assert.equal(
      decision.needsClarification,
      true,
      'an entity absent from current question/history must stop execution'
    )
    assert.equal(entityNames(decision).includes('负责人丙'), false)
    assert.doesNotMatch(decision.resolvedQuestion, /负责人丙/u)
  } catch (error) {
    assert.match(String(error), /实体|范围|澄清|未落地|grounded|invalid|unsupported/u)
  }
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls.some((call) => Array.isArray(call.tools) && call.tools.length > 0), false)
}

const testOrdinaryListStaysFlat = async (): Promise<void> => {
  const { decision } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '列出负责人甲的需求记录',
      resultMode: 'list',
      groupEntities: []
    }),
    request('列出负责人甲的需求记录')
  )
  assertDecisionCore(decision, {
    taskType: 'record_query',
    sourceMode: 'records',
    resultMode: 'list'
  })
  assert.deepEqual(entityNames(decision), [])
}

const testComparativeFollowUpNormalizesToAnswer = async (): Promise<void> => {
  const history: ChatHistoryTurn[] = [{
    role: 'user',
    content: '请查询周顺峰和陈立的需求记录。'
  }]
  const { decision } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '哪个人的需求数量更多？',
      resultMode: 'grouped_list',
      groupEntities: ['周顺峰', '陈立']
    }),
    request('哪个人的需求数量更多？', history)
  )
  assert.equal(decision.resultMode, 'answer', 'a comparative follow-up should deliver a conclusion, not only a grouped dump')
  assert.deepEqual(decision.groupEntities, ['周顺峰', '陈立'])
}

const testHistoryCanGroundResolutionWithoutUidLeak = async (): Promise<void> => {
  const history: ChatHistoryTurn[] = [
    {
      role: 'user',
      content: '上一轮查询了负责人甲和负责人乙的需求。'
    },
    {
      role: 'assistant',
      content: '已准备数据视图；完整记录 UID 列表由服务端分页保存。',
      contextRefs: [
        { kind: 'dataView', id: 'field-query:owner', label: '负责人查询', total: 24 },
        { kind: 'record', id: 'record-owner-a', label: '负责人甲' },
        { kind: 'record', id: 'record-owner-b', label: '负责人乙' }
      ]
    }
  ]
  const fullUidList = [
    'record-owner-a-01',
    'record-owner-a-02',
    'record-owner-b-01',
    'record-owner-b-02'
  ]
  const { decision, client } = await resolveWithRecordingClient(
    decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '分别列出负责人甲和负责人乙的需求记录',
      resultMode: 'grouped_list',
      groupEntities: ['负责人甲', '负责人乙']
    }),
    request('分别列出这些记录', history)
  )

  assert.match(decision.resolvedQuestion, /负责人甲/u)
  assert.match(decision.resolvedQuestion, /负责人乙/u)
  const prompt = textOfCalls(client.calls)
  assert.doesNotMatch(prompt, /recordUids/u, 'UID index metadata must stay out of model prompts')
  for (const uid of fullUidList) {
    assert.doesNotMatch(prompt, new RegExp(uid, 'u'), 'full record UID lists must remain in data views')
  }
}

const groupedRecordFixtures = [
  { uid: 'intent-group-a-01', itemId: 'INTENT-GROUP-A-01', name: '需求记录甲-1', owner: '负责人甲' },
  { uid: 'intent-group-a-02', itemId: 'INTENT-GROUP-A-02', name: '需求记录甲-2', owner: '负责人甲' },
  { uid: 'intent-group-b-01', itemId: 'INTENT-GROUP-B-01', name: '需求记录乙-1', owner: '负责人乙' },
  { uid: 'intent-group-b-02', itemId: 'INTENT-GROUP-B-02', name: '需求记录乙-2', owner: '负责人乙' }
] as const

const seedGroupedRecordFixtures = (db: AppDatabase): void => {
  for (const fixture of groupedRecordFixtures) {
    db.upsertRecord({
      uid: fixture.uid,
      projectId: 'intent-group-project',
      nodeType: 'Requirement',
      itemId: fixture.itemId,
      parentId: '',
      name: fixture.name,
      lastModifyTime: new Date(0).toISOString(),
      raw: {
        Owner: fixture.owner,
        Summary: fixture.name,
        _valm_Description: `${fixture.owner} 负责的需求记录。`
      },
      normalizedText: `${fixture.name}：${fixture.owner} 负责的需求记录。`
    })
  }
}

const testGroupedDecisionProducesSeparateDataViewGroups = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-intent-grouped-'))
  const db = new AppDatabase(join(directory, 'intent.db'), join(directory, 'assets'))
  try {
    seedGroupedRecordFixtures(db)
    const history: ChatHistoryTurn[] = [{
      role: 'user',
      content: '请查询负责人甲和负责人乙相关的需求记录。'
    }]
    const decisionClient = new RecordingIntentClient(decisionResponse({
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '分别列出负责人甲和负责人乙各自相关的需求记录，不要合并',
      resultMode: 'grouped_list',
      groupEntities: ['负责人甲', '负责人乙']
    }))
    const intentRouter = new AssistantIntentRouter(settings, decisionClient)
    const decision = await intentRouter.resolve(request('分别列出，不要放一起', history))
    assert.equal(decision.resultMode, 'grouped_list')
    assert.deepEqual(decision.groupEntities, ['负责人甲', '负责人乙'])

    const callInputs: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings)
    const mutableAgent = agent as unknown as Record<string, unknown>
    Object.defineProperty(mutableAgent, 'callModel', {
      configurable: true,
      writable: true,
      value: async (input: ModelChatInput): Promise<ModelResponse> => {
        callInputs.push(input)
        return { message: { role: 'assistant', content: '已按负责人分别整理记录。' } }
      }
    })
    const executionEvents: string[] = ['intent-decision']
    const inspectedAt: string[] = []
    const originalInspectFields = db.inspectFields.bind(db)
    Object.defineProperty(db, 'inspectFields', {
      configurable: true,
      writable: true,
      value: (...args: Parameters<AppDatabase['inspectFields']>) => {
        executionEvents.push('database-inspect')
        inspectedAt.push('inspect_fields')
        return originalInspectFields(...args)
      }
    })
    const result = await agent.ask({
      ...request('分别列出，不要放一起', history),
      assistantIntent: decision
    })

    const groups = result.dataViews.flatMap((view) => view.groups)
    assert.ok(groups.length >= 2, 'grouped_list must expose at least one data group per grounded entity')
    const groupsByName = new Map(groups.map((group) => [group.name, group]))
    for (const entity of decision.groupEntities) {
      const group = groupsByName.get(entity)
      assert.ok(group, `missing separate data view group for ${entity}`)
      assert.ok(group!.rows.length > 0, `${entity} group must contain its matched records`)
      assert.ok(
        group!.rows.every((row) => row.name.includes(entity.replace('负责人', '需求记录'))),
        `${entity} group must not contain another entity's records`
      )
    }
    assert.equal(inspectedAt.length, 1, 'structured evidence lookup happens only after the intent decision')
    assert.ok(
      executionEvents.indexOf('intent-decision') < executionEvents.indexOf('database-inspect'),
      'the intent decision must precede the first database access'
    )
    assert.equal(
      callInputs.length,
      0,
      'records-only grouped answers use deterministic verified rendering after structured grouped data exists'
    )
    const modelPrompt = textOfCalls(callInputs)
    assert.doesNotMatch(modelPrompt, /"recordUids"/u, 'full UID indexes belong to ChatDataView, not model prompts')
    for (const fixture of groupedRecordFixtures) {
      assert.doesNotMatch(modelPrompt, new RegExp(fixture.uid, 'u'))
    }
    const viewUidSet = new Set(result.dataViews.flatMap((view) => view.recordUids ?? []))
    assert.deepEqual(
      [...viewUidSet].sort(),
      groupedRecordFixtures.map((fixture) => fixture.uid).sort(),
      'ChatDataView retains all matched UIDs for paging/detail lookup'
    )
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const spyDatabaseMethod = (db: AppDatabase, method: string): { count: () => number } => {
  const target = db as unknown as Record<string, unknown>
  const original = target[method]
  if (typeof original !== 'function') throw new Error(`database method ${method} is unavailable`)
  let calls = 0
  Object.defineProperty(db, method, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      calls += 1
      return (original as (...innerArgs: unknown[]) => unknown).apply(db, args)
    }
  })
  return { count: () => calls }
}

const testConversationDecisionDoesNotTouchDatabase = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-agent-intent-conversation-'))
  const db = new AppDatabase(join(directory, 'intent.db'), join(directory, 'assets'))
  try {
    const decisionClient = new RecordingIntentClient(decisionResponse({
      taskType: 'conversation',
      skillId: 'general',
      sourceMode: 'conversation',
      resolvedQuestion: '友好回应用户问候',
      resultMode: 'answer'
    }))
    const decision = await new AssistantIntentRouter(settings, decisionClient).resolve(request('你好'))
    const inspectSpy = spyDatabaseMethod(db, 'inspectFields')
    const nodeTypesSpy = spyDatabaseMethod(db, 'listNodeTypes')
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const knowledgeStatsSpy = spyDatabaseMethod(db, 'getKnowledgeStats')
    const answerCalls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings)
    const mutableAgent = agent as unknown as Record<string, unknown>
    Object.defineProperty(mutableAgent, 'callModel', {
      configurable: true,
      writable: true,
      value: async (input: ModelChatInput): Promise<ModelResponse> => {
        answerCalls.push(input)
        return { message: { role: 'assistant', content: '你好，我是 VISSLM AI 助手。' } }
      }
    })
    const result = await agent.ask({
      ...request('你好'),
      assistantIntent: decision
    })
    assert.equal(inspectSpy.count(), 0, 'conversation must not inspect the field catalog')
    assert.equal(nodeTypesSpy.count(), 0, 'conversation must not enumerate local node types')
    assert.equal(querySpy.count(), 0, 'conversation must not query records')
    assert.equal(knowledgeStatsSpy.count(), 0, 'conversation must not inspect knowledge index status')
    assert.equal(result.sources.length, 0)
    assert.equal(result.dataViews.length, 0)
    assert.equal(answerCalls.length, 1)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testFunctionalExportMatchesClassContract = async (): Promise<void> => {
  const decision = await resolveAssistantIntent(
    request('你好，你是谁？'),
    settings,
    new RecordingIntentClient(decisionResponse({
      taskType: 'conversation',
      skillId: 'general',
      sourceMode: 'conversation',
      resultMode: 'answer'
    }))
  )
  assertDecisionCore(decision, {
    taskType: 'conversation',
    skillId: 'general',
    sourceMode: 'conversation',
    resultMode: 'answer'
  })
}

const main = async (): Promise<void> => {
  await testConversationIsFirstAndSourceFree()
  await testVisualizationSelectsSkillBeforeEvidence()
  await testExactRequirementIdKeepsRequirementSkill()
  await testKnowledgeAndMixedUseDeclaredSources()
  await testKnowledgeQuestionRoutesWithOneClosedThinkingCall()
  await testEmptyClassifierResponseRetriesOnce()
  await testLengthClassifierResponseRetriesOnce()
  await testClassifierRetryIsCappedAtOneAndFallsBack()
  await testAmbiguousIntentStopsWithClarification()
  await testMultiturnGroupingUsesGroundedHistory()
  await testInventedGroupEntityFailsClosed()
  await testOrdinaryListStaysFlat()
  await testComparativeFollowUpNormalizesToAnswer()
  await testHistoryCanGroundResolutionWithoutUidLeak()
  await testGroupedDecisionProducesSeparateDataViewGroups()
  await testConversationDecisionDoesNotTouchDatabase()
  await testFunctionalExportMatchesClassContract()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'conversation intent is source-free before evidence execution',
      'visualization intent selects its skill before evidence execution',
      'exact requirement IDs preserve requirement analysis routing',
      'knowledge and mixed modes preserve their declared source contract',
      'GJB5000B knowledge questions route to knowledge with one closed-thinking call',
      'empty classifier responses retry once with the expanded budget',
      'length-truncated classifier responses retry once with the expanded budget',
      'classifier retries are capped and degrade to a concrete clarification',
      'ambiguous intent stops with clarification and no tools',
      'multiturn grouping inherits only grounded entities',
      'invented entities fail closed',
      'ordinary lists remain flat',
      'comparative follow-ups deliver an answer while retaining grounded entities',
      'history may ground resolution without leaking UID indexes',
      'grouped decisions produce separate grounded data-view groups',
      'conversation decisions avoid database and knowledge status access',
      'class and functional intent-router exports share the contract'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
