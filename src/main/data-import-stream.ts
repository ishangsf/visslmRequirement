import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

export const DATA_IMPORT_BATCH_SIZE = 256

export interface ImportBatchContext {
  /** 1-based committed batch number. */
  batchNumber: number
  /** Number of syntactically valid source rows seen up to this batch. */
  sourceRowCount: number
  /** Parser errors seen up to this batch; database rows are still committed independently. */
  parseErrorCount: number
}

export interface ImportResumeCheckpoint {
  /** Number of valid source rows already committed before interruption. */
  sourceRowCount: number
  /** Number of parser errors already observed before interruption. */
  parseErrorCount: number
  /** Number of committed batches already persisted before interruption. */
  batchCount: number
}

const normalizeResumeCheckpoint = (
  checkpoint?: Partial<ImportResumeCheckpoint>
): ImportResumeCheckpoint => ({
  sourceRowCount: Math.max(0, Math.trunc(checkpoint?.sourceRowCount ?? 0)),
  parseErrorCount: Math.max(0, Math.trunc(checkpoint?.parseErrorCount ?? 0)),
  batchCount: Math.max(0, Math.trunc(checkpoint?.batchCount ?? 0))
})

export type ImportBatchHandler = (rows: unknown[], context?: ImportBatchContext) => Promise<void> | void

const flushImportBatch = async (
  rows: unknown[],
  onBatch: ImportBatchHandler,
  context: ImportBatchContext
): Promise<number> => {
  if (!rows.length) return 0
  const batch = rows.splice(0, rows.length)
  await onBatch(batch, context)
  return batch.length
}

/**
 * Parse line-delimited JSON without materialising the complete source file.
 * Rows are handed to the database in bounded batches so a 512 MB legacy
 * export does not become a second 512 MB+ JavaScript allocation.
 */
export const readJsonlImportRows = async (
  filePath: string,
  parseErrors: string[],
  onBatch: ImportBatchHandler,
  resumeCheckpoint?: Partial<ImportResumeCheckpoint>
): Promise<{ rowCount: number; parseErrorCount: number }> => {
  const resume = normalizeResumeCheckpoint(resumeCheckpoint)
  const rows: unknown[] = []
  const input = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  let rowCount = 0
  let parseErrorCount = 0
  let batchNumber = 0
  try {
    for await (const line of lines) {
      lineNumber += 1
      const normalized = (lineNumber === 1 ? line.replace(/^\uFEFF/, '') : line).trim()
      if (!normalized) continue
      try {
        const parsed = JSON.parse(normalized) as unknown
        rowCount += 1
        if (rowCount <= resume.sourceRowCount) continue
        rows.push(parsed)
        if (rows.length >= DATA_IMPORT_BATCH_SIZE) {
          batchNumber += 1
          await flushImportBatch(rows, onBatch, {
            batchNumber: resume.batchCount + batchNumber,
            sourceRowCount: rowCount,
            parseErrorCount
          })
        }
      } catch {
        parseErrorCount += 1
        if (parseErrorCount <= resume.parseErrorCount) continue
        if (parseErrors.length < 50) {
          parseErrors.push(`第 ${lineNumber} 行：JSON 格式错误`)
        }
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  if (rows.length) {
    batchNumber += 1
    await flushImportBatch(rows, onBatch, {
      batchNumber: resume.batchCount + batchNumber,
      sourceRowCount: rowCount,
      parseErrorCount
    })
  }
  return { rowCount, parseErrorCount }
}

/**
 * Parse a top-level JSON array incrementally.  This deliberately keeps the
 * parser small and dependency-free: each element is isolated by tracking
 * string/escape state and nested object/array depth, then decoded by the
 * native JSON parser.  Invalid elements are reported and skipped, matching
 * the line-oriented legacy importer behaviour.
 */
export const readJsonArrayImportRows = async (
  filePath: string,
  parseErrors: string[],
  onBatch: ImportBatchHandler,
  resumeCheckpoint?: Partial<ImportResumeCheckpoint>
): Promise<{ rowCount: number; parseErrorCount: number }> => {
  const resume = normalizeResumeCheckpoint(resumeCheckpoint)
  const rows: unknown[] = []
  const input = createReadStream(filePath, { encoding: 'utf8' })
  let rootStarted = false
  let rootClosed = false
  let inString = false
  let escaped = false
  let nestedDepth = 0
  let elementStarted = false
  let elementIndex = 0
  let rowCount = 0
  let parseErrorCount = 0
  let batchNumber = 0
  let token = ''

  const recordParseError = (message: string, report = true): void => {
    parseErrorCount += 1
    if (report && parseErrors.length < 50) parseErrors.push(message)
  }

  const flushToken = async (): Promise<void> => {
    const normalized = token.trim()
    token = ''
    elementStarted = false
    elementIndex += 1
    if (!normalized) {
      recordParseError(`第 ${elementIndex} 项：JSON 格式错误`)
      return
    }
    try {
      const parsed = JSON.parse(normalized) as unknown
      rowCount += 1
      if (rowCount <= resume.sourceRowCount) return
      rows.push(parsed)
      if (rows.length >= DATA_IMPORT_BATCH_SIZE) {
        batchNumber += 1
        await flushImportBatch(rows, onBatch, {
          batchNumber: resume.batchCount + batchNumber,
          sourceRowCount: rowCount,
          parseErrorCount
        })
      }
    } catch {
      recordParseError(
        `第 ${elementIndex} 项：JSON 格式错误`,
        parseErrorCount + 1 > resume.parseErrorCount
      )
    }
  }

  try {
    for await (const chunk of input) {
      const text = String(chunk)
      for (let index = 0; index < text.length; index += 1) {
        const character = text[index]
        if (!rootStarted) {
          if (character === '\uFEFF' || /\s/.test(character)) continue
          if (character !== '[') throw new Error('JSON 文件根节点必须是数组')
          rootStarted = true
          continue
        }
        if (rootClosed) {
          if (/\s/.test(character)) continue
          throw new Error('JSON 文件数组后存在多余内容')
        }
        if (!inString && nestedDepth === 0 && character === ',') {
          if (!elementStarted) throw new Error('JSON 数组包含空元素')
          await flushToken()
          continue
        }
        if (!inString && nestedDepth === 0 && character === ']') {
          if (elementStarted) {
            await flushToken()
          } else if (elementIndex > 0) {
            throw new Error('JSON 数组末尾存在多余逗号')
          }
          rootClosed = true
          continue
        }

        token += character
        if (!elementStarted && !/\s/.test(character)) elementStarted = true
        if (inString) {
          if (escaped) escaped = false
          else if (character === '\\') escaped = true
          else if (character === '"') inString = false
        } else if (character === '"') {
          inString = true
        } else if (character === '{' || character === '[') {
          nestedDepth += 1
        } else if (character === '}' || character === ']') {
          if (nestedDepth > 0) nestedDepth -= 1
        }
      }
    }
    if (!rootStarted || !rootClosed || inString || nestedDepth !== 0) {
      throw new Error('JSON 文件数组格式无效')
    }
  } finally {
    input.destroy()
  }
  if (rows.length) {
    batchNumber += 1
    await flushImportBatch(rows, onBatch, {
      batchNumber: resume.batchCount + batchNumber,
      sourceRowCount: rowCount,
      parseErrorCount
    })
  }
  return { rowCount, parseErrorCount }
}

export const detectJsonFirstToken = async (filePath: string): Promise<string> => {
  const input = createReadStream(filePath, { encoding: 'utf8' })
  try {
    for await (const chunk of input) {
      const text = String(chunk).replace(/^\uFEFF/, '')
      const first = text.match(/\S/)
      if (first?.[0]) return first[0]
    }
  } finally {
    input.destroy()
  }
  return ''
}
