import { once } from 'node:events'
import { createWriteStream, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'

const root = mkdtempSync(join(tmpdir(), 'visslm-data-export-stream-'))
const database = new AppDatabase(join(root, 'data.db'), join(root, 'assets'))
const outputPath = join(root, 'export.jsonl')

for (let index = 0; index < 4; index += 1) {
  database.upsertRecord({
    uid: `export-${index}`,
    projectId: 'project-1',
    nodeType: 'Task',
    itemId: `TASK-${index}`,
    parentId: '',
    name: `导出测试 ${index}`,
    lastModifyTime: '2026-08-23T00:00:00.000Z',
    raw: { _valm_Name: `导出测试 ${index}`, _valm_Description: 'streaming' },
    normalizedText: 'streaming'
  })
  database.saveImage({
    recordUid: `export-${index}`,
    name: `image-${index}.bin`,
    mimeType: 'application/octet-stream',
    sourceUrl: 'smoke-test',
    bytes: Buffer.alloc(32 * 1024, index)
  })
}

const stream = createWriteStream(outputPath, { encoding: 'utf8' })
let recordCount = 0
for (const row of database.iterateExportRows()) {
  if (!stream.write(`${JSON.stringify(row)}\n`)) await once(stream, 'drain')
  recordCount += 1
}
stream.end()
await once(stream, 'finish')

const lines = readFileSync(outputPath, 'utf8').trim().split(/\r?\n/)
const first = JSON.parse(lines[0]) as {
  images?: Array<{ base64?: string }>
}
database.close()

if (recordCount !== 4 || lines.length !== 4 || !first.images?.[0]?.base64) {
  throw new Error(`流式导出 smoke 失败：记录 ${recordCount}，行数 ${lines.length}`)
}

console.log(JSON.stringify({ recordCount, lineCount: lines.length, imageBase64: true }))
