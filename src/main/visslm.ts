import type {
  ConnectionResult,
  DataReviewApplyResult,
  DataReviewItem,
  DataReviewSummary,
  PushConfig,
  PushRequestTrace,
  PushResult,
  SyncFieldFilter,
  SyncPreviewResult,
  SyncProgress,
  SyncResult,
  SyncScopeConfig
} from '../shared/types'
import { AppDatabase, type RecordInput } from './database'

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

const normalizeText = (raw: JsonObject): string => {
  const parts: string[] = []
  const visit = (input: unknown, path = ''): void => {
    if (input === null || input === undefined) return
    if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      const text = stripHtml(String(input))
      if (text && !text.startsWith('data:image/') && text.length < 100_000) {
        parts.push(path ? `${path}: ${text}` : text)
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

const userLookupValue = (input: unknown): string[] => {
  if (Array.isArray(input)) return input.flatMap(userLookupValue)
  if (typeof input === 'string' || typeof input === 'number') {
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

  private readonly userPropertyKeys: ReadonlySet<string>

  constructor(private readonly credentials: Credentials) {
    if (!credentials.baseUrl || !credentials.username || !credentials.token) {
      throw new Error('请先完整配置 VISSLM 地址、用户名和 API Token')
    }
    this.userPropertyKeys = new Set(
      (credentials.userPropertyKeys ?? []).map((key) => key.trim()).filter(Boolean)
    )
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

  private async getJson(path: string, query?: Record<string, string>): Promise<AlmResponse | unknown> {
    const response = await fetch(this.authenticatedUrl(path, query), {
      signal: AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`VISSLM HTTP ${response.status}`)
    const data = (await response.json()) as AlmResponse | unknown
    if (data && typeof data === 'object' && 'ErrorCode' in data) {
      const result = data as AlmResponse
      if (Number(result.ErrorCode) !== 0) {
        throw new Error(result.ErrorMessage || result.ErrorMsg || `VISSLM 错误 ${result.ErrorCode}`)
      }
    }
    return data
  }

  private async postJson(
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>
  ): Promise<PostJsonResult> {
    const response = await fetch(this.authenticatedUrl(path, query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
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
    return (await Promise.all(
      records.map((record) => this.resolveNumericFieldValue(record))
    )) as JsonObject[]
  }

  private async resolveNumericFieldValue(input: unknown, path = ''): Promise<unknown> {
    if (Array.isArray(input)) {
      return Promise.all(input.map((item) => this.resolveNumericFieldValue(item, path)))
    }
    if (!input || typeof input !== 'object') return input

    const source = input as JsonObject
    const result: JsonObject = {}
    for (const [key, current] of Object.entries(source)) {
      if (key.endsWith('_text')) {
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
            const texts = await Promise.all(
              numericValues.map((value) => this.lookupItemName(value))
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

    const names = await Promise.all(values.map((value) => this.lookupUserDisplayName(value)))
    if (!names.some(Boolean)) return

    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const object = result[key]
      const resolved = object && typeof object === 'object' && !Array.isArray(object)
        ? object as JsonObject
        : { ...(input as JsonObject) }
      if (Object.prototype.hasOwnProperty.call(input, 'key')) {
        resolved.key_text = Array.isArray((input as JsonObject).key) ? names : names[0]
        result[key] = resolved
        return
      }
    }

    result[textKey] = Array.isArray(input) ? names : names[0]
  }

  private async lookupItemName(uid: string): Promise<string> {
    if (this.itemNameCache.has(uid)) return this.itemNameCache.get(uid) ?? ''
    const pending = this.itemNameRequests.get(uid)
    if (pending) return pending

    const request = this.getJson('/rest/items', {
      ReturnProperty: '_valm_Uid,_valm_Name',
      'q._valm_Uid': uid
    })
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

    const request = this.getJson('/ssf/user/getUserByName', { name: loginName })
      .then((data) => {
        const name = findUserDisplayName(data, loginName)
        this.userDisplayNameCache.set(loginName, name)
        return name
      })
      .catch(() => {
        this.userDisplayNameCache.set(loginName, '')
        return ''
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
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    return {
      bytes,
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
      sourceUrl: this.redactUrl(url)
    }
  }

  private redactUrl(url: URL): string {
    const safe = new URL(url)
    safe.searchParams.delete('ApiToken')
    safe.searchParams.delete('apiToken')
    safe.searchParams.delete('UToken')
    safe.searchParams.delete('utoken')
    return safe.toString()
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
    const forbiddenBodyFields = new Set([
      '_valm_Uid',
      '_valm_ItemID',
      '_valm_NodeType'
    ])
    const sourceFields = new Set<string>()
    const targetFields = new Set<string>()
    for (const mapping of mappings) {
      if (!mapping.sourceField || !mapping.targetField) {
        throw new Error('字段映射的源属性 Key 和目标属性 Key 均不能为空')
      }
      if (!identifierPattern.test(mapping.sourceField)) {
        throw new Error(`源属性 Key ${mapping.sourceField} 格式无效`)
      }
      if (!identifierPattern.test(mapping.targetField)) {
        throw new Error(`目标属性 Key ${mapping.targetField} 格式无效`)
      }
      if (forbiddenBodyFields.has(mapping.targetField)) {
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
      const body = { ...detail.raw }
      for (const mapping of mappings) {
        if (Object.prototype.hasOwnProperty.call(detail.raw, mapping.sourceField)) {
          body[mapping.targetField] = detail.raw[mapping.sourceField]
          if (mapping.sourceField !== mapping.targetField) {
            delete body[mapping.sourceField]
          }
        }
      }
      for (const field of forbiddenBodyFields) delete body[field]
      if (!body._valm_Name) body._valm_Name = detail.name
      return {
        id: index + 1,
        recordUid: detail.uid,
        recordName: detail.name,
        method: 'POST' as const,
        endpoint: client.createItemEndpoint(),
        params: client.createItemTraceParams(params),
        body
      }
    })

    if (!execute) {
      return {
        preview: true,
        total: requests.length,
        successCount: 0,
        failedCount: 0,
        requests: requests.map((request) => ({
          ...request,
          response: { preview: true, message: '请求预览，未向真实平台发送 POST' }
        }))
      }
    }

    return this.execute(client, requests)
  }

  private async execute(
    client: VisslmClient,
    requests: PushRequestTrace[]
  ): Promise<PushResult> {
    let successCount = 0
    let failedCount = 0
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
      try {
        const created = await client.createItem(params, request.body)
        const response = created.data
        const result = response as AlmResponse
        const pushedUid =
          value(result.propList?.[0] ?? {}, '_valm_Uid') ||
          value(result.props ?? result.prop ?? {}, '_valm_Uid')
        this.db.finishPushLog(logId, 'success', {
          httpStatus: created.httpStatus,
          response,
          remoteUid: pushedUid
        })
        this.db.markPushResult(request.recordUid, 'success', '推送成功', pushedUid)
        completed.push({ ...request, response })
        successCount += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.db.finishPushLog(logId, 'failed', {
          httpStatus: error instanceof VisslmRequestError ? error.httpStatus : 0,
          response: error instanceof VisslmRequestError ? error.response : undefined,
          errorMessage: message
        })
        this.db.markPushResult(request.recordUid, 'failed', message)
        completed.push({ ...request, error: message })
        failedCount += 1
      }
    }
    return {
      preview: false,
      total: requests.length,
      successCount,
      failedCount,
      requests: completed
    }
  }
}

export class SyncService {
  private running = false

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
    const retainedUids: string[] = []
    const duplicates: DataReviewItem[] = []
    const stagedItemIds = new Set<string>()
    let skippedCount = 0
    let invalidItemIdCount = 0
    const reviewBatchId = `sync:${runId}`
    const summary = (record: {
      uid: string
      projectId: string
      nodeType: string
      name: string
      lastModifyTime: string
    }): DataReviewSummary => ({
      uid: record.uid,
      projectId: record.projectId,
      nodeType: record.nodeType,
      name: record.name,
      lastModifyTime: record.lastModifyTime
    })
    try {
      const client = this.clientFactory()
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
          const record: RecordInput = {
            uid,
            projectId,
            nodeType,
            itemId,
            parentId: value(raw, '_valm_ParentId'),
            name,
            lastModifyTime,
            raw: normalizedRaw,
            normalizedText: normalizeText(normalizedRaw)
          }
          this.progress({
            phase: 'records',
            message: `校验 ${nodeType}：${name}`,
            current: index + 1,
            total: records.length
          })

          const existing = this.db.findRecordByItemId(itemId)
          if (existing) {
            retainedUids.push(existing.uid)
            skippedCount += 1
            if (!stagedItemIds.has(itemId)) {
              duplicates.push(this.db.stageDataReview({
                batchId: reviewBatchId,
                source: 'sync',
                itemId,
                existing: summary(existing),
                incoming: summary(record),
                payload: record
              }))
              stagedItemIds.add(itemId)
            }
            this.progress({
              phase: 'records',
              message: `跳过已存在的 _valm_ItemID：${itemId}`,
              current: index + 1,
              total: records.length
            })
            continue
          }

          if (nodeType === 'Project') {
            this.db.upsertProject({
              uid,
              name,
              itemId,
              lastModifyTime,
              raw: normalizedRaw
            })
            counts.projects += 1
          }

          this.db.upsertRecord(record)
          retainedUids.push(uid)
          counts.records += 1
          counts.images += await this.syncImages(client, uid, normalizedRaw)
        }

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
          `同步完成：新增 ${counts.records} 条记录，跳过 ${skippedCount} 条` +
          (duplicates.length ? `，发现 ${duplicates.length} 条已有数据待审查` : '') +
          (invalidItemIdCount ? `，${invalidItemIdCount} 条缺少 _valm_ItemID` : ''),
        current: counts.records,
        total: counts.records
      })
      return {
        ok: true,
        projectCount: counts.projects,
        recordCount: counts.records,
        imageCount: counts.images,
        skippedCount,
        invalidItemIdCount,
        ...(duplicates.length ? { reviewBatchId } : {}),
        duplicates,
        message:
          `同步完成：新增 ${counts.records} 条，跳过 ${skippedCount} 条` +
          (duplicates.length ? `，发现 ${duplicates.length} 条已有数据待审查` : '') +
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
        imageCount: counts.images,
        skippedCount,
        invalidItemIdCount,
        duplicates,
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
        const record: RecordInput = {
          uid: targetUid,
          projectId: candidate.nodeType === 'Project' ? targetUid : String(candidate.projectId ?? ''),
          nodeType: String(candidate.nodeType),
          itemId: review.itemId,
          parentId: String(candidate.parentId ?? ''),
          name: String(candidate.name ?? targetUid),
          lastModifyTime: String(candidate.lastModifyTime ?? ''),
          raw,
          normalizedText: String(candidate.normalizedText ?? '')
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
        imageCount += await this.syncImages(
          client,
          targetUid,
          raw,
          review.incoming.uid
        )
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
  ): Promise<number> {
    const candidates = new Map<string, string>()
    const visit = (input: unknown): void => {
      if (typeof input === 'string') {
        for (const match of input.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
          candidates.set(match[1], '富文本图片')
        }
        if (input.startsWith('data:image/')) candidates.set(input, '内嵌图片')
        else if (imageExtension.test(input)) candidates.set(input, '图片字段')
      } else if (Array.isArray(input)) {
        input.forEach(visit)
      } else if (input && typeof input === 'object') {
        Object.values(input as JsonObject).forEach(visit)
      }
    }
    visit(raw)

    const attachments = await client.getAttachments(attachmentUid)
    for (const attachment of attachments) {
      const name = value(attachment, 'Name') || value(attachment, 'FileName')
      const resource = value(attachment, 'resource') || value(attachment, 'Resource')
      if (resource && imageExtension.test(name || resource)) candidates.set(resource, name)
    }

    let saved = 0
    for (const [source, name] of candidates) {
      try {
        let bytes: Buffer
        let mimeType: string
        let sourceUrl = source
        if (source.startsWith('data:image/')) {
          const match = source.match(/^data:([^;]+);base64,(.+)$/s)
          if (!match) continue
          mimeType = match[1]
          bytes = Buffer.from(match[2], 'base64')
          sourceUrl = 'inline:data-uri'
        } else {
          const downloaded = await client.download(source)
          bytes = downloaded.bytes
          mimeType = downloaded.mimeType
          sourceUrl = downloaded.sourceUrl
        }
        if (!mimeType.startsWith('image/') && !imageExtension.test(name || source)) continue
        this.db.saveImage({ recordUid, name, mimeType, sourceUrl, bytes })
        saved += 1
      } catch {
        // A broken or unauthorized image should not fail the whole sync.
      }
    }
    return saved
  }
}
