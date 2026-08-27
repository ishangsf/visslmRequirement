import { normalizeRequirementMatchingRolloutMode, type RequirementMatchingRolloutMode } from '../../shared/types'

export interface RequirementMatchingRolloutDecision {
  mode: RequirementMatchingRolloutMode
  primaryReadPath: 'legacy_safe' | 'v1_1'
  newPipelinePersisted: boolean
  businessWriteCount: 0
}

export const resolveRequirementMatchingRollout = (value: unknown): RequirementMatchingRolloutDecision => {
  const mode = normalizeRequirementMatchingRolloutMode(value)
  return {
    mode,
    primaryReadPath: mode === 'v1_1' ? 'v1_1' : 'legacy_safe',
    newPipelinePersisted: mode !== 'legacy_safe',
    businessWriteCount: 0
  }
}
