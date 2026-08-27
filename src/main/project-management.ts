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
  ProjectAnalysisLogEntry,
  ManagedProjectPage,
  ProjectAnalysisProgress,
  ProjectAnalysisStartResult,
  ProjectAgreementUploadOptions,
  ProjectAsset,
  ProjectCostEntry,
  ProjectCostEntryInput,
  ProjectParticipant,
  ProjectParticipantInput,
  ProjectPlanTask,
  ProjectPlanTaskInput,
  ProjectPlanTaskMoveInput,
  ProjectRequirement,
  ProjectRequirementCategory,
  ProjectRequirementInput,
  ProjectRequirementMergeInput,
  ProjectRequirementMatchPage,
  ProjectRequirementMatchQuery,
  ProjectRequirementPage,
  ProjectRequirementQuery,
  ProjectRequirementReviewStatus,
  ProjectRequirementSetSummary,
  ProjectRequirementSplitInput,
  ProjectRequirementStatus,
  ProjectDataSnapshot,
  ProjectDataTransferResult,
  ProjectDocumentSnapshot
} from '../shared/project-types'
import {
  DEFAULT_PROJECT_MATCHING_SETTINGS,
  normalizeProjectMatchScore
} from '../shared/types'
import type { KnowledgeIndexProgress, ModelSettings, ProjectMatchingSettings } from '../shared/types'
import { normalizeProjectRequirementText } from '../shared/project-requirement-utils'
import { AppDatabase } from './database'
import { KnowledgeService, type KnowledgeRecordMatch } from './knowledge'
import { ModelClient } from './model-client'

const supportedAgreementExtensions = new Set(['.docx', '.pdf', '.xlsx', '.xls', '.txt'])
// Keep local-model requests small enough that a slow CPU model can finish
// before the shared 180-second request timeout. Each completed batch is still
// checkpointed, so smaller batches do not trade away recoverability.
const extractionBatchMaxChars = 2_000
const extractionSplitChunkMaxChars = 600
const extractionOutputMaxTokens = 6_000
const extractionStrictOutputMaxTokens = 8_000
const extractionCompactOutputMaxTokens = 4_000
const requirementCategories = new Set<ProjectRequirementCategory>([
  'functional', 'interface', 'data', 'performance', 'security',
  'deployment', 'operations', 'acceptance', 'business'
])

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
  category?: ProjectRequirementCategory
  module?: string
  title?: string
  content?: string
  keyInfoTerms?: string[]
  sourceLocation?: string
  sourceChunkId?: string
  sourceDocumentId?: string
  evidenceQuote?: string
  confidence?: number
}

export interface AgreementExtractionChunk {
  id: string
  documentId: string
  location: string
  content: string
  normalizedContent?: string
}

export interface AgreementRequirementSourceInput {
  title?: string
  content?: string
  sourceChunkId?: string
  evidenceQuote?: string
  confidence?: number
}

export type AgreementSourceValidationStatus = 'verified' | 'corrected' | 'inferred' | 'unverified'

export interface AgreementRequirementSourceResult {
  status: AgreementSourceValidationStatus
  sourceChunkId: string
  sourceDocumentId: string
  sourceLocation: string
  evidenceQuote: string
  confidence: number
}

const estimateAgreementChunkChars = (chunk: AgreementExtractionChunk): number =>
  chunk.id.length + chunk.location.length + chunk.content.length + 80

export const buildAgreementExtractionBatches = (
  chunks: AgreementExtractionChunk[],
  maxChars = extractionBatchMaxChars
): AgreementExtractionChunk[][] => {
  const safeMaxChars = Math.max(800, Math.floor(maxChars))
  const batches: AgreementExtractionChunk[][] = []
  let currentBatch: AgreementExtractionChunk[] = []
  let currentLength = 0
  for (const chunk of chunks) {
    const size = estimateAgreementChunkChars(chunk)
    if (currentBatch.length && currentLength + size > safeMaxChars) {
      batches.push(currentBatch)
      currentBatch = []
      currentLength = 0
    }
    currentBatch.push(chunk)
    currentLength += size
  }
  if (currentBatch.length) batches.push(currentBatch)
  return batches
}

const normalizeAgreementText = (value: string): string => value.replace(/[\s\u200B-\u200D\uFEFF]+/g, '')

const normalizeAgreementMatchText = (value: string): string =>
  normalizeAgreementText(value).replace(/[\p{P}\p{S}]+/gu, '')

const agreementBigramRecall = (query: string, source: string): number => {
  if (query.length < 2 || source.length < 2) return 0
  const queryBigrams = new Set<string>()
  for (let index = 0; index < query.length - 1; index += 1) {
    queryBigrams.add(query.slice(index, index + 2))
  }
  if (!queryBigrams.size) return 0
  let matched = 0
  for (const bigram of queryBigrams) {
    if (source.includes(bigram)) matched += 1
  }
  return matched / queryBigrams.size
}

const agreementLongestCommonSubstring = (left: string, right: string): number => {
  if (!left || !right) return 0
  let previous = new Array<number>(right.length + 1).fill(0)
  let longest = 0
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = new Array<number>(right.length + 1).fill(0)
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        current[rightIndex] = previous[rightIndex - 1] + 1
        longest = Math.max(longest, current[rightIndex])
      }
    }
    previous = current
  }
  return longest
}

type AgreementFuzzySourceMatch = {
  chunk: AgreementExtractionChunk
  evidenceQuote: string
}

const findAgreementFuzzySource = (
  text: string,
  candidates: AgreementExtractionChunk[]
): AgreementFuzzySourceMatch | undefined => {
  const query = normalizeAgreementMatchText(text)
  if (query.length < 24) return undefined
  const ranked = candidates.map((chunk) => {
    const source = normalizeAgreementMatchText(chunk.content)
    const recall = agreementBigramRecall(query, source)
    const commonLength = agreementLongestCommonSubstring(query, source)
    return {
      chunk,
      recall,
      commonRatio: commonLength / query.length
    }
  }).sort((left, right) =>
    right.recall - left.recall || right.commonRatio - left.commonRatio
  )
  const best = ranked[0]
  if (!best || best.recall < 0.84 || best.commonRatio < 0.25) return undefined
  const runnerUp = ranked[1]
  if (runnerUp && best.recall < 0.92 && best.recall - runnerUp.recall < 0.04) return undefined
  return {
    chunk: best.chunk,
    evidenceQuote: best.chunk.content.trim().slice(0, 1000)
  }
}

const clampAgreementConfidence = (value: unknown, fallback = 0.7): number => {
  const numeric = Number(value ?? fallback)
  return Number.isFinite(numeric) ? Math.max(0, Math.min(1, numeric)) : fallback
}

export const resolveAgreementRequirementSource = (
  requirement: AgreementRequirementSourceInput,
  chunks: AgreementExtractionChunk[]
): AgreementRequirementSourceResult => {
  const requestedChunkId = String(requirement.sourceChunkId ?? '').trim()
  const requestedChunkIndex = chunks.findIndex((chunk) => chunk.id === requestedChunkId)
  const requestedChunk = requestedChunkIndex >= 0 ? chunks[requestedChunkIndex] : undefined
  const requestedDocumentId = requestedChunk?.documentId ?? ''
  const adjacentChunks = requestedChunk
    ? [-1, 1]
      .map((offset) => chunks[requestedChunkIndex + offset])
      .filter((chunk): chunk is AgreementExtractionChunk => Boolean(chunk) && chunk.documentId === requestedDocumentId)
    : []
  const orderedChunks: AgreementExtractionChunk[] = requestedChunk
    ? [
        requestedChunk,
        ...adjacentChunks,
        ...chunks.filter((chunk) => chunk.documentId === requestedDocumentId && chunk.id !== requestedChunkId),
        ...chunks.filter((_chunk, index) =>
          _chunk.documentId !== requestedDocumentId &&
          index !== requestedChunkIndex &&
          index !== requestedChunkIndex - 1 &&
          index !== requestedChunkIndex + 1
        )
      ]
    : chunks
  const requestedEvidence = String(requirement.evidenceQuote ?? '').trim().slice(0, 1000)
  const normalizedEvidence = normalizeAgreementText(requestedEvidence)
  const sourceCandidates = requestedDocumentId
    ? orderedChunks.filter((chunk) => chunk.documentId === requestedDocumentId)
    : orderedChunks
  const sourceFor = (text: string): AgreementExtractionChunk | undefined => {
    const normalizedText = normalizeAgreementText(text)
    if (!normalizedText) return undefined
    const matches = orderedChunks.filter((chunk) =>
      (chunk.normalizedContent ?? normalizeAgreementText(chunk.content)).includes(normalizedText)
    )
    if (!matches.length) return undefined
    if (requestedDocumentId) return matches.find((chunk) => chunk.documentId === requestedDocumentId)
    const documentIds = new Set(matches.map((chunk) => chunk.documentId))
    return documentIds.size === 1 ? matches[0] : undefined
  }
  const fuzzySourceFor = (text: string): AgreementFuzzySourceMatch | undefined => {
    const exactChunk = sourceFor(text)
    if (exactChunk) return { chunk: exactChunk, evidenceQuote: exactChunk.content.trim().slice(0, 1000) }
    return findAgreementFuzzySource(text, sourceCandidates)
  }
  const evidenceChunk = normalizedEvidence
    ? requestedChunk && (requestedChunk.normalizedContent ?? normalizeAgreementText(requestedChunk.content)).includes(normalizedEvidence)
      ? requestedChunk
      : sourceFor(requestedEvidence)
    : undefined
  const fuzzyEvidence = normalizedEvidence && !evidenceChunk
    ? findAgreementFuzzySource(requestedEvidence, sourceCandidates)
    : undefined
  if (evidenceChunk || fuzzyEvidence) {
    const resolvedChunk = evidenceChunk ?? fuzzyEvidence!.chunk
    const corrected = resolvedChunk.id !== requestedChunkId
    const confidence = corrected
      ? Math.min(clampAgreementConfidence(requirement.confidence), 0.75)
      : clampAgreementConfidence(requirement.confidence)
    return {
      status: corrected ? 'corrected' : 'verified',
      sourceChunkId: resolvedChunk.id,
      sourceDocumentId: resolvedChunk.documentId,
      sourceLocation: resolvedChunk.location,
      evidenceQuote: fuzzyEvidence?.evidenceQuote ?? requestedEvidence,
      confidence
    }
  }

  const content = String(requirement.content ?? '').trim()
  const contentChunk = content ? sourceFor(content) : undefined
  const fuzzyContent = content && !contentChunk ? fuzzySourceFor(content) : undefined
  if (contentChunk || fuzzyContent) {
    const resolvedChunk = contentChunk ?? fuzzyContent!.chunk
    return {
      status: 'inferred',
      sourceChunkId: resolvedChunk.id,
      sourceDocumentId: resolvedChunk.documentId,
      sourceLocation: resolvedChunk.location,
      evidenceQuote: fuzzyContent?.evidenceQuote ?? content.slice(0, 1000),
      confidence: Math.min(clampAgreementConfidence(requirement.confidence), 0.7)
    }
  }

  return {
    status: 'unverified',
    sourceChunkId: '',
    sourceDocumentId: '',
    sourceLocation: '',
    evidenceQuote: '',
    confidence: Math.min(clampAgreementConfidence(requirement.confidence), 0.35)
  }
}

interface ExtractedAgreement {
  project?: ExtractedProject
  requirements?: ExtractedRequirement[]
}

interface AgreementExtractionResult {
  agreement: ExtractedAgreement
  warnings: string[]
  analyzedChunks: number
}

type AgreementExtractionEventMetadata = Partial<Pick<
  ProjectAnalysisProgress,
  'logKind' | 'requestId' | 'batchNumber' | 'attempt' | 'elapsedMs' | 'inputChars' |
  'outputChars' | 'doneReason' | 'modelName' | 'status'
>>

type AgreementExtractionEvent = (
  message: string,
  detail?: string,
  metadata?: AgreementExtractionEventMetadata
) => void

type AgreementExtractionCheckpoint = (
  agreement: ExtractedAgreement,
  warnings: string[],
  analyzedChunks: number
) => void

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
  private readonly runningProjectIds = new Set<string>()

  constructor(
    private readonly db: AppDatabase,
    private readonly knowledge: KnowledgeService,
    private readonly modelSettings: () => ModelSettings,
    private readonly progress?: (progress: ProjectAnalysisProgress) => void,
    private readonly projectMatchingSettings: () => ProjectMatchingSettings = () => DEFAULT_PROJECT_MATCHING_SETTINGS
  ) {
    this.db.reconcileInterruptedProjectAnalysis()
  }

  listProjects(query: ManagedProjectListQuery): ManagedProjectPage {
    return this.db.listManagedProjects(query)
  }

  getProject(id: string): ManagedProject | null {
    return this.db.getManagedProject(id)
  }

  listProjectDocuments(id: string): ProjectDocumentSnapshot[] {
    return this.db.listManagedProjectDocuments(id)
  }

  listAnalysisLogs(id: string, limit = 2000): ProjectAnalysisLogEntry[] {
    return this.db.listProjectAnalysisLogs(id, limit)
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
    if (project.requirementCount > 0 && ['idle', 'stale', 'failed'].includes(project.matchStatus)) {
      this.startMatching(id)
    }
    return this.db.getManagedProject(id)
  }

  async startTechnicalAgreement(
    filePaths: string | string[],
    projectId?: string,
    options: ProjectAgreementUploadOptions = {}
  ): Promise<ProjectAnalysisStartResult> {
    const paths = [...new Set((Array.isArray(filePaths) ? filePaths : [filePaths])
      .map((filePath) => String(filePath ?? '').trim())
      .filter(Boolean))]
    if (!paths.length) return { ok: false, message: '请选择技术协议文件' }
    for (const filePath of paths) {
      const extension = extname(filePath).toLocaleLowerCase()
      if (!supportedAgreementExtensions.has(extension)) {
        return { ok: false, message: `不支持的技术协议格式: ${extension || '无扩展名'}` }
      }
    }
    const settings = this.modelSettings()
    if (settings.source === 'online' && !options.allowExternalProcessing) {
      return { ok: false, message: '当前配置为在线模型，必须确认协议外发后才能解析' }
    }
    let targetProject = projectId ? this.db.getManagedProject(projectId) : null
    if (projectId && !targetProject) return { ok: false, message: '项目不存在' }
    if (!targetProject) {
      const extension = extname(paths[0]).toLocaleLowerCase()
      const fileName = basename(paths[0], extension).trim() || '未命名项目'
      targetProject = this.db.createManagedProject(randomUUID(), {
        projectName: fileName
      }, 'technical_agreement', 'draft')
    }
    if (this.runningProjectIds.has(targetProject.id) || targetProject.analysisStatus === 'processing') {
      return { ok: false, projectId: targetProject.id, message: '该项目已有协议解析任务正在运行' }
    }

    const taskId = randomUUID()
    this.runningProjectIds.add(targetProject.id)
    this.db.updateManagedProjectState(targetProject.id, {
      analysisStatus: 'processing',
      analysisMessage: '技术协议已加入处理队列',
      matchStatus: 'idle',
      matchMessage: ''
    })
    void this.runTechnicalAgreement(taskId, targetProject.id, paths, settings.source === 'online')
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
    if (this.runningProjectIds.has(id)) return { ok: false, projectId: id, message: '该项目已有任务正在运行' }
    const settings = this.modelSettings()
    if (settings.source === 'online') {
      return { ok: false, projectId: id, message: '在线模型重试需要重新上传并确认本次协议外发' }
    }
    this.db.updateManagedProjectState(id, {
      analysisStatus: 'processing',
      analysisMessage: document.status === 'ready'
        ? '正在重新识别技术协议，已发布需求将继续保留'
        : '正在重新建立协议索引，已发布需求将继续保留',
      matchStatus: 'idle',
      matchMessage: ''
    })
    this.runningProjectIds.add(id)
    void (document.status === 'ready'
      ? this.runDocumentAnalysis(taskId, id, [document.id], false)
      : this.runDocumentRetry(taskId, id, document.id))
    return { ok: true, projectId: id, taskId, message: '技术协议已重新加入分析队列' }
  }

  startMatching(id: string): ProjectAnalysisStartResult {
    const project = this.db.getManagedProject(id)
    if (!project) return { ok: false, message: '项目不存在' }
    if (!project.requirementCount) return { ok: false, message: '当前项目没有可匹配的需求条目' }
    if (project.reviewSetId) return { ok: false, message: '存在未发布的需求审核版本，请先完成审核并发布' }
    if (this.runningProjectIds.has(id)) return { ok: false, projectId: id, message: '该项目已有任务正在运行' }
    const taskId = randomUUID()
    this.runningProjectIds.add(id)
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

  listAllRequirements(projectId: string): ProjectRequirement[] {
    this.assertProject(projectId)
    return this.db.listAllProjectRequirements(projectId, 'active')
  }

  getRequirement(id: string): ProjectRequirement | null {
    return this.db.getProjectRequirement(id)
  }

  getRequirementSet(projectId: string): ProjectRequirementSetSummary | null {
    return this.db.getReviewProjectRequirementSet(projectId)
  }

  createRequirement(projectId: string, input: ProjectRequirementInput): ProjectRequirement {
    this.assertProject(projectId)
    return this.db.createReviewProjectRequirement(projectId, this.normalizeRequirementInput(input))
  }

  updateRequirement(id: string, input: ProjectRequirementInput): ProjectRequirement | null {
    return this.db.updateReviewProjectRequirement(id, this.normalizeRequirementInput(input))
  }

  splitRequirement(id: string, input: ProjectRequirementSplitInput): ProjectRequirement[] {
    if (!Array.isArray(input.parts) || input.parts.length < 2) throw new Error('拆分后至少需要两条需求')
    return this.db.splitReviewProjectRequirement(id, {
      parts: input.parts.map((part) => this.normalizeRequirementInput(part))
    })
  }

  mergeRequirements(input: ProjectRequirementMergeInput): ProjectRequirement | null {
    return this.db.mergeReviewProjectRequirements({
      ...this.normalizeRequirementInput(input),
      requirementIds: input.requirementIds
    })
  }

  reviewRequirements(ids: string[], status: ProjectRequirementReviewStatus): { ok: boolean; message: string } {
    if (!['pending', 'approved', 'rejected'].includes(status)) return { ok: false, message: '审核状态无效' }
    const projectIds = [...new Set(ids
      .map((id) => this.db.getProjectRequirement(id)?.projectId)
      .filter((projectId): projectId is string => Boolean(projectId)))]
    const count = this.db.reviewProjectRequirements(ids, status)
    if (!count) return { ok: false, message: '没有可更新的待审核需求' }

    if (status === 'approved') {
      for (const projectId of projectIds) {
        const set = this.db.getReviewProjectRequirementSet(projectId)
        if (!set) continue
        const allApproved = set.requirementCount > 0 && set.pendingCount === 0 &&
          set.rejectedCount === 0 && set.approvedCount === set.requirementCount
        if (!allApproved) continue
        const published = this.publishRequirements(projectId)
        return {
          ok: published.ok,
          message: published.ok
            ? `全部 ${set.approvedCount} 条需求已通过，${published.message}`
            : published.message
        }
      }
    }
    return { ok: true, message: `已更新 ${count} 条需求的审核状态` }
  }

  publishRequirements(projectId: string): ProjectAnalysisStartResult {
    const set = this.db.publishReviewProjectRequirementSet(projectId)
    const matching = this.startMatching(projectId)
    return matching.ok
      ? { ...matching, message: `需求 V${set.version} 已自动发布，语义匹配任务已启动` }
      : { ok: true, projectId, message: `需求 V${set.version} 已发布；${matching.message}` }
  }

  deleteRequirement(id: string): { ok: boolean; message: string } {
    const requirement = this.db.getProjectRequirement(id)
    const reviewSet = requirement ? this.db.getReviewProjectRequirementSet(requirement.projectId) : null
    if (!requirement || !reviewSet || requirement.setId !== reviewSet.id) {
      return { ok: false, message: '已发布需求不能直接删除，请通过新协议版本变更' }
    }
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
    const project = this.db.getManagedProject(requirement.projectId)
    if (project?.reviewSetId) return { ok: false, message: '待审核需求不能启动匹配' }
    if (this.runningProjectIds.has(requirement.projectId)) return { ok: false, message: '该项目已有任务正在运行' }
    const taskId = randomUUID()
    this.runningProjectIds.add(requirement.projectId)
    this.db.updateManagedProjectState(requirement.projectId, {
      matchStatus: 'processing',
      matchMessage: `正在重新匹配：${requirement.title}`
    })
    void this.runSingleRequirementMatching(taskId, requirement.projectId, requirement.id)
    return { ok: true, projectId: requirement.projectId, taskId, message: '该需求的匹配任务已启动' }
  }

  listMatches(query: ProjectRequirementMatchQuery): ProjectRequirementMatchPage {
    return this.db.listProjectRequirementMatches({
      ...query,
      minScore: normalizeProjectMatchScore(this.projectMatchingSettings().minScore)
    })
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
    this.assertProjectTaskRequirements(projectId, normalized.requirementIds ?? [])
    return this.db.insertProjectTask(projectId, normalized)
  }

  updateProjectTask(id: string, input: ProjectPlanTaskInput): ProjectPlanTask | null {
    const normalized = this.normalizeProjectTaskInput(input)
    const current = this.findProjectTask(id)
    if (!current) return null
    if (normalized.parentTaskId) this.assertProjectTaskParent(current.projectId, normalized.parentTaskId, id)
    if (normalized.ownerPersonId) this.assertPerson(normalized.ownerPersonId)
    this.assertProjectTaskRequirements(current.projectId, normalized.requirementIds ?? [])
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

  linkAsset(projectId: string, recordUid: string, requirementId?: string): ProjectAsset | null {
    this.assertProject(projectId)
    const normalizedRequirementId = requirementId?.trim()
    if (normalizedRequirementId) {
      const requirement = this.db.getProjectRequirement(normalizedRequirementId)
      if (!requirement || requirement.projectId !== projectId) {
        throw new Error('需求条目不存在或不属于当前项目')
      }
    }
    return this.db.linkProjectAsset(projectId, recordUid, normalizedRequirementId, {
      linkSource: 'manual',
      confirmedBy: 'local-user'
    })
  }

  unlinkAsset(projectId: string, recordUid: string): { ok: boolean; message: string } {
    return this.db.unlinkProjectAsset(projectId, recordUid)
  }

  unlinkAssetRequirement(projectId: string, recordUid: string, requirementId: string): { ok: boolean; message: string } {
    this.assertProject(projectId)
    return this.db.unlinkProjectAssetRequirement(projectId, recordUid, requirementId)
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

  private normalizeRequirementInput(input: ProjectRequirementInput): ProjectRequirementInput {
    const normalized = normalizeProjectRequirementText(input)
    const title = normalized.title.trim()
    const content = normalized.content.trim()
    if (!title) throw new Error('需求标题不能为空')
    if (!content) throw new Error('需求内容不能为空')
    return {
      category: requirementCategories.has(input.category) ? input.category : 'functional',
      module: normalized.module,
      title,
      content,
      keyInfoTerms: this.normalizeKeyInfoTerms(input.keyInfoTerms, title, content),
      sourceLocation: String(input.sourceLocation ?? '').trim(),
      sourceChunkId: String(input.sourceChunkId ?? '').trim(),
      evidenceQuote: String(input.evidenceQuote ?? '').trim().slice(0, 1000),
      confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
      reviewNote: String(input.reviewNote ?? '').trim().slice(0, 500)
    }
  }

  private assertProject(id: string): void {
    if (!this.db.getManagedProject(id)) throw new Error('项目不存在')
  }

  private assertPerson(id: string): void {
    if (!this.db.getOrganizationPerson(id)) throw new Error('组织人员不存在')
  }

  private assertProjectTaskRequirements(projectId: string, requirementIds: string[]): void {
    for (const requirementId of requirementIds) {
      const requirement = this.db.getProjectRequirement(requirementId)
      if (!requirement || requirement.projectId !== projectId) {
        throw new Error('计划任务关联的需求不存在或不属于当前项目')
      }
    }
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
      sortOrder: Math.max(0, Math.trunc(Number(input.sortOrder ?? 0))),
      requirementIds: [...new Set((Array.isArray(input.requirementIds) ? input.requirementIds : [])
        .map((id) => String(id).trim())
        .filter(Boolean))]
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

  private async runTechnicalAgreement(
    taskId: string,
    projectId: string,
    filePaths: string[],
    externalProcessing: boolean
  ): Promise<void> {
    const totalFiles = filePaths.length
    const fileNames = filePaths.map((filePath) => basename(filePath))
    let currentFile = 0
    try {
      this.emit({
        taskId,
        projectId,
        phase: 'queued',
        message: `已接收 ${totalFiles} 个技术协议文件`,
        detail: `文件：${fileNames.join('、')}`,
        current: 0,
        total: totalFiles,
        status: 'running'
      })
      this.emit({
        taskId,
        projectId,
        phase: 'parsing',
        message: '正在读取并校验协议文件',
        detail: '文件会先保存到本地知识库，再开始需求抽取；抽取失败不会丢失协议关联',
        current: 0,
        total: totalFiles,
        status: 'running'
      })
      const result = await this.knowledge.processFiles(filePaths, (progress) => {
        if (progress.fileName && progress.status !== 'failed' && ['queued', 'parsing', 'done'].includes(progress.phase)) {
          currentFile = Math.max(currentFile, progress.current)
        }
        const phase: ProjectAnalysisProgress['phase'] = progress.phase === 'parsing'
          ? 'parsing'
          : progress.phase === 'error'
            ? 'error'
            : 'embedding'
        this.emit({
          taskId,
          projectId,
          phase,
          message: `知识库：${progress.message}`,
          detail: progress.fileName
            ? `文件 ${Math.min(progress.current, progress.total || totalFiles)}/${progress.total || totalFiles} · ${progress.fileName}`
            : undefined,
          ...(progress.documentId ? { documentId: progress.documentId } : {}),
          ...(progress.fileName ? { fileName: progress.fileName } : {}),
          current: progress.current,
          total: progress.total || totalFiles,
          status: progress.status === 'failed' ? 'failed' : 'running'
        })
      })
      const documents = result.documents
      if (documents.length) {
        // Persist the project/document relationship before extraction. This keeps
        // the uploaded agreement visible and retryable when model extraction fails.
        documents.forEach((document) => this.db.linkProjectDocument(projectId, document.id))
        this.db.updateManagedProjectState(projectId, {
          analysisMessage: documents.every((document) => document.status === 'ready')
            ? `已上传并建立 ${documents.length} 个协议索引，准备抽取需求`
            : `已保存协议附件，但有 ${documents.filter((document) => document.status !== 'ready').length} 个文件索引失败`
        })
        this.emit({
          taskId,
          projectId,
          phase: 'embedding',
          message: documents.every((document) => document.status === 'ready')
            ? '协议已上传并完成知识库索引，准备需求抽取'
            : '协议附件已保存，索引阶段存在失败文件',
          detail: `${result.message}${result.skipped.length ? `；${result.skipped.map((item) => `${item.fileName}: ${item.reason}`).join('；').slice(0, 500)}` : ''}`,
          current: totalFiles,
          total: totalFiles,
          status: 'running'
        })
      }
      const readyDocuments = documents.filter((document) => document.status === 'ready')
      if (readyDocuments.length !== totalFiles) {
        const failed = documents.find((document) => document.status === 'failed')
        throw new Error(failed?.errorMessage || result.skipped[0]?.reason || '部分技术协议未完成索引')
      }
      const documentIds = [...new Set(readyDocuments.map((document) => document.id))]
      await this.runDocumentAnalysis(taskId, projectId, documentIds, externalProcessing)
    } catch (error) {
      this.failProject(taskId, projectId, error, {
        current: currentFile,
        total: totalFiles,
        detail: '协议附件关联已保留；可查看执行日志后重试分析'
      })
    } finally {
      this.runningProjectIds.delete(projectId)
    }
  }

  private async runDocumentRetry(taskId: string, projectId: string, documentId: string): Promise<void> {
    try {
      const document = this.db.getKnowledgeDocument(documentId)
      if (!document) throw new Error('技术协议索引记录不存在')
      this.emit({
        taskId,
        projectId,
        phase: 'parsing',
        message: `正在重新建立 ${document.fileName} 的协议索引`,
        detail: '原协议附件已关联到当前项目，将复用本地文件重新解析',
        documentId: document.id,
        fileName: document.fileName,
        current: 0,
        total: 1,
        status: 'running'
      })
      const retried = await this.knowledge.retryDocument(document.id)
      if (!retried || retried.status !== 'ready') {
        throw new Error(retried?.errorMessage || '协议索引重试失败')
      }
      this.db.linkProjectDocument(projectId, retried.id)
      this.emit({
        taskId,
        projectId,
        phase: 'embedding',
        message: `${retried.fileName} 已重新完成索引`,
        detail: '索引已恢复，正在进入需求抽取',
        documentId: retried.id,
        fileName: retried.fileName,
        current: 1,
        total: 1,
        status: 'running'
      })
      await this.runDocumentAnalysis(taskId, projectId, [retried.id], false)
    } catch (error) {
      this.failProject(taskId, projectId, error, {
        detail: '协议附件仍保留在项目中，可查看日志定位索引失败原因'
      })
    } finally {
      this.runningProjectIds.delete(projectId)
    }
  }

  private async runDocumentAnalysis(
    taskId: string,
    projectId: string,
    documentIds: string[],
    externalProcessing: boolean
  ): Promise<void> {
    let analyzedCurrent = 0
    let analyzedTotal = 0
    try {
      const details = documentIds.map((documentId) => this.db.getKnowledgeDocument(documentId))
      if (!details.length || details.some((detail) => !detail || detail.status !== 'ready')) {
        throw new Error('技术协议尚未完成知识库索引')
      }
      const chunks = details.flatMap((detail) => detail!.chunks.map((chunk) => ({
        id: chunk.id,
        documentId: detail!.id,
        location: `${detail!.fileName} · ${chunk.location}`,
        content: chunk.content
      })))
      analyzedTotal = chunks.length
      if (!chunks.length) throw new Error('协议没有可分析的正文分块')
      const primaryDocumentId = documentIds[documentIds.length - 1]
      const settings = this.modelSettings()
      const set = this.db.createProjectRequirementSet({
        projectId,
        documentId: primaryDocumentId,
        totalChunks: chunks.length,
        analyzedChunks: 0,
        warnings: [],
        externalProcessing,
        modelName: `${settings.provider}:${settings.model}`
      })
      const saveExtractionCheckpoint: AgreementExtractionCheckpoint = (agreement, warnings, analyzedChunks) => {
        const requirements = this.normalizeRequirements(projectId, primaryDocumentId, agreement.requirements ?? [])
        this.db.replaceReviewProjectRequirements(set.id, projectId, primaryDocumentId, requirements)
        this.db.updateProjectRequirementSetProgress(set.id, analyzedChunks, warnings)
        this.db.updateManagedProjectState(projectId, {
          analysisMessage: `已抽取 ${requirements.length} 条候选需求（${analyzedChunks}/${chunks.length} 个分块），正在继续分析`
        })
      }
      this.emit({
        taskId,
        projectId,
        phase: 'extracting',
        message: `开始抽取 ${chunks.length} 个正文分块中的可交付需求`,
        detail: `协议：${details.map((detail) => detail!.fileName).join('、')}；按小批次调用模型，每批完成后保存候选需求并记录请求耗时`,
        current: 0,
        total: analyzedTotal,
        status: 'running'
      })
      const extraction = await this.extractAgreement(chunks, (current, total, message, detail, metadata) => {
        analyzedCurrent = current
        analyzedTotal = total
        this.emit({
          taskId,
          projectId,
          phase: 'extracting',
          message: message || `已分析 ${current}/${total} 个正文分块`,
          detail,
          ...metadata,
          current,
          total,
          status: metadata?.status ?? 'running'
        })
      }, saveExtractionCheckpoint)
      const extracted = extraction.agreement
      analyzedCurrent = analyzedTotal
      this.emit({
        taskId,
        projectId,
        phase: 'extracting',
        message: `正文抽取完成，正在保存 ${extracted.requirements?.length ?? 0} 条候选需求`,
        detail: extraction.warnings.length ? `发现 ${extraction.warnings.length} 条可追溯性提示，将随待审核版本保留` : '未发现来源追溯异常',
        current: analyzedCurrent,
        total: analyzedTotal,
        status: 'running'
      })
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
      const requirements = this.normalizeRequirements(projectId, primaryDocumentId, extracted.requirements ?? [])
      this.db.updateProjectRequirementSetProgress(set.id, extraction.analyzedChunks, extraction.warnings)
      this.db.replaceReviewProjectRequirements(set.id, projectId, primaryDocumentId, requirements)
      this.db.updateManagedProjectState(projectId, {
        analysisStatus: 'ready',
        analysisMessage: `已生成待审核版本 V${set.version}，共 ${requirements.length} 条分类需求`,
        matchStatus: 'idle',
        matchMessage: '需完成人工审核并发布后才能匹配'
      })
      this.emit({
        taskId,
        projectId,
        phase: 'done',
        message: `待审核版本 V${set.version} 已生成`,
        detail: `共 ${requirements.length} 条需求；协议附件已关联，可进入“需求清单”审核后发布`,
        current: chunks.length,
        total: chunks.length,
        status: 'success'
      })
    } catch (error) {
      this.failProject(taskId, projectId, error, {
        current: analyzedCurrent,
        total: analyzedTotal,
        detail: '协议附件和已建立的索引不会被删除；请根据日志中的失败阶段重试'
      })
    } finally {
      this.runningProjectIds.delete(projectId)
    }
  }

  private normalizeRequirements(
    projectId: string,
    documentId: string,
    requirements: ExtractedRequirement[]
  ): Array<{
    id: string
    requirementNo: number
    category: ProjectRequirementCategory
    module: string
    title: string
    content: string
    keyInfoTerms: string[]
    sourceLocation: string
    sourceChunkId: string
    documentId: string
    evidenceQuote: string
    confidence: number
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
        category: requirementCategories.has(item.category ?? 'functional') ? item.category ?? 'functional' : 'functional',
        module,
        title: finalTitle,
        content: content || finalTitle,
        keyInfoTerms: this.normalizeKeyInfoTerms(item.keyInfoTerms, finalTitle, content),
        sourceLocation: String(item.sourceLocation ?? '').trim(),
        sourceChunkId: String(item.sourceChunkId ?? '').trim(),
        documentId: String(item.sourceDocumentId ?? documentId).trim() || documentId,
        evidenceQuote: String(item.evidenceQuote ?? '').trim().slice(0, 1000),
        confidence: Math.max(0, Math.min(1, Number(item.confidence ?? 0.7)))
      }]
    }).map((item, index) => ({ ...item, requirementNo: index + 1 }))
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
        category: item.category,
        module: item.module,
        sourceLocation: item.sourceLocation,
        sourceChunkId: item.sourceChunkId,
        sourceDocumentId: item.sourceDocumentId,
        evidenceQuote: item.evidenceQuote,
        confidence: item.confidence,
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
    chunks: AgreementExtractionChunk[],
    onProgress?: (current: number, total: number, message?: string, detail?: string, metadata?: AgreementExtractionEventMetadata) => void,
    onCheckpoint?: AgreementExtractionCheckpoint
  ): Promise<AgreementExtractionResult> {
    const batches = buildAgreementExtractionBatches(chunks)
    if (!batches.length) throw new Error('协议没有可分析的正文分块')

    const merged: ExtractedAgreement = { project: {}, requirements: [] }
    const traceabilityChunks = chunks.map((chunk) => ({
      ...chunk,
      normalizedContent: normalizeAgreementText(chunk.content)
    }))
    const warnings: string[] = []
    let analyzedChunks = 0
    const extractionConcurrency = this.modelSettings().source === 'local' ? 2 : 1
    for (let windowStart = 0; windowStart < batches.length; windowStart += extractionConcurrency) {
      const window = batches.slice(windowStart, windowStart + extractionConcurrency)
      const windowAnalyzedChunks = analyzedChunks
      window.forEach((batch, offset) => {
        const index = windowStart + offset
        onProgress?.(
          windowAnalyzedChunks,
          chunks.length,
          `正在调用模型分析第 ${index + 1}/${batches.length} 批正文`,
          `本批包含 ${batch.length} 个正文分块，输入约 ${batch.reduce((sum, item) => sum + item.content.length, 0)} 字${extractionConcurrency > 1 ? ` · 本地并发 ${extractionConcurrency}` : ''}`
        )
      })
      const settled = await Promise.allSettled(window.map((batch, offset) => {
        const index = windowStart + offset
        return this.extractAgreementBatch(batch, String(index + 1), batches.length, (message, detail, metadata) => {
          onProgress?.(windowAnalyzedChunks, chunks.length, message, detail, metadata)
        })
      }))
      for (let offset = 0; offset < settled.length; offset += 1) {
        const result = settled[offset]
        if (result.status === 'rejected') {
          throw result.reason instanceof Error ? result.reason : new Error(String(result.reason))
        }
        const batch = window[offset]
        const extracted = result.value
        const fields = extracted.project ?? {}
        const project = merged.project!
        for (const key of Object.keys(fields) as Array<keyof ExtractedProject>) {
          if (project[key] === undefined && fields[key] !== undefined) {
            Object.assign(project, { [key]: fields[key] })
          }
        }
        for (const requirement of extracted.requirements ?? []) {
          const source = resolveAgreementRequirementSource(requirement, traceabilityChunks)
          if (source.status === 'corrected') {
            warnings.push(`需求来源已根据原文证据修正：${requirement.title ?? '未命名需求'}`)
          } else if (source.status === 'inferred') {
            warnings.push(`需求未提供证据摘录，已根据需求正文回溯：${requirement.title ?? '未命名需求'}`)
          } else if (source.status === 'unverified') {
            warnings.push(`需求无法回溯到协议原文，已降为低置信待复核：${requirement.title ?? '未命名需求'}`)
          }
          merged.requirements!.push({
            ...requirement,
            category: requirementCategories.has(requirement.category ?? 'functional')
              ? requirement.category ?? 'functional'
              : 'functional',
            sourceChunkId: source.sourceChunkId,
            sourceDocumentId: source.sourceDocumentId,
            sourceLocation: source.sourceLocation,
            evidenceQuote: source.evidenceQuote,
            confidence: source.confidence
          })
        }
        analyzedChunks += batch.length
        onCheckpoint?.(merged, [...new Set(warnings)].slice(0, 100), analyzedChunks)
        onProgress?.(analyzedChunks, chunks.length, `已完成第 ${windowStart + offset + 1}/${batches.length} 批需求抽取`, `当前累计识别 ${merged.requirements?.length ?? 0} 条候选需求`)
      }
    }
    return { agreement: merged, warnings: [...new Set(warnings)].slice(0, 100), analyzedChunks }
  }

  private async extractAgreementBatch(
    chunks: AgreementExtractionChunk[],
    batchNumber: string,
    batchCount: number,
    onEvent?: AgreementExtractionEvent
  ): Promise<ExtractedAgreement> {
    const source = chunks
      .map((chunk) => `[分块ID:${chunk.id}][位置:${chunk.location}]\n${chunk.content}`)
      .join('\n\n')
    const systemPrompt = [
      '你是企业技术协议结构化分析器。只依据输入正文，不得补写正文没有出现的项目字段或需求。',
      `当前是第 ${batchNumber}/${batchCount} 批正文。提取项目基本信息以及所有可验证、可交付、可验收的技术或商务约束。`,
      'project 只输出本批正文明确出现且能够直接确认的字段，可选字段为 projectName、customerName、contractAmount、riskFactor、deliveryReminderDays、plannedDeliveryDate、salesOwner、technicalOwner、developmentOwner、estimatedCost、estimatedDurationDays。未出现的字段不要输出，禁止使用 0、空字符串或 null 占位。',
      'category 必须从 functional、interface、data、performance、security、deployment、operations、acceptance、business 中选择，分别表示功能、接口、数据、性能、安全、部署、运维、验收和商务约束。不得因为内容属于非功能需求而丢弃。',
      '每条需求必须原子化：一条只描述一个动作、对象或约束。多个并列动作、指标或序号项必须拆成多条。',
      '字段长度限制只用于压缩单条输出，不得因此省略或合并可靠需求；正文中的每个独立动作、指标、责任、交付物、付款条款和人员管理约束都必须分别保留。',
      '遇到任何同级序号标识都必须严格分条输出：包括 1.、1)、1）、1、（1）、(1)、①，以及 一、/（一）等。序号后的每一项对应 requirements 数组中的一个独立元素；即使它们共享同一个章节标题，也绝对不能合并到同一条 content 中。',
      '识别每条需求所在的最近章节或功能模块，并写入 module 字段，例如“2.1 整体要求”“2.2 项目策划”。同一章节下的多条需求必须复用相同 module；title 只写需求名称或功能动作，绝对不要把章节名称重复拼接到 title 前面。',
      '排除纯背景、宣传性描述和没有约束含义的泛泛目标，但保留明确的架构、技术选型、实施、培训、付款、性能、安全、验收和服务要求。',
      '每条 content 使用简洁需求句，最多 120 字。sourceChunkId 必须从输入分块ID原样选择；evidenceQuote 必须逐字摘录该分块中的直接证据，最多 80 字并优先保留核心约束；confidence 返回 0 到 1。sourceLocation 不要输出，程序会根据 sourceChunkId 回填。',
      '为每条需求提取 keyInfoTerms：2-4 个用于数据中心匹配的关键功能信息词，只保留正文中出现的业务对象、动作、模块、接口/集成对象、指标或约束词；不要返回“系统、功能、支持、实现、能够、可以”等泛词，不要编造同义词。',
      '只输出一个完整且闭合的 JSON 对象，不要输出 Markdown、解释文字或思考过程。JSON 结构必须为：',
      '{"project":{},"requirements":[{"category":"functional","module":"","title":"","content":"","keyInfoTerms":[""],"sourceChunkId":"","evidenceQuote":"","confidence":0.8}]}',
      'requirements 没有可靠需求时返回空数组。'
    ].join('\n')
    const compactSystemPrompt = [
      '这是格式重试（紧凑恢复）。你是企业技术协议需求抽取器，只依据输入正文，不得补写。',
      '只输出一个完整且闭合的 JSON 对象：{"project":{},"requirements":[]}。',
      '逐条提取正文中可验证、可交付、可验收的要求，不能合并同级序号项；每条只保留 category、module、title、content、keyInfoTerms、sourceChunkId、evidenceQuote、confidence。',
      'content 最多 120 字，evidenceQuote 必须逐字摘录且最多 80 字，keyInfoTerms 最多 4 个；sourceChunkId 必须原样取自输入分块ID，sourceLocation 不要输出。',
      '不要输出项目基本信息、解释文字、Markdown 或思考过程；requirements 没有可靠需求时返回空数组。'
    ].join('\n')
    const settings = this.modelSettings()
    const model = new ModelClient(settings)
    const modelName = `${settings.provider}:${settings.model}`
    const strictPromptSuffix = '\n这是格式重试：上一次输出不完整或无法解析。请减少文字，确保最后一个字段和所有括号都闭合后再结束。'
    type RequestMode = 'normal' | 'strict' | 'compact'
    const request = (mode: RequestMode): Promise<Awaited<ReturnType<ModelClient['chat']>>> => {
      const requestSystemPrompt = mode === 'compact'
        ? compactSystemPrompt
        : mode === 'strict'
          ? `${systemPrompt}${strictPromptSuffix}`
          : systemPrompt
      return model.chat({
      messages: [
        {
          role: 'system',
          content: requestSystemPrompt
        },
        { role: 'user', content: source }
      ],
      format: 'json',
      think: false,
      temperature: 0,
      numPredict: mode === 'compact'
        ? extractionCompactOutputMaxTokens
        : mode === 'strict'
          ? extractionStrictOutputMaxTokens
          : extractionOutputMaxTokens
      })
    }
    let requestAttempt = 0
    const executeRequest = async (mode: RequestMode): Promise<Awaited<ReturnType<ModelClient['chat']>>> => {
      requestAttempt += 1
      const requestId = randomUUID()
      const startedAt = Date.now()
      const requestSystemPrompt = mode === 'compact'
        ? compactSystemPrompt
        : mode === 'strict'
          ? `${systemPrompt}${strictPromptSuffix}`
          : systemPrompt
      const inputChars = requestSystemPrompt.length + source.length
      const requestLabel = mode === 'strict' ? '（格式重试）' : mode === 'compact' ? '（紧凑恢复）' : ''
      try {
        const response = await request(mode)
        const elapsedMs = Math.max(0, Date.now() - startedAt)
        const outputChars = response.message?.content?.length ?? 0
        const doneReason = String(response.done_reason ?? '')
        onEvent?.(
          `模型请求完成：第 ${batchNumber}/${batchCount} 批${requestLabel}`,
          `模型 ${modelName} · 输入 ${inputChars} 字 · 输出 ${outputChars} 字 · 耗时 ${elapsedMs} ms · 结束 ${doneReason || '未知'}`,
          {
            logKind: 'model_request',
            requestId,
            batchNumber,
            attempt: requestAttempt,
            elapsedMs,
            inputChars,
            outputChars,
            doneReason,
            modelName,
            status: 'success'
          }
        )
        return response
      } catch (error) {
        const elapsedMs = Math.max(0, Date.now() - startedAt)
        const message = error instanceof Error ? error.message : String(error)
        onEvent?.(
          `模型请求失败：第 ${batchNumber}/${batchCount} 批${requestLabel}`,
          `模型 ${modelName} · 输入 ${inputChars} 字 · 耗时 ${elapsedMs} ms · ${message}`,
          {
            logKind: 'model_request',
            requestId,
            batchNumber,
            attempt: requestAttempt,
            elapsedMs,
            inputChars,
            outputChars: 0,
            doneReason: 'error',
            modelName,
            status: 'failed'
          }
        )
        throw error
      }
    }
    let response: Awaited<ReturnType<ModelClient['chat']>>
    let compactAttempted = false
    try {
      response = await executeRequest('normal')
    } catch (error) {
      const split = this.splitExtractionBatch(chunks)
      if (split) {
        onEvent?.(
          `第 ${batchNumber}/${batchCount} 批请求失败，正在拆分重试`,
          `原批次 ${chunks.length} 个正文分块；失败原因：${error instanceof Error ? error.message : String(error)}`
        )
        return this.extractSplitAgreementBatch(split, batchNumber, batchCount, onEvent)
      }
      onEvent?.(
        `第 ${batchNumber}/${batchCount} 批请求失败，正在尝试紧凑恢复`,
        `无法继续拆分单个正文分块；失败原因：${error instanceof Error ? error.message : String(error)}`
      )
      compactAttempted = true
      response = await executeRequest('compact')
    }
    let parsed = this.parseAgreementJson(response.message?.content ?? '')
    if (!parsed && response.done_reason !== 'length') {
      try {
        response = await executeRequest('strict')
      } catch (error) {
        const split = this.splitExtractionBatch(chunks)
        if (split) {
          onEvent?.(
            `第 ${batchNumber}/${batchCount} 批格式重试失败，正在拆分重试`,
            `原批次 ${chunks.length} 个正文分块；失败原因：${error instanceof Error ? error.message : String(error)}`
          )
          return this.extractSplitAgreementBatch(split, batchNumber, batchCount, onEvent)
        }
        onEvent?.(
          `第 ${batchNumber}/${batchCount} 批格式重试失败，正在尝试紧凑恢复`,
          `无法继续拆分单个正文分块；失败原因：${error instanceof Error ? error.message : String(error)}`
        )
        compactAttempted = true
        response = await executeRequest('compact')
      }
      parsed = this.parseAgreementJson(response.message?.content ?? '')
    }
    if (!parsed) {
      const split = this.splitExtractionBatch(chunks)
      if (split) {
        onEvent?.(
          `第 ${batchNumber}/${batchCount} 批模型结果无法完整解析，正在拆分重试`,
          `原批次 ${chunks.length} 个正文分块；已避免重复请求同一批次`
        )
        return this.extractSplitAgreementBatch(split, batchNumber, batchCount, onEvent)
      }
      if (!compactAttempted && (response.done_reason === 'length' || response.message?.content)) {
        onEvent?.(
          `第 ${batchNumber}/${batchCount} 批模型结果仍不完整，正在尝试紧凑恢复`,
          `当前批次已无法继续拆分；将只要求模型输出短字段和短证据`
        )
        compactAttempted = true
        response = await executeRequest('compact')
        parsed = this.parseAgreementJson(response.message?.content ?? '')
        if (parsed) {
          return this.normalizeExtractedAgreement(parsed)
        }
      }
      if (response.done_reason === 'length') {
        throw new Error(`第 ${batchNumber}/${batchCount} 批模型输出被截断，拆分后仍未完成`)
      }
      throw new Error('大模型返回的技术协议分析结果不是有效 JSON，已自动重试')
    }
    return this.normalizeExtractedAgreement(parsed)
  }

  private normalizeExtractedAgreement(value: Record<string, unknown>): ExtractedAgreement {
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
        category: requirementCategories.has(String(item.category) as ProjectRequirementCategory)
          ? String(item.category) as ProjectRequirementCategory
          : 'functional',
        module: this.optionalString(item.module),
        title: this.optionalString(item.title),
        content: this.optionalString(item.content),
        keyInfoTerms: Array.isArray(item.keyInfoTerms)
          ? item.keyInfoTerms.map((term) => this.optionalString(term)).filter((term): term is string => Boolean(term))
          : undefined,
        sourceLocation: this.optionalString(item.sourceLocation),
        sourceChunkId: this.optionalString(item.sourceChunkId),
        evidenceQuote: this.optionalString(item.evidenceQuote),
        confidence: this.optionalNumber(item.confidence)
      }))
    }
  }

  private async extractSplitAgreementBatch(
    split: [AgreementExtractionChunk[], AgreementExtractionChunk[]],
    batchNumber: string,
    batchCount: number,
    onEvent?: AgreementExtractionEvent
  ): Promise<ExtractedAgreement> {
    const [left, right] = split
    const [leftResult, rightResult] = await Promise.all([
      this.extractAgreementBatch(left, `${batchNumber}.1`, batchCount, onEvent),
      this.extractAgreementBatch(right, `${batchNumber}.2`, batchCount, onEvent)
    ])
    return this.mergeExtractedAgreements(leftResult, rightResult)
  }

  private splitExtractionBatch(
    chunks: AgreementExtractionChunk[]
  ): [
    AgreementExtractionChunk[],
    AgreementExtractionChunk[]
  ] | null {
    if (chunks.length > 1) {
      const midpoint = Math.ceil(chunks.length / 2)
      return [chunks.slice(0, midpoint), chunks.slice(midpoint)]
    }
    const chunk = chunks[0]
    if (!chunk || chunk.content.length <= extractionSplitChunkMaxChars) return null
    const midpoint = Math.floor(chunk.content.length / 2)
    const boundaryCandidates = [
      chunk.content.lastIndexOf('\n', midpoint),
      chunk.content.lastIndexOf('。', midpoint),
      chunk.content.lastIndexOf('；', midpoint),
      chunk.content.lastIndexOf(' ', midpoint)
    ].filter((value) => value > extractionSplitChunkMaxChars / 3)
    const splitAt = boundaryCandidates.length ? Math.max(...boundaryCandidates) + 1 : midpoint
    const leftContent = chunk.content.slice(0, splitAt).trim()
    const rightContent = chunk.content.slice(splitAt).trim()
    if (!leftContent || !rightContent) return null
    return [
      [{ ...chunk, location: `${chunk.location} · 前半段`, content: leftContent }],
      [{ ...chunk, location: `${chunk.location} · 后半段`, content: rightContent }]
    ]
  }

  private mergeExtractedAgreements(left: ExtractedAgreement, right: ExtractedAgreement): ExtractedAgreement {
    const project: ExtractedProject = {}
    for (const fields of [left.project ?? {}, right.project ?? {}]) {
      for (const key of Object.keys(fields) as Array<keyof ExtractedProject>) {
        if (project[key] === undefined && fields[key] !== undefined) {
          Object.assign(project, { [key]: fields[key] })
        }
      }
    }
    return {
      project,
      requirements: [...(left.requirements ?? []), ...(right.requirements ?? [])]
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
          detail: [
            requirement.module,
            requirement.title,
            requirement.content.slice(0, 180),
            requirement.keyInfoTerms.length ? `补充信息词：${requirement.keyInfoTerms.join('、')}` : ''
          ].filter(Boolean).join(' · '),
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
    } finally {
      this.runningProjectIds.delete(projectId)
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
        detail: [
          requirement.module,
          requirement.content.slice(0, 180),
          requirement.keyInfoTerms.length ? `补充信息词：${requirement.keyInfoTerms.join('、')}` : ''
        ].filter(Boolean).join(' · '),
        current: 0,
        total: 1,
        status: 'running'
      })
      await this.matchSingleRequirement(requirement)
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'ready',
        matchMessage: `已完成「${requirement.title}」的匹配`
      })
      this.emit({
        taskId,
        projectId,
        phase: 'done',
        message: '功能需求匹配完成',
        detail: `需求「${requirement.title}」的匹配结果已保存`,
        current: 1,
        total: 1,
        status: 'success'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.updateManagedProjectState(projectId, {
        matchStatus: 'failed',
        matchMessage: message
      })
      this.emit({ taskId, projectId, phase: 'error', message, current: 0, total: 1, status: 'failed' })
    } finally {
      this.runningProjectIds.delete(projectId)
    }
  }

  private async matchSingleRequirement(requirement: ProjectRequirement): Promise<void> {
    const matchingQuery = this.buildRequirementMatchQuery(requirement)
    const vectorMatches = await this.knowledge.rankRecordMatches(matchingQuery)
    const reviewed = await this.reviewMatches(requirement, vectorMatches.slice(0, 20))
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
  }

  private buildRequirementMatchQuery(requirement: ProjectRequirement): string {
    const terms = this.normalizeKeyInfoTerms(requirement.keyInfoTerms)
    return [
      `需求分类：${requirement.category}`,
      requirement.module.trim() ? `业务模块：${requirement.module.trim()}` : '',
      `需求标题：${requirement.title.trim()}`,
      `需求描述：${requirement.content.trim()}`,
      terms.length ? `补充信息词：${terms.join('、')}` : ''
    ].filter(Boolean).join('\n')
  }

  private async reviewMatches(requirement: ProjectRequirement, candidates: KnowledgeRecordMatch[]): Promise<MatchReview> {
    if (!candidates.length) return { status: 'unmarked', reason: '数据中心没有可用的向量匹配记录', matches: [] }
    try {
      const response = await new ModelClient(this.modelSettings()).chat({
        messages: [
          {
            role: 'system',
            content: [
              '你是技术需求与数据资产语义匹配评审器。请综合需求分类、业务模块、标题和完整需求描述理解真实意图，再评审候选记录。',
              'keyInfoTerms 只是帮助理解行业术语、缩写和重点概念的补充信息，不是硬约束。候选记录即使没有逐字命中这些词，只要整体语义和能力一致，也不能因此降为不匹配。',
              '为每个候选记录给出 0 到 100 的匹配分数和简短理由，不能虚构候选记录字段。',
              '同时给出需求整体状态：satisfied 仅表示已有数据明确支持；unmarked 表示匹配度不足、无法确认满足或需要人工标记。AI 不要输出 to_develop 或 to_negotiate，这两个状态只由用户手动标记。',
              '只输出 JSON：{"status":"satisfied|unmarked","reason":"","matches":[{"recordUid":"","score":0,"reason":""}]}'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify({
              requirement: {
                category: requirement.category,
                module: requirement.module,
                title: requirement.title,
                content: requirement.content,
                keyInfoTerms: this.normalizeKeyInfoTerms(requirement.keyInfoTerms)
              },
              candidates
            })
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

  private failProject(
    taskId: string,
    projectId: string,
    error: unknown,
    progress: { current?: number; total?: number; detail?: string } = {}
  ): void {
    const message = error instanceof Error ? error.message : String(error)
    this.db.updateManagedProjectState(projectId, {
      analysisStatus: 'failed',
      analysisMessage: message
    })
    this.emit({
      taskId,
      projectId,
      phase: 'error',
      message,
      detail: progress.detail,
      current: Math.max(0, Math.trunc(progress.current ?? 0)),
      total: Math.max(0, Math.trunc(progress.total ?? 0)),
      status: 'failed'
    })
  }

  private emit(progress: ProjectAnalysisProgress): void {
    this.db.saveProjectAnalysisProgress(progress)
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
