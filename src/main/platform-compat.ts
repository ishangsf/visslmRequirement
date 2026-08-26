/**
 * Electron 23 and newer no longer ship Chromium binaries for Windows 7,
 * Windows 8, or Windows 8.1. Keep this check independent from Electron so it
 * can be verified without starting the desktop runtime.
 */
export const isUnsupportedWindowsVersion = (systemVersion: string): boolean => {
  const major = Number.parseInt(systemVersion.split('.', 1)[0] ?? '', 10)
  return Number.isFinite(major) && major > 0 && major < 10
}

export const unsupportedWindowsMessage = (systemVersion: string): string => (
  `检测到 Windows ${systemVersion || '旧版本'}。当前版本基于 Electron 43，` +
  '最低需要 Windows 10；Windows 7/8/8.1 不受支持。请升级系统后再运行 VISSLM Agent。'
)
