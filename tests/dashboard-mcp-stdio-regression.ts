import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const dir = resolve('artifacts/dashboard-generation-remediation')
await mkdir(dir, { recursive: true })
const snapshot = resolve(dir, 'mcp-snapshot.json')
await writeFile(snapshot, JSON.stringify({ scope: { projectIds: ['authorized'] }, records: [
  { uid: 'allowed', projectId: 'authorized', nodeType: 'Issue', itemId: 'I-1', parentId: '', name: '授权数据', lastModifyTime: '', raw: { 状态: '完成' } },
  { uid: 'denied', projectId: 'other', nodeType: 'Issue', itemId: 'I-2', parentId: '', name: '其他项目', lastModifyTime: '', raw: { 状态: '完成' } }
] }))
const child = spawn(process.execPath, [resolve('out/main/dashboard-mcp-worker.js')], { env: { ...process.env, VISSLM_DASHBOARD_SNAPSHOT_FILE: snapshot }, windowsHide: true, stdio: 'pipe' })
let id = 0
const pending = new Map<number, (value: any) => void>()
const lines = createInterface({ input: child.stdout })
lines.on('line', line => { const data = JSON.parse(line); pending.get(data.id)?.(data); pending.delete(data.id) })
const rpc = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const current = ++id; const timer = setTimeout(() => reject(new Error('MCP timeout')), 8000); pending.set(current, value => { clearTimeout(timer); resolve(value) }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n') })
try {
  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.serverInfo.name, 'visslm-dashboard-tools')
  assert.equal((await rpc('tools/list', {})).result.tools.length, 7)
  const result = await rpc('tools/call', { name: 'preview_query', arguments: { query: { source: 'records', measures: [{ id: 'n', aggregation: 'count' }] } } })
  assert.equal(result.result.structuredContent.rows[0].n, 1)
  const denied = await rpc('tools/call', { name: 'preview_query', arguments: { query: { source: 'records', scope: { projectIds: ['other'] }, measures: [{ id: 'n', aggregation: 'count' }] } } })
  assert.equal(denied.result.isError, true)
  console.log(JSON.stringify({ ok: true, checks: ['real stdio process', 'MCP initialize', 'tool discovery', 'structured output', 'scope boundary'] }))
} finally { child.stdin.end(); child.kill(); lines.close() }
