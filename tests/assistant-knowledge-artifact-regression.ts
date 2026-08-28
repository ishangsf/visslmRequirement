import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import * as XLSX from 'xlsx'
import { AssistantIntentRouter, resolveAssistantIntent } from '../src/main/assistant/intent-router'
import {
  assistantExecutionAgentRegistry,
  getAssistantExecutionAgent,
  resolveAssistantExecutionRoute
} from '../src/main/assistant/agent-registry'
import { KnowledgeBaseAgent } from '../src/main/assistant/agents/knowledge-base-agent'
import { ExpertRouter, expertRegistry } from '../src/main/experts/router'
import { AppDatabase } from '../src/main/database'
import type { ModelResponse } from '../src/main/model-client'
import type { KnowledgeSearchHit, KnowledgeService } from '../src/main/knowledge'
import type {
  AssistantArtifact,
  AssistantArtifactInput,
  AssistantArtifactOutputFormat,
  ChatSource,
  ModelSettings
} from '../src/shared/types'

const checks: string[] = []

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'knowledge-artifact-regression-model',
  thinking: false,
  apiKey: 'knowledge-artifact-regression-key'
}

const sources: ChatSource[] = [
  {
    uid: 'record:artifact-regression-001',
    name: '需求记录甲',
    nodeType: 'Requirement',
    itemId: 'REQ-001',
    sourceType: 'record',
    snippet: '记录来源内容。'
  },
  {
    uid: 'document:artifact-regression-guide',
    name: '交付规范',
    nodeType: 'knowledge_document',
    itemId: 'artifact-regression-guide',
    sourceType: 'document',
    documentId: 'artifact-regression-guide',
    chunkId: 'artifact-regression-guide-0',
    fileName: '交付规范.txt',
    location: '第 1 段',
    snippet: '文档来源内容。'
  }
]

const evidenceBlocks: AssistantArtifactInput['evidenceBlocks'] = [
  {
    id: 'evidence:records',
    kind: 'record',
    title: '数据中心记录',
    summary: '需求记录甲',
    count: 1,
    sourceIndexes: [0],
    dataViewId: 'view:records',
    matchedCount: 1,
    returnedCount: 1,
    truncated: false
  },
  {
    id: 'evidence:document',
    kind: 'document',
    title: '知识库文档',
    summary: '交付规范第 1 段',
    count: 1,
    sourceIndexes: [1]
  }
]

const dataViews: AssistantArtifactInput['dataViews'] = [{
  id: 'view:records',
  title: '需求结果',
  description: '已验证的需求记录快照',
  total: 1,
  loadedRows: 1,
  isPreview: false,
  fields: ['Owner', '危险等式', '危险加号', '危险减号', '危险@'],
  groups: [{
    name: '负责人甲',
    count: 1,
    rows: [{
      uid: 'record:artifact-regression-001',
      name: '需求记录甲',
      nodeType: 'Requirement',
      itemId: 'REQ-001',
      values: {
        Owner: '负责人甲',
        // These four values must remain literal text in XLSX cells.
        '危险等式': '=HYPERLINK("https://evil.invalid","打开")',
        '危险加号': '+cmd|/C calc',
        '危险减号': '-cmd|/C calc',
        '危险@': '@cmd'
      }
    }]
  }],
  recordUids: ['record:artifact-regression-001']
}]

const validInput: AssistantArtifactInput = {
  type: 'analysis_snapshot',
  conversationId: 'conversation:artifact-regression',
  messageId: 'message:artifact-regression',
  title: '季度/报告\\危险:*?"<>|',
  question: '请把已验证的记录和文档证据整理成可交付文件。',
  answer: '已验证结论：需求记录甲符合交付规范。<script>alert(1)</script>',
  evidenceBlocks,
  dataViews,
  sources,
  instructions: '仅使用已验证证据，不要补充未检索事实。'
}

const validArtifact = (input: AssistantArtifactInput = validInput): AssistantArtifact => ({
  id: 'artifact:knowledge-artifact-regression',
  type: input.type,
  status: 'active',
  version: 1,
  conversationId: input.conversationId,
  messageId: input.messageId,
  title: input.title,
  payload: input,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z'
})

const recordHit = (): KnowledgeSearchHit => ({
  source: {
    uid: 'record:knowledge-leak',
    name: '不应泄漏的记录',
    nodeType: 'Requirement',
    itemId: 'REQ-LEAK',
    sourceType: 'record'
  },
  chunk: {
    id: 'record-chunk',
    recordUid: 'record:knowledge-leak',
    sourceType: 'record',
    sourceName: '不应泄漏的记录',
    content: '不应作为知识库事实返回。',
    chunkIndex: 0,
    location: '记录正文',
    charStart: 0,
    charEnd: 13
  },
  score: 0.99
})

const documentHit = (): KnowledgeSearchHit => ({
  source: {
    uid: 'document:knowledge-safe',
    name: '授权文档',
    nodeType: 'knowledge_document',
    itemId: 'knowledge-safe',
    sourceType: 'document',
    documentId: 'knowledge-safe',
    chunkId: 'knowledge-safe-0',
    fileName: '授权文档.txt',
    location: '第 1 段'
  },
  chunk: {
    id: 'knowledge-safe-0',
    documentId: 'knowledge-safe',
    sourceType: 'document',
    sourceName: '授权文档',
    content: '可作为知识库依据的文档内容。',
    chunkIndex: 0,
    location: '第 1 段',
    charStart: 0,
    charEnd: 15
  },
  score: 0.9
})

const testIndependentKnowledgeExpertRoute = async (): Promise<void> => {
  const knowledge = expertRegistry.filter((expert) => expert.id === 'knowledge-base')
  assert.equal(knowledge.length, 1, 'knowledge-base must be a distinct UI expert')
  assert.equal(knowledge[0]?.name, '知识库专家')
  assert.equal(knowledge[0]?.mention, '@知识库专家')

  const expertRoute = new ExpertRouter().route({
    question: '@知识库专家 请根据上传文档回答',
    entrypoint: 'dashboard'
  })
  assert.equal(expertRoute.reason, 'explicit-mention')
  assert.equal(expertRoute.expert.id, 'knowledge-base')
  assert.equal(expertRoute.question, '请根据上传文档回答')

  let modelCalls = 0
  const client = {
    chat: async (): Promise<ModelResponse> => {
      modelCalls += 1
      throw new Error('explicit knowledge route must not invoke the classifier')
    }
  }
  const decision = await new AssistantIntentRouter(settings, client).resolve({
    question: '@知识库专家 请根据上传文档回答',
    entrypoint: 'dashboard',
    chatMode: 'auto'
  })
  assert.deepEqual(
    {
      taskType: decision.taskType,
      skillId: decision.skillId,
      sourceMode: decision.sourceMode,
      resultMode: decision.resultMode
    },
    {
      taskType: 'knowledge_qa',
      skillId: 'knowledge-base',
      sourceMode: 'knowledge',
      resultMode: 'answer'
    }
  )
  assert.equal(decision.needsClarification, false)
  assert.equal(modelCalls, 0)
  checks.push('知识库专家具有独立入口，显式 mention 优先并保留 knowledge 来源契约')
}

const testKnowledgeSourceIsolationAndPermissions = async (): Promise<void> => {
  const knowledgeDefinition = getAssistantExecutionAgent('knowledge-base')
  assert.ok(knowledgeDefinition)
  assert.deepEqual(knowledgeDefinition?.allowedTools, ['search_document_chunks'])
  assert.equal(knowledgeDefinition?.readonly, true)
  assert.throws(
    () => resolveAssistantExecutionRoute('knowledge_qa', 'records'),
    /未注册|不支持|不允许/u,
    'knowledge QA cannot execute against record source mode'
  )
  assert.deepEqual(
    resolveAssistantExecutionRoute('knowledge_qa', 'knowledge').agents.map((agent) => agent.id),
    ['knowledge-base']
  )

  const directory = await mkdtemp(join(tmpdir(), 'knowledge-artifact-regression-kb-'))
  const db = new AppDatabase(join(directory, 'knowledge.db'), join(directory, 'assets'))
  try {
    const calls: Array<{ question: string; limit?: number; sourceType?: string }> = []
    const fakeKnowledge = {
      modelVersion: 'knowledge-artifact-regression-model',
      search: async (
        question: string,
        limit?: number,
        options?: { sourceType?: string }
      ): Promise<KnowledgeSearchHit[]> => {
        calls.push({ question, limit, sourceType: options?.sourceType })
        return [recordHit(), documentHit()]
      }
    } as unknown as KnowledgeService
    const result = await new KnowledgeBaseAgent(db, fakeKnowledge).search('请查授权文档')
    assert.deepEqual(calls, [{
      question: '请查授权文档',
      limit: 8,
      sourceType: 'document'
    }])
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0]?.source.sourceType, 'document')
    assert.equal(result.hits[0]?.chunk.sourceType, 'document')
    assert.equal(result.hits.some((hit) => hit.source.sourceType === 'record'), false)
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
  checks.push('知识库执行 Agent 只调用文档检索并在结果边界过滤 record 来源')
}

const testArtifactRouteAndFailClosedPlanning = async (): Promise<void> => {
  let modelCalls = 0
  const client = {
    chat: async (): Promise<ModelResponse> => {
      modelCalls += 1
      throw new Error('explicit artifact route must not invoke the classifier')
    }
  }
  const withEvidence = await resolveAssistantIntent({
    question: '@交付物专家 导出为 xlsx',
    entrypoint: 'chat',
    chatMode: 'auto',
    artifactSource: { ...validInput, outputFormat: 'xlsx' }
  }, settings, client)
  assert.deepEqual(
    {
      taskType: withEvidence.taskType,
      skillId: withEvidence.skillId,
      sourceMode: withEvidence.sourceMode,
      resultMode: withEvidence.resultMode
    },
    {
      taskType: 'artifact_generation',
      skillId: 'artifact',
      sourceMode: 'mixed',
      resultMode: 'artifact'
    }
  )
  assert.equal(withEvidence.needsClarification, false)

  const withoutEvidence = await resolveAssistantIntent({
    question: '@交付物专家 导出为 xlsx',
    entrypoint: 'chat',
    chatMode: 'auto',
    artifactSource: { ...validInput, evidenceBlocks: [], outputFormat: 'xlsx' }
  }, settings, client)
  assert.equal(withoutEvidence.taskType, 'artifact_generation')
  assert.equal(withoutEvidence.skillId, 'artifact')
  assert.equal(withoutEvidence.resultMode, 'artifact')
  assert.equal(withoutEvidence.needsClarification, true)
  assert.match(withoutEvidence.clarificationQuestion ?? '', /证据|回答|交付物/u)
  assert.equal(modelCalls, 0, 'explicit artifact routing must stop before model/data access')
  checks.push('交付物专家仅在有 EvidenceBlock 时完成路由，无证据时澄清并 fail-closed')
}

interface ExportModule {
  exportAssistantArtifact?: (source: unknown, options: {
    format: AssistantArtifactOutputFormat
    fileName?: string
    artifactId?: string
    instructions?: string
  }) => unknown
  generateAssistantArtifact?: (source: unknown, options: {
    format: AssistantArtifactOutputFormat
    fileName?: string
    artifactId?: string
    instructions?: string
  }) => unknown
  createAssistantArtifactExport?: (source: unknown, options: {
    format: AssistantArtifactOutputFormat
    fileName?: string
    artifactId?: string
    instructions?: string
  }) => unknown
  renderAssistantArtifact?: (artifact: unknown, format: AssistantArtifactOutputFormat, instructions?: string) => unknown
  renderArtifact?: (input: unknown, format: AssistantArtifactOutputFormat, instructions?: string) => unknown
  generateArtifact?: (input: unknown, format: AssistantArtifactOutputFormat, instructions?: string) => unknown
  exportArtifact?: (input: unknown, format: AssistantArtifactOutputFormat, instructions?: string) => unknown
}

const loadExportModule = async (): Promise<ExportModule> => {
  const candidates = [
    join(process.cwd(), 'src/main/assistant/agents/artifact-agent.ts'),
    join(process.cwd(), 'src/main/assistant/artifact-exporter.ts')
  ]
  const filePath = candidates.find((candidate) => existsSync(candidate))
  assert.ok(filePath, 'an artifact-agent.ts or artifact-exporter.ts module must be present')
  return await import(pathToFileURL(filePath!).href) as ExportModule
}

const exportFunctionOf = (module: ExportModule): {
  name: keyof ExportModule
  invoke: (artifact: AssistantArtifact, format: AssistantArtifactOutputFormat) => Promise<unknown>
} => {
  const inputOptionsRenderer = (
    name: keyof ExportModule,
    fn: (source: unknown, options: {
      format: AssistantArtifactOutputFormat
      fileName?: string
      artifactId?: string
      instructions?: string
    }) => unknown
  ) => ({
    name,
    invoke: async (artifact: AssistantArtifact, format: AssistantArtifactOutputFormat) =>
      await fn(artifact.payload, { format, instructions: artifact.payload.instructions })
  })
  if (typeof module.exportAssistantArtifact === 'function') {
    return inputOptionsRenderer('exportAssistantArtifact', module.exportAssistantArtifact)
  }
  if (typeof module.generateAssistantArtifact === 'function') {
    return inputOptionsRenderer('generateAssistantArtifact', module.generateAssistantArtifact)
  }
  if (typeof module.createAssistantArtifactExport === 'function') {
    return inputOptionsRenderer('createAssistantArtifactExport', module.createAssistantArtifactExport)
  }
  if (typeof module.renderAssistantArtifact === 'function') {
    return {
      name: 'renderAssistantArtifact',
      invoke: async (artifact, format) => await module.renderAssistantArtifact!(artifact, format)
    }
  }
  const inputRenderer = (
    name: keyof ExportModule,
    fn: (input: unknown, format: AssistantArtifactOutputFormat, instructions?: string) => unknown
  ) => ({
    name,
    invoke: async (artifact: AssistantArtifact, format: AssistantArtifactOutputFormat) =>
      await fn(artifact.payload, format, artifact.payload.instructions)
  })
  if (typeof module.renderArtifact === 'function') return inputRenderer('renderArtifact', module.renderArtifact)
  if (typeof module.generateArtifact === 'function') return inputRenderer('generateArtifact', module.generateArtifact)
  if (typeof module.exportArtifact === 'function') return inputRenderer('exportArtifact', module.exportArtifact)
  throw new Error('artifact exporter must export a callable render/generate function')
}

interface RenderedArtifactLike {
  bytes?: Uint8Array | Buffer
  fileName?: string
  mimeType?: string
  manifest?: {
    format?: AssistantArtifactOutputFormat
    files?: Array<{ name: string; mimeType: string; byteSize: number; sha256: string }>
    [key: string]: unknown
  }
  filePath?: string
  byteSize?: number
  sha256?: string
}

const materializeRendered = async (
  raw: unknown,
  directory: string
): Promise<{ result: RenderedArtifactLike; bytes: Buffer }> => {
  assert.ok(raw && typeof raw === 'object', 'artifact renderer must return metadata')
  const result = raw as RenderedArtifactLike
  const bytes = result.bytes
    ? Buffer.from(result.bytes)
    : result.filePath
      ? await readFile(result.filePath)
      : undefined
  assert.ok(bytes && bytes.length > 0, 'artifact renderer must return non-empty bytes or a file path')
  const fileName = result.fileName || `rendered.${result.manifest?.format || 'bin'}`
  const localPath = join(directory, fileName)
  await writeFile(localPath, bytes!)
  assert.equal((await readFile(localPath)).byteLength, bytes!.byteLength)
  return { result, bytes: bytes! }
}

const assertOuterManifest = (
  result: RenderedArtifactLike,
  bytes: Buffer,
  format: AssistantArtifactOutputFormat
): void => {
  assert.equal(result.manifest?.format, format)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (format === 'zip') {
    assert.equal(result.byteSize, bytes.byteLength)
    assert.equal(result.sha256, sha256)
    assert.ok((result.manifest?.files?.length ?? 0) >= 3, 'ZIP manifest must describe its generated members')
    return
  }
  const file = result.manifest?.files?.find((candidate) => candidate.name === result.fileName) ?? result.manifest?.files?.[0]
  assert.ok(file, 'renderer manifest must include the generated file')
  assert.equal(file?.byteSize, bytes.byteLength)
  assert.equal(file?.sha256, sha256)
  assert.match(file?.sha256 ?? '', /^[a-f0-9]{64}$/u)
  assert.equal(result.byteSize === undefined || result.byteSize === bytes.byteLength, true)
  assert.equal(result.sha256 === undefined || result.sha256 === sha256, true)
}

const assertDocx = (bytes: Buffer): void => {
  const entries = unzipSync(bytes)
  const names = Object.keys(entries)
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml']) {
    assert.ok(names.includes(name), `DOCX must contain ${name}`)
    assert.ok(entries[name]!.byteLength > 0, `DOCX entry ${name} must be non-empty`)
  }
  const document = Buffer.from(entries['word/document.xml']!).toString('utf8')
  assert.match(document, /<w:document[\s>]/u)
  assert.doesNotMatch(document, /<script\b/iu)
  assert.doesNotMatch(document, /<\/script\s*>/iu)
}

const assertXlsx = (bytes: Buffer): void => {
  const entries = unzipSync(bytes)
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(entries[name], `XLSX must contain ${name}`)
    assert.ok(entries[name]!.byteLength > 0, `XLSX entry ${name} must be non-empty`)
  }
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true })
  assert.ok(workbook.SheetNames.length >= 2, 'XLSX must include summary and data sheets')
  const dataSheetName = workbook.SheetNames.find((name) => !['摘要', '证据', '来源'].includes(name)) ?? workbook.SheetNames[1]
  assert.ok(dataSheetName)
  const dataSheet = workbook.Sheets[dataSheetName!]
  assert.ok(dataSheet)
  const cells = Object.values(dataSheet!).filter((value): value is { v?: unknown; f?: string } => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  ))
  assert.equal(cells.some((cell) => typeof cell.f === 'string' && cell.f.trim().length > 0), false)
  const literalCells = cells.filter((cell) => typeof cell.v === 'string')
  for (const expected of ['=HYPERLINK(', '+cmd|', '-cmd|', '@cmd']) {
    assert.ok(literalCells.some((cell) => String(cell.v).includes(expected)), `XLSX must retain ${expected} as text`)
  }
}

const assertPptx = (bytes: Buffer): void => {
  const entries = unzipSync(bytes)
  for (const name of [
    '[Content_Types].xml',
    '_rels/.rels',
    'ppt/presentation.xml',
    'ppt/_rels/presentation.xml.rels',
    'ppt/slides/slide1.xml'
  ]) {
    assert.ok(entries[name], `PPTX must contain ${name}`)
    assert.ok(entries[name]!.byteLength > 0, `PPTX entry ${name} must be non-empty`)
  }
  const slide = Buffer.from(entries['ppt/slides/slide1.xml']!).toString('utf8')
  assert.match(slide, /<p:sld[\s>]/u)
  assert.doesNotMatch(slide, /<a:hlinkClick\b|<a:hlinkHover\b/iu, 'PPTX must not embed external links')
}

const assertZipBundle = (bytes: Buffer): void => {
  const entries = unzipSync(bytes)
  const names = Object.keys(entries)
  for (const name of ['manifest.json', 'report.docx', 'table.xlsx', 'presentation.pptx']) {
    assert.ok(names.includes(name), `ZIP must contain the agreed entry ${name}`)
  }
  assert.ok(names.length >= 4, 'ZIP must contain the four agreed export entries')
  assert.equal(names.some((name) => name.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(name) || name.split('/').includes('..')), false)
  for (const [name, entry] of Object.entries(entries)) {
    assert.ok(entry.byteLength > 0, `ZIP entry ${name} must be non-empty`)
  }
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString('utf8')) as {
    files?: Array<{ name: string; byteSize: number; sha256: string }>
  }
  assert.ok(Array.isArray(manifest.files), 'ZIP manifest must describe member hashes')
  assert.ok(manifest.files!.length >= 1)
  for (const file of manifest.files!) {
    const entry = entries[file.name]
    assert.ok(entry, `ZIP manifest references missing member ${file.name}`)
    assert.equal(file.byteSize, entry!.byteLength)
    assert.equal(file.sha256, createHash('sha256').update(entry!).digest('hex'))
  }
}

const testArtifactFormatsAndEvidenceBoundary = async (): Promise<void> => {
  const exporter = await loadExportModule()
  const renderer = exportFunctionOf(exporter)
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-artifact-regression-export-'))
  try {
    const formats: AssistantArtifactOutputFormat[] = ['docx', 'xlsx', 'pptx', 'zip']
    for (const format of formats) {
      const { result, bytes } = await materializeRendered(
        await renderer.invoke(validArtifact(), format),
        directory
      )
      assertOuterManifest(result, bytes, format)
      assert.equal(result.mimeType?.includes('zip') || result.mimeType?.includes('officedocument'), true)
      assert.match(result.fileName ?? '', new RegExp(`\\.${format}$`, 'u'))
      assert.doesNotMatch(result.fileName ?? '', /[\\/:*?"<>|\u0000-\u001f]/u, 'file names must be sanitized')
      if (format === 'docx') assertDocx(bytes)
      if (format === 'xlsx') assertXlsx(bytes)
      if (format === 'pptx') assertPptx(bytes)
      if (format === 'zip') assertZipBundle(bytes)
    }
    const outputFiles = await readdir(directory)
    assert.equal(outputFiles.length, formats.length, 'only temporary regression files may be created')
    checks.push('交付物 Agent 生成非空且可解包的 DOCX/XLSX/PPTX/ZIP，并返回一致的 manifest、SHA-256 和 byteSize')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const dataRowsFromXlsx = (bytes: Buffer, viewTitle: string): unknown[][] => {
  const workbook = XLSX.read(bytes, { type: 'buffer' })
  const sheetName = workbook.SheetNames.find((name) => name.startsWith(`查询-${viewTitle}`))
  assert.ok(sheetName, `XLSX must include the DataView sheet for ${viewTitle}`)
  const sheet = workbook.Sheets[sheetName!]
  assert.ok(sheet)
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: ''
  }) as unknown[][]
}

const artifactForColumnDedup = (
  view: AssistantArtifactInput['dataViews'][number]
): AssistantArtifact => validArtifact({
  ...validInput,
  evidenceBlocks: [{
    ...validInput.evidenceBlocks[0]!,
    dataViewId: view.id
  }],
  dataViews: [view]
})

const renderXlsxForColumnDedup = async (
  renderer: ReturnType<typeof exportFunctionOf>,
  artifact: AssistantArtifact,
  directory: string
): Promise<unknown[][]> => {
  const { bytes } = await materializeRendered(
    await renderer.invoke(artifact, 'xlsx'),
    directory
  )
  return dataRowsFromXlsx(bytes, artifact.payload.dataViews[0]?.title ?? '')
}

const testArtifactXlsxColumnDeduplication = async (): Promise<void> => {
  const exporter = await loadExportModule()
  const renderer = exportFunctionOf(exporter)
  const directory = await mkdtemp(join(tmpdir(), 'knowledge-artifact-column-dedup-'))
  try {
    const identicalView: AssistantArtifactInput['dataViews'][number] = {
      id: 'view:column-dedup-identical',
      title: '名称列去重-相同值',
      description: '固定名称与动态名称字段内容完全相同',
      total: 2,
      loadedRows: 2,
      isPreview: false,
      fields: ['Summary'],
      fieldLabels: { Summary: '名称' },
      groups: [{
        name: '全部',
        count: 2,
        rows: [
          {
            uid: 'record:column-dedup-001',
            name: '需求一',
            nodeType: 'Requirement',
            itemId: 'REQ-COLUMN-001',
            values: { Summary: '需求一' }
          },
          {
            uid: 'record:column-dedup-002',
            name: '需求二',
            nodeType: 'Requirement',
            itemId: 'REQ-COLUMN-002',
            values: { Summary: '需求二' }
          }
        ]
      }],
      recordUids: ['record:column-dedup-001', 'record:column-dedup-002']
    }
    const identicalRows = await renderXlsxForColumnDedup(
      renderer,
      artifactForColumnDedup(identicalView),
      directory
    )
    const identicalHeaders = (identicalRows[0] ?? []).map(String)
    assert.equal(
      identicalHeaders.filter((header) => header === '名称').length,
      1,
      'identical fixed and dynamic name columns must collapse to one 名称 header'
    )
    assert.equal(new Set(identicalHeaders).size, identicalHeaders.length)
    checks.push('固定 row.name 与 Summary(label=名称) 值相同时，XLSX 只保留一个名称列')

    const distinctView: AssistantArtifactInput['dataViews'][number] = {
      id: 'view:column-dedup-distinct',
      title: '名称列去重-不同值',
      description: '动态名称字段与固定名称内容不同',
      total: 2,
      loadedRows: 2,
      isPreview: false,
      fields: ['Summary'],
      fieldLabels: { Summary: '名称' },
      groups: [{
        name: '全部',
        count: 2,
        rows: [
          {
            uid: 'record:column-distinct-001',
            name: '需求一',
            nodeType: 'Requirement',
            itemId: 'REQ-DISTINCT-001',
            values: { Summary: '摘要一' }
          },
          {
            uid: 'record:column-distinct-002',
            name: '需求二',
            nodeType: 'Requirement',
            itemId: 'REQ-DISTINCT-002',
            values: { Summary: '摘要二' }
          }
        ]
      }],
      recordUids: ['record:column-distinct-001', 'record:column-distinct-002']
    }
    const distinctRows = await renderXlsxForColumnDedup(
      renderer,
      artifactForColumnDedup(distinctView),
      directory
    )
    const distinctHeaders = (distinctRows[0] ?? []).map(String)
    const distinctNameIndexes = distinctHeaders
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => header === '名称' || header.startsWith('名称'))
    assert.equal(distinctNameIndexes.length, 2, 'different same-label values must retain two name columns')
    assert.equal(new Set(distinctNameIndexes.map(({ header }) => header)).size, 2, 'name headers must be unique')
    const distinctValues = distinctRows.slice(1).map((row) => (
      distinctNameIndexes.map(({ index }) => String(row[index] ?? ''))
    ))
    assert.deepEqual(distinctValues, [
      ['需求一', '摘要一'],
      ['需求二', '摘要二']
    ], 'fixed and dynamic name values must both survive XLSX export')
    assert.equal(new Set(distinctHeaders).size, distinctHeaders.length)
    checks.push('同名但内容不同的动态字段保留两个唯一名称表头及两份值')

    const multipleDynamicView: AssistantArtifactInput['dataViews'][number] = {
      id: 'view:column-dedup-multiple',
      title: '名称列去重-多个属性',
      description: '多个动态属性使用相同显示名称',
      total: 2,
      loadedRows: 2,
      isPreview: false,
      fields: ['Summary', 'Title'],
      fieldLabels: { Summary: '名称', Title: '名称' },
      groups: [{
        name: '全部',
        count: 2,
        rows: [
          {
            uid: 'record:column-multiple-001',
            name: '需求一',
            nodeType: 'Requirement',
            itemId: 'REQ-MULTIPLE-001',
            values: { Summary: '摘要一', Title: '标题一' }
          },
          {
            uid: 'record:column-multiple-002',
            name: '需求二',
            nodeType: 'Requirement',
            itemId: 'REQ-MULTIPLE-002',
            values: { Summary: '摘要二', Title: '标题二' }
          }
        ]
      }],
      recordUids: ['record:column-multiple-001', 'record:column-multiple-002']
    }
    const multipleDynamicRows = await renderXlsxForColumnDedup(
      renderer,
      artifactForColumnDedup(multipleDynamicView),
      directory
    )
    const multipleDynamicHeaders = (multipleDynamicRows[0] ?? []).map(String)
    const multipleNameIndexes = multipleDynamicHeaders
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => header === '名称' || header.startsWith('名称'))
    assert.equal(multipleNameIndexes.length, 3, 'multiple same-label properties must remain three name columns')
    assert.equal(new Set(multipleNameIndexes.map(({ header }) => header)).size, 3)
    assert.deepEqual(
      multipleDynamicRows.slice(1).map((row) => multipleNameIndexes.map(({ index }) => String(row[index] ?? ''))),
      [
        ['需求一', '摘要一', '标题一'],
        ['需求二', '摘要二', '标题二']
      ],
      'multiple same-label property values must remain aligned with their unique headers'
    )
    checks.push('多个同名动态属性列也会生成唯一名称表头并保持列值对齐')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const testArtifactGenerationRejectsUnsafeInputs = async (): Promise<void> => {
  const exporter = await loadExportModule()
  const renderer = exportFunctionOf(exporter)
  const emptyArtifact = validArtifact({ ...validInput, evidenceBlocks: [], dataViews: [], sources: [] })
  await assert.rejects(
    async () => renderer.invoke(emptyArtifact, 'docx'),
    /证据|EvidenceBlock|evidence|不能为空|missing/iu,
    'artifact generation must reject evidence-free input'
  )
  await assert.rejects(
    async () => renderer.invoke(validArtifact(), 'pdf' as AssistantArtifactOutputFormat),
    /格式|format|unsupported|只支持|不支持/iu,
    'artifact generation must reject unsupported formats'
  )

  const artifactAgent = getAssistantExecutionAgent('artifact')
  assert.ok(artifactAgent, 'artifact execution Agent must be registered')
  assert.deepEqual(
    artifactAgent?.allowedTools,
    ['render_docx', 'render_xlsx', 'render_pptx', 'render_bundle']
  )
  const forbiddenTools = [
    'search_records',
    'query_records_by_fields',
    'aggregate_records',
    'search_document_chunks',
    'locate_requirement',
    'web_search'
  ]
  assert.equal(forbiddenTools.some((tool) => artifactAgent?.allowedTools.includes(tool)), false)
  assert.equal(assistantExecutionAgentRegistry.find((agent) => agent.id === 'artifact')?.readonly, false)
  checks.push('无 EvidenceBlock、未知格式和业务检索工具均被交付物边界拒绝')
}

const main = async (): Promise<void> => {
  await testIndependentKnowledgeExpertRoute()
  await testKnowledgeSourceIsolationAndPermissions()
  await testArtifactRouteAndFailClosedPlanning()
  await testArtifactFormatsAndEvidenceBoundary()
  await testArtifactXlsxColumnDeduplication()
  await testArtifactGenerationRejectsUnsafeInputs()
  console.log(JSON.stringify({ ok: true, checks }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
