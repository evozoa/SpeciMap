/// <reference lib="webworker" />
import { computeFocusMetrics } from './laplacian'

export interface FocusRequest {
  seq: number
  width: number
  height: number
  /** RGBA pixels, transferred. */
  buffer: ArrayBuffer
}

export interface FocusResponse {
  seq: number
  variance: number
  meanLuma: number
}

self.onmessage = (e: MessageEvent<FocusRequest>) => {
  const { seq, width, height, buffer } = e.data
  const rgba = new Uint8ClampedArray(buffer)
  const metrics = computeFocusMetrics(rgba, width, height)
  const response: FocusResponse = { seq, ...metrics }
  self.postMessage(response)
}
