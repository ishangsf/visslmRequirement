import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceRoot = resolve(process.env.VISSLM_RESOURCE_ROOT ?? join(projectRoot, 'buildResources'))
const huggingFaceEndpoint = (process.env.VISSLM_HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '')
const execFileAsync = promisify(execFile)

const EMBEDDING_MODEL = {
  id: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  license: 'Apache-2.0',
  source: 'https://huggingface.co/Xenova/bge-small-zh-v1.5',
  files: [
    'config.json',
    'onnx/model_quantized.onnx',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.txt'
  ]
}

const CROSS_ENCODER_MODEL = {
  id: 'Xenova/bge-reranker-base',
  revision: '280bcc27a84e0b898c251e06fddb25171bd9b101',
  license: 'Apache-2.0',
  source: 'https://huggingface.co/Xenova/bge-reranker-base',
  files: [
    'config.json',
    'onnx/model_int8.onnx',
    'sentencepiece.bpe.model',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json'
  ]
}

const MODEL_RESOURCES = [EMBEDDING_MODEL, CROSS_ENCODER_MODEL]

const OCR = {
  version: 'tesseract-data-4.0.0',
  license: 'Apache-2.0',
  baseUrl: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0',
  files: ['eng.traineddata.gz', 'chi_sim.traineddata.gz']
}
const ocrEndpoint = (process.env.VISSLM_OCR_ENDPOINT ?? OCR.baseUrl).replace(/\/+$/, '')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isCompleteGzip = (bytes) => {
  try {
    gunzipSync(bytes)
    return true
  } catch {
    return false
  }
}

const modelDirectory = (model) => join(resourceRoot, 'models', ...model.id.split('/'))
const modelFileUrl = (model, file) => `${huggingFaceEndpoint}/${model.id}/resolve/${model.revision}/${file}`

const download = async (url, target, validate = () => true) => {
  await mkdir(dirname(target), { recursive: true })
  try {
    const existing = await stat(target)
    if (existing.isFile() && existing.size > 0) {
      const bytes = await readFile(target)
      if (validate(bytes)) return { bytes, downloaded: false }
      console.warn(`Existing resource is incomplete, redownloading ${target}`)
    }
  } catch {
    // The file does not exist yet.
  }

  console.log(`Downloading ${url}`)
  let bytes
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!response.ok) {
      throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`)
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (process.platform !== 'win32') throw error
    const fallback = `${target}.powershell-${process.pid}-${Date.now()}`
    try {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '$downloadUrl=[Environment]::GetEnvironmentVariable("VISSLM_RESOURCE_DOWNLOAD_URL");$downloadTarget=[Environment]::GetEnvironmentVariable("VISSLM_RESOURCE_DOWNLOAD_TARGET");Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $downloadTarget'
      ], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          VISSLM_RESOURCE_DOWNLOAD_URL: url,
          VISSLM_RESOURCE_DOWNLOAD_TARGET: fallback
        }
      })
      bytes = await readFile(fallback)
    } catch (fallbackError) {
      throw new Error(
        `Download failed through Node fetch and PowerShell: ${url}; ` +
        `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        { cause: error }
      )
    } finally {
      try {
        await unlink(fallback)
      } catch {
        // The fallback file may not have been created.
      }
    }
  }
  if (!bytes.length) throw new Error(`Downloaded an empty resource: ${url}`)
  if (!validate(bytes)) throw new Error(`Downloaded resource failed validation: ${url}`)
  const temporary = `${target}.download-${process.pid}-${Date.now()}`
  await writeFile(temporary, bytes)
  await rename(temporary, target)
  return { bytes, downloaded: true }
}

const prepareModel = async (model) => {
  const files = []
  for (const file of model.files) {
    const url = modelFileUrl(model, file)
    const target = join(modelDirectory(model), file)
    const result = await download(url, target)
    files.push({
      file: `${model.id}/${file}`,
      url,
      byteSize: result.bytes.length,
      sha256: sha256(result.bytes)
    })
  }
  return files
}

const modelManifest = (model, files, type) => ({
  type,
  id: model.id,
  revision: model.revision,
  license: model.license,
  source: model.source,
  files
})

const plannedResources = () => ({
  resourceRoot,
  packageTarget: 'resources/models',
  models: MODEL_RESOURCES.map((model) => ({
    id: model.id,
    revision: model.revision,
    license: model.license,
    source: model.source,
    output: modelDirectory(model),
    files: model.files.map((file) => ({
      file: `${model.id}/${file}`,
      url: modelFileUrl(model, file),
      output: join(modelDirectory(model), file)
    }))
  })),
  ocr: {
    output: join(resourceRoot, 'ocr', 'tessdata'),
    files: OCR.files.map((file) => ({
      file: `tessdata/${file}`,
      url: `${ocrEndpoint}/${file}`,
      output: join(resourceRoot, 'ocr', 'tessdata', file)
    }))
  }
})

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

const checkManifestFiles = async (manifest, model, files, failures) => {
  if (!manifest || typeof manifest !== 'object') {
    failures.push(`${model.id}: manifest entry is missing`)
    return
  }
  const value = manifest
  if (value.id !== model.id) failures.push(`${model.id}: manifest id does not match`)
  if (value.revision !== model.revision) failures.push(`${model.id}: manifest revision does not match`)
  if (value.license !== model.license) failures.push(`${model.id}: manifest license does not match`)
  if (value.source !== model.source) failures.push(`${model.id}: manifest source does not match`)
  const records = Array.isArray(value.files) ? value.files : []
  for (const file of files) {
    const record = records.find((item) => item && item.file === `${model.id}/${file}`)
    const target = join(modelDirectory(model), file)
    if (!record) {
      failures.push(`${target}: manifest file entry is missing`)
      continue
    }
    try {
      const bytes = await readFile(target)
      const digest = sha256(bytes)
      if (record.byteSize !== bytes.length) failures.push(`${target}: byte size does not match manifest`)
      if (record.sha256 !== digest) failures.push(`${target}: sha256 does not match manifest`)
    } catch {
      failures.push(`${target}: file is missing or unreadable`)
    }
  }
}

const checkLocalResources = async () => {
  const failures = []
  const manifestPath = join(resourceRoot, 'models', 'manifest.json')
  let manifest = null
  try {
    manifest = await readJson(manifestPath)
  } catch {
    failures.push(`${manifestPath}: manifest is missing or invalid`)
  }

  if (manifest) {
    await checkManifestFiles(manifest, EMBEDDING_MODEL, EMBEDDING_MODEL.files, failures)
    await checkManifestFiles(manifest.crossEncoder, CROSS_ENCODER_MODEL, CROSS_ENCODER_MODEL.files, failures)
  }

  const ocrManifestPath = join(resourceRoot, 'ocr', 'manifest.json')
  try {
    const ocrManifest = await readJson(ocrManifestPath)
    if (ocrManifest.version !== OCR.version) failures.push(`${ocrManifestPath}: version does not match`)
    if (ocrManifest.license !== OCR.license) failures.push(`${ocrManifestPath}: license does not match`)
    if (ocrManifest.source !== OCR.baseUrl) failures.push(`${ocrManifestPath}: source does not match`)
    const records = Array.isArray(ocrManifest.files) ? ocrManifest.files : []
    for (const file of OCR.files) {
      const target = join(resourceRoot, 'ocr', 'tessdata', file)
      const record = records.find((item) => item && item.file === `tessdata/${file}`)
      if (!record) {
        failures.push(`${target}: manifest file entry is missing`)
        continue
      }
      try {
        const bytes = await readFile(target)
        if (!isCompleteGzip(bytes)) failures.push(`${target}: gzip validation failed`)
        if (record.byteSize !== bytes.length) failures.push(`${target}: byte size does not match manifest`)
        if (record.sha256 !== sha256(bytes)) failures.push(`${target}: sha256 does not match manifest`)
      } catch {
        failures.push(`${target}: file is missing or unreadable`)
      }
    }
  } catch {
    failures.push(`${ocrManifestPath}: manifest is missing or invalid`)
  }

  if (failures.length) {
    throw new Error(`Local resource check failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`)
  }
  console.log(`Local AI resources are complete and match their manifests in ${resourceRoot}`)
}

const prepare = async () => {
  const preparedModels = []
  for (const model of MODEL_RESOURCES) {
    preparedModels.push({ model, files: await prepareModel(model) })
  }

  const tessdataDirectory = join(resourceRoot, 'ocr', 'tessdata')
  const ocrFiles = []
  for (const file of OCR.files) {
    const url = `${ocrEndpoint}/${file}`
    const target = join(tessdataDirectory, file)
    const result = await download(url, target, isCompleteGzip)
    ocrFiles.push({
      file: `tessdata/${file}`,
      url,
      byteSize: result.bytes.length,
      sha256: sha256(result.bytes)
    })
  }

  await writeFile(
    join(resourceRoot, 'models', 'manifest.json'),
    `${JSON.stringify({
      ...modelManifest(EMBEDDING_MODEL, preparedModels[0].files, 'embedding-model'),
      crossEncoder: modelManifest(CROSS_ENCODER_MODEL, preparedModels[1].files, 'cross-encoder-model')
    }, null, 2)}\n`,
    'utf8'
  )
  await writeFile(
    join(resourceRoot, 'ocr', 'manifest.json'),
    `${JSON.stringify({
      type: 'tesseract-language-data',
      version: OCR.version,
      license: OCR.license,
      source: OCR.baseUrl,
      languages: ['chi_sim', 'eng'],
      files: ocrFiles
    }, null, 2)}\n`,
    'utf8'
  )

  console.log(`Prepared local AI resources in ${resourceRoot}`)
  for (const { model, files } of preparedModels) {
    console.log(`${model.id}: ${files.map((item) => `${item.file} (${item.byteSize} bytes)`).join(', ')}`)
  }
  console.log(`OCR languages: ${ocrFiles.map((item) => `${item.file} (${item.byteSize} bytes)`).join(', ')}`)
}

const usage = () => {
  console.log(`Usage: node scripts/prepare-local-resources.mjs [--dry-run|--check|--help]

  --dry-run  Print pinned model/OCR files and output paths without network or file writes.
  --check    Verify all local model/OCR files and manifest SHA-256 values without network or writes.
  --help     Show this help text.`)
}

const main = async () => {
  const args = new Set(process.argv.slice(2))
  const supportedArgs = new Set(['--dry-run', '--check', '--help', '-h'])
  const unknownArgs = [...args].filter((arg) => !supportedArgs.has(arg))
  if (unknownArgs.length) throw new Error(`Unknown argument(s): ${unknownArgs.join(', ')}`)
  if (args.has('--help') || args.has('-h')) {
    usage()
    return
  }
  if (args.has('--dry-run') && args.has('--check')) {
    throw new Error('--dry-run and --check cannot be used together')
  }
  if (args.has('--dry-run')) {
    console.log(JSON.stringify(plannedResources(), null, 2))
    return
  }
  if (args.has('--check')) {
    await checkLocalResources()
    return
  }
  await prepare()
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
