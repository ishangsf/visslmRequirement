import assert from 'node:assert/strict'
import { VisslmClient } from '../src/main/visslm'

const originalFetch = globalThis.fetch
const calls: Array<{ path: string; method: string }> = []
let versionAttempts = 0
let queryAttempts = 0

try {
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url)
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    calls.push({ path: url.pathname, method })

    if (url.pathname.endsWith('/Version')) {
      versionAttempts += 1
      if (versionAttempts === 1) return new Response('busy', { status: 503 })
      return new Response(JSON.stringify('1.0.0'), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.pathname.endsWith('/DBVersion')) {
      return new Response(JSON.stringify('1'), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.pathname.endsWith('/rest/items')) {
      queryAttempts += 1
      if (queryAttempts === 1) throw new TypeError('simulated network reset')
      return new Response(JSON.stringify({
        ErrorCode: 0,
        propList: [{ _valm_Uid: 'u1', _valm_ItemID: 'i1', _valm_Name: 'Record' }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    throw new Error(`unexpected request ${method} ${url.pathname}`)
  }) as typeof fetch

  const client = new VisslmClient({
    baseUrl: 'https://example.test/alm',
    username: 'tester',
    token: 'secret'
  })
  const connection = await client.test()
  assert.equal(connection.ok, true)
  assert.equal(versionAttempts, 2, 'GET 503 should be retried once')

  const records = await client.queryItems('Project')
  assert.equal(records.length, 1)
  assert.equal(queryAttempts, 2, 'transient GET network error should be retried once')

  const post = calls.find((call) => call.method === 'POST')
  assert.equal(post, undefined, 'read-only smoke must not issue POST requests')

  console.log(JSON.stringify({
    ok: true,
    checks: [
      { name: 'http-status-backoff', attempts: versionAttempts },
      { name: 'network-error-backoff', attempts: queryAttempts },
      { name: 'read-only-methods', postRequests: post ? 1 : 0 }
    ]
  }, null, 2))
} finally {
  globalThis.fetch = originalFetch
}
