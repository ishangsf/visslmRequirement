import { compactContextValue, sanitizeContextText } from '../context-budget'

export interface RecordEvidencePacket {
  records: Array<Record<string, unknown>>
  coverage: {
    queryReturnedCount: number
    modelIncludedCount: number
    omittedRecordCount: number
    sampled: boolean
  }
  [key: string]: unknown
}

/** Budget whole records, never remove the records property to keep envelope metadata. */
export const packRecordEvidence = (input: Record<string, unknown>, maxChars = 24_000): RecordEvidencePacket => {
  const rows = Array.isArray(input.records) ? input.records : []
  const metadata = Object.fromEntries(Object.entries(input).filter(([key]) => ![
    'records', 'recordUids', 'recordUidsByTerm', 'coverage'
  ].includes(key)))
  if (metadata.grouping && typeof metadata.grouping === 'object') {
    const grouping = metadata.grouping as { field: string; groups: Array<{ name: string; count: number; isEmpty: boolean }> }
    metadata.grouping = { field: grouping.field, groups: grouping.groups.map(({ name, count, isEmpty }) => ({ name, count, isEmpty })) }
  }
  if (Array.isArray(metadata.explicitGroups)) {
    metadata.explicitGroups = metadata.explicitGroups.map(({ recordUids: _uids, ...group }) => group)
  }
  const safeMetadata = compactContextValue(metadata, {
    maxStringChars: 512, maxArrayItems: 50, maxObjectEntries: 40, maxDepth: 4
  }) as Record<string, unknown>
  const packet: RecordEvidencePacket = {
    ...safeMetadata,
    records: [],
    coverage: {
      queryReturnedCount: rows.length,
      modelIncludedCount: 0,
      omittedRecordCount: rows.length,
      sampled: true
    }
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const original = row as Record<string, unknown>
    const record = compactContextValue(original, {
      maxStringChars: 512, maxArrayItems: 12, maxObjectEntries: 30, maxDepth: 5
    }) as Record<string, unknown>
    if (typeof original.text === 'string') record.text = sanitizeContextText(original.text, 2_400)
    packet.records.push(record)
    if (JSON.stringify(packet).length > maxChars - 128) {
      packet.records.pop()
      continue
    }
  }
  packet.coverage.modelIncludedCount = packet.records.length
  packet.coverage.omittedRecordCount = rows.length - packet.records.length
  packet.coverage.sampled = packet.coverage.omittedRecordCount > 0 ||
    Number(input.matchedCount ?? rows.length) > packet.records.length || Boolean(input.retrieval)
  return packet
}
