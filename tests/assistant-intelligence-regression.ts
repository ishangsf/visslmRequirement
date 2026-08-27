import { strict as assert } from 'node:assert'
import type {
  AssistantIntentDecision,
  ChatHistoryTurn,
  ChatRequest,
  ModelSettings
} from '../src/shared/types'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import evalSet from './fixtures/assistant-intelligence-eval-set.json'

type EvalCase = {
  id: string
  category: string
  failure?: string
  evaluationGroup?: string
  online?: boolean
  onlineScenario?: 'count' | 'history-grouped' | 'clarification'
  minimumOnlineSamples?: number
  question: string
  history?: ChatHistoryTurn[]
  expected: Partial<AssistantIntentDecision> & {
    safeFallback?: boolean
    failClosed?: boolean
    clarificationMustBeConcrete?: boolean
    classifierCall?: boolean
    clarificationClass?: 'none' | 'user_decision' | 'internal_failure' | 'system_unavailable'
    evidenceRequired?: boolean
  }
  expectedGroupEntities?: string[]
  expectedGroundedTerms?: string[]
}

const cases = evalSet as unknown as readonly EvalCase[]
const fixtureVersion = 'assistant-intelligence-eval-v2'

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-intelligence-regression-model',
  thinking: false,
  apiKey: 'assistant-intelligence-regression-key'
}

type IntentOutcome = ModelResponse | { throw: Error }

class ScriptedIntentClient {
  readonly calls: ModelChatInput[] = []
  private responseIndex = 0

  constructor(private readonly outcomes: readonly IntentOutcome[]) {}

  async chat(input: ModelChatInput): Promise<ModelResponse> {
    this.calls.push(input)
    const outcome = this.outcomes[Math.min(this.responseIndex, this.outcomes.length - 1)]
    this.responseIndex += 1
    if (!outcome) throw new Error(`missing scripted outcome #${this.responseIndex}`)
    if ('throw' in outcome) throw outcome.throw
    return outcome
  }
}

const request = (
  question: string,
  history?: readonly ChatHistoryTurn[]
): Pick<ChatRequest, 'question' | 'history' | 'entrypoint' | 'expertId' | 'chatMode'> => ({
  question,
  history: history ? [...history] : undefined,
  entrypoint: 'chat',
  chatMode: 'auto'
})

const rawDecision = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  taskType: 'conversation',
  skillId: 'general',
  sourceMode: 'conversation',
  resolvedQuestion: '处理当前问题',
  resultMode: 'answer',
  groupEntities: [],
  needsClarification: false,
  reason: '回归测试分类结果',
  ...overrides
})

const modelResponse = (content: string, doneReason?: string): ModelResponse => ({
  message: { role: 'assistant', content },
  ...(doneReason ? { done_reason: doneReason } : {})
})

const decisionResponse = (overrides: Record<string, unknown> = {}): ModelResponse => (
  modelResponse(JSON.stringify(rawDecision(overrides)))
)

const emptyResponse = (): ModelResponse => ({
  message: { role: 'assistant', content: '' },
  done_reason: 'stop'
})

const throwingOutcome = (): { throw: Error } => ({
  throw: new Error('classifier transport unavailable')
})

const assertDecisionCore = (
  decision: AssistantIntentDecision,
  expected: Partial<Pick<AssistantIntentDecision, 'taskType' | 'skillId' | 'sourceMode' | 'resultMode'>>
): void => {
  const routeFields: readonly (keyof Pick<AssistantIntentDecision, 'taskType' | 'skillId' | 'sourceMode' | 'resultMode'>)[] = [
    'taskType',
    'skillId',
    'sourceMode',
    'resultMode'
  ]
  for (const field of routeFields) {
    const value = expected[field]
    if (value === undefined) continue
    assert.equal(decision[field as keyof AssistantIntentDecision], value, `${field} route mismatch`)
  }
  assert.equal(typeof decision.resolvedQuestion, 'string')
  assert.ok(decision.resolvedQuestion.trim().length > 0)
  assert.ok(Array.isArray(decision.groupEntities))
  assert.equal(typeof decision.needsClarification, 'boolean')
  assert.equal(typeof decision.reason, 'string')
}

const assertDecisionContract = (
  id: string,
  decision: AssistantIntentDecision,
  item: EvalCase
): void => {
  assertDecisionCore(decision, item.expected)
  if (item.expected.needsClarification !== undefined) {
    assert.equal(decision.needsClarification, item.expected.needsClarification, `${id} clarification mismatch`)
  }
  if (item.expectedGroupEntities) {
    assert.deepEqual(decision.groupEntities, item.expectedGroupEntities, `${id} grounded entities mismatch`)
  }
  if (item.expectedGroundedTerms?.length) {
    for (const term of item.expectedGroundedTerms) {
      assert.ok(decision.resolvedQuestion.includes(term), `${id} must retain grounded term ${term}`)
    }
  }
  if (item.expected.clarificationClass === 'none' || item.expected.clarificationClass === 'internal_failure') {
    assert.equal(decision.needsClarification, false, `${id} must not become a user clarification`)
  }
  if (item.expected.clarificationClass === 'user_decision' || item.expected.clarificationMustBeConcrete) {
    assertNoInternalClarificationRequest(decision)
  }
}

const assertNoInternalClarificationRequest = (decision: AssistantIntentDecision): string => {
  assert.equal(decision.needsClarification, true)
  const clarification = decision.clarificationQuestion?.trim() ?? ''
  assert.ok(clarification.length >= 8, 'a clarification must be actionable, not empty')
  assert.doesNotMatch(
    clarification,
    /任务类型|数据来源|结果形式/u,
    'clarifications must not expose internal routing fields'
  )
  assert.doesNotMatch(
    clarification,
    /请明确任务|请补充任务|请填写来源|请填写结果/u,
    'clarifications must not ask the user to fill the classifier schema'
  )
  return clarification
}

const caseById = (id: string): EvalCase => {
  const found = cases.find((item) => item.id === id)
  if (!found) throw new Error(`missing eval case ${id}`)
  return found
}

const testFixtureContract = (): void => {
  assert.ok(cases.length >= 20, 'the intelligence fixture must remain a reusable multi-scenario set')
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length, 'fixture case IDs must be unique')

  const onlineCases = cases.filter((item) => item.online)
  assert.ok(onlineCases.length >= 7, 'the fixture must expose count, context and clarification live cases')
  for (const item of onlineCases) {
    assert.ok(item.onlineScenario, `${item.id} must declare its online scenario`)
    assert.ok((item.minimumOnlineSamples ?? 0) >= 3, `${item.id} must require at least three live samples`)
    assert.ok(item.expected.clarificationClass, `${item.id} must classify its clarification semantics`)
  }
  const synonymCases = cases.filter((item) => item.evaluationGroup === 'synonymous_total_count')
  assert.ok(synonymCases.length >= 3, 'the fixture must contain at least three equivalent count phrasings')
  const expectedRoute = synonymCases[0]?.expected
  for (const item of synonymCases.slice(1)) {
    assert.deepEqual(
      ['taskType', 'skillId', 'sourceMode', 'resultMode', 'needsClarification']
        .map((field) => item.expected[field as keyof EvalCase['expected']]),
      ['taskType', 'skillId', 'sourceMode', 'resultMode', 'needsClarification']
        .map((field) => expectedRoute?.[field as keyof EvalCase['expected']]),
      `${item.id} must share the canonical route contract`
    )
  }
}

const testRelatedRequirementCountNaturalLanguage = async (): Promise<void> => {
  const relatedCases = cases.filter((item) => item.category === 'related_requirement_count')
  assert.ok(relatedCases.length >= 3, 'the regression fixture must contain several natural count phrasings')

  for (const item of relatedCases) {
    // Deliberately return a semantically useful task with stale skill/source
    // metadata. A capable router normalizes the metadata and executes the
    // obvious read request instead of asking the user to classify it.
    const client = new ScriptedIntentClient([decisionResponse({
      taskType: 'record_query',
      skillId: 'knowledge-base',
      sourceMode: 'knowledge',
      resolvedQuestion: item.question,
      resultMode: 'answer'
    })])
    const decision = await new AssistantIntentRouter(settings, client).resolve(request(item.question, item.history))
    assertDecisionCore(decision, item.expected)
    assert.equal(decision.needsClarification, false, `${item.id} must execute without clarification`)
  }
}

const testEquivalentTotalCountPhrasingsKeepOneRoute = async (): Promise<void> => {
  const synonymCases = cases.filter((item) => item.evaluationGroup === 'synonymous_total_count')
  const outcomes: string[] = []
  for (const item of synonymCases) {
    const client = new ScriptedIntentClient([decisionResponse({
      taskType: 'record_query',
      skillId: 'knowledge-base',
      sourceMode: 'knowledge',
      resolvedQuestion: item.question,
      resultMode: 'list'
    })])
    const decision = await new AssistantIntentRouter(settings, client).resolve(request(item.question, item.history))
    assertDecisionContract(item.id, decision, item)
    assert.equal(decision.needsClarification, false, `${item.id} must execute without clarification`)
    outcomes.push(JSON.stringify({
      taskType: decision.taskType,
      skillId: decision.skillId,
      sourceMode: decision.sourceMode,
      resultMode: decision.resultMode,
      needsClarification: decision.needsClarification
    }))
  }
  assert.ok(outcomes.length >= 3)
  assert.equal(new Set(outcomes).size, 1, 'equivalent count phrasings must normalize to one route')
}

const testOwnerCountAndConfirmedHistoryGroupingStayGrounded = async (): Promise<void> => {
  const ownerCase = caseById('owner-count-001')
  const ownerClient = new ScriptedIntentClient([decisionResponse({
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: ownerCase.question,
    resultMode: 'answer',
    // A single owner filter is a search term, not a grouped-list entity.
    groupEntities: []
  })])
  const ownerDecision = await new AssistantIntentRouter(settings, ownerClient).resolve(request(ownerCase.question))
  assertDecisionContract(ownerCase.id, ownerDecision, ownerCase)
  assert.equal(ownerDecision.needsClarification, false)
  assert.deepEqual(ownerDecision.groupEntities, [])
  assert.match(ownerDecision.resolvedQuestion, /周顺峰/u)

  const historyCase = caseById('history-grouped-deterministic-001')
  const historyClient = new ScriptedIntentClient([decisionResponse({
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: historyCase.question,
    resultMode: 'grouped_list',
    groupEntities: historyCase.expectedGroupEntities
  })])
  const historyDecision = await new AssistantIntentRouter(settings, historyClient).resolve(
    request(historyCase.question, historyCase.history)
  )
  assertDecisionContract(historyCase.id, historyDecision, historyCase)
  assert.equal(historyDecision.needsClarification, false)
  assert.deepEqual(historyDecision.groupEntities, ['负责人甲', '负责人乙'])
  assert.doesNotMatch(historyDecision.resolvedQuestion, /丙|猜测|推测/u)
}

const testInconsistentTaskSkillSourceIsCanonicalized = async (): Promise<void> => {
  const recordCase = caseById('canonical-route-001')
  const recordClient = new ScriptedIntentClient([decisionResponse({
    taskType: 'record_query',
    skillId: 'knowledge-base',
    sourceMode: 'knowledge',
    resolvedQuestion: recordCase.question,
    resultMode: 'answer'
  })])
  const recordDecision = await new AssistantIntentRouter(settings, recordClient).resolve(request(recordCase.question))
  assertDecisionCore(recordDecision, recordCase.expected)
  assert.equal(recordDecision.needsClarification, false)

  const knowledgeCase = caseById('canonical-route-002')
  const knowledgeClient = new ScriptedIntentClient([decisionResponse({
    taskType: 'knowledge_qa',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: knowledgeCase.question,
    resultMode: 'answer'
  })])
  const knowledgeDecision = await new AssistantIntentRouter(settings, knowledgeClient).resolve(
    request(knowledgeCase.question)
  )
  assertDecisionCore(knowledgeDecision, knowledgeCase.expected)
  assert.equal(knowledgeDecision.needsClarification, false)
}

const testClearReadRequestsSafelyDegradeWhenClassifierFails = async (): Promise<void> => {
  const failureCases = cases.filter((item) => item.category === 'classifier_failure')
  assert.equal(failureCases.length, 4)

  for (const item of failureCases) {
    let client: ScriptedIntentClient
    if (item.failure === 'missing-fields') {
      client = new ScriptedIntentClient([modelResponse(JSON.stringify({
        taskType: 'record_query',
        resolvedQuestion: item.question
      }))])
    } else if (item.failure === 'empty-response') {
      client = new ScriptedIntentClient([emptyResponse(), emptyResponse()])
    } else if (item.failure === 'invalid-json') {
      client = new ScriptedIntentClient([modelResponse('这不是 JSON')])
    } else if (item.failure === 'throws') {
      client = new ScriptedIntentClient([throwingOutcome()])
    } else {
      throw new Error(`unknown classifier failure ${item.failure}`)
    }

    const decision = await new AssistantIntentRouter(settings, client).resolve(request(item.question))
    assertDecisionContract(item.id, decision, item)
    assert.equal(decision.needsClarification, false, `${item.id} must use a safe read fallback`)
    assert.ok(decision.resolvedQuestion.includes(item.question.replace(/[？?]/gu, '').trim().slice(0, 4)))
    assert.ok(client.calls.length >= 1 && client.calls.length <= 2, `${item.id} must have bounded classifier calls`)
  }
}

const testInternalClassifierFailuresNeverBecomeClarification = async (): Promise<void> => {
  const failureCases = cases.filter((item) => item.category === 'internal_classifier_failure')
  assert.equal(failureCases.length, 3)

  for (const item of failureCases) {
    let client: ScriptedIntentClient
    if (item.failure === 'invalid-enum') {
      client = new ScriptedIntentClient([modelResponse(JSON.stringify({
        taskType: 'not-a-task',
        skillId: 'not-a-skill',
        sourceMode: 'not-a-source',
        resolvedQuestion: '',
        resultMode: 'not-a-result',
        groupEntities: [],
        needsClarification: true,
        clarificationQuestion: '请明确任务类型、数据来源和结果形式。',
        reason: 'invalid enum fixture'
      }))])
    } else if (item.failure === 'length-truncated') {
      client = new ScriptedIntentClient([
        modelResponse(JSON.stringify(rawDecision({
          taskType: 'record_query',
          skillId: 'general',
          sourceMode: 'records',
          resultMode: 'answer'
        })), 'length'),
        decisionResponse({
          taskType: 'record_query',
          skillId: 'knowledge-base',
          sourceMode: 'knowledge',
          resolvedQuestion: item.question,
          resultMode: 'list'
        })
      ])
    } else if (item.failure === 'retry-exhausted') {
      client = new ScriptedIntentClient([emptyResponse(), emptyResponse()])
    } else {
      throw new Error(`unknown internal classifier failure ${item.failure}`)
    }

    const decision = await new AssistantIntentRouter(settings, client).resolve(request(item.question, item.history))
    assertDecisionContract(item.id, decision, item)
    assert.equal(decision.needsClarification, false, `${item.id} must remain an internal recovery event`)
    assert.doesNotMatch(decision.clarificationQuestion ?? '', /任务类型|数据来源|结果形式/u)
    assert.ok(client.calls.length >= 1 && client.calls.length <= 2, `${item.id} must have bounded retries`)
  }
}

const testTargetlessQuestionStillClarifiesWithBusinessLanguage = async (): Promise<void> => {
  const item = caseById('ambiguous-targetless-001')
  const client = new ScriptedIntentClient([decisionResponse({
    // The classifier is intentionally overconfident. The router must still
    // detect that there is no object, scope, or operation to execute.
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: '处理当前问题',
    resultMode: 'answer',
    needsClarification: false,
    clarificationQuestion: '请明确任务类型、数据来源和结果形式。'
  })])
  const decision = await new AssistantIntentRouter(settings, client).resolve(request(item.question))
  const clarification = assertNoInternalClarificationRequest(decision)
  assert.match(clarification, /查询|统计|列出|需求|记录|对象|范围|想要/u)
}

const testSimilarityMatchingAndKnowledgeSpecialistKeepTheirRoutes = async (): Promise<void> => {
  const similarityCase = caseById('similarity-matching-001')
  const similarityClient = new ScriptedIntentClient([decisionResponse({
    taskType: 'requirement_matching',
    skillId: 'general',
    sourceMode: 'knowledge',
    resolvedQuestion: similarityCase.question,
    resultMode: 'table'
  })])
  const similarityDecision = await new AssistantIntentRouter(settings, similarityClient).resolve(
    request(similarityCase.question)
  )
  assertDecisionCore(similarityDecision, similarityCase.expected)
  assert.equal(similarityDecision.needsClarification, false)

  const knowledgeCase = caseById('explicit-knowledge-001')
  const knowledgeClient = new ScriptedIntentClient([throwingOutcome()])
  const knowledgeDecision = await new AssistantIntentRouter(settings, knowledgeClient).resolve(
    request(knowledgeCase.question)
  )
  assertDecisionCore(knowledgeDecision, knowledgeCase.expected)
  assert.equal(knowledgeDecision.needsClarification, false)
  assert.equal(knowledgeClient.calls.length, 0, 'an explicit knowledge specialist route must not be reclassified')

  const explicitSimilarityCase = caseById('explicit-similarity-002')
  const explicitSimilarityClient = new ScriptedIntentClient([throwingOutcome()])
  const explicitSimilarityDecision = await new AssistantIntentRouter(settings, explicitSimilarityClient).resolve(
    request(explicitSimilarityCase.question)
  )
  assertDecisionCore(explicitSimilarityDecision, explicitSimilarityCase.expected)
  assert.equal(explicitSimilarityDecision.needsClarification, false)
  assert.equal(explicitSimilarityClient.calls.length, 0, 'an explicit matching specialist route must not be reclassified')
}

const testUngroundedGroupedEntityRemainsBlocked = async (): Promise<void> => {
  const item = caseById('ungrounded-group-001')
  const client = new ScriptedIntentClient([decisionResponse({
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: '分别列出负责人甲和负责人丙的需求记录，不要合并',
    resultMode: 'grouped_list',
    groupEntities: ['负责人甲', '负责人丙'],
    needsClarification: false,
    clarificationQuestion: '请明确任务类型、数据来源和结果形式。'
  })])
  const decision = await new AssistantIntentRouter(settings, client).resolve(
    request(item.question, item.history)
  )
  const clarification = assertNoInternalClarificationRequest(decision)
  assertDecisionCore(decision, item.expected)
  assert.match(clarification, /分组|实体|负责人|分别|确认/u)
  assert.deepEqual(decision.groupEntities, ['负责人甲'])
  assert.doesNotMatch(decision.resolvedQuestion, /负责人丙/u)
}

const main = async (): Promise<void> => {
  testFixtureContract()
  await testRelatedRequirementCountNaturalLanguage()
  await testEquivalentTotalCountPhrasingsKeepOneRoute()
  await testOwnerCountAndConfirmedHistoryGroupingStayGrounded()
  await testInconsistentTaskSkillSourceIsCanonicalized()
  await testClearReadRequestsSafelyDegradeWhenClassifierFails()
  await testInternalClassifierFailuresNeverBecomeClarification()
  await testTargetlessQuestionStillClarifiesWithBusinessLanguage()
  await testSimilarityMatchingAndKnowledgeSpecialistKeepTheirRoutes()
  await testUngroundedGroupedEntityRemainsBlocked()
  console.log(JSON.stringify({
    ok: true,
    track: 'deterministic',
    fixtureVersion,
    caseCount: cases.length,
    checks: [
      'multiple natural related-requirement count phrasings remain direct record reads',
      'four equivalent total-count phrasings share one canonical route',
      'owner-constrained counts and confirmed follow-up groups retain grounded entities',
      'task, skill and source metadata are canonicalized instead of escalating to clarification',
      'missing, empty, invalid and throwing classifiers safely fall back for clear reads',
      'truncated, invalid-enum and retry-exhausted classifier failures never become clarifications',
      'targetless requests still stop with a concrete business clarification',
      'requirement similarity and explicit knowledge routes are not misrouted',
      'ungrounded grouped entities fail closed without exposing routing fields'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
