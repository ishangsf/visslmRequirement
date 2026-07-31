import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const resourceRoot = resolve(process.env.VISSLM_RESOURCE_ROOT ?? join(projectRoot, 'buildResources'))
const huggingFaceEndpoint = (process.env.VISSLM_HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/+$/, '')

const EMBEDDING_MODEL = {
  id: 'Xenova/bge-small-zh-v1.5',
  revision: '75c43b069aac4d136ba6bc1122f995fedcfd2781',
  license: 'Apache-2.0',
  files: [
    'config.json',
    'onnx/model_quantized.onnx',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.txt'
  ]
}

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
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length) throw new Error(`Downloaded an empty resource: ${url}`)
  if (!validate(bytes)) throw new Error(`Downloaded resource failed validation: ${url}`)
  const temporary = `${target}.download-${process.pid}-${Date.now()}`
  await writeFile(temporary, bytes)
  await rename(temporary, target)
  return { bytes, downloaded: true }
}

const prepare = async () => {
  const modelDirectory = join(resourceRoot, 'models', ...EMBEDDING_MODEL.id.split('/'))
  const modelFiles = []
  for (const file of EMBEDDING_MODEL.files) {
    const url = `${huggingFaceEndpoint}/${EMBEDDING_MODEL.id}/resolve/${EMBEDDING_MODEL.revision}/${file}`
    const target = join(modelDirectory, file)
    const result = await download(url, target)
    modelFiles.push({
      file: `${EMBEDDING_MODEL.id}/${file}`,
      url,
      byteSize: result.bytes.length,
      sha256: sha256(result.bytes)
    })
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
      type: 'embedding-model',
      id: EMBEDDING_MODEL.id,
      revision: EMBEDDING_MODEL.revision,
      license: EMBEDDING_MODEL.license,
      source: 'https://huggingface.co/Xenova/bge-small-zh-v1.5',
      files: modelFiles
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
  console.log(`Embedding model: ${modelFiles.map((item) => `${item.file} (${item.byteSize} bytes)`).join(', ')}`)
  console.log(`OCR languages: ${ocrFiles.map((item) => `${item.file} (${item.byteSize} bytes)`).join(', ')}`)
}

prepare().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
