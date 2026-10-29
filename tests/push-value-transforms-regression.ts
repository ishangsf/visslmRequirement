import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { PushService, type VisslmClient } from '../src/main/visslm'
import { compilePushValueTransforms } from '../src/shared/push-value-transforms'
import type { PushConfig, PushValueOptions } from '../src/shared/types'
import { parsePushConfigDraft, pushConfigDraftStorageKey, readPushConfigDraft, writePushConfigDraft } from '../src/renderer/src/push-config-draft'

const options: PushValueOptions = {
  userMappingFields: ['Devs', 'Reviewers'],
  userMappings: [
    { id: 'a', sourceLogin: 'alice.ext', targetLogin: 'alice.internal' },
    { id: 'b', sourceLogin: 'bob.ext', targetLogin: 'bob.internal' }
  ],
  fixedParameters: [
    { id: 'text', location: 'body', key: 'Source', valueType: 'text', value: '内网导入' },
    { id: 'json', location: 'body', key: 'Flags', valueType: 'json', value: '{"enabled":true,"count":0,"tags":["a"],"empty":null}' },
    { id: 'query', location: 'query', key: 'workflow', valueType: 'text', value: '审批 & 导入=1' }
  ]
}
const transform = compilePushValueTransforms(options)
assert.deepEqual(transform({ Devs: 'alice.ext; bob.ext，alice.ext\nbob.ext', Reviewers: ['bob.ext', null, ''], Description: 'alice.ext' }, {}).body, {
  Devs: 'alice.internal;bob.internal，alice.internal\nbob.internal', Reviewers: ['bob.internal', null, ''], Description: 'alice.ext',
  Source: '内网导入', Flags: { enabled: true, count: 0, tags: ['a'], empty: null }
})
assert.throws(() => transform({ Devs: 'Alice.ext' }, {}), /未配置映射/)
assert.throws(() => transform({ Devs: { login: 'alice.ext' } }, {}), /数据结构/)
assert.equal(compilePushValueTransforms({ ...options, unmappedUserPolicy: 'keep' })({ Devs: 'alice.ext;unknown' }, {}).body.Devs, 'alice.internal;unknown')
assert.equal(compilePushValueTransforms({ ...options, fixedParameters: [
  { id: 'override', location: 'body', key: 'Devs', valueType: 'text', value: 'fixed.internal' }
] })({ Devs: 'unknown' }, {}).body.Devs, 'fixed.internal')
for (const key of ['user', 'ApiToken', 'projectId', 'nodeType', 'insertBeforeId']) {
  assert.throws(() => compilePushValueTransforms({ fixedParameters: [
    { id: 'bad', location: 'query', key, valueType: 'text', value: 'bad' }
  ] }), /冲突/)
}
for (const key of ['_valm_Uid', '_valm_ItemID', '_valm_NodeType', '__proto__', 'constructor', 'x.__proto__']) {
  assert.throws(() => compilePushValueTransforms({ fixedParameters: [
    { id: 'bad', location: 'body', key, valueType: 'text', value: 'bad' }
  ] }))
}
for (const value of ['{oops}', 'undefined', '1e999']) {
  assert.throws(() => compilePushValueTransforms({ fixedParameters: [
    { id: 'bad', location: 'body', key: 'Flags', valueType: 'json', value }
  ] }), /JSON/)
}
assert.throws(() => compilePushValueTransforms({ ...options, userMappings: [...options.userMappings!, options.userMappings![0]] }), /重复/)
assert.throws(() => compilePushValueTransforms({ ...options, fixedParameters: [...options.fixedParameters!, options.fixedParameters![0]] }), /重复/)
assert.throws(() => compilePushValueTransforms({ ...options, userMappingFields: [] }), /目标字段/)
assert.throws(() => compilePushValueTransforms({ ...options, userMappings: [] }), /至少/)

const directory = mkdtempSync(join(tmpdir(), 'push-values-regression-'))
const db = new AppDatabase(join(directory, 'data.db'), join(directory, 'assets'))
const calls: Array<{ params: Record<string, string>; body: Record<string, unknown> }> = []
const client = {
  createItemEndpoint: () => 'https://internal.example.test/rest/items',
  createItemTraceParams: (params: Record<string, string>) => ({ ...params, user: 'service-user', ApiToken: '******' }),
  createItem: async (params: Record<string, string>, body: Record<string, unknown>) => {
    calls.push({ params, body })
    return { httpStatus: 200, data: { ErrorCode: 0, props: { _valm_Uid: `created-${calls.length}` } } }
  }
} as unknown as VisslmClient
try {
  for (const [uid, rao] of [['first', 'alice.ext;bob.ext'], ['second', 'unknown']]) {
    db.upsertRecord({ uid, projectId: 'source', nodeType: 'Task', itemId: uid, parentId: '', name: uid,
      lastModifyTime: '', normalizedText: uid, raw: { RAO: rao, Reviewers: ['bob.ext'], Source: 'original', Secret: 'unmapped' } })
  }
  const service = new PushService(db, () => client)
  const config: PushConfig = {
    ...options, recordUids: ['first'], nodeType: 'Task', projectId: 'internal',
    fieldMappings: [
      { id: 'dev', sourceField: 'RAO', targetField: 'Devs' },
      { id: 'review', sourceField: 'Reviewers', targetField: 'Reviewers' },
      { id: 'source', sourceField: 'Source', targetField: 'Source' }
    ]
  }
  const preview = service.preview(config)
  assert.equal(calls.length, 0)
  assert.equal(preview.requests[0].body.Devs, 'alice.internal;bob.internal')
  assert.equal(preview.requests[0].body.Source, '内网导入')
  assert.equal(preview.requests[0].body.Secret, undefined)
  assert.equal(preview.requests[0].params.workflow, '审批 & 导入=1')
  assert.throws(() => service.preview({ ...config, userMappingFields: ['RAO'] }), /不在推送目标字段/)
  await assert.rejects(service.push({ ...config, recordUids: ['first', 'second'] }), /second.*unknown.*未配置映射/)
  assert.equal(calls.length, 0, 'validate the whole batch before sending any record')
  const result = await service.push(config)
  assert.equal(result.successCount, 1)
  assert.deepEqual(calls[0].body, preview.requests[0].body)
  assert.equal(calls[0].params.workflow, preview.requests[0].params.workflow)
  assert.equal(calls[0].params.ApiToken, undefined)
  assert.equal(db.getRecord('first', false)!.raw.RAO, 'alice.ext;bob.ext')
  const constantsOnly = service.preview({ ...config, fieldMappings: [], userMappingFields: [], userMappings: [] })
  assert.deepEqual(Object.keys(constantsOnly.requests[0].body).sort(), ['Flags', 'Source'])
  const legacy = service.preview({ ...config, fieldMappings: undefined, userMappingFields: ['RAO'] })
  assert.equal(legacy.requests[0].body.RAO, 'alice.internal;bob.internal')
} finally {
  db.close()
  rmSync(directory, { recursive: true, force: true })
}

const draft = parsePushConfigDraft({ version: 3, fieldMappings: [], valueOptions: options })!
assert.deepEqual(compilePushValueTransforms(draft.valueOptions!)({ Devs: 'alice.ext' }, {}), transform({ Devs: 'alice.ext' }, {}))
const storage = new Map<string, string>()
const previousWindow = globalThis.window
Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value)
} } })
try {
  writePushConfigDraft(draft)
  assert.ok(storage.has(pushConfigDraftStorageKey))
  assert.deepEqual(readPushConfigDraft()?.valueOptions, draft.valueOptions)
  storage.set(pushConfigDraftStorageKey, '{bad')
  assert.equal(readPushConfigDraft(), null)
} finally {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
}
console.log('Push user mappings, fixed parameters, preview/execution parity, atomic preflight and draft persistence passed')
