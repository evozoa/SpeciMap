import { useCallback, useEffect, useRef, useState } from 'react'
import { computeFocusMetrics } from '../focus/laplacian'
import { useFocusMeter, type FocusState } from '../focus/useFocusMeter'
import { encodePhoto, encodePhotoFile, keepOriginal, type EncodedPhoto } from '../lib/image'
import { usePrefs } from '../lib/prefs'

/** Chromium's still-photo API (not in TypeScript's DOM lib). */
declare class ImageCapture {
  constructor(track: MediaStreamTrack)
  takePhoto(): Promise<Blob>
}

/**
 * Full sensor resolution where the browser can (Chrome on Android); null
 * where it can't (iOS Safari), so the caller falls back to the video frame.
 */
async function takeFullResStill(stream: MediaStream | null): Promise<EncodedPhoto | null> {
  const track = stream?.getVideoTracks()[0]
  if (!track || typeof ImageCapture === 'undefined') return null
  try {
    return await keepOriginal(await new ImageCapture(track).takePhoto())
  } catch {
    return null
  }
}

export interface CapturedPhoto extends EncodedPhoto {
  focusScore: number | null
}

interface Props {
  onCapture: (photo: CapturedPhoto) => void
}

const FOCUS_UI: Record<FocusState, { label: string; className: string }> = {
  idle: { label: 'Starting camera…', className: 'bg-slate-700' },
  dark: { label: 'Too dark — add light', className: 'bg-amber-600' },
  blurry: {
    label: 'Blurry — move back slightly or wipe the lens',
    className: 'bg-red-600',
  },
  almost: { label: 'Almost… hold steady', className: 'bg-amber-600' },
  sharp: { label: 'Sharp — hold still', className: 'bg-emerald-600' },
}

/** Focus score of the full-resolution still (preview can be sharper than the capture). */
function scoreStill(video: HTMLVideoElement): number | null {
  try {
    const size = 256
    const cropW = video.videoWidth * 0.6
    const cropH = video.videoHeight * 0.6
    const scale = size / Math.max(cropW, cropH)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(3, Math.round(cropW * scale))
    canvas.height = Math.max(3, Math.round(cropH * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(
      video,
      (video.videoWidth - cropW) / 2,
      (video.videoHeight - cropH) / 2,
      cropW,
      cropH,
      0,
      0,
      canvas.width,
      canvas.height,
    )
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
    return computeFocusMetrics(data.data, canvas.width, canvas.height).variance
  } catch {
    return null
  }
}

/**
 * Live viewfinder with on-device focus guidance. The shutter is never
 * blocked — a blurry capture is confirmed by the parent, not prevented here.
 * Falls back to a plain file input when getUserMedia is unavailable/denied.
 */
export default function CameraView({ onCapture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [streaming, setStreaming] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const focus = useFocusMeter(videoRef, streaming)
  const streamRef = useRef<MediaStream | null>(null)
  const { fullRes } = usePrefs('capturePrefs')

  useEffect(() => {
    let stream: MediaStream | null = null
    let cancelled = false
    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3072 },
            height: { ideal: 3072 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play()
          setStreaming(true)
        }
      } catch (err) {
        setCameraError(err instanceof Error ? err.message : String(err))
      }
    }
    void start()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const shutter = useCallback(async () => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const focusScore = scoreStill(video)
    const photo =
      (fullRes && (await takeFullResStill(streamRef.current))) ||
      (await encodePhoto(video, video.videoWidth, video.videoHeight))
    onCapture({ ...photo, focusScore })
  }, [onCapture, fullRes])

  async function onFilePicked(file: File | undefined) {
    if (!file) return
    const photo = fullRes ? await keepOriginal(file) : await encodePhotoFile(file)
    // No live loop in the fallback path — score the picked image once.
    onCapture({ ...photo, focusScore: null })
  }

  if (cameraError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-sm text-slate-400">
          Camera unavailable ({cameraError}). Use your camera app instead:
        </p>
        <label className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold">
          Take photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void onFilePicked(e.target.files?.[0])}
          />
        </label>
      </div>
    )
  }

  const ui = FOCUS_UI[focus.state]
  return (
    <div className="relative flex-1 overflow-hidden bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        className="h-full w-full object-cover"
      />
      <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
        <span
          className={`rounded-full px-4 py-1.5 text-sm font-semibold text-white shadow ${ui.className}`}
        >
          {ui.label}
        </span>
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
        <span className="rounded bg-black/50 px-3 py-1 text-xs text-white">
          Place the tag beside the specimen
        </span>
      </div>
      {fullRes && (
        // The phone's camera app gives true full-resolution originals on
        // every phone (the in-browser shutter can't on iOS).
        <label className="absolute bottom-10 left-4 rounded-lg bg-black/60 px-3 py-2 text-xs font-semibold text-white">
          Camera app
          <span className="block font-normal text-slate-300">full resolution</span>
          <input
            type="file"
            accept="image/jpeg,image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void onFilePicked(e.target.files?.[0])}
          />
        </label>
      )}
      <div className="absolute inset-x-0 bottom-8 flex justify-center">
        <button
          onClick={() => void shutter()}
          disabled={!streaming}
          aria-label="Take photo"
          className={`h-18 w-18 rounded-full border-4 border-white disabled:opacity-40 ${
            focus.state === 'sharp' ? 'bg-emerald-500' : 'bg-white/30'
          }`}
          style={{ width: 72, height: 72 }}
        />
      </div>
    </div>
  )
}
