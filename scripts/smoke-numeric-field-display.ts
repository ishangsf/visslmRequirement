import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { normalizeText, SyncService, VisslmClient } from '../src/main/visslm'
import type { SyncScopeConfig } from '../src/shared/types'

const root = mkdtempSync(join(tmpdir(), 'visslm-numeric-field-display-'))
const db = new AppDatabase(join(root, 'display.db'), join(root, 'assets'))
const originalFetch = globalThis.fetch
const lookupNames = new Map([
  ['177560', 'V2.00.01.76'],
  ['177561', 'V2.00.01.77'],
  ['180198', 'V2.00.01.78'],
  ['42', 'Answer']
])
const lookupRequests: URL[] = []
const userLookupRequests: URL[] = []

const response = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response => new Response(
  typeof body === 'string' ? body : JSON.stringify(body),
  {
    status,
    headers: {
      ...(typeof body === 'string' ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders
    }
  }
)

const headerValue = (init: RequestInit | undefined, name: string): string =>
  new Headers(init?.headers).get(name) ?? ''

const authUsername = 'auth-test-user'
const authToken = 'auth-token-that-must-not-leak'
const authPassword = 'auth-password-that-must-not-leak'
const authLoginName = 'repeat-account-name-that-must-not-leak'
const authDisplayName = '鉴权后用户'
const multiLoginDisplayNames = new Map([
  ['yuanjunhe', '显示名1'],
  ['feixiaoyuan', '显示名2']
])
const authRecordFixture = [
  {
    _valm_Uid: 'auth-1',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'AUTH-1',
    _valm_Name: 'Authenticated user fixture 1',
    assignee: authLoginName,
    reviewer: authLoginName,
    owner: { key: authLoginName }
  },
  {
    _valm_Uid: 'auth-2',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'AUTH-2',
    _valm_Name: 'Authenticated user fixture 2',
    assignee: authLoginName,
    reviewer: authLoginName,
    owner: { key: authLoginName }
  },
  {
    _valm_Uid: 'auth-3',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'AUTH-3',
    _valm_Name: 'Authenticated user fixture 3',
    assignee: authLoginName,
    owner: { key: authLoginName }
  }
]
let authRecordsResponse: unknown[] = authRecordFixture

type AuthMode =
  | 'success'
  | 'login-failure'
  | 'http-500-html'
  | 'malformed-json'
  | 'ordinary-html'

let authMode: AuthMode = 'success'
let authLoginPageContentType: 'none' | 'html' = 'none'
let authLogOnCalls = 0
let authUpLogOnCalls = 0
let authActiveLogOns = 0
let authMaxConcurrentLogOns = 0
let authUserLookupAttempts: Array<{
  loginName: string
  cookie: string
  success: boolean
  url: URL
}> = []
let authUpLogOnRequests: Array<{ cookie: string; body: string }> = []

const resetAuthTrace = (): void => {
  authLogOnCalls = 0
  authUpLogOnCalls = 0
  authActiveLogOns = 0
  authMaxConcurrentLogOns = 0
  authUserLookupAttempts = []
  authUpLogOnRequests = []
}

const waitForAuthRace = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10))

const authFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith('/User/LogOn')) {
    authLogOnCalls += 1
    authActiveLogOns += 1
    authMaxConcurrentLogOns = Math.max(authMaxConcurrentLogOns, authActiveLogOns)
    await waitForAuthRace()
    authActiveLogOns -= 1
    const headers = authLoginPageContentType === 'html'
      ? { 'Content-Type': 'text/html; charset=UTF-8' }
      : {}
    return response(
      '<!doctype html><html><head><title>LogOn</title></head><body>Login</body></html>',
      200,
      { ...headers, 'Set-Cookie': 'JSESSIONID=pre-auth-session; Path=/' }
    )
  }
  if (url.pathname.endsWith('/User/UPLogOn')) {
    authUpLogOnCalls += 1
    authUpLogOnRequests.push({
      cookie: headerValue(init, 'cookie'),
      body: String(init?.body ?? '')
    })
    if (authMode === 'login-failure') {
      return response({
        ErrorCode: 1001,
        ErrorMessage: `登录失败 password=${authPassword} token=${authToken} user=${authLoginName}`
      })
    }
    return response(
      { ErrorCode: 0 },
      200,
      { 'Set-Cookie': 'JSESSIONID=authenticated-session; Path=/' }
    )
  }
  if (url.pathname.endsWith('/ssf/user/getUserByName')) {
    const loginName = url.searchParams.get('name') ?? ''
    const cookie = headerValue(init, 'cookie')
    if (authMode === 'http-500-html') {
      return response(
        `<html><body>upstream failure token=${authToken} user=${authLoginName} password=${authPassword}</body></html>`,
        500,
        { 'Content-Type': 'text/html; charset=UTF-8' }
      )
    }
    if (authMode === 'malformed-json') {
      return response(
        `{"error":"damaged token=${authToken} user=${authLoginName} password=${authPassword}`,
        200,
        { 'Content-Type': 'application/json; charset=UTF-8' }
      )
    }
    if (authMode === 'ordinary-html') {
      return response(
        `<html><body>Unexpected upstream page token=${authToken} user=${authLoginName} password=${authPassword}</body></html>`,
        200,
        { 'Content-Type': 'text/html; charset=UTF-8' }
      )
    }
    const success = cookie.includes('JSESSIONID=authenticated-session')
    authUserLookupAttempts.push({ loginName, cookie, success, url: new URL(url.toString()) })
    if (!success) {
      const headers = authLoginPageContentType === 'html'
        ? { 'Content-Type': 'text/html; charset=UTF-8' }
        : {}
      // This is deliberately HTTP 200 and can have no Content-Type: some
      // VISSLM deployments return the login page from the JSON endpoint this
      // way, so status-only error handling must not silently accept it.
      return response(
        '<html><head><title>LogOn</title></head><body>Login required</body></html>',
        200,
        headers
      )
    }
    return response({
      Data: {
        UserName: loginName,
        DisplayName: multiLoginDisplayNames.get(loginName) ?? authDisplayName
      }
    })
  }
  if (url.pathname.endsWith('/rest/application/Version')) return response('1.0')
  if (url.pathname.endsWith('/rest/application/DBVersion')) return response('1.0')
  if (url.pathname.endsWith('/Admin/Virtualization_ReadMember')) {
    return response({ ErrorCode: 0, propList: [] })
  }
  if (url.pathname.endsWith('/rest/items') && !url.pathname.includes('/id/')) {
    return response({ ErrorCode: 0, propList: authRecordsResponse })
  }
  return response({ ErrorCode: 0, propList: [] })
}

try {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/ssf/user/getUserByName')) {
      userLookupRequests.push(url)
      const loginName = url.searchParams.get('name') ?? ''
      return response({
        Data: {
          UserName: loginName,
          DisplayName: loginName === 'shunfengzhou' ? '顺丰州' : loginName
        }
      })
    }
    const lookupUid = url.searchParams.get('q._valm_Uid')
    if (lookupUid) {
      lookupRequests.push(url)
      return response({
        ErrorCode: 0,
        propList: [{ _valm_Uid: lookupUid, _valm_Name: lookupNames.get(lookupUid) ?? '' }]
      })
    }
    return response({
      ErrorCode: 0,
      propList: [{
        // Regression fixture for the production record UID 180194.  Its
        // numeric-looking description is opaque rich text, not an item UID.
        _valm_Uid: '180194',
        _valm_NodeType: 'Task',
        _valm_ItemID: 'TASK-1',
        _valm_Name: 'Numeric field task',
        _valm_Release: 177560,
        _valm_Description: '180198',
        _valm_Description_text: 'V2.00.01.78',
        reference: 177560,
        numericString: '42',
        decimal: '42.5',
        nested: { key: '177560' },
        numericArray: [177560, 177561],
        assignee: 'shunfengzhou',
        reviewer: 'shunfengzhou',
        owner: { key: 'shunfengzhou' },
        unconfiguredUser: 'other-user'
      }]
    })
  }

  const client = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: 'test-user',
    token: 'test-token',
    userPropertyKeys: ['assignee', 'reviewer', 'owner']
  })
  const trace = client.queryItemsTrace('Task', [], '_valm_Name')
  assert(trace.params.ReturnProperty.includes('assignee'))
  assert(trace.params.ReturnProperty.includes('reviewer'))
  assert(trace.params.ReturnProperty.includes('owner'))
  const records = await client.queryItems('Task', [], '_valm_Name')
  const raw = records[0]
  assert.equal(raw._valm_Uid, '180194')
  assert.equal(raw._valm_Description, '180198')
  assert.equal(raw._valm_Description_text, undefined)
  assert.equal(
    lookupRequests.filter((url) => url.searchParams.get('q._valm_Uid') === '180198').length,
    0,
    'numeric rich-text descriptions must not trigger item-name lookups'
  )
  assert.equal(raw._valm_Release, 177560)
  assert.equal(raw._valm_Release_text, 'V2.00.01.76')
  assert.equal(raw.reference, 177560)
  assert.equal(raw.reference_text, 'V2.00.01.76')
  assert.equal(raw.numericString_text, 'Answer')
  assert.equal(raw.nested && typeof raw.nested === 'object' && (raw.nested as Record<string, unknown>).key_text, 'V2.00.01.76')
  assert.deepEqual(raw.numericArray_text, ['V2.00.01.76', 'V2.00.01.77'])
  assert.equal(raw.decimal_text, undefined)
  assert.equal(raw.assignee_text, '顺丰州')
  assert.equal(raw.reviewer_text, '顺丰州')
  assert.equal((raw.owner as Record<string, unknown>).key_text, '顺丰州')
  assert.equal(raw.unconfiguredUser_text, undefined)
  assert.equal(lookupRequests.filter((url) => url.searchParams.get('q._valm_Uid') === '177560').length, 1)
  assert(lookupRequests.every((url) => url.searchParams.get('ReturnProperty') === '_valm_Uid,_valm_Name'))
  assert.equal(userLookupRequests.length, 1)
  assert.equal(userLookupRequests[0]?.searchParams.get('name'), 'shunfengzhou')

  const config: SyncScopeConfig = {
    selectedTypes: ['Task'],
    rules: [{ nodeType: 'Task', filters: [], returnProperty: '_valm_Name' }]
  }
  const fakeClient = {
    test: async () => ({ ok: true, message: 'ok' }),
    queryItemsTrace: () => ({ endpoint: 'http://example.test/alm/rest/items', params: {} }),
    queryItems: async () => records,
    getAttachments: async () => [],
    download: async () => ({ bytes: Buffer.alloc(0), mimeType: 'image/png', sourceUrl: '' })
  } as unknown as VisslmClient
  const service = new SyncService(db, () => fakeClient, () => undefined)
  const sync = await service.run(config)
  assert.equal(sync.ok, true)
  const stored = db.getRecord('180194', false)
  assert.equal(stored?.raw._valm_Description, '180198')
  assert.equal(stored?.raw._valm_Description_text, undefined)
  assert.equal(stored?.raw.reference_text, 'V2.00.01.76')
  assert.deepEqual(db.getStats().byRelease, [{ name: 'V2.00.01.76', value: 1 }])
  assert(stored?.normalizedText?.includes('reference_text: V2.00.01.76'))

  const legacyRaw = structuredClone(stored?.raw ?? {}) as Record<string, unknown>
  // Simulate a pre-fix local row.  The next sync must remove this stale
  // derived field when the real description is returned again.
  legacyRaw._valm_Description_text = 'V2.00.01.78'
  delete legacyRaw.assignee_text
  delete legacyRaw.reviewer_text
  if (legacyRaw.owner && typeof legacyRaw.owner === 'object' && !Array.isArray(legacyRaw.owner)) {
    delete (legacyRaw.owner as Record<string, unknown>).key_text
  }
  db.updateRecordRawAndNormalizedText('180194', legacyRaw, normalizeText(legacyRaw))
  const repeated = await service.run(config)
  assert.equal(repeated.ok, true)
  const refreshed = db.getRecord('180194', false)
  assert.equal(refreshed?.raw._valm_Description, '180198')
  assert.equal(refreshed?.raw._valm_Description_text, undefined)
  assert.equal(refreshed?.raw.assignee_text, '顺丰州')
  assert.equal(refreshed?.raw.reviewer_text, '顺丰州')
  assert.equal((refreshed?.raw.owner as Record<string, unknown>)?.key_text, '顺丰州')
  assert(refreshed?.normalizedText?.includes('assignee_text: 顺丰州'))

  // A token-authenticated GET can still return the platform login page with
  // HTTP 200.  Exercise the browser-compatible session recovery path with a
  // response that has no Content-Type first; a second client below covers the
  // common text/html variant as well.
  globalThis.fetch = authFetch
  const assertSanitized = (message: string): void => {
    assert(message.trim().length > 0)
    for (const secret of [authPassword, authToken, authLoginName]) {
      assert(!message.includes(secret), `auth error leaked secret ${secret}`)
    }
  }

  resetAuthTrace()
  authMode = 'success'
  authLoginPageContentType = 'none'
  const authenticatedClient = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: authUsername,
    token: authToken,
    uploadPassword: authPassword,
    userPropertyKeys: ['assignee', 'reviewer', 'owner']
  })
  const authenticatedRecords = await authenticatedClient.queryItems('Task', [], '_valm_Name')
  assert.equal(authenticatedRecords.length, authRecordFixture.length)
  assert.equal(authenticatedRecords[0]?.assignee_text, authDisplayName)
  assert.equal(authenticatedRecords[0]?.reviewer_text, authDisplayName)
  assert.equal(
    (authenticatedRecords[0]?.owner as Record<string, unknown>)?.key_text,
    authDisplayName
  )
  assert.equal(authenticatedRecords[1]?.assignee_text, authDisplayName)
  assert.equal(authenticatedRecords[1]?.reviewer_text, authDisplayName)
  assert.equal(
    (authenticatedRecords[1]?.owner as Record<string, unknown>)?.key_text,
    authDisplayName
  )
  assert.equal(authenticatedRecords[2]?.assignee_text, authDisplayName)
  assert.equal(
    (authenticatedRecords[2]?.owner as Record<string, unknown>)?.key_text,
    authDisplayName
  )
  assert.equal(authUserLookupAttempts.length, 2, 'one login-page response plus one retry')
  assert.equal(
    authUserLookupAttempts.filter((attempt) => attempt.success).length,
    1,
    'duplicate fields and records must share one successful user lookup'
  )
  assert.equal(authLogOnCalls, 1, 'concurrent user lookups must share one LogOn request')
  assert.equal(authUpLogOnCalls, 1, 'concurrent user lookups must share one UPLogOn request')
  assert.equal(authMaxConcurrentLogOns, 1, 'web login must not run concurrently')
  assert.match(authUpLogOnRequests[0]?.cookie ?? '', /JSESSIONID=pre-auth-session/)
  assert.match(
    authUserLookupAttempts.find((attempt) => attempt.success)?.cookie ?? '',
    /JSESSIONID=authenticated-session/
  )
  const tokenUserLookup = authUserLookupAttempts.find((attempt) => !attempt.success)
  const sessionUserLookup = authUserLookupAttempts.find((attempt) => attempt.success)
  assert.equal(tokenUserLookup?.url.searchParams.get('user'), authUsername)
  assert.equal(tokenUserLookup?.url.searchParams.get('ApiToken'), authToken)
  assert.equal(sessionUserLookup?.url.searchParams.has('user'), false)
  assert.equal(sessionUserLookup?.url.searchParams.has('ApiToken'), false)
  assert.equal(sessionUserLookup?.url.searchParams.has('apiToken'), false)
  assert(authUpLogOnRequests.every(({ body }) => !body.includes(authPassword)))

  resetAuthTrace()
  authMode = 'success'
  authLoginPageContentType = 'html'
  const htmlLoginClient = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: authUsername,
    token: authToken,
    uploadPassword: authPassword,
    userPropertyKeys: ['assignee']
  })
  const htmlLoginRecords = await htmlLoginClient.queryItems('Task', [], '_valm_Name')
  assert.equal(htmlLoginRecords[0]?.assignee_text, authDisplayName)
  assert.equal(authUserLookupAttempts.length, 2, 'HTML login page must also be retried')
  assert.equal(authUserLookupAttempts.filter((attempt) => attempt.success).length, 1)
  assert.equal(authLogOnCalls, 1)
  assert.equal(authUpLogOnCalls, 1)

  resetAuthTrace()
  authMode = 'success'
  authLoginPageContentType = 'none'
  authRecordsResponse = [{
    _valm_Uid: 'multi-auth-1',
    _valm_NodeType: 'Task',
    _valm_ItemID: 'MULTI-AUTH-1',
    _valm_Name: 'Multiple login values',
    RAO: 'yuanjunhe,feixiaoyuan',
    chineseComma: ' yuanjunhe， ， feixiaoyuan ',
    englishSemicolon: 'yuanjunhe; ;feixiaoyuan',
    chineseSemicolon: 'yuanjunhe；； feixiaoyuan',
    mixedSeparators: ', yuanjunhe,,；feixiaoyuan ;，',
    singleLogin: ' yuanjunhe ',
    loginArray: [' yuanjunhe ', 'feixiaoyuan'],
    objectString: { key: ' yuanjunhe, ,feixiaoyuan ' },
    objectArray: { key: ['yuanjunhe', ' feixiaoyuan '] },
    duplicateOrder: 'feixiaoyuan；yuanjunhe,,feixiaoyuan',
    emptyOnly: ' ， ;；, '
  }]
  const multiLoginKeys = [
    'RAO',
    'chineseComma',
    'englishSemicolon',
    'chineseSemicolon',
    'mixedSeparators',
    'singleLogin',
    'loginArray',
    'objectString',
    'objectArray',
    'duplicateOrder',
    'emptyOnly'
  ]
  const multiLoginClient = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: authUsername,
    token: authToken,
    uploadPassword: authPassword,
    userPropertyKeys: multiLoginKeys
  })
  const multiLoginRecords = await multiLoginClient.queryItems('Task', [], '_valm_Name')
  const multiLoginRecord = multiLoginRecords[0]
  assert.equal(multiLoginRecord?.RAO_text, '显示名1,显示名2')
  assert.equal(multiLoginRecord?.chineseComma_text, '显示名1,显示名2')
  assert.equal(multiLoginRecord?.englishSemicolon_text, '显示名1,显示名2')
  assert.equal(multiLoginRecord?.chineseSemicolon_text, '显示名1,显示名2')
  assert.equal(multiLoginRecord?.mixedSeparators_text, '显示名1,显示名2')
  assert.equal(multiLoginRecord?.singleLogin_text, '显示名1')
  assert.deepEqual(multiLoginRecord?.loginArray_text, ['显示名1', '显示名2'])
  assert.equal(
    (multiLoginRecord?.objectString as Record<string, unknown>)?.key_text,
    '显示名1,显示名2'
  )
  assert.deepEqual(
    (multiLoginRecord?.objectArray as Record<string, unknown>)?.key_text,
    ['显示名1', '显示名2']
  )
  assert.equal(multiLoginRecord?.duplicateOrder_text, '显示名2,显示名1,显示名2')
  assert.equal(multiLoginRecord?.emptyOnly_text, undefined)
  const multiLoginNames = ['yuanjunhe', 'feixiaoyuan']
  assert.deepEqual(
    [...new Set(authUserLookupAttempts.map((attempt) => attempt.loginName))].sort(),
    [...multiLoginNames].sort(),
    'only non-empty login-name segments should be queried'
  )
  for (const loginName of multiLoginNames) {
    const attempts = authUserLookupAttempts.filter((attempt) => attempt.loginName === loginName)
    assert.equal(attempts.length, 2, `${loginName} should have one token GET and one session retry`)
    assert.equal(attempts.filter((attempt) => attempt.success).length, 1)
  }
  assert.equal(authLogOnCalls, 1, 'duplicate login values must share one web login')
  assert.equal(authUpLogOnCalls, 1, 'duplicate login values must share one UPLogOn')
  authRecordsResponse = authRecordFixture

  resetAuthTrace()
  authMode = 'success'
  authLoginPageContentType = 'none'
  const noPasswordClient = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: authUsername,
    token: authToken,
    userPropertyKeys: ['assignee']
  })
  await assert.rejects(
    () => noPasswordClient.queryItems('Task', [], '_valm_Name'),
    (error: unknown) => {
      assertSanitized(error instanceof Error ? error.message : String(error))
      return true
    }
  )
  assert.equal(authLogOnCalls, 0, 'missing uploadPassword must reject before web login')
  assert.equal(authUpLogOnCalls, 0, 'missing uploadPassword must not submit UPLogOn')

  resetAuthTrace()
  authMode = 'login-failure'
  authLoginPageContentType = 'html'
  const failedLoginClient = new VisslmClient({
    baseUrl: 'http://example.test/alm',
    username: authUsername,
    token: authToken,
    uploadPassword: authPassword,
    userPropertyKeys: ['assignee', 'reviewer', 'owner']
  })
  const failedSync = await new SyncService(db, () => failedLoginClient, () => undefined).run(config)
  assert.equal(failedSync.ok, false, 'failed web login must fail synchronization')
  assertSanitized(failedSync.message)
  assert.equal(authLogOnCalls, 1)
  assert.equal(authUpLogOnCalls, 1)
  assert.equal(authUserLookupAttempts.filter((attempt) => attempt.success).length, 0)

  const assertNonLoginFailure = async (mode: AuthMode, label: string): Promise<void> => {
    resetAuthTrace()
    authMode = mode
    authLoginPageContentType = 'html'
    const queryClient = new VisslmClient({
      baseUrl: 'http://example.test/alm',
      username: authUsername,
      token: authToken,
      uploadPassword: authPassword,
      userPropertyKeys: ['assignee']
    })
    await assert.rejects(
      () => queryClient.queryItems('Task', [], '_valm_Name'),
      (error: unknown) => {
        assertSanitized(error instanceof Error ? error.message : String(error))
        return true
      },
      `${label} user lookup must reject`
    )
    assert.equal(authLogOnCalls, 0, `${label} must not open /User/LogOn`)
    assert.equal(authUpLogOnCalls, 0, `${label} must not submit /User/UPLogOn`)

    resetAuthTrace()
    const syncClient = new VisslmClient({
      baseUrl: 'http://example.test/alm',
      username: authUsername,
      token: authToken,
      uploadPassword: authPassword,
      userPropertyKeys: ['assignee']
    })
    const syncResult = await new SyncService(db, () => syncClient, () => undefined).run(config)
    assert.equal(syncResult.ok, false, `${label} must fail synchronization`)
    assertSanitized(syncResult.message)
    // Sync now refreshes the field-definition catalog before querying items,
    // so one web login is expected even though the later display-value HTTP
    // failure itself must not trigger an additional relogin.
    assert.equal(authLogOnCalls, 1, `${label} sync must perform only the field-definition login`)
    assert.equal(authUpLogOnCalls, 1, `${label} sync must submit only the field-definition login`)
  }

  await assertNonLoginFailure(
    'http-500-html',
    'HTTP 500 HTML'
  )
  await assertNonLoginFailure(
    'malformed-json',
    'HTTP 200 malformed JSON'
  )
  await assertNonLoginFailure(
    'ordinary-html',
    'HTTP 200 ordinary non-login HTML'
  )

  console.log(JSON.stringify({
    storedDisplayValue: stored?.raw.reference_text,
    nestedDisplayValue: (stored?.raw.nested as Record<string, unknown>)?.key_text,
    descriptionValue: stored?.raw._valm_Description,
    descriptionDisplayValue: stored?.raw._valm_Description_text,
    userDisplayValue: stored?.raw.assignee_text,
    refreshedUserDisplayValue: refreshed?.raw.assignee_text,
    lookupCountFor177560: lookupRequests.filter((url) => url.searchParams.get('q._valm_Uid') === '177560').length,
    userLookupCount: userLookupRequests.length,
    authenticatedUserLookupAttempts: authUserLookupAttempts.length,
    authenticatedSuccessfulUserLookups: authUserLookupAttempts.filter((attempt) => attempt.success).length,
    authenticatedLogOnCount: authLogOnCalls,
    authenticatedUpLogOnCount: authUpLogOnCalls,
    decimalSkipped: raw.decimal_text === undefined
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
  db.close()
  rmSync(root, { recursive: true, force: true })
}
