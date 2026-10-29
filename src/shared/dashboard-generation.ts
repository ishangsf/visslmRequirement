import type { QuerySpec } from './query-spec'

export interface DashboardGoal {
  id: string
  question: string
  fields: string[]
  dimensionFields: string[]
  query?: QuerySpec
}
export interface DashboardAnalysisContract {
  goals: DashboardGoal[]
  assumptions: string[]
}
export interface DashboardRenderIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
  componentId?: string
}
export interface DashboardRenderPreview {
  rendered: boolean
  componentCount: number
  issues: DashboardRenderIssue[]
  measurements?: Array<{ componentId: string; element: string; width: number; height: number; scrollWidth: number; scrollHeight: number }>
  screenshot?: { mimeType: 'image/png'; data: string }
}
