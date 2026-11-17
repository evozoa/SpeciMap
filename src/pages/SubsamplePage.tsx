import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { db, type LocalSubsample } from '../db/schema'
import { LocationHistory, ScanBanner } from '../scans/ScanViews'
import { locationHistory, type HistoryEntry } from '../scans/store'
import { formatTagId } from '../lib/tagid'
import { PRESERVATIONS, SAMPLE_TYPES, updateSubsample } from '../subsamples/store'
import { subsampleSync } from '../sync/triggers'

const kick = () => {
  if (navigator.onLine) void subsampleSync.kick()
}

type Key = 'sampleType' | 'preservation' | 'remarks'

function Field({ s, k, label, term, options }: { s: LocalSubsample; k: Key; label: string; term?: string; options?: string[] }) {
  const saved = s[k]
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  const id = `opts-${k}`
  return (
    <label className="flex flex-col gap-1">
      <span>
        {label} {term && <span className="text-xs text-slate-500">({term})</span>}
      </span>
      <input
        list={options ? id : undefined}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value.trim() !== saved) void updateSubsample(s.tagId, { [k]: value.trim() }).then(kick)
        }}
        className="rounded bg-slate-800 px-3 py-2"
      />
      {options && (
        <datalist id={id}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </label>
  )
}

/** /subsample/:tagId: a subsample and the specimen it came from. */
export default function SubsamplePage() {
  const { tagId } = useParams<{ tagId: string }>()
  const [params] = useSearchParams()
  const scanId = params.get('scan')
  const { session } = useAuth()
  const data = useLiveQuery(async () => {
    if (!tagId) return null
    const s = await db.subsamples.get(tagId)
    if (!s) return null
    const parentCaptures = await db.records.where('tagId').equals(s.parentTagId).toArray()
    const species = parentCaptures.find((r) => r.species?.trim())?.species?.trim() ?? ''
    const event = s.eventId ? await db.events.get(s.eventId) : undefined
    // Where it was taken: the event's position, if the event has one.
    const taken: HistoryEntry = {
      kind: 'collected',
      id: s.tagId,
      at: s.collectedAt,
      lat: event?.decimalLatitude ?? null,
      lng: event?.decimalLongitude ?? null,
      accuracyM: event?.coordinateUncertaintyInMeters ?? null,
      place: event?.locality ?? '',
      by: s.createdBy,
    }
    const history = [taken, ...locationHistory([], await db.scans.where('tagId').equals(tagId).toArray())]
    return { s, species, parentKnown: parentCaptures.length > 0, event, history }
  }, [tagId])

  if (data === undefined) return null
  if (!data) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400">Subsample not found on this device.</p>
        <Link to="/" className="text-emerald-400 underline">
          Home
        </Link>
      </div>
    )
  }
  const { s, species, parentKnown, event, history } = data

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-slate-400 underline">
          ← Home
        </Link>
        <span className="font-mono text-lg font-bold">{formatTagId(s.tagId)}</span>
      </header>

      {scanId && <ScanBanner scanId={scanId} />}
      {params.get('saved') && (
        <div className="rounded-lg bg-emerald-900/50 p-3 text-emerald-200">
          Saved. Scan the next tag with your camera.
        </div>
      )}
      {s.status === 'error' && (
        <div className="rounded-lg bg-red-900/50 p-4">
          <p className="font-semibold text-red-300">Upload failed</p>
          <p className="mt-1 text-red-200">{s.lastError}</p>
          <button
            onClick={() => void subsampleSync.retry(s.tagId).then(kick)}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 font-semibold"
          >
            Retry upload
          </button>
        </div>
      )}

      <section className="flex flex-col gap-1 rounded-lg bg-slate-900 p-4">
        <h1 className="text-lg font-bold">Subsample</h1>
        <p>
          Taken from specimen{' '}
          {parentKnown ? (
            <Link to={`/specimen/${s.parentTagId}`} className="font-mono text-emerald-400 underline">
              {formatTagId(s.parentTagId)}
            </Link>
          ) : (
            <span className="font-mono">{formatTagId(s.parentTagId)}</span>
          )}
          {species && (
            <>
              {' '}
              (<i>{species}</i>)
            </>
          )}
        </p>
        {!parentKnown && <p className="text-xs text-slate-500">That specimen isn't recorded on this phone.</p>}
        {event && (
          <p>
            Event{' '}
            <Link to={`/event/${event.id}`} className="text-emerald-400 underline">
              {event.fieldNumber || formatTagId(event.id)}
            </Link>
          </p>
        )}
        <p className="text-slate-400">
          {new Date(s.collectedAt).toLocaleString()} ·{' '}
          {s.status === 'synced' ? 'Uploaded' : s.status === 'error' ? 'Not uploaded' : 'Waiting to upload'}
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4">
        <Field s={s} k="sampleType" label="Sample type" term="materialSampleType" options={SAMPLE_TYPES} />
        <Field s={s} k="preservation" label="Preservation" term="preparations" options={PRESERVATIONS} />
        <Field s={s} k="remarks" label="Remarks" />
      </section>

      <LocationHistory history={history} userId={session?.user.id} />
    </div>
  )
}
