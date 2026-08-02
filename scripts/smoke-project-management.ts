import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { AppDatabase } from '../src/main/database'
import { ProjectManagementService } from '../src/main/project-management'
import type { KnowledgeService } from '../src/main/knowledge'
import { normalizeProjectRequirementText } from '../src/shared/project-requirement-utils'

const directory = mkdtempSync(join(tmpdir(), 'visslm-project-management-'))
const db = new AppDatabase(join(directory, 'projects.db'), join(directory, 'assets'))

try {
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
  const analysisLogs = db.listProjectAnalysisLogs(project.id)
  assert.equal(analysisLogs.length, 2)
  assert.equal(analysisLogs[0]?.message, '需求抽取失败')
  assert.equal(analysisLogs[0]?.detail, '协议附件关联已保留，可重试')

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
    })
  } as unknown as KnowledgeService
  const service = new ProjectManagementService(
    db,
    fakeKnowledge,
    () => ({
      source: 'local',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      model: 'smoke',
      thinking: false
    })
  )
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
  const normalizedRequirement = normalizeProjectRequirementText({
    title: '2.1 整体要求 支持按订单号查询订单详情',
    content: '支持按订单号查询订单详情'
  })
  assert.equal(normalizedRequirement.module, '2.1 整体要求')
  assert.equal(normalizedRequirement.title, '支持按订单号查询订单详情')
  const initialRequirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(initialRequirementPage.rows[0]?.status, 'unmarked')
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

  const matchPage = db.listProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 1 })
  assert.equal(matchPage.total, 2)
  assert.equal(matchPage.rows[0]?.recordUid, 'smoke-record-1')
  assert.equal(matchPage.rows[0]?.finalScore, 95)
  const requirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(requirementPage.total, 2)
  assert.equal(requirementPage.rows[0]?.module, '订单管理')
  assert.equal(requirementPage.rows[0]?.status, 'satisfied')
  assert.equal(requirementPage.rows[1]?.statusSource, 'manual')

  const deleteRequirementResult = db.deleteProjectRequirement('smoke-requirement-1')
  assert.equal(deleteRequirementResult.ok, true)
  assert.equal(db.listProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 }).total, 0)
  const remainingRequirementPage = db.listProjectRequirements({ projectId: project.id, page: 1, pageSize: 20 })
  assert.equal(remainingRequirementPage.total, 1)
  assert.equal(remainingRequirementPage.rows[0]?.id, 'smoke-requirement-2')

  const snapshot = db.exportManagedProjectSnapshot(project.id)
  assert(snapshot)
  assert.equal(snapshot.format, 'visslm-project')
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.project.baseEstimatedCost, 240)
  assert.equal(snapshot.participants.length, 1)
  assert.equal(snapshot.tasks.length, 3)
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
  assert.equal(db.listProjectTasks(imported.projectId).length, 3)
  assert.equal(db.listProjectRequirements({ projectId: imported.projectId, page: 1, pageSize: 20 }).total, 1)
  assert.equal(db.listProjectAssets(imported.projectId).length, 1)
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
  assert.equal(listedProject.taskCount, 3)
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
