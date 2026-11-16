import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SpeciMapDB, type LocalRecord, type Taxon } from '../db/schema'
import type { TaxonLookup } from './lookup'
import { TaxonResolver } from './resolver'

const longear: Taxon = { id: 58635, name: 'Lepomis megalotis', rank: 'species', commonName: 'Longear Sunfish' }
const weed: Taxon = { id: 1545618, name: 'Alburnops texanus', rank: 'species', commonName: 'Weed Shiner' }

let n = 0

function rec(species: string, overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId: '7Q4MK2XRC',
    collectorId: 'user-1',
    lat: 1,
    lng: 2,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-11-01T12:00:00.000Z',
    notes: '',
    species,
    focusScore: null,
    status: 'synced',
    syncStep: 'done',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    ...overrides,
  }
}

const lookup: TaxonLookup = vi.fn(async (q: string) => {
  const name = q.toLowerCase()
  if (name === 'lepomis megalotis') return { hits: [{ taxon: longear, matched: 'Lepomis megalotis' }], fuzzy: false }
  if (name === 'longear sunfish') return { hits: [{ taxon: longear, matched: 'Longear Sunfish' }], fuzzy: false }
  if (name === 'lepomis megalotus') return { hits: [{ taxon: longear, matched: 'Lepomis megalotis' }], fuzzy: true }
  if (name === 'notropis texanus') return { hits: [{ taxon: weed, matched: 'Notropis texanus' }], fuzzy: false }
  return { hits: [], fuzzy: true }
})

describe('TaxonResolver', () => {
  it('links exact names (fixing capitals) and requeues them for upload', async () => {
    const db = new SpeciMapDB(`resolve-${++n}`)
    const r = rec('lepomis megalotis')
    await db.records.add(r)
    await new TaxonResolver(db, lookup).kick()
    expect(await db.records.get(r.id)).toMatchObject({
      species: 'Lepomis megalotis',
      taxon: { id: 58635 },
      status: 'queued',
      syncStep: 'upsert-specimen',
    })
    expect((await db.taxa.get(58635))?.usedAt).toBeGreaterThan(0)
  })

  it('asks rather than renaming common names, synonyms and typos', async () => {
    const db = new SpeciMapDB(`resolve-${++n}`)
    const common = rec('longear sunfish')
    const synonym = rec('Notropis texanus')
    const typo = rec('Lepomis megalotus')
    const nothing = rec('Unknown sp. 3')
    await db.records.bulkAdd([common, synonym, typo, nothing])
    await new TaxonResolver(db, lookup).kick()
    for (const r of [common, synonym, typo]) {
      const after = await db.records.get(r.id)
      expect(after).toMatchObject({ species: r.species, status: 'synced' })
      expect(after?.taxon ?? null).toBeNull()
      expect(after?.taxonReview?.for).toBe(r.species)
      expect(after?.taxonReview?.candidates).toHaveLength(1)
    }
    expect((await db.records.get(synonym.id))?.taxonReview?.candidates[0]).toMatchObject({
      id: 1545618,
      matched: 'Notropis texanus',
    })
    expect((await db.records.get(nothing.id))?.taxonReview).toEqual({ for: 'Unknown sp. 3', candidates: [] })
  })

  it('looks each name up once, and skips linked or already-checked names', async () => {
    const db = new SpeciMapDB(`resolve-${++n}`)
    const calls = vi.fn(lookup)
    await db.records.bulkAdd([
      rec('Lepomis megalotus'),
      rec('Lepomis megalotus'),
      rec('Lepomis megalotis', { taxon: longear }),
      rec('Unknown sp. 3', { taxonReview: { for: 'Unknown sp. 3', candidates: [] } }),
      rec(''),
    ])
    const resolver = new TaxonResolver(db, calls)
    await resolver.kick()
    await resolver.kick()
    expect(calls).toHaveBeenCalledTimes(1)
  })

  it('stops quietly when offline and tries again later', async () => {
    const db = new SpeciMapDB(`resolve-${++n}`)
    const r = rec('Lepomis megalotis')
    await db.records.add(r)
    const offline: TaxonLookup = async () => {
      throw new TypeError('Failed to fetch')
    }
    await new TaxonResolver(db, offline).kick()
    expect((await db.records.get(r.id))?.taxonReview).toBeUndefined()
    await new TaxonResolver(db, lookup).kick()
    expect((await db.records.get(r.id))?.taxon?.id).toBe(58635)
  })
})
