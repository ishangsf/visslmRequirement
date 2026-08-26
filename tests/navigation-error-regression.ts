import assert from 'node:assert/strict'

import { isNavigationAbortedError } from '../src/main/navigation-error'

const testNavigationAbortedVariants = (): void => {
  const cases: Array<{ name: string; error: unknown }> = [
    {
      name: 'errno and code',
      error: { errno: -3, code: 'ERR_ABORTED' }
    },
    {
      name: 'code only',
      error: { code: 'ERR_ABORTED' }
    },
    {
      name: 'errno only',
      error: { errno: -3 }
    },
    {
      name: 'message marker',
      error: new Error('navigation failed: ERR_ABORTED (-3)')
    }
  ]

  for (const { name, error } of cases) {
    assert.equal(isNavigationAbortedError(error), true, `${name} should be treated as an intentional navigation abort`)
  }
}

const testRealNavigationErrorsAreNotSuppressed = (): void => {
  const cases: Array<{ name: string; error: unknown }> = [
    {
      name: 'file not found errno and code',
      error: { errno: -6, code: 'ERR_FILE_NOT_FOUND' }
    },
    {
      name: 'file not found message',
      error: new Error('navigation failed: ERR_FILE_NOT_FOUND (-6)')
    },
    {
      name: 'ordinary error',
      error: new Error('navigation failed')
    },
    {
      name: 'null',
      error: null
    }
  ]

  for (const { name, error } of cases) {
    assert.equal(isNavigationAbortedError(error), false, `${name} must remain a reportable error`)
  }
}

const main = (): void => {
  testNavigationAbortedVariants()
  testRealNavigationErrorsAreNotSuppressed()
  console.log(JSON.stringify({
    ok: true,
    checks: [
      'ERR_ABORTED is recognized from errno, code, or the standard message marker',
      'ERR_FILE_NOT_FOUND, ordinary errors, and null are not suppressed'
    ]
  }))
}

main()
