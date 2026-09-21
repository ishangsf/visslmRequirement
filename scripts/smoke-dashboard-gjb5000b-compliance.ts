import { strict as assert } from 'node:assert'

import { QueryEngine } from '../src/main/analytics/query-engine'
import type { AnalyticsRecord, AppDatabase } from '../src/main/database'
import { validateDashboardSpec } from '../src/main/dashboards/validator'
import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { runDashboardDomainChatRequest } from '../src/main/experts/dashboard-domain-chat'
import { VisualizationAgent } from '../src/main/experts/visualization-agent'
import { gjb5000bComplianceGoldenFixture } from '../src/main/experts/dashboard-gjb5000b-compliance'

const makeDb = (records: readonly AnalyticsRecord[]): AppDatabase => ({
  scanAnalyticsRecords(scope) {
    return records.filter((record) =>
      (!scope.projectIds?.length || scope.projectIds.includes(record.projectId)) &&
      (!scope.nodeTypes?.length || scope.nodeTypes.includes(record.nodeType)) &&
      (!scope.recordUids?.length || scope.recordUids.includes(record.uid))
    )
  }
} as AppDatabase)

const engine = new QueryEngine(makeDb(gjb5000bComplianceGoldenFixture.records))
const scenario = dashboardDomainCatalog.scenarios.find((item) => item.id === gjb5000bComplianceGoldenFixture.scenario)
assert.ok(scenario)
assert.equal(scenario.status, 'active')
assert.match(scenario.description, /不代表官方符合性结论/)
assert.deepEqual(scenario.metricIds, gjb5000bComplianceGoldenFixture.metricIds)
assert.deepEqual(scenario.componentIds, gjb5000bComplianceGoldenFixture.componentIds)

const originalFetch = globalThis.fetch
let modelCalls = 0
globalThis.fetch = (async () => {
  modelCalls += 1
  throw new Error('GJB5000B 过程证据领域链路不得调用模型')
}) as typeof globalThis.fetch

try {
  const result = await runDashboardDomainChatRequest({
    question: gjb5000bComplianceGoldenFixture.request,
    scope: { projectIds: [gjb5000bComplianceGoldenFixture.projectId] },
    generatedAt: gjb5000bComplianceGoldenFixture.generatedAt
  }, engine)
  assert.equal(result.status, 'ready')
  assert.equal(result.scenario, 'gjb5000b-compliance')
  assert.ok(result.dashboard)
  const dashboard = result.dashboard!
  assert.equal(dashboard.title, 'GJB5000B 过程符合度与证据审计（受控样例）')
  assert.equal(dashboard.domainContext?.role, 'qa-epg')
  assert.equal(dashboard.domainContext?.artifactStatus, 'preview')
  assert.equal(dashboard.domainContext?.dataMode, 'controlled-sample')
  assert.equal(dashboard.presentation?.kind, 'gjb5000b-compliance')
  assert.equal(dashboard.presentation?.defaultMode, 'standard')
  assert.equal(dashboard.presentation?.processDomains.length, 5)
  assert.equal(dashboard.presentation?.selectedDomainId, 'configuration-management')
  assert.equal(dashboard.presentation?.trace.length, 5)
  assert.equal(dashboard.presentation?.aging.reduce((total, bucket) => total + bucket.count, 0), 4)
  assert.equal(dashboard.presentation?.scene.decorativeOnly, true)
  assert.equal(dashboard.presentation?.scene.classification, 'visual-theme')
  assert.match(dashboard.presentation?.scene.disclaimer ?? '', /非型号数据/)
  assert.deepEqual(dashboard.analysisBlueprint?.metrics.map((metric) => metric.id), gjb5000bComplianceGoldenFixture.metricIds)
  const expectedPublicComponentIds = [
    'gjb5000b-compliance-activity-card',
    'gjb5000b-compliance-work-product-card',
    'gjb5000b-compliance-evidence-headline-card',
    'gjb5000b-compliance-nonconformity-headline-card',
    'gjb5000b-compliance-evidence-card',
    'gjb5000b-compliance-evidence-detail-card',
    'gjb5000b-compliance-deviation-card',
    'gjb5000b-compliance-evidence-ranking-card',
    'gjb5000b-compliance-nonconformity-card'
  ]
  assert.deepEqual(dashboard.components.map((component) => component.id), expectedPublicComponentIds)
  assert.deepEqual(dashboard.components.map((component) => component.type), [
    'kpi',
    'kpi',
    'kpi',
    'kpi',
    'data-matrix',
    'description-list',
    'line',
    'ranking',
    'comparison-bars'
  ])
  const matrixComponent = dashboard.components.find((component) => component.type === 'data-matrix')
  const detailComponent = dashboard.components.find((component) => component.type === 'description-list')
  assert.equal(matrixComponent?.content?.kind, 'data-matrix')
  assert.equal(detailComponent?.content?.kind, 'description-list')
  assert.equal(dashboard.components.find((component) => component.type === 'comparison-bars')?.content?.kind, 'comparison-bars')
  assert.equal(matrixComponent?.content?.kind === 'data-matrix' ? matrixComponent.content.pageSize : undefined, 5)
  assert.equal(matrixComponent?.content?.kind === 'data-matrix' ? matrixComponent.content.expansionMode : undefined, 'linked-detail')
  assert.equal(
    matrixComponent?.content?.kind === 'data-matrix' ? matrixComponent.content.selectionChannel : undefined,
    'gjb5000b-process-domain'
  )
  assert.equal(
    detailComponent?.content?.kind === 'description-list' ? detailComponent.content.selectionChannel : undefined,
    'gjb5000b-process-domain'
  )
  assert.deepEqual(
    detailComponent?.content?.kind === 'description-list'
      ? detailComponent.content.variants?.map((variant) => variant.selectionId)
      : undefined,
    dashboard.presentation?.processDomains.map((domain) => domain.id)
  )
  assert.deepEqual(validateDashboardSpec(dashboard, engine), [])
  assert.ok(dashboard.domainReceipt?.warnings.some((warning) => /不构成正式符合性结论/.test(warning)))

  const expectedDimensions: Record<string, readonly string[]> = {
    'gjb5000b-compliance-evidence-card': ['name'],
    'gjb5000b-compliance-evidence-detail-card': ['name'],
    'gjb5000b-compliance-evidence-ranking-card': ['name'],
    'gjb5000b-compliance-deviation-card': ['lastModifyTime'],
    'gjb5000b-compliance-nonconformity-card': ['name'],
    'gjb5000b-compliance-evidence-headline-card': [],
    'gjb5000b-compliance-nonconformity-headline-card': []
  }
  for (const component of dashboard.components) {
    assert.ok(component.query)
    assert.deepEqual(component.query?.scope.nodeTypes, ['Gjb5000bComplianceSample'])
    assert.ok(component.data.length > 0)
    assert.ok(component.semanticBinding?.processBindingIds?.length)
    assert.deepEqual(component.semanticBinding?.dimensionFields ?? [], expectedDimensions[component.id] ?? [])
  }

  const evidence = dashboard.components.find((item) => item.id === 'gjb5000b-compliance-evidence-card')
  const deviations = dashboard.components.find((item) => item.id === 'gjb5000b-compliance-deviation-card')
  assert.equal(evidence?.query?.measures?.[0]?.field, 'evidenceSufficiencyRate')
  assert.equal(deviations?.query?.measures?.[0]?.field, 'processDeviationCount')
  assert.notEqual(evidence?.query?.measures?.[0]?.field, deviations?.query?.measures?.[0]?.field)
  assert.ok(/证据充分率/.test(evidence?.title ?? ''))
  assert.ok(/过程偏差数/.test(deviations?.title ?? ''))

  const withoutEvidence = gjb5000bComplianceGoldenFixture.records.map((record) => ({
    ...record,
    raw: Object.fromEntries(Object.entries(record.raw).filter(([field]) => field !== 'evidenceSufficiencyRate'))
  }))
  const missingEvidence = await runDashboardDomainChatRequest({
    question: gjb5000bComplianceGoldenFixture.request,
    scope: { projectIds: [gjb5000bComplianceGoldenFixture.projectId] },
    generatedAt: gjb5000bComplianceGoldenFixture.generatedAt
  }, new QueryEngine(makeDb(withoutEvidence)))
  assert.equal(missingEvidence.status, 'clarification')
  assert.equal(missingEvidence.reason, 'missing-metric-source')

  const roleMismatch = await runDashboardDomainChatRequest({
    question: '项目负责人基于受控样例生成 GJB5000B 过程符合度与证据审计大屏',
    scope: { projectIds: [gjb5000bComplianceGoldenFixture.projectId] },
    generatedAt: gjb5000bComplianceGoldenFixture.generatedAt
  }, engine)
  assert.equal(roleMismatch.status, 'clarification')
  assert.equal(roleMismatch.reason, 'role-not-applicable')
  assert.equal(modelCalls, 0)

  let aiPatchCall = 0
  globalThis.fetch = (async () => {
    aiPatchCall += 1
    const operations = aiPatchCall === 1
      ? [
          {
            op: 'set-component-content-settings',
            componentId: matrixComponent!.id,
            pageSize: 4,
            expansionMode: 'linked-detail'
          },
          {
            op: 'set-component-content-item',
            componentId: matrixComponent!.id,
            itemId: 'configuration-management-evidence',
            label: '30 条有效证据',
            displayValue: '61%'
          },
          {
            op: 'set-component-style',
            componentId: matrixComponent!.id,
            bodyFontSize: 11,
            padding: 8,
            showStatusLegend: false
          }
        ]
      : [
          {
            op: 'set-component-content-item',
            componentId: detailComponent!.id,
            selectionId: 'configuration-management',
            itemId: 'owner',
            displayValue: '李工'
          }
        ]
    return new Response(JSON.stringify({
      message: { content: JSON.stringify({ operations }) }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof globalThis.fetch
  const agent = new VisualizationAgent(engine, {
    source: 'local',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'test-model',
    thinking: false
  })
  const matrixPatched = await agent.patch(
    '矩阵每页改为 4 行，更新配置管理证据并缩小边距',
    dashboard,
    { projectIds: [gjb5000bComplianceGoldenFixture.projectId] },
    matrixComponent!.id
  )
  const patchedMatrix = matrixPatched.components.find((component) => component.id === matrixComponent!.id)
  assert.equal(patchedMatrix?.content?.kind === 'data-matrix' ? patchedMatrix.content.pageSize : undefined, 4)
  assert.equal(patchedMatrix?.style?.bodyFontSize, 11)
  assert.equal(patchedMatrix?.style?.showStatusLegend, false)
  assert.equal(
    patchedMatrix?.content?.kind === 'data-matrix'
      ? patchedMatrix.content.rows.flatMap((row) => row.cells).find((cell) =>
          cell.id === 'configuration-management-evidence'
        )?.value
      : undefined,
    '61%'
  )
  const detailPatched = await agent.patch(
    '把配置管理联动详情责任人改为李工',
    matrixPatched,
    { projectIds: [gjb5000bComplianceGoldenFixture.projectId] },
    detailComponent!.id
  )
  assert.equal(
    detailPatched.components.find((component) => component.id === detailComponent!.id)?.content?.kind === 'description-list'
      ? detailPatched.components.find((component) => component.id === detailComponent!.id)!.content!.variants
        ?.find((variant) => variant.selectionId === 'configuration-management')
        ?.fields.find((field) => field.id === 'owner')?.value
      : undefined,
    '李工'
  )
  assert.deepEqual(validateDashboardSpec(detailPatched, engine), [])
  assert.equal(aiPatchCall, 2)

  console.log(JSON.stringify({
    ok: true,
    scenario: dashboard.domainContext?.scenario,
    title: dashboard.title,
    metricIds: dashboard.analysisBlueprint?.metrics.map((metric) => metric.id),
    components: dashboard.components.map((component) => ({
      id: component.id,
      title: component.title,
      type: component.type,
      field: component.query?.measures?.[0]?.field,
      dimensions: component.semanticBinding?.dimensionFields
    })),
    receipt: dashboard.domainReceipt,
    presentation: dashboard.presentation ? {
      kind: dashboard.presentation.kind,
      processDomainCount: dashboard.presentation.processDomains.length,
      traceNodeCount: dashboard.presentation.trace.length,
      scene: dashboard.presentation.scene
    } : undefined,
    officialConclusionBoundary: true,
    guards: [missingEvidence.reason, roleMismatch.reason],
    modelCalls
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
