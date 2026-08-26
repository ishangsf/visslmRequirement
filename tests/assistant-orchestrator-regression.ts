import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { KnowledgeService, type KnowledgeSearchHit } from '../src/main/knowledge'
import { OllamaAgent } from '../src/main/ollama'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import {
  assertAssistantAgentToolAllowed,
  assistantExecutionAgentRegistry,
  getAssistantExecutionAgent,
  resolveAssistantExecutionRoute,
  validateAssistantExecutionRoute
} from '../src/main/assistant/agent-registry'
import {
  attachAssistantTaskTrace,
  createAssistantTaskTrace,
  traceContextFromDecision
} from '../src/main/assistant/task-trace'
import type {
  AssistantExecutionAgentId,
  AssistantIntentDecision,
  AssistantTaskTrace,
  ChatRequest,
  ModelSettings
} from '../src/shared/types'

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-orchestrator-regression-model',
  thinking: false,
  apiKey: 'assistant-orchestrator-regression-key'
}

const answerResponse = (content: string): ModelResponse => ({
  message: { role: 'assistant', content }
})

const decision = (
  input: Partial<AssistantIntentDecision> & Pick<AssistantIntentDecision, 'taskType' | 'sourceMode'>
): AssistantIntentDecision => ({
  taskType: input.taskType,
  skillId: input.skillId ?? 'general',
  sourceMode: input.sourceMode,
  resolvedQuestion: input.resolvedQuestion ?? '按已确认范围执行当前任务',
  resultMode: input.resultMode ?? 'answer',
  groupEntities: input.groupEntities ?? [],
  needsClarification: input.needsClarification ?? false,
  ...(input.clarificationQuestion === undefined
    ? {}
    : { clarificationQuestion: input.clarificationQuestion }),
  reason: input.reason ?? 'orchestrator regression fixture'
})

const requestWithDecision = (
  question: string,
  assistantIntent: AssistantIntentDecision
): ChatRequest => ({
  question,
  projectId: 'assistant-orchestrator-project',
  chatMode: 'auto',
  entrypoint: 'chat',
  assistantIntent
})

const spyDatabaseMethod = (db: AppDatabase, method: keyof AppDatabase): { count: () => number } => {
  const target = db as unknown as Record<string, unknown>
  const original = target[method as string]
  if (typeof original !== 'function') throw new Error(`database method ${String(method)} is unavailable`)
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

const spyExecutionAgentMethod = (
  agent: OllamaAgent,
  property: 'dataCenterAgent' | 'knowledgeBaseAgent',
  method: 'executePlan' | 'search'
): { count: () => number } => {
  const agentObject = (agent as unknown as Record<string, unknown>)[property]
  if (!agentObject || typeof agentObject !== 'object') {
    throw new Error(`OllamaAgent.${property} is unavailable`)
  }
  const target = agentObject as Record<string, unknown>
  const original = target[method]
  if (typeof original !== 'function') throw new Error(`${property}.${method} is unavailable`)
  let calls = 0
  Object.defineProperty(target, method, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      calls += 1
      return (original as (...innerArgs: unknown[]) => unknown).apply(target, args)
    }
  })
  return { count: () => calls }
}

const installAnswerModel = (
  agent: OllamaAgent,
  calls: ModelChatInput[],
  response = '已依据真实来源完成回答。'
): void => {
  const mutableAgent = agent as unknown as Record<string, unknown>
  Object.defineProperty(mutableAgent, 'callModel', {
    configurable: true,
    writable: true,
    value: async (input: ModelChatInput): Promise<ModelResponse> => {
      calls.push(input)
      return answerResponse(response)
    }
  })
}

const seedRecord = (db: AppDatabase): void => {
  db.upsertRecord({
    uid: 'orchestrator-record-001',
    projectId: 'assistant-orchestrator-project',
    nodeType: 'Requirement',
    itemId: 'ORCHESTRATOR-001',
    parentId: '',
    name: '负责人甲的需求记录',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      Owner: '负责人甲',
      Summary: '负责人甲的需求记录',
      _valm_Description: '负责人甲负责的数据中心记录。'
    },
    normalizedText: '负责人甲的需求记录：负责人甲负责的数据中心记录。'
  })
}

const documentHit = (): KnowledgeSearchHit => ({
  source: {
    uid: 'document:orchestrator-guide',
    name: '编排规范文档',
    nodeType: 'knowledge_document',
    itemId: 'orchestrator-guide',
    sourceType: 'document',
    documentId: 'orchestrator-guide',
    chunkId: 'orchestrator-guide-0',
    fileName: '编排规范文档.md',
    location: '第 1 页',
    snippet: '文档来源的编排证据。'
  },
  chunk: {
    id: 'orchestrator-guide-0',
    documentId: 'orchestrator-guide',
    sourceType: 'document',
    sourceName: '编排规范文档',
    content: '文档来源的编排证据。',
    chunkIndex: 0,
    location: '第 1 页',
    charStart: 0,
    charEnd: 10
  },
  score: 0.9
})

const newDatabase = async (prefix: string): Promise<{
  directory: string
  db: AppDatabase
}> => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  return {
    directory,
    db: new AppDatabase(join(directory, 'assistant-orchestrator.db'), join(directory, 'assets'))
  }
}

const closeDatabase = async (directory: string, db: AppDatabase): Promise<void> => {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const testExecutionRegistryContract = (): void => {
  const expectedIds: AssistantExecutionAgentId[] = [
    'conversation',
    'data-center',
    'knowledge-base',
    'requirement-analysis',
    'visualization',
    'artifact'
  ]
  assert.deepEqual(
    [...assistantExecutionAgentRegistry.map((agent) => agent.id)].sort(),
    [...expectedIds].sort(),
    'the registry must expose every required execution agent exactly once'
  )
  assert.equal(new Set(assistantExecutionAgentRegistry.map((agent) => agent.id)).size, expectedIds.length)
  for (const agent of assistantExecutionAgentRegistry) {
    assert.ok(agent.version.trim().length > 0)
    assert.ok(agent.name.trim().length > 0)
    assert.equal(Array.isArray(agent.supportedTaskTypes), true)
    assert.equal(Array.isArray(agent.allowedSources), true)
    assert.equal(Array.isArray(agent.allowedTools), true)
    assert.equal(typeof agent.readonly, 'boolean')
    assert.equal(agent.allowedTools.includes('knowledge.search'), false)
    assert.equal(agent.allowedTools.includes('query_records'), false)
    assert.equal(getAssistantExecutionAgent(agent.id)?.version, agent.version)
  }

  const routeCases: Array<{
    taskType: AssistantIntentDecision['taskType']
    sourceMode: AssistantIntentDecision['sourceMode']
    primaryAgent: AssistantExecutionAgentId
    agents: AssistantExecutionAgentId[]
  }> = [
    { taskType: 'conversation', sourceMode: 'conversation', primaryAgent: 'conversation', agents: ['conversation'] },
    { taskType: 'record_query', sourceMode: 'records', primaryAgent: 'data-center', agents: ['data-center'] },
    { taskType: 'knowledge_qa', sourceMode: 'knowledge', primaryAgent: 'knowledge-base', agents: ['knowledge-base'] },
    {
      taskType: 'mixed_analysis',
      sourceMode: 'mixed',
      primaryAgent: 'data-center',
      agents: ['data-center', 'knowledge-base']
    },
    { taskType: 'visualization', sourceMode: 'records', primaryAgent: 'visualization', agents: ['visualization'] },
    {
      taskType: 'requirement_matching',
      sourceMode: 'records',
      primaryAgent: 'requirement-analysis',
      agents: ['requirement-analysis']
    },
    { taskType: 'artifact_generation', sourceMode: 'mixed', primaryAgent: 'artifact', agents: ['artifact'] }
  ]
  for (const routeCase of routeCases) {
    const route = resolveAssistantExecutionRoute(routeCase.taskType, routeCase.sourceMode)
    assert.equal(route.primaryAgent, routeCase.primaryAgent)
    assert.deepEqual(route.agents.map((agent) => agent.id), routeCase.agents)
    for (const agent of route.agents) {
      assert.ok(agent.supportedTaskTypes.includes(routeCase.taskType))
      assert.ok(agent.allowedSources.includes(routeCase.sourceMode))
    }
    const validated = validateAssistantExecutionRoute({
      taskType: routeCase.taskType,
      sourceMode: routeCase.sourceMode
    })
    assert.equal(validated.ok, true)
  }

  assert.throws(
    () => resolveAssistantExecutionRoute('record_query', 'knowledge'),
    /未注册|不支持|不允许/u,
    'an illegal task/source pair must fail closed'
  )
  assert.throws(
    () => resolveAssistantExecutionRoute('conversation', 'records'),
    /未注册|不支持|不允许/u
  )
  const invalid = validateAssistantExecutionRoute({
    taskType: 'record_query',
    sourceMode: 'knowledge'
  })
  assert.equal(invalid.ok, false)
  assert.equal(getAssistantExecutionAgent('unknown-agent' as AssistantExecutionAgentId), undefined)
  assert.doesNotThrow(() => assertAssistantAgentToolAllowed('data-center', 'query_records_by_fields'))
  assert.doesNotThrow(() => assertAssistantAgentToolAllowed('knowledge-base', 'search_document_chunks'))
  assert.doesNotThrow(() => assertAssistantAgentToolAllowed('artifact', 'render_docx'))
  assert.throws(
    () => assertAssistantAgentToolAllowed('data-center', 'search_document_chunks'),
    /不允许工具/u,
    'a data-center Agent must not call a knowledge-base tool'
  )
  assert.throws(
    () => assertAssistantAgentToolAllowed('knowledge-base', 'query_records_by_fields'),
    /不允许工具/u,
    'a knowledge-base Agent must not call a data-center tool'
  )
}

const assertTraceShape = (
  trace: AssistantTaskTrace,
  expected: {
    status: AssistantTaskTrace['status']
    primaryAgent: AssistantExecutionAgentId
    invokedAgents: AssistantExecutionAgentId[]
    taskType: AssistantTaskTrace['taskType']
    sourceMode: AssistantTaskTrace['sourceMode']
    resultMode: AssistantTaskTrace['resultMode']
  }
): void => {
  assert.equal(typeof trace.runId, 'string')
  assert.ok(trace.runId.length > 0)
  assert.equal(trace.status, expected.status)
  assert.equal(trace.primaryAgent, expected.primaryAgent)
  assert.deepEqual(trace.invokedAgents, expected.invokedAgents)
  assert.equal(trace.taskType, expected.taskType)
  assert.equal(trace.sourceMode, expected.sourceMode)
  assert.equal(trace.resultMode, expected.resultMode)
  assert.doesNotThrow(() => new Date(trace.startedAt).toISOString())
  assert.doesNotThrow(() => new Date(trace.completedAt).toISOString())
  assert.ok(new Date(trace.completedAt).getTime() >= new Date(trace.startedAt).getTime())
}

const testTaskTraceContract = (): void => {
  const mixedDecision = decision({
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'grouped_list',
    groupEntities: ['负责人甲', '负责人乙']
  })
  const context = traceContextFromDecision(mixedDecision)
  assert.deepEqual(context, {
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'grouped_list',
    primaryAgent: 'data-center',
    invokedAgents: ['data-center', 'knowledge-base']
  })

  const completed = createAssistantTaskTrace(context, {
    runId: 'trace-completed-001',
    startedAt: '2026-08-26T00:00:00.000Z',
    status: 'completed'
  })
  assertTraceShape(completed, {
    status: 'completed',
    primaryAgent: 'data-center',
    invokedAgents: ['data-center', 'knowledge-base'],
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'grouped_list'
  })
  assert.equal(completed.runId, 'trace-completed-001')
  assert.equal(completed.error, undefined)

  const clarification = createAssistantTaskTrace(context, {
    runId: 'trace-clarification-001',
    startedAt: '2026-08-26T00:00:00.000Z',
    status: 'clarification',
    clarificationQuestion: '请明确数据范围。'
  })
  assertTraceShape(clarification, {
    status: 'clarification',
    primaryAgent: 'data-center',
    invokedAgents: [],
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'grouped_list'
  })
  assert.equal(clarification.clarificationQuestion, '请明确数据范围。')
  assert.equal(clarification.status === 'completed', false)

  const failed = createAssistantTaskTrace(context, {
    runId: 'trace-failed-001',
    startedAt: '2026-08-26T00:00:00.000Z',
    status: 'failed',
    error: { code: 'AGENT_EXECUTION_FAILED', message: '数据中心查询失败' }
  })
  assertTraceShape(failed, {
    status: 'failed',
    primaryAgent: 'data-center',
    invokedAgents: ['data-center', 'knowledge-base'],
    taskType: 'mixed_analysis',
    sourceMode: 'mixed',
    resultMode: 'grouped_list'
  })
  assert.equal(failed.status === 'completed', false)
  assert.deepEqual(failed.error, {
    code: 'AGENT_EXECUTION_FAILED',
    message: '数据中心查询失败'
  })

  const attached = attachAssistantTaskTrace(
    { answer: '已完成', sources: [], dataViews: [] },
    context,
    { runId: 'trace-attached-001', startedAt: '2026-08-26T00:00:00.000Z' }
  )
  assert.equal(attached.taskTrace?.runId, 'trace-attached-001')
  assert.equal(attached.taskTrace?.status, 'completed')
  assert.equal(attached.taskTrace?.primaryAgent, 'data-center')
}

const testConversationDoesNotInvokeEvidenceAgents = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-conversation-')
  try {
    const route = resolveAssistantExecutionRoute('conversation', 'conversation')
    assert.deepEqual(route.agents.map((agent) => agent.id), ['conversation'])
    const knowledgeCalls: string[] = []
    const knowledge = {
      modelVersion: 'assistant-orchestrator-model',
      search: async (query: string) => {
        knowledgeCalls.push(query)
        return []
      }
    } as unknown as KnowledgeService
    const inspectSpy = spyDatabaseMethod(db, 'inspectFields')
    const listNodeTypesSpy = spyDatabaseMethod(db, 'listNodeTypes')
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const knowledgeStatsSpy = spyDatabaseMethod(db, 'getKnowledgeStats')
    const calls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings, knowledge)
    const dataCenterAgentCalls = spyExecutionAgentMethod(agent, 'dataCenterAgent', 'executePlan')
    const knowledgeBaseAgentCalls = spyExecutionAgentMethod(agent, 'knowledgeBaseAgent', 'search')
    installAnswerModel(agent, calls, '你好，我是通用对话 Agent。')

    const result = await agent.ask(requestWithDecision(
      '你好，你是谁？',
      decision({ taskType: 'conversation', sourceMode: 'conversation' })
    ))
    assert.equal(knowledgeCalls.length, 0)
    assert.equal(inspectSpy.count(), 0)
    assert.equal(listNodeTypesSpy.count(), 0)
    assert.equal(querySpy.count(), 0)
    assert.equal(knowledgeStatsSpy.count(), 0)
    assert.equal(dataCenterAgentCalls.count(), 0)
    assert.equal(knowledgeBaseAgentCalls.count(), 0)
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.dataViews, [])
    assert.equal(calls.length, 1)
    assert.ok(result.taskTrace)
    assert.equal(result.taskTrace?.status, 'completed')
    assert.equal(result.taskTrace?.primaryAgent, 'conversation')
    assert.deepEqual(result.taskTrace?.invokedAgents, ['conversation'])
  } finally {
    await closeDatabase(directory, db)
  }
}

const testRecordsInvokeDataCenterOnly = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-records-')
  try {
    seedRecord(db)
    const route = resolveAssistantExecutionRoute('record_query', 'records')
    assert.deepEqual(route.agents.map((agent) => agent.id), ['data-center'])
    const knowledgeCalls: string[] = []
    const knowledge = {
      modelVersion: 'assistant-orchestrator-model',
      search: async (query: string) => {
        knowledgeCalls.push(query)
        return [documentHit()]
      }
    } as unknown as KnowledgeService
    const inspectSpy = spyDatabaseMethod(db, 'inspectFields')
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const calls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings, knowledge)
    const dataCenterAgentCalls = spyExecutionAgentMethod(agent, 'dataCenterAgent', 'executePlan')
    const knowledgeBaseAgentCalls = spyExecutionAgentMethod(agent, 'knowledgeBaseAgent', 'search')
    installAnswerModel(agent, calls)

    const result = await agent.ask(requestWithDecision(
      '分别列出负责人甲的需求记录',
      decision({
        taskType: 'record_query',
        sourceMode: 'records',
        resultMode: 'grouped_list',
        groupEntities: ['负责人甲']
      })
    ))
    assert.equal(inspectSpy.count(), 1)
    assert.equal(querySpy.count(), 1)
    assert.equal(dataCenterAgentCalls.count(), 1, 'records must invoke the data-center execution Agent')
    assert.equal(knowledgeBaseAgentCalls.count(), 0)
    assert.equal(knowledgeCalls.length, 0, 'records must invoke only the data-center executor')
    assert.ok(result.dataViews.length > 0)
    assert.deepEqual(result.dataViews[0]?.recordUids, ['orchestrator-record-001'])
    assert.ok(result.sources.every((source) => source.sourceType === 'record'))
    assert.equal(calls.length, 1)
    assert.ok(result.taskTrace)
    assert.equal(result.taskTrace?.status, 'completed')
    assert.equal(result.taskTrace?.primaryAgent, 'data-center')
    assert.deepEqual(result.taskTrace?.invokedAgents, ['data-center'])
  } finally {
    await closeDatabase(directory, db)
  }
}

const testKnowledgeInvokesKnowledgeBaseOnly = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-knowledge-')
  try {
    const route = resolveAssistantExecutionRoute('knowledge_qa', 'knowledge')
    assert.deepEqual(route.agents.map((agent) => agent.id), ['knowledge-base'])
    const knowledgeCalls: Array<{ query: string; limit?: number; sourceType?: string }> = []
    const knowledge = {
      modelVersion: 'assistant-orchestrator-model',
      search: async (
        query: string,
        limit?: number,
        options?: { sourceType?: string }
      ) => {
        knowledgeCalls.push({ query, limit, sourceType: options?.sourceType })
        return [documentHit()]
      }
    } as unknown as KnowledgeService
    const inspectSpy = spyDatabaseMethod(db, 'inspectFields')
    const listNodeTypesSpy = spyDatabaseMethod(db, 'listNodeTypes')
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const calls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings, knowledge)
    const dataCenterAgentCalls = spyExecutionAgentMethod(agent, 'dataCenterAgent', 'executePlan')
    const knowledgeBaseAgentCalls = spyExecutionAgentMethod(agent, 'knowledgeBaseAgent', 'search')
    installAnswerModel(agent, calls, '仅依据文档证据回答。')

    const result = await agent.ask(requestWithDecision(
      '请根据上传的编排规范文档回答',
      decision({
        taskType: 'knowledge_qa',
        sourceMode: 'knowledge',
        resolvedQuestion: '请根据上传的编排规范文档回答'
      })
    ))
    assert.deepEqual(knowledgeCalls, [{
      query: '请根据上传的编排规范文档回答',
      limit: 8,
      sourceType: 'document'
    }])
    assert.equal(inspectSpy.count(), 0)
    assert.equal(listNodeTypesSpy.count(), 0)
    assert.equal(querySpy.count(), 0, 'knowledge must not invoke the data-center executor')
    assert.equal(dataCenterAgentCalls.count(), 0)
    assert.equal(knowledgeBaseAgentCalls.count(), 1, 'knowledge must invoke the knowledge-base execution Agent')
    assert.deepEqual(result.sources.map((source) => source.sourceType), ['document'])
    assert.deepEqual(result.dataViews, [])
    assert.equal(calls.length, 1)
    assert.ok(result.taskTrace)
    assert.equal(result.taskTrace?.status, 'completed')
    assert.equal(result.taskTrace?.primaryAgent, 'knowledge-base')
    assert.deepEqual(result.taskTrace?.invokedAgents, ['knowledge-base'])
  } finally {
    await closeDatabase(directory, db)
  }
}

const testMixedInvokesBothAndPreservesProvenance = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-mixed-')
  try {
    seedRecord(db)
    const route = resolveAssistantExecutionRoute('mixed_analysis', 'mixed')
    assert.deepEqual(route.agents.map((agent) => agent.id), ['data-center', 'knowledge-base'])
    const knowledgeCalls: Array<{ query: string; sourceType?: string }> = []
    const knowledge = {
      modelVersion: 'assistant-orchestrator-model',
      search: async (query: string, _limit?: number, options?: { sourceType?: string }) => {
        knowledgeCalls.push({ query, sourceType: options?.sourceType })
        return [documentHit()]
      }
    } as unknown as KnowledgeService
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const calls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings, knowledge)
    const dataCenterAgentCalls = spyExecutionAgentMethod(agent, 'dataCenterAgent', 'executePlan')
    const knowledgeBaseAgentCalls = spyExecutionAgentMethod(agent, 'knowledgeBaseAgent', 'search')
    installAnswerModel(agent, calls, '已综合记录和文档证据。')

    const result = await agent.ask(requestWithDecision(
      '结合负责人甲的记录和编排规范文档回答',
      decision({
        taskType: 'mixed_analysis',
        sourceMode: 'mixed',
        resolvedQuestion: '结合负责人甲的记录和编排规范文档回答',
        resultMode: 'grouped_list',
        groupEntities: ['负责人甲']
      })
    ))
    assert.equal(querySpy.count(), 1)
    assert.equal(dataCenterAgentCalls.count(), 1, 'mixed must invoke data-center exactly once')
    assert.equal(knowledgeBaseAgentCalls.count(), 1, 'mixed must invoke knowledge-base exactly once')
    assert.deepEqual(knowledgeCalls, [{
      query: '结合负责人甲的记录和编排规范文档回答',
      sourceType: 'document'
    }])
    assert.deepEqual(
      result.sources.map((source) => source.sourceType).sort(),
      ['document', 'record']
    )
    assert.ok(result.sources.some((source) => source.uid === 'orchestrator-record-001' && source.sourceType === 'record'))
    assert.ok(result.sources.some((source) => source.uid === 'document:orchestrator-guide' && source.sourceType === 'document'))
    assert.deepEqual(result.dataViews[0]?.recordUids, ['orchestrator-record-001'])
    const modelPrompt = calls
      .flatMap((call) => call.messages)
      .map((message) => String(message.content))
      .join('\n')
    assert.doesNotMatch(modelPrompt, /"recordUids"/u)
    assert.doesNotMatch(modelPrompt, /orchestrator-record-001/u)
    assert.ok(result.taskTrace)
    assert.equal(result.taskTrace?.status, 'completed')
    assert.equal(result.taskTrace?.primaryAgent, 'data-center')
    assert.deepEqual(result.taskTrace?.invokedAgents, ['data-center', 'knowledge-base'])
  } finally {
    await closeDatabase(directory, db)
  }
}

const testClarificationStopsBeforeEveryExecutor = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-clarification-')
  try {
    seedRecord(db)
    const knowledgeCalls: string[] = []
    const knowledge = {
      modelVersion: 'assistant-orchestrator-model',
      search: async (query: string) => {
        knowledgeCalls.push(query)
        return [documentHit()]
      }
    } as unknown as KnowledgeService
    const inspectSpy = spyDatabaseMethod(db, 'inspectFields')
    const querySpy = spyDatabaseMethod(db, 'queryRecordsByFields')
    const statsSpy = spyDatabaseMethod(db, 'getKnowledgeStats')
    const calls: ModelChatInput[] = []
    const agent = new OllamaAgent(db, settings, knowledge)
    installAnswerModel(agent, calls, '不应调用回答模型。')

    const clarificationDecision = decision({
      taskType: 'mixed_analysis',
      sourceMode: 'mixed',
      needsClarification: true,
      clarificationQuestion: '请明确数据范围和文档范围。'
    })
    const result = await agent.ask(requestWithDecision('请处理一下', clarificationDecision))
    assert.equal(result.needsClarification, true)
    assert.equal(result.clarificationQuestion, '请明确数据范围和文档范围。')
    assert.equal(inspectSpy.count(), 0)
    assert.equal(querySpy.count(), 0)
    assert.equal(statsSpy.count(), 0)
    assert.equal(knowledgeCalls.length, 0)
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.dataViews, [])
    assert.deepEqual(traceContextFromDecision(clarificationDecision).invokedAgents, ['data-center', 'knowledge-base'])
    const trace = createAssistantTaskTrace(traceContextFromDecision(clarificationDecision), {
      status: 'clarification',
      clarificationQuestion: result.clarificationQuestion
    })
    assert.equal(trace.status, 'clarification')
    assert.deepEqual(trace.invokedAgents, [], 'clarification must report no invoked execution agents')
    assert.ok(result.taskTrace)
    assert.equal(result.taskTrace?.status, 'clarification')
    assert.deepEqual(result.taskTrace?.invokedAgents, [])
    assert.equal(calls.length, 0)
  } finally {
    await closeDatabase(directory, db)
  }
}

const testFailureDoesNotFabricateCompletedTrace = async (): Promise<void> => {
  const { directory, db } = await newDatabase('assistant-orchestrator-failed-')
  try {
    seedRecord(db)
    Object.defineProperty(db, 'queryRecordsByFields', {
      configurable: true,
      writable: true,
      value: (..._args: Parameters<AppDatabase['queryRecordsByFields']>) => {
        throw new Error('simulated data-center failure')
      }
    })
    const agent = new OllamaAgent(db, settings)
    installAnswerModel(agent, [])
    await assert.rejects(
      agent.ask(requestWithDecision(
        '分别列出负责人甲的需求记录',
        decision({
          taskType: 'record_query',
          sourceMode: 'records',
          resultMode: 'grouped_list',
          groupEntities: ['负责人甲']
        })
      )),
      /查询计划执行或结果校验失败|simulated data-center failure/u,
      'executor failures must reject rather than masquerade as a completed answer'
    )
    const failed = createAssistantTaskTrace(
      traceContextFromDecision(decision({ taskType: 'record_query', sourceMode: 'records' })),
      {
        status: 'failed',
        error: { code: 'DATA_CENTER_EXECUTION_FAILED', message: 'simulated data-center failure' }
      }
    )
    assert.equal(failed.status, 'failed')
    assert.notEqual(failed.status, 'completed')
    assert.equal(failed.error?.code, 'DATA_CENTER_EXECUTION_FAILED')
  } finally {
    await closeDatabase(directory, db)
  }
}

const main = async (): Promise<void> => {
  testExecutionRegistryContract()
  testTaskTraceContract()
  await testConversationDoesNotInvokeEvidenceAgents()
  await testRecordsInvokeDataCenterOnly()
  await testKnowledgeInvokesKnowledgeBaseOnly()
  await testMixedInvokesBothAndPreservesProvenance()
  await testClarificationStopsBeforeEveryExecutor()
  await testFailureDoesNotFabricateCompletedTrace()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'execution registry declares stable source-aware agents and rejects illegal routes',
      'completed clarification and failed task traces have stable structures',
      'conversation invokes no evidence executor',
      'records invoke data-center only',
      'knowledge invokes knowledge-base only with document evidence',
      'mixed invokes both executors and preserves provenance',
      'clarification stops before database, index and execution agents',
      'executor failure cannot masquerade as completed'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
