import type {
  ConnectionResult,
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
  constructor(private readonly credentials: Credentials) {
    if (!credentials.baseUrl || !credentials.username || !credentials.token) {
      throw new Error('请先完整配置 VISSLM 地址、用户名和 API Token')
    }
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
    if (!filters.length) {
      return {
        'q._valm_NodeType': nodeType,
        ReturnProperty: returnProperty
      }
    }

    const quote = (input: string): string => `'${input.replaceAll("'", "''")}'`
    const conditions = filters.map((filter) => {
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
    })
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
    return response.propList ?? []
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
              itemId: value(raw, '_valm_ItemID'),
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
          const uid = value(raw, '_valm_Uid')
          if (!uid) continue
          const nodeType = value(raw, '_valm_NodeType') || configuredType
          const projectId =
            nodeType === 'Project'
              ? uid
              : value(raw, '_valm_ProjectId') || value(raw, '_valm_ProjectUid')
          this.progress({
            phase: 'records',
            message: `同步 ${nodeType}：${value(raw, '_valm_Name') || uid}`,
            current: index + 1,
            total: records.length
          })

          if (nodeType === 'Project') {
            this.db.upsertProject({
              uid,
              name: value(raw, '_valm_Name') || uid,
              itemId: value(raw, '_valm_ItemID'),
              lastModifyTime: value(raw, '_valm_LastModifyTime'),
              raw
            })
            counts.projects += 1
          }

          const record: RecordInput = {
            uid,
            projectId,
            nodeType,
            itemId: value(raw, '_valm_ItemID'),
            parentId: value(raw, '_valm_ParentId'),
            name: value(raw, '_valm_Name') || uid,
            lastModifyTime: value(raw, '_valm_LastModifyTime'),
            raw,
            normalizedText: normalizeText(raw)
          }
          this.db.upsertRecord(record)
          retainedUids.push(uid)
          counts.records += 1
          counts.images += await this.syncImages(client, uid, raw)
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
        message: `同步完成：${counts.records} 条记录，${counts.images} 张图片`,
        current: counts.records,
        total: counts.records
      })
      return {
        ok: true,
        projectCount: counts.projects,
        recordCount: counts.records,
        imageCount: counts.images,
        message: '同步完成'
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
        message
      }
    } finally {
      this.running = false
    }
  }

  private async syncImages(client: VisslmClient, recordUid: string, raw: JsonObject): Promise<number> {
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

    const attachments = await client.getAttachments(recordUid)
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
