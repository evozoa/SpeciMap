import { useEffect, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { stashResumePath } from '../auth/resume'
import { useGeoWatch } from '../capture/useGeoWatch'
import { db, type LocalEvent, type LocalEventPhoto, type LocalPhoto } from '../db/schema'
import {
  addEventPhoto,
  endEvent,
  getActiveEvent,
  openFieldSheet,
  resumeEvent,
  setActiveEvent,
  setEventLocationIfMissing,
  updateEvent,
} from '../events/store'
import { encodePhotoFile, keepOriginal } from '../lib/image'
import { usePhotoUrl } from '../lib/photoUrl'
import { getPrefs, usePrefs } from '../lib/prefs'
import { formatTagId, parseTagId } from '../lib/tagid'
import LocationPicker from '../map/LocationPicker'
import { buildSpecimens } from '../specimens/view'
import { eventSync } from '../sync/triggers'

const kick = () => void eventSync.kick()

/** /e/:tagId, the URL in a field sheet's QR code: opens or starts its event. */
export function FieldSheetScan() {
  const { tagId: raw } = useParams<{ tagId: string }>()
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const tagId = parseTagId(raw ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (loading || !session || !tagId) return
    void (async () => {
      try {
        const [{ recordedBy }, { fieldNumberPrefix }] = await Promise.all([
          getPrefs('exportPrefs'),
          getPrefs('collectorPrefs'),
        ])
        const e = await openFieldSheet({ tagId, userId: session.user.id, recordedBy, fieldNumberPrefix })
        kick()
        navigate(`/event/${e.id}`, { replace: true })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [loading, session, tagId, navigate])

  if (!tagId) return <Navigate to={`/s/${raw ?? ''}`} replace />
  if (!loading && !session) {
    stashResumePath(`/e/${tagId}`)
    return <Navigate to="/auth" replace />
  }
  return (
    <div className="flex min-h-full items-center justify-center p-6 text-slate-400">
      {error ?? 'Opening field sheet…'}
    </div>
  )
}

function SheetPhoto({ photo }: { photo: LocalEventPhoto }) {
  const url = usePhotoUrl(photo as unknown as LocalPhoto)
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} className="w-full rounded-lg object-cover" />
    </a>
  ) : (
    <div className="aspect-[3/4] w-full rounded-lg bg-slate-800" />
  )
}

type TextKey =
  | 'fieldNumber'
  | 'recordedBy'
  | 'locality'
  | 'waterBody'
  | 'county'
  | 'stateProvince'
  | 'countryCode'
  | 'samplingProtocol'
  | 'samplingEffort'
  | 'habitat'
  | 'eventRemarks'

/** A text field saved on blur; label is the Darwin Core term. */
function Field({
  event,
  k,
  label,
  hint,
  placeholder,
  multiline,
}: {
  event: LocalEvent
  k: TextKey
  label: string
  hint?: string
  placeholder?: string
  multiline?: boolean
}) {
  const saved = event[k]
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  const save = () => {
    if (value.trim() !== saved) void updateEvent(event.id, { [k]: value.trim() }).then(kick)
  }
  const cls = 'rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600'
  return (
    <label className="flex flex-col gap-1">
      <span>
        {hint ?? label} {hint && <span className="text-xs text-slate-500">({label})</span>}
      </span>
      {multiline ? (
        <textarea value={value} rows={3} onChange={(e) => setValue(e.target.value)} onBlur={save} placeholder={placeholder} className={cls} />
      ) : (
        <input value={value} onChange={(e) => setValue(e.target.value)} onBlur={save} placeholder={placeholder} className={cls} />
      )}
    </label>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  )
}

function localInput(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export default function EventPage() {
  const { id } = useParams<{ id: string }>()
  const { session } = useAuth()
  const { fullRes } = usePrefs('capturePrefs')
  const event = useLiveQuery(async () => (id ? ((await db.events.get(id)) ?? null) : null), [id])
  const active = useLiveQuery(() => getActiveEvent(), [], null)
  const photos = useLiveQuery(() => (id ? db.eventPhotos.where('eventId').equals(id).toArray() : []), [id], [])
  const specimens = useLiveQuery(async () => {
    if (!id) return []
    const captures = await db.records.where('eventId').equals(id).toArray()
    const tags = [...new Set(captures.map((c) => c.tagId))]
    // Whole specimens, including captures of them made outside the event.
    const all = await db.records.where('tagId').anyOf(tags).toArray()
    return buildSpecimens(all, (await db.specimens.bulkGet(tags)).filter((s) => !!s))
  }, [id])
  const needsFix = !!event && event.decimalLatitude == null
  const geo = useGeoWatch(needsFix)

  useEffect(() => {
    if (event && geo.fix) void setEventLocationIfMissing(event.id, geo.fix).then(kick)
  }, [event, geo.fix])

  if (event === undefined) return null
  if (!event) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400">Event not found on this device.</p>
        <Link to="/events" className="text-emerald-400 underline">
          Events
        </Link>
      </div>
    )
  }
  const isActive = active?.id === event.id
  const mine = event.createdBy === session?.user.id

  async function addSheetPhoto(file: File | undefined) {
    if (!file || !event) return
    await addEventPhoto(event.id, fullRes ? await keepOriginal(file) : await encodePhotoFile(file))
    kick()
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/events" className="text-sm text-slate-400 underline">
          ← Events
        </Link>
        <span className="text-right">
          <span className="block text-lg font-bold">{event.fieldNumber || 'Event'}</span>
          <span className="font-mono text-xs text-slate-500">eventID {formatTagId(event.id)}</span>
        </span>
      </header>

      {event.status === 'error' && (
        <p className="rounded-lg bg-red-900/50 p-3 text-sm text-red-200">Upload failed: {event.lastError}</p>
      )}

      <div
        className={`flex items-center justify-between gap-3 rounded-lg p-4 text-sm ${isActive ? 'bg-emerald-900/50' : 'bg-slate-900'}`}
      >
        <span>
          {isActive
            ? 'Active: specimens you capture now join this event.'
            : event.eventEnd
              ? `Ended ${new Date(event.eventEnd).toLocaleString()}`
              : 'Not active on this phone.'}
        </span>
        {isActive ? (
          <button onClick={() => void endEvent(event.id).then(kick)} className="shrink-0 rounded bg-slate-700 px-3 py-1.5 font-semibold">
            End event
          </button>
        ) : event.eventEnd ? (
          <button onClick={() => void resumeEvent(event.id).then(kick)} className="shrink-0 rounded bg-slate-700 px-3 py-1.5 font-semibold">
            Resume
          </button>
        ) : (
          <button onClick={() => void setActiveEvent(event.id)} className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 font-semibold">
            Make active
          </button>
        )}
      </div>

      {!mine && (
        <p className="text-xs text-amber-300">
          This field sheet belongs to another collector. Joining someone else's event is coming
          with shared events; for now, edits here stay on this phone.
        </p>
      )}

      <Section title="Event">
        <div className="grid grid-cols-2 gap-3">
          <Field event={event} k="fieldNumber" label="fieldNumber" hint="Field number" />
          <label className="flex flex-col gap-1">
            <span>
              Start <span className="text-xs text-slate-500">(eventDate)</span>
            </span>
            <input
              type="datetime-local"
              value={localInput(event.eventDate)}
              onChange={(e) =>
                e.target.value && void updateEvent(event.id, { eventDate: new Date(e.target.value).toISOString() }).then(kick)
              }
              className="rounded bg-slate-800 px-2 py-2"
            />
          </label>
        </div>
        <Field event={event} k="recordedBy" label="recordedBy" hint="Collectors" placeholder="Names, separated by |" />
        <Field event={event} k="samplingProtocol" label="samplingProtocol" hint="Method" placeholder="e.g. seine, backpack electrofishing" />
        <Field event={event} k="samplingEffort" label="samplingEffort" hint="Effort" placeholder="e.g. 6 seine hauls; 1,200 s shocking" />
        <Field event={event} k="habitat" label="habitat" hint="Habitat" placeholder="e.g. riffle-run, gravel substrate" />
        <Field event={event} k="eventRemarks" label="eventRemarks" hint="Remarks" multiline />
      </Section>

      <Section title="Location">
        <Field event={event} k="locality" label="locality" hint="Locality" placeholder="e.g. Tibbee Creek at Hwy 50 bridge" />
        <div className="grid grid-cols-2 gap-3">
          <Field event={event} k="waterBody" label="waterBody" hint="Water body" />
          <Field event={event} k="county" label="county" hint="County" />
          <Field event={event} k="stateProvince" label="stateProvince" hint="State" />
          <Field event={event} k="countryCode" label="countryCode" hint="Country code" placeholder="US" />
        </div>
        {event.decimalLatitude != null && event.decimalLongitude != null ? (
          <>
            <LocationPicker
              value={{ lat: event.decimalLatitude, lng: event.decimalLongitude }}
              accuracyM={event.coordinateUncertaintyInMeters}
              onChange={(p) =>
                void updateEvent(event.id, { decimalLatitude: p.lat, decimalLongitude: p.lng }).then(kick)
              }
              className="h-56 overflow-hidden rounded-lg"
            />
            <p className="font-mono text-xs text-slate-500">
              {event.decimalLatitude.toFixed(6)}, {event.decimalLongitude.toFixed(6)}
              {event.coordinateUncertaintyInMeters != null && ` ±${Math.round(event.coordinateUncertaintyInMeters)} m`}
              {' '}· drag the pin to adjust
            </p>
          </>
        ) : (
          <p className="text-slate-400">{geo.error ? `GPS unavailable (${geo.error})` : 'Getting GPS fix…'}</p>
        )}
      </Section>

      <Section title="Field notes">
        <p className="text-slate-400">
          Photograph the completed field sheet; the photos are linked as <i>fieldNotes</i>.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {photos.map((p) => (
            <SheetPhoto key={p.id} photo={p} />
          ))}
        </div>
        <label className="self-start rounded bg-slate-700 px-3 py-2 font-semibold">
          Photograph field sheet
          <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void addSheetPhoto(e.target.files?.[0])} />
        </label>
      </Section>

      <Section title={`Specimens (${specimens?.length ?? 0})`}>
        {specimens?.length === 0 && <p className="text-slate-500">None yet. Scan vial tags while this event is active.</p>}
        <ul className="flex flex-col">
          {specimens?.map((v) => (
            <li key={v.tagId} className="border-t border-slate-800 py-2 first:border-0">
              <Link to={`/specimen/${v.tagId}`} className="flex justify-between gap-2">
                <span className="font-mono">{formatTagId(v.tagId)}</span>
                <span className="truncate italic text-slate-300">
                  {v.species || <span className="not-italic text-slate-600">no species</span>}
                  {v.individualCount > 1 && <span className="not-italic text-slate-400"> × {v.individualCount}</span>}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  )
}

/** /events: the collector's events, newest first. */
export function EventsPage() {
  const events = useLiveQuery(() => db.events.orderBy('eventDate').reverse().toArray(), [], [])
  const counts = useLiveQuery(async () => {
    const m = new Map<string, Set<string>>()
    await db.records.each((r) => {
      if (r.eventId) m.set(r.eventId, (m.get(r.eventId) ?? new Set()).add(r.tagId))
    })
    return m
  }, [])
  const active = useLiveQuery(() => getActiveEvent(), [], null)
  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-xl font-bold">Events</h1>
      </header>
      <p className="text-sm text-slate-400">
        Scan a field sheet's QR code to start an event. Print field sheets from{' '}
        <Link to="/tags" className="text-emerald-400 underline">
          Tag sheets
        </Link>
        .
      </p>
      {events.length === 0 && <p className="text-sm text-slate-500">No events yet.</p>}
      {events.map((e) => (
        <Link key={e.id} to={`/event/${e.id}`} className="flex items-center gap-3 rounded-lg bg-slate-900 p-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{e.fieldNumber || formatTagId(e.id)}</div>
            <div className="truncate text-sm text-slate-300">{e.locality || e.waterBody || 'No locality yet'}</div>
            <div className="text-xs text-slate-400">
              {new Date(e.eventDate).toLocaleString()} · {counts?.get(e.id)?.size ?? 0} specimens
            </div>
          </div>
          {active?.id === e.id && <span className="rounded-full bg-emerald-700 px-2 py-1 text-xs">Active</span>}
          {e.status !== 'synced' && (
            <span className={`rounded-full px-2 py-1 text-xs ${e.status === 'error' ? 'bg-red-700' : 'bg-amber-600'}`}>
              {e.status === 'error' ? 'Needs attention' : 'Queued'}
            </span>
          )}
        </Link>
      ))}
    </div>
  )
}
