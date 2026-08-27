const asString = (value) => (typeof value === 'string' ? value : '')

const asStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : []
)

const historyKey = (history) => JSON.stringify(
  Array.isArray(history)
    ? history.map((turn) => ({
        role: asString(turn?.role),
        content: asString(turn?.content)
      }))
    : []
)

export const questionKey = (item) => asString(item?.question).trim()

export const interactionKey = (item) => `${questionKey(item)}\u0000${historyKey(item?.history)}`

export const normalizeOnlineCase = (item, index = 0) => {
  const onlineTracks = asStringArray(item?.onlineTracks)
  const onlineScenario = asString(item?.onlineScenario).trim() || 'count'
  return {
    id: asString(item?.id).trim() || `online-case-${index + 1}`,
    category: asString(item?.category).trim(),
    evaluationGroup: asString(item?.evaluationGroup).trim() || onlineScenario,
    onlineScenario,
    onlineTracks: onlineTracks.length ? onlineTracks : ['coverage'],
    minimumOnlineSamples: Number.isFinite(Number(item?.minimumOnlineSamples))
      ? Math.max(1, Math.trunc(Number(item.minimumOnlineSamples)))
      : 1,
    question: questionKey(item),
    history: Array.isArray(item?.history) ? item.history : [],
    expected: item?.expected && typeof item.expected === 'object' ? item.expected : {},
    expectedGroupEntities: asStringArray(item?.expectedGroupEntities),
    expectedGroundedTerms: asStringArray(item?.expectedGroundedTerms)
  }
}

export const selectOnlineCases = (fixture, requestedIds = []) => {
  const ids = new Set(requestedIds.map((id) => String(id).trim()).filter(Boolean))
  if (!Array.isArray(fixture)) return []
  return fixture
    .filter((item) => item && typeof item === 'object' && item.online === true)
    .map((item, index) => normalizeOnlineCase(item, index))
    .filter((item) => item.id && item.question)
    .filter((item) => !ids.size || ids.has(item.id))
}

const hasTrack = (item, track) => item.onlineTracks.includes(track) || item.onlineTracks.includes('both')

export const shouldRunUiPreparation = (skipUiProbes) => skipUiProbes !== true

export const withTimeout = (operation, timeoutMs) => new Promise((resolve, reject) => {
  let settled = false
  const duration = Math.max(1, Math.trunc(Number(timeoutMs) || 1))
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    resolve({ timedOut: true })
  }, duration)
  Promise.resolve()
    .then(operation)
    .then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ timedOut: false, value })
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
})

export const summarizeCoverage = (cases, { repetitionCount = 1, executionSampleCount } = {}) => {
  const normalized = cases.map((item, index) => normalizeOnlineCase(item, index))
  const questions = normalized.map(questionKey).filter(Boolean)
  const interactions = normalized.map(interactionKey).filter(Boolean)
  const categoryCounts = Object.fromEntries(
    [...new Set(normalized.map((item) => item.category).filter(Boolean))]
      .sort()
      .map((category) => [category, normalized.filter((item) => item.category === category).length])
  )
  const calculatedExecutionSampleCount = normalized.length * Math.max(1, Number(repetitionCount) || 1)
  return {
    caseCount: normalized.length,
    uniqueQuestionCount: new Set(questions).size,
    uniqueInteractionCount: new Set(interactions).size,
    duplicateQuestionCount: Math.max(0, questions.length - new Set(questions).size),
    scenarioCategoryCount: Object.keys(categoryCounts).length,
    categoryCounts,
    repetitionCount: Math.max(1, Number(repetitionCount) || 1),
    executionSampleCount: Number.isFinite(Number(executionSampleCount))
      ? Math.max(0, Math.trunc(Number(executionSampleCount)))
      : calculatedExecutionSampleCount
  }
}

export const buildOnlinePlan = (fixture, {
  mode = 'standard',
  requestedIds = [],
  stabilityRepetitions = 3
} = {}) => {
  const selectedCases = selectOnlineCases(fixture, requestedIds)
  const coverageCases = selectedCases.filter((item) => hasTrack(item, 'coverage'))
  const stabilityCases = selectedCases.filter((item) => hasTrack(item, 'stability'))
  const repetitions = Math.max(1, Math.trunc(Number(stabilityRepetitions) || 1))
  const executions = []

  if (mode === 'coverage' || mode === 'standard') {
    coverageCases.forEach((item) => executions.push({ ...item, track: 'coverage', repetition: 1 }))
  }
  if (mode === 'stability' || mode === 'standard') {
    stabilityCases.forEach((item) => {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        executions.push({ ...item, track: 'stability', repetition })
      }
    })
  }

  return {
    selectedCases,
    coverageCases,
    stabilityCases,
    executions,
    coverage: summarizeCoverage(coverageCases),
    stability: summarizeCoverage(stabilityCases, { repetitionCount: repetitions }),
    standard: summarizeCoverage(executions, { repetitionCount: 1, executionSampleCount: executions.length })
  }
}
