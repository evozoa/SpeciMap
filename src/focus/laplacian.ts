/**
 * Pure sharpness metric: variance of the 3x3 Laplacian over a grayscale
 * image, plus mean luma for exposure checking. Runs in a Web Worker at
 * ~5 fps on a ~256px center crop of the camera preview.
 *
 * Higher variance = more high-frequency edge energy = sharper. Absolute
 * values depend on the scene and camera, so callers combine an absolute
 * floor with a session-relative gate (see useFocusMeter).
 */

export interface FocusMetrics {
  /** Variance of the Laplacian response over interior pixels. */
  variance: number
  /** Mean luma (0-255); low values mean the scene is too dark to judge focus. */
  meanLuma: number
}

/** Convert RGBA pixel data to a luma (grayscale) plane. */
export function toLuma(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const luma = new Float32Array(width * height)
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
  }
  return luma
}

/** Variance of the 4-neighbor Laplacian [0,1,0;1,-4,1;0,1,0] over interior pixels. */
export function laplacianVariance(
  luma: Float32Array,
  width: number,
  height: number,
): number {
  if (width < 3 || height < 3) return 0
  const n = (width - 2) * (height - 2)
  let sum = 0
  let sumSq = 0
  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const i = row + x
      const v =
        luma[i - width] + luma[i + width] + luma[i - 1] + luma[i + 1] - 4 * luma[i]
      sum += v
      sumSq += v * v
    }
  }
  const mean = sum / n
  return sumSq / n - mean * mean
}

/** Full metric pass over an RGBA frame (as produced by ctx.getImageData). */
export function computeFocusMetrics(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): FocusMetrics {
  const luma = toLuma(rgba, width, height)
  let lumaSum = 0
  for (let i = 0; i < luma.length; i++) lumaSum += luma[i]
  return {
    variance: laplacianVariance(luma, width, height),
    meanLuma: lumaSum / luma.length,
  }
}
