import assert from 'node:assert/strict'

import {
  buildDefaultPushFieldMappings,
  isLegacyDefaultPushFieldMappings,
  parsePushConfigDraft
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
    Priority: 'P1',
    _valm_Uid: 'local-uid',
    _valm_NodeType: 'Task',
    RequireBy: 'legacy require-by value',
    UserStoryDescription: 'legacy description value',
    AcceptCriteria: 'legacy acceptance value'
  })

  const sourceAndTargets = mappings.map(({ sourceField, targetField }) => ({ sourceField, targetField }))
  assert.deepEqual(sourceAndTargets, [
    { sourceField: 'Source', targetField: 'RequireBy' },
    { sourceField: '_valm_Description', targetField: 'UserStoryDescription' },
    { sourceField: '_valm_ItemID', targetField: 'AcceptCriteria' },
    { sourceField: 'Priority', targetField: 'Priority' }
  ], 'default mappings must preserve aliases and ordinary business fields')
  assert.ok(!mappings.some(({ sourceField }) => forbiddenSourceFields.includes(sourceField as typeof forbiddenSourceFields[number])))
  assert.ok(!mappings.some(({ sourceField }) => (
    sourceField === 'RequireBy' ||
    sourceField === 'UserStoryDescription' ||
    sourceField === 'AcceptCriteria'
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
      id: `legacy-mapping-${index + 1}`,
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
    false,
    'deleting one old default mapping must not be treated as an untouched legacy set'
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

const main = (): void => {
  testForbiddenMappingsAreRemovedWithoutLosingDraftState()
  testInitializedFlagSurvivesWhenOnlyForbiddenMappingsRemain()
  testCorruptedDraftsReturnNull()
  testDefaultMappingsPreferBusinessAliases()
  testLegacyDefaultMappingsAreRecognizedPrecisely()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      '_valm_Uid/_valm_NodeType sources and all three forbidden targets are removed',
      '_valm_ItemID remains legal as a source when mapped to AcceptCriteria',
      'valid mappings and form/filter/selection/pagination state survive recovery',
      'mappingInitialized remains true after forbidden mappings are filtered',
      'corrupted drafts return null',
      'default mappings prefer business aliases and avoid target collisions',
      'legacy same-name defaults are recognized only when complete and unchanged'
    ]
  }))
}

main()
