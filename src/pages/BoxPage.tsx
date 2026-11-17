import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import {
  COLS,
  ROWS,
  SIZE_NAMES,
  boxContents,
  describeStorage,
  getPacking,
  isGrid,
  positionsFor,
  placeItem,
  removeFromBox,
  startPacking,
  stopPacking,
  updateBox,
} from '../boxes/store'
import CustodyPanel from '../custody/CustodyPanel'
import { cachedMemberships, canEdit } from '../custody/api'
import { db } from '../db/schema'
import { formatTagId, parseTagId } from '../lib/tagid'
import { LocationHistory, ScanBanner } from '../scans/ScanViews'
import { locationHistory } from '../scans/store'
import { describeSubsample } from '../subsamples/store'
import { boxSync, placementSync, scanSync } from '../sync/triggers'

const kick = () => {
  if (!navigator.onLine) return
  void boxSync.kick().then(() => placementSync.kick()).then(() => scanSync.kick())
}

/** A short description of an item: species, lot contents or sample type. */
async function describeItem(tagId: string): Promise<{ text: string; link: string }> {
  const inner = await db.boxes.get(tagId)
  if (inner) {
    const n = (await boxContents(tagId)).length
    return { text: `${SIZE_NAMES[inner.size]}${inner.label ? `: ${inner.label}` : ''} (${n})`, link: `/box/${tagId}` }
  }
  const sub = await db.subsamples.get(tagId)
  if (sub) return { text: describeSubsample(sub), link: `/subsample/${tagId}` }
  const spec = await db.specimens.get(tagId)
  if (spec?.kind === 'mixed_lot') {
    return { text: `Mixed lot${spec.composition?.length ? `: ${spec.composition.map((p) => p.name).join(', ')}` : ''}`, link: `/specimen/${tagId}` }
  }
  const caps = await db.records.where('tagId').equals(tagId).toArray()
  const named = caps.find((r) => r.species?.trim())
  if (caps.length) return { text: named?.species?.trim() ?? 'Specimen', link: `/specimen/${tagId}` }
  return { text: 'Not on this phone', link: `/s/${tagId}` }
}

/** /box/:tagId: a storage box, its positions, and packing it by scanning. */
export default function BoxPage() {
  const { tagId } = useParams<{ tagId: string }>()
  const [params] = useSearchParams()
  const scanId = params.get('scan')
  const { session } = useAuth()
  const userId = session?.user.id
  const orgs = useLiveQuery(() => cachedMemberships(), [], [])
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const data = useLiveQuery(async () => {
    if (!tagId) return null
    const box = await db.boxes.get(tagId)
    if (!box) return null
    const contents = await boxContents(tagId)
    const described = await Promise.all(contents.map(async (p) => ({ ...p, ...(await describeItem(p.itemTagId)) })))
    const history = locationHistory([], await db.scans.where('tagId').equals(tagId).toArray())
    return { box, contents: described, history, packing: await getPacking(), storedIn: await describeStorage(tagId) }
  }, [tagId])
  const [label, setLabel] = useState('')
  useEffect(() => setLabel(data?.box.label ?? ''), [data?.box.label])

  if (data === undefined) return null
  if (!data) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3">
        <p className="text-slate-400">Box not found on this device.</p>
        <Link to="/" className="text-emerald-400 underline">
          Home
        </Link>
      </div>
    )
  }
  const { box, contents, history, packing, storedIn } = data
  const grid = isGrid(box.size)
  const holdsContainers = !!(box.size === 'rack' || box.size === 'shelf')
  const editable = canEdit(box.custody, userId, orgs ?? [])
  const packingThis = packing?.boxTagId === box.tagId
  const at = new Map(contents.map((c) => [c.position, c]))
  const run = (fn: () => Promise<unknown>) => {
    setError(null)
    void fn()
      .then(kick)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const cell = selected ? at.get(selected) : undefined

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-slate-400 underline">
          ← Home
        </Link>
        <span className="font-mono text-lg font-bold">{formatTagId(box.tagId)}</span>
      </header>

      {scanId && <ScanBanner scanId={scanId} />}

      <section className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
        <h1 className="text-lg font-bold">
          {SIZE_NAMES[box.size]}{' '}
          <span className="text-sm font-normal text-slate-400">
            {contents.length}/{box.capacity}
          </span>
        </h1>
        <input
          value={label}
          disabled={!editable}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label.trim() !== box.label && run(() => updateBox(box.tagId, { label }))}
          placeholder="Label, e.g. Fin clips 2026, box 3"
          className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600"
        />
        {storedIn && <p className="text-slate-400">Stored in {storedIn}</p>}
      </section>

      {editable && (
        <section className={`flex flex-col gap-2 rounded-lg p-4 ${packingThis ? 'border border-emerald-600 bg-emerald-950/40' : 'bg-slate-900'}`}>
          {packingThis ? (
            <>
              <p className="font-semibold text-emerald-200">
                Packing: scan {holdsContainers ? 'box' : 'vial, tube or jar'} tags with your camera.{' '}
                {packing.target ? `The next one goes to ${packing.target}.` : 'Each goes to the next free position.'}
              </p>
              <p className="text-xs text-slate-400">Tap an empty position below to put the next scan there.</p>
              <button onClick={() => run(() => stopPacking())} className="self-start rounded bg-slate-700 px-3 py-1.5">
                Stop packing
              </button>
            </>
          ) : (
            <button onClick={() => run(() => startPacking(box.tagId))} className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold">
              Start packing (scan {holdsContainers ? 'boxes onto' : 'items into'} this)
            </button>
          )}
        </section>
      )}

      <section className="rounded-lg bg-slate-900 p-3">
        {!grid && (
          <div className="grid grid-cols-6 gap-1 text-center text-xs">
            {positionsFor(box).map((pos) => {
              const item = at.get(pos)
              const isTarget = packingThis && packing.target === pos
              return (
                <button
                  key={pos}
                  onClick={() => {
                    setSelected(pos)
                    if (!item && packingThis) run(() => startPacking(box.tagId, pos))
                  }}
                  className={`rounded px-1 py-2 ${isTarget ? 'bg-emerald-500' : item ? 'bg-sky-700' : 'bg-slate-800'} ${selected === pos ? 'ring-2 ring-white' : ''}`}
                >
                  {pos}
                </button>
              )
            })}
          </div>
        )}
        {grid && (
        <div className="grid grid-cols-[1.25rem_repeat(10,minmax(0,1fr))] gap-0.5 text-center text-[10px]">
          <span />
          {COLS.map((c) => (
            <span key={c} className="text-slate-500">
              {c}
            </span>
          ))}
          {ROWS.map((r) => (
            <div key={r} className="contents">
              <span className="self-center text-slate-500">{r}</span>
              {COLS.map((c) => {
                const pos = `${r}${c}`
                const item = at.get(pos)
                const isTarget = packingThis && packing.target === pos
                return (
                  <button
                    key={pos}
                    title={item ? `${pos}: ${formatTagId(item.itemTagId)}` : pos}
                    onClick={() => {
                      setSelected(pos)
                      if (!item && packingThis) run(() => startPacking(box.tagId, pos))
                    }}
                    className={`aspect-square rounded-sm ${
                      isTarget ? 'bg-emerald-500' : item ? (item.status === 'synced' ? 'bg-sky-600' : 'bg-sky-800') : 'bg-slate-800'
                    } ${selected === pos ? 'ring-2 ring-white' : ''}`}
                  />
                )
              })}
            </div>
          ))}
        </div>
        )}
        {selected && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="font-semibold">{selected}</p>
            {cell ? (
              <>
                <Link to={cell.link} className="text-emerald-400 underline">
                  <span className="font-mono">{formatTagId(cell.itemTagId)}</span> · {cell.text}
                </Link>
                {editable && (
                  <button onClick={() => run(() => removeFromBox(cell.itemTagId))} className="self-start text-xs underline">
                    Take out of the box
                  </button>
                )}
              </>
            ) : (
              editable && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const id = parseTagId(typed)
                    if (!id || !userId) return setError('Not a valid tag number.')
                    run(async () => {
                      await placeItem({ itemTagId: id, boxTagId: box.tagId, position: selected, placedBy: userId })
                      setTyped('')
                    })
                  }}
                >
                  <input
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="Or type a tag for this position"
                    autoCapitalize="characters"
                    className="flex-1 rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600"
                  />
                  <button className="rounded bg-slate-700 px-3 py-2">Place</button>
                </form>
              )
            )}
          </div>
        )}
      </section>
      {error && <p className="text-red-400">{error}</p>}

      <section className="rounded-lg bg-slate-900 p-4">
        <h2 className="mb-1 font-semibold">Contents ({contents.length})</h2>
        <ul>
          {contents.map((c) => (
            <li key={c.itemTagId} className="flex gap-3 border-t border-slate-800 py-1.5 first:border-0">
              <span className="w-8 font-mono text-slate-400">{c.position}</span>
              <Link to={c.link} className="font-mono text-emerald-400 underline">
                {formatTagId(c.itemTagId)}
              </Link>
              <span className="truncate text-slate-400">{c.text}</span>
            </li>
          ))}
        </ul>
      </section>

      <LocationHistory history={history} userId={userId} />

      <CustodyPanel tagId={box.tagId} custody={box.custody} userId={userId} />
      <p className="text-xs text-slate-500">
        Transferring a box moves the box itself; its contents keep their own custody. To send both, use{' '}
        <Link to={`/transfer?box=${box.tagId}`} className="underline">
          Transfer several items
        </Link>{' '}
        with this box selected.
      </p>
    </div>
  )
}
