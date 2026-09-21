import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer as createTcpServer } from 'node:net'
import WebSocket from 'ws'

/**
 * Clean-room GJB5000B domain acceptance:
 * renderer preload -> main agent route -> local QueryEngine -> dashboard save gate.
 *
 * This deliberately does not provide an Ollama endpoint.  A recognized domain
 * request must be completed by the host-only domain path; falling back to the
 * model would fail against the intentionally unusable local endpoint and would
 * also create a failed VisualizationRun.
 */

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const smokeName = 'dashboard-gjb5000b-electron'
const sampleProjectId = 'sample-project-001'
const platformProjectId = 'platform-project-alpha'
const generatedAt = '2026-08-28T00:00:00.000Z'
const modelEndpoint = 'http://127.0.0.1:1'
const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const reservePort = async () => {
  const server = createTcpServer()
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolvePromise)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('无法为 Electron CDP 预留端口')
    const port = address.port
    await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    return port
  } catch (error) {
    if (server.listening) {
      await new Promise((resolvePromise) => server.close(() => resolvePromise()))
    }
    throw error
  }
}

const loadAppDatabase = async () => {
  const chunkDirectory = join(repoRoot, 'out', 'main', 'chunks')
  const chunkName = (await readdir(chunkDirectory)).find((name) => /^database-.*\.js$/.test(name))
  if (!chunkName) throw new Error(`未找到已构建的 AppDatabase chunk：${chunkDirectory}`)
  const module = await import(pathToFileURL(join(chunkDirectory, chunkName)).href)
  const AppDatabase = Object.values(module).find((value) => (
    typeof value === 'function' && value.name === 'AppDatabase'
  ))
  if (typeof AppDatabase !== 'function') throw new Error('已构建产物未导出 AppDatabase')
  return AppDatabase
}

const sampleRows = [
  {
    uid: 'sample-project-overview-001',
    itemId: 'SAMPLE-PO-001',
    name: '受控样例项目·基线',
    updatedAt: '2026-08-01T00:00:00.000Z',
    values: {
      healthScore: 78,
      milestoneAchievement: 0.72,
      requirementCompletion: 0.68,
      defectDensity: 0.12,
      highRiskCount: 2,
      processCompliance: 0.71
    }
  },
  {
    uid: 'sample-project-overview-002',
    itemId: 'SAMPLE-PO-002',
    name: '受控样例项目·阶段二',
    updatedAt: '2026-08-08T00:00:00.000Z',
    values: {
      healthScore: 82,
      milestoneAchievement: 0.86,
      requirementCompletion: 0.74,
      defectDensity: 0.09,
      highRiskCount: 1,
      processCompliance: 0.77
    }
  },
  {
    uid: 'sample-project-overview-003',
    itemId: 'SAMPLE-PO-003',
    name: '受控样例项目·阶段三',
    updatedAt: '2026-08-15T00:00:00.000Z',
    values: {
      healthScore: 75,
      milestoneAchievement: 0.8,
      requirementCompletion: 0.8,
      defectDensity: 0.15,
      highRiskCount: 1,
      processCompliance: 0.74
    }
  }
]

const requirementsSampleRows = [
  { uid: 'sample-requirements-delivery-001', itemId: 'SAMPLE-RD-001', name: '需求基线 B1', updatedAt: '2026-08-01T00:00:00.000Z', values: { requirementStability: 0.82, reviewCompletion: 0.76, requirementChangeRate: 0.18, developmentCompletion: 0.58, testCoverage: 0.44, traceabilityCompleteness: 0.61 } },
  { uid: 'sample-requirements-delivery-002', itemId: 'SAMPLE-RD-002', name: '需求基线 B2', updatedAt: '2026-08-08T00:00:00.000Z', values: { requirementStability: 0.88, reviewCompletion: 0.9, requirementChangeRate: 0.12, developmentCompletion: 0.72, testCoverage: 0.68, traceabilityCompleteness: 0.79 } },
  { uid: 'sample-requirements-delivery-003', itemId: 'SAMPLE-RD-003', name: '需求基线 B3', updatedAt: '2026-08-15T00:00:00.000Z', values: { requirementStability: 0.93, reviewCompletion: 0.96, requirementChangeRate: 0.07, developmentCompletion: 0.86, testCoverage: 0.91, traceabilityCompleteness: 0.94 } }
]

const planSampleRows = [
  {
    uid: 'sample-plan-milestone-001',
    itemId: 'SAMPLE-PM-001',
    name: '方案评审里程碑',
    updatedAt: '2026-08-01T00:00:00.000Z',
    values: {
      planCompletionRate: 0.64,
      scheduleVarianceDays: 9,
      delayedTaskCount: 5,
      criticalPathRiskScore: 0.88,
      milestoneForecastDelayDays: 12
    }
  },
  {
    uid: 'sample-plan-milestone-002',
    itemId: 'SAMPLE-PM-002',
    name: '测试准入里程碑',
    updatedAt: '2026-08-08T00:00:00.000Z',
    values: {
      planCompletionRate: 0.76,
      scheduleVarianceDays: 6,
      delayedTaskCount: 3,
      criticalPathRiskScore: 0.72,
      milestoneForecastDelayDays: 7
    }
  },
  {
    uid: 'sample-plan-milestone-003',
    itemId: 'SAMPLE-PM-003',
    name: '发布评审里程碑',
    updatedAt: '2026-08-15T00:00:00.000Z',
    values: {
      planCompletionRate: 0.85,
      scheduleVarianceDays: 3,
      delayedTaskCount: 2,
      criticalPathRiskScore: 0.58,
      milestoneForecastDelayDays: 3
    }
  }
]

const qualitySampleRows = [
  { uid: 'sample-software-quality-summary', itemId: 'SAMPLE-SQ-SUMMARY', name: '最新质量摘要', updatedAt: '2026-08-15T00:00:00.000Z', values: { criticalDefectCount: 1, defectReopenRate: 0.04 } },
  { uid: 'sample-software-quality-trend-001', itemId: 'SAMPLE-SQ-TREND-001', name: '质量快照 1', updatedAt: '2026-08-01T00:00:00.000Z', values: { openDefectCount: 18 } },
  { uid: 'sample-software-quality-trend-002', itemId: 'SAMPLE-SQ-TREND-002', name: '质量快照 2', updatedAt: '2026-08-08T00:00:00.000Z', values: { openDefectCount: 12 } },
  { uid: 'sample-software-quality-trend-003', itemId: 'SAMPLE-SQ-TREND-003', name: '质量快照 3', updatedAt: '2026-08-15T00:00:00.000Z', values: { openDefectCount: 7 } },
  { uid: 'sample-software-quality-module-001', itemId: 'SAMPLE-SQ-MODULE-001', name: '核心服务模块', updatedAt: '2026-08-15T00:00:00.000Z', values: { defectDensity: 0.14, meanRepairHours: 72, residualDefectRiskScore: 0.84 } },
  { uid: 'sample-software-quality-module-002', itemId: 'SAMPLE-SQ-MODULE-002', name: '数据处理模块', updatedAt: '2026-08-15T00:00:00.000Z', values: { defectDensity: 0.09, meanRepairHours: 49, residualDefectRiskScore: 0.66 } },
  { uid: 'sample-software-quality-module-003', itemId: 'SAMPLE-SQ-MODULE-003', name: '桌面交互模块', updatedAt: '2026-08-15T00:00:00.000Z', values: { defectDensity: 0.05, meanRepairHours: 31, residualDefectRiskScore: 0.42 } }
]

const testValidationSampleRows = [
  { uid: 'sample-test-summary', itemId: 'SAMPLE-TV-SUMMARY', name: '最新测试摘要', updatedAt: '2026-08-15T00:00:00.000Z', values: { testExecutionRate: 0.92, testPassRate: 0.88, testAutomationRate: 0.63 } },
  { uid: 'sample-code-coverage-001', itemId: 'SAMPLE-TV-CODE-001', name: '构建 1', updatedAt: '2026-08-01T00:00:00.000Z', values: { codeCoverageRate: 0.61 } },
  { uid: 'sample-code-coverage-002', itemId: 'SAMPLE-TV-CODE-002', name: '构建 2', updatedAt: '2026-08-08T00:00:00.000Z', values: { codeCoverageRate: 0.72 } },
  { uid: 'sample-code-coverage-003', itemId: 'SAMPLE-TV-CODE-003', name: '构建 3', updatedAt: '2026-08-15T00:00:00.000Z', values: { codeCoverageRate: 0.81 } },
  { uid: 'sample-requirement-coverage-001', itemId: 'SAMPLE-TV-REQ-001', name: '核心需求集', updatedAt: '2026-08-15T00:00:00.000Z', values: { testCoverage: 0.96 } },
  { uid: 'sample-requirement-coverage-002', itemId: 'SAMPLE-TV-REQ-002', name: '接口需求集', updatedAt: '2026-08-15T00:00:00.000Z', values: { testCoverage: 0.82 } },
  { uid: 'sample-requirement-coverage-003', itemId: 'SAMPLE-TV-REQ-003', name: '安全需求集', updatedAt: '2026-08-15T00:00:00.000Z', values: { testCoverage: 0.75 } },
  { uid: 'sample-blocked-suite-001', itemId: 'SAMPLE-TV-BLOCK-001', name: '系统测试', updatedAt: '2026-08-15T00:00:00.000Z', values: { blockedTestCaseCount: 3 } },
  { uid: 'sample-blocked-suite-002', itemId: 'SAMPLE-TV-BLOCK-002', name: '集成测试', updatedAt: '2026-08-15T00:00:00.000Z', values: { blockedTestCaseCount: 1 } },
  { uid: 'sample-blocked-suite-003', itemId: 'SAMPLE-TV-BLOCK-003', name: '回归测试', updatedAt: '2026-08-15T00:00:00.000Z', values: { blockedTestCaseCount: 0 } }
]

const configurationChangeSampleRows = [
  { uid: 'sample-configuration-summary', itemId: 'SAMPLE-CC-SUMMARY', name: '最新配置状态', updatedAt: '2026-08-15T00:00:00.000Z', values: { configurationItemControlRate: 0.94, baselineCompletenessRate: 0.91 } },
  { uid: 'sample-change-set-001', itemId: 'SAMPLE-CC-APPROVAL-001', name: '需求变更集', updatedAt: '2026-08-15T00:00:00.000Z', values: { changeApprovalRate: 1 } },
  { uid: 'sample-change-set-002', itemId: 'SAMPLE-CC-APPROVAL-002', name: '设计变更集', updatedAt: '2026-08-15T00:00:00.000Z', values: { changeApprovalRate: 0.88 } },
  { uid: 'sample-change-set-003', itemId: 'SAMPLE-CC-APPROVAL-003', name: '代码变更集', updatedAt: '2026-08-15T00:00:00.000Z', values: { changeApprovalRate: 0.96 } },
  { uid: 'sample-change-snapshot-001', itemId: 'SAMPLE-CC-OPEN-001', name: '变更快照 1', updatedAt: '2026-08-01T00:00:00.000Z', values: { openChangeCount: 12 } },
  { uid: 'sample-change-snapshot-002', itemId: 'SAMPLE-CC-OPEN-002', name: '变更快照 2', updatedAt: '2026-08-08T00:00:00.000Z', values: { openChangeCount: 8 } },
  { uid: 'sample-change-snapshot-003', itemId: 'SAMPLE-CC-OPEN-003', name: '变更快照 3', updatedAt: '2026-08-15T00:00:00.000Z', values: { openChangeCount: 5 } },
  { uid: 'sample-reproducible-build-001', itemId: 'SAMPLE-CC-BUILD-001', name: '发布构建 A', updatedAt: '2026-08-15T00:00:00.000Z', values: { reproducibleBuildRate: 1 } },
  { uid: 'sample-reproducible-build-002', itemId: 'SAMPLE-CC-BUILD-002', name: '发布构建 B', updatedAt: '2026-08-15T00:00:00.000Z', values: { reproducibleBuildRate: 0.8 } },
  { uid: 'sample-reproducible-build-003', itemId: 'SAMPLE-CC-BUILD-003', name: '发布构建 C', updatedAt: '2026-08-15T00:00:00.000Z', values: { reproducibleBuildRate: 0.6 } }
]

const gjb5000bComplianceSampleRows = [
  { uid: 'sample-compliance-summary', itemId: 'SAMPLE-GJB-SUMMARY', name: '最新内部检查摘要', updatedAt: '2026-08-15T00:00:00.000Z', values: { activityExecutionRate: 0.89, workProductCompletenessRate: 0.86 } },
  { uid: 'sample-evidence-domain-001', itemId: 'SAMPLE-GJB-EVIDENCE-001', name: '项目策划过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { evidenceSufficiencyRate: 0.92 } },
  { uid: 'sample-evidence-domain-002', itemId: 'SAMPLE-GJB-EVIDENCE-002', name: '需求开发过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { evidenceSufficiencyRate: 0.81 } },
  { uid: 'sample-evidence-domain-003', itemId: 'SAMPLE-GJB-EVIDENCE-003', name: '配置管理过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { evidenceSufficiencyRate: 0.74 } },
  { uid: 'sample-deviation-snapshot-001', itemId: 'SAMPLE-GJB-DEV-001', name: '检查快照 1', updatedAt: '2026-08-01T00:00:00.000Z', values: { processDeviationCount: 9 } },
  { uid: 'sample-deviation-snapshot-002', itemId: 'SAMPLE-GJB-DEV-002', name: '检查快照 2', updatedAt: '2026-08-08T00:00:00.000Z', values: { processDeviationCount: 6 } },
  { uid: 'sample-deviation-snapshot-003', itemId: 'SAMPLE-GJB-DEV-003', name: '检查快照 3', updatedAt: '2026-08-15T00:00:00.000Z', values: { processDeviationCount: 4 } },
  { uid: 'sample-nonconformity-domain-001', itemId: 'SAMPLE-GJB-NC-001', name: '项目策划过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { nonconformityClosureRate: 1 } },
  { uid: 'sample-nonconformity-domain-002', itemId: 'SAMPLE-GJB-NC-002', name: '需求开发过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { nonconformityClosureRate: 0.83 } },
  { uid: 'sample-nonconformity-domain-003', itemId: 'SAMPLE-GJB-NC-003', name: '配置管理过程域', updatedAt: '2026-08-15T00:00:00.000Z', values: { nonconformityClosureRate: 0.67 } }
]

const organizationImprovementSampleRows = [
  { uid: 'sample-organization-summary', itemId: 'SAMPLE-OI-SUMMARY', name: '最新组织度量摘要', updatedAt: '2026-08-15T00:00:00.000Z', values: { qualityDispersionScore: 0.42, estimationDeviationRate: 0.21, improvementCompletionRate: 0.78 } },
  { uid: 'sample-productivity-project-001', itemId: 'SAMPLE-OI-PROD-001', name: '项目 Alpha', updatedAt: '2026-08-15T00:00:00.000Z', values: { productivityIndex: 1.08 } },
  { uid: 'sample-productivity-project-002', itemId: 'SAMPLE-OI-PROD-002', name: '项目 Beta', updatedAt: '2026-08-15T00:00:00.000Z', values: { productivityIndex: 0.91 } },
  { uid: 'sample-productivity-project-003', itemId: 'SAMPLE-OI-PROD-003', name: '项目 Gamma', updatedAt: '2026-08-15T00:00:00.000Z', values: { productivityIndex: 0.76 } },
  { uid: 'sample-defect-escape-001', itemId: 'SAMPLE-OI-ESCAPE-001', name: '质量周期 1', updatedAt: '2026-08-01T00:00:00.000Z', values: { defectEscapeRate: 0.13 } },
  { uid: 'sample-defect-escape-002', itemId: 'SAMPLE-OI-ESCAPE-002', name: '质量周期 2', updatedAt: '2026-08-08T00:00:00.000Z', values: { defectEscapeRate: 0.09 } },
  { uid: 'sample-defect-escape-003', itemId: 'SAMPLE-OI-ESCAPE-003', name: '质量周期 3', updatedAt: '2026-08-15T00:00:00.000Z', values: { defectEscapeRate: 0.06 } },
  { uid: 'sample-baseline-group-001', itemId: 'SAMPLE-OI-BASE-001', name: '研发过程基线组', updatedAt: '2026-08-15T00:00:00.000Z', values: { baselineStabilityRate: 0.94 } },
  { uid: 'sample-baseline-group-002', itemId: 'SAMPLE-OI-BASE-002', name: '质量度量基线组', updatedAt: '2026-08-15T00:00:00.000Z', values: { baselineStabilityRate: 0.86 } },
  { uid: 'sample-baseline-group-003', itemId: 'SAMPLE-OI-BASE-003', name: '项目估算基线组', updatedAt: '2026-08-15T00:00:00.000Z', values: { baselineStabilityRate: 0.72 } }
]

const platformAdapter = {
  schemaVersion: '1.0',
  id: 'visslm-project-overview-v1',
  scenarioId: 'project-overview',
  sourceSystem: 'VISSLM lifecycle platform',
  allowedProjectIds: [platformProjectId],
  permissions: ['project:read', 'process:evidence:read'],
  nodeTypes: ['ProjectStatusRecord'],
  tailoringBaselineId: 'BL-PROJECT-2026-V3',
  metricBindings: [
    { metricId: 'project-health', field: 'health_indicator', aggregation: 'avg' },
    { metricId: 'milestone-achievement', field: 'milestone_ratio', aggregation: 'avg' },
    { metricId: 'requirement-completion', field: 'requirement_ratio', aggregation: 'avg' },
    { metricId: 'defect-density', field: 'defect_per_size', aggregation: 'avg' },
    { metricId: 'high-risk-count', field: 'risk_total', aggregation: 'sum' },
    { metricId: 'process-compliance', field: 'process_rate', aggregation: 'avg' }
  ],
  questionBindings: [
    { questionId: 'project-overview-defect-question', dimensionFields: ['name'] }
  ],
  evidenceBindings: [
    { processBindingId: 'process.project-health', evidenceStatus: 'sufficient', sourceKey: 'visslm.review.project-health' },
    { processBindingId: 'process.milestone-tracking', evidenceStatus: 'sufficient', sourceKey: 'visslm.plan.milestone' },
    { processBindingId: 'process.requirement-status', evidenceStatus: 'insufficient', sourceKey: 'visslm.requirement.status' },
    { processBindingId: 'process.defect-classification', evidenceStatus: 'sufficient', sourceKey: 'visslm.defect.classification' },
    { processBindingId: 'process.risk-register', evidenceStatus: 'missing', sourceKey: 'visslm.risk.register' },
    { processBindingId: 'process.baseline-evidence', evidenceStatus: 'insufficient', sourceKey: 'visslm.baseline.evidence' }
  ],
  updatedAt: generatedAt
}

const platformRows = [
  { uid: 'platform-project-001', itemId: 'PLATFORM-PROJECT-001', name: '平台项目 Alpha', updatedAt: '2026-08-20T00:00:00.000Z', values: { health_indicator: 0.82, milestone_ratio: 0.88, requirement_ratio: 0.79, defect_per_size: 0.12, risk_total: 4, process_rate: 0.86 } },
  { uid: 'platform-project-002', itemId: 'PLATFORM-PROJECT-002', name: '平台项目 Beta', updatedAt: '2026-08-20T00:00:00.000Z', values: { health_indicator: 0.76, milestone_ratio: 0.81, requirement_ratio: 0.84, defect_per_size: 0.18, risk_total: 6, process_rate: 0.78 } }
]

const seedDatabase = async (userDataDirectory) => {
  const AppDatabase = await loadAppDatabase()
  const database = new AppDatabase(
    join(userDataDirectory, 'visslm-agent.db'),
    join(userDataDirectory, 'assets')
  )
  try {
    // Keep an accidental model fallback local and unavailable. The expected
    // domain path never reads this endpoint or calls the model.
    const settings = {
      'model.source': 'local',
      'model.provider': 'ollama',
      'model.baseUrl': modelEndpoint,
      'model.model': 'smoke-domain-unused',
      'model.thinking': 'false',
      'model.profile.local.provider': 'ollama',
      'model.profile.local.baseUrl': modelEndpoint,
      'model.profile.local.model': 'smoke-domain-unused',
      'model.profile.local.thinking': 'false',
      'dashboard.domain-platform-adapters:v1': JSON.stringify({ adapters: [platformAdapter] })
    }
    for (const [key, value] of Object.entries(settings)) database.setSetting(key, value)

    const rows = sampleRows.map((record) => ({
      documentId: `ProjectOverviewSample:${record.uid}`,
      title: record.name,
      content: 'controlled GJB5000B project overview sample',
      metadata: {
        projectId: sampleProjectId,
        recordType: 'ProjectOverviewSample',
        sourceId: record.uid,
        itemId: record.itemId,
        updatedAt: record.updatedAt
      },
      raw: record.values
    })).concat(requirementsSampleRows.map((record) => ({
      documentId: `RequirementsDeliverySample:${record.uid}`,
      title: record.name,
      content: 'controlled requirements delivery sample',
      metadata: { projectId: sampleProjectId, recordType: 'RequirementsDeliverySample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), planSampleRows.map((record) => ({
      documentId: `PlanMilestoneSample:${record.uid}`,
      title: record.name,
      content: 'controlled plan and milestone sample',
      metadata: {
        projectId: sampleProjectId,
        recordType: 'PlanMilestoneSample',
        sourceId: record.uid,
        itemId: record.itemId,
        updatedAt: record.updatedAt
      },
      raw: record.values
    })), qualitySampleRows.map((record) => ({
      documentId: `SoftwareQualitySample:${record.uid}`,
      title: record.name,
      content: 'controlled software quality sample',
      metadata: { projectId: sampleProjectId, recordType: 'SoftwareQualitySample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), testValidationSampleRows.map((record) => ({
      documentId: `TestValidationSample:${record.uid}`,
      title: record.name,
      content: 'controlled test validation sample',
      metadata: { projectId: sampleProjectId, recordType: 'TestValidationSample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), configurationChangeSampleRows.map((record) => ({
      documentId: `ConfigurationChangeSample:${record.uid}`,
      title: record.name,
      content: 'controlled configuration and change sample',
      metadata: { projectId: sampleProjectId, recordType: 'ConfigurationChangeSample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), gjb5000bComplianceSampleRows.map((record) => ({
      documentId: `Gjb5000bComplianceSample:${record.uid}`,
      title: record.name,
      content: 'controlled internal GJB5000B process evidence sample; not an official compliance conclusion',
      metadata: { projectId: sampleProjectId, recordType: 'Gjb5000bComplianceSample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), organizationImprovementSampleRows.map((record) => ({
      documentId: `OrganizationImprovementSample:${record.uid}`,
      title: record.name,
      content: 'controlled organization measurement and improvement sample',
      metadata: { projectId: sampleProjectId, recordType: 'OrganizationImprovementSample', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })), platformRows.map((record) => ({
      documentId: `ProjectStatusRecord:${record.uid}`,
      title: record.name,
      content: 'mapped VISSLM lifecycle platform project status record',
      metadata: { projectId: platformProjectId, recordType: 'ProjectStatusRecord', sourceId: record.uid, itemId: record.itemId, updatedAt: record.updatedAt },
      raw: record.values
    })))
    const imported = database.importRows(rows)
    assert.equal(imported.recordCount, rows.length, '领域 Electron 夹具应导入三条记录')
    return { recordCount: imported.recordCount, projectId: sampleProjectId }
  } finally {
    database.close()
  }
}

const waitForTargets = async (electron, port, timeoutMs = 60_000) => {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (electron.exitCode !== null) {
      throw new Error(`Electron 在 CDP 启动前退出（${electron.exitCode}）：${lastError}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const targets = await response.json()
        if (targets.some((target) => (
          target.type === 'page' && target.webSocketDebuggerUrl &&
          target.url && target.url !== 'about:blank'
        ))) return targets
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(100)
  }
  throw new Error(`等待 Electron CDP 超时：${lastError}`)
}

const connectCdp = async (url) => {
  const socket = new WebSocket(url)
  await new Promise((resolvePromise, reject) => {
    socket.once('open', resolvePromise)
    socket.once('error', reject)
  })
  let sequence = 0
  const pending = new Map()
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'))
    if (!message.id) return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    request.resolve(message)
  })
  socket.on('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('CDP WebSocket 已关闭'))
    }
    pending.clear()
  })
  const call = (method, params = {}, timeoutMs = 30_000) => new Promise((resolvePromise, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 调用超时：${method}`))
    }, timeoutMs)
    pending.set(id, { resolve: resolvePromise, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, timeoutMs = 120_000) => {
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs)
    if (response.error) throw new Error(response.error.message || 'CDP evaluate 失败')
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ||
        response.result.exceptionDetails.text ||
        'Renderer evaluate 失败'
      )
    }
    return response.result?.result?.value
  }
  return {
    call,
    evaluate,
    close: () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
  }
}

const connectStableCdp = async (electron, port, timeoutMs = 60_000) => {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (electron.exitCode !== null) {
      throw new Error(`Electron 在 renderer 就绪前退出（${electron.exitCode}）：${lastError}`)
    }
    try {
      const targets = await waitForTargets(electron, port, 2_000)
      const target = targets.find((item) => (
        item.type === 'page' && item.webSocketDebuggerUrl && item.url !== 'about:blank'
      ))
      if (!target?.webSocketDebuggerUrl) throw new Error('没有可用的 Electron page target')
      const candidate = await connectCdp(target.webSocketDebuggerUrl)
      try {
        await candidate.call('Runtime.enable', {}, 5_000)
        await candidate.call('Page.enable', {}, 5_000)
        const ready = await candidate.evaluate(
          'Boolean(window.visslm && document.querySelector(".ant-menu-item"))',
          5_000
        )
        if (ready) return candidate
        lastError = '应用菜单尚未挂载'
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      candidate.close()
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250)
  }
  throw new Error(`等待稳定 Electron renderer 超时：${lastError}`)
}

const evaluateRenderer = (cdp, source, timeoutMs = 120_000) =>
  cdp.evaluate(`(${source})()`, timeoutMs)

const runDomainContract = async function () {
  const scope = { projectIds: ['sample-project-001'] }
  const request = {
    question: '项目负责人基于受控样例生成项目综合态势大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: scope
  }
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent(request)
  const dashboard = response?.dashboard
  const answer = String(response?.answer || '')
  const base = {
    responseExpert: response?.expertId,
    answer,
    responseEventTypes: Array.isArray(response?.events)
      ? response.events.map((event) => event?.type).filter(Boolean)
      : [],
    dashboardId: dashboard?.id,
    dashboardComponentCount: Array.isArray(dashboard?.components) ? dashboard.components.length : 0
  }
  if (!dashboard) {
    return {
      ok: false,
      checks: { responseHasDashboard: false },
      ...base,
      runsBefore: runsBefore.length,
      runsAfter: (await window.visslm.listVisualizationRuns(100)).length
    }
  }

  const metricIds = [
    'project-health',
    'milestone-achievement',
    'requirement-completion',
    'defect-density',
    'high-risk-count',
    'process-compliance'
  ]
  const receipt = dashboard.domainReceipt
  const components = Array.isArray(dashboard.components) ? dashboard.components : []
  const blueprint = dashboard.analysisBlueprint
  const componentContracts = components.map((component) => {
    const queryScope = component?.query?.scope?.projectIds
    const data = Array.isArray(component?.data) ? component.data : []
    const measures = Array.isArray(component?.query?.measures) ? component.query.measures : []
    return {
      id: component?.id,
      hasQuery: Boolean(component?.query),
      hasLayout: Boolean(component?.layout),
      hasBinding: Boolean(component?.semanticBinding),
      hasSlotRole: Boolean(component?.slotRole),
      hasProcessBindings: Array.isArray(component?.semanticBinding?.processBindingIds) &&
        component.semanticBinding.processBindingIds.length > 0,
      hasData: data.length > 0 && data.every((point) => Number.isFinite(Number(point?.value))),
      queryScopePreserved: JSON.stringify(queryScope) === JSON.stringify(scope.projectIds),
      queryNodeTypeScoped: JSON.stringify(component?.query?.scope?.nodeTypes) ===
        JSON.stringify(['ProjectOverviewSample']),
      hasMeasure: measures.length > 0
    }
  })
  const runsAfterGeneration = await window.visslm.listVisualizationRuns(100)
  const rendererModelRequests = performance.getEntriesByType('resource')
    .map((entry) => String(entry?.name || ''))
    .filter((name) => /ollama|api\/(?:chat|tags|show)|127\.0\.0\.1:1|11434/i.test(name))
  const checks = {
    responseHasDashboard: true,
    expertRoutedToVisualization: response?.expertId === 'visualization',
    answerMarksControlledSample: /受控样例/.test(answer),
    answerMarksPreview: /预览/.test(answer),
    answerMentionsLocalQuerySpec: /QuerySpec/.test(answer) && /本地计算/.test(answer),
    domainContextValid: dashboard.domainContext?.role === 'project-owner' &&
      dashboard.domainContext?.scenario === 'project-overview' &&
      dashboard.domainContext?.artifactStatus === 'preview' &&
      dashboard.domainContext?.catalogVersion === '1.0' &&
      dashboard.domainContext?.tailoringBaselineId === 'sample-tailoring-baseline-v1',
    domainReceiptPersisted: Boolean(receipt) &&
      Array.isArray(receipt?.evidenceMissing) &&
      Array.isArray(receipt?.evidenceInsufficient) &&
      Array.isArray(receipt?.warnings) &&
      Array.isArray(receipt?.confirmations) &&
      Number.isFinite(Number(receipt?.confidence)),
    analysisBlueprintHasSixCatalogMetrics: blueprint?.metrics?.length === 6 &&
      JSON.stringify(blueprint.metrics.map((metric) => metric.id)) === JSON.stringify(metricIds) &&
      blueprint.metrics.every((metric) => metric.source === 'catalog'),
    sixComponentsRendered: components.length === 6,
    componentContractsValid: componentContracts.every((contract) => Object.values(contract)
      .filter((value) => typeof value === 'boolean').every(Boolean)),
    noVisualizationRunCreated: runsAfterGeneration.length === runsBefore.length,
    noRendererModelNetworkCalls: rendererModelRequests.length === 0
  }
  if (!Object.values(checks).every(Boolean)) {
    return {
      ok: false,
      checks,
      ...base,
      componentContracts,
      runsBefore: runsBefore.length,
      runsAfter: runsAfterGeneration.length,
      rendererModelRequests
    }
  }

  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'GJB5000B 领域 Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  const versionsAfterPreview = await window.visslm.listDashboardVersions(saved.dashboardId)
  const formalDashboard = JSON.parse(JSON.stringify(dashboard))
  formalDashboard.domainContext.artifactStatus = 'formal'
  let formalSaveError = ''
  try {
    await window.visslm.saveDashboard({
      spec: formalDashboard,
      changeSummary: 'GJB5000B formal evidence-gap rejection smoke'
    })
  } catch (error) {
    formalSaveError = String(error?.message || error)
  }
  const versionsAfterFormal = await window.visslm.listDashboardVersions(saved.dashboardId)
  const savedReceipt = readBack?.spec?.domainReceipt
  const formalRejected = Boolean(formalSaveError) && versionsAfterFormal.length === versionsAfterPreview.length &&
    versionsAfterFormal.every((version) => versionsAfterPreview.some((previous) => (
      version.version === previous.version && JSON.stringify(version.spec) === JSON.stringify(previous.spec)
    )))
  return {
    ok: true,
    checks: {
      ...checks,
      previewSaveSucceeded: saved.version === 1,
      previewReadBackSucceeded: Boolean(readBack?.spec?.domainContext) &&
        readBack.spec.domainContext.artifactStatus === 'preview',
      receiptSurvivesSaveReadBack: JSON.stringify(savedReceipt) === JSON.stringify(receipt),
      formalSaveRejectedWithoutNewVersion: formalRejected
    },
    ...base,
    componentContracts,
    saved: {
      dashboardId: saved.dashboardId,
      version: saved.version,
      versionCount: versionsAfterPreview.length,
      receipt: savedReceipt
    },
    formalSaveError,
    formalVersionCount: versionsAfterFormal.length,
    runsBefore: runsBefore.length,
    runsAfter: runsAfterGeneration.length,
    rendererModelRequests
  }
}

const runRequirementsDeliveryContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: '项目负责人基于受控样例生成需求到交付全链路大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'requirement-stability',
    'requirement-review-completion',
    'requirement-change-rate',
    'development-completion',
    'requirement-test-coverage',
    'bidirectional-traceability'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const checks = {
    requirementsResponseHasDashboard: Boolean(dashboard),
    requirementsExpertRouted: response?.expertId === 'visualization',
    requirementsScenarioValid: dashboard?.domainContext?.scenario === 'requirements-delivery',
    requirementsTitleValid: dashboard?.title === '需求到交付全链路（受控样例）',
    requirementsMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    requirementsComponentsValid: components.length === 6 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['RequirementsDeliverySample'])
    ),
    requirementsReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    requirementsNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'requirements-delivery Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.requirementsPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'requirements-delivery' &&
    readBack?.spec?.components?.length === 6
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runPlanMilestoneContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: '项目负责人基于受控样例生成计划与里程碑执行大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'plan-completion-rate',
    'schedule-variance-days',
    'delayed-task-count',
    'critical-path-risk-score',
    'milestone-forecast-delay-days'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const checks = {
    planResponseHasDashboard: Boolean(dashboard),
    planExpertRouted: response?.expertId === 'visualization',
    planScenarioValid: dashboard?.domainContext?.scenario === 'plan-milestone',
    planTitleValid: dashboard?.title === '计划与里程碑执行（受控样例）',
    planMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    planComponentsValid: components.length === 5 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['PlanMilestoneSample'])
    ),
    planSemanticLimitsVisible: components.some((component) =>
      component.id === 'plan-milestone-delayed-card' && /平均值/.test(component.title)
    ) && components.some((component) =>
      component.id === 'plan-milestone-forecast-card' && component.type === 'table'
    ),
    planReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    planNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'plan-milestone Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.planPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'plan-milestone' &&
    readBack?.spec?.components?.length === 5
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runSoftwareQualityContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: 'QA/EPG 基于受控样例生成软件质量与缺陷闭环大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'critical-defect-count',
    'defect-reopen-rate',
    'defect-density',
    'open-defect-count',
    'mean-defect-repair-hours',
    'residual-defect-risk-score'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const density = components.find((component) => component.id === 'software-quality-density-card')
  const checks = {
    qualityResponseHasDashboard: Boolean(dashboard),
    qualityExpertRouted: response?.expertId === 'visualization',
    qualityScenarioValid: dashboard?.domainContext?.scenario === 'software-quality',
    qualityTitleValid: dashboard?.title === '软件质量与缺陷闭环（受控样例）',
    qualityMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    qualityComponentsValid: components.length === 6 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['SoftwareQualitySample'])
    ),
    qualityDensityNotCount: density?.query?.measures?.[0]?.field === 'defectDensity' &&
      /缺陷密度/.test(density?.title || '') && !/缺陷总数/.test(density?.title || ''),
    qualityReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    qualityNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'software-quality Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.qualityPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'software-quality' &&
    readBack?.spec?.components?.length === 6
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runTestValidationContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: 'QA/EPG 基于受控样例生成测试与验证充分性大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'test-case-execution-rate',
    'test-pass-rate',
    'requirement-test-coverage',
    'code-coverage-rate',
    'test-automation-rate',
    'blocked-test-case-count'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const requirementCoverage = components.find((component) =>
    component.id === 'test-validation-requirement-coverage-card'
  )
  const codeCoverage = components.find((component) =>
    component.id === 'test-validation-code-coverage-card'
  )
  const requirementCoverageField = requirementCoverage?.query?.measures?.[0]?.field
  const codeCoverageField = codeCoverage?.query?.measures?.[0]?.field
  const checks = {
    testValidationResponseHasDashboard: Boolean(dashboard),
    testValidationExpertRouted: response?.expertId === 'visualization',
    testValidationScenarioValid: dashboard?.domainContext?.scenario === 'test-validation',
    testValidationTitleValid: dashboard?.title === '测试与验证充分性（受控样例）',
    testValidationMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    testValidationComponentsValid: components.length === 6 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['TestValidationSample'])
    ),
    testValidationCoverageSemanticsValid: requirementCoverageField === 'testCoverage' &&
      codeCoverageField === 'codeCoverageRate' && requirementCoverageField !== codeCoverageField,
    testValidationReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    testValidationNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'test-validation Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.testValidationPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'test-validation' &&
    readBack?.spec?.components?.length === 6
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runConfigurationChangeContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: '研发负责人基于受控样例生成配置管理与变更控制大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'configuration-item-control-rate',
    'baseline-completeness-rate',
    'change-approval-rate',
    'open-change-count',
    'reproducible-build-rate'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const approval = components.find((component) => component.id === 'configuration-change-approval-card')
  const openChanges = components.find((component) => component.id === 'configuration-change-open-trend-card')
  const approvalField = approval?.query?.measures?.[0]?.field
  const openChangesField = openChanges?.query?.measures?.[0]?.field
  const checks = {
    configurationResponseHasDashboard: Boolean(dashboard),
    configurationExpertRouted: response?.expertId === 'visualization',
    configurationScenarioValid: dashboard?.domainContext?.scenario === 'configuration-change',
    configurationTitleValid: dashboard?.title === '配置管理与变更控制（受控样例）',
    configurationMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    configurationComponentsValid: components.length === 5 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['ConfigurationChangeSample'])
    ),
    configurationChangeSemanticsValid: approvalField === 'changeApprovalRate' &&
      openChangesField === 'openChangeCount' && approvalField !== openChangesField,
    configurationReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    configurationNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'configuration-change Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.configurationPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'configuration-change' &&
    readBack?.spec?.components?.length === 5
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runGjb5000bComplianceContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: 'QA/EPG 基于受控样例生成 GJB5000B 过程符合度与证据审计大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'process-activity-execution-rate',
    'work-product-completeness-rate',
    'evidence-sufficiency-rate',
    'process-deviation-count',
    'nonconformity-closure-rate'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const evidence = components.find((component) => component.id === 'gjb5000b-compliance-evidence-headline-card')
  const deviations = components.find((component) => component.id === 'gjb5000b-compliance-deviation-card')
  const evidenceField = evidence?.query?.measures?.[0]?.field
  const deviationField = deviations?.query?.measures?.[0]?.field
  const checks = {
    complianceResponseHasDashboard: Boolean(dashboard),
    complianceExpertRouted: response?.expertId === 'visualization',
    complianceScenarioValid: dashboard?.domainContext?.scenario === 'gjb5000b-compliance',
    complianceTitleValid: dashboard?.title === 'GJB5000B 过程符合度与证据审计（受控样例）',
    complianceMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    complianceComponentsValid: components.length === 9 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['Gjb5000bComplianceSample'])
    ),
    compliancePublicPrimitivesValid: JSON.stringify(components.map((component) => component.type)) === JSON.stringify([
      'kpi',
      'kpi',
      'kpi',
      'kpi',
      'data-matrix',
      'description-list',
      'line',
      'ranking',
      'comparison-bars'
    ]),
    complianceSemanticsValid: evidenceField === 'evidenceSufficiencyRate' &&
      deviationField === 'processDeviationCount' && evidenceField !== deviationField,
    complianceOfficialBoundaryVisible: dashboard?.domainReceipt?.warnings?.some((warning) =>
      /不构成正式符合性结论/.test(warning)
    ) === true,
    complianceReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    complianceNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const diagnosis = await window.visslm.diagnoseDashboard(dashboard)
  checks.complianceDiagnosticUsesControlledFixture =
    diagnosis.components.length === components.length &&
    diagnosis.components.every((component) => component.status === 'ok') &&
    diagnosis.issues.every((issue) => issue.code !== 'query-error')
  const repaired = await window.visslm.repairDashboardComponent(
    dashboard,
    'gjb5000b-compliance-activity-card'
  )
  checks.complianceRepairUsesControlledFixture =
    repaired.componentId === 'gjb5000b-compliance-activity-card' &&
    repaired.spec.components.length === components.length &&
    repaired.report.components.every((component) => component.status === 'ok') &&
    repaired.report.issues.every((issue) => issue.code !== 'query-error')
  const saved = await window.visslm.saveDashboard({
    spec: repaired.spec,
    changeSummary: 'gjb5000b-compliance Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.compliancePreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'gjb5000b-compliance' &&
    readBack?.spec?.components?.length === 9 &&
    readBack?.spec?.domainReceipt?.warnings?.some((warning) => /不构成正式符合性结论/.test(warning)) === true
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runOrganizationImprovementContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: '型号组织管理负责人基于受控样例生成组织级度量与过程改进大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['sample-project-001'] }
  })
  const dashboard = response?.dashboard
  const expectedMetrics = [
    'project-quality-dispersion-score',
    'estimation-deviation-rate',
    'delivery-productivity-index',
    'defect-escape-rate',
    'process-improvement-completion-rate',
    'organizational-baseline-stability-rate'
  ]
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const dispersion = components.find((component) => component.id === 'organization-improvement-quality-dispersion-card')
  const productivity = components.find((component) => component.id === 'organization-improvement-productivity-card')
  const checks = {
    organizationResponseHasDashboard: Boolean(dashboard),
    organizationExpertRouted: response?.expertId === 'visualization',
    organizationScenarioValid: dashboard?.domainContext?.scenario === 'organization-improvement',
    organizationRoleValid: dashboard?.domainContext?.role === 'model-org-manager',
    organizationTitleValid: dashboard?.title === '组织级度量与过程改进（受控样例）',
    organizationMetricsValid: JSON.stringify(dashboard?.analysisBlueprint?.metrics?.map((metric) => metric.id)) ===
      JSON.stringify(expectedMetrics),
    organizationComponentsValid: components.length === 6 && components.every((component) =>
      component?.query && component?.semanticBinding?.processBindingIds?.length && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['OrganizationImprovementSample'])
    ),
    organizationSemanticsValid: dispersion?.query?.measures?.[0]?.field === 'qualityDispersionScore' &&
      productivity?.query?.measures?.[0]?.field === 'productivityIndex',
    organizationReceiptPersisted: Boolean(dashboard?.domainReceipt?.confidence) &&
      dashboard.domainReceipt.evidenceMissing?.length > 0 &&
      dashboard.domainReceipt.evidenceInsufficient?.length > 0,
    organizationNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'organization-improvement Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.organizationPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.domainContext?.scenario === 'organization-improvement' &&
    readBack?.spec?.domainContext?.role === 'model-org-manager' &&
    readBack?.spec?.components?.length === 6
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    componentTitles: components.map((component) => component.title)
  }
}

const runPlatformAdapterContract = async function () {
  const runsBefore = await window.visslm.listVisualizationRuns(100)
  const response = await window.visslm.askAgent({
    question: '项目负责人生成项目综合态势大屏',
    expertId: 'visualization',
    chatMode: 'expert',
    entrypoint: 'dashboard',
    dataScope: { projectIds: ['platform-project-alpha'] }
  })
  const dashboard = response?.dashboard
  const components = Array.isArray(dashboard?.components) ? dashboard.components : []
  const health = components.find((component) => component.id === 'project-overview-health-card')
  const checks = {
    platformResponseHasDashboard: Boolean(dashboard),
    platformExpertRouted: response?.expertId === 'visualization',
    platformScenarioValid: dashboard?.domainContext?.scenario === 'project-overview',
    platformBaselineValid: dashboard?.domainContext?.tailoringBaselineId === 'BL-PROJECT-2026-V3',
    platformTitleValid: dashboard?.title === '项目综合态势（平台数据预览）',
    platformSubtitleValid: dashboard?.subtitle === 'VISSLM lifecycle platform · mapped data · preview',
    platformAnswerValid: /平台数据预览/.test(response?.answer || '') &&
      /visslm-project-overview-v1/.test(response?.answer || ''),
    platformComponentsValid: components.length === 6 && components.every((component) =>
      component?.query && component?.data?.length &&
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['ProjectStatusRecord'])
    ),
    platformFieldMappingValid: health?.query?.measures?.[0]?.field === 'health_indicator',
    platformReceiptValid: dashboard?.domainReceipt?.evidenceMissing?.length === 1 &&
      dashboard?.domainReceipt?.evidenceInsufficient?.length === 2 &&
      dashboard?.domainReceipt?.warnings?.some((warning) => /VISSLM lifecycle platform/.test(warning)) === true,
    platformNoModelFallback: (await window.visslm.listVisualizationRuns(100)).length === runsBefore.length
  }
  const settings = await window.visslm.getSettings()
  const configuredAdapter = settings?.dashboardDomainPlatformAdapters?.find((adapter) => adapter.id === 'visslm-project-overview-v1')
  const scopeRejected = configuredAdapter
    ? await window.visslm.previewDashboardDomainPlatformAdapter({
      adapter: { ...configuredAdapter, allowedProjectIds: ['another-project'] },
      projectId: 'platform-project-alpha'
    })
    : undefined
  const permissionRejected = configuredAdapter
    ? await window.visslm.previewDashboardDomainPlatformAdapter({
      adapter: { ...configuredAdapter, permissions: ['project:read'] },
      projectId: 'platform-project-alpha'
    })
    : undefined
  checks.platformAdapterScopeRejected = scopeRejected?.ok === false && /授权范围|超出/.test(scopeRejected.reason || '')
  checks.platformAdapterPermissionRejected = permissionRejected?.ok === false && /必要权限|过程证据/.test(permissionRejected.reason || '')
  if (!dashboard || !Object.values(checks).every(Boolean)) {
    return { ok: false, checks, answer: response?.answer, dashboard }
  }
  const saved = await window.visslm.saveDashboard({
    spec: dashboard,
    changeSummary: 'platform adapter Electron preview smoke'
  })
  const readBack = await window.visslm.getDashboard(saved.dashboardId, saved.version)
  checks.platformPreviewSaveReadBack = saved.version === 1 &&
    readBack?.spec?.title === '项目综合态势（平台数据预览）' &&
    readBack?.spec?.domainContext?.tailoringBaselineId === 'BL-PROJECT-2026-V3' &&
    readBack?.spec?.components?.every((component) =>
      JSON.stringify(component?.query?.scope?.nodeTypes) === JSON.stringify(['ProjectStatusRecord'])
    )
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    answer: response?.answer,
    dashboardId: dashboard.id,
    version: saved.version,
    mappedFields: dashboard.analysisBlueprint?.metrics?.map((metric) => ({ id: metric.id, field: metric.field }))
  }
}

const runAdapterSettingsContract = async function () {
  const initial = await window.visslm.getSettings()
  const configured = initial?.dashboardDomainPlatformAdapters || []
  const selected = configured.find((adapter) => adapter.id === 'visslm-project-overview-v1')
  if (!selected) return { ok: false, checks: { adapterLoadedInSettings: false } }
  const saved = await window.visslm.saveDashboardDomainPlatformAdapters({ adapters: configured })
  const readBack = await window.visslm.getSettings()
  const duplicateError = await window.visslm.saveDashboardDomainPlatformAdapters({
    adapters: [selected, { ...selected, id: `${selected.id}-duplicate` }]
  }).then(() => '').catch((error) => String(error))
  const checks = {
    adapterLoadedInSettings: selected.id === 'visslm-project-overview-v1',
    adapterSaveReadBack: saved.dashboardDomainPlatformAdapters.some((adapter) => adapter.id === selected.id) &&
      readBack.dashboardDomainPlatformAdapters.some((adapter) => adapter.id === selected.id &&
        JSON.stringify(adapter.allowedProjectIds) === JSON.stringify(selected.allowedProjectIds) &&
        JSON.stringify(adapter.permissions) === JSON.stringify(selected.permissions)),
    duplicateAdapterRejected: /同一场景只能配置一个平台适配器|场景已存在平台适配器/.test(duplicateError)
  }
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    adapterCount: readBack.dashboardDomainPlatformAdapters.length,
    duplicateError
  }
}

const stopElectron = async (electron) => {
  if (!electron || electron.exitCode !== null) return
  if (process.platform === 'win32' && electron.pid) {
    await new Promise((resolvePromise) => {
      execFile('taskkill', ['/PID', String(electron.pid), '/T', '/F'], () => resolvePromise())
    })
  } else {
    electron.kill('SIGTERM')
  }
  await Promise.race([
    new Promise((resolvePromise) => electron.once('exit', resolvePromise)),
    sleep(5_000)
  ])
}

const run = async () => {
  const checks = {}
  let userDataDirectory
  let cdpPort
  let electron
  let cdp
  let fixture
  let contract
  let requirementsContract
  let planContract
  let qualityContract
  let testValidationContract
  let configurationChangeContract
  let gjb5000bComplianceContract
  let organizationImprovementContract
  let platformAdapterContract
  let adapterSettingsContract
  let failure
  let electronLogs = ''
  try {
    userDataDirectory = await mkdtemp(join(tmpdir(), 'visslm-dashboard-gjb5000b-electron-'))
    cdpPort = await reservePort()
    fixture = await seedDatabase(userDataDirectory)
    electron = spawn(electronPath, [
      '.',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDirectory}`,
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ], {
      cwd: repoRoot,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    electron.stdout?.on('data', (chunk) => { electronLogs += chunk.toString() })
    electron.stderr?.on('data', (chunk) => { electronLogs += chunk.toString() })
    cdp = await connectStableCdp(electron, cdpPort)
    contract = await evaluateRenderer(cdp, runDomainContract, 120_000)
    if (!contract || contract.ok !== true || !Object.values(contract.checks || {}).every(Boolean)) {
      throw new Error(`领域 Electron 合约失败：${JSON.stringify(contract)}`)
    }
    Object.assign(checks, contract.checks)
    requirementsContract = await evaluateRenderer(cdp, runRequirementsDeliveryContract, 120_000)
    if (!requirementsContract || requirementsContract.ok !== true ||
      !Object.values(requirementsContract.checks || {}).every(Boolean)) {
      throw new Error(`需求交付领域 Electron 合约失败：${JSON.stringify(requirementsContract)}`)
    }
    Object.assign(checks, requirementsContract.checks)
    planContract = await evaluateRenderer(cdp, runPlanMilestoneContract, 120_000)
    if (!planContract || planContract.ok !== true ||
      !Object.values(planContract.checks || {}).every(Boolean)) {
      throw new Error(`计划里程碑领域 Electron 合约失败：${JSON.stringify(planContract)}`)
    }
    Object.assign(checks, planContract.checks)
    qualityContract = await evaluateRenderer(cdp, runSoftwareQualityContract, 120_000)
    if (!qualityContract || qualityContract.ok !== true ||
      !Object.values(qualityContract.checks || {}).every(Boolean)) {
      throw new Error(`软件质量领域 Electron 合约失败：${JSON.stringify(qualityContract)}`)
    }
    Object.assign(checks, qualityContract.checks)
    testValidationContract = await evaluateRenderer(cdp, runTestValidationContract, 120_000)
    if (!testValidationContract || testValidationContract.ok !== true ||
      !Object.values(testValidationContract.checks || {}).every(Boolean)) {
      throw new Error(`测试验证领域 Electron 合约失败：${JSON.stringify(testValidationContract)}`)
    }
    Object.assign(checks, testValidationContract.checks)
    configurationChangeContract = await evaluateRenderer(cdp, runConfigurationChangeContract, 120_000)
    if (!configurationChangeContract || configurationChangeContract.ok !== true ||
      !Object.values(configurationChangeContract.checks || {}).every(Boolean)) {
      throw new Error(`配置与变更领域 Electron 合约失败：${JSON.stringify(configurationChangeContract)}`)
    }
    Object.assign(checks, configurationChangeContract.checks)
    gjb5000bComplianceContract = await evaluateRenderer(cdp, runGjb5000bComplianceContract, 120_000)
    if (!gjb5000bComplianceContract || gjb5000bComplianceContract.ok !== true ||
      !Object.values(gjb5000bComplianceContract.checks || {}).every(Boolean)) {
      throw new Error(`GJB5000B 过程证据领域 Electron 合约失败：${JSON.stringify(gjb5000bComplianceContract)}`)
    }
    Object.assign(checks, gjb5000bComplianceContract.checks)
    organizationImprovementContract = await evaluateRenderer(cdp, runOrganizationImprovementContract, 120_000)
    if (!organizationImprovementContract || organizationImprovementContract.ok !== true ||
      !Object.values(organizationImprovementContract.checks || {}).every(Boolean)) {
      throw new Error(`组织级度量领域 Electron 合约失败：${JSON.stringify(organizationImprovementContract)}`)
    }
    Object.assign(checks, organizationImprovementContract.checks)
    platformAdapterContract = await evaluateRenderer(cdp, runPlatformAdapterContract, 120_000)
    if (!platformAdapterContract || platformAdapterContract.ok !== true ||
      !Object.values(platformAdapterContract.checks || {}).every(Boolean)) {
      throw new Error(`平台适配器 Electron 合约失败：${JSON.stringify(platformAdapterContract)}`)
    }
    Object.assign(checks, platformAdapterContract.checks)
    adapterSettingsContract = await evaluateRenderer(cdp, runAdapterSettingsContract, 120_000)
    if (!adapterSettingsContract || adapterSettingsContract.ok !== true ||
      !Object.values(adapterSettingsContract.checks || {}).every(Boolean)) {
      throw new Error(`平台适配器设置 Electron 合约失败：${JSON.stringify(adapterSettingsContract)}`)
    }
    Object.assign(checks, adapterSettingsContract.checks)
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    try { cdp?.close() } catch { /* best effort */ }
    try { await stopElectron(electron) } catch { /* best effort */ }
    try {
      if (userDataDirectory) await rm(userDataDirectory, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
  const result = {
    ok: !failure,
    smoke: smokeName,
    fixture,
    checks,
    contract,
    requirementsContract,
    planContract,
    qualityContract,
    testValidationContract,
    configurationChangeContract,
    gjb5000bComplianceContract,
    organizationImprovementContract,
    platformAdapterContract,
    adapterSettingsContract,
    modelNetworkCallsObserved: contract?.rendererModelRequests?.length ?? 0,
    ...(failure ? { failure } : {}),
    ...(electronLogs ? { electronLogs: electronLogs.slice(-8_000) } : {})
  }
  console.log(JSON.stringify(result, null, 2))
  if (failure) process.exitCode = 1
}

await run()
