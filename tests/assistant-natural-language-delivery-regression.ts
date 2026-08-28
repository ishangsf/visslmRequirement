import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveNaturalLanguageDeliveryIntent } from '../src/shared/assistant-natural-language'
import { AssistantIntentRouter } from '../src/main/assistant/intent-router'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

const checks: string[] = []

type DeliveryIntent = NonNullable<ReturnType<typeof resolveNaturalLanguageDeliveryIntent>>

const requireDelivery = (question: string): DeliveryIntent => {
  const result = resolveNaturalLanguageDeliveryIntent(question)
  assert.ok(result, `应识别为交付请求：${question}`)
  assert.equal(typeof result.queryText, 'string', '交付意图必须提供可独立查询的 queryText')
  assert.equal(typeof result.instructions, 'string', '交付意图必须保留用户的自然语言说明')
  return result
}

const assertFormat = (question: string, format: DeliveryIntent['format']): DeliveryIntent => {
  const result = requireDelivery(question)
  assert.equal(result.format, format, `格式识别错误：${question}`)
  return result
}

const xlsxRequest = requireDelivery('整理周顺峰相关的数据，生成一份excel文件给我。')
assert.equal(xlsxRequest.format, 'xlsx')
assert.match(xlsxRequest.queryText, /周顺峰/u, '查询目标必须保留真实人名')
assert.doesNotMatch(xlsxRequest.queryText, /excel|xlsx|文件给我/iu, '交付动作和文件描述不得污染查询词')
checks.push('复合的查询与 Excel 交付请求被拆成 xlsx 格式和周顺峰查询目标')

const ownerXlsx = assertFormat('把周顺峰负责的需求导出为XLSX', 'xlsx')
assert.match(ownerXlsx.queryText, /周顺峰/u)
assert.doesNotMatch(ownerXlsx.queryText, /xlsx/iu)
checks.push('带“负责的需求”的 XLSX 自然表达保留负责人实体')

const previousPptx = assertFormat('将上一轮结果整理成PPT', 'pptx')
assert.doesNotMatch(previousPptx.queryText, /pptx?/iu, 'PPT 只表达交付格式，不应成为查询词')
checks.push('基于上一轮结果的 PPT 交付请求被识别为 pptx')

const previousXlsx = assertFormat('把上一轮结果导出为XLSX', 'xlsx')
const previousXlsxContract = previousXlsx as DeliveryIntent & {
  referencesPriorResult?: boolean
}
if ('referencesPriorResult' in previousXlsxContract) {
  assert.equal(
    previousXlsxContract.referencesPriorResult,
    true,
    '共享契约提供上一轮引用标记时必须明确置为 true'
  )
} else {
  assert.match(
    `${previousXlsx.queryText} ${previousXlsx.instructions}`,
    /上一轮|上轮|此前|之前/u,
    '没有显式引用字段时，queryText 或 instructions 仍需保留上一轮引用'
  )
}
assert.doesNotMatch(
  `${previousXlsx.queryText} ${previousXlsx.instructions}`,
  /周顺峰|ZX-不存在-2026/u,
  'delivery-only follow-up 不得凭空生成数据库实体'
)
const previousAliasXlsx = assertFormat('把以上内容导出为Excel', 'xlsx')
assert.equal(previousAliasXlsx.referencesPriorResult, true)
assert.equal(previousAliasXlsx.queryText, '')
checks.push('上一轮结果的 XLSX follow-up 保留上下文引用且不伪造实体')

assert.equal(
  resolveNaturalLanguageDeliveryIntent('评审中心能够开展Excel文件评审'),
  null,
  '正文中提到 Excel 不能被误判为用户要求导出文件'
)
checks.push('业务描述中的 Excel 词不会触发交付意图')

assert.equal(
  resolveNaturalLanguageDeliveryIntent('查询需求代号 ZX-不存在-2026 的记录'),
  null,
  '普通查询中的实体代号不能被误判为交付请求'
)
checks.push('没有输出动作的明确代号查询保持普通查询')

assertFormat('把周顺峰负责的需求整理成 Word 文档给我。', 'docx')
assertFormat('把上一轮结果打包成 ZIP 压缩包。', 'zip')
const naturalReport = assertFormat('根据知识库部署规范整理一份报告', 'docx')
assert.match(naturalReport.queryText, /知识库部署规范/u)
const naturalTable = assertFormat('我需要一份周顺峰数据表格', 'xlsx')
assert.match(naturalTable.queryText, /周顺峰/u)
checks.push('Word、报告、自然表格和 ZIP 压缩包等表达映射到对应格式')

assert.equal(
  resolveNaturalLanguageDeliveryIntent('系统需要Excel文件评审功能'),
  null,
  '业务需求中的“需要 Excel 文件评审”不能被误判为交付动作'
)
checks.push('业务需求句中的格式词仍不会误触发交付')

const emptyTarget = resolveNaturalLanguageDeliveryIntent('生成一份Excel给我')
if (emptyTarget !== null) {
  assert.equal(emptyTarget.format, 'xlsx')
  assert.equal(emptyTarget.queryText.trim(), '', '没有查询对象时不得伪造查询词')
}
checks.push('没有查询对象的纯交付请求保守返回 null 或空 queryText')

const settings: ModelSettings = {
  source: 'online',
  provider: 'openai-compatible',
  baseUrl: 'https://example.invalid/v1',
  model: 'assistant-natural-language-delivery-regression-model',
  thinking: false,
  apiKey: 'assistant-natural-language-delivery-regression-key'
}
const classifierCalls: ModelChatInput[] = []
const router = new AssistantIntentRouter(settings, {
  chat: async (input: ModelChatInput): Promise<ModelResponse> => {
    classifierCalls.push(input)
    // Deliberately return a weak conversation decision. The deterministic
    // natural-language boundary must still keep the grounded query target.
    return {
      message: {
        role: 'assistant',
        content: JSON.stringify({
          taskType: 'conversation',
          skillId: 'general',
          sourceMode: 'conversation',
          resolvedQuestion: '生成 Excel 文件',
          resultMode: 'answer',
          groupEntities: [],
          needsClarification: false,
          reason: 'weak classifier fixture'
        })
      }
    }
  }
})
const routedCompoundRequest = await router.resolve({
  question: '整理周顺峰相关的数据，生成一份excel文件给我。',
  chatMode: 'auto',
  entrypoint: 'chat'
})
assert.equal(classifierCalls.length, 1)
assert.equal(routedCompoundRequest.taskType, 'record_query')
assert.equal(routedCompoundRequest.sourceMode, 'records')
assert.equal(routedCompoundRequest.skillId, 'general')
assert.equal(routedCompoundRequest.resultMode, 'list')
assert.match(routedCompoundRequest.resolvedQuestion, /周顺峰/u)
assert.doesNotMatch(routedCompoundRequest.resolvedQuestion, /excel|生成|文件给我/iu)
checks.push('即使分类模型漂移，复合自然语言请求仍确定性路由为干净的数据查询')

const callsBeforeMissingTargets = classifierCalls.length
const targetlessDelivery = await router.resolve({
  question: '生成一份Excel给我',
  chatMode: 'auto',
  entrypoint: 'chat'
})
assert.equal(targetlessDelivery.needsClarification, true)
assert.match(targetlessDelivery.clarificationQuestion ?? '', /查询或整理哪些数据/u)
const missingPriorDelivery = await router.resolve({
  question: '把上一轮结果导出为XLSX',
  chatMode: 'auto',
  entrypoint: 'chat'
})
assert.equal(missingPriorDelivery.needsClarification, true)
assert.match(missingPriorDelivery.clarificationQuestion ?? '', /没有可直接复用的已核验证据/u)
assert.equal(
  classifierCalls.length,
  callsBeforeMissingTargets,
  '缺少查询目标或上一轮证据时应确定性澄清，不调用分类模型猜测'
)
checks.push('缺少查询目标或上一轮证据时安全澄清，不把格式词当数据实体')

const rendererSource = await readFile(
  new URL('../src/renderer/src/App.tsx', import.meta.url),
  'utf8'
)
assert.match(rendererSource, /resolveNaturalLanguageDeliveryIntent\(text\)/u)
assert.match(rendererSource, /requestsNaturalLanguageArtifact/u)
assert.match(
  rendererSource,
  /requestsNaturalLanguageArtifact[\s\S]{0,1200}response\.evidenceBlocks\?\.length[\s\S]{0,1200}previewAssistantArtifact/u,
  '复合请求只能在成功返回证据后创建交付预览'
)
assert.match(
  rendererSource,
  /messageId:\s*naturalArtifactSourceMessage\.id/u,
  '上一轮交付必须保留证据所属的原始消息 ID'
)
assert.doesNotMatch(
  rendererSource,
  /requestsNaturalLanguageArtifact[\s\S]{0,800}commitAssistantArtifact/u,
  '自然语言识别不得绕过预览自动提交文件'
)
checks.push('渲染器在证据成功后打开预览，复用正确来源且不自动提交')

console.log(JSON.stringify({ ok: true, checks }, null, 2))
