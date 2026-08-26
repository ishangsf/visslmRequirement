import assert from 'node:assert/strict'
import {
  isUnsupportedWindowsVersion,
  unsupportedWindowsMessage
} from '../src/main/platform-compat'

assert.equal(isUnsupportedWindowsVersion('6.1.7601'), true)
assert.equal(isUnsupportedWindowsVersion('6.3.9600'), true)
assert.equal(isUnsupportedWindowsVersion('10.0.19045'), false)
assert.equal(isUnsupportedWindowsVersion('10.0.26100'), false)
assert.equal(isUnsupportedWindowsVersion(''), false)
assert.equal(isUnsupportedWindowsVersion('unknown'), false)
assert.match(unsupportedWindowsMessage('6.1.7601'), /Electron 43/)
assert.match(unsupportedWindowsMessage('6.1.7601'), /Windows 10/)

console.log('platform compatibility checks passed')
