import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { AppDatabase } from '../src/main/database'
import {
  buildAgreementExtractionBatches,
  ProjectManagementService,
  resolveAgreementRequirementSource
} from '../src/main/project-management'
import { KnowledgeService, type KnowledgeRecordMatch } from '../src/main/knowledge'
import type {
  ManagedProject,
  ProjectAnalysisProgress,
  ProjectRequirement
} from '../src/shared/project-types'
import type { RequirementMatchCandidateResult } from '../src/main/requirements/requirement-match-domain'
import { normalizeProjectRequirementText } from '../src/shared/project-requirement-utils'
import { buildRequirementSourceView } from '../src/main/requirements/requirement-match-card'
import { RequirementMatchingCore } from '../src/main/requirements/requirement-matching-core'
import { hashProjectRequirementSnapshot } from '../src/main/requirements/requirement-match-run-service'

const directory = mkdtempSync(join(tmpdir(), 'visslm-project-management-'))
const db = new AppDatabase(join(directory, 'projects.db'), join(directory, 'assets'))
type SmokeSqlRow = Record<string, unknown>
const databaseHandle = db as unknown as {
  db: {
    prepare: (sql: string) => {
      get: (...params: unknown[]) => SmokeSqlRow | undefined
      all: (...params: unknown[]) => SmokeSqlRow[]
    }
  }
}
const retiredProjectTableNames = [
  'pm_project_trace_reviews',
  'pm_project_trace_decision_audits',
  'pm_project_trace_ai_runs',
  'pm_project_trace_ai_results',
  'pm_project_governance_acknowledgements'
]
const listRetiredProjectTables = (database: AppDatabase): string[] => {
  const handle = database as unknown as {
    db: { prepare: (sql: string) => { all: (...params: unknown[]) => SmokeSqlRow[] } }
  }
  return handle.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${retiredProjectTableNames.map(() => '?').join(', ')})
    ORDER BY name
  `).all(...retiredProjectTableNames).map((row) => String(row.name))
}

try {
  assert.deepEqual(listRetiredProjectTables(db), [], '新数据库初始化不得创建 Phase2–5 退役表')
  const sourceChunks = [
    { id: 'source-a', documentId: 'agreement-a', location: '协议 · 第 1 页', content: '项目应支持用户登录和权限配置。' },
    { id: 'source-b', documentId: 'agreement-a', location: '协议 · 第 2 页', content: '项目应支持跨系统接口同步和订单明细导出。' },
    { id: 'source-c', documentId: 'agreement-a', location: '协议 · 第 3 页', content: '项目应在验收前提供部署文档。' }
  ]
  const batchChunks = sourceChunks.map((chunk) => ({ ...chunk, content: `${chunk.content}${'x'.repeat(500)}` }))
  const batches = buildAgreementExtractionBatches(batchChunks, 1_300)
  assert.equal(batches.length, 2)
  assert.deepEqual(batches.flat().map((chunk) => chunk.id), sourceChunks.map((chunk) => chunk.id))
  const correctedSource = resolveAgreementRequirementSource({
    title: '接口同步',
    sourceChunkId: 'source-a',
    evidenceQuote: '支持跨系统接口同步',
    confidence: 0.9
  }, sourceChunks)
  assert.equal(correctedSource.status, 'corrected')
  assert.equal(correctedSource.sourceChunkId, 'source-b')
  assert.equal(correctedSource.sourceLocation, '协议 · 第 2 页')
  const inferredSource = resolveAgreementRequirementSource({
    title: '部署文档',
    content: '项目应在验收前提供部署文档。',
    sourceChunkId: 'source-c',
    confidence: 0.9
  }, sourceChunks)
  assert.equal(inferredSource.status, 'inferred')
  assert.equal(inferredSource.evidenceQuote, '项目应在验收前提供部署文档。')
  const fuzzySourceChunks = [{
    id: 'fuzzy-source',
    documentId: 'agreement-a',
    location: 'page-4',
    content: '系统必须在验收前提供完整的部署文档、安装手册和配置清单，并完成环境部署说明。'
  }]
  const recoveredFuzzySource = resolveAgreementRequirementSource({
    title: '部署文档',
    content: '系统须在验收前提供完整部署文档、安装手册和配置清单，并完成环境部署说明。',
    confidence: 0.9
  }, fuzzySourceChunks)
  assert.equal(recoveredFuzzySource.status, 'inferred')
  assert.equal(recoveredFuzzySource.sourceChunkId, 'fuzzy-source')
  assert.equal(recoveredFuzzySource.evidenceQuote, fuzzySourceChunks[0].content)
  const unverifiedSource = resolveAgreementRequirementSource({
    title: '无法回溯',
    content: '协议没有出现的需求',
    sourceChunkId: 'source-a',
    confidence: 0.9
  }, sourceChunks)
  assert.equal(unverifiedSource.status, 'unverified')
  assert.equal(unverifiedSource.sourceChunkId, '')
  assert.equal(unverifiedSource.confidence, 0.35)
  const ambiguousCrossDocumentSource = resolveAgreementRequirementSource({
    title: '跨文档同名原文',
    evidenceQuote: '项目应支持跨系统接口同步和订单明细导出。'
  }, [
    ...sourceChunks,
    { id: 'other-document', documentId: 'agreement-b', location: '另一协议 · 第 1 页', content: '项目应支持跨系统接口同步和订单明细导出。' }
  ])
  assert.equal(ambiguousCrossDocumentSource.status, 'unverified')

  const project = db.createManagedProject(randomUUID(), {
    projectName: '项目管理 Smoke',
    customerName: '示例客户',
    contractAmount: 1000,
    estimatedCost: 240,
    deliveryReminderDays: 7,
    estimatedDurationDays: 30
  })
  assert.equal(project.contractAmount, 1000)
  assert.equal(project.estimatedCost, 240)
  assert.equal(project.remainingQuota, 760)

  db.saveProjectAnalysisProgress({
    taskId: 'smoke-analysis-task',
    projectId: project.id,
    phase: 'queued',
    message: '已接收技术协议文件',
    detail: '文件：technical-agreement.txt',
    current: 0,
    total: 1,
    status: 'running'
  })
  db.saveProjectAnalysisProgress({
    taskId: 'smoke-analysis-task',
    projectId: project.id,
    phase: 'error',
    message: '需求抽取失败',
    detail: '协议附件关联已保留，可重试',
    current: 1,
    total: 1,
    status: 'failed'
  })
  db.saveProjectAnalysisProgress({
    taskId: 'smoke-analysis-task',
    projectId: project.id,
    phase: 'extracting',
    message: '模型请求完成：第 1/1 批',
    detail: '模型 ollama:smoke · 结束 stop',
    current: 0,
    total: 1,
    status: 'running',
    logKind: 'model_request',
    requestId: 'smoke-request-1',
    batchNumber: '1',
    attempt: 1,
    elapsedMs: 1234,
    inputChars: 4567,
    outputChars: 0,
    doneReason: 'stop',
    modelName: 'ollama:smoke'
  })
  const analysisLogs = db.listProjectAnalysisLogs(project.id)
  assert.equal(analysisLogs.length, 3)
  assert.equal(analysisLogs[0]?.logKind, 'model_request')
  assert.equal(analysisLogs[0]?.requestId, 'smoke-request-1')
  assert.equal(analysisLogs[0]?.elapsedMs, 1234)
  assert.equal(analysisLogs[0]?.inputChars, 4567)
  assert.equal(analysisLogs[0]?.outputChars, 0)
  assert.equal(analysisLogs[1]?.message, '需求抽取失败')
  assert.equal(analysisLogs[1]?.detail, '协议附件关联已保留，可重试')

  db.saveProjectAnalysisProgress({
    taskId: 'smoke-matching-task',
    projectId: project.id,
    phase: 'matching',
    message: '正在重新匹配：接口同步',
    detail: '补充信息词：接口同步',
    current: 0,
    total: 1,
    status: 'running'
  })
  db.saveProjectAnalysisProgress({
    taskId: 'smoke-matching-task',
    projectId: project.id,
    phase: 'done',
    message: '功能需求匹配完成',
    detail: '需求「接口同步」的匹配结果已保存',
    current: 1,
    total: 1,
    status: 'success'
  })
  const matchingLogs = db.listProjectAnalysisLogs(project.id).filter((log) => log.taskId === 'smoke-matching-task')
  assert.equal(matchingLogs.length, 2)
  assert(matchingLogs.every((log) => log.taskType === 'matching'))

  db.insertProjectCostEntry(project.id, {
    type: 'actual',
    category: '人力',
    description: '首期实际成本',
    amount: 80,
    occurredAt: '2026-07-31'
  })
  const afterCost = db.getManagedProject(project.id)
  assert(afterCost)
  assert.equal(afterCost.actualCost, 80)
  assert.equal(afterCost.remainingQuota, 760)

  const person = db.createOrganizationPerson({
    name: '项目管理测试人员',
    employeeNo: 'SMOKE-001',
    department: '研发中心',
    role: '工程师',
    hourlyRate: 50
  })
  const participant = db.insertProjectParticipant(project.id, {
    personId: person.id,
    startDate: '2026-08-01',
    endDate: '2026-08-03',
    notes: '项目初期投入'
  })
  assert.equal(participant.durationDays, 3)
  assert.equal(participant.estimatedCost, 1200)
  assert.equal(db.listProjectParticipants(project.id).length, 1)

  const responsibleCost = db.insertProjectCostEntry(project.id, {
    type: 'actual',
    category: '外协',
    description: '责任人关联验证',
    amount: 25,
    occurredAt: '2026-08-01',
    responsibleParticipantId: participant.id
  })
  assert.equal(responsibleCost.responsibleParticipantId, participant.id)
  assert.equal(responsibleCost.responsiblePersonName, person.name)
  assert.equal(db.listProjectCostEntries(project.id).find((entry) => entry.id === responsibleCost.id)?.responsiblePersonName, person.name)

  const planTask = db.insertProjectTask(project.id, {
    taskType: 'phase',
    title: '项目管理 Smoke 阶段任务',
    startDate: '2026-08-01',
    endDate: '2026-08-10',
    ownerPersonId: person.id,
    status: 'in_progress',
    progressPercent: 40
  })
  assert.equal(planTask.ownerName, person.name)
  const firstChildTask = db.insertProjectTask(project.id, {
    taskType: 'task',
    title: '项目管理 Smoke 子任务一',
    parentTaskId: planTask.id,
    startDate: '2026-08-05',
    endDate: '2026-08-15',
    status: 'in_progress',
    progressPercent: 20,
    sortOrder: 1
  })
  const parentAfterFirstChild = db.getProjectTask(planTask.id)
  assert(parentAfterFirstChild)
  assert.equal(parentAfterFirstChild.startDate, '2026-08-05')
  assert.equal(parentAfterFirstChild.endDate, '2026-08-15')
  assert.equal(parentAfterFirstChild.hasChildren, true)

  db.insertProjectTask(project.id, {
    taskType: 'task',
    title: '项目管理 Smoke 子任务二',
    parentTaskId: planTask.id,
    startDate: '2026-07-25',
    endDate: '2026-08-20',
    status: 'not_started',
    sortOrder: 2
  })
  const listedTasks = db.listProjectTasks(project.id)
  assert.equal(listedTasks.length, 3)
  assert.equal(listedTasks[0]?.id, planTask.id)
  assert.equal(listedTasks.find((task) => task.id === firstChildTask.id)?.depth, 1)
  const parentAfterSecondChild = db.getProjectTask(planTask.id)
  assert(parentAfterSecondChild)
  assert.equal(parentAfterSecondChild.startDate, '2026-07-25')
  assert.equal(parentAfterSecondChild.endDate, '2026-08-20')

  const movedToRoot = db.moveProjectTask(firstChildTask.id, { sortOrder: 0 })
  assert(movedToRoot)
  assert.equal(movedToRoot.parentTaskId, undefined)
  const movedBackToPhase = db.moveProjectTask(firstChildTask.id, { parentTaskId: planTask.id, sortOrder: 0 })
  assert(movedBackToPhase)
  assert.equal(movedBackToPhase.parentTaskId, planTask.id)
  assert.equal(db.listProjectTasks(project.id).find((task) => task.id === firstChildTask.id)?.depth, 1)

  const updatedChildTask = db.updateProjectTask(firstChildTask.id, {
    taskType: 'task',
    title: '项目管理 Smoke 子任务一（已编辑）',
    description: '验证列表编辑后的任务更新链路',
    parentTaskId: planTask.id,
    startDate: '2026-08-05',
    endDate: '2026-08-15',
    status: 'completed',
    progressPercent: 100,
    sortOrder: 1
  })
  assert(updatedChildTask)
  assert.equal(updatedChildTask.title, '项目管理 Smoke 子任务一（已编辑）')
  assert.equal(updatedChildTask.status, 'completed')
  assert.equal(updatedChildTask.progressPercent, 100)

  db.upsertRecord({
    uid: 'smoke-record-1',
    projectId: 'external-project',
    nodeType: 'Requirement',
    itemId: 'REQ-1',
    parentId: '',
    name: '订单查询能力',
    lastModifyTime: new Date().toISOString(),
    raw: { description: '订单查询能力' },
    normalizedText: '订单查询能力'
  })
  db.upsertRecord({
    uid: 'smoke-record-2',
    projectId: 'external-project',
    nodeType: 'Requirement',
    itemId: 'REQ-2',
    parentId: '',
    name: '库存同步能力',
    lastModifyTime: new Date().toISOString(),
    raw: { description: '库存同步能力' },
    normalizedText: '库存同步能力'
  })
  const asset = db.linkProjectAsset(project.id, 'smoke-record-1')
  assert(asset)
  assert.equal(db.listProjectAssets(project.id).length, 1)
  const availableAssetRecords = db.listRecords({ page: 1, pageSize: 20, excludeProjectAssetProjectId: project.id })
  assert.equal(availableAssetRecords.rows.some((row) => row.uid === 'smoke-record-1'), false)

  const document = db.insertKnowledgeDocument({
    id: randomUUID(),
    fileName: 'technical-agreement.txt',
    filePath: join(directory, 'technical-agreement.txt'),
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 20,
    sha256: randomUUID()
  })
  const readyDocument = db.updateKnowledgeDocument(document.id, {
    status: 'ready',
    chunkCount: 0,
    modelVersion: 'smoke',
    processedAt: new Date().toISOString()
  })
  assert(readyDocument)
  db.linkProjectDocument(project.id, document.id)
  const linkedProject = db.getManagedProject(project.id)
  assert(linkedProject)
  assert.equal(linkedProject.currentDocumentId, document.id)
  assert.equal(linkedProject.currentDocumentName, document.fileName)
  assert.equal(linkedProject.documentCount, 1)
  const knowledgeService = new KnowledgeService(db)
  const referencedDocumentDelete = knowledgeService.deleteDocument(document.id)
  assert.equal(referencedDocumentDelete.ok, false, '被项目引用的知识文档不得删除')
  assert.equal(db.getKnowledgeDocument(document.id)?.id, document.id)
  const orphanDocument = db.insertKnowledgeDocument({
    id: randomUUID(),
    fileName: 'unreferenced-document.txt',
    filePath: join(directory, 'unreferenced-document.txt'),
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 18,
    sha256: randomUUID()
  })
  const orphanDocumentDelete = knowledgeService.deleteDocument(orphanDocument.id)
  assert.equal(orphanDocumentDelete.ok, true, '未被项目引用的知识文档应可删除')
  assert.equal(db.getKnowledgeDocument(orphanDocument.id), null)

  let semanticCandidates: KnowledgeRecordMatch[] = []
  const semanticMatchQueries: string[] = []
  const fakeKnowledge = {
    processFiles: async () => ({
      ok: true,
      acceptedCount: 1,
      reusedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      documents: [readyDocument],
      skipped: [],
      message: 'Smoke 协议已保存'
    }),
    rankRecordMatches: async (query: string) => {
      semanticMatchQueries.push(query)
      return semanticCandidates
    }
  } as unknown as KnowledgeService
  const matchingCore = new RequirementMatchingCore({
    retriever: {
      async retrieve(base) {
        semanticMatchQueries.push(base.matchingText)
        return semanticCandidates.flatMap((match) => {
          const record = db.getRecord(match.recordUid, false)
          if (!record) return []
          return [{
            record,
            card: buildRequirementSourceView(record),
            denseScore: match.score,
            lexicalScore: 0,
            retrievalScore: match.score,
            snippet: match.snippet
          }]
        })
      }
    },
    reranker: {
      modelId: 'project-smoke-reranker',
      async rerank(_base, candidates) {
        return candidates.map((candidate) => ({
          recordUid: candidate.record.uid,
          score: candidate.denseScore
        }))
      }
    },
    async exactBusinessHashCandidates() { return [] },
    candidateEligible() { return true }
  })
  const service = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke',
      thinking: false
    }),
    undefined,
    undefined,
    matchingCore
  )
  const editableCostProject = service.createProject({
    projectName: '预计成本编辑 Smoke',
    customerName: '成本编辑客户',
    contractAmount: 10_000,
    estimatedCost: 240,
    estimatedDurationDays: 12
  })
  const initialBaseCostEntries = db.listProjectCostEntries(editableCostProject.id)
    .filter((entry) => entry.type === 'estimated' && entry.category === '项目预估')
  assert.equal(initialBaseCostEntries.length, 1)
  const updatedCostProject = service.updateProject(editableCostProject.id, {
    projectName: editableCostProject.projectName,
    customerName: editableCostProject.customerName,
    contractAmount: editableCostProject.contractAmount,
    riskFactor: editableCostProject.riskFactor,
    deliveryReminderDays: editableCostProject.deliveryReminderDays,
    plannedDeliveryDate: editableCostProject.plannedDeliveryDate,
    salesOwner: editableCostProject.salesOwner,
    technicalOwner: editableCostProject.technicalOwner,
    developmentOwner: editableCostProject.developmentOwner,
    estimatedCost: 360,
    estimatedDurationDays: editableCostProject.estimatedDurationDays
  })
  assert(updatedCostProject)
  assert.equal(updatedCostProject.estimatedCost, 360, '编辑项目预计成本后项目汇总应立即生效')
  const updatedBaseCostEntries = db.listProjectCostEntries(editableCostProject.id)
    .filter((entry) => entry.type === 'estimated' && entry.category === '项目预估')
  assert.equal(updatedBaseCostEntries.length, 1, '编辑预计成本不得新增重复的基础预估台账')
  assert.equal(updatedBaseCostEntries[0]?.id, initialBaseCostEntries[0]?.id)
  assert.equal(updatedBaseCostEntries[0]?.amount, 360)
  db.insertProjectParticipant(editableCostProject.id, {
    personId: person.id,
    startDate: '2026-08-01',
    endDate: '2026-08-01'
  })
  db.insertProjectCostEntry(editableCostProject.id, {
    type: 'estimated',
    category: '采购',
    description: '固定采购预估',
    amount: 50,
    occurredAt: '2026-08-01'
  })
  const costProjectWithDerivedItems = db.getManagedProject(editableCostProject.id)
  assert(costProjectWithDerivedItems)
  const targetTotalEstimatedCost = 900
  const updateCostTotal = (): ManagedProject | null => service.updateProject(editableCostProject.id, {
    projectName: costProjectWithDerivedItems.projectName,
    customerName: costProjectWithDerivedItems.customerName,
    contractAmount: costProjectWithDerivedItems.contractAmount,
    riskFactor: costProjectWithDerivedItems.riskFactor,
    deliveryReminderDays: costProjectWithDerivedItems.deliveryReminderDays,
    plannedDeliveryDate: costProjectWithDerivedItems.plannedDeliveryDate,
    salesOwner: costProjectWithDerivedItems.salesOwner,
    technicalOwner: costProjectWithDerivedItems.technicalOwner,
    developmentOwner: costProjectWithDerivedItems.developmentOwner,
    estimatedCost: targetTotalEstimatedCost,
    estimatedDurationDays: costProjectWithDerivedItems.estimatedDurationDays
  })
  assert.equal(updateCostTotal()?.estimatedCost, targetTotalEstimatedCost)
  assert.equal(updateCostTotal()?.estimatedCost, targetTotalEstimatedCost, '重复保存预计成本总额必须幂等')
  const idempotentBaseEntries = db.listProjectCostEntries(editableCostProject.id)
    .filter((entry) => entry.type === 'estimated' && entry.category === '项目预估')
  assert.equal(idempotentBaseEntries.length, 1)
  assert.equal(idempotentBaseEntries[0]?.amount, 450, '基础预估应扣除人力与其他固定预计项')
  assert.equal(service.deleteProject(editableCostProject.id).ok, true)
  const seedReviewRequirement = (
    projectId: string,
    requirementId: string,
    title: string,
    content = title
  ): ProjectRequirement => {
    const set = db.createProjectRequirementSet({
      projectId,
      documentId: document.id,
      totalChunks: 1,
      analyzedChunks: 1,
      warnings: [],
      externalProcessing: false,
      modelName: 'ollama:smoke'
    })
    db.replaceReviewProjectRequirements(set.id, projectId, document.id, [{
      id: requirementId,
      requirementNo: 1,
      category: 'functional',
      module: 'Smoke',
      title,
      content,
      keyInfoTerms: [title],
      sourceLocation: 'Smoke',
      sourceChunkId: `source-${requirementId}`,
      evidenceQuote: content,
      confidence: 0.9
    }])
    const requirement = db.getProjectRequirement(requirementId)
    assert(requirement)
    return requirement
  }
  const publishSeededRequirement = (
    projectId: string,
    requirementId: string,
    title: string,
    content = title
  ): ProjectRequirement => {
    const requirement = seedReviewRequirement(projectId, requirementId, title, content)
    assert.equal(db.reviewProjectRequirements([requirementId], 'approved'), 1)
    const publishedSet = db.publishReviewProjectRequirementSet(projectId)
    assert.equal(publishedSet.status, 'published')
    return db.getProjectRequirement(requirementId) as ProjectRequirement
  }
  const originalFetch = globalThis.fetch
  const extractBatch = (service as unknown as {
    extractAgreementBatch: (
      chunks: typeof sourceChunks,
      batchNumber: string,
      batchCount: number,
      onEvent?: (message: string, detail?: string, metadata?: Partial<ProjectAnalysisProgress>) => void
    ) => Promise<unknown>
  }).extractAgreementBatch
  let extractionModelCalls = 0
  let extractionSystemPrompt = ''
  let extractionTemperature: unknown
  const extractionEvents: Array<{ message: string; detail?: string; metadata?: Partial<ProjectAnalysisProgress> }> = []
  globalThis.fetch = async (_input, init) => {
    extractionModelCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      messages?: Array<{ role?: string; content?: string }>
      options?: { temperature?: unknown }
    }
    extractionSystemPrompt ||= body.messages?.find((message) => message.role === 'system')?.content ?? ''
    extractionTemperature ??= body.options?.temperature
    const content = extractionModelCalls === 1
      ? '{"project":'
      : '{"project":{},"requirements":[]}'
    return new Response(JSON.stringify({
      done_reason: extractionModelCalls === 1 ? 'length' : 'stop',
      message: { role: 'assistant', content }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await extractBatch.call(service, sourceChunks.slice(0, 2), '1', 1, (message, detail, metadata) => {
      extractionEvents.push({ message, detail, metadata })
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(extractionModelCalls, 3)
  const modelRequestEvents = extractionEvents.filter((event) => event.metadata?.logKind === 'model_request')
  assert.equal(modelRequestEvents.length, 3)
  assert.equal(modelRequestEvents[0]?.metadata?.doneReason, 'length')
  assert.equal(modelRequestEvents[0]?.metadata?.status, 'success')
  assert.equal(modelRequestEvents[0]?.metadata?.batchNumber, '1')
  assert.equal(modelRequestEvents[0]?.metadata?.elapsedMs !== undefined, true)
  assert.match(extractionSystemPrompt, /未出现的字段不要输出/)
  assert.match(extractionSystemPrompt, /content 使用简洁需求句，最多 120 字/)
  assert.match(extractionSystemPrompt, /不得因此省略或合并可靠需求/)
  assert.doesNotMatch(extractionSystemPrompt, /"contractAmount":0/)
  assert.doesNotMatch(extractionSystemPrompt, /"sourceLocation"/)
  assert.equal(extractionTemperature, 0)
  let compactRecoveryCalls = 0
  globalThis.fetch = async (_input, init) => {
    compactRecoveryCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role?: string; content?: string }> }
    const system = body.messages?.find((message) => message.role === 'system')?.content ?? ''
    const compact = system.includes('紧凑恢复')
    return new Response(JSON.stringify({
      done_reason: compact ? 'stop' : 'length',
      message: {
        role: 'assistant',
        content: compact
          ? '{"project":{},"requirements":[{"category":"functional","module":"登录","title":"用户登录","content":"项目应支持用户登录。","keyInfoTerms":["用户登录"],"sourceChunkId":"source-a","evidenceQuote":"项目应支持用户登录","confidence":0.9}]}'
          : '{"project":'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const recovered = await extractBatch.call(service, [sourceChunks[0]], 'compact-recovery', 1)
    assert.equal(compactRecoveryCalls, 2)
    assert.equal((recovered as { requirements?: Array<{ sourceChunkId?: string }> }).requirements?.[0]?.sourceChunkId, 'source-a')
  } finally {
    globalThis.fetch = originalFetch
  }
  const deepSeekService = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'online',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      model: 'deepseek-v4-flash-0731',
      thinking: true,
      apiKey: 'project-management-deepseek-smoke-key'
    }),
    undefined,
    undefined,
    matchingCore
  )
  const deepSeekRequests: Array<Record<string, unknown>> = []
  const deepSeekEvents: Array<{ message: string; detail?: string; metadata?: Partial<ProjectAnalysisProgress> }> = []
  let deepSeekCalls = 0
  globalThis.fetch = async (_input, init) => {
    deepSeekCalls += 1
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    deepSeekRequests.push(body)
    const messages = Array.isArray(body.messages)
      ? body.messages as Array<{ role?: string; content?: string }>
      : []
    const compact = messages.some((message) => message.role === 'system' && message.content?.includes('紧凑恢复'))
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: compact ? 'stop' : 'length',
        message: {
          role: 'assistant',
          content: compact
            ? '{"project":{},"requirements":[{"category":"functional","module":"登录","title":"用户登录","content":"项目应支持用户登录。","keyInfoTerms":["用户登录"],"sourceChunkId":"source-a","evidenceQuote":"项目应支持用户登录","confidence":0.9}]}'
            : ''
        }
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const recovered = await extractBatch.call(deepSeekService, [sourceChunks[0]], 'deepseek-empty-length', 1, (message, detail, metadata) => {
      deepSeekEvents.push({ message, detail, metadata })
    })
    assert.equal(deepSeekCalls, 2, 'empty length output must trigger exactly one compact recovery request')
    assert.equal(deepSeekRequests.length, 2)
    assert(deepSeekRequests.every((body) => {
      const thinking = body.thinking as { type?: unknown } | undefined
      return thinking?.type === 'disabled'
    }), 'OpenAI-compatible DeepSeek requests must disable thinking explicitly')
    assert.equal((recovered as { requirements?: Array<{ sourceChunkId?: string }> }).requirements?.[0]?.sourceChunkId, 'source-a')
    assert.equal(deepSeekEvents[0]?.metadata?.doneReason, 'length')
    assert.equal(deepSeekEvents[0]?.metadata?.outputChars, 0)
    assert.equal(deepSeekEvents[0]?.metadata?.status, 'success')
    assert.match(deepSeekEvents[1]?.message ?? '', /紧凑恢复/)
    assert.equal(deepSeekEvents[2]?.metadata?.doneReason, 'stop')
  } finally {
    globalThis.fetch = originalFetch
  }
  const openAiReasoningService = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'online',
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      model: 'o3-mini',
      thinking: true,
      apiKey: 'project-management-openai-smoke-key'
    }),
    undefined,
    undefined,
    matchingCore
  )
  let openAiReasoningRequest: Record<string, unknown> | undefined
  globalThis.fetch = async (_input, init) => {
    openAiReasoningRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"project":{},"requirements":[]}' } }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await extractBatch.call(openAiReasoningService, [sourceChunks[0]], 'openai-reasoning', 1)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert(openAiReasoningRequest)
  assert.equal(openAiReasoningRequest.reasoning_effort, 'none', 'technical agreement extraction must keep OpenAI reasoning disabled')
  assert.equal('thinking' in openAiReasoningRequest, false, 'true OpenAI reasoning models must retain their native reasoning transport')
  assert.equal(openAiReasoningRequest.temperature, undefined)
  assert.equal(typeof openAiReasoningRequest.max_completion_tokens, 'number')
  assert.equal('max_tokens' in openAiReasoningRequest, false)
  const concurrentChunks = Array.from({ length: 3 }, (_, index) => ({
    id: `concurrent-${index + 1}`,
    documentId: 'agreement-concurrent',
    location: `协议 · 并发测试 ${index + 1}`,
    content: `第${index + 1}批${'需求内容'.repeat(400)}`
  }))
  let activeModelCalls = 0
  let maxActiveModelCalls = 0
  let concurrentModelCalls = 0
  const concurrentCheckpoints: number[] = []
  globalThis.fetch = async (_input, _init) => {
    concurrentModelCalls += 1
    activeModelCalls += 1
    maxActiveModelCalls = Math.max(maxActiveModelCalls, activeModelCalls)
    await new Promise((resolve) => setTimeout(resolve, 20))
    activeModelCalls -= 1
    return new Response(JSON.stringify({
      done_reason: 'stop',
      message: { role: 'assistant', content: '{"project":{},"requirements":[]}' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const extractAgreement = (service as unknown as {
      extractAgreement: (
        chunks: typeof concurrentChunks,
        onProgress?: (current: number, total: number, message?: string, detail?: string, metadata?: Partial<ProjectAnalysisProgress>) => void,
        onCheckpoint?: (agreement: unknown, warnings: string[], analyzedChunks: number) => void
      ) => Promise<{ analyzedChunks: number }>
    }).extractAgreement
    const extraction = await extractAgreement.call(service, concurrentChunks, undefined, (_agreement, _warnings, analyzedChunks) => {
      concurrentCheckpoints.push(analyzedChunks)
    })
    assert.equal(concurrentModelCalls, 3)
    assert.equal(maxActiveModelCalls, 2)
    assert.deepEqual(concurrentCheckpoints, [1, 2, 3])
    assert.equal(extraction.analyzedChunks, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
  const failedAnalysis = await service.startTechnicalAgreement(join(directory, 'uploaded-agreement.txt'))
  assert.equal(failedAnalysis.ok, true)
  assert(failedAnalysis.projectId)
  let failedProject: ReturnType<AppDatabase['getManagedProject']> = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    failedProject = db.getManagedProject(failedAnalysis.projectId)
    if (failedProject?.analysisStatus === 'failed') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert(failedProject)
  assert.equal(failedProject.analysisStatus, 'failed')
  assert.equal(failedProject.currentDocumentId, document.id)
  assert.equal(failedProject.currentDocumentName, document.fileName)
  assert.equal(failedProject.documentCount, 1)
  assert(db.listProjectAnalysisLogs(failedAnalysis.projectId).some((log) => log.phase === 'error' && log.status === 'failed'))

  db.replaceProjectRequirements(project.id, document.id, [
    {
      id: 'smoke-requirement-1',
      requirementNo: 1,
      module: '订单管理',
      title: '订单查询',
      content: '支持按订单号查询订单详情',
      sourceLocation: '第 1 页',
      sourceChunkId: 'chunk-1'
    },
    {
      id: 'smoke-requirement-2',
      requirementNo: 2,
      module: '库存管理',
      title: '库存同步',
      content: '支持库存同步',
      sourceLocation: '第 2 页',
      sourceChunkId: 'chunk-2'
    }
  ])
  const updatedPlanTaskWithRequirement = db.updateProjectTask(planTask.id, {
    taskType: 'phase',
    title: planTask.title,
    description: planTask.description,
    startDate: planTask.startDate,
    endDate: planTask.endDate,
    ownerPersonId: person.id,
    status: planTask.status,
    progressPercent: planTask.progressPercent,
    sortOrder: planTask.sortOrder,
    requirementIds: ['smoke-requirement-1']
  })
  assert(updatedPlanTaskWithRequirement)
  assert.deepEqual(updatedPlanTaskWithRequirement.requirements.map((item) => item.requirementId), ['smoke-requirement-1'])
  const requirementTask = db.insertProjectTask(project.id, {
    taskType: 'task',
    title: '需求关联 Smoke 任务',
    startDate: '2026-08-11',
    endDate: '2026-08-14',
    requirementIds: ['smoke-requirement-1', 'smoke-requirement-2']
  })
  assert.deepEqual(requirementTask.requirements.map((item) => item.requirementId), ['smoke-requirement-1', 'smoke-requirement-2'])
  const replacedRequirementTask = db.updateProjectTask(requirementTask.id, {
    taskType: requirementTask.taskType,
    title: requirementTask.title,
    startDate: requirementTask.startDate,
    endDate: requirementTask.endDate,
    status: requirementTask.status,
    progressPercent: requirementTask.progressPercent,
    sortOrder: requirementTask.sortOrder,
    requirementIds: ['smoke-requirement-2']
  })
  assert(replacedRequirementTask)
  assert.deepEqual(replacedRequirementTask.requirements.map((item) => item.requirementId), ['smoke-requirement-2'])
  const normalizedRequirement = normalizeProjectRequirementText({
    title: '2.1 整体要求 支持按订单号查询订单详情',
    content: '支持按订单号查询订单详情'
  })
  assert.equal(normalizedRequirement.module, '2.1 整体要求')
  assert.equal(normalizedRequirement.title, '支持按订单号查询订单详情')
  const initialRequirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(initialRequirementPage.rows[0]?.status, 'unmarked')
  const requirementBeforeSemanticMatching = db.getProjectRequirement('smoke-requirement-1')
  assert(requirementBeforeSemanticMatching)
  semanticCandidates = [
    {
      recordUid: 'smoke-record-2',
      recordName: '库存同步能力',
      nodeType: 'record',
      itemId: 'smoke-record-2',
      score: 80,
      chunkId: 'chunk-record-2',
      snippet: '库存同步能力'
    },
    {
      recordUid: 'smoke-record-1',
      recordName: '订单查询能力',
      nodeType: 'record',
      itemId: 'smoke-record-1',
      score: 79,
      chunkId: 'chunk-record-1',
      snippet: '订单查询能力'
    }
  ]
  const originalMatchingFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    done_reason: 'stop',
    message: {
      role: 'assistant',
      content: '{"status":"unmarked","reason":"测试","matches":[]}'
    }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const startedRequirementMatching = service.startRequirementMatching('smoke-requirement-1')
    assert.equal(startedRequirementMatching.ok, true)
    for (let attempt = 0; attempt < 50 && db.getManagedProject(project.id)?.matchStatus === 'processing'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  } finally {
    globalThis.fetch = originalMatchingFetch
  }
  const assetsAfterSemanticMatching = db.listProjectAssets(project.id)
  assert.equal(assetsAfterSemanticMatching.some((item) => item.recordUid === 'smoke-record-2'), false)
  assert.equal(assetsAfterSemanticMatching.find((item) => item.recordUid === 'smoke-record-1')?.requirements.some((item) => item.requirementId === 'smoke-requirement-1'), false)
  const requirementAfterSemanticMatching = db.getProjectRequirement('smoke-requirement-1')
  assert.equal(requirementAfterSemanticMatching?.status, requirementBeforeSemanticMatching.status)
  assert.equal(requirementAfterSemanticMatching?.statusSource, requirementBeforeSemanticMatching.statusSource)
  const automaticLegacyMatches = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 })
  assert.equal(automaticLegacyMatches.total, 0, 'new matching runs must not write the legacy replacement table')
  const latestRun = db.getLatestCompatibleRequirementMatchRun({
    requirementId: 'smoke-requirement-1',
    requirementSnapshotHash: hashProjectRequirementSnapshot(requirementAfterSemanticMatching!)
  })
  assert(latestRun)
  const automaticMatches = db.listRequirementMatchCandidates({ runId: latestRun.id, page: 1, pageSize: 20 })
  assert.equal(automaticMatches.total, 1, 'hard-conflict candidates must be excluded from the default suggestion list')
  assert.equal(automaticMatches.rows[0]?.recordUid, 'smoke-record-1')

  const cancellationProject = db.createManagedProject(randomUUID(), {
    projectName: '匹配停止 Smoke'
  })
  db.replaceProjectRequirements(cancellationProject.id, document.id, [
    {
      id: 'cancellation-requirement-1',
      requirementNo: 1,
      module: '停止验证',
      title: '长耗时匹配',
      content: '验证匹配任务可以在安全点停止',
      sourceLocation: 'Smoke',
      sourceChunkId: 'cancellation-chunk-1'
    },
    {
      id: 'cancellation-requirement-2',
      requirementNo: 2,
      module: '停止验证',
      title: '正在停止的需求',
      content: '停止请求在本条需求的安全点生效',
      sourceLocation: 'Smoke',
      sourceChunkId: 'cancellation-chunk-2'
    },
    {
      id: 'cancellation-requirement-3',
      requirementNo: 3,
      module: '停止验证',
      title: '不应继续执行',
      content: '停止后不应执行第三条需求',
      sourceLocation: 'Smoke',
      sourceChunkId: 'cancellation-chunk-3'
    }
  ])
  let releaseCancellationMatch: (() => void) | undefined
  let markCancellationMatchStarted: (() => void) | undefined
  const cancellationMatchStarted = new Promise<void>((resolve) => { markCancellationMatchStarted = resolve })
  const cancellationMatchRelease = new Promise<void>((resolve) => { releaseCancellationMatch = resolve })
  let cancellationRetrieveCount = 0
  const cancellationProgress: ProjectAnalysisProgress[] = []
  let cancellationFailureCode = ''
  const originalFailRequirementMatchRun = db.failRequirementMatchRun.bind(db)
  db.failRequirementMatchRun = (runId: string, failureCode: string): void => {
    cancellationFailureCode = failureCode
    originalFailRequirementMatchRun(runId, failureCode)
  }
  const cancellationCore = new RequirementMatchingCore({
    retriever: {
      async retrieve() {
        cancellationRetrieveCount += 1
        if (cancellationRetrieveCount === 1) return []
        markCancellationMatchStarted?.()
        await cancellationMatchRelease
        return []
      }
    },
    reranker: {
      modelId: 'project-cancellation-smoke-reranker',
      async rerank() { return [] }
    },
    async exactBusinessHashCandidates() { return [] },
    candidateEligible() { return true }
  })
  const cancellationService = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke',
      thinking: false
    }),
    (progress) => cancellationProgress.push(progress),
    undefined,
    cancellationCore
  )
  const cancellationStart = cancellationService.startMatching(cancellationProject.id)
  assert.equal(cancellationStart.ok, true)
  await cancellationMatchStarted
  const cancellationStop = cancellationService.stopMatching(cancellationProject.id)
  assert.equal(cancellationStop.ok, true)
  assert.match(cancellationStop.message, /停止请求已提交/)
  releaseCancellationMatch?.()
  for (let attempt = 0; attempt < 50 && db.getManagedProject(cancellationProject.id)?.matchStatus === 'processing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const cancelledProject = db.getManagedProject(cancellationProject.id)
  assert(cancelledProject)
  assert.equal(cancelledProject.matchStatus, 'stale')
  assert.match(cancelledProject.matchMessage, /已完成 1\/3 条需求/)
  assert.equal(cancellationRetrieveCount, 2, 'stop must prevent the requirement after the active one from starting')
  assert(cancellationProgress.some((entry) => entry.status === 'cancelled'))
  const preservedRun = db.getLatestCompatibleRequirementMatchRun({
    requirementId: 'cancellation-requirement-1',
    requirementSnapshotHash: hashProjectRequirementSnapshot(db.getProjectRequirement('cancellation-requirement-1')!)
  })
  assert.equal(preservedRun?.status, 'succeeded', 'completed requirement results must remain available after stopping')
  assert.equal(db.getLatestCompatibleRequirementMatchRun({
    requirementId: 'cancellation-requirement-3',
    requirementSnapshotHash: hashProjectRequirementSnapshot(db.getProjectRequirement('cancellation-requirement-3')!)
  }), null, 'requirements after the stop boundary must not start')
  assert.equal(cancellationFailureCode, 'MATCH_CANCELLED')
  db.failRequirementMatchRun = originalFailRequirementMatchRun
  assert.equal(cancellationService.stopMatching(cancellationProject.id).ok, false)
  db.replaceRequirementMatches('smoke-requirement-1', [
    {
      recordUid: 'smoke-record-1',
      vectorScore: 92,
      aiScore: 95,
      finalScore: 95,
      scoreSource: 'ai',
      reason: '功能名称和内容均直接对应',
      bestChunkId: 'chunk-record-1'
    },
    {
      recordUid: 'smoke-record-2',
      vectorScore: 40,
      finalScore: 40,
      scoreSource: 'vector',
      reason: '',
      bestChunkId: 'chunk-record-2'
    }
  ])
  db.updateProjectRequirementAiStatus('smoke-requirement-1', 'satisfied', '已有数据中心能力')
  db.updateProjectRequirementStatus('smoke-requirement-2', 'to_develop')
  const satisfiedRequirements = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20, status: 'satisfied' })
  assert.equal(satisfiedRequirements.total, 1)
  assert.equal(satisfiedRequirements.rows[0]?.id, 'smoke-requirement-1')
  const toDevelopRequirements = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20, status: 'to_develop' })
  assert.equal(toDevelopRequirements.total, 1)
  assert.equal(toDevelopRequirements.rows[0]?.id, 'smoke-requirement-2')
  const unmarkedRequirements = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20, status: 'unmarked' })
  assert.equal(unmarkedRequirements.total, 0)
  db.updateProjectRequirementStatus('smoke-requirement-2', 'to_negotiate')
  const toNegotiateRequirements = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20, status: 'to_negotiate' })
  assert.equal(toNegotiateRequirements.total, 1)
  assert.equal(toNegotiateRequirements.rows[0]?.id, 'smoke-requirement-2')
  db.updateProjectRequirementStatus('smoke-requirement-2', 'to_develop')

  const matchPage = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 1 })
  assert.equal(matchPage.total, 2)
  assert.equal(matchPage.rows[0]?.recordUid, 'smoke-record-1')
  assert.equal(matchPage.rows[0]?.finalScore, 95)
  const thresholdMatchPage = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20, minScore: 40 })
  assert.equal(thresholdMatchPage.total, 1)
  assert.equal(thresholdMatchPage.rows[0]?.recordUid, 'smoke-record-1')
  const serviceMatchPage = service.listMatches({ requirementId: 'smoke-requirement-1', runId: latestRun.id, page: 1, pageSize: 20 })
  assert.equal(serviceMatchPage.total, 1)
  assert.equal(serviceMatchPage.rows[0]?.finalRank, 1)
  assert.equal(typeof serviceMatchPage.rows[0]?.rankingScore, 'number')
  const linkedAssetWithRequirement = db.linkProjectAsset(project.id, 'smoke-record-1', 'smoke-requirement-1')
  assert(linkedAssetWithRequirement)
  assert.equal(linkedAssetWithRequirement.requirements[0]?.requirementId, 'smoke-requirement-1')
  assert.equal(linkedAssetWithRequirement.requirements[0]?.title, '订单查询')
  assert.equal(linkedAssetWithRequirement.requirements[0]?.matchScore, 95)
  const linkedAssetWithSecondRequirement = db.linkProjectAsset(project.id, 'smoke-record-1', 'smoke-requirement-2')
  assert(linkedAssetWithSecondRequirement)
  assert.equal(linkedAssetWithSecondRequirement.requirements.length, 2)
  const linkedMatchPage = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 })
  assert.equal(linkedMatchPage.rows[0]?.assetLinked, true)
  assert.equal(linkedMatchPage.rows[0]?.requirementLinked, true)
  const unlinkedRequirementAsset = db.unlinkProjectAssetRequirement(project.id, 'smoke-record-1', 'smoke-requirement-1')
  assert.equal(unlinkedRequirementAsset.ok, true)
  const assetsAfterRequirementUnlink = db.listProjectAssets(project.id)
  assert.equal(assetsAfterRequirementUnlink.some((item) => item.recordUid === 'smoke-record-1'), true, '解除单个需求关联不得删除项目资产')
  assert.deepEqual(
    assetsAfterRequirementUnlink.find((item) => item.recordUid === 'smoke-record-1')?.requirements.map((item) => item.requirementId),
    ['smoke-requirement-2'],
    '解除单个需求关联应保留同一资产与其他需求的关联'
  )
  const availableAssetRecordsAfterUnlink = db.listRecords({ page: 1, pageSize: 20, excludeProjectAssetProjectId: project.id })
  assert.equal(availableAssetRecordsAfterUnlink.rows.some((row) => row.uid === 'smoke-record-1'), false, '仍有关联需求的资产不应回到可选列表')
  const unlinkedMatchPage = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 })
  assert.equal(unlinkedMatchPage.rows[0]?.assetLinked, true, '资产仍被其他需求关联时，候选记录仍应显示资产已关联')
  assert.equal(unlinkedMatchPage.rows[0]?.requirementLinked, false)
  const relinkedRequirementAsset = db.linkProjectAsset(project.id, 'smoke-record-1', 'smoke-requirement-1')
  assert(relinkedRequirementAsset)
  assert.equal(relinkedRequirementAsset.requirements.length, 2)
  const relinkedAssetWithSecondRequirement = db.linkProjectAsset(project.id, 'smoke-record-1', 'smoke-requirement-2')
  assert(relinkedAssetWithSecondRequirement)
  assert.equal(relinkedAssetWithSecondRequirement.requirements.length, 2)
  const requirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(requirementPage.total, 2)
  assert.equal(requirementPage.rows[0]?.module, '订单管理')
  assert.equal(requirementPage.rows[0]?.status, 'satisfied')
  assert.equal(requirementPage.rows[1]?.statusSource, 'manual')

  const deleteRequirementResult = db.deleteProjectRequirement('smoke-requirement-1')
  assert.equal(deleteRequirementResult.ok, true)
  assert.equal(db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 }).total, 0)
  assert.equal(db.listProjectAssets(project.id).find((asset) => asset.recordUid === 'smoke-record-1')?.requirements.length, 1)
  assert.equal(db.listProjectAssets(project.id).find((asset) => asset.recordUid === 'smoke-record-1')?.requirements[0]?.requirementId, 'smoke-requirement-2')
  assert.equal(db.getProjectTask(planTask.id)?.requirements.length, 0)
  assert.equal(db.getProjectTask(requirementTask.id)?.requirements[0]?.title, '库存同步')
  const remainingRequirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(remainingRequirementPage.total, 1)
  assert.equal(remainingRequirementPage.rows[0]?.id, 'smoke-requirement-2')

  const snapshot = db.exportManagedProjectSnapshot(project.id)
  assert(snapshot)
  assert.equal(snapshot.format, 'visslm-project')
  assert.equal(snapshot.version, 1, '默认快照格式仍保留 v1 兼容性')
  assert.equal(snapshot.project.baseEstimatedCost, 240)
  assert.equal(snapshot.participants.length, 1)
  assert.equal(snapshot.tasks.length, 4)
  assert.equal(snapshot.requirements.length, 1)
  const imported = db.importManagedProjectSnapshot(snapshot)
  assert(imported.projectId)
  assert.notEqual(imported.projectId, project.id)
  const importedProject = db.getManagedProject(imported.projectId)
  assert(importedProject)
  assert.equal(importedProject.projectName, project.projectName)
  assert.equal(importedProject.estimatedCost, 1440)
  assert.equal(importedProject.actualCost, 105)
  assert.equal(db.listProjectParticipants(imported.projectId).length, 1)
  assert.equal(db.listProjectTasks(imported.projectId).length, 4)
  assert.equal(db.listProjectRequirements({ projectId: imported.projectId, page: 1, pageSize: 20 }).total, 1)
  const importedRequirementTask = db.listProjectTasks(imported.projectId).find((task) => task.title === requirementTask.title)
  assert(importedRequirementTask)
  assert.equal(importedRequirementTask.requirements.length, 1)
  assert.equal(importedRequirementTask.requirements[0]?.title, '库存同步')
  assert.equal(db.listProjectAssets(imported.projectId).length, 1)
  assert.equal(db.listProjectAssets(imported.projectId)[0]?.requirements[0]?.title, '库存同步')
  assert.equal(db.getKnowledgeDocument(document.id)?.id, document.id)
  assert.equal(db.getRecord('smoke-record-1')?.uid, 'smoke-record-1')
  const deleteImportedResult = db.deleteManagedProject(imported.projectId)
  assert.equal(deleteImportedResult.ok, true)
  assert.equal(db.getManagedProject(imported.projectId), null)
  assert(db.getManagedProject(project.id))

  const listed = db.listManagedProjects({ page: 1, pageSize: 20 })
  const listedProject = listed.rows.find((item) => item.id === project.id)
  assert(listedProject)
  assert.equal(listedProject.requirementCount, 1)
  assert.equal(listedProject.satisfiedCount, 0)
  assert.equal(listedProject.toDevelopCount, 1)
  assert.equal(listedProject.unmarkedCount, 0)
  assert.equal(listedProject.assetCount, 1)
  assert.equal(listedProject.participantCount, 1)
  assert.equal(listedProject.taskCount, 4)
  assert.equal(listedProject.laborEstimatedCost, 1200)

  const reviewSet = db.createProjectRequirementSet({
    projectId: project.id,
    documentId: document.id,
    totalChunks: 4,
    analyzedChunks: 4,
    warnings: [],
    externalProcessing: false,
    modelName: 'ollama:smoke'
  })
  const checkpointSet = db.updateProjectRequirementSetProgress(reviewSet.id, 2, ['来源待复核'])
  assert(checkpointSet)
  assert.equal(checkpointSet.analyzedChunks, 2)
  assert.deepEqual(checkpointSet.warnings, ['来源待复核'])
  const appendixDocument = db.insertKnowledgeDocument({
    id: randomUUID(),
    fileName: 'technical-appendix.txt',
    filePath: join(directory, 'technical-appendix.txt'),
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 24,
    sha256: randomUUID()
  })
  db.linkProjectDocument(project.id, appendixDocument.id)
  db.replaceReviewProjectRequirements(reviewSet.id, project.id, document.id, [
    {
      id: 'review-requirement-1',
      requirementNo: 1,
      category: 'functional',
      module: '订单管理',
      title: '订单导出',
      content: '支持导出订单明细',
      keyInfoTerms: ['订单', '导出'],
      sourceLocation: '第 3 页',
      sourceChunkId: 'chunk-3',
      evidenceQuote: '支持导出订单明细',
      confidence: 0.92
    },
    {
      id: 'review-requirement-2',
      documentId: appendixDocument.id,
      requirementNo: 2,
      category: 'security',
      module: '安全要求',
      title: '访问审计',
      content: '所有管理操作必须记录审计日志',
      keyInfoTerms: ['管理操作', '审计日志'],
      sourceLocation: '第 4 页',
      sourceChunkId: 'chunk-4',
      evidenceQuote: '所有管理操作必须记录审计日志',
      confidence: 0.88
    }
  ])
  const reviewRequirements = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(reviewRequirements.total, 2)
  assert.equal(reviewRequirements.rows.find((item) => item.id === 'review-requirement-2')?.documentId, appendixDocument.id)
  assert.equal(db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20, scope: 'published' }).total, 1)
  db.reviewProjectRequirements(['review-requirement-1'], 'approved')
  assert.throws(() => db.publishReviewProjectRequirementSet(project.id), /仍有 1 条需求未完成审核/)
  db.reviewProjectRequirements(['review-requirement-2'], 'approved')
  const publishedSet = db.publishReviewProjectRequirementSet(project.id)
  assert.equal(publishedSet.status, 'published')
  assert.equal(db.listAllProjectRequirements(project.id).length, 2)

  const draftGateProject = db.createManagedProject(randomUUID(), {
    projectName: '草稿项目匹配门禁 Smoke'
  }, 'manual', 'draft')
  db.replaceProjectRequirements(draftGateProject.id, document.id, [{
    id: 'draft-gate-requirement',
    requirementNo: 1,
    module: '门禁验证',
    title: '草稿不可匹配',
    content: '草稿项目在确认前不得启动需求匹配',
    sourceLocation: 'Smoke',
    sourceChunkId: 'draft-gate-source'
  }])
  assert.equal(db.getManagedProject(draftGateProject.id)?.requirementCount, 1)
  assert.equal(service.startMatching(draftGateProject.id).ok, false, 'draft 项目不得启动项目级匹配')
  assert.equal(service.startRequirementMatching('draft-gate-requirement').ok, false, 'draft 项目不得启动单需求匹配')

  const reviewingGateProject = db.createManagedProject(randomUUID(), {
    projectName: '待审核版本匹配门禁 Smoke'
  })
  const publishedGateRequirement = publishSeededRequirement(
    reviewingGateProject.id,
    'reviewing-gate-published-requirement',
    '当前已发布需求'
  )
  const reviewingGateRequirement = seedReviewRequirement(
    reviewingGateProject.id,
    'reviewing-gate-reviewing-requirement',
    '待审核需求'
  )
  assert.equal(db.getManagedProject(reviewingGateProject.id)?.requirementCount, 1)
  assert.equal(db.getReviewProjectRequirementSet(reviewingGateProject.id)?.status, 'reviewing')
  assert.deepEqual(
    service.listAllRequirements(reviewingGateProject.id).map((item) => item.id),
    [publishedGateRequirement.id],
    '任务与资产选择器只能加载当前已发布需求，不得暴露 reviewing 候选项'
  )
  assert.equal(service.startMatching(reviewingGateProject.id).ok, false, '存在 reviewing 版本时不得启动项目级匹配')
  assert.equal(service.startRequirementMatching(reviewingGateRequirement.id).ok, false, 'reviewing 需求不得启动单需求匹配')
  assert.equal(db.getProjectRequirement(publishedGateRequirement.id)?.reviewStatus, 'approved')

  const supersededGateProject = db.createManagedProject(randomUUID(), {
    projectName: '非当前版本匹配门禁 Smoke'
  })
  const supersededRequirement = publishSeededRequirement(
    supersededGateProject.id,
    'superseded-gate-requirement',
    '已被替代需求'
  )
  const currentGateRequirement = publishSeededRequirement(
    supersededGateProject.id,
    'current-gate-requirement',
    '当前生效需求'
  )
  assert.equal(db.getReviewProjectRequirementSet(supersededGateProject.id), null)
  assert.notEqual(supersededRequirement.setId, currentGateRequirement.setId)
  assert.equal(service.startRequirementMatching(supersededRequirement.id).ok, false, 'superseded 需求不得启动单需求匹配')

  const crossProjectA = db.createManagedProject(randomUUID(), { projectName: '跨项目审核 A' })
  const crossProjectB = db.createManagedProject(randomUUID(), { projectName: '跨项目审核 B' })
  const crossProjectRequirementA = seedReviewRequirement(crossProjectA.id, 'cross-project-review-a', '跨项目需求 A')
  const crossProjectRequirementB = seedReviewRequirement(crossProjectB.id, 'cross-project-review-b', '跨项目需求 B')
  const crossProjectReview = service.reviewRequirements(
    [crossProjectRequirementA.id, crossProjectRequirementB.id],
    'approved'
  )
  assert.equal(crossProjectReview.ok, false, '一次审核操作不得跨越多个项目')
  assert.match(crossProjectReview.message, /同一项目|跨项目/)
  assert.equal(db.getProjectRequirement(crossProjectRequirementA.id)?.reviewStatus, 'pending')
  assert.equal(db.getProjectRequirement(crossProjectRequirementB.id)?.reviewStatus, 'pending')

  const analysisLockProject = db.createManagedProject(randomUUID(), {
    projectName: '分析锁定需求写操作 Smoke'
  })
  const analysisLockRequirement = seedReviewRequirement(
    analysisLockProject.id,
    'analysis-lock-requirement',
    '分析期间不可编辑需求'
  )
  db.updateManagedProjectState(analysisLockProject.id, {
    analysisStatus: 'processing',
    analysisMessage: '协议正在分析'
  })
  const assertAnalysisLocked = (operation: () => unknown, label: string): void => {
    assert.throws(operation, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return /分析|处理|锁定|等待/.test(message)
    }, label)
  }
  const analysisLockInput = {
    category: 'functional' as const,
    module: analysisLockRequirement.module,
    title: analysisLockRequirement.title,
    content: analysisLockRequirement.content,
    keyInfoTerms: analysisLockRequirement.keyInfoTerms,
    sourceLocation: analysisLockRequirement.sourceLocation,
    sourceChunkId: analysisLockRequirement.sourceChunkId,
    evidenceQuote: analysisLockRequirement.evidenceQuote,
    confidence: analysisLockRequirement.confidence,
    reviewNote: analysisLockRequirement.reviewNote
  }
  assertAnalysisLocked(
    () => service.createRequirement(analysisLockProject.id, { ...analysisLockInput, title: '分析期间新增需求' }),
    '分析期间不得补录需求'
  )
  assertAnalysisLocked(
    () => service.updateRequirement(analysisLockRequirement.id, { ...analysisLockInput, title: '分析期间编辑需求' }),
    '分析期间不得编辑需求'
  )
  assertAnalysisLocked(
    () => service.updateRequirementStatus(analysisLockRequirement.id, 'satisfied'),
    '分析期间不得修改需求状态'
  )
  assertAnalysisLocked(
    () => service.updateRequirementKeyInfoTerms(analysisLockRequirement.id, ['分析期间修改']),
    '分析期间不得修改需求信息词'
  )
  assertAnalysisLocked(
    () => service.splitRequirement(analysisLockRequirement.id, {
      parts: [
        { ...analysisLockInput, title: '拆分需求一', content: '拆分需求一' },
        { ...analysisLockInput, title: '拆分需求二', content: '拆分需求二' }
      ]
    }),
    '分析期间不得拆分需求'
  )
  const analysisLockReview = service.reviewRequirements([analysisLockRequirement.id], 'approved')
  assert.equal(analysisLockReview.ok, false, '分析期间不得审核需求')
  assert.equal(db.getProjectRequirement(analysisLockRequirement.id)?.reviewStatus, 'pending')

  const failedReviewSetReplaceGuard = (service as unknown as {
    canReplaceFailedReviewSet: (project: ManagedProject) => boolean
  }).canReplaceFailedReviewSet.bind(service)
  const failedUntouchedProject = db.createManagedProject(randomUUID(), {
    projectName: '失败分析可恢复 Smoke'
  })
  db.linkProjectDocument(failedUntouchedProject.id, document.id)
  seedReviewRequirement(failedUntouchedProject.id, 'failed-untouched-requirement', '失败分析未人工修改')
  db.updateManagedProjectState(failedUntouchedProject.id, {
    analysisStatus: 'failed',
    analysisMessage: '模拟协议抽取中断'
  })
  const failedUntouchedSnapshot = db.getManagedProject(failedUntouchedProject.id)
  assert(failedUntouchedSnapshot)
  assert.equal(failedReviewSetReplaceGuard(failedUntouchedSnapshot), true, '失败且未人工修改的候选集应允许重试替换')

  db.updateManagedProjectState(analysisLockProject.id, {
    analysisStatus: 'failed',
    analysisMessage: '模拟人工接管前的分析失败'
  })
  const reviewSetFingerprintBeforeManualEdit = db.getReviewProjectRequirementSet(analysisLockProject.id)?.fingerprint
  assert(reviewSetFingerprintBeforeManualEdit)
  assert(service.updateRequirement(analysisLockRequirement.id, {
    ...analysisLockInput,
    title: '失败后已人工修订的需求'
  }))
  const reviewSetFingerprintAfterManualEdit = db.getReviewProjectRequirementSet(analysisLockProject.id)?.fingerprint
  assert(reviewSetFingerprintAfterManualEdit)
  assert.notEqual(
    reviewSetFingerprintAfterManualEdit,
    reviewSetFingerprintBeforeManualEdit,
    '人工编辑需求后必须同步刷新需求与需求集 fingerprint'
  )
  assert(service.updateRequirementKeyInfoTerms(analysisLockRequirement.id, ['人工修订信息词']))
  const reviewSetFingerprintAfterTermsEdit = db.getReviewProjectRequirementSet(analysisLockProject.id)?.fingerprint
  assert(reviewSetFingerprintAfterTermsEdit)
  assert.notEqual(
    reviewSetFingerprintAfterTermsEdit,
    reviewSetFingerprintAfterManualEdit,
    '人工修改关键信息词后必须同步刷新需求与需求集 fingerprint'
  )
  const manuallyEditedFailedSnapshot = db.getManagedProject(analysisLockProject.id)
  assert(manuallyEditedFailedSnapshot)
  assert.equal(failedReviewSetReplaceGuard(manuallyEditedFailedSnapshot), false, '失败后已有人工修改的审核稿不得被重试覆盖')
  const blockedReplacementUpload = await service.startTechnicalAgreement(
    join(directory, 'replacement-agreement.txt'),
    analysisLockProject.id
  )
  assert.equal(blockedReplacementUpload.ok, false)
  assert.match(blockedReplacementUpload.message, /待审核|发布/)

  const draftProject = db.createManagedProject(randomUUID(), {
    projectName: '技术协议草稿自动匹配'
  }, 'technical_agreement', 'draft')
  db.linkProjectDocument(draftProject.id, document.id)
  const draftReviewSet = db.createProjectRequirementSet({
    projectId: draftProject.id,
    documentId: document.id,
    totalChunks: 1,
    analyzedChunks: 1,
    warnings: [],
    externalProcessing: false,
    modelName: 'ollama:smoke'
  })
  db.replaceReviewProjectRequirements(draftReviewSet.id, draftProject.id, document.id, [{
    id: 'draft-semantic-requirement',
    requirementNo: 1,
    category: 'functional',
    module: '订单管理',
    title: '订单明细导出',
    content: '系统应允许业务人员按时间范围筛选订单，并导出包含商品与金额的明细文件。',
    keyInfoTerms: ['订单导出', '时间范围'],
    sourceLocation: '第 5 页',
    sourceChunkId: 'chunk-5',
    evidenceQuote: '按时间范围筛选订单并导出明细',
    confidence: 0.94
  }])
  const semanticMatchCountBeforeReview = semanticMatchQueries.length
  const reviewApproval = service.reviewRequirements(['draft-semantic-requirement'], 'approved')
  assert.equal(reviewApproval.ok, true)
  assert.match(reviewApproval.message, /已更新 1 条需求的审核状态/)
  const reviewingDraftSet = db.getReviewProjectRequirementSet(draftProject.id)
  assert(reviewingDraftSet)
  assert.equal(reviewingDraftSet.status, 'reviewing')
  assert.equal(reviewingDraftSet.approvedCount, 1)
  assert.equal(reviewingDraftSet.pendingCount, 0)
  assert.equal(db.getManagedProject(draftProject.id)?.matchStatus, 'idle', '最后一条需求审核通过不得自动启动匹配')
  assert.equal(semanticMatchQueries.length, semanticMatchCountBeforeReview, '最后一条需求审核通过不得自动发布并触发匹配')

  const confirmedDraftProject = service.confirmProject(draftProject.id)
  assert(confirmedDraftProject)
  assert.equal(confirmedDraftProject.lifecycle, 'active')
  assert.equal(db.getReviewProjectRequirementSet(draftProject.id)?.status, 'reviewing')
  assert.equal(db.getManagedProject(draftProject.id)?.matchStatus, 'idle')

  const explicitPublish = service.publishRequirements(draftProject.id)
  assert.equal(explicitPublish.ok, true)
  assert.equal(db.getReviewProjectRequirementSet(draftProject.id), null)
  for (let attempt = 0; attempt < 50 && db.getManagedProject(draftProject.id)?.matchStatus === 'processing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const matchedDraftProject = db.getManagedProject(draftProject.id)
  assert(matchedDraftProject)
  assert.equal(matchedDraftProject.lifecycle, 'active')
  assert.equal(matchedDraftProject.matchStatus, 'ready')
  const semanticQuery = semanticMatchQueries.at(-1) ?? ''
  assert.match(semanticQuery, /明确模块：订单管理/)
  assert.match(semanticQuery, /名称：订单明细导出/)
  assert.match(semanticQuery, /描述：系统应允许业务人员按时间范围筛选订单，并导出包含商品与金额的明细文件。/)

  const publishedRequirement = db.getProjectRequirement('draft-semantic-requirement')
  assert(publishedRequirement)
  let semanticReviewRequest: Record<string, unknown> = {}
  globalThis.fetch = async (_input, init) => {
    semanticReviewRequest = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      done_reason: 'stop',
      message: {
        role: 'assistant',
        content: '{"status":"unmarked","reason":"需要人工确认","matches":[]}'
      }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const reviewMatches = (service as unknown as {
      reviewMatches: (requirement: ProjectRequirement, candidates: KnowledgeRecordMatch[]) => Promise<unknown>
    }).reviewMatches
    await reviewMatches.call(service, publishedRequirement, [{
      recordUid: 'semantic-candidate',
      recordName: '订单数据服务',
      nodeType: 'record',
      itemId: 'semantic-candidate',
      score: 88,
      chunkId: 'semantic-chunk',
      snippet: '提供订单明细查询与文件导出能力'
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
  const semanticMessages = semanticReviewRequest.messages as Array<{ role?: string; content?: string }>
  const semanticSystemPrompt = semanticMessages.find((item) => item.role === 'system')?.content ?? ''
  const semanticUserPayload = JSON.parse(semanticMessages.find((item) => item.role === 'user')?.content ?? '{}') as {
    requirement?: Partial<ProjectRequirement>
  }
  assert.match(semanticSystemPrompt, /补充信息，不是硬约束/)
  assert.match(semanticSystemPrompt, /没有逐字命中这些词/)
  assert.equal(semanticUserPayload.requirement?.module, '订单管理')
  assert.equal(semanticUserPayload.requirement?.title, '订单明细导出')
  assert.equal(semanticUserPayload.requirement?.content, '系统应允许业务人员按时间范围筛选订单，并导出包含商品与金额的明细文件。')
  assert.deepEqual(semanticUserPayload.requirement?.keyInfoTerms, ['订单导出', '时间范围'])

  const recoveryProject = db.createManagedProject(randomUUID(), {
    projectName: '匹配运行启动恢复 Smoke'
  })
  db.replaceProjectRequirements(recoveryProject.id, document.id, [{
    id: 'interrupted-match-requirement',
    requirementNo: 1,
    module: '恢复验证',
    title: '遗留匹配运行',
    content: '启动时应将遗留的运行中匹配标记为中断失败',
    sourceLocation: 'Smoke',
    sourceChunkId: 'interrupted-match-source'
  }])
  const recoveryRequirement = db.getProjectRequirement('interrupted-match-requirement')
  assert(recoveryRequirement)
  db.updateManagedProjectState(recoveryProject.id, {
    matchStatus: 'processing',
    matchMessage: '遗留匹配任务仍在运行'
  })
  const runningMatchRun = db.createRequirementMatchRun({
    requirementId: recoveryRequirement.id,
    requirementSnapshotHash: hashProjectRequirementSnapshot(recoveryRequirement),
    normalizationVersion: 'v1',
    pipelineVersion: 'v1.1',
    rankingVersion: 'smoke-ranking-v1',
    configHash: 'smoke-config',
    modelVersion: 'ollama:smoke'
  })
  assert.equal(runningMatchRun.status, 'running')
  const restartedService = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke',
      thinking: false
    }),
    undefined,
    undefined,
    matchingCore
  )
  assert(restartedService.getProject(recoveryProject.id))
  const recoveredMatchRun = db.getRequirementMatchRun(runningMatchRun.id)
  assert(recoveredMatchRun)
  assert.equal(recoveredMatchRun.status, 'failed', '启动恢复必须结束遗留 running 匹配运行')
  assert.equal(recoveredMatchRun.failureCode, 'MATCH_INTERRUPTED')
  const recoveredProject = db.getManagedProject(recoveryProject.id)
  assert(recoveredProject)
  assert.equal(recoveredProject.matchStatus, 'failed')
  assert.match(recoveredProject.matchMessage, /中断|重新执行/)

  // Phase 1: requirement identity, release traceability, and historical-link policy.
  type ReviewRequirementInput = Parameters<AppDatabase['replaceReviewProjectRequirements']>[3][number]
  const makeTraceRequirementInput = (
    id: string,
    title: string,
    content: string,
    requirementNo: number
  ): ReviewRequirementInput => ({
    id,
    requirementNo,
    category: 'functional',
    module: '需求追溯 Smoke',
    title,
    content,
    keyInfoTerms: [title],
    sourceLocation: `追溯协议 · 第 ${requirementNo} 页`,
    sourceChunkId: `trace-source-${id}`,
    evidenceQuote: content,
    confidence: 0.95
  })
  const seedTraceVersion = (projectId: string, requirements: ReviewRequirementInput[]) => {
    const set = db.createProjectRequirementSet({
      projectId,
      documentId: document.id,
      totalChunks: requirements.length,
      analyzedChunks: requirements.length,
      warnings: [],
      externalProcessing: false,
      modelName: 'ollama:smoke'
    })
    db.replaceReviewProjectRequirements(set.id, projectId, document.id, requirements)
    return {
      set,
      requirements: requirements.map((item) => db.getProjectRequirement(item.id) as ProjectRequirement)
    }
  }
  const makeTaskInput = (requirementIds: string[]) => ({
    taskType: 'task' as const,
    title: '需求追溯发布 Smoke 任务',
    description: '验证需求版本发布后的关系重映射与历史关系保留',
    startDate: '2026-08-21',
    endDate: '2026-08-25',
    status: 'not_started' as const,
    progressPercent: 0,
    sortOrder: 0,
    requirementIds
  })
  const traceProject = db.createManagedProject(randomUUID(), {
    projectName: '需求追溯发布 Smoke',
    customerName: '追溯测试客户'
  })
  db.linkProjectDocument(traceProject.id, document.id)
  for (const [index, recordUid] of ['trace-record-1', 'trace-record-2', 'trace-record-3', 'trace-record-4', 'trace-record-5'].entries()) {
    db.upsertRecord({
      uid: recordUid,
      projectId: 'trace-source-project',
      nodeType: 'Requirement',
      itemId: recordUid,
      parentId: '',
      name: `需求追溯数据 ${index + 1}`,
      lastModifyTime: '2026-08-20T00:00:00.000Z',
      raw: { description: `需求追溯数据 ${index + 1}` },
      normalizedText: `需求追溯数据 ${index + 1}`
    })
  }

  const v1KeepInput = makeTraceRequirementInput(
    'trace-requirement-keep-v1',
    '支持订单查询',
    '系统应支持按订单号查询订单详情。',
    1
  )
  const v1DropInput = makeTraceRequirementInput(
    'trace-requirement-drop-v1',
    '支持历史报表',
    '系统应支持导出历史报表。',
    2
  )
  const seededV1 = seedTraceVersion(traceProject.id, [v1KeepInput, v1DropInput])
  assert.equal(db.reviewProjectRequirements(seededV1.requirements.map((item) => item.id), 'approved'), 2)
  const publishedV1 = db.publishReviewProjectRequirementSet(traceProject.id)
  assert.equal(publishedV1.status, 'published')
  const v1Keep = db.getProjectRequirement(v1KeepInput.id)
  const v1Drop = db.getProjectRequirement(v1DropInput.id)
  assert(v1Keep)
  assert(v1Drop)
  assert.equal(v1Keep.version, 1)
  assert.equal(v1Drop.version, 1)
  assert.notEqual(v1Keep.logicalId, v1Drop.logicalId)

  const traceTask = db.insertProjectTask(traceProject.id, makeTaskInput([v1Keep.id, v1Drop.id]))
  const traceKeepAsset = db.linkProjectAsset(traceProject.id, 'trace-record-1', v1Keep.id)
  const traceDropAsset = db.linkProjectAsset(traceProject.id, 'trace-record-2', v1Drop.id)
  assert(traceKeepAsset)
  assert(traceDropAsset)
  const initialKeepTaskLink = traceTask.requirements.find((item) => item.requirementId === v1Keep.id)
  const initialKeepAssetLink = traceKeepAsset.requirements.find((item) => item.requirementId === v1Keep.id)
  assert(initialKeepTaskLink)
  assert(initialKeepAssetLink)
  assert.equal(initialKeepTaskLink.logicalId, v1Keep.logicalId)
  assert.equal(initialKeepTaskLink.traceStatus, 'valid')
  assert.equal(initialKeepTaskLink.sourceBaselineVersion, 1)
  assert.equal(initialKeepTaskLink.sourceRequirementVersion, 1)
  assert.equal(initialKeepTaskLink.targetCurrentVersion, 1)
  assert.equal(initialKeepTaskLink.traceMetadata.sourceRequirementId, v1Keep.id)
  assert.equal(initialKeepTaskLink.traceMetadata.targetRequirementId, v1Keep.id)
  assert.equal(initialKeepAssetLink.logicalId, v1Keep.logicalId)
  assert.equal(initialKeepAssetLink.traceStatus, 'valid')

  const v2KeepInput = makeTraceRequirementInput(
    'trace-requirement-keep-v2',
    v1Keep.title,
    v1Keep.content,
    1
  )
  const v2ReviewInput = makeTraceRequirementInput(
    'trace-requirement-review-v2',
    '支持评审中的对账',
    '系统应支持评审中的对账能力。',
    2
  )
  const v2RejectedInput = makeTraceRequirementInput(
    'trace-requirement-rejected-v2',
    '支持被拒绝的归档',
    '系统应支持被拒绝的归档能力。',
    3
  )
  const seededV2 = seedTraceVersion(traceProject.id, [v2KeepInput, v2ReviewInput, v2RejectedInput])
  const v2Keep = db.getProjectRequirement(v2KeepInput.id)
  const v2Review = db.getProjectRequirement(v2ReviewInput.id)
  const v2Rejected = db.getProjectRequirement(v2RejectedInput.id)
  assert(v2Keep)
  assert(v2Review)
  assert(v2Rejected)
  assert.equal(v2Keep.logicalId, v1Keep.logicalId, '相同业务需求发布新版本必须继承 logicalId')
  assert.equal(v2Keep.version, 2)
  assert.equal(v2Keep.setId, seededV2.set.id)
  assert.equal(db.reviewProjectRequirements([v2Keep.id], 'approved'), 1)

  const assertAssetRequirementRejected = (recordUid: string, requirementId: string, message: string): void => {
    let rejected = false
    try {
      const result = db.linkProjectAsset(traceProject.id, recordUid, requirementId)
      rejected = result === null
    } catch {
      rejected = true
    }
    assert.equal(rejected, true, message)
    assert.equal(
      Boolean(db.listProjectAssets(traceProject.id)
        .find((asset) => asset.recordUid === recordUid)
        ?.requirements.some((item) => item.requirementId === requirementId)),
      false,
      `${message}（不得留下新关系）`
    )
  }
  const assertTaskRequirementRejected = (requirementId: string, message: string): void => {
    let rejected = false
    try {
      const created = db.insertProjectTask(traceProject.id, makeTaskInput([requirementId]))
      if (created) db.deleteProjectTask(created.id)
    } catch {
      rejected = true
    }
    assert.equal(rejected, true, message)
  }
  assertAssetRequirementRejected('trace-record-3', v2Review.id, '评审中的需求禁止新增资产关联')
  assertTaskRequirementRejected(v2Review.id, '评审中的需求禁止新增任务关联')

  assert.equal(db.reviewProjectRequirements([v2Review.id, v2Rejected.id], 'rejected'), 2)
  const publishedV2 = db.publishReviewProjectRequirementSet(traceProject.id)
  assert.equal(publishedV2.status, 'published')
  const currentV2Keep = db.getProjectRequirement(v2Keep.id)
  assert(currentV2Keep)
  assert.equal(currentV2Keep.reviewStatus, 'approved')
  assert.equal(db.getProjectRequirement(v1Keep.id)?.setId, publishedV1.id, '旧版本需求记录必须保留以支持追溯')

  const remappedTask = db.getProjectTask(traceTask.id)
  const remappedKeepTaskLink = remappedTask?.requirements.find((item) => item.logicalId === v1Keep.logicalId)
  const suspectDropTaskLink = remappedTask?.requirements.find((item) => item.logicalId === v1Drop.logicalId)
  assert(remappedTask)
  assert(remappedKeepTaskLink)
  assert(suspectDropTaskLink)
  assert.equal(remappedKeepTaskLink.requirementId, currentV2Keep.id, '任务关联应自动重映射到新版本需求')
  assert.equal(remappedKeepTaskLink.traceStatus, 'valid')
  assert.equal(remappedKeepTaskLink.sourceBaselineVersion, 1)
  assert.equal(remappedKeepTaskLink.sourceRequirementVersion, 1)
  assert.equal(remappedKeepTaskLink.targetCurrentVersion, 2)
  assert.equal(remappedKeepTaskLink.traceMetadata.sourceRequirementId, v1Keep.id)
  assert.equal(remappedKeepTaskLink.traceMetadata.targetRequirementId, currentV2Keep.id)
  assert.equal(suspectDropTaskLink.requirementId, v1Drop.id, '无法对应的旧任务关系应保留源关系')
  assert.equal(suspectDropTaskLink.traceStatus, 'suspect')
  assert.equal(suspectDropTaskLink.targetCurrentVersion, null)
  assert.equal(suspectDropTaskLink.traceMetadata.targetRequirementId, null)
  assert.notEqual(suspectDropTaskLink.traceMetadata.validationReason, '', '无法对应的旧关系必须记录复核原因')

  const remappedAssets = db.listProjectAssets(traceProject.id)
  const remappedKeepAssetLink = remappedAssets.find((asset) => asset.recordUid === 'trace-record-1')?.requirements.find((item) => item.logicalId === v1Keep.logicalId)
  const suspectDropAssetLink = remappedAssets.find((asset) => asset.recordUid === 'trace-record-2')?.requirements.find((item) => item.logicalId === v1Drop.logicalId)
  assert(remappedKeepAssetLink)
  assert(suspectDropAssetLink)
  assert.equal(remappedKeepAssetLink.requirementId, currentV2Keep.id, '资产关联应自动重映射到新版本需求')
  assert.equal(remappedKeepAssetLink.traceStatus, 'valid')
  assert.equal(remappedKeepAssetLink.sourceBaselineVersion, 1)
  assert.equal(remappedKeepAssetLink.sourceRequirementVersion, 1)
  assert.equal(remappedKeepAssetLink.targetCurrentVersion, 2)
  assert.equal(remappedKeepAssetLink.traceMetadata.sourceRequirementId, v1Keep.id)
  assert.equal(remappedKeepAssetLink.traceMetadata.targetRequirementId, currentV2Keep.id)
  assert.equal(suspectDropAssetLink.requirementId, v1Drop.id)
  assert.equal(suspectDropAssetLink.traceStatus, 'suspect')
  assert.equal(suspectDropAssetLink.targetCurrentVersion, null)
  assert.equal(suspectDropAssetLink.traceMetadata.targetRequirementId, null)

  assertAssetRequirementRejected('trace-record-4', v1Drop.id, '历史需求禁止新增资产关联')
  assertAssetRequirementRejected('trace-record-5', v2Rejected.id, '拒绝需求禁止新增资产关联')
  assertTaskRequirementRejected(v1Drop.id, '历史需求禁止新增任务关联')
  assertTaskRequirementRejected(v2Rejected.id, '拒绝需求禁止新增任务关联')
  const retainedSuspectTask = db.updateProjectTask(traceTask.id, makeTaskInput([currentV2Keep.id, v1Drop.id]))
  assert(retainedSuspectTask)
  const retainedSuspectLink = retainedSuspectTask.requirements.find((item) => item.requirementId === v1Drop.id)
  assert(retainedSuspectLink)
  assert.equal(retainedSuspectLink.traceStatus, 'suspect', '编辑任务时允许保留已有 suspect 历史关系')
  const removedSuspectTask = db.updateProjectTask(traceTask.id, makeTaskInput([currentV2Keep.id]))
  assert(removedSuspectTask)
  assert.equal(
    removedSuspectTask.requirements.some((item) => item.requirementId === v1Drop.id),
    false,
    '编辑任务时必须允许用户明确移除已有 suspect 历史关系'
  )

  const traceCandidate: RequirementMatchCandidateResult & { recordSnapshotHash: string } = {
    recordUid: 'trace-record-1',
    finalRank: 1,
    similarityScore: 88,
    rankingScore: 88,
    rankingVersion: 'trace-ranking-v2',
    scoreBreakdown: {
      formulaVersion: 'trace-formula-v1',
      dense: { rawScore: 0.88, normalizedScore: 88, weight: 0.4, contribution: 35.2, available: true },
      lexical: { rawScore: 0.86, normalizedScore: 86, weight: 0.2, contribution: 17.2, available: true },
      reranker: { rawScore: null, normalizedScore: 0, weight: 0, contribution: 0, available: false },
      businessAlignment: { rawScore: 0.9, normalizedScore: 90, weight: 0.4, contribution: 36, available: true },
      total: 88.4
    },
    relation: 'highly_similar',
    decisionStatus: 'suggested',
    confidenceStatus: 'high',
    confidenceReasons: ['traceability smoke'],
    evidenceLevel: 'deterministic_rule',
    reasonCodes: ['TRACE_SMOKE'],
    degradationCodes: [],
    stageScores: {
      denseRank: 1,
      denseScore: 0.88,
      lexicalRank: 1,
      lexicalScore: 0.86,
      fusedRank: 1,
      fusedScore: 0.88,
      rerankerRank: null,
      rerankerScore: null
    },
    evidenceJson: { source: 'traceability smoke' },
    explanationStatus: 'not_requested',
    explanation: null,
    recordSnapshotHash: 'trace-record-snapshot-v1'
  }
  const traceRun = db.createRequirementMatchRun({
    requirementId: currentV2Keep.id,
    requirementSnapshotHash: hashProjectRequirementSnapshot(currentV2Keep),
    normalizationVersion: 'trace-normalization-v2',
    pipelineVersion: 'trace-pipeline-v2',
    rankingVersion: 'trace-ranking-v2',
    configHash: 'trace-config-v2',
    modelVersion: 'ollama:smoke'
  })
  db.completeRequirementMatchRun(traceRun.id, [traceCandidate], [])
  const traceRunningRun = db.createRequirementMatchRun({
    requirementId: currentV2Keep.id,
    requirementSnapshotHash: hashProjectRequirementSnapshot(currentV2Keep),
    normalizationVersion: 'trace-normalization-running-v2',
    pipelineVersion: 'trace-pipeline-running-v2',
    rankingVersion: 'trace-running-ranking-v2',
    configHash: 'trace-config-running-v2',
    modelVersion: 'ollama:smoke'
  })
  assert.equal(traceRunningRun.status, 'running')
  const traceSnapshot = db.exportManagedProjectSnapshot(traceProject.id, 2)
  assert(traceSnapshot)
  assert.equal(traceSnapshot.version, 2, '项目快照必须升级到 v2')
  assert(Array.isArray(traceSnapshot.requirementSets))
  assert(Array.isArray(traceSnapshot.matchRuns))
  assert(Array.isArray(traceSnapshot.matchCandidates))
  assert(Array.isArray(traceSnapshot.traceMetadata))
  assert.equal(traceSnapshot.requirementSets.length >= 2, true, 'v2 快照必须包含全部需求集版本')
  assert.equal(traceSnapshot.requirements.some((item) => item.id === v1Keep.id), true, 'v2 快照必须包含旧需求版本')
  assert.equal(traceSnapshot.requirements.some((item) => item.id === currentV2Keep.id), true, 'v2 快照必须包含当前需求版本')
  assert.equal(traceSnapshot.requirementSets.some((item) => item.id === publishedV1.id && item.status === 'superseded'), true)
  assert.equal(traceSnapshot.requirementSets.some((item) => item.id === publishedV2.id && item.status === 'published'), true)
  assert.equal(traceSnapshot.matchRuns.some((item) => item.id === traceRun.id && item.requirementLogicalId === currentV2Keep.logicalId), true, 'v2 快照必须包含匹配运行逻辑身份')
  assert.equal(traceSnapshot.matchRuns.some((item) => item.id === traceRunningRun.id && item.status === 'running'), true, 'v2 快照必须保留 running 运行状态供导入恢复')
  assert.equal(traceSnapshot.matchCandidates.some((item) => item.runId === traceRun.id && item.recordUid === traceCandidate.recordUid), true, 'v2 快照必须包含匹配候选证据')
  assert.equal(traceSnapshot.traceMetadata.some((item) => item.entityType === 'task' && item.taskId === traceTask.id), true)
  assert.equal(traceSnapshot.traceMetadata.some((item) => item.entityType === 'asset' && item.recordUid === 'trace-record-1'), true)
  const retiredSnapshotFields = [
    'traceReviews',
    'traceDecisionAudits',
    'traceAiReviewRuns',
    'traceAiReviewResults',
    'governanceAcknowledgements',
    'governanceReport'
  ] as const
  const retiredV2Snapshot = structuredClone(traceSnapshot) as unknown as Record<string, unknown>
  for (const field of retiredSnapshotFields) retiredV2Snapshot[field] = field === 'governanceReport' ? {} : []
  const importedRetiredV2 = db.importManagedProjectSnapshot(retiredV2Snapshot as unknown as typeof traceSnapshot)
  const retiredV2Export = db.exportManagedProjectSnapshot(importedRetiredV2.projectId, 2) as unknown as Record<string, unknown>
  for (const field of retiredSnapshotFields) {
    assert.equal(Object.prototype.hasOwnProperty.call(retiredV2Export, field), false, `退役 v2 字段 ${field} 必须被忽略且不得重新导出`)
  }

  const importedV2 = db.importManagedProjectSnapshot(traceSnapshot)
  const importedCurrentRequirements = db.listAllProjectRequirements(importedV2.projectId)
  const importedCurrentKeep = importedCurrentRequirements.find((item) => item.logicalId === currentV2Keep.logicalId)
  assert(importedCurrentKeep)
  assert.notEqual(importedCurrentKeep.id, currentV2Keep.id, '导入必须为冲突的需求 ID 建立映射')
  const importedTask = db.listProjectTasks(importedV2.projectId).find((task) => task.title === traceTask.title)
  assert(importedTask)
  const importedTaskKeep = importedTask.requirements.find((item) => item.logicalId === currentV2Keep.logicalId)
  assert(importedTaskKeep)
  assert.equal(importedTaskKeep.requirementId, importedCurrentKeep.id, '导入任务关联必须指向映射后的需求 ID')
  assert.equal(importedTaskKeep.traceMetadata.targetRequirementId, importedCurrentKeep.id)
  const importedAsset = db.listProjectAssets(importedV2.projectId).find((asset) => asset.recordUid === 'trace-record-1')
  assert(importedAsset)
  const importedAssetKeep = importedAsset.requirements.find((item) => item.logicalId === currentV2Keep.logicalId)
  assert(importedAssetKeep)
  assert.equal(importedAssetKeep.requirementId, importedCurrentKeep.id, '导入资产关联必须指向映射后的需求 ID')
  const importedRunRow = databaseHandle.db.prepare(`
    SELECT mr.id, mr.requirement_id
    FROM pm_requirement_match_runs mr
    JOIN pm_requirements q ON q.id = mr.requirement_id
    WHERE q.project_id = ? AND q.logical_id = ? AND mr.ranking_version = ?
  `).get(importedV2.projectId, currentV2Keep.logicalId, traceRun.rankingVersion)
  assert(importedRunRow)
  assert.notEqual(String(importedRunRow.id), traceRun.id, '导入必须为冲突的匹配运行 ID 建立映射')
  assert.equal(String(importedRunRow.requirement_id), importedCurrentKeep.id)
  const importedCompatibleRun = db.getLatestCompatibleRequirementMatchRun({
    requirementId: importedCurrentKeep.id,
    requirementSnapshotHash: hashProjectRequirementSnapshot(importedCurrentKeep)
  })
  assert(importedCompatibleRun, '导入后的成功匹配运行必须可被目标需求兼容性查询选中')
  assert.equal(importedCompatibleRun.id, String(importedRunRow.id))
  const importedCandidates = db.listRequirementMatchCandidates({ runId: String(importedRunRow.id), page: 1, pageSize: 20, diagnostics: true })
  assert.equal(importedCandidates.rows.length, 1)
  assert.equal(importedCandidates.rows[0]?.recordUid, traceCandidate.recordUid)
  const importedRunningRunRow = databaseHandle.db.prepare(`
    SELECT mr.status, mr.failure_code
    FROM pm_requirement_match_runs mr
    JOIN pm_requirements q ON q.id = mr.requirement_id
    WHERE q.project_id = ? AND q.logical_id = ? AND mr.ranking_version = ?
  `).get(importedV2.projectId, currentV2Keep.logicalId, traceRunningRun.rankingVersion)
  assert(importedRunningRunRow)
  assert.equal(String(importedRunningRunRow.status), 'failed', '导入快照不得恢复 running 匹配运行')
  assert.equal(String(importedRunningRunRow.failure_code), 'MATCH_INTERRUPTED', '导入 running 匹配运行必须标记为 MATCH_INTERRUPTED')

  const malformedSnapshot = structuredClone(traceSnapshot)
  const sourceAssetForWarning = malformedSnapshot.assets.find((asset) => asset.recordUid === 'trace-record-1')
  assert(sourceAssetForWarning)
  malformedSnapshot.assets.push({ ...sourceAssetForWarning, recordUid: 'missing-record-link' })
  const sourceCandidateForWarning = malformedSnapshot.matchCandidates?.find((candidate) => candidate.runId === traceRun.id)
  assert(sourceCandidateForWarning)
  malformedSnapshot.matchCandidates?.push({ ...sourceCandidateForWarning, recordUid: 'missing-record-candidate' })
  const sourceTraceForWarning = malformedSnapshot.traceMetadata?.find((trace) => trace.entityType === 'asset')
  assert(sourceTraceForWarning)
  malformedSnapshot.traceMetadata?.push({ ...sourceTraceForWarning, recordUid: 'missing-record-trace' })
  const importedWithWarnings = db.importManagedProjectSnapshot(malformedSnapshot)
  assert.equal(importedWithWarnings.warnings.length >= 2, true, '缺失数据记录的链接与候选必须产生 warning')
  assert.equal(importedWithWarnings.warnings.some((warning) => /记录/.test(warning)), true)
  assert.equal(importedWithWarnings.warnings.some((warning) => /候选/.test(warning)), true)
  const missingAssetRows = databaseHandle.db.prepare(`
    SELECT COUNT(*) AS count FROM pm_project_assets WHERE project_id = ? AND record_uid IN ('missing-record-link', 'missing-record-trace')
  `).get(importedWithWarnings.projectId)
  assert.equal(Number(missingAssetRows?.count ?? 0), 0, '缺失数据记录的资产链接必须跳过')
  const missingCandidateRows = databaseHandle.db.prepare(`
    SELECT COUNT(*) AS count FROM pm_requirement_match_candidates c
    JOIN pm_requirement_match_runs r ON r.id = c.run_id
    JOIN pm_requirements q ON q.id = r.requirement_id
    WHERE q.project_id = ? AND c.record_uid = 'missing-record-candidate'
  `).get(importedWithWarnings.projectId)
  assert.equal(Number(missingCandidateRows?.count ?? 0), 0, '缺失数据记录的候选必须跳过')

  // A minimal v1 payload (without v2 arrays and trace fields) must still import.
  const legacySnapshot = structuredClone(traceSnapshot)
  legacySnapshot.version = 1
  delete legacySnapshot.requirementSets
  delete legacySnapshot.matchRuns
  delete legacySnapshot.matchCandidates
  delete legacySnapshot.traceMetadata
  legacySnapshot.tasks = legacySnapshot.tasks.map((task) => ({
    ...task,
    requirements: task.requirements.map((relation) => {
      const legacyRelation = { ...relation } as unknown as Record<string, unknown>
      delete legacyRelation.logicalId
      delete legacyRelation.sourceBaselineVersion
      delete legacyRelation.sourceRequirementVersion
      delete legacyRelation.targetCurrentVersion
      delete legacyRelation.traceStatus
      delete legacyRelation.traceMetadata
      return legacyRelation as unknown as typeof relation
    })
  }))
  legacySnapshot.assets = legacySnapshot.assets.map((asset) => ({
    ...asset,
    requirements: asset.requirements.map((relation) => {
      const legacyRelation = { ...relation } as unknown as Record<string, unknown>
      delete legacyRelation.logicalId
      delete legacyRelation.sourceBaselineVersion
      delete legacyRelation.sourceRequirementVersion
      delete legacyRelation.targetCurrentVersion
      delete legacyRelation.traceStatus
      delete legacyRelation.traceMetadata
      return legacyRelation as unknown as typeof relation
    })
  }))
  const importedV1 = db.importManagedProjectSnapshot(legacySnapshot)
  assert(importedV1.projectId)
  assert(importedV1.projectId !== traceProject.id)
  assert(db.getManagedProject(importedV1.projectId))
  assert.equal(db.listProjectTasks(importedV1.projectId).length, db.listProjectTasks(traceProject.id).length)

  // Exercise the legacy migration backfill and verify stable identity on a second startup.
  const legacyDirectory = mkdtempSync(join(tmpdir(), 'visslm-project-trace-migration-'))
  const legacyDatabasePath = join(legacyDirectory, 'projects.db')
  let legacyDb: AppDatabase | null = new AppDatabase(legacyDatabasePath, join(legacyDirectory, 'assets'))
  try {
    const legacyProject = legacyDb.createManagedProject(randomUUID(), { projectName: '需求追溯迁移 Smoke' })
    legacyDb.insertKnowledgeDocument({
      id: document.id,
      fileName: 'legacy-trace-agreement.txt',
      filePath: join(legacyDirectory, 'legacy-trace-agreement.txt'),
      extension: '.txt',
      mimeType: 'text/plain',
      byteSize: 16,
      sha256: 'legacy-trace-agreement-sha256'
    })
    legacyDb.upsertRecord({
      uid: 'legacy-trace-record',
      projectId: 'legacy-source-project',
      nodeType: 'Requirement',
      itemId: 'legacy-trace-record',
      parentId: '',
      name: '旧库追溯数据',
      lastModifyTime: '2026-08-20T00:00:00.000Z',
      raw: { description: '旧库追溯数据' },
      normalizedText: '旧库追溯数据'
    })
    legacyDb.replaceProjectRequirements(legacyProject.id, document.id, [{
      id: 'legacy-trace-requirement',
      requirementNo: 1,
      module: '旧库',
      title: '旧库需求',
      content: '旧库需求内容',
      sourceLocation: '旧库协议',
      sourceChunkId: 'legacy-trace-source'
    }])
    const legacyRequirement = legacyDb.getProjectRequirement('legacy-trace-requirement')
    assert(legacyRequirement)
    const legacyTask = legacyDb.insertProjectTask(legacyProject.id, makeTaskInput([legacyRequirement.id]))
    assert(legacyDb.linkProjectAsset(legacyProject.id, 'legacy-trace-record', legacyRequirement.id))
    const legacyStorage = legacyDb as unknown as { db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } } }
    legacyStorage.db.prepare('UPDATE pm_requirements SET logical_id = ?, fingerprint = ? WHERE id = ?').run('', '', legacyRequirement.id)
    legacyStorage.db.prepare(`
      UPDATE pm_project_task_requirements
      SET source_baseline_version = 0, source_requirement_version = 0,
          target_current_version = NULL, trace_status = 'suspect', trace_metadata_json = '{}'
      WHERE task_id = ? AND requirement_id = ?
    `).run(legacyTask.id, legacyRequirement.id)
    legacyStorage.db.prepare(`
      UPDATE pm_project_asset_requirements
      SET source_baseline_version = 0, source_requirement_version = 0,
          target_current_version = NULL, trace_status = 'suspect', trace_metadata_json = '{}'
      WHERE record_uid = 'legacy-trace-record' AND requirement_id = ?
    `).run(legacyRequirement.id)
    legacyDb.close()
    legacyDb = null

    const migratedDatabase = new AppDatabase(legacyDatabasePath, join(legacyDirectory, 'assets'))
    const migratedRequirement = migratedDatabase.getProjectRequirement(legacyRequirement.id)
    const migratedTask = migratedDatabase.getProjectTask(legacyTask.id)
    assert(migratedRequirement)
    assert(migratedTask)
    assert.match(migratedRequirement.logicalId, /^legacy:/)
    assert.notEqual(migratedRequirement.logicalId, '')
    const migratedTaskLink = migratedTask.requirements[0]
    assert(migratedTaskLink)
    assert.equal(migratedTaskLink.traceStatus, 'valid')
    assert.equal(migratedTaskLink.traceMetadata.sourceRequirementId, legacyRequirement.id)
    assert.equal(migratedTaskLink.traceMetadata.targetRequirementId, legacyRequirement.id)
    const migratedStorage = migratedDatabase as unknown as {
      db: { prepare: (sql: string) => {
        get: (...params: unknown[]) => SmokeSqlRow | undefined
        all: (...params: unknown[]) => SmokeSqlRow[]
      } }
    }
    assert.deepEqual(listRetiredProjectTables(migratedDatabase), [], '旧库首次启动不得创建 Phase2–5 退役表')
    const migratedRaw = migratedStorage.db.prepare('SELECT logical_id, fingerprint FROM pm_requirements WHERE id = ?').get(legacyRequirement.id)
    assert(migratedRaw)
    const migratedLogicalId = String(migratedRaw.logical_id)
    const migratedFingerprint = String(migratedRaw.fingerprint)
    migratedDatabase.close()

    const idempotentDatabase = new AppDatabase(legacyDatabasePath, join(legacyDirectory, 'assets'))
    const idempotentRequirement = idempotentDatabase.getProjectRequirement(legacyRequirement.id)
    assert(idempotentRequirement)
    const idempotentStorage = idempotentDatabase as unknown as {
      db: { prepare: (sql: string) => {
        get: (...params: unknown[]) => SmokeSqlRow | undefined
        all: (...params: unknown[]) => SmokeSqlRow[]
      } }
    }
    assert.deepEqual(listRetiredProjectTables(idempotentDatabase), [], '旧库二次启动仍不得创建 Phase2–5 退役表')
    const idempotentRaw = idempotentStorage.db.prepare('SELECT logical_id, fingerprint FROM pm_requirements WHERE id = ?').get(legacyRequirement.id)
    assert(idempotentRaw)
    assert.equal(String(idempotentRaw.logical_id), migratedLogicalId, '旧库迁移二次初始化不得改变 logicalId')
    assert.equal(String(idempotentRaw.fingerprint), migratedFingerprint, '旧库迁移二次初始化不得改变 fingerprint')
    assert.equal(idempotentRequirement.logicalId, migratedRequirement.logicalId)
    assert.equal(idempotentDatabase.getProjectTask(legacyTask.id)?.requirements[0]?.traceStatus, 'valid')
    idempotentDatabase.close()
  } finally {
    legacyDb?.close()
    rmSync(legacyDirectory, { recursive: true, force: true })
  }

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    remainingQuota: listedProject.remainingQuota,
    laborEstimatedCost: listedProject.laborEstimatedCost,
    requirementCount: listedProject.requirementCount,
    topMatch: matchPage.rows[0]?.finalScore
  }, null, 2))
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}
