import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { useGeoWatch } from '../capture/useGeoWatch'
import { db } from '../db/schema'
import { scanSync } from '../sync/triggers'
import { FIX_WINDOW_MS, GOOD_ENOUGH_M, lastKnown, logScan, offerFix, removeScan, setScanPlace, type HistoryEntry } from './store'

const kick = () => {
  if (navigator.onLine) void scanSync.kick()
}

/**
 * A rescan of a collected specimen or subsample: log a location check right
 * away, then open its page, where ScanBanner fills in the GPS fix.
 */
export function LocationCheck({ tagId, to }: { tagId: string; to: string }) {
  const { session } = useAuth()
  const navigate = useNavigate()
  const [id] = useState(() => crypto.randomUUID())
  useEffect(() => {
    if (!session) return
    void logScan({ id, tagId, scannedBy: session.user.id }).then(() => {
      kick()
      navigate(`${to}?scan=${id}`, { replace: true })
    })
  }, [id, tagId, to, session, navigate])
  return <div className="flex min-h-full items-center justify-center p-6 text-slate-400">Logging location…</div>
}

/** Shown on a specimen or subsample page right after a location check. */
export function ScanBanner({ scanId, onDifferentFish }: { scanId: string; onDifferentFish?: () => void }) {
  const scan = useLiveQuery(() => db.scans.get(scanId), [scanId])
  const [place, setPlace] = useState('')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => setPlace(scan?.place ?? ''), [scan?.place])

  const fresh = !!scan && now - Date.parse(scan.scannedAt) < FIX_WINDOW_MS
  const settled = scan?.gpsAccuracyM != null && scan.gpsAccuracyM <= GOOD_ENOUGH_M
  const geo = useGeoWatch(fresh && !settled && !scan?.deleted)
  useEffect(() => {
    if (geo.fix) void offerFix(scanId, geo.fix).then((changed) => changed && kick())
  }, [geo.fix, scanId])

  if (!scan || scan.deleted) return null
  const where =
    scan.lat != null
      ? `GPS ±${scan.gpsAccuracyM} m`
      : fresh && !geo.error
        ? 'getting GPS…'
        : 'no GPS fix: type where it is'

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-sky-800 bg-sky-950/50 p-3 text-sm text-sky-100">
      <p>
        <span className="font-semibold">Location check logged</span> {new Date(scan.scannedAt).toLocaleTimeString()} · {where}
      </p>
      <input
        value={place}
        onChange={(e) => setPlace(e.target.value)}
        onBlur={() => void setScanPlace(scanId, place).then(kick)}
        placeholder="Where is it? e.g. Range 4, shelf B (optional)"
        className="rounded bg-slate-900 px-3 py-2 placeholder:text-slate-500"
      />
      <div className="flex flex-wrap gap-3 text-xs">
        <button onClick={() => void removeScan(scanId).then(kick)} className="underline">
          Remove this check
        </button>
        {onDifferentFish && (
          <button
            onClick={() => void removeScan(scanId).then(kick).then(onDifferentFish)}
            className="underline"
          >
            This tag is on a different fish
          </button>
        )}
      </div>
    </div>
  )
}

const LABEL: Record<HistoryEntry['kind'], string> = {
  collected: 'Collected',
  capture: 'Photographed',
  scan: 'Location check',
}

function coords(e: HistoryEntry) {
  if (e.lat == null || e.lng == null) return null
  const text = `${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}${e.accuracyM != null ? ` ±${Math.round(e.accuracyM)} m` : ''}`
  return (
    <a
      href={`https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lng}#map=17/${e.lat}/${e.lng}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-xs text-emerald-400 underline"
    >
      {text}
    </a>
  )
}

/** Where a tag has been: collection, later captures and location checks. */
export function LocationHistory({ history, userId }: { history: HistoryEntry[]; userId: string | undefined }) {
  const last = lastKnown(history)
  const checks = history.filter((e) => e.kind === 'scan').length
  return (
    <section className="rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="mb-1 font-semibold">
        Location history <span className="text-xs font-normal text-slate-500">({checks} check{checks === 1 ? '' : 's'})</span>
      </h2>
      {last && history.length > 1 && (
        <p className="mb-2 text-slate-300">
          Last known: {last.place || 'GPS position'}, {new Date(last.at).toLocaleDateString()}
        </p>
      )}
      <ul>
        {[...history].reverse().map((e) => (
          <li key={e.id} className="flex flex-col border-t border-slate-800 py-2 first:border-0">
            <span>
              <span className="font-medium">{LABEL[e.kind]}</span>{' '}
              <span className="text-slate-400">
                {new Date(e.at).toLocaleString()}
                {e.by !== userId && ' · another collector'}
              </span>
            </span>
            {e.place && <span>{e.place}</span>}
            {coords(e)}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-slate-500">Each later scan of this tag logs where it was seen.</p>
    </section>
  )
}
