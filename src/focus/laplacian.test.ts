import { describe, expect, it } from 'vitest'
import { computeFocusMetrics, laplacianVariance, toLuma } from './laplacian'

/** Deterministic pseudo-random noise pattern (sharp: full of edges). */
function noiseImage(w: number, h: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(w * h * 4)
  let seed = 42
  for (let i = 0; i < rgba.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    const v = seed % 256
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v
    rgba[i + 3] = 255
  }
  return rgba
}

/** 3x3 box blur applied to an RGBA image (grayscale content). */
function boxBlur(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy
          const xx = x + dx
          if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue
          sum += rgba[(yy * w + xx) * 4]
          count++
        }
      }
      const i = (y * w + x) * 4
      const v = sum / count
      out[i] = out[i + 1] = out[i + 2] = v
      out[i + 3] = 255
    }
  }
  return out
}

describe('laplacianVariance', () => {
  it('is zero for a flat image', () => {
    const luma = new Float32Array(64 * 64).fill(128)
    expect(laplacianVariance(luma, 64, 64)).toBe(0)
  })

  it('is zero for degenerate sizes', () => {
    expect(laplacianVariance(new Float32Array(4), 2, 2)).toBe(0)
  })

  it('ranks sharp above blurred above doubly-blurred', () => {
    const w = 64
    const h = 64
    const sharp = noiseImage(w, h)
    const blurred = boxBlur(sharp, w, h)
    const blurrier = boxBlur(blurred, w, h)
    const vSharp = computeFocusMetrics(sharp, w, h).variance
    const vBlur = computeFocusMetrics(blurred, w, h).variance
    const vBlur2 = computeFocusMetrics(blurrier, w, h).variance
    expect(vSharp).toBeGreaterThan(vBlur)
    expect(vBlur).toBeGreaterThan(vBlur2)
    expect(vBlur2).toBeGreaterThan(0)
  })
})

describe('computeFocusMetrics', () => {
  it('reports mean luma for exposure checks', () => {
    const w = 16
    const h = 16
    const dark = new Uint8ClampedArray(w * h * 4)
    for (let i = 3; i < dark.length; i += 4) dark[i] = 255
    expect(computeFocusMetrics(dark, w, h).meanLuma).toBe(0)

    const bright = new Uint8ClampedArray(w * h * 4).fill(255)
    expect(computeFocusMetrics(bright, w, h).meanLuma).toBeCloseTo(255, 0)
  })
})

describe('toLuma', () => {
  it('uses Rec.601 weights', () => {
    const rgba = new Uint8ClampedArray([100, 200, 50, 255])
    const luma = toLuma(rgba, 1, 1)
    expect(luma[0]).toBeCloseTo(0.299 * 100 + 0.587 * 200 + 0.114 * 50, 3)
  })
})
