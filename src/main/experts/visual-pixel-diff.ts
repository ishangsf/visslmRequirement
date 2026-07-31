import { createCanvas, loadImage } from '@napi-rs/canvas'

export interface PixelDiffOptions {
  channelThreshold?: number
  maxChangedRatio?: number
}

export interface PixelDiffResult {
  width: number
  height: number
  totalPixels: number
  changedPixels: number
  changedRatio: number
  meanAbsoluteError: number
  passed: boolean
}

export const comparePngBuffers = async (
  expected: Buffer,
  actual: Buffer,
  options: PixelDiffOptions = {}
): Promise<PixelDiffResult> => {
  const [expectedImage, actualImage] = await Promise.all([
    loadImage(expected),
    loadImage(actual)
  ])
  const width = Math.max(expectedImage.width, actualImage.width)
  const height = Math.max(expectedImage.height, actualImage.height)
  const totalPixels = width * height
  if (expectedImage.width !== actualImage.width || expectedImage.height !== actualImage.height) {
    return {
      width,
      height,
      totalPixels,
      changedPixels: totalPixels,
      changedRatio: 1,
      meanAbsoluteError: 1,
      passed: false
    }
  }

  const render = (image: typeof expectedImage): Uint8ClampedArray => {
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, width, height).data
  }
  const expectedPixels = render(expectedImage)
  const actualPixels = render(actualImage)
  const channelThreshold = Math.max(0, Math.min(255, options.channelThreshold ?? 8))
  let changedPixels = 0
  let absoluteError = 0
  for (let index = 0; index < expectedPixels.length; index += 4) {
    let changed = false
    for (let channel = 0; channel < 4; channel += 1) {
      const difference = Math.abs(expectedPixels[index + channel] - actualPixels[index + channel])
      absoluteError += difference / 255
      if (difference > channelThreshold) changed = true
    }
    if (changed) changedPixels += 1
  }
  const changedRatio = totalPixels ? changedPixels / totalPixels : 0
  const meanAbsoluteError = expectedPixels.length
    ? absoluteError / expectedPixels.length
    : 0
  return {
    width,
    height,
    totalPixels,
    changedPixels,
    changedRatio: Number(changedRatio.toFixed(8)),
    meanAbsoluteError: Number(meanAbsoluteError.toFixed(8)),
    passed: changedRatio <= (options.maxChangedRatio ?? 0.001)
  }
}
