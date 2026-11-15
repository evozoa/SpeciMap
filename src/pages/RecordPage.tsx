import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type LocalPhoto, type LocalRecord } from '../db/schema'
import { knownSpecies, setSpecies } from '../db/drafts'
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
  const [value, setValue] = useState(saved)
  const [error, setError] = useState<string | null>(null)
  const suggestions = useLiveQuery(knownSpecies, [], [])
  // Follow the stored value when it changes elsewhere (e.g. a pull).
  useEffect(() => setValue(saved), [saved])

  const dirty = value.trim() !== saved
  const save = () => {
    if (!dirty) return
    setError(null)
    void setSpecies(record.id, value)
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
      <div className="flex gap-2">
        <input
          id="species"
          list="species-suggestions"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          placeholder="e.g. Lepomis megalotis"
          autoCapitalize="sentences"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-slate-800 px-3 py-2 italic placeholder:not-italic placeholder:text-slate-600"
        />
        <button
          type="submit"
          disabled={!dirty}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-semibold disabled:opacity-40"
        >
          Save
        </button>
      </div>
      <datalist id="species-suggestions">
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {error && <p className="text-sm text-red-300">{error}</p>}
    </form>
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
