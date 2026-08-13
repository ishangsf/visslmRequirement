import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  RequirementSemanticizationService,
  REQUIREMENT_SEMANTIC_ANALYZER_VERSION,
  requirementSemanticModelSignature
} from '../../src/main/requirements/semanticization-service'
import {
  REQUIREMENT_SEMANTIC_FIELDS,
  buildRequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import type {
  ModelSettings,
  RecordDetail,
  RequirementSemanticizationProgress
} from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'semantic-regression-model',
  thinking: false
}

const upsert = (db: AppDatabase, uid: string, description: string): RecordDetail => {
  db.upsertRecord({
    uid,
    projectId: 'semantic-regression',
    nodeType: 'Requirement',
    itemId: uid.toUpperCase(),
    parentId: '',
    name: '订单详情查询',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_Module: '订单管理',
      _valm_ProductDomain: '订单管理',
      _valm_Description: description
    },
    normalizedText: `订单详情查询\n${description}`
  })
  const record = db.getRecord(uid, false)
  assert.ok(record)
  return record
}

const outputFor = (recordUid: string, sourceText: string, invalid = false): string => {
  const evidence = sourceText.slice(0, Math.min(24, sourceText.length))
  const fields = Object.fromEntries(REQUIREMENT_SEMANTIC_FIELDS.map((field) => [field, {
    value: '',
    confidence: 0,
    evidence: ''
  }])) as Record<string, { value: string; confidence: number; evidence: string }>
  Object.assign(fields.requirementType, { value: 'Enhancement', confidence: 0.99, evidence })
  Object.assign(fields.productDomain, { value: '订单管理', confidence: 0.98, evidence })
  Object.assign(fields.module, { value: '订单管理', confidence: 0.98, evidence })
  Object.assign(fields.functionalObject, { value: '订单详情', confidence: 0.96, evidence })
  Object.assign(fields.action, { value: invalid ? 'invented_action' : 'add_capability', confidence: 0.95, evidence })
  Object.assign(fields.behavior, { value: '用户按订单编号查询并查看订单详情', confidence: 0.96, evidence })
  Object.assign(fields.input, { value: '订单编号', confidence: 0.9, evidence })
  Object.assign(fields.output, { value: '订单详情', confidence: 0.9, evidence })
  Object.assign(fields.acceptance, { value: '返回对应订单详情', confidence: 0.88, evidence })
  return JSON.stringify({ recordUid, fields, analysisSummary: '三阶段分析与裁决完成' })
}

const createModel = (invalid = false): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  calls: ModelChatInput[]
  passes: string[]
} => {
  const calls: ModelChatInput[] = []
  const passes: string[] = []
  return {
    calls,
    passes,
    client: {
      async chat(input): Promise<ModelResponse> {
        calls.push(input)
        assert.equal(input.think, true, 'all semanticization stages must request model reasoning')
        assert.equal(input.forceThinking, true, 'all semanticization stages must force model reasoning')
        assert.ok(input.format && typeof input.format === 'object', 'all semanticization stages must request strict schema output')
        const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as {
          recordUid: string
          sourceText: string
          analysisPass?: string
        }
        assert.ok(payload.recordUid)
        assert.ok(payload.sourceText.includes('订单详情查询'))
        assert.ok(!payload.sourceText.includes('<p>') && !payload.sourceText.includes('&quot;'))
        passes.push(payload.analysisPass ?? '')
        return {
          message: {
            role: 'assistant',
            content: outputFor(payload.recordUid, payload.sourceText, invalid)
          }
        }
      }
    }
  }
}

const waitForJob = (
  start: () => { jobId: string },
  subscribe: (resolve: (progress: RequirementSemanticizationProgress) => void) => void
): Promise<RequirementSemanticizationProgress> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('semanticization job timed out')), 10_000)
  const result = start()
  subscribe((progress) => {
    if (progress.jobId !== result.jobId || progress.status !== 'completed') return
    clearTimeout(timer)
    resolve(progress)
  })
})

const testLifecycle = async (db: AppDatabase): Promise<void> => {
  const record = upsert(
    db,
    'semantic-ready-uid',
    '<p>支持按订单编号查询 &quot;订单&quot; &amp; 详情。</p><script>alert(1)</script>'
  )
  const model = createModel()
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settings,
    (progress) => listener?.(progress),
    () => model.client
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 0)
  assert.equal(model.calls.length, 3, 'one record must execute initial, independent and adjudication exactly once')
  assert.deepEqual(model.passes, ['initial', 'independent', 'adjudication'])

  const context = service.context()
  const contentHash = db.getRecordContentHash(record.uid)
  assert.ok(contentHash)
  const card = db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash, ...context })
  assert.ok(card)
  assert.equal(card.analysisStatus, 'ai_adjudicated')
  assert.equal(card.functionalObject, '订单详情')

  const cached = service.start({ recordUids: [record.uid] })
  assert.equal(cached.accepted, 0)
  assert.equal(cached.skipped, 1)
  assert.equal(model.calls.length, 3, 'valid ready cards must not be regenerated')

  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'ready' }, context).total, 1)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, context).total, 0)

  db.updateRecordNormalizedText(record.uid, `${record.normalizedText}\n内容发生变化`)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, context).total, 1)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'ready' }, context).total, 0)
  const changedHash = db.getRecordContentHash(record.uid)
  assert.ok(changedHash && changedHash !== contentHash)
  assert.equal(db.getReadyRequirementSemanticCard({ recordUid: record.uid, contentHash: changedHash, ...context }), null)

  const analyzerChanged = { ...context, analyzerVersion: `${REQUIREMENT_SEMANTIC_ANALYZER_VERSION}-next` }
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, analyzerChanged).total, 1)
  const modelChanged = {
    ...context,
    modelSignature: requirementSemanticModelSignature({ ...settings, model: 'semantic-regression-model-next' })
  }
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'pending' }, modelChanged).total, 1)
}

const testFailure = async (db: AppDatabase): Promise<void> => {
  const record = upsert(db, 'semantic-failed-uid', '<p>支持查看订单详情。</p>')
  const model = createModel(true)
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settings,
    (progress) => listener?.(progress),
    () => model.client
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 1)
  assert.equal(model.calls.length, 2, 'invalid schema output retries once and fails closed before later stages')
  const state = db.getRequirementSemanticCardState(record.uid)
  assert.equal(state?.status, 'failed')
  assert.equal(state?.card, null)
  assert.match(state?.errorMessage ?? '', /未知枚举/)
  assert.equal(db.listRecords({ page: 1, pageSize: 20, semanticStatus: 'failed' }, service.context()).total, 1)
}

const testModelSettingsSnapshot = async (db: AppDatabase): Promise<void> => {
  const record = upsert(db, 'semantic-settings-snapshot-uid', '<p>支持按订单编号查看订单详情。</p>')
  const firstSettings = { ...settings, model: 'semantic-snapshot-first' }
  const laterSettings = { ...settings, model: 'semantic-snapshot-later' }
  const model = createModel()
  const capturedModels: string[] = []
  let settingsReads = 0
  let listener: ((progress: RequirementSemanticizationProgress) => void) | undefined
  const service = new RequirementSemanticizationService(
    db,
    () => settingsReads++ === 0 ? firstSettings : laterSettings,
    (progress) => listener?.(progress),
    (capturedSettings) => {
      capturedModels.push(capturedSettings.model)
      return model.client
    }
  )
  const completed = await waitForJob(
    () => service.start({ recordUids: [record.uid] }),
    (resolve) => { listener = resolve }
  )
  assert.equal(completed.failed, 0)
  assert.equal(settingsReads, 1, 'job submission must capture model settings exactly once')
  assert.deepEqual(capturedModels, [firstSettings.model], 'model client must use the settings captured for the cache signature')
  const state = db.getRequirementSemanticCardState(record.uid)
  assert.equal(state?.status, 'ready')
  assert.equal(state?.modelSignature, requirementSemanticModelSignature(firstSettings))
}

const main = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-semantic-card-regression-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
    await testLifecycle(db)
    await testFailure(db)
    await testModelSettingsSnapshot(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'persistent pending/processing/ready/failed lifecycle',
        'three reasoning stages per record',
        'strict schema, evidence and enum validation',
        'ready-card cache hit without model calls',
        'content/analyzer/model invalidation',
        'atomic model-settings snapshot for signature and execution',
        'asset-center status filtering',
        'failed output never becomes a usable card'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
