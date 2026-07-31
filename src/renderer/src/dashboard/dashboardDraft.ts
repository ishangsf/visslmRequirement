import type { DashboardSpec } from '../../../shared/dashboard'

export interface DashboardDraft {
  spec: DashboardSpec
  savedAt: string
}

const draftKeyPrefix = 'visslm:dashboard-draft:'

export const dashboardDraftStorageKey = (dashboardId: string): string =>
  `${draftKeyPrefix}${dashboardId}`

export const serializeDashboardDraft = (spec: DashboardSpec, savedAt: string): string =>
  JSON.stringify({ spec, savedAt } satisfies DashboardDraft)

export const parseDashboardDraft = (
  value: string | null,
  dashboardId: string
): DashboardDraft | null => {
  if (!value) return null
  try {
    const draft = JSON.parse(value) as Partial<DashboardDraft>
    if (
      !draft.spec ||
      draft.spec.id !== dashboardId ||
      draft.spec.schemaVersion !== '1.0' ||
      !Array.isArray(draft.spec.components) ||
      typeof draft.savedAt !== 'string' ||
      Number.isNaN(Date.parse(draft.savedAt))
    ) return null
    return draft as DashboardDraft
  } catch {
    return null
  }
}
