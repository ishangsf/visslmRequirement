import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DATA_IMPORT_BATCH_SIZE,
  readJsonArrayImportRows,
  readJsonlImportRows
} from '../src/main/data-import-stream'

const run = async (): Promise<void> => {
  const directory = mkdtempSync(join(tmpdir(), 'visslm-data-import-stream-'))
  try {
    const sourceRows = Array.from({ length: DATA_IMPORT_BATCH_SIZE * 2 + 88 }, (_, index) => ({
      uid: `stream-${index}`,
      raw: {
        _valm_ItemID: `STREAM-${index}`,
        description: `文本 ${index}，包含逗号、换行\n以及 ] 和 \\" 引号`
      },
      nested: { values: [index, index + 1] }
    }))
    const jsonlPath = join(directory, 'records.jsonl')
    writeFileSync(
      jsonlPath,
      `\uFEFF${sourceRows.map((row) => JSON.stringify(row)).join('\n')}\n不是 JSON\n`,
      'utf8'
    )
    const jsonlBatches: unknown[][] = []
    const jsonlContexts: Array<{ batchNumber: number; sourceRowCount: number; parseErrorCount: number }> = []
    const jsonlErrors: string[] = []
    const jsonl = await readJsonlImportRows(jsonlPath, jsonlErrors, (batch, context) => {
      jsonlBatches.push(batch)
      if (context) jsonlContexts.push(context)
    })
    assert.equal(jsonl.rowCount, sourceRows.length)
    assert.equal(jsonl.parseErrorCount, 1)
    assert.deepEqual(jsonlBatches.map((batch) => batch.length), [256, 256, 88])
    assert.deepEqual(jsonlContexts.map((context) => context.batchNumber), [1, 2, 3])
    assert.deepEqual(jsonlContexts.map((context) => context.sourceRowCount), [256, 512, 600])
    assert.equal((jsonlBatches[0][0] as { uid: string }).uid, 'stream-0')
    assert.equal((jsonlBatches[2][87] as { uid: string }).uid, `stream-${sourceRows.length - 1}`)
    assert.match(jsonlErrors[0], new RegExp(`第 ${sourceRows.length + 1} 行`))

    const resumedJsonlBatches: unknown[][] = []
    const resumedJsonlContexts: Array<{ batchNumber: number; sourceRowCount: number; parseErrorCount: number }> = []
    const resumedJsonlErrors: string[] = []
    const resumedJsonl = await readJsonlImportRows(
      jsonlPath,
      resumedJsonlErrors,
      (batch, context) => {
        resumedJsonlBatches.push(batch)
        if (context) resumedJsonlContexts.push(context)
      },
      { sourceRowCount: 512, parseErrorCount: 0, batchCount: 2 }
    )
    assert.equal(resumedJsonl.rowCount, sourceRows.length)
    assert.equal(resumedJsonl.parseErrorCount, 1)
    assert.deepEqual(resumedJsonlBatches.map((batch) => batch.length), [88])
    assert.deepEqual(resumedJsonlContexts, [{ batchNumber: 3, sourceRowCount: 600, parseErrorCount: 1 }])
    assert.equal(resumedJsonlErrors.length, 1)
    assert.equal((resumedJsonlBatches[0][0] as { uid: string }).uid, 'stream-512')

    const arrayPath = join(directory, 'records.json')
    const arrayRows = [
      sourceRows[0],
      'not-an-object-but-valid-json',
      { ...sourceRows[1], raw: { _valm_ItemID: 'STREAM-1', description: '数组元素 ] , { }' } }
    ]
    writeFileSync(
      arrayPath,
      `[${JSON.stringify(arrayRows[0])},not-json,${JSON.stringify(arrayRows[2])}]`,
      'utf8'
    )
    const arrayBatches: unknown[][] = []
    const arrayErrors: string[] = []
    const array = await readJsonArrayImportRows(arrayPath, arrayErrors, (batch) => {
      arrayBatches.push(batch)
    })
    assert.equal(array.rowCount, 2)
    assert.equal(array.parseErrorCount, 1)
    assert.deepEqual(arrayBatches.map((batch) => batch.length), [2])
    assert.match(arrayErrors[0], /第 2 项/)

    const resumedArrayBatches: unknown[][] = []
    const resumedArrayErrors: string[] = []
    const resumedArray = await readJsonArrayImportRows(
      arrayPath,
      resumedArrayErrors,
      (batch) => resumedArrayBatches.push(batch),
      { sourceRowCount: 1, parseErrorCount: 0, batchCount: 0 }
    )
    assert.equal(resumedArray.rowCount, 2)
    assert.equal(resumedArray.parseErrorCount, 1)
    assert.deepEqual(resumedArrayBatches.map((batch) => batch.length), [1])
    assert.equal((resumedArrayBatches[0][0] as { uid: string }).uid, 'stream-1')
    assert.equal(resumedArrayErrors.length, 1)

    console.log(JSON.stringify({
      ok: true,
      jsonlRows: jsonl.rowCount,
      jsonlBatchSizes: jsonlBatches.map((batch) => batch.length),
      jsonlParseErrors: jsonl.parseErrorCount,
      jsonlCheckpoints: jsonlContexts.map((context) => context.sourceRowCount),
      jsonlResumeRows: resumedJsonlBatches.reduce((sum, batch) => sum + batch.length, 0),
      jsonArrayRows: array.rowCount,
      jsonArrayParseErrors: array.parseErrorCount,
      jsonArrayResumeRows: resumedArrayBatches.reduce((sum, batch) => sum + batch.length, 0)
    }, null, 2))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

void run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
