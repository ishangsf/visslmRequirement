export type AppThemeMode = 'dark' | 'light'

export const APP_THEME_STORAGE_KEY = 'visslm:app-theme:v1'

export const readInitialThemeMode = (): AppThemeMode => {
  try {
    return window.localStorage.getItem(APP_THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}
