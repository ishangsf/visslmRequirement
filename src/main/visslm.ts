import { createHash, randomBytes } from 'node:crypto'
import type {
  ConnectionResult,
  DataReviewApplyResult,
  FieldDefinition,
  FieldDefinitionNormalizedType,
  PushConfig,
  PushRequestTrace,
  PushResult,
  SyncFieldFilter,
  SyncPreviewResult,
  SyncProgress,
  SyncResult,
  SyncScopeConfig
} from '../shared/types'
import {
  pushForbiddenSourceFields,
  pushForbiddenTargetFields
} from '../shared/push-field-mapping'
import { AppDatabase, type RecordInput } from './database'
import {
  findRichTextImageSources,
  parseAssetToken,
  replaceRichTextImageSources
} from './rich-text-assets'

type JsonObject = Record<string, unknown>

interface AlmResponse {
  ErrorCode?: number | string
  ErrorMessage?: string | null
  ErrorMsg?: string | null
  Data?: unknown
  props?: JsonObject
  prop?: JsonObject
  propList?: JsonObject[]
}

interface Credentials {
  baseUrl: string
  username: string
  token: string
  uploadPassword?: string
  userPropertyKeys?: string[]
}

interface PostJsonResult {
  data: AlmResponse | unknown
  httpStatus: number
}

class VisslmRequestError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly response?: unknown
  ) {
    super(message)
    this.name = 'VisslmRequestError'
  }
}

/** A GET that was expected to be JSON returned a page or another text body. */
class VisslmInvalidJsonResponseError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly loginPage: boolean
  ) {
    super(message)
    this.name = 'VisslmInvalidJsonResponseError'
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const SAFE_REQUEST_MAX_ATTEMPTS = 3
const SAFE_REQUEST_BACKOFF_MS = [200, 500]
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

const isRetryableNetworkError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  // undici uses TypeError for connection failures and TimeoutError/AbortError
  // for AbortSignal.timeout().  These are safe to retry for GET/downloads,
  // but never for the non-idempotent POST endpoints below.
  return error.name === 'TypeError' || error.name === 'TimeoutError' || error.name === 'AbortError'
}

const retryAfterDelayMs = (response: Response): number | undefined => {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(10_000, Math.round(seconds * 1_000))
  }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(10_000, Math.max(0, timestamp - Date.now()))
}

class AssetPreparationError extends Error {
  constructor(
    message: string,
    readonly stats: {
      imageTotal: number
      imageUpload: number
      imageReuse: number
      imageFailed: number
      imageErrors?: string[]
    }
  ) {
    super(message)
    this.name = 'AssetPreparationError'
  }
}

const value = (obj: JsonObject, key: string): string =>
  obj[key] === undefined || obj[key] === null ? '' : String(obj[key])

const stripHtml = (text: string): string =>
  text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()

const fieldPathLabel = (path: string, fieldLabels: Record<string, string>): string => {
  const direct = fieldLabels[path]?.trim()
  if (direct) return direct
  const withoutIndexes = path.replace(/\[\d+\]/g, '')
  const indexed = fieldLabels[withoutIndexes]?.trim()
  if (indexed) return indexed
  return path.split('.').map((segment) => {
    const match = /^(.*?)(\[\d+\])+$/.exec(segment)
    const field = match?.[1] ?? segment
    const suffix = match ? segment.slice(field.length) : ''
    return `${fieldLabels[field]?.trim() || field}${suffix}`
  }).join('.')
}

export const normalizeText = (
  raw: JsonObject,
  fieldLabels: Record<string, string> = {}
): string => {
  const parts: string[] = []
  const visit = (input: unknown, path = ''): void => {
    if (input === null || input === undefined) return
    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      const text = stripHtml(String(input))
      if (text && !text.startsWith('data:image/') && text.length < 100_000) {
        parts.push(path ? `${fieldPathLabel(path, fieldLabels)}: ${text}` : text)
      }
      return
    }
    if (Array.isArray(input)) {
      input.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (typeof input === 'object') {
      for (const [key, val] of Object.entries(input as JsonObject)) {
        visit(val, path ? `${path}.${key}` : key)
      }
    }
  }
  visit(raw)
  return parts.join('\n')
}

const imageExtension = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i
const MAX_JPEG_TRAILING_BYTES = 64 * 1024

const richImageMimeExtensions: Readonly<Record<string, string>> = {
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/gif': '.gif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/tiff': '.tif',
  'image/webp': '.webp',
  'image/x-icon': '.ico'
}

const normalizeRichImageMimeType = (input: string): string => {
  const candidate = input.trim().toLowerCase().split(';', 1)[0] || 'application/octet-stream'
  // A few older VISSLM deployments report image/jpg.  Keep the original
  // extension mapping below, but send the standards spelling in the part
  // headers so multipart parsers do not reject the upload.
  return candidate === 'image/jpg' ? 'image/jpeg' : candidate
}

const normalizeRichImageFileName = (input: string, mimeType: string): string => {
  const extension = richImageMimeExtensions[mimeType] ?? ''
  let name = input
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
    .trim()
  if (!name || name === '.' || name === '..') name = 'image'
  // Rich-text references collected from HTML use the generic label
  // “富文本图片”, which has no suffix.  Old multipart handlers often infer
  // the stored file type from the filename, so append a MIME-compatible
  // suffix when the caller did not provide one.
  if (extension && !/\.[A-Za-z0-9]{1,12}$/.test(name)) name += extension
  if (name.length <= 180) return name
  const suffix = extension && name.toLocaleLowerCase().endsWith(extension)
    ? extension
    : ''
  const stemLength = Math.max(1, 180 - suffix.length)
  return `${name.slice(0, stemLength)}${suffix}`
}

const imageBytesMatchMime = (mimeType: string, bytes: Buffer): boolean => {
  const mime = mimeType.trim().toLowerCase()
  if (!bytes.byteLength) return false
  if (!mime.startsWith('image/')) return false
  if (mime === 'image/png') {
    return bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      bytes.subarray(bytes.length - 8, bytes.length - 4).equals(Buffer.from('IEND', 'ascii'))
  }
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    if (bytes.length < 5 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return false
    const eoi = bytes.lastIndexOf(Buffer.from([0xff, 0xd9]))
    if (eoi < 3) return false
    return bytes.length - (eoi + 2) <= MAX_JPEG_TRAILING_BYTES
  }
  if (mime === 'image/gif') {
    return bytes.length >= 7 &&
      (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a') &&
      bytes[bytes.length - 1] === 0x3b
  }
  if (mime === 'image/webp') {
    if (bytes.length < 12 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
      bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return false
    const declaredLength = bytes.readUInt32LE(4)
    return declaredLength >= 4 && declaredLength <= bytes.length - 8
  }
  if (mime === 'image/bmp') {
    if (bytes.length < 14 || bytes.subarray(0, 2).toString('ascii') !== 'BM') return false
    const declaredLength = bytes.readUInt32LE(2)
    return declaredLength >= 14 && declaredLength <= bytes.length
  }
  if (mime === 'image/svg+xml') {
    const text = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString('utf8')
    return /^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(text) && /<\/svg\s*>/i.test(text)
  }
  return true
}

const redactUrlForError = (input: string | URL): string => {
  try {
    const safe = new URL(input.toString())
    safe.username = ''
    safe.password = ''
    safe.hash = ''
    for (const key of [...safe.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|cookie|auth|credential|key)/i.test(key)) {
        safe.searchParams.delete(key)
      }
    }
    return safe.toString()
  } catch {
    return '[已脱敏 URL]'
  }
}

const imagePayloadDiagnostic = (input: {
  reason: string
  httpStatus: number
  contentType: string
  bytes: Buffer
  url: string | URL
}): string => {
  const preview = input.bytes.subarray(0, 16).toString('hex') || '（空）'
  return `${input.reason}；HTTP ${input.httpStatus}；Content-Type ${input.contentType || '未知'}；字节数 ${input.bytes.byteLength}；前16字节 hex ${preview}；URL ${redactUrlForError(input.url)}`
}

const sanitizeImageErrorMessage = (message: string): string => message
  .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrlForError(url))
  .replace(/((?:api)?token|secret|password|passwd|cookie|authorization)=([^\s&]+)/gi, '$1=[已脱敏]')
  .slice(0, 1_000)

const ITEM_BASE_PROPERTIES = [
  '_valm_Uid',
  '_valm_ParentId',
  '_valm_Name',
  '_valm_ItemID',
  '_valm_NodeType',
  '_valm_LastModifyTime',
  '_valm_Description'
]

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_.]*$/
const pureNumericPattern = /^\d+$/
const DISPLAY_LOOKUP_CONCURRENCY = 8

/**
 * Run asynchronous work in a bounded number of workers while preserving the
 * input order.  Workers keep draining after an individual mapper failure so
 * the bounded version retains Promise.all's side-effect/error semantics: all
 * scheduled items are allowed to settle and the first observed error is
 * re-thrown afterwards.
 */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency = DISPLAY_LOOKUP_CONCURRENCY
): Promise<R[]> => {
  if (!items.length) return []
  const results = new Array<R>(items.length)
  const workerCount = Math.min(
    items.length,
    Math.max(1, Math.floor(concurrency))
  )
  let nextIndex = 0
  let failed = false
  let firstError: unknown

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (failed) throw firstError
  return results
}

/** Shared cap for display-value lookups made while syncing large datasets. */
class AsyncTaskLimiter {
  private active = 0
  private readonly pending: Array<{
    task: () => Promise<unknown> | unknown
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }> = []

  constructor(private readonly maxConcurrency: number) {}

  run<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        task,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.drain()
    })
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.pending.length) {
      const entry = this.pending.shift()!
      this.active += 1
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1
          this.drain()
        })
    }
  }
}

const FIELD_KEY_KEYS = [
  '_valm_MemberName',
  '_valm_FieldName',
  '_valm_PropertyName',
  '_valm_AttributeName',
  '_valm_Key',
  'memberName',
  'fieldName',
  'propertyName',
  'attributeName',
  'key',
  'field',
  'property',
  'attribute',
  'name',
  '_valm_Name'
]

const FIELD_DISPLAY_KEYS = [
  '_valm_DisplayName',
  '_valm_MemberDisplayName',
  '_valm_DisplayText',
  '_valm_MemberCaption',
  '_valm_Caption',
  '_valm_Label',
  '_valm_Title',
  '_valm_Description',
  'displayName',
  'display_name',
  'displayText',
  'label',
  'caption',
  'title',
  'description',
  'text'
]

const FIELD_NODE_TYPE_KEYS = ['_valm_NodeType', 'nodeType', 'node_type', 'NodeType']

const FIELD_COLLECTION_KEYS = new Set([
  'data',
  'props',
  'prop',
  'proplist',
  'fields',
  'members',
  'properties',
  'attributes',
  'items',
  'rows'
])

const readTextCandidate = (object: JsonObject, keys: string[]): string => {
  for (const key of keys) {
    const current = object[key]
    if (typeof current !== 'string' && typeof current !== 'number') continue
    const text = String(current).trim()
    if (text) return text
  }
  return ''
}

const readCaseInsensitiveValue = (object: JsonObject, key: string): unknown => {
  if (Object.prototype.hasOwnProperty.call(object, key)) return object[key]
  const normalizedKey = key.toLocaleLowerCase()
  const actualKey = Object.keys(object).find((candidate) =>
    candidate.toLocaleLowerCase() === normalizedKey
  )
  return actualKey === undefined ? undefined : object[actualKey]
}

const hasCaseInsensitiveKey = (object: JsonObject, key: string): boolean => {
  const normalizedKey = key.toLocaleLowerCase()
  return Object.keys(object).some((candidate) => candidate.toLocaleLowerCase() === normalizedKey)
}

const readFieldDefinitionText = (object: JsonObject, key: string): string => {
  const current = readCaseInsensitiveValue(object, key)
  if (typeof current !== 'string' && typeof current !== 'number') return ''
  return String(current).trim()
}

const readFieldDefinitionBoolean = (input: unknown): boolean => {
  if (typeof input === 'boolean') return input
  if (typeof input === 'number') return Number.isFinite(input) && input !== 0
  if (typeof input !== 'string') return false
  const normalized = input.trim().toLocaleLowerCase()
  return ['true', '1', 'yes', 'y', 'on', 't', '是', '真'].includes(normalized)
}

const fieldDefinitionTypeMap: Readonly<Record<string, FieldDefinitionNormalizedType>> = {
  SINGLELINETEXT: 'string',
  MULTILINETEXT: 'string',
  RICH: 'rich_text',
  LOG: 'log',
  INTEGER: 'integer',
  FLOAT: 'number',
  BOOL: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  DATAENUM: 'enum',
  SYSTEMENUM: 'system_enum',
  REFERENCE: 'reference',
  RELATION: 'relation',
  URL: 'url',
  SPECIALTYPE: 'special'
}

export const normalizeFieldDefinitionType = (
  sourceType: unknown
): FieldDefinitionNormalizedType => {
  const normalized = String(sourceType ?? '').trim().toLocaleUpperCase()
  return fieldDefinitionTypeMap[normalized] ?? 'unknown'
}

const parseJsonPayload = (input: unknown): unknown => {
  let current = input
  for (let attempt = 0; attempt < 2 && typeof current === 'string'; attempt += 1) {
    const text = current.trim()
    if (!text || !['{', '['].includes(text[0])) break
    try {
      current = JSON.parse(text) as unknown
    } catch {
      break
    }
  }
  return current
}

const createdUidKeys = ['_valm_Uid', '_valm_UID', 'uid', 'Uid', 'UID'] as const
const createdUidContainerKeys = [
  'Data',
  'data',
  'Item',
  'item',
  'Result',
  'result',
  'propList',
  'PropList',
  'props',
  'Props',
  'prop',
  'Prop'
] as const

/**
 * POST /rest/items has returned both propList/props and nested Data payloads
 * across platform versions.  Read only known UID keys and response containers
 * so an unrelated id from a status object cannot be mistaken for the created
 * item UID.
 */
const extractCreatedItemUid = (input: unknown): string => {
  const queue: Array<{ value: unknown; depth: number }> = [{ value: parseJsonPayload(input), depth: 0 }]
  const visited = new Set<unknown>()
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 4 || visited.has(current.value)) continue
    visited.add(current.value)
    if (Array.isArray(current.value)) {
      current.value.forEach((item) => queue.push({ value: parseJsonPayload(item), depth: current.depth + 1 }))
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    const object = current.value as JsonObject
    for (const key of createdUidKeys) {
      const candidate = object[key]
      if (typeof candidate !== 'string' && typeof candidate !== 'number') continue
      const uid = String(candidate).trim()
      if (uid) return uid
    }
    if (current.depth >= 4) continue
    for (const key of createdUidContainerKeys) {
      if (!Object.prototype.hasOwnProperty.call(object, key)) continue
      const nested = parseJsonPayload(object[key])
      if (nested !== undefined && nested !== object[key]) {
        queue.push({ value: nested, depth: current.depth + 1 })
      } else if (nested && typeof nested === 'object') {
        queue.push({ value: nested, depth: current.depth + 1 })
      }
    }
  }
  return ''
}

const describeInvalidJsonResponse = (response: Response, body: string): string => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim()
  const normalizedBody = body.trimStart()
  const isHtml = /^<(?:!doctype\s+html|html|head|body|script)\b/i.test(normalizedBody)
  const responseKind = isHtml ? 'HTML 页面' : '无效 JSON'
  const contentHint = contentType ? `，Content-Type 为 ${contentType}` : ''
  return `VISSLM 返回${responseKind}而不是 JSON（HTTP ${response.status}${contentHint}）。请检查接口地址、登录状态或接口权限`
}

const decodeJavaScriptString = (input: string): string | null => {
  let output = ''
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index]
    if (current !== '\\') {
      if (/[\u0000-\u001f\u007f]/.test(current)) return null
      output += current
      continue
    }
    if (index + 1 >= input.length) return null
    const escaped = input[++index]
    const simple: Record<string, string> = {
      n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v',
      '0': '\0', '\\': '\\', '/': '/', "'": "'", '"': '"'
    }
    if (simple[escaped] !== undefined) {
      output += simple[escaped]
      continue
    }
    if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(input.slice(index + 1, index + 3))) {
      output += String.fromCharCode(Number.parseInt(input.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }
    if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(input.slice(index + 1, index + 5))) {
      output += String.fromCharCode(Number.parseInt(input.slice(index + 1, index + 5), 16))
      index += 4
      continue
    }
    // A line continuation is legal JavaScript but not useful in a URL.  Keep
    // the parser strict so arbitrary callback code cannot be interpreted.
    return null
  }
  return output
}

const richImageCallbackPattern = /(?:\bwindow\s*\.\s*)?(?:parent\s*\.\s*)?CKEDITOR\s*\.\s*tools\s*\.\s*callFunction\s*\(/gi

const safeRichImageContentType = (response: Response): string => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || ''
  // Content-Type is a server-controlled value.  Keep it to a MIME-shaped
  // token so an error response cannot inject arbitrary text into the log.
  return /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+$/.test(contentType)
    ? contentType.slice(0, 100)
    : '未知'
}

const isRichImageLoginResponse = (body: string): boolean => {
  const sample = body.slice(0, 128 * 1024)
  if (!sample) return false
  if (/\/(?:logon|login)(?:[/?#"'\s]|$)/i.test(sample)) return true
  const looksLikeHtml = /<(?:!doctype\s+html|html|head|body|form)\b/i.test(sample)
  if (!looksLikeHtml) return false
  return /(?:\blogon\b|\blogin\b|登录)/i.test(sample)
}

const classifyRichImageUploadResponse = (body: string, contentType: string): string => {
  const normalized = body.trimStart()
  if (!normalized) return '空响应'
  if (isRichImageLoginResponse(body)) return '登录页/LogOn'
  if (/json/i.test(contentType) || /^[{[]/.test(normalized)) return 'JSON'
  if (/^<(?:!doctype\s+html|html|head|body|script)\b/i.test(normalized)) return 'HTML'
  if (richImageCallbackPattern.test(body)) {
    richImageCallbackPattern.lastIndex = 0
    return 'CKEditor 回调'
  }
  richImageCallbackPattern.lastIndex = 0
  return '其他文本'
}

const richImageUploadDiagnostic = (input: {
  reason: string
  response: Response
  body: string
}): string => {
  const contentType = safeRichImageContentType(input.response)
  const format = classifyRichImageUploadResponse(input.body, contentType)
  const length = Buffer.byteLength(input.body, 'utf8')
  return `${input.reason}（HTTP ${input.response.status}；Content-Type ${contentType}；响应长度 ${length} 字节；响应格式 ${format}）`
}

const normalizeRichImagePath = (input: string): string | null => {
  const path = input.trim()
  if (!path || path.length > 8_192) return null
  if (/[\u0000-\u001f\u007f\\]/.test(path) || path.includes('#')) return null
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return null

  const queryIndex = path.indexOf('?')
  const rawPath = queryIndex >= 0 ? path.slice(0, queryIndex) : path
  const rawQuery = queryIndex >= 0 ? path.slice(queryIndex + 1) : ''
  if (!rawPath || rawQuery.length > 4_096) return null

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(rawPath)
    // Validate percent escapes in the query without changing the value that
    // will be written into the rich text.
    decodeURIComponent(rawQuery)
  } catch {
    return null
  }
  if (
    !decodedPath ||
    /[\u0000-\u001f\u007f\\\s?#]/.test(decodedPath) ||
    /[\u0000-\u001f\u007f\\]/.test(decodeURIComponent(rawQuery)) ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(decodedPath) ||
    decodedPath.startsWith('//')
  ) return null

  const pathWithoutLeadingSlash = decodedPath.startsWith('/')
    ? decodedPath.slice(1)
    : decodedPath
  const segments = pathWithoutLeadingSlash.split('/')
  if (segments.some((segment) => segment === '..' || !segment)) return null
  const resourceIndex = segments.findIndex((segment, index) =>
    segment.toLocaleLowerCase() === 'filecenterimg' &&
    segments[index + 1]?.toLocaleLowerCase() === 'index'
  )
  if (resourceIndex < 0 || resourceIndex + 2 >= segments.length) return null
  if (segments.slice(resourceIndex + 2).some((segment) => segment === '..' || !segment)) return null

  // Preserve the server-provided spelling and query string, while keeping the
  // historical relative-path return shape used by rich-text replacement.
  return `${rawPath.replace(/^\/+/, '')}${queryIndex >= 0 ? `?${rawQuery}` : ''}`
}

const richImageUploadMarkerIsSuccess = (input: unknown): boolean => {
  if (input === undefined) return true
  if (input === true) return true
  if (typeof input === 'number') return input === 1
  if (typeof input !== 'string') return false
  return ['1', 'true', 'ok', 'success'].includes(input.trim().toLocaleLowerCase())
}

const richImageErrorCodeIsSuccess = (input: unknown): boolean => {
  if (typeof input === 'number') return input === 0
  if (typeof input !== 'string') return false
  return ['0', 'ok', 'success'].includes(input.trim().toLocaleLowerCase())
}

const parseRichImageUploadJson = (body: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.trim()) as unknown
  } catch {
    return null
  }

  const queue: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }]
  const visited = new Set<unknown>()
  while (queue.length) {
    const current = queue.shift()!
    if (current.depth > 3 || visited.has(current.value)) continue
    visited.add(current.value)
    if (Array.isArray(current.value)) {
      current.value.forEach((item) => queue.push({ value: item, depth: current.depth + 1 }))
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    const object = current.value as JsonObject
    const hasErrorCode = Object.prototype.hasOwnProperty.call(object, 'ErrorCode') ||
      Object.prototype.hasOwnProperty.call(object, 'errorCode')
    const errorCode = object.ErrorCode ?? object.errorCode
    if (hasErrorCode && !richImageErrorCodeIsSuccess(errorCode)) continue
    const hasSuccess = Object.prototype.hasOwnProperty.call(object, 'success') ||
      Object.prototype.hasOwnProperty.call(object, 'Success')
    const success = object.success ?? object.Success
    if (hasSuccess && !richImageUploadMarkerIsSuccess(success)) continue
    const uploaded = object.uploaded ?? object.Uploaded
    const hasUploaded = Object.prototype.hasOwnProperty.call(object, 'uploaded') ||
      Object.prototype.hasOwnProperty.call(object, 'Uploaded')
    // An explicit failed upload marker applies to the whole response object,
    // including a nested data payload.  Do not accept a stale/error URL from it.
    if (hasUploaded && !richImageUploadMarkerIsSuccess(uploaded)) continue
    for (const key of ['url', 'Url', 'URL', 'path', 'Path']) {
      const candidate = object[key]
      if (typeof candidate !== 'string') continue
      const normalized = normalizeRichImagePath(candidate)
      if (normalized) return normalized
    }
    if (current.depth >= 3) continue
    for (const key of ['Data', 'data']) {
      const nested = parseJsonPayload(object[key])
      if (nested !== object[key] && nested !== undefined) {
        queue.push({ value: nested, depth: current.depth + 1 })
      } else if (nested && typeof nested === 'object') {
        queue.push({ value: nested, depth: current.depth + 1 })
      }
    }
  }
  return null
}

/** Parse only CKEditor's callback/JSON path; never evaluate returned script. */
export const parseRichImageUploadCallback = (body: string): string => {
  for (const match of body.matchAll(richImageCallbackPattern)) {
    let index = (match.index ?? 0) + match[0].length
    while (/\s/.test(body[index] ?? '')) index += 1
    const functionStart = index
    while (/\d/.test(body[index] ?? '')) index += 1
    if (functionStart === index) continue
    while (/\s/.test(body[index] ?? '')) index += 1
    if (body[index] !== ',') continue
    index += 1
    while (/\s/.test(body[index] ?? '')) index += 1
    const quote = body[index]
    if (quote !== "'" && quote !== '"') continue
    index += 1
    let raw = ''
    let closed = false
    while (index < body.length) {
      const current = body[index]
      if (current === quote) {
        closed = true
        index += 1
        break
      }
      if (current === '\\' && index + 1 < body.length) {
        raw += current + body[++index]
      } else {
        raw += current
      }
      index += 1
    }
    if (!closed) continue
    const path = decodeJavaScriptString(raw)
    if (!path) continue
    const normalized = normalizeRichImagePath(path)
    if (normalized) return normalized
  }

  const jsonPath = parseRichImageUploadJson(body)
  if (jsonPath) return jsonPath
  if (isRichImageLoginResponse(body)) {
    throw new Error('图片上传鉴权失败：服务器返回登录页面或 LogOn 页面')
  }
  throw new Error('图片上传响应未返回合法的 CKEditor 图片路径')
}

const validFieldKey = (
  field: string,
  allowNodeTypeField = false,
  allowCollectionField = false
): boolean =>
  field.length > 0 && field.length <= 240 &&
  (allowNodeTypeField || field !== '_valm_NodeType') &&
  (allowCollectionField || !FIELD_COLLECTION_KEYS.has(field.toLocaleLowerCase()))

type FieldDefinitionMetadata = Pick<
  FieldDefinition,
  'sourceType' | 'normalizedType' | 'attrType' | 'sourceUid' |
  'internalMember' | 'conditionUid' | 'isSystem' | 'isEditable' | 'isRemovable'
>

const emptyFieldDefinitionMetadata = (): FieldDefinitionMetadata => ({
  sourceType: '',
  normalizedType: 'unknown',
  attrType: '',
  sourceUid: '',
  internalMember: '',
  conditionUid: '',
  isSystem: false,
  isEditable: false,
  isRemovable: false
})

const fieldDefinitionMetadataFromRow = (row: JsonObject): FieldDefinitionMetadata => {
  const sourceType = readFieldDefinitionText(row, 'MemberType')
  return {
    sourceType,
    normalizedType: normalizeFieldDefinitionType(sourceType),
    attrType: readFieldDefinitionText(row, 'AttrType'),
    sourceUid: readFieldDefinitionText(row, 'Uid'),
    internalMember: readFieldDefinitionText(row, 'Member'),
    conditionUid: readFieldDefinitionText(row, 'MemberConditionUid'),
    isSystem: readFieldDefinitionBoolean(readCaseInsensitiveValue(row, 'IsSystem')),
    isEditable: readFieldDefinitionBoolean(readCaseInsensitiveValue(row, 'IsEdit')),
    isRemovable: readFieldDefinitionBoolean(readCaseInsensitiveValue(row, 'IsRemove'))
  }
}

const fieldDefinitionRowsPayload = (input: unknown): unknown[] | null => {
  let current = parseJsonPayload(input)
  for (let depth = 0; depth <= 3; depth += 1) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null
    const object = current as JsonObject
    const rowsValue = readCaseInsensitiveValue(object, 'rows')
    if (hasCaseInsensitiveKey(object, 'rows')) {
      const rows = parseJsonPayload(rowsValue)
      return Array.isArray(rows) ? rows : []
    }
    // An envelope without rows is a failed/empty member response.  Do not let
    // the legacy recursive parser treat `total` or `Extend` as a business
    // field and accidentally replace a known-good catalog.
    if (hasCaseInsensitiveKey(object, 'total') || hasCaseInsensitiveKey(object, 'extend')) {
      return []
    }
    const next = readCaseInsensitiveValue(object, 'Data')
    if (next === undefined || next === current) return null
    current = parseJsonPayload(next)
  }
  return null
}

const parseDeterministicFieldDefinitionRows = (
  rows: unknown[],
  fallbackNodeType: string
): FieldDefinition[] => {
  const definitions = new Map<string, FieldDefinition>()
  const fallback = fallbackNodeType.trim()
  for (const rawRow of rows) {
    const row = parseJsonPayload(rawRow)
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const rowObject = row as JsonObject
    const nodeType = readFieldDefinitionText(rowObject, 'NodeType') || fallback
    const field = readFieldDefinitionText(rowObject, 'HideMember')
    const displayName = stripHtml(readFieldDefinitionText(rowObject, 'MemberName')).trim()
    if (!nodeType || nodeType.length > 240 || !validFieldKey(field, true, true) ||
        !displayName || displayName.length > 200) continue
    definitions.set(`${nodeType}\u0000${field}`, {
      nodeType,
      field,
      displayName,
      ...fieldDefinitionMetadataFromRow(rowObject)
    })
  }
  return [...definitions.values()]
}

export const parseFieldDefinitions = (
  input: unknown,
  fallbackNodeType = ''
): FieldDefinition[] => {
  const deterministicRows = fieldDefinitionRowsPayload(input)
  if (deterministicRows) {
    return parseDeterministicFieldDefinitionRows(deterministicRows, fallbackNodeType)
  }

  const definitions = new Map<string, FieldDefinition>()
  const add = (
    nodeTypeInput: string,
    fieldInput: string,
    displayInput: string,
    metadata: Partial<FieldDefinitionMetadata> = {}
  ): void => {
    const nodeType = nodeTypeInput.trim() || fallbackNodeType.trim()
    const field = fieldInput.trim()
    const displayName = stripHtml(displayInput).trim()
    if (!nodeType || !validFieldKey(field) || !displayName || displayName.length > 200) return
    definitions.set(`${nodeType}\u0000${field}`, {
      nodeType,
      field,
      displayName,
      ...emptyFieldDefinitionMetadata(),
      ...metadata,
      normalizedType: metadata.normalizedType ?? normalizeFieldDefinitionType(metadata.sourceType)
    })
  }

  const visit = (
    inputValue: unknown,
    inheritedNodeType: string,
    collectionContext: boolean,
    depth: number
  ): void => {
    const valueToVisit = parseJsonPayload(inputValue)
    if (Array.isArray(valueToVisit)) {
      valueToVisit.forEach((item) => visit(item, inheritedNodeType, collectionContext, depth + 1))
      return
    }
    if (!valueToVisit || typeof valueToVisit !== 'object') return
    const object = valueToVisit as JsonObject
    const nodeType = readTextCandidate(object, FIELD_NODE_TYPE_KEYS) || inheritedNodeType
    const field = readTextCandidate(object, FIELD_KEY_KEYS)
    const displayName = readTextCandidate(object, FIELD_DISPLAY_KEYS)
    if (field && displayName) add(nodeType, field, displayName, fieldDefinitionMetadataFromRow(object))

    const dynamicCollection = collectionContext || (depth === 0 && Boolean(nodeType) && !field)
    for (const [key, child] of Object.entries(object)) {
      const normalizedKey = key.toLocaleLowerCase()
      const childIsCollection = FIELD_COLLECTION_KEYS.has(normalizedKey)
      const parsedChild = childIsCollection || key === 'Data' ? parseJsonPayload(child) : child
      visit(parsedChild, nodeType, dynamicCollection || childIsCollection, depth + 1)
    }

    if (!dynamicCollection || field) return
    for (const [key, child] of Object.entries(object)) {
      const normalizedKey = key.toLocaleLowerCase()
      if (
        FIELD_COLLECTION_KEYS.has(normalizedKey) ||
        FIELD_NODE_TYPE_KEYS.some((candidate) => candidate.toLocaleLowerCase() === normalizedKey) ||
        normalizedKey.startsWith('error')
      ) continue
      if (typeof child === 'string' || typeof child === 'number') {
        add(nodeType, key, String(child))
        continue
      }
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue
      const childObject = child as JsonObject
      const childDisplayName = readTextCandidate(childObject, FIELD_DISPLAY_KEYS)
      if (childDisplayName) {
        add(nodeType, key, childDisplayName, fieldDefinitionMetadataFromRow(childObject))
      }
    }
  }

  visit(input, fallbackNodeType, false, 0)
  return [...definitions.values()]
}

const pureNumericValue = (input: unknown): string | null => {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 0 ? String(input) : null
  }
  if (typeof input !== 'string') return null
  const normalized = input.trim()
  return pureNumericPattern.test(normalized) ? normalized : null
}

const hasDisplayText = (input: unknown): boolean => {
  if (Array.isArray(input)) return input.some(hasDisplayText)
  if (input === null || input === undefined) return false
  return String(input).trim() !== ''
}

/** Split supported account separators; ordinary spaces stay part of a login. */
const splitUserLoginNames = (input: string): string[] => input
  .split(/[,，;；]/)
  .map((part) => part.trim())
  .filter(Boolean)

const userLookupValue = (input: unknown): string[] => {
  if (Array.isArray(input)) return input.flatMap(userLookupValue)
  if (typeof input === 'string') return splitUserLoginNames(input)
  if (typeof input === 'number') {
    const normalized = String(input).trim()
    return normalized ? [normalized] : []
  }
  if (!input || typeof input !== 'object') return []

  const object = input as JsonObject
  for (const key of [
    'key',
    'login',
    'loginName',
    'login_name',
    'username',
    'userName',
    'UserName',
    'name',
    'Name',
    'value',
    'Value'
  ]) {
    const values = userLookupValue(object[key])
    if (values.length) return values
  }
  return []
}

const USER_DISPLAY_NAME_KEYS = [
  'displayName',
  'DisplayName',
  'display_name',
  'realName',
  'RealName',
  'real_name',
  'fullName',
  'FullName',
  'full_name',
  'userDisplayName',
  'UserDisplayName',
  'user_display_name',
  'userRealName',
  'UserRealName',
  'UserFullName',
  'nameText',
  'NameText',
  'userNameText',
  'UserNameText',
  'nickname',
  'nickName',
  'NickName',
  'name',
  '_valm_Name',
  'Name'
]

const findUserDisplayName = (
  input: unknown,
  loginName: string,
  depth = 0
): string => {
  if (depth > 5 || input === null || input === undefined) return ''
  if (Array.isArray(input)) {
    for (const item of input) {
      const name = findUserDisplayName(item, loginName, depth + 1)
      if (name) return name
    }
    return ''
  }
  if (typeof input !== 'object') return ''

  const object = input as JsonObject
  let fallback = ''
  for (const key of USER_DISPLAY_NAME_KEYS) {
    const candidate = object[key]
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue
    const name = String(candidate).trim()
    if (!name) continue
    fallback ||= name
    if (name.localeCompare(loginName, undefined, { sensitivity: 'accent' }) !== 0) {
      return name
    }
  }
  for (const value of Object.values(object)) {
    const name = findUserDisplayName(value, loginName, depth + 1)
    if (name) return name
  }
  return fallback
}

const displayValue = (input: unknown): string => {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    try {
      return JSON.stringify(input)
    } catch {
      return String(input)
    }
  }
  return String(input).trim()
}

const compareFilter = (rawValue: unknown, filter: SyncFieldFilter): boolean => {
  const current = displayValue(rawValue)
  const expected = filter.value ?? ''
  switch (filter.operator) {
    case 'empty':
      return current.trim() === ''
    case 'notEmpty':
      return current.trim() !== ''
    case 'equals':
      return current.localeCompare(expected, undefined, { sensitivity: 'accent' }) === 0
    case 'notEquals':
      return current.localeCompare(expected, undefined, { sensitivity: 'accent' }) !== 0
    case 'contains':
      return current.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    case 'notContains':
      return !current.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    default: {
      const currentNumber = Number(current)
      const expectedNumber = Number(expected)
      const numeric = Number.isFinite(currentNumber) && Number.isFinite(expectedNumber)
      const left = numeric ? currentNumber : Date.parse(current)
      const right = numeric ? expectedNumber : Date.parse(expected)
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false
      if (filter.operator === 'greaterThan') return left > right
      if (filter.operator === 'greaterThanOrEqual') return left >= right
      if (filter.operator === 'lessThan') return left < right
      return left <= right
    }
  }
}

const matchesFilters = (raw: JsonObject, filters: SyncFieldFilter[]): boolean =>
  filters.every((filter) => compareFilter(raw[filter.field], filter))

export class VisslmClient {
  private readonly itemNameCache = new Map<string, string>()

  private readonly itemNameRequests = new Map<string, Promise<string>>()

  private readonly userDisplayNameCache = new Map<string, string>()

  private readonly userDisplayNameRequests = new Map<string, Promise<string>>()

  private readonly displayLookupLimiter = new AsyncTaskLimiter(DISPLAY_LOOKUP_CONCURRENCY)

  private readonly userPropertyKeys: ReadonlySet<string>

  private readonly sessionCookies = new Map<string, string>()

  private richImageLoginPromise: Promise<void> | undefined

  private richImageAuthenticated = false

  /**
   * A client instance owns one immutable credential set.  Remember a failed
   * web login for the lifetime of that instance so optional field-catalog
   * enrichment cannot immediately submit the same invalid credentials again
   * when the sync proceeds to user display-name resolution.
   */
  private richImageLoginError: unknown

  constructor(private readonly credentials: Credentials) {
    if (!credentials.baseUrl || !credentials.username || !credentials.token) {
      throw new Error('请先完整配置 VISSLM 地址、用户名和 API Token')
    }
    this.userPropertyKeys = new Set(
      (credentials.userPropertyKeys ?? []).map((key) => key.trim()).filter(Boolean)
    )
  }

  get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/+$/, '')
  }

  private endpoint(path: string): URL {
    const base = this.credentials.baseUrl.replace(/\/+$/, '')
    const normalized = path.startsWith('/') ? path : `/${path}`
    return new URL(`${base}${normalized}`)
  }

  private authenticatedUrl(pathOrUrl: string, query?: Record<string, string>): URL {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : this.endpoint(pathOrUrl)
    url.searchParams.set('user', this.credentials.username)
    url.searchParams.set('ApiToken', this.credentials.token)
    for (const [key, val] of Object.entries(query ?? {})) {
      if (val !== '') url.searchParams.set(key, val)
    }
    return url
  }

  /** Build a URL for an already authenticated browser session. */
  private sessionUrl(pathOrUrl: string, query?: Record<string, string>): URL {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? new URL(pathOrUrl)
      : this.endpoint(pathOrUrl)
    for (const [key, val] of Object.entries(query ?? {})) {
      if (val !== '') url.searchParams.set(key, val)
    }
    return url
  }

  private sessionCookieHeader(extra?: { name: string; value: string }): string {
    const cookies = new Map(this.sessionCookies)
    if (extra) cookies.set(extra.name, extra.value)
    return [...cookies.entries()]
      .filter(([name, value]) => name && value)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ')
  }

  private updateSessionCookies(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] }
    const setCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (() => {
          const combined = response.headers.get('set-cookie')
          return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/) : []
        })()
    for (const setCookie of setCookies) {
      const pair = setCookie.split(';', 1)[0] ?? ''
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator).trim()
      const cookieValue = pair.slice(separator + 1).trim()
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
      const expired = !cookieValue || /(?:^|;)\s*max-age\s*=\s*0(?:;|$)/i.test(setCookie)
      if (expired) this.sessionCookies.delete(name)
      else this.sessionCookies.set(name, cookieValue)
    }
  }

  private hasSessionCookie(name: string): boolean {
    return Boolean(this.sessionCookies.get(name)?.trim())
  }

  private clearRichImageSession(): void {
    this.sessionCookies.clear()
    this.richImageAuthenticated = false
  }

  private async loginForRichImage(): Promise<void> {
    const password = this.credentials.uploadPassword
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('未配置 VISSLM 图片上传密码，无法登录图片上传接口')
    }

    this.clearRichImageSession()
    const logOnResponse = await this.requestWithRetry(this.endpoint('/User/LogOn'), {
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' }
    })
    this.updateSessionCookies(logOnResponse)
    try { await logOnResponse.text() } catch { /* best effort: status/cookies are enough */ }
    if (!logOnResponse.ok) {
      throw new VisslmRequestError(`VISSLM 登录页请求失败 HTTP ${logOnResponse.status}`, logOnResponse.status)
    }
    if (!this.hasSessionCookie('JSESSIONID')) {
      throw new Error('VISSLM 登录页未返回 JSESSIONID，无法建立图片上传会话')
    }

    let encodedUsername: string
    try {
      // Match the V2.00.01.22 browser client: encodeURI first, then base64
      // without padding.  encodeURI keeps the same reserved characters as
      // the platform JavaScript implementation.
      const encoded = Buffer.from(encodeURI(this.credentials.username), 'utf8')
        .toString('base64')
        .replace(/=/g, '')
      encodedUsername = `${randomBytes(3).toString('hex')}${encoded}${randomBytes(3).toString('hex').toUpperCase()}`
    } catch {
      throw new Error('VISSLM 用户名无法编码，无法登录图片上传接口')
    }
    const passwordDigest = createHash('md5')
      .update(password)
      .digest('hex')
      .toUpperCase()
    const upassword = `*${createHash('md5')
      .update(`${this.credentials.username.toUpperCase()}:VISSLM:${passwordDigest}`)
      .digest('hex')}`
    const form = new URLSearchParams({
      uname: encodedUsername,
      upassword,
      rememberPwd: 'false'
    })
    const loginResponse = await this.requestWithRetry(this.endpoint('/User/UPLogOn'), {
      method: 'POST',
      headers: {
        accept: 'application/json,text/plain,*/*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        cookie: this.sessionCookieHeader(),
        origin: new URL(this.baseUrl).origin,
        referer: this.endpoint('/User/LogOn').toString()
      },
      body: form.toString()
    })
    this.updateSessionCookies(loginResponse)
    const responseText = await loginResponse.text()
    let payload: unknown
    try {
      payload = responseText.trim() ? JSON.parse(responseText) as unknown : null
    } catch {
      throw new Error('VISSLM 图片上传登录响应不是有效 JSON')
    }
    if (!loginResponse.ok || !payload || typeof payload !== 'object') {
      throw new VisslmRequestError(
        `VISSLM 图片上传登录失败 HTTP ${loginResponse.status}`,
        loginResponse.status,
        undefined
      )
    }
    const result = payload as JsonObject
    const errorCode = result.ErrorCode ?? result.errorCode
    const numericErrorCode = typeof errorCode === 'string' || typeof errorCode === 'number'
      ? Number(errorCode)
      : Number.NaN
    if (errorCode === undefined || errorCode === null || numericErrorCode !== 0) {
      const errorMessage = typeof (result.ErrorMessage ?? result.ErrorMsg) === 'string'
        ? String(result.ErrorMessage ?? result.ErrorMsg).trim().slice(0, 200)
        : ''
      const safeErrorMessage = errorMessage && password
        ? errorMessage.split(password).join('[已脱敏]')
        : errorMessage
      throw new Error(`VISSLM 图片上传登录失败${safeErrorMessage ? `：${safeErrorMessage}` : ''}`)
    }
    if (!this.hasSessionCookie('JSESSIONID')) {
      throw new Error('VISSLM 图片上传登录成功但未返回 JSESSIONID')
    }
    this.richImageAuthenticated = true
  }

  private async ensureRichImageLogin(): Promise<void> {
    if (this.richImageAuthenticated && this.hasSessionCookie('JSESSIONID')) return
    if (this.richImageLoginError) throw this.richImageLoginError
    if (!this.richImageLoginPromise) {
      this.richImageLoginPromise = this.loginForRichImage().catch((error) => {
        this.richImageLoginError = error
        throw error
      })
    }
    try {
      await this.richImageLoginPromise
    } finally {
      this.richImageLoginPromise = undefined
    }
  }

  private async ensureFieldDefinitionLogin(): Promise<void> {
    try {
      // The member catalog and rich-image upload use the same VISSLM web
      // session.  Reuse that login flow so the platform password never needs
      // to be sent as part of the catalog request itself.
      await this.ensureRichImageLogin()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('图片上传密码')) {
        throw new Error('未配置 VISSLM 平台登录密码，无法读取字段定义')
      }
      if (message.includes('图片上传')) {
        throw new Error(message.replaceAll('图片上传', '平台网页'))
      }
      throw error
    }
  }

  /**
   * Retry only idempotent reads.  POST requests deliberately opt out because
   * the platform contract does not expose an idempotency key; replaying a
   * timed-out create/upload could otherwise duplicate remote data.
   */
  private async requestWithRetry(
    url: URL,
    init: RequestInit,
    safe = false
  ): Promise<Response> {
    const maxAttempts = safe ? SAFE_REQUEST_MAX_ATTEMPTS : 1
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
        if (
          safe &&
          attempt < maxAttempts &&
          RETRYABLE_HTTP_STATUSES.has(response.status)
        ) {
          try {
            await response.body?.cancel()
          } catch {
            // Best effort: releasing a retry response should not hide the
            // eventual request result.
          }
          const delay = retryAfterDelayMs(response) ?? SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        return response
      } catch (error) {
        if (!safe || attempt >= maxAttempts || !isRetryableNetworkError(error)) throw error
        const delay = SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw new Error('VISSLM 请求重试次数已用尽')
  }

  private async getJson(path: string, query?: Record<string, string>): Promise<AlmResponse | unknown> {
    const response = await this.requestWithRetry(
      this.authenticatedUrl(path, query),
      { method: 'GET' },
      true
    )
    const responseText = await response.text()
    if (!response.ok) throw new Error(`VISSLM HTTP ${response.status}`)
    let data: AlmResponse | unknown = null
    try {
      data = responseText.trim() ? JSON.parse(responseText) as AlmResponse | unknown : null
    } catch {
      throw new VisslmInvalidJsonResponseError(
        describeInvalidJsonResponse(response, responseText),
        response.status,
        isRichImageLoginResponse(responseText)
      )
    }
    if (data && typeof data === 'object' && 'ErrorCode' in data) {
      const result = data as AlmResponse
      if (Number(result.ErrorCode) !== 0) {
        throw new Error(result.ErrorMessage || result.ErrorMsg || `VISSLM 错误 ${result.ErrorCode}`)
      }
    }
    return data
  }

  /**
   * Read JSON through the browser login session, without putting the API
   * token in the URL.  This is used only for endpoints that reject token
   * authentication while still allowing an authenticated JSESSIONID.
   */
  private async getJsonWithSession(
    path: string,
    query?: Record<string, string>
  ): Promise<AlmResponse | unknown> {
    const response = await this.requestWithRetry(
      this.sessionUrl(path, query),
      {
        method: 'GET',
        headers: {
          accept: 'application/json,text/plain,*/*',
          cookie: this.sessionCookieHeader(),
          origin: new URL(this.baseUrl).origin,
          referer: this.endpoint('/User/LogOn').toString()
        }
      },
      true
    )
    this.updateSessionCookies(response)
    const responseText = await response.text()
    if (!response.ok) {
      throw new VisslmRequestError(`VISSLM HTTP ${response.status}`, response.status)
    }
    let data: AlmResponse | unknown = null
    try {
      data = responseText.trim() ? JSON.parse(responseText) as AlmResponse | unknown : null
    } catch {
      throw new VisslmInvalidJsonResponseError(
        describeInvalidJsonResponse(response, responseText),
        response.status,
        isRichImageLoginResponse(responseText)
      )
    }
    if (data && typeof data === 'object' && 'ErrorCode' in data) {
      const result = data as AlmResponse
      if (Number(result.ErrorCode) !== 0) {
        throw new VisslmRequestError(
          result.ErrorMessage || result.ErrorMsg || `VISSLM 错误 ${result.ErrorCode}`,
          response.status,
          data
        )
      }
    }
    return data
  }

  /**
   * Read a form-backed JSON endpoint through the browser session.  This
   * helper is intentionally private and only used by the read-only member
   * catalog endpoint below: unlike ordinary POST calls, replaying this
   * request is safe because it only reads metadata.
   */
  private async postJsonWithSessionReadOnly(
    path: string,
    body: Record<string, string>
  ): Promise<AlmResponse | unknown> {
    const form = new URLSearchParams(body)
    const response = await this.requestWithRetry(
      this.sessionUrl(path),
      {
        method: 'POST',
        headers: {
          accept: 'application/json,text/plain,*/*',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          cookie: this.sessionCookieHeader(),
          origin: new URL(this.baseUrl).origin,
          referer: this.endpoint('/admin/index').toString(),
          'x-requested-with': 'XMLHttpRequest'
        },
        body: form.toString()
      },
      true
    )
    this.updateSessionCookies(response)
    const responseText = await response.text()
    const loginPage = response.status === 999 || isRichImageLoginResponse(responseText)
    if (loginPage) {
      throw new VisslmRequestError(
        `VISSLM 字段定义会话已过期（HTTP ${response.status}）`,
        response.status,
        { ErrorCode: 999 }
      )
    }
    if (!response.ok) {
      throw new VisslmRequestError(`VISSLM HTTP ${response.status}`, response.status)
    }
    let data: AlmResponse | unknown = null
    try {
      data = responseText.trim() ? JSON.parse(responseText) as AlmResponse | unknown : null
    } catch {
      throw new VisslmInvalidJsonResponseError(
        describeInvalidJsonResponse(response, responseText),
        response.status,
        false
      )
    }
    if (data && typeof data === 'object' && 'ErrorCode' in data) {
      const result = data as AlmResponse
      const errorCode = Number(result.ErrorCode)
      const errorMessage = result.ErrorMessage || result.ErrorMsg || `VISSLM 错误 ${result.ErrorCode}`
      if (errorCode !== 0) {
        throw new VisslmRequestError(
          errorMessage,
          response.status,
          data
        )
      }
    }
    return data
  }

  private isFieldDefinitionSessionExpired(error: unknown): boolean {
    if (error instanceof VisslmInvalidJsonResponseError) return error.loginPage
    if (!(error instanceof VisslmRequestError)) return false
    if (error.httpStatus === 999) return true
    if (!error.response || typeof error.response !== 'object') return false
    const response = error.response as JsonObject
    return Number(response.ErrorCode ?? response.errorCode) === 999
  }

  private async postJson(
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<PostJsonResult> {
    const response = await this.requestWithRetry(this.authenticatedUrl(path, query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    })
    const responseText = await response.text()
    let data: AlmResponse | unknown = responseText
    try {
      data = responseText ? JSON.parse(responseText) as AlmResponse | unknown : null
    } catch {
      // Keep non-JSON response text in the request log.
    }
    if (!response.ok) {
      throw new VisslmRequestError(`VISSLM HTTP ${response.status}`, response.status, data)
    }
    if (data && typeof data === 'object' && 'ErrorCode' in data) {
      const result = data as AlmResponse
      if (Number(result.ErrorCode) !== 0) {
        throw new VisslmRequestError(
          result.ErrorMessage || result.ErrorMsg || `VISSLM 错误 ${result.ErrorCode}`,
          response.status,
          data
        )
      }
    }
    return { data, httpStatus: response.status }
  }

  createItemEndpoint(): string {
    return this.endpoint('/rest/items').toString()
  }

  createItemTraceParams(params: Record<string, string>): Record<string, string> {
    return {
      ...params,
      user: this.credentials.username,
      ApiToken: '******'
    }
  }

  createItem(
    params: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<PostJsonResult> {
    return this.postJson('/rest/items', params, body)
  }

  private async uploadRichImageOnce(input: {
    projectId: string
    bytes: Buffer
    mimeType: string
    fileName: string
    fieldName?: string
    dataId?: string
    hideMember?: string
  }): Promise<{
    remotePath?: string
    httpStatus: number
    loginPage: boolean
  }> {
    const token = this.sessionCookies.get('ckCsrfToken') || randomBytes(32).toString('hex')
    this.sessionCookies.set('ckCsrfToken', token)
    const url = this.endpoint('/FileCenterImg/UploadRichImg')
    const query: Record<string, string> = {
      type: 'image',
      proId: input.projectId.trim(),
      CKEditor: input.fieldName?.trim() || 'Replyrecord',
      CKEditorFuncNum: '0',
      langCode: 'zh-cn'
    }
    if (input.dataId?.trim()) query.dataId = input.dataId.trim()
    if (input.hideMember?.trim()) query.hideMember = input.hideMember.trim()
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

    const form = new FormData()
    const mimeType = normalizeRichImageMimeType(input.mimeType)
    const safeName = normalizeRichImageFileName(input.fileName, mimeType)
    const uploadBytes = new ArrayBuffer(input.bytes.byteLength)
    new Uint8Array(uploadBytes).set(input.bytes)
    form.append('upload', new Blob([uploadBytes], { type: mimeType }), safeName)
    form.append('ckCsrfToken', token)
    const response = await this.requestWithRetry(url, {
      method: 'POST',
      headers: {
        // Do not set Content-Type: undici must add the multipart boundary.
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        cookie: this.sessionCookieHeader({ name: 'ckCsrfToken', value: token }),
        origin: new URL(this.baseUrl).origin,
        referer: this.endpoint('/User/LogOn').toString()
      },
      body: form
    })
    this.updateSessionCookies(response)
    let responseText = ''
    try {
      responseText = await response.text()
    } catch {
      throw new VisslmRequestError(
        richImageUploadDiagnostic({
          reason: '图片上传响应读取失败',
          response,
          body: responseText
        }),
        response.status
      )
    }
    const loginPage = isRichImageLoginResponse(responseText)
    if (loginPage) {
      return { httpStatus: response.status, loginPage: true }
    }
    if (!response.ok) {
      throw new VisslmRequestError(
        richImageUploadDiagnostic({
          reason: response.status === 401 || response.status === 403
            ? '图片上传鉴权失败：服务器拒绝请求'
            : '图片上传失败',
          response,
          body: responseText
        }),
        response.status
      )
    }
    try {
      return {
        remotePath: parseRichImageUploadCallback(responseText),
        httpStatus: response.status,
        loginPage: false
      }
    } catch {
      throw new VisslmRequestError(
        richImageUploadDiagnostic({
          reason: '图片上传响应无法解析',
          response,
          body: responseText
        }),
        response.status
      )
    }
  }

  /** Upload one rich-text image using the CKEditor File Browser contract. */
  async uploadRichImage(input: {
    projectId: string
    bytes: Buffer
    mimeType: string
    fileName: string
    fieldName?: string
    dataId?: string
    hideMember?: string
  }): Promise<{ remotePath: string; httpStatus: number }> {
    const projectId = input.projectId.trim()
    if (!projectId) throw new Error('图片上传缺少目标项目 UID')
    if (!input.bytes.byteLength) throw new Error('不能上传空图片')
    await this.ensureRichImageLogin()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uploaded = await this.uploadRichImageOnce({ ...input, projectId })
      if (!uploaded.loginPage) {
        if (!uploaded.remotePath) throw new Error('图片上传响应未返回远端路径')
        return { remotePath: uploaded.remotePath, httpStatus: uploaded.httpStatus }
      }
      if (attempt === 1) {
        throw new VisslmRequestError(
          `图片上传鉴权失败：服务器返回登录页面或 LogOn 页面（HTTP ${uploaded.httpStatus}）`,
          uploaded.httpStatus
        )
      }
      // Only an explicit LogOn page authorizes replaying this POST.  Timeouts,
      // generic 4xx/5xx responses, and malformed callbacks are never replayed.
      this.clearRichImageSession()
      await this.ensureRichImageLogin()
    }
    throw new Error('图片上传流程未完成')
  }

  async test(): Promise<ConnectionResult> {
    try {
      const [version, dbVersion] = await Promise.all([
        this.getJson('/rest/application/Version'),
        this.getJson('/rest/application/DBVersion')
      ])
      return {
        ok: true,
        message: `连接成功，VISSLM ${String(version).replaceAll('"', '')}`,
        details: { version, dbVersion }
      }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async getFieldDefinitions(nodeType: string): Promise<FieldDefinition[]> {
    const normalizedNodeType = nodeType.trim()
    if (!normalizedNodeType) return []
    await this.ensureFieldDefinitionLogin()
    const request = (): Promise<AlmResponse | unknown> => this.postJsonWithSessionReadOnly(
      '/Admin/Virtualization_ReadMember',
      { nodeType: normalizedNodeType, proId: '0' }
    )
    try {
      return parseFieldDefinitions(await request(), normalizedNodeType)
    } catch (error) {
      if (!this.isFieldDefinitionSessionExpired(error)) throw error
      // HTTP 999 and an explicit LogOn page are the only conditions that
      // authorize replaying this otherwise read-only POST.  Generic 4xx/5xx,
      // malformed JSON, and network failures are not replayed here.
      this.clearRichImageSession()
      await this.ensureFieldDefinitionLogin()
      return parseFieldDefinitions(await request(), normalizedNodeType)
    }
  }

  async getAttachments(id: string): Promise<JsonObject[]> {
    try {
      const response = (await this.getJson(
        `/rest/items/id/${encodeURIComponent(id)}/attachment`
      )) as AlmResponse
      return response.propList ?? []
    } catch {
      return []
    }
  }

  async resolveNumericFieldDisplayValues(records: JsonObject[]): Promise<JsonObject[]> {
    return (await mapWithConcurrency(
      records,
      (record) => this.resolveNumericFieldValue(record)
    )) as JsonObject[]
  }

  private async resolveNumericFieldValue(input: unknown, path = ''): Promise<unknown> {
    if (Array.isArray(input)) {
      return mapWithConcurrency(
        input,
        (item) => this.resolveNumericFieldValue(item, path)
      )
    }
    if (!input || typeof input !== 'object') return input

    const source = input as JsonObject
    const result: JsonObject = {}
    for (const [key, current] of Object.entries(source)) {
      if (key === '_valm_Description_text') {
        continue
      }
      if (key.endsWith('_text')) {
        result[key] = current
        continue
      }
      // `_valm_Description` is opaque rich-text content.  A numeric-looking
      // description is still text, not an item UID, so do not recurse into it
      // or synthesize a `${key}_text` display value for it.
      if (key === '_valm_Description') {
        result[key] = current
        continue
      }
      const fieldPath = path ? `${path}.${key}` : key
      result[key] = await this.resolveNumericFieldValue(current, fieldPath)

      if (this.isUserProperty(fieldPath)) {
        await this.addUserDisplayValue(result, source, key, current)
        continue
      }

      const numericValue = pureNumericValue(current)
      if (numericValue) {
        const textKey = `${key}_text`
        if (!hasDisplayText(source[textKey])) {
          const text = await this.lookupItemName(numericValue)
          if (text) result[textKey] = text
        }
        continue
      }

      if (Array.isArray(current) && current.length > 0) {
        const numericValues = current.map(pureNumericValue)
        if (numericValues.every((value): value is string => Boolean(value))) {
          const textKey = `${key}_text`
          if (!hasDisplayText(source[textKey])) {
            const texts = await mapWithConcurrency(
              numericValues,
              (value) => this.lookupItemName(value)
            )
            if (texts.some(Boolean)) result[textKey] = texts
          }
        }
      }
    }
    return result
  }

  private isUserProperty(fieldPath: string): boolean {
    const lastKey = fieldPath.slice(fieldPath.lastIndexOf('.') + 1)
    return this.userPropertyKeys.has(fieldPath) || this.userPropertyKeys.has(lastKey)
  }

  private async addUserDisplayValue(
    result: JsonObject,
    source: JsonObject,
    key: string,
    input: unknown
  ): Promise<void> {
    const textKey = `${key}_text`
    const nestedText = input && typeof input === 'object' && !Array.isArray(input)
      ? (input as JsonObject).key_text
      : undefined
    if (hasDisplayText(source[textKey]) || hasDisplayText(nestedText)) return

    const values = userLookupValue(input)
    if (!values.length) return

    const names = await mapWithConcurrency(
      values,
      (value) => this.lookupUserDisplayName(value)
    )
    if (!names.some(Boolean)) return

    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const object = result[key]
      const resolved = object && typeof object === 'object' && !Array.isArray(object)
        ? object as JsonObject
        : { ...(input as JsonObject) }
      if (Object.prototype.hasOwnProperty.call(input, 'key')) {
        resolved.key_text = Array.isArray((input as JsonObject).key)
          ? names
          : names.length > 1 ? names.join(',') : names[0]
        result[key] = resolved
        return
      }
    }

    result[textKey] = Array.isArray(input)
      ? names
      : names.length > 1 ? names.join(',') : names[0]
  }

  private async lookupItemName(uid: string): Promise<string> {
    if (this.itemNameCache.has(uid)) return this.itemNameCache.get(uid) ?? ''
    const pending = this.itemNameRequests.get(uid)
    if (pending) return pending

    const request = this.displayLookupLimiter.run(() => this.getJson('/rest/items', {
      ReturnProperty: '_valm_Uid,_valm_Name',
      'q._valm_Uid': uid
    }))
      .then((data) => {
        const response = data as AlmResponse
        const candidates = [
          ...(response.propList ?? []),
          response.props ?? response.prop ?? {}
        ]
        const item = candidates.find((candidate) => value(candidate, '_valm_Uid') === uid)
          ?? candidates.find((candidate) => value(candidate, '_valm_Name'))
        const name = item ? value(item, '_valm_Name').trim() : ''
        this.itemNameCache.set(uid, name)
        return name
      })
      .catch(() => {
        this.itemNameCache.set(uid, '')
        return ''
      })
    this.itemNameRequests.set(uid, request)
    try {
      return await request
    } finally {
      if (this.itemNameRequests.get(uid) === request) this.itemNameRequests.delete(uid)
    }
  }

  private async lookupUserDisplayName(loginName: string): Promise<string> {
    if (this.userDisplayNameCache.has(loginName)) {
      return this.userDisplayNameCache.get(loginName) ?? ''
    }
    const pending = this.userDisplayNameRequests.get(loginName)
    if (pending) return pending

    const request = this.displayLookupLimiter.run(async () => {
      try {
        const data = await this.getJson('/ssf/user/getUserByName', { name: loginName })
        const name = findUserDisplayName(data, loginName)
        // An empty name from valid JSON is a successful, cacheable result.
        this.userDisplayNameCache.set(loginName, name)
        return name
      } catch (error) {
        // Some VISSLM deployments return the LogOn page with HTTP 200 when
        // this token-authenticated endpoint is called.  Only an explicit
        // Login/LogOn page gets the browser-session fallback; ordinary HTTP
        // failures, malformed JSON, and unrelated HTML remain failures.
        if (
          !(error instanceof VisslmInvalidJsonResponseError) ||
          error.httpStatus !== 200 ||
          !error.loginPage
        ) {
          throw new Error(
            'VISSLM 用户显示值查询失败，请检查 API Token、平台地址和用户查询权限后重试'
          )
        }

        try {
          await this.ensureRichImageLogin()
          const data = await this.getJsonWithSession('/ssf/user/getUserByName', { name: loginName })
          const name = findUserDisplayName(data, loginName)
          this.userDisplayNameCache.set(loginName, name)
          return name
        } catch {
          // Do not include the login name, token, password, or upstream body
          // in a collection error.  The setting name is intentionally
          // actionable because this fallback requires the platform password.
          throw new Error(
            'VISSLM 用户显示值查询登录失败，请在平台配置中填写正确的平台登录密码，并检查平台地址和权限后重试'
          )
        }
      }
    })
    this.userDisplayNameRequests.set(loginName, request)
    try {
      return await request
    } finally {
      if (this.userDisplayNameRequests.get(loginName) === request) {
        this.userDisplayNameRequests.delete(loginName)
      }
    }
  }

  private itemQueryParams(
    nodeType: string,
    filters: SyncFieldFilter[] = [],
    configuredReturnProperty = ''
  ): Record<string, string> {
    if (!identifierPattern.test(nodeType)) {
      throw new Error(`数据类型 ${nodeType} 不是合法的 VSearch 标识`)
    }
    const configuredProperties = configuredReturnProperty
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean)
    const returnProperties = [
      ...new Set([
        ...ITEM_BASE_PROPERTIES,
        ...this.userPropertyKeys,
        ...configuredProperties,
        ...filters.map((filter) => filter.field.trim()).filter(Boolean)
      ])
    ]
    for (const field of returnProperties) {
      if (!identifierPattern.test(field)) {
        throw new Error(`ReturnProperty 字段 ${field} 不是合法的字段 Key`)
      }
    }
    const returnProperty = returnProperties.join(',')
    const quote = (input: string): string => `'${input.replaceAll("'", "''")}'`
    const conditions = ["_valm_ItemID<>''", ...filters.map((filter) => {
      const field = filter.field.trim()
      if (!identifierPattern.test(field)) {
        throw new Error(`过滤字段 ${field} 不是合法的字段 Key`)
      }
      const expected = quote(filter.value ?? '')
      switch (filter.operator) {
        case 'equals':
          return `${field}=${expected}`
        case 'notEquals':
          return `${field}<>${expected}`
        case 'contains':
          return `${field} like ${quote(`%${filter.value ?? ''}%`)}`
        case 'notContains':
          return `${field} not like ${quote(`%${filter.value ?? ''}%`)}`
        case 'empty':
          return `${field}=''`
        case 'notEmpty':
          return `${field}<>''`
        case 'greaterThan':
          return `${field}>${expected}`
        case 'greaterThanOrEqual':
          return `${field}>=${expected}`
        case 'lessThan':
          return `${field}<${expected}`
        case 'lessThanOrEqual':
          return `${field}<=${expected}`
      }
    })]
    return {
      VSearch: `select ${returnProperty} from ${nodeType} where ${conditions.join(' and ')}`,
      ReturnProperty: returnProperty
    }
  }

  async queryItems(
    nodeType: string,
    filters: SyncFieldFilter[] = [],
    returnProperty = ''
  ): Promise<JsonObject[]> {
    const response = (await this.getJson(
      '/rest/items',
      this.itemQueryParams(nodeType, filters, returnProperty)
    )) as AlmResponse
    return this.resolveNumericFieldDisplayValues(response.propList ?? [])
  }

  queryItemsTrace(
    nodeType: string,
    filters: SyncFieldFilter[] = [],
    returnProperty = ''
  ): { endpoint: string; params: Record<string, string> } {
    return {
      endpoint: this.endpoint('/rest/items').toString(),
      params: {
        ...this.itemQueryParams(nodeType, filters, returnProperty),
        user: this.credentials.username,
        ApiToken: '******'
      }
    }
  }

  async previewScope(config: SyncScopeConfig): Promise<SyncPreviewResult> {
    if (!config.selectedTypes.length) throw new Error('请至少配置一种采集数据类型')
    const rules = new Map(config.rules.map((rule) => [rule.nodeType, rule]))
    const requests: SyncPreviewResult['requests'] = []
    let requestId = 0
    const trace = async <T>(
      endpoint: string,
      params: Record<string, string>,
      action: () => Promise<T>
    ): Promise<T> => {
      const item = {
        id: ++requestId,
        method: 'GET' as const,
        endpoint: this.endpoint(endpoint).toString(),
        params: {
          ...params,
          user: this.credentials.username,
          ApiToken: '******'
        }
      }
      try {
        const response = await action()
        requests.push({ ...item, response })
        return response
      } catch (error) {
        requests.push({
          ...item,
          error: error instanceof Error ? error.message : String(error)
        })
        throw error
      }
    }
    const counts = new Map<string, number>()
    const samples: SyncPreviewResult['samples'] = []
    let scannedCount = 0
    let matchedCount = 0
    let invalidItemIdCount = 0

    for (const configuredType of config.selectedTypes) {
      const rule = rules.get(configuredType)
      const filters = rule?.filters ?? []
      const params = this.itemQueryParams(
        configuredType,
        filters,
        rule?.returnProperty
      )
      const response = await trace('/rest/items', params, () =>
        this.getJson('/rest/items', params)
      ) as AlmResponse
      const records = response.propList ?? []
      scannedCount += records.length

      for (const raw of records) {
        if (matchesFilters(raw, filters)) {
          const itemId = value(raw, '_valm_ItemID').trim()
          if (!itemId) {
            invalidItemIdCount += 1
            continue
          }
          const uid = value(raw, '_valm_Uid')
          const nodeType = value(raw, '_valm_NodeType') || configuredType
          const projectId =
            nodeType === 'Project'
              ? uid
              : value(raw, '_valm_ProjectId') || value(raw, '_valm_ProjectUid')
          matchedCount += 1
          counts.set(nodeType, (counts.get(nodeType) ?? 0) + 1)
          if (samples.length < 30) {
            samples.push({
              uid,
              projectId,
              nodeType,
              itemId,
              name: value(raw, '_valm_Name') || uid,
              description: value(raw, '_valm_Description')
            })
          }
        }
      }
    }

    return {
      scannedCount,
      matchedCount,
      invalidItemIdCount,
      byType: [...counts.entries()]
        .map(([name, count]) => ({ name, value: count }))
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name)),
      samples,
      requests
    }
  }

  async download(pathOrUrl: string): Promise<{
    bytes: Buffer
    mimeType: string
    sourceUrl: string
  }> {
    let url: URL
    if (/^https?:\/\//i.test(pathOrUrl)) {
      const source = new URL(pathOrUrl)
      const base = new URL(`${this.credentials.baseUrl.replace(/\/+$/, '')}/`)
      if (
        source.origin === base.origin &&
        source.pathname.startsWith(`${base.pathname}FileCenterImg/`)
      ) {
        const filePath = source.pathname.slice(base.pathname.length)
        const encodedPath = filePath
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')
        url = this.endpoint(`/rest/file/DownloadFile/${encodedPath}`)
      } else {
        url = source
      }
    } else {
      if (pathOrUrl.startsWith('/rest/')) {
        url = this.endpoint(pathOrUrl)
      } else {
        const basePath = new URL(`${this.credentials.baseUrl.replace(/\/+$/, '')}/`).pathname
        const normalized = pathOrUrl
          .replace(/^\/+/, '')
          .replace(new RegExp(`^${basePath.replace(/^\/|\/$/g, '')}/`, 'i'), '')
        const encodedPath = normalized
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')
        url = this.endpoint(`/rest/file/DownloadFile/${encodedPath}`)
      }
    }
    url.searchParams.set('user', this.credentials.username)
    url.searchParams.set('ApiToken', this.credentials.token)
    const sourceUrl = this.redactUrl(url)
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= SAFE_REQUEST_MAX_ATTEMPTS; attempt += 1) {
      let response: Response | undefined
      try {
        response = await fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        })
      } catch (error) {
        if (attempt < SAFE_REQUEST_MAX_ATTEMPTS && isRetryableNetworkError(error)) {
          await new Promise((resolve) => setTimeout(resolve, SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500))
          continue
        }
        throw new Error(imagePayloadDiagnostic({
          reason: '图片下载网络失败',
          httpStatus: 0,
          contentType: '',
          bytes: Buffer.alloc(0),
          url: sourceUrl
        }))
      }

      const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() || 'application/octet-stream'
      let bytes: Buffer
      try {
        // Always consume the response body, including non-2xx responses, so a
        // retry does not retain an undrained connection in undici's pool.
        bytes = Buffer.from(await response.arrayBuffer())
      } catch (error) {
        try { await response.body?.cancel() } catch { /* best effort */ }
        lastError = new Error(imagePayloadDiagnostic({
          reason: `图片响应读取失败（${error instanceof Error ? error.name : '未知错误'}）`,
          httpStatus: response.status,
          contentType,
          bytes: Buffer.alloc(0),
          url: sourceUrl
        }))
        if (
          attempt < SAFE_REQUEST_MAX_ATTEMPTS &&
          isRetryableNetworkError(error) &&
          RETRYABLE_HTTP_STATUSES.has(response.status)
        ) {
          await new Promise((resolve) => setTimeout(resolve, SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500))
          continue
        }
        throw lastError
      }

      if (!response.ok) {
        lastError = new Error(imagePayloadDiagnostic({
          reason: '图片下载失败',
          httpStatus: response.status,
          contentType,
          bytes,
          url: sourceUrl
        }))
        if (attempt < SAFE_REQUEST_MAX_ATTEMPTS && RETRYABLE_HTTP_STATUSES.has(response.status)) {
          const delay = retryAfterDelayMs(response) ?? SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500
          await new Promise((resolve) => setTimeout(resolve, delay))
          continue
        }
        throw lastError
      }

      if (!imageBytesMatchMime(contentType, bytes)) {
        lastError = new Error(imagePayloadDiagnostic({
          reason: '图片响应 MIME/文件签名校验失败',
          httpStatus: response.status,
          contentType,
          bytes,
          url: sourceUrl
        }))
        if (attempt < SAFE_REQUEST_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, SAFE_REQUEST_BACKOFF_MS[attempt - 1] ?? 500))
          continue
        }
        throw lastError
      }

      return {
        bytes,
        mimeType: contentType,
        sourceUrl
      }
    }
    throw lastError ?? new Error('图片下载重试次数已用尽')
  }

  private redactUrl(url: URL): string {
    return redactUrlForError(url)
  }
}

export class PushService {
  constructor(
    private readonly db: AppDatabase,
    private readonly clientFactory: () => VisslmClient
  ) {}

  preview(config: PushConfig): PushResult {
    return this.run(config, false) as PushResult
  }

  async push(config: PushConfig): Promise<PushResult> {
    return this.run(config, true) as Promise<PushResult>
  }

  private run(config: PushConfig, execute: false): PushResult
  private run(config: PushConfig, execute: true): Promise<PushResult>
  private run(config: PushConfig, execute: boolean): PushResult | Promise<PushResult> {
    if (!config.nodeType.trim()) throw new Error('请输入目标节点类型 nodeType')
    if (!config.projectId.trim()) throw new Error('请输入目标项目 UID')
    const recordUids = [...new Set(config.recordUids.map((uid) => uid.trim()).filter(Boolean))]
    if (!recordUids.length) throw new Error('请至少选择一条待推送数据')
    const mappings = (config.fieldMappings ?? []).map((mapping) => ({
      sourceField: mapping.sourceField.trim(),
      targetField: mapping.targetField.trim()
    }))
    const sourceFields = new Set<string>()
    const targetFields = new Set<string>()
    for (const mapping of mappings) {
      if (!mapping.sourceField || !mapping.targetField) {
        throw new Error('字段映射的源属性 Key 和目标属性 Key 均不能为空')
      }
      if (!identifierPattern.test(mapping.sourceField)) {
        throw new Error(`源属性 Key ${mapping.sourceField} 格式无效`)
      }
      if (pushForbiddenSourceFields.has(mapping.sourceField)) {
        throw new Error(`源属性 Key ${mapping.sourceField} 是消息体禁止字段`)
      }
      if (!identifierPattern.test(mapping.targetField)) {
        throw new Error(`目标属性 Key ${mapping.targetField} 格式无效`)
      }
      if (pushForbiddenTargetFields.has(mapping.targetField)) {
        throw new Error(`目标属性 Key ${mapping.targetField} 是消息体禁止字段`)
      }
      if (sourceFields.has(mapping.sourceField)) {
        throw new Error(`源属性 Key ${mapping.sourceField} 存在重复映射`)
      }
      if (targetFields.has(mapping.targetField)) {
        throw new Error(`目标属性 Key ${mapping.targetField} 存在重复映射`)
      }
      sourceFields.add(mapping.sourceField)
      targetFields.add(mapping.targetField)
    }
    const client = this.clientFactory()
    const requests = recordUids.map((uid, index) => {
      const detail = this.db.getRecord(uid, false)
      if (!detail) throw new Error(`本地数据 ${uid} 不存在`)
      const params: Record<string, string> = {
        nodeType: config.nodeType.trim(),
        projectId: config.projectId.trim()
      }
      if (config.componentId?.trim()) params.componentId = config.componentId.trim()
      if (config.parentId?.trim()) params.parentId = config.parentId.trim()
      if (config.insertBeforeId?.trim()) {
        params.insertBeforeId = config.insertBeforeId.trim()
      } else if (config.insertAfterId?.trim()) {
        params.insertAfterId = config.insertAfterId.trim()
      }
      // The renderer always sends an explicit fieldMappings array. In that
      // mode the request body is intentionally allow-listed: only values
      // referenced by the mapping table are copied, so an omitted local field
      // cannot leak into the platform request. Keep the legacy behavior for
      // callers that predate fieldMappings and omit the option entirely.
      const hasExplicitMappings = Array.isArray(config.fieldMappings)
      const body: Record<string, unknown> = hasExplicitMappings ? {} : { ...detail.raw }
      for (const mapping of mappings) {
        if (Object.prototype.hasOwnProperty.call(detail.raw, mapping.sourceField)) {
          body[mapping.targetField] = detail.raw[mapping.sourceField]
        }
      }
      if (!hasExplicitMappings) {
        for (const field of pushForbiddenTargetFields) delete body[field]
        if (!body._valm_Name) body._valm_Name = detail.name
      }
      const previewAssets = this.inspectBodyAssets(body)
      return {
        id: index + 1,
        recordUid: detail.uid,
        recordName: detail.name,
        method: 'POST' as const,
        endpoint: client.createItemEndpoint(),
        params: client.createItemTraceParams(params),
        body,
        ...(previewAssets.imageTotal || previewAssets.imageFailed ? previewAssets : {})
      }
    })

    if (!execute) {
      const previewImageStats = requests.reduce((summary, request) => ({
        imageTotal: summary.imageTotal + (request.imageTotal ?? 0),
        imageUpload: summary.imageUpload + (request.imageUpload ?? 0),
        imageReuse: summary.imageReuse + (request.imageReuse ?? 0),
        imageFailed: summary.imageFailed + (request.imageFailed ?? 0),
        imageErrors: [...summary.imageErrors, ...(request.imageErrors ?? [])].slice(0, 50)
      }), { imageTotal: 0, imageUpload: 0, imageReuse: 0, imageFailed: 0, imageErrors: [] as string[] })
      return {
        preview: true,
        total: requests.length,
        successCount: 0,
        failedCount: 0,
        ...previewImageStats,
        requests: requests.map((request) => ({
          ...request,
          response: { preview: true, message: '请求预览，未向真实平台发送 POST' }
        }))
      }
    }

    return this.execute(client, requests)
  }

  private inspectBodyAssets(
    body: Record<string, unknown>
  ): Pick<PushRequestTrace, 'imageTotal' | 'imageUpload' | 'imageReuse' | 'imageFailed' | 'imageErrors'> {
    const tokenPattern = /visslm-asset:\/\/([a-f0-9]{64})\/[A-Za-z0-9_-]{1,128}/gi
    const hashes = new Set<string>()
    const occurrences = new Map<string, number>()
    const failedHashes = new Set<string>()
    let imageTotal = 0
    let imageFailed = 0
    const imageErrors: string[] = []
    const addError = (message: string): void => {
      if (imageErrors.length < 20 && !imageErrors.includes(message)) imageErrors.push(message)
    }
    const visit = (input: unknown): void => {
      if (typeof input === 'string') {
        const matches = [...input.matchAll(tokenPattern)]
        imageTotal += matches.length
        for (const match of matches) {
          const sha256 = match[1].toLowerCase()
          hashes.add(sha256)
          occurrences.set(sha256, (occurrences.get(sha256) ?? 0) + 1)
          if (!this.db.getAssetBlob(sha256) || !this.db.readAssetBytes(sha256)) {
            imageFailed += 1
            failedHashes.add(sha256)
            addError(`图片资源 ${sha256.slice(0, 12)}… 不存在或校验失败`)
          }
        }
        for (const source of findRichTextImageSources(input)) {
          if (parseAssetToken(source.source)) continue
          imageTotal += 1
          imageFailed += 1
          addError('富文本中存在未解析图片')
        }
        return
      }
      if (Array.isArray(input)) {
        input.forEach(visit)
        return
      }
      if (input && typeof input === 'object') {
        Object.values(input as JsonObject).forEach(visit)
      }
    }
    visit(body)
    const imageReuse = [...occurrences.entries()]
      .filter(([sha256]) => !failedHashes.has(sha256))
      .reduce((total, [, count]) => total + Math.max(0, count - 1), 0)
    return {
      imageTotal,
      imageUpload: Math.max(0, hashes.size - failedHashes.size),
      imageReuse,
      imageFailed,
      ...(imageErrors.length ? { imageErrors } : {})
    }
  }

  private async execute(
    client: VisslmClient,
    requests: PushRequestTrace[]
  ): Promise<PushResult> {
    let successCount = 0
    let failedCount = 0
    let imageTotal = 0
    let imageUpload = 0
    let imageReuse = 0
    let imageFailed = 0
    const imageErrors: string[] = []
    const completed: PushRequestTrace[] = []
    for (const request of requests) {
      const params = Object.fromEntries(
        Object.entries(request.params).filter(([key]) => key !== 'user' && key !== 'ApiToken')
      )
      const logId = this.db.beginPushLog({
        recordUid: request.recordUid,
        recordName: request.recordName,
        endpoint: request.endpoint,
        params: request.params,
        body: request.body
      })
      let requestImageStats: Pick<PushRequestTrace, 'imageTotal' | 'imageUpload' | 'imageReuse' | 'imageFailed'> = {}
      try {
        const projectId = String(params.projectId ?? '').trim()
        const prepared = await this.resolveBodyAssets(client, projectId, request.recordUid, request.body)
        requestImageStats = prepared
        imageTotal += prepared.imageTotal
        imageUpload += prepared.imageUpload
        imageReuse += prepared.imageReuse
        imageFailed += prepared.imageFailed
        const created = await client.createItem(params, prepared.body)
        const response = created.data
        const pushedUid = extractCreatedItemUid(response)
        this.db.finishPushLog(logId, 'success', {
          httpStatus: created.httpStatus,
          response,
          remoteUid: pushedUid
        })
        this.db.markPushResult(request.recordUid, 'success', '推送成功', pushedUid)
        completed.push({
          ...request,
          body: prepared.body,
          response,
          ...(prepared.imageTotal ? {
            imageTotal: prepared.imageTotal,
            imageUpload: prepared.imageUpload,
            imageReuse: prepared.imageReuse,
            imageFailed: prepared.imageFailed
          } : {})
        })
        successCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const assetStats = error instanceof AssetPreparationError ? error.stats : undefined
        if (assetStats) {
          imageTotal += assetStats.imageTotal
          imageUpload += assetStats.imageUpload
          imageReuse += assetStats.imageReuse
          imageFailed += assetStats.imageFailed
          imageErrors.push(...(assetStats.imageErrors ?? []))
        }
        this.db.finishPushLog(logId, 'failed', {
          httpStatus: error instanceof VisslmRequestError ? error.httpStatus : 0,
          response: error instanceof VisslmRequestError ? error.response : undefined,
          errorMessage: message
        })
        this.db.markPushResult(request.recordUid, 'failed', message)
        completed.push({
          ...request,
          ...requestImageStats,
          ...(assetStats ? assetStats : {}),
          error: message
        })
        failedCount += 1
      }
    }
    return {
      preview: false,
      total: requests.length,
      successCount,
      failedCount,
      requests: completed,
      ...(imageTotal || imageUpload || imageReuse || imageFailed ? {
        imageTotal,
        imageUpload,
        imageReuse,
        imageFailed,
        ...(imageErrors.length ? { imageErrors: imageErrors.slice(0, 50) } : {})
      } : {})
    }
  }

  private async resolveBodyAssets(
    client: VisslmClient,
    projectId: string,
    recordUid: string,
    body: Record<string, unknown>
  ): Promise<{
    body: Record<string, unknown>
    imageTotal: number
    imageUpload: number
    imageReuse: number
    imageFailed: number
  }> {
    let imageTotal = 0
    let imageUpload = 0
    let imageReuse = 0
    let imageFailed = 0
    const fail = (message: string): never => {
      throw new AssetPreparationError(message, {
        imageTotal,
        imageUpload,
        imageReuse,
        imageFailed,
        imageErrors: [message]
      })
    }
    if (!projectId) fail('图片上传缺少目标项目 UID')
    const references = new Map(
      this.db.listRecordImageReferences(recordUid).map((reference) => [reference.id, reference])
    )
    const tokenPattern = /visslm-asset:\/\/([a-f0-9]{64})\/([A-Za-z0-9_-]{1,128})/gi
    const remoteBySha = new Map<string, string>()
    const resolveString = async (valueInput: string): Promise<string> => {
      const richSources = findRichTextImageSources(valueInput)
      const matches = [...valueInput.matchAll(tokenPattern)]
      const replacements: Array<{ start: number; end: number; value: string }> = []
      for (const match of matches) {
        const token = match[0]
        const parsed = parseAssetToken(token)
        if (!parsed) continue
        imageTotal += 1
        let remotePath = remoteBySha.get(parsed.sha256)
        if (!remotePath) {
          const reference = references.get(parsed.referenceId)
          const blob = this.db.getAssetBlob(parsed.sha256)
          const bytes = this.db.readAssetBytes(parsed.sha256)
          if (!blob) {
            imageFailed += 1
            fail(`图片资源 ${parsed.sha256.slice(0, 12)}… 不存在或校验失败`)
          }
          if (!bytes) {
            imageFailed += 1
            fail(`图片资源 ${parsed.sha256.slice(0, 12)}… 不存在或校验失败`)
          }
          const resolvedBlob = blob as NonNullable<typeof blob>
          const resolvedBytes = bytes as Buffer
          try {
            const uploaded = await client.uploadRichImage({
              projectId,
              bytes: resolvedBytes,
              mimeType: resolvedBlob.mimeType,
              fileName: reference?.sourceName || `image-${parsed.sha256.slice(0, 12)}`
            })
            remotePath = uploaded.remotePath
            imageUpload += 1
          } catch (error) {
            imageFailed += 1
            fail(error instanceof Error ? error.message : String(error))
          }
          const resolvedRemotePath = remotePath || fail(`图片资源 ${parsed.sha256.slice(0, 12)}… 未返回远端路径`)
          remoteBySha.set(parsed.sha256, resolvedRemotePath)
        } else {
          imageReuse += 1
        }
        const resolvedRemotePath = remotePath || fail(`图片资源 ${parsed.sha256.slice(0, 12)}… 未返回远端路径`)
        const start = match.index ?? 0
        replacements.push({ start, end: start + token.length, value: resolvedRemotePath })
      }
      // An un-tokenized image means collection/import could not retain the
      // binary resource.  Refuse to create a partial remote record.
      for (const source of richSources) {
        if (!parseAssetToken(source.source)) {
          imageFailed += 1
          fail('富文本中存在未解析图片，已阻止推送')
        }
      }
      let result = valueInput
      for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
        result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end)
      }
      return result
    }

    const visit = async (input: unknown): Promise<unknown> => {
      if (typeof input === 'string') return resolveString(input)
      if (Array.isArray(input)) {
        // Uploads are non-idempotent.  Visit one record's fields in order so
        // duplicate SHA tokens cannot race and create two remote files.
        const result: unknown[] = []
        for (const item of input) result.push(await visit(item))
        return result
      }
      if (!input || typeof input !== 'object') return input
      const result: JsonObject = {}
      for (const [key, valueInput] of Object.entries(input as JsonObject)) {
        result[key] = await visit(valueInput)
      }
      return result
    }
    const prepared = await visit(body)
    return {
      body: prepared as Record<string, unknown>,
      imageTotal,
      imageUpload,
      imageReuse,
      imageFailed
    }
  }
}

export class SyncService {
  private running = false

  private static readonly writeBatchSize = 256

  constructor(
    private readonly db: AppDatabase,
    private readonly clientFactory: () => VisslmClient,
    private readonly progress: (progress: SyncProgress) => void
  ) {}

  async run(config?: SyncScopeConfig): Promise<SyncResult> {
    if (this.running) throw new Error('已有同步任务正在运行')
    this.running = true
    const runId = this.db.beginSync()
    const counts = { projects: 0, records: 0, images: 0 }
    let updatedCount = 0
    const retainedUids: string[] = []
    let skippedCount = 0
    let invalidItemIdCount = 0
    try {
      const client = this.clientFactory()
      const pendingRecords: RecordInput[] = []
      const pendingItemIds = new Set<string>()
      const flushPendingRecords = async (): Promise<void> => {
        if (!pendingRecords.length) return
        const batch = pendingRecords.splice(0, pendingRecords.length)
        pendingItemIds.clear()
        // Keep project-row ordering compatible with the previous per-record
        // path, then persist records in one transaction.  Images are handled
        // only after records exist so foreign-key and rich-text asset behavior
        // remains unchanged.
        for (const record of batch) {
          if (record.nodeType === 'Project') {
            this.db.upsertProject({
              uid: record.uid,
              name: record.name,
              itemId: record.itemId,
              lastModifyTime: record.lastModifyTime,
              raw: record.raw
            })
          }
        }
        this.db.upsertRecords(batch)
        for (const record of batch) {
          const imageSync = await this.syncImages(client, record.uid, record.raw)
          counts.images += imageSync.count
          if (JSON.stringify(imageSync.raw) !== JSON.stringify(record.raw)) {
            const refreshedLabels = this.db.getFieldDisplayNames(
              record.nodeType,
              Object.keys(imageSync.raw)
            )
            this.db.updateRecordRawAndNormalizedText(
              record.uid,
              imageSync.raw,
              normalizeText(imageSync.raw, refreshedLabels)
            )
          }
        }
      }
      this.progress({ phase: 'connect', message: '正在验证平台连接', current: 0, total: 1 })
      const connection = await client.test()
      if (!connection.ok) throw new Error(connection.message)
      if (!config?.selectedTypes.length) {
        throw new Error('请先保存至少一种采集数据类型')
      }

      const rules = new Map(config.rules.map((rule) => [rule.nodeType, rule]))
      for (let typeIndex = 0; typeIndex < config.selectedTypes.length; typeIndex += 1) {
        const configuredType = config.selectedTypes[typeIndex]
        const rule = rules.get(configuredType)
        const filters = rule?.filters ?? []
        this.progress({
          phase: 'projects',
          message: `正在通过 items 接口查询 ${configuredType}`,
          current: typeIndex,
          total: config.selectedTypes.length
        })
        if (typeof client.getFieldDefinitions === 'function') {
          try {
            const definitions = await client.getFieldDefinitions(configuredType)
            this.db.replaceFieldDefinitions(definitions)
          } catch (error) {
            this.progress({
              phase: 'projects',
              message: `field definitions unavailable for ${configuredType}; continue collection (${error instanceof Error ? error.message : String(error)})`,
              current: typeIndex,
              total: config.selectedTypes.length
            })
          }
        }
        const requestTrace = client.queryItemsTrace(
          configuredType,
          filters,
          rule?.returnProperty
        )
        const requestLogId = this.db.beginCollectionRequestLog({
          nodeType: configuredType,
          endpoint: requestTrace.endpoint,
          params: requestTrace.params
        })
        let records: JsonObject[]
        try {
          records = await client.queryItems(
            configuredType,
            filters,
            rule?.returnProperty
          )
          if (typeof client.resolveNumericFieldDisplayValues === 'function') {
            records = await client.resolveNumericFieldDisplayValues(records)
          }
          this.db.finishCollectionRequestLog(requestLogId, 'success', {
            httpStatus: 200,
            recordCount: records.length,
            response: {
              ErrorCode: 0,
              recordCount: records.length
            }
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const httpStatus = Number(message.match(/HTTP\s+(\d+)/i)?.[1] ?? 0)
          this.db.finishCollectionRequestLog(requestLogId, 'failed', {
            httpStatus,
            errorMessage: message
          })
          throw error
        }

        for (let index = 0; index < records.length; index += 1) {
          const raw = records[index]
          if (!matchesFilters(raw, filters)) continue
          const itemId = value(raw, '_valm_ItemID').trim()
          if (!itemId) {
            invalidItemIdCount += 1
            continue
          }
          const uid = value(raw, '_valm_Uid').trim()
          if (!uid) continue
          const nodeType = value(raw, '_valm_NodeType') || configuredType
          const projectId =
            nodeType === 'Project'
              ? uid
              : value(raw, '_valm_ProjectId') || value(raw, '_valm_ProjectUid')
          const name = value(raw, '_valm_Name') || uid
          const lastModifyTime = value(raw, '_valm_LastModifyTime')
          const normalizedRaw = {
            ...raw,
            _valm_Uid: uid,
            _valm_ItemID: itemId
          }
          const fieldLabels = this.db.getFieldDisplayNames(nodeType, Object.keys(normalizedRaw))
          const record: RecordInput = {
            uid,
            projectId,
            nodeType,
            itemId,
            parentId: value(raw, '_valm_ParentId'),
            name,
            lastModifyTime,
            raw: normalizedRaw,
            normalizedText: normalizeText(normalizedRaw, fieldLabels)
          }
          this.progress({
            phase: 'records',
            message: `校验 ${nodeType}：${name}`,
            current: index + 1,
            total: records.length
          })

          // A duplicate can occur within one response before the current
          // write batch is flushed. Flush first so the existing row is visible
          // and the latest occurrence wins deterministically.
          const itemKey = itemId.toLowerCase()
          if (pendingItemIds.has(itemKey)) await flushPendingRecords()
          const existing = this.db.findRecordByItemId(itemId)
          if (existing) {
            retainedUids.push(existing.uid)
            const existingDetail = this.db.getRecord(existing.uid, false)
            // Keep the local primary key stable so project assets, knowledge
            // chunks and PM links remain attached even if the platform sends a
            // different UID for the same business ItemID.  Properties returned
            // by this run win; fields omitted by ReturnProperty remain intact.
            const hasIncomingField = (field: string): boolean =>
              Object.prototype.hasOwnProperty.call(record.raw, field)
            const mergedRaw: JsonObject = {
              ...(existingDetail?.raw ?? {}),
              ...record.raw,
              _valm_Uid: existing.uid,
              _valm_ItemID: itemId,
              _valm_NodeType: value(record.raw, '_valm_NodeType') ||
                value(existingDetail?.raw ?? {}, '_valm_NodeType') ||
                record.nodeType ||
                existing.nodeType
            }
            // `_valm_Description_text` was historically synthesized when a
            // numeric-looking rich-text description was mistaken for an item
            // UID.  Once the real description is present in this response,
            // remove that derived legacy field while preserving the opaque
            // `_valm_Description` value itself.
            if (hasIncomingField('_valm_Description')) {
              delete mergedRaw._valm_Description_text
            }
            // Derive the row metadata from the merged payload so a field that
            // is omitted by ReturnProperty remains intact, while an explicitly
            // returned latest value (including an empty value) is respected.
            const mergedNodeType = value(mergedRaw, '_valm_NodeType') || record.nodeType || existing.nodeType
            const hasIncomingProjectId = hasIncomingField('_valm_ProjectId') ||
              hasIncomingField('_valm_ProjectUid') ||
              record.nodeType === 'Project'
            const mergedProjectId = hasIncomingProjectId ? record.projectId : existing.projectId
            const mergedParentId = hasIncomingField('_valm_ParentId')
              ? value(record.raw, '_valm_ParentId')
              : existing.parentId
            const mergedName = hasIncomingField('_valm_Name')
              ? (value(record.raw, '_valm_Name') || existing.name || record.name)
              : existing.name
            const mergedLastModifyTime = hasIncomingField('_valm_LastModifyTime')
              ? value(record.raw, '_valm_LastModifyTime')
              : existing.lastModifyTime
            mergedRaw._valm_NodeType = mergedNodeType
            const mergedLabels = this.db.getFieldDisplayNames(
              mergedNodeType,
              Object.keys(mergedRaw)
            )
            const mergedNormalizedText = normalizeText(mergedRaw, mergedLabels)
            const recordChanged = !existingDetail ||
              existingDetail.projectId !== mergedProjectId ||
              existingDetail.nodeType !== mergedNodeType ||
              existingDetail.parentId !== mergedParentId ||
              existingDetail.name !== mergedName ||
              existingDetail.lastModifyTime !== mergedLastModifyTime ||
              JSON.stringify(existingDetail.raw) !== JSON.stringify(mergedRaw) ||
              existingDetail.normalizedText !== mergedNormalizedText
            if (recordChanged) {
              this.db.upsertRecord({
                ...record,
                uid: existing.uid,
                projectId: mergedProjectId,
                nodeType: mergedNodeType,
                parentId: mergedParentId,
                name: mergedName,
                lastModifyTime: mergedLastModifyTime,
                raw: mergedRaw,
                normalizedText: mergedNormalizedText
              })
            }
            const imageSync = recordChanged || record.uid !== existing.uid
              ? await this.syncImages(client, existing.uid, mergedRaw, record.uid)
              : { count: 0, raw: mergedRaw }
            counts.images += imageSync.count
            const imageRawChanged = JSON.stringify(imageSync.raw) !== JSON.stringify(mergedRaw)
            if (imageRawChanged) {
              const imageLabels = this.db.getFieldDisplayNames(
                mergedNodeType,
                Object.keys(imageSync.raw)
              )
              this.db.updateRecordRawAndNormalizedText(
                existing.uid,
                imageSync.raw,
                normalizeText(imageSync.raw, imageLabels)
              )
            }
            if (mergedNodeType === 'Project') {
              this.db.upsertProject({
                uid: existing.uid,
                name: mergedName,
                itemId,
                lastModifyTime: mergedLastModifyTime,
                raw: imageSync.raw
              })
            }
            if (recordChanged || imageRawChanged) updatedCount += 1
            this.progress({
              phase: 'records',
              message: `已自动更新 _valm_ItemID：${itemId}`,
              current: index + 1,
              total: records.length
            })
            continue
          }

          if (nodeType === 'Project') counts.projects += 1
          pendingRecords.push(record)
          pendingItemIds.add(itemKey)
          retainedUids.push(uid)
          counts.records += 1
          if (pendingRecords.length >= SyncService.writeBatchSize) {
            await flushPendingRecords()
          }
        }

        await flushPendingRecords()

        this.progress({
          phase: 'projects',
          message: `类型 ${configuredType} 同步完成`,
          current: typeIndex + 1,
          total: config.selectedTypes.length
        })
      }

      this.db.retainRecords(retainedUids)
      this.db.finishSync(runId, 'success', counts)
      this.progress({
        phase: 'done',
        message:
          `同步完成：新增 ${counts.records} 条，自动更新 ${updatedCount} 条` +
          (skippedCount ? `，跳过 ${skippedCount} 条` : '') +
          (invalidItemIdCount ? `，${invalidItemIdCount} 条缺少 _valm_ItemID` : ''),
        current: counts.records + updatedCount,
        total: counts.records + updatedCount
      })
      return {
        ok: true,
        projectCount: counts.projects,
        recordCount: counts.records,
        updatedCount,
        imageCount: counts.images,
        skippedCount,
        invalidItemIdCount,
        duplicates: [],
        message:
          `同步完成：新增 ${counts.records} 条，自动更新 ${updatedCount} 条` +
          (skippedCount ? `，跳过 ${skippedCount} 条` : '') +
          (invalidItemIdCount ? `，${invalidItemIdCount} 条缺少 _valm_ItemID` : '')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.db.finishSync(runId, 'failed', counts, message)
      this.progress({ phase: 'error', message, current: 0, total: 0 })
      return {
        ok: false,
        projectCount: counts.projects,
        recordCount: counts.records,
        updatedCount,
        imageCount: counts.images,
        skippedCount,
        invalidItemIdCount,
        duplicates: [],
        message
      }
    } finally {
      this.running = false
    }
  }

  async applyDataReviews(batchId: string, reviewIds?: string[]): Promise<DataReviewApplyResult> {
    const pending = this.db.getPendingDataReviews(batchId, 'sync', reviewIds)
    if (!pending.length) {
      return {
        ok: true,
        source: 'sync',
        updatedCount: 0,
        imageCount: 0,
        resolvedReviewIds: [],
        errors: [],
        message: '没有需要覆盖更新的数据'
      }
    }

    const client = this.clientFactory()
    let updatedCount = 0
    let imageCount = 0
    const resolvedReviewIds: string[] = []
    const errors: string[] = []
    for (const review of pending) {
      try {
        if (!review.payload || typeof review.payload !== 'object' || Array.isArray(review.payload)) {
          throw new Error('待覆盖数据格式无效')
        }
        const candidate = review.payload as Partial<RecordInput>
        if (
          typeof candidate.uid !== 'string' ||
          typeof candidate.nodeType !== 'string' ||
          typeof candidate.itemId !== 'string' ||
          !candidate.raw || typeof candidate.raw !== 'object' || Array.isArray(candidate.raw)
        ) {
          throw new Error('待覆盖数据缺少必要字段')
        }
        const targetUid = review.existing.uid
        const raw = {
          ...(candidate.raw as JsonObject),
          _valm_Uid: targetUid,
          _valm_ItemID: review.itemId
        }
        const nodeType = String(candidate.nodeType)
        const fieldLabels = this.db.getFieldDisplayNames(nodeType, Object.keys(raw))
        const record: RecordInput = {
          uid: targetUid,
          projectId: nodeType === 'Project' ? targetUid : String(candidate.projectId ?? ''),
          nodeType,
          itemId: review.itemId,
          parentId: String(candidate.parentId ?? ''),
          name: String(candidate.name ?? targetUid),
          lastModifyTime: String(candidate.lastModifyTime ?? ''),
          raw,
          normalizedText: normalizeText(raw, fieldLabels)
        }
        this.db.upsertRecord(record)
        if (record.nodeType === 'Project') {
          this.db.upsertProject({
            uid: targetUid,
            name: record.name,
            itemId: record.itemId,
            lastModifyTime: record.lastModifyTime,
            raw
          })
        }
        const imageSync = await this.syncImages(
          client,
          targetUid,
          raw,
          review.incoming.uid
        )
        imageCount += imageSync.count
        if (JSON.stringify(imageSync.raw) !== JSON.stringify(raw)) {
          const refreshedLabels = this.db.getFieldDisplayNames(nodeType, Object.keys(imageSync.raw))
          this.db.updateRecordRawAndNormalizedText(
            targetUid,
            imageSync.raw,
            normalizeText(imageSync.raw, refreshedLabels)
          )
        }
        updatedCount += 1
        resolvedReviewIds.push(review.id)
      } catch (error) {
        errors.push(`${review.itemId}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.db.resolveDataReviews(batchId, 'sync', resolvedReviewIds)
    return {
      ok: updatedCount > 0 && errors.length === 0,
      source: 'sync',
      updatedCount,
      imageCount,
      resolvedReviewIds,
      errors: errors.slice(0, 50),
      message:
        `覆盖更新完成：${updatedCount} 条记录，${imageCount} 张图片` +
        (errors.length ? `，${errors.length} 条失败` : '')
    }
  }

  private async syncImages(
    client: VisslmClient,
    recordUid: string,
    raw: JsonObject,
    attachmentUid = recordUid
  ): Promise<{ count: number; raw: JsonObject }> {
    const candidates = new Map<string, string>()
    const description = typeof raw._valm_Description === 'string' ? raw._valm_Description : ''
    for (const source of findRichTextImageSources(description)) {
      if (!parseAssetToken(source.source)) candidates.set(source.source, '富文本图片')
    }
    const visitNonDescription = (input: unknown): void => {
      if (typeof input === 'string') {
        if (/^data:image\//i.test(input)) candidates.set(input, '内嵌图片')
        else if (imageExtension.test(input)) candidates.set(input, '图片字段')
      } else if (Array.isArray(input)) {
        input.forEach(visitNonDescription)
      } else if (input && typeof input === 'object') {
        Object.values(input as JsonObject).forEach(visitNonDescription)
      }
    }
    for (const [key, valueInput] of Object.entries(raw)) {
      if (key !== '_valm_Description') visitNonDescription(valueInput)
    }

    const attachments = await client.getAttachments(attachmentUid)
    for (const attachment of attachments) {
      const name = value(attachment, 'Name') || value(attachment, 'FileName')
      const resource = value(attachment, 'resource') || value(attachment, 'Resource')
      if (resource && imageExtension.test(name || resource)) candidates.set(resource, name)
    }

    let saved = 0
    const savedBySource = new Map<string, { id: string; sha256: string; name: string }>()
    for (const [source, name] of candidates) {
      let mimeType = 'application/octet-stream'
      const markUnresolved = (message: string): void => {
        if (name !== '富文本图片' || typeof this.db.saveUnresolvedImage !== 'function') return
        try {
          this.db.saveUnresolvedImage({
            recordUid,
            name,
            mimeType,
            sourceUrl: source,
            errorMessage: sanitizeImageErrorMessage(message)
          })
        } catch {
          // The unresolved marker is best-effort; the original HTML remains
          // un-tokenized and therefore still blocks export and push.
        }
      }
      try {
        let bytes: Buffer
        let sourceUrl = source
        if (/^data:image\//i.test(source)) {
          const match = source.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/s)
          if (!match || match[2].length % 4 === 1) {
            markUnresolved(imagePayloadDiagnostic({
              reason: '内嵌图片 Base64 格式无效',
              httpStatus: 0,
              contentType: mimeType,
              bytes: Buffer.alloc(0),
              url: 'inline:data-uri'
            }))
            continue
          }
          mimeType = match[1].toLowerCase()
          bytes = Buffer.from(match[2], 'base64')
          sourceUrl = 'inline:data-uri'
        } else {
          const downloaded = await client.download(source)
          bytes = downloaded.bytes
          mimeType = downloaded.mimeType
          sourceUrl = downloaded.sourceUrl
        }
        if (!imageBytesMatchMime(mimeType, bytes)) {
          markUnresolved(imagePayloadDiagnostic({
            reason: '图片 MIME/文件签名校验失败',
            httpStatus: 0,
            contentType: mimeType,
            bytes,
            url: sourceUrl
          }))
          continue
        }
        const savedImage = this.db.saveImage({
          recordUid,
          name,
          mimeType,
          sourceUrl,
          unresolvedSourceUrl: source,
          bytes
        })
        savedBySource.set(source, {
          id: savedImage.id,
          sha256: savedImage.sha256,
          name
        })
        saved += 1
      } catch (error) {
        // A broken or unauthorized image should not fail the whole sync.
        markUnresolved(error instanceof Error ? error.message : '图片下载失败')
      }
    }
    if (typeof description !== 'string') return { count: saved, raw }
    const tokenized = replaceRichTextImageSources(description, (source) => {
      const savedImage = savedBySource.get(source.source)
      if (!savedImage) return undefined
      const reference = this.db.saveRecordImageReference({
        recordUid,
        fieldPath: '_valm_Description',
        ordinal: source.occurrence,
        assetSha256: savedImage.sha256,
        sourceType: 'rich-text',
        sourceName: savedImage.name,
        originalSource: source.source
      })
      return `visslm-asset://${savedImage.sha256}/${reference.id}`
    })
    if (!tokenized.replacements.length) return { count: saved, raw }
    return {
      count: saved,
      raw: {
        ...raw,
        _valm_Description: tokenized.html
      }
    }
  }
}
