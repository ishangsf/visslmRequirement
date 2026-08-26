import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { DirectRequirementDataAnalysisAgent } from '../src/main/direct-data-analysis'
import { DataCenterAgent } from '../src/main/assistant/agents/data-center-agent'
import { PlainChatAgent, type PlainChatClient } from '../src/main/plain-chat'
import { chatHistoryFromMessages } from '../src/main/context-budget'
import { compactEvidenceJson, selectHistoryWithSummary } from '../src/main/context-budget'
import type { ChatResponse } from '../src/shared/types'
import type { ModelMessage } from '../src/main/model-client'

/**
 * Context safety contract for the direct requirement path.
 *
 * The production agent may choose a different compression representation, but
 * these invariants are intentionally stable: the model must never receive
 * image bytes or raw HTML, every requested ID must remain auditable in the
 * compact index, and an included detail must be a complete block.
 */
const MAX_MODEL_CHARS = 64_000
const MAX_GENERIC_FIELD_CHARS = 512
const MAX_GENERIC_DETAIL_TEXT_CHARS = 4_096
const IMAGE_PAYLOAD = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(80)
const IMAGE_DATA_URI = `data:image/png;base64,${IMAGE_PAYLOAD}`
const ASSET_TOKEN = `visslm-asset://${'a'.repeat(64)}/image-reference-1`
const RAW_HTML_PATTERN = /<\/?(?:p|strong|img|script)\b[^>]*>/iu
const DATA_URI_PATTERN = /data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/iu

type CapturedModelInput = {
  messages: ModelMessage[]
}

type ContextStats = {
  requestedCount: number
  resolvedCount: number
  indexCount: number
  detailBlockCount: number
  completeDetailBlockCount: number
  omittedDetailCount: number
  inputChars: number
  truncated: boolean
  containsBase64: boolean
  containsRawHtml: boolean
  containsAssetToken: boolean
  error?: string
}

const modelTextOf = (input: CapturedModelInput | undefined): string =>
  input?.messages.map((message) => message.content).join('\n') ?? ''

const detailBlocksOf = (text: string): Array<{ id: string; content: string }> => {
  const starts = [...text.matchAll(/用户请求编号：([^\r\n]+)/gu)]
    .flatMap((match) => match.index === undefined ? [] : [{ id: match[1]!.trim(), index: match.index }])
  return starts.map((start, index) => ({
    id: start.id,
    content: text.slice(start.index, starts[index + 1]?.index ?? text.length)
  }))
}

const isCompleteDetailBlock = (content: string): boolean => (
  content.includes('最后修改时间：') &&
  /(?:原始字段：|安全字段|detailComplete\s*[:=]\s*true|详情完整|上下文预算已省略)/iu.test(content)
)

const recordInput = (itemId: string, index: number): {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  parentId: string
  name: string
  lastModifyTime: string
  raw: Record<string, unknown>
  normalizedText: string
} => {
  const fact = `FACT-${itemId}`
  const longText = `${fact} ` + '长描述内容用于上下文压缩边界验证。'.repeat(220)
  const description = [
    `<p>${fact} <strong>可分析事实</strong></p>`,
    `<img src="${IMAGE_DATA_URI}" alt="图片-${itemId}">`,
    `<img src="${ASSET_TOKEN}" alt="资源-${itemId}">`,
    `<script>window.shouldNeverReachTheModel = true</script>`,
    longText
  ].join('\n')
  return {
    uid: `chat-context-uid-${index}`,
    projectId: 'chat-context-project',
    nodeType: 'Requirement',
    itemId,
    parentId: '',
    name: `上下文安全需求 ${itemId}`,
    lastModifyTime: '2026-08-25T00:00:00.000Z',
    raw: {
      // Put the image first so a naive character slice cannot hide it from
      // this regression test.
      _valm_ImagePayload: IMAGE_DATA_URI,
      _valm_Description: description,
      Source: `来源-${itemId}`,
      _valm_AssignedTo: `负责人-${itemId}`,
      HugeField: 'RAW_FIELD_SHOULD_BE_BOUNDED_'.repeat(400),
      Nested: { asset: ASSET_TOKEN }
    },
    normalizedText: `${fact} 可分析事实 ${longText}`
  }
}

const assertContextStats = (
  failures: string[],
  stats: ContextStats,
  promptAndResponse: string,
  requestedIds: string[],
  response: ChatResponse
): void => {
  if (stats.resolvedCount !== requestedIds.length) {
    failures.push(`resolved count mismatch: expected ${requestedIds.length}, got ${stats.resolvedCount}`)
  }
  if (stats.indexCount !== requestedIds.length) {
    failures.push(`compact index lost IDs: expected ${requestedIds.length}, got ${stats.indexCount}`)
  }
  if (stats.inputChars > MAX_MODEL_CHARS) {
    failures.push(`model input exceeds ${MAX_MODEL_CHARS} chars: ${stats.inputChars}`)
  }
  if (stats.containsBase64) failures.push('model/response contains a data:image Base64 payload')
  if (stats.containsRawHtml) failures.push('model/response contains raw HTML tags')
  if (stats.containsAssetToken) failures.push('model/response contains a raw visslm-asset token')
  if (stats.truncated && !/(?:contextStats|上下文统计|上下文摘要)/iu.test(promptAndResponse)) {
    failures.push('truncated context has no structured context statistics')
  }

  const detailBlocks = detailBlocksOf(promptAndResponse)
  for (const block of detailBlocks) {
    if (!isCompleteDetailBlock(block.content)) failures.push(`detail block was cut in the middle: ${block.id}`)
  }

  // A small request should retain every complete detail block. Larger
  // requests may omit detail after compression, but their compact index must
  // still contain every requested ID.
  if (requestedIds.length <= 5 && detailBlocks.length !== requestedIds.length) {
    failures.push(
      `small request lost detail blocks: expected ${requestedIds.length}, got ${detailBlocks.length}`
    )
  }

  const responseEvents = JSON.stringify(response.events ?? [])
  if (stats.truncated && !/(?:contextStats|上下文统计|上下文摘要)/iu.test(responseEvents + promptAndResponse)) {
    failures.push('truncation statistics are not exposed in the response contract')
  }
  if (stats.truncated) {
    if (!response.contextStats) {
      failures.push('truncated context has no structured response.contextStats')
    } else {
      if (response.contextStats.detailOmittedCount !== stats.omittedDetailCount) {
        failures.push(
          `response.contextStats omission mismatch: expected ${stats.omittedDetailCount}, got ${response.contextStats.detailOmittedCount}`
        )
      }
      if (!response.contextStats.recoveryHint) failures.push('truncated context has no recovery hint')
    }
  }
}

const main = async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'visslm-chat-context-safety-'))
  let database: AppDatabase | undefined
  const failures: string[] = []
  const cases: Array<ContextStats & { requestedCount: number }> = []
  try {
    database = new AppDatabase(join(root, 'chat.db'), join(root, 'assets'))
    const allIds = Array.from({ length: 200 }, (_value, index) => `CHAT-REQ-${String(index + 1).padStart(4, '0')}`)
    allIds.forEach((itemId, index) => database!.upsertRecord(recordInput(itemId, index)))
    for (let imageIndex = 0; imageIndex < 25; imageIndex += 1) {
      database.saveUnresolvedImage({
        recordUid: 'chat-context-uid-0',
        name: `image-${imageIndex}.png`,
        mimeType: 'image/png',
        sourceUrl: `https://example.invalid/image-${imageIndex}.png`,
        errorMessage: 'test image marker'
      })
    }
    const chatDetail = database.getRecord('chat-context-uid-0', false)
    const imagePage = database.getRecordImagePage('chat-context-uid-0', 2, 12)
    if (chatDetail?.images.length !== 0 || chatDetail?.imageCount !== 25) {
      failures.push('chat record detail did not defer image metadata')
    }
    if (imagePage.total !== 25 || imagePage.images.length !== 12 || imagePage.page !== 2) {
      failures.push(`record image paging mismatch: ${JSON.stringify(imagePage)}`)
    }

    for (const count of [1, 5, 20, 200]) {
      const requestedIds = allIds.slice(0, count)
      let captured: CapturedModelInput | undefined
      const client = {
        chat: async (input: CapturedModelInput) => {
          captured = input
          return {
            message: {
              role: 'assistant' as const,
              content: '已根据受控上下文完成分析。'
            }
          }
        }
      }
      let response: ChatResponse = { answer: '', sources: [], dataViews: [] }
      let directError: string | undefined
      try {
        response = await new DirectRequirementDataAnalysisAgent(database, {}, client).ask({
          question: `请分析这 ${count} 条需求的关键事实，保留可核验编号。`,
          extractedRequirementIds: requestedIds,
          history: [
            {
              role: 'user',
              content: '上一轮已确认：只使用本地事实。',
              contextRefs: [{ kind: 'record', id: 'chat-context-uid-0', itemId: requestedIds[0], label: '上下文记录' }]
            },
            { role: 'assistant', content: '已确认，只使用本地事实。' }
          ]
        })
      } catch (error) {
        directError = error instanceof Error ? error.message : String(error)
        failures.push(`direct analysis ${count} records threw: ${directError}`)
      }
      const modelText = modelTextOf(captured)
      const combinedText = `${modelText}\n${JSON.stringify(response)}`
      const detailBlocks = detailBlocksOf(modelText)
      const indexCount = requestedIds.filter((itemId) => modelText.includes(itemId)).length
      const stats: ContextStats = {
        requestedCount: count,
        resolvedCount: response.sources.length,
        indexCount,
        detailBlockCount: detailBlocks.length,
        completeDetailBlockCount: detailBlocks.filter((block) => isCompleteDetailBlock(block.content)).length,
        omittedDetailCount: Math.max(0, count - detailBlocks.length),
        inputChars: modelText.length,
        truncated: detailBlocks.length < count || modelText.length >= MAX_MODEL_CHARS,
        containsBase64: DATA_URI_PATTERN.test(combinedText) || combinedText.includes(IMAGE_PAYLOAD.slice(0, 64)),
        containsRawHtml: RAW_HTML_PATTERN.test(combinedText),
        containsAssetToken: combinedText.includes(ASSET_TOKEN),
        ...(directError ? { error: directError } : {})
      }
      cases.push(stats)
      if (!directError) assertContextStats(failures, stats, modelText, requestedIds, response)
      if (!directError && count === 200) {
        const view = response.dataViews[0]
        if (!view?.recordUids?.length || view.groups[0]?.rows.length !== 100) {
          failures.push('large data view did not expose a bounded first-page preview')
        } else {
          const page = database.getChatDataViewPage(view, 2, 50)
          if (page.total !== 200 || page.rows.length !== 50 || page.page !== 2) {
            failures.push(`server-side data view paging mismatch: ${JSON.stringify(page)}`)
          }
          if (page.rows.some((row) => JSON.stringify(row).includes(IMAGE_PAYLOAD.slice(0, 64)))) {
            failures.push('server-side data view paging leaked image payload')
          }
        }
      }
    }

    // Multi-turn contract: retain the most recent user/assistant pair and the
    // current question when the history is longer than the normal window.
    let plainCaptured: CapturedModelInput | undefined
    const plainClient: PlainChatClient = {
      async chat(input) {
        plainCaptured = input
        return { message: { role: 'assistant', content: '多轮回答已生成。' } }
      }
    }
    await new PlainChatAgent({}, plainClient).ask({
      question: '当前轮需要继续核验上一轮结论。',
      history: [
        { role: 'user', content: '旧问题 1' },
        { role: 'assistant', content: '旧回答 1' },
        { role: 'user', content: '旧问题 2' },
        { role: 'assistant', content: '旧回答 2' },
        { role: 'user', content: '旧问题 3' },
        { role: 'assistant', content: '旧回答 3' },
        { role: 'user', content: '上一轮关键事实：FACT-MULTI-TURN' },
        {
          role: 'assistant',
          content: '上一轮助手结论：保留 FACT-MULTI-TURN',
          contextRefs: [{ kind: 'dataView', id: 'view-multi', label: '多轮数据', total: 3 }]
        },
        { role: 'user', content: '上一轮补充问题' },
        { role: 'assistant', content: '上一轮补充回答' }
      ]
    })
    const plainText = modelTextOf(plainCaptured)
    for (const marker of ['FACT-MULTI-TURN', '保留 FACT-MULTI-TURN', '当前轮需要继续核验上一轮结论。']) {
      if (!plainText.includes(marker)) failures.push(`plain multi-turn history lost marker: ${marker}`)
    }
    if (!plainText.includes('上下文引用') || !plainText.includes('多轮数据')) {
      failures.push('plain multi-turn history lost lightweight context references')
    }
    const longHistory = Array.from({ length: 30 }, (_value, index) => ({
      role: index % 2 ? 'assistant' as const : 'user' as const,
      content: index === 0 ? '最早约束：必须保留 FACT-EARLY-MEMORY' : `历史消息 ${index}`
    }))
    const summarizedHistory = selectHistoryWithSummary(longHistory, 8, 240, 1_800)
    if (!JSON.stringify(summarizedHistory).includes('FACT-EARLY-MEMORY')) {
      failures.push('long-session summary lost an early conversation constraint')
    }
    const boundedToolJson = compactEvidenceJson({
      rows: Array.from({ length: 1_000 }, (_value, index) => ({ index, payload: 'p'.repeat(1_000) }))
    }, 12_000)
    if (boundedToolJson.length > 12_000) failures.push('tool JSON exceeds its whole-result budget')
    try {
      JSON.parse(boundedToolJson)
    } catch {
      failures.push('tool JSON compression produced invalid JSON')
    }

    const restoredHistory = chatHistoryFromMessages([{
      id: 'restored-assistant',
      role: 'assistant',
      content: '恢复会话回答',
      createdAt: new Date().toISOString(),
      contextRefs: [{ kind: 'dataView', id: 'restored-view', label: '恢复视图', total: 9_999 }],
      dataViews: [{
        id: 'restored-view',
        title: '完整结果不应进入模型历史',
        description: 'z'.repeat(10_000),
        total: 9_999,
        groups: [{ name: 'all', count: 9_999, rows: [] }],
        fields: ['HugeField']
      }]
    }])
    const restoredText = JSON.stringify(restoredHistory)
    if (!restoredText.includes('恢复视图') || restoredText.includes('完整结果不应进入模型历史')) {
      failures.push('persisted session recovery did not reduce history to references')
    }

    // Generic data-tool contract: field queries may return only requested,
    // bounded scalar values; record detail must not expose raw image bytes or
    // unbounded raw payloads to a model-facing tool result.
    const dataCenterAgent = new DataCenterAgent(database)
    const executeTool = dataCenterAgent.executeTool.bind(dataCenterAgent)
    const detail = executeTool('get_record_detail', { uid: 'chat-context-uid-0' }) as {
      text?: string
      raw?: Record<string, unknown>
    }
    const detailText = JSON.stringify(detail)
    if (DATA_URI_PATTERN.test(detailText) || detailText.includes(IMAGE_PAYLOAD.slice(0, 64))) {
      failures.push('get_record_detail exposes image bytes to the model-facing tool result')
    }
    if ((detail.text ?? '').length > MAX_GENERIC_DETAIL_TEXT_CHARS) {
      failures.push(`get_record_detail text is unbounded: ${(detail.text ?? '').length} chars`)
    }
    for (const [key, value] of Object.entries(detail.raw ?? {})) {
      if (typeof value === 'string' && value.length > MAX_GENERIC_FIELD_CHARS) {
        failures.push(`get_record_detail raw field ${key} is unbounded: ${value.length} chars`)
      }
    }

    const fieldQuery = executeTool('query_records_by_fields', {
      search: 'CHAT-REQ-0001',
      fields: ['Source', 'HugeField'],
      limit: 1
    }) as {
      returnedCount?: number
      fields?: string[]
      records?: Array<{
        values: Record<string, string | string[]>
      }>
    }
    for (const record of fieldQuery.records ?? []) {
      for (const [field, value] of Object.entries(record.values)) {
        const values = Array.isArray(value) ? value : [value]
        if (values.some((item) => item.length > MAX_GENERIC_FIELD_CHARS)) {
          failures.push(`field query value ${field} exceeds ${MAX_GENERIC_FIELD_CHARS} chars`)
        }
      }
    }

    console.log(JSON.stringify({
      ok: failures.length === 0,
      cases,
      genericTool: {
        rawFields: Object.keys(detail.raw ?? {}),
        fieldQueryReturned: fieldQuery.returnedCount ?? 0,
        fieldQueryFields: fieldQuery.fields ?? []
      },
      failures
    }, null, 2))
  } finally {
    database?.close()
    rmSync(root, { recursive: true, force: true })
  }
  if (failures.length) throw new Error(failures.join('\n'))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
