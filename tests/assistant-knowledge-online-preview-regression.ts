import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkKnowledgePages } from '../src/main/knowledge'
import { resolveAssistantIntent } from '../src/main/assistant/intent-router'
import type { AssistantIntentModelClient } from '../src/main/assistant/intent-router'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import type {
  AssistantArtifactInput,
  ChatSource,
  ModelSettings
} from '../src/shared/types'
import * as XLSX from 'xlsx'

const checks: string[] = []

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-knowledge-online-preview-regression-model',
  thinking: false,
  apiKey: 'assistant-knowledge-online-preview-regression-key'
}

const readText = (path: string | URL): Promise<string> => readFile(path, 'utf8')

const sectionBetween = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start)
  assert.ok(startIndex >= 0, `source must contain ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.ok(endIndex >= 0, `source section ${start} must end at ${end}`)
  return source.slice(startIndex, endIndex)
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const assertLiteralMapping = (source: string, key: string, value: string, label: string): void => {
  assert.match(
    source,
    new RegExp(`['"]${escapeRegExp(key)}['"]\\s*:\\s*['"]${escapeRegExp(value)}['"]`),
    `${label} must map ${key} to ${value}`
  )
}

const assertAny = (source: string, patterns: RegExp[], message: string): void => {
  assert.ok(patterns.some((pattern) => pattern.test(source)), message)
}

const modelResponse = (content: string): ModelResponse => ({
  message: { role: 'assistant', content }
})

const modelArtifactDecision = JSON.stringify({
  taskType: 'artifact_generation',
  skillId: 'artifact',
  sourceMode: 'mixed',
  resolvedQuestion: '请把已验证回答导出为 DOCX',
  resultMode: 'artifact',
  groupEntities: [],
  needsClarification: false,
  reason: 'untrusted model fixture'
})

const verifiedSource: ChatSource = {
  uid: 'document:preview-source-opaque-uid',
  name: '预览规范',
  nodeType: 'knowledge_document',
  itemId: 'preview-source-item',
  sourceType: 'document',
  documentId: 'preview-document-1',
  chunkId: 'preview-chunk-7',
  fileName: '预览规范.pdf',
  location: '第 3 页 · 目标段落',
  pageNumber: 3,
  snippet: '预览定位测试证据。'
}

const artifactSource: AssistantArtifactInput = {
  type: 'delivery_draft',
  conversationId: 'preview-conversation',
  messageId: 'preview-message',
  title: '预览测试交付物',
  question: '请整理已验证回答',
  answer: '已验证回答。',
  evidenceBlocks: [{
    id: 'evidence:preview',
    kind: 'document',
    title: '预览规范',
    summary: '预览定位证据',
    count: 1,
    sourceIndexes: [0]
  }],
  dataViews: [],
  sources: [verifiedSource],
  outputFormat: 'docx'
}

const collectSourceFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(path))
      continue
    }
    if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(path)
  }
  return files
}

const testPreviewIpcContract = async (): Promise<{
  mainSource: string
  knowledgeSource: string
  sharedSource: string
  preloadSource: string
  appSource: string
  projectSource: string
  viewerSource: string
}> => {
  const [mainSource, knowledgeSource, sharedSource, preloadSource, appSource, projectSource] = await Promise.all([
    readText(new URL('../src/main/index.ts', import.meta.url)),
    readText(new URL('../src/main/knowledge.ts', import.meta.url)),
    readText(new URL('../src/shared/types.ts', import.meta.url)),
    readText(new URL('../src/preload/index.ts', import.meta.url)),
    readText(new URL('../src/renderer/src/App.tsx', import.meta.url)),
    readText(new URL('../src/renderer/src/project-management/ProjectManagementPage.tsx', import.meta.url))
  ])
  const rendererRoot = fileURLToPath(new URL('../src/renderer/src/', import.meta.url))
  const rendererFiles = await collectSourceFiles(rendererRoot)
  const rendererSources = await Promise.all(rendererFiles.map(readText))
  const viewerSource = [appSource, projectSource, ...rendererSources.filter((_source, index) => {
    const fileName = rendererFiles[index]?.toLocaleLowerCase() ?? ''
    return /knowledge|document|preview|viewer/u.test(fileName)
  })].join('\n')

  const extensionBlock = sectionBetween(
    mainSource,
    'const sourcePreviewExtensions',
    'const sourcePreviewMimeTypes'
  )
  const mimeBlock = sectionBetween(
    mainSource,
    'const sourcePreviewMimeTypes',
    'const sourcePreviewRenderFormats'
  )
  const formatBlock = sectionBetween(
    mainSource,
    'const sourcePreviewRenderFormats',
    'const execFileAsync'
  )
  const expectedFormats: Record<string, string> = {
    '.docx': 'docx',
    '.pdf': 'pdf',
    '.xlsx': 'xlsx',
    // Legacy XLS is parsed by the same spreadsheet viewer, while retaining
    // its source MIME in sourcePreviewMimeTypes.
    '.xls': 'xlsx',
    '.txt': 'text'
  }
  const expectedMimes: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.txt': 'text/plain'
  }
  for (const extension of Object.keys(expectedFormats)) {
    assert.match(extensionBlock, new RegExp(`['"]${escapeRegExp(extension)}['"]`))
    assertLiteralMapping(mimeBlock, extension, expectedMimes[extension]!, 'preview MIME map')
    assertLiteralMapping(formatBlock, extension, expectedFormats[extension]!, 'preview render-format map')
  }

  const previewHandler = sectionBetween(
    mainSource,
    "ipcMain.handle('knowledge:document-preview'",
    "ipcMain.handle('knowledge:upload'"
  )
  assert.match(previewHandler, /document\.extension\.trim\(\)\.toLocaleLowerCase\(\)/)
  assert.match(previewHandler, /sourcePreviewMimeTypes\[extension\]/)
  assert.match(previewHandler, /sourcePreviewRenderFormats\[extension\]/)
  assert.match(previewHandler, /createPreviewUrl\(document\.filePath, mimeType\)/)
  assert.match(previewHandler, /stats\.size === 0/)
  assert.match(previewHandler, /errorMessage/)
  assert.match(previewHandler, /return \{ document \}/)
  const docxPreviewBranch = sectionBetween(previewHandler, "if (extension === '.docx')", 'const mimeType')
  assert.match(docxPreviewBranch, /createPreviewUrl\(wordRenderedPdf, 'application\/pdf'\)/)
  assert.match(docxPreviewBranch, /renderFormat: 'pdf'/)
  assert.match(docxPreviewBranch, /renderFormat: 'docx'/)

  const knowledgeMimeBlock = sectionBetween(knowledgeSource, 'const mimeFor', 'const fileHash')
  for (const extension of Object.keys(expectedMimes)) {
    assertLiteralMapping(knowledgeMimeBlock, extension, expectedMimes[extension]!, 'knowledge MIME map')
  }
  const previewTypeBlock = sectionBetween(sharedSource, 'export interface KnowledgeDocumentPreview', 'export interface KnowledgeDocumentQuery')
  for (const format of new Set(Object.values(expectedFormats))) {
    assert.match(previewTypeBlock, new RegExp(`['"]?${escapeRegExp(format)}['"]?`))
  }
  assert.match(preloadSource, /getKnowledgeDocumentPreview[\s\S]{0,180}knowledge:document-preview/)
  assert.match(sharedSource, /getKnowledgeDocumentPreview\(id: string\)/)
  checks.push('knowledge preview IPC advertises all five formats with source MIME and render-format mappings plus empty-content fallback')
  return { mainSource, knowledgeSource, sharedSource, preloadSource, appSource, projectSource, viewerSource }
}

const testCitationFragmentAndPreviewClickAsync = async ({
  appSource,
  viewerSource
}: Awaited<ReturnType<typeof testPreviewIpcContract>>): Promise<void> => {
  const ollamaSource = await readText(new URL('../src/main/ollama.ts', import.meta.url))
  const citationPrefix = ollamaSource.match(/const knowledgeCitationFragmentPrefix = ['"]([^'"]+)['"]/u)?.[1]
  assert.equal(citationPrefix, '#knowledge-document=', 'citation links must use a local document/chunk fragment')
  const href = `${citationPrefix}preview-document-1&chunk=preview-chunk-7`
  const parsed = new URLSearchParams(href.slice(1))
  assert.equal(parsed.get('knowledge-document'), 'preview-document-1')
  assert.equal(parsed.get('chunk'), 'preview-chunk-7')

  const citationParser = sectionBetween(appSource, 'const knowledgeCitationTargetOf', 'type AssistantMarkdownLinkProps')
  assert.match(citationParser, /URLSearchParams/)
  assert.match(citationParser, /knowledge-document/)
  assert.match(citationParser, /params\.get\('chunk'\)/)
  assert.match(citationParser, /documentId/)
  assert.match(citationParser, /chunkId/)
  assert.match(appSource, /onClick=\{\(\) => void openKnowledgeDetail\(citation\.documentId, citation\.chunkId\)\}/)

  const openKnowledgeOffset = appSource.indexOf('const openKnowledgeDetail')
  assert.ok(openKnowledgeOffset >= 0)
  const openKnowledgeBlock = appSource.slice(openKnowledgeOffset, openKnowledgeOffset + 3_500)
  assert.match(openKnowledgeBlock, /getKnowledgeDocumentPreview/)
  assert.match(openKnowledgeBlock, /chunkId/)
  assert.match(viewerSource, /getKnowledgeDocumentPreview/)
  assert.match(viewerSource, /contentUrl|contentBase64/)
  checks.push('citation fragments parse documentId/chunkId and click handling loads online preview instead of only opening the chunk drawer')
}

const testChunkMetadataAndViewerNavigation = ({
  projectSource,
  viewerSource
}: Awaited<ReturnType<typeof testPreviewIpcContract>>): void => {
  const pages: Parameters<typeof chunkKnowledgePages>[0] = [
    { text: 'PDF target page content', pageNumber: 3, location: '第 3 页' },
    { text: 'A1=目标值\nA2=高亮目标', sheetName: '目标表', location: '工作表: 目标表' }
  ]
  const chunks = chunkKnowledgePages(pages)
  assert.equal(chunks[0]?.pageNumber, 3)
  assert.equal(chunks[0]?.charStart, 0)
  assert.equal(chunks[0]?.text, 'PDF target page content')
  assert.equal(chunks[1]?.sheetName, '目标表')
  assert.equal(chunks[1]?.charStart, 0)
  assert.match(chunks[1]?.text ?? '', /高亮目标/)

  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['名称', '状态'],
    ['目标行', '完成']
  ])
  XLSX.utils.book_append_sheet(workbook, sheet, '目标表')
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
  const reparsed = XLSX.read(bytes, { type: 'buffer' })
  assert.deepEqual(reparsed.SheetNames, ['目标表'])
  const rows = XLSX.utils.sheet_to_json<unknown[]>(reparsed.Sheets['目标表']!, { header: 1 })
  assert.deepEqual(rows[1], ['目标行', '完成'])

  for (const field of ['pageNumber', 'sheetName', 'charStart', 'content']) {
    assert.match(viewerSource, new RegExp(field), `viewer must receive ${field} from the target chunk`)
  }
  assertAny(
    viewerSource,
    [/target(?:Chunk|Page|PageNumber)/iu, /active(?:Chunk|Page|PageNumber)/iu, /target.*pageNumber/iu],
    'viewer must carry the citation target rather than rendering only the first chunk'
  )
  assertAny(
    viewerSource,
    [/scrollIntoView/iu, /scrollTo/iu, /currentPage/iu, /targetPage/iu],
    'viewer must navigate to the cited page or text position'
  )
  assert.match(viewerSource, /pdfjs-dist[\s\S]{0,500}getDocument/)
  assert.match(viewerSource, /IntersectionObserver/)
  assert.match(viewerSource, /data-pdf-page/)
  assert.match(viewerSource, /向下滚动连续阅读/)
  assert.doesNotMatch(viewerSource, /aria-label="上一页"|aria-label="下一页"/)
  assertAny(viewerSource, [/XLSX/iu, /sheet_to_json/iu], 'XLSX/XLS viewer must parse workbook sheets')
  assertAny(viewerSource, [/highlight/iu, /is-target/iu, /targetRow/iu, /rowIndex/iu], 'XLSX viewer must highlight the cited row')
  assert.match(viewerSource, /renderAsync/)
  assertAny(viewerSource, [/indexOf/iu, /charStart/iu, /scrollIntoView/iu], 'DOCX/TXT viewer must locate cited text')
  assertAny(viewerSource, [/project-document-text-preview/iu, /text-preview/iu, /textContent/iu], 'TXT viewer must expose a text-preview surface')
  assert.match(projectSource, /documentPreview\.document\.extension/)
  assert.match(projectSource, /documentPreview\.renderFormat/)
  assertAny(viewerSource, [/Empty/iu, /没有可预览/iu, /fallback/iu], 'viewer must show a readable fallback when no content is available')
  assert.match(viewerSource, /errorMessage|documentPreviewError/)
  checks.push('target chunk page/sheet/offset/content metadata reaches format viewers with PDF navigation, XLSX row highlighting, DOCX/TXT text location and empty fallback')
}

const testAssetCenterKnowledgePreview = async ({ appSource }: Awaited<ReturnType<typeof testPreviewIpcContract>>): Promise<void> => {
  const knowledgePage = sectionBetween(appSource, 'function KnowledgeBasePage', 'function ChatPage')
  const rendererHtml = await readText(new URL('../src/renderer/index.html', import.meta.url))
  assert.match(knowledgePage, /getKnowledgeDocumentPreview\(id\)/)
  assert.match(knowledgePage, /<KnowledgeDocumentPreviewer/)
  assert.match(knowledgePage, /preview=\{detailPreview\}/)
  assert.match(knowledgePage, /fallbackDocument=\{detail\}/)
  assert.match(knowledgePage, /在线预览/)
  assert.match(knowledgePage, /解析与索引/)
  assert.match(knowledgePage, /filteredDetailChunks/)
  assert.match(knowledgePage, /<Pagination/)
  assert.match(knowledgePage, /detail\.modelVersion/)
  assert.match(knowledgePage, /detail\.processedAt/)
  assert.match(knowledgePage, /rootClassName="knowledge-detail-preview-drawer"/)
  assert.match(knowledgePage, /destroyOnHidden/)
  assert.doesNotMatch(knowledgePage, /分块预览（/)
  assert.doesNotMatch(knowledgePage, /仅预览前 30 个分块/)
  assert.match(rendererHtml, /connect-src[^;]*visslm-preview:/)
  checks.push('asset-center knowledge detail loads the source preview contract and uses the shared online viewer with indexed-content fallback')
}

const testArtifactExplicitOptIn = async ({ mainSource, appSource }: Awaited<ReturnType<typeof testPreviewIpcContract>>): Promise<void> => {
  const classifier: AssistantIntentModelClient = {
    chat: async (_input: ModelChatInput): Promise<ModelResponse> => modelResponse(modelArtifactDecision)
  }
  const automatic = await resolveAssistantIntent({
    question: '请总结这份已完成回答',
    chatMode: 'auto',
    entrypoint: 'chat',
    artifactSource
  }, settings, classifier)
  assert.notEqual(automatic.taskType, 'artifact_generation')
  assert.notEqual(automatic.skillId, 'artifact')
  assert.notEqual(automatic.resultMode, 'artifact')

  const explicit = await resolveAssistantIntent({
    question: '@交付物专家 请导出为 DOCX',
    chatMode: 'expert',
    entrypoint: 'chat',
    artifactSource
  }, settings, classifier)
  assert.equal(explicit.taskType, 'artifact_generation')
  assert.equal(explicit.skillId, 'artifact')
  assert.equal(explicit.resultMode, 'artifact')
  assert.equal(explicit.needsClarification, false)

  assert.match(mainSource, /explicitArtifactMentionPattern/)
  assert.match(mainSource, /artifactRouteRequested[\s\S]{0,500}explicitArtifactMentionPattern/)
  assert.match(appSource, /requestsArtifactExport/)
  const actionOffset = appSource.indexOf('className="chat-artifact-actions"')
  if (actionOffset >= 0) {
    const condition = appSource.slice(Math.max(0, actionOffset - 500), actionOffset)
    assert.doesNotMatch(condition, /message\.role === 'assistant' && message\.contextOutcome === 'success' && message\.evidenceBlocks\?\.length \?/)
    assertAny(condition, [/explicit/iu, /mention/iu, /request/iu, /artifact/iu], 'artifact action area must be mention-gated')
  }
  checks.push('online preview changes preserve explicit @交付物专家 opt-in and reject model-only artifact escalation')
}

const contracts = await testPreviewIpcContract()
await testCitationFragmentAndPreviewClickAsync(contracts)
testChunkMetadataAndViewerNavigation(contracts)
await testAssetCenterKnowledgePreview(contracts)
await testArtifactExplicitOptIn(contracts)

console.log(JSON.stringify({ ok: true, checks }, null, 2))
