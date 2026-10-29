import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { DataExportResult, DataImportResult, DataReviewItem } from '../shared/types'
import { findRichTextImageSources, parseAssetToken, replaceRichTextImageSources } from './rich-text-assets'

const PACK_FORMAT = 'visslm-transfer'
const PACK_VERSION = 1
const MAX_PACK_BYTES = 1024 * 1024 * 1024
const MAX_ENTRY_COUNT = 200_000

type JsonObject = Record<string, unknown>

export interface TransferPackDatabase {
  iterateExportRows(recordUids?: ReadonlySet<string>): Generator<Record<string, unknown>>
  iterateExportRowsWithoutBinary?(recordUids?: ReadonlySet<string>): Generator<Record<string, unknown>>
  readAssetBytes(sha256: string): Buffer | null
  getAssetBlob(sha256: string): { sha256: string; mimeType: string; byteSize: number; filePath: string } | null
  saveAssetBlob?(input: { sha256: string; mimeType: string; bytes: Buffer }): unknown
  removeAssetBlob?(sha256: string): void
  runInTransaction?<T>(action: () => T): T
  importRows(rows: unknown[]): DataImportResult
}

interface PackAsset {
  sha256: string
  mimeType: string
  byteSize: number
  sourcePath?: string
  fallbackPath?: string
}

interface PackManifest {
  format: typeof PACK_FORMAT
  version: typeof PACK_VERSION
  createdAt: string
  recordCount: number
  assetCount: number
  assetBytes: number
  entries: {
    records: string
    assets: string
    checksums: string
  }
}

interface PackChecksum {
  path: string
  sha256: string
  byteSize: number
}

const text = (value: unknown): string => value === undefined || value === null ? '' : String(value)

const normalizePackMime = (value: unknown): string => {
  const candidate = text(value).trim().toLowerCase().split(';', 1)[0]
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(candidate)
    ? candidate
    : 'application/octet-stream'
}

const asObject = (value: unknown): JsonObject | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null

const safeEntryName = (entry: string): string => {
  const normalized = entry.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`资源包条目路径无效：${entry}`)
  }
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`资源包条目路径包含穿越：${entry}`)
  }
  if (normalized.length > 260 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`资源包条目路径过长或含控制字符：${entry}`)
  }
  return normalized
}

const digestFile = async (filePath: string): Promise<{ sha256: string; byteSize: number }> => {
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(bytes)
    byteSize += bytes.byteLength
  }
  return { sha256: hash.digest('hex'), byteSize }
}

const isKnownImageSignature = (mimeType: string, bytes: Buffer): boolean => {
  const mime = mimeType.trim().toLowerCase()
  if (!mime.startsWith('image/')) return true
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mime === 'image/jpeg' || mime === 'image/jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (mime === 'image/gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  if (mime === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (mime === 'image/bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM'
  if (mime === 'image/svg+xml') {
    const textValue = bytes.subarray(0, Math.min(bytes.length, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart()
    return /^<(?:\?xml[^>]*>\s*)?<svg\b/i.test(textValue)
  }
  // Unknown image MIME types are allowed only when there is no stronger
  // signature rule.  The MIME is still retained in the manifest/record.
  return true
}

const detectMimeType = (bytes: Buffer, fallback = 'application/octet-stream'): string => {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp'
  return fallback
}

const validateAssetBytes = (sha256: string, mimeType: string, bytes: Buffer): void => {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error(`图片资源 SHA-256 无效：${sha256}`)
  if (!bytes.length) throw new Error(`图片资源为空：${sha256}`)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== sha256.toLowerCase()) throw new Error(`图片资源校验失败：${sha256}`)
  if (!mimeType.trim().toLowerCase().startsWith('image/')) {
    throw new Error(`图片 MIME 无效：${sha256}`)
  }
  if (!isKnownImageSignature(mimeType, bytes)) throw new Error(`图片 MIME 与文件签名不匹配：${sha256}`)
}

const streamZipFile = async (
  zip: Zip,
  entryName: string,
  filePath: string,
  deflate: boolean,
  mimeType?: string
): Promise<{ sha256: string; byteSize: number }> => {
  const entry = deflate ? new ZipDeflate(entryName, { level: 6 }) : new ZipPassThrough(entryName)
  zip.add(entry)
  const hash = createHash('sha256')
  const prefix = Buffer.alloc(4096)
  let prefixLength = 0
  let byteSize = 0
  for await (const chunk of createReadStream(filePath)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (prefixLength < prefix.byteLength) {
      const copyLength = Math.min(prefix.byteLength - prefixLength, bytes.byteLength)
      bytes.copy(prefix, prefixLength, 0, copyLength)
      prefixLength += copyLength
    }
    hash.update(bytes)
    byteSize += bytes.byteLength
    entry.push(bytes)
  }
  entry.push(new Uint8Array(0), true)
  if (mimeType && (!mimeType.toLowerCase().startsWith('image/') ||
    !isKnownImageSignature(mimeType, prefix.subarray(0, prefixLength)))) {
    throw new Error(`图片 MIME 与文件签名不匹配：${entryName}`)
  }
  return { sha256: hash.digest('hex'), byteSize }
}

const writeAll = (fd: number, bytes: Uint8Array): void => {
  let offset = 0
  while (offset < bytes.byteLength) {
    offset += writeSync(fd, bytes, offset, bytes.byteLength - offset)
  }
}

const stripBinaryFields = (row: JsonObject): JsonObject => {
  const images = Array.isArray(row.images) ? row.images : []
  return {
    ...row,
    images: images.map((input) => {
      const image = asObject(input)
      if (!image) return input
      const { base64: _base64, dataUri: _dataUri, ...metadata } = image
      const sha256 = text(metadata.sha256).trim().toLowerCase()
      const sourceUrl = text(metadata.sourceUrl)
      const compactSourceUrl = sha256 && /^data:image\//i.test(sourceUrl)
        ? `inline:data-uri:${sha256}`
        : sourceUrl
      return sha256
        ? { ...metadata, sourceUrl: compactSourceUrl, assetPath: `assets/${sha256}` }
        : { ...metadata, sourceUrl: compactSourceUrl }
    }),
    imageReferences: Array.isArray(row.imageReferences)
      ? row.imageReferences.map((input) => {
          const reference = asObject(input)
          if (!reference) return input
          const sha256 = text(reference.assetSha256 || reference.sha256).trim().toLowerCase()
          const originalSource = text(reference.originalSource)
          return {
            ...reference,
            originalSource: sha256 && /^data:image\//i.test(originalSource)
              ? `inline:data-uri:${sha256}`
              : originalSource
          }
        })
      : row.imageReferences
  }
}

const containsImageDataUri = (input: unknown): boolean => {
  if (typeof input === 'string') return /^data:image\//i.test(input)
  if (Array.isArray(input)) return input.some(containsImageDataUri)
  if (input && typeof input === 'object') {
    return Object.values(input as JsonObject).some(containsImageDataUri)
  }
  return false
}

const imageExtension = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i
const assetTokenPattern = /visslm-asset:\/\/([a-f0-9]{64})\/[A-Za-z0-9_-]{1,128}/gi

/**
 * A plain image value is allowed to be a field value in newer exports. Keep
 * this deliberately narrow so an ordinary text value such as "icon.png" is
 * never treated as an image source.
 */
const isStandaloneImageSource = (input: string): boolean =>
  !parseAssetToken(input) && (/^data:image\//i.test(input) ||
    (input.includes('/') && !/[\s<>"']/.test(input) && imageExtension.test(input)))

const dataUriSha256 = (value: string): string => {
  const match = /^data:image\/[^;,\s]+;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value.trim())
  if (!match || match[1].length % 4 === 1) return ''
  try {
    const bytes = Buffer.from(match[1], 'base64')
    return bytes.length ? createHash('sha256').update(bytes).digest('hex') : ''
  } catch {
    return ''
  }
}

const sourceMatchesAlias = (source: string, candidate: string): boolean => {
  const left = source.trim()
  const right = candidate.trim()
  if (!left || !right) return false
  if (left === right) return true
  // Data URI bytes are compacted in exported image metadata and references.
  if (/^data:image\//i.test(left)) {
    const sha256 = dataUriSha256(left)
    const compact = /^inline:data-uri(?::([a-f0-9]{64}))?$/i.exec(right)
    if (!compact) return false
    return Boolean(sha256) && (compact[1] ? compact[1].toLowerCase() === sha256 : true)
  }
  if (/^data:image\//i.test(right)) return sourceMatchesAlias(right, left)
  return false
}

const uniqueImageCandidate = (
  images: JsonObject[],
  source: string
): JsonObject | undefined => {
  const sourceSha = dataUriSha256(source)
  const candidates = images.filter((image) => {
    const imageSha = validSha256(image.sha256)
    if (sourceSha && imageSha && sourceSha !== imageSha) return false
    return sourceMatchesAlias(source, text(image.sourceUrl))
  })
  return candidates.length === 1 ? candidates[0] : undefined
}

const rowRecordUid = (row: JsonObject): string => {
  const metadata = asObject(row.metadata)
  const sourceId = text(metadata?.sourceId).trim()
  if (sourceId) return sourceId
  const uid = text(row.uid).trim()
  if (uid) return uid
  const documentId = text(row.documentId).trim()
  const separator = documentId.indexOf(':')
  return separator >= 0 ? documentId.slice(separator + 1) : documentId
}

const referenceMatches = (
  reference: JsonObject,
  recordUid: string,
  fieldPath: string,
  ordinal: number,
  source: string
): boolean => {
  const referenceRecordUid = text(reference.recordUid).trim()
  if (referenceRecordUid && recordUid && referenceRecordUid !== recordUid) return false
  if (text(reference.fieldPath).trim() !== fieldPath) return false
  const referenceOrdinal = Number(reference.ordinal ?? reference.occurrence)
  if (!Number.isSafeInteger(referenceOrdinal) || referenceOrdinal !== ordinal) return false
  const sourceSha = dataUriSha256(source)
  const referencedSha = validSha256(reference.assetSha256 || reference.sha256)
  if (sourceSha && referencedSha && sourceSha !== referencedSha) return false
  const originalSource = text(reference.originalSource).trim()
  // References from current exports carry the original source. A source-less
  // legacy reference is only safe when its field/ordinal pair is exact.
  return !originalSource || sourceMatchesAlias(source, originalSource)
}

const validSha256 = (value: unknown): string => {
  const sha256 = text(value).trim().toLowerCase()
  return /^[a-f0-9]{64}$/.test(sha256) ? sha256 : ''
}

/** Tokenize legacy image-bearing values throughout the raw object. */
const tokenizeLegacyImages = (row: JsonObject): JsonObject => {
  const raw = asObject(row.raw)
  const images = Array.isArray(row.images) ? row.images.map(asObject).filter(Boolean) as JsonObject[] : []
  if (!raw) return row
  let imageIndex = 0
  const recordUid = rowRecordUid(row)
  const recordKey = (recordUid || text(row.title))
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 24) || 'record'
  const imageReferences = Array.isArray(row.imageReferences)
    ? row.imageReferences.map((input) => asObject(input)).filter(Boolean) as JsonObject[]
    : []
  const resolveSource = (source: string, fieldPath: string, ordinal: number): string | undefined => {
    const existingReference = imageReferences.find((reference) =>
      referenceMatches(reference, recordUid, fieldPath, ordinal, source)
    )
    const referencedSha = validSha256(existingReference?.assetSha256 || existingReference?.sha256)
    const match = uniqueImageCandidate(images, source)
    const sha256 = referencedSha || validSha256(match?.sha256)
    if (!sha256) return undefined
    const referenceId = text(existingReference?.id).trim() || `legacy-${recordKey}-${++imageIndex}`
    if (!existingReference) {
      imageReferences.push({
        id: referenceId,
        recordUid,
        fieldPath,
        occurrence: ordinal,
        ordinal,
        assetSha256: sha256,
        sourceType: 'legacy-export',
        sourceName: text(match?.name),
        originalSource: /^data:image\//i.test(source)
          ? `inline:data-uri:${sha256}`
          : source
      })
    }
    return `visslm-asset://${sha256}/${referenceId}`
  }
  const tokenize = (input: unknown, fieldPath: string): unknown => {
    if (typeof input === 'string') {
      if (isStandaloneImageSource(input)) return resolveSource(input, fieldPath, 0) ?? input
      return replaceRichTextImageSources(input, (source) =>
        parseAssetToken(source.source)
          ? undefined
          : resolveSource(source.source, fieldPath, source.occurrence)).html
    }
    if (Array.isArray(input)) {
      return input.map((entry, index) => tokenize(entry, `${fieldPath}[${index}]`))
    }
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input as JsonObject).map(([key, entry]) =>
        [key, tokenize(entry, fieldPath ? `${fieldPath}.${key}` : key)]))
    }
    return input
  }
  const tokenizedRaw = tokenize(raw, '') as JsonObject
  return {
    ...row,
    raw: tokenizedRaw,
    imageReferences
  }
}

/**
 * Rewrite rich-text image sources while allowing a resolver to explicitly
 * remove a source.  replaceRichTextImageSources intentionally leaves an
 * unresolved source untouched, which is useful during collection but would
 * leave a dangling URL in a transfer pack.
 */
const replaceRichTextSourcesForExport = (
  html: string,
  resolver: (source: ReturnType<typeof findRichTextImageSources>[number]) => string | undefined
): string => {
  const ranges: Array<{ start: number; end: number; value: string }> = []
  for (const source of findRichTextImageSources(html)) {
    const value = resolver(source)
    if (value === undefined) continue
    ranges.push({ start: source.start, end: source.end, value })
  }
  let result = html
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, range.start) + range.value + result.slice(range.end)
  }
  return result
}

/** Remove any remaining standalone embedded image payloads from JSON values. */
const stripImageDataUris = (value: unknown): unknown => {
  if (typeof value === 'string') return /^\s*data:image\//i.test(value) ? '' : value
  if (Array.isArray(value)) return value.map(stripImageDataUris)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject).map(([key, child]) => [key, stripImageDataUris(child)])
    )
  }
  return value
}

const imageSha256 = (image: JsonObject): string => {
  const direct = text(image.sha256).trim().toLowerCase()
  if (/^[a-f0-9]{64}$/.test(direct)) return direct
  return parseAssetToken(text(image.assetUrl))?.sha256 ?? ''
}

const safeImageReferenceId = (value: unknown, fallback: string): string => {
  const candidate = text(value).trim()
  return /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : fallback
}

const mergeImportResults = (results: DataImportResult[]): DataImportResult => {
  const first = results[0]
  const duplicates: DataReviewItem[] = results.flatMap((result) => result.duplicates)
  const errors = results.flatMap((result) => result.errors).slice(0, 50)
  const recordCount = results.reduce((sum, result) => sum + result.recordCount, 0)
  const imageCount = results.reduce((sum, result) => sum + result.imageCount, 0)
  const skippedCount = results.reduce((sum, result) => sum + result.skippedCount, 0)
  return {
    ok: results.every((result) => result.ok),
    recordCount,
    imageCount,
    skippedCount,
    errors,
    duplicates,
    reviewBatchId: first?.reviewBatchId,
    message: `导入完成：${recordCount} 条记录，${imageCount} 张图片，跳过 ${skippedCount} 条`,
    format: 'visslmpack',
    packVersion: PACK_VERSION,
    checksumVerified: true
  }
}

/** Stream a .visslmpack file without building the archive in memory. */
export async function exportVisslmPack(
  db: TransferPackDatabase,
  targetPath: string,
  recordUids?: ReadonlySet<string>
): Promise<DataExportResult> {
  const temporaryPath = `${targetPath}.part-${process.pid}-${randomUUID()}`
  mkdirSync(dirname(targetPath), { recursive: true })
  const fallbackDirectory = join(tmpdir(), `visslm-pack-assets-${randomUUID()}`)
  mkdirSync(fallbackDirectory, { recursive: true })
  const assets = new Map<string, PackAsset>()
  const checksums: PackChecksum[] = []
  let recordCount = 0
  let recordBytes = 0
  const recordHash = createHash('sha256')
  let fd: number | undefined
  let zipError: Error | undefined
  try {
    fd = openSync(temporaryPath, 'w')
    const zip = new Zip((error, chunk) => {
      if (error) {
        zipError = new Error(String(error))
        return
      }
      if (fd !== undefined) writeAll(fd, chunk)
    })
    const recordsEntry = new ZipDeflate('records.jsonl', { level: 6 })
    zip.add(recordsEntry)
    let skippedImageCount = 0
    const skippedKeys = new Set<string>()
    const noteSkipped = (recordLabel: string, key: string): void => {
      const dedupeKey = `${recordLabel}\u0000${key}`
      if (skippedKeys.has(dedupeKey)) return
      skippedKeys.add(dedupeKey)
      skippedImageCount += 1
    }
    const addAsset = (sha256Input: string, image: JsonObject): boolean => {
      const sha256 = sha256Input.trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(sha256)) return false
      if (assets.has(sha256)) return true
      let blob: ReturnType<TransferPackDatabase['getAssetBlob']> = null
      try { blob = db.getAssetBlob(sha256) } catch { blob = null }
      let fallbackPath: string | undefined
      let sourcePath: string | undefined
      let bytes: Buffer | null = null
      if (blob) {
        try { bytes = db.readAssetBytes(sha256) } catch { bytes = null }
        if (bytes) sourcePath = blob.filePath
      }
      if (!bytes) {
        const encoded = text(image.base64).replace(/\s+/g, '')
        if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return false
        bytes = Buffer.from(encoded, 'base64')
        fallbackPath = join(fallbackDirectory, sha256)
        writeFileSync(fallbackPath, bytes)
      }
      const declaredMime = text(image.mimeType).trim() || text(blob?.mimeType).trim()
      const mimeType = normalizePackMime(declaredMime || detectMimeType(bytes))
      try {
        validateAssetBytes(sha256, mimeType, bytes)
      } catch {
        return false
      }
      assets.set(sha256, {
        sha256,
        mimeType,
        byteSize: bytes.byteLength,
        sourcePath,
        fallbackPath
      })
      return true
    }
    const rows = db.iterateExportRowsWithoutBinary?.(recordUids) ?? db.iterateExportRows(recordUids)
    for (const originalRow of rows) {
      const row = tokenizeLegacyImages(stripBinaryFields(originalRow))
      const images = Array.isArray(originalRow.images) ? originalRow.images : []
      const imageBySha = new Map<string, JsonObject>()
      const validImages: JsonObject[] = []
      const unavailableAssetShas = new Set<string>()
      const recordLabel = text(row.documentId) || text(row.title) || '未命名记录'
      for (const [imageIndex, input] of images.entries()) {
        const image = asObject(input)
        if (!image) continue
        const sha256 = imageSha256(image)
        const skipKey = sha256 ? `asset:${sha256}` : `source:${text(image.sourceUrl) || imageIndex}`
        if (text(image.state).trim().toLowerCase() !== 'ready') {
          if (sha256) unavailableAssetShas.add(sha256)
          noteSkipped(recordLabel, skipKey)
          continue
        }
        if (!addAsset(sha256, image)) {
          if (sha256) unavailableAssetShas.add(sha256)
          noteSkipped(recordLabel, skipKey)
          continue
        }
        unavailableAssetShas.delete(sha256)
        imageBySha.set(sha256, image)
        const strippedImages = stripBinaryFields({ images: [image] }).images
        const sanitized = asObject(Array.isArray(strippedImages) ? strippedImages[0] : null) ?? {}
        const { base64: _base64, dataUri: _dataUri, errorMessage: _errorMessage, ...metadata } = sanitized
        const asset = assets.get(sha256)
        if (!asset) continue
        const referenceId = safeImageReferenceId(
          metadata.id,
          `export-${sha256.slice(0, 16)}`
        )
        validImages.push({
          ...metadata,
          sha256,
          mimeType: asset.mimeType,
          byteSize: asset.byteSize,
          assetPath: `assets/${sha256}`,
          assetUrl: `visslm-asset://${sha256}/${referenceId}`,
          state: 'ready'
        })
      }
      const raw = asObject(row.raw)
      const resolveTokenForExport = (sha256Input: string, token: string): string => {
        const sha256 = validSha256(sha256Input)
        if (!sha256) return ''
        if (unavailableAssetShas.has(sha256)) {
          noteSkipped(recordLabel, `asset:${sha256}`)
          return ''
        }
        const candidate = imageBySha.get(sha256)
        let blob: ReturnType<TransferPackDatabase['getAssetBlob']> = null
        try { blob = db.getAssetBlob(sha256) } catch { blob = null }
        const image = {
          ...(candidate ?? {}),
          sha256,
          mimeType: text(candidate?.mimeType) || text(blob?.mimeType)
        }
        if (addAsset(sha256, image)) return token
        unavailableAssetShas.add(sha256)
        noteSkipped(recordLabel, `asset:${sha256}`)
        return ''
      }
      const rewriteExportString = (input: string): string => {
        let result = replaceRichTextSourcesForExport(input, (source) => {
          const parsed = parseAssetToken(source.source)
          if (parsed) return resolveTokenForExport(parsed.sha256, source.source)
          noteSkipped(recordLabel, `source:${source.source}`)
          return ''
        })
        // Collector-generated standalone tokens are valid even when they are
        // not nested in an <img>/<source> attribute.
        result = result.replace(assetTokenPattern, (token, sha256: string) =>
          resolveTokenForExport(sha256, token)
        )
        if (isStandaloneImageSource(result)) {
          noteSkipped(recordLabel, `source:${result}`)
          return '[图片未能导出]'
        }
        return result
      }
      const rewriteRaw = (input: unknown, fieldPath: string): unknown => {
        if (typeof input === 'string') return rewriteExportString(input)
        if (Array.isArray(input)) {
          return input.map((entry, index) => rewriteRaw(entry, `${fieldPath}[${index}]`))
        }
        if (input && typeof input === 'object') {
          return Object.fromEntries(Object.entries(input as JsonObject).map(([key, entry]) =>
            [key, rewriteRaw(entry, fieldPath ? `${fieldPath}.${key}` : key)]))
        }
        return input
      }
      const nextRaw = raw ? rewriteRaw(raw, '') as JsonObject : raw
      const sourceReferences = Array.isArray(row.imageReferences) ? row.imageReferences : []
      const validReferences = sourceReferences.flatMap((input, referenceIndex) => {
        const reference = asObject(input)
        if (!reference) {
          noteSkipped(recordLabel, `reference:${referenceIndex}`)
          return []
        }
        const sha256 = text(reference.assetSha256 || reference.sha256).trim().toLowerCase()
        if (!/^[a-f0-9]{64}$/.test(sha256) || !assets.has(sha256)) {
          noteSkipped(
            recordLabel,
            sha256 ? `asset:${sha256}` : `source:${text(reference.originalSource) || referenceIndex}`
          )
          return []
        }
        const sanitized = stripImageDataUris(reference) as JsonObject
        return [{ ...sanitized, assetSha256: sha256 }]
      })
      let exportRow: JsonObject = {
        ...row,
        images: validImages,
        imageReferences: validReferences,
        ...(nextRaw ? { raw: nextRaw } : {})
      }
      if (containsImageDataUri(exportRow)) {
        noteSkipped(recordLabel, 'source:embedded-data-uri')
        exportRow = stripImageDataUris(exportRow) as JsonObject
      }
      const line = Buffer.from(`${JSON.stringify(exportRow)}\n`, 'utf8')
      recordHash.update(line)
      recordBytes += line.byteLength
      recordCount += 1
      recordsEntry.push(line)
    }
    recordsEntry.push(new Uint8Array(0), true)
    checksums.push({ path: 'records.jsonl', sha256: recordHash.digest('hex'), byteSize: recordBytes })

    let assetBytes = 0
    for (const [sha256, asset] of assets) {
      const assetPath = asset.sourcePath || asset.fallbackPath
      if (!assetPath) throw new Error(`图片资源 ${sha256.slice(0, 12)}… 没有文件路径`)
      const digest = await streamZipFile(zip, `assets/${sha256}`, assetPath, false, asset.mimeType)
      if (digest.sha256 !== sha256) throw new Error(`图片资源 ${sha256.slice(0, 12)}… 校验失败`)
      assetBytes += digest.byteSize
      if (assetBytes > MAX_PACK_BYTES) throw new Error('资源包未压缩资源超过 1 GB 限制')
      checksums.push({ path: `assets/${sha256}`, sha256, byteSize: digest.byteSize })
    }
    const manifest: PackManifest = {
      format: PACK_FORMAT,
      version: PACK_VERSION,
      createdAt: new Date().toISOString(),
      recordCount,
      assetCount: assets.size,
      assetBytes,
      entries: { records: 'records.jsonl', assets: 'assets/', checksums: 'checksums.jsonl' }
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex')
    checksums.push({ path: 'manifest.json', sha256: manifestDigest, byteSize: manifestBytes.byteLength })
    const manifestEntry = new ZipDeflate('manifest.json', { level: 6 })
    zip.add(manifestEntry)
    manifestEntry.push(manifestBytes, true)
    const checksumBytes = Buffer.from(checksums.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8')
    if (recordBytes + assetBytes + manifestBytes.byteLength + checksumBytes.byteLength > MAX_PACK_BYTES) {
      throw new Error('资源包未压缩体积超过 1 GB 限制')
    }
    const checksumEntry = new ZipDeflate('checksums.jsonl', { level: 6 })
    zip.add(checksumEntry)
    checksumEntry.push(checksumBytes, true)
    zip.end()
    if (zipError) throw zipError
    if (fd !== undefined) {
      closeSync(fd)
      fd = undefined
    }
    const totalBytes = statSync(temporaryPath).size
    if (totalBytes > MAX_PACK_BYTES) throw new Error('资源包超过 1 GB 限制')
    try { unlinkSync(targetPath) } catch {}
    renameSync(temporaryPath, targetPath)
    return {
      ok: true,
      path: targetPath,
      recordCount,
      message: `已导出 ${recordCount} 条数据和 ${assets.size} 个二进制资源${skippedImageCount ? `，跳过 ${skippedImageCount} 张图片（本地尚无可用图片文件，请重新采集后再导出）` : ''}`,
      format: 'visslmpack',
      packVersion: PACK_VERSION,
      assetCount: assets.size,
      assetBytes
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temporaryPath) } catch {}
    throw error
  } finally {
    try { requireRemoveDirectory(fallbackDirectory) } catch {}
  }
}

const requireRemoveDirectory = (path: string): void => {
  rmSync(path, { recursive: true, force: true })
}

const extractPack = async (filePath: string, stagingDirectory: string): Promise<Map<string, string>> => {
  const entries = new Map<string, string>()
  const seen = new Set<string>()
  let entryCount = 0
  let totalBytes = 0
  let extractionError: Error | undefined
  const unzip = new Unzip((file) => {
    try {
      const name = safeEntryName(file.name)
      if (seen.has(name)) throw new Error(`资源包存在重复条目：${name}`)
      if (++entryCount > MAX_ENTRY_COUNT) throw new Error('资源包条目数量超过安全上限')
      const outputPath = join(stagingDirectory, ...name.split('/'))
      const resolvedRoot = `${stagingDirectory}${sep}`
      if (!outputPath.startsWith(resolvedRoot)) throw new Error(`资源包条目路径越界：${name}`)
      mkdirSync(dirname(outputPath), { recursive: true })
      const outputFd = openSync(outputPath, 'w')
      let entryBytes = 0
      file.ondata = (error, chunk, final) => {
        if (error) {
          extractionError = new Error(String(error))
          try { closeSync(outputFd) } catch {}
          return
        }
        entryBytes += chunk.byteLength
        totalBytes += chunk.byteLength
        if (totalBytes > MAX_PACK_BYTES) {
          extractionError = new Error('资源包解压后的体积超过 1 GB 限制')
          try { file.terminate() } catch {}
          try { closeSync(outputFd) } catch {}
          return
        }
        writeAll(outputFd, chunk)
        if (final) {
          closeSync(outputFd)
          entries.set(name, outputPath)
        }
      }
      file.start()
    } catch (error) {
      extractionError = error instanceof Error ? error : new Error(String(error))
    }
  })
  unzip.register(UnzipInflate)
  try {
    for await (const chunk of createReadStream(filePath)) {
      if (extractionError) break
      unzip.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), false)
    }
    if (!extractionError) unzip.push(new Uint8Array(0), true)
  } catch (error) {
    extractionError = error instanceof Error ? error : new Error(String(error))
  }
  if (extractionError) throw extractionError
  return entries
}

const readJsonFile = (filePath: string): unknown => JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))

const hashAndValidate = async (
  entries: Map<string, string>,
  checksumsPath: string
): Promise<Map<string, PackChecksum>> => {
  const checksums = readFileSync(checksumsPath, 'utf8').split(/\r?\n/).filter(Boolean)
  const verified = new Map<string, PackChecksum>()
  for (const line of checksums) {
    const item = asObject(JSON.parse(line))
    if (!item) throw new Error('checksums.jsonl 条目无效')
    const name = safeEntryName(text(item.path))
    if (name === 'checksums.jsonl') throw new Error('checksums.jsonl 不能自校验')
    if (verified.has(name)) throw new Error(`资源包校验条目重复：${name}`)
    const sha256 = text(item.sha256).trim().toLowerCase()
    const byteSize = Number(item.byteSize)
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new Error(`资源包校验条目无效：${name}`)
    }
    const path = entries.get(name)
    if (!path) throw new Error(`资源包缺少校验条目对应文件：${name}`)
    const actual = await digestFile(path)
    if (actual.sha256 !== sha256 || actual.byteSize !== byteSize) {
      throw new Error(`资源包校验失败：${name}`)
    }
    verified.set(name, { path: name, sha256, byteSize })
  }
  for (const name of entries.keys()) {
    if (name === 'checksums.jsonl') continue
    if (!verified.has(name)) throw new Error(`资源包缺少文件校验条目：${name}`)
  }
  return verified
}

const assertPackEntries = (entries: Map<string, string>): void => {
  for (const name of entries.keys()) {
    if (name === 'manifest.json' || name === 'records.jsonl' || name === 'checksums.jsonl') continue
    const match = /^assets\/([a-f0-9]{64})$/i.exec(name)
    if (!match) throw new Error(`资源包包含未声明条目：${name}`)
  }
}

export async function importVisslmPack(
  db: TransferPackDatabase,
  filePath: string
): Promise<DataImportResult> {
  const stats = statSync(filePath)
  if (!stats.isFile() || stats.size > MAX_PACK_BYTES) throw new Error('资源包不能超过 1 GB')
  const stagingDirectory = join(tmpdir(), `visslm-pack-import-${randomUUID()}`)
  mkdirSync(stagingDirectory, { recursive: true })
  try {
    const entries = await extractPack(filePath, stagingDirectory)
    const manifestPath = entries.get('manifest.json')
    const recordsPath = entries.get('records.jsonl')
    const checksumsPath = entries.get('checksums.jsonl')
    if (!manifestPath || !recordsPath || !checksumsPath) throw new Error('资源包缺少必要文件')
    const manifest = asObject(readJsonFile(manifestPath)) as Partial<PackManifest> | null
    if (!manifest || manifest.format !== PACK_FORMAT || Number(manifest.version) !== PACK_VERSION) {
      throw new Error('资源包格式或版本不受支持')
    }
    assertPackEntries(entries)
    const verified = await hashAndValidate(entries, checksumsPath)
    const assetEntries = [...entries.keys()].filter((name) => /^assets\/[a-f0-9]{64}$/i.test(name))
    const manifestRecordCount = Number(manifest.recordCount)
    const manifestAssetCount = Number(manifest.assetCount)
    const manifestAssetBytes = Number(manifest.assetBytes)
    if (!Number.isSafeInteger(manifestRecordCount) || manifestRecordCount < 0 ||
      !Number.isSafeInteger(manifestAssetCount) || manifestAssetCount < 0 ||
      !Number.isSafeInteger(manifestAssetBytes) || manifestAssetBytes < 0) {
      throw new Error('资源包 manifest 统计字段无效')
    }
    if (manifestAssetCount !== assetEntries.length || manifestAssetCount > MAX_ENTRY_COUNT) {
      throw new Error('资源包资源数量与 manifest 不一致')
    }
    const actualAssetBytes = assetEntries.reduce((sum, name) => sum + (verified.get(name)?.byteSize ?? 0), 0)
    if (actualAssetBytes !== manifestAssetBytes || actualAssetBytes > MAX_PACK_BYTES) {
      throw new Error('资源包资源字节数与 manifest 不一致')
    }
    const preparedRows: unknown[] = []
    const referencedAssets = new Set<string>()
    const validatedAssets = new Set<string>()
    const assetMimeTypes = new Map<string, string>()
    const ensureImportedAsset = (
      sha256Input: string,
      preferredMime: string,
      context: string
    ): { assetPath: string; mimeType: string } => {
      const sha256 = validSha256(sha256Input)
      if (!sha256) throw new Error(`${context} 图片资源 SHA-256 无效：${sha256Input}`)
      const assetPath = `assets/${sha256}`
      const stagedAsset = entries.get(assetPath)
      if (!stagedAsset) throw new Error(`${context} 引用了缺失图片资源：${sha256}`)
      referencedAssets.add(assetPath)
      const rawAssetBytes = readFileSync(stagedAsset)
      const detectedMime = detectMimeType(rawAssetBytes)
      const declaredMime = normalizePackMime(preferredMime)
      const mimeType = declaredMime.startsWith('image/') ? declaredMime : detectedMime
      assetMimeTypes.set(sha256, assetMimeTypes.get(sha256) || mimeType)
      if (!validatedAssets.has(sha256)) {
        validateAssetBytes(sha256, mimeType, rawAssetBytes)
        validatedAssets.add(sha256)
      }
      return { assetPath, mimeType: assetMimeTypes.get(sha256) || mimeType }
    }
    const reader = createInterface({ input: createReadStream(recordsPath), crlfDelay: Infinity })
    let lineNumber = 0
    for await (const line of reader) {
      lineNumber += 1
      if (!line.trim()) continue
      const row = asObject(JSON.parse(line))
      if (!row) throw new Error(`records.jsonl 第 ${lineNumber} 行不是对象`)
      const images = Array.isArray(row.images) ? row.images : []
      const convertedImages = images.map((input) => {
        const image = asObject(input)
        if (!image) return input
        const sha256 = validSha256(image.sha256)
        if (!/^[a-f0-9]{64}$/.test(sha256)) return image
        const assetPath = safeEntryName(text(image.assetPath) || `assets/${sha256}`)
        if (assetPath !== `assets/${sha256}`) throw new Error(`图片资源路径与 SHA 不一致：${sha256}`)
        const importedAsset = ensureImportedAsset(sha256, text(image.mimeType), `记录第 ${lineNumber} 行`)
        const existingToken = parseAssetToken(text(image.assetUrl))
        return {
          ...image,
          mimeType: importedAsset.mimeType,
          assetUrl: existingToken?.sha256 === sha256
            ? text(image.assetUrl)
            : `visslm-asset://${sha256}/import-${sha256.slice(0, 16)}`
        }
      })
      const raw = asObject(row.raw)
      const validateRawImages = (input: unknown, fieldPath = ''): void => {
        if (typeof input === 'string') {
          for (const match of input.matchAll(assetTokenPattern)) {
            const parsed = parseAssetToken(match[0])
            if (!parsed) continue
            const importedAsset = ensureImportedAsset(parsed.sha256, '', `records.jsonl 第 ${lineNumber} 行`)
            if (!convertedImages.some((candidate) =>
              validSha256(asObject(candidate)?.sha256) === parsed.sha256 ||
              parseAssetToken(text(asObject(candidate)?.assetUrl))?.sha256 === parsed.sha256
            )) {
              const verifiedAsset = verified.get(importedAsset.assetPath)
              convertedImages.push({
                id: parsed.referenceId,
                name: '',
                mimeType: importedAsset.mimeType,
                sourceUrl: 'imported:asset',
                sha256: parsed.sha256,
                byteSize: verifiedAsset?.byteSize ?? 0,
                assetUrl: match[0]
              })
            }
          }
          for (const source of findRichTextImageSources(input)) {
            if (!parseAssetToken(source.source) && fieldPath === '_valm_Description') {
              throw new Error(`records.jsonl 第 ${lineNumber} 行含未令牌化图片`)
            }
          }
          if (isStandaloneImageSource(input) && fieldPath === '_valm_Description') {
            throw new Error(`records.jsonl 第 ${lineNumber} 行含未令牌化图片`)
          }
          return
        }
        if (Array.isArray(input)) {
          input.forEach((entry, index) => validateRawImages(entry, `${fieldPath}[${index}]`))
          return
        }
        if (input && typeof input === 'object') {
          Object.entries(input as JsonObject).forEach(([key, entry]) =>
            validateRawImages(entry, fieldPath ? `${fieldPath}.${key}` : key))
        }
      }
      validateRawImages(raw)
      preparedRows.push({ ...row, images: convertedImages })
    }
    if (lineNumber !== manifestRecordCount) {
      throw new Error('资源包记录数与 manifest 不一致')
    }
    for (const assetPath of assetEntries) {
      if (!referencedAssets.has(assetPath)) throw new Error(`资源包包含未声明资源：${assetPath}`)
    }

    const savedHashes: string[] = []
    try {
      for (const assetPath of assetEntries) {
        const sha256 = assetPath.slice('assets/'.length)
        const bytes = readFileSync(entries.get(assetPath) as string)
        const existing = db.getAssetBlob(sha256)
        if (!existing && db.saveAssetBlob) {
          const mimeType = assetMimeTypes.get(sha256) || 'application/octet-stream'
          db.saveAssetBlob({ sha256, mimeType, bytes })
          savedHashes.push(sha256)
        }
      }
      const apply = (): DataImportResult[] => preparedRows.map((row) => {
        if (!db.saveAssetBlob) {
          const object = asObject(row)
          const images = Array.isArray(object?.images) ? object.images.map((input) => {
            const image = asObject(input)
            if (!image) return input
            const sha256 = text(image.sha256).toLowerCase()
            const path = entries.get(`assets/${sha256}`)
            return path ? { ...image, base64: readFileSync(path).toString('base64') } : image
          }) : []
          return db.importRows([{ ...object, images }])
        }
        return db.importRows([row])
      })
      const results = db.runInTransaction ? db.runInTransaction(apply) : apply()
      const result = mergeImportResults(results)
      if (result.errors.length) throw new Error(result.errors[0])
      result.assetCount = manifestAssetCount
      result.assetBytes = manifestAssetBytes
      result.format = 'visslmpack'
      result.packVersion = PACK_VERSION
      result.checksumVerified = true
      for (const sha256 of savedHashes) {
        try { db.removeAssetBlob?.(sha256) } catch { /* best effort */ }
      }
      return result
    } catch (error) {
      for (const sha256 of savedHashes) {
        try { db.removeAssetBlob?.(sha256) } catch { /* best effort */ }
      }
      throw error
    }
  } finally {
    requireRemoveDirectory(stagingDirectory)
  }
}
