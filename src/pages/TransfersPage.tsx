import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import {
  cancelBatch,
  cancelTransfer,
  groupByBatch,
  incomingTransfers,
  respondBatch,
  outgoingTransfers,
  refreshMemberships,
  respondTransfer,
  type Transfer,
} from '../custody/api'
import { formatTagId } from '../lib/tagid'
import { syncAll } from '../sync/triggers'
import { catalogSequence } from '../custody/catalog'

function Incoming({ t, onChange }: { t: Transfer; onChange: () => void }) {
  const [catalog, setCatalog] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const respond = async (accept: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await respondTransfer(t.id, accept, catalog)
      await syncAll() // pull what is now ours
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
      <p>
        <span className="font-mono font-bold">{formatTagId(t.tag_id)}</span> from {t.from_label} to {t.to_label}
        <span className="block text-xs text-slate-400">
          {t.purpose} · sent {new Date(t.created_at).toLocaleString()}
          {t.note && ` · ${t.note}`}
        </span>
      </p>
      <input
        value={catalog}
        onChange={(e) => setCatalog(e.target.value)}
        placeholder="Catalog number (optional), e.g. AUM 12345"
        className="rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600"
      />
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button disabled={busy} onClick={() => void respond(false)} className="flex-1 rounded bg-slate-700 px-3 py-2 disabled:opacity-50">
          Decline
        </button>
        <button disabled={busy} onClick={() => void respond(true)} className="flex-1 rounded bg-emerald-600 px-3 py-2 font-semibold disabled:opacity-50">
          Accept custody
        </button>
      </div>
    </li>
  )
}

/** A batch sent together: accept or decline all, with optional catalog numbers. */
function IncomingBatch({ ts, onChange }: { ts: Transfer[]; onChange: () => void }) {
  const [numbers, setNumbers] = useState<Record<string, string>>({})
  const [start, setStart] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = ts[0]
  const respond = async (accept: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await respondBatch(first.batch_id!, accept, numbers)
      await syncAll()
      onChange()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  const fill = () => {
    const seq = catalogSequence(start, ts.length)
    setNumbers(Object.fromEntries(ts.map((t, i) => [t.tag_id, seq[i]])))
    setOpen(true)
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
      <p>
        <span className="font-semibold">{ts.length} items</span> from {first.from_label} to {first.to_label}
        <span className="block text-xs text-slate-400">
          {first.purpose} · sent {new Date(first.created_at).toLocaleString()}
          {first.note && ` · ${first.note}`}
        </span>
      </p>
      <div className="flex gap-2">
        <input
          value={start}
          onChange={(e) => setStart(e.target.value)}
          placeholder="First catalog number, e.g. AUM 12345"
          className="flex-1 rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600"
        />
        <button disabled={!start.trim()} onClick={fill} className="rounded bg-slate-700 px-3 py-2 disabled:opacity-50">
          Number all
        </button>
      </div>
      <button onClick={() => setOpen(!open)} className="self-start text-xs underline">
        {open ? 'Hide items' : 'Show items and catalog numbers'}
      </button>
      {open && (
        <ul className="flex flex-col gap-1">
          {ts.map((t) => (
            <li key={t.id} className="flex items-center gap-2">
              <span className="w-32 font-mono">{formatTagId(t.tag_id)}</span>
              <input
                value={numbers[t.tag_id] ?? ''}
                onChange={(e) => setNumbers({ ...numbers, [t.tag_id]: e.target.value })}
                placeholder="Catalog no."
                className="flex-1 rounded bg-slate-800 px-2 py-1 font-mono placeholder:font-sans placeholder:text-slate-600"
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button disabled={busy} onClick={() => void respond(false)} className="flex-1 rounded bg-slate-700 px-3 py-2 disabled:opacity-50">
          Decline all
        </button>
        <button disabled={busy} onClick={() => void respond(true)} className="flex-1 rounded bg-emerald-600 px-3 py-2 font-semibold disabled:opacity-50">
          Accept all {ts.length}
        </button>
      </div>
    </li>
  )
}

/** /transfers: transfers waiting for you to accept, and ones you sent. */
export default function TransfersPage() {
  const { session } = useAuth()
  const userId = session?.user.id
  const [incoming, setIncoming] = useState<Transfer[] | null>(null)
  const [outgoing, setOutgoing] = useState<Transfer[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const orgs = await refreshMemberships(userId)
      const [i, o] = await Promise.all([incomingTransfers(userId, orgs), outgoingTransfers(userId)])
      setIncoming(i)
      setOutgoing(o)
    } catch (err) {
      setError(navigator.onLine ? (err instanceof Error ? err.message : String(err)) : 'Connect to the internet to see transfers.')
    }
  }, [userId])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-lg font-bold">Transfers</h1>
      </header>
      {!session && <p className="text-slate-400">Sign in to see transfers.</p>}
      {error && <p className="text-red-400">{error}</p>}

      {session && (
        <Link to="/transfer" className="rounded-lg bg-slate-800 px-4 py-3 text-center font-semibold">
          Transfer several items…
        </Link>
      )}

      <h2 className="font-semibold">Waiting for you</h2>
      {incoming?.length === 0 && <p className="text-slate-400">Nothing to accept.</p>}
      <ul className="flex flex-col gap-3">
        {incoming &&
          groupByBatch(incoming).map((ts) =>
            ts.length > 1 && ts[0].batch_id ? (
              <IncomingBatch key={ts[0].batch_id} ts={ts} onChange={() => void load()} />
            ) : (
              <Incoming key={ts[0].id} t={ts[0]} onChange={() => void load()} />
            ),
          )}
      </ul>

      <h2 className="font-semibold">Sent by you</h2>
      {outgoing.length === 0 && <p className="text-slate-400">None yet. Start one from a specimen or subsample page.</p>}
      <ul className="flex flex-col gap-2">
        {groupByBatch(outgoing).map((ts) => {
          const t = ts[0]
          const waiting = ts.filter((x) => x.status === 'pending').length
          const statuses = [...new Set(ts.map((x) => x.status))].join(', ')
          return (
            <li key={t.batch_id ?? t.id} className="flex items-center justify-between gap-2 rounded bg-slate-900 px-3 py-2">
              <span>
                {ts.length > 1 ? (
                  <span className="font-semibold">{ts.length} items</span>
                ) : (
                  <span className="font-mono">{formatTagId(t.tag_id)}</span>
                )}{' '}
                → {t.to_label}
                <span className="block text-xs text-slate-400">
                  {statuses} · {new Date(t.created_at).toLocaleDateString()}
                </span>
              </span>
              {waiting > 0 && (
                <button
                  onClick={() =>
                    void (ts.length > 1 && t.batch_id ? cancelBatch(t.batch_id) : cancelTransfer(t.id))
                      .then(load)
                      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  }
                  className="text-xs underline"
                >
                  Withdraw{ts.length > 1 ? ' all' : ''}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
