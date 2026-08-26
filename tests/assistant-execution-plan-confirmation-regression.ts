import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantPlanConfirmationController } from '../src/main/assistant/plan-confirmation'
import {
  validateAndApplyAssistantPlanPatch,
  type AssistantPlanConfirmationInput,
  type ConfirmedAssistantPlan
} from '../src/main/assistant/execution-plan'
import { AppDatabase } from '../src/main/database'
import type { KnowledgeSearchHit, KnowledgeService } from '../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import { OllamaAgent } from '../src/main/ollama'
import type { AssistantExecutionSummary } from '../src/shared/expert-types'
import type {
  AssistantIntentDecision,
  AssistantPlanPatch,
  ConfirmAgentPlanResult,
  ModelSettings
} from '../src/shared/types'

const checks: string[] = []

const planOwner = { id: 101 }

const summaryFixture = (
  overrides: Partial<AssistantExecutionSummary> = {}
): AssistantExecutionSummary => ({
  question: '请按旧范围查询记录',
  taskType: 'record_query',
  sourceMode: 'records',
  resultMode: 'list',
  intent: 'filter_records',
  searchTerms: ['旧词'],
  fields: ['Owner', 'Summary'],
  filters: [{ field: 'Owner', operator: 'contains', value: '旧过滤' }],
  groupEntities: [],
  searchMode: 'any',
  limit: 7,
  scope: {
    projectIds: ['project-a'],
    nodeTypes: ['Requirement'],
    recordCount: 2,
    baseFilters: [{ field: 'Owner', operator: 'contains', value: '旧范围' }],
    snapshotAt: '2026-08-27T00:00:00.000Z'
  },
  ...overrides
})

const planValidationInput = (
  overrides: Partial<AssistantPlanConfirmationInput> = {}
): AssistantPlanConfirmationInput => ({
  summary: summaryFixture(),
  dataScope: {
    projectIds: ['project-a'],
    nodeTypes: ['Requirement'],
    baseFilters: [{ field: 'Owner', operator: 'contains', value: '旧范围' }],
    snapshotAt: '2026-08-27T00:00:00.000Z'
  },
  metadata: {
    fields: [
      { field: 'Owner', displayName: '负责人', allowed: true, types: ['Requirement'] },
      { field: 'Summary', displayName: '摘要', allowed: true, types: ['Requirement'] },
      { field: 'Priority', displayName: '优先级', allowed: true, types: ['Requirement'] }
    ],
    projectIds: ['project-a', 'project-b'],
    nodeTypes: ['Requirement', 'Task']
  },
  ...overrides
})

const editedPlanPatch: AssistantPlanPatch = {
  searchTerms: ['  新词  ', '新词', 'ＮＥＷ', 'new'],
  fields: [' 优先级 ', '优先级'],
  scope: {
    projectIds: [' project-b ', 'PROJECT-B'],
    nodeTypes: [' requirement ', 'Requirement'],
    baseFilters: [
      { field: '负责人', operator: 'contains', value: ' 新值 ' },
      { field: 'OWNER', operator: 'contains', value: '新值' }
    ]
  },
  filters: [
    { field: '优先级', operator: 'equals', value: ' Ｐ１ ' },
    { field: 'Priority', operator: 'equals', value: 'P1' }
  ],
  limit: 999,
  resultMode: 'table'
}

const resultCodes = (result: ConfirmAgentPlanResult | { errors?: Array<{ code: string }> }): string[] => (
  (result.errors ?? []).map((item) => item.code)
)

const testPatchNormalizationAndEffectiveScope = (): void => {
  const result = validateAndApplyAssistantPlanPatch(planValidationInput(), editedPlanPatch)
  assert.equal(result.ok, true)
  if (!result.ok) return

  const { effectiveSummary, effectiveDataScope, warnings } = result.plan
  assert.deepEqual(effectiveSummary.searchTerms, ['新词', 'NEW'])
  assert.deepEqual(effectiveSummary.fields, ['Priority'])
  assert.deepEqual(effectiveSummary.scope.projectIds, ['project-b'])
  assert.deepEqual(effectiveSummary.scope.nodeTypes, ['Requirement'])
  assert.deepEqual(effectiveSummary.scope.baseFilters, [{
    field: 'Owner',
    operator: 'contains',
    value: '新值'
  }])
  assert.deepEqual(effectiveSummary.filters, [{
    field: 'Priority',
    operator: 'equals',
    value: 'P1'
  }])
  assert.equal(effectiveSummary.limit, 50)
  assert.equal(effectiveSummary.resultMode, 'table')
  assert.deepEqual(effectiveDataScope.projectIds, ['project-b'])
  assert.deepEqual(effectiveDataScope.nodeTypes, ['Requirement'])
  assert.equal(effectiveSummary.scope.recordCount, 2, 'immutable record scope remains an audit fact')
  assert.ok(warnings.some((item) => item.code === 'LIMIT_CLAMPED'))
  assert.equal(effectiveSummary.searchTerms.includes('旧词'), false)
  assert.equal(effectiveSummary.fields.includes('Owner'), false)
  assert.equal(effectiveSummary.filters.some((item) => item.value === '旧过滤'), false)
  assert.equal(effectiveSummary.scope.baseFilters.some((item) => item.value === '旧范围'), false)
  checks.push('plan patch normalization trims, NFKC-normalizes, dedupes, and clamps editable values')
}

const testExplicitRecordScopeRemainsImmutable = (): void => {
  const input = planValidationInput()
  const result = validateAndApplyAssistantPlanPatch({
    ...input,
    dataScope: {
      ...input.dataScope,
      recordUids: ['plan-record-1', 'plan-record-2']
    }
  }, {
    searchTerms: [' 新词 ']
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.plan.effectiveDataScope.recordUids, ['plan-record-1', 'plan-record-2'])
  assert.equal(result.plan.effectiveSummary.scope.recordCount, 2)
  checks.push('explicit record UID scope remains immutable while other plan fields are edited')
}

const testInvalidPatchIsFailClosed = (): void => {
  const invalidPatch = {
    question: '试图改写用户原文',
    taskType: 'conversation',
    fields: ['不存在字段'],
    scope: {
      projectIds: ['project-not-allowed'],
      nodeTypes: ['UnknownType']
    },
    filters: [{ field: 'Owner', operator: 'unsupported', value: 'x' }],
    limit: Number.NaN,
    resultMode: 'dashboard'
  } as unknown as AssistantPlanPatch
  const result = validateAndApplyAssistantPlanPatch(planValidationInput(), invalidPatch)
  assert.equal(result.ok, false)
  if (result.ok) return
  const codes = resultCodes(result)
  assert.ok(codes.includes('PLAN_PATCH_FIELD_NOT_ALLOWED'))
  assert.ok(codes.includes('FIELD_NOT_FOUND'))
  assert.ok(codes.includes('PROJECT_NOT_FOUND'))
  assert.ok(codes.includes('NODE_TYPE_NOT_FOUND'))
  assert.ok(codes.includes('FILTER_INVALID'))
  assert.ok(codes.includes('LIMIT_INVALID'))
  assert.ok(codes.includes('RESULT_MODE_NOT_COMPATIBLE'))
  checks.push('fixed, unknown, malformed, unauthorized, and incompatible patch values fail closed')
}

const testControllerKeepsPendingAfterInvalidPatch = async (): Promise<void> => {
  const localController = new AssistantPlanConfirmationController()
  const signal = new AbortController()
  const runId = 'editable-plan-run'
  const input = planValidationInput()
  const waiting = localController.wait(planOwner, runId, signal.signal, input)

  const invalid = localController.confirm(planOwner, runId, {
    fields: ['不存在字段']
  })
  assert.equal(invalid.status, 'invalid')
  assert.ok(resultCodes(invalid).includes('FIELD_NOT_FOUND'))
  const incompatible = localController.confirm(planOwner, runId, { resultMode: 'dashboard' })
  assert.equal(incompatible.status, 'invalid')
  assert.ok(resultCodes(incompatible).includes('RESULT_MODE_NOT_COMPATIBLE'))

  const approved = localController.confirm(planOwner, runId, editedPlanPatch)
  assert.equal(approved.status, 'approved')
  assert.ok(approved.effectiveSummary)
  assert.equal(approved.effectiveSummary?.limit, 50)
  assert.deepEqual(approved.effectiveSummary?.fields, ['Priority'])
  const confirmed = await waiting
  assert.equal(confirmed?.effectiveSummary.limit, 50)
  assert.deepEqual(confirmed?.effectiveDataScope.projectIds, ['project-b'])

  const duplicate = localController.confirm(planOwner, runId, editedPlanPatch)
  assert.equal(duplicate.status, 'not_found', 'one-shot approval must reject duplicate confirmation')
  checks.push('invalid edits keep pending alive; approved edits freeze an effective summary and one-shot state')
}

const testLegacyConfirmationWithoutPatchRemainsCompatible = async (): Promise<void> => {
  const localController = new AssistantPlanConfirmationController()
  const signal = new AbortController()
  const runId = 'legacy-plan-run'
  const waiting = localController.wait(planOwner, runId, signal.signal, planValidationInput())
  const approved = localController.confirm(planOwner, runId)
  assert.equal(approved.status, 'approved')
  assert.ok(approved.effectiveSummary, 'legacy confirmation must still return the effective summary')
  const confirmed = await waiting
  assert.deepEqual(confirmed?.effectiveSummary.searchTerms, ['旧词'])
  checks.push('confirming a pending plan without a patch preserves the legacy call shape')
}

const testOwnerAndCancellationBoundaries = async (): Promise<void> => {
  const localController = new AssistantPlanConfirmationController()
  const signal = new AbortController()
  const runId = 'boundary-plan-run'
  assert.deepEqual(localController.confirm(planOwner, 'unknown-plan-run', editedPlanPatch), {
    status: 'not_found',
    runId: 'unknown-plan-run'
  })
  const waiting = localController.wait(planOwner, runId, signal.signal, planValidationInput())
  assert.deepEqual(localController.confirm({ id: planOwner.id + 1 }, runId, editedPlanPatch), {
    status: 'not_found',
    runId
  })
  signal.abort(new Error('plan cancelled'))
  await assert.rejects(waiting, /plan cancelled/)
  assert.deepEqual(localController.confirm(planOwner, runId, editedPlanPatch), {
    status: 'not_found',
    runId
  })

  const closedController = new AssistantPlanConfirmationController()
  const closedSignal = new AbortController()
  const closedRun = 'window-closed-plan-run'
  const closedWaiting = closedController.wait(
    planOwner,
    closedRun,
    closedSignal.signal,
    planValidationInput()
  )
  closedController.clearOwner(planOwner)
  await assert.rejects(closedWaiting, /窗口已关闭/)
  assert.equal(closedController.confirm(planOwner, closedRun).status, 'not_found')
  checks.push('owner mismatch, cancellation, and closed-window cleanup never approve or execute a pending plan')
}

const testPendingPlanExpiresWithoutApproval = async (): Promise<void> => {
  const localController = new AssistantPlanConfirmationController(5)
  const signal = new AbortController()
  const runId = 'expired-plan-run'
  const waiting = localController.wait(planOwner, runId, signal.signal, planValidationInput())
  await assert.rejects(waiting, /执行计划确认已超时/)
  assert.equal(localController.confirm(planOwner, runId).status, 'not_found')
  checks.push('unconfirmed plans expire and cannot be approved after the timeout')
}

testPatchNormalizationAndEffectiveScope()
testExplicitRecordScopeRemainsImmutable()
testInvalidPatchIsFailClosed()
await testControllerKeepsPendingAfterInvalidPatch()
await testLegacyConfirmationWithoutPatchRemainsCompatible()
await testOwnerAndCancellationBoundaries()
await testPendingPlanExpiresWithoutApproval()

const controller = new AssistantPlanConfirmationController()
const owner = { id: 1 }
const stranger = { id: 2 }
const abortController = new AbortController()
let settled = false
const waiting = controller.wait(owner, 'plan-run-1', abortController.signal).then(() => { settled = true })
assert.deepEqual(controller.confirm(stranger, 'plan-run-1'), { status: 'not_found', runId: 'plan-run-1' })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(settled, false)
assert.deepEqual(controller.confirm(owner, 'plan-run-1'), { status: 'approved', runId: 'plan-run-1' })
await waiting
assert.equal(settled, true)
checks.push('plan approval is run-scoped and owner-isolated')

const cancelled = new AbortController()
const cancelledWait = controller.wait(owner, 'plan-run-2', cancelled.signal)
cancelled.abort(new Error('cancelled before approval'))
await assert.rejects(cancelledWait, /cancelled before approval/)
assert.equal(controller.confirm(owner, 'plan-run-2').status, 'not_found')
checks.push('run cancellation releases a pending plan without approval')

const directory = await mkdtemp(join(tmpdir(), 'assistant-plan-confirmation-'))
const db = new AppDatabase(join(directory, 'plan.db'), join(directory, 'assets'))
try {
  db.upsertRecord({
    uid: 'plan-record-1',
    projectId: 'project-a',
    nodeType: 'Requirement',
    itemId: 'PLAN-1',
    parentId: '',
    name: '负责人甲的需求',
    lastModifyTime: new Date(0).toISOString(),
    raw: { Owner: '负责人甲', Summary: '负责人甲的需求' },
    normalizedText: '负责人甲的需求'
  })
  const settings: ModelSettings = {
    source: 'online',
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'plan-regression',
    thinking: false,
    apiKey: 'test-key'
  }
  const intent: AssistantIntentDecision = {
    taskType: 'record_query',
    skillId: 'general',
    sourceMode: 'records',
    resolvedQuestion: '列出负责人甲的需求',
    resultMode: 'list',
    groupEntities: [],
    needsClarification: false,
    reason: 'test'
  }
  let releasePlan: (() => void) | undefined
  let observedSummary: AssistantExecutionSummary | undefined
  const approval = new Promise<void>((resolve) => { releasePlan = resolve })
  const agent = new OllamaAgent(db, settings, undefined, undefined, undefined, async (summary) => {
    observedSummary = summary
    await approval
  })
  const mutableAgent = agent as unknown as Record<string, unknown>
  const dataCenter = mutableAgent.dataCenterAgent as Record<string, unknown>
  const originalExecute = dataCenter.executePlan as (...args: unknown[]) => unknown
  let executionCalls = 0
  dataCenter.executePlan = (...args: unknown[]) => {
    executionCalls += 1
    return originalExecute.apply(dataCenter, args)
  }
  mutableAgent.callModel = async (input: ModelChatInput): Promise<ModelResponse> => {
    assert.equal(input.onTextDelta, undefined)
    if (input.format) {
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify({
            sourceMode: 'records',
            needsClarification: false,
            intent: 'filter_records',
            explanation: '按负责人字段筛选',
            searchTerms: [],
            searchMode: 'any',
            filters: [{ field: 'Owner', operator: 'contains', value: '负责人甲' }],
            fields: ['Owner', 'Summary'],
            resultMode: 'list',
            groupEntities: [],
            limit: 20
          })
        }
      }
    }
    return { message: { role: 'assistant', content: '已完成。' } }
  }
  const resultPromise = agent.ask({
    question: '列出负责人甲的需求',
    projectId: 'project-a',
    dataScope: {
      projectIds: ['project-a'],
      nodeTypes: ['Requirement'],
      baseFilters: [{ field: 'Owner', operator: 'contains', value: '负责人甲' }]
    },
    assistantIntent: intent
  })
  for (let attempt = 0; attempt < 50 && !observedSummary; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(observedSummary)
  assert.equal(executionCalls, 0, 'evidence execution must wait for explicit approval')
  assert.deepEqual(observedSummary.scope.projectIds, ['project-a'])
  assert.deepEqual(observedSummary.scope.nodeTypes, ['Requirement'])
  assert.deepEqual(observedSummary.scope.baseFilters, [{ field: 'Owner', operator: 'contains', value: '负责人甲' }])
  releasePlan?.()
  const result = await resultPromise
  assert.equal(executionCalls, 1)
  assert.deepEqual(result.executionSummary, observedSummary)
  checks.push('structured plan pauses before evidence and persists the confirmed effective scope')
} finally {
  db.close()
  await rm(directory, { recursive: true, force: true })
}

const testEditedPlanDrivesRecordExecution = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-plan-edit-execution-'))
  const db = new AppDatabase(join(directory, 'plan.db'), join(directory, 'assets'))
  try {
    for (const record of [
      {
        uid: 'plan-edit-old',
        projectId: 'project-a',
        nodeType: 'Requirement',
        itemId: 'PLAN-OLD',
        name: '旧项目旧词记录',
        owner: '旧负责人',
        summary: '旧词',
        priority: 'P0'
      },
      {
        uid: 'plan-edit-new',
        projectId: 'project-b',
        nodeType: 'Requirement',
        itemId: 'PLAN-NEW',
        name: '新项目新词记录',
        owner: '新负责人',
        summary: '新词',
        priority: 'P1'
      },
      {
        uid: 'plan-edit-wrong-type',
        projectId: 'project-b',
        nodeType: 'Task',
        itemId: 'PLAN-TASK',
        name: '新项目新词任务',
        owner: '新负责人',
        summary: '新词',
        priority: 'P1'
      }
    ]) {
      db.upsertRecord({
        uid: record.uid,
        projectId: record.projectId,
        nodeType: record.nodeType,
        itemId: record.itemId,
        parentId: '',
        name: record.name,
        lastModifyTime: new Date(0).toISOString(),
        raw: {
          Owner: record.owner,
          Summary: record.summary,
          Priority: record.priority
        },
        normalizedText: `${record.name} ${record.owner} ${record.summary} ${record.priority}`
      })
    }

    const settings: ModelSettings = {
      source: 'online',
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      model: 'plan-edit-execution-regression',
      thinking: false,
      apiKey: 'test-key'
    }
    const intent: AssistantIntentDecision = {
      taskType: 'record_query',
      skillId: 'general',
      sourceMode: 'records',
      resolvedQuestion: '查询旧词记录',
      resultMode: 'list',
      groupEntities: [],
      needsClarification: false,
      reason: 'test'
    }
    const runId = 'plan-edit-execution-run'
    const signal = new AbortController()
    const planController = new AssistantPlanConfirmationController()
    const executionPatch: AssistantPlanPatch = {
      searchTerms: [' 新词 ', '新词'],
      fields: [' 优先级 ', 'Priority'],
      scope: {
        projectIds: [' project-b ', 'PROJECT-B'],
        nodeTypes: [' requirement ', 'Requirement'],
        baseFilters: [{ field: '负责人', operator: 'contains', value: ' 新负责人 ' }]
      },
      filters: [{ field: '优先级', operator: 'equals', value: ' Ｐ１ ' }],
      limit: 2,
      resultMode: 'table'
    }
    const queryInputs: Record<string, unknown>[] = []
    const originalQuery = db.queryRecordsByFields.bind(db)
    Object.defineProperty(db, 'queryRecordsByFields', {
      configurable: true,
      writable: true,
      value: (...args: Parameters<AppDatabase['queryRecordsByFields']>) => {
        queryInputs.push(args[0] as unknown as Record<string, unknown>)
        return originalQuery(...args)
      }
    })

    let observedSummary: AssistantExecutionSummary | undefined
    let waitingForApproval: Promise<ConfirmedAssistantPlan | undefined> | undefined
    const confirmExecution = async (summary: AssistantExecutionSummary): Promise<ConfirmedAssistantPlan> => {
      observedSummary = summary
      waitingForApproval = planController.wait(planOwner, runId, signal.signal, {
        summary,
        dataScope: {
          projectIds: ['project-a'],
          nodeTypes: ['Requirement'],
          baseFilters: [{ field: 'Owner', operator: 'contains', value: '旧负责人' }]
        },
        metadata: {
          fields: [
            { field: 'Owner', displayName: '负责人', allowed: true, types: ['Requirement'] },
            { field: 'Summary', displayName: '摘要', allowed: true, types: ['Requirement'] },
            { field: 'Priority', displayName: '优先级', allowed: true, types: ['Requirement'] }
          ],
          projectIds: ['project-a', 'project-b'],
          nodeTypes: ['Requirement', 'Task']
        }
      })
      const confirmed = await waitingForApproval
      return confirmed ?? {
        effectiveSummary: summary,
        effectiveDataScope: {
          projectIds: ['project-a'],
          nodeTypes: ['Requirement'],
          baseFilters: [{ field: 'Owner', operator: 'contains', value: '旧负责人' }]
        },
        warnings: []
      }
    }
    const agent = new OllamaAgent(
      db,
      settings,
      undefined,
      undefined,
      undefined,
      confirmExecution
    )
    const mutableAgent = agent as unknown as Record<string, unknown>
    const dataCenter = mutableAgent.dataCenterAgent as Record<string, unknown>
    const originalExecutePlan = dataCenter.executePlan as (...args: unknown[]) => unknown
    let executedProjectId: unknown
    let executedPlan: Record<string, unknown> | undefined
    let executedToolArgs: Record<string, unknown> | undefined
    dataCenter.executePlan = (...args: unknown[]) => {
      executedProjectId = args[0]
      executedPlan = args[1] as Record<string, unknown>
      const execution = originalExecutePlan.apply(dataCenter, args) as {
        args?: Record<string, unknown>
      }
      executedToolArgs = execution.args
      return execution
    }
    mutableAgent.callModel = async (input: ModelChatInput): Promise<ModelResponse> => {
      if (input.format) {
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              sourceMode: 'records',
              needsClarification: false,
              intent: 'filter_records',
              explanation: '按旧词和旧负责人筛选',
              searchTerms: ['旧词'],
              searchMode: 'any',
              filters: [{ field: 'Owner', operator: 'contains', value: '旧负责人' }],
              fields: ['Owner', 'Summary'],
              resultMode: 'list',
              groupEntities: [],
              limit: 7
            })
          }
        }
      }
      return { message: { role: 'assistant', content: '已按确认后的编辑计划执行。' } }
    }

    const resultPromise = agent.ask({
      runId,
      question: '查询旧词记录',
      projectId: 'project-a',
      dataScope: {
        projectIds: ['project-a'],
        nodeTypes: ['Requirement'],
        baseFilters: [{ field: 'Owner', operator: 'contains', value: '旧负责人' }]
      },
      assistantIntent: intent
    })
    for (let attempt = 0; attempt < 100 && !observedSummary; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(observedSummary, 'a data plan must be visible before edited execution is released')
    assert.equal(queryInputs.length, 0, 'editing/waiting for approval must not access record evidence')

    const approved = planController.confirm(planOwner, runId, executionPatch)
    assert.equal(approved.status, 'approved')
    assert.ok(approved.effectiveSummary)
    const result = await resultPromise
    assert.equal(executedProjectId, 'project-b')
    const executedScope = executedPlan?.scope as Record<string, unknown> | undefined
    assert.deepEqual(executedScope?.projectIds, ['project-b'])
    assert.deepEqual(executedScope?.nodeTypes, ['Requirement'])
    assert.deepEqual(executedPlan?.searchTerms, ['新词'])
    assert.deepEqual(executedPlan?.fields, ['Priority'])
    assert.deepEqual(executedPlan?.filters, [{ field: 'Priority', operator: 'equals', value: 'P1' }])
    assert.equal(executedPlan?.limit, 2)
    assert.equal(executedPlan?.resultMode, 'table')
    assert.equal(executedToolArgs?.project_id, 'project-b')
    assert.deepEqual(executedToolArgs?.project_ids, ['project-b'])
    assert.deepEqual(executedToolArgs?.node_types, ['Requirement'])
    assert.deepEqual(executedToolArgs?.search_terms, ['新词'])
    assert.deepEqual(executedToolArgs?.fields, ['Priority'])
    assert.deepEqual(executedToolArgs?.base_filters, [
      { field: 'Owner', operator: 'contains', value: '新负责人' }
    ])
    assert.deepEqual(executedToolArgs?.filters, [
      { field: 'Priority', operator: 'equals', value: 'P1' }
    ])
    assert.equal(executedToolArgs?.limit, 2)
    assert.equal(executedToolArgs?.result_mode, 'table')
    const queryInput = queryInputs.at(-1)
    assert.ok(queryInput, 'approved plan must reach the structured record query')
    assert.deepEqual(queryInput?.projectIds, ['project-b'])
    assert.deepEqual(queryInput?.nodeTypes, ['Requirement'])
    assert.deepEqual(queryInput?.searchTerms, ['新词'])
    assert.deepEqual(queryInput?.fields, ['Priority'])
    assert.deepEqual(queryInput?.baseFilters, [
      { field: 'Owner', operator: 'contains', value: '新负责人' },
    ])
    assert.deepEqual(queryInput?.filters, [
      { field: 'Priority', operator: 'equals', value: 'P1' }
    ])
    assert.equal(queryInput?.limit, 2)
    assert.doesNotMatch(JSON.stringify(queryInput), /旧词|旧负责人|project-a|Summary/u)
    assert.deepEqual(result.executionSummary, approved.effectiveSummary)
    assert.deepEqual(result.executionSummary?.scope.projectIds, ['project-b'])
    assert.deepEqual(result.executionSummary?.scope.nodeTypes, ['Requirement'])
    assert.deepEqual(result.executionSummary?.searchTerms, ['新词'])
    assert.deepEqual(result.executionSummary?.fields, ['Priority'])
    assert.equal(result.executionSummary?.resultMode, 'table')
    assert.equal(result.executionSummary?.limit, 2)
    const view = result.dataViews[0]
    assert.ok(view)
    assert.deepEqual(view?.fields, ['Priority'])
    assert.deepEqual(view?.recordUids, ['plan-edit-new'])
    checks.push('approved edits drive record tools and final summary with new terms, fields, filters, scope, limit, and result mode')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

await testEditedPlanDrivesRecordExecution()

const testEditedTermsDriveKnowledgeRetrieval = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-plan-edit-knowledge-'))
  const db = new AppDatabase(join(directory, 'plan.db'), join(directory, 'assets'))
  try {
    const knowledgeCalls: Array<{ query: string; limit?: number }> = []
    const hit: KnowledgeSearchHit = {
      source: {
        uid: 'document:edited-plan',
        name: '编辑计划文档',
        nodeType: 'knowledge_document',
        itemId: 'edited-plan',
        sourceType: 'document',
        fileName: 'edited-plan.md',
        snippet: '新知识词对应的文档证据。',
        score: 0.95
      },
      chunk: {
        id: 'chunk-edited-plan',
        documentId: 'edited-plan',
        sourceType: 'document',
        sourceName: '编辑计划文档',
        content: '新知识词对应的文档证据。',
        chunkIndex: 0,
        location: '第 1 页',
        charStart: 0,
        charEnd: 14
      },
      score: 0.95
    }
    const knowledge = {
      modelVersion: 'plan-edit-knowledge-regression',
      search: async (query: string, limit?: number) => {
        knowledgeCalls.push({ query, limit })
        return [hit]
      }
    } as unknown as KnowledgeService
    const settings: ModelSettings = {
      source: 'online',
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      model: 'plan-edit-knowledge-regression',
      thinking: false,
      apiKey: 'test-key'
    }
    const intent: AssistantIntentDecision = {
      taskType: 'knowledge_qa',
      skillId: 'general',
      sourceMode: 'knowledge',
      resolvedQuestion: '查询旧知识词',
      resultMode: 'answer',
      groupEntities: ['旧知识词'],
      needsClarification: false,
      reason: 'test'
    }
    const runId = 'plan-edit-knowledge-run'
    const signal = new AbortController()
    const planController = new AssistantPlanConfirmationController()
    let observedSummary: AssistantExecutionSummary | undefined
    const confirmExecution = async (summary: AssistantExecutionSummary): Promise<ConfirmedAssistantPlan> => {
      observedSummary = summary
      const pending = planController.wait(planOwner, runId, signal.signal, {
        summary,
        metadata: {}
      })
      const confirmed = await pending
      return confirmed ?? {
        effectiveSummary: summary,
        effectiveDataScope: {},
        warnings: []
      }
    }
    const agent = new OllamaAgent(
      db,
      settings,
      knowledge,
      undefined,
      undefined,
      confirmExecution
    )
    const mutableAgent = agent as unknown as Record<string, unknown>
    mutableAgent.callModel = async (input: ModelChatInput): Promise<ModelResponse> => {
      if (input.format) {
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({
              sourceMode: 'knowledge',
              needsClarification: false,
              intent: 'search_content',
              explanation: '检索旧知识词',
              searchTerms: ['旧知识词'],
              searchMode: 'any',
              filters: [],
              fields: [],
              resultMode: 'answer',
              groupEntities: ['旧知识词'],
              limit: 8
            })
          }
        }
      }
      return { message: { role: 'assistant', content: '已按编辑后的知识检索词回答。[UID:document:edited-plan]' } }
    }

    const resultPromise = agent.ask({
      runId,
      question: '知识库的旧知识词是什么？',
      assistantIntent: intent
    })
    for (let attempt = 0; attempt < 100 && !observedSummary; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(observedSummary, 'a knowledge plan must be visible before retrieval is released')
    assert.equal(knowledgeCalls.length, 0, 'knowledge evidence must wait for plan confirmation')
    const approved = planController.confirm(planOwner, runId, {
      searchTerms: [' 新知识词 ', '新知识词'],
      limit: 3
    })
    assert.equal(approved.status, 'approved')
    assert.ok(approved.effectiveSummary)
    const result = await resultPromise
    assert.equal(knowledgeCalls.length, 1)
    assert.match(knowledgeCalls[0]?.query ?? '', /新知识词/u)
    assert.doesNotMatch(knowledgeCalls[0]?.query ?? '', /旧知识词/u)
    assert.equal(knowledgeCalls[0]?.limit, 3)
    assert.deepEqual(result.executionSummary, approved.effectiveSummary)
    assert.deepEqual(result.executionSummary?.searchTerms, ['新知识词'])
    assert.equal(result.executionSummary?.limit, 3)
    assert.equal(result.sources[0]?.sourceType, 'document')
    checks.push('approved knowledge edits replace the old search terms in retrieval and final summary')
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

await testEditedTermsDriveKnowledgeRetrieval()

const [main, preload, renderer, shared] = await Promise.all([
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8')
])
assert.match(main, /agent:confirm-plan/)
assert.match(preload, /confirmAgentPlan/)
assert.match(preload, /confirmAgentPlan:\s*\(runId: string, patch\?: AssistantPlanPatch\)/)
assert.match(preload, /ipcRenderer\.invoke\('agent:confirm-plan', runId, patch\)/)
assert.match(main, /agent:confirm-plan[\s\S]{0,320}patch as AssistantPlanPatch/u)
assert.match(shared, /executionSummary\?:\s*AssistantExecutionSummary/)
assert.match(shared, /dataScope\?:\s*DataScope/)
assert.match(renderer, /确认并执行/)
assert.match(renderer, /本轮实际执行范围/)
assert.match(renderer, /latestScopedMessage/)
checks.push('IPC, persisted message, UI confirmation, and session scope restoration contracts agree')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
