import { createHash } from 'node:crypto'

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import PptxGenJS from 'pptxgenjs'
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
  type Zippable
} from 'fflate'
import * as XLSX from 'xlsx'

import type {
  AssistantArtifact,
  AssistantArtifactExportFile,
  AssistantArtifactExportManifest,
  AssistantArtifactInput,
  AssistantArtifactOutputFormat,
  ChatDataRow,
  ChatDataView,
  EvidenceBlock
} from '../../shared/types'
import type { AssistantExecutionSummary } from '../../shared/expert-types'

/** Fixed bounds keep a malformed or unexpectedly large model payload from
 * turning a local export into an unbounded memory/CPU operation. */
export const ARTIFACT_EXPORT_LIMITS = {
  titleChars: 160,
  questionChars: 16_000,
  answerChars: 120_000,
  instructionChars: 8_000,
  evidenceBlocks: 256,
  dataViews: 64,
  fieldsPerView: 128,
  rowsPerView: 5_000,
  rowsTotal: 20_000,
  cellsTotal: 400_000,
  sources: 20_000,
  cellChars: 32_000,
  summaryChars: 4_000,
  reportRowsPerView: 120,
  reportSources: 200,
  presentationSlides: 24,
  presentationRowsPerView: 8,
  presentationColumns: 8,
  outputBytes: 50 * 1024 * 1024,
  inputBytes: 20 * 1024 * 1024
} as const

const OUTPUT_EXTENSIONS: Record<AssistantArtifactOutputFormat, string> = {
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  zip: 'zip'
}

export const ARTIFACT_OUTPUT_MIME_TYPES: Record<AssistantArtifactOutputFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip'
}

const EPOCH_ISO = '1970-01-01T00:00:00.000Z'
// DOS timestamps cannot represent 1970.  1980-01-01 is the earliest valid
// ZIP timestamp and makes all generated package entries reproducible.
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0)
const ZIP_OPTIONS = { level: 6, mtime: ZIP_MTIME } as const

const OOXML_REQUIRED_ENTRIES: Record<Exclude<AssistantArtifactOutputFormat, 'zip'>, string[]> = {
  docx: ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'],
  xlsx: ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'],
  pptx: ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']
}

export interface ArtifactExportOptions {
  format: AssistantArtifactOutputFormat
  /** Optional display name. It is treated as a file name, never as a path. */
  fileName?: string
  /** Saved artifact ID. Unsaved inputs receive a stable content-derived ID. */
  artifactId?: string
  instructions?: string
}

export type ArtifactExportSource = AssistantArtifact | AssistantArtifactInput

export interface ArtifactSourceSummary {
  blockCount: number
  recordCount: number
  documentCount: number
  queryMatchedCount: number
  dataViewCount: number
  sourceCount: number
}

export interface ArtifactExportOutput {
  bytes: Uint8Array
  fileName: string
  mimeType: string
  byteSize: number
  sha256: string
  manifest: AssistantArtifactExportManifest
  sourceSummary: ArtifactSourceSummary
}

export class ArtifactExportError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ArtifactExportError'
    this.code = code
  }
}

const fail = (code: string, message: string): never => {
  throw new ArtifactExportError(code, message)
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const assertString = (value: unknown, field: string, maxChars: number): string => {
  if (typeof value !== 'string') fail('ARTIFACT_INVALID_INPUT', `${field}必须是文本`)
  const valueText = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
  if (!valueText.trim()) fail('ARTIFACT_INVALID_INPUT', `${field}不能为空`)
  if (valueText.length > maxChars) fail('ARTIFACT_INPUT_TOO_LARGE', `${field}超过${maxChars}字符上限`)
  return valueText
}

const optionalString = (value: unknown, field: string, maxChars: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('ARTIFACT_INVALID_INPUT', `${field}必须是文本`)
  const valueText = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
  if (valueText.length > maxChars) fail('ARTIFACT_INPUT_TOO_LARGE', `${field}超过${maxChars}字符上限`)
  return valueText
}

const finiteCount = (value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    fail('ARTIFACT_INVALID_INPUT', `${field}必须是范围内的非负整数`)
  }
  return value as number
}

const boundedArray = <T>(value: unknown, field: string, max: number): T[] => {
  if (!Array.isArray(value)) fail('ARTIFACT_INVALID_INPUT', `${field}必须是数组`)
  if ((value as unknown[]).length > max) fail('ARTIFACT_INPUT_TOO_LARGE', `${field}超过${max}项上限`)
  return value as T[]
}

const toText = (value: unknown, field = '值', maxChars: number = ARTIFACT_EXPORT_LIMITS.cellChars): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .slice(0, maxChars)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'bigint') return String(value)
  try {
    return stableJson(value).slice(0, maxChars)
  } catch {
    fail('ARTIFACT_INVALID_INPUT', `${field}无法转换为文本`)
  }
  return ''
}

const plainText = (value: unknown, field = '文本', maxChars: number = ARTIFACT_EXPORT_LIMITS.cellChars): string => {
  const text = toText(value, field, maxChars)
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p\s*>/giu, '\n')
    .replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
  return text.slice(0, maxChars)
}

const clipText = (value: unknown, maxChars: number, field = '文本'): string => {
  const text = plainText(value, field, Math.max(maxChars, 1))
  if (text.length <= maxChars) return text
  const marker = '…[已截断]'
  return `${text.slice(0, Math.max(0, maxChars - marker.length))}${marker}`
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return String(value)
  if (isRecord(value)) {
    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue(value[key])
      return result
    }, {})
  }
  return value
}

const stableJson = (value: unknown): string => {
  const json = JSON.stringify(stableValue(value))
  return json === undefined ? 'null' : json
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const sha256Json = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex')

const isSavedArtifact = (value: ArtifactExportSource): value is AssistantArtifact => (
  isRecord(value) && isRecord(value.payload) && typeof value.id === 'string'
)

interface NormalizedRow {
  group: string
  row: ChatDataRow
}

interface NormalizedView {
  id: string
  title: string
  description: string
  total: number
  isPreview: boolean
  fields: string[]
  fieldLabels: Record<string, string>
  rows: NormalizedRow[]
}

interface NormalizedArtifact {
  artifactId: string
  version?: number
  generatedAt: string
  input: AssistantArtifactInput
  views: NormalizedView[]
  sourceSummary: ArtifactSourceSummary
}

const validEvidenceKinds = new Set<EvidenceBlock['kind']>([
  'record',
  'document',
  'aggregate',
  'query_detail'
])

const normalizeSources = (rawSources: unknown): AssistantArtifactInput['sources'] => {
  if (rawSources === undefined) return undefined
  const sources = boundedArray<Record<string, unknown>>(
    rawSources,
    'sources',
    ARTIFACT_EXPORT_LIMITS.sources
  )
  return sources.map((source, index) => {
    if (!isRecord(source)) fail('ARTIFACT_INVALID_INPUT', `sources[${index}]格式无效`)
    const uid = assertString(source.uid, `sources[${index}].uid`, 300)
    const name = assertString(source.name, `sources[${index}].name`, 1_000)
    const nodeType = assertString(source.nodeType, `sources[${index}].nodeType`, 300)
    const itemId = assertString(source.itemId, `sources[${index}].itemId`, 300)
    return {
      uid,
      name,
      nodeType,
      itemId,
      ...(source.sourceType === 'document' || source.sourceType === 'record'
        ? { sourceType: source.sourceType }
        : {}),
      ...(optionalString(source.documentId, `sources[${index}].documentId`, 300)
        ? { documentId: optionalString(source.documentId, `sources[${index}].documentId`, 300) }
        : {}),
      ...(optionalString(source.chunkId, `sources[${index}].chunkId`, 300)
        ? { chunkId: optionalString(source.chunkId, `sources[${index}].chunkId`, 300) }
        : {}),
      ...(optionalString(source.fileName, `sources[${index}].fileName`, 1_000)
        ? { fileName: optionalString(source.fileName, `sources[${index}].fileName`, 1_000) }
        : {}),
      ...(optionalString(source.location, `sources[${index}].location`, 1_000)
        ? { location: optionalString(source.location, `sources[${index}].location`, 1_000) }
        : {}),
      ...(typeof source.pageNumber === 'number' && Number.isSafeInteger(source.pageNumber) && source.pageNumber >= 0
        ? { pageNumber: source.pageNumber }
        : {}),
      ...(optionalString(source.sheetName, `sources[${index}].sheetName`, 300)
        ? { sheetName: optionalString(source.sheetName, `sources[${index}].sheetName`, 300) }
        : {}),
      ...(optionalString(source.snippet, `sources[${index}].snippet`, ARTIFACT_EXPORT_LIMITS.summaryChars)
        ? { snippet: optionalString(source.snippet, `sources[${index}].snippet`, ARTIFACT_EXPORT_LIMITS.summaryChars) }
        : {}),
      ...(typeof source.score === 'number' && Number.isFinite(source.score)
        ? { score: source.score }
        : {})
    }
  })
}

const normalizeDataViews = (
  rawViews: unknown
): { views: NormalizedView[]; totalRows: number; totalCells: number } => {
  const dataViews = boundedArray<Record<string, unknown>>(
    rawViews,
    'dataViews',
    ARTIFACT_EXPORT_LIMITS.dataViews
  )
  let totalRows = 0
  let totalCells = 0
  const views = dataViews.map((rawView, viewIndex): NormalizedView => {
    if (!isRecord(rawView)) fail('ARTIFACT_INVALID_INPUT', `dataViews[${viewIndex}]格式无效`)
    const id = assertString(rawView.id, `dataViews[${viewIndex}].id`, 300)
    const title = assertString(rawView.title, `dataViews[${viewIndex}].title`, ARTIFACT_EXPORT_LIMITS.titleChars)
    const description = optionalString(rawView.description, `dataViews[${viewIndex}].description`, ARTIFACT_EXPORT_LIMITS.summaryChars) ?? ''
    const groups = boundedArray<Record<string, unknown>>(
      rawView.groups,
      `dataViews[${viewIndex}].groups`,
      ARTIFACT_EXPORT_LIMITS.rowsPerView
    )
    const fieldsRaw = boundedArray<unknown>(
      rawView.fields,
      `dataViews[${viewIndex}].fields`,
      ARTIFACT_EXPORT_LIMITS.fieldsPerView
    )
    const fields = [...new Set(fieldsRaw.map((field, fieldIndex) => (
      assertString(field, `dataViews[${viewIndex}].fields[${fieldIndex}]`, 300)
    )))]
    const fieldLabelsRaw = isRecord(rawView.fieldLabels) ? rawView.fieldLabels : {}
    const fieldLabels: Record<string, string> = {}
    for (const field of fields) {
      const label = optionalString(fieldLabelsRaw[field], `dataViews[${viewIndex}].fieldLabels.${field}`, 300)
      fieldLabels[field] = label?.trim() || field
    }

    const rows: NormalizedRow[] = []
    for (const [groupIndex, rawGroup] of groups.entries()) {
      if (!isRecord(rawGroup)) fail('ARTIFACT_INVALID_INPUT', `dataViews[${viewIndex}].groups[${groupIndex}]格式无效`)
      const group = optionalString(rawGroup.name, `dataViews[${viewIndex}].groups[${groupIndex}].name`, 300) ?? ''
      const groupRows = boundedArray<Record<string, unknown>>(
        rawGroup.rows,
        `dataViews[${viewIndex}].groups[${groupIndex}].rows`,
        ARTIFACT_EXPORT_LIMITS.rowsPerView
      )
      for (const [rowIndex, rawRow] of groupRows.entries()) {
        if (!isRecord(rawRow)) fail('ARTIFACT_INVALID_INPUT', `dataViews[${viewIndex}]行格式无效`)
        const values = isRecord(rawRow.values) ? rawRow.values : fail(
          'ARTIFACT_INVALID_INPUT',
          `dataViews[${viewIndex}].groups[${groupIndex}].rows[${rowIndex}].values格式无效`
        )
        const row = {
          uid: assertString(rawRow.uid, `dataViews[${viewIndex}].rows[${rowIndex}].uid`, 300),
          name: assertString(rawRow.name, `dataViews[${viewIndex}].rows[${rowIndex}].name`, 1_000),
          nodeType: assertString(rawRow.nodeType, `dataViews[${viewIndex}].rows[${rowIndex}].nodeType`, 300),
          itemId: assertString(rawRow.itemId, `dataViews[${viewIndex}].rows[${rowIndex}].itemId`, 300),
          values: Object.keys(values).sort().reduce<Record<string, string | string[]>>((result, key) => {
            const value = values[key]
            if (typeof value === 'string') result[key] = clipText(value, ARTIFACT_EXPORT_LIMITS.cellChars, `${id}.${key}`)
            else if (Array.isArray(value)) result[key] = value.map((entry) => (
              clipText(entry, ARTIFACT_EXPORT_LIMITS.cellChars, `${id}.${key}`)
            ))
            else if (value === null || value === undefined) result[key] = ''
            else result[key] = clipText(value, ARTIFACT_EXPORT_LIMITS.cellChars, `${id}.${key}`)
            return result
          }, {})
        } satisfies ChatDataRow
        rows.push({ group, row })
        totalCells += 4 + Object.keys(values).length
        if (rows.length > ARTIFACT_EXPORT_LIMITS.rowsPerView) {
          fail('ARTIFACT_INPUT_TOO_LARGE', `数据视图“${title}”超过${ARTIFACT_EXPORT_LIMITS.rowsPerView}行上限`)
        }
        if (totalCells > ARTIFACT_EXPORT_LIMITS.cellsTotal) {
          fail('ARTIFACT_INPUT_TOO_LARGE', `交付物数据单元格超过${ARTIFACT_EXPORT_LIMITS.cellsTotal}项上限`)
        }
      }
    }
    totalRows += rows.length
    const rawTotal = rawView.total
    const total = rawTotal === undefined
      ? rows.length
      : finiteCount(rawTotal, `dataViews[${viewIndex}].total`, Number.MAX_SAFE_INTEGER)
    if (total < rows.length) fail('ARTIFACT_INVALID_INPUT', `dataViews[${viewIndex}].total小于已加载行数`)
    return {
      id,
      title,
      description,
      total,
      isPreview: rawView.isPreview === true || (typeof rawView.loadedRows === 'number' && rawView.loadedRows < total),
      fields,
      fieldLabels,
      rows
    }
  })
  if (totalRows > ARTIFACT_EXPORT_LIMITS.rowsTotal) {
    fail('ARTIFACT_INPUT_TOO_LARGE', `交付物数据行超过${ARTIFACT_EXPORT_LIMITS.rowsTotal}行上限`)
  }
  return { views, totalRows, totalCells }
}

const normalizeEvidenceBlocks = (
  rawBlocks: unknown,
  dataViews: readonly NormalizedView[],
  sources: AssistantArtifactInput['sources']
): { blocks: EvidenceBlock[]; summary: Omit<ArtifactSourceSummary, 'dataViewCount' | 'sourceCount'> & { sourceCount: number } } => {
  const blocks = boundedArray<Record<string, unknown>>(
    rawBlocks,
    'evidenceBlocks',
    ARTIFACT_EXPORT_LIMITS.evidenceBlocks
  )
  if (!blocks.length) fail('ARTIFACT_NO_EVIDENCE', '没有已验证 EvidenceBlock，禁止生成确定性交付物')
  const viewIds = new Set(dataViews.map((view) => view.id))
  const blockIds = new Set<string>()
  const sourceIndexesUsed = new Set<number>()
  let recordCount = 0
  let documentCount = 0
  let queryMatchedCount = 0
  let hasUsableEvidence = false
  const normalized: EvidenceBlock[] = blocks.map((rawBlock, index) => {
    if (!isRecord(rawBlock)) fail('ARTIFACT_INVALID_INPUT', `evidenceBlocks[${index}]格式无效`)
    const id = assertString(rawBlock.id, `evidenceBlocks[${index}].id`, 300)
    if (blockIds.has(id)) fail('ARTIFACT_INVALID_INPUT', `EvidenceBlock ID重复：${id}`)
    blockIds.add(id)
    const kind = rawBlock.kind
    if (typeof kind !== 'string' || !validEvidenceKinds.has(kind as EvidenceBlock['kind'])) {
      fail('ARTIFACT_INVALID_INPUT', `evidenceBlocks[${index}].kind不受支持`)
    }
    const title = assertString(rawBlock.title, `evidenceBlocks[${index}].title`, ARTIFACT_EXPORT_LIMITS.titleChars)
    const summary = clipText(rawBlock.summary, ARTIFACT_EXPORT_LIMITS.summaryChars, `evidenceBlocks[${index}].summary`)
    const count = finiteCount(rawBlock.count, `evidenceBlocks[${index}].count`, Number.MAX_SAFE_INTEGER)
    const sourceIndexes = rawBlock.sourceIndexes === undefined
      ? undefined
      : boundedArray<unknown>(rawBlock.sourceIndexes, `evidenceBlocks[${index}].sourceIndexes`, ARTIFACT_EXPORT_LIMITS.sources)
        .map((sourceIndex, sourceIndexPosition) => finiteCount(
          sourceIndex,
          `evidenceBlocks[${index}].sourceIndexes[${sourceIndexPosition}]`,
          Math.max(0, (sources?.length ?? 1) - 1)
        ))
    if (sourceIndexes) {
      for (const sourceIndex of sourceIndexes) {
        if (sources && sourceIndex >= sources.length) {
          fail('ARTIFACT_INVALID_EVIDENCE', `EvidenceBlock ${id} 引用了不存在的来源`)
        }
        sourceIndexesUsed.add(sourceIndex)
      }
    }
    const dataViewId = optionalString(rawBlock.dataViewId, `evidenceBlocks[${index}].dataViewId`, 300)
    if ((kind === 'aggregate' || kind === 'query_detail') && (!dataViewId || !viewIds.has(dataViewId))) {
      fail('ARTIFACT_INVALID_EVIDENCE', `EvidenceBlock ${id} 未关联有效数据视图`)
    }
    const matchedCount = rawBlock.matchedCount === undefined
      ? undefined
      : finiteCount(rawBlock.matchedCount, `evidenceBlocks[${index}].matchedCount`)
    const returnedCount = rawBlock.returnedCount === undefined
      ? undefined
      : finiteCount(rawBlock.returnedCount, `evidenceBlocks[${index}].returnedCount`)
    if (matchedCount !== undefined && returnedCount !== undefined && returnedCount > matchedCount) {
      fail('ARTIFACT_INVALID_EVIDENCE', `EvidenceBlock ${id} 的返回数超过命中数`)
    }
    const truncated = rawBlock.truncated === true
    if (count > 0 || (sourceIndexes?.length ?? 0) > 0 || (matchedCount ?? 0) > 0) hasUsableEvidence = true
    if (kind === 'record') recordCount += count
    if (kind === 'document') documentCount += count
    if (kind === 'aggregate' || kind === 'query_detail') queryMatchedCount += matchedCount ?? count
    return {
      id,
      kind: kind as EvidenceBlock['kind'],
      title,
      summary,
      count,
      ...(sourceIndexes ? { sourceIndexes } : {}),
      ...(dataViewId ? { dataViewId } : {}),
      ...(matchedCount === undefined ? {} : { matchedCount }),
      ...(returnedCount === undefined ? {} : { returnedCount }),
      ...(truncated ? { truncated: true } : {})
    }
  })
  if (!hasUsableEvidence) fail('ARTIFACT_NO_EVIDENCE', 'EvidenceBlock 均为空，禁止生成确定性交付物')
  return {
    blocks: normalized,
    summary: {
      blockCount: normalized.length,
      recordCount,
      documentCount,
      queryMatchedCount,
      sourceCount: sources ? sourceIndexesUsed.size || sources.length : sourceIndexesUsed.size
    }
  }
}

const normalizedTimestamp = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) return EPOCH_ISO
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? EPOCH_ISO : date.toISOString()
}

const normalizeInput = (
  source: ArtifactExportSource,
  options: ArtifactExportOptions
): NormalizedArtifact => {
  const saved = isSavedArtifact(source)
  if (saved && source.status !== 'active') fail('ARTIFACT_REVERTED', '已撤销的交付物不能导出')
  const rawInput = saved ? source.payload : source
  if (!isRecord(rawInput)) fail('ARTIFACT_INVALID_INPUT', '交付物输入格式无效')
  const inputType = rawInput.type
  if (typeof inputType !== 'string' || ![
    'analysis_snapshot',
    'saved_filter',
    'report_draft',
    'delivery_draft'
  ].includes(inputType)) {
    fail('ARTIFACT_INVALID_INPUT', '不支持的交付物类型')
  }
  const title = assertString(rawInput.title, '交付物标题', ARTIFACT_EXPORT_LIMITS.titleChars)
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
  const question = assertString(rawInput.question, '交付物问题', ARTIFACT_EXPORT_LIMITS.questionChars)
  const answer = assertString(rawInput.answer, '已验证回答', ARTIFACT_EXPORT_LIMITS.answerChars)
  const conversationId = assertString(rawInput.conversationId, 'conversationId', 300).trim()
  const messageId = assertString(rawInput.messageId, 'messageId', 300).trim()
  const sources = normalizeSources(rawInput.sources)
  const { views, totalRows, totalCells } = normalizeDataViews(rawInput.dataViews)
  const { blocks, summary } = normalizeEvidenceBlocks(rawInput.evidenceBlocks, views, sources)
  if (totalRows > ARTIFACT_EXPORT_LIMITS.rowsTotal || totalCells > ARTIFACT_EXPORT_LIMITS.cellsTotal) {
    fail('ARTIFACT_INPUT_TOO_LARGE', '交付物数据超过安全上限')
  }

  const executionSummary = rawInput.executionSummary
  let normalizedExecutionSummary: AssistantExecutionSummary | undefined
  if (executionSummary !== undefined) {
    if (!isRecord(executionSummary)) fail('ARTIFACT_INVALID_INPUT', 'executionSummary格式无效')
    const sourceModes = new Set<AssistantExecutionSummary['sourceMode']>([
      'conversation',
      'records',
      'knowledge',
      'mixed'
    ])
    const resultModes = new Set<AssistantExecutionSummary['resultMode']>([
      'answer',
      'list',
      'grouped_list',
      'table',
      'dashboard'
    ])
    if (typeof executionSummary.sourceMode !== 'string' || !sourceModes.has(
      executionSummary.sourceMode as AssistantExecutionSummary['sourceMode']
    )) fail('ARTIFACT_INVALID_INPUT', 'executionSummary.sourceMode不受支持')
    if (typeof executionSummary.resultMode !== 'string' || !resultModes.has(
      executionSummary.resultMode as AssistantExecutionSummary['resultMode']
    )) fail('ARTIFACT_INVALID_INPUT', 'executionSummary.resultMode不受支持')
    normalizedExecutionSummary = {
      question: clipText(executionSummary.question, ARTIFACT_EXPORT_LIMITS.questionChars, 'executionSummary.question'),
      taskType: assertString(executionSummary.taskType, 'executionSummary.taskType', 100),
      sourceMode: executionSummary.sourceMode as AssistantExecutionSummary['sourceMode'],
      resultMode: executionSummary.resultMode as AssistantExecutionSummary['resultMode'],
      intent: assertString(executionSummary.intent, 'executionSummary.intent', 200),
      searchTerms: boundedArray<unknown>(executionSummary.searchTerms, 'executionSummary.searchTerms', 128)
        .map((term, index) => assertString(term, `executionSummary.searchTerms[${index}]`, 300)),
      fields: boundedArray<unknown>(executionSummary.fields, 'executionSummary.fields', ARTIFACT_EXPORT_LIMITS.fieldsPerView)
        .map((field, index) => assertString(field, `executionSummary.fields[${index}]`, 300)),
      filters: boundedArray<Record<string, unknown>>(executionSummary.filters, 'executionSummary.filters', 256)
        .map((filter, index) => {
          if (!isRecord(filter)) fail('ARTIFACT_INVALID_INPUT', `executionSummary.filters[${index}]格式无效`)
          return {
            field: assertString(filter.field, `executionSummary.filters[${index}].field`, 300),
            operator: assertString(filter.operator, `executionSummary.filters[${index}].operator`, 100),
            ...(optionalString(filter.value, `executionSummary.filters[${index}].value`, 1_000)
              ? { value: optionalString(filter.value, `executionSummary.filters[${index}].value`, 1_000) }
              : {})
          }
        }),
      ...(optionalString(executionSummary.groupByField, 'executionSummary.groupByField', 300)
        ? { groupByField: optionalString(executionSummary.groupByField, 'executionSummary.groupByField', 300) }
        : {}),
      ...(isRecord(executionSummary.sort)
        ? {
            sort: {
              field: assertString(executionSummary.sort.field, 'executionSummary.sort.field', 300),
              direction: executionSummary.sort.direction === 'desc' ? 'desc' as const : 'asc' as const
            }
          }
        : {}),
      limit: finiteCount(executionSummary.limit, 'executionSummary.limit'),
      scope: (() => {
        if (!isRecord(executionSummary.scope)) fail('ARTIFACT_INVALID_INPUT', 'executionSummary.scope格式无效')
        return {
          projectIds: boundedArray<unknown>(executionSummary.scope.projectIds, 'executionSummary.scope.projectIds', 256)
            .map((projectId, index) => assertString(projectId, `executionSummary.scope.projectIds[${index}]`, 300)),
          nodeTypes: boundedArray<unknown>(executionSummary.scope.nodeTypes, 'executionSummary.scope.nodeTypes', 256)
            .map((nodeType, index) => assertString(nodeType, `executionSummary.scope.nodeTypes[${index}]`, 300)),
          ...(executionSummary.scope.recordCount === undefined
            ? {}
            : { recordCount: finiteCount(executionSummary.scope.recordCount, 'executionSummary.scope.recordCount') }),
          baseFilters: boundedArray<Record<string, unknown>>(executionSummary.scope.baseFilters, 'executionSummary.scope.baseFilters', 256)
            .map((filter, index) => {
              if (!isRecord(filter)) fail('ARTIFACT_INVALID_INPUT', `executionSummary.scope.baseFilters[${index}]格式无效`)
              return {
                field: assertString(filter.field, `executionSummary.scope.baseFilters[${index}].field`, 300),
                operator: assertString(filter.operator, `executionSummary.scope.baseFilters[${index}].operator`, 100),
                ...(optionalString(filter.value, `executionSummary.scope.baseFilters[${index}].value`, 1_000)
                  ? { value: optionalString(filter.value, `executionSummary.scope.baseFilters[${index}].value`, 1_000) }
                  : {})
              }
            }),
          ...(optionalString(executionSummary.scope.snapshotAt, 'executionSummary.scope.snapshotAt', 100)
            ? { snapshotAt: optionalString(executionSummary.scope.snapshotAt, 'executionSummary.scope.snapshotAt', 100) }
            : {})
        }
      })()
    }
  }

  // Ensure the stored payload remains structurally equivalent while replacing
  // untrusted text with bounded, XML-safe values. No database or source lookup
  // happens here: export only consumes this validated snapshot.
  const effectiveInstructions = options.instructions ?? rawInput.instructions
  const normalizedInput: AssistantArtifactInput = {
    ...rawInput,
    type: inputType as AssistantArtifactInput['type'],
    conversationId,
    messageId,
    title,
    question,
    answer,
    evidenceBlocks: blocks,
    dataViews: views.map((view) => ({
      id: view.id,
      title: view.title,
      description: view.description,
      total: view.total,
      loadedRows: view.rows.length,
      isPreview: view.isPreview,
      fields: view.fields,
      fieldLabels: view.fieldLabels,
      groups: [{
        name: '',
        count: view.rows.length,
        rows: view.rows.map(({ row }) => row),
        recordUids: view.rows.map(({ row }) => row.uid)
      }]
    })),
    ...(sources ? { sources } : {}),
    ...(normalizedExecutionSummary ? { executionSummary: normalizedExecutionSummary } : {}),
    ...(optionalString(effectiveInstructions, 'instructions', ARTIFACT_EXPORT_LIMITS.instructionChars)
      ? { instructions: optionalString(effectiveInstructions, 'instructions', ARTIFACT_EXPORT_LIMITS.instructionChars) }
      : {})
  }
  const contentHash = sha256Json(normalizedInput)
  const artifactId = saved
    ? assertString(source.id, 'artifactId', 300)
    : options.artifactId?.trim() || `artifact-${contentHash.slice(0, 24)}`
  if (options.artifactId !== undefined && !options.artifactId.trim()) {
    fail('ARTIFACT_INVALID_INPUT', 'artifactId不能为空')
  }
  return {
    artifactId,
    ...(saved && Number.isSafeInteger(source.version) && source.version > 0 ? { version: source.version } : {}),
    generatedAt: saved
      ? normalizedTimestamp(source.updatedAt)
      : normalizedTimestamp(normalizedExecutionSummary?.scope.snapshotAt),
    input: normalizedInput,
    views,
    sourceSummary: {
      ...summary,
      dataViewCount: views.length,
      sourceCount: sources ? Math.max(summary.sourceCount, sources.length) : summary.sourceCount
    }
  }
}

const safeBaseName = (rawName: string, extension: string, strictPathCheck: boolean): string => {
  const original = rawName.trim()
  if (strictPathCheck && (/[\\/]/u.test(original) || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(original))) {
    fail('ARTIFACT_INVALID_FILENAME', '文件名不能包含路径分隔符或上级目录')
  }
  const withExtensionRemoved = original.replace(new RegExp(`\\.${extension}$`, 'iu'), '')
  const sanitized = withExtensionRemoved
    .replace(/[\\/]/gu, '_')
    .replace(/[<>:"|?*\u0000-\u001F]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  const base = Array.from(sanitized || 'VISSLM-交付物').slice(0, 96).join('')
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/iu.test(base)
  return `${reserved ? '_' : ''}${base}.${extension}`
}

export const artifactFileName = (
  snapshot: Pick<NormalizedArtifact, 'input'>,
  options: ArtifactExportOptions
): string => safeBaseName(
  options.fileName ?? snapshot.input.title,
  OUTPUT_EXTENSIONS[options.format],
  options.fileName !== undefined
)

const sourceSummaryForManifest = (summary: ArtifactSourceSummary): AssistantArtifactExportManifest['evidence'] => ({
  blockCount: summary.blockCount,
  recordCount: summary.recordCount,
  documentCount: summary.documentCount,
  queryMatchedCount: summary.queryMatchedCount,
  dataViewCount: summary.dataViewCount,
  sourceCount: summary.sourceCount
})

const manifestFor = (
  snapshot: NormalizedArtifact,
  format: AssistantArtifactOutputFormat,
  files: AssistantArtifactExportFile[]
): AssistantArtifactExportManifest => ({
  schemaVersion: '1.0',
  artifactId: snapshot.artifactId,
  title: snapshot.input.title,
  format,
  conversationId: snapshot.input.conversationId,
  messageId: snapshot.input.messageId,
  // A saved artifact's update time is stable. Unsaved input uses a snapshot
  // timestamp or the fixed epoch, so package bytes do not depend on wall time.
  generatedAt: snapshot.generatedAt,
  evidence: sourceSummaryForManifest(snapshot.sourceSummary),
  files
})

const xmlText = (value: unknown): string => plainText(value, 'XML文本', ARTIFACT_EXPORT_LIMITS.cellChars)

const docxParagraph = (
  value: unknown,
  options: { heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; bold?: boolean } = {}
): Paragraph => (
  new Paragraph({
    ...(options.heading ? { heading: options.heading } : {}),
    children: [new TextRun({
      text: xmlText(value),
      ...(options.bold ? { bold: true } : {})
    })]
  })
)

const docxCell = (value: unknown, header = false): TableCell => new TableCell({
  shading: header ? { type: ShadingType.CLEAR, fill: '2F1B4F' } : undefined,
  children: [new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({
      text: clipText(value, 2_000, 'DOCX单元格'),
      bold: header,
      color: header ? 'FFFFFF' : undefined
    })]
  })]
})

const docxTable = (headers: string[], rows: string[][]): Table => new Table({
  width: { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    new TableRow({ children: headers.map((header) => docxCell(header, true)) }),
    ...rows.map((row) => new TableRow({
      children: headers.map((_header, index) => docxCell(row[index] ?? ''))
    }))
  ],
  borders: {
    top: { style: BorderStyle.SINGLE, size: 4, color: 'B7A8C7' },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: 'B7A8C7' },
    left: { style: BorderStyle.SINGLE, size: 4, color: 'B7A8C7' },
    right: { style: BorderStyle.SINGLE, size: 4, color: 'B7A8C7' },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'D9D2E2' },
    insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'D9D2E2' }
  }
})

const rowColumns = (view: NormalizedView): Array<{ key: string; label: string }> => [
  { key: '__uid', label: '记录 UID' },
  { key: '__name', label: '名称' },
  { key: '__nodeType', label: '节点类型' },
  { key: '__itemId', label: '项目编号' },
  ...view.fields.map((field) => ({ key: field, label: view.fieldLabels[field] ?? field }))
]

const rowValue = (row: ChatDataRow, key: string): string => {
  if (key === '__uid') return row.uid
  if (key === '__name') return row.name
  if (key === '__nodeType') return row.nodeType
  if (key === '__itemId') return row.itemId
  const value = row.values[key]
  return Array.isArray(value) ? value.join('、') : toText(value, key)
}

const buildReport = async (snapshot: NormalizedArtifact): Promise<Uint8Array> => {
  const input = snapshot.input
  const children: Array<Paragraph | Table> = []
  children.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: xmlText(input.title), bold: true, size: 34, color: '4B2673' })]
  }))
  children.push(docxParagraph(`生成时间：${snapshot.generatedAt}`))
  children.push(docxParagraph('本报告仅整理已验证回答、EvidenceBlock 与 DataView 快照，不执行任何数据写入。'))
  children.push(docxParagraph('问题', { heading: HeadingLevel.HEADING_1 }))
  children.push(docxParagraph(input.question))

  children.push(docxParagraph('回答', { heading: HeadingLevel.HEADING_1 }))
  const answerParts = plainText(input.answer, '已验证回答', ARTIFACT_EXPORT_LIMITS.answerChars).split(/\r?\n/u)
  for (const part of answerParts.slice(0, 400)) children.push(docxParagraph(part || ' '))
  if (answerParts.length > 400) children.push(docxParagraph('回答内容已按安全上限截断。'))

  if (input.executionSummary) {
    const summary = input.executionSummary
    children.push(docxParagraph('执行摘要', { heading: HeadingLevel.HEADING_1 }))
    children.push(docxTable(
      ['项目', '内容'],
      [
        ['任务类型', summary.taskType],
        ['来源模式', summary.sourceMode],
        ['结果形式', summary.resultMode],
        ['意图', summary.intent],
        ['检索词', summary.searchTerms.join('、')],
        ['字段', summary.fields.join('、')],
        ['过滤条件', summary.filters.map((filter) => `${filter.field} ${filter.operator}${filter.value ? ` ${filter.value}` : ''}`).join('；')],
        ['分组字段', summary.groupByField ?? ''],
        ['排序', summary.sort ? `${summary.sort.field} ${summary.sort.direction}` : ''],
        ['范围', `项目：${summary.scope.projectIds.join('、') || '全部'}；节点：${summary.scope.nodeTypes.join('、') || '全部'}；记录数：${summary.scope.recordCount ?? '未提供'}`]
      ].map((row) => row.map((cell) => clipText(cell, 2_000)))
    ))
  }

  children.push(docxParagraph('证据账本', { heading: HeadingLevel.HEADING_1 }))
  children.push(docxTable(
    ['ID', '类型', '标题', '摘要', '数量', '命中数', '返回数', '截断'],
    input.evidenceBlocks.map((block) => [
      block.id,
      block.kind,
      block.title,
      block.summary,
      String(block.count),
      block.matchedCount === undefined ? '' : String(block.matchedCount),
      block.returnedCount === undefined ? '' : String(block.returnedCount),
      block.truncated ? '是' : '否'
    ].map((cell) => clipText(cell, 2_000)))
  ))

  children.push(docxParagraph('数据视图', { heading: HeadingLevel.HEADING_1 }))
  for (const view of snapshot.views) {
    children.push(docxParagraph(view.title, { heading: HeadingLevel.HEADING_2 }))
    if (view.description) children.push(docxParagraph(view.description))
    const columns = rowColumns(view)
    const rows = view.rows.slice(0, ARTIFACT_EXPORT_LIMITS.reportRowsPerView).map(({ row }) => (
      columns.map((column) => clipText(rowValue(row, column.key), 2_000))
    ))
    children.push(docxTable(columns.map((column) => column.label), rows))
    if (view.rows.length > rows.length || view.isPreview) {
      children.push(docxParagraph(`此视图仅包含已加载的${view.rows.length}行；声明总数为${view.total}，完整数据请查看表格交付物。`))
    }
  }
  if (!snapshot.views.length) children.push(docxParagraph('当前回答没有附带 DataView；摘要与证据账本仍保留。'))

  const sourceRows = (input.sources ?? []).slice(0, ARTIFACT_EXPORT_LIMITS.reportSources).map((source) => [
    source.uid,
    source.sourceType ?? '',
    source.name,
    source.fileName ?? '',
    source.location ?? '',
    source.snippet ?? ''
  ].map((cell) => clipText(cell, 2_000)))
  if (sourceRows.length) {
    children.push(docxParagraph('来源定位', { heading: HeadingLevel.HEADING_1 }))
    children.push(docxTable(['UID', '类型', '名称', '文件', '位置', '摘录'], sourceRows))
  }
  if (input.instructions) {
    children.push(docxParagraph('生成说明', { heading: HeadingLevel.HEADING_1 }))
    children.push(docxParagraph(input.instructions))
  }

  const document = new Document({
    creator: 'VISSLM Agent',
    lastModifiedBy: 'VISSLM Agent',
    title: xmlText(input.title),
    subject: '基于已验证证据的 AI 交付物',
    description: 'VISSLM Agent evidence-only artifact',
    sections: [{
      properties: {
        page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } }
      },
      children
    }]
  })
  const packed = await Packer.toBuffer(document)
  return canonicalizePackage(new Uint8Array(packed), ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'])
}

const excelCell = (value: unknown): string | number | boolean => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'boolean') return value
  const text = clipText(value, 32_000, 'Excel单元格')
  // Excel treats leading =, +, -, and @ as formulas even when the source is
  // untrusted text. Apostrophe is the conventional literal-cell escape.
  return /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text
}

const excelColumnName = (index: number): string => {
  let current = index + 1
  let result = ''
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

const appendExcelSheet = (
  workbook: XLSX.WorkBook,
  name: string,
  headers: string[],
  rows: Array<Array<string | number | boolean>>
): void => {
  const safeHeaders = headers.map((header) => String(header).slice(0, 255))
  const sheet = XLSX.utils.aoa_to_sheet([safeHeaders, ...rows])
  sheet['!cols'] = safeHeaders.map((header, index) => ({
    wch: Math.min(52, Math.max(12, Math.max(header.length, ...rows.slice(0, 64).map((row) => String(row[index] ?? '').length)) + 2))
  }))
  sheet['!autofilter'] = {
    ref: `A1:${excelColumnName(Math.max(0, safeHeaders.length - 1))}${Math.max(1, rows.length + 1)}`
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name.slice(0, 31))
}

const uniqueSheetName = (name: string, used: Set<string>, fallback: string): string => {
  const sanitized = (name || fallback).replace(/[\\/*?:\[\]]/gu, '_').trim().slice(0, 31) || fallback
  let candidate = sanitized
  let suffix = 2
  while (used.has(candidate)) {
    const suffixText = `-${suffix}`
    candidate = `${sanitized.slice(0, 31 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

const buildWorkbook = (snapshot: NormalizedArtifact): Uint8Array => {
  const workbook = XLSX.utils.book_new()
  const usedSheets = new Set<string>()
  const summary = snapshot.sourceSummary
  appendExcelSheet(workbook, uniqueSheetName('摘要', usedSheets, '摘要'), ['项目', '内容'], [
    ['标题', excelCell(snapshot.input.title)],
    ['问题', excelCell(snapshot.input.question)],
    ['来源模式', excelCell(snapshot.input.executionSummary?.sourceMode ?? '未提供')],
    ['结果形式', excelCell(snapshot.input.executionSummary?.resultMode ?? '未提供')],
    ['EvidenceBlock 数', excelCell(summary.blockCount)],
    ['记录证据数', excelCell(summary.recordCount)],
    ['文档证据数', excelCell(summary.documentCount)],
    ['查询命中数', excelCell(summary.queryMatchedCount)],
    ['DataView 数', excelCell(summary.dataViewCount)],
    ['来源数', excelCell(summary.sourceCount)],
    ['生成时间', excelCell(snapshot.generatedAt)],
    ['说明', excelCell('本工作簿只包含已验证快照；没有执行任何数据库或知识库写入。')]
  ])

  appendExcelSheet(workbook, uniqueSheetName('证据', usedSheets, '证据'), [
    'EvidenceBlock ID', '类型', '标题', '摘要', '数量', '命中数', '返回数', '关联 DataView', '截断'
  ], snapshot.input.evidenceBlocks.map((block) => [
    excelCell(block.id),
    excelCell(block.kind),
    excelCell(block.title),
    excelCell(block.summary),
    excelCell(block.count),
    excelCell(block.matchedCount ?? ''),
    excelCell(block.returnedCount ?? ''),
    excelCell(block.dataViewId ?? ''),
    excelCell(block.truncated ? '是' : '否')
  ]))

  for (const view of snapshot.views) {
    const columns = rowColumns(view)
    const sheetRows = view.rows.map(({ row }) => columns.map((column) => excelCell(rowValue(row, column.key))))
    appendExcelSheet(
      workbook,
      uniqueSheetName(`查询-${view.title}`, usedSheets, '查询-数据视图'),
      columns.map((column) => column.label),
      sheetRows
    )
  }

  if (snapshot.input.sources?.length) {
    appendExcelSheet(workbook, uniqueSheetName('来源', usedSheets, '来源'), [
      'UID', '类型', '名称', '文件名', '位置', '页码', '工作表', '摘录'
    ], snapshot.input.sources.map((source) => [
      excelCell(source.uid),
      excelCell(source.sourceType ?? ''),
      excelCell(source.name),
      excelCell(source.fileName ?? ''),
      excelCell(source.location ?? ''),
      excelCell(source.pageNumber ?? ''),
      excelCell(source.sheetName ?? ''),
      excelCell(source.snippet ?? '')
    ]))
  }

  const written = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer',
    compression: true,
    cellDates: false
  })
  return canonicalizePackage(new Uint8Array(written), [
    '[Content_Types].xml',
    '_rels/.rels',
    'xl/workbook.xml',
    'xl/worksheets/sheet1.xml'
  ])
}

const splitForSlide = (value: string, maxChars: number): string[] => {
  const text = plainText(value, '演示文稿文本', ARTIFACT_EXPORT_LIMITS.cellChars)
  if (!text) return ['']
  const parts: string[] = []
  for (const line of text.split(/\r?\n/u)) {
    const characters = Array.from(line)
    if (!characters.length) {
      parts.push('')
      continue
    }
    for (let index = 0; index < characters.length; index += maxChars) {
      parts.push(characters.slice(index, index + maxChars).join(''))
    }
  }
  return parts
}

const pptTextOptions = {
  fontFace: 'Aptos',
  color: '25202D',
  fit: 'shrink',
  margin: 0.04,
  breakLine: false,
  valign: 'middle',
  wrap: true
} as const

const buildPresentation = async (snapshot: NormalizedArtifact): Promise<Uint8Array> => {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'VISSLM Agent'
  pptx.company = 'VISSLM'
  pptx.subject = '基于已验证证据的 AI 交付物'
  pptx.title = plainText(snapshot.input.title, '演示文稿标题', 200)
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos'
  }
  let slideCount = 0
  const addSlide = (title: string): ReturnType<PptxGenJS['addSlide']> => {
    if (slideCount >= ARTIFACT_EXPORT_LIMITS.presentationSlides) {
      fail('ARTIFACT_OUTPUT_TOO_LARGE', `演示文稿超过${ARTIFACT_EXPORT_LIMITS.presentationSlides}页上限`)
    }
    slideCount += 1
    const slide = pptx.addSlide()
    slide.background = { color: 'F7F4FA' }
    slide.addText(plainText(title, '幻灯片标题', 160), {
      ...pptTextOptions,
      x: 0.55,
      y: 0.28,
      w: 12.2,
      h: 0.55,
      fontFace: 'Aptos Display',
      fontSize: 24,
      bold: true,
      color: '4B2673'
    })
    slide.addText(`${slideCount}`, {
      ...pptTextOptions,
      x: 12.35,
      y: 7.08,
      w: 0.4,
      h: 0.2,
      fontSize: 8,
      color: '776A84',
      align: 'right'
    })
    return slide
  }

  let slide = addSlide(snapshot.input.title)
  slide.addText(splitForSlide(`问题：${snapshot.input.question}`, 180).join('\n'), {
    ...pptTextOptions,
    x: 0.72,
    y: 1.18,
    w: 11.9,
    h: 1.4,
    fontSize: 18,
    bold: true
  })
  slide.addText(`证据块 ${snapshot.sourceSummary.blockCount} · 数据视图 ${snapshot.sourceSummary.dataViewCount} · 记录证据 ${snapshot.sourceSummary.recordCount} · 文档证据 ${snapshot.sourceSummary.documentCount}`, {
    ...pptTextOptions,
    x: 0.72,
    y: 3.05,
    w: 11.9,
    h: 0.45,
    fontSize: 14,
    color: '665875'
  })
  slide.addText(`生成于 ${snapshot.generatedAt}；内容来自已验证快照。`, {
    ...pptTextOptions,
    x: 0.72,
    y: 6.45,
    w: 11.9,
    h: 0.35,
    fontSize: 10,
    color: '776A84'
  })

  const answerChunks = splitForSlide(snapshot.input.answer, 300)
  for (let index = 0; index < answerChunks.length; index += 8) {
    slide = addSlide(index === 0 ? '回答摘要' : '回答摘要（续）')
    const chunk = answerChunks.slice(index, index + 8).map((item) => `• ${item}`).join('\n')
    slide.addText(chunk, {
      ...pptTextOptions,
      x: 0.72,
      y: 1.05,
      w: 11.85,
      h: 5.75,
      fontSize: 17,
      breakLine: false
    })
  }

  slide = addSlide('证据账本')
  const evidenceRows = snapshot.input.evidenceBlocks.slice(0, 12).map((block) => [
    { text: clipText(block.id, 40) },
    { text: clipText(block.kind, 20) },
    { text: clipText(block.title, 36) },
    { text: clipText(block.summary, 90) },
    { text: String(block.count) }
  ])
  slide.addTable([
    [
      { text: 'ID', options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } } },
      { text: '类型', options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } } },
      { text: '标题', options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } } },
      { text: '摘要', options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } } },
      { text: '数量', options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } } }
    ],
    ...evidenceRows
  ], {
    x: 0.55,
    y: 1.05,
    w: 12.25,
    h: 5.75,
    colW: [1.45, 1.1, 2.2, 6.5, 1],
    rowH: 0.38,
    fontSize: 10,
    color: '25202D',
    border: { type: 'solid', color: 'C7B9D3', pt: 1 },
    fill: { color: 'FFFFFF' },
    margin: 0.04,
    autoPage: false
  })

  for (const view of snapshot.views) {
    if (slideCount >= ARTIFACT_EXPORT_LIMITS.presentationSlides) break
    const columns = rowColumns(view).slice(0, ARTIFACT_EXPORT_LIMITS.presentationColumns)
    slide = addSlide(view.title)
    if (view.description) {
      slide.addText(clipText(view.description, 180), {
        ...pptTextOptions,
        x: 0.7,
        y: 0.92,
        w: 11.95,
        h: 0.4,
        fontSize: 11,
        color: '665875'
      })
    }
    const tableRows = view.rows.slice(0, ARTIFACT_EXPORT_LIMITS.presentationRowsPerView).map(({ row }) => (
      columns.map((column) => ({ text: clipText(rowValue(row, column.key), 34) }))
    ))
    slide.addTable([
      columns.map((column) => ({
        text: clipText(column.label, 30),
        options: { bold: true, color: 'FFFFFF', fill: { color: '4B2673' } }
      })),
      ...tableRows
    ], {
      x: 0.5,
      y: view.description ? 1.45 : 1.0,
      w: 12.3,
      h: view.description ? 5.25 : 5.7,
      colW: columns.map(() => 12.3 / columns.length),
      rowH: 0.5,
      fontSize: columns.length > 6 ? 8 : 10,
      color: '25202D',
      border: { type: 'solid', color: 'C7B9D3', pt: 1 },
      fill: { color: 'FFFFFF' },
      margin: 0.03,
      autoPage: false
    })
    if (view.rows.length > tableRows.length || view.isPreview) {
      slide.addText(`展示前${tableRows.length}行；视图总数 ${view.total}。完整行请查看 XLSX。`, {
        ...pptTextOptions,
        x: 0.7,
        y: 6.72,
        w: 11.8,
        h: 0.25,
        fontSize: 9,
        color: '776A84'
      })
    }
  }
  if (snapshot.input.instructions && slideCount < ARTIFACT_EXPORT_LIMITS.presentationSlides) {
    slide = addSlide('生成说明')
    slide.addText(splitForSlide(snapshot.input.instructions, 280).join('\n'), {
      ...pptTextOptions,
      x: 0.72,
      y: 1.05,
      w: 11.8,
      h: 5.8,
      fontSize: 17
    })
  }

  const packed = await pptx.write({ outputType: 'uint8array' }) as Uint8Array
  return canonicalizePackage(packed, [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/slides/slide1.xml'
  ])
}

const stripVolatileCoreProperties = (xml: string): string => xml
  .replace(/<dcterms:created\b[^>]*>[\s\S]*?<\/dcterms:created>/gu, '')
  .replace(/<dcterms:modified\b[^>]*>[\s\S]*?<\/dcterms:modified>/gu, '')
  .replace(/<cp:lastPrinted\b[^>]*>[\s\S]*?<\/cp:lastPrinted>/gu, '')

const canonicalizePackage = (bytes: Uint8Array, requiredEntries: string[]): Uint8Array => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) {
    fail('ARTIFACT_PACKAGE_INVALID', '生成文件为空')
  }
  let entries: Record<string, Uint8Array<ArrayBuffer>> = {} = {}
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    fail('ARTIFACT_PACKAGE_INVALID', `无法读取 OOXML ZIP：${error instanceof Error ? error.message : String(error)}`)
  }
  const normalized: Zippable = {}
  for (const name of Object.keys(entries).sort()) {
    if (!name || name.endsWith('/')) continue
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) {
      fail('ARTIFACT_PACKAGE_INVALID', `文件包包含不安全路径：${name}`)
    }
    const content = name === 'docProps/core.xml'
      ? strToU8(stripVolatileCoreProperties(strFromU8(entries[name])))
      : entries[name]
    normalized[name] = [content, ZIP_OPTIONS]
  }
  const canonical = zipSync(normalized, ZIP_OPTIONS)
  validatePackage(canonical, requiredEntries)
  return canonical
}

const validatePackage = (bytes: Uint8Array, requiredEntries: string[]): void => {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    fail('ARTIFACT_PACKAGE_INVALID', '输出文件不是有效 ZIP/OOXML 包')
  }
  if (bytes.byteLength > ARTIFACT_EXPORT_LIMITS.outputBytes) {
    fail('ARTIFACT_OUTPUT_TOO_LARGE', `输出文件超过${ARTIFACT_EXPORT_LIMITS.outputBytes}字节上限`)
  }
  let entries: Record<string, Uint8Array<ArrayBuffer>> = {} = {}
  try {
    entries = unzipSync(bytes)
  } catch (error) {
    fail('ARTIFACT_PACKAGE_INVALID', `输出 ZIP 校验失败：${error instanceof Error ? error.message : String(error)}`)
  }
  for (const requiredEntry of requiredEntries) {
    const entry = entries[requiredEntry]
    if (!entry || entry.byteLength === 0) fail('ARTIFACT_PACKAGE_INVALID', `输出包缺少或包含空条目：${requiredEntry}`)
  }
  const totalBytes = Object.values(entries).reduce((sum, entry) => sum + entry.byteLength, 0)
  if (totalBytes > ARTIFACT_EXPORT_LIMITS.inputBytes * 4) {
    fail('ARTIFACT_OUTPUT_TOO_LARGE', '输出 ZIP 解压后超过安全上限')
  }
}

const createFileInfo = (name: string, mimeType: string, bytes: Uint8Array): AssistantArtifactExportFile => ({
  name,
  mimeType,
  byteSize: bytes.byteLength,
  sha256: sha256Of(bytes)
})

const buildBundle = (
  snapshot: NormalizedArtifact,
  report: Uint8Array,
  workbook: Uint8Array,
  presentation: Uint8Array
): { bytes: Uint8Array; manifest: AssistantArtifactExportManifest } => {
  const files = [
    createFileInfo('report.docx', ARTIFACT_OUTPUT_MIME_TYPES.docx, report),
    createFileInfo('table.xlsx', ARTIFACT_OUTPUT_MIME_TYPES.xlsx, workbook),
    createFileInfo('presentation.pptx', ARTIFACT_OUTPUT_MIME_TYPES.pptx, presentation)
  ]
  const manifest = manifestFor(snapshot, 'zip', files)
  const manifestBytes = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
  const bundle = zipSync({
    'manifest.json': [manifestBytes, ZIP_OPTIONS],
    'presentation.pptx': [presentation, ZIP_OPTIONS],
    'report.docx': [report, ZIP_OPTIONS],
    'table.xlsx': [workbook, ZIP_OPTIONS]
  }, ZIP_OPTIONS)
  validatePackage(bundle, ['manifest.json', 'report.docx', 'table.xlsx', 'presentation.pptx'])
  for (const file of files) {
    const bytes = unzipSync(bundle)[file.name]
    if (!bytes || sha256Of(bytes) !== file.sha256) fail('ARTIFACT_PACKAGE_INVALID', `导出包条目校验失败：${file.name}`)
  }
  return { bytes: bundle, manifest }
}

/**
 * Generate one deterministic deliverable from a saved or pending verified
 * AssistantArtifact. This function is intentionally pure with respect to the
 * application: it reads no database, performs no IPC, and never writes source
 * records or knowledge documents.
 */
export const exportAssistantArtifact = async (
  source: ArtifactExportSource,
  options: ArtifactExportOptions
): Promise<ArtifactExportOutput> => {
  if (!['docx', 'xlsx', 'pptx', 'zip'].includes(options.format)) {
    fail('ARTIFACT_UNSUPPORTED_FORMAT', '只支持 DOCX、XLSX、PPTX 或 ZIP')
  }
  const snapshot = normalizeInput(source, options)
  const fileName = artifactFileName(snapshot, options)
  let bytes: Uint8Array
  let manifest: AssistantArtifactExportManifest
  if (options.format === 'zip') {
    const [report, workbook, presentation] = await Promise.all([
      buildReport(snapshot),
      Promise.resolve(buildWorkbook(snapshot)),
      buildPresentation(snapshot)
    ])
    const bundle = buildBundle(snapshot, report, workbook, presentation)
    bytes = bundle.bytes
    manifest = bundle.manifest
  } else if (options.format === 'docx') {
    bytes = await buildReport(snapshot)
    manifest = manifestFor(snapshot, options.format, [
      createFileInfo(fileName, ARTIFACT_OUTPUT_MIME_TYPES.docx, bytes)
    ])
  } else if (options.format === 'xlsx') {
    bytes = buildWorkbook(snapshot)
    manifest = manifestFor(snapshot, options.format, [
      createFileInfo(fileName, ARTIFACT_OUTPUT_MIME_TYPES.xlsx, bytes)
    ])
  } else {
    bytes = await buildPresentation(snapshot)
    manifest = manifestFor(snapshot, options.format, [
      createFileInfo(fileName, ARTIFACT_OUTPUT_MIME_TYPES.pptx, bytes)
    ])
  }
  validatePackage(bytes, options.format === 'zip'
    ? ['manifest.json', 'report.docx', 'table.xlsx', 'presentation.pptx']
    : OOXML_REQUIRED_ENTRIES[options.format])
  return {
    bytes,
    fileName,
    mimeType: ARTIFACT_OUTPUT_MIME_TYPES[options.format],
    byteSize: bytes.byteLength,
    sha256: sha256Of(bytes),
    manifest,
    sourceSummary: snapshot.sourceSummary
  }
}

// Stable aliases make the core easy for the main-process orchestrator to use
// while retaining one implementation and one validation boundary.
export const generateAssistantArtifact = exportAssistantArtifact
export const createAssistantArtifactExport = exportAssistantArtifact

/** Compatibility entry used by the main-process IPC and regression harness. */
export const renderAssistantArtifact = (
  artifact: AssistantArtifact,
  format: AssistantArtifactOutputFormat,
  instructions?: string
): Promise<ArtifactExportOutput> => exportAssistantArtifact(artifact, {
  format,
  artifactId: artifact.id,
  instructions
})
