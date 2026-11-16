/**
 * Species-name lookup against iNaturalist's taxonomy (all taxa), with an
 * on-device cache so suggestions keep working offline.
 *
 * Online lookups use the public /taxa/autocomplete endpoint (no account
 * needed). It matches scientific names, synonyms and common names by
 * prefix but does not forgive typos, so when it finds nothing we retry with
 * a shorter prefix and keep the candidates within a small edit distance.
 *
 * Every taxon seen online is cached; the cache is searched by the lower-case
 * words of the scientific and common names.
 */
import type { CachedTaxon, SpeciMapDB, Taxon } from '../db/schema'
import { INAT_API } from '../inat/auth'

export interface TaxonHit {
  taxon: Taxon
  /** The name that matched (scientific, synonym or common name). */
  matched: string
}

export interface TaxonSearch {
  hits: TaxonHit[]
  /** True when the hits come from the typo-tolerant fallback. */
  fuzzy: boolean
}

/** Looks a name up online; injectable so tests can fake iNaturalist. */
export type TaxonLookup = (query: string, signal?: AbortSignal) => Promise<TaxonSearch>

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

export function termsFor(t: Pick<Taxon, 'name' | 'commonName'>): string[] {
  const words = `${t.name} ${t.commonName ?? ''}`.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  return [...new Set(words.filter(Boolean))]
}

/** Edit distance (Levenshtein), for typo-tolerant matching. */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** Ranks that group or mix species sort after the real thing. */
const rankPenalty = (rank: string) =>
  ['complex', 'hybrid', 'section', 'subsection', 'zoosection'].includes(rank) ? 1 : 0

/**
 * The hit whose scientific name is exactly `name` (ignoring case), preferring
 * a species over a same-named complex.
 */
export function exactHit(hits: TaxonHit[], name: string): Taxon | null {
  const want = norm(name)
  const exact = hits
    .filter((h) => norm(h.taxon.name) === want)
    .sort((a, b) => rankPenalty(a.taxon.rank) - rankPenalty(b.taxon.rank))
  return exact[0]?.taxon ?? null
}

// ---- Online (iNaturalist) ----------------------------------------------

interface ApiTaxon {
  id: number
  name: string
  rank: string
  preferred_common_name?: string
  matched_term?: string
  iconic_taxon_name?: string
}

async function autocomplete(q: string, signal?: AbortSignal): Promise<TaxonHit[]> {
  const locale = (navigator.language || 'en').split('-')[0]
  const url =
    `${INAT_API}/taxa/autocomplete?q=${encodeURIComponent(q)}` +
    `&per_page=10&is_active=true&locale=${locale}`
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`iNaturalist lookup failed (${res.status})`)
  const { results } = (await res.json()) as { results: ApiTaxon[] }
  return results.map((t) => ({
    taxon: {
      id: t.id,
      name: t.name,
      rank: t.rank,
      commonName: t.preferred_common_name ?? null,
      iconic: t.iconic_taxon_name ?? null,
    },
    matched: t.matched_term ?? t.name,
  }))
}

/** Shorter query for the typo fallback: genus + first letters of the epithet. */
export function fallbackQuery(q: string): string | null {
  const words = norm(q).split(' ')
  if (words.length >= 2) {
    const last = words[words.length - 1]
    const head = words.slice(0, -1).join(' ')
    return last.length > 3 ? `${head} ${last.slice(0, 3)}` : head
  }
  return words[0].length > 4 ? words[0].slice(0, 4) : null
}

/** Keeps fallback hits close enough to the typed name to be a typo of it. */
export function closeHits(q: string, hits: TaxonHit[]): TaxonHit[] {
  const want = norm(q)
  const limit = Math.max(2, Math.floor(want.length / 6))
  return hits
    .map((h) => ({
      h,
      d: Math.min(editDistance(want, norm(h.taxon.name)), editDistance(want, norm(h.matched))),
    }))
    .filter(({ d }) => d <= limit)
    .sort((a, b) => a.d - b.d || rankPenalty(a.h.taxon.rank) - rankPenalty(b.h.taxon.rank))
    .map(({ h }) => h)
}

export const searchInat: TaxonLookup = async (query, signal) => {
  const q = norm(query)
  const hits = await autocomplete(q, signal)
  if (hits.length) return { hits, fuzzy: false }
  const shorter = fallbackQuery(q)
  if (!shorter) return { hits: [], fuzzy: true }
  return { hits: closeHits(q, await autocomplete(shorter, signal)), fuzzy: true }
}

// ---- On-device cache -----------------------------------------------------

/** Saves taxa to the offline cache; `used` marks ones the collector chose. */
export async function cacheTaxa(db: SpeciMapDB, taxa: Taxon[], used = false): Promise<void> {
  if (!taxa.length) return
  await db.transaction('rw', db.taxa, async () => {
    const old = await db.taxa.bulkGet(taxa.map((t) => t.id))
    await db.taxa.bulkPut(
      taxa.map(
        (t, i): CachedTaxon => ({
          id: t.id,
          name: t.name,
          rank: t.rank,
          commonName: t.commonName ?? old[i]?.commonName ?? null,
          iconic: t.iconic ?? old[i]?.iconic ?? null,
          terms: termsFor({ name: t.name, commonName: t.commonName ?? old[i]?.commonName }),
          usedAt: used ? Date.now() : (old[i]?.usedAt ?? 0),
        }),
      ),
    )
  })
}

function strip(t: CachedTaxon): Taxon {
  return { id: t.id, name: t.name, rank: t.rank, commonName: t.commonName, iconic: t.iconic }
}

/**
 * Cached taxa matching what's typed: every typed word must start a word of
 * the scientific or common name. Taxa the collector has used come first.
 */
export async function searchCached(db: SpeciMapDB, query: string, limit = 8): Promise<Taxon[]> {
  const words = norm(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (!words.length) return []
  const rows = await db.taxa.where('terms').startsWith(words[0]).limit(500).toArray()
  const seen = new Set<number>()
  const want = norm(query)
  return rows
    .filter((t) => {
      if (seen.has(t.id)) return false
      seen.add(t.id)
      return words.every((w) => t.terms.some((term) => term.startsWith(w)))
    })
    .sort(
      (a, b) =>
        Number(norm(b.name) === want) - Number(norm(a.name) === want) ||
        b.usedAt - a.usedAt ||
        rankPenalty(a.rank) - rankPenalty(b.rank) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(strip)
}

/** The cached taxon whose scientific name is exactly `name`, if any. */
export async function cachedExact(db: SpeciMapDB, name: string): Promise<Taxon | null> {
  const want = norm(name)
  if (!want) return null
  const first = want.split(' ')[0]
  const rows = await db.taxa.where('terms').equals(first).toArray()
  const exact = rows
    .filter((t) => norm(t.name) === want)
    .sort((a, b) => rankPenalty(a.rank) - rankPenalty(b.rank) || b.usedAt - a.usedAt)
  return exact[0] ? strip(exact[0]) : null
}
