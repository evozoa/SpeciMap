import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { db, type LocalPhoto, type LocalRecord, type Taxon } from '../db/schema'
import { confirmTaxon, keepSpeciesAsTyped, needsNameCheck } from '../db/drafts'
import SpeciesInput from '../components/SpeciesInput'
import InatRecordPanel from '../inat/InatRecordPanel'
import { usePhotoUrl } from '../lib/photoUrl'
import { formatTagId, parseTagId } from '../lib/tagid'
import LocationPicker from '../map/LocationPicker'
import { distanceMetres, specimenView, type SpecimenView } from '../specimens/view'
import {
  confirmSameSpecimen,
  moveCaptureToTag,
  setIndividualCount,
  setSpecimenSpecies,
} from '../specimens/store'
import { describeSubsample } from '../subsamples/store'
import { LocationHistory, ScanBanner } from '../scans/ScanViews'
import { locationHistory } from '../scans/store'
import { syncEngine } from '../sync/triggers'

function Photo({ photo }: { photo: LocalPhoto }) {
  const url = usePhotoUrl(photo)
  return url ? (
    <img src={url} className="w-full rounded-lg object-cover" />
  ) : (
    <div className="aspect-square w-full rounded-lg bg-slate-800" />
  )
}

const kick = () => void syncEngine.kick()

function describeDistance(m: number) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`
}

// ---- Identification ------------------------------------------------------

function SpeciesField({ view, userId }: { view: SpecimenView; userId: string | undefined }) {
  const saved = view.species
  const savedTaxon = view.taxon
  const [value, setValue] = useState(saved)
  const [taxon, setTaxon] = useState<Taxon | null>(savedTaxon)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setValue(saved)
    setTaxon(savedTaxon)
  }, [saved, savedTaxon])

  const mine = view.captures.some((r) => r.collectorId === userId)
  const dirty = value.trim() !== saved || (taxon?.id ?? null) !== (savedTaxon?.id ?? null)
  const save = (name = value, picked = taxon) => {
    if (!userId || !mine) return
    if (name.trim() === saved && (picked?.id ?? null) === (savedTaxon?.id ?? null)) return
    setError(null)
    void setSpecimenSpecies(view.captures, userId, name, picked)
      .then(kick)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const check = view.identification && needsNameCheck(view.identification) && !dirty

  return (
    <form
      className="flex flex-col gap-1 rounded-lg bg-slate-900 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label htmlFor="species" className="text-sm text-slate-500">
        Species <span className="text-xs">(scientificName)</span>
      </label>
      <div className="flex items-start gap-2">
        <SpeciesInput
          id="species"
          value={value}
          taxon={taxon}
          onChange={(name, picked) => {
            setValue(name)
            setTaxon(picked)
            if (picked) save(name, picked)
          }}
          onBlur={() => save()}
          className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600"
        />
        <button
          type="submit"
          disabled={!dirty || !mine}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {check && <NameCheck record={view.identification!} />}
    </form>
  )
}

/** "Did you mean" for a name iNaturalist didn't match exactly. */
function NameCheck({ record }: { record: LocalRecord }) {
  const review = record.taxonReview!
  const typed = review.for
  const run = (p: Promise<void>) => void p.then(kick)
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-amber-700/60 bg-amber-950/40 p-3 text-sm">
      {review.candidates.length === 0 ? (
        <p className="text-amber-200">
          iNaturalist has no taxon called <i>{typed}</i> or anything close.
        </p>
      ) : (
        <p className="text-amber-200">
          <i>{typed}</i> isn't an exact iNaturalist name. Did you mean:
        </p>
      )}
      {review.candidates.map((t) => {
        // A synonym of the taxon (e.g. an older genus): offer to keep the name.
        const synonym =
          t.matched?.toLowerCase() === typed.toLowerCase() &&
          t.name.toLowerCase() !== typed.toLowerCase()
        return (
          <div key={t.id} className="flex flex-col gap-1 rounded bg-slate-900 p-2">
            <div>
              <span className="italic">{t.name}</span>
              {t.rank !== 'species' && <span className="text-slate-500"> ({t.rank})</span>}
              {t.commonName && <span className="text-slate-400"> · {t.commonName}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => run(confirmTaxon(record.id, t))}
                className="rounded bg-emerald-600 px-3 py-1 font-semibold"
              >
                Use <i>{t.name}</i>
              </button>
              {synonym && (
                <button
                  type="button"
                  onClick={() => run(confirmTaxon(record.id, t, { keepName: true }))}
                  className="rounded bg-slate-700 px-3 py-1"
                >
                  Keep <i>{typed}</i>, link to this taxon
                </button>
              )}
            </div>
          </div>
        )
      })}
      <button
        type="button"
        onClick={() => void keepSpeciesAsTyped(record.id)}
        className="self-start text-slate-400 underline"
      >
        Keep <i>{typed}</i> as typed
      </button>
    </div>
  )
}

/** Captures name different taxa: show each and let the collector pick. */
function Disagreement({ view, userId }: { view: SpecimenView; userId: string | undefined }) {
  const choices = new Map<string, LocalRecord>()
  for (const r of view.captures) {
    const name = r.species?.trim()
    if (name && !choices.has(name.toLowerCase())) choices.set(name.toLowerCase(), r)
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-700/60 bg-amber-950/40 p-4 text-sm">
      <p className="font-semibold text-amber-200">Identifications disagree</p>
      <p className="text-amber-100/80">
        Captures of this specimen were identified differently. Pick the identification to keep;
        each capture's own identification stays in its history.
      </p>
      {[...choices.values()].map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2 rounded bg-slate-900 p-2">
          <span>
            <i>{r.species}</i>
            <span className="block text-xs text-slate-500">
              {r.collectorId === userId ? 'You' : 'Another collector'},{' '}
              {new Date(r.identifiedAt ?? r.capturedAt).toLocaleString()}
            </span>
          </span>
          <button
            onClick={() =>
              userId && void setSpecimenSpecies(view.captures, userId, r.species!, r.taxon ?? null).then(kick)
            }
            className="rounded bg-emerald-600 px-3 py-1 font-semibold"
          >
            Use
          </button>
        </div>
      ))}
    </div>
  )
}

// ---- Tag reuse -----------------------------------------------------------

function MoveCapture({ capture }: { capture: LocalRecord }) {
  const [open, setOpen] = useState(false)
  const [entry, setEntry] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-slate-700 px-3 py-1">
        Different fish: move to its new tag
      </button>
    )
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        const tag = parseTagId(entry)
        if (!tag) return setError('Not a valid tag ID; check the last (check) character.')
        if (tag === capture.tagId) return setError('That is the same tag.')
        void moveCaptureToTag(capture.id, tag).then(kick)
      }}
    >
      <input
        value={entry}
        onChange={(e) => setEntry(e.target.value)}
        placeholder="New tag ID, e.g. 7Q4M-K2XR-C"
        autoCapitalize="characters"
        className="rounded bg-slate-800 px-3 py-2 font-mono"
      />
      {error && <p className="text-xs text-red-300">{error}</p>}
      <button className="rounded bg-emerald-600 px-3 py-1 font-semibold">Move capture</button>
    </form>
  )
}

function TagReuse({ view }: { view: SpecimenView }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-red-800/70 bg-red-950/40 p-4 text-sm">
      <p className="font-semibold text-red-200">Possible tag reuse</p>
      <p className="text-red-100/80">
        This tag was captured far apart in time or place. If it's one fish, confirm it. If a
        reprinted or reused tag ended up on a second fish, give that fish a new tag and move its
        capture there.
      </p>
      {view.reuseSuspects.map((r) => (
        <div key={r.id} className="flex flex-col gap-2 rounded bg-slate-900 p-2">
          <span className="text-xs text-slate-400">
            {new Date(r.capturedAt).toLocaleString()} ·{' '}
            {describeDistance(distanceMetres(view.first, r))} from the first capture
            {r.species ? (
              <>
                {' '}
                · <i>{r.species}</i>
              </>
            ) : null}
          </span>
          <MoveCapture capture={r} />
        </div>
      ))}
      <button
        onClick={() => void confirmSameSpecimen(view.tagId, view.reuseSuspects.map((r) => r.id))}
        className="self-start rounded bg-emerald-700 px-3 py-1 font-semibold"
      >
        Same fish: confirm
      </button>
    </div>
  )
}

// ---- Page ------------------------------------------------------------------

function CountField({ view }: { view: SpecimenView }) {
  const [value, setValue] = useState(String(view.individualCount))
  useEffect(() => setValue(String(view.individualCount)), [view.individualCount])
  const save = () => {
    const n = parseInt(value, 10)
    if (n >= 1 && n !== view.individualCount) void setIndividualCount(view.tagId, n)
    else setValue(String(view.individualCount))
  }
  return (
    <label className="flex items-center justify-between gap-3 rounded-lg bg-slate-900 p-4 text-sm">
      <span>
        Individuals <span className="text-xs text-slate-500">(individualCount)</span>
        <span className="block text-xs text-slate-500">More than 1 if this tag is on a lot.</span>
      </span>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
        className="w-20 rounded bg-slate-800 px-3 py-2 text-right"
      />
    </label>
  )
}

function CaptureRow({ r, userId }: { r: LocalRecord; userId: string | undefined }) {
  return (
    <li className="flex flex-col gap-0.5 border-t border-slate-800 py-2 first:border-0">
      <span>
        {new Date(r.capturedAt).toLocaleString()}{' '}
        <span className="text-xs text-slate-500">
          · {r.collectorId === userId ? 'you' : 'another collector'} ·{' '}
          <span className="capitalize">{r.status}</span>
        </span>
      </span>
      <span className="font-mono text-xs text-slate-400">
        {r.lat.toFixed(6)}, {r.lng.toFixed(6)}{' '}
        {r.gpsAccuracyM != null ? `±${Math.round(r.gpsAccuracyM)} m` : ''}
        {r.locationAdjusted && ' (pin adjusted by hand)'}
      </span>
      {r.species && (
        <span className="text-xs text-slate-400">
          Identified as <i>{r.species}</i>
        </span>
      )}
      {r.notes && <span className="text-xs text-slate-300">{r.notes}</span>}
    </li>
  )
}

/** Old /record/:id links open the capture's specimen. */
export function RecordRedirect() {
  const { id } = useParams<{ id: string }>()
  const record = useLiveQuery(async () => (id ? ((await db.records.get(id)) ?? null) : null), [id])
  if (record === undefined) return null
  return <Navigate to={record ? `/specimen/${record.tagId}` : '/'} replace />
}

export default function SpecimenPage() {
  const { tagId } = useParams<{ tagId: string }>()
  const { session } = useAuth()
  const userId = session?.user.id
  const [params] = useSearchParams()
  const scanId = params.get('scan')
  const navigate = useNavigate()
  const data = useLiveQuery(async () => {
    if (!tagId) return null
    const captures = (await db.records.where('tagId').equals(tagId).toArray()).filter(
      (r) => r.status !== 'draft',
    )
    if (!captures.length) return null
    const view = specimenView(captures, await db.specimens.get(tagId))
    const photos = await db.photos.where('recordId').anyOf(captures.map((r) => r.id)).toArray()
    const subsamples = await db.subsamples.where('parentTagId').equals(tagId).sortBy('collectedAt')
    const history = locationHistory(captures, await db.scans.where('tagId').equals(tagId).toArray())
    return { view, photos, subsamples, history }
  }, [tagId])

  if (data === undefined) return null
  if (!data) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400">Specimen not found on this device.</p>
        <Link to="/" className="text-emerald-400 underline">
          Home
        </Link>
      </div>
    )
  }
  const { view, photos, subsamples, history } = data
  const failed = view.captures.filter((r) => r.status === 'error')
  const myFirst = view.captures.find((r) => r.collectorId === userId)

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <span className="font-mono text-lg font-bold">{formatTagId(view.tagId)}</span>
      </header>

      {failed.map((r) => (
        <div key={r.id} className="rounded-lg bg-red-900/50 p-4 text-sm">
          <p className="font-semibold text-red-300">Upload failed</p>
          <p className="mt-1 text-red-200">{r.lastError}</p>
          <button
            onClick={() => void syncEngine.retryRecord(r.id).then(kick)}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 font-semibold"
          >
            Retry upload
          </button>
        </div>
      ))}

      {scanId && (
        <ScanBanner scanId={scanId} onDifferentFish={() => navigate(`/s/${view.tagId}?photos=1`, { replace: true })} />
      )}

      {view.reuseSuspects.length > 0 && <TagReuse view={view} />}
      {view.disagreement && <Disagreement view={view} userId={userId} />}

      <SpeciesField view={view} userId={userId} />
      <CountField view={view} />

      <div className="grid grid-cols-2 gap-2">
        {photos.map((p) => (
          <Photo key={p.id} photo={p} />
        ))}
      </div>

      <LocationPicker
        value={{ lat: view.first.lat, lng: view.first.lng }}
        accuracyM={view.first.gpsAccuracyM}
        onChange={() => {}}
        readOnly
        className="h-64 overflow-hidden rounded-lg"
      />

      <Link to={`/s/${view.tagId}?photos=1`} className="rounded-lg bg-slate-800 px-4 py-3 text-center text-sm font-semibold">
        Add photos
      </Link>

      {myFirst && <InatRecordPanel record={myFirst} />}

      <LocationHistory history={history} userId={userId} />

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="mb-1 font-semibold">
          Subsamples <span className="text-xs font-normal text-slate-500">({subsamples.length})</span>
        </h2>
        <ul>
          {subsamples.map((s) => (
            <li key={s.tagId} className="flex items-center justify-between border-t border-slate-800 py-2 first:border-0">
              <Link to={`/subsample/${s.tagId}`} className="font-mono text-emerald-400 underline">
                {formatTagId(s.tagId)}
              </Link>
              <span className="text-slate-400">
                {describeSubsample(s)}
                {s.status !== 'synced' && ' · not uploaded'}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-slate-500">
          To add one, scan an unused tag (e.g. on a 2 mL tube) and choose Subsample.
        </p>
      </section>

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="mb-1 font-semibold">
          Captures <span className="text-xs font-normal text-slate-500">({view.captures.length})</span>
        </h2>
        <ul>
          {view.captures.map((r) => (
            <CaptureRow key={r.id} r={r} userId={userId} />
          ))}
        </ul>
      </section>
    </div>
  )
}
