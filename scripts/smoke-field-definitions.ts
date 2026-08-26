import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { QueryEngine } from '../src/main/analytics/query-engine'
import { DataCenterAgent } from '../src/main/assistant/agents/data-center-agent'
import { AppDatabase } from '../src/main/database'
import {
  normalizeText,
  normalizeFieldDefinitionType,
  parseFieldDefinitions,
  SyncService,
  VisslmClient
} from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

type FieldMode = 'valid' | 'html' | 'malformed' | 'empty-json' | 'empty-body'

type FieldRequest = {
  method: string
  url: URL
  contentType: string
  cookie: string
  body: string
}

type JsonObject = Record<string, unknown>

const root = mkdtempSync(join(tmpdir(), 'visslm-field-definitions-'))
const db = new AppDatabase(join(root, 'fields.db'), join(root, 'assets'))
const originalFetch = globalThis.fetch
const fieldRequests: FieldRequest[] = []
const authRequests: Array<{ path: string; method: string; cookie: string; body: string }> = []
const progressMessages: string[] = []
const htmlFieldDefinitionMarker = 'unexpected-field-definitions-html '.repeat(200)
const malformedFieldDefinitionMarker = 'unexpected-field-definitions-malformed '.repeat(200)
const authToken = 'field-definition-token-must-not-leak'
const authPassword = 'field-definition-password-must-not-leak'

let fieldMode: FieldMode = 'valid'
let sourceDisplayName = '来源'
let fieldSessionExpiryRemaining = 0
let remoteRows: JsonObject[] = []

const jsonResponse = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=UTF-8', ...extraHeaders }
})

const textResponse = (
  body: string,
  status = 200,
  contentType = 'text/plain; charset=UTF-8',
  extraHeaders: Record<string, string> = {}
): Response => new Response(body, {
  status,
  headers: { 'Content-Type': contentType, ...extraHeaders }
})

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof URL) return new URL(input.toString())
  if (typeof input === 'string') return new URL(input)
  return new URL(input.url)
}

const requestBody = (body: BodyInit | null | undefined): string => {
  if (typeof body === 'string') return body
  if (body instanceof URLSearchParams) return body.toString()
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8')
  return body ? String(body) : ''
}

const headerValue = (init: RequestInit | undefined, name: string): string =>
  new Headers(init?.headers).get(name) ?? ''

const rawFieldRow = (input: {
  uid: string
  nodeType: string
  memberType: string
  attrType: string
  field: string
  displayName: string
  member: string
  conditionUid: string
  isSystem?: boolean
  isEdit?: boolean
  isRemove?: boolean
}): JsonObject => ({
  Uid: input.uid,
  IsEdit: input.isEdit === false ? 'False' : 'True',
  AttrType: input.attrType,
  MemberType: input.memberType,
  HideMember: input.field,
  NodeType: input.nodeType,
  IsSystem: input.isSystem ? 'True' : 'False',
  MemberConditionUid: input.conditionUid,
  MemberName: input.displayName,
  IsRemove: input.isRemove ? 'True' : 'False',
  Member: input.member
})

/**
 * The platform's response has total=0 even when rows is populated.  Keep the
 * fixture close to that response and include every supported MemberType so a
 * parser regression cannot silently drop one of the type families.
 */
const fieldRows = (): JsonObject[] => [
  rawFieldRow({
    uid: '1', nodeType: '', memberType: 'INTEGER', attrType: '整型',
    field: '_valm_Uid', displayName: 'ID', member: 'Uid', conditionUid: '1', isSystem: true
  }),
  rawFieldRow({
    uid: '2', nodeType: '', memberType: 'SINGLELINETEXT', attrType: '单行文本',
    field: '_valm_Name', displayName: '名称', member: 'Name', conditionUid: '2'
  }),
  rawFieldRow({
    uid: '3', nodeType: '', memberType: 'MULTILINETEXT', attrType: '多行文本',
    field: 'Notes', displayName: '备注', member: 'Notes', conditionUid: '3', isEdit: false
  }),
  rawFieldRow({
    uid: '17', nodeType: '', memberType: 'SINGLELINETEXT', attrType: '单行文本',
    field: '_valm_NodeType', displayName: '类型', member: 'NodeType', conditionUid: '17'
  }),
  rawFieldRow({
    uid: '4', nodeType: '', memberType: 'RICH', attrType: '富裕文本格式',
    field: '_valm_Description', displayName: '描述', member: 'Description', conditionUid: '4'
  }),
  rawFieldRow({
    uid: '5', nodeType: 'TSIssue', memberType: 'DATAENUM', attrType: '枚举',
    field: 'Priority', displayName: '优先级', member: 'item1', conditionUid: '5', isRemove: true
  }),
  rawFieldRow({
    uid: '6', nodeType: 'TSIssue', memberType: 'SYSTEMENUM', attrType: '系统枚举',
    field: 'AssignTo', displayName: '当前处理人', member: 'item2', conditionUid: '6'
  }),
  rawFieldRow({
    uid: '7', nodeType: 'TSIssue', memberType: 'LOG', attrType: '日志',
    field: 'Record', displayName: '交流记录', member: 'item3', conditionUid: '7'
  }),
  rawFieldRow({
    uid: '8', nodeType: 'TSIssue', memberType: 'FLOAT', attrType: '浮点',
    field: 'Score', displayName: '分数', member: 'item4', conditionUid: '8'
  }),
  rawFieldRow({
    uid: '9', nodeType: 'TSIssue', memberType: 'BOOL', attrType: '布尔',
    field: 'Closed', displayName: '是否关闭', member: 'item5', conditionUid: '9'
  }),
  rawFieldRow({
    uid: '10', nodeType: 'TSIssue', memberType: 'DATE', attrType: '日期',
    field: 'VisitDate', displayName: '拜访日期', member: 'item6', conditionUid: '10'
  }),
  rawFieldRow({
    uid: '11', nodeType: 'TSIssue', memberType: 'DATETIME', attrType: '时间',
    field: 'CreatedAt', displayName: '创建时间', member: 'item7', conditionUid: '11'
  }),
  rawFieldRow({
    uid: '12', nodeType: 'TSIssue', memberType: 'REFERENCE', attrType: '引用',
    field: 'Project', displayName: '项目', member: 'item8', conditionUid: '12'
  }),
  rawFieldRow({
    uid: '13', nodeType: 'TSIssue', memberType: 'RELATION', attrType: '关系',
    field: 'Related', displayName: '关联记录', member: 'item9', conditionUid: '13'
  }),
  rawFieldRow({
    uid: '14', nodeType: 'TSIssue', memberType: 'URL', attrType: '地址',
    field: 'DesignUrl', displayName: '设计地址', member: 'item10', conditionUid: '14'
  }),
  rawFieldRow({
    uid: '15', nodeType: 'TSIssue', memberType: 'SPECIALTYPE', attrType: '定制类型',
    field: 'Tags', displayName: '分析标签', member: 'item11', conditionUid: '15'
  }),
  rawFieldRow({
    uid: '16', nodeType: 'TSIssue', memberType: 'SINGLELINETEXT', attrType: '单行文本',
    field: 'Source', displayName: sourceDisplayName, member: 'item12', conditionUid: '16'
  }),
  // A row without a HideMember is metadata, not a business field.  It guards
  // against the old recursive parser turning Uid/IsEdit/AttrType into fields.
  {
    Uid: 'metadata-only',
    IsEdit: 'True',
    AttrType: 'BOOL',
    MemberType: 'BOOL',
    HideMember: '',
    NodeType: 'TSIssue',
    IsSystem: 'True',
    MemberConditionUid: 'metadata-only',
    MemberName: 'must not become a field',
    IsRemove: 'False',
    Member: 'metadata-only'
  }
]

const fieldDefinitionResponse = (): JsonObject => ({
  Extend: null,
  total: 0,
  rows: fieldRows()
})

const recordForRun = (uid: string, name: string, lastModifyTime: string): JsonObject => ({
  _valm_Uid: uid,
  _valm_NodeType: 'TSIssue',
  _valm_ItemID: `ISSUE-${uid.toUpperCase()}`,
  _valm_Name: name,
  _valm_LastModifyTime: lastModifyTime,
  Source: 'Customer',
  Priority: 'P1',
  Notes: 'A note for field-label normalization',
  Closed: false
})

const config: SyncScopeConfig = {
  selectedTypes: ['TSIssue'],
  rules: [{ nodeType: 'TSIssue', filters: [], returnProperty: 'Source,Priority,Notes,Closed' }]
}

const readDefinition = (definition: unknown): JsonObject => {
  assert.ok(definition && typeof definition === 'object')
  return definition as JsonObject
}

const assertDefinition = (
  definitions: unknown[],
  field: string,
  expected: Partial<JsonObject>
): void => {
  const definition = definitions.find((candidate) => readDefinition(candidate).field === field)
  assert.ok(definition, `missing field definition: ${field}`)
  const actual = readDefinition(definition)
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${field}.${key}`)
}

try {
  const rawResponse = { Extend: null, total: 0, rows: fieldRows() }
  const parsed = parseFieldDefinitions(rawResponse, 'TSIssue')
  const parsedRows = parsed.map(readDefinition)

  // total=0 is not a row count.  Every valid HideMember in rows is retained,
  // including the technical common fields and IsRemove=True custom fields.
  assert.equal(parsed.length, fieldRows().filter((row) => String(row.HideMember ?? '').trim()).length)
  assertDefinition(parsed, '_valm_Uid', {
    nodeType: 'TSIssue', field: '_valm_Uid', displayName: 'ID', sourceType: 'INTEGER',
    attrType: '整型', sourceUid: '1', internalMember: 'Uid', conditionUid: '1',
    isSystem: true, isEditable: true, isRemovable: false
  })
  assertDefinition(parsed, 'Priority', {
    nodeType: 'TSIssue', field: 'Priority', displayName: '优先级', sourceType: 'DATAENUM',
    attrType: '枚举', sourceUid: '5', internalMember: 'item1', conditionUid: '5',
    isSystem: false, isEditable: true, isRemovable: true
  })
  assertDefinition(parsed, 'Source', { sourceType: 'SINGLELINETEXT', attrType: '单行文本', displayName: '来源' })
  assertDefinition(parsed, '_valm_NodeType', {
    nodeType: 'TSIssue', displayName: '类型', sourceType: 'SINGLELINETEXT', internalMember: 'NodeType'
  })
  assertDefinition(parsed, 'Score', { sourceType: 'FLOAT', attrType: '浮点' })
  assertDefinition(parsed, 'Closed', { sourceType: 'BOOL', attrType: '布尔' })
  assertDefinition(parsed, 'VisitDate', { sourceType: 'DATE', attrType: '日期' })
  assertDefinition(parsed, 'CreatedAt', { sourceType: 'DATETIME', attrType: '时间' })
  assertDefinition(parsed, 'Record', { sourceType: 'LOG', attrType: '日志' })
  assertDefinition(parsed, 'AssignTo', { sourceType: 'SYSTEMENUM', attrType: '系统枚举' })
  assertDefinition(parsed, 'Project', { sourceType: 'REFERENCE', attrType: '引用' })
  assertDefinition(parsed, 'Related', { sourceType: 'RELATION', attrType: '关系' })
  assertDefinition(parsed, 'DesignUrl', { sourceType: 'URL', attrType: '地址' })
  assertDefinition(parsed, 'Tags', { sourceType: 'SPECIALTYPE', attrType: '定制类型' })
  assertDefinition(parsed, 'Notes', { sourceType: 'MULTILINETEXT', attrType: '多行文本', isEditable: false })
  assertDefinition(parsed, '_valm_Description', { sourceType: 'RICH', attrType: '富裕文本格式' })

  const supportedTypes = new Set(parsedRows.map((row) => String(row.sourceType ?? '')))
  assert.deepEqual([...supportedTypes].sort(), [
    'BOOL', 'DATAENUM', 'DATE', 'DATETIME', 'FLOAT', 'INTEGER', 'LOG',
    'MULTILINETEXT', 'REFERENCE', 'RELATION', 'RICH', 'SINGLELINETEXT',
    'SPECIALTYPE', 'SYSTEMENUM', 'URL'
  ].sort())
  const normalizedTypeBySourceType: Record<string, string> = {
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
  for (const [sourceType, normalizedType] of Object.entries(normalizedTypeBySourceType)) {
    const definition = parsedRows.find((row) => row.sourceType === sourceType)
    assert.ok(definition, `missing source type definition: ${sourceType}`)
    assert.equal(definition.normalizedType, normalizedType, `${sourceType} normalized type`)
    assert.equal(normalizeFieldDefinitionType(sourceType), normalizedType)
  }

  const parsedFieldNames = parsedRows.map((row) => String(row.field ?? ''))
  for (const bogusField of ['Uid', 'IsEdit', 'AttrType', 'MemberType', 'MemberName', 'MemberConditionUid', 'IsRemove']) {
    assert.equal(parsedFieldNames.includes(bogusField), false, `metadata key became a field: ${bogusField}`)
  }

  db.replaceFieldDefinitions(parsed)
  assert.deepEqual(db.getFieldDisplayNames('TSIssue', [
    '_valm_Uid', '_valm_Name', 'Source', 'Priority', 'Notes', 'Closed'
  ]), {
    _valm_Uid: 'ID',
    _valm_Name: '名称',
    Source: '来源',
    Priority: '优先级',
    Notes: '备注',
    Closed: '是否关闭'
  })
  assert.equal(normalizeText({ Source: 'Customer', Priority: 'P1' }, {
    Source: '来源', Priority: '优先级'
  }), '来源: Customer\n优先级: P1')

  globalThis.fetch = async (input, init): Promise<Response> => {
    const url = requestUrl(input)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const cookie = headerValue(init, 'cookie')
    const body = requestBody(init?.body)

    if (url.pathname.endsWith('/User/LogOn')) {
      authRequests.push({ path: url.pathname, method, cookie, body })
      return textResponse(
        '<!doctype html><html><head><title>LogOn</title></head><body>Login</body></html>',
        200,
        'text/html; charset=UTF-8',
        { 'Set-Cookie': 'JSESSIONID=field-definition-pre-auth; Path=/' }
      )
    }
    if (url.pathname.endsWith('/User/UPLogOn')) {
      authRequests.push({ path: url.pathname, method, cookie, body })
      return jsonResponse(
        { ErrorCode: 0 },
        200,
        { 'Set-Cookie': 'JSESSIONID=field-definition-authenticated; Path=/' }
      )
    }
    if (url.pathname.endsWith('/Admin/Virtualization_ReadMember')) {
      fieldRequests.push({
        method,
        url: new URL(url.toString()),
        contentType: headerValue(init, 'content-type'),
        cookie,
        body
      })
      if (fieldSessionExpiryRemaining > 0) {
        fieldSessionExpiryRemaining -= 1
        return jsonResponse({ ErrorCode: 999, ErrorMessage: 'field-definition session expired' })
      }
      if (fieldMode === 'html') return textResponse(`<html><body>${htmlFieldDefinitionMarker}</body></html>`, 200, 'text/html')
      if (fieldMode === 'malformed') return textResponse(`{"total":0,"rows":[${malformedFieldDefinitionMarker}`, 200, 'application/json')
      if (fieldMode === 'empty-body') return textResponse('', 200, 'application/json')
      if (fieldMode === 'empty-json') return jsonResponse({ Extend: null, total: 0, rows: [] })
      return jsonResponse(fieldDefinitionResponse())
    }
    if (url.pathname.endsWith('/rest/application/Version')) return jsonResponse({ ErrorCode: 0, Version: '1.0' })
    if (url.pathname.endsWith('/rest/application/DBVersion')) return jsonResponse({ ErrorCode: 0, DBVersion: '1.0' })
    if (url.pathname.endsWith('/rest/items/id/task-1/attachment')) return jsonResponse({ ErrorCode: 0, propList: [] })
    if (url.pathname.endsWith('/rest/items')) return jsonResponse({ ErrorCode: 0, propList: remoteRows })
    throw new Error(`Unexpected request: ${method} ${url}`)
  }

  const client = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: 'collector',
    token: authToken,
    uploadPassword: authPassword
  })
  const service = new SyncService(db, () => client, (progress) => {
    progressMessages.push(progress.message)
  })

  remoteRows = [recordForRun('task-1', 'Collected issue', 'v1')]
  const first = await service.run(config)
  assert.equal(first.ok, true)
  assert.equal(first.recordCount, 1)
  assert(fieldRequests.length >= 1)

  const firstFieldRequest = fieldRequests[0]
  assert.equal(firstFieldRequest?.method, 'POST')
  assert.match(firstFieldRequest?.contentType ?? '', /^application\/x-www-form-urlencoded/i)
  assert.deepEqual([...new URLSearchParams(firstFieldRequest?.body ?? '').entries()], [
    ['nodeType', 'TSIssue'],
    ['proId', '0']
  ])
  assert.equal(firstFieldRequest?.url.searchParams.has('user'), false)
  assert.equal(firstFieldRequest?.url.searchParams.has('ApiToken'), false)
  assert.equal(firstFieldRequest?.url.searchParams.toString(), '')
  assert.match(firstFieldRequest?.cookie ?? '', /(?:^|;\s*)JSESSIONID=field-definition-(?:pre-auth|authenticated)(?:;|$)/)
  assert.doesNotMatch(firstFieldRequest?.cookie ?? '', new RegExp(authToken))
  assert.equal(authRequests.some((request) => request.path.endsWith('/User/LogOn')), true)

  const stored = db.getRecord('task-1', false)
  assert.equal(stored?.fieldLabels?._valm_Uid, 'ID')
  assert.equal(stored?.fieldLabels?._valm_Name, '名称')
  assert.equal(stored?.fieldLabels?.Priority, '优先级')
  assert.equal(stored?.fieldLabels?.Notes, '备注')
  assert(stored?.normalizedText?.includes('名称: Collected issue'))
  assert(stored?.normalizedText?.includes('优先级: P1'))
  assert(!stored?.normalizedText?.includes('Uid: task-1'))

  // The persisted catalog must enrich field inspection without replacing the
  // observed value shapes.  Priority is deliberately declared as an enum but
  // observed as a string in the collected record, so both facts stay visible.
  const inspectedFields = db.inspectFields({ nodeType: 'TSIssue', limit: 100 })
  const inspectedPriority = inspectedFields.fields.find((field) => field.field === 'Priority')
  assert.deepEqual({
    displayName: inspectedPriority?.displayName,
    declaredType: inspectedPriority?.declaredType,
    sourceType: inspectedPriority?.sourceType,
    attrType: inspectedPriority?.attrType,
    types: inspectedPriority?.types
  }, {
    displayName: '优先级',
    declaredType: 'enum',
    sourceType: 'DATAENUM',
    attrType: '枚举',
    types: ['string']
  })

  const queryProfiles = new QueryEngine(db).profile({ nodeTypes: ['TSIssue'] })
  const priorityProfile = queryProfiles.find((profile) => profile.field === 'Priority')
  assert.deepEqual({
    inferredType: priorityProfile?.inferredType,
    declaredType: priorityProfile?.declaredType,
    sourceType: priorityProfile?.sourceType,
    attrType: priorityProfile?.attrType,
    displayName: priorityProfile?.displayName
  }, {
    inferredType: 'enum',
    declaredType: 'enum',
    sourceType: 'DATAENUM',
    attrType: '枚举',
    displayName: '优先级'
  })

  const catalog = new DataCenterAgent(db).inspectCatalog()
  const catalogPriority = catalog.fields.find((field) => field.field === 'Priority')
  assert.deepEqual({
    displayName: catalogPriority?.displayName,
    declaredType: catalogPriority?.declaredType,
    sourceType: catalogPriority?.sourceType,
    attrType: catalogPriority?.attrType,
    types: catalogPriority?.types
  }, {
    displayName: '优先级',
    declaredType: 'enum',
    sourceType: 'DATAENUM',
    attrType: '枚举',
    types: ['string']
  })

  // HTTP 999 is the platform's expired-session marker.  It is the one
  // read-only POST failure that may be replayed: exactly one fresh browser
  // login and exactly one replay should recover the catalog.
  const logOnCountBeforeRetry = authRequests.filter((request) => request.path.endsWith('/User/LogOn')).length
  const upLogOnCountBeforeRetry = authRequests.filter((request) => request.path.endsWith('/User/UPLogOn')).length
  const fieldRequestCountBeforeRetry = fieldRequests.length
  fieldSessionExpiryRemaining = 1
  fieldMode = 'valid'
  const retriedDefinitions = await client.getFieldDefinitions('TSIssue')
  assert.equal(retriedDefinitions.length, parsed.length)
  assert.equal(fieldSessionExpiryRemaining, 0)
  const retryLogOnCount = authRequests.filter((request) => request.path.endsWith('/User/LogOn')).length - logOnCountBeforeRetry
  const retryUpLogOnCount = authRequests.filter((request) => request.path.endsWith('/User/UPLogOn')).length - upLogOnCountBeforeRetry
  assert.equal(retryLogOnCount, 1)
  assert.equal(retryUpLogOnCount, 1)
  const retryFieldRequests = fieldRequests.slice(fieldRequestCountBeforeRetry)
  assert.equal(retryFieldRequests.length, 2)
  for (const request of retryFieldRequests) {
    assert.equal(request.method, 'POST')
    assert.deepEqual([...new URLSearchParams(request.body).entries()], [
      ['nodeType', 'TSIssue'],
      ['proId', '0']
    ])
    assert.match(request.cookie, /JSESSIONID=/)
  }

  const lastGoodLabels = db.getFieldDisplayNames('TSIssue', ['Source', 'Priority', '_valm_Name', 'Notes'])
  const unavailableRuns: Array<{ mode: FieldMode; result: unknown; progress: string[] }> = []
  const runWithUnavailableDefinitions = async (mode: FieldMode, uid: string): Promise<void> => {
    fieldMode = mode
    remoteRows = [recordForRun(uid, `Collected while ${mode}`, uid)]
    const progressStart = progressMessages.length
    const result = await service.run(config)
    const runProgress = progressMessages.slice(progressStart)
    unavailableRuns.push({ mode, result, progress: runProgress })
    assert.equal((result as { ok?: boolean }).ok, true, `${mode} field definitions must not abort collection`)
    assert.equal(db.getRecord(uid, false)?.name, `Collected while ${mode}`)
    assert.deepEqual(db.getFieldDisplayNames('TSIssue', ['Source', 'Priority', '_valm_Name', 'Notes']), lastGoodLabels)
    assert.equal(runProgress.some((message) => message.includes(htmlFieldDefinitionMarker)), false)
    assert.equal(runProgress.some((message) => message.includes(malformedFieldDefinitionMarker)), false)
    assert.equal(runProgress.some((message) => message.includes(authToken)), false)
    assert.equal(runProgress.some((message) => message.includes(authPassword)), false)
  }

  await runWithUnavailableDefinitions('html', 'task-2')
  await runWithUnavailableDefinitions('malformed', 'task-3')
  await runWithUnavailableDefinitions('empty-json', 'task-4')
  await runWithUnavailableDefinitions('empty-body', 'task-5')

  const unavailableMessages = unavailableRuns
    .flatMap((run) => run.progress)
    .filter((message) => message.includes('field definitions unavailable for TSIssue'))
  assert(unavailableMessages.length >= 2)
  for (const message of unavailableMessages) {
    assert.match(message, /continue collection/)
    assert(message.length < 300)
    assert(!message.includes('<html>'))
  }

  // A successful refresh is still allowed to replace the last-good catalog.
  sourceDisplayName = '客户来源'
  fieldMode = 'valid'
  remoteRows = [recordForRun('task-6', 'Collected after valid refresh', 'v6')]
  const refreshedRun = await service.run(config)
  assert.equal(refreshedRun.ok, true)
  assert.equal(db.getFieldDisplayNames('TSIssue', ['Source']).Source, '客户来源')

  console.log(JSON.stringify({
    parsedDefinitionCount: parsed.length,
    supportedMemberTypes: [...supportedTypes].sort(),
    inheritedCommonField: readDefinition(parsed.find((definition) => readDefinition(definition).field === '_valm_Uid')).nodeType,
    retainedLastGoodLabels: lastGoodLabels,
    downstreamMetadata: {
      inspectFields: inspectedPriority,
      queryProfile: priorityProfile,
      aiCatalog: catalogPriority
    },
    sessionExpiryRetry: {
      requests: retryFieldRequests.length,
      reLogins: retryLogOnCount,
      reUpLogOns: retryUpLogOnCount
    },
    postFieldRequest: {
      method: firstFieldRequest?.method,
      contentType: firstFieldRequest?.contentType,
      body: firstFieldRequest?.body,
      hasSessionCookie: /JSESSIONID=/.test(firstFieldRequest?.cookie ?? ''),
      hasApiTokenInUrl: firstFieldRequest?.url.searchParams.has('ApiToken') ?? false
    },
    unavailableModes: unavailableRuns.map((run) => ({
      mode: run.mode,
      ok: (run.result as { ok?: boolean }).ok,
      continued: run.progress.some((message) => message.includes('continue collection'))
    })),
    refreshedSourceLabel: db.getFieldDisplayNames('TSIssue', ['Source']).Source
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(root, { recursive: true, force: true })
}
