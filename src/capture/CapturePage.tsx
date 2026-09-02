import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { stashResumeTag } from '../auth/resume'
import { db } from '../db/schema'
import { addDraftPhoto, finalizeRecord } from '../db/drafts'
import { formatTagId, parseTagId } from '../lib/tagid'
import LocationPicker, { type LatLng } from '../map/LocationPicker'
import { syncEngine } from '../sync/triggers'
import CameraView, { type CapturedPhoto } from './CameraView'
import { useGeoWatch } from './useGeoWatch'

type Step = 'camera' | 'confirm-blurry' | 'confirm-tag' | 'location' | 'saved'

/**
 * The capture flow: /s/:tagId → camera → tag confirmation → map → saved.
 * Happy path is 3 taps: shutter → "matches" → "save". The captured photo is
 * written to IndexedDB as a draft immediately, so navigation can't lose it.
 */
export default function CapturePage() {
  const params = useParams<{ tagId: string }>()
  const navigate = useNavigate()
  const { session, loading } = useAuth()

  const [manualEntry, setManualEntry] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const [tagId, setTagId] = useState<string | null>(() =>
    parseTagId(params.tagId ?? ''),
  )
  const [step, setStep] = useState<Step>('camera')
  const [recordId] = useState(() => crypto.randomUUID())
  const [photos, setPhotos] = useState<CapturedPhoto[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [location, setLocation] = useState<LatLng | null>(null)
  const [locationAdjusted, setLocationAdjusted] = useState(false)
  const [notes, setNotes] = useState('')
  const [savedStatus, setSavedStatus] = useState<'synced' | 'queued' | null>(null)
  const capturedAtRef = useRef<string | null>(null)

  const geo = useGeoWatch(step === 'camera' || step === 'confirm-tag' || step === 'confirm-blurry')

  // Non-blocking duplicate hint: has this collector already recorded this tag?
  const existing = useLiveQuery(
    () => (tagId ? db.records.where('tagId').equals(tagId).toArray() : []),
    [tagId],
  )
  const priorRecords = (existing ?? []).filter((r) => r.id !== recordId)

  const pending = useLiveQuery(
    () => db.records.where('status').anyOf('queued', 'syncing', 'error').count(),
    [],
    0,
  )

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const onCapture = useCallback(
    (photo: CapturedPhoto) => {
      capturedAtRef.current ??= new Date().toISOString()
      // Draft-persist immediately: back-nav can never lose a shot.
      void addDraftPhoto({
        recordId,
        blob: photo.blob,
        width: photo.width,
        height: photo.height,
      })
      setPhotos((prev) => [...prev, photo])
      setPreviewUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(photo.blob)
      })
      const blurry = photo.focusScore != null && photo.focusScore < 50
      setStep(blurry ? 'confirm-blurry' : 'confirm-tag')
    },
    [recordId],
  )

  const bestFocus = useMemo(
    () =>
      photos.reduce<number | null>(
        (best, p) =>
          p.focusScore == null ? best : Math.max(best ?? -Infinity, p.focusScore),
        null,
      ),
    [photos],
  )

  async function retake() {
    // Keep the record draft but drop the last photo.
    const last = await db.photos.where('recordId').equals(recordId).last()
    if (last) await db.photos.delete(last.id)
    setPhotos((prev) => prev.slice(0, -1))
    setStep('camera')
  }

  async function save(where: LatLng) {
    if (!tagId || !session) return
    await finalizeRecord({
      id: recordId,
      tagId,
      collectorId: session.user.id,
      lat: where.lat,
      lng: where.lng,
      gpsAccuracyM: geo.fix?.accuracyM ?? null,
      locationAdjusted,
      capturedAt: capturedAtRef.current ?? new Date().toISOString(),
      notes,
      focusScore: bestFocus,
    })
    setStep('saved')
    setSavedStatus('queued')
    if (navigator.onLine) {
      const summary = await syncEngine.kick()
      const mine = await db.records.get(recordId)
      if (summary.synced > 0 && mine?.status === 'synced') setSavedStatus('synced')
    }
  }

  // ---- Guards ----------------------------------------------------------

  if (loading) {
    return <Centered>Loading…</Centered>
  }

  if (!session) {
    if (tagId) stashResumeTag(tagId)
    return (
      <Centered>
        <div className="flex flex-col items-center gap-4 p-6 text-center">
          <h1 className="text-xl font-bold">
            Tag {tagId ? formatTagId(tagId) : ''} scanned
          </h1>
          <p className="text-sm text-slate-400">
            Sign in once to record specimens. After that, capturing works
            offline in the field.
          </p>
          <Link
            to="/auth"
            className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold"
          >
            Sign in
          </Link>
        </div>
      </Centered>
    )
  }

  if (!tagId) {
    return (
      <Centered>
        <form
          className="flex w-full max-w-sm flex-col gap-3 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            const parsed = parseTagId(manualEntry)
            if (parsed) {
              setManualError(null)
              setTagId(parsed)
              navigate(`/s/${parsed}`, { replace: true })
            } else {
              setManualError(
                'That does not look like a valid tag — check the number and its last (check) character.',
              )
            }
          }}
        >
          <h1 className="text-xl font-bold">Unrecognized tag</h1>
          <p className="text-sm text-slate-400">
            The scanned code is not a valid SpeciMap tag. You can enter the
            printed tag number manually:
          </p>
          <input
            value={manualEntry}
            onChange={(e) => setManualEntry(e.target.value)}
            placeholder="7Q4M-K2XR-C"
            autoCapitalize="characters"
            className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-center font-mono text-lg"
          />
          {manualError && <p className="text-sm text-red-400">{manualError}</p>}
          <button className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold">
            Open tag
          </button>
        </form>
      </Centered>
    )
  }

  // ---- Steps -----------------------------------------------------------

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between bg-slate-900 px-4 py-2">
        <span className="font-mono text-lg font-bold">{formatTagId(tagId)}</span>
        <span className="text-xs text-slate-400">
          {geo.fix
            ? `GPS ±${Math.round(geo.fix.accuracyM)}m`
            : geo.error
              ? 'GPS unavailable'
              : 'GPS acquiring…'}
        </span>
      </header>

      {priorRecords.length > 0 && step === 'camera' && (
        <div className="bg-amber-900/60 px-4 py-2 text-sm text-amber-200">
          This tag already has {priorRecords.length} record
          {priorRecords.length > 1 ? 's' : ''} on this device — you are adding
          another.{' '}
          <Link className="underline" to={`/record/${priorRecords[0].id}`}>
            View
          </Link>
        </div>
      )}

      {step === 'camera' && <CameraView onCapture={onCapture} />}

      {step === 'confirm-blurry' && previewUrl && (
        <div className="flex flex-1 flex-col">
          <img src={previewUrl} className="min-h-0 flex-1 object-contain" />
          <div className="flex flex-col gap-3 p-4">
            <p className="text-center font-semibold text-amber-400">
              This photo looks blurry.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => void retake()}
                className="flex-1 rounded-lg bg-slate-700 px-4 py-3 font-semibold"
              >
                Retake
              </button>
              <button
                onClick={() => setStep('confirm-tag')}
                className="flex-1 rounded-lg bg-emerald-600 px-4 py-3 font-semibold"
              >
                Keep anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'confirm-tag' && previewUrl && (
        <div className="flex flex-1 flex-col">
          <img src={previewUrl} className="min-h-0 flex-1 object-contain" />
          <div className="flex flex-col gap-3 p-4">
            <p className="text-center">
              Does the physical tag in your photo read{' '}
              <span className="font-mono text-lg font-bold">
                {formatTagId(tagId)}
              </span>
              ?
            </p>
            <button
              onClick={() => setStep('location')}
              className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold"
            >
              Yes, it matches
            </button>
            <div className="flex gap-3">
              <button
                onClick={() => void retake()}
                className="flex-1 rounded-lg bg-slate-700 px-4 py-3"
              >
                Retake
              </button>
              <button
                onClick={() => setStep('camera')}
                className="flex-1 rounded-lg bg-slate-700 px-4 py-3"
              >
                Add another photo
              </button>
              <button
                onClick={() => {
                  setTagId(null)
                  setManualEntry('')
                }}
                className="flex-1 rounded-lg bg-slate-700 px-4 py-3"
              >
                Wrong tag
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'location' && (
        <div className="flex flex-1 flex-col">
          {(() => {
            const value = location ??
              (geo.fix
                ? { lat: geo.fix.lat, lng: geo.fix.lng }
                : { lat: 0, lng: 0 })
            return (
              <>
                <LocationPicker
                  value={value}
                  accuracyM={locationAdjusted ? null : geo.fix?.accuracyM}
                  onChange={(next) => {
                    setLocation(next)
                    setLocationAdjusted(true)
                  }}
                  className="min-h-0 flex-1"
                />
                <div className="flex flex-col gap-3 p-4">
                  <p className="text-center text-sm text-slate-400">
                    {geo.fix
                      ? `GPS ±${Math.round(geo.fix.accuracyM)}m — drag the pin to adjust`
                      : 'No GPS fix — drag the pin to your location (you can also fix this later)'}
                  </p>
                  <p className="text-center font-mono text-xs text-slate-500">
                    {value.lat.toFixed(6)}, {value.lng.toFixed(6)}
                  </p>
                  <input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3"
                  />
                  <button
                    onClick={() => void save(value)}
                    disabled={!geo.fix && !location}
                    className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-50"
                  >
                    Save record
                  </button>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {step === 'saved' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <div className="text-5xl">✓</div>
          <h1 className="text-xl font-bold">Saved</h1>
          <p className="text-sm text-slate-400">
            {savedStatus === 'synced'
              ? 'Uploaded to your collection.'
              : `Queued — will upload when online${pending ? ` (${pending} pending)` : ''}.`}
          </p>
          <div className="flex gap-3">
            <Link to="/" className="rounded-lg bg-slate-700 px-5 py-3">
              Done
            </Link>
            <div className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold">
              Scan the next tag with your camera
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center">{children}</div>
  )
}
