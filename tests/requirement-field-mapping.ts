import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AppDatabase } from '../src/main/database'
import type { FieldDefinition, RecordInput } from '../src/shared/types'

const NODE_TYPE = 'Requirement'

const definition = (field: string, displayName: string): FieldDefinition => ({
  nodeType: NODE_TYPE,
  field,
  displayName,
  sourceType: 'SINGLELINETEXT',
  normalizedType: 'string',
  attrType: '文本',
  sourceUid: `field-definition-${field}`,
  internalMember: field,
  conditionUid: '',
  isSystem: false,
  isEditable: true,
  isRemovable: true
})

const internalDefinitions = (): FieldDefinition[] => [
  definition('内网标题字段', '需求名称'),
  definition('内网描述字段', '需求描述'),
  definition('内网类型字段', '问题类型'),
  definition('内网产品字段', '产品'),
  definition('内网模块字段', '功能模块')
]

const internalRecord: RecordInput = {
  uid: 'field-mapping-internal-record',
  projectId: 'field-mapping-project',
  nodeType: NODE_TYPE,
  itemId: 'FIELD-MAPPING-1',
  parentId: '',
  name: '数据中心通用名称',
  lastModifyTime: '2026-08-27T00:00:00.000Z',
  raw: {
    内网标题字段: '内网需求：流程权限配置',
    内网描述字段: '<p>内网描述应进入向量索引</p>',
    内网类型字段: '缺陷',
    内网产品字段: '统一门户',
    内网模块字段: '权限中心'
  },
  normalizedText: '旧版 normalizedText 不应决定业务索引内容'
}

const legacyRecord: RecordInput = {
  uid: 'field-mapping-legacy-record',
  projectId: 'field-mapping-project',
  nodeType: NODE_TYPE,
  itemId: 'FIELD-MAPPING-2',
  parentId: '',
  name: '外网兼容名称',
  lastModifyTime: '2026-08-27T00:00:00.000Z',
  raw: {
    IssueType: 'Enhancement',
    _valm_ProductDomain: '外网产品域',
    _valm_Module: '外网模块',
    _valm_Description: '<p>外网描述仍需被保留</p>'
  },
  normalizedText: '外网兼容旧 normalizedText'
}

const withDatabase = async <T>(worker: (db: AppDatabase) => Promise<T> | T): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), 'requirement-field-mapping-'))
  let db: AppDatabase | undefined
  try {
    db = new AppDatabase(join(directory, 'field-mapping.db'), join(directory, 'assets'))
    return await worker(db)
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const testNodeTypeFieldDefinitionsAndLegacyAliases = async (): Promise<void> => {
  await withDatabase(async (db) => {
    db.upsertRecord(internalRecord)
    db.upsertRecord(legacyRecord)
    db.upsertRecord({
      ...internalRecord,
      uid: 'field-mapping-other-node-type',
      nodeType: 'Incident',
      itemId: 'FIELD-MAPPING-3'
    })

    assert.equal(db.replaceFieldDefinitions(internalDefinitions()), true)

    const internal = db.getKnowledgeRecordIndexRow(internalRecord.uid)
    assert.ok(internal)
    assert.match(internal.content, /内网需求：流程权限配置/)
    assert.match(internal.content, /内网描述应进入向量索引/)
    assert.match(internal.content, /缺陷/)
    assert.match(internal.content, /统一门户/)
    assert.match(internal.content, /权限中心/)
    assert.doesNotMatch(internal.content, /<p>|旧版 normalizedText/)

    const legacy = db.getKnowledgeRecordIndexRow(legacyRecord.uid)
    assert.ok(legacy)
    assert.match(legacy.content, /外网兼容名称/)
    assert.match(legacy.content, /Enhancement/)
    assert.match(legacy.content, /外网产品域/)
    assert.match(legacy.content, /外网模块/)
    assert.match(legacy.content, /外网描述仍需被保留/)

    const otherNodeType = db.getKnowledgeRecordIndexRow('field-mapping-other-node-type')
    assert.ok(otherNodeType)
    assert.doesNotMatch(
      otherNodeType.content,
      /内网需求：流程权限配置|内网描述应进入向量索引|统一门户|权限中心/,
      'a Requirement field catalogue must not leak into another nodeType'
    )
  })
}

const testFieldDefinitionChangeInvalidatesSourceHash = async (): Promise<void> => {
  await withDatabase(async (db) => {
    db.upsertRecord(internalRecord)
    const initialDefinitions = internalDefinitions()
    assert.equal(db.replaceFieldDefinitions(initialDefinitions), true)
    const before = db.getKnowledgeRecordIndexRow(internalRecord.uid)
    assert.ok(before)
    assert.match(before.content, /内网描述应进入向量索引/)

    // Keep the same raw payload but change the declaration.  The index source
    // hash must include the effective field mapping/revision, otherwise an old
    // vector can be incorrectly treated as current after catalog sync.
    const changedDefinitions = initialDefinitions.map((item) => (
      item.field === '内网描述字段'
        ? { ...item, displayName: '普通备注字段' }
        : item
    ))
    assert.equal(db.replaceFieldDefinitions(changedDefinitions), true)
    const after = db.getKnowledgeRecordIndexRow(internalRecord.uid)
    assert.ok(after)
    assert.notEqual(
      after.contentHash,
      before.contentHash,
      'field-definition changes must invalidate the vector source hash'
    )

    // Even a declaration that is not populated by this row changes the
    // catalogue contract.  Its revision must be part of the source identity
    // so a vector built against one field catalogue is never reused under a
    // different catalogue with coincidentally identical extracted text.
    const withUnusedField = [
      ...changedDefinitions,
      definition('内网未使用字段', '未使用字段')
    ]
    assert.equal(db.replaceFieldDefinitions(withUnusedField), true)
    const afterUnusedField = db.getKnowledgeRecordIndexRow(internalRecord.uid)
    assert.ok(afterUnusedField)
    assert.equal(
      afterUnusedField.content,
      after.content,
      'an unused field declaration must not add empty business text'
    )
    assert.notEqual(
      afterUnusedField.contentHash,
      after.contentHash,
      'any field-definition/catalogue change must invalidate the vector source hash'
    )
  })
}

await testNodeTypeFieldDefinitionsAndLegacyAliases()
await testFieldDefinitionChangeInvalidatesSourceHash()

console.log(JSON.stringify({
  ok: true,
  contract: 'requirement-field-mapping',
  checks: [
    'nodeType-scoped Chinese field labels map internal keys into business text',
    'field labels do not leak across node types',
    'legacy external aliases remain supported',
    'field-definition changes invalidate vector source hash'
  ]
}, null, 2))
