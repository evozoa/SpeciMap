import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type LocalPhoto, type LocalRecord, type Taxon } from '../db/schema'
import { confirmTaxon, keepSpeciesAsTyped, needsNameCheck, setSpecies } from '../db/drafts'
import SpeciesInput from '../components/SpeciesInput'
import InatRecordPanel from '../inat/InatRecordPanel'
import { usePhotoUrl } from '../lib/photoUrl'
import { formatTagId } from '../lib/tagid'
import LocationPicker from '../map/LocationPicker'
import { syncEngine } from '../sync/triggers'

function Photo({ photo }: { photo: LocalPhoto }) {
  const url = usePhotoUrl(photo)
  return url ? (
    <img src={url} className="w-full rounded-lg object-cover" />
  ) : (
    <div className="aspect-square w-full rounded-lg bg-slate-800" />
  )
}

function SpeciesField({ record }: { record: LocalRecord }) {
  const saved = record.species ?? ''
  const savedTaxon = record.taxon ?? null
  const [value, setValue] = useState(saved)
  const [taxon, setTaxon] = useState<Taxon | null>(savedTaxon)
  const [error, setError] = useState<string | null>(null)
  // Follow the stored value when it changes elsewhere (e.g. a pull, or a
  // name confirmed below).
  useEffect(() => {
    setValue(saved)
    setTaxon(savedTaxon)
  }, [saved, savedTaxon])

  const dirty = value.trim() !== saved || (taxon?.id ?? null) !== (savedTaxon?.id ?? null)
  const save = (name = value, picked = taxon) => {
    if (name.trim() === saved && (picked?.id ?? null) === (savedTaxon?.id ?? null)) return
    setError(null)
    void setSpecies(record.id, name, picked)
      .then(() => syncEngine.kick())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <form
      className="flex flex-col gap-1 rounded-lg bg-slate-900 p-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <label htmlFor="species" className="text-sm text-slate-500">
        Species
      </label>
      <div className="flex items-start gap-2">
        <SpeciesInput
          id="species"
          value={value}
          taxon={taxon}
          onChange={(name, picked) => {
            setValue(name)
            setTaxon(picked)
            if (picked) save(name, picked) // a pick from the list saves at once
          }}
          onBlur={() => save()}
          className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600"
        />
        <button
          type="submit"
          disabled={!dirty}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Save
        </button>
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      {needsNameCheck(record) && !dirty && <NameCheck record={record} />}
    </form>
  )
}

/** "Did you mean" for a name iNaturalist didn't match exactly. */
function NameCheck({ record }: { record: LocalRecord }) {
  const review = record.taxonReview!
  const typed = review.for
  const run = (p: Promise<void>) => void p.then(() => syncEngine.kick())
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

export default function RecordPage() {
  const { id } = useParams<{ id: string }>()
  const record = useLiveQuery(() => (id ? db.records.get(id) : undefined), [id])
  const photos = useLiveQuery(
    () => (id ? db.photos.where('recordId').equals(id).toArray() : []),
    [id],
  )
  if (!record) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400">Record not found on this device.</p>
        <Link to="/" className="text-emerald-400 underline">
          Home
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <span className="font-mono text-lg font-bold">
          {formatTagId(record.tagId)}
        </span>
      </header>

      {record.status === 'error' && (
        <div className="rounded-lg bg-red-900/50 p-4 text-sm">
          <p className="font-semibold text-red-300">Upload failed</p>
          <p className="mt-1 text-red-200">{record.lastError}</p>
          <button
            onClick={() => {
              void syncEngine
                .retryRecord(record.id)
                .then(() => syncEngine.kick())
            }}
            className="mt-3 rounded bg-red-700 px-3 py-1.5 font-semibold"
          >
            Retry upload
          </button>
        </div>
      )}

      <SpeciesField record={record} />

      <div className="grid grid-cols-2 gap-2">
        {photos?.map((p) => <Photo key={p.id} photo={p} />)}
      </div>

      <LocationPicker
        value={{ lat: record.lat, lng: record.lng }}
        accuracyM={record.gpsAccuracyM}
        onChange={() => {}}
        readOnly
        className="h-64 overflow-hidden rounded-lg"
      />

      <InatRecordPanel record={record} />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg bg-slate-900 p-4 text-sm">
        <dt className="text-slate-500">Captured</dt>
        <dd>{new Date(record.capturedAt).toLocaleString()}</dd>
        <dt className="text-slate-500">Coordinates</dt>
        <dd className="font-mono text-xs">
          {record.lat.toFixed(6)}, {record.lng.toFixed(6)}
        </dd>
        <dt className="text-slate-500">GPS accuracy</dt>
        <dd>
          {record.gpsAccuracyM != null ? `±${Math.round(record.gpsAccuracyM)}m` : '—'}
          {record.locationAdjusted && ' (pin adjusted by hand)'}
        </dd>
        <dt className="text-slate-500">Status</dt>
        <dd className="capitalize">{record.status}</dd>
        {record.focusScore != null && (
          <>
            <dt className="text-slate-500">Focus score</dt>
            <dd>{record.focusScore.toFixed(0)}</dd>
          </>
        )}
        {record.notes && (
          <>
            <dt className="text-slate-500">Notes</dt>
            <dd>{record.notes}</dd>
          </>
        )}
      </dl>
    </div>
  )
}
