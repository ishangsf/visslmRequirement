import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { AppDatabase } from '../src/main/database'
import { createProjectWorkbook } from '../src/main/project-export'
const directory = mkdtempSync(join(tmpdir(), 'visslm-project-export-'))
const database = new AppDatabase(join(directory, 'project.db'), join(directory, 'assets'))

try {
  const project = database.createManagedProject(randomUUID(), {
    projectName: 'Excel 导出 Smoke',
    customerName: '示例客户',
    contractAmount: 1000,
    riskFactor: 0.8,
    deliveryReminderDays: 7,
    plannedDeliveryDate: '2026-08-20',
    estimatedCost: 240,
    estimatedDurationDays: 30
  })
  const document = database.insertKnowledgeDocument({
    id: randomUUID(),
    fileName: 'export-agreement.txt',
    filePath: join(directory, 'export-agreement.txt'),
    extension: '.txt',
    mimeType: 'text/plain',
    byteSize: 10,
    sha256: randomUUID()
  })
  database.linkProjectDocument(project.id, document.id)
  database.replaceProjectRequirements(project.id, document.id, [{
    id: 'export-requirement-1',
    requirementNo: 1,
    category: 'functional',
    module: '导出',
    title: '导出关联需求',
    content: '验证项目计划导出关联需求',
    sourceLocation: '第 1 页',
    sourceChunkId: 'export-chunk'
  }])
  const task = database.insertProjectTask(project.id, {
    taskType: 'task',
    title: '导出关联任务',
    startDate: '2026-08-01',
    endDate: '2026-08-02',
    requirementIds: ['export-requirement-1']
  })
  assert.equal(task.requirements[0]?.title, '导出关联需求')
  database.upsertRecord({
    uid: 'export-trace-record',
    projectId: 'export-source-project',
    nodeType: 'Requirement',
    itemId: 'EXPORT-TRACE-1',
    parentId: '',
    name: '导出追溯资产',
    lastModifyTime: '2026-08-20T00:00:00.000Z',
    raw: { description: 'Excel 追溯矩阵资产' },
    normalizedText: 'Excel 追溯矩阵资产'
  })
  const asset = database.linkProjectAsset(project.id, 'export-trace-record', 'export-requirement-1')
  assert(asset)
  database.insertProjectCostEntry(project.id, {
    type: 'actual',
    category: '项目实际成本',
    description: '项目导出实际成本样本',
    amount: 1200,
    occurredAt: '2026-08-20'
  })
  const snapshotForExport = database.exportManagedProjectSnapshot(project.id)
  assert(snapshotForExport)
  const taskRelation = snapshotForExport.tasks.find((item) => item.id === task.id)?.requirements[0]
  const assetRelation = snapshotForExport.assets.find((item) => item.recordUid === 'export-trace-record')?.requirements[0]
  assert(taskRelation)
  assert(assetRelation)
  const workbook = createProjectWorkbook(snapshotForExport)
  const filePath = join(directory, 'project.xlsx')
  XLSX.writeFile(workbook, filePath, { bookType: 'xlsx', compression: true })

  const reopened = XLSX.read(readFileSync(filePath), { type: 'buffer' })
  const expectedSheetNames = [
    '项目概览', '技术协议', '项目人员', '项目参与人', '成本明细',
    '项目资产', '项目计划', '功能需求', '需求匹配', '需求追溯矩阵'
  ]
  assert.deepEqual(reopened.SheetNames, expectedSheetNames)
  for (const retiredSheetName of ['追溯决策审计', 'AI复核建议', '项目治理']) {
    assert.equal(reopened.SheetNames.includes(retiredSheetName), false, `退役工作表 ${retiredSheetName} 不得导出`)
  }
  const overview = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['项目概览'], { header: 1 })
  assert(overview.some((row) => Array.isArray(row) && row[0] === '项目名称' && row[1] === 'Excel 导出 Smoke'))
  const documentHeaders = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['技术协议'], { header: 1 })[0]
  assert(Array.isArray(documentHeaders) && documentHeaders[0] === '文档 ID')
  const planRows = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['项目计划'], { header: 1 })
  assert(Array.isArray(planRows[0]) && planRows[0].includes('关联需求'))
  const requirementColumnIndex = (planRows[0] as unknown[]).indexOf('关联需求')
  assert(planRows.some((row) => Array.isArray(row) && row[requirementColumnIndex] === 'REQ-001 导出关联需求'))
  const traceMatrixRows = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['需求追溯矩阵'], { header: 1 })
  assert(Array.isArray(traceMatrixRows[0]))
  const traceMatrixHeaders = traceMatrixRows[0] as unknown[]
  for (const header of ['对象类型', '记录 UID', '关系 Key', '需求标题', '追溯状态', '验证人', '验证时间']) {
    assert(traceMatrixHeaders.includes(header), `需求追溯矩阵必须包含“${header}”表头`)
  }
  const matrixObjectTypeIndex = traceMatrixHeaders.indexOf('对象类型')
  const matrixRecordUidIndex = traceMatrixHeaders.indexOf('记录 UID')
  const matrixRelationKeyIndex = traceMatrixHeaders.indexOf('关系 Key')
  const matrixStatusIndex = traceMatrixHeaders.indexOf('追溯状态')
  assert(traceMatrixRows.some((row) => Array.isArray(row)
    && row[matrixObjectTypeIndex] === '任务'
    && typeof row[matrixRelationKeyIndex] === 'string'
    && typeof row[matrixStatusIndex] === 'string'))
  assert(traceMatrixRows.some((row) => Array.isArray(row)
    && row[matrixObjectTypeIndex] === '资产'
    && row[matrixRecordUidIndex] === 'export-trace-record'))

  const emptySnapshot = structuredClone(snapshotForExport)
  emptySnapshot.traceMetadata = []
  const emptyWorkbook = createProjectWorkbook(emptySnapshot)
  const emptyTraceRows = XLSX.utils.sheet_to_json<unknown[]>(emptyWorkbook.Sheets['需求追溯矩阵'], { header: 1 })
  assert(Array.isArray(emptyTraceRows[0]) && emptyTraceRows[0].length > 0, '需求追溯矩阵空数组时仍必须保留表头')
  assert.equal(emptyWorkbook.SheetNames.includes('追溯决策审计'), false)
  assert.equal(emptyWorkbook.SheetNames.includes('AI复核建议'), false)
  assert.equal(emptyWorkbook.SheetNames.includes('项目治理'), false)

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    sheetNames: reopened.SheetNames,
    outputBytes: readFileSync(filePath).byteLength
  }, null, 2))
} finally {
  database.close()
  rmSync(directory, { recursive: true, force: true })
}
