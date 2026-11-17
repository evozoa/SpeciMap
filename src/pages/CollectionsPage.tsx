import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import {
  addMember,
  createOrganization,
  listInvites,
  listMembers,
  refreshMemberships,
  removeInvite,
  removeMember,
  setMemberRole,
  type Member,
  type Membership,
  type Role,
} from '../custody/api'

const ROLES: { value: Role; label: string }[] = [
  { value: 'curator', label: 'Curator: accepts transfers, sets privacy, manages members' },
  { value: 'staff', label: 'Staff: edits records, logs locations' },
  { value: 'viewer', label: 'Viewer: read only' },
]

function Members({ org, me }: { org: Membership; me: string }) {
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<{ email: string; role: Role }[]>([])
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [note, setNote] = useState<string | null>(null)
  const curator = org.role === 'curator'

  const load = useCallback(async () => {
    setMembers(await listMembers(org.id))
    if (curator) setInvites(await listInvites(org.id))
  }, [org.id, curator])
  useEffect(() => {
    void load().catch((err) => setNote(String(err)))
  }, [load])

  const run = (fn: () => Promise<unknown>) =>
    void fn()
      .then(load)
      .catch((err) => setNote(err instanceof Error ? err.message : String(err)))

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {members.map((m) => (
          <li key={m.user_id} className="flex items-center justify-between gap-2 rounded bg-slate-800 px-3 py-1.5">
            <span>{m.user_id === me ? 'You' : m.name}</span>
            {curator && m.user_id !== me ? (
              <span className="flex items-center gap-2">
                <select value={m.role} onChange={(e) => run(() => setMemberRole(org.id, m.user_id, e.target.value as Role))} className="rounded bg-slate-900 px-2 py-1 text-xs">
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.value}
                    </option>
                  ))}
                </select>
                <button onClick={() => run(() => removeMember(org.id, m.user_id))} className="text-xs underline">
                  Remove
                </button>
              </span>
            ) : (
              <span className="text-xs text-slate-400">{m.role}</span>
            )}
          </li>
        ))}
        {invites.map((i) => (
          <li key={i.email} className="flex items-center justify-between rounded bg-slate-800/60 px-3 py-1.5 text-slate-400">
            <span>
              {i.email} <span className="text-xs">(invited, {i.role})</span>
            </span>
            <button onClick={() => run(() => removeInvite(org.id, i.email))} className="text-xs underline">
              Cancel
            </button>
          </li>
        ))}
      </ul>
      {curator && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            run(async () => {
              const r = await addMember(org.id, email, role)
              setNote(r === 'invited' ? `${email} has no account yet: they'll join when they first sign in.` : null)
              setEmail('')
            })
          }}
        >
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Add a member by email" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded bg-slate-800 px-3 py-2">
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <button disabled={!email.includes('@')} className="self-start rounded bg-slate-700 px-3 py-1.5 disabled:opacity-50">
            Add member
          </button>
        </form>
      )}
      {note && <p className="text-xs text-slate-400">{note}</p>}
    </div>
  )
}

/** /collections: museum or lab collections that can hold specimens. */
export default function CollectionsPage() {
  const { session } = useAuth()
  const userId = session?.user.id
  const [orgs, setOrgs] = useState<Membership[] | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) return
    try {
      setOrgs(await refreshMemberships(userId))
    } catch (err) {
      setError(navigator.onLine ? String(err) : 'Connect to the internet to manage collections.')
    }
  }, [userId])
  useEffect(() => {
    void load()
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await createOrganization(name, code)
      setName('')
      setCode('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-lg font-bold">Collections</h1>
      </header>
      <p className="text-slate-400">
        A collection (a museum's fish or tissue collection, or a lab) can hold specimens and subsamples. Its curators
        accept transfers and decide who can see what it holds.
      </p>
      {error && <p className="text-red-400">{error}</p>}
      {orgs?.length === 0 && <p className="text-slate-400">You aren't in any collection yet.</p>}
      {orgs?.map((o) => (
        <section key={o.id} className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
          <h2 className="font-semibold">
            {o.name} <span className="font-mono text-slate-400">({o.code})</span>{' '}
            <span className="text-xs font-normal text-slate-400">you: {o.role}</span>
          </h2>
          {userId && <Members org={o} me={userId} />}
        </section>
      ))}
      <form onSubmit={(e) => void create(e)} className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
        <h2 className="font-semibold">New collection</h2>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Auburn University Fish Collection" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code, e.g. AUM" className="rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600" />
        <button disabled={!name.trim() || code.trim().length < 2} className="self-start rounded bg-emerald-600 px-3 py-1.5 font-semibold disabled:opacity-50">
          Create (you become its curator)
        </button>
      </form>
    </div>
  )
}
