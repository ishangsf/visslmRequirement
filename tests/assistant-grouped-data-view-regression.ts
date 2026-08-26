import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppDatabase } from '../src/main/database'
import { DataCenterAgent } from '../src/main/assistant/agents/data-center-agent'
import {
  compactChatDataViews,
  compactChatMessageForPersistence
} from '../src/main/context-budget'
import type {
  ChatDataGroup,
  ChatDataView,
  ChatMessage
} from '../src/shared/types'

type GroupWithRecordUids = ChatDataGroup & { recordUids?: string[] }
type GroupedDataView = Omit<ChatDataView, 'groups'> & { groups: GroupWithRecordUids[] }

const projectId = 'assistant-grouped-view-project'

const groupSpecs = [
  { name: '组甲', count: 5 },
  { name: '组乙', count: 6 },
  { name: '组丙', count: 4 },
  { name: '组丁', count: 6 }
] as const

const fixtures = groupSpecs.flatMap(({ name, count }) => Array.from({ length: count }, (_unused, index) => ({
  group: name,
  uid: `grouped-view-${name}-${String(index + 1).padStart(2, '0')}`,
  itemId: `GROUPED-VIEW-${name}-${String(index + 1).padStart(2, '0')}`,
  name: `需求分组-${name}-${String(index + 1).padStart(2, '0')}`
})))

const allFixtureUids = fixtures.map((fixture) => fixture.uid)

const largeProjectId = 'assistant-grouped-view-large-project'

const largeGroupSpecs = [
  { name: '组甲', count: 55 },
  { name: '组乙', count: 6 }
] as const

const largeFixtures = largeGroupSpecs.flatMap(({ name, count }) => Array.from({ length: count }, (_unused, index) => ({
  group: name,
  uid: `grouped-view-large-${name}-${String(index + 1).padStart(2, '0')}`,
  itemId: `GROUPED-VIEW-LARGE-${name}-${String(index + 1).padStart(2, '0')}`,
  name: `需求分组-${name}-${String(index + 1).padStart(2, '0')}`
})))

const allLargeFixtureUids = largeFixtures.map((fixture) => fixture.uid)

const seedFixtures = (db: AppDatabase): void => {
  for (const fixture of fixtures) {
    db.upsertRecord({
      uid: fixture.uid,
      projectId,
      nodeType: 'Requirement',
      itemId: fixture.itemId,
      parentId: '',
      name: fixture.name,
      lastModifyTime: new Date(0).toISOString(),
      raw: {
        Owner: fixture.group,
        Summary: fixture.name,
        _valm_Description: `${fixture.group} 的分组回归记录。`
      },
      normalizedText: `${fixture.name}：${fixture.group} 的分组回归记录。`
    })
  }
}

const seedLargeFixtures = (db: AppDatabase): void => {
  for (const fixture of largeFixtures) {
    db.upsertRecord({
      uid: fixture.uid,
      projectId: largeProjectId,
      nodeType: 'Requirement',
      itemId: fixture.itemId,
      parentId: '',
      name: fixture.name,
      lastModifyTime: new Date(0).toISOString(),
      raw: {
        Owner: fixture.group,
        Summary: fixture.name,
        _valm_Description: `${fixture.group} 的大结果集分组回归记录。`
      },
      normalizedText: `${fixture.name}：${fixture.group} 的大结果集分组回归记录。`
    })
  }
}

const newDatabase = async (): Promise<{
  directory: string
  db: AppDatabase
}> => {
  const directory = await mkdtemp(join(tmpdir(), 'assistant-grouped-view-'))
  return {
    directory,
    db: new AppDatabase(join(directory, 'grouped-view.db'), join(directory, 'assets'))
  }
}

const toGroupedView = (view: ChatDataView): GroupedDataView => (
  view as GroupedDataView
)

const groupUids = (group: GroupWithRecordUids): string[] => (
  (group.recordUids ?? []).map((uid) => String(uid))
)

const uidSet = (uids: readonly string[]): Set<string> => new Set(uids)

const createGroupedView = (db: AppDatabase): ChatDataView => {
  const query = db.queryRecordsByFields({
    projectId,
    nodeType: 'Requirement',
    searchTerms: ['需求分组'],
    searchMode: 'any',
    fields: ['Owner'],
    limit: 50
  })
  assert.equal(query.matchedCount, 21)
  assert.equal(query.returnedCount, 21)
  assert.deepEqual(query.recordUids, allFixtureUids)
  return new DataCenterAgent(db).createDataView(
    'query_records_by_fields',
    {
      project_id: projectId,
      node_type: 'Requirement',
      result_mode: 'grouped_list',
      group_entities: groupSpecs.map((spec) => spec.name)
    },
    query,
    projectId
  )!
}

const assertGroupHasOnlyOwnRecords = (
  group: GroupWithRecordUids,
  expectedUids: readonly string[],
  expectedCount: number
): void => {
  const actualUids = groupUids(group)
  assert.equal(group.count, expectedCount, `${group.name} count must describe its own records`)
  assert.equal(actualUids.length, expectedCount, `${group.name} must retain every own UID`)
  assert.deepEqual(uidSet(actualUids), uidSet(expectedUids))
  assert.deepEqual(
    uidSet(group.rows.map((row) => row.uid)),
    uidSet(expectedUids),
    `${group.name} rows must not contain another group's records`
  )
  assert.equal(actualUids.every((uid) => expectedUids.includes(uid)), true)
}

const testGroupedViewRetainsIndependentUidIndexes = async (): Promise<void> => {
  const { directory, db } = await newDatabase()
  try {
    seedFixtures(db)
    const view = toGroupedView(createGroupedView(db))
    assert.equal(view.total, 21)
    assert.deepEqual(view.recordUids, allFixtureUids)
    assert.equal(view.groups.length, 4)

    for (const spec of groupSpecs) {
      const expectedUids = fixtures
        .filter((fixture) => fixture.group === spec.name)
        .map((fixture) => fixture.uid)
      const group = view.groups.find((candidate) => candidate.name === spec.name)
      assert.ok(group, `missing group ${spec.name}`)
      assertGroupHasOnlyOwnRecords(group!, expectedUids, spec.count)
    }
    assert.deepEqual(
      [...new Set(view.groups.flatMap(groupUids))].sort(),
      [...new Set(allFixtureUids)].sort(),
      'the union of group UID indexes must equal the top-level UID index'
    )
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testGroupPagingUsesOnlyTheSelectedGroup = async (): Promise<void> => {
  const { directory, db } = await newDatabase()
  try {
    seedFixtures(db)
    const view = toGroupedView(createGroupedView(db))
    for (const spec of groupSpecs) {
      const group = view.groups.find((candidate) => candidate.name === spec.name)
      assert.ok(group)
      const selectedUids = groupUids(group!)
      const expectedUids = fixtures
        .filter((fixture) => fixture.group === spec.name)
        .map((fixture) => fixture.uid)
      assert.deepEqual(selectedUids, expectedUids)
      // The renderer reuses the existing IPC request and scopes its
      // recordUids to the active group's own UID snapshot. Passing the
      // view-wide 21 IDs here would recreate the popup regression.
      const pageRequest = { recordUids: selectedUids, fields: view.fields }
      const firstPage = db.getChatDataViewPage(
        pageRequest,
        1,
        2
      )
      const secondPage = db.getChatDataViewPage(
        pageRequest,
        2,
        2
      )
      assert.equal(firstPage.total, spec.count, `${spec.name} page total must not use 21`)
      assert.equal(secondPage.total, spec.count, `${spec.name} page total must remain group-local`)
      assert.ok(firstPage.rows.length <= 2)
      assert.ok(secondPage.rows.length <= 2)
      const firstPageUids = firstPage.rows.map((row) => row.uid)
      const secondPageUids = secondPage.rows.map((row) => row.uid)
      assert.equal(firstPageUids.every((uid) => selectedUids.includes(uid)), true)
      assert.equal(secondPageUids.every((uid) => selectedUids.includes(uid)), true)
      assert.equal(new Set([...firstPageUids, ...secondPageUids]).size, firstPageUids.length + secondPageUids.length)
    }
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testLargePreviewRetainsCompleteGroupIndexes = async (): Promise<void> => {
  const { directory, db } = await newDatabase()
  try {
    seedLargeFixtures(db)
    const query = db.queryRecordsByFields({
      projectId: largeProjectId,
      nodeType: 'Requirement',
      searchTerms: largeGroupSpecs.map((spec) => spec.name),
      searchMode: 'any',
      fields: ['Owner'],
      limit: 50
    })
    assert.equal(query.matchedCount, 61)
    assert.equal(query.returnedCount, 50)
    assert.equal(query.records.length, 50)
    assert.deepEqual(query.recordUids, allLargeFixtureUids)

    const queryWithTermIndexes = query as typeof query & {
      recordUidsByTerm?: Record<string, string[]>
    }
    assert.ok(queryWithTermIndexes.recordUidsByTerm, 'large queries must expose complete UID indexes by search term')
    for (const spec of largeGroupSpecs) {
      const expectedUids = largeFixtures
        .filter((fixture) => fixture.group === spec.name)
        .map((fixture) => fixture.uid)
      assert.deepEqual(
        queryWithTermIndexes.recordUidsByTerm?.[spec.name],
        expectedUids,
        `${spec.name} search-term index must include all ${spec.count} matched UIDs`
      )
    }

    const dataCenterAgent = new DataCenterAgent(db)
    const view = toGroupedView(dataCenterAgent.createDataView(
      'query_records_by_fields',
      {
        project_id: largeProjectId,
        node_type: 'Requirement',
        result_mode: 'grouped_list',
        group_entities: largeGroupSpecs.map((spec) => spec.name)
      },
      query,
      largeProjectId
    )!)
    assert.equal(view.total, 61)
    assert.equal(view.loadedRows, 50)
    assert.equal(view.isPreview, true)

    const answer = dataCenterAgent.renderVerifiedAnswer(
      {
        sourceMode: 'records',
        needsClarification: false,
        resultMode: 'grouped_list',
        groupEntities: largeGroupSpecs.map((spec) => spec.name),
        intent: 'filter_records',
        explanation: '按实体分别列出匹配记录。',
        nodeType: 'Requirement',
        searchTerms: largeGroupSpecs.map((spec) => spec.name),
        searchMode: 'any',
        filters: [],
        fields: ['Owner'],
        limit: 50
      },
      query,
      '模型草稿不应覆盖结构化分组数量。'
    )
    assert.match(answer, /### 组甲（(?:共 )?55 条/)
    assert.match(answer, /### 组乙（(?:共 )?6 条/)
    assert.equal(
      answer.includes('### 组甲（50 条）'),
      false,
      'the answer must not present the 50-row preview as the complete first-group count'
    )

    for (const spec of largeGroupSpecs) {
      const expectedUids = largeFixtures
        .filter((fixture) => fixture.group === spec.name)
        .map((fixture) => fixture.uid)
      const group = view.groups.find((candidate) => candidate.name === spec.name)
      assert.ok(group, `missing large group ${spec.name}`)
      const groupRecordUids = groupUids(group!)
      assert.equal(group?.count, spec.count, `${spec.name} count must use complete matches, not the 50-row preview`)
      assert.deepEqual(groupRecordUids, expectedUids)
      assert.equal(
        group?.rows.every((row) => expectedUids.includes(row.uid)),
        true,
        `${spec.name} preview rows must not contain another group's records`
      )
    }

    const firstGroup = view.groups.find((candidate) => candidate.name === largeGroupSpecs[0].name)
    assert.ok(firstGroup)
    const lastPage = db.getChatDataViewPage(
      { recordUids: groupUids(firstGroup!), fields: view.fields },
      3,
      20
    )
    assert.equal(lastPage.total, 55, 'the third page must retain the complete first-group total')
    assert.equal(lastPage.page, 3)
    assert.equal(lastPage.pageSize, 20)
    assert.equal(lastPage.rows.length, 15)
    assert.equal(
      lastPage.rows.every((row) => groupUids(firstGroup!).includes(row.uid)),
      true,
      'the final page must remain scoped to the first group'
    )
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testFlatLegacyViewUsesTopLevelUidIndex = async (): Promise<void> => {
  const { directory, db } = await newDatabase()
  try {
    seedFixtures(db)
    const grouped = toGroupedView(createGroupedView(db))
    const flatLegacyView = {
      ...grouped,
      groups: [{
        name: '查询结果',
        count: grouped.total,
        rows: grouped.groups.flatMap((group) => group.rows)
      }]
    } as ChatDataView
    const compacted = compactChatDataViews([flatLegacyView])[0] as ChatDataView
    assert.deepEqual(compacted.recordUids, allFixtureUids)
    assert.equal((compacted.groups[0] as GroupWithRecordUids).recordUids, undefined)
    const page = db.getChatDataViewPage(
      { recordUids: compacted.recordUids, fields: compacted.fields },
      1,
      100
    )
    assert.equal(page.total, 21)
    assert.deepEqual(uidSet(page.rows.map((row) => row.uid)), uidSet(allFixtureUids))
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testGroupedUidIndexesSurviveCompactAndPersistence = async (): Promise<void> => {
  const { directory, db } = await newDatabase()
  try {
    seedFixtures(db)
    const view = toGroupedView(createGroupedView(db))
    const message: ChatMessage = {
      id: 'assistant-grouped-view-message',
      role: 'assistant',
      content: '已按实体分别整理。',
      createdAt: new Date(0).toISOString(),
      dataViews: [view]
    }
    const compacted = compactChatMessageForPersistence(message)
    const compactedView = toGroupedView(compacted.dataViews![0]!)
    assert.deepEqual(compactedView.recordUids, allFixtureUids)
    assert.deepEqual(
      compactedView.groups.map(groupUids),
      view.groups.map(groupUids),
      'session compact must retain every group UID index'
    )
    db.saveChatSession({
      id: 'assistant-grouped-view-session',
      title: '分组视图回归',
      messages: [compacted]
    })
    const restored = db.getChatSession('assistant-grouped-view-session')
    assert.ok(restored)
    const restoredView = toGroupedView(restored!.messages[0]!.dataViews![0]!)
    assert.deepEqual(restoredView.recordUids, allFixtureUids)
    assert.deepEqual(restoredView.groups.map(groupUids), view.groups.map(groupUids))
  } finally {
    db.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const testLegacyMessageWithoutGroupUidIndexRemainsReadable = (): void => {
  const legacyView = {
    id: 'legacy-flat-view',
    title: '旧版查询结果',
    description: '旧版本只有顶层 UID 索引。',
    total: 2,
    fields: ['Owner'],
    recordUids: ['legacy-record-1', 'legacy-record-2'],
    groups: [{
      name: '查询结果',
      count: 2,
      rows: []
    }]
  } as ChatDataView
  const message: ChatMessage = {
    id: 'legacy-message',
    role: 'assistant',
    content: '旧版结果',
    createdAt: new Date(0).toISOString(),
    dataViews: [legacyView]
  }
  assert.doesNotThrow(() => {
    const compacted = compactChatMessageForPersistence(message)
    assert.deepEqual(compacted.dataViews?.[0]?.recordUids, legacyView.recordUids)
    assert.equal(compacted.dataViews?.[0]?.groups[0]?.name, '查询结果')
  })
}

const main = async (): Promise<void> => {
  assert.equal(fixtures.length, 21)
  testLegacyMessageWithoutGroupUidIndexRemainsReadable()
  await testGroupedViewRetainsIndependentUidIndexes()
  await testGroupPagingUsesOnlyTheSelectedGroup()
  await testLargePreviewRetainsCompleteGroupIndexes()
  await testFlatLegacyViewUsesTopLevelUidIndex()
  await testGroupedUidIndexesSurviveCompactAndPersistence()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'four grouped entities retain independent UID indexes totaling 21 records',
      'group paging returns only the selected group and preserves its count',
      'large 50-row previews retain complete 55-record group indexes and final-page paging',
      'verified grouped answers preserve 55/6 group counts instead of labeling A as 50',
      'flat legacy views continue using the top-level UID index',
      'group UID indexes survive compact and session persistence',
      'legacy messages without group UID indexes remain readable'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
