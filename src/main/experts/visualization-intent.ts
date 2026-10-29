export type VisualizationRequestMode = 'generate' | 'patch'

export const resolveVisualizationRequestMode = (
  question: string,
  hasActiveArtifact: boolean,
  focusComponentId?: string,
  plannedMode?: VisualizationRequestMode
): VisualizationRequestMode => {
  if (!hasActiveArtifact) return 'generate'
  return plannedMode ?? 'patch'
}
