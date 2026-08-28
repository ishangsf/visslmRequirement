import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import { dashboardDomainCatalog } from '../src/main/experts/dashboard-domain-catalog'
import { projectOverviewGoldenFixture } from '../src/main/experts/dashboard-project-overview'

const dashboardStudioSource = readFileSync(
  new URL('../src/renderer/src/dashboard/DashboardStudio.tsx', import.meta.url),
  'utf8'
)

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const assertSourceContains = (needle: string, message: string): void => {
  assert.ok(dashboardStudioSource.includes(needle), message)
}

const assertSourceMapping = (
  mappingName: string,
  entries: Readonly<Record<string, string>>,
  message: string
): void => {
  assertSourceContains(`const ${mappingName}: Record<string, string>`, `${message} 未声明 ${mappingName}`)
  for (const [id, label] of Object.entries(entries)) {
    const pattern = new RegExp(
      `(?:['"]${escapeRegExp(id)}['"]|\\b${escapeRegExp(id)}\\b)\\s*:\\s*['"]${escapeRegExp(label)}['"]`
    )
    assert.match(dashboardStudioSource, pattern, `${message} 缺少 ${id} → ${label}`)
  }
}

const expectedRoleLabels = {
  'project-owner': '项目负责人',
  'qa-epg': '质量与过程负责人',
  'rd-lead': '研发负责人',
  'model-org-manager': '型号/组织管理负责人'
} as const

const expectedScenarioLabels = {
  'project-overview': '项目综合态势',
  'requirements-delivery': '需求到交付全链路',
  'plan-milestone': '计划与里程碑执行',
  'software-quality': '软件质量与缺陷闭环',
  'test-validation': '测试与验证充分性',
  'configuration-change': '配置管理与变更控制',
  'gjb5000b-compliance': '过程证据审计',
  'organization-improvement': '组织改进'
} as const

assert.deepEqual(
  dashboardDomainCatalog.roles,
  Object.keys(expectedRoleLabels),
  '领域上下文必须保持四类角色枚举'
)
assert.deepEqual(
  dashboardDomainCatalog.scenarios.map((scenario) => scenario.id),
  Object.keys(expectedScenarioLabels),
  '领域上下文必须保持八个黄金场景 ID'
)
assertSourceMapping('dashboardDomainRoleLabels', expectedRoleLabels, '四类角色中文映射')
assertSourceMapping('dashboardDomainScenarioLabels', expectedScenarioLabels, '八个场景中文映射')
assertSourceMapping(
  'dashboardDomainArtifactStatusLabels',
  { preview: '预览', formal: '正式' },
  '产物状态中文映射'
)

const fixtureSpec = projectOverviewGoldenFixture.spec
assert.equal(fixtureSpec.domainContext?.role, 'project-owner')
assert.equal(fixtureSpec.domainContext?.scenario, 'project-overview')
assert.equal(fixtureSpec.domainContext?.catalogVersion, dashboardDomainCatalog.version)
assert.ok(fixtureSpec.domainContext?.tailoringBaselineId)
assert.equal(fixtureSpec.domainContext?.artifactStatus, 'preview')
assert.equal(fixtureSpec.components.length, 6, '现有 editor 领域 fixture 应包含六个项目综合态势组件')
for (const component of fixtureSpec.components) {
  const binding = component.semanticBinding
  assert.ok(binding, `组件 ${component.id} 必须有 semanticBinding`)
  assert.ok(component.slotRole, `组件 ${component.id} 必须有 slotRole`)
  assert.ok(binding?.processBindingIds?.length, `组件 ${component.id} 必须有 processBindingIds`)
  assert.ok(
    binding?.processBindingIds?.every((id) =>
      dashboardDomainCatalog.processBindings.some((processBinding) => processBinding.id === id)
    ),
    `组件 ${component.id} 的 processBindingIds 必须来自领域目录`
  )
  assert.equal(typeof binding?.confidence, 'number', `组件 ${component.id} 必须有可信度数值`)
}

const contextKeyIndex = dashboardStudioSource.indexOf("key: 'domain-context'")
assert.ok(contextKeyIndex >= 0, 'DashboardStudio 必须声明 domain-context inspector group')
const conditionalMarker = '...(dashboard.domainContext ? [{'
const conditionalStart = dashboardStudioSource.lastIndexOf(conditionalMarker, contextKeyIndex)
assert.ok(
  conditionalStart >= 0,
  'domain-context 必须由 dashboard.domainContext 条件片段生成'
)
const selectedComponentCollapseIndex = dashboardStudioSource.indexOf("defaultActiveKey={['basic', 'data', 'layout-query']}", contextKeyIndex)
const conditionalEnd = selectedComponentCollapseIndex > contextKeyIndex
  ? dashboardStudioSource.lastIndexOf('}] : [])', selectedComponentCollapseIndex)
  : -1
assert.ok(conditionalEnd > contextKeyIndex, 'domain-context 条件片段必须有空值分支')
const domainContextFragment = dashboardStudioSource.slice(conditionalStart, conditionalEnd + '}] : [])'.length)
for (const property of ['role', 'scenario', 'artifactStatus', 'catalogVersion', 'tailoringBaselineId']) {
  assertSourceContains(
    `dashboard.domainContext.${property}`,
    `领域上下文必须展示 dashboard.domainContext.${property}`
  )
  assert.ok(
    domainContextFragment.includes(`dashboard.domainContext.${property}`),
    `domain-context 片段不得从其他状态读取 ${property}`
  )
}
assert.ok(domainContextFragment.includes('{domainReceipt && ('),
  'domainReceipt 必须仅在领域上下文存在的 inspector 片段内条件渲染')
assert.ok(domainContextFragment.includes('aria-label="领域生成回执"'),
  'domainReceipt 区域必须提供可访问名称')
for (const [variable, property, label] of [
  ['domainReceiptEvidenceMissing', 'evidenceMissing', '证据缺失'],
  ['domainReceiptEvidenceInsufficient', 'evidenceInsufficient', '证据不足']
] as const) {
  assertSourceContains(
    `const ${variable} = dashboardDomainReceiptItemsOf(domainReceipt?.${property})`,
    `domainReceipt 必须读取 ${property}`
  )
  assert.ok(domainContextFragment.includes(`${variable}.length > 0`),
    `${label} 必须独立按数量条件渲染`)
  assert.ok(domainContextFragment.includes(`Tooltip title={\`${label}：\$\{${variable}.join('、')}\`}`),
    `${label} 必须提供 Tooltip 明细`)
  assert.ok(domainContextFragment.includes(`aria-label={\`${label} \$\{${variable}.length\} 项\`}`),
    `${label} 必须提供数量 aria-label`)
}
assert.ok(domainContextFragment.includes('dashboardSemanticConfidenceLabel(domainReceipt.confidence) &&'),
  'domainReceipt confidence 只有在有效百分比时才应展示')
assert.ok(domainContextFragment.includes('domainReceiptWarnings.length > 0 || domainReceiptConfirmations.length > 0'),
  'warnings/confirmations 必须按实际存在条件渲染')
assert.ok(domainContextFragment.includes('defaultActiveKey={[]}'),
  'warnings/confirmations 内层 Collapse 默认必须收起')
assert.ok(domainContextFragment.includes("key: 'warnings'"),
  'warnings 必须作为内层 Collapse 项展示')
assert.ok(domainContextFragment.includes("key: 'confirmations'"),
  'confirmations 必须作为内层 Collapse 项展示')
assert.ok(domainContextFragment.includes('domainReceiptVetoCodes.length > 0'),
  'vetoCodes 必须有独立阻断条件')
assert.match(domainContextFragment, /<Alert\s*[\s\S]*?type="error"/,
  'vetoCodes 必须通过 error Alert 展示')
assert.ok(domainContextFragment.includes('不可作为正式交付'),
  'vetoCodes 警示必须明确不可作为正式交付')
assert.equal(
  (dashboardStudioSource.match(/key:\s*['"]domain-context['"]/g) ?? []).length,
  1,
  'domain-context inspector group 不应重复声明'
)
assert.ok(!/<aside\b/.test(domainContextFragment), '领域上下文不得新增第二侧栏')

const dashboardCollapseDefault = "defaultActiveKey={['dashboard-info', 'global-filter'] }".replace(
  "'global-filter'] }",
  "'global-filter']}"
)
assertSourceContains(
  dashboardCollapseDefault,
  '大屏属性 Collapse 默认展开项必须保持 dashboard-info/global-filter'
)
const defaultActiveKeyIndex = dashboardStudioSource.indexOf(dashboardCollapseDefault)
const defaultActiveKeyWindow = dashboardStudioSource.slice(defaultActiveKeyIndex, defaultActiveKeyIndex + 160)
assert.ok(!defaultActiveKeyWindow.includes('domain-context'), 'domain-context 不得进入 Collapse defaultActiveKey')

assertSourceContains('label="产物状态"', '领域上下文必须展示 artifactStatus')
assertSourceContains('label="目录版本"', '领域上下文必须展示 catalogVersion')
assertSourceContains('label="裁剪基线"', '领域上下文必须展示 tailoringBaselineId')
assertSourceContains('<section className="dashboard-domain-context" aria-label="领域上下文详情">',
  '领域上下文区必须有可访问名称')

const contextValueHelperStart = dashboardStudioSource.indexOf('const dashboardDomainContextValue =')
const confidenceHelperStart = dashboardStudioSource.indexOf('const dashboardSemanticConfidenceLabel =')
assert.ok(contextValueHelperStart >= 0 && confidenceHelperStart > contextValueHelperStart,
  'DashboardStudio 必须提供领域上下文显示辅助函数')
const contextValueHelper = dashboardStudioSource.slice(contextValueHelperStart, confidenceHelperStart)
assertSourceContains('<Tooltip title={tooltipValue}>', '领域上下文值必须提供 Tooltip')
assertSourceContains('aria-label={`${label}：${tooltipValue}`}', '领域上下文值必须提供 aria-label')
assertSourceContains('title={tooltipValue}', '领域上下文值必须提供原生 title 提示')
assert.match(contextValueHelper, /<Tooltip title=\{tooltipValue\}>/, '领域上下文显示辅助函数必须包裹 Tooltip')
assert.match(contextValueHelper, /aria-label=\{`\$\{label\}：\$\{tooltipValue\}`\}/,
  '领域上下文显示辅助函数必须生成 aria-label')

const confidenceHelperEnd = dashboardStudioSource.indexOf('const visualizationToolMetadataLabels:')
assert.ok(confidenceHelperEnd > confidenceHelperStart, '可信度格式化辅助函数边界缺失')
const confidenceHelper = dashboardStudioSource.slice(confidenceHelperStart, confidenceHelperEnd)
assert.match(confidenceHelper, /Math\.round\(value \* 100\)/, '可信度必须按百分比显示')
assert.match(confidenceHelper, /%`/, '可信度显示必须包含百分号')
assertSourceContains('可信度 ${dashboardSemanticConfidenceLabel(', '组件属性必须展示可信度百分比')
assertSourceContains('semanticBinding.processBindingIds?.length', '组件属性必须展示过程绑定')
assertSourceContains('.processBindingIds.map(', '过程绑定必须逐项渲染')
assertSourceContains('Tooltip title={bindingId}', '过程绑定必须提供 Tooltip')
assertSourceContains('aria-label={`过程绑定 ${bindingId}`}', '过程绑定必须提供 aria-label')

const bodyStart = dashboardStudioSource.indexOf('ref={studioBodyRef}')
const previewStart = dashboardStudioSource.indexOf('<main className={`dashboard-preview-shell', bodyStart)
assert.ok(bodyStart >= 0 && previewStart > bodyStart, 'DashboardStudio 必须保留画布主区域')
const bodySource = dashboardStudioSource.slice(bodyStart, previewStart + 180)
const sidebars = [...bodySource.matchAll(/<aside\s+className="([^"]+)"/g)].map((match) => match[1])
assert.deepEqual(
  sidebars,
  ['dashboard-library'],
  '领域上下文片段之前只能保留既有左侧组件库，不得插入第二侧栏'
)
assert.equal(
  (dashboardStudioSource.match(/className="dashboard-inspector"/g) ?? []).length,
  1,
  'DashboardStudio 必须保持单一属性 inspector'
)
assertSourceContains('dashboard-preview-shell', 'DashboardStudio 必须保留画布优先的 preview shell')
assertSourceContains("const dashboardInspectorWidthStorageKey = 'visslm:dashboard-inspector-width:v1'",
  '属性面板宽度缓存 key 不得改变')
for (const [constant, value] of [
  ['dashboardInspectorDefaultWidth', '320'],
  ['dashboardInspectorMinimumWidth', '280'],
  ['dashboardInspectorMaximumWidth', '480']
] as const) {
  assert.match(
    dashboardStudioSource,
    new RegExp(`const ${constant} = ${value}`),
    `属性面板宽度常量 ${constant} 不得改变`
  )
}

console.log(JSON.stringify({
  ok: true,
  checked: {
    roles: dashboardDomainCatalog.roles.length,
    scenarios: dashboardDomainCatalog.scenarios.length,
    domainContextCondition: true,
    domainFields: ['artifactStatus', 'catalogVersion', 'tailoringBaselineId'],
    semanticBindingFields: ['confidence', 'processBindingIds'],
    inspectorSidebars: sidebars,
    inspectorWidth: { default: 320, minimum: 280, maximum: 480 },
    fixtureComponents: fixtureSpec.components.length
  }
}, null, 2))
