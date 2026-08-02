import { createHash } from 'node:crypto'
import type { DashboardSpec } from '../../shared/dashboard'

const stableValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stableValue)
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, stableValue(object[key])])
  )
}

export const dashboardSpecHash = (spec: DashboardSpec): string =>
  createHash('sha256')
    .update(JSON.stringify(stableValue(spec)))
    .digest('hex')
