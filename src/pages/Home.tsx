import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { db, type LocalRecord } from '../db/schema'
import { needsNameCheck } from '../db/drafts'
import { buildSpecimens } from '../specimens/view'
import { usePhotoUrl } from '../lib/photoUrl'
import { formatTagId } from '../lib/tagid'
import { syncAll } from '../sync/triggers'

const STATUS_CHIP: Record<LocalRecord['status'], { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-slate-600' },
  queued: { label: 'Queued', cls: 'bg-amber-600' },
  syncing: { label: 'Syncing…', cls: 'bg-sky-600' },
  synced: { label: 'Synced', cls: 'bg-emerald-700' },
  error: { label: 'Needs attention', cls: 'bg-red-700' },
}

function Thumb({ recordId }: { recordId: string }) {
  const photo = useLiveQuery(
    () => db.photos.where('recordId').equals(recordId).first(),
    [recordId],
  )
  const url = usePhotoUrl(photo)
  return url ? (
    <img src={url} className="h-14 w-14 rounded object-cover" />
  ) : (
    <div className="h-14 w-14 rounded bg-slate-800" />
  )
}

export default function Home() {
  const { session } = useAuth()
  const specimens = useLiveQuery(async () => {
    const records = await db.records.toArray()
    return buildSpecimens(records, await db.specimens.toArray()).slice(0, 50)
  }, [])
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
          <Link to="/export" className="text-emerald-400 underline">
            Export
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
              void syncAll().finally(() => setSyncing(false))
            }}
            className="rounded bg-amber-600 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent specimens
        </h2>
        {specimens?.length === 0 && (
          <p className="text-sm text-slate-500">Nothing recorded yet.</p>
        )}
        {specimens?.map((v) => {
          const chip = STATUS_CHIP[v.status]
          const r = v.identification ?? v.first
          const shared = v.captures.some((c) => c.inat?.status === 'shared')
          return (
            <Link
              key={v.tagId}
              to={`/specimen/${v.tagId}`}
              className="flex items-center gap-3 rounded-lg bg-slate-900 p-3"
            >
              <Thumb recordId={v.first.id} />
              <div className="min-w-0 flex-1">
                <div className="font-mono font-semibold">
                  {formatTagId(r.tagId)}
                </div>
                {v.species ? (
                  <div className="truncate text-sm italic text-slate-200">
                    {v.species}
                    {v.individualCount > 1 && (
                      <span className="not-italic text-slate-400"> × {v.individualCount}</span>
                    )}
                  </div>
                ) : (
                  <div className="text-sm text-slate-600">No species yet</div>
                )}
                <div className="text-xs text-slate-400">
                  {new Date(v.first.capturedAt).toLocaleString()}
                  {v.captures.length > 1 && ` · ${v.captures.length} captures`}
                </div>
              </div>
              {v.reuseSuspects.length > 0 && (
                <span className="rounded-full bg-red-800 px-2 py-1 text-xs" title="Possible tag reuse">
                  Check tag
                </span>
              )}
              {v.disagreement && (
                <span className="rounded-full bg-amber-800 px-2 py-1 text-xs" title="Identifications disagree">
                  IDs differ
                </span>
              )}
              {needsNameCheck(r) && (
                <span className="rounded-full bg-amber-800 px-2 py-1 text-xs" title="Confirm the species name">
                  Check name
                </span>
              )}
              {shared && (
                <span className="rounded-full bg-slate-700 px-2 py-1 text-xs" title="Shared to iNaturalist">
                  iNat
                </span>
              )}
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
