import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from './schema'
import { appendToRecord, joinNotes, knownSpecies, setSpecies } from './drafts'
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
