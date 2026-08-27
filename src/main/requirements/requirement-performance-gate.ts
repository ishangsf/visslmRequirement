export interface RequirementMatchingPerformanceReport {
  mode: 'retrieval' | 'rerank' | 'end-to-end-local' | 'end-to-end-with-explainer'
  hardwareProfile: string
  dataSnapshotHash: string
  pipelineVersion: string
  rankingVersion: string
  modelHash: string
  includesModelLoad: boolean
  p50Ms: number
  p95Ms: number
  peakMemoryMb: number
}

export const validateRequirementMatchingPerformanceReport = (
  value: Partial<RequirementMatchingPerformanceReport>
): { ok: boolean; errors: string[] } => {
  const required: Array<keyof RequirementMatchingPerformanceReport> = [
    'mode', 'hardwareProfile', 'dataSnapshotHash', 'pipelineVersion', 'rankingVersion',
    'modelHash', 'includesModelLoad', 'p50Ms', 'p95Ms', 'peakMemoryMb'
  ]
  const errors = required.filter((key) => value[key] === undefined || value[key] === '').map((key) => `missing:${key}`)
  if (['p50Ms', 'p95Ms', 'peakMemoryMb'].some((key) => !Number.isFinite(value[key as 'p50Ms']))) errors.push('invalid:metrics')
  return { ok: errors.length === 0, errors }
}

export const compareRequirementMatchingPerformance = (
  current: RequirementMatchingPerformanceReport,
  baseline: RequirementMatchingPerformanceReport
): { ok: boolean; p95Ratio: number; memoryRatio: number; errors: string[] } => {
  const identityKeys: Array<keyof RequirementMatchingPerformanceReport> = [
    'mode', 'hardwareProfile', 'dataSnapshotHash', 'pipelineVersion', 'rankingVersion', 'modelHash', 'includesModelLoad'
  ]
  const errors = identityKeys.filter((key) => current[key] !== baseline[key]).map((key) => `identity:${key}`)
  const p95Ratio = current.p95Ms / Math.max(0.001, baseline.p95Ms)
  const memoryRatio = current.peakMemoryMb / Math.max(0.001, baseline.peakMemoryMb)
  if (p95Ratio > 1.2) errors.push('regression:p95')
  if (memoryRatio > 1.25) errors.push('regression:memory')
  return { ok: errors.length === 0, p95Ratio, memoryRatio, errors }
}
