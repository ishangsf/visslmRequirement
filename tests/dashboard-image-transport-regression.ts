import assert from 'node:assert/strict'
import { ModelClient } from '../src/main/model-client'
import type { ModelSettings } from '../src/shared/types'

const original = globalThis.fetch
const image = { mimeType: 'image/png' as const, data: 'aGVsbG8=' }
try {
  for (const provider of ['ollama', 'openai', 'anthropic', 'rawchat-codex'] as const) {
    let sent: any
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(provider === 'ollama' ? { message: { role: 'assistant', content: '{}' } } : provider === 'anthropic' ? { content: [{ type: 'text', text: '{}' }] } : provider === 'rawchat-codex' ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }] } : { choices: [{ message: { role: 'assistant', content: '{}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    const settings: ModelSettings = { source: provider === 'ollama' ? 'local' : 'online', provider, baseUrl: provider === 'rawchat-codex' ? 'https://rawchat.cn/codex/v1' : 'http://test.invalid', model: 'mock', apiKey: 'fixture', thinking: false }
    await new ModelClient(settings).chat({ messages: [{ role: 'user', content: '检查渲染', images: [image] }] })
    if (provider === 'ollama') assert.deepEqual(sent.messages[0].images, [image.data])
    if (provider === 'openai') assert.equal(sent.messages[0].content[1].image_url.url, 'data:image/png;base64,' + image.data)
    if (provider === 'anthropic') assert.equal(sent.messages[0].content[1].source.data, image.data)
    if (provider === 'rawchat-codex') assert.equal(sent.input[0].content[1].image_url, 'data:image/png;base64,' + image.data)
  }
  console.log(JSON.stringify({ ok: true, providers: ['ollama', 'openai', 'anthropic', 'responses'] }))
} finally { globalThis.fetch = original }
