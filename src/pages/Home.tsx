import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { db, type LocalRecord } from '../db/schema'
import { formatTagId } from '../lib/tagid'
import { syncEngine } from '../sync/triggers'

const STATUS_CHIP: Record<LocalRecord['status'], { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-slate-600' },
  queued: { label: 'Queued', cls: 'bg-amber-600' },
  syncing: { label: 'Syncing…', cls: 'bg-sky-600' },
  synced: { label: 'Synced', cls: 'bg-emerald-700' },
  error: { label: 'Needs attention', cls: 'bg-red-700' },
}

function Thumb({ recordId }: { recordId: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let objectUrl: string | null = null
    void db.photos
      .where('recordId')
      .equals(recordId)
      .first()
      .then((photo) => {
        if (photo) {
          objectUrl = URL.createObjectURL(photo.blob)
          setUrl(objectUrl)
        }
      })
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [recordId])
  return url ? (
    <img src={url} className="h-14 w-14 rounded object-cover" />
  ) : (
    <div className="h-14 w-14 rounded bg-slate-800" />
  )
}

export default function Home() {
  const { session } = useAuth()
  const records = useLiveQuery(
    () => db.records.orderBy('capturedAt').reverse().limit(50).toArray(),
    [],
  )
  const pending = useLiveQuery(
    () => db.records.where('status').anyOf('queued', 'error').count(),
    [],
    0,
  )
  const [syncing, setSyncing] = useState(false)

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">SpeciMap</h1>
        <nav className="flex gap-3 text-sm">
          <Link to="/tags" className="text-emerald-400 underline">
            Tag sheets
          </Link>
          <Link to="/settings" className="text-slate-400 underline">
            Settings
          </Link>
        </nav>
      </header>

      {!session && (
        <Link
          to="/auth"
          className="rounded-lg bg-emerald-600 px-4 py-3 text-center font-semibold"
        >
          Sign in to start recording
        </Link>
      )}

      <div className="rounded-lg bg-slate-900 p-4 text-sm text-slate-300">
        Scan a SpeciMap tag with your phone's camera app to record a specimen.
      </div>

      {pending > 0 && (
        <div className="flex items-center justify-between rounded-lg bg-amber-900/50 px-4 py-3">
          <span className="text-sm text-amber-200">
            {pending} record{pending > 1 ? 's' : ''} waiting to upload
          </span>
          <button
            disabled={syncing || !navigator.onLine}
            onClick={() => {
              setSyncing(true)
              void syncEngine.kick().finally(() => setSyncing(false))
            }}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent records
        </h2>
        {records?.length === 0 && (
          <p className="text-sm text-slate-500">Nothing recorded yet.</p>
        )}
        {records?.map((r) => {
          const chip = STATUS_CHIP[r.status]
          return (
            <Link
              key={r.id}
              to={`/record/${r.id}`}
              className="flex items-center gap-3 rounded-lg bg-slate-900 p-3"
            >
              <Thumb recordId={r.id} />
              <div className="min-w-0 flex-1">
                <div className="font-mono font-semibold">
                  {formatTagId(r.tagId)}
                </div>
                <div className="text-xs text-slate-400">
                  {new Date(r.capturedAt).toLocaleString()}
                </div>
              </div>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${chip.cls}`}
              >
                {chip.label}
              </span>
            </Link>
          )
        })}
      </section>
    </div>
  )
}
