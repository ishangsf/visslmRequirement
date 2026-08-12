import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildRequirementSemanticCard } from '../src/main/requirements/semantic-card'
import type { RecordDetail } from '../src/shared/types'

interface Options {
  database: string
  baseItemId: string
  candidateItemIds: string[]
  output: string
}

type SqlRow = Record<string, unknown>

const parseArgs = (): Options => {
  const values = new Map<string, string>()
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const next = args[index + 1]
    if (!arg.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${arg}`)
    values.set(arg, next)
    index += 1
  }
  const database = values.get('--database')
  const baseItemId = values.get('--base-item-id')
  const candidateItemIds = (values.get('--candidate-item-ids') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const output = values.get('--output')
  if (!database || !baseItemId || !candidateItemIds.length || !output) {
    throw new Error('Required: --database, --base-item-id, --candidate-item-ids, --output')
  }
  return {
    database: resolve(database),
    baseItemId,
    candidateItemIds: [...new Set(candidateItemIds)],
    output: resolve(output)
  }
}

const parseRaw = (value: unknown): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

const toRecord = (row: SqlRow): RecordDetail => {
  const raw = parseRaw(row.raw_json)
  return {
    uid: String(row.uid),
    projectId: String(row.project_id ?? ''),
    nodeType: String(row.node_type ?? ''),
    itemId: String(row.item_id ?? ''),
    parentId: String(row.parent_id ?? ''),
    name: String(row.name ?? ''),
    description: String(raw._valm_Description ?? raw.description ?? ''),
    lastModifyTime: String(row.last_modify_time ?? ''),
    syncedAt: String(row.synced_at ?? ''),
    imageCount: 0,
    normalizedText: String(row.normalized_text ?? ''),
    pushStatus: 'pending',
    pushMessage: '',
    pushedAt: '',
    pushedUid: '',
    raw,
    images: []
  }
}

const main = async (): Promise<void> => {
  const options = parseArgs()
  const requestedIds = [options.baseItemId, ...options.candidateItemIds]
  const database = new DatabaseSync(options.database, { readOnly: true })
  try {
    const placeholders = requestedIds.map(() => '?').join(', ')
    const rows = database.prepare(`
      SELECT uid, project_id, node_type, item_id, parent_id, name,
             last_modify_time, synced_at, normalized_text, raw_json
      FROM records
      WHERE item_id COLLATE NOCASE IN (${placeholders})
    `).all(...requestedIds) as SqlRow[]
    const records = new Map(rows.map((row) => [String(row.item_id).toLocaleUpperCase(), toRecord(row)]))
    const missing = requestedIds.filter((itemId) => !records.has(itemId.toLocaleUpperCase()))
    if (missing.length) throw new Error(`Database records are missing: ${missing.join(', ')}`)
    const base = records.get(options.baseItemId.toLocaleUpperCase())!
    const baseCard = buildRequirementSemanticCard(base)
    const pairs = options.candidateItemIds.map((candidateItemId) => {
      const candidate = records.get(candidateItemId.toLocaleUpperCase())!
      return {
        id: `${options.baseItemId}/${candidateItemId}`,
        queryId: options.baseItemId,
        candidateItemId,
        query: baseCard.matchingText,
        candidate: buildRequirementSemanticCard(candidate).matchingText
      }
    })
    await mkdir(dirname(options.output), { recursive: true })
    await writeFile(options.output, `${JSON.stringify({
      schemaVersion: '1.0',
      provenance: 'Generated from a local VISSLM data-center database using the production semantic-card builder.',
      pairs
    }, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ output: options.output, queryCount: 1, pairCount: pairs.length }))
  } finally {
    database.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
