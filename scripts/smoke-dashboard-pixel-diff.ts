import { strict as assert } from 'node:assert'
import { createCanvas } from '@napi-rs/canvas'
import { comparePngBuffers } from '../src/main/experts/visual-pixel-diff'

const createPng = (mutate?: (context: ReturnType<ReturnType<typeof createCanvas>['getContext']>) => void): Buffer => {
  const canvas = createCanvas(8, 8)
  const context = canvas.getContext('2d')
  context.fillStyle = '#162033'
  context.fillRect(0, 0, 8, 8)
  context.fillStyle = '#64dbff'
  context.fillRect(2, 2, 4, 4)
  mutate?.(context)
  return canvas.toBuffer('image/png')
}

const expected = createPng()
const same = await comparePngBuffers(expected, expected)
assert.equal(same.passed, true)
assert.equal(same.changedPixels, 0)

const changed = await comparePngBuffers(expected, createPng((context) => {
  context.fillStyle = '#ff5f7a'
  context.fillRect(0, 0, 1, 1)
}), { maxChangedRatio: 0.001 })
assert.equal(changed.passed, false)
assert.equal(changed.changedPixels, 1)

const differentSize = await comparePngBuffers(expected, createCanvas(4, 4).toBuffer('image/png'))
assert.equal(differentSize.passed, false)
assert.equal(differentSize.changedRatio, 1)

console.log(JSON.stringify({
  ok: true,
  identical: same,
  changedPixel: changed,
  differentSize
}, null, 2))
