/**
 * Live focus guidance for the camera viewfinder.
 *
 * Samples the video element at ~5fps, grabs a center crop scaled to ~256px,
 * ships it to the Laplacian worker, then smooths (EMA) and gates with
 * hysteresis so the indicator doesn't flicker. Because absolute Laplacian
 * variance is scene/camera dependent, "sharp" also accepts anything at or
 * above 60% of the session's rolling maximum (relative gate).
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { FocusRequest, FocusResponse } from './focus.worker'

export type FocusState = 'idle' | 'dark' | 'blurry' | 'almost' | 'sharp'

export interface FocusMeter {
  state: FocusState
  /** Smoothed Laplacian variance (exposed for calibration/debugging). */
  score: number
}

const SAMPLE_MS = 200
const CROP_FRACTION = 0.6
const TARGET_SIZE = 256
const EMA_ALPHA = 0.35
const DARK_LUMA = 40
/** Absolute hysteresis thresholds (8-bit luma, 256px crop) — see plan §5. */
const T_LOW = 50
const T_HIGH = 150
const RELATIVE_GATE = 0.6

export function useFocusMeter(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): FocusMeter {
  const [meter, setMeter] = useState<FocusMeter>({ state: 'idle', score: 0 })
  const emaRef = useRef(0)
  const maxRef = useRef(0)
  const stateRef = useRef<FocusState>('idle')

  useEffect(() => {
    if (!enabled) {
      setMeter({ state: 'idle', score: 0 })
      emaRef.current = 0
      maxRef.current = 0
      stateRef.current = 'idle'
      return
    }
    const worker = new Worker(new URL('./focus.worker.ts', import.meta.url), {
      type: 'module',
    })
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let seq = 0
    let pending = false
    let cancelled = false

    worker.onmessage = (e: MessageEvent<FocusResponse>) => {
      pending = false
      if (cancelled) return
      const { variance, meanLuma } = e.data

      if (meanLuma < DARK_LUMA) {
        stateRef.current = 'dark'
        setMeter({ state: 'dark', score: emaRef.current })
        return
      }

      emaRef.current =
        emaRef.current === 0
          ? variance
          : EMA_ALPHA * variance + (1 - EMA_ALPHA) * emaRef.current
      maxRef.current = Math.max(maxRef.current, emaRef.current)

      const score = emaRef.current
      const relativeSharp = maxRef.current > 0 && score >= RELATIVE_GATE * maxRef.current
      const prev = stateRef.current
      let next: FocusState
      if (score >= T_HIGH || (score >= T_LOW && relativeSharp)) {
        next = 'sharp'
      } else if (score <= T_LOW) {
        // Hysteresis: only drop out of 'sharp' once clearly below T_LOW.
        next = 'blurry'
      } else {
        next = prev === 'sharp' ? 'sharp' : 'almost'
      }
      stateRef.current = next
      setMeter({ state: next, score })
    }

    const timer = setInterval(() => {
      const video = videoRef.current
      if (!video || !ctx || pending) return
      if (video.readyState < 2 || video.videoWidth === 0) return
      const cropW = video.videoWidth * CROP_FRACTION
      const cropH = video.videoHeight * CROP_FRACTION
      const sx = (video.videoWidth - cropW) / 2
      const sy = (video.videoHeight - cropH) / 2
      const scale = TARGET_SIZE / Math.max(cropW, cropH)
      canvas.width = Math.max(3, Math.round(cropW * scale))
      canvas.height = Math.max(3, Math.round(cropH * scale))
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const request: FocusRequest = {
        seq: seq++,
        width: canvas.width,
        height: canvas.height,
        buffer: imageData.data.buffer,
      }
      pending = true
      worker.postMessage(request, [request.buffer])
    }, SAMPLE_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      worker.terminate()
    }
  }, [enabled, videoRef])

  return meter
}
