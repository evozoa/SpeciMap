import { useEffect, useId, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Taxon } from '../db/schema'
import { knownSpecies } from '../db/drafts'
import { cacheTaxa, searchCached, searchInat, type TaxonSearch } from '../taxa/lookup'

interface Props {
  value: string
  /** The iNaturalist taxon the name is linked to, if any. */
  taxon?: Taxon | null
  /** `taxon` is set when a suggestion was picked, null when text was typed. */
  onChange: (value: string, taxon: Taxon | null) => void
  onBlur?: () => void
  id?: string
  className?: string
}

type Suggestion = { kind: 'taxon'; taxon: Taxon } | { kind: 'name'; name: string }

// Online answers for this session, so retyping doesn't re-query iNaturalist.
const online = new Map<string, TaxonSearch>()
const MIN_CHARS = 3
const DEBOUNCE_MS = 350

function rankLabel(rank: string) {
  return rank && rank !== 'species' ? rank : null
}

/**
 * Species name box backed by iNaturalist's taxonomy (all taxa). Suggestions
 * come from iNaturalist while online, and offline from taxa cached on this
 * device plus names already used. Anything can still be typed: a name that
 * isn't picked from the list is checked against iNaturalist later.
 * Dictation works through the phone keyboard's microphone.
 */
export default function SpeciesInput({ value, taxon, onChange, onBlur, id, className }: Props) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [remote, setRemote] = useState<TaxonSearch | null>(null)
  const [loading, setLoading] = useState(false)
  const query = value.trim()
  const lower = query.toLowerCase()

  const cached = useLiveQuery(() => searchCached(db, query), [query], [])
  const names = useLiveQuery(knownSpecies, [], [])

  // Debounced online lookup.
  const abort = useRef<AbortController | null>(null)
  useEffect(() => {
    abort.current?.abort()
    if (!open || query.length < MIN_CHARS || !navigator.onLine) {
      setRemote(null)
      setLoading(false)
      return
    }
    const hit = online.get(lower)
    if (hit) {
      setRemote(hit)
      setLoading(false)
      return
    }
    setLoading(true)
    const ctl = new AbortController()
    abort.current = ctl
    const timer = setTimeout(() => {
      searchInat(query, ctl.signal)
        .then((res) => {
          online.set(lower, res)
          setRemote(res)
          void cacheTaxa(
            db,
            res.hits.map((h) => h.taxon),
          )
        })
        .catch(() => setRemote(null)) // offline/aborted: cached suggestions only
        .finally(() => {
          if (!ctl.signal.aborted) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [query, lower, open])

  // iNaturalist first, then cached taxa, then plain names used before.
  const suggestions: Suggestion[] = []
  const seenIds = new Set<number>()
  const seenNames = new Set<string>()
  const addTaxon = (t: Taxon) => {
    if (seenIds.has(t.id)) return
    seenIds.add(t.id)
    seenNames.add(t.name.toLowerCase())
    suggestions.push({ kind: 'taxon', taxon: t })
  }
  remote?.hits.forEach((h) => addTaxon(h.taxon))
  cached.forEach(addTaxon)
  if (lower) {
    for (const n of names) {
      const l = n.toLowerCase()
      if (!seenNames.has(l) && l !== lower && l.includes(lower)) {
        seenNames.add(l)
        suggestions.push({ kind: 'name', name: n })
      }
    }
  }
  const shown = suggestions.slice(0, 8)
  const visible = open && query.length > 0 && (shown.length > 0 || loading)

  const pick = (s: Suggestion) => {
    if (s.kind === 'taxon') onChange(s.taxon.name, s.taxon)
    else onChange(s.name, null)
    setOpen(false)
    setActive(-1)
  }

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <input
        id={id}
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        onChange={(e) => {
          onChange(e.target.value, null)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          onBlur?.()
        }}
        onKeyDown={(e) => {
          if (!visible) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(i + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(i - 1, -1))
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault()
            pick(shown[active])
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
        placeholder="Species (optional): scientific or common name"
        autoCapitalize="sentences"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="done"
        className={`italic placeholder:not-italic ${className ?? ''}`}
      />

      {visible && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-20 mt-1 max-h-80 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl"
        >
          {remote?.fuzzy && remote.hits.length > 0 && (
            <li className="px-3 pt-2 text-xs text-amber-300">Did you mean…</li>
          )}
          {shown.map((s, i) => (
            <li
              key={s.kind === 'taxon' ? `t${s.taxon.id}` : `n${s.name}`}
              role="option"
              aria-selected={i === active}
              // mousedown, not click: keeps focus so blur doesn't close the list first
              onMouseDown={(e) => {
                e.preventDefault()
                pick(s)
              }}
              className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-slate-700' : 'hover:bg-slate-800'}`}
            >
              {s.kind === 'taxon' ? (
                <>
                  <span className="italic">{s.taxon.name}</span>
                  {rankLabel(s.taxon.rank) && (
                    <span className="ml-1 text-xs text-slate-500">({s.taxon.rank})</span>
                  )}
                  {s.taxon.commonName && (
                    <span className="block text-xs text-slate-400">{s.taxon.commonName}</span>
                  )}
                </>
              ) : (
                <>
                  <span className="italic">{s.name}</span>
                  <span className="block text-xs text-slate-500">used before, not matched</span>
                </>
              )}
            </li>
          ))}
          {loading && <li className="px-3 py-2 text-xs text-slate-500">Searching iNaturalist…</li>}
        </ul>
      )}

      {query && <TaxonStatus value={query} taxon={taxon ?? null} />}
    </div>
  )
}

function TaxonStatus({ value, taxon }: { value: string; taxon: Taxon | null }) {
  if (!taxon) {
    return (
      <p className="mt-1 text-xs text-slate-500">
        Not matched to iNaturalist yet; it will be checked when online.
      </p>
    )
  }
  const details = [rankLabel(taxon.rank), taxon.commonName].filter(Boolean).join(' · ')
  const same = taxon.name.toLowerCase() === value.toLowerCase()
  return (
    <p className="mt-1 text-xs text-emerald-400">
      ✓ {same ? 'Matched on iNaturalist' : <>Linked to <i>{taxon.name}</i></>}
      {details && ` · ${details}`}
    </p>
  )
}
