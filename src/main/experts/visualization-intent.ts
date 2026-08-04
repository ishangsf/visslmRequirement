export type VisualizationRequestMode = 'generate' | 'patch'

const newDashboardPattern =
  /(?:^|[\s，。；：])(?:请)?(?:重新|全新)?(?:生成|创建|新建|制作|构建)(?:一个|一套|新的|全新)?[^。；\n]{0,32}?(?:可视化)?(?:大屏|看板|驾驶舱)/

export const resolveVisualizationRequestMode = (
  question: string,
  hasActiveArtifact: boolean,
  focusComponentId?: string
): VisualizationRequestMode => {
  if (!hasActiveArtifact) return 'generate'
  if (focusComponentId?.trim()) return 'patch'
  return newDashboardPattern.test(question.replace(/\s+/g, ' ').trim())
    ? 'generate'
    : 'patch'
}
