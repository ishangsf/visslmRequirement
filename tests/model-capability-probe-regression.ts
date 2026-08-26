import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'

import { ModelClient } from '../src/main/model-client'
import type { ModelCapabilityReport, ModelSettings } from '../src/shared/types'

type CapturedRequest = {
  method: string
  path: string
  body?: Record<string, unknown>
}

const captured: CapturedRequest[] = []

const readBody = async (request: IncomingMessage): Promise<Record<string, unknown> | undefined> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (!chunks.length) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const json = (response: import('node:http').ServerResponse, value: unknown, statusCode = 200): void => {
  response.statusCode = statusCode
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(value))
}

const server = createServer(async (request, response) => {
  const path = request.url ?? ''
  const method = request.method ?? 'GET'
  const body = method === 'POST' ? await readBody(request) : undefined
  captured.push({ method, path, ...(body ? { body } : {}) })

  if (path === '/online/models' && method === 'GET') {
    json(response, { data: [{ id: 'probe-online-model' }] })
    return
  }
  if (path === '/online-invalid/models' && method === 'GET') {
    json(response, { error: { message: 'api_key=probe-secret is invalid' } }, 401)
    return
  }

  const match = path.match(/^\/(supported|limited|show-fail|missing)\/api\/(tags|show|chat)$/)
  if (!match) {
    json(response, { error: 'not found' }, 404)
    return
  }
  const [, scenario, endpoint] = match
  if (endpoint === 'tags') {
    json(response, {
      models: scenario === 'missing' ? [{ name: 'another-model' }] : [{ name: 'probe-local-model' }]
    })
    return
  }
  if (endpoint === 'show') {
    if (scenario === 'show-fail') {
      json(response, { error: 'show endpoint unavailable' }, 503)
      return
    }
    json(response, scenario === 'limited'
      ? {
          capabilities: ['completion'],
          model_info: { 'probe.context_length': 4096 },
          parameters: 'num_ctx 4096'
        }
      : {
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'probe.context_length': 131072 },
          parameters: 'num_ctx 131072'
        })
    return
  }

  const format = body?.format
  const tools = body?.tools
  if (format) {
    json(response, {
      done: true,
      message: {
        role: 'assistant',
        content: scenario === 'limited' ? 'not-json' : '{"ok":true}'
      }
    })
    return
  }
  if (Array.isArray(tools) && tools.length) {
    json(response, scenario === 'limited'
      ? { done: true, message: { role: 'assistant', content: '无法调用工具' } }
      : {
          done: true,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              function: { name: 'capability_probe', arguments: { ok: true } }
            }]
          }
        })
    return
  }
  json(response, { done: true, message: { role: 'assistant', content: 'OK' } })
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const origin = `http://127.0.0.1:${address.port}`

const localSettings = (scenario: string): ModelSettings => ({
  source: 'local',
  provider: 'ollama',
  baseUrl: `${origin}/${scenario}`,
  model: 'probe-local-model',
  thinking: false
})

const requestsSince = (offset: number): CapturedRequest[] => captured.slice(offset)

const requireReport = (value: ModelCapabilityReport | undefined): ModelCapabilityReport => {
  assert.ok(value, 'expected a structured capability report')
  return value
}

const assertProbePromptsAreSafe = (requests: CapturedRequest[]): void => {
  const serialized = JSON.stringify(requests)
  assert.doesNotMatch(serialized, /UID:|recordUids|业务证据|api[_ -]?key|probe-secret/i)
  for (const request of requests.filter((item) => item.path.endsWith('/api/chat'))) {
    assert.equal(request.body?.stream, false)
    const options = request.body?.options as Record<string, unknown> | undefined
    assert.ok(Number(options?.num_predict) <= 96, 'capability probes must keep output budgets small')
  }
}

const testMetadataOnlyStartupProbe = async (): Promise<void> => {
  const start = captured.length
  const result = await new ModelClient(localSettings('supported')).test(false, true)
  assert.equal(result.ok, true)
  const report = requireReport(result.capabilityReport)
  assert.equal(report.probeMode, 'metadata')
  assert.equal(report.checks.connection.status, 'supported')
  assert.equal(report.checks.minimalChat.status, 'unknown')
  assert.equal(report.checks.structuredOutput.status, 'unknown')
  assert.equal(report.checks.toolCalling.status, 'supported')
  assert.equal(report.checks.thinking.status, 'supported')
  assert.equal(report.checks.contextWindow.status, 'supported')
  assert.equal(report.checks.contextWindow.value, 131072)
  const requests = requestsSince(start)
  assert.deepEqual(requests.map((item) => item.path), [
    '/supported/api/tags',
    '/supported/api/show'
  ])
  assert.deepEqual(requests[1]?.body, { model: 'probe-local-model', verbose: false })
}

const testFullActiveProbe = async (): Promise<void> => {
  const start = captured.length
  const result = await new ModelClient(localSettings('supported')).test(true, true)
  assert.equal(result.ok, true)
  const report = requireReport(result.capabilityReport)
  assert.equal(report.probeMode, 'active')
  assert.equal(report.checks.minimalChat.status, 'supported')
  assert.equal(report.checks.structuredOutput.status, 'supported')
  assert.equal(report.checks.structuredOutput.evidence, 'active-probe')
  assert.equal(report.checks.toolCalling.status, 'supported')
  assert.equal(report.checks.toolCalling.evidence, 'active-probe')
  const requests = requestsSince(start)
  assert.equal(requests.filter((item) => item.path.endsWith('/api/chat')).length, 3)
  assertProbePromptsAreSafe(requests)
}

const testLimitedAndUnsupportedCapabilitiesStayIsolated = async (): Promise<void> => {
  const result = await new ModelClient(localSettings('limited')).test(true, true)
  assert.equal(result.ok, true, 'capability limitations must not masquerade as a connection failure')
  const report = requireReport(result.capabilityReport)
  assert.equal(report.checks.connection.status, 'supported')
  assert.equal(report.checks.contextWindow.status, 'limited')
  assert.equal(report.checks.contextWindow.value, 4096)
  assert.equal(report.checks.thinking.status, 'unsupported')
  assert.equal(report.checks.structuredOutput.status, 'unsupported')
  assert.equal(report.checks.toolCalling.status, 'unsupported')
}

const testShowFailureDoesNotMakeTheModelOffline = async (): Promise<void> => {
  const result = await new ModelClient(localSettings('show-fail')).test(false, true)
  assert.equal(result.ok, true)
  const report = requireReport(result.capabilityReport)
  assert.equal(report.checks.connection.status, 'supported')
  assert.equal(report.checks.contextWindow.status, 'error')
  assert.equal(report.checks.toolCalling.status, 'error')
  assert.equal(report.checks.thinking.status, 'error')
  assert.equal(report.checks.minimalChat.status, 'unknown')
}

const testMissingModelStopsBeforeCapabilityAccess = async (): Promise<void> => {
  const start = captured.length
  const result = await new ModelClient(localSettings('missing')).test(false, true)
  assert.equal(result.ok, false)
  assert.equal(requireReport(result.capabilityReport).checks.connection.status, 'unsupported')
  assert.deepEqual(requestsSince(start).map((item) => item.path), ['/missing/api/tags'])
}

const testLegacyTwoArgumentBehavior = async (): Promise<void> => {
  const start = captured.length
  const result = await new ModelClient(localSettings('supported')).test(true)
  assert.equal(result.ok, true)
  assert.match(result.message, /最小问答测试通过/)
  assert.equal(result.capabilityReport, undefined)
  assert.deepEqual(requestsSince(start).map((item) => item.path), [
    '/supported/api/tags',
    '/supported/api/chat'
  ])
}

const testOnlineMetadataIsHonestAndSecretsAreRedacted = async (): Promise<void> => {
  const settings: ModelSettings = {
    source: 'online',
    provider: 'openai-compatible',
    baseUrl: `${origin}/online`,
    model: 'probe-online-model',
    thinking: true,
    apiKey: 'probe-secret'
  }
  const result = await new ModelClient(settings).test(false, true)
  assert.equal(result.ok, true)
  const report = requireReport(result.capabilityReport)
  assert.equal(report.checks.connection.evidence, 'provider-contract')
  assert.equal(report.checks.contextWindow.status, 'unknown')
  assert.equal(report.checks.thinking.status, 'unknown')
  assert.equal(report.checks.toolCalling.status, 'unknown')

  const invalid = await new ModelClient({ ...settings, baseUrl: `${origin}/online-invalid` }).test(false, true)
  assert.equal(invalid.ok, false)
  assert.doesNotMatch(invalid.message, /probe-secret/)
  assert.doesNotMatch(JSON.stringify(invalid.capabilityReport), /probe-secret/)
}

const testPublicIpcAndRendererContract = async (): Promise<void> => {
  const [shared, preload, main, renderer] = await Promise.all([
    readFile(new URL('../src/shared/types.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')
  ])
  assert.match(shared, /capabilityReport\?:\s*ModelCapabilityReport/)
  assert.match(shared, /probeCapabilities\?:\s*boolean/)
  assert.match(preload, /probeCapabilities\s*=\s*false/)
  assert.match(preload, /connections:test-model['"],\s*input,\s*probeChat,\s*probeCapabilities/)
  assert.match(main, /probeCapabilities\s*=\s*false/)
  assert.match(main, /\.test\(probeChat,\s*probeCapabilities\)/)
  assert.match(renderer, /\.testModel\(settings\.model,\s*false,\s*true\)/)
  assert.match(renderer, /testModelWithCapabilities\(input,\s*probeChat,\s*true\)/)
  assert.match(renderer, /ModelCapabilityMatrix report=\{visibleModelCapabilityReport\}/)
  assert.match(renderer, /modelCapabilityReportMatches/)
}

try {
  await testMetadataOnlyStartupProbe()
  await testFullActiveProbe()
  await testLimitedAndUnsupportedCapabilitiesStayIsolated()
  await testShowFailureDoesNotMakeTheModelOffline()
  await testMissingModelStopsBeforeCapabilityAccess()
  await testLegacyTwoArgumentBehavior()
  await testOnlineMetadataIsHonestAndSecretsAreRedacted()
  await testPublicIpcAndRendererContract()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'startup probe uses tags and show without chat generation',
      'Ollama metadata exposes tools, thinking, and context length honestly',
      'full probe validates minimal chat, JSON Schema, and exact tool arguments',
      'probe prompts are business-data-free, non-streaming, and low budget',
      'limited or unsupported capabilities do not become connection failures',
      'show metadata failure is isolated from model connectivity',
      'missing model stops before show or chat',
      'legacy two-argument test remains compatible',
      'online unknown capabilities stay unknown and secrets are redacted',
      'main, preload, shared, and renderer use the three-argument contract'
    ]
  }, null, 2))
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
