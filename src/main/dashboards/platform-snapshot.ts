import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AnalyticsRecord } from '../database'
import type { DataScope } from '../../shared/query-spec'
import type { FieldDefinition, SyncFieldFilter } from '../../shared/types'
import type { DashboardSpec } from '../../shared/dashboard'
import type { PlatformReader } from '../assistant/platform-analysis'
import type { PlatformCredentials } from '../assistant/platform-mcp'
import { VisslmClient, parseFieldDefinitions } from '../visslm'
import { QueryEngine } from '../analytics/query-engine'
import { throwIfAssistantRunCancelled } from '../assistant/run-controller'

interface PlatformSnapshot {
  version: 1
  id: string
  scope: DataScope
  fetchedAt: string
  completePopulation: boolean
  records: AnalyticsRecord[]
  definitions: FieldDefinition[]
}
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safeField = /^[A-Za-z_][A-Za-z0-9_.]*$/
const coreFields = ['_valm_Uid', '_valm_Name', '_valm_ItemID', '_valm_NodeType', '_valm_LastModifyTime', '_valm_ParentId']
const text = (row: Record<string, unknown>, key: string) => typeof row[key] === 'string' || typeof row[key] === 'number' ? String(row[key]) : ''
const pathFor = (root: string, id: string): string => {
  if (!isAbsolute(root) || !validId.test(id)) throw new Error('平台快照路径或标识无效')
  return join(root, `${id}.json`)
}

/** Captures only a bounded, explicitly scoped response; incomplete platform totals stay marked. */
export const capturePlatformDashboardSnapshot = async (options: {
  reader: PlatformReader
  credentials: PlatformCredentials
  nodeTypes: string[]
  scope: DataScope
  root: string
}): Promise<NonNullable<DashboardSpec['dataSource']>> => {
  const { reader, scope } = options
  const projectIds = scope.projectIds ?? []
  if (projectIds.length > 1) throw new Error('平台实时大屏当前支持单项目范围，请选择一个项目')
  const types = [...new Set((scope.nodeTypes?.length ? scope.nodeTypes : options.nodeTypes).filter(type => safeField.test(type)))]
  if (types.length > 12) throw new Error('平台数据类型超过 12 个，请缩小选择范围')
  if (!types.length) throw new Error('请先选择平台数据类型，再生成实时数据大屏')
  const compiler = new VisslmClient(options.credentials)
  const records: AnalyticsRecord[] = []
  const definitions: FieldDefinition[] = []
  let completePopulation = true
  const fetchedAt = new Date().toISOString()
  try {
    await reader.connect()
    for (const nodeType of types) {
      throwIfAssistantRunCancelled()
      const fields = parseFieldDefinitions(await reader.read('/Admin/Virtualization_ReadMember', { nodeType, proId: projectIds[0] ?? '0' }), nodeType)
      if (!fields.length) throw new Error(`平台未返回 ${nodeType} 的字段目录`)
      definitions.push(...fields)
      const known = new Set([...coreFields, ...fields.map(field => field.field).filter(field => safeField.test(field))])
      const projectField = nodeType === 'Project' ? '_valm_Uid' : ['_valm_ProjectId', '_valm_ProjectUid'].find(field => known.has(field))
      if (projectIds.length && !projectField) throw new Error(`平台类型 ${nodeType} 缺少可验证的项目关联字段`)
      if (known.size > 200) throw new Error(`平台类型 ${nodeType} 的字段超过单次安全上限，请缩小选择范围`)
      const filters: SyncFieldFilter[] = projectIds.length ? [{ id: 'scope', field: projectField!, operator: 'equals', value: projectIds[0] }] : []
      const { params } = compiler.queryItemsTrace(nodeType, filters, [...known].join(','))
      const payload = await reader.read('/rest/items', { VSearch: params.VSearch!, ReturnProperty: params.ReturnProperty! }) as Record<string, unknown>
      if (payload.ErrorCode !== undefined && Number(payload.ErrorCode) !== 0) throw new Error(`平台拒绝了 ${nodeType} 查询`)
      if (!Array.isArray(payload.propList)) throw new Error('平台响应缺少记录列表')
      completePopulation = completePopulation && payload.completePopulation === true
      for (const candidate of payload.propList) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('平台记录结构无效')
        const row = candidate as Record<string, unknown>
        const uid = text(row, '_valm_Uid'), projectId = nodeType === 'Project' ? uid : text(row, projectField ?? '_valm_ProjectId') || text(row, '_valm_ProjectUid')
        if (!uid || !projectId) throw new Error('平台记录缺少标识或项目归属，不能确认范围')
        if (projectIds.length && !projectIds.includes(projectId)) throw new Error('平台返回了范围外记录')
        if (scope.recordUids !== undefined && !scope.recordUids.includes(uid)) continue
        records.push({ uid, projectId, nodeType, itemId: text(row, '_valm_ItemID'), name: text(row, '_valm_Name'), lastModifyTime: text(row, '_valm_LastModifyTime'), raw: row })
        if (records.length > 10_000) throw new Error('平台快照超过 10000 条安全上限，请缩小范围')
      }
    }
  } finally { await reader.close() }
  const id = randomUUID()
  const snapshot: PlatformSnapshot = { version: 1, id, scope: structuredClone(scope), fetchedAt, completePopulation, records, definitions }
  const data = JSON.stringify(snapshot)
  if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error('平台快照超过 16MB 安全上限，请缩小范围')
  await mkdir(options.root, { recursive: true })
  const destination = pathFor(options.root, id), temporary = pathFor(options.root, randomUUID())
  await writeFile(temporary, data, { encoding: 'utf8', flag: 'wx' })
  await rename(temporary, destination)
  return { kind: 'platform-snapshot', snapshotId: id, fetchedAt, completePopulation, recordCount: records.length }
}

export const platformSnapshotQueryEngine = (root: string, source: NonNullable<DashboardSpec['dataSource']>): QueryEngine => {
  const filename = pathFor(root, source.snapshotId)
  if (statSync(filename).size > 16 * 1024 * 1024) throw new Error('平台快照超过安全上限')
  const snapshot = JSON.parse(readFileSync(filename, 'utf8')) as PlatformSnapshot
  if (snapshot.version !== 1 || snapshot.id !== source.snapshotId || snapshot.fetchedAt !== source.fetchedAt || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.definitions)) throw new Error('平台快照损坏或不匹配')
  const subset = (base: string[] | undefined, requested: string[] | undefined, emptyMeansAll: boolean): boolean => {
    if (base === undefined || (emptyMeansAll && !base.length)) return true
    return requested !== undefined && (!emptyMeansAll || requested.length > 0) && requested.every(value => base.includes(value))
  }
  const scan = (requested: DataScope): AnalyticsRecord[] => {
    if (!subset(snapshot.scope.projectIds, requested.projectIds, true) || !subset(snapshot.scope.nodeTypes, requested.nodeTypes, true) || !subset(snapshot.scope.recordUids, requested.recordUids, false)) throw new Error('查询范围不能超过平台快照范围')
    if (snapshot.scope.baseFilters?.some(filter => !requested.baseFilters?.some(candidate => JSON.stringify(candidate) === JSON.stringify(filter)))) throw new Error('查询不能删除平台快照的基础筛选')
    return snapshot.records.filter(row => (!requested.projectIds?.length || requested.projectIds.includes(row.projectId)) && (!requested.nodeTypes?.length || requested.nodeTypes.includes(row.nodeType)) && (requested.recordUids === undefined || requested.recordUids.includes(row.uid)))
  }
  return new QueryEngine({ scanAnalyticsRecords: scan, getFieldDefinitions: (types) => snapshot.definitions.filter(field => !types.length || (Array.isArray(types) ? types.includes(field.nodeType) : types === field.nodeType)) })
}
