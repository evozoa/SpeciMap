import { useCallback, useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useGeoWatch } from '../capture/useGeoWatch'
import type { Custody, Visibility } from '../db/schema'
import { syncAll } from '../sync/triggers'
import {
  cachedMemberships,
  canCurate,
  cancelTransfer,
  listOrganizations,
  partyName,
  setCatalogNumber,
  setPrivacy,
  shareTag,
  sharesFor,
  startTransfer,
  transfersFor,
  unshareTag,
  type Organization,
  type Party,
  type Purpose,
  type Share,
  type Transfer,
} from './api'

const PURPOSES: { value: Purpose; label: string }[] = [
  { value: 'accession', label: 'Accession (permanent)' },
  { value: 'loan', label: 'Loan' },
  { value: 'gift', label: 'Gift' },
  { value: 'return', label: 'Return' },
  { value: 'other', label: 'Other' },
]

const VISIBILITY: { value: Visibility; label: string; detail: string }[] = [
  { value: 'private', label: 'Private', detail: 'Only the custodian (and the collector) can see it.' },
  { value: 'shared', label: 'Shared', detail: 'Also the people and collections listed below.' },
  { value: 'public', label: 'Public', detail: 'Anyone who scans the tag sees the basics.' },
]

const STATUS: Record<Transfer['status'], string> = {
  pending: 'waiting for acceptance',
  accepted: 'accepted',
  declined: 'declined',
  cancelled: 'cancelled',
}

/** Recipient picker: one of the collections, or a person by email. */
function PartyInput({ onChange }: { onChange: (p: Party | null) => void }) {
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [mode, setMode] = useState<'org' | 'email'>('org')
  const [orgId, setOrgId] = useState('')
  const [email, setEmail] = useState('')
  useEffect(() => {
    void listOrganizations().then(setOrgs).catch(() => setOrgs([]))
  }, [])
  useEffect(() => {
    onChange(mode === 'org' ? (orgId ? { orgId } : null) : email.includes('@') ? { email } : null)
  }, [mode, orgId, email, onChange])
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-4">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'org'} onChange={() => setMode('org')} className="accent-emerald-500" /> A collection
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'email'} onChange={() => setMode('email')} className="accent-emerald-500" /> A person
        </label>
      </div>
      {mode === 'org' ? (
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="rounded bg-slate-800 px-3 py-2">
          <option value="">Choose a collection…</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({o.code})
            </option>
          ))}
        </select>
      ) : (
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Their SpeciMap sign-in email"
          className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600"
        />
      )}
    </div>
  )
}

function TransferForm({ tagId, onDone, onCancel }: { tagId: string; onDone: () => void; onCancel: () => void }) {
  const [to, setTo] = useState<Party | null>(null)
  const [purpose, setPurpose] = useState<Purpose>('accession')
  const [note, setNote] = useState('')
  const [place, setPlace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const geo = useGeoWatch(true)
  const onParty = useCallback((p: Party | null) => setTo(p), [])

  async function submit() {
    if (!to) return setError('Choose who receives it.')
    if (!place.trim() && !geo.fix) return setError('Log where it is now: wait for GPS or type a place.')
    setBusy(true)
    setError(null)
    try {
      await startTransfer({ tagId, to, purpose, note, place, fix: geo.fix })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 p-3">
      <h3 className="font-semibold">Transfer custody</h3>
      <PartyInput onChange={onParty} />
      <select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} className="rounded bg-slate-800 px-3 py-2">
        {PURPOSES.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional), e.g. shipment or loan number" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
      <div className="flex flex-col gap-1">
        <span>Where is it now?</span>
        <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="e.g. Shipped by FedEx; Lab freezer 2" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
        <span className="text-xs text-slate-500">
          {geo.fix ? `GPS ±${Math.round(geo.fix.accuracyM)} m will be logged with it.` : geo.error ? 'No GPS: type a place.' : 'Getting GPS…'}
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Custody changes only when the recipient accepts. After that they control who can see it; you will always see
        what you collected and where it is.
      </p>
      {error && <p className="text-red-400">{error}</p>}
      <div className="flex gap-3">
        <button onClick={onCancel} className="flex-1 rounded bg-slate-700 px-3 py-2">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={busy} className="flex-1 rounded bg-emerald-600 px-3 py-2 font-semibold disabled:opacity-50">
          Send transfer
        </button>
      </div>
    </div>
  )
}

/**
 * Who holds a specimen or subsample, its chain of custody, and (for the
 * custodian) privacy, sharing, catalog number and transfers. Online only.
 */
export default function CustodyPanel({ tagId, custody, userId }: { tagId: string; custody: Custody | undefined; userId: string | undefined }) {
  const orgs = useLiveQuery(() => cachedMemberships(), [], [])
  const [holder, setHolder] = useState<string | null>(null)
  const [chain, setChain] = useState<Transfer[] | null>(null)
  const [shares, setShares] = useState<Share[]>([])
  const [transferring, setTransferring] = useState(false)
  const [sharing, setSharing] = useState<Party | null>(null)
  const [catalog, setCatalog] = useState(custody?.catalogNumber ?? '')
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const onShareParty = useCallback((p: Party | null) => setSharing(p), [])

  const curator = canCurate(custody, userId, orgs ?? [])
  const load = useCallback(async () => {
    if (!navigator.onLine) return setOnline(false)
    setOnline(true)
    try {
      const [h, c, s] = await Promise.all([
        custody ? partyName(custody) : Promise.resolve('You'),
        transfersFor(tagId),
        custody?.visibility === 'shared' ? sharesFor(tagId) : Promise.resolve([]),
      ])
      setHolder(custody?.custodianUser === userId ? 'You' : h)
      setChain(c)
      setShares(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [tagId, custody, userId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => setCatalog(custody?.catalogNumber ?? ''), [custody?.catalogNumber])

  /** Run a change, then pull it back so the phone shows the server's state. */
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await syncAll()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const pending = chain?.find((t) => t.status === 'pending')
  const notUploaded = !custody

  return (
    <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="font-semibold">Custody</h2>
      {notUploaded ? (
        <p className="text-slate-400">Held by you. Custody and privacy can be changed once it has uploaded.</p>
      ) : (
        <>
          <p>
            Held by <span className="font-semibold">{holder ?? '…'}</span>
            {custody.catalogNumber && <> · catalog no. <span className="font-mono">{custody.catalogNumber}</span></>}
            {' · '}
            {VISIBILITY.find((v) => v.value === custody.visibility)?.label}
          </p>
          {!online && <p className="text-slate-500">Connect to the internet to see the chain of custody or make changes.</p>}

          {chain && chain.length > 0 && (
            <ol className="flex flex-col gap-1 border-l border-slate-700 pl-3">
              {chain.map((t) => (
                <li key={t.id}>
                  <span className="text-slate-400">{new Date(t.created_at).toLocaleDateString()}</span> {t.from_label} → {t.to_label}{' '}
                  <span className="text-slate-400">
                    ({PURPOSES.find((p) => p.value === t.purpose)?.label.split(' ')[0].toLowerCase()}, {STATUS[t.status]}
                    {t.catalog_number ? `, ${t.catalog_number}` : ''})
                  </span>
                  {t.note && <span className="block text-xs text-slate-500">{t.note}</span>}
                </li>
              ))}
            </ol>
          )}

          {pending && (curator || pending.created_by === userId) && (
            <button onClick={() => void act(() => cancelTransfer(pending.id))} className="self-start rounded bg-slate-700 px-3 py-1.5">
              Withdraw transfer to {pending.to_label}
            </button>
          )}

          {curator && online && (
            <>
              <div className="flex flex-col gap-2">
                <span className="font-medium">Who can see it</span>
                {VISIBILITY.map((v) => (
                  <label key={v.value} className="flex items-start gap-2">
                    <input
                      type="radio"
                      checked={custody.visibility === v.value}
                      onChange={() => void act(() => setPrivacy(tagId, v.value, custody.generalizePublic))}
                      className="mt-1 accent-emerald-500"
                    />
                    <span>
                      {v.label} <span className="text-xs text-slate-500">{v.detail}</span>
                    </span>
                  </label>
                ))}
                {custody.visibility === 'public' && (
                  <label className="flex items-center gap-2 pl-6 text-xs">
                    <input
                      type="checkbox"
                      checked={!custody.generalizePublic}
                      onChange={(e) => void act(() => setPrivacy(tagId, 'public', !e.target.checked))}
                      className="accent-emerald-500"
                    />
                    Show exact coordinates publicly (otherwise rounded to about 10 km)
                  </label>
                )}
              </div>

              {custody.visibility === 'shared' && (
                <div className="flex flex-col gap-2">
                  <span className="font-medium">Shared with</span>
                  {shares.map((s) => (
                    <span key={s.id} className="flex items-center justify-between rounded bg-slate-800 px-3 py-1.5">
                      {s.label}
                      <button onClick={() => void act(() => unshareTag(s.id))} className="text-xs underline">
                        Remove
                      </button>
                    </span>
                  ))}
                  <PartyInput onChange={onShareParty} />
                  <button
                    disabled={!sharing}
                    onClick={() => sharing && void act(() => shareTag(tagId, sharing))}
                    className="self-start rounded bg-slate-700 px-3 py-1.5 disabled:opacity-50"
                  >
                    Share
                  </button>
                </div>
              )}

              <label className="flex flex-col gap-1">
                <span className="font-medium">Catalog number</span>
                <input
                  value={catalog}
                  onChange={(e) => setCatalog(e.target.value)}
                  onBlur={() => catalog.trim() !== (custody.catalogNumber ?? '') && void act(() => setCatalogNumber(tagId, catalog))}
                  placeholder="Assigned by the collection, e.g. AUM 12345"
                  className="rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600"
                />
              </label>

              {!pending &&
                (transferring ? (
                  <TransferForm
                    tagId={tagId}
                    onCancel={() => setTransferring(false)}
                    onDone={() => {
                      setTransferring(false)
                      void act(async () => {})
                    }}
                  />
                ) : (
                  <button onClick={() => setTransferring(true)} className="rounded-lg bg-slate-800 px-4 py-2 font-semibold">
                    Transfer custody…
                  </button>
                ))}
            </>
          )}
        </>
      )}
      {error && <p className="text-red-400">{error}</p>}
    </section>
  )
}
