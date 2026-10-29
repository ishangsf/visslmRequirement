import { createInterface } from 'node:readline'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { QueryEngine } from '../analytics/query-engine'
import { DashboardGenerationSession } from './generation-tools'
import type { AnalyticsRecord } from '../database'
import type { DataScope, FieldProfile } from '../../shared/query-spec'

// Optional local MCP stdio transport. The host supplies a bounded snapshot;
// model tools cannot select paths, credentials or an application database.
const filename = process.env.VISSLM_DASHBOARD_SNAPSHOT_FILE
if (!filename || !isAbsolute(filename) || statSync(filename).size > 16 * 1024 * 1024) throw new Error('需要宿主提供有效且不超过 16MB 的快照文件')
const input = JSON.parse(readFileSync(filename, 'utf8')) as { records: AnalyticsRecord[]; scope: DataScope; profiles?: FieldProfile[] }
if (!Array.isArray(input.records) || !input.scope || input.records.some(row => !row.uid || !row.projectId || !row.nodeType || !row.raw)) throw new Error('快照结构无效')
const authorized = input.records.filter(row => (!input.scope.projectIds?.length || input.scope.projectIds.includes(row.projectId)) && (!input.scope.nodeTypes?.length || input.scope.nodeTypes.includes(row.nodeType)) && (input.scope.recordUids === undefined || input.scope.recordUids.includes(row.uid)))
const engine = new QueryEngine({ scanAnalyticsRecords: () => authorized, ...(input.profiles ? { getFieldProfiles: () => input.profiles! } : {}) })
const session = new DashboardGenerationSession(engine, input.scope)
let initialized = false
let queue = Promise.resolve()
const lines = createInterface({ input: process.stdin })
lines.on('line', line => {
  queue = queue.then(async () => {
    try {
      if (line.length > 2_000_000) throw new Error('请求超出大小限制')
      const request = JSON.parse(line)
      if (request.method === 'initialize') initialized = true
      if (!initialized) throw new Error('必须先初始化 MCP')
      const response = await session.handle(request)
      if (response && request.id !== undefined) process.stdout.write(JSON.stringify(response) + '\n')
    } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: String(error) } }) + '\n') }
  })
})
