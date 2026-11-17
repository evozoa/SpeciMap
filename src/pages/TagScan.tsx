import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../auth/AuthProvider'
import CapturePage from '../capture/CapturePage'
import { db } from '../db/schema'
import { getActiveEvent } from '../events/store'
import { LocationCheck } from '../scans/ScanViews'
import { REUSE_HOURS } from '../specimens/view'
import { setKind } from '../specimens/store'
import { cachedMemberships, canEdit, publicTagInfo, tagUnclaimed, type PublicInfo } from '../custody/api'
import { syncAll } from '../sync/triggers'
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
 * /s/:tagId, the URL in every tag's QR code. An unused tag asks what it
 * marks (event, specimen or subsample). A tag already in use opens what it
 * is; scanning a specimen or subsample after it was collected also logs a
 * location check, so its last known location can be traced.
 *
 * A specimen this collector captured within the last REUSE_HOURS is still
 * being worked up in the field: rescanning it opens the camera to add photos.
 * `?photos=1` opens the camera for an older specimen too.
 */
export default function TagScan() {
  const { tagId: raw } = useParams<{ tagId: string }>()
  return <TagScanFor key={raw ?? ''} />
}

function TagScanFor() {
  const { tagId: raw } = useParams<{ tagId: string }>()
  const tagId = parseTagId(raw ?? '')
  const { session, loading } = useAuth()
  const [params] = useSearchParams()
  const userId = session?.user.id
  const [chosen, setChosen] = useState<{ rank: TagRank | 'mixed_lot'; parentTagId: string | null } | null>(null)
  const role = useLiveQuery(async () => (tagId ? ((await tagRole(tagId)) ?? 'unused') : null), [tagId])
  const mayLog = useLiveQuery(() => (tagId ? mayLogCheck(tagId, userId) : false), [tagId, userId])
  // Only ever turns true during a visit (a new capture is recent), so saving
  // a capture never turns the camera page into a location check.
  const fieldSession = useLiveQuery(() => recentOwnCapture(tagId, userId), [tagId, userId])

  // Signed out: a public tag shows its public summary; otherwise sign in.
  if (tagId && !loading && !session) return <PublicOrSignIn tagId={tagId} />
  // Invalid tags are handled by the capture page.
  if (!tagId || loading || !session) return <CapturePage />
  if (role === undefined) return <Centered>Opening tag…</Centered>
  if (role === 'event') return <Navigate to={`/event/${tagId}`} replace />
  if (mayLog === undefined) return <Centered>Opening tag…</Centered>
  // Only the custodian side or the collector logs location checks; anyone
  // else who can see the record just opens it.
  if (role === 'subsample') {
    return mayLog ? <LocationCheck tagId={tagId} to={`/subsample/${tagId}`} /> : <Navigate to={`/subsample/${tagId}`} replace />
  }
  if (role === 'specimen' && !chosen) {
    if (fieldSession === undefined) return <Centered>Opening tag…</Centered>
    if (fieldSession || params.get('photos')) return <CapturePage />
    return mayLog ? <LocationCheck tagId={tagId} to={`/specimen/${tagId}`} /> : <Navigate to={`/specimen/${tagId}`} replace />
  }
  if (chosen?.rank === 'specimen' || chosen?.rank === 'mixed_lot') return <CapturePage />
  if (chosen?.rank === 'event') return <Navigate to={`/e/${tagId}`} replace />
  if (chosen?.rank === 'subsample') {
    return <NewSubsample tagId={tagId} userId={session.user.id} parentTagId={chosen.parentTagId} onBack={() => setChosen(null)} />
  }
  return (
    <RankChooser
      tagId={tagId}
      onChoose={(rank, parentTagId) => {
        if (rank === 'mixed_lot') void setKind(tagId, 'mixed_lot').then(() => setChosen({ rank, parentTagId }))
        else setChosen({ rank, parentTagId })
      }}
    />
  )
}

/** May this user log a location check for the tag (custodian side or collector)? */
async function mayLogCheck(tagId: string, userId: string | undefined): Promise<boolean> {
  const orgs = await cachedMemberships()
  const sub = await db.subsamples.get(tagId)
  if (sub) return sub.createdBy === userId || canEdit(sub.custody, userId, orgs)
  const captures = await db.records.where('tagId').equals(tagId).toArray()
  if (captures.some((r) => r.collectorId === userId)) return true
  return canEdit((await db.specimens.get(tagId))?.custody, userId, orgs)
}

/** Signed out: the public summary of a public tag, else a sign-in prompt. */
function PublicOrSignIn({ tagId }: { tagId: string }) {
  const [info, setInfo] = useState<PublicInfo | null | undefined>(undefined)
  useEffect(() => {
    if (!navigator.onLine) return setInfo(null)
    void publicTagInfo(tagId).then(setInfo, () => setInfo(null))
  }, [tagId])
  if (info === undefined) return <Centered>Opening tag…</Centered>
  if (!info) return <CapturePage />
  const where = [info.waterBody, info.county && `${info.county} Co.`, info.stateProvince, info.countryCode].filter(Boolean).join(', ')
  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4 text-sm">
      <header className="flex items-center justify-between">
        <span className="font-bold">SpeciMap</span>
        <span className="font-mono text-lg font-bold">{formatTagId(tagId)}</span>
      </header>
      <section className="flex flex-col gap-1 rounded-lg bg-slate-900 p-4">
        <h1 className="text-lg font-bold">
          {info.rank === 'subsample' ? 'Subsample' : info.rank === 'mixed_lot' ? 'Mixed lot' : 'Specimen'}
        </h1>
        {info.species && <p className="text-base italic">{info.species}{(info.individualCount ?? 1) > 1 && <span className="not-italic text-slate-400"> × {info.individualCount}</span>}</p>}
        {info.composition && info.composition.length > 0 && (
          <ul>
            {info.composition.map((p, i) => (
              <li key={i}>
                <i>{p.name}</i> × {p.count}
              </li>
            ))}
          </ul>
        )}
        {info.sampleType && <p>{[info.sampleType, info.preservation].filter(Boolean).join(', ')}</p>}
        <p>
          Held by {info.custodian}
          {info.catalogNumber && <>, catalog no. <span className="font-mono">{info.catalogNumber}</span></>}
        </p>
        {info.year && <p className="text-slate-400">Collected {info.year}{where && ` · ${where}`}</p>}
        {info.lat != null && info.lng != null && (
          <p className="text-slate-400">
            {info.lat}, {info.lng}
            {info.generalized && ' (rounded to about 10 km)'}
          </p>
        )}
        {info.parent && (
          <p className="text-slate-400">
            Taken from specimen <span className="font-mono">{formatTagId(info.parent)}</span>
          </p>
        )}
      </section>
      <Link to="/auth" className="text-center text-emerald-400 underline">
        Sign in for more
      </Link>
    </div>
  )
}

/** True if this collector captured the tag recently (still in the field). */
async function recentOwnCapture(tagId: string | null, userId: string | undefined): Promise<boolean> {
  if (!tagId || !userId) return false
  const since = Date.now() - REUSE_HOURS * 3_600_000
  const captures = await db.records.where('tagId').equals(tagId).toArray()
  return captures.some((r) => r.collectorId === userId && r.status !== 'draft' && Date.parse(r.capturedAt) >= since)
}

const RANKS: { rank: TagRank | 'mixed_lot'; title: string; detail: string }[] = [
  { rank: 'specimen', title: 'Specimen', detail: 'A fish, or a lot of one species, in a vial or jar. Next: photograph it.' },
  { rank: 'mixed_lot', title: 'Mixed lot', detail: 'A jar of several species, e.g. a whole seine haul, to sort later.' },
  { rank: 'subsample', title: 'Subsample', detail: 'Tissue taken from a specimen, e.g. a fin clip in a 2 mL tube.' },
  { rank: 'event', title: 'Collecting event', detail: 'A field sheet: the site, date, method and collectors.' },
]

function RankChooser({ tagId, onChoose }: { tagId: string; onChoose: (rank: TagRank | 'mixed_lot', parentTagId: string | null) => void }) {
  const [hint, setHint] = useState<{ suggestion: Suggestion; format: string | null } | null>(null)
  // A tag unused on this phone may be in use elsewhere: check before offering it.
  const [claim, setClaim] = useState<'checking' | 'free' | 'taken'>(navigator.onLine ? 'checking' : 'free')
  useEffect(() => {
    if (!navigator.onLine) return
    let live = true
    void (async () => {
      try {
        if (await tagUnclaimed(tagId)) return live && setClaim('free')
        await syncAll() // ours or shared with us: pulling it reroutes this page
        if (live) setClaim('taken')
      } catch {
        if (live) setClaim('free')
      }
    })()
    return () => {
      live = false
    }
  }, [tagId])

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

  if (claim === 'checking') return <Centered>Checking tag…</Centered>
  if (claim === 'taken') {
    return (
      <Centered>
        <div className="flex max-w-sm flex-col gap-3 text-center">
          <p className="font-mono text-lg font-bold text-slate-200">{formatTagId(tagId)}</p>
          <p>This tag is already in use by someone else, and its record isn't shared with you.</p>
          <Link to="/" className="text-emerald-400 underline">
            Home
          </Link>
        </div>
      </Centered>
    )
  }

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
