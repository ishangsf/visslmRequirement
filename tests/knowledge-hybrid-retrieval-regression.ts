import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AppDatabase } from '../src/main/database'
import {
  KnowledgeService,
  scoreKnowledgeLexicalRelevance
} from '../src/main/knowledge'

/**
 * Regression coverage for the lexical half of knowledge hybrid retrieval.
 *
 * These fixtures deliberately use generic document keys and Chinese topics.
 * They are intended to catch query tokenization/normalization regressions,
 * rather than encode a particular knowledge-base question or answer.
 */

type ScoredText = {
  label: string
  content: string
  score: number
}

const score = (query: string, content: string): number => {
  const value = scoreKnowledgeLexicalRelevance(query, content)
  assert.equal(typeof value, 'number', 'lexical relevance must return a number')
  assert.ok(Number.isFinite(value), 'lexical relevance must be finite')
  assert.ok(value >= 0, 'lexical relevance must not be negative')
  assert.ok(value <= 1, 'lexical relevance must not exceed one')
  return value
}

const testUnicodeAndSpacingNormalization = (): void => {
  const fullWidthQuery = 'ＤＯＣ４２ 设备接口协议的总体要求是什么？'
  const spacedAsciiQuery = 'doc 42 设备接口协议的总体要求是什么？'
  const content = 'DOC42 设备接口协议\n总体要求包括接口定义、时序约束和异常处理规则。'

  const fullWidthScore = score(fullWidthQuery, content)
  const spacedAsciiScore = score(spacedAsciiQuery, content)

  assert.ok(fullWidthScore > 0, 'NFKC-normalized query should match its Chinese topic')
  assert.equal(
    fullWidthScore,
    spacedAsciiScore,
    'full-width/case and letter-number spacing variants should have equivalent lexical coverage'
  )
}

const testContinuousChineseTopicSurvivesQuestionExpansion = (): void => {
  const query = 'DOC42 设备接口协议的总体要求是什么？'
  const candidateContents = [
    {
      label: 'topic-bearing chunk',
      content: '设备接口协议\n设备接口协议规定接口定义、状态转换、时序约束和异常处理规则。'
    },
    {
      label: 'document-id distractor',
      content: 'DOC42 文档修订记录：记录编制人、审核人、版本日期和变更说明。'
    },
    {
      label: 'question-word distractor',
      content: 'DOC42 目录说明：本文件用于回答总体要求相关问题，并列出章节索引。'
    },
    {
      label: 'unrelated chunk',
      content: '采购申请流程包括预算填写、审批流转、供应商选择和付款登记。'
    }
  ]

  const ranked: ScoredText[] = candidateContents
    .map((candidate) => ({
      ...candidate,
      score: score(query, candidate.content)
    }))
    .sort((left, right) => right.score - left.score)

  assert.equal(
    ranked[0]?.label,
    'topic-bearing chunk',
    'a chunk containing the continuous Chinese topic should outrank document/question distractors'
  )

  const relevant = ranked.find((candidate) => candidate.label === 'topic-bearing chunk')
  const unrelated = ranked.find((candidate) => candidate.label === 'unrelated chunk')
  assert.ok(relevant && unrelated)
  assert.ok(relevant.score > unrelated.score, 'the topic-bearing chunk must have higher lexical coverage than unrelated text')

  const distractorScores = ranked
    .filter((candidate) => candidate.label !== 'topic-bearing chunk' && candidate.label !== 'unrelated chunk')
    .map((candidate) => candidate.score)
  assert.ok(
    distractorScores.every((candidateScore) => candidateScore < relevant.score),
    'document identifiers and question suffixes must not outweigh the actual topic evidence'
  )
}

const testUnrelatedTextScoresLowerThanTopicEvidence = (): void => {
  const query = 'REF9 数据同步策略如何保证失败重试？'
  const topic = '数据同步策略规定失败重试、幂等校验和断点恢复机制。'
  const unrelated = '会议室预约流程规定申请时间、审批人和参会人数。'

  assert.ok(
    score(query, topic) > score(query, unrelated),
    'unrelated text must receive lower lexical relevance than a chunk containing the topic and body evidence'
  )
}

const testShortAndEmptyQueriesAreSafe = (): void => {
  const content = '数据同步策略规定失败重试和断点恢复机制。'
  const empty = score('', content)
  const whitespace = score('   \t\n', content)
  const punctuation = score('？', content)
  const short = score('A', content)

  assert.equal(empty, 0, 'an empty query should have no lexical evidence')
  assert.equal(whitespace, 0, 'a whitespace-only query should have no lexical evidence')
  assert.equal(punctuation, 0, 'a punctuation-only query should have no lexical evidence')
  assert.ok(short >= 0, 'a one-character query should be safe and non-negative')
}

const restoreEnvironment = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

const testKnowledgeServiceDocumentSearch = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'visslm-knowledge-hybrid-regression-'))
  const previousFallback = process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK
  let db: AppDatabase | null = null
  try {
    process.env.VISSLM_KNOWLEDGE_TEST_FALLBACK = '1'
    const files = {
      topic: join(directory, 'topic-guide.txt'),
      documentId: join(directory, 'document-id-notes.txt'),
      questionWords: join(directory, 'question-index.txt'),
      unrelated: join(directory, 'unrelated-process.txt')
    }
    await Promise.all([
      writeFile(
        files.topic,
        '设备接口协议\n设备接口协议规定接口定义、状态转换、时序约束和异常处理规则。',
        'utf8'
      ),
      writeFile(
        files.documentId,
        'DOC42 文档修订记录：编制、审核、版本日期和变更说明。',
        'utf8'
      ),
      writeFile(
        files.questionWords,
        'DOC42 问题索引：列出是什么、如何说明、如何查询等常见问法。',
        'utf8'
      ),
      writeFile(
        files.unrelated,
        '采购申请流程包括预算填写、审批流转、供应商选择和付款登记。',
        'utf8'
      )
    ])

    db = new AppDatabase(join(directory, 'knowledge.db'), join(directory, 'assets'))
    const service = new KnowledgeService(db)
    const upload = await service.processFiles(Object.values(files))
    assert.equal(upload.acceptedCount, 4, 'all generic TXT fixtures should be accepted')
    assert.equal(upload.failedCount, 0, 'all generic TXT fixtures should be indexed successfully')
    assert.ok(upload.documents.every((document) => document.status === 'ready'), 'all fixtures should be ready')

    const hits = await service.search(
      'DOC42 设备接口协议的总体要求是什么？',
      8,
      { sourceType: 'document' }
    )
    assert.ok(hits.length > 0, 'document search should return evidence for the topic query')
    assert.ok(hits.length <= 8, 'document search should respect the default evidence budget')
    assert.ok(
      hits.every((hit) => hit.source.sourceType === 'document'),
      'sourceType=document must exclude non-document evidence'
    )
    assert.ok(
      hits.every((hit) => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1),
      'search hit scores must remain in the public 0..1 range'
    )

    const topicIndex = hits.findIndex((hit) => hit.source.fileName === 'topic-guide.txt')
    assert.ok(topicIndex >= 0 && topicIndex < 8, 'the topic-bearing document must enter the first eight hits')
    for (const distractorName of ['document-id-notes.txt', 'question-index.txt', 'unrelated-process.txt']) {
      const distractorIndex = hits.findIndex((hit) => hit.source.fileName === distractorName)
      if (distractorIndex >= 0) {
        assert.ok(
          topicIndex < distractorIndex,
          `${distractorName} must not outrank the topic-bearing document`
        )
      }
    }
  } finally {
    try {
      db?.close()
    } finally {
      restoreEnvironment('VISSLM_KNOWLEDGE_TEST_FALLBACK', previousFallback)
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  }
}

const main = async (): Promise<void> => {
  testUnicodeAndSpacingNormalization()
  testContinuousChineseTopicSurvivesQuestionExpansion()
  testUnrelatedTextScoresLowerThanTopicEvidence()
  testShortAndEmptyQueriesAreSafe()
  await testKnowledgeServiceDocumentSearch()

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'NFKC/case and letter-number spacing equivalence',
      'continuous Chinese topic survives document-id and question-suffix expansion',
      'unrelated text ranks below topic evidence',
      'empty, whitespace, punctuation-only, and short queries are safe',
      'KnowledgeService TXT indexing and document-scoped black-box search'
    ]
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
