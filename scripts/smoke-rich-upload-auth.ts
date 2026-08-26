import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { VisslmClient } from '../src/main/visslm'

const BASE_URL = 'http://mock.local/alm'
const USERNAME = 'tester'
const API_TOKEN = 'api-token-test'
const UPLOAD_PASSWORD = 'upload-password-test'
const imageBytes = Buffer.from('89504e470d0a1a0a', 'hex')

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
type TestCredentials = ConstructorParameters<typeof VisslmClient>[0]

type AuthMode = 'success' | 'login-no-cookie' | 'missing-jsession' | 'login-failure' | 'login-page-once' | 'login-page-always'

const callOrder: string[] = []
let authMode: AuthMode = 'success'
let loginGetCount = 0
let loginPostCount = 0
let uploadAttemptCount = 0
let successfulUploadCount = 0
let loginPageRemaining = 0

const loginPage = '<!doctype html><html><body><form action="/User/LogOn"></form></body></html>'

const response = (
  body: string,
  options: { status?: number; contentType?: string; setCookies?: string[] } = {}
): Response => {
  const headers = new Headers({
    'content-type': options.contentType ?? 'text/html; charset=utf-8'
  })
  for (const cookie of options.setCookies ?? []) headers.append('set-cookie', cookie)
  return new Response(body, { status: options.status ?? 200, headers })
}

const urlFromInput = (input: FetchInput): URL => {
  if (typeof input === 'string' || input instanceof URL) return new URL(input.toString())
  return new URL(input.url)
}

const methodFromInput = (input: FetchInput, init: FetchInit): string => {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase()
  return 'GET'
}

const cookieValue = (cookieHeader: string, name: string): string => {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
  return match?.[1] ?? ''
}

const recordCall = (method: string, url: URL): void => {
  callOrder.push(`${method} ${url.pathname}`)
}

const assertLoginForm = (init: FetchInit): void => {
  const headers = new Headers(init?.headers)
  const cookie = headers.get('cookie') ?? ''
  assert.equal(cookieValue(cookie, 'JSESSIONID'), 'jsession-initial')
  const body = typeof init?.body === 'string' ? init.body : ''
  const form = new URLSearchParams(body)
  assert.deepEqual([...form.keys()].sort(), ['rememberPwd', 'uname', 'upassword'])
  assert.equal(form.get('rememberPwd'), 'false')
  const uname = form.get('uname') ?? ''
  const encodedUsername = Buffer.from(encodeURI(USERNAME), 'utf8')
    .toString('base64')
    .replace(/=/g, '')
  assert.match(uname, /^[0-9a-f]{6}.+[0-9A-F]{6}$/)
  assert.equal(uname.slice(6, -6), encodedUsername)
  const passwordDigest = createHash('md5')
    .update(UPLOAD_PASSWORD)
    .digest('hex')
    .toUpperCase()
  const expectedUpassword = `*${createHash('md5')
    .update(`${USERNAME.toUpperCase()}:VISSLM:${passwordDigest}`)
    .digest('hex')}`
  assert.equal(form.get('upassword'), expectedUpassword)
  assert.equal(body.includes(USERNAME), false)
  assert.equal(body.includes(UPLOAD_PASSWORD), false)
  assert.equal(body.includes(API_TOKEN), false)
}

const assertUploadForm = (init: FetchInit): void => {
  const headers = new Headers(init?.headers)
  const cookie = headers.get('cookie') ?? ''
  assert.equal(
    cookieValue(cookie, 'JSESSIONID'),
    authMode === 'login-no-cookie' ? 'jsession-initial' : 'jsession-auth'
  )
  assert.equal(cookie.includes(API_TOKEN), false)
  assert.ok(init?.body instanceof FormData)
  const form = init?.body as FormData
  const csrf = form.get('ckCsrfToken')
  assert.equal(typeof csrf, 'string')
  assert.equal(cookieValue(cookie, 'ckCsrfToken'), csrf)
  const upload = form.get('upload')
  assert.ok(upload instanceof Blob)
  assert.equal((upload as Blob).size, imageBytes.byteLength)
}

const mockFetch = async (input: FetchInput, init?: FetchInit): Promise<Response> => {
  const url = urlFromInput(input)
  const method = methodFromInput(input, init)
  recordCall(method, url)

  if (url.pathname.endsWith('/User/LogOn') && method === 'GET') {
    loginGetCount += 1
    if (authMode === 'missing-jsession') return response('<html><body>LogOn</body></html>')
    return response('<html><body>LogOn</body></html>', {
      setCookies: ['JSESSIONID=jsession-initial; Path=/']
    })
  }

  if (url.pathname.endsWith('/User/UPLogOn') && method === 'POST') {
    loginPostCount += 1
    assertLoginForm(init ?? {})
    if (authMode === 'login-failure') {
      return response(JSON.stringify({ ErrorCode: 1, ErrorMessage: '登录失败' }), {
        contentType: 'application/json; charset=utf-8'
      })
    }
    if (authMode === 'login-no-cookie') {
      return response(JSON.stringify({ ErrorCode: 0 }), {
        contentType: 'application/json; charset=utf-8'
      })
    }
    return response(JSON.stringify({ ErrorCode: 0 }), {
      contentType: 'application/json; charset=utf-8',
      setCookies: ['JSESSIONID=jsession-auth; Path=/']
    })
  }

  if (url.pathname.endsWith('/FileCenterImg/UploadRichImg') && method === 'POST') {
    uploadAttemptCount += 1
    assertUploadForm(init ?? {})
    if (authMode === 'login-page-always' || (authMode === 'login-page-once' && loginPageRemaining > 0)) {
      if (authMode === 'login-page-once') loginPageRemaining -= 1
      return response(loginPage)
    }
    successfulUploadCount += 1
    return response(
      `window.parent.CKEDITOR.tools.callFunction(0, '/alm/FileCenterImg/Index/auth-${successfulUploadCount}.png')`
    )
  }

  throw new Error(`未预期的 mock 请求 ${method} ${url.pathname}`)
}

const makeClient = (uploadPassword?: string): VisslmClient => new VisslmClient({
  baseUrl: BASE_URL,
  username: USERNAME,
  token: API_TOKEN,
  ...(uploadPassword === undefined ? {} : { uploadPassword })
} as TestCredentials)

const resetTrace = (mode: AuthMode): void => {
  callOrder.length = 0
  authMode = mode
  loginGetCount = 0
  loginPostCount = 0
  uploadAttemptCount = 0
  successfulUploadCount = 0
  loginPageRemaining = mode === 'login-page-once' ? 1 : 0
}

const input = {
  projectId: 'target-project',
  bytes: imageBytes,
  mimeType: 'image/png',
  fileName: 'auth.png'
}

const originalFetch = globalThis.fetch
globalThis.fetch = mockFetch as typeof fetch
try {
  resetTrace('success')
  const missingPasswordClient = makeClient()
  await assert.rejects(
    () => missingPasswordClient.uploadRichImage(input),
    /未配置 VISSLM 图片上传密码/
  )
  assert.deepEqual(callOrder, [])

  resetTrace('success')
  const client = makeClient(UPLOAD_PASSWORD)
  const first = await client.uploadRichImage(input)
  assert.equal(first.remotePath, 'alm/FileCenterImg/Index/auth-1.png')
  assert.deepEqual(callOrder, [
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg'
  ])
  assert.equal(loginGetCount, 1)
  assert.equal(loginPostCount, 1)
  assert.equal(uploadAttemptCount, 1)

  callOrder.length = 0
  const second = await client.uploadRichImage(input)
  assert.equal(second.remotePath, 'alm/FileCenterImg/Index/auth-2.png')
  assert.deepEqual(callOrder, ['POST /alm/FileCenterImg/UploadRichImg'])
  assert.equal(loginGetCount, 1)
  assert.equal(loginPostCount, 1)
  assert.equal(uploadAttemptCount, 2)

  resetTrace('login-no-cookie')
  const loginWithoutCookieClient = makeClient(UPLOAD_PASSWORD)
  const loginWithoutCookie = await loginWithoutCookieClient.uploadRichImage(input)
  assert.equal(loginWithoutCookie.remotePath, 'alm/FileCenterImg/Index/auth-1.png')
  assert.deepEqual(callOrder, [
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg'
  ])
  assert.equal(loginGetCount, 1)
  assert.equal(loginPostCount, 1)
  assert.equal(uploadAttemptCount, 1)

  resetTrace('login-page-once')
  const loginPageRetryClient = makeClient(UPLOAD_PASSWORD)
  const retried = await loginPageRetryClient.uploadRichImage(input)
  assert.equal(retried.remotePath, 'alm/FileCenterImg/Index/auth-1.png')
  assert.deepEqual(callOrder, [
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg',
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg'
  ])
  assert.equal(loginGetCount, 2)
  assert.equal(loginPostCount, 2)
  assert.equal(uploadAttemptCount, 2)

  resetTrace('login-page-always')
  const retryLimitClient = makeClient(UPLOAD_PASSWORD)
  await assert.rejects(
    () => retryLimitClient.uploadRichImage(input),
    /登录页面或 LogOn 页面/
  )
  assert.deepEqual(callOrder, [
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg',
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn',
    'POST /alm/FileCenterImg/UploadRichImg'
  ])
  assert.equal(loginGetCount, 2)
  assert.equal(loginPostCount, 2)
  assert.equal(uploadAttemptCount, 2)

  resetTrace('missing-jsession')
  const missingSessionClient = makeClient(UPLOAD_PASSWORD)
  await assert.rejects(
    () => missingSessionClient.uploadRichImage(input),
    /未返回 JSESSIONID/
  )
  assert.deepEqual(callOrder, ['GET /alm/User/LogOn'])
  assert.equal(loginPostCount, 0)
  assert.equal(uploadAttemptCount, 0)

  resetTrace('login-failure')
  const loginFailureClient = makeClient(UPLOAD_PASSWORD)
  await assert.rejects(
    () => loginFailureClient.uploadRichImage(input),
    /图片上传登录失败/
  )
  assert.deepEqual(callOrder, [
    'GET /alm/User/LogOn',
    'POST /alm/User/UPLogOn'
  ])
  assert.equal(uploadAttemptCount, 0)

  console.log(JSON.stringify({
    missingPasswordNetworkCalls: 0,
    firstLogin: { get: 1, post: 1, upload: 1 },
    loginWithoutCookieReuse: { get: 1, post: 1, upload: 1 },
    sessionReuseUploadCalls: 1,
    logOnRetry: { loginCycles: 2, uploadAttempts: 2 },
    retryLimit: { loginCycles: 2, uploadAttempts: 2 },
    missingJsessionUploadCalls: 0,
    loginFailureUploadCalls: 0
  }))
} finally {
  globalThis.fetch = originalFetch
}
