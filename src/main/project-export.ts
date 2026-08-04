import * as XLSX from 'xlsx'
import type {
  ProjectDataSnapshot,
  ProjectDocumentSnapshot,
  ProjectRequirement,
  ProjectRequirementMatch
} from '../shared/project-types'

type ExcelCell = string | number | boolean

const cell = (value: unknown): ExcelCell | '' => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return JSON.stringify(value)
}

const listCell = (values: string[] | undefined): string => (values ?? []).join('、')

const assetRequirementCell = (asset: ProjectDataSnapshot['assets'][number]): string => (
  (asset.requirements ?? []).map((requirement) => {
    const number = requirement.requirementNo > 0 ? `REQ-${String(requirement.requirementNo).padStart(3, '0')}` : ''
    return [number, requirement.title].filter(Boolean).join(' ')
  }).join('；')
)

const columnName = (index: number): string => {
  let current = index + 1
  let name = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    current = Math.floor((current - 1) / 26)
  }
  return name
}

const appendSheet = (
  workbook: XLSX.WorkBook,
  name: string,
  headers: string[],
  rows: ExcelCell[][],
  widths: number[]
): void => {
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows])
  sheet['!cols'] = widths.map((wch) => ({ wch }))
  sheet['!autofilter'] = {
    ref: `A1:${columnName(headers.length - 1)}${Math.max(1, rows.length + 1)}`
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name)
}

const projectRows = (snapshot: ProjectDataSnapshot): ExcelCell[][] => {
  const project = snapshot.project
  return [
    ['数据格式', snapshot.format],
    ['数据版本', snapshot.version],
    ['导出时间', snapshot.exportedAt],
    ['项目 ID', project.id],
    ['项目名称', project.projectName],
    ['客户名称', project.customerName],
    ['项目来源', project.source],
    ['生命周期', project.lifecycle],
    ['合同金额', project.contractAmount],
    ['风险系数', project.riskFactor],
    ['交付提醒天数', project.deliveryReminderDays],
    ['计划交付日期', project.plannedDeliveryDate],
    ['销售负责人', project.salesOwner],
    ['技术负责人', project.technicalOwner],
    ['开发负责人', project.developmentOwner],
    ['基础预估成本', project.baseEstimatedCost],
    ['当前预估成本', project.estimatedCost],
    ['人力预估成本', project.laborEstimatedCost],
    ['实际成本', project.actualCost],
    ['剩余额度', project.remainingQuota],
    ['预计工期（天）', project.estimatedDurationDays],
    ['协议分析状态', project.analysisStatus],
    ['协议分析消息', project.analysisMessage],
    ['匹配状态', project.matchStatus],
    ['匹配消息', project.matchMessage],
    ['需求数量', project.requirementCount],
    ['已满足需求数', project.satisfiedCount],
    ['待开发需求数', project.toDevelopCount],
    ['待协商需求数', project.toNegotiateCount],
    ['未标记需求数', project.unmarkedCount],
    ['项目资产数', project.assetCount],
    ['项目参与人数', project.participantCount],
    ['计划任务数', project.taskCount],
    ['技术协议数', project.documentCount],
    ['当前审核集 ID', project.reviewSetId ?? ''],
    ['当前审核版本', project.reviewVersion],
    ['待审核需求数', project.pendingReviewCount],
    ['当前协议文档 ID', project.currentDocumentId ?? ''],
    ['当前协议文档名称', project.currentDocumentName ?? ''],
    ['创建时间', project.createdAt],
    ['更新时间', project.updatedAt]
  ].map(([label, value]) => [label, cell(value)])
}

const documentRows = (documents: ProjectDocumentSnapshot[]): ExcelCell[][] => documents.map((document) => [
  document.id,
  document.fileName,
  document.extension,
  document.mimeType,
  document.filePath,
  document.byteSize,
  document.sha256,
  listCell(document.tags),
  document.status,
  document.errorMessage,
  document.chunkCount,
  document.pageCount,
  document.modelVersion,
  document.version,
  document.isCurrent ? '是' : '否',
  document.createdAt,
  document.updatedAt,
  document.processedAt,
  document.linkedAt
].map(cell))

const requirementRows = (requirements: ProjectRequirement[]): ExcelCell[][] => requirements.map((requirement) => [
  requirement.id,
  requirement.requirementNo,
  requirement.category,
  requirement.module,
  requirement.title,
  requirement.content,
  listCell(requirement.keyInfoTerms),
  requirement.keyInfoTermsSource,
  requirement.sourceLocation,
  requirement.sourceChunkId,
  requirement.evidenceQuote,
  requirement.confidence,
  requirement.reviewStatus,
  requirement.reviewNote,
  requirement.status,
  requirement.statusSource,
  requirement.statusReason,
  requirement.highestMatchScore,
  requirement.matchCount,
  requirement.documentId,
  requirement.setId,
  requirement.version,
  requirement.projectId,
  requirement.createdAt,
  requirement.updatedAt
].map(cell))

const matchRows = (matches: ProjectRequirementMatch[]): ExcelCell[][] => matches.map((match) => [
  match.requirementId,
  match.recordUid,
  match.recordName,
  match.nodeType,
  match.itemId,
  match.description,
  match.vectorScore,
  match.aiScore ?? '',
  match.finalScore,
  match.scoreSource,
  match.reason,
  match.bestChunkId,
  match.assetLinked ? '是' : '否',
  match.requirementLinked ? '是' : '否'
].map(cell))

export const createProjectWorkbook = (snapshot: ProjectDataSnapshot): XLSX.WorkBook => {
  const workbook = XLSX.utils.book_new()

  appendSheet(workbook, '项目概览', ['字段', '值'], projectRows(snapshot), [24, 52])
  appendSheet(workbook, '技术协议', [
    '文档 ID', '文件名', '扩展名', 'MIME 类型', '源文件路径', '文件大小（字节）', 'SHA-256', '标签',
    '索引状态', '错误信息', '分块数', '页数', '模型版本', '协议版本', '当前版本', '创建时间', '更新时间', '处理时间', '关联时间'
  ], documentRows(snapshot.documents), [38, 28, 10, 20, 48, 16, 66, 24, 12, 36, 10, 10, 24, 10, 10, 24, 24, 24, 24])
  appendSheet(workbook, '项目人员', [
    '人员 ID', '姓名', '工号', '部门', '岗位', '小时费率', '状态', '备注', '创建时间', '更新时间'
  ], snapshot.people.map((person) => [
    person.id, person.name, person.employeeNo, person.department, person.role, person.hourlyRate,
    person.status, person.notes, person.createdAt, person.updatedAt
  ].map(cell)), [38, 18, 16, 20, 20, 14, 12, 36, 24, 24])
  appendSheet(workbook, '项目参与人', [
    '参与关系 ID', '人员 ID', '姓名', '工号', '部门', '岗位', '小时费率', '开始日期', '结束日期',
    '参与天数', '预估成本', '备注', '创建时间', '更新时间'
  ], snapshot.participants.map((participant) => [
    participant.id, participant.personId, participant.personName, participant.employeeNo, participant.department,
    participant.role, participant.hourlyRate, participant.startDate, participant.endDate, participant.durationDays,
    participant.estimatedCost, participant.notes, participant.createdAt, participant.updatedAt
  ].map(cell)), [38, 38, 18, 16, 20, 20, 14, 16, 16, 12, 14, 36, 24, 24])
  appendSheet(workbook, '成本明细', [
    '成本 ID', '项目 ID', '成本类型', '分类', '说明', '金额', '发生日期', '资产记录 UID', '责任参与人 ID', '责任人', '创建时间', '更新时间'
  ], snapshot.costs.map((cost) => [
    cost.id, cost.projectId, cost.type, cost.category, cost.description, cost.amount, cost.occurredAt,
    cost.assetRecordUid ?? '', cost.responsibleParticipantId ?? '', cost.responsiblePersonName ?? '', cost.createdAt, cost.updatedAt
  ].map(cell)), [38, 38, 14, 18, 36, 14, 18, 38, 38, 18, 24, 24])
  appendSheet(workbook, '项目资产', [
    '项目 ID', '记录 UID', '名称', '节点类型', '项目编号', '描述', '关联需求', '关联时间'
  ], snapshot.assets.map((asset) => [
    asset.projectId, asset.recordUid, asset.name, asset.nodeType, asset.itemId, asset.description,
    assetRequirementCell(asset), asset.linkedAt
  ].map(cell)), [38, 38, 28, 20, 20, 60, 48, 24])
  appendSheet(workbook, '项目计划', [
    '任务 ID', '任务类型', '任务名称', '任务说明', '父任务 ID', '开始日期', '结束日期', '负责人 ID', '负责人',
    '状态', '进度（%）', '排序', '层级', '包含子任务', '创建时间', '更新时间'
  ], snapshot.tasks.map((task) => [
    task.id, task.taskType, task.title, task.description, task.parentTaskId ?? '', task.startDate, task.endDate,
    task.ownerPersonId ?? '', task.ownerName ?? '', task.status, task.progressPercent, task.sortOrder, task.depth,
    task.hasChildren ? '是' : '否', task.createdAt, task.updatedAt
  ].map(cell)), [38, 14, 32, 60, 38, 16, 16, 38, 18, 16, 14, 10, 10, 12, 24, 24])
  appendSheet(workbook, '功能需求', [
    '需求 ID', '需求编号', '类别', '模块', '标题', '内容', '关键信息词', '信息词来源', '来源位置', '来源分块 ID',
    '证据摘录', '置信度', '审核状态', '审核备注', '实现状态', '状态来源', '状态原因', '最高匹配分', '匹配数',
    '文档 ID', '审核集 ID', '版本', '项目 ID', '创建时间', '更新时间'
  ], requirementRows(snapshot.requirements), [38, 12, 14, 20, 32, 70, 30, 14, 22, 38, 60, 12, 14, 36, 14, 14, 36, 14, 10, 38, 38, 10, 38, 24, 24])
  appendSheet(workbook, '需求匹配', [
    '需求 ID', '记录 UID', '记录名称', '节点类型', '项目编号', '记录描述', '向量分数', 'AI 分数', '最终分数',
    '分数来源', '匹配原因', '最佳分块 ID', '已关联项目资产', '已关联当前需求'
  ], matchRows(snapshot.matches), [38, 38, 30, 20, 20, 70, 14, 14, 14, 14, 60, 38, 18, 18])

  return workbook
}
