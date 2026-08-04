import type { DashboardOfflineExportPayload } from '../../shared/dashboard'

declare global {
  interface Window {
    __VISSLM_DASHBOARD_EXPORT__?: DashboardOfflineExportPayload
  }
}

export {}
