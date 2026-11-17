import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import CapturePage from '../capture/CapturePage'
import { db } from '../db/schema'
import { getActiveEvent } from '../events/store'
import { formatTagId, parseTagId } from '../lib/tagid'
import { PRESERVATIONS, SAMPLE_TYPES, createSubsample } from '../subsamples/store'
import { fetchTagFormat } from '../sync/supabaseTransport'
import { subsampleSync } from '../sync/triggers'
import {
  cacheFormats,
  cachedFormat,
  recentSpecimen,
  suggestRank,
  tagRole,
  type Suggestion,
  type TagRank,
} from '../tags/rank'

/**
 * /s/:tagId, the URL in every tag's QR code. A tag already in use opens what
 * it is; an unused tag asks what it marks (event, specimen or subsample).
 */
export default function TagScan() {
  const { tagId: raw } = useParams<{ tagId: string }>()
  return <TagScanFor key={raw ?? ''} />
}

function TagScanFor() {
  const { tagId: raw } = useParams<{ tagId: string }>()
  const tagId = parseTagId(raw ?? '')
  const { session, loading } = useAuth()
  const [chosen, setChosen] = useState<{ rank: TagRank; parentTagId: string | null } | null>(null)
  const role = useLiveQuery(async () => (tagId ? ((await tagRole(tagId)) ?? 'unused') : null), [tagId])

  // Invalid tags and sign-in are handled by the capture page.
  if (!tagId || loading || !session) return <CapturePage />
  if (role === undefined) return <Centered>Opening tag…</Centered>
  if (role === 'event') return <Navigate to={`/event/${tagId}`} replace />
  if (role === 'subsample') return <Navigate to={`/subsample/${tagId}`} replace />
  if (role === 'specimen' || chosen?.rank === 'specimen') return <CapturePage />
  if (chosen?.rank === 'event') return <Navigate to={`/e/${tagId}`} replace />
  if (chosen?.rank === 'subsample') {
    return <NewSubsample tagId={tagId} userId={session.user.id} parentTagId={chosen.parentTagId} onBack={() => setChosen(null)} />
  }
  return <RankChooser tagId={tagId} onChoose={(rank, parentTagId) => setChosen({ rank, parentTagId })} />
}

const RANKS: { rank: TagRank; title: string; detail: string }[] = [
  { rank: 'specimen', title: 'Specimen', detail: 'A fish or lot in a vial or jar. Next: photograph it.' },
  { rank: 'subsample', title: 'Subsample', detail: 'Tissue taken from a specimen, e.g. a fin clip in a 2 mL tube.' },
  { rank: 'event', title: 'Collecting event', detail: 'A field sheet: the site, date, method and collectors.' },
]

function RankChooser({ tagId, onChoose }: { tagId: string; onChoose: (rank: TagRank, parentTagId: string | null) => void }) {
  const [hint, setHint] = useState<{ suggestion: Suggestion; format: string | null } | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      let format = await cachedFormat(tagId)
      const recent = await recentSpecimen()
      if (live) setHint({ suggestion: suggestRank(format, recent, tagId), format })
      if (format || !navigator.onLine) return
      const found = await fetchTagFormat(tagId)
      if (!found?.format) return
      format = found.format
      await cacheFormats([{ id: tagId, batchId: found.batchId, seq: found.seq, format }])
      if (live) setHint({ suggestion: suggestRank(format, recent, tagId), format })
    })()
    return () => {
      live = false
    }
  }, [tagId])

  const suggested = hint?.suggestion.rank ?? null
  const parent = hint?.suggestion.parentTagId ?? null
  const why =
    suggested && hint?.format
      ? `printed as ${FORMAT_NAMES[hint.format] ?? hint.format}`
      : suggested === 'subsample' && parent
        ? `you just recorded ${formatTagId(parent)}`
        : null
  const ordered = suggested ? [...RANKS].sort((a, b) => Number(b.rank === suggested) - Number(a.rank === suggested)) : RANKS

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <span className="font-mono text-lg font-bold">{formatTagId(tagId)}</span>
      </header>
      <div>
        <h1 className="text-xl font-bold">New tag: what does it mark?</h1>
        <p className="mt-1 text-sm text-slate-400">
          Any SpeciMap tag can be used for any of these. The choice is fixed once you save.
        </p>
      </div>
      {ordered.map(({ rank, title, detail }) => {
        const isSuggested = rank === suggested
        return (
          <button
            key={rank}
            onClick={() => onChoose(rank, rank === 'subsample' ? parent : null)}
            className={`flex flex-col gap-1 rounded-lg border p-4 text-left ${
              isSuggested ? 'border-emerald-500 bg-emerald-950/40' : 'border-slate-700 bg-slate-900'
            }`}
          >
            <span className="flex items-center justify-between">
              <span className="text-lg font-semibold">{title}</span>
              {isSuggested && <span className="rounded bg-emerald-700 px-2 py-0.5 text-xs font-semibold">Suggested</span>}
            </span>
            <span className="text-sm text-slate-400">{detail}</span>
            {isSuggested && why && <span className="text-xs text-emerald-300">Because this tag was {why}.</span>}
          </button>
        )
      })}
    </div>
  )
}

const FORMAT_NAMES: Record<string, string> = {
  insert: 'a vial insert tag',
  punch: 'a vial cap tag',
  both: 'a vial tag',
  insert_2ml: 'a 2 mL tube tag',
  fieldsheet: 'a field sheet',
}

const LAST_KEY = 'lastSubsample'

/** Recent specimens on this phone, newest first, for picking a parent. */
async function recentSpecimens(limit = 12): Promise<{ tagId: string; species: string; at: string }[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const records = await db.records.where('capturedAt').above(since).reverse().sortBy('capturedAt')
  const subsampleTags = new Set(await db.subsamples.toCollection().primaryKeys())
  const seen = new Map<string, { tagId: string; species: string; at: string }>()
  for (const r of records) {
    if (r.status === 'draft' || subsampleTags.has(r.tagId) || seen.has(r.tagId)) continue
    seen.set(r.tagId, { tagId: r.tagId, species: r.species?.trim() ?? '', at: r.capturedAt })
    if (seen.size >= limit) break
  }
  return [...seen.values()]
}

function NewSubsample({
  tagId,
  userId,
  parentTagId,
  onBack,
}: {
  tagId: string
  userId: string
  parentTagId: string | null
  onBack: () => void
}) {
  const navigate = useNavigate()
  const recent = useLiveQuery(() => recentSpecimens(), [], [])
  const [parent, setParent] = useState<string | null>(parentTagId)
  const [typed, setTyped] = useState('')
  const [sampleType, setSampleType] = useState('')
  const [preservation, setPreservation] = useState('')
  const [remarks, setRemarks] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Default to the type and preservation used last time.
  useEffect(() => {
    void db.meta.get(LAST_KEY).then((row) => {
      const last = row?.value as { sampleType?: string; preservation?: string } | undefined
      if (last?.sampleType) setSampleType((v) => v || last.sampleType!)
      if (last?.preservation) setPreservation((v) => v || last.preservation!)
    })
  }, [])

  const typedParent = typed.trim() ? parseTagId(typed) : null
  const chosenParent = typed.trim() ? typedParent : parent

  async function save() {
    if (!chosenParent) {
      setError(typed.trim() ? 'That is not a valid tag number.' : 'Choose the specimen this came from.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const event = await getActiveEvent()
      await createSubsample({
        tagId,
        parentTagId: chosenParent,
        createdBy: userId,
        eventId: event?.id ?? null,
        sampleType,
        preservation,
        remarks,
      })
      await db.meta.put({ key: LAST_KEY, value: { sampleType: sampleType.trim(), preservation: preservation.trim() } })
      if (navigator.onLine) void subsampleSync.kick()
      navigate(`/subsample/${tagId}?saved=1`, { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const list = recent ?? []
  const extra = parent && !list.some((r) => r.tagId === parent) ? [{ tagId: parent, species: '', at: '' }] : []

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <button onClick={onBack} className="text-slate-400 underline">
          ← Back
        </button>
        <span className="font-mono text-lg font-bold">{formatTagId(tagId)}</span>
      </header>
      <h1 className="text-xl font-bold">New subsample</h1>

      <section className="flex flex-col gap-2 rounded-lg bg-slate-900 p-4">
        <h2 className="font-semibold">Taken from specimen</h2>
        {[...extra, ...list].map((r) => (
          <label key={r.tagId} className="flex items-center gap-3 rounded bg-slate-800 px-3 py-2">
            <input
              type="radio"
              name="parent"
              checked={!typed.trim() && parent === r.tagId}
              onChange={() => {
                setParent(r.tagId)
                setTyped('')
              }}
              className="h-5 w-5 accent-emerald-500"
            />
            <span className="font-mono">{formatTagId(r.tagId)}</span>
            <span className="truncate text-slate-400">{r.species ? <i>{r.species}</i> : ''}</span>
          </label>
        ))}
        {list.length === 0 && !extra.length && (
          <p className="text-slate-400">No specimens recorded on this phone in the last week.</p>
        )}
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Or type the specimen's tag, e.g. 7Q4M-K2XR-C"
          autoCapitalize="characters"
          className="rounded bg-slate-800 px-3 py-2 font-mono placeholder:font-sans placeholder:text-slate-600"
        />
      </section>

      <section className="flex flex-col gap-3 rounded-lg bg-slate-900 p-4">
        <label className="flex flex-col gap-1">
          <span>
            Sample type <span className="text-xs text-slate-500">(materialSampleType)</span>
          </span>
          <input list="sample-types" value={sampleType} onChange={(e) => setSampleType(e.target.value)} placeholder="Fin clip" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
          <datalist id="sample-types">
            {SAMPLE_TYPES.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span>
            Preservation <span className="text-xs text-slate-500">(preparations)</span>
          </span>
          <input list="preservations" value={preservation} onChange={(e) => setPreservation(e.target.value)} placeholder="95% ethanol" className="rounded bg-slate-800 px-3 py-2 placeholder:text-slate-600" />
          <datalist id="preservations">
            {PRESERVATIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          <span>Remarks</span>
          <input value={remarks} onChange={(e) => setRemarks(e.target.value)} className="rounded bg-slate-800 px-3 py-2" />
        </label>
      </section>

      {error && <p className="text-red-400">{error}</p>}
      <button onClick={() => void save()} disabled={busy} className="rounded-lg bg-emerald-600 px-4 py-3 text-base font-semibold disabled:opacity-50">
        Save subsample
      </button>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full items-center justify-center p-6 text-slate-400">{children}</div>
}
