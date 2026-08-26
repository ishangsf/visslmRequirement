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
  version: 1
  formValues: Partial<PushFormValues>
  fieldMappings: PushFieldMapping[]
  mappingInitialized: boolean
  selectedRowKeys: string[]
  search: string
  releaseText?: string
  page: number
  pageSize: number
}

export const pushConfigDraftStorageKey = 'visslm:push-config-draft:v1'

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

export const parsePushConfigDraft = (parsed: unknown): PushConfigDraft | null => {
  if (!isRecordObject(parsed) || parsed.version !== 1) return null

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
  return {
    version: 1,
    formValues,
    fieldMappings,
    // Keep an explicit initialization marker even when every old mapping row
    // was forbidden, otherwise navigation would silently repopulate the table.
    mappingInitialized: parsed.mappingInitialized === true || fieldMappings.length > 0,
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

const legacyForbiddenSourceFields: ReadonlySet<string> = new Set([
  '_valm_Uid',
  '_valm_NodeType',
  '_valm_ItemID'
])

export const isLegacyDefaultPushFieldMappings = (
  mappings: PushFieldMapping[],
  raw: Record<string, unknown>
): boolean => {
  const legacySourceFields = Object.keys(raw).filter((field) => (
    !legacyForbiddenSourceFields.has(field) && pushMappingIdentifierPattern.test(field)
  ))
  return mappings.length > 0 &&
    mappings.length === legacySourceFields.length &&
    mappings.every((mapping, index) => (
      mapping.sourceField === legacySourceFields[index] &&
      mapping.targetField === legacySourceFields[index]
    ))
}

export const readPushConfigDraft = (): PushConfigDraft | null => {
  if (typeof window === 'undefined') return null
  try {
    const stored = window.localStorage.getItem(pushConfigDraftStorageKey)
    if (!stored) return null
    return parsePushConfigDraft(JSON.parse(stored) as unknown)
  } catch {
    return null
  }
}

export const writePushConfigDraft = (draft: PushConfigDraft): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(pushConfigDraftStorageKey, JSON.stringify(draft))
  } catch {
    // The push page remains usable when browser storage is unavailable or full.
  }
}
