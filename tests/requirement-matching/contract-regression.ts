import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../../src/main/database'
import {
  enforceRequirementRelationshipRules,
  RequirementAnalysisAgent,
  type RequirementMatchRelation,
  type RequirementReviewItem
} from '../../src/main/experts/requirement-analysis-agent'
import type { KnowledgeService } from '../../src/main/knowledge'
import type { ModelChatInput, ModelResponse } from '../../src/main/model-client'
import {
  buildRequirementSemanticCard,
  type RequirementSemanticCard
} from '../../src/main/requirements/semantic-card'
import type { HybridRequirementCandidate } from '../../src/main/requirements/hybrid-retrieval'
import type { ModelSettings, RecordDetail } from '../../src/shared/types'

const settings: ModelSettings = {
  source: 'local',
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  model: 'contract-test-model',
  thinking: false
}

const makeRecord = (overrides: Partial<RecordDetail>): RecordDetail => ({
  uid: 'test-uid',
  projectId: 'requirement-matching-contracts',
  nodeType: 'Requirement',
  itemId: 'TEST-ITEM',
  parentId: '',
  name: '测试需求',
  description: '测试需求内容。',
  lastModifyTime: new Date(0).toISOString(),
  syncedAt: new Date(0).toISOString(),
  imageCount: 0,
  normalizedText: '测试需求\n测试需求内容。',
  pushStatus: 'pending',
  pushMessage: '',
  pushedAt: '',
  pushedUid: '',
  raw: {},
  images: [],
  ...overrides
})

const upsert = (
  db: AppDatabase,
  input: { uid: string; itemId: string; name: string; description: string; issueType?: string; module?: string }
): void => {
  db.upsertRecord({
    uid: input.uid,
    projectId: 'requirement-matching-contracts',
    nodeType: 'Requirement',
    itemId: input.itemId,
    parentId: '',
    name: input.name,
    lastModifyTime: new Date(0).toISOString(),
    raw: {
      _valm_Description: input.description,
      IssueType: input.issueType ?? 'Enhancement',
      _valm_Module: input.module ?? '需求管理'
    },
    normalizedText: `${input.name}\n${input.description}`
  })
}

const candidateFor = (db: AppDatabase, uid: string, denseScore = 82): HybridRequirementCandidate => {
  const record = db.getRecord(uid, false)
  assert.ok(record, `missing fixture record ${uid}`)
  return {
    record,
    card: buildRequirementSemanticCard(record),
    denseScore,
    lexicalScore: denseScore - 3,
    structuralScore: denseScore - 5,
    retrievalScore: denseScore / 100,
    snippet: record.description
  }
}

const deterministicReranker = {
  modelId: 'requirement-matching-contract-reranker',
  async rerank(_base: RequirementSemanticCard, candidates: HybridRequirementCandidate[]) {
    return candidates.map((candidate, index) => ({
      recordUid: candidate.record.uid,
      score: 90 - index
    }))
  }
}

const semanticCard = (overrides: Partial<RequirementSemanticCard>): RequirementSemanticCard => ({
  requirementType: 'Enhancement',
  productDomain: '配置管理',
  module: '配置管理',
  functionalObject: '基线管理页面',
  action: 'unknown',
  currentState: '',
  targetState: '',
  trigger: '',
  input: '',
  output: '',
  behavior: '测试行为',
  constraints: '',
  acceptance: '',
  businessScene: '',
  evidence: '测试原文证据',
  matchingText: '测试语义卡',
  lexicalTerms: ['测试'],
  ...overrides
})

const reviewItem = (
  base: RequirementSemanticCard,
  candidate: RequirementSemanticCard,
  relation: RequirementMatchRelation,
  score: number,
  recordUid = 'candidate-uid'
): RequirementReviewItem => ({
  recordUid,
  relation,
  score,
  sharedEvidence: '同一业务场景',
  difference: '功能对象或动作存在差异',
  baseEvidence: base.evidence.slice(0, 32),
  candidateEvidence: candidate.evidence.slice(0, 32)
})

const testSemanticCardCleaningAndFieldLookup = (): void => {
  const dirty = makeRecord({
    uid: 'semantic-dirty',
    itemId: 'SEMANTIC-DIRTY',
    name: '<span>订单查询</span>',
    description: '<p>支持增加订单查询功能：按&nbsp;订单编号查询 &quot;订单&quot; &amp; 展示结果。</p><p>发布版本：V1.0</p><p>处理意见：忽略历史回复</p><script>alert(1)</script><style>.secret{display:none}</style><br/>验收标准：能够返回结果。',
    raw: {
      nested: {
        IssueType: '<b>Enhancement</b>',
        moduleName: '<i>订单管理</i>',
        productDomain: '订单管理'
      }
    }
  })
  const card = buildRequirementSemanticCard(dirty)
  const searchableText = [card.behavior, card.evidence, card.matchingText].join('\n')

  assert.equal(card.requirementType, 'Enhancement', 'type lookup should read nested IssueType aliases')
  assert.equal(card.module, '订单管理', 'module lookup should read nested moduleName aliases')
  assert.equal(card.productDomain, '订单管理', 'product domain lookup should read nested aliases')
  assert.equal(card.action, 'add_capability', 'cleaned behavior should still infer the business action')
  assert.ok(searchableText.includes('"订单" & 展示结果'), 'HTML entities should be decoded in semantic evidence')
  assert.ok(!searchableText.includes('<p>') && !searchableText.includes('&quot;'), 'HTML tags/entities must not reach matching text')
  assert.ok(!searchableText.includes('alert(1)') && !searchableText.includes('.secret'), 'script/style content must be removed')
  assert.ok(!searchableText.includes('发布版本') && !searchableText.includes('处理意见'), 'operational noise must be removed')

  const nestedFallback = makeRecord({
    uid: 'semantic-fallback',
    itemId: 'SEMANTIC-FALLBACK',
    name: '基线创建失败',
    description: '',
    raw: {
      payload: {
        IssueType: 'Defect',
        _valm_ModuleName: '配置管理',
        _valm_Description: '<p>配置管理页面无法创建基线。</p>'
      }
    }
  })
  const fallbackCard = buildRequirementSemanticCard(nestedFallback)
  assert.equal(fallbackCard.requirementType, 'Defect', 'type lookup should work when description comes from raw fields')
  assert.equal(fallbackCard.module, '配置管理', 'module lookup should work when description comes from raw fields')
  assert.equal(fallbackCard.action, 'fix_defect', 'Defect type and failure wording should infer fix_defect')
  assert.ok(fallbackCard.behavior.includes('无法创建基线'), 'nested raw description should be used as behavior')
}

const testActionAndObjectHardRules = (): void => {
  const renameBase = buildRequirementSemanticCard(makeRecord({
    uid: 'rename-base',
    name: '基线管理名称修改',
    description: '配置管理中“变更基线”按钮建议改为“创建基线”。',
    raw: { IssueType: 'Enhancement', _valm_Module: '配置管理' }
  }))
  const permissionCandidate = buildRequirementSemanticCard(makeRecord({
    uid: 'permission-candidate',
    name: '基线创建权限配置',
    description: '基线管理预设子页中的“创建基线”按钮支持权限设置。',
    raw: { IssueType: 'Enhancement', _valm_Module: '配置管理' }
  }))
  assert.equal(renameBase.action, 'rename_label', 'button wording change should infer rename_label')
  assert.equal(permissionCandidate.action, 'configure_permission', 'permission wording should infer configure_permission')
  const renameResult = enforceRequirementRelationshipRules(
    renameBase,
    permissionCandidate,
    reviewItem(renameBase, permissionCandidate, 'duplicate', 95, 'permission-candidate')
  )
  assert.equal(renameResult.relation, 'topic_only', 'rename and permission actions must not be formally matched')
  assert.ok(renameResult.score <= 39, 'rename hard rule must cap the downgraded score')

  const sameObjectBase = semanticCard({ action: 'add_capability', functionalObject: '基线管理页面', evidence: '基线页面增加按钮' })
  const differentAction = semanticCard({ action: 'configure_permission', functionalObject: '基线管理页面', evidence: '基线页面配置权限' })
  const overlapResult = enforceRequirementRelationshipRules(
    sameObjectBase,
    differentAction,
    reviewItem(sameObjectBase, differentAction, 'duplicate', 90)
  )
  assert.equal(overlapResult.relation, 'partial_overlap', 'same object with a different action may only be partial overlap')
  assert.ok(overlapResult.score <= 69, 'different-action rule must cap partial overlap confidence')

  const renameCandidate = semanticCard({ action: 'rename_label', functionalObject: '基线管理页面', evidence: '基线页面修改按钮文案' })
  const reverseRenameResult = enforceRequirementRelationshipRules(
    sameObjectBase,
    renameCandidate,
    reviewItem(sameObjectBase, renameCandidate, 'duplicate', 90)
  )
  assert.equal(reverseRenameResult.relation, 'topic_only', 'feature addition and wording change must not be formally matched in either direction')
  assert.ok(reverseRenameResult.score <= 39, 'symmetric wording rule must cap the downgraded score')

  const differentObject = semanticCard({ action: 'add_capability', functionalObject: '测试报告页面', evidence: '测试报告页面增加按钮' })
  const patternResult = enforceRequirementRelationshipRules(
    sameObjectBase,
    differentObject,
    reviewItem(sameObjectBase, differentObject, 'duplicate', 90)
  )
  assert.equal(patternResult.relation, 'same_pattern', 'same action with a different object may only be same_pattern')
  assert.ok(patternResult.score <= 59, 'different-object rule must cap same-pattern confidence')
}

type ReviewMode = 'relations' | 'topic-only' | 'invalid-evidence' | 'unknown-uid'

const createReviewModel = (
  mode: ReviewMode,
  relationByUid = new Map<string, RequirementMatchRelation>()
): {
  client: { chat(input: ModelChatInput): Promise<ModelResponse> }
  callCount: () => number
  candidateUids: string[][]
} => {
  let calls = 0
  const candidateUids: string[][] = []
  return {
    client: {
      async chat(input: ModelChatInput): Promise<ModelResponse> {
        calls += 1
        const content = input.messages.at(-1)?.content ?? '{}'
        const payload = JSON.parse(content) as {
          requirement?: { evidence?: string }
          candidates?: Array<{ recordUid: string; evidence?: string }>
        }
        const candidates = payload.candidates ?? []
        candidateUids.push(candidates.map((candidate) => candidate.recordUid))
        const baseEvidence = payload.requirement?.evidence?.slice(0, 32) || '基准证据'
        const validItem = (candidate: { recordUid: string; evidence?: string }, relation: RequirementMatchRelation) => ({
          recordUid: candidate.recordUid,
          relation,
          score: {
            duplicate: 90,
            highly_similar: 80,
            partial_overlap: 55,
            same_pattern: 45,
            topic_only: 20,
            unrelated: 10
          }[relation],
          sharedEvidence: '同一需求场景',
          difference: '功能对象或动作存在差异',
          baseEvidence,
          candidateEvidence: candidate.evidence?.slice(0, 32) || '候选证据'
        })

        if (mode === 'unknown-uid') {
          return {
            message: {
              role: 'assistant',
              content: JSON.stringify({
                summary: '未知 UID 测试',
                items: [{
                  ...validItem(candidates[0] ?? { recordUid: 'missing', evidence: '候选证据' }, 'topic_only'),
                  recordUid: 'unknown-candidate-uid'
                }]
              })
            }
          }
        }

        const items = candidates.map((candidate) => {
          const relation = mode === 'topic-only'
            ? 'topic_only'
            : relationByUid.get(candidate.recordUid) ?? 'topic_only'
          const item = validItem(candidate, relation)
          return mode === 'invalid-evidence'
            ? { ...item, baseEvidence: '不在基准原文中的证据', candidateEvidence: '不在候选原文中的证据' }
            : item
        })
        return {
          message: {
            role: 'assistant',
            content: JSON.stringify({ summary: `契约测试复核 ${mode}`, items })
          }
        }
      }
    },
    callCount: () => calls,
    candidateUids
  }
}

const createAgent = (
  db: AppDatabase,
  retriever: Pick<{ retrieve: (base: RequirementSemanticCard, excludedUids: Set<string>) => Promise<HybridRequirementCandidate[]> }, 'retrieve'>,
  model: ReturnType<typeof createReviewModel>
): RequirementAnalysisAgent => new RequirementAnalysisAgent(
  db,
  {} as KnowledgeService,
  settings,
  undefined,
  { retriever, reranker: deterministicReranker, modelClient: model.client }
)

const testMultipleBaseUidExclusion = async (db: AppDatabase): Promise<void> => {
  upsert(db, { uid: 'base-one-uid', itemId: 'BASE-1', name: '订单查询', description: '支持在订单页面查看订单详情。', module: '订单管理' })
  upsert(db, { uid: 'base-two-uid', itemId: 'BASE-2', name: '库存查询', description: '支持在库存页面查看库存详情。', module: '库存管理' })
  upsert(db, { uid: 'shared-candidate-uid', itemId: 'SHARED-CANDIDATE', name: '相关详情查询', description: '支持在需求页面查看相关详情。', module: '需求管理' })

  const excludedSnapshots: string[][] = []
  const model = createReviewModel('relations', new Map([['shared-candidate-uid', 'partial_overlap']]))
  const retriever = {
    async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      excludedSnapshots.push([...excludedUids].sort())
      return ['base-one-uid', 'base-two-uid', 'shared-candidate-uid']
        .filter((uid) => !excludedUids.has(uid))
        .map((uid) => candidateFor(db, uid))
    }
  }
  const response = await createAgent(db, retriever, model).ask({ question: '分析需求编号 BASE-1、BASE-2' })

  assert.deepEqual(excludedSnapshots, [
    ['base-one-uid', 'base-two-uid'],
    ['base-one-uid', 'base-two-uid']
  ], 'every base query must exclude all requested base record UIDs')
  assert.ok(model.candidateUids.every((uids) => uids.length === 1 && uids[0] === 'shared-candidate-uid'), 'excluded base UIDs must never reach AI review')
  assert.deepEqual(
    response.dataViews[0]?.groups.map((group) => group.name),
    ['BASE-1 · 参考关联需求', 'BASE-2 · 参考关联需求']
  )
}

const testTopicOnlyIsNotFormalMatch = async (db: AppDatabase): Promise<void> => {
  upsert(db, { uid: 'topic-base-uid', itemId: 'TOPIC-BASE', name: '订单查询', description: '支持在订单页面查看订单详情。', module: '订单管理' })
  upsert(db, { uid: 'topic-candidate-uid', itemId: 'TOPIC-CANDIDATE', name: '订单模块配置', description: '订单管理模块支持配置字段展示。', module: '订单管理' })
  const model = createReviewModel('topic-only')
  const retriever = {
    async retrieve(_base: RequirementSemanticCard, excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
      return excludedUids.has('topic-candidate-uid') ? [] : [candidateFor(db, 'topic-candidate-uid')]
    }
  }
  const response = await createAgent(db, retriever, model).ask({ question: '分析需求编号 TOPIC-BASE' })

  assert.equal(model.callCount(), 2, 'topic-only candidate should complete both review passes')
  assert.equal(response.dataViews.length, 0, 'topic_only must not be promoted into a formal/reference result table')
  assert.equal(response.sources.length, 0, 'topic_only must not be exposed as a source')
  assert.match(response.answer, /未发现业务目标一致的高度相似或重复需求/)
  assert.ok(!response.answer.includes('TOPIC-CANDIDATE'), 'topic_only candidate must not leak into the answer')
}

const testReviewFailuresCloseResults = async (db: AppDatabase): Promise<void> => {
  upsert(db, { uid: 'failure-base-uid', itemId: 'FAILURE-BASE', name: '失败关闭基准', description: '支持在配置页面查看配置详情。', module: '配置管理' })
  upsert(db, { uid: 'failure-candidate-uid', itemId: 'FAILURE-CANDIDATE', name: '失败关闭候选', description: '支持在配置页面查看相关详情。', module: '配置管理' })

  for (const mode of ['invalid-evidence', 'unknown-uid'] as const) {
    const model = createReviewModel(mode)
    const retriever = {
      async retrieve(_base: RequirementSemanticCard, _excludedUids: Set<string>): Promise<HybridRequirementCandidate[]> {
        return [candidateFor(db, 'failure-candidate-uid')]
      }
    }
    const response = await createAgent(db, retriever, model).ask({ question: '分析需求编号 FAILURE-BASE' })

    assert.equal(model.callCount(), 2, `${mode} must retry exactly once before closing`)
    assert.equal(response.dataViews.length, 0, `${mode} must not expose a partial result table`)
    assert.equal(response.sources.length, 0, `${mode} must not expose unverified sources`)
    assert.match(response.answer, /精准匹配失败关闭/)
    assert.ok(!response.answer.includes('FAILURE-CANDIDATE'), `${mode} must not leak the invalid candidate`)
  }
}

const main = async (): Promise<void> => {
  testSemanticCardCleaningAndFieldLookup()
  testActionAndObjectHardRules()

  const directory = await mkdtemp(join(tmpdir(), 'visslm-requirement-matching-contract-'))
  let db: AppDatabase | null = null
  try {
    db = new AppDatabase(join(directory, 'contract.db'), join(directory, 'assets'))
    await testMultipleBaseUidExclusion(db)
    await testTopicOnlyIsNotFormalMatch(db)
    await testReviewFailuresCloseResults(db)
    console.log(JSON.stringify({
      ok: true,
      checks: [
        'HTML/entity/script/style and operational-noise cleaning',
        'nested raw type/module/description lookup',
        'action/object hard-rule downgrades',
        'all requested base UIDs excluded from every retrieval',
        'topic_only is never promoted to a visible match',
        'invalid evidence and unknown UID fail closed'
      ]
    }))
  } finally {
    db?.close()
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
