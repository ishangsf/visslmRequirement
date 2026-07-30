import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChatSource,
  CollectionRequestLogPage,
  CollectionRequestLogRow,
  CollectionRequestLogStatus,
  DataDeleteResult,
  DataImportResult,
  DashboardStats,
  ImageAsset,
  ProjectRow,
  PushLogPage,
  PushLogRow,
  PushLogStatus,
  RecordDetail,
  RecordPage,
  RecordQuery,
  RecordRow,
  SyncRun
} from '../shared/types'
import type { DataScope } from '../shared/query-spec'
import type {
  DashboardSaveInput,
  DashboardSpec,
  DashboardSummary,
  DashboardVersion,
  VisualizationRun,
  VisualizationRunInput
} from '../shared/dashboard'

export interface RecordInput {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  parentId: string
  name: string
  lastModifyTime: string
  raw: Record<string, unknown>
  normalizedText: string
}

export interface ImageInput {
  recordUid: string
  name: string
  mimeType: string
  sourceUrl: string
  bytes: Buffer
}

type SqlRow = Record<string, unknown>

const nowIso = (): string => new Date().toISOString()

export interface FieldAggregateOptions {
  field: string
  projectId?: string
  nodeType?: string
  limit?: number
  splitMultiValue?: boolean
}

export interface FieldAggregateResult {
  field: string
  totalRecords: number
  matchedRecords: number
  emptyRecords: number
  valueOccurrences: number
  splitMultiValue: boolean
  items: Array<{
    name: string
    value: number
    examples: Array<{ source: ChatSource }>
  }>
}

export interface FieldInspectionOptions {
  projectId?: string
  nodeType?: string
  search?: string
  limit?: number
}

export interface FieldInspectionResult {
  totalRecords: number
  fields: Array<{
    field: string
    nonEmptyRecords: number
    coverageRate: number
    types: string[]
    samples: string[]
  }>
}

export type FieldQueryOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_empty'
  | 'not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'

export interface FieldQueryFilter {
  field: string
  operator: FieldQueryOperator
  value?: string
}

export interface FieldQueryOptions {
  projectId?: string
  nodeType?: string
  search?: string
  searchTerms?: string[]
  searchMode?: 'any' | 'all'
  filters?: FieldQueryFilter[]
  fields?: string[]
  sort?: { field: string; direction: 'asc' | 'desc' }
  limit?: number
}

export interface FieldQueryResult {
  totalScanned: number
  matchedCount: number
  returnedCount: number
  fields: string[]
  records: Array<{
    source: ChatSource
    values: Record<string, string | string[]>
  }>
}

export interface AnalyticsRecord {
  uid: string
  projectId: string
  nodeType: string
  itemId: string
  name: string
  lastModifyTime: string
  raw: Record<string, unknown>
}

const fieldValuesAtPath = (raw: Record<string, unknown>, fieldPath: string): unknown[] => {
  const direct = raw[fieldPath]
  if (direct !== undefined) return [direct]

  const segments = fieldPath.split('.').map((segment) => segment.trim()).filter(Boolean)
  const descend = (current: unknown, remaining: string[]): unknown[] => {
    if (!remaining.length) return [current]
    if (Array.isArray(current)) {
      return current.flatMap((item) => descend(item, remaining))
    }
    if (!current || typeof current !== 'object') return []
    const object = current as Record<string, unknown>
    const [segment, ...rest] = remaining
    const actualKey = Object.keys(object).find(
      (key) => key.localeCompare(segment, undefined, { sensitivity: 'accent' }) === 0
    )
    return actualKey ? descend(object[actualKey], rest) : []
  }
  return descend(raw, segments)
}

const scalarFieldValues = (value: unknown): string[] => {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(scalarFieldValues)
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    for (const key of ['name', 'Name', 'label', 'Label', 'value', 'Value']) {
      if (object[key] !== undefined) return scalarFieldValues(object[key])
    }
    return []
  }
  const text = String(value).trim()
  return text ? [text] : []
}

const normalizedFieldValues = (value: unknown, splitMultiValue: boolean): string[] => {
  const values = scalarFieldValues(value).flatMap((item) =>
    splitMultiValue ? item.split(/[，,；;\n\r、|]+/) : [item]
  )
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))]
}

const dateLikePattern =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/

const scalarType = (value: unknown): string => {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  if (
    typeof value === 'string' &&
    dateLikePattern.test(value.trim()) &&
    Number.isFinite(Date.parse(value))
  ) return 'date'
  return typeof value
}

const collectRecordFieldValues = (
  input: Record<string, unknown>,
  maxDepth = 3
): Map<string, unknown[]> => {
  const collected = new Map<string, unknown[]>()
  const add = (path: string, value: unknown): void => {
    const values = collected.get(path) ?? []
    values.push(value)
    collected.set(path, values)
  }
  const visit = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      const scalarItems = value.filter(
        (item) => item === null || typeof item !== 'object'
      )
      if (scalarItems.length) add(path, scalarItems)
      if (depth < maxDepth) {
        value
          .filter((item) => item && typeof item === 'object')
          .forEach((item) => visit(item, path, depth + 1))
      }
      return
    }
    if (typeof value === 'object') {
      if (depth >= maxDepth) return
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1)
      }
      return
    }
    add(path, value)
  }
  visit(input, '', 0)
  return collected
}

const comparisonValue = (value: string): number | string => {
  const numeric = Number(value)
  if (value.trim() && Number.isFinite(numeric)) return numeric
  if (dateLikePattern.test(value.trim())) {
    const date = Date.parse(value)
    if (Number.isFinite(date)) return date
  }
  return value.toLocaleLowerCase()
}

const matchesFieldFilter = (values: string[], filter: FieldQueryFilter): boolean => {
  if (filter.operator === 'is_empty') return values.length === 0
  if (filter.operator === 'not_empty') return values.length > 0
  if (!values.length) return false
  const expected = String(filter.value ?? '').trim()
  const expectedLower = expected.toLocaleLowerCase()
  if (filter.operator === 'equals') {
    return values.some((value) => value.toLocaleLowerCase() === expectedLower)
  }
  if (filter.operator === 'not_equals') {
    return values.every((value) => value.toLocaleLowerCase() !== expectedLower)
  }
  if (filter.operator === 'contains') {
    return values.some((value) => value.toLocaleLowerCase().includes(expectedLower))
  }
  if (filter.operator === 'not_contains') {
    return values.every((value) => !value.toLocaleLowerCase().includes(expectedLower))
  }
  const right = comparisonValue(expected)
  return values.some((value) => {
    const left = comparisonValue(value)
    if (typeof left !== typeof right) return false
    if (filter.operator === 'gt') return left > right
    if (filter.operator === 'gte') return left >= right
    if (filter.operator === 'lt') return left < right
    return left <= right
  })
}

const fieldSearchTerms = (search?: string): string[] => {
  const input = search?.trim().toLocaleLowerCase()
  if (!input) return []
  const terms = [input]
  const aliases: Array<[RegExp, string[]]> = [
    [/负责人|责任人|处理人/, ['assigned', 'assignee', 'owner', 'username']],
    [/来源|来源单位/, ['source']],
    [/状态/, ['state', 'status']],
    [/版本|发布/, ['release', 'version']],
    [/创建时间/, ['createtime', 'created']],
    [/修改时间|更新时间/, ['lastmodifytime', 'updated']],
    [/操作人|执行人|活动人/, ['record.username', 'username']]
  ]
  for (const [pattern, mapped] of aliases) {
    if (pattern.test(input)) terms.push(...mapped)
  }
  return [...new Set(terms)]
}

export class AppDatabase {
  private readonly db: DatabaseSync
  private readonly assetDir: string

  constructor(databasePath: string, assetDir: string) {
    mkdirSync(assetDir, { recursive: true })
    this.assetDir = assetDir
    this.db = new DatabaseSync(databasePath)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        uid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        item_id TEXT NOT NULL DEFAULT '',
        last_modify_time TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '{}',
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS records (
        uid TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        node_type TEXT NOT NULL DEFAULT '',
        item_id TEXT NOT NULL DEFAULT '',
        parent_id TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        last_modify_time TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL,
        normalized_text TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        synced_at TEXT NOT NULL,
        push_status TEXT NOT NULL DEFAULT 'pending',
        push_message TEXT NOT NULL DEFAULT '',
        pushed_at TEXT NOT NULL DEFAULT '',
        pushed_uid TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_records_project ON records(project_id);
      CREATE INDEX IF NOT EXISTS idx_records_type ON records(node_type);
      CREATE INDEX IF NOT EXISTS idx_records_parent ON records(parent_id);
      CREATE INDEX IF NOT EXISTS idx_records_modify ON records(last_modify_time);

      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        record_uid TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        source_url TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        base64_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(record_uid, sha256),
        FOREIGN KEY(record_uid) REFERENCES records(uid) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_images_record ON images(record_uid);
      CREATE INDEX IF NOT EXISTS idx_images_hash ON images(sha256);

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        project_count INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        image_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS push_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        record_uid TEXT NOT NULL DEFAULT '',
        record_name TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT 'POST',
        endpoint TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        body_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'sending',
        http_status INTEGER NOT NULL DEFAULT 0,
        response_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        remote_uid TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_push_logs_created ON push_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_push_logs_record ON push_logs(record_uid);
      CREATE INDEX IF NOT EXISTS idx_push_logs_status ON push_logs(status);

      CREATE TABLE IF NOT EXISTS collection_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_type TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL DEFAULT 'GET',
        endpoint TEXT NOT NULL DEFAULT '',
        params_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'running',
        http_status INTEGER NOT NULL DEFAULT 0,
        record_count INTEGER NOT NULL DEFAULT 0,
        response_json TEXT NOT NULL DEFAULT '',
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_collection_logs_created
        ON collection_request_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_collection_logs_status
        ON collection_request_logs(status);

      CREATE TABLE IF NOT EXISTS dashboards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL,
        current_version INTEGER NOT NULL,
        component_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dashboard_versions (
        dashboard_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        spec_json TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(dashboard_id, version),
        FOREIGN KEY(dashboard_id) REFERENCES dashboards(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_dashboards_updated ON dashboards(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dashboard_versions_created
        ON dashboard_versions(dashboard_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS visualization_runs (
        id TEXT PRIMARY KEY,
        dashboard_id TEXT NOT NULL DEFAULT '',
        request_summary TEXT NOT NULL DEFAULT '',
        model_name TEXT NOT NULL DEFAULT '',
        prompt_version TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        component_count INTEGER NOT NULL DEFAULT 0,
        query_count INTEGER NOT NULL DEFAULT 0,
        duration_ms REAL NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_visualization_runs_created
        ON visualization_runs(created_at DESC);
    `)

    for (const statement of [
      "ALTER TABLE records ADD COLUMN push_status TEXT NOT NULL DEFAULT 'pending'",
      "ALTER TABLE records ADD COLUMN push_message TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE records ADD COLUMN pushed_at TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE records ADD COLUMN pushed_uid TEXT NOT NULL DEFAULT ''"
    ]) {
      try {
        this.db.exec(statement)
      } catch {
        // Existing databases may already contain the migration column.
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_records_push_status ON records(push_status)')

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          name,
          item_id,
          node_type,
          normalized_text,
          content='records',
          content_rowid='rowid',
          tokenize='trigram'
        );
      `)
    } catch {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
          name,
          item_id,
          node_type,
          normalized_text,
          content='records',
          content_rowid='rowid'
        );
      `)
    }

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS records_ai AFTER INSERT ON records BEGIN
        INSERT INTO records_fts(rowid, name, item_id, node_type, normalized_text)
        VALUES (new.rowid, new.name, new.item_id, new.node_type, new.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_ad AFTER DELETE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, name, item_id, node_type, normalized_text)
        VALUES ('delete', old.rowid, old.name, old.item_id, old.node_type, old.normalized_text);
      END;
      CREATE TRIGGER IF NOT EXISTS records_au AFTER UPDATE ON records BEGIN
        INSERT INTO records_fts(records_fts, rowid, name, item_id, node_type, normalized_text)
        VALUES ('delete', old.rowid, old.name, old.item_id, old.node_type, old.normalized_text);
        INSERT INTO records_fts(rowid, name, item_id, node_type, normalized_text)
        VALUES (new.rowid, new.name, new.item_id, new.node_type, new.normalized_text);
      END;
    `)
  }

  close(): void {
    this.db.close()
  }

  listDashboards(): DashboardSummary[] {
    return this.db.prepare(`
      SELECT id, title, subtitle, theme, current_version, component_count, created_at, updated_at
      FROM dashboards
      ORDER BY updated_at DESC
    `).all().map((row) => {
      const value = row as SqlRow
      return {
        id: String(value.id),
        title: String(value.title),
        subtitle: String(value.subtitle),
        theme: String(value.theme) as DashboardSummary['theme'],
        currentVersion: Number(value.current_version),
        componentCount: Number(value.component_count),
        createdAt: String(value.created_at),
        updatedAt: String(value.updated_at)
      }
    })
  }

  getDashboard(id: string, version?: number): DashboardVersion | null {
    const row = version === undefined
      ? this.db.prepare(`
          SELECT v.dashboard_id, v.version, v.spec_json, v.change_summary, v.created_at
          FROM dashboard_versions v
          JOIN dashboards d ON d.id = v.dashboard_id AND d.current_version = v.version
          WHERE v.dashboard_id = ?
        `).get(id)
      : this.db.prepare(`
          SELECT dashboard_id, version, spec_json, change_summary, created_at
          FROM dashboard_versions
          WHERE dashboard_id = ? AND version = ?
        `).get(id, version)
    if (!row) return null
    const value = row as SqlRow
    return {
      dashboardId: String(value.dashboard_id),
      version: Number(value.version),
      spec: JSON.parse(String(value.spec_json)) as DashboardSpec,
      changeSummary: String(value.change_summary),
      createdAt: String(value.created_at)
    }
  }

  listDashboardVersions(id: string): DashboardVersion[] {
    return this.db.prepare(`
      SELECT dashboard_id, version, spec_json, change_summary, created_at
      FROM dashboard_versions
      WHERE dashboard_id = ?
      ORDER BY version DESC
    `).all(id).map((row) => {
      const value = row as SqlRow
      return {
        dashboardId: String(value.dashboard_id),
        version: Number(value.version),
        spec: JSON.parse(String(value.spec_json)) as DashboardSpec,
        changeSummary: String(value.change_summary),
        createdAt: String(value.created_at)
      }
    })
  }

  saveDashboard(input: DashboardSaveInput): DashboardVersion {
    const timestamp = nowIso()
    const existing = this.db.prepare(
      'SELECT current_version, created_at FROM dashboards WHERE id = ?'
    ).get(input.spec.id) as SqlRow | undefined
    const version = existing ? Number(existing.current_version) + 1 : 1
    const spec: DashboardSpec = { ...input.spec, updatedAt: timestamp }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO dashboards (
          id, title, subtitle, theme, current_version, component_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          subtitle = excluded.subtitle,
          theme = excluded.theme,
          current_version = excluded.current_version,
          component_count = excluded.component_count,
          updated_at = excluded.updated_at
      `).run(
        spec.id,
        spec.title,
        spec.subtitle,
        spec.theme,
        version,
        spec.components.length,
        existing ? String(existing.created_at) : timestamp,
        timestamp
      )
      this.db.prepare(`
        INSERT INTO dashboard_versions (
          dashboard_id, version, spec_json, change_summary, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        spec.id,
        version,
        JSON.stringify(spec),
        input.changeSummary.trim() || (version === 1 ? '创建大屏' : '保存编辑'),
        timestamp
      )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getDashboard(spec.id, version)!
  }

  restoreDashboard(id: string, version: number): DashboardVersion {
    const source = this.getDashboard(id, version)
    if (!source) throw new Error(`找不到大屏 ${id} 的版本 ${version}`)
    return this.saveDashboard({
      spec: source.spec,
      changeSummary: `恢复自版本 V${version}`
    })
  }

  recordVisualizationRun(input: VisualizationRunInput): VisualizationRun {
    const run: VisualizationRun = {
      ...input,
      id: randomUUID(),
      requestSummary: input.requestSummary.slice(0, 500),
      errorMessage: input.errorMessage?.slice(0, 1000),
      createdAt: nowIso()
    }
    this.db.prepare(`
      INSERT INTO visualization_runs (
        id, dashboard_id, request_summary, model_name, prompt_version, status,
        attempt_count, component_count, query_count, duration_ms, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.dashboardId ?? '',
      run.requestSummary,
      run.modelName,
      run.promptVersion,
      run.status,
      run.attemptCount,
      run.componentCount,
      run.queryCount,
      run.durationMs,
      run.errorMessage ?? '',
      run.createdAt
    )
    return run
  }

  listVisualizationRuns(limit = 30): VisualizationRun[] {
    return this.db.prepare(`
      SELECT *
      FROM visualization_runs
      ORDER BY created_at DESC
      LIMIT ?
    `).all(Math.min(100, Math.max(1, limit))).map((row) => {
      const value = row as SqlRow
      return {
        id: String(value.id),
        dashboardId: String(value.dashboard_id) || undefined,
        requestSummary: String(value.request_summary),
        modelName: String(value.model_name),
        promptVersion: String(value.prompt_version),
        status: String(value.status) as VisualizationRun['status'],
        attemptCount: Number(value.attempt_count),
        componentCount: Number(value.component_count),
        queryCount: Number(value.query_count),
        durationMs: Number(value.duration_ms),
        errorMessage: String(value.error_message) || undefined,
        createdAt: String(value.created_at)
      }
    })
  }

  scanAnalyticsRecords(scope: DataScope, maximumRows = 100_000): AnalyticsRecord[] {
    const clauses: string[] = []
    const params: string[] = []
    const addListFilter = (column: string, values?: string[]): void => {
      const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
      if (!normalized.length) return
      if (normalized.length > 200) throw new Error(`数据范围 ${column} 最多允许 200 个值`)
      clauses.push(`${column} IN (${normalized.map(() => '?').join(', ')})`)
      params.push(...normalized)
    }
    addListFilter('project_id', scope.projectIds)
    addListFilter('node_type', scope.nodeTypes)
    addListFilter('uid', scope.recordUids)
    if (scope.snapshotAt) {
      const timestamp = Date.parse(scope.snapshotAt)
      if (!Number.isFinite(timestamp)) throw new Error('snapshotAt 不是有效时间')
      clauses.push('synced_at <= ?')
      params.push(new Date(timestamp).toISOString())
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(100_000, Math.max(1, Math.trunc(maximumRows)))
    const rows = this.db.prepare(
      `SELECT uid, project_id, node_type, item_id, name, last_modify_time, raw_json
       FROM records${where}
       ORDER BY uid
       LIMIT ?`
    ).all(...params, limit + 1) as SqlRow[]
    if (rows.length > limit) {
      throw new Error(`查询扫描行数超过安全上限 ${limit}，请缩小 DataScope`)
    }
    return rows.flatMap((row) => {
      try {
        return [{
          uid: String(row.uid),
          projectId: String(row.project_id),
          nodeType: String(row.node_type),
          itemId: String(row.item_id),
          name: String(row.name),
          lastModifyTime: String(row.last_modify_time),
          raw: JSON.parse(String(row.raw_json)) as Record<string, unknown>
        }]
      } catch {
        return []
      }
    })
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | SqlRow
      | undefined
    return row ? String(row.value) : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  upsertProject(input: {
    uid: string
    name: string
    itemId: string
    lastModifyTime: string
    raw: Record<string, unknown>
  }): void {
    this.db
      .prepare(
        `INSERT INTO projects(uid, name, item_id, last_modify_time, raw_json, synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           name=excluded.name,
           item_id=excluded.item_id,
           last_modify_time=excluded.last_modify_time,
           raw_json=excluded.raw_json,
           synced_at=excluded.synced_at`
      )
      .run(
        input.uid,
        input.name,
        input.itemId,
        input.lastModifyTime,
        JSON.stringify(input.raw),
        nowIso()
      )
  }

  upsertRecord(input: RecordInput): void {
    const rawJson = JSON.stringify(input.raw)
    const contentHash = createHash('sha256').update(rawJson).digest('hex')
    this.db
      .prepare(
        `INSERT INTO records(
           uid, project_id, node_type, item_id, parent_id, name,
           last_modify_time, raw_json, normalized_text, content_hash, synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET
           project_id=excluded.project_id,
           node_type=excluded.node_type,
           item_id=excluded.item_id,
           parent_id=excluded.parent_id,
           name=excluded.name,
           last_modify_time=excluded.last_modify_time,
           raw_json=excluded.raw_json,
           normalized_text=excluded.normalized_text,
           content_hash=excluded.content_hash,
           push_status=CASE
             WHEN records.content_hash <> excluded.content_hash THEN 'pending'
             ELSE records.push_status
           END,
           push_message=CASE
             WHEN records.content_hash <> excluded.content_hash THEN ''
             ELSE records.push_message
           END,
           pushed_at=CASE
             WHEN records.content_hash <> excluded.content_hash THEN ''
             ELSE records.pushed_at
           END,
           pushed_uid=CASE
             WHEN records.content_hash <> excluded.content_hash THEN ''
             ELSE records.pushed_uid
           END,
           synced_at=excluded.synced_at`
      )
      .run(
        input.uid,
        input.projectId,
        input.nodeType,
        input.itemId,
        input.parentId,
        input.name,
        input.lastModifyTime,
        rawJson,
        input.normalizedText,
        contentHash,
        nowIso()
      )
  }

  retainRecords(uids: string[]): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS sync_record_keep (
        uid TEXT PRIMARY KEY
      );
      DELETE FROM sync_record_keep;
    `)
    const insert = this.db.prepare('INSERT OR IGNORE INTO sync_record_keep(uid) VALUES (?)')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const uid of uids) insert.run(uid)
      this.db.exec(`
        DELETE FROM records
        WHERE uid NOT IN (SELECT uid FROM sync_record_keep);
        COMMIT;
      `)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
      this.db.exec('DELETE FROM sync_record_keep')
    }
  }

  saveImage(input: ImageInput): ImageAsset {
    const sha256 = createHash('sha256').update(input.bytes).digest('hex')
    const existing = this.db
      .prepare('SELECT * FROM images WHERE record_uid = ? AND sha256 = ?')
      .get(input.recordUid, sha256) as SqlRow | undefined
    if (existing) return this.mapImage(existing)

    const id = randomUUID()
    const base64Path = join(this.assetDir, `${sha256}.b64`)
    writeFileSync(base64Path, input.bytes.toString('base64'), 'utf8')
    const createdAt = nowIso()
    this.db
      .prepare(
        `INSERT INTO images(
           id, record_uid, name, mime_type, source_url, sha256,
           base64_path, byte_size, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.recordUid,
        input.name,
        input.mimeType,
        input.sourceUrl,
        sha256,
        base64Path,
        input.bytes.byteLength,
        createdAt
      )
    return {
      id,
      recordUid: input.recordUid,
      name: input.name,
      mimeType: input.mimeType,
      sourceUrl: input.sourceUrl,
      sha256,
      byteSize: input.bytes.byteLength
    }
  }

  private mapImage(row: SqlRow, includeData = false): ImageAsset {
    const mimeType = String(row.mime_type)
    let dataUri: string | undefined
    if (includeData) {
      try {
        dataUri = `data:${mimeType};base64,${readFileSync(String(row.base64_path), 'utf8')}`
      } catch {
        dataUri = undefined
      }
    }
    return {
      id: String(row.id),
      recordUid: String(row.record_uid),
      name: String(row.name),
      mimeType,
      sourceUrl: String(row.source_url),
      sha256: String(row.sha256),
      byteSize: Number(row.byte_size),
      dataUri
    }
  }

  listProjects(): ProjectRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.uid, p.name, p.item_id, p.last_modify_time,
                COUNT(r.uid) AS record_count
         FROM projects p
         LEFT JOIN records r ON r.project_id = p.uid
         GROUP BY p.uid
         ORDER BY p.name`
      )
      .all() as SqlRow[]
    return rows.map((row) => ({
      uid: String(row.uid),
      name: String(row.name),
      itemId: String(row.item_id),
      lastModifyTime: String(row.last_modify_time),
      recordCount: Number(row.record_count)
    }))
  }

  listNodeTypes(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT node_type FROM records WHERE node_type <> '' ORDER BY node_type")
        .all() as SqlRow[]
    ).map((row) => String(row.node_type))
  }

  private recordFilters(query: RecordQuery): {
    join: string
    where: string
    params: Array<string | number>
  } {
    const clauses: string[] = []
    const params: Array<string | number> = []
    let join = ''
    if (query.search?.trim()) {
      const search = query.search.trim()
      if (search.length >= 3) {
        join = 'JOIN records_fts f ON f.rowid = r.rowid'
        clauses.push('records_fts MATCH ?')
        params.push(`"${search.replaceAll('"', '""')}"`)
      } else {
        clauses.push('(r.name LIKE ? OR r.item_id LIKE ? OR r.normalized_text LIKE ?)')
        params.push(`%${search}%`, `%${search}%`, `%${search}%`)
      }
    }
    if (query.projectId) {
      clauses.push('r.project_id = ?')
      params.push(query.projectId)
    }
    if (query.nodeType) {
      clauses.push('r.node_type = ?')
      params.push(query.nodeType)
    }
    return {
      join,
      where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
      params
    }
  }

  listRecords(query: RecordQuery): RecordPage {
    const page = Math.max(1, query.page || 1)
    const pageSize = Math.min(200, Math.max(1, query.pageSize || 20))
    const filters = this.recordFilters(query)
    const totalRow = this.db
      .prepare(`SELECT COUNT(DISTINCT r.uid) AS total FROM records r ${filters.join} ${filters.where}`)
      .get(...filters.params) as SqlRow
    const rows = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count
         FROM records r
         ${filters.join}
         LEFT JOIN images i ON i.record_uid = r.uid
         ${filters.where}
         GROUP BY r.uid
         ORDER BY r.last_modify_time DESC, r.uid DESC
         LIMIT ? OFFSET ?`
      )
      .all(...filters.params, pageSize, (page - 1) * pageSize) as SqlRow[]
    return {
      total: Number(totalRow.total),
      rows: rows.map((row) => this.mapRecord(row))
    }
  }

  getRecord(uid: string, includeImages = true): RecordDetail | null {
    const row = this.db
      .prepare(
        `SELECT r.*, COUNT(i.id) AS image_count
         FROM records r LEFT JOIN images i ON i.record_uid = r.uid
         WHERE r.uid = ? GROUP BY r.uid`
      )
      .get(uid) as SqlRow | undefined
    if (!row) return null
    const images = includeImages
      ? (
          this.db
            .prepare('SELECT * FROM images WHERE record_uid = ? ORDER BY created_at')
            .all(uid) as SqlRow[]
        ).map((image) => this.mapImage(image, true))
      : []
    return {
      ...this.mapRecord(row),
      normalizedText: String(row.normalized_text),
      raw: JSON.parse(String(row.raw_json)) as Record<string, unknown>,
      images
    }
  }

  markPushResult(
    uid: string,
    status: 'pending' | 'success' | 'failed',
    message = '',
    pushedUid = ''
  ): void {
    this.db
      .prepare(
        `UPDATE records
         SET push_status=?, push_message=?, pushed_at=?, pushed_uid=?
         WHERE uid=?`
      )
      .run(
        status,
        message,
        status === 'pending' ? '' : nowIso(),
        pushedUid,
        uid
      )
  }

  beginPushLog(input: {
    recordUid: string
    recordName: string
    endpoint: string
    params: Record<string, string>
    body: Record<string, unknown>
  }): number {
    const loggedBody = Object.fromEntries(
      Object.entries(input.body).filter(([key]) => key !== '_valm_Description')
    )
    const result = this.db
      .prepare(
        `INSERT INTO push_logs(
          record_uid, record_name, method, endpoint, params_json, body_json,
          status, created_at
        ) VALUES (?, ?, 'POST', ?, ?, ?, 'sending', ?)`
      )
      .run(
        input.recordUid,
        input.recordName,
        input.endpoint,
        JSON.stringify(input.params),
        JSON.stringify(loggedBody),
        nowIso()
      )
    return Number(result.lastInsertRowid)
  }

  finishPushLog(
    id: number,
    status: Exclude<PushLogStatus, 'sending'>,
    input: {
      httpStatus?: number
      response?: unknown
      errorMessage?: string
      remoteUid?: string
    }
  ): void {
    this.db
      .prepare(
        `UPDATE push_logs
         SET status=?, http_status=?, response_json=?, error_message=?,
             remote_uid=?, finished_at=?
         WHERE id=?`
      )
      .run(
        status,
        input.httpStatus ?? 0,
        input.response === undefined ? '' : JSON.stringify(input.response),
        input.errorMessage ?? '',
        input.remoteUid ?? '',
        nowIso(),
        id
      )
  }

  listPushLogs(page = 1, pageSize = 50): PushLogPage {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(200, Math.max(1, Math.floor(pageSize)))
    const rows = this.db
      .prepare('SELECT * FROM push_logs ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    const total = this.db.prepare('SELECT COUNT(*) AS value FROM push_logs').get() as SqlRow
    return {
      rows: rows.map((row) => this.mapPushLog(row)),
      total: Number(total.value ?? 0)
    }
  }

  private mapPushLog(row: SqlRow): PushLogRow {
    const parseJson = (input: unknown, fallback: unknown): unknown => {
      if (!input) return fallback
      try {
        return JSON.parse(String(input)) as unknown
      } catch {
        return fallback
      }
    }
    const status = String(row.status)
    return {
      id: Number(row.id),
      recordUid: String(row.record_uid),
      recordName: String(row.record_name),
      method: 'POST',
      endpoint: String(row.endpoint),
      params: parseJson(row.params_json, {}) as Record<string, string>,
      body: parseJson(row.body_json, {}) as Record<string, unknown>,
      status: ['success', 'failed'].includes(status)
        ? status as 'success' | 'failed'
        : 'sending',
      httpStatus: Number(row.http_status ?? 0),
      response: parseJson(row.response_json, undefined),
      errorMessage: String(row.error_message ?? ''),
      remoteUid: String(row.remote_uid ?? ''),
      createdAt: String(row.created_at),
      finishedAt: String(row.finished_at)
    }
  }

  beginCollectionRequestLog(input: {
    nodeType: string
    endpoint: string
    params: Record<string, string>
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO collection_request_logs(
          node_type, method, endpoint, params_json, status, created_at
        ) VALUES (?, 'GET', ?, ?, 'running', ?)`
      )
      .run(
        input.nodeType,
        input.endpoint,
        JSON.stringify(input.params),
        nowIso()
      )
    return Number(result.lastInsertRowid)
  }

  finishCollectionRequestLog(
    id: number,
    status: Exclude<CollectionRequestLogStatus, 'running'>,
    input: {
      httpStatus?: number
      recordCount?: number
      response?: unknown
      errorMessage?: string
    }
  ): void {
    this.db
      .prepare(
        `UPDATE collection_request_logs
         SET status=?, http_status=?, record_count=?, response_json=?,
             error_message=?, finished_at=?
         WHERE id=?`
      )
      .run(
        status,
        input.httpStatus ?? 0,
        input.recordCount ?? 0,
        input.response === undefined ? '' : JSON.stringify(input.response),
        input.errorMessage ?? '',
        nowIso(),
        id
      )
  }

  listCollectionRequestLogs(page = 1, pageSize = 50): CollectionRequestLogPage {
    const safePage = Math.max(1, Math.floor(page))
    const safePageSize = Math.min(200, Math.max(1, Math.floor(pageSize)))
    const rows = this.db
      .prepare('SELECT * FROM collection_request_logs ORDER BY id DESC LIMIT ? OFFSET ?')
      .all(safePageSize, (safePage - 1) * safePageSize) as SqlRow[]
    const total = this.db
      .prepare('SELECT COUNT(*) AS value FROM collection_request_logs')
      .get() as SqlRow
    return {
      rows: rows.map((row) => this.mapCollectionRequestLog(row)),
      total: Number(total.value ?? 0)
    }
  }

  private mapCollectionRequestLog(row: SqlRow): CollectionRequestLogRow {
    const parseJson = (input: unknown, fallback: unknown): unknown => {
      if (!input) return fallback
      try {
        return JSON.parse(String(input)) as unknown
      } catch {
        return fallback
      }
    }
    const status = String(row.status)
    return {
      id: Number(row.id),
      nodeType: String(row.node_type),
      method: 'GET',
      endpoint: String(row.endpoint),
      params: parseJson(row.params_json, {}) as Record<string, string>,
      status: ['success', 'failed'].includes(status)
        ? status as 'success' | 'failed'
        : 'running',
      httpStatus: Number(row.http_status ?? 0),
      recordCount: Number(row.record_count ?? 0),
      response: parseJson(row.response_json, undefined),
      errorMessage: String(row.error_message ?? ''),
      createdAt: String(row.created_at),
      finishedAt: String(row.finished_at)
    }
  }

  private mapRecord(row: SqlRow): RecordRow {
    let raw: Record<string, unknown> = {}
    try {
      raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
    } catch {
      // Corrupt legacy raw JSON should not prevent the data table from loading.
    }
    return {
      uid: String(row.uid),
      projectId: String(row.project_id),
      nodeType: String(row.node_type),
      itemId: String(row.item_id),
      parentId: String(row.parent_id),
      name: String(row.name),
      description:
        raw._valm_Description === undefined || raw._valm_Description === null
          ? ''
          : String(raw._valm_Description),
      lastModifyTime: String(row.last_modify_time),
      syncedAt: String(row.synced_at),
      imageCount: Number(row.image_count ?? 0),
      pushStatus: ['success', 'failed'].includes(String(row.push_status))
        ? String(row.push_status) as 'success' | 'failed'
        : 'pending',
      pushMessage: String(row.push_message ?? ''),
      pushedAt: String(row.pushed_at ?? ''),
      pushedUid: String(row.pushed_uid ?? '')
    }
  }

  searchForAgent(search: string, projectId?: string, limit = 8): Array<{
    source: ChatSource
    text: string
    raw: Record<string, unknown>
  }> {
    const page = this.listRecords({
      page: 1,
      pageSize: limit,
      search,
      projectId
    })
    return page.rows.map((row) => {
      const detail = this.getRecord(row.uid, false)!
      return {
        source: {
          uid: row.uid,
          name: row.name,
          nodeType: row.nodeType,
          itemId: row.itemId
        },
        text: detail.normalizedText ?? '',
        raw: detail.raw
      }
    })
  }

  getStats(): DashboardStats {
    const scalar = (sql: string): number => {
      const row = this.db.prepare(sql).get() as SqlRow
      return Number(Object.values(row)[0] ?? 0)
    }
    const byType = this.db
      .prepare(
        `SELECT COALESCE(NULLIF(node_type, ''), 'Unknown') AS name, COUNT(*) AS value
         FROM records GROUP BY node_type ORDER BY value DESC`
      )
      .all() as SqlRow[]
    const byProject = this.db
      .prepare(
        `SELECT p.name AS name, COUNT(r.uid) AS value
         FROM projects p LEFT JOIN records r ON r.project_id = p.uid
         GROUP BY p.uid ORDER BY value DESC`
      )
      .all() as SqlRow[]
    const releaseCounts = new Map<string, number>()
    const releaseRows = this.db.prepare('SELECT raw_json FROM records').all() as SqlRow[]
    for (const row of releaseRows) {
      let releaseValue: unknown
      try {
        const raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
        releaseValue = raw._valm_Release
      } catch {
        releaseValue = undefined
      }
      const name =
        releaseValue === undefined || releaseValue === null || String(releaseValue).trim() === ''
          ? '未设置'
          : typeof releaseValue === 'object'
            ? JSON.stringify(releaseValue)
            : String(releaseValue)
      releaseCounts.set(name, (releaseCounts.get(name) ?? 0) + 1)
    }
    return {
      projectCount: scalar('SELECT COUNT(*) FROM projects'),
      recordCount: scalar('SELECT COUNT(*) FROM records'),
      collectedCount: scalar('SELECT COUNT(*) FROM records'),
      pushedCount: scalar("SELECT COUNT(*) FROM records WHERE push_status = 'success'"),
      imageCount: scalar('SELECT COUNT(*) FROM images'),
      byType: byType.map((row) => ({ name: String(row.name), value: Number(row.value) })),
      byProject: byProject.map((row) => ({
        name: String(row.name),
        value: Number(row.value)
      })),
      byRelease: [...releaseCounts.entries()]
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) => right.value - left.value)
    }
  }

  aggregate(metric: string, projectId?: string): unknown {
    const where = projectId ? ' WHERE project_id = ?' : ''
    const params = projectId ? [projectId] : []
    if (metric === 'record_count') {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS value FROM records${where}`)
        .get(...params) as SqlRow
      return { metric, value: Number(row.value) }
    }
    if (metric === 'image_count') {
      const sql = projectId
        ? `SELECT COUNT(*) AS value FROM images i
           JOIN records r ON r.uid=i.record_uid WHERE r.project_id=?`
        : 'SELECT COUNT(*) AS value FROM images'
      const row = this.db.prepare(sql).get(...params) as SqlRow
      return { metric, value: Number(row.value) }
    }
    if (metric === 'count_by_project') {
      return this.getStats().byProject
    }
    const rows = this.db
      .prepare(
        `SELECT node_type AS name, COUNT(*) AS value FROM records${where}
         GROUP BY node_type ORDER BY value DESC`
      )
      .all(...params) as SqlRow[]
    return rows.map((row) => ({ name: String(row.name), value: Number(row.value) }))
  }

  aggregateByField(options: FieldAggregateOptions): FieldAggregateResult {
    const field = options.field.trim()
    if (!field || field.length > 160) throw new Error('统计字段不能为空且不能超过 160 个字符')

    const clauses: string[] = []
    const params: string[] = []
    if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT uid, name, node_type, item_id, raw_json
         FROM records${where}`
      )
      .all(...params) as SqlRow[]

    const splitMultiValue = options.splitMultiValue !== false
    const counts = new Map<string, {
      name: string
      value: number
      examples: Array<{ source: ChatSource }>
    }>()
    let matchedRecords = 0
    let valueOccurrences = 0

    for (const row of rows) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        continue
      }
      const values = normalizedFieldValues(fieldValuesAtPath(raw, field), splitMultiValue)
      if (!values.length) continue
      matchedRecords += 1
      valueOccurrences += values.length
      for (const currentValue of values) {
        const normalizedKey = currentValue.toLocaleLowerCase()
        const current = counts.get(normalizedKey) ?? {
          name: currentValue,
          value: 0,
          examples: []
        }
        current.value += 1
        if (current.examples.length < 2) {
          current.examples.push({
            source: {
              uid: String(row.uid),
              name: String(row.name),
              nodeType: String(row.node_type),
              itemId: String(row.item_id)
            }
          })
        }
        counts.set(normalizedKey, current)
      }
    }

    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 10)))
    const items = [...counts.values()]
      .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name, 'zh-CN'))
      .slice(0, limit)

    return {
      field,
      totalRecords: rows.length,
      matchedRecords,
      emptyRecords: rows.length - matchedRecords,
      valueOccurrences,
      splitMultiValue,
      items
    }
  }

  inspectFields(options: FieldInspectionOptions = {}): FieldInspectionResult {
    const clauses: string[] = []
    const params: string[] = []
    if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT raw_json FROM records${where}`).all(...params) as SqlRow[]
    const profiles = new Map<string, {
      nonEmptyRecords: number
      types: Set<string>
      samples: string[]
    }>()

    for (const row of rows) {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        continue
      }
      for (const [field, rawValues] of collectRecordFieldValues(raw)) {
        const values = normalizedFieldValues(rawValues, false)
        if (!values.length) continue
        const profile = profiles.get(field) ?? {
          nonEmptyRecords: 0,
          types: new Set<string>(),
          samples: []
        }
        profile.nonEmptyRecords += 1
        rawValues.forEach((value) => {
          if (Array.isArray(value)) {
            value.forEach((item) => profile.types.add(scalarType(item)))
          } else {
            profile.types.add(scalarType(value))
          }
        })
        for (const value of values) {
          const sample = value.length > 120 ? `${value.slice(0, 117)}...` : value
          if (!profile.samples.includes(sample) && profile.samples.length < 5) {
            profile.samples.push(sample)
          }
        }
        profiles.set(field, profile)
      }
    }

    const searchTerms = fieldSearchTerms(options.search)
    const limit = Math.min(100, Math.max(1, Math.trunc(options.limit ?? 40)))
    const fields = [...profiles.entries()]
      .filter(([field]) =>
        !searchTerms.length ||
        searchTerms.some((term) => field.toLocaleLowerCase().includes(term))
      )
      .sort((left, right) =>
        right[1].nonEmptyRecords - left[1].nonEmptyRecords ||
        left[0].localeCompare(right[0], 'zh-CN')
      )
      .slice(0, limit)
      .map(([field, profile]) => ({
        field,
        nonEmptyRecords: profile.nonEmptyRecords,
        coverageRate: rows.length
          ? Number(((profile.nonEmptyRecords / rows.length) * 100).toFixed(2))
          : 0,
        types: [...profile.types].sort(),
        samples: profile.samples
      }))

    return { totalRecords: rows.length, fields }
  }

  queryRecordsByFields(options: FieldQueryOptions): FieldQueryResult {
    const clauses: string[] = []
    const params: string[] = []
    if (options.projectId?.trim()) {
      clauses.push('project_id = ?')
      params.push(options.projectId.trim())
    }
    if (options.nodeType?.trim()) {
      clauses.push('node_type = ?')
      params.push(options.nodeType.trim())
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(
        `SELECT uid, name, node_type, item_id, raw_json, normalized_text
         FROM records${where}`
      )
      .all(...params) as SqlRow[]
    const fields = [...new Set((options.fields ?? []).map((field) => field.trim()).filter(Boolean))]
      .slice(0, 20)
    const filters = (options.filters ?? [])
      .filter((filter) => filter.field?.trim())
      .slice(0, 10)
    const searchTerms = [
      ...(options.searchTerms ?? []),
      ...(options.search?.trim() ? [options.search] : [])
    ]
      .map((term) => term.trim().toLocaleLowerCase())
      .filter(Boolean)
      .filter((term, index, values) => values.indexOf(term) === index)
      .slice(0, 10)
    const searchMode = options.searchMode === 'all' ? 'all' : 'any'

    const matched = rows.flatMap((row) => {
      let raw: Record<string, unknown>
      try {
        raw = JSON.parse(String(row.raw_json)) as Record<string, unknown>
      } catch {
        return []
      }
      if (searchTerms.length) {
        const searchable = [
          String(row.name),
          String(row.item_id),
          String(row.normalized_text)
        ].join('\n').toLocaleLowerCase()
        const termMatches = searchTerms.map((term) => searchable.includes(term))
        if (
          (searchMode === 'all' && !termMatches.every(Boolean)) ||
          (searchMode === 'any' && !termMatches.some(Boolean))
        ) return []
      }
      const passes = filters.every((filter) => {
        const values = normalizedFieldValues(
          fieldValuesAtPath(raw, filter.field.trim()),
          false
        )
        return matchesFieldFilter(values, filter)
      })
      if (!passes) return []

      const values: Record<string, string | string[]> = {}
      for (const field of fields) {
        const selected = normalizedFieldValues(fieldValuesAtPath(raw, field), false)
        values[field] = selected.length <= 1 ? selected[0] ?? '' : selected
      }
      return [{
        source: {
          uid: String(row.uid),
          name: String(row.name),
          nodeType: String(row.node_type),
          itemId: String(row.item_id)
        },
        values,
        raw
      }]
    })

    if (options.sort?.field.trim()) {
      const sortField = options.sort.field.trim()
      const direction = options.sort.direction === 'desc' ? -1 : 1
      matched.sort((left, right) => {
        const leftValue = normalizedFieldValues(fieldValuesAtPath(left.raw, sortField), false)[0] ?? ''
        const rightValue = normalizedFieldValues(fieldValuesAtPath(right.raw, sortField), false)[0] ?? ''
        const a = comparisonValue(leftValue)
        const b = comparisonValue(rightValue)
        if (typeof a === typeof b) {
          if (a < b) return -1 * direction
          if (a > b) return 1 * direction
        }
        return 0
      })
    }

    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 10)))
    const records = matched.slice(0, limit).map(({ source, values }) => ({ source, values }))
    return {
      totalScanned: rows.length,
      matchedCount: matched.length,
      returnedCount: records.length,
      fields,
      records
    }
  }

  beginSync(): number {
    const result = this.db
      .prepare("INSERT INTO sync_runs(started_at, status) VALUES (?, 'running')")
      .run(nowIso())
    return Number(result.lastInsertRowid)
  }

  finishSync(
    id: number,
    status: 'success' | 'failed',
    counts: { projects: number; records: number; images: number },
    errorMessage = ''
  ): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET finished_at=?, status=?, project_count=?,
         record_count=?, image_count=?, error_message=? WHERE id=?`
      )
      .run(
        nowIso(),
        status,
        counts.projects,
        counts.records,
        counts.images,
        errorMessage,
        id
      )
  }

  listSyncRuns(): SyncRun[] {
    const rows = this.db
      .prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10')
      .all() as SqlRow[]
    return rows.map((row) => ({
      id: Number(row.id),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      status: String(row.status),
      projectCount: Number(row.project_count),
      recordCount: Number(row.record_count),
      imageCount: Number(row.image_count),
      errorMessage: String(row.error_message)
    }))
  }

  exportRows(): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT * FROM records ORDER BY project_id, node_type, uid')
      .all() as SqlRow[]
    return rows.map((row) => {
      const images = (
        this.db.prepare('SELECT * FROM images WHERE record_uid=?').all(String(row.uid)) as SqlRow[]
      ).map((image) => {
        const mapped = this.mapImage(image, true)
        return {
          id: mapped.id,
          name: mapped.name,
          mimeType: mapped.mimeType,
          sourceUrl: mapped.sourceUrl,
          sha256: mapped.sha256,
          base64: mapped.dataUri?.split(',', 2)[1] ?? ''
        }
      })
      return {
        documentId: `${row.node_type}:${row.uid}`,
        title: String(row.name),
        content: String(row.normalized_text),
        metadata: {
          projectId: String(row.project_id),
          recordType: String(row.node_type),
          sourceId: String(row.uid),
          itemId: String(row.item_id),
          updatedAt: String(row.last_modify_time),
          pushStatus: String(row.push_status ?? 'pending'),
          pushMessage: String(row.push_message ?? ''),
          pushedAt: String(row.pushed_at ?? ''),
          pushedUid: String(row.pushed_uid ?? '')
        },
        raw: JSON.parse(String(row.raw_json)),
        images
      }
    })
  }

  importRows(rows: unknown[]): DataImportResult {
    let recordCount = 0
    let imageCount = 0
    let skippedCount = 0
    const errors: string[] = []
    const asObject = (input: unknown): Record<string, unknown> | null =>
      input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : null
    const text = (input: unknown): string =>
      input === undefined || input === null ? '' : String(input)

    rows.forEach((input, index) => {
      try {
        const row = asObject(input)
        if (!row) throw new Error('记录不是 JSON 对象')
        const metadata = asObject(row.metadata) ?? {}
        const raw = asObject(row.raw) ?? {}
        const documentId = text(row.documentId)
        const uid =
          text(metadata.sourceId) ||
          text(raw._valm_Uid) ||
          text(row.uid) ||
          (documentId.includes(':') ? documentId.slice(documentId.lastIndexOf(':') + 1) : '')
        const nodeType =
          text(metadata.recordType) ||
          text(raw._valm_NodeType) ||
          text(row.nodeType) ||
          (documentId.includes(':') ? documentId.slice(0, documentId.indexOf(':')) : '')
        if (!uid || !nodeType) throw new Error('缺少 UID 或数据类型')

        const name = text(row.title) || text(raw._valm_Name) || text(row.name) || uid
        const projectId =
          text(metadata.projectId) ||
          text(raw._valm_ProjectId) ||
          text(raw._valm_ProjectUid) ||
          text(row.projectId)
        const itemId = text(metadata.itemId) || text(raw._valm_ItemID) || text(row.itemId)
        const lastModifyTime =
          text(metadata.updatedAt) ||
          text(raw._valm_LastModifyTime) ||
          text(row.lastModifyTime)
        const parentId = text(raw._valm_ParentId) || text(row.parentId)
        const normalizedRaw = {
          ...raw,
          _valm_Uid: text(raw._valm_Uid) || uid,
          _valm_NodeType: text(raw._valm_NodeType) || nodeType,
          _valm_Name: text(raw._valm_Name) || name
        }

        if (nodeType === 'Project') {
          this.upsertProject({
            uid,
            name,
            itemId,
            lastModifyTime,
            raw: normalizedRaw
          })
        }
        this.upsertRecord({
          uid,
          projectId: nodeType === 'Project' ? uid : projectId,
          nodeType,
          itemId,
          parentId,
          name,
          lastModifyTime,
          raw: normalizedRaw,
          normalizedText: text(row.content)
        })
        const importedPushStatus = text(metadata.pushStatus)
        if (['pending', 'success', 'failed'].includes(importedPushStatus)) {
          this.markPushResult(
            uid,
            importedPushStatus as 'pending' | 'success' | 'failed',
            text(metadata.pushMessage),
            text(metadata.pushedUid)
          )
        }
        recordCount += 1

        const images = Array.isArray(row.images) ? row.images : []
        for (const imageInput of images) {
          const image = asObject(imageInput)
          const base64 = text(image?.base64).replace(/\s+/g, '')
          if (!image || !base64) continue
          const bytes = Buffer.from(base64, 'base64')
          if (!bytes.length) {
            skippedCount += 1
            continue
          }
          this.saveImage({
            recordUid: uid,
            name: text(image.name),
            mimeType: text(image.mimeType) || 'application/octet-stream',
            sourceUrl: text(image.sourceUrl) || 'imported:data',
            bytes
          })
          imageCount += 1
        }
      } catch (error) {
        skippedCount += 1
        if (errors.length < 50) {
          errors.push(`第 ${index + 1} 条：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })

    return {
      ok: recordCount > 0 || (rows.length === 0 && skippedCount === 0),
      recordCount,
      imageCount,
      skippedCount,
      errors,
      message: `导入完成：${recordCount} 条记录，${imageCount} 张图片，跳过 ${skippedCount} 条`
    }
  }

  deleteData(uids?: string[]): DataDeleteResult {
    const selected = [...new Set((uids ?? []).map((uid) => uid.trim()).filter(Boolean))]
    const deleteAll = uids === undefined
    if (!deleteAll && !selected.length) {
      return { ok: true, recordCount: 0, imageCount: 0, message: '没有需要删除的数据' }
    }

    const placeholders = selected.map(() => '?').join(',')
    const where = deleteAll ? '' : `WHERE record_uid IN (${placeholders})`
    const imageRows = this.db
      .prepare(`SELECT base64_path FROM images ${where}`)
      .all(...selected) as SqlRow[]
    const paths = [...new Set(imageRows.map((row) => String(row.base64_path)))]

    this.db.exec('BEGIN IMMEDIATE')
    let recordCount = 0
    try {
      if (deleteAll) {
        recordCount = Number(
          (this.db.prepare('SELECT COUNT(*) AS count FROM records').get() as SqlRow).count
        )
        this.db.prepare('DELETE FROM records').run()
        this.db.prepare('DELETE FROM projects').run()
      } else {
        const recordWhere = `uid IN (${placeholders})`
        recordCount = Number(
          (
            this.db
              .prepare(`SELECT COUNT(*) AS count FROM records WHERE ${recordWhere}`)
              .get(...selected) as SqlRow
          ).count
        )
        this.db.prepare(`DELETE FROM records WHERE ${recordWhere}`).run(...selected)
        this.db.prepare(`DELETE FROM projects WHERE ${recordWhere}`).run(...selected)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    for (const path of paths) {
      const remaining = this.db
        .prepare('SELECT 1 FROM images WHERE base64_path = ? LIMIT 1')
        .get(path)
      if (remaining) continue
      try {
        unlinkSync(path)
      } catch {
        // A missing Base64 file is already effectively deleted.
      }
    }

    return {
      ok: true,
      recordCount,
      imageCount: imageRows.length,
      message: `已删除 ${recordCount} 条记录和 ${imageRows.length} 张图片`
    }
  }
}
