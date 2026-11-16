import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'
import { buildPackage } from '../export/package'
import { buildSpecimens } from '../specimens/view'
import { isFullRes } from '../lib/image'
import { setPrefs, usePrefs, type BasisOfRecord, type PhotoLicense } from '../lib/prefs'

const BASIS_LABEL: Record<BasisOfRecord, string> = {
  HumanObservation: 'Photo voucher (the photos are the voucher)',
  PreservedSpecimen: 'Preserved specimen (physical voucher)',
  MaterialSample: 'Material sample (tissue, fin clip)',
}

const LICENSE_LABEL: Record<PhotoLicense, string> = {
  'CC0-1.0': 'CC0 (public domain)',
  'CC-BY-4.0': 'CC BY 4.0 (credit required)',
  'CC-BY-NC-4.0': 'CC BY-NC 4.0 (credit, non-commercial)',
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const field = 'rounded bg-slate-800 px-3 py-2'

export default function ExportPage() {
  const prefs = usePrefs('exportPrefs')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  // Specimens, by the local date of their first capture.
  const selected = useLiveQuery(async () => {
    const all = buildSpecimens(await db.records.toArray(), await db.specimens.toArray())
    return all.filter((v) => {
      const day = new Date(v.first.capturedAt).toLocaleDateString('en-CA')
      return (!from || day >= from) && (!to || day <= to)
    })
  }, [from, to])
  const photoStats = useLiveQuery(async () => {
    if (!selected) return null
    const ids = selected.flatMap((v) => v.captures.map((r) => r.id))
    const photos = await db.photos.where('recordId').anyOf(ids).toArray()
    return {
      count: photos.length,
      mb: photos.reduce((n, p) => n + p.bytes, 0) / 1e6,
      fullRes: photos.filter(isFullRes).length,
    }
  }, [selected])

  const records = selected ?? []
  const noSpecies = records.filter((v) => !v.species).length
  const disagree = records.filter((v) => v.disagreement || v.reuseSuspects.length).length
  const missing = [
    !prefs.recordedBy.trim() && 'collector name',
    !prefs.institutionCode.trim() && 'institution code',
  ].filter(Boolean)

  async function run(withPhotos: boolean) {
    setError(null)
    setWarnings([])
    setBusy('Preparing…')
    try {
      const result = await buildPackage(records, prefs, {
        withPhotos,
        onProgress: (done, total) => setBusy(`Adding photos… ${done}/${total}`),
      })
      download(result.blob, result.fileName)
      setWarnings(result.warnings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/settings" className="text-sm text-slate-400 underline">
          ← Settings
        </Link>
        <h1 className="text-xl font-bold">Darwin Core export</h1>
      </header>

      <p className="text-sm text-slate-400">
        A package for a museum: Darwin Core spreadsheets plus the photos named by
        tag ID. The vial tag goes in <i>materialEntityID</i>; the museum assigns the
        catalog number.
      </p>

      <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Museum and collector</h2>
        <label className="flex flex-col gap-1">
          Collector name <span className="text-xs text-slate-500">recordedBy, photo credit</span>
          <input
            value={prefs.recordedBy}
            onChange={(e) => void setPrefs('exportPrefs', { recordedBy: e.target.value })}
            placeholder="Name as it should appear on records"
            className={field}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            Institution code
            <input
              value={prefs.institutionCode}
              onChange={(e) =>
                void setPrefs('exportPrefs', { institutionCode: e.target.value.toUpperCase() })
              }
              placeholder="e.g. AUM"
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1">
            Collection code
            <input
              value={prefs.collectionCode}
              onChange={(e) => void setPrefs('exportPrefs', { collectionCode: e.target.value })}
              placeholder="e.g. Fishes"
              className={field}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          Record type
          <select
            value={prefs.basisOfRecord}
            onChange={(e) =>
              void setPrefs('exportPrefs', { basisOfRecord: e.target.value as BasisOfRecord })
            }
            className={field}
          >
            {Object.entries(BASIS_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          Photo license
          <select
            value={prefs.license}
            onChange={(e) => void setPrefs('exportPrefs', { license: e.target.value as PhotoLicense })}
            className={field}
          >
            {Object.entries(LICENSE_LABEL).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Records</h2>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
          </label>
          <label className="flex flex-col gap-1">
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={field} />
          </label>
        </div>
        <p className="text-slate-300">
          {records.length} specimen{records.length === 1 ? '' : 's'}
          {photoStats &&
            `, ${photoStats.count} photo${photoStats.count === 1 ? '' : 's'} (~${photoStats.mb.toFixed(0)} MB on this phone)`}
        </p>
        {photoStats && photoStats.count > 0 && photoStats.fullRes < photoStats.count && (
          <p className="text-xs text-amber-300">
            {photoStats.count - photoStats.fullRes} photo(s) are reduced to 2048 px. For photo
            vouchers, turn on full-resolution photos in Settings before capturing.
          </p>
        )}
        {noSpecies > 0 && (
          <p className="text-xs text-amber-300">{noSpecies} specimen(s) have no species name.</p>
        )}
        {disagree > 0 && (
          <p className="text-xs text-amber-300">
            {disagree} specimen(s) have disagreeing identifications or a possible reused tag. Review
            them first; disagreements are noted in taxonRemarks.
          </p>
        )}
      </section>

      {missing.length > 0 && (
        <p className="text-sm text-amber-300">Add the {missing.join(' and ')} first.</p>
      )}
      <div className="flex flex-col gap-2">
        <button
          onClick={() => void run(true)}
          disabled={!!busy || missing.length > 0 || records.length === 0}
          className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-40"
        >
          Download package (.zip with photos)
        </button>
        <button
          onClick={() => void run(false)}
          disabled={!!busy || missing.length > 0 || records.length === 0}
          className="rounded-lg bg-slate-700 px-4 py-3 font-semibold disabled:opacity-40"
        >
          Spreadsheet only (.csv)
        </button>
      </div>
      {busy && <p className="text-center text-sm text-slate-400">{busy}</p>}
      {error && <p className="text-sm text-red-300">{error}</p>}
      {warnings.length > 0 && (
        <ul className="list-disc rounded-lg bg-amber-950/40 p-3 pl-6 text-xs text-amber-200">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
