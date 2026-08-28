import { strict as assert } from 'node:assert'
import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { planAnalysisBlueprint, VisualizationAgent } from '../src/main/experts/visualization-agent'
import { resolveVisualizationRequestMode } from '../src/main/experts/visualization-intent'
import { ExpertRouter } from '../src/main/experts/router'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import {
  automaticDashboardComponentTitle,
  validateDashboardSemanticConsistency
} from '../src/shared/dashboard-semantics'
import type {
  DashboardAnalysisBlueprint,
  DashboardComponentSpec,
  DashboardSpec,
  VisualizationRunInput
} from '../src/shared/dashboard'
import type { FieldProfile } from '../src/shared/query-spec'

const records: AnalyticsRecord[] = [
  {
    uid: 'ai-context-1',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-1',
    name: 'Issue 1',
    lastModifyTime: '2026-07-01T10:00:00Z',
    raw: { status: 'open', effort: 3, score: 8, email: 'one@example.com', note: 'high' }
  },
  {
    uid: 'ai-context-2',
    projectId: 'p1',
    nodeType: 'Issue',
    itemId: 'I-2',
    name: 'Issue 2',
    lastModifyTime: '2026-07-08T10:00:00Z',
    raw: { status: 'closed', effort: 5, score: 13, email: 'two@example.com', note: 'low' }
  }
]

const fakeDb = {
  scanAnalyticsRecords: (scope) => records.filter((record) =>
    !scope.projectIds?.length || scope.projectIds.includes(record.projectId)
  )
} as AppDatabase

const component = (id: string, title: string, x: number): DashboardComponentSpec => ({
  id,
  type: 'kpi',
  title,
  layout: { x, y: 0, w: 6, h: 3 },
  data: [{ name: title, value: 2 }],
  query: {
    source: 'records',
    scope: { projectIds: ['p1'] },
    dimensions: [],
    measures: [{ id: 'records', aggregation: 'count' }],
    limit: 1
  },
  encoding: { value: 'records' }
})

const baseDashboard: DashboardSpec = {
  schemaVersion: '1.0',
  id: 'dashboard-ai-context-smoke',
  title: 'Operations dashboard',
  subtitle: 'AI context smoke test',
  businessContext: {
    audience: 'QA',
    objective: 'Verify continuous AI patches',
    scopeDescription: 'p1'
  },
  viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
  theme: 'technology-dark',
  updatedAt: new Date().toISOString(),
  components: [
    component('kpi-total', 'Total issues', 0),
    component('kpi-open', 'Open issues', 6),
    component('kpi-closed', 'Closed issues', 12),
    component('kpi-effort', 'Total effort', 18)
  ]
}

const semanticBlueprint: DashboardAnalysisBlueprint = {
  version: '1.0',
  request: '观察缺陷总量和状态分布',
  audience: '项目经理',
  objective: '跟踪研发质量',
  scopeDescription: 'p1 Issue 数据',
  metrics: [{
    id: 'issueCount',
    label: '缺陷',
    measureId: 'records',
    aggregation: 'count',
    source: 'catalog',
    confidence: 1
  }],
  questions: [
    {
      id: 'q-total',
      question: '当前缺陷总量是多少？',
      metricIds: ['issueCount'],
      dimensionFields: [],
      preferredComponentTypes: ['kpi'],
      slotRole: 'headline',
      priority: 1,
      required: true
    },
    {
      id: 'q-status',
      question: '缺陷按状态如何分布？',
      metricIds: ['issueCount'],
      dimensionFields: ['status'],
      preferredComponentTypes: ['bar'],
      slotRole: 'comparison',
      priority: 2,
      required: false
    }
  ],
  assumptions: [],
  unresolvedAmbiguities: [],
  generatedAt: '2026-08-27T00:00:00.000Z'
}

const runCanonicalMetadataLabelContract = (): void => {
  const scope = { projectIds: ['p1'] }
  const profiled = new QueryEngine(fakeDb).profile(scope)
  const dateProfile = profiled.find((profile) => profile.field === 'lastModifyTime')
  assert.ok(dateProfile, 'canonical metadata fixture must expose lastModifyTime')
  const profiles: FieldProfile[] = [
    { ...dateProfile, displayName: 'last Modify Time' },
    { ...dateProfile, field: '_valm_LastModifyTime', displayName: undefined },
    ...profiled.filter((profile) => profile.field !== 'lastModifyTime')
  ]
  const blueprint = planAnalysisBlueprint('按最后修改时间生成趋势', scope, profiles)
  const trendQuestions = blueprint.questions.filter((question) =>
    question.dimensionFields.includes('lastModifyTime')
  )
  assert.ok(trendQuestions.length, 'canonical lastModifyTime must produce a trend question')
  for (const question of trendQuestions) {
    assert.match(question.question, /最后修改时间/,
      'canonical metadata trend question must use the localized label')
    assert.doesNotMatch(question.question, /_valm_|lastModifyTime/i,
      'canonical metadata trend question must not expose the raw field key')
  }
}

const semanticDashboard: DashboardSpec = {
  ...baseDashboard,
  id: 'dashboard-ai-context-semantic',
  analysisBlueprint: semanticBlueprint,
  components: baseDashboard.components.map((item) => ({
    ...item,
    title: '缺陷数量',
    semanticBinding: {
      questionId: 'q-total',
      metricIds: ['issueCount'],
      dimensionFields: [],
      titleMode: 'auto' as const,
      confidence: 1
    },
    slotRole: 'headline' as const
  }))
}

const settings = {
  source: 'local' as const,
  provider: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434',
  model: 'test-model',
  thinking: false
}

assert.equal(resolveVisualizationRequestMode('生成项目管理大屏看板', true), 'generate')
assert.equal(
  resolveVisualizationRequestMode(
    '生成项目管理看板，最低不少于8个组件，需要统计开发负责人排行、测试负责人排行、发布数排行。',
    true
  ),
  'generate'
)
assert.equal(resolveVisualizationRequestMode('把当前大屏改成明亮商务主题', true), 'patch')
assert.equal(resolveVisualizationRequestMode('修改选中组件标题', true, 'kpi-total'), 'patch')
assert.equal(resolveVisualizationRequestMode('生成新的项目看板', true, 'kpi-total'), 'patch')
assert.equal(resolveVisualizationRequestMode('生成项目管理大屏看板', false), 'generate')

const expertRouter = new ExpertRouter()
assert.equal(expertRouter.route({
  question: '@数据可视化专家 生成项目管理大屏',
  conversationId: 'chat-routing-smoke',
  entrypoint: 'chat',
  expertId: 'general'
}).expert.id, 'visualization')
assert.equal(expertRouter.route({
  question: '按开发负责人、测试负责人、发布统计当前数据',
  conversationId: 'chat-routing-smoke',
  entrypoint: 'chat',
  expertId: 'general'
}).expert.id, 'general')

const modelResponses = [
  [{ op: 'set-dashboard-title', value: 'Operations overview' }],
  [{ op: 'set-theme', value: 'light-business' }],
  [{ op: 'set-dashboard-title', value: 'Issue count' }],
  [{ op: 'set-component-limit', componentId: 'kpi-total', limit: 25 }],
  [{
    op: 'set-component-sort',
    componentId: 'kpi-total',
    sortField: 'records',
    sortDirection: 'desc'
  }],
  [
    { op: 'set-component-time-grain', componentId: 'kpi-total', timeGrain: 'month' }
  ],
  [{ op: 'set-component-subtitle', componentId: 'kpi-total', value: 'Monthly tracked issues' }],
  [{ op: 'set-dashboard-title', value: 'Rejected cross-component change' }],
  [{ op: 'set-dashboard-title', value: 'Rejected cross-component retry' }],
  [{ op: 'set-dashboard-subtitle', value: 'Recovered after a rejected patch' }],
  [{ op: 'remove-component', componentId: 'kpi-effort' }]
]

const originalFetch = globalThis.fetch
const versions: number[] = []
const runs: VisualizationRunInput[] = []
const modelPayloads: Array<{
  messages?: Array<{ role?: string; content?: string }>
}> = []
let fetchCount = 0
let current = baseDashboard
let fullRefreshQueryBaseline = 0

const queryExecutions = (run: VisualizationRunInput): number =>
  run.toolCalls.filter((call) => call.tool === 'execute-query').length

const patchMetadata = (run: VisualizationRunInput): Record<string, number | boolean> | undefined =>
  run.toolCalls.find((call) => call.tool === 'apply-patch' && call.status === 'success')?.metadata

const componentSnapshot = (
  dashboard: DashboardSpec,
  excludedId?: string
): DashboardComponentSpec[] => dashboard.components
  .filter((item) => item.id !== excludedId)
  .map((item) => JSON.parse(JSON.stringify(item)) as DashboardComponentSpec)

const longHistory = [
  { role: 'user', content: 'Keep the original quarterly operations context for later follow-ups' },
  { role: 'assistant', content: 'Quarterly operations context saved' },
  { role: 'user', content: 'Use concise metric labels' },
  { role: 'assistant', content: 'Metric labels are concise' },
  { role: 'user', content: 'Keep the executive audience in mind' },
  { role: 'assistant', content: 'Executive audience retained' },
  { role: 'user', content: 'Preserve issue status terminology' },
  { role: 'assistant', content: 'Issue status terminology retained' },
  { role: 'user', content: 'This rejected request must not become context', outcome: 'failed' },
  { role: 'assistant', content: 'The rejected change was not applied', outcome: 'failed' },
  { role: 'user', content: 'This undone request must not become context', outcome: 'undone' },
  { role: 'assistant', content: 'The change was later undone', outcome: 'undone' },
  { role: 'user', content: 'Recent request one' },
  { role: 'assistant', content: 'Recent result one' },
  { role: 'user', content: 'Recent request two' },
  { role: 'assistant', content: 'Recent result two' },
  { role: 'user', content: 'Recent request three' },
  { role: 'assistant', content: 'Recent result three' },
  { role: 'user', content: 'Recent request four' },
  { role: 'assistant', content: 'Recent result four' }
] as const

try {
  globalThis.fetch = async (_input, init) => {
    const operations = modelResponses[fetchCount]
    fetchCount += 1
    assert.ok(operations, `unexpected model request ${fetchCount}`)
    if (typeof init?.body === 'string') {
      modelPayloads.push(JSON.parse(init.body) as (typeof modelPayloads)[number])
    }
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ operations }) }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const agent = new VisualizationAgent(
    new QueryEngine(fakeDb),
    settings,
    (run) => runs.push(run)
  )
  const scope = { projectIds: ['p1'] }
  let semanticUpgradePatchCount = 0

  const applySuccessfulPatch = async (
    question: string,
    options: {
      focusComponentId?: string
      expectedQueries: number
      allowLayoutChanges?: boolean
      allowSemanticUpgrade?: boolean
      history?: Array<{ role: 'user' | 'assistant'; content: string }>
    }
  ): Promise<DashboardSpec> => {
    const before = current
    const unaffectedBefore = componentSnapshot(before, options.focusComponentId)
    const beforeSource = JSON.stringify(before)
    const next = await agent.patch(
      question,
      before,
      scope,
      options.focusComponentId,
      options.history
    )
    current = next
    versions.push(versions.length + 1)
    fullRefreshQueryBaseline += next.components.filter((item) => item.query).length
    assert.equal(next.id, baseDashboard.id)
    assert.equal(queryExecutions(runs.at(-1)!), options.expectedQueries)
    assert.equal(patchMetadata(runs.at(-1)!)?.queryExecutionCount, options.expectedQueries)
    assert.equal(JSON.stringify(before), beforeSource, 'patch 不得修改传入的源 Spec')
    if (options.allowSemanticUpgrade) {
      assert.equal(semanticUpgradePatchCount, 0,
        'allowSemanticUpgrade 只能用于首次 legacy 数据变更 patch')
      assert.equal(question, 'Show the top 25 results',
        'allowSemanticUpgrade 只能用于 Show the top 25 results legacy patch')
      assert.equal(options.focusComponentId, 'kpi-total')
      assert.equal(options.expectedQueries, 1)
      assert.equal(options.allowLayoutChanges, undefined,
        '语义升级契约不得放宽布局不变断言')
      semanticUpgradePatchCount += 1
      const beforeById = new Map(unaffectedBefore.map((item) => [item.id, item]))
      assert.equal(next.components.length, before.components.length,
        'legacy 语义升级 patch 不得增删组件')
      for (const item of next.components.filter((candidate) => candidate.id !== options.focusComponentId)) {
        const previous = beforeById.get(item.id)
        assert.ok(previous)
        assert.deepEqual({
          id: item.id,
          type: item.type,
          title: item.title,
          layout: item.layout,
          data: item.data,
          query: item.query,
          encoding: item.encoding
        }, {
          id: previous.id,
          type: previous.type,
          title: previous.title,
          layout: previous.layout,
          data: previous.data,
          query: previous.query,
          encoding: previous.encoding
        }, `legacy 语义升级不得改写未聚焦组件 ${item.id} 的业务内容`)
        assert.ok(item.semanticBinding, `legacy 组件 ${item.id} 必须补齐 semanticBinding`)
        assert.ok(item.slotRole, `legacy 组件 ${item.id} 必须补齐 slotRole`)
      }
      assert.ok(next.analysisBlueprint, 'legacy 数据变更后必须生成 Blueprint')
      assert.ok(next.components.every((item) => item.semanticBinding && item.slotRole),
        'legacy 数据变更后全部组件必须具备 semanticBinding 与 slotRole')
      const semanticIssues = validateDashboardSemanticConsistency(next)
      assert.deepEqual(
        semanticIssues.filter((issue) => issue.severity === 'error'),
        [],
        'legacy 数据变更升级后的完整 Spec 不得有语义错误'
      )
      const legacyComponentIds = new Set(before.components.map((item) => item.id))
      const warningCounts = new Map<string, number>()
      for (const issue of semanticIssues.filter((item) => item.severity === 'warning')) {
        assert.equal(issue.code, 'custom-title-weak-match',
          'legacy 保留用户标题时仅允许 custom-title-weak-match warning')
        assert.ok(issue.componentId && legacyComponentIds.has(issue.componentId),
          'legacy 标题 warning 必须指向旧组件')
        const count = (warningCounts.get(issue.componentId) ?? 0) + 1
        warningCounts.set(issue.componentId, count)
        assert.ok(count <= 1, `legacy 旧组件 ${issue.componentId} 最多允许一条标题 warning`)
      }
    } else if (!options.allowLayoutChanges) {
      assert.deepEqual(componentSnapshot(next, options.focusComponentId), unaffectedBefore)
    } else {
      const beforeById = new Map(unaffectedBefore.map((item) => [item.id, item]))
      for (const item of next.components.filter((candidate) => candidate.id !== options.focusComponentId)) {
        const previous = beforeById.get(item.id)
        assert.ok(previous)
        assert.deepEqual(item.query, previous.query)
        assert.deepEqual(item.data, previous.data)
        assert.equal(item.title, previous.title)
      }
    }
    return next
  }

  await applySuccessfulPatch('Rename the dashboard', {
    expectedQueries: 0,
    history: [...longHistory]
  })
  assert.equal(current.title, 'Operations overview')
  const firstModelContext = JSON.parse(modelPayloads[0].messages?.[1]?.content ?? '{}') as {
    conversationContext?: {
      currentState?: { title?: string; components?: Array<{ id?: string }> }
      earlierSuccessfulRequests?: string[]
      recentTurns?: Array<{ role: string; content: string }>
      omittedTurnCount?: number
    }
  }
  assert.equal(firstModelContext.conversationContext?.currentState?.title, baseDashboard.title)
  assert.deepEqual(
    firstModelContext.conversationContext?.currentState?.components?.map((item) => item.id),
    baseDashboard.components.map((item) => item.id)
  )
  assert.ok(firstModelContext.conversationContext?.earlierSuccessfulRequests?.includes(
    'Keep the original quarterly operations context for later follow-ups'
  ))
  assert.equal(firstModelContext.conversationContext?.recentTurns?.length, 8)
  assert.equal(firstModelContext.conversationContext?.recentTurns?.[0]?.content, 'Recent request one')
  assert.equal(firstModelContext.conversationContext?.omittedTurnCount, 12)
  assert.ok(!JSON.stringify(firstModelContext.conversationContext).includes('rejected request'))
  assert.ok(!JSON.stringify(firstModelContext.conversationContext).includes('undone request'))
  assert.ok(JSON.stringify(firstModelContext.conversationContext).length < 12_000)

  await applySuccessfulPatch('Use the business light theme', { expectedQueries: 0 })
  assert.equal(current.theme, 'business-light')

  await applySuccessfulPatch('Rename only the selected component', {
    focusComponentId: 'kpi-total',
    expectedQueries: 0
  })
  assert.equal(current.components.find((item) => item.id === 'kpi-total')?.title, 'Issue count')
  assert.deepEqual(current.components.find((item) => item.id === 'kpi-total')?.data, [
    { name: 'Issue count', value: 2 }
  ])
  const focusedModelContext = JSON.parse(modelPayloads[2].messages?.[1]?.content ?? '{}') as {
    currentDashboard?: DashboardSpec
    focusComponent?: { id?: string }
  }
  assert.deepEqual(
    focusedModelContext.currentDashboard?.components.map((item) => item.id),
    ['kpi-total']
  )
  assert.equal(focusedModelContext.focusComponent?.id, 'kpi-total')

  await applySuccessfulPatch('Show the top 25 results', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1,
    allowSemanticUpgrade: true
  })
  assert.equal(current.components.find((item) => item.id === 'kpi-total')?.query?.limit, 25)

  await applySuccessfulPatch('Sort by issue count descending', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1
  })
  assert.deepEqual(current.components.find((item) => item.id === 'kpi-total')?.query?.sort, [
    { field: 'records', direction: 'desc' }
  ])

  await applySuccessfulPatch('Change the selected KPI into a monthly line chart', {
    focusComponentId: 'kpi-total',
    expectedQueries: 1,
    allowLayoutChanges: true
  })
  const lineComponent = current.components.find((item) => item.id === 'kpi-total')
  assert.equal(lineComponent?.type, 'line')
  assert.equal(lineComponent?.query?.dimensions?.length, 1)
  assert.equal(lineComponent?.query?.dimensions?.[0]?.timeGrain, 'month')
  assert.equal(lineComponent?.encoding?.label, lineComponent?.query?.dimensions?.[0]?.field)

  await applySuccessfulPatch('Add a subtitle to the selected line chart', {
    focusComponentId: 'kpi-total',
    expectedQueries: 0
  })
  assert.equal(
    current.components.find((item) => item.id === 'kpi-total')?.subtitle,
    'Monthly tracked issues'
  )

  const beforeRejectedPatch = JSON.parse(JSON.stringify(current)) as DashboardSpec
  await assert.rejects(
    () => agent.patch(
      'Change the whole dashboard while a component is selected',
      current,
      scope,
      'kpi-total'
    ),
    /DashboardSpec/
  )
  assert.deepEqual(current, beforeRejectedPatch)
  assert.equal(runs.at(-1)?.status, 'failed')
  assert.equal(queryExecutions(runs.at(-1)!), 0)
  assert.ok(runs.at(-1)?.toolCalls.some((call) => call.tool === 'repair-attempt'))

  await applySuccessfulPatch('Update the subtitle after the rejected change', { expectedQueries: 0 })
  assert.equal(current.subtitle, 'Recovered after a rejected patch')

  await applySuccessfulPatch('Remove the effort KPI', {
    focusComponentId: 'kpi-effort',
    expectedQueries: 0
  })
  assert.equal(current.components.some((item) => item.id === 'kpi-effort'), false)
  assert.equal(patchMetadata(runs.at(-1)!)?.removedComponentCount, 1)

  assert.equal(fetchCount, 11)
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(runs.map(queryExecutions), [0, 0, 0, 1, 1, 1, 0, 0, 0, 0])
  const incrementalQueryExecutions = runs.reduce((total, run) => total + queryExecutions(run), 0)
  assert.equal(fullRefreshQueryBaseline, 35)
  assert.equal(incrementalQueryExecutions, 3)
  assert.deepEqual(validateDashboardSpec(current, new QueryEngine(fakeDb)), [])

  globalThis.fetch = async () => new Response(JSON.stringify({
    message: {
      content: JSON.stringify({
        schemaVersion: '1.0',
        id: 'generated-with-missing-title',
        title: 'Generated dashboard',
        subtitle: 'Normalization smoke test',
        businessContext: {
          audience: 'QA',
          objective: 'Normalize generated metadata',
          scopeDescription: 'p1'
        },
        viewport: { width: 1920, height: 1080, columns: 24, rowHeight: 56 },
        theme: 'technology-dark',
        globalFilters: [{
          id: 'status-filter',
          field: 'status',
          label: '',
          operator: 'in',
          options: ['open', 'closed']
        }],
        updatedAt: new Date().toISOString(),
        components: [1, 2, 3, 4].map((index) => ({
          id: `generated-${index}`,
          type: 'kpi',
          title: index === 2 ? '' : `Metric ${index}`,
          layout: { x: (index - 1) * 6, y: 0, w: 6, h: 3 },
          data: [],
          query: {
            source: 'records',
            scope: { projectIds: ['p1'] },
            dimensions: [],
            measures: [{ id: 'records', aggregation: 'count' }],
            limit: 1
          },
          encoding: { value: 'records' }
        }))
      })
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const generatedWithFallback = await new VisualizationAgent(
    new QueryEngine(fakeDb),
    settings
  ).generate('Generate a dashboard', { projectIds: ['p1'] })
  assert.equal(
    generatedWithFallback.components[1].title,
    '记录数',
    '缺失模型标题时应从受控 count QuerySpec 生成语义标题'
  )
  assert.equal(generatedWithFallback.globalFilters?.[0].label, 'status')
  assert.deepEqual(validateDashboardSpec(generatedWithFallback, new QueryEngine(fakeDb)), [])

  console.log(JSON.stringify({
    ok: true,
    dashboardId: current.id,
    versions,
    successfulPatches: versions.length,
    rejectedPatches: runs.filter((run) => run.status === 'failed').length,
    queryExecutions: runs.map(queryExecutions),
    fullRefreshQueryBaseline,
    incrementalQueryExecutions,
    queryReductionPercent: Number(
      ((1 - incrementalQueryExecutions / fullRefreshQueryBaseline) * 100).toFixed(1)
    ),
    fetchCount,
    finalComponentCount: current.components.length
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}

const runSemanticPatchContract = async (): Promise<void> => {
  const previousFetch = globalThis.fetch
  let responsePayload: unknown = {
    ...semanticDashboard,
    id: 'generated-semantic-dashboard',
    title: '研发质量语义大屏',
    components: semanticDashboard.components.map((item) => ({ ...item, data: [] }))
  }
  const responseOf = (): Response => new Response(JSON.stringify({
    message: { content: JSON.stringify(responsePayload) }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

  const addOperation = {
    op: 'add-component',
    type: 'bar',
    title: '状态分布',
    questionId: 'q-status',
    dimensionField: 'status',
    aggregation: 'count'
  }
  const focusedAddOperation = addOperation
  const missingFieldOperation = {
    ...addOperation,
    dimensionField: 'missing-field'
  }
  const incompatibleOperation = {
    ...addOperation,
    type: 'line'
  }
  const scatterOperation = {
    ...addOperation,
    type: 'scatter'
  }

  try {
    globalThis.fetch = async () => responseOf()
    const agent = new VisualizationAgent(
      new QueryEngine(fakeDb),
      settings
    )
    const generated = await agent.generate('生成带业务语义绑定的研发质量大屏', { projectIds: ['p1'] })
    assert.ok(generated.analysisBlueprint, '新生成大屏必须携带 analysisBlueprint')
    assert.ok(generated.components.length >= 4)
    assert.ok(generated.components.every((item) => item.semanticBinding && item.slotRole),
      '新生成组件必须携带 semanticBinding 与 slotRole')
    assert.deepEqual(validateDashboardSemanticConsistency(generated), [],
      '新生成大屏的语义绑定必须通过一致性校验')

    responsePayload = { operations: [addOperation] }
    const added = await agent.patch(
      '增加一个按状态展示的分布组件',
      semanticDashboard,
      { projectIds: ['p1'] }
    )
    assert.equal(added.components.length, semanticDashboard.components.length + 1,
      'add-component 必须只新增一个组件')
    const originalIds = new Set(semanticDashboard.components.map((item) => item.id))
    const addedComponent = added.components.find((item) => !originalIds.has(item.id))
    assert.ok(addedComponent, 'add-component 必须产生新的组件 id')
    assert.equal(addedComponent.type, 'bar')
    assert.equal(addedComponent.query?.dimensions?.[0]?.field, 'status')
    assert.equal(addedComponent.encoding?.label, 'status')
    assert.equal(addedComponent.semanticBinding?.questionId, 'q-status')
    assert.deepEqual(addedComponent.semanticBinding?.metricIds, ['issueCount'])
    assert.equal(addedComponent.slotRole, 'comparison')
    assert.equal(
      addedComponent.title,
      automaticDashboardComponentTitle(semanticBlueprint, addedComponent),
      '新增组件标题必须由复用的指标和维度自动生成'
    )
    assert.ok(addedComponent.data.length > 0, '新增受控组件必须完成查询物化')
    assert.deepEqual(validateDashboardSemanticConsistency(added), [])

    responsePayload = { operations: [focusedAddOperation] }
    const focusedBefore = JSON.parse(JSON.stringify(semanticDashboard)) as DashboardSpec
    await assert.rejects(() => agent.patch(
      '在选中组件内新增一个状态分布图',
      semanticDashboard,
      { projectIds: ['p1'] },
      'kpi-total'
    ), '聚焦组件模式不得执行 add-component')
    assert.deepEqual(semanticDashboard, focusedBefore, '聚焦新增被拒时原 Spec 必须保持不变')

    responsePayload = { operations: [missingFieldOperation] }
    const missingBefore = JSON.parse(JSON.stringify(semanticDashboard)) as DashboardSpec
    await assert.rejects(() => agent.patch(
      '增加一个使用不存在字段的组件',
      semanticDashboard,
      { projectIds: ['p1'] }
    ), '不存在字段必须拒绝而不能静默替换')
    assert.deepEqual(semanticDashboard, missingBefore, '不存在字段失败时原 Spec 必须保持不变')

    responsePayload = { operations: [incompatibleOperation] }
    const incompatibleBefore = JSON.parse(JSON.stringify(semanticDashboard)) as DashboardSpec
    await assert.rejects(() => agent.patch(
      '增加一个不兼容的折线组件',
      semanticDashboard,
      { projectIds: ['p1'] }
    ), '不兼容组件/字段必须拒绝而不能静默替换')
    assert.deepEqual(semanticDashboard, incompatibleBefore, '不兼容字段失败时原 Spec 必须保持不变')

    responsePayload = { operations: [scatterOperation] }
    const scatterBefore = JSON.parse(JSON.stringify(semanticDashboard)) as DashboardSpec
    await assert.rejects(() => agent.patch(
      '增加一个散点图',
      semanticDashboard,
      { projectIds: ['p1'] }
    ), 'add-component 必须明确拒绝散点图，而不是隐式补齐第二个数值指标')
    assert.deepEqual(semanticDashboard, scatterBefore, '散点图拒绝时原 Spec 必须保持不变')

    console.log(JSON.stringify({
      ok: true,
      generatedBlueprint: true,
      generatedBindings: generated.components.length,
      addedComponent: {
        id: addedComponent.id,
        type: addedComponent.type,
        questionId: addedComponent.semanticBinding?.questionId,
        dimension: addedComponent.query?.dimensions?.[0]?.field
      },
      rejectedAddCases: ['focused-component', 'missing-field', 'incompatible-field', 'scatter']
    }, null, 2))
  } finally {
    globalThis.fetch = previousFetch
  }
}

await runSemanticPatchContract()

const runBlueprintFirstContract = async (): Promise<void> => {
  const previousFetch = globalThis.fetch
  const ambiguousRequest = '生成研发质量大屏；负责人可能指开发负责人或测试负责人，请保留歧义并说明假设。'
  const ambiguousBlueprint: DashboardAnalysisBlueprint = {
    ...semanticBlueprint,
    request: ambiguousRequest,
    assumptions: ['当前仅按可识别的负责人字段生成候选分析，不替用户选择业务口径'],
    unresolvedAmbiguities: ['负责人未明确指开发负责人还是测试负责人，需后续确认']
  }
  const responsePayload: DashboardSpec = {
    ...semanticDashboard,
    id: 'blueprint-first-generated',
    title: '研发质量候选大屏',
    analysisBlueprint: ambiguousBlueprint,
    components: semanticDashboard.components.map((item) => ({ ...item, data: [] }))
  }
  const modelBodies: Array<Record<string, unknown>> = []
  const auditRuns: VisualizationRunInput[] = []
  try {
    globalThis.fetch = async (_input, init) => {
      if (typeof init?.body === 'string') {
        modelBodies.push(JSON.parse(init.body) as Record<string, unknown>)
      }
      return new Response(JSON.stringify({
        message: { content: JSON.stringify(responsePayload) }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const generated = await new VisualizationAgent(
      new QueryEngine(fakeDb),
      settings,
      (run) => auditRuns.push(run)
    ).generate(ambiguousRequest, { projectIds: ['p1'] })
    const firstMessages = Array.isArray(modelBodies[0]?.messages)
      ? modelBodies[0].messages as Array<Record<string, unknown>>
      : []
    const firstPrompt = firstMessages
      .map((message) => typeof message.content === 'string' ? message.content : '')
      .join('\n')
    const promptBlueprintPayload = firstMessages
      .map((message) => {
        if (typeof message.content !== 'string') return undefined
        try {
          return JSON.parse(message.content) as Record<string, unknown>
        } catch {
          return undefined
        }
      })
      .find((payload) => payload && payload.analysisBlueprint && typeof payload.analysisBlueprint === 'object')
    const promptBlueprint = promptBlueprintPayload?.analysisBlueprint as {
      request?: unknown
      metrics?: Array<{ id?: unknown; measureId?: unknown }>
      questions?: Array<{ id?: unknown; metricIds?: unknown }>
    } | undefined
    assert.ok(modelBodies.length > 0, 'Blueprint-first 生成必须发起模型请求')
    assert.match(firstPrompt, /analysisBlueprint/, '模型 prompt 必须包含主机先生成的 AnalysisBlueprint')
    assert.ok(promptBlueprint, '模型 prompt 必须携带 concrete AnalysisBlueprint，而不是仅写审计标签')
    assert.equal(promptBlueprint?.request, ambiguousRequest)
    assert.ok((promptBlueprint?.metrics?.length ?? 0) > 0, 'prompt Blueprint 必须包含 concrete metric ids')
    assert.ok((promptBlueprint?.questions?.length ?? 0) > 0, 'prompt Blueprint 必须包含 concrete question ids')
    const promptMetricIds = new Set(
      (promptBlueprint?.metrics ?? []).map((metric) => metric.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
    )
    assert.equal(promptMetricIds.size, promptBlueprint?.metrics?.length,
      'prompt Blueprint metric ids 必须非空且唯一')
    for (const question of promptBlueprint?.questions ?? []) {
      assert.ok(typeof question.id === 'string' && question.id.length > 0,
        'prompt Blueprint question id 必须为非空字符串')
      assert.ok(Array.isArray(question.metricIds), 'prompt Blueprint question 必须绑定 metric ids')
      for (const metricId of question.metricIds as unknown[]) {
        assert.ok(typeof metricId === 'string' && promptMetricIds.has(metricId),
          `prompt Blueprint question ${String(question.id)} 引用了不存在的 metric id`)
      }
    }
    const run = auditRuns.find((item) => item.mode === 'generate' && item.status === 'success')
    assert.ok(run, 'Blueprint-first 生成必须写入成功审计记录')
    const planCall = run.toolCalls.find((call) => call.tool === 'plan-analysis')
    const composeCall = run.toolCalls.find((call) => call.tool === 'model-compose')
    assert.ok(planCall && composeCall, '生成审计必须同时包含 plan-analysis 与 model-compose')
    assert.ok(planCall.sequence < composeCall.sequence,
      'plan-analysis 必须在 model-compose 之前完成')
    assert.ok(generated.analysisBlueprint, '生成结果必须携带 AnalysisBlueprint')
    assert.deepEqual(
      generated.analysisBlueprint.metrics.map((metric) => metric.id),
      [...promptMetricIds],
      '最终 Blueprint 必须延续 prompt 中主机先生成的 metric ids'
    )
    assert.deepEqual(
      generated.analysisBlueprint.questions.map((question) => question.id),
      (promptBlueprint?.questions ?? []).map((question) => question.id),
      '最终 Blueprint 必须延续 prompt 中主机先生成的 question ids'
    )
    assert.ok(generated.analysisBlueprint.assumptions.length > 0,
      '歧义请求必须记录 assumptions')
    assert.ok(generated.analysisBlueprint.unresolvedAmbiguities.length > 0,
      '歧义请求必须记录 unresolvedAmbiguities')
    const requiredQuestions = generated.analysisBlueprint.questions.filter((question) => question.required)
    assert.ok(requiredQuestions.length > 0, 'Blueprint 至少应包含一个必答业务问题')
    for (const question of requiredQuestions) {
      const boundComponent = generated.components.find((component) =>
        component.semanticBinding?.questionId === question.id
      )
      assert.ok(boundComponent, `必答问题 ${question.id} 必须映射到组件`)
      assert.ok(boundComponent.query, `必答问题 ${question.id} 必须映射到 QuerySpec`)
      assert.deepEqual(boundComponent.semanticBinding?.metricIds, question.metricIds,
        `必答问题 ${question.id} 的指标绑定必须精确一致`)
      for (const metricId of question.metricIds) {
        const metric = generated.analysisBlueprint.metrics.find((item) => item.id === metricId)
        assert.ok(metric, `必答问题 ${question.id} 引用了不存在指标 ${metricId}`)
        assert.ok(boundComponent.query!.measures.some((measure) => measure.id === metric!.measureId),
          `必答问题 ${question.id} 的指标必须落到 QuerySpec measure`)
      }
      assert.equal(boundComponent.title,
        automaticDashboardComponentTitle(generated.analysisBlueprint, boundComponent),
        `必答问题 ${question.id} 的标题必须由绑定指标、维度自动生成`)
    }
    console.log(JSON.stringify({
      ok: true,
      auditOrder: run.toolCalls.map((call) => call.tool),
      assumptions: generated.analysisBlueprint.assumptions.length,
      unresolvedAmbiguities: generated.analysisBlueprint.unresolvedAmbiguities.length,
      requiredQuestions: requiredQuestions.length
    }, null, 2))
  } finally {
    globalThis.fetch = previousFetch
  }
}

const runLegacyUpgradeContract = async (): Promise<void> => {
  const previousFetch = globalThis.fetch
  const legacyDashboard = JSON.parse(JSON.stringify(baseDashboard)) as DashboardSpec
  legacyDashboard.id = 'legacy-ai-upgrade-smoke'
  delete legacyDashboard.analysisBlueprint
  const legacySource = JSON.stringify(legacyDashboard)
  let responsePayload: unknown = {
    operations: [{
      op: 'add-component',
      type: 'bar',
      title: '状态分布',
      dimensionField: 'status',
      aggregation: 'count'
    }]
  }
  const responseOf = (): Response => new Response(JSON.stringify({
    message: { content: JSON.stringify(responsePayload) }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    globalThis.fetch = async () => responseOf()
    const agent = new VisualizationAgent(new QueryEngine(fakeDb), settings)
    const upgraded = await agent.patch(
      '在 legacy 大屏中新增状态分布组件并升级语义绑定',
      legacyDashboard,
      { projectIds: ['p1'] }
    )
    assert.equal(upgraded.components.length, legacyDashboard.components.length + 1)
    assert.ok(upgraded.analysisBlueprint, 'legacy AI add 必须升级为 Blueprint')
    assert.ok(upgraded.components.every((component) => component.semanticBinding && component.slotRole),
      'legacy AI add 必须为旧组件和新组件补齐语义绑定')
    const legacySemanticIssues = validateDashboardSemanticConsistency(upgraded)
    assert.deepEqual(
      legacySemanticIssues.filter((issue) => issue.severity === 'error'),
      [],
      'legacy AI add 升级后的完整 Spec 不得有语义错误'
    )
    const legacyIds = new Set(legacyDashboard.components.map((component) => component.id))
    const legacyWarningCounts = new Map<string, number>()
    for (const issue of legacySemanticIssues.filter((item) => item.severity === 'warning')) {
      assert.equal(issue.code, 'custom-title-weak-match',
        'legacy AI add 保留用户标题时仅允许 custom-title-weak-match warning')
      assert.ok(issue.componentId && legacyIds.has(issue.componentId),
        'legacy AI add 标题 warning 必须指向旧组件')
      const count = (legacyWarningCounts.get(issue.componentId) ?? 0) + 1
      legacyWarningCounts.set(issue.componentId, count)
      assert.ok(count <= 1, `legacy AI add 旧组件 ${issue.componentId} 最多允许一条标题 warning`)
    }
    assert.equal(JSON.stringify(legacyDashboard), legacySource,
      'legacy AI add 失败或成功均不得修改源 Spec')

    const legacyPresentation = JSON.parse(JSON.stringify(baseDashboard)) as DashboardSpec
    legacyPresentation.id = 'legacy-presentation-smoke'
    legacyPresentation.components = [{
      ...legacyPresentation.components[0],
      query: undefined,
      encoding: undefined
    }]
    delete legacyPresentation.analysisBlueprint
    const presentationSource = JSON.stringify(legacyPresentation)
    responsePayload = { operations: [{ op: 'set-dashboard-title', value: 'Legacy presentation snapshot' }] }
    const presentation = await agent.patch(
      '只修改 legacy 展示快照标题',
      legacyPresentation,
      { projectIds: ['p1'] }
    )
    assert.equal(presentation.title, 'Legacy presentation snapshot')
    assert.equal(presentation.analysisBlueprint, undefined,
      'legacy presentation-only 模式应保持无 Blueprint 兼容')
    assert.equal(JSON.stringify(legacyPresentation), presentationSource,
      'legacy presentation-only patch 不得修改源 Spec')
    console.log(JSON.stringify({
      ok: true,
      upgradedComponents: upgraded.components.length,
      legacyBlueprint: true,
      legacyBindings: upgraded.components.filter((component) => component.semanticBinding).length,
      presentationOnlyCompatible: true
    }, null, 2))
  } finally {
    globalThis.fetch = previousFetch
  }
}

const runAiScatterContract = async (): Promise<void> => {
  const previousFetch = globalThis.fetch
  const scatterScope = { projectIds: ['p1'] }
  const scatterBlueprint = planAnalysisBlueprint(
    '生成投入工时与评分的双指标散点图',
    scatterScope,
    new QueryEngine(fakeDb).profile(scatterScope)
  )
  const scatterQuestion = scatterBlueprint.questions.find((question) =>
    question.preferredComponentTypes.includes('scatter')
  )
  assert.ok(scatterQuestion, '散点图请求必须先规划 scatter 业务问题')
  assert.equal(scatterQuestion.metricIds.length, 2, '散点图 Blueprint 必须规划两个指标')
  const scatterMetrics = scatterQuestion.metricIds.map((metricId) => {
    const metric = scatterBlueprint.metrics.find((candidate) => candidate.id === metricId)
    assert.ok(metric, `散点图 Blueprint 缺少指标 ${metricId}`)
    return metric
  })
  const scatterMeasures = scatterMetrics.map((metric) => ({
    id: metric.measureId,
    ...(metric.field ? { field: metric.field } : {}),
    aggregation: metric.aggregation,
    ...(metric.calculation ? { calculation: metric.calculation } : {})
  }))
  const scatterComponent: DashboardComponentSpec = {
    ...baseDashboard.components[0],
    id: 'scatter-generated',
    type: 'scatter',
    title: '投入工时与评分相关性',
    layout: { x: 0, y: 0, w: 10, h: 5 },
    data: [],
    query: {
      source: 'records',
      scope: scatterScope,
      dimensions: scatterQuestion.dimensionFields.map((field) => ({
        field,
        ...(scatterQuestion.timeGrain && field === scatterQuestion.dimensionFields[0]
          ? { timeGrain: scatterQuestion.timeGrain }
          : {})
      })),
      measures: scatterMeasures,
      limit: 100
    },
    encoding: {
      ...(scatterQuestion.dimensionFields[0] ? { label: scatterQuestion.dimensionFields[0] } : {}),
      value: scatterMeasures[0].id,
      secondaryValue: scatterMeasures[1].id
    }
  }
  const scatterRaw: DashboardSpec = {
    ...baseDashboard,
    id: 'ai-scatter-smoke',
    title: 'AI 双指标散点大屏',
    analysisBlueprint: scatterBlueprint,
    components: [scatterComponent, ...baseDashboard.components.slice(1)]
  }
  let responsePayload: unknown = scatterRaw
  const responseOf = (): Response => new Response(JSON.stringify({
    message: { content: JSON.stringify(responsePayload) }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const assertScatterRejected = async (
    label: string,
    mutate: (candidate: DashboardSpec) => void
  ): Promise<void> => {
    const candidate = JSON.parse(JSON.stringify(scatterRaw)) as DashboardSpec
    mutate(candidate)
    const source = JSON.stringify(candidate)
    responsePayload = candidate
    const agent = new VisualizationAgent(new QueryEngine(fakeDb), settings)
    await assert.rejects(
      () => agent.generate(`生成散点图：${label}`, { projectIds: ['p1'] }),
      `散点图 ${label} 必须被原子拒绝`
    )
    assert.equal(JSON.stringify(candidate), source, `散点图 ${label} 拒绝时输入必须保持不变`)
  }
  try {
    globalThis.fetch = async () => responseOf()
    const generated = await new VisualizationAgent(new QueryEngine(fakeDb), settings).generate(
      '生成投入工时与评分的双指标散点图',
      { projectIds: ['p1'] }
    )
    const scatter = generated.components.find((component) => component.type === 'scatter')
    assert.ok(scatter, 'AI 生成结果必须包含散点组件')
    assert.ok(scatter.query, 'AI 散点组件必须带受控 QuerySpec')
    assert.equal(scatter.query.measures.length, 2, 'AI 散点必须恰好使用两个 measure')
    assert.notEqual(scatter.query.measures[0].id, scatter.query.measures[1].id)
    assert.notEqual(scatter.query.measures[0].field, scatter.query.measures[1].field)
    assert.equal(scatter.encoding?.secondaryValue, scatter.query.measures[1].id)
    assert.equal(scatter.semanticBinding?.metricIds.length, 2)
    assert.deepEqual(
      scatter.semanticBinding?.metricIds,
      scatter.query.measures.map((measure) => generated.analysisBlueprint!.metrics.find((metric) => metric.measureId === measure.id)?.id)
    )
    assert.deepEqual(validateDashboardSemanticConsistency(generated), [])

    await assertScatterRejected('缺少第二指标字段', (candidate) => {
      const target = candidate.components.find((component) => component.type === 'scatter')!
      target.query!.measures[1] = { id: 'scoreSum', aggregation: 'sum' }
    })
    await assertScatterRejected('重复第二指标', (candidate) => {
      const target = candidate.components.find((component) => component.type === 'scatter')!
      target.query!.measures[1] = { ...target.query!.measures[0] }
      target.encoding!.secondaryValue = target.query!.measures[0].id
    })
    await assertScatterRejected('敏感第二指标', (candidate) => {
      const target = candidate.components.find((component) => component.type === 'scatter')!
      target.query!.measures[1] = { id: 'emailSum', field: 'email', aggregation: 'sum' }
      target.encoding!.secondaryValue = 'emailSum'
    })
    await assertScatterRejected('非数值第二指标', (candidate) => {
      const target = candidate.components.find((component) => component.type === 'scatter')!
      target.query!.measures[1] = { id: 'statusSum', field: 'status', aggregation: 'sum' }
      target.encoding!.secondaryValue = 'statusSum'
    })
    console.log(JSON.stringify({
      ok: true,
      measures: scatter.query.measures.map((measure) => measure.id),
      secondaryValue: scatter.encoding?.secondaryValue,
      metricBindings: scatter.semanticBinding?.metricIds,
      rejectedCases: ['missing-field', 'duplicate', 'sensitive', 'non-numeric']
    }, null, 2))
  } finally {
    globalThis.fetch = previousFetch
  }
}

runCanonicalMetadataLabelContract()
await runBlueprintFirstContract()
await runLegacyUpgradeContract()
await runAiScatterContract()
