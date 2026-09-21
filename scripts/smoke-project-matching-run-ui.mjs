import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'src/renderer/src/project-management/ProjectManagementPage.tsx'), 'utf8')
const styles = readFileSync(join(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')
const projectManagement = readFileSync(join(process.cwd(), 'src/main/project-management.ts'), 'utf8')
const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
assert.match(source, /相似度评分/)
assert.match(source, /评分由向量语义、关键词、Cross-Encoder和业务结构共同构成/)
assert.match(source, /scoreBreakdown/)
assert.match(source, /最高相似度评分/)
assert.match(source, /highestSimilarityScore/)
assert.match(source, /project-match-analysis/)
assert.match(source, /project-match-common-guidance/)
assert.match(source, /当前页.*条候选存在同一判断条件/)
assert.match(source, /候选数据/)
assert.match(source, /关联操作/)
assert.match(source, /差异：/)
assert.match(source, /finalRank/)
assert.match(source, /decisionStatus/)
assert.match(source, /degradationCodes/)
assert.match(source, /project-requirement-match-runs:v3/)
assert.match(source, /匹配分析/)
assert.match(source, /window\.visslm\.unlinkProjectAssetRequirement\(current\.id, recordUid, requirementId\)/)
assert.match(source, /tableKey="project-requirements-v3"[\s\S]*pagination=\{\{ current: requirementPage, pageSize: requirementPageSize/)
assert.match(source, /const requirementActionsDisabled = current\.analysisStatus === 'processing'/)
assert.match(source, /if \(!ensureRequirementActionsEnabled\(\)\) return/)
assert.match(source, /关键信息不完整，暂无法确认/)
assert.match(source, /关键功能信息词只能改善召回，不能替代缺失字段/)
assert.match(source, /本次没有生成逐项相似点和差异点/)
assert.match(source, /这不是每条数据分别失败/)
assert.match(source, /排序已经完成，正在后台补充逐项说明/)
assert.doesNotMatch(source, /project-match-guidance-line/)
assert.doesNotMatch(source, /project-match-guidance-footer/)
assert.doesNotMatch(source, /主要由.*Cross-Encoder/)
assert.doesNotMatch(source, /<strong>候选内容：<\/strong>\{row\.description\}/)
assert.doesNotMatch(source, /技术信息：\$\{row\.decisionStatus\}/)
assert.doesNotMatch(source, /技术代码：\$\{technicalCodes\}/)
assert.match(source, /clamp\(280px, calc\(100vh - 360px\), 620px\)/)
assert.doesNotMatch(source, /匹配度\s*&gt;/)
assert.doesNotMatch(source.slice(source.indexOf('function MatchDrawer'), source.indexOf('type OrganizationPeopleColumnKey')), /minScore/)
assert.match(source, /const projectLifecycleLabel = current\.lifecycle === 'draft'/)
assert.match(source, /isProcessing\s*\? '执行中'/)
assert.match(source, /'项目已确认'/)
assert.match(source, /window\.setInterval\(\(\) => void pollProjectStatus\(\), 1_500\)/)
assert.doesNotMatch(source, /current\.lifecycle === 'active' \? '执行中' : '待确认'/)
assert.match(source, /type ProjectRequirementTraceStatus = ProjectTraceStatus/)
assert.match(source, /valid: \{ label: '有效'/)
assert.match(source, /suspect: \{ label: '需复核'/)
assert.match(source, /invalid: \{ label: '失效'/)
assert.match(source, /traceStatus/)
assert.match(source, /logicalId/)
assert.match(source, /sourceBaselineVersion/)
assert.match(source, /sourceRequirementVersion/)
assert.match(source, /targetCurrentVersion/)
assert.match(source, /traceMetadata\?\.validationReason/)
assert.match(source, /function ProjectRequirementTraceTag/)
assert.match(source, /Tooltip title=\{trace\.tooltip\}/)
assert.match(source, /aria-label=\{`需求追溯状态：\$\{meta\.label\}`\}/)
assert.match(source, /whiteSpace: 'nowrap'/)
assert.match(source, /需复核和失效关系会继续展示/)
assert.match(source, /仅保留历史关系/)
assert.match(source, /preservedHistoricalRequirementIds/)
assert.match(source, /else await onUpdate\(inlineEditingId, inlineDraft\)/)
assert.doesNotMatch(source, /\.\.\.preservedHistoricalRequirementIds/)
assert.match(source, /ProjectRequirementTraceTag relation=\{requirement\}/)
assert.match(source, /源基线 \$\{sourceBaselineVersion\}/)
assert.match(source, /目标当前版本 \$\{targetCurrentVersion\}/)
const sharedProjectTypesSource = readFileSync(join(process.cwd(), 'src/shared/project-types.ts'), 'utf8')
const sharedTypesSource = readFileSync(join(process.cwd(), 'src/shared/types.ts'), 'utf8')
const retiredProjectSources = [
  source,
  preload,
  main,
  projectManagement,
  sharedProjectTypesSource,
  sharedTypesSource
]
const retiredProjectApiTokens = [
  'ProjectRequirementImpact',
  'getProjectRequirementImpactReport',
  'applyProjectTraceDecisions',
  'ProjectTraceDecision',
  'assignProjectTraceReviews',
  'listProjectTraceDecisionAudits',
  'ProjectTraceAiReview',
  'startProjectTraceAiReview',
  'cancelProjectTraceAiReview',
  'listProjectTraceAiReviewRuns',
  'getProjectTraceAiReviewRun',
  'ProjectGovernance',
  'getProjectGovernanceReport',
  'acknowledgeProjectGovernanceAlerts'
]
const retiredProjectIpcTokens = [
  'projects:requirement-impact',
  'projects:trace-decisions',
  'projects:trace-review-assignments',
  'projects:trace-decision-audits',
  'projects:trace-ai-review-',
  'projects:governance-'
]
const retiredProjectUiTokens = [
  "key: 'impact'",
  '变更影响',
  'ProjectImpactWorkbench',
  "key: 'audits'",
  '决策审计',
  '分配复核',
  'AI 辅助复核',
  'AI辅助复核',
  "key: 'governance'",
  '项目治理',
  '确认知悉治理提醒'
]
const retiredProjectNegativeContract = retiredProjectSources.every((text) => (
  [...retiredProjectApiTokens, ...retiredProjectIpcTokens, ...retiredProjectUiTokens]
    .every((token) => !text.includes(token))
))
assert.equal(retiredProjectNegativeContract, true, 'renderer/preload/main/service/shared 不得保留 Phase2–5 退役合同')
assert.match(source, /aria-label/)
console.log(JSON.stringify({ ok: true, checks: ['score detail only in tooltip', 'candidate-specific match analysis', 'shared guidance lifted above table', 'five-column compact layout', 'live project status', 'responsive scroll', 'requirement trace status and version tooltip', 'historical relation preservation', 'retired Phase2–5 contracts absent'] }))
