import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildOnlinePlan,
  shouldRunUiPreparation,
  summarizeCoverage,
  withTimeout
} from '../scripts/assistant-intelligence-live-plan.mjs'

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/assistant-intelligence-eval-set.json', import.meta.url), 'utf8')
) as unknown

const main = async (): Promise<void> => {
  const repetitions = 3
  const plan = buildOnlinePlan(fixture, {
    mode: 'standard',
    stabilityRepetitions: repetitions
  })
  const onlineCases = plan.selectedCases
  const oneRun = summarizeCoverage(onlineCases, { repetitionCount: 1 })
  const repeatedRun = summarizeCoverage(onlineCases, { repetitionCount: repetitions })
  const failures: string[] = []

  const ids = new Set<string>()
  for (const item of onlineCases) {
    if (!item.id || ids.has(item.id)) failures.push(`online case IDs must be unique: ${item.id || '<empty>'}`)
    ids.add(item.id)
    if (!item.question.trim()) failures.push(`online case ${item.id} must have a question`)
    if (!item.category.trim()) failures.push(`online case ${item.id} must have a scenario category`)
    if (!Number.isInteger(item.minimumOnlineSamples) || item.minimumOnlineSamples < 1) {
      failures.push(`online case ${item.id} must require at least one sample`)
    }
    const stabilityTagged = item.onlineTracks.some((track) => track === 'stability' || track === 'both')
    if (stabilityTagged && item.minimumOnlineSamples < 3) {
      failures.push(`stability online case ${item.id} must require at least three samples`)
    }
  }

  if (plan.coverage.uniqueQuestionCount < 18) {
    failures.push(`unique online questions ${plan.coverage.uniqueQuestionCount} < required 18`)
  }
  if (plan.coverage.scenarioCategoryCount < 10) {
    failures.push(`online scenario categories ${plan.coverage.scenarioCategoryCount} < required 10`)
  }

  if (oneRun.uniqueQuestionCount !== repeatedRun.uniqueQuestionCount) {
    failures.push('repetition count must not change independent-question coverage')
  }
  if (oneRun.repetitionCount === repeatedRun.repetitionCount) {
    failures.push('one-run and repeated-run reports must expose different repetition counts')
  }
  if (repeatedRun.executionSampleCount !== onlineCases.length * repetitions) {
    failures.push('repeated execution samples must be counted independently from unique questions')
  }
  if (repeatedRun.executionSampleCount <= repeatedRun.uniqueQuestionCount) {
    failures.push('repeated execution samples must not be reported as the independent-question count')
  }

  if (plan.coverage.caseCount !== plan.coverageCases.length || plan.stability.caseCount !== plan.stabilityCases.length) {
    failures.push('coverage and stability summaries must describe their own selected cases')
  }
  if (!plan.executions.some((item) => item.track === 'coverage') || !plan.executions.some((item) => item.track === 'stability')) {
    failures.push('standard plan must contain separate coverage and stability executions')
  }
  if (plan.standard.executionSampleCount !== plan.coverage.executionSampleCount + plan.stability.executionSampleCount) {
    failures.push('standard execution samples must equal coverage plus stability executions')
  }
  if (plan.standard.uniqueQuestionCount !== plan.coverage.uniqueQuestionCount) {
    failures.push('standard plan unique-question coverage must remain independent of stability repetitions')
  }
  if (plan.stability.repetitionCount !== repetitions || plan.stability.executionSampleCount !== plan.stability.caseCount * repetitions) {
    failures.push('stability execution summary must preserve its repetition count separately')
  }
  if (shouldRunUiPreparation(true)) failures.push('skip-ui mode must not prepare or wait for UI probes')
  if (!shouldRunUiPreparation(false)) failures.push('normal mode must keep UI probe preparation enabled')
  const timeoutProbe = await withTimeout(() => new Promise(() => {}), 5)
  if (!timeoutProbe.timedOut) failures.push('a hung online case must become an isolated timeout result')

  const firstCase = onlineCases[0]
  if (firstCase) {
    const exactDuplicate = { ...firstCase, id: `${firstCase.id}-exact-duplicate` }
    const duplicateRun = summarizeCoverage([...onlineCases, exactDuplicate], { repetitionCount: repetitions })
    if (duplicateRun.uniqueQuestionCount !== plan.coverage.uniqueQuestionCount) {
      failures.push('an exact duplicate question must not increase independent-question coverage')
    }
    if (duplicateRun.executionSampleCount !== repeatedRun.executionSampleCount + repetitions) {
      failures.push('an exact duplicate question may increase executions, but not question coverage')
    }
  } else {
    failures.push('fixture must expose online cases for duplicate-question coverage validation')
  }

  assert.equal(
    failures.length,
    0,
    `assistant intelligence live contract violations:\n- ${failures.join('\n- ')}\n` +
      `observed=${JSON.stringify({ coverage: plan.coverage, stability: plan.stability, standard: plan.standard })}`
  )

  console.log(JSON.stringify({
    ok: true,
    track: 'deterministic-live-contract',
    fixtureVersion: 'assistant-intelligence-eval-v2',
    coverage: plan.coverage,
    stability: plan.stability,
    standard: plan.standard,
    checks: [
      'independent online questions meet the coverage floor',
      'scenario categories meet the coverage floor',
      'repetition count and execution samples are separate from unique questions',
      'exact duplicate question text does not increase coverage'
    ]
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
