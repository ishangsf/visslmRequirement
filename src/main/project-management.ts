import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type {
  ManagedProject,
  ManagedProjectInput,
  ManagedProjectListQuery,
  OrganizationPerson,
  OrganizationPersonInput,
  OrganizationPersonListQuery,
  OrganizationPersonPage,
  ManagedProjectPage,
  ProjectAnalysisProgress,
  ProjectAnalysisStartResult,
  ProjectAsset,
  ProjectCostEntry,
  ProjectCostEntryInput,
  ProjectParticipant,
  ProjectParticipantInput,
  ProjectPlanTask,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectRequirement,
  ProjectRequirementMatchPage,
  ProjectRequirementMatchQuery,
  ProjectRequirementPage,
  ProjectRequirementQuery,
  ProjectRequirementStatus,
  ProjectDataSnapshot,
  ProjectDataTransferResult
} from '../shared/project-types'
import type { ModelSettings } from '../shared/types'
import { normalizeProjectRequirementText } from '../shared/project-requirement-utils'
import { AppDatabase } from './database'
import { KnowledgeService, type KnowledgeRecordMatch } from './knowledge'
import { ModelClient } from './model-client'

const supportedAgreementExtensions = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.txt'])

interface ExtractedProject {
  projectName?: string
  customerName?: string
  contractAmount?: number
  riskFactor?: number
  deliveryReminderDays?: number
  plannedDeliveryDate?: string
  salesOwner?: string
  technicalOwner?: string
  developmentOwner?: string
  estimatedCost?: number
  estimatedDurationDays?: number
}

interface ExtractedRequirement {
  module?: string
  title?: string
  content?: string
  keyInfoTerms?: string[]
  sourceLocation?: string
  sourceChunkId?: string
}

interface ExtractedAgreement {
  project?: ExtractedProject
  requirements?: ExtractedRequirement[]
}

interface MatchReview {
  status?: ProjectRequirementStatus
  reason?: string
  matches?: Array<{
    recordUid?: string
    score?: number
    reason?: string
  }>
}

export class ProjectManagementService {
  private readonly runningTasks = new Set<string>()

  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge: KnowledgeService,
    private readonly modelSettings: () => ModelSettings,
    private readonly progress?: (progress: ProjectAnalysisProgress) => void
  ) {}

  listProjects(query: ManagedProjectListQuery): ManagedProjectPage {
    return this.db.listManagedProjects(query)
  }

  getProject(id: string): ManagedProject | null {
    return this.db.getManagedProject(id)
  }

  markMatchesStale(): void {
    this.db.markManagedProjectMatchesStale()
  }

  createProject(input: ManagedProjectInput): ManagedProject {
    const normalized = this.normalizeProjectInput(input)
    if (!normalized.projectName) throw new Error('项目名称不能为空')
    return this.db.createManagedProject(randomUUID(), normalized)
  }

  updateProject(id: string, input: ManagedProjectInput): ManagedProject | null {
    const normalized = this.normalizeProjectInput(input)
    if (!normalized.projectName) throw new Error('项目名称不能为空')
    return this.db.updateManagedProject(id, normalized)
  }

  deleteProject(id: string): { ok: boolean; message: string } {
    const project = this.db.getManagedProject(id)
    if (project && (project.analysisStatus === 'processing' || project.matchStatus === 'processing')) {
      return { ok: false, message: '项目正在处理技术协议或匹配任务，请完成后再删除' }
    }
    return this.db.deleteManagedProject(id)
  }

  exportProjectData(id: string): ProjectDataSnapshot | null {
    return this.db.exportManagedProjectSnapshot(id)
  }

  importProjectData(payload: unknown): ProjectDataTransferResult {
    const snapshot = this.parseProjectDataSnapshot(payload)
    const result = this.db.importManagedProjectSnapshot(snapshot)
    return {
      ok: true,
      projectId: result.projectId,
      warningCount: result.warnings.length,
      warnings: result.warnings,
      message: result.warnings.length
        ? `项目已导入，部分关联数据已跳过（${result.warnings.length} 项）`
        : '项目完整数据已导入'
    }
  }

  discardProjectDraft(id: string): { ok: boolean; message: string } {
    return this.db.discardManagedProjectDraft(id)
  }

  confirmProject(id: string): ManagedProject | null {
    const project = this.db.confirmManagedProject(id)
    if (!project) return null
    if (project.requirementCount > 0 && project.matchStatus !== 'processing') {
      this.startMatching(id)
    }
    return this.db.getManagedProject(id)
  }

  async startTechnicalAgreement(
    filePath: string,
    projectId?: string
  ): Promise<ProjectAnalysisStartResult> {
    const extension = extname(filePath).toLocaleLowerCase()
    if (!supportedAgreementExtensions.has(extension)) {
      return { ok: false, message: `不支持的技术协议格式: ${extension || '无扩展名'}` }
    }
    let targetProject = projectId ? this.db.getManagedProject(projectId) : null
    if (projectId && !targetProject) return { ok: false, message: '项目不存在' }
    if (!targetProject) {
      const fileName = basename(filePath, extension).trim() || '未命名项目'
      targetProject = this.db.createManagedProject(randomUUID(), {
        projectName: fileName
      }, 'technical_agreement', 'draft')
    }

    const taskId = randomUUID()
    this.db.updateManagedProjectState(targetProject.id, {
      analysisStatus: 'processing',
      analysisMessage: '技术协议已加入处理队列',
      matchStatus: 'idle',
      matchMessage: ''
    })
    void this.runTechnicalAgreement(taskId, targetProject.id, filePath)
    return {
      ok: true,
      projectId: targetProject.id,
      taskId,
      message: '技术协议已加入处理队列'
    }
  }

  retryAnalysis(id: string): ProjectAnalysisStartResult {
    const project = this.db.getManagedProject(id)
    if (!project?.currentDocumentId) {
      return { ok: false, message: '项目没有可重试的技术协议' }
    }
    if (project.analysisStatus !== 'failed') {
      return { ok: false, message: '当前没有失败的技术协议识别任务' }
    }
    const document = this.db.getKnowledgeDocument(project.currentDocumentId)
    if (!document) return { ok: false, message: '技术协议索引不存在' }
    const taskId = randomUUID()
    this.db.clearProjectRequirements(id)
    this.db.updateManagedProjectState(id, {
      analysisStatus: 'processing',
      analysisMessage: '正在重新识别技术协议，旧功能需求已清除',
      matchStatus: 'idle',
      matchMessage: ''
    })
    void this.runDocumentAnalysis(taskId, id, document.id)
    return { ok: true, projectId: id, taskId, message: '技术协议已重新加入分析队列' }
  }

  startMatching(id: string): ProjectAnalysisStartResult {
    const project = this.db.getManagedProject(id)
    if (!project) return { ok: false, message: '项目不存在' }
    if (!project.requirementCount) return { ok: false, message: '当前项目没有可匹配的需求条目' }
    const taskId = randomUUID()
    this.db.updateManagedProjectState(id, {
      matchStatus: 'processing',
      matchMessage: '正在准备数据中心匹配'
    })
    void this.runMatching(taskId, id)
    return { ok: true, projectId: id, taskId, message: '匹配任务已启动' }
  }

  listRequirements(query: ProjectRequirementQuery): ProjectRequirementPage {
    return this.db.listProjectRequirements(query)
  }

  deleteRequirement(id: string): { ok: boolean; message: string } {
    return this.db.deleteProjectRequirement(id)
  }

  updateRequirementStatus(id: string, status: ProjectRequirementStatus): ProjectRequirement | null {
    return this.db.updateProjectRequirementStatus(id, status)
  }

  updateRequirementKeyInfoTerms(id: string, terms: string[]): ProjectRequirement | null {
    return this.db.updateProjectRequirementKeyInfoTerms(id, this.normalizeKeyInfoTerms(terms))
  }

  startRequirementMatching(id: string): ProjectAnalysisStartResult {
    const requirement = this.db.getProjectRequirement(id)
    if (!requirement) return { ok: false, message: '功能需求不存在' }
    const taskId = randomUUID()
    this.db.updateManagedProjectState(requirement.projectId, {
      matchStatus: 'processing',
      matchMessage: `正在重新匹配：${requirement.title}`
    })
    void this.runSingleRequirementMatching(taskId, requirement.projectId, requirement.id)
    return { ok: true, projectId: requirement.projectId, taskId, message: '该需求的匹配任务已启动' }
  }

  listMatches(query: ProjectRequirementMatchQuery): ProjectRequirementMatchPage {
    return this.db.listProjectRequirementMatches(query)
  }

  listCostEntries(projectId: string): ProjectCostEntry[] {
    return this.db.listProjectCostEntries(projectId)
  }

  addCostEntry(projectId: string, input: ProjectCostEntryInput): ProjectCostEntry {
    this.assertProject(projectId)
    this.assertCostInput(input)
    this.assertCostResponsibleParticipant(projectId, input.responsibleParticipantId)
    return this.db.insertProjectCostEntry(projectId, input)
  }

  updateCostEntry(id: string, input: ProjectCostEntryInput): ProjectCostEntry | null {
    this.assertCostInput(input)
    const current = this.db.getProjectCostEntry(id)
    if (!current) return null
    this.assertCostResponsibleParticipant(current.projectId, input.responsibleParticipantId)
    return this.db.updateProjectCostEntry(id, input)
  }

  deleteCostEntry(id: string): { ok: boolean; message: string } {
    return this.db.deleteProjectCostEntry(id)
  }

  listOrganizationPeople(query: OrganizationPersonListQuery): OrganizationPersonPage {
    return this.db.listOrganizationPeople(query)
  }

  createOrganizationPerson(input: OrganizationPersonInput): OrganizationPerson {
    const normalized = this.normalizeOrganizationPersonInput(input)
    if (!normalized.name) throw new Error('人员姓名不能为空')
    return this.db.createOrganizationPerson(normalized)
  }

  updateOrganizationPerson(id: string, input: OrganizationPersonInput): OrganizationPerson | null {
    const normalized = this.normalizeOrganizationPersonInput(input)
    if (!normalized.name) throw new Error('人员姓名不能为空')
    return this.db.updateOrganizationPerson(id, normalized)
  }

  deleteOrganizationPerson(id: string): { ok: boolean; message: string } {
    return this.db.deleteOrganizationPerson(id)
  }

  listProjectParticipants(projectId: string): ProjectParticipant[] {
    this.assertProject(projectId)
    return this.db.listProjectParticipants(projectId)
  }

  addProjectParticipant(projectId: string, input: ProjectParticipantInput): ProjectParticipant {
    this.assertProject(projectId)
    const normalized = this.normalizeProjectParticipantInput(input)
    this.assertPerson(normalized.personId)
    return this.db.insertProjectParticipant(projectId, normalized)
  }

  updateProjectParticipant(id: string, input: ProjectParticipantInput): ProjectParticipant | null {
    const normalized = this.normalizeProjectParticipantInput(input)
    this.assertPerson(normalized.personId)
    return this.db.updateProjectParticipant(id, normalized)
  }

  deleteProjectParticipant(id: string): { ok: boolean; message: string } {
    return this.db.deleteProjectParticipant(id)
  }

  listProjectTasks(projectId: string): ProjectPlanTask[] {
    this.assertProject(projectId)
    return this.db.listProjectTasks(projectId)
  }

  addProjectTask(projectId: string, input: ProjectPlanTaskInput): ProjectPlanTask {
    this.assertProject(projectId)
    const normalized = this.normalizeProjectTaskInput(input)
    if (normalized.parentTaskId) this.assertProjectTaskParent(projectId, normalized.parentTaskId)
    if (normalized.ownerPersonId) this.assertPerson(normalized.ownerPersonId)
    return this.db.insertProjectTask(projectId, normalized)
  }

  updateProjectTask(id: string, input: ProjectPlanTaskInput): ProjectPlanTask | null {
    const normalized = this.normalizeProjectTaskInput(input)
    const current = this.findProjectTask(id)
    if (!current) return null
    if (normalized.parentTaskId) this.assertProjectTaskParent(current.projectId, normalized.parentTaskId, id)
    if (normalized.ownerPersonId) this.assertPerson(normalized.ownerPersonId)
    return this.db.updateProjectTask(id, normalized)
  }

  moveProjectTask(id: string, input: ProjectPlanTaskMoveInput): ProjectPlanTask | null {
    const current = this.findProjectTask(id)
    if (!current) return null
    const parentTaskId = input.parentTaskId?.trim() || undefined
    if (parentTaskId) this.assertProjectTaskParent(current.projectId, parentTaskId, id)
    const sortOrder = Math.max(0, Math.trunc(Number(input.sortOrder ?? 0)))
    return this.db.moveProjectTask(id, { parentTaskId, sortOrder })
  }

  deleteProjectTask(id: string): { ok: boolean; message: string } {
    return this.db.deleteProjectTask(id)
  }

  listAssets(projectId: string): ProjectAsset[] {
    return this.db.listProjectAssets(projectId)
  }

  linkAsset(projectId: string, recordUid: string): ProjectAsset | null {
    this.assertProject(projectId)
    return this.db.linkProjectAsset(projectId, recordUid)
  }

  unlinkAsset(projectId: string, recordUid: string): { ok: boolean; message: string } {
    return this.db.unlinkProjectAsset(projectId, recordUid)
  }

  private normalizeProjectInput(input: ManagedProjectInput): ManagedProjectInput {
    return {
      projectName: input.projectName?.trim() ?? '',
      customerName: input.customerName?.trim() ?? '',
      contractAmount: Math.max(0, Number(input.contractAmount ?? 0)),
      riskFactor: Math.max(0, Number(input.riskFactor ?? 0)),
      deliveryReminderDays: Math.max(0, Math.trunc(Number(input.deliveryReminderDays ?? 0))),
      plannedDeliveryDate: input.plannedDeliveryDate?.trim() ?? '',
      salesOwner: input.salesOwner?.trim() ?? '',
      technicalOwner: input.technicalOwner?.trim() ?? '',
      developmentOwner: input.developmentOwner?.trim() ?? '',
      estimatedCost: Math.max(0, Number(input.estimatedCost ?? 0)),
      estimatedDurationDays: Math.max(0, Math.trunc(Number(input.estimatedDurationDays ?? 0)))
    }
  }

  private assertProject(id: string): void {
    if (!this.db.getManagedProject(id)) throw new Error('项目不存在')
  }

  private assertPerson(id: string): void {
    if (!this.db.getOrganizationPerson(id)) throw new Error('组织人员不存在')
  }

  private findProjectTask(id: string): ProjectPlanTask | null {
    return this.db.getProjectTask(id)
  }

  private assertProjectTaskParent(projectId: string, parentTaskId: string, currentTaskId?: string): void {
    const tasks = this.db.listProjectTasks(projectId)
    const taskMap = new Map(tasks.map((task) => [task.id, task]))
    if (!taskMap.has(parentTaskId)) throw new Error('所属父任务不存在或不属于当前项目')
    if (currentTaskId && parentTaskId === currentTaskId) throw new Error('任务不能将自己设置为父任务')
    const visited = new Set<string>()
    let cursor: string | undefined = parentTaskId
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      if (cursor === currentTaskId) throw new Error('任务不能挂载到自己的子任务下')
      cursor = taskMap.get(cursor)?.parentTaskId
    }
  }

  private normalizeOrganizationPersonInput(input: OrganizationPersonInput): OrganizationPersonInput {
    const hourlyRate = Number(input.hourlyRate ?? 0)
    if (!Number.isFinite(hourlyRate) || hourlyRate < 0) throw new Error('工时报价必须是非负数字')
    return {
      name: input.name?.trim() ?? '',
      employeeNo: input.employeeNo?.trim() ?? '',
      department: input.department?.trim() ?? '',
      role: input.role?.trim() ?? '',
      hourlyRate,
      status: input.status === 'inactive' ? 'inactive' : 'active',
      notes: input.notes?.trim() ?? ''
    }
  }

  private normalizeProjectParticipantInput(input: ProjectParticipantInput): ProjectParticipantInput {
    const personId = input.personId?.trim() ?? ''
    const startDate = input.startDate?.trim() ?? ''
    const endDate = input.endDate?.trim() ?? ''
    if (!personId) throw new Error('请选择项目参与人员')
    this.assertDateRange(startDate, endDate, '参与人员')
    return { personId, startDate, endDate, notes: input.notes?.trim() ?? '' }
  }

  private normalizeProjectTaskInput(input: ProjectPlanTaskInput): ProjectPlanTaskInput {
    const taskType = input.taskType
    if (!['milestone', 'phase', 'task'].includes(taskType)) throw new Error('计划任务类型无效')
    const title = input.title?.trim() ?? ''
    if (!title) throw new Error('任务名称不能为空')
    const startDate = input.startDate?.trim() ?? ''
    const endDate = input.endDate?.trim() ?? ''
    this.assertDateRange(startDate, endDate, '计划任务')
    const progressPercent = Number(input.progressPercent ?? 0)
    if (!Number.isFinite(progressPercent) || progressPercent < 0 || progressPercent > 100) {
      throw new Error('完成进度必须在 0 到 100 之间')
    }
    const validStatuses = ['not_started', 'in_progress', 'completed', 'blocked']
    if (input.status && !validStatuses.includes(input.status)) throw new Error('计划任务状态无效')
    return {
      taskType,
      title,
      description: input.description?.trim() ?? '',
      parentTaskId: input.parentTaskId?.trim() || undefined,
      startDate,
      endDate,
      ownerPersonId: input.ownerPersonId?.trim() || undefined,
      status: input.status ?? 'not_started',
      progressPercent,
      sortOrder: Math.max(0, Math.trunc(Number(input.sortOrder ?? 0)))
    }
  }

  private assertDateRange(startDate: string, endDate: string, label: string): void {
    const start = Date.parse(`${startDate}T00:00:00Z`)
    const end = Date.parse(`${endDate}T00:00:00Z`)
    if (!startDate || !endDate || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(`${label}开始和结束时间不能为空`)
    }
    if (end < start) throw new Error(`${label}结束时间不能早于开始时间`)
  }

  private assertCostInput(input: ProjectCostEntryInput): void {
    if (!['estimated', 'actual'].includes(input.type)) throw new Error('成本类型无效')
    if (!input.category?.trim()) throw new Error('成本分类不能为空')
    if (!Number.isFinite(Number(input.amount)) || Number(input.amount) < 0) {
      throw new Error('成本金额必须是非负数字')
    }
  }

  private assertCostResponsibleParticipant(projectId: string, participantId?: string): void {
    const normalizedId = participantId?.trim()
    if (!normalizedId) return
    if (!this.db.listProjectParticipants(projectId).some((participant) => participant.id === normalizedId)) {
      throw new Error('成本责任人必须是当前项目参与人')
    }
  }

  private async runTechnicalAgreement(taskId: string, projectId: string, filePath: string): Promise<void> {
    if (this.runningTasks.has(taskId)) return
    this.runningTasks.add(taskId)
    try {
      this.emit({ taskId, projectId, phase: 'queued', message: '正在处理技术协议', current: 0, total: 1, status: 'running' })
      this.emit({ taskId, projectId, phase: 'embedding', message: '正在解析并建立项目知识库索引', current: 0, total: 1, status: 'running' })
      const result = await this.knowledge.processFiles([filePath])
      const document = result.documents[0]
      if (!document || document.status !== 'ready') {
        throw new Error(document?.errorMessage || result.skipped[0]?.reason || '技术协议索引失败')
      }
      this.db.linkProjectDocument(projectId, document.id)
      await this.runDocumentAnalysis(taskId, projectId, document.id)
    } catch (error) {
      this.failProject(taskId, projectId, error)
    } finally {
      this.runningTasks.delete(taskId)
    }
  }

  private async runDocumentAnalysis(taskId: string, projectId: string, documentId: string): Promise<void> {
    try {
      const detail = this.db.getKnowledgeDocument(documentId)
      if (!detail || detail.status !== 'ready') throw new Error('技术协议尚未完成知识库索引')
      this.emit({ taskId, projectId, phase: 'extracting', message: '正在识别项目基本信息和功能需求', current: 0, total: 1, status: 'running' })
      const extracted = await this.extractAgreement(detail.chunks.map((chunk) => ({
        id: chunk.id,
        location: chunk.location,
        content: chunk.content
      })))
      const project = this.db.getManagedProject(projectId)
      if (!project) throw new Error('项目不存在')
      if (project.lifecycle === 'draft') {
        const fields = extracted.project ?? {}
        const merged = this.normalizeProjectInput({
          projectName: fields.projectName || project.projectName,
          customerName: fields.customerName || project.customerName,
          contractAmount: fields.contractAmount ?? project.contractAmount,
          riskFactor: fields.riskFactor ?? project.riskFactor,
          deliveryReminderDays: fields.deliveryReminderDays ?? project.deliveryReminderDays,
          plannedDeliveryDate: fields.plannedDeliveryDate || project.plannedDeliveryDate,
          salesOwner: fields.salesOwner || project.salesOwner,
          technicalOwner: fields.technicalOwner || project.technicalOwner,
          developmentOwner: fields.developmentOwner || project.developmentOwner,
          estimatedCost: project.estimatedCost,
          estimatedDurationDays: fields.estimatedDurationDays ?? project.estimatedDurationDays
        })
        this.db.updateManagedProject(projectId, merged)
        if (fields.estimatedCost !== undefined && project.estimatedCost <= 0 && fields.estimatedCost > 0) {
          this.db.insertProjectCostEntry(projectId, {
            type: 'estimated',
            category: '协议识别预估',
            description: '技术协议识别出的预计成本',
            amount: fields.estimatedCost,
            occurredAt: new Date().toISOString()
          })
        }
      }
      const requirements = this.normalizeRequirements(projectId, documentId, extracted.requirements ?? [])
      this.db.replaceProjectRequirements(projectId, documentId, requirements)
      this.db.updateManagedProjectState(projectId, {
        analysisStatus: 'ready',
        analysisMessage: `已识别 ${requirements.length} 条功能需求`,
        matchStatus: 'idle',
        matchMessage: '等待确认后开始匹配'
      })
      this.emit({ taskId, projectId, phase: 'done', message: `已识别 ${requirements.length} 条功能需求`, current: 1, total: 1, status: 'success' })
    } catch (error) {
      this.failProject(taskId, projectId, error)
    }
  }

  private normalizeRequirements(
    projectId: string,
    documentId: string,
    requirements: ExtractedRequirement[]
  ): Array<{
    id: string
    requirementNo: number
    module: string
    title: string
    content: string
    keyInfoTerms: string[]
    sourceLocation: string
    sourceChunkId: string
  }> {
    const seen = new Set<string>()
    const preparedRequirements = requirements.map((item) => {
      const normalized = normalizeProjectRequirementText(item)
      return { ...item, module: normalized.module, title: normalized.title, content: normalized.content }
    })
    const expandedRequirements = preparedRequirements.flatMap((item) => this.splitNumberedRequirement(item))
    let currentModule = ''
    return expandedRequirements.flatMap((item, index) => {
      const normalized = normalizeProjectRequirementText(item)
      const module = normalized.module || currentModule
      const title = normalized.title
      const content = normalized.content
      if (!title && !content) return []
      if (module) currentModule = module
      const finalTitle = title || `功能需求 ${index + 1}`
      const key = `${module}\n${finalTitle}\n${content}`.toLocaleLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      return [{
        id: randomUUID(),
        requirementNo: index + 1,
        module,
        title: finalTitle,
        content: content || finalTitle,
        keyInfoTerms: this.normalizeKeyInfoTerms(item.keyInfoTerms, finalTitle, content),
        sourceLocation: String(item.sourceLocation ?? '').trim(),
        sourceChunkId: String(item.sourceChunkId ?? '').trim()
      }]
    }).map((item, index) => ({ ...item, requirementNo: index + 1, projectId, documentId }))
      .map(({ projectId: _projectId, documentId: _documentId, ...item }) => item)
  }

  private splitNumberedRequirement(item: ExtractedRequirement): ExtractedRequirement[] {
    const title = String(item.title ?? '').trim()
    const content = String(item.content ?? '').trim()
    const source = content || title
    const markers = [...source.matchAll(/(?:^|[\s,，;；。:：])(?:(?:\(?\d{1,3}\s*[.．、:：)）])|(?:[（(]\d{1,3}[)）])|(?:[一二三四五六七八九十百千万]+\s*[、:：.．])|(?:[（(][一二三四五六七八九十百千万]+[)）])|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?!\d)(?=\S)/gu)]
    if (markers.length < 2) return [item]

    const parts = markers.map((marker, index) => {
      const markerStart = marker.index ?? 0
      const start = markerStart + marker[0].length
      const end = index + 1 < markers.length ? (markers[index + 1].index ?? source.length) : source.length
      const childContent = source.slice(start, end).trim().replace(/[；;]+$/g, '').trim()
      if (!childContent) return null
      const childTerms = Array.isArray(item.keyInfoTerms)
        ? item.keyInfoTerms.filter((term) => childContent.toLocaleLowerCase().includes(String(term).toLocaleLowerCase()))
        : []
      const childTitle = this.titleFromNumberedRequirement(childContent, title, index)
      const child: ExtractedRequirement = {
        module: item.module,
        sourceLocation: item.sourceLocation,
        sourceChunkId: item.sourceChunkId,
        title: childTitle,
        content: childContent
      }
      if (childTerms.length) child.keyInfoTerms = childTerms
      return child
    }).filter((part): part is ExtractedRequirement => part !== null)

    return parts.length > 1 ? parts : [item]
  }

  private titleFromNumberedRequirement(content: string, parentTitle: string, index: number): string {
    const firstSentence = content.split(/[。；;\n，,：:]/)[0]?.trim() ?? ''
    if (firstSentence.length >= 4 && firstSentence.length <= 40) return firstSentence
    return parentTitle ? `${parentTitle} · 第${index + 1}项` : `功能需求 ${index + 1}`
  }

  private async extractAgreement(
    chunks: Array<{ id: string; location: string; content: string }>
  ): Promise<ExtractedAgreement> {
    const source = chunks
      .map((chunk) => `[分块ID:${chunk.id}][位置:${chunk.location}]\n${chunk.content}`)
      .join('\n\n')
      .slice(0, 80_000)
    const systemPrompt = [
      '你是企业技术协议结构化分析器。只依据输入正文，不得补写正文没有出现的项目字段或需求。',
      '提取项目基本信息和功能需求，不要提取纯背景、商务条款、付款条款或泛泛描述。',
      '功能需求必须是可验证、可交付、可匹配的原子功能：一个需求只描述一个动作和一个业务对象。遇到同一段中的 1)、2)、3) 或多个并列动作必须拆成多条，不要把整章、整段或多个子功能合并成一条。',
      '遇到任何同级序号标识都必须严格分条输出：包括 1.、1)、1）、1、（1）、(1)、①，以及 一、/（一）等。序号后的每一项对应 requirements 数组中的一个独立元素；即使它们共享同一个章节标题，也绝对不能合并到同一条 content 中。',
      '单条 content 中不得同时出现两个及以上同级序号项；如果原文为“1) …；2) …；3) …”，必须输出 3 条需求记录。',
      '识别每条需求所在的最近章节或功能模块，并写入 module 字段，例如“2.1 整体要求”“2.2 项目策划”。同一章节下的多条需求必须复用相同 module；title 只写需求名称或功能动作，绝对不要把章节名称重复拼接到 title 前面。',
      '只提取正文明确提出的系统能力、用户操作、业务处理、查询、配置、统计、集成等功能；排除项目背景、建设目标、总体架构、技术选型、实施计划、培训服务、商务付款、泛化的性能/安全口号和非功能性描述。',
      '每条需求的 content 使用简洁的功能句，尽量不超过 160 字，不要复制无关上下文；并尽量返回对应分块ID和位置。',
      '为每条需求提取 keyInfoTerms：3-8 个用于数据中心匹配的关键功能信息词，只保留正文中出现的业务对象、动作、模块、接口/集成对象、指标或约束词；不要返回“系统、功能、支持、实现、能够、可以”等泛词，不要编造同义词。',
      '只输出一个完整且闭合的 JSON 对象，不要输出 Markdown、解释文字或思考过程。JSON 结构必须为：',
      '{"project":{"projectName":"","customerName":"","contractAmount":0,"riskFactor":0,"deliveryReminderDays":0,"plannedDeliveryDate":"","salesOwner":"","technicalOwner":"","developmentOwner":"","estimatedCost":0,"estimatedDurationDays":0},"requirements":[{"module":"","title":"","content":"","keyInfoTerms":[""],"sourceLocation":"","sourceChunkId":""}]}',
      '不确定的数字、日期和负责人字段使用空字符串或 null；requirements 没有可靠功能需求时返回空数组。'
    ].join('\n')
    const model = new ModelClient(this.modelSettings())
    const request = (strict: boolean): Promise<Awaited<ReturnType<ModelClient['chat']>>> => model.chat({
      messages: [
        {
          role: 'system',
          content: strict
            ? `${systemPrompt}\n这是格式重试：上一次输出不完整或无法解析。请减少文字，确保最后一个字段和所有括号都闭合后再结束。`
            : systemPrompt
        },
        { role: 'user', content: source }
      ],
      format: 'json',
      think: false,
      temperature: strict ? 0 : 0.1,
      numPredict: strict ? 12_000 : 8_192
    })
    let response = await request(false)
    let parsed = this.parseAgreementJson(response.message?.content ?? '')
    if (!parsed) {
      response = await request(true)
      parsed = this.parseAgreementJson(response.message?.content ?? '')
    }
    if (!parsed) {
      if (response.done_reason === 'length') {
        throw new Error('大模型输出被截断，已自动重试仍未完成，请减少协议内容后重试')
      }
      throw new Error('大模型返回的技术协议分析结果不是有效 JSON，已自动重试')
    }
    const value = parsed
    const project = value.project && typeof value.project === 'object'
      ? value.project as Record<string, unknown>
      : {}
    const requirements = Array.isArray(value.requirements)
      ? value.requirements.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : []
    return {
      project: {
        projectName: this.optionalString(project.projectName),
        customerName: this.optionalString(project.customerName),
        contractAmount: this.optionalNumber(project.contractAmount),
        riskFactor: this.optionalNumber(project.riskFactor),
        deliveryReminderDays: this.optionalNumber(project.deliveryReminderDays),
        plannedDeliveryDate: this.optionalString(project.plannedDeliveryDate),
        salesOwner: this.optionalString(project.salesOwner),
        technicalOwner: this.optionalString(project.technicalOwner),
        developmentOwner: this.optionalString(project.developmentOwner),
        estimatedCost: this.optionalNumber(project.estimatedCost),
        estimatedDurationDays: this.optionalNumber(project.estimatedDurationDays)
      },
      requirements: requirements.map((item) => ({
        module: this.optionalString(item.module),
        title: this.optionalString(item.title),
        content: this.optionalString(item.content),
        keyInfoTerms: Array.isArray(item.keyInfoTerms)
          ? item.keyInfoTerms.map((term) => this.optionalString(term)).filter((term): term is string => Boolean(term))
          : undefined,
        sourceLocation: this.optionalString(item.sourceLocation),
        sourceChunkId: this.optionalString(item.sourceChunkId)
      }))
    }
  }

  private parseAgreementJson(content: string): Record<string, unknown> | null {
    const cleaned = content
      .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
      .replace(/```(?:json)?/gi, '')
      .replace(/```/g, '')
      .trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const candidate = cleaned.slice(start, end + 1)
    for (const value of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(value) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>
        }
      } catch {
        // Try the next cleaned candidate before reporting a model failure.
      }
    }
    return null
  }

  private async runMatching(taskId: string, projectId: string): Promise<void> {
    try {
      const requirements = this.db.listAllProjectRequirements(projectId)
      for (let index = 0; index < requirements.length; index += 1) {
        const requirement = requirements[index]
        this.emit({
          taskId,
          projectId,
          phase: 'matching',
          message: `正在匹配第 ${index + 1}/${requirements.length} 条需求`,
          current: index,
          total: requirements.length,
          status: 'running'
        })
        await this.matchSingleRequirement(requirement)
      }
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'ready',
        matchMessage: `已完成 ${requirements.length} 条需求匹配`
      })
      this.emit({ taskId, projectId, phase: 'done', message: '技术协议需求匹配完成', current: requirements.length, total: requirements.length, status: 'success' })
    } catch (error) {
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'failed',
        matchMessage: error instanceof Error ? error.message : String(error)
      })
      this.emit({ taskId, projectId, phase: 'error', message: error instanceof Error ? error.message : String(error), current: 0, total: 0, status: 'failed' })
    }
  }

  private async runSingleRequirementMatching(taskId: string, projectId: string, requirementId: string): Promise<void> {
    try {
      const requirement = this.db.getProjectRequirement(requirementId)
      if (!requirement || requirement.projectId !== projectId) throw new Error('功能需求不存在')
      this.emit({
        taskId,
        projectId,
        phase: 'matching',
        message: `正在重新匹配：${requirement.title}`,
        current: 0,
        total: 1,
        status: 'running'
      })
      await this.matchSingleRequirement(requirement)
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'ready',
        matchMessage: `已完成「${requirement.title}」的匹配`
      })
      this.emit({ taskId, projectId, phase: 'done', message: '功能需求匹配完成', current: 1, total: 1, status: 'success' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'failed',
        matchMessage: message
      })
      this.emit({ taskId, projectId, phase: 'error', message, current: 0, total: 1, status: 'failed' })
    }
  }

  private async matchSingleRequirement(requirement: ProjectRequirement): Promise<void> {
    const matchingQuery = this.buildRequirementMatchQuery(requirement)
    const vectorMatches = await this.knowledge.rankRecordMatches(matchingQuery)
    const reviewed = await this.reviewMatches(matchingQuery, vectorMatches.slice(0, 20))
    const reviewByRecord = new Map(
      (reviewed.matches ?? [])
        .filter((item) => item.recordUid)
        .map((item) => [String(item.recordUid), item])
    )
    const matches = vectorMatches.map((match) => {
      const review = reviewByRecord.get(match.recordUid)
      const aiScore = review?.score === undefined ? undefined : this.clampScore(review.score)
      return {
        recordUid: match.recordUid,
        vectorScore: this.clampScore(match.score),
        ...(aiScore === undefined ? {} : { aiScore }),
        finalScore: aiScore ?? this.clampScore(match.score),
        scoreSource: aiScore === undefined ? 'vector' as const : 'ai' as const,
        reason: review?.reason?.trim() ?? '',
        bestChunkId: match.chunkId
      }
    })
    this.db.replaceRequirementMatches(requirement.id, matches)
    const highestMatchScore = matches.reduce((value, item) => Math.max(value, item.finalScore), 0)
    const scoreThreshold = 80
    const aiStatus: ProjectRequirementStatus = reviewed.status === 'satisfied' && highestMatchScore >= scoreThreshold
      ? 'satisfied'
      : 'unmarked'
    const aiReason = aiStatus === 'satisfied'
      ? reviewed.reason?.trim() || `最高匹配度 ${highestMatchScore.toFixed(1)}%，AI 初判为已满足`
      : highestMatchScore > 0
        ? `最高匹配度 ${highestMatchScore.toFixed(1)}% 未达到已满足阈值 ${scoreThreshold}%，待人工标记`
        : reviewed.reason?.trim() || '当前没有足够匹配依据，待人工标记'
    this.db.updateProjectRequirementAiStatus(requirement.id, aiStatus, aiReason)
  }

  private buildRequirementMatchQuery(requirement: ProjectRequirement): string {
    const terms = this.normalizeKeyInfoTerms(requirement.keyInfoTerms)
    if (terms.length) return terms.join(' ')
    return requirement.title.trim() || requirement.content.trim().slice(0, 120)
  }

  private async reviewMatches(requirement: string, candidates: KnowledgeRecordMatch[]): Promise<MatchReview> {
    if (!candidates.length) return { status: 'unmarked', reason: '数据中心没有可用的向量匹配记录', matches: [] }
    try {
      const response = await new ModelClient(this.modelSettings()).chat({
        messages: [
          {
            role: 'system',
            content: [
              '你是技术需求与数据资产匹配评审器。输入中的 requirement 是经过人工或 AI 提取的关键功能信息词，不是完整协议正文；只依据这些词和候选记录进行判断。',
              '为每个候选记录给出 0 到 100 的匹配分数和简短理由，不能虚构候选记录字段。',
              '同时给出需求整体状态：satisfied 仅表示已有数据明确支持；unmarked 表示匹配度不足、无法确认满足或需要人工标记。AI 不要输出 to_develop 或 to_negotiate，这两个状态只由用户手动标记。',
              '只输出 JSON：{"status":"satisfied|unmarked","reason":"","matches":[{"recordUid":"","score":0,"reason":""}]}'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify({ keyInfoTerms: requirement.split(/\s+/).filter(Boolean), candidates })
          }
        ],
        format: 'json',
        think: false,
        temperature: 0.1,
        numPredict: 2048
      })
      const content = response.message?.content?.trim() ?? ''
      const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as Record<string, unknown>
      const status = ['satisfied', 'unmarked'].includes(String(parsed.status))
        ? String(parsed.status) as ProjectRequirementStatus
        : undefined
      const matches = Array.isArray(parsed.matches)
        ? parsed.matches.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map((item) => ({
          recordUid: this.optionalString(item.recordUid),
          score: this.optionalNumber(item.score),
          reason: this.optionalString(item.reason)
        }))
        : []
      return { status, reason: this.optionalString(parsed.reason), matches }
    } catch {
      return { status: 'unmarked', reason: '大模型复核不可用，当前展示向量匹配结果，待人工标记', matches: [] }
    }
  }

  private failProject(taskId: string, projectId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.db.updateManagedProjectState(projectId, {
      analysisStatus: 'failed',
      analysisMessage: message
    })
    this.emit({ taskId, projectId, phase: 'error', message, current: 0, total: 0, status: 'failed' })
  }

  private emit(progress: ProjectAnalysisProgress): void {
    this.progress?.(progress)
  }

  private clampScore(value: number): number {
    return Number(Math.min(100, Math.max(0, Number(value) || 0)).toFixed(2))
  }

  private normalizeKeyInfoTerms(values: unknown, title = '', _content = ''): string[] {
    const explicit = Array.isArray(values)
    const source = explicit ? values : [title]
    const genericTerms = new Set(['系统', '功能', '功能需求', '支持', '实现', '能够', '可以', '应当', '提供'])
    const terms = (source as unknown[])
      .flatMap((value) => String(value ?? '').split(/[，,、；;\n]+/))
      .map((value) => value.replace(/^[\d.、)）(（\s]+|[。.!！?？]+$/g, '').trim())
      .filter((value) => value.length >= 2 && value.length <= 32 && !genericTerms.has(value))
    const unique = [...new Set(terms)]
    return unique.slice(0, 12)
  }

  private parseProjectDataSnapshot(payload: unknown): ProjectDataSnapshot {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('项目数据文件内容无效')
    }
    const value = payload as Record<string, unknown>
    if (value.format !== 'visslm-project' || value.version !== 1) {
      throw new Error('项目数据文件格式或版本不受支持')
    }
    const project = value.project
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('项目数据文件缺少项目基本信息')
    }
    const projectRecord = project as Record<string, unknown>
    if (!this.optionalString(projectRecord.projectName)) {
      throw new Error('项目数据文件缺少项目名称')
    }
    for (const field of ['documents', 'people', 'participants', 'costs', 'assets', 'tasks', 'requirements', 'matches']) {
      if (!Array.isArray(value[field])) throw new Error(`项目数据文件缺少有效的 ${field} 数据`)
    }
    return value as unknown as ProjectDataSnapshot
  }

  private optionalString(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined
    const text = String(value).trim()
    return text || undefined
  }

  private optionalNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
}
