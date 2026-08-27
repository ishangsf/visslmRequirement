import type { PushConfig, PushFieldMapping } from '../../shared/types'
import {
  defaultPushTargetField,
  pushForbiddenSourceFields,
  pushForbiddenTargetFields,
  pushMappingIdentifierPattern
} from '../../shared/push-field-mapping'

export {
  pushForbiddenSourceFields,
  pushForbiddenTargetFields,
  pushMappingIdentifierPattern
} from '../../shared/push-field-mapping'

export type PushFormValues = Omit<PushConfig, 'recordUids' | 'fieldMappings'>

export type PushConfigDraft = {
  version: 2
  formValues: Partial<PushFormValues>
  fieldMappings: PushFieldMapping[]
  mappingInitialized: boolean
  /**
   * v1 generated mappings used source names as their targets. Keep this bit
   * until the first record is available so the renderer can verify and
   * rebuild only an untouched generated mapping set.
   */
  mappingMigrationPending?: boolean
  selectedRowKeys: string[]
  search: string
  releaseText?: string
  page: number
  pageSize: number
}

export const pushConfigDraftStorageKey = 'visslm:push-config-draft:v2'
export const legacyPushConfigDraftStorageKey = 'visslm:push-config-draft:v1'

const pushFormValueKeys = [
  'nodeType',
  'projectId',
  'componentId',
  'parentId',
  'insertAfterId',
  'insertBeforeId'
] as const

const isRecordObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
)

const legacyDefaultMappingIdPattern = /^push-default-mapping-\d+-(.+)$/

const isLegacyGeneratedDefaultMapping = (mapping: PushFieldMapping): boolean => {
  const match = mapping.id.match(legacyDefaultMappingIdPattern)
  return Boolean(match?.[1]) &&
    match?.[1] === mapping.sourceField &&
    mapping.sourceField === mapping.targetField
}

export const parsePushConfigDraft = (parsed: unknown): PushConfigDraft | null => {
  if (!isRecordObject(parsed) || (parsed.version !== 1 && parsed.version !== 2)) return null
  // A version marker without any persisted draft state is not a recoverable
  // draft. Keep malformed v2 values from masking a valid v1 fallback.
  if (parsed.version === 2 && ![
    'formValues',
    'fieldMappings',
    'mappingInitialized',
    'selectedRowKeys',
    'search',
    'releaseText',
    'page',
    'pageSize'
  ].some((key) => Object.prototype.hasOwnProperty.call(parsed, key))) return null

  const formValues: Partial<PushFormValues> = {}
  if (isRecordObject(parsed.formValues)) {
    for (const key of pushFormValueKeys) {
      const value = parsed.formValues[key]
      if (typeof value === 'string') formValues[key] = value
    }
  }

  const usedMappingIds = new Set<string>()
  const fieldMappings = Array.isArray(parsed.fieldMappings)
    ? parsed.fieldMappings.flatMap((value, index) => {
        if (!isRecordObject(value)) return []
        const sourceField = typeof value.sourceField === 'string' ? value.sourceField : ''
        const targetField = typeof value.targetField === 'string' ? value.targetField : ''
        // Drafts created before forbidden source fields were filtered can still
        // contain local identifiers. Drop only those invalid rows while keeping
        // the rest of the user's push configuration intact.
        if (pushForbiddenSourceFields.has(sourceField.trim())) return []
        if (pushForbiddenTargetFields.has(targetField.trim())) return []
        let id = typeof value.id === 'string' && value.id.trim()
          ? value.id.trim()
          : `push-mapping-${index + 1}`
        while (usedMappingIds.has(id)) id = `${id}-${index + 1}`
        usedMappingIds.add(id)
        return [{ id, sourceField, targetField }]
      })
    : []

  const selectedRowKeys = Array.isArray(parsed.selectedRowKeys)
    ? [...new Set(parsed.selectedRowKeys
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(Boolean))]
    : []
  const page = typeof parsed.page === 'number' && Number.isFinite(parsed.page)
    ? Math.max(1, Math.floor(parsed.page))
    : 1
  const pageSize = typeof parsed.pageSize === 'number' && Number.isFinite(parsed.pageSize)
    ? Math.min(100, Math.max(10, Math.floor(parsed.pageSize)))
    : 20
  const mappingInitialized = parsed.mappingInitialized === true || fieldMappings.length > 0
  const hasLegacyDefaultMappingShape = fieldMappings.length > 0 &&
    fieldMappings.every(isLegacyGeneratedDefaultMapping)
  const mappingMigrationPending = (
    hasLegacyDefaultMappingShape &&
    (parsed.mappingMigrationPending === true || parsed.version === 1)
  )
  return {
    version: 2,
    formValues,
    fieldMappings,
    // Keep an explicit initialization marker even when every old mapping row
    // was forbidden, otherwise navigation would silently repopulate the table.
    mappingInitialized,
    ...(mappingMigrationPending && fieldMappings.length > 0 ? { mappingMigrationPending: true } : {}),
    selectedRowKeys,
    search: typeof parsed.search === 'string' ? parsed.search : '',
    ...(typeof parsed.releaseText === 'string' ? { releaseText: parsed.releaseText } : {}),
    page,
    pageSize
  }
}

export const buildDefaultPushFieldMappings = (
  raw: Record<string, unknown>
): PushFieldMapping[] => {
  const sourceFields = Object.keys(raw).filter((field) => (
    !pushForbiddenSourceFields.has(field) && pushMappingIdentifierPattern.test(field)
  ))
  const reservedAliasTargets = new Set(sourceFields.flatMap((sourceField) => {
    const targetField = defaultPushTargetField(sourceField)
    return targetField === sourceField ? [] : [targetField]
  }))

  return sourceFields
    // Prefer the requested alias when the record already contains a property
    // whose original name would collide with that alias target.
    .filter((sourceField) => (
      defaultPushTargetField(sourceField) !== sourceField || !reservedAliasTargets.has(sourceField)
    ))
    .map((sourceField, index) => ({
      id: `push-default-mapping-${index + 1}-${sourceField}`,
      sourceField,
      targetField: defaultPushTargetField(sourceField)
    }))
}

export const isLegacyDefaultPushFieldMappings = (
  mappings: PushFieldMapping[],
  _raw: Record<string, unknown>
): boolean => {
  // Generated IDs contain the original source field. This identifies an
  // untouched v1 default set even when the current first record has a
  // different field shape, while rejecting user edits to either side.
  return mappings.length > 0 && mappings.every(isLegacyGeneratedDefaultMapping)
}

export const readPushConfigDraft = (): PushConfigDraft | null => {
  if (typeof window === 'undefined') return null
  const readAt = (key: string): PushConfigDraft | null => {
    try {
      const stored = window.localStorage.getItem(key)
      if (!stored) return null
      return parsePushConfigDraft(JSON.parse(stored) as unknown)
    } catch {
      return null
    }
  }

  const currentDraft = readAt(pushConfigDraftStorageKey)
  if (currentDraft) return currentDraft

  // Keep v1 untouched for rollback/recovery, but materialize the normalized
  // v2 copy as soon as it can be read. The renderer will finish any
  // first-record mapping migration after the record data is available.
  const legacyDraft = readAt(legacyPushConfigDraftStorageKey)
  if (!legacyDraft) return null
  try {
    window.localStorage.setItem(pushConfigDraftStorageKey, JSON.stringify(legacyDraft))
  } catch {
    // The push page remains usable when browser storage is unavailable or full.
  }
  return legacyDraft
}

export const writePushConfigDraft = (draft: PushConfigDraft): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(pushConfigDraftStorageKey, JSON.stringify(draft))
  } catch {
    // The push page remains usable when browser storage is unavailable or full.
  }
}
