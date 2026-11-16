/**
 * Checks species names that aren't linked to an iNaturalist taxon yet
 * (typed offline, or typed without picking a suggestion) once the phone is
 * online.
 *
 *   - Exactly iNaturalist's scientific name (ignoring case): linked
 *     automatically. Only capitalization can change.
 *   - Anything else (a common name, a synonym, a typo): the best matches are
 *     stored on the record as a review, and the collector confirms one or
 *     keeps the name as typed. Names are never changed silently.
 *
 * Each name is looked up once per spelling; editing the name looks it up again.
 */
import { db as defaultDb, type LocalRecord, type SpeciMapDB } from '../db/schema'
import { serverEdit } from '../db/drafts'
import { cacheTaxa, exactHit, searchInat, type TaxonLookup } from './lookup'

export interface ResolverOptions {
  /** Pause between lookups, to stay well inside iNaturalist's rate limit. */
  delayMs?: number
}

function unchecked(r: LocalRecord): boolean {
  const species = r.species?.trim()
  return !!species && !r.taxon && r.taxonReview?.for !== species
}

export class TaxonResolver {
  private running: Promise<void> | null = null

  constructor(
    private db: SpeciMapDB,
    private lookup: TaxonLookup,
    private opts: ResolverOptions = {},
  ) {}

  /** Single-flight: a call while a pass runs waits for that pass. */
  kick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const todo = await this.db.records.filter(unchecked).toArray()
    // One lookup per distinct name, however many records share it.
    const byName = new Map<string, string[]>()
    for (const r of todo) {
      const key = r.species!.trim()
      byName.set(key, [...(byName.get(key) ?? []), r.id])
    }
    let first = true
    for (const [name, ids] of byName) {
      if (!first && this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs))
      first = false
      let result
      try {
        result = await this.lookup(name)
      } catch {
        return // offline or iNaturalist unavailable: try again next time
      }
      await cacheTaxa(this.db, result.hits.map((h) => h.taxon))
      const exact = result.fuzzy ? null : exactHit(result.hits, name)
      if (exact) await cacheTaxa(this.db, [exact], true)
      await this.db.transaction('rw', this.db.records, async () => {
        for (const id of ids) {
          const r = await this.db.records.get(id)
          if (!r || r.species?.trim() !== name || r.taxon) continue // edited meanwhile
          if (exact) {
            await this.db.records.update(
              id,
              serverEdit(r, { species: exact.name, taxon: exact, taxonReview: null }),
            )
          } else {
            const candidates = result.hits
              .slice(0, 3)
              .map((h) => ({ ...h.taxon, matched: h.matched }))
            await this.db.records.update(id, { taxonReview: { for: name, candidates } })
          }
        }
      })
    }
  }
}

export const taxonResolver = new TaxonResolver(defaultDb, searchInat, { delayMs: 1100 })
