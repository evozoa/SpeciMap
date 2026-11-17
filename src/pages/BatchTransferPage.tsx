import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import { cachedMemberships, canCurate } from '../custody/api'
import { TransferForm } from '../custody/CustodyPanel'
import { db } from '../db/schema'
import { eventIdOf } from '../export/package'
import { formatTagId } from '../lib/tagid'
import { buildSpecimens } from '../specimens/view'
import { describeSubsample } from '../subsamples/store'
import { SIZE_NAMES } from '../boxes/store'

interface Item {
  tagId: string
  kind: 'specimen' | 'mixed_lot' | 'subsample' | 'container'
  label: string
  at: string
  eventId: string | null
}

interface Group {
  key: string
  title: string
  items: Item[]
}

/**
 * /transfer: choose many specimens and subsamples (e.g. a field season) and
 * transfer them together. Only items this user holds and that have uploaded
 * can be chosen; the server re-checks every one.
 */
export default function BatchTransferPage() {
  const { session } = useAuth()
  const userId = session?.user.id
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [withSubsamples, setWithSubsamples] = useState(true)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [params] = useSearchParams()

  const data = useLiveQuery(async () => {
    const orgs = await cachedMemberships()
    const specimens = buildSpecimens(await db.records.toArray(), await db.specimens.toArray())
    const subsamples = await db.subsamples.toArray()
    const events = new Map((await db.events.toArray()).map((e) => [e.id, e]))
    const items: Item[] = []
    let notUploaded = 0
    for (const v of specimens) {
      if (!v.custody) {
        if (v.captures.some((r) => r.collectorId === userId)) notUploaded++
        continue
      }
      if (!canCurate(v.custody, userId, orgs)) continue
      items.push({
        tagId: v.tagId,
        kind: v.kind,
        label: v.kind === 'mixed_lot' ? `Mixed lot: ${v.composition.map((p) => p.name).join(', ')}` : v.species || 'No species yet',
        at: v.first.capturedAt,
        eventId: eventIdOf(v) ?? null,
      })
    }
    for (const s of subsamples) {
      if (!s.custody) {
        if (s.createdBy === userId) notUploaded++
        continue
      }
      if (!canCurate(s.custody, userId, orgs)) continue
      items.push({ tagId: s.tagId, kind: 'subsample', label: `Subsample: ${describeSubsample(s)} of ${formatTagId(s.parentTagId)}`, at: s.collectedAt, eventId: s.eventId })
    }
    for (const b of await db.boxes.toArray()) {
      if (!b.custody) {
        if (b.createdBy === userId) notUploaded++
        continue
      }
      if (!canCurate(b.custody, userId, orgs)) continue
      items.push({ tagId: b.tagId, kind: 'container', label: `${SIZE_NAMES[b.size]}${b.label ? `: ${b.label}` : ''}`, at: b.updatedAt, eventId: null })
    }
    // What's inside each container, to select it along with the container.
    const inside = new Map<string, string[]>()
    for (const p of await db.placements.toArray()) {
      if (p.deleted) continue
      inside.set(p.boxTagId, [...(inside.get(p.boxTagId) ?? []), p.itemTagId])
    }
    return { items, events, notUploaded, inside }
  }, [userId])

  /** A container and everything in it (nested), that this user can send. */
  const withContents = (id: string): string[] => {
    const sendable = new Set(data?.items.map((it) => it.tagId))
    const out: string[] = []
    const walk = (t: string, depth: number) => {
      if (sendable.has(t)) out.push(t)
      if (depth < 4) for (const c of data?.inside.get(t) ?? []) walk(c, depth + 1)
    }
    walk(id, 0)
    return out
  }

  // ?box=<tag>: start with that container and its contents selected.
  const preset = params.get('box')
  useEffect(() => {
    if (preset && data) setPicked(new Set(withContents(preset)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, !!data])

  const groups = useMemo<Group[]>(() => {
    if (!data) return []
    const q = query.trim().toLowerCase()
    const shown = data.items.filter(
      (it) =>
        (withSubsamples || it.kind !== 'subsample') &&
        (!q || it.tagId.toLowerCase().includes(q.replace(/-/g, '')) || it.label.toLowerCase().includes(q)),
    )
    const byKey = new Map<string, Group>()
    for (const it of shown) {
      const e = it.eventId ? data.events.get(it.eventId) : undefined
      const day = new Date(it.at).toLocaleDateString()
      const key = it.kind === 'container' ? 'storage' : (it.eventId ?? `day:${day}`)
      const title = it.kind === 'container'
        ? 'Storage: boxes, racks and shelves (selecting one selects its contents)'
        : it.eventId
        ? `Event ${e?.fieldNumber || formatTagId(it.eventId)}${e?.locality ? `, ${e.locality}` : ''} · ${new Date(e?.eventDate ?? it.at).toLocaleDateString()}`
        : `No event · ${day}`
      if (!byKey.has(key)) byKey.set(key, { key, title, items: [] })
      byKey.get(key)!.items.push(it)
    }
    return [...byKey.values()]
      .map((g) => ({ ...g, items: g.items.sort((a, b) => a.at.localeCompare(b.at) || a.tagId.localeCompare(b.tagId)) }))
      .sort((a, b) => b.items[0].at.localeCompare(a.items[0].at))
  }, [data, query, withSubsamples])

  const toggle = (ids: string[], on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })

  // In the order shown, so sequential catalog numbers follow it.
  const ordered = groups.flatMap((g) => g.items.map((it) => it.tagId)).filter((id) => picked.has(id))

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 pb-28 text-sm">
      <header className="flex items-center justify-between">
        <Link to="/transfers" className="text-slate-400 underline">
          ← Transfers
        </Link>
        <h1 className="text-lg font-bold">Transfer several</h1>
      </header>

      {sending ? (
        <TransferForm tagIds={ordered} onCancel={() => setSending(false)} onDone={() => navigate('/transfers', { replace: true })} />
      ) : (
        <>
          <p className="text-slate-400">
            Choose what to send, e.g. a whole field season. Each item gets its own entry in the chain of custody, and
            the recipient can accept them all at once.
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tag, species or sample type"
            className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600"
          />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withSubsamples} onChange={(e) => setWithSubsamples(e.target.checked)} className="h-5 w-5 accent-emerald-500" />
            Include subsamples (they transfer separately from their specimens)
          </label>
          {data && data.notUploaded > 0 && (
            <p className="text-amber-300">
              {data.notUploaded} of your items haven't uploaded yet and can't be transferred until they do.
            </p>
          )}
          {data && groups.length === 0 && <p className="text-slate-400">Nothing you hold matches.</p>}

          {groups.map((g) => {
            const ids = g.items.map((it) => it.tagId)
            const all = ids.every((id) => picked.has(id))
            return (
              <section key={g.key} className="flex flex-col gap-1 rounded-lg bg-slate-900 p-3">
                <label className="flex items-center gap-2 font-semibold">
                  <input type="checkbox" checked={all} onChange={(e) => toggle(ids, e.target.checked)} className="h-5 w-5 accent-emerald-500" />
                  {g.title} <span className="font-normal text-slate-400">({ids.length})</span>
                </label>
                {g.items.map((it) => (
                  <label key={it.tagId} className="flex items-center gap-2 pl-7">
                    <input
                      type="checkbox"
                      checked={picked.has(it.tagId)}
                      onChange={(e) => toggle(it.kind === 'container' ? withContents(it.tagId) : [it.tagId], e.target.checked)}
                      className="h-4 w-4 accent-emerald-500"
                    />
                    <span className="font-mono">{formatTagId(it.tagId)}</span>
                    <span className={`truncate text-slate-400 ${it.kind === 'specimen' ? 'italic' : ''}`}>{it.label}</span>
                  </label>
                ))}
              </section>
            )
          })}

          <div className="fixed inset-x-0 bottom-0 bg-slate-950/95 p-4">
            <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
              <span>{ordered.length} selected</span>
              <button
                disabled={ordered.length === 0}
                onClick={() => setSending(true)}
                className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold disabled:opacity-40"
              >
                Continue
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
