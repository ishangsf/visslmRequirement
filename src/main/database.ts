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
