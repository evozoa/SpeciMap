import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB, type Taxon } from '../db/schema'
import {
  cacheTaxa,
  cachedExact,
  closeHits,
  editDistance,
  exactHit,
  fallbackQuery,
  searchCached,
  termsFor,
  type TaxonHit,
} from './lookup'

const longear: Taxon = { id: 58635, name: 'Lepomis megalotis', rank: 'species', commonName: 'Longear Sunfish' }
const longearComplex: Taxon = { id: 1553125, name: 'Lepomis megalotis', rank: 'complex', commonName: 'Longear Sunfish Complex' }
const bluegill: Taxon = { id: 49591, name: 'Lepomis macrochirus', rank: 'species', commonName: 'Bluegill' }
const weed: Taxon = { id: 1545618, name: 'Alburnops texanus', rank: 'species', commonName: 'Weed Shiner' }
const hit = (taxon: Taxon, matched = taxon.name): TaxonHit => ({ taxon, matched })

let n = 0

describe('matching helpers', () => {
  it('measures edit distance', () => {
    expect(editDistance('megalotus', 'megalotis')).toBe(1)
    expect(editDistance('', 'abc')).toBe(3)
    expect(editDistance('same', 'same')).toBe(0)
  })

  it('indexes the words of scientific and common names', () => {
    expect(termsFor(longear)).toEqual(['lepomis', 'megalotis', 'longear', 'sunfish'])
  })

  it('shortens a misspelled name to genus plus the epithet start', () => {
    expect(fallbackQuery('Lepomis megalotus')).toBe('lepomis meg')
    expect(fallbackQuery('Lepomis me')).toBe('lepomis')
    expect(fallbackQuery('Lepomus')).toBe('lepo')
    expect(fallbackQuery('Lep')).toBeNull()
  })

  it('keeps only fallback hits close to what was typed, closest first', () => {
    const hits = [hit(bluegill), hit(longearComplex), hit(longear), hit(weed, 'Notropis texanus')]
    expect(closeHits('Lepomis megalotus', hits).map((h) => h.taxon.id)).toEqual([58635, 1553125])
    expect(closeHits('Notropis texanis', hits).map((h) => h.taxon.id)).toEqual([1545618])
  })

  it('finds an exact scientific name, preferring the species over a complex', () => {
    expect(exactHit([hit(longearComplex), hit(longear)], 'lepomis  megalotis')).toBe(longear)
    expect(exactHit([hit(weed, 'Notropis texanus')], 'Notropis texanus')).toBeNull()
  })
})

describe('taxon cache', () => {
  it('searches by any word of the scientific or common name, offline', async () => {
    const db = new SpeciMapDB(`taxa-${++n}`)
    await cacheTaxa(db, [longear, bluegill, weed])
    expect((await searchCached(db, 'lep')).map((t) => t.id).sort()).toEqual([49591, 58635])
    expect((await searchCached(db, 'longear sun')).map((t) => t.id)).toEqual([58635])
    expect((await searchCached(db, 'blue')).map((t) => t.id)).toEqual([49591])
    expect(await searchCached(db, 'zz')).toEqual([])
  })

  it('lists taxa the collector has used first', async () => {
    const db = new SpeciMapDB(`taxa-${++n}`)
    await cacheTaxa(db, [longear, bluegill])
    await cacheTaxa(db, [bluegill], true)
    expect((await searchCached(db, 'lepomis'))[0].id).toBe(49591)
  })

  it('looks up an exact name, ignoring case', async () => {
    const db = new SpeciMapDB(`taxa-${++n}`)
    await cacheTaxa(db, [longearComplex, longear])
    expect((await cachedExact(db, 'LEPOMIS megalotis'))?.id).toBe(58635)
    expect(await cachedExact(db, 'Lepomis')).toBeNull()
  })
})
