type NavigationErrorLike = {
  code?: unknown
  errno?: unknown
  message?: unknown
}

const navigationErrorLike = (error: unknown): NavigationErrorLike | null => (
  error !== null && typeof error === 'object'
    ? error as NavigationErrorLike
    : null
)

/**
 * Electron rejects a navigation promise with ERR_ABORTED (-3) when a newer
 * load intentionally replaces it. This is expected while moving from the
 * lightweight startup page to the renderer and must not be shown as a load
 * failure to the user.
 */
export const isNavigationAbortedError = (error: unknown): boolean => {
  const candidate = navigationErrorLike(error)
  if (candidate?.code === 'ERR_ABORTED' || candidate?.errno === -3) return true

  const message = error instanceof Error
    ? error.message
    : typeof candidate?.message === 'string'
      ? candidate.message
      : typeof error === 'string'
        ? error
        : ''
  return /\bERR_ABORTED\b/i.test(message) || /(?:^|\D)-3(?:\D|$)/.test(message)
}
