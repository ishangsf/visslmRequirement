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
    estimatedCost: 240,
    estimatedDurationDays: 30
  })
  const snapshot = database.exportManagedProjectSnapshot(project.id)
  assert(snapshot)

  const workbook = createProjectWorkbook(snapshot)
  const filePath = join(directory, 'project.xlsx')
  XLSX.writeFile(workbook, filePath, { bookType: 'xlsx', compression: true })

  const reopened = XLSX.read(readFileSync(filePath), { type: 'buffer' })
  assert.deepEqual(reopened.SheetNames, [
    '项目概览', '技术协议', '项目人员', '项目参与人', '成本明细',
    '项目资产', '项目计划', '功能需求', '需求匹配'
  ])
  const overview = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['项目概览'], { header: 1 })
  assert(overview.some((row) => Array.isArray(row) && row[0] === '项目名称' && row[1] === 'Excel 导出 Smoke'))
  const documentHeaders = XLSX.utils.sheet_to_json<unknown[]>(reopened.Sheets['技术协议'], { header: 1 })[0]
  assert(Array.isArray(documentHeaders) && documentHeaders[0] === '文档 ID')

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
