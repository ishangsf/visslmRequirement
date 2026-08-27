import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { DataCenterAgent } from '../src/main/assistant/agents/data-center-agent'
import { OllamaAgent } from '../src/main/ollama'
import type { DataCenterQueryPlan } from '../src/main/assistant/agents/data-center-agent'
import type { ChatRequest, ModelSettings } from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-planner-recovery-regression-model',
  thinking: false,
  apiKey: 'assistant-planner-recovery-regression-key'
}

type PlanQuestion = (request: ChatRequest, groundingQuestion?: string) => Promise<DataCenterQueryPlan>

const planQuestionOf = (agent: OllamaAgent): PlanQuestion => (
  (agent as unknown as { planQuestion: PlanQuestion }).planQuestion.bind(agent)
)

const installModel = (
  agent: OllamaAgent,
  handler: (input: ModelChatInput) => Promise<ModelResponse> | ModelResponse
): void => {
  Object.defineProperty(agent, 'callModel', {
    configurable: true,
    value: handler
  })
}

const recordIntent = (question: string): NonNullable<ChatRequest['assistantIntent']> => ({
  taskType: 'record_query',
  skillId: 'general',
  sourceMode: 'records',
  resolvedQuestion: question,
  resultMode: 'answer',
  groupEntities: [],
  needsClarification: false,
  reason: 'regression fixture'
})

const response = (value: Record<string, unknown>): ModelResponse => ({
  message: { role: 'assistant', content: JSON.stringify(value) }
})

const textResponse = (content: string): ModelResponse => ({
  message: { role: 'assistant', content }
})

const seedCountFixture = (db: AppDatabase): {
  totalCount: number
  matchingCount: number
  ownerCount: number
} => {
  const records = Array.from({ length: 64 }, (_unused, index) => {
    const owner = index < 17 ? '周顺峰' : '负责人乙'
    return {
      uid: `planner-count-matching-${index + 1}`,
      projectId: 'planner-recovery-project',
      nodeType: 'Requirement',
      itemId: `PLANNER-MATCH-${index + 1}`,
      parentId: '',
      name: `统一认证需求 ${index + 1}`,
      lastModifyTime: new Date(0).toISOString(),
      raw: {
        Owner: owner,
        Summary: `统一认证改造需求 ${index + 1}`,
        _valm_Description: `${owner} 负责的统一认证业务记录。`
      },
      normalizedText: `统一认证改造需求 ${index + 1}：${owner} 负责的统一认证业务记录。`
    }
  })
  records.push({
    uid: 'planner-count-extra-001',
    projectId: 'planner-recovery-project',
    nodeType: 'Requirement',
    itemId: 'PLANNER-EXTRA-001',
    parentId: '',
    name: '支付改造需求',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      Owner: '负责人乙',
      Summary: '支付改造需求',
      _valm_Description: '支付业务记录。'
    },
    normalizedText: '支付改造需求：负责人乙负责的支付业务记录。'
  })
  db.upsertRecords(records)
  return { totalCount: records.length, matchingCount: 64, ownerCount: 17 }
}

const countIntent = (
  question: string,
  groupEntities: string[] = []
): NonNullable<ChatRequest['assistantIntent']> => ({
  ...recordIntent(question),
  groupEntities
})

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-planner-recovery-'))
  const db = new AppDatabase(join(directory, 'planner.db'), join(directory, 'assets'))
  try {
    const truth = seedCountFixture(db)
    new QueryEngine(db).updateFieldProfileSemantics(
      { projectIds: ['planner-recovery-project'] },
      'Owner',
      { displayName: '负责人', role: 'dimension', synonyms: ['负责人'] }
    )
    const dataCenter = new DataCenterAgent(db)

    const qualifiedQuestion = '周顺峰相关需求一共有多少条？'
    const qualifiedAgent = new OllamaAgent(db, settings)
    installModel(qualifiedAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const qualifiedPlan = await planQuestionOf(qualifiedAgent)({
      question: qualifiedQuestion,
      assistantIntent: recordIntent(qualifiedQuestion)
    } as ChatRequest)
    assert.equal(qualifiedPlan.sourceMode, 'records')
    assert.equal(qualifiedPlan.intent, 'count_matching')
    assert.equal(qualifiedPlan.resultMode, 'answer')
    assert.deepEqual(qualifiedPlan.searchTerms, ['周顺峰'])
    assert.equal(qualifiedPlan.needsClarification, false)

    const totalQuestion = '当前数据中心一共有多少条需求？'
    const totalAgent = new OllamaAgent(db, settings)
    installModel(totalAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const totalPlan = await planQuestionOf(totalAgent)({
      question: totalQuestion,
      assistantIntent: recordIntent(totalQuestion)
    } as ChatRequest)
    assert.equal(totalPlan.intent, 'total')
    assert.equal(totalPlan.metric, 'record_count')
    assert.deepEqual(totalPlan.searchTerms, [])
    assert.equal(totalPlan.needsClarification, false)

    const broadListQuestion = '请列出当前数据中心里的需求记录'
    const broadListAgent = new OllamaAgent(db, settings)
    installModel(broadListAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const broadListPlan = await planQuestionOf(broadListAgent)({
      question: broadListQuestion,
      assistantIntent: {
        ...recordIntent(broadListQuestion),
        resultMode: 'list'
      }
    } as ChatRequest)
    assert.equal(broadListPlan.intent, 'filter_records')
    assert.equal(broadListPlan.resultMode, 'list')
    assert.deepEqual(broadListPlan.searchTerms, [])
    assert.equal(broadListPlan.needsClarification, false, 'an explicit request to list the current records must not ask for a redundant scope')

    const ownerListQuestion = '列出周顺峰负责的需求记录'
    const ownerListAgent = new OllamaAgent(db, settings)
    installModel(ownerListAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const ownerListPlan = await planQuestionOf(ownerListAgent)({
      question: ownerListQuestion,
      assistantIntent: {
        ...recordIntent(ownerListQuestion),
        resolvedQuestion: '列出负责人为周顺峰的需求记录',
        resultMode: 'list'
      }
    } as ChatRequest, '列出负责人为周顺峰的需求记录')
    assert.equal(ownerListPlan.intent, 'filter_records')
    assert.deepEqual(ownerListPlan.searchTerms, ['周顺峰'])
    assert.equal(ownerListPlan.needsClarification, false)

    const explicitCodeQuestion = '查询需求代号 ZX-不存在-2026 的记录'
    const explicitCodeAgent = new OllamaAgent(db, settings)
    installModel(explicitCodeAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const explicitCodePlan = await planQuestionOf(explicitCodeAgent)({
      question: explicitCodeQuestion,
      assistantIntent: {
        ...recordIntent(explicitCodeQuestion),
        resultMode: 'list'
      }
    } as ChatRequest)
    assert.equal(explicitCodePlan.intent, 'filter_records')
    assert.equal(explicitCodePlan.resultMode, 'list')
    assert.deepEqual(explicitCodePlan.searchTerms, ['ZX-不存在-2026'])
    assert.equal(explicitCodePlan.needsClarification, false, 'an explicit requirement code must remain a grounded zero-result lookup')

    const groupedCountQuestion = '分别统计周顺峰和负责人乙各自负责的需求数量'
    const groupedCountAgent = new OllamaAgent(db, settings)
    installModel(groupedCountAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const groupedCountPlan = await planQuestionOf(groupedCountAgent)({
      question: groupedCountQuestion,
      assistantIntent: {
        ...recordIntent(groupedCountQuestion),
        resultMode: 'grouped_list',
        groupEntities: ['周顺峰', '负责人乙']
      }
    } as ChatRequest)
    assert.equal(groupedCountPlan.intent, 'filter_records')
    assert.equal(groupedCountPlan.resultMode, 'grouped_list', 'a grouped count request must retain per-entity output')
    assert.deepEqual(groupedCountPlan.groupEntities, ['周顺峰', '负责人乙'])
    assert.equal(groupedCountPlan.needsClarification, false)

    const followUpQuestion = '相关需求一共有多少条？'
    const followUpAgent = new OllamaAgent(db, settings)
    installModel(followUpAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const followUpPlan = await planQuestionOf(followUpAgent)({
      question: followUpQuestion,
      history: [{ role: 'user', content: '请找出和统一认证改造相关的需求。' }],
      assistantIntent: recordIntent(followUpQuestion)
    } as ChatRequest)
    assert.equal(followUpPlan.intent, 'count_matching')
    assert.deepEqual(followUpPlan.searchTerms, ['统一认证改造'])
    assert.equal(followUpPlan.needsClarification, false)

    const ownerPlan = await planQuestionOf(new OllamaAgent(db, settings))({
      question: qualifiedQuestion,
      assistantIntent: countIntent(qualifiedQuestion, ['周顺峰'])
    } as ChatRequest)
    assert.equal(ownerPlan.intent, 'count_matching')
    assert.deepEqual(ownerPlan.searchTerms, ['周顺峰'])
    const ownerExecution = dataCenter.executePlan(undefined, ownerPlan)
    assert.equal(ownerExecution.toolName, 'query_records_by_fields')
    const ownerResult = ownerExecution.result as {
      totalScanned: number
      matchedCount: number
      returnedCount: number
      records: unknown[]
    }
    assert.equal(ownerResult.matchedCount, truth.ownerCount)
    assert.equal(ownerResult.returnedCount, truth.ownerCount)
    assert.equal(ownerResult.records.length, truth.ownerCount)
    assert.equal(dataCenter.hasEvidence(ownerExecution.toolName, ownerExecution.result), true)

    const plannerCatalog = dataCenter.inspectCatalog('planner-recovery-project')
    assert.ok(plannerCatalog.nodeTypes.includes('Requirement'), 'the node type used by the drift fixture must be catalog-grounded')
    assert.ok(
      plannerCatalog.fields.some((field) => field.field === 'Owner' && field.displayName === '负责人' && field.synonyms.includes('负责人')),
      'the owner field used by the drift fixture must expose its user-facing catalog alias'
    )
    const planWithScriptedPlanner = async (
      question: string,
      plannerOutput: Record<string, unknown>
    ): Promise<DataCenterQueryPlan> => {
      const agent = new OllamaAgent(db, settings)
      installModel(agent, async () => response(plannerOutput))
      return planQuestionOf(agent)({
        question,
        projectId: 'planner-recovery-project',
        assistantIntent: countIntent(question)
      } as ChatRequest)
    }

    const explicitListDriftPlan = await planWithScriptedPlanner(explicitCodeQuestion, {
      sourceMode: 'records',
      needsClarification: false,
      intent: 'record_lookup',
      resultMode: 'answer',
      searchTerms: ['ZX-不存在-2026'],
      groupEntities: [],
      filters: [],
      fields: [],
      limit: 30,
      explanation: 'list request result-mode drift fixture'
    })
    assert.equal(explicitListDriftPlan.intent, 'filter_records')
    assert.equal(explicitListDriftPlan.resultMode, 'list', 'a list verb must override an answer-mode planner drift')
    assert.equal(explicitListDriftPlan.needsClarification, false)

    const paginationQuestion = '请列出最近更新的5条需求记录'
    const paginationDriftPlan = await planWithScriptedPlanner(paginationQuestion, {
      sourceMode: 'records',
      needsClarification: true,
      clarificationQuestion: '请补充查询范围。',
      intent: 'filter_records',
      resultMode: 'table',
      searchTerms: [],
      groupEntities: [],
      filters: [],
      fields: [],
      limit: 30,
      explanation: 'pagination list result-mode drift fixture'
    })
    assert.equal(paginationDriftPlan.intent, 'filter_records')
    assert.equal(paginationDriftPlan.resultMode, 'list', 'an explicit recent-list request must stay a list')
    assert.equal(paginationDriftPlan.limit, 5, 'an explicit list limit must survive planner drift')
    assert.deepEqual(paginationDriftPlan.sort, { field: 'lastModifyTime', direction: 'desc' })
    assert.equal(paginationDriftPlan.needsClarification, false)

    const mixedQuestion = '请结合本地需求记录和知识库的部署规范说明审批流程'
    const mixedAgent = new OllamaAgent(db, settings)
    installModel(mixedAgent, async () => response({
      sourceMode: 'mixed',
      needsClarification: false,
      intent: 'search_content',
      resultMode: 'answer',
      searchTerms: ['部署规范'],
      groupEntities: [],
      filters: [],
      fields: [],
      limit: 30,
      explanation: 'mixed source record scope drift fixture'
    }))
    const mixedPlan = await planQuestionOf(mixedAgent)({
      question: mixedQuestion,
      assistantIntent: {
        taskType: 'mixed_analysis',
        skillId: 'general',
        sourceMode: 'mixed',
        resolvedQuestion: mixedQuestion,
        resultMode: 'answer',
        groupEntities: [],
        needsClarification: false,
        reason: 'mixed source regression'
      }
    } as ChatRequest)
    assert.equal(mixedPlan.intent, 'filter_records')
    assert.equal(mixedPlan.resultMode, 'answer')
    assert.deepEqual(mixedPlan.searchTerms, [], 'knowledge-only wording must not narrow the local record leg')
    assert.equal(mixedPlan.needsClarification, false, 'explicit local-record wording must provide a safe mixed record scope')

    const comparisonQuestion = '哪个人的需求数量更多？'
    const comparisonAgent = new OllamaAgent(db, settings)
    installModel(comparisonAgent, async () => response({
      sourceMode: 'records',
      needsClarification: false,
      intent: 'count_matching',
      resultMode: 'table',
      searchTerms: [],
      groupEntities: ['周顺峰', '负责人乙'],
      filters: [],
      fields: [],
      limit: 30,
      explanation: 'comparative follow-up fixture'
    }))
    const comparisonPlan = await planQuestionOf(comparisonAgent)({
      question: comparisonQuestion,
      history: [{ role: 'user', content: '请查询周顺峰和负责人乙的需求记录。' }],
      assistantIntent: {
        taskType: 'record_query',
        skillId: 'general',
        sourceMode: 'records',
        resolvedQuestion: comparisonQuestion,
        resultMode: 'answer',
        groupEntities: ['周顺峰', '负责人乙'],
        needsClarification: false,
        reason: 'comparative follow-up regression'
      }
    } as ChatRequest)
    assert.equal(comparisonPlan.intent, 'count_matching')
    assert.equal(comparisonPlan.resultMode, 'answer')
    assert.deepEqual(comparisonPlan.groupEntities, ['周顺峰', '负责人乙'])
    const comparisonAnswer = dataCenter.renderVerifiedAnswer(comparisonPlan, {
      matchedCount: truth.totalCount,
      returnedCount: truth.totalCount,
      recordUidsByTerm: {
        '周顺峰': Array.from({ length: truth.ownerCount }, (_unused, index) => `zhou-${index}`),
        '负责人乙': []
      },
      records: []
    }, '')
    assert.match(comparisonAnswer, /周顺峰.*更多/u)

    const ownerDriftPlan = await planWithScriptedPlanner(qualifiedQuestion, {
      sourceMode: 'records',
      needsClarification: false,
      intent: 'count_matching',
      resultMode: 'answer',
      // Simulate the online drift: the planner loses the grounded term while
      // inventing valid-looking constraints from the catalog.
      searchTerms: [],
      groupEntities: [],
      nodeType: 'Requirement',
      filters: [{ field: 'Owner', operator: 'equals', value: '周顺峰' }],
      fields: [],
      limit: 30,
      explanation: 'owner-count planner drift fixture'
    })
    assert.equal(ownerDriftPlan.intent, 'count_matching')
    assert.deepEqual(ownerDriftPlan.searchTerms, ['周顺峰'])
    assert.deepEqual(ownerDriftPlan.filters, [], 'an implicit owner mention must not become an invented field predicate')
    assert.equal(ownerDriftPlan.nodeType, undefined, 'an unmentioned catalog node type must not narrow the owner count')
    assert.equal(ownerDriftPlan.needsClarification, false)

    const explicitOwnerQuestion = '负责人为周顺峰的需求一共有多少条？'
    const explicitOwnerPlan = await planWithScriptedPlanner(explicitOwnerQuestion, {
      sourceMode: 'records',
      needsClarification: false,
      intent: 'count_matching',
      resultMode: 'answer',
      searchTerms: ['周顺峰'],
      groupEntities: [],
      nodeType: 'Requirement',
      filters: [{ field: 'Owner', operator: 'equals', value: '周顺峰' }],
      fields: [],
      limit: 30,
      explanation: 'explicit owner filter fixture'
    })
    assert.ok(explicitOwnerPlan.searchTerms.includes('周顺峰'))
    assert.deepEqual(
      explicitOwnerPlan.filters.map(({ field, operator, value }) => ({ field, operator, value })),
      [{ field: 'Owner', operator: 'equals', value: '周顺峰' }],
      'an explicitly stated owner field predicate must remain grounded'
    )
    assert.equal(explicitOwnerPlan.nodeType, undefined, 'the owner wording does not explicitly select a node type')

    const nonEmptyOwnerQuestion = '负责人不为空的需求一共有多少条？'
    const staleEmptyPlan = await planWithScriptedPlanner(nonEmptyOwnerQuestion, {
      sourceMode: 'records',
      needsClarification: false,
      intent: 'count_matching',
      resultMode: 'answer',
      searchTerms: [],
      groupEntities: [],
      filters: [{ field: 'Owner', operator: 'is_empty' }],
      fields: [],
      limit: 30,
      explanation: 'stale empty-owner predicate fixture'
    })
    assert.equal(
      staleEmptyPlan.filters.some((filter) => filter.operator === 'is_empty'),
      false,
      'a stale is_empty predicate must not pass grounding through the “为空” substring'
    )

    const nonEmptyPlan = await planWithScriptedPlanner(nonEmptyOwnerQuestion, {
      sourceMode: 'records',
      needsClarification: false,
      intent: 'count_matching',
      resultMode: 'answer',
      searchTerms: [],
      groupEntities: [],
      filters: [{ field: 'Owner', operator: 'not_empty' }],
      fields: [],
      limit: 30,
      explanation: 'grounded non-empty-owner predicate fixture'
    })
    assert.deepEqual(
      nonEmptyPlan.filters.map(({ field, operator, value }) => ({ field, operator, value })),
      [{ field: 'Owner', operator: 'not_empty', value: undefined }],
      'the explicitly requested non-empty owner predicate must remain grounded'
    )

    const matchingQuestion = '统一认证相关需求一共有多少条？'
    const matchingAgent = new OllamaAgent(db, settings)
    installModel(matchingAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const matchingPlan = await planQuestionOf(matchingAgent)({
      question: matchingQuestion,
      assistantIntent: countIntent(matchingQuestion, ['统一认证'])
    } as ChatRequest)
    assert.equal(matchingPlan.intent, 'count_matching')
    assert.deepEqual(matchingPlan.searchTerms, ['统一认证'])
    const matchingExecution = dataCenter.executePlan(undefined, matchingPlan)
    const matchingResult = matchingExecution.result as {
      totalScanned: number
      matchedCount: number
      returnedCount: number
      records: unknown[]
    }
    assert.equal(matchingResult.matchedCount, truth.matchingCount)
    assert.equal(matchingResult.totalScanned, truth.totalCount)
    assert.equal(matchingResult.returnedCount, Math.min(matchingPlan.limit, truth.matchingCount))
    assert.equal(matchingResult.records.length, matchingResult.returnedCount)
    assert.equal(dataCenter.hasEvidence(matchingExecution.toolName, matchingExecution.result), true)
    const matchingView = dataCenter.createDataView(
      matchingExecution.toolName,
      matchingExecution.args,
      matchingExecution.result
    )
    assert.ok(matchingView)
    assert.equal(matchingView?.total, truth.matchingCount)
    assert.equal(matchingView?.loadedRows, matchingResult.returnedCount)
    assert.equal(matchingView?.isPreview, truth.matchingCount > matchingResult.returnedCount)

    const totalExecution = dataCenter.executePlan(undefined, totalPlan)
    const totalResult = totalExecution.result as { metric: string; value: number }
    assert.equal(totalResult.metric, 'record_count')
    assert.equal(totalResult.value, truth.totalCount)
    assert.equal(dataCenter.hasEvidence(totalExecution.toolName, totalExecution.result), true)

    const totalAnswerAgent = new OllamaAgent(db, settings)
    let totalAnswerCalls = 0
    installModel(totalAnswerAgent, async () => {
      totalAnswerCalls += 1
      if (totalAnswerCalls === 1) throw new Error('planner transport unavailable')
      return textResponse(`当前数据中心共有 ${truth.totalCount} 条需求。`)
    })
    const totalAnswer = await totalAnswerAgent.ask({
      question: totalQuestion,
      assistantIntent: countIntent(totalQuestion)
    } as ChatRequest)
    assert.equal(totalAnswer.taskTrace?.status, 'completed')
    assert.equal(totalAnswer.needsClarification, undefined)
    assert.match(totalAnswer.answer, new RegExp(String(truth.totalCount), 'u'))
    assert.ok(
      totalAnswer.dataViews.length > 0 || totalAnswer.sources.length > 0 || totalAnswer.evidenceBlocks?.length,
      'a total count answer must retain a verifiable aggregate evidence block'
    )

    const fastPathCalls: ModelChatInput[] = []
    const fastPathAgent = new OllamaAgent(db, settings)
    installModel(fastPathAgent, async (input) => {
      fastPathCalls.push(input)
      const prompt = input.messages.map((message) => String(message.content)).join('\n')
      if (prompt.includes('AI 助手意图与数据查询规划器')) {
        return response({
          sourceMode: 'records',
          needsClarification: false,
          intent: 'total',
          resultMode: 'answer',
          searchTerms: [],
          groupEntities: [],
          searchMode: 'any',
          filters: [],
          fields: [],
          limit: 30,
          explanation: 'records-only fast-path regression plan'
        })
      }
      return textResponse('不应由模型生成 records-only 的确定性计数回答。')
    })
    const fastPathAnswer = await fastPathAgent.ask({
      question: totalQuestion,
      assistantIntent: countIntent(totalQuestion)
    } as ChatRequest)
    assert.equal(fastPathAnswer.taskTrace?.status, 'completed')
    assert.equal(fastPathAnswer.needsClarification, undefined)
    assert.match(fastPathAnswer.answer, new RegExp(String(truth.totalCount), 'u'))
    assert.ok(fastPathAnswer.dataViews.length > 0, 'records-only fast path must retain its data view')
    assert.equal(
      fastPathCalls.some((input) => input.messages.some((message) => (
        String(message.content).includes('你是 VISSLM 数据回答器')
      ))),
      false,
      'records-only deterministic verified answers must not invoke the final answer model'
    )

    const emptyQuestion = '不存在主题相关需求一共有多少条？'
    const emptyAgent = new OllamaAgent(db, settings)
    installModel(emptyAgent, async () => {
      throw new Error('planner transport unavailable')
    })
    const emptyPlan = await planQuestionOf(emptyAgent)({
      question: emptyQuestion,
      assistantIntent: countIntent(emptyQuestion, ['不存在主题'])
    } as ChatRequest)
    assert.equal(emptyPlan.intent, 'count_matching')
    const emptyExecution = dataCenter.executePlan(undefined, emptyPlan)
    const emptyResult = emptyExecution.result as {
      matchedCount: number
      returnedCount: number
      records: unknown[]
    }
    assert.equal(emptyResult.matchedCount, 0)
    assert.equal(emptyResult.returnedCount, 0)
    assert.deepEqual(emptyResult.records, [])
    assert.equal(dataCenter.hasEvidence(emptyExecution.toolName, emptyExecution.result), false)

    const groupedZeroEntity = '不存在负责人'
    const groupedZeroPlan: DataCenterQueryPlan = {
      sourceMode: 'records',
      needsClarification: false,
      resultMode: 'grouped_list',
      groupEntities: [groupedZeroEntity],
      intent: 'filter_records',
      explanation: 'grouped zero-result data-view regression plan',
      searchTerms: [groupedZeroEntity],
      searchMode: 'any',
      filters: [],
      fields: [],
      limit: 30
    }
    const groupedZeroExecution = dataCenter.executePlan(undefined, groupedZeroPlan)
    const groupedZeroResult = groupedZeroExecution.result as {
      matchedCount: number
      returnedCount: number
      records: unknown[]
    }
    assert.equal(groupedZeroResult.matchedCount, 0)
    assert.equal(groupedZeroResult.returnedCount, 0)
    assert.deepEqual(groupedZeroResult.records, [])
    const groupedZeroView = dataCenter.createDataView(
      groupedZeroExecution.toolName,
      groupedZeroExecution.args,
      groupedZeroExecution.result
    )
    assert.ok(groupedZeroView, 'grouped_list with zero matches must still expose a data view')
    assert.equal(groupedZeroView?.total, 0)
    assert.equal(groupedZeroView?.loadedRows, 0)
    assert.equal(groupedZeroView?.isPreview, false)
    const groupedZeroGroup = groupedZeroView?.groups.find((group) => group.name === groupedZeroEntity)
    assert.ok(groupedZeroGroup, 'zero-result grouped view must retain the requested entity group')
    assert.equal(groupedZeroGroup?.count, 0)
    assert.deepEqual(groupedZeroGroup?.rows, [])

    const emptyResponseAgent = new OllamaAgent(db, settings)
    let emptyResponseCalls = 0
    installModel(emptyResponseAgent, async () => {
      emptyResponseCalls += 1
      if (emptyResponseCalls === 1) throw new Error('planner transport unavailable')
      return textResponse('没有命中任何符合条件的记录。')
    })
    const emptyResponse = await emptyResponseAgent.ask({
      question: emptyQuestion,
      assistantIntent: countIntent(emptyQuestion, ['不存在主题'])
    } as ChatRequest)
    assert.equal(emptyResponse.taskTrace?.status, 'completed')
    assert.equal(emptyResponse.needsClarification, undefined)
    assert.match(emptyResponse.answer, /没有|未找到|未命中/u)

    const recoverableQuestion = '统一认证相关需求一共有多少条？'
    const recoverableAgent = new OllamaAgent(db, settings)
    installModel(recoverableAgent, async () => response({
      sourceMode: 'records',
      needsClarification: true,
      clarificationQuestion: '请明确任务类型、数据来源和结果形式。',
      intent: 'count_matching',
      resultMode: 'answer',
      searchTerms: ['统一认证'],
      fields: ['ImaginaryField'],
      filters: [],
      groupEntities: [],
      limit: 30,
      explanation: 'classifier metadata conflict'
    }))
    const recoverablePlan = await planQuestionOf(recoverableAgent)({
      question: recoverableQuestion,
      assistantIntent: recordIntent(recoverableQuestion)
    } as ChatRequest)
    assert.equal(recoverablePlan.intent, 'count_matching')
    assert.deepEqual(recoverablePlan.searchTerms, ['统一认证'])
    assert.deepEqual(recoverablePlan.fields, [])
    assert.equal(recoverablePlan.needsClarification, false)
    assert.match(recoverablePlan.explanation, /忽略|deferred/u)

    const invalidJsonAgent = new OllamaAgent(db, settings)
    installModel(invalidJsonAgent, async () => ({
      message: { role: 'assistant', content: 'not JSON' }
    }))
    const invalidJsonPlan = await planQuestionOf(invalidJsonAgent)({
      question: matchingQuestion,
      assistantIntent: countIntent(matchingQuestion, ['统一认证'])
    } as ChatRequest)
    assert.equal(invalidJsonPlan.needsClarification, false)
    assert.equal(invalidJsonPlan.intent, 'count_matching')
    assert.deepEqual(invalidJsonPlan.searchTerms, ['统一认证'])

    const vagueAgent = new OllamaAgent(db, settings)
    installModel(vagueAgent, async () => response({
      sourceMode: 'records',
      needsClarification: true,
      clarificationQuestion: '请说明要查询的对象或范围。',
      intent: 'search_content',
      resultMode: 'answer',
      searchTerms: [],
      groupEntities: [],
      explanation: 'missing business target'
    }))
    const vaguePlan = await planQuestionOf(vagueAgent)({ question: '请帮我查一下' } as ChatRequest)
    assert.equal(vaguePlan.needsClarification, true)
    assert.match(vaguePlan.clarificationQuestion ?? '', /对象|范围/u)

    console.log(JSON.stringify({
      ok: true,
      track: 'deterministic',
      fixtureVersion: 'assistant-intelligence-eval-v2',
      checks: [
        'qualified count questions recover grounded terms when planning fails',
        'unqualified total counts recover deterministically',
        'follow-up counts recover their grounded user-history object',
        'owner and 64+ result counts preserve full matched truth beyond the return limit',
        'owner-count planner drift restores grounded terms and drops unmentioned catalog constraints',
        'explicit owner predicates remain available when the user names the owner field',
        'non-empty owner wording rejects stale is_empty predicates and preserves not_empty',
        'explicit list verbs override answer/table planner drift and preserve requested limits',
        'mixed analysis retains an evidence-bearing local-record scope',
        'comparative follow-ups preserve answer mode and identify the leading grounded entity',
        'records-only count answers use a deterministic verified fast path',
        'zero-result count plans complete as empty evidence instead of guessing',
        'grouped zero-result queries retain a zero-count data view',
        'planner metadata conflicts and unknown fields do not become user clarifications',
        'invalid planner JSON falls back to grounded read-only plans',
        'targetless requests still stop before retrieval'
      ]
    }))
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
