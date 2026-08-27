import { strict as assert } from 'node:assert'
import {
  compareRequirementMatchingPerformance,
  validateRequirementMatchingPerformanceReport,
  type RequirementMatchingPerformanceReport
} from '../../src/main/requirements/requirement-performance-gate'

const baseline: RequirementMatchingPerformanceReport = {
  mode: 'end-to-end-local', hardwareProfile: 'fixture', dataSnapshotHash: 'data',
  pipelineVersion: 'pipeline', rankingVersion: 'ranking', modelHash: 'model', includesModelLoad: false,
  p50Ms: 60, p95Ms: 100, peakMemoryMb: 100
}
assert.equal(validateRequirementMatchingPerformanceReport({ ...baseline, includesModelLoad: undefined }).ok, false)
assert.equal(compareRequirementMatchingPerformance({ ...baseline, p95Ms: 121 }, baseline).ok, false)
assert.equal(compareRequirementMatchingPerformance({ ...baseline, peakMemoryMb: 126 }, baseline).ok, false)
assert.equal(compareRequirementMatchingPerformance({ ...baseline, p95Ms: 120, peakMemoryMb: 125 }, baseline).ok, true)
assert.equal(compareRequirementMatchingPerformance({ ...baseline, modelHash: 'other' }, baseline).ok, false)
console.log(JSON.stringify({ ok: true, checks: ['required metadata', 'p95 20% boundary', 'memory 25% boundary', 'identity matching'] }))
