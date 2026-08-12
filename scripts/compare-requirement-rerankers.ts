import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { cpus, totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type JsonObject = Record<string, unknown>

interface ModelFileManifest {
  file: string
  byteSize?: number
  sha256?: string
}

interface ModelManifestEntry {
  type?: string
  id: string
  revision: string
  license?: string
  source?: string
  files: ModelFileManifest[]
}

interface PinnedManifest {
  version?: string
  schemaVersion?: string
  type?: string
  models?: unknown
  baseline?: unknown
  candidate?: unknown
  crossEncoder?: unknown
}

interface PairInput {
  id: string
  queryId: string
  candidateId: string
  query: string
  candidate: string
}

interface InputFile {
  schemaVersion?: string
  pairs?: unknown
  inputs?: unknown
  queries?: unknown
}

interface Options {
  baseModel?: string
  candidateModel?: string
  basePath?: string
  candidatePath?: string
  manifest?: string
  inputs?: string
  output?: string
  resourceRoot: string
  baseRevision?: string
  candidateRevision?: string
  baseLicense?: string
  candidateLicense?: string
  iterations: number
  warmup: number
  batchSize: number
  maxLength: number
  dtype: string
  reportOnly: boolean
  run: boolean
  help: boolean
}

interface ModelSpec {
  role: 'base' | 'candidate'
  id: string
  revision?: string
  license?: string
  source?: string
  modelPath: string
  files?: ModelFileManifest[]
  manifestSource: string
}

interface ResourceFileReport {
  path: string
  relativePath: string
  present: boolean
  byteSize: number | null
  sha256: string | null
  expectedByteSize: number | null
  expectedSha256: string | null
  checks: {
    byteSize: boolean | null
    sha256: boolean | null
  }
  error?: string
}

interface ModelResourceReport {
  role: ModelSpec['role']
  id: string
  revision: string | null
  license: string | null
  source: string | null
  modelPath: string
  manifestSource: string
  metadataChecks: {
    id: boolean
    revision: boolean
    license: boolean
    files: boolean
  }
  files: ResourceFileReport[]
  present: boolean
  sha256Verified: boolean
  byteSize: number
  errors: string[]
}

interface ScoreItem {
  id: string
  score: number
}

interface ModelRunReport {
  role: ModelSpec['role']
  id: string
  status: 'PASS' | 'BLOCKED' | 'ERROR'
  inputCount: number
  iterations: number
  warmup: number
  timingsMs: {
    p50: number | null
    p95: number | null
    min: number | null
    max: number | null
  }
  memory: {
    before: { rss: number; heapUsed: number }
    afterLoad: { rss: number; heapUsed: number }
    afterRun: { rss: number; heapUsed: number }
    loadDelta: { rss: number; heapUsed: number }
    runDelta: { rss: number; heapUsed: number }
  } | null
  rankings: Array<{ queryId: string; ranking: ScoreItem[] }>
  error?: string
}

const DEFAULT_BASE_MODEL = 'Xenova/bge-reranker-base'
const DEFAULT_CANDIDATE_MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX'
const DEFAULT_BASE_REVISION = '280bcc27a84e0b898c251e06fddb25171bd9b101'
const MODEL_FILE_NAMES = [
  'config.json',
  'onnx/model_int8.onnx',
  'onnx/model_quantized.onnx',
  'onnx/model.onnx',
  'sentencepiece.bpe.model',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
  'merges.txt'
] as const
const MANIFEST_VERSION = 'requirement-reranker-comparison-v1'

const isObject = (value: unknown): value is JsonObject => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asString = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined

const asFiniteNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parseArgs = (): Options => {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    if (arg === '--help' || arg === '-h' || arg === '--report-only' || arg === '--run') {
      flags.add(arg)
      continue
    }
    const next = args[index + 1]
    if (!next || next.startsWith('--')) throw new Error(`Argument requires a value: ${arg}`)
    values.set(arg, next)
    index += 1
  }
  const numberValue = (name: string, fallback: number, minimum: number): number => {
    const raw = values.get(name)
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isFinite(value) || value < minimum) throw new Error(`${name} must be a number >= ${minimum}: ${raw}`)
    return Math.trunc(value)
  }
  const resourceRoot = resolve(values.get('--resource-root') ?? process.env.VISSLM_RESOURCE_ROOT ?? join(projectRoot(), 'buildResources'))
  const dtype = values.get('--dtype') ?? 'int8'
  if (!['int8', 'q8', 'fp32', 'fp16', 'auto'].includes(dtype)) throw new Error(`Unsupported --dtype: ${dtype}`)
  return {
    baseModel: values.get('--base-model'),
    candidateModel: values.get('--candidate-model'),
    basePath: values.get('--base-path') ? resolve(values.get('--base-path')!) : undefined,
    candidatePath: values.get('--candidate-path') ? resolve(values.get('--candidate-path')!) : undefined,
    manifest: values.get('--manifest') ? resolve(values.get('--manifest')!) : undefined,
    inputs: values.get('--inputs') ? resolve(values.get('--inputs')!) : undefined,
    output: values.get('--output') ? resolve(values.get('--output')!) : undefined,
    resourceRoot,
    baseRevision: values.get('--base-revision'),
    candidateRevision: values.get('--candidate-revision'),
    baseLicense: values.get('--base-license'),
    candidateLicense: values.get('--candidate-license'),
    iterations: numberValue('--iterations', 1, 1),
    warmup: numberValue('--warmup', 0, 0),
    batchSize: numberValue('--batch-size', 8, 1),
    maxLength: numberValue('--max-length', 512, 1),
    dtype,
    reportOnly: flags.has('--report-only'),
    run: flags.has('--run'),
    help: flags.has('--help') || flags.has('-h')
  }
}

const projectRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), '..')

const usage = (): string => `Usage: npx tsx scripts/compare-requirement-rerankers.ts [options]

Default behavior is local resource/manifest inspection only. It never downloads models.

Model selection:
  --base-model <id|path>          Base model (default: ${DEFAULT_BASE_MODEL})
  --candidate-model <id|path>     Candidate model (default: ${DEFAULT_CANDIDATE_MODEL})
  --base-path <path>              Local base model directory override
  --candidate-path <path>         Local candidate model directory override
  --manifest <path>               Pinned JSON manifest; may define base/candidate entries
  --resource-root <path>          Root containing models/<org>/<name> (default: VISSLM_RESOURCE_ROOT or buildResources)
  --base-revision <revision>      Override base revision when using CLI model selection
  --candidate-revision <revision> Override candidate revision when using CLI model selection
  --base-license <license>        Override base license metadata when using CLI model selection
  --candidate-license <license>   Override candidate license metadata when using CLI model selection

Inputs and execution:
  --inputs <path>                 JSON pairs with queryId, candidateItemId, query and candidate
  --run                           Load both local tokenizer/model and score the same pairs
  --iterations <n>                Measured inference iterations (default: 1)
  --warmup <n>                    Warmup inference iterations (default: 0)
  --batch-size <n>                Pair batch size (default: 8)
  --max-length <n>                Tokenizer max_length (default: 512)
  --dtype <int8|q8|fp32|fp16|auto> Model dtype (default: int8)

Reporting:
  --output <path>                 Write the JSON report to this path as well as stdout
  --report-only                   Keep a non-zero status report from changing process exit code
  --help                          Show this help

Exit status is non-zero for ERROR, BLOCKED, or failed verification when enforcement is enabled.
The candidate remains UNVERIFIED until an independent evaluation process accepts it.`

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8')) as unknown

const objectAt = (value: unknown, path: string): JsonObject | undefined => {
  const segments = path.split('.').filter(Boolean)
  let current: unknown = value
  for (const segment of segments) {
    if (!isObject(current)) return undefined
    current = current[segment]
  }
  return isObject(current) ? current : undefined
}

const modelEntryAt = (manifest: unknown, role: ModelSpec['role']): JsonObject | undefined => {
  const root = isObject(manifest) ? manifest : undefined
  const direct = role === 'base' ? root?.base : root?.candidate
  if (isObject(direct)) return direct
  const models = root?.models
  if (Array.isArray(models)) {
    const entry = models.find((item) => isObject(item) && (item.role === role || item.name === role))
    if (isObject(entry)) return entry
  }
  if (isObject(models)) {
    const entry = models[role]
    if (isObject(entry)) return entry
  }
  const crossEncoder = root?.crossEncoder
  if (role === 'base' && isObject(crossEncoder)) return crossEncoder
  return undefined
}

const normalizeFileManifest = (value: unknown): ModelFileManifest[] | undefined => {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((item): ModelFileManifest[] => {
    if (!isObject(item)) return []
    const file = asString(item.file) ?? asString(item.path)
    if (!file) return []
    return [{
      file,
      byteSize: asFiniteNumber(item.byteSize) ?? asFiniteNumber(item.size),
      sha256: asString(item.sha256)?.toLowerCase()
    }]
  })
}

const inferModelPath = (resourceRoot: string, model: string): string => {
  if (isAbsolute(model) || model.includes('\\') || model.startsWith('./') || model.startsWith('../')) return resolve(model)
  return join(resourceRoot, 'models', ...model.split('/'))
}

const defaultFilesForModel = (modelPath: string): string[] => {
  return MODEL_FILE_NAMES.filter((file) => file === 'onnx/model_int8.onnx' || file === 'onnx/model_quantized.onnx' || file === 'onnx/model.onnx' || true)
    .filter((file) => file.endsWith('.json') || file === 'sentencepiece.bpe.model' || file === 'tokenizer.json' || file.startsWith('onnx/'))
    .filter((file) => file === 'onnx/model_int8.onnx' || file === 'onnx/model_quantized.onnx' || file === 'onnx/model.onnx' || file.endsWith('.json') || file === 'sentencepiece.bpe.model')
    .map((file) => join(modelPath, file))
    .map((file) => relative(modelPath, file))
}

const createModelSpec = (role: ModelSpec['role'], options: Options, manifest: unknown): ModelSpec => {
  const entry = modelEntryAt(manifest, role)
  const cliModel = role === 'base' ? options.baseModel : options.candidateModel
  const id = asString(entry?.id) ?? cliModel ?? (role === 'base' ? DEFAULT_BASE_MODEL : DEFAULT_CANDIDATE_MODEL)
  const revision = asString(entry?.revision) ?? (role === 'base' ? options.baseRevision : options.candidateRevision) ?? (role === 'base' && id === DEFAULT_BASE_MODEL ? DEFAULT_BASE_REVISION : undefined)
  const license = asString(entry?.license) ?? (role === 'base' ? options.baseLicense : options.candidateLicense)
  const source = asString(entry?.source)
  const cliPath = role === 'base' ? options.basePath : options.candidatePath
  const modelPath = asString(entry?.path) ? resolve(asString(entry?.path)!) : cliPath ?? inferModelPath(options.resourceRoot, id)
  const files = normalizeFileManifest(entry?.files)
  return { role, id, revision, license, source, modelPath, files, manifestSource: entry ? options.manifest ?? 'inline/default manifest entry' : 'CLI/default selection' }
}

const sha256File = async (path: string): Promise<string> => {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

const fileNamesUnder = async (root: string): Promise<string[]> => {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(relative(root, path).replaceAll('\\', '/'))
    }
  }
  await visit(root)
  return result.sort()
}

const inspectModel = async (spec: ModelSpec, manifest: unknown): Promise<ModelResourceReport> => {
  const errors: string[] = []
  const entry = modelEntryAt(manifest, spec.role)
  const expectedFiles = spec.files?.length ? spec.files : normalizeFileManifest(entry?.files)
  const filesToCheck = expectedFiles?.length ? expectedFiles : defaultFilesForModel(spec.modelPath).map((file) => ({ file }))
  const manifestIds = expectedFiles?.length ? expectedFiles.map((file) => file.file) : []
  const actualFiles = await fileNamesUnder(spec.modelPath)
  if (!actualFiles.length) errors.push(`model directory is missing or empty: ${spec.modelPath}`)
  const files: ResourceFileReport[] = []
  let byteSize = 0
  for (const expected of filesToCheck) {
    const relativePath = expected.file.replace(/^.*?\/models\//, '').replaceAll('\\', '/')
    const fileName = relativePath.startsWith(`${spec.id}/`) ? relativePath.slice(spec.id.length + 1) : relativePath
    const path = join(spec.modelPath, fileName)
    try {
      const fileStat = await stat(path)
      if (!fileStat.isFile()) throw new Error('path is not a file')
      const digest = await sha256File(path)
      byteSize += fileStat.size
      const byteCheck = expected.byteSize === undefined ? null : expected.byteSize === fileStat.size
      const shaCheck = expected.sha256 === undefined ? null : expected.sha256.toLowerCase() === digest
      if (byteCheck === false) errors.push(`${fileName}: byteSize mismatch`)
      if (shaCheck === false) errors.push(`${fileName}: SHA-256 mismatch`)
      files.push({ path, relativePath: fileName, present: true, byteSize: fileStat.size, sha256: digest, expectedByteSize: expected.byteSize ?? null, expectedSha256: expected.sha256 ?? null, checks: { byteSize: byteCheck, sha256: shaCheck } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${fileName}: ${message}`)
      files.push({ path, relativePath: fileName, present: false, byteSize: null, sha256: null, expectedByteSize: expected.byteSize ?? null, expectedSha256: expected.sha256 ?? null, checks: { byteSize: false, sha256: false }, error: message })
    }
  }
  const metadataChecks = {
    id: Boolean(spec.id),
    revision: Boolean(spec.revision),
    license: Boolean(spec.license),
    files: Boolean(expectedFiles?.length && expectedFiles.every((file) => file.sha256 && Number.isFinite(file.byteSize)))
  }
  if (!metadataChecks.revision) errors.push('revision metadata is missing; pin a commit revision')
  if (!metadataChecks.license) errors.push('license metadata is missing; provide a pinned license value')
  if (!metadataChecks.files) errors.push('manifest files must include byteSize and sha256 for every file')
  if (manifestIds.some((file) => file.includes('..'))) errors.push('manifest contains an invalid parent path')
  return {
    role: spec.role,
    id: spec.id,
    revision: spec.revision ?? null,
    license: spec.license ?? null,
    source: spec.source ?? null,
    modelPath: spec.modelPath,
    manifestSource: spec.manifestSource,
    metadataChecks,
    files,
    present: errors.length === 0 || files.every((file) => file.present),
    sha256Verified: files.length > 0 && files.every((file) => file.checks.sha256 === true),
    byteSize,
    errors
  }
}

const normalizePairs = (input: unknown): PairInput[] => {
  const root = isObject(input) ? input as InputFile : undefined
  const source = Array.isArray(input) ? input : root?.pairs ?? root?.inputs ?? root?.queries
  if (!Array.isArray(source)) throw new Error('inputs must be an array or an object with pairs/inputs/queries')
  return source.flatMap((item, index): PairInput[] => {
    if (!isObject(item)) throw new Error(`inputs[${index}] must be an object`)
    const id = asString(item.id) ?? asString(item.inputId) ?? asString(item.pairId) ?? `input-${index + 1}`
    const query = asString(item.query) ?? asString(item.base) ?? asString(item.baseText) ?? asString(item.left)
    const candidate = asString(item.candidate) ?? asString(item.candidateText) ?? asString(item.right)
    if (!query || !candidate) throw new Error(`inputs[${index}] requires query/base and candidate/candidateText`)
    const slashIndex = id.indexOf('/')
    const queryId = asString(item.queryId) ?? asString(item.baseItemId) ?? (slashIndex > 0 ? id.slice(0, slashIndex) : `query-${createHash('sha256').update(query).digest('hex').slice(0, 16)}`)
    const candidateId = asString(item.candidateItemId) ?? asString(item.candidateId) ?? (slashIndex > 0 ? id.slice(slashIndex + 1) : id)
    return [{ id, queryId, candidateId, query, candidate }]
  })
}

const validatePairGroups = (inputs: PairInput[]): PairInput[] => {
  const seen = new Set<string>()
  const queryTextById = new Map<string, string>()
  for (const input of inputs) {
    const key = `${input.queryId}\u0000${input.candidateId}`
    if (seen.has(key)) throw new Error(`duplicate candidate in query group: ${input.queryId}/${input.candidateId}`)
    seen.add(key)
    const queryText = queryTextById.get(input.queryId)
    if (queryText !== undefined && queryText !== input.query) throw new Error(`queryId maps to inconsistent query text: ${input.queryId}`)
    queryTextById.set(input.queryId, input.query)
  }
  return inputs
}

const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return Number((sorted[index] ?? 0).toFixed(3))
}

const memorySnapshot = (): { rss: number; heapUsed: number } => {
  const memory = process.memoryUsage()
  return { rss: memory.rss, heapUsed: memory.heapUsed }
}

const memoryDelta = (before: { rss: number; heapUsed: number }, after: { rss: number; heapUsed: number }): { rss: number; heapUsed: number } => ({
  rss: after.rss - before.rss,
  heapUsed: after.heapUsed - before.heapUsed
})

const scoreFromLogits = (output: any, index: number): number => {
  const data = output?.logits?.data as ArrayLike<number> | undefined
  const dims = output?.logits?.dims as number[] | undefined
  if (!data || !dims?.length) throw new Error('Cross-Encoder did not return logits')
  const width = Number(dims[dims.length - 1])
  if (!width || data.length < (index + 1) * width) throw new Error('Cross-Encoder logits shape is invalid')
  if (width === 1) {
    const logit = Number(data[index])
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, logit))))
  }
  const values = Array.from({ length: width }, (_, offset) => Number(data[index * width + offset]))
  const max = Math.max(...values)
  const probabilities = values.map((value) => Math.exp(value - max))
  return (probabilities[probabilities.length - 1] ?? 0) / Math.max(1e-9, probabilities.reduce((sum, value) => sum + value, 0))
}

const loadRuntime = async (spec: ModelSpec, options: Options): Promise<{ tokenizer: any; model: any }> => {
  const runtime = await import('@huggingface/transformers') as any
  runtime.env.allowRemoteModels = false
  runtime.env.allowLocalModels = true
  runtime.env.useBrowserCache = false
  const tokenizer = await runtime.AutoTokenizer.from_pretrained(spec.modelPath, { local_files_only: true })
  const model = await runtime.AutoModelForSequenceClassification.from_pretrained(spec.modelPath, {
    dtype: options.dtype,
    local_files_only: true,
    model_file_name: 'model'
  })
  return { tokenizer, model }
}

const scorePairs = async (runtime: { tokenizer: any; model: any }, inputs: PairInput[], options: Options): Promise<ScoreItem[]> => {
  const scores: ScoreItem[] = []
  for (let offset = 0; offset < inputs.length; offset += options.batchSize) {
    const batch = inputs.slice(offset, offset + options.batchSize)
    const left = batch.map((item) => item.query.slice(0, 6000))
    const right = batch.map((item) => item.candidate.slice(0, 6000))
    const encoded = runtime.tokenizer(left, { text_pair: right, padding: true, truncation: true, max_length: options.maxLength })
    const output = await runtime.model(encoded)
    scores.push(...batch.map((item, index) => ({ id: item.id, score: scoreFromLogits(output, index) })))
  }
  return scores
}

export const groupRankings = (inputs: PairInput[], scores: ScoreItem[]): Array<{ queryId: string; ranking: ScoreItem[] }> => {
  const scoreByPairId = new Map(scores.map((item) => [item.id, item.score]))
  const byQuery = new Map<string, ScoreItem[]>()
  for (const input of inputs) {
    const ranking = byQuery.get(input.queryId) ?? []
    ranking.push({ id: input.candidateId, score: scoreByPairId.get(input.id) ?? 0 })
    byQuery.set(input.queryId, ranking)
  }
  return [...byQuery]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([queryId, ranking]) => ({
      queryId,
      ranking: ranking.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    }))
}

const runModel = async (spec: ModelSpec, resource: ModelResourceReport, inputs: PairInput[], options: Options): Promise<ModelRunReport> => {
  const before = memorySnapshot()
  if (!resource.present || !resource.sha256Verified || resource.errors.length) {
    return { role: spec.role, id: spec.id, status: 'BLOCKED', inputCount: inputs.length, iterations: options.iterations, warmup: options.warmup, timingsMs: { p50: null, p95: null, min: null, max: null }, memory: null, rankings: [], error: `local resource verification failed: ${resource.errors.join('; ')}` }
  }
  if (!inputs.length) return { role: spec.role, id: spec.id, status: 'BLOCKED', inputCount: 0, iterations: options.iterations, warmup: options.warmup, timingsMs: { p50: null, p95: null, min: null, max: null }, memory: null, rankings: [], error: 'no input pairs supplied; pass --inputs' }
  try {
    const runtime = await loadRuntime(spec, options)
    const afterLoad = memorySnapshot()
    let scores: ScoreItem[] = []
    const timings: number[] = []
    for (let iteration = 0; iteration < options.warmup + options.iterations; iteration += 1) {
      const started = performance.now()
      scores = await scorePairs(runtime, inputs, options)
      const elapsed = performance.now() - started
      if (iteration >= options.warmup) timings.push(elapsed)
    }
    const afterRun = memorySnapshot()
    if (typeof runtime.model.dispose === 'function') await runtime.model.dispose()
    return {
      role: spec.role,
      id: spec.id,
      status: 'PASS',
      inputCount: inputs.length,
      iterations: options.iterations,
      warmup: options.warmup,
      timingsMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95), min: percentile(timings, 0), max: percentile(timings, 1) },
      memory: { before, afterLoad, afterRun, loadDelta: memoryDelta(before, afterLoad), runDelta: memoryDelta(afterLoad, afterRun) },
      rankings: groupRankings(inputs, scores)
    }
  } catch (error) {
    return { role: spec.role, id: spec.id, status: 'ERROR', inputCount: inputs.length, iterations: options.iterations, warmup: options.warmup, timingsMs: { p50: null, p95: null, min: null, max: null }, memory: null, rankings: [], error: error instanceof Error ? error.message : String(error) }
  }
}

const kendallTau = (left: ScoreItem[], right: ScoreItem[]): number | null => {
  const rightRank = new Map(right.map((item, index) => [item.id, index]))
  const common = left.filter((item) => rightRank.has(item.id))
  if (common.length < 2) return null
  let concordant = 0
  let discordant = 0
  for (let leftIndex = 0; leftIndex < common.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < common.length; rightIndex += 1) {
      const a = rightRank.get(common[leftIndex].id)!
      const b = rightRank.get(common[rightIndex].id)!
      if (a === b) continue
      if (a < b) concordant += 1
      else discordant += 1
    }
  }
  const pairs = concordant + discordant
  return pairs ? Number(((concordant - discordant) / pairs).toFixed(6)) : null
}

export const rankingAgreement = (base: ModelRunReport, candidate: ModelRunReport): JsonObject => {
  const candidateById = new Map(candidate.rankings.map((item) => [item.queryId, item.ranking]))
  const taus = base.rankings.flatMap((item) => {
    const tau = kendallTau(item.ranking, candidateById.get(item.queryId) ?? [])
    return tau === null ? [] : [tau]
  })
  const identical = base.rankings.reduce((count, item) => {
    const other = candidateById.get(item.queryId) ?? []
    return count + (item.ranking.map((entry) => entry.id).join('\u0000') === other.map((entry) => entry.id).join('\u0000') ? 1 : 0)
  }, 0)
  return {
    comparableInputCount: taus.length,
    exactRankingMatchCount: identical,
    exactRankingMatchRate: base.rankings.length ? Number((identical / base.rankings.length).toFixed(6)) : null,
    kendallTauP50: percentile(taus, 0.5),
    kendallTauP95: percentile(taus, 0.95)
  }
}

const writeReport = async (report: JsonObject, output?: string): Promise<void> => {
  const serialized = JSON.stringify(report, null, 2)
  console.log(serialized)
  if (output) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(output, `${serialized}\n`, 'utf8')
  }
}

const main = async (): Promise<void> => {
  const options = parseArgs()
  if (options.help) {
    console.log(usage())
    return
  }
  let manifest: unknown = undefined
  const errors: string[] = []
  try {
    if (options.manifest) manifest = await readJson(options.manifest)
  } catch (error) {
    errors.push(`manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  const baseSpec = createModelSpec('base', options, manifest)
  const candidateSpec = createModelSpec('candidate', options, manifest)
  const [baseResource, candidateResource] = await Promise.all([
    inspectModel(baseSpec, manifest),
    inspectModel(candidateSpec, manifest)
  ])
  let inputs: PairInput[] = []
  try {
    if (options.inputs) inputs = validatePairGroups(normalizePairs(await readJson(options.inputs)))
  } catch (error) {
    errors.push(`inputs: ${error instanceof Error ? error.message : String(error)}`)
  }
  const system = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    runtime: '@huggingface/transformers local_files_only=true allowRemoteModels=false'
  }
  const baseRun = options.run && !errors.length ? await runModel(baseSpec, baseResource, inputs, options) : null
  const candidateRun = options.run && !errors.length ? await runModel(candidateSpec, candidateResource, inputs, options) : null
  const agreement = baseRun?.status === 'PASS' && candidateRun?.status === 'PASS' ? rankingAgreement(baseRun, candidateRun) : null
  const status = errors.length || baseResource.errors.length || candidateResource.errors.length || (options.run && (baseRun?.status !== 'PASS' || candidateRun?.status !== 'PASS')) ? 'BLOCKED' : 'PASS'
  const report: JsonObject = {
    schemaVersion: MANIFEST_VERSION,
    status,
    gateMode: options.reportOnly ? 'report-only' : 'enforced',
    execution: options.run ? 'run' : 'dry/report-only',
    candidateDisposition: status === 'PASS' ? 'MEASURED: technical comparison only; no automatic promotion' : 'BLOCKED: no model comparison accepted',
    system,
    options: {
      baseModel: baseSpec.id,
      candidateModel: candidateSpec.id,
      basePath: baseSpec.modelPath,
      candidatePath: candidateSpec.modelPath,
      resourceRoot: options.resourceRoot,
      inputs: options.inputs ?? null,
      manifest: options.manifest ?? null,
      iterations: options.iterations,
      warmup: options.warmup,
      batchSize: options.batchSize,
      maxLength: options.maxLength,
      dtype: options.dtype
    },
    resources: { base: baseResource, candidate: candidateResource, totalByteSize: baseResource.byteSize + candidateResource.byteSize },
    inputs: { pairCount: inputs.length, queryCount: new Set(inputs.map((input) => input.queryId)).size },
    runs: { base: baseRun, candidate: candidateRun },
    comparison: { rankingAgreement: agreement },
    errors,
    notes: [
      'This script does not download models and does not modify online matching behavior.',
      'A BLOCKED result is evidence that the comparison cannot be trusted, not a candidate failure measurement.',
      'This report records technical measurements and does not automatically switch the production model.'
    ]
  }
  await writeReport(report, options.output)
  if (status !== 'PASS' && !options.reportOnly) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const report = { schemaVersion: MANIFEST_VERSION, status: 'ERROR', gateMode: 'enforced', message: error instanceof Error ? error.message : String(error), notes: ['No model was downloaded.'] }
    console.error(JSON.stringify(report, null, 2))
    process.exitCode = 1
  })
}
