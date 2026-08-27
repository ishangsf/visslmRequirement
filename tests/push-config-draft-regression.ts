import assert from 'node:assert/strict'

import {
  buildDefaultPushFieldMappings,
  isLegacyDefaultPushFieldMappings,
  legacyPushConfigDraftStorageKey,
  parsePushConfigDraft,
  pushConfigDraftStorageKey,
  readPushConfigDraft,
  writePushConfigDraft
} from '../src/renderer/src/push-config-draft'

const forbiddenSourceFields = ['_valm_Uid', '_valm_NodeType'] as const
const forbiddenTargetFields = ['_valm_Uid', '_valm_NodeType', '_valm_ItemID'] as const

const testForbiddenMappingsAreRemovedWithoutLosingDraftState = (): void => {
  const draft = {
    version: 1,
    formValues: {
      nodeType: 'Task',
      projectId: 'project-1',
      componentId: 'component-1',
      parentId: 'parent-1',
      insertAfterId: 'after-1',
      insertBeforeId: 'before-1'
    },
    fieldMappings: [
      { id: 'require-by', sourceField: 'Source', targetField: 'RequireBy' },
      { id: 'user-story-description', sourceField: '_valm_Description', targetField: 'UserStoryDescription' },
      { id: 'accept-criteria', sourceField: '_valm_ItemID', targetField: 'AcceptCriteria' },
      ...forbiddenSourceFields.map((field, index) => ({
        id: `forbidden-source-${index + 1}`,
        sourceField: field,
        targetField: `MappedSourceForbidden${index + 1}`
      })),
      ...forbiddenTargetFields.map((field, index) => ({
        id: `forbidden-target-${index + 1}`,
        sourceField: `MappedTargetForbidden${index + 1}`,
        targetField: field
      }))
    ],
    // This must survive even when filtering removes every forbidden mapping;
    // otherwise navigation back to the page regenerates first-record defaults.
    mappingInitialized: true,
    selectedRowKeys: ['uid-1', 'uid-2', 'uid-1'],
    search: '订单',
    releaseText: 'v1.2',
    page: 3,
    pageSize: 50
  }

  const parsed = parsePushConfigDraft(draft)
  assert.ok(parsed, 'a valid historical draft should parse')
  assert.deepEqual(parsed.formValues, draft.formValues, 'form values must survive draft recovery')
  assert.deepEqual(
    parsed.fieldMappings,
    draft.fieldMappings.slice(0, 3),
    'forbidden source fields and all forbidden targets must be removed while _valm_ItemID remains a legal source'
  )
  assert.equal(parsed.mappingInitialized, true, 'mappingInitialized must remain true after filtering')
  assert.deepEqual(parsed.selectedRowKeys, ['uid-1', 'uid-2'], 'selected rows must survive recovery')
  assert.equal(parsed.search, draft.search, 'search filter must survive recovery')
  assert.equal(parsed.releaseText, draft.releaseText, 'release filter must survive recovery')
  assert.equal(parsed.page, draft.page, 'page must survive recovery')
  assert.equal(parsed.pageSize, draft.pageSize, 'page size must survive recovery')
}

const testInitializedFlagSurvivesWhenOnlyForbiddenMappingsRemain = (): void => {
  const parsed = parsePushConfigDraft({
    version: 1,
    formValues: {},
    fieldMappings: forbiddenTargetFields.map((field, index) => ({
      id: `forbidden-${index + 1}`,
      sourceField: field,
      targetField: field
    })),
    mappingInitialized: true,
    selectedRowKeys: [],
    search: '',
    page: 1,
    pageSize: 20
  })

  assert.ok(parsed, 'a draft containing only forbidden mappings should still parse')
  assert.deepEqual(parsed.fieldMappings, [], 'all forbidden mappings must be removed')
  assert.equal(parsed.mappingInitialized, true, 'the original initialized state must not be lost')
}

const testCorruptedDraftsReturnNull = (): void => {
  const corruptedValues: unknown[] = [
    null,
    undefined,
    [],
    'not a draft',
    { version: 2 },
    { version: '1' },
    { version: 1.0 + 1 }
  ]

  for (const value of corruptedValues) {
    assert.equal(parsePushConfigDraft(value), null, `corrupted draft should return null: ${String(value)}`)
  }
}

const testDefaultMappingsPreferBusinessAliases = (): void => {
  const mappings = buildDefaultPushFieldMappings({
    Source: 'source value',
    _valm_Description: 'description value',
    _valm_ItemID: 'ITEM-1',
    RAO: 'development owner',
    TSIS_ClarifyInfo: 'clarification text',
    Priority: 'P1',
    _valm_Uid: 'local-uid',
    _valm_NodeType: 'Task',
    RequireBy: 'legacy require-by value',
    UserStoryDescription: 'legacy description value',
    AcceptCriteria: 'legacy acceptance value',
    Devs: 'legacy development owner value'
  })

  const sourceAndTargets = mappings.map(({ sourceField, targetField }) => ({ sourceField, targetField }))
  assert.deepEqual(sourceAndTargets, [
    { sourceField: 'Source', targetField: 'RequireBy' },
    { sourceField: '_valm_Description', targetField: 'UserStoryDescription' },
    { sourceField: '_valm_ItemID', targetField: 'AcceptCriteria' },
    { sourceField: 'RAO', targetField: 'Devs' },
    { sourceField: 'TSIS_ClarifyInfo', targetField: '_valm_Description' },
    { sourceField: 'Priority', targetField: 'Priority' }
  ], 'default mappings must preserve aliases and ordinary business fields')
  assert.ok(!mappings.some(({ sourceField }) => forbiddenSourceFields.includes(sourceField as typeof forbiddenSourceFields[number])))
  assert.ok(!mappings.some(({ sourceField }) => (
    sourceField === 'RequireBy' ||
    sourceField === 'UserStoryDescription' ||
    sourceField === 'AcceptCriteria' ||
    sourceField === 'Devs'
  )), 'original fields that collide with alias targets must be excluded')

  const targetFields = mappings.map(({ targetField }) => targetField)
  assert.equal(new Set(targetFields).size, targetFields.length, 'default target fields must be unique')
}

const testLegacyDefaultMappingsAreRecognizedPrecisely = (): void => {
  const raw = {
    Source: 'source value',
    _valm_Description: 'description value',
    _valm_ItemID: 'ITEM-1',
    Priority: 'P1',
    _valm_Uid: 'local-uid',
    _valm_NodeType: 'Task'
  }
  const legacyMappings = Object.keys(raw)
    .filter((sourceField) => !forbiddenTargetFields.includes(sourceField as typeof forbiddenTargetFields[number]))
    .map((sourceField, index) => ({
      id: `push-default-mapping-${index + 1}-${sourceField}`,
      sourceField,
      targetField: sourceField
    }))

  assert.equal(
    isLegacyDefaultPushFieldMappings(legacyMappings, raw),
    true,
    'a complete old same-name mapping set must be recognized as legacy'
  )

  const withoutOneRow = legacyMappings.slice(1)
  assert.equal(
    isLegacyDefaultPushFieldMappings(withoutOneRow, raw),
    true,
    'an old generated subset must remain recognizable when the current raw field shape changed'
  )

  const withChangedTarget = legacyMappings.map((mapping, index) => (
    index === 0 ? { ...mapping, targetField: 'RenamedSource' } : mapping
  ))
  assert.equal(
    isLegacyDefaultPushFieldMappings(withChangedTarget, raw),
    false,
    'changing one target must not be treated as an untouched legacy set'
  )

  const withAddedRow = [
    ...legacyMappings,
    { id: 'user-added-mapping', sourceField: 'CustomField', targetField: 'CustomField' }
  ]
  assert.equal(
    isLegacyDefaultPushFieldMappings(withAddedRow, raw),
    false,
    'adding a row must not be treated as an untouched legacy set'
  )

  assert.equal(
    isLegacyDefaultPushFieldMappings([], raw),
    false,
    'an empty mapping list with non-empty raw data is not a complete legacy set'
  )
}

const testDraftVersionMigrationAndV3Persistence = (): void => {
  const legacyMappings = [
    { id: 'push-default-mapping-1-Source', sourceField: 'Source', targetField: 'Source' },
    { id: 'push-default-mapping-2-_valm_Description', sourceField: '_valm_Description', targetField: '_valm_Description' },
    { id: 'push-default-mapping-3-Priority', sourceField: 'Priority', targetField: 'Priority' }
  ]
  const v1Draft = {
    version: 1,
    formValues: {
      nodeType: 'Task',
      projectId: 'project-v1',
      componentId: 'component-v1',
      parentId: 'parent-v1',
      insertAfterId: 'after-v1',
      insertBeforeId: 'before-v1'
    },
    fieldMappings: legacyMappings,
    mappingInitialized: true,
    selectedRowKeys: ['v1-row-1', 'v1-row-2'],
    search: '历史筛选',
    releaseText: '旧版本',
    page: 4,
    pageSize: 30
  }

  const migrated = parsePushConfigDraft(v1Draft)
  assert.ok(migrated, 'v1 drafts must remain readable')
  assert.equal(migrated.version, 3, 'v1 drafts must migrate to the v3 draft version')
  assert.deepEqual(migrated.formValues, v1Draft.formValues, 'v1 migration must preserve form values')
  assert.deepEqual(migrated.fieldMappings, legacyMappings, 'v1 migration must preserve legacy mappings for later default detection')
  assert.equal(migrated.mappingInitialized, true, 'v1 migration must preserve mappingInitialized')
  assert.deepEqual(migrated.selectedRowKeys, v1Draft.selectedRowKeys, 'v1 migration must preserve selection')
  assert.equal(migrated.search, v1Draft.search, 'v1 migration must preserve search filter')
  assert.equal(migrated.releaseText, v1Draft.releaseText, 'v1 migration must preserve release filter')
  assert.equal(migrated.page, v1Draft.page, 'v1 migration must preserve page')
  assert.equal(migrated.pageSize, v1Draft.pageSize, 'v1 migration must preserve page size')

  const v2Draft = {
    ...migrated,
    version: 2 as const,
    fieldMappings: [
      { id: 'manual-source', sourceField: 'Source', targetField: 'RequireBy' },
      { id: 'manual-description', sourceField: '_valm_Description', targetField: 'UserStoryDescription' },
      { id: 'manual-item-id', sourceField: '_valm_ItemID', targetField: 'AcceptCriteria' }
    ]
  }
  const parsedV2 = parsePushConfigDraft(v2Draft)
  assert.ok(parsedV2, 'v2 drafts must remain readable')
  assert.equal(parsedV2.version, 3, 'v2 drafts must migrate to the v3 draft version')
  assert.deepEqual(parsedV2.formValues, v2Draft.formValues, 'v2 parsing must preserve form values')
  assert.deepEqual(parsedV2.fieldMappings, v2Draft.fieldMappings, 'v2 parsing must preserve user mappings')
  assert.deepEqual(parsedV2.selectedRowKeys, v2Draft.selectedRowKeys, 'v2 parsing must preserve selection')
  assert.equal(parsedV2.search, v2Draft.search, 'v2 parsing must preserve search filter')
  assert.equal(parsedV2.releaseText, v2Draft.releaseText, 'v2 parsing must preserve release filter')
  assert.equal(parsedV2.page, v2Draft.page, 'v2 parsing must preserve page')
  assert.equal(parsedV2.pageSize, v2Draft.pageSize, 'v2 parsing must preserve page size')

  const storage = new Map<string, string>([[legacyPushConfigDraftStorageKey, JSON.stringify(v2Draft)]])
  let writtenKey = ''
  let writtenValue = ''
  const globalWithWindow = globalThis as unknown as {
    window?: {
      localStorage: {
        getItem: (key: string) => string | null
        setItem: (key: string, value: string) => void
      }
    }
  }
  const previousWindow = globalWithWindow.window
  globalWithWindow.window = {
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value)
        writtenKey = key
        writtenValue = value
      }
    }
  }
  try {
    const recovered = readPushConfigDraft()
    assert.ok(recovered, 'reader must recover a v2 draft when no v3 draft exists')
    assert.equal(recovered.version, 3, 'reader must normalize the recovered draft to v3')
    assert.deepEqual(recovered.formValues, v2Draft.formValues, 'reader must preserve recovered form state')
    assert.ok(storage.has(legacyPushConfigDraftStorageKey), 'reader must keep the v2 key for rollback safety')
    assert.ok(storage.has(pushConfigDraftStorageKey), 'reader must materialize the normalized v3 draft')
    writePushConfigDraft(parsedV2 as Parameters<typeof writePushConfigDraft>[0])
  } finally {
    if (previousWindow === undefined) delete globalWithWindow.window
    else globalWithWindow.window = previousWindow
  }
  assert.ok(writtenKey, 'v3 writer must write to localStorage')
  assert.equal(writtenKey, pushConfigDraftStorageKey, 'writer must use the versioned v3 storage key')
  const persisted = JSON.parse(writtenValue) as { version?: unknown; fieldMappings?: unknown }
  assert.equal(persisted.version, 3, 'writer must persist v3 drafts')
  assert.deepEqual(persisted.fieldMappings, parsedV2.fieldMappings, 'writer must persist migrated mappings')
}

const testLegacyDetectionSurvivesRawShapeChanges = (): void => {
  const rawWithNewFieldsAndChangedOrder = {
    Priority: 'P1',
    NewBusinessField: 'new',
    _valm_ItemID: 'ITEM-2',
    Source: 'source',
    _valm_Description: 'description',
    _valm_Uid: 'uid-2',
    _valm_NodeType: 'Task'
  }
  const oldAutomaticMappings = [
    { id: 'push-default-mapping-1-Source', sourceField: 'Source', targetField: 'Source' },
    { id: 'push-default-mapping-2-_valm_Description', sourceField: '_valm_Description', targetField: '_valm_Description' },
    { id: 'push-default-mapping-3-Priority', sourceField: 'Priority', targetField: 'Priority' }
  ]
  assert.equal(
    isLegacyDefaultPushFieldMappings(oldAutomaticMappings, rawWithNewFieldsAndChangedOrder),
    true,
    'old automatic mappings must remain recognizable after raw fields are added or reordered'
  )
  const mappingsFromPreviousFirstRecord = [
    ...oldAutomaticMappings,
    {
      id: 'push-default-mapping-4-PreviousRecordOnly',
      sourceField: 'PreviousRecordOnly',
      targetField: 'PreviousRecordOnly'
    }
  ]
  assert.equal(
    isLegacyDefaultPushFieldMappings(mappingsFromPreviousFirstRecord, rawWithNewFieldsAndChangedOrder),
    true,
    'an old automatic set must remain recognizable when the current first record has a different shape'
  )

  const v2AutomaticMappings = [
    { id: 'push-default-mapping-1-Source', sourceField: 'Source', targetField: 'RequireBy' },
    {
      id: 'push-default-mapping-2-_valm_Description',
      sourceField: '_valm_Description',
      targetField: 'UserStoryDescription'
    },
    { id: 'push-default-mapping-3-_valm_ItemID', sourceField: '_valm_ItemID', targetField: 'AcceptCriteria' },
    { id: 'push-default-mapping-4-RAO', sourceField: 'RAO', targetField: 'RAO' },
    {
      id: 'push-default-mapping-5-TSIS_ClarifyInfo',
      sourceField: 'TSIS_ClarifyInfo',
      targetField: 'TSIS_ClarifyInfo'
    },
    { id: 'push-default-mapping-6-Priority', sourceField: 'Priority', targetField: 'Priority' }
  ]
  const v2AutomaticDraft = {
    version: 2,
    formValues: { nodeType: 'Task', projectId: 'project-v2' },
    fieldMappings: v2AutomaticMappings,
    mappingInitialized: true,
    selectedRowKeys: ['v2-row-1'],
    search: 'v2 筛选',
    page: 2,
    pageSize: 20
  }
  const upgradedAutomaticDraft = parsePushConfigDraft(v2AutomaticDraft)
  assert.ok(upgradedAutomaticDraft, 'v2 automatic drafts must remain readable')
  assert.equal(upgradedAutomaticDraft.version, 3, 'v2 automatic drafts must migrate to v3')
  assert.equal(
    upgradedAutomaticDraft.mappingMigrationPending,
    true,
    'v2 automatic defaults must remain eligible for alias upgrade'
  )

  const editedTarget = oldAutomaticMappings.map((mapping, index) => (
    index === 0 ? { ...mapping, targetField: 'EditedRequireBy' } : mapping
  ))
  assert.equal(
    isLegacyDefaultPushFieldMappings(editedTarget, rawWithNewFieldsAndChangedOrder),
    false,
    'a user-edited target must not be treated as an old automatic mapping'
  )
  const userRenamedId = oldAutomaticMappings.map((mapping, index) => (
    index === 0 ? { ...mapping, id: 'user-mapping-1' } : mapping
  ))
  assert.equal(
    isLegacyDefaultPushFieldMappings(userRenamedId, rawWithNewFieldsAndChangedOrder),
    false,
    'a mapping with a user-owned ID must not be treated as an old automatic mapping'
  )

  const editedTargetDraft = parsePushConfigDraft({
    ...v2AutomaticDraft,
    fieldMappings: editedTarget
  })
  assert.ok(editedTargetDraft, 'edited v2 drafts must remain readable')
  assert.equal(
    editedTargetDraft.mappingMigrationPending,
    undefined,
    'a changed v2 target must not be upgraded as an automatic default'
  )
  const userRenamedIdDraft = parsePushConfigDraft({
    ...v2AutomaticDraft,
    fieldMappings: userRenamedId
  })
  assert.ok(userRenamedIdDraft, 'v2 drafts with user IDs must remain readable')
  assert.equal(
    userRenamedIdDraft.mappingMigrationPending,
    undefined,
    'a user-owned v2 mapping ID must not be upgraded as an automatic default'
  )

  const defaults = buildDefaultPushFieldMappings(rawWithNewFieldsAndChangedOrder)
  const targetBySource = new Map(defaults.map(({ sourceField, targetField }) => [sourceField, targetField]))
  assert.equal(targetBySource.get('Source'), 'RequireBy')
  assert.equal(targetBySource.get('_valm_Description'), 'UserStoryDescription')
  assert.equal(targetBySource.get('_valm_ItemID'), 'AcceptCriteria')
  assert.equal(targetBySource.get('NewBusinessField'), 'NewBusinessField')
  assert.equal(targetBySource.get('Priority'), 'Priority')
}

const main = (): void => {
  testForbiddenMappingsAreRemovedWithoutLosingDraftState()
  testInitializedFlagSurvivesWhenOnlyForbiddenMappingsRemain()
  testCorruptedDraftsReturnNull()
  testDefaultMappingsPreferBusinessAliases()
  testLegacyDefaultMappingsAreRecognizedPrecisely()
  testDraftVersionMigrationAndV3Persistence()
  testLegacyDetectionSurvivesRawShapeChanges()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      '_valm_Uid/_valm_NodeType sources and all three forbidden targets are removed',
      '_valm_ItemID remains legal as a source when mapped to AcceptCriteria',
      'valid mappings and form/filter/selection/pagination state survive recovery',
      'mappingInitialized remains true after forbidden mappings are filtered',
      'corrupted drafts return null',
      'default mappings prefer business aliases (including RAO/ClarifyInfo) and avoid target collisions',
      'legacy generated same-name defaults are recognized without overriding user edits',
      'v1/v2 drafts migrate to v3 while preserving state and v3 writes round-trip',
      'legacy detection tolerates raw field additions/reordering and preserves final aliases'
    ]
  }))
}

main()
