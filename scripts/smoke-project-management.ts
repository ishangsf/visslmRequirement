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
import type { KnowledgeRecordMatch, KnowledgeService } from '../src/main/knowledge'
import type { ProjectAnalysisProgress, ProjectRequirement } from '../src/shared/project-types'
import { normalizeProjectRequirementText } from '../src/shared/project-requirement-utils'
import { buildRequirementSourceView } from '../src/main/requirements/requirement-match-card'
import { RequirementMatchingCore } from '../src/main/requirements/requirement-matching-core'
import { hashProjectRequirementSnapshot } from '../src/main/requirements/requirement-match-run-service'

const directory = mkdtempSync(join(tmpdir(), 'visslm-project-management-'))
const db = new AppDatabase(join(directory, 'projects.db'), join(directory, 'assets'))

try {
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
  assert.equal(db.listProjectAssets(project.id).some((item) => item.recordUid === 'smoke-record-1'), false)
  const availableAssetRecordsAfterUnlink = db.listRecords({ page: 1, pageSize: 20, excludeProjectAssetProjectId: project.id })
  assert.equal(availableAssetRecordsAfterUnlink.rows.some((row) => row.uid === 'smoke-record-1'), true)
  const unlinkedMatchPage = db.listLegacyProjectRequirementMatches({ requirementId: 'smoke-requirement-1', page: 1, pageSize: 20 })
  assert.equal(unlinkedMatchPage.rows[0]?.assetLinked, false)
  assert.equal(unlinkedMatchPage.rows[0]?.requirementLinked, false)
  const relinkedRequirementAsset = db.linkProjectAsset(project.id, 'smoke-record-1', 'smoke-requirement-1')
  assert(relinkedRequirementAsset)
  assert.equal(relinkedRequirementAsset.requirements.length, 1)
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
  assert.equal(snapshot.version, 1)
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
  const automaticPublish = service.reviewRequirements(['draft-semantic-requirement'], 'approved')
  assert.equal(automaticPublish.ok, true)
  assert.match(automaticPublish.message, /全部 1 条需求已通过/)
  assert.match(automaticPublish.message, /语义匹配任务已启动/)
  assert.equal(db.getReviewProjectRequirementSet(draftProject.id), null)
  for (let attempt = 0; attempt < 50 && db.getManagedProject(draftProject.id)?.matchStatus === 'processing'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const matchedDraftProject = db.getManagedProject(draftProject.id)
  assert(matchedDraftProject)
  assert.equal(matchedDraftProject.lifecycle, 'draft')
  assert.equal(matchedDraftProject.matchStatus, 'ready')
  const semanticQuery = semanticMatchQueries.at(-1) ?? ''
  assert.match(semanticQuery, /明确模块：订单管理/)
  assert.match(semanticQuery, /名称：订单明细导出/)
  assert.match(semanticQuery, /描述：系统应允许业务人员按时间范围筛选订单，并导出包含商品与金额的明细文件。/)

  const matchCallCountBeforeConfirm = semanticMatchQueries.length
  const confirmedDraftProject = service.confirmProject(draftProject.id)
  assert(confirmedDraftProject)
  assert.equal(confirmedDraftProject.lifecycle, 'active')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(semanticMatchQueries.length, matchCallCountBeforeConfirm)

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
