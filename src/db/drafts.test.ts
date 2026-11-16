import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from './schema'
import {
  appendToRecord,
  confirmTaxon,
  joinNotes,
  keepSpeciesAsTyped,
  knownSpecies,
  needsNameCheck,
  requestInatShare,
  setSpecies,
} from './drafts'
import { cacheTaxa } from '../taxa/lookup'
import type { LocalRecord } from './schema'

describe('joinNotes', () => {
  it('skips blanks and repeats', () => {
    expect(joinNotes('', ' 15902 ', '15902', 'wing torn')).toBe('15902\nwing torn')
  })
})

describe('appendToRecord', () => {
  it('moves draft photos onto the record, appends notes, and requeues it', async () => {
    const target = crypto.randomUUID()
    const draft = crypto.randomUUID()
    await db.records.add({
      id: target,
      tagId: '7Q4MK2XRC',
      collectorId: 'user-1',
      lat: 1,
      lng: 2,
      gpsAccuracyM: 5,
      locationAdjusted: false,
      capturedAt: '2026-09-20T12:00:00.000Z',
      notes: 'first',
      focusScore: null,
      status: 'synced',
      syncStep: 'done',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      clientMeta: {},
    })
    await db.photos.add({
      id: crypto.randomUUID(),
      recordId: draft,
      blob: new Blob(['x']),
      width: 1,
      height: 1,
      bytes: 1,
      uploaded: 0,
    })

    await appendToRecord(target, draft, 'second')

    expect(await db.records.get(target)).toMatchObject({
      notes: 'first\nsecond',
      status: 'queued',
      syncStep: 'upsert-specimen',
      capturedAt: '2026-09-20T12:00:00.000Z',
      lat: 1,
    })
    expect(await db.photos.where('recordId').equals(target).count()).toBe(1)
    expect(await db.photos.where('recordId').equals(draft).count()).toBe(0)
  })
})

function record(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId: '7Q4MK2XRC',
    collectorId: 'user-1',
    lat: 1,
    lng: 2,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-09-20T12:00:00.000Z',
    notes: '',
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

describe('setSpecies', () => {
  it('requeues a synced record from the specimen step', async () => {
    const r = record({ attempts: 3, lastError: 'old' })
    await db.records.add(r)
    await setSpecies(r.id, '  Lepomis megalotis ')
    expect(await db.records.get(r.id)).toMatchObject({
      species: 'Lepomis megalotis',
      status: 'queued',
      syncStep: 'upsert-specimen',
      attempts: 0,
      lastError: null,
    })
  })

  it('rewinds a queued record that is past the specimen step', async () => {
    const r = record({ status: 'queued', syncStep: 'upload-photos' })
    await db.records.add(r)
    await setSpecies(r.id, 'Cyprinella venusta')
    expect(await db.records.get(r.id)).toMatchObject({
      status: 'queued',
      syncStep: 'upsert-specimen',
    })
  })

  it('keeps an earlier step and leaves syncing records to the engine', async () => {
    const early = record({ status: 'queued', syncStep: 'ensure-tag' })
    const busy = record({ status: 'syncing', syncStep: 'upload-photos' })
    await db.records.bulkAdd([early, busy])
    await setSpecies(early.id, 'A')
    await setSpecies(busy.id, 'B')
    expect(await db.records.get(early.id)).toMatchObject({ syncStep: 'ensure-tag', species: 'A' })
    expect(await db.records.get(busy.id)).toMatchObject({
      status: 'syncing',
      syncStep: 'upload-photos',
      species: 'B',
    })
  })

  it('does nothing when the name is unchanged', async () => {
    const r = record({ species: 'Lepomis' })
    await db.records.add(r)
    await setSpecies(r.id, 'Lepomis ')
    expect(await db.records.get(r.id)).toMatchObject({ status: 'synced' })
  })

  it('lists distinct names for suggestions', async () => {
    expect(await knownSpecies()).toEqual(
      expect.arrayContaining(['Cyprinella venusta', 'Lepomis', 'Lepomis megalotis']),
    )
  })
})

describe('appendToRecord species', () => {
  it('sets the species when one is given and keeps it when blank', async () => {
    const r = record({ species: 'Lepomis' })
    await db.records.add(r)
    await appendToRecord(r.id, crypto.randomUUID(), '', '  ')
    expect((await db.records.get(r.id))?.species).toBe('Lepomis')
    await appendToRecord(r.id, crypto.randomUUID(), '', 'Lepomis megalotis')
    expect(await db.records.get(r.id)).toMatchObject({
      species: 'Lepomis megalotis',
      status: 'queued',
      syncStep: 'upsert-specimen',
    })
  })
})

describe('iNaturalist share requests', () => {
  it('queues a share once, keeping its UUID on retry after an error', async () => {
    const r = record()
    await db.records.add(r)
    await requestInatShare(r.id, 'private')
    const first = (await db.records.get(r.id))!.inat!
    expect(first).toMatchObject({ status: 'queued', geoprivacy: 'private', observationId: null })

    await requestInatShare(r.id, 'open') // already queued: no change
    expect((await db.records.get(r.id))!.inat).toEqual(first)

    await db.records.update(r.id, { inat: { ...first, status: 'error', lastError: 'x' } })
    await requestInatShare(r.id, 'open')
    expect((await db.records.get(r.id))!.inat).toMatchObject({
      status: 'queued',
      uuid: first.uuid,
      geoprivacy: 'private',
      lastError: null,
    })
  })

  it('requeues a shared record when a rescan adds photos', async () => {
    const r = record({
      inat: {
        status: 'shared',
        uuid: 'u-1',
        geoprivacy: 'obscured',
        observationId: 9,
        sharedPhotoIds: [],
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      },
    })
    await db.records.add(r)
    await appendToRecord(r.id, crypto.randomUUID(), 'more')
    expect((await db.records.get(r.id))!.inat).toMatchObject({ status: 'queued', observationId: 9 })
  })
})

describe('species taxa', () => {
  const longear = { id: 58635, name: 'Lepomis megalotis', rank: 'species', commonName: 'Longear Sunfish' }
  const weed = { id: 1545618, name: 'Alburnops texanus', rank: 'species', commonName: 'Weed Shiner' }

  it('stores a picked taxon and remembers it for offline suggestions', async () => {
    const r = record()
    await db.records.add(r)
    await setSpecies(r.id, 'Lepomis megalotis', longear)
    expect((await db.records.get(r.id))?.taxon).toEqual(longear)
    expect((await db.taxa.get(58635))?.usedAt).toBeGreaterThan(0)
  })

  it('links a typed name that exactly matches a cached taxon, and unlinks on retyping', async () => {
    await cacheTaxa(db, [longear])
    const r = record()
    await db.records.add(r)
    await setSpecies(r.id, 'lepomis megalotis')
    expect((await db.records.get(r.id))?.taxon?.id).toBe(58635)
    await setSpecies(r.id, 'Lepomis sp.')
    expect((await db.records.get(r.id))?.taxon).toBeNull()
  })

  it('confirms a suggestion, optionally keeping the typed name', async () => {
    const a = record({ species: 'longear sunfish', taxonReview: { for: 'longear sunfish', candidates: [longear] } })
    const b = record({ species: 'Notropis texanus', taxonReview: { for: 'Notropis texanus', candidates: [{ ...weed, matched: 'Notropis texanus' }] } })
    await db.records.bulkAdd([a, b])
    expect(needsNameCheck(a)).toBe(true)
    await confirmTaxon(a.id, longear)
    await confirmTaxon(b.id, { ...weed, matched: 'Notropis texanus' } as typeof weed, { keepName: true })
    expect(await db.records.get(a.id)).toMatchObject({ species: 'Lepomis megalotis', taxon: longear, taxonReview: null, status: 'queued' })
    const after = await db.records.get(b.id)
    expect(after).toMatchObject({ species: 'Notropis texanus', taxon: { id: 1545618, name: 'Alburnops texanus' } })
    expect(after?.taxon).not.toHaveProperty('matched')
  })

  it('stops asking once a name is kept as typed', async () => {
    const r = record({ species: 'Unknown sp. 3', taxonReview: { for: 'Unknown sp. 3', candidates: [] } })
    await db.records.add(r)
    await keepSpeciesAsTyped(r.id)
    const after = await db.records.get(r.id)
    expect(needsNameCheck(after!)).toBe(false)
    expect(after?.status).toBe('synced')
  })
})
