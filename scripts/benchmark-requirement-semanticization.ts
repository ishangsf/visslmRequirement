import { performance } from 'node:perf_hooks'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../src/main/database'
import type { ModelChatInput, ModelResponse } from '../src/main/model-client'
import {
  RequirementSemanticizationService,
  type RequirementSemanticizationModelClient
} from '../src/main/requirements/semanticization-service'
import { REQUIREMENT_SEMANTIC_FIELDS } from '../src/main/requirements/semantic-card'
import type {
  ModelSettings,
  RequirementSemanticizationProgress,
  RequirementSemanticizationQualityMode,
  RequirementSemanticizationTaskSnapshot
} from '../src/shared/types'

type Assessment = { value: string; confidence: number; evidence: string }
type Payload = {
  task?: string
  recordUid?: string
  sourceText?: string
  analysisPass?: string
}
type Stage = 'initial' | 'independent' | 'adjudication'
type CallMetric = {
  recordUid: string
  stage: Stage
  repair: boolean
  adjudication: boolean
  logicalDurationMs: number
}
type RecordMetric = {
  recordUid: string
  callCount: number
  logicalDurationMs: number
  repair: boolean
  adjudication: boolean
}
type RunResult = {
  qualityMode: RequirementSemanticizationQualityMode
  recordCount: number
  calls: CallMetric[]
  records: RecordMetric[]
  maxInFlight: number
  wallClockMs: number
}
type Options = {
  records: number
  iterations: number
  warmup: number
  json: boolean
  enforce: boolean
}

const offlineSettings: ModelSettings = {
  // The injected client below is always used. This URL is deliberately
  // unreachable so an accidental network fallback cannot look like a pass.
  source: 'online',
  provider: 'openai',
  baseUrl: 'https://offline-semanticization.invalid/v1',
  model: 'offline-semanticization-stub',
  thinking: false
}
const knownFields = ['requirementType', 'productDomain', 'module'] as const
const modelFields = REQUIREMENT_SEMANTIC_FIELDS.filter((field) => !knownFields.includes(field as never))

const percentile = (values: number[], fraction: number): number => {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return sorted[index]
}

const statistics = (values: number[]) => ({
  p50: Number(percentile(values, 0.5).toFixed(2)),
  p95: Number(percentile(values, 0.95).toFixed(2)),
  p99: Number(percentile(values, 0.99).toFixed(2))
})

const parseOptions = (): Options => {
  const values = new Map<string, string>()
  let json = false
  let enforce = false
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--enforce') {
      enforce = true
      continue
    }
    if (!arg.startsWith('--') || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error(`参数无效：${arg}`)
    }
    values.set(arg, args[index + 1])
    index += 1
  }
  const numberValue = (name: string, fallback: number): number => {
    const value = Number(values.get(name) ?? fallback)
    if (!Number.isFinite(value)) throw new Error(`${name} 不是有效数字`)
    return value
  }
  return {
    records: Math.max(1, Math.trunc(numberValue('--records', 20))),
    iterations: Math.max(1, Math.trunc(numberValue('--iterations', 5))),
    warmup: Math.max(0, Math.trunc(numberValue('--warmup', 1))),
    json,
    enforce
  }
}

const upsert = (db: AppDatabase, uid: string): void => {
  db.upsertRecord({
    uid,
    projectId: 'offline-semanticization-benchmark',
    nodeType: 'Requirement',
    itemId: uid.toUpperCase(),
    parentId: '',
    name: '订单详情查询',
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      IssueType: 'Enhancement',
      _valm_ProductDomain: '订单管理',
      _valm_Module: '订单管理',
      _valm_Description: '<p>用户可以按订单编号查询并查看订单详情；返回对应订单详情。</p><script>不应发送</script>'
    },
    normalizedText: '订单详情查询\n用户可以按订单编号查询并查看订单详情；返回对应订单详情。'
  })
}

const empty = (): Assessment => ({ value: '', confidence: 0, evidence: '' })

const modelFieldsFor = (
  overrides: Partial<Record<string, Assessment>> = {}
): Record<string, Assessment> => {
  const fields = Object.fromEntries(modelFields.map((field) => [field, empty()])) as Record<string, Assessment>
  Object.assign(fields, {
    functionalObject: { value: '订单详情', confidence: 0.96, evidence: '订单详情查询' },
    action: { value: 'add_capability', confidence: 0.96, evidence: '查询' },
    behavior: { value: '用户按订单编号查询并查看订单详情', confidence: 0.96, evidence: '用户可以按订单编号查询并查看订单详情' },
    input: { value: '订单编号', confidence: 0.9, evidence: '订单编号' },
    output: { value: '订单详情', confidence: 0.9, evidence: '订单详情' },
    acceptance: { value: '返回对应订单详情', confidence: 0.88, evidence: '返回对应订单详情' }
  })
  Object.assign(fields, overrides)
  return fields
}

const responseFor = (
  payload: Payload,
  qualityMode: RequirementSemanticizationQualityMode,
  recordIndex: number
): { response: ModelResponse; logicalDurationMs: number; repair: boolean; adjudication: boolean } => {
  const repair = payload.task?.startsWith('repair_') ?? false
  const adjudication = payload.analysisPass === 'adjudication'
  const divergence = qualityMode === 'strict' && recordIndex % 10 === 0
  let overrides: Partial<Record<string, Assessment>> = {}
  if (repair) {
    overrides = {
      functionalObject: { value: '订单详情', confidence: 0.96, evidence: '订单详情查询' }
    }
  } else if (qualityMode === 'standard' && recordIndex % 10 === 0) {
    overrides = {
      functionalObject: { value: '订单详情', confidence: 0.4, evidence: '订单详情查询' }
    }
  } else if (adjudication) {
    overrides = {
      action: { value: 'add_capability', confidence: 0.98, evidence: '查询' }
    }
  } else if (divergence && payload.analysisPass === 'independent') {
    overrides = {
      action: { value: 'change_flow', confidence: 0.82, evidence: '查询' }
    }
  }
  const logicalDurationMs = adjudication ? 6 : repair ? 4 : payload.analysisPass === 'independent' ? 9 : 8
  return {
    response: {
      message: {
        role: 'assistant',
        content: JSON.stringify({
          recordUid: payload.recordUid,
          fields: modelFieldsFor(overrides),
          analysisSummary: 'offline deterministic benchmark result'
        })
      },
      usage: {
        promptTokens: 80 + (payload.sourceText?.length ?? 0),
        completionTokens: 30,
        totalDurationMs: logicalDurationMs
      }
    },
    logicalDurationMs,
    repair,
    adjudication
  }
}

const parsePayload = (input: ModelChatInput): Payload => {
  const payload = JSON.parse(input.messages.at(-1)?.content ?? '{}') as Payload
  if (!payload.recordUid || !payload.sourceText) throw new Error('offline stub received an incomplete payload')
  return payload
}

const recordIndex = (uid: string): number => {
  const value = Number(uid.split('-').at(-1))
  return Number.isInteger(value) && value > 0 ? value : 1
}

const createOfflineClient = (
  qualityMode: RequirementSemanticizationQualityMode,
  calls: CallMetric[],
  getMaxInFlight: (value: number) => void
): RequirementSemanticizationModelClient => {
  let inFlight = 0
  return {
    chat(input) {
      const payload = parsePayload(input)
      const stage: Stage = payload.analysisPass === 'independent'
        ? 'independent'
        : payload.analysisPass === 'adjudication' ? 'adjudication' : 'initial'
      const metric = responseFor(payload, qualityMode, recordIndex(payload.recordUid!))
      inFlight += 1
      getMaxInFlight(inFlight)
      calls.push({
        recordUid: payload.recordUid!,
        stage,
        repair: metric.repair,
        adjudication: metric.adjudication,
        logicalDurationMs: metric.logicalDurationMs
      })
      return Promise.resolve(metric.response).finally(() => { inFlight -= 1 })
    }
  }
}

const waitForCompletion = async (
  completion: Promise<RequirementSemanticizationTaskSnapshot>
): Promise<RequirementSemanticizationTaskSnapshot> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion,
      new Promise<RequirementSemanticizationTaskSnapshot>((_, reject) => {
        timer = setTimeout(() => reject(new Error('offline benchmark task did not complete')), 30_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const runProfile = async (
  qualityMode: RequirementSemanticizationQualityMode,
  recordCount: number
): Promise<RunResult> => {
  const directory = await mkdtemp(join(tmpdir(), `semanticization-benchmark-${qualityMode}-`))
  const db = new AppDatabase(join(directory, 'semantic.db'), join(directory, 'assets'))
  const calls: CallMetric[] = []
  const recordUids = Array.from({ length: recordCount }, (_, index) => `offline-${qualityMode}-${index + 1}`)
  let maxInFlight = 0
  const client = createOfflineClient(qualityMode, calls, (value) => { maxInFlight = Math.max(maxInFlight, value) })
  const progress: Promise<RequirementSemanticizationTaskSnapshot> = new Promise((resolve) => {
    const service = new RequirementSemanticizationService(
      db,
      () => offlineSettings,
      (snapshot: RequirementSemanticizationProgress) => {
        if (snapshot.status === 'completed') resolve(snapshot)
      },
      () => client
    )
    for (const uid of recordUids) upsert(db, uid)
    const result = service.start({ recordUids, qualityMode })
    if (result.accepted !== recordCount) throw new Error(`offline benchmark accepted ${result.accepted}/${recordCount} records`)
  })
  const started = performance.now()
  try {
    const task = await waitForCompletion(progress)
    if (task.succeeded !== recordCount || task.failed !== 0) {
      throw new Error(`offline benchmark ${qualityMode} finished ${task.succeeded} succeeded/${task.failed} failed`)
    }
    const records = recordUids.map((recordUid): RecordMetric => {
      const recordCalls = calls.filter((call) => call.recordUid === recordUid)
      const initialDuration = recordCalls
        .filter((call) => call.stage === 'initial')
        .reduce((total, call) => total + call.logicalDurationMs, 0)
      const independentDuration = recordCalls
        .filter((call) => call.stage === 'independent')
        .reduce((total, call) => total + call.logicalDurationMs, 0)
      const adjudicationDuration = recordCalls
        .filter((call) => call.stage === 'adjudication')
        .reduce((total, call) => total + call.logicalDurationMs, 0)
      return {
        recordUid,
        callCount: recordCalls.length,
        logicalDurationMs: qualityMode === 'strict'
          ? Math.max(initialDuration, independentDuration) + adjudicationDuration
          : initialDuration,
        repair: recordCalls.some((call) => call.repair),
        adjudication: recordCalls.some((call) => call.adjudication)
      }
    })
    return {
      qualityMode,
      recordCount,
      calls,
      records,
      maxInFlight,
      wallClockMs: Number((performance.now() - started).toFixed(2))
    }
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const aggregateProfile = (runs: RunResult[]) => {
  const qualityMode = runs[0]?.qualityMode ?? 'standard'
  const calls = runs.flatMap((run) => run.calls)
  const records = runs.flatMap((run) => run.records)
  const stageNames: Stage[] = ['initial', 'independent', 'adjudication']
  const byStage = Object.fromEntries(stageNames.map((stage) => {
    const stageCalls = calls.filter((call) => call.stage === stage)
    return [stage, {
      count: stageCalls.length,
      latencyMs: statistics(stageCalls.map((call) => call.logicalDurationMs))
    }]
  })) as Record<Stage, { count: number; latencyMs: ReturnType<typeof statistics> }>
  const repairCount = records.filter((record) => record.repair).length
  const adjudicationCount = records.filter((record) => record.adjudication).length
  return {
    qualityMode,
    record: {
      count: records.length,
      callCount: statistics(records.map((record) => record.callCount)),
      logicalLatencyMs: statistics(records.map((record) => record.logicalDurationMs))
    },
    stage: byStage,
    call: {
      count: calls.length,
      logicalLatencyMs: statistics(calls.map((call) => call.logicalDurationMs))
    },
    repairRate: Number((repairCount / Math.max(1, records.length)).toFixed(4)),
    adjudicationRate: Number((adjudicationCount / Math.max(1, records.length)).toFixed(4)),
    maxInFlight: Math.max(...runs.map((run) => run.maxInFlight), 0),
    wallClockMs: statistics(runs.map((run) => run.wallClockMs)),
    iterations: runs.length,
    note: 'offline deterministic stub; logical latency is a repeatable harness value, not provider/network latency'
  }
}

const expectedViolations = (profile: ReturnType<typeof aggregateProfile>, records: number): string[] => {
  const violations: string[] = []
  const repairRecords = Array.from({ length: records }, (_, index) => index + 1).filter((index) => index % 10 === 0).length
  const adjudicationRecords = profile.qualityMode === 'strict' ? repairRecords : 0
  const expectedCalls = profile.qualityMode === 'standard'
    ? records + repairRecords
    : records * 2 + adjudicationRecords
  const expectedMaxInFlight = profile.qualityMode === 'standard'
    ? Math.min(4, records)
    : Math.min(4, records * 2)
  const expectedRecordCount = records * profile.iterations
  if (profile.record.count !== expectedRecordCount) {
    violations.push(`record count ${profile.record.count} != ${expectedRecordCount}`)
  }
  if (profile.call.count !== expectedCalls * profile.iterations) {
    violations.push(`call count ${profile.call.count} != ${expectedCalls * profile.iterations}`)
  }
  if (profile.maxInFlight !== expectedMaxInFlight) {
    violations.push(`maxInFlight ${profile.maxInFlight} != ${expectedMaxInFlight}`)
  }
  const expectedRepairRate = Number(((profile.qualityMode === 'standard' ? repairRecords : 0) /
    Math.max(1, records)).toFixed(4))
  const expectedAdjudicationRate = Number((adjudicationRecords / Math.max(1, records)).toFixed(4))
  if (profile.repairRate !== expectedRepairRate) violations.push(`repairRate ${profile.repairRate} != ${expectedRepairRate}`)
  if (profile.adjudicationRate !== expectedAdjudicationRate) {
    violations.push(`adjudicationRate ${profile.adjudicationRate} != ${expectedAdjudicationRate}`)
  }
  for (const metric of [profile.call.logicalLatencyMs, profile.record.callCount, profile.record.logicalLatencyMs]) {
    if (![metric.p50, metric.p95, metric.p99].every((value) => Number.isFinite(value) && value >= 0)) {
      violations.push('latency/count percentiles must be finite and non-negative')
      break
    }
  }
  return violations
}

const run = async (): Promise<void> => {
  const options = parseOptions()
  const profiles = []
  const violations: string[] = []
  for (const qualityMode of ['standard', 'strict'] as const) {
    const runs: RunResult[] = []
    for (let iteration = 0; iteration < options.warmup + options.iterations; iteration += 1) {
      const result = await runProfile(qualityMode, options.records)
      if (iteration >= options.warmup) runs.push(result)
    }
    const profile = aggregateProfile(runs)
    profiles.push(profile)
    violations.push(...expectedViolations(profile, options.records).map((item) => `${qualityMode}: ${item}`))
  }
  const report = {
    status: options.enforce ? (violations.length ? 'GATE_FAIL' : 'PASS') : 'REPORT',
    gateMode: options.enforce ? 'enforced' : 'report-only',
    provider: 'offline-stub',
    network: false,
    records: options.records,
    iterations: options.iterations,
    warmup: options.warmup,
    profiles,
    violations
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log('Requirement semanticization benchmark (offline deterministic stub; no network)')
    for (const profile of profiles) {
      console.log([
        `${profile.qualityMode}:`,
        `records=${profile.record.count}`,
        `calls=${profile.call.count}`,
        `record.p50/p95/p99=${profile.record.logicalLatencyMs.p50}/${profile.record.logicalLatencyMs.p95}/${profile.record.logicalLatencyMs.p99}ms`,
        `repairRate=${profile.repairRate}`,
        `adjudicationRate=${profile.adjudicationRate}`,
        `maxInFlight=${profile.maxInFlight}`
      ].join(' '))
    }
    console.log(`status=${report.status}`)
    if (violations.length) console.log(`violations=${violations.join('; ')}`)
  }
  if (options.enforce && violations.length) process.exitCode = 1
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
