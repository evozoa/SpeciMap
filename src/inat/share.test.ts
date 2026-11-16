import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/supabase', () => ({ supabase: {}, PHOTO_BUCKET: 'photos' }))

import { SpeciMapDB, type InatShare, type LocalRecord } from '../db/schema'
import {
  InatShareRunner,
  InatTerminalError,
  observationFor,
  type InatClient,
  type NewObservation,
} from './share'
import { InatAuthError } from './auth'

let n = 0

function share(overrides: Partial<InatShare> = {}): InatShare {
  return {
    status: 'queued',
    uuid: crypto.randomUUID(),
    geoprivacy: 'obscured',
    observationId: null,
    sharedPhotoIds: [],
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    ...overrides,
  }
}

function makeRecord(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId: '7Q4MK2XRC',
    collectorId: 'user-1',
    lat: 33.45,
    lng: -88.79,
    gpsAccuracyM: 6.4,
    locationAdjusted: false,
    capturedAt: '2026-11-01T15:00:00.000Z',
    notes: 'riffle, seine haul 3',
    species: 'Cyprinella venusta',
    focusScore: null,
    status: 'synced',
    syncStep: 'done',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    inat: share(),
    ...overrides,
  }
}

function fakeClient() {
  const created: NewObservation[] = []
  const photos: { obs: number; name: string }[] = []
  const existing = new Map<string, number>()
  const client: InatClient = {
    findObservationByUuid: vi.fn(async (uuid) => existing.get(uuid) ?? null),
    matchTaxon: vi.fn(async (name) => (name === 'Cyprinella venusta' ? 42 : null)),
    createObservation: vi.fn(async (obs) => {
      created.push(obs)
      existing.set(obs.uuid, 1000 + created.length)
      return 1000 + created.length
    }),
    addPhoto: vi.fn(async (obs, _blob, name) => {
      photos.push({ obs, name })
    }),
    photoBlob: vi.fn(async (p) => p.blob ?? new Blob(['remote'])),
  }
  return { client, created, photos, existing }
}

async function addPhoto(db: SpeciMapDB, recordId: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.photos.add({
    id,
    recordId,
    blob: new Blob(['x']),
    width: 1,
    height: 1,
    bytes: 1,
    uploaded: 1,
  })
  return id
}

describe('observationFor', () => {
  it('maps a record to an iNaturalist observation', () => {
    const r = makeRecord()
    expect(observationFor(r, 42)).toEqual({
      uuid: r.inat!.uuid,
      species_guess: 'Cyprinella venusta',
      taxon_id: 42,
      observed_on_string: '2026-11-01T15:00:00.000Z',
      latitude: 33.45,
      longitude: -88.79,
      positional_accuracy: 6,
      geoprivacy: 'obscured',
      description: 'riffle, seine haul 3\n\nSpeciMap tag 7Q4M-K2XR-C',
      tag_list: 'SpeciMap',
    })
  })

  it('leaves out species and taxon when unknown', () => {
    const obs = observationFor(makeRecord({ species: '', notes: '' }), null)
    expect(obs).not.toHaveProperty('species_guess')
    expect(obs).not.toHaveProperty('taxon_id')
    expect(obs.description).toBe('SpeciMap tag 7Q4M-K2XR-C')
  })
})

describe('InatShareRunner', () => {
  let db: SpeciMapDB
  beforeEach(() => {
    db = new SpeciMapDB(`inat-${++n}`)
  })

  it('creates the observation, attaches every photo, and requeues the server sync', async () => {
    const r = makeRecord()
    await db.records.add(r)
    const p1 = await addPhoto(db, r.id)
    const p2 = await addPhoto(db, r.id)
    const { client, created, photos } = fakeClient()

    await new InatShareRunner(db, client).kick()

    expect(created).toHaveLength(1)
    expect(created[0].taxon_id).toBe(42)
    expect(photos.map((p) => p.name).sort()).toEqual([`${p1}.jpg`, `${p2}.jpg`].sort())
    expect(await db.records.get(r.id)).toMatchObject({
      inat: { status: 'shared', observationId: 1001, lastError: null },
      // the observation id must reach Supabase
      status: 'queued',
      syncStep: 'upsert-specimen',
    })
  })

  it('resumes a half-done share without duplicating the observation or photos', async () => {
    const r = makeRecord()
    await db.records.add(r)
    const p1 = await addPhoto(db, r.id)
    const p2 = await addPhoto(db, r.id)
    const { client, created, photos } = fakeClient()
    let calls = 0
    client.addPhoto = vi.fn(async (obs, _b, name) => {
      if (++calls === 2) throw new Error('network dropped')
      photos.push({ obs, name })
    })
    const runner = new InatShareRunner(db, client, { baseDelayMs: 0 })

    await runner.kick()
    const half = await db.records.get(r.id)
    expect(half).toMatchObject({ inat: { status: 'queued', observationId: 1001, attempts: 1 } })
    // Photos go in id order, so either one may be the first sent.
    expect(half?.inat?.sharedPhotoIds).toHaveLength(1)
    expect([p1, p2]).toContain(half?.inat?.sharedPhotoIds[0])

    await runner.kick()
    expect(created).toHaveLength(1)
    expect(photos).toHaveLength(2)
    expect((await db.records.get(r.id))?.inat?.status).toBe('shared')
  })

  it('finds an observation created by an attempt whose reply was lost', async () => {
    const r = makeRecord()
    await db.records.add(r)
    const { client, created, existing } = fakeClient()
    existing.set(r.inat!.uuid, 777)

    await new InatShareRunner(db, client).kick()

    expect(created).toHaveLength(0)
    expect((await db.records.get(r.id))?.inat).toMatchObject({
      status: 'shared',
      observationId: 777,
    })
  })

  it('stops and flags the record when the iNaturalist sign-in is gone', async () => {
    const a = makeRecord()
    const b = makeRecord()
    await db.records.bulkAdd([a, b])
    const { client } = fakeClient()
    client.findObservationByUuid = vi.fn(async () => {
      throw new InatAuthError('reconnect in Settings')
    })

    await new InatShareRunner(db, client).kick()

    expect(client.findObservationByUuid).toHaveBeenCalledTimes(1)
    const states = (await db.records.bulkGet([a.id, b.id])).map((r) => r?.inat?.status)
    expect(states.sort()).toEqual(['error', 'queued'])
  })

  it('marks rejected observations as errors without retrying', async () => {
    const r = makeRecord()
    await db.records.add(r)
    const { client } = fakeClient()
    client.createObservation = vi.fn(async () => {
      throw new InatTerminalError('bad coordinates')
    })

    await new InatShareRunner(db, client).kick()

    expect((await db.records.get(r.id))?.inat).toMatchObject({
      status: 'error',
      lastError: 'bad coordinates',
    })
  })

  it('ignores records that were never shared or are already done', async () => {
    const plain = makeRecord({ inat: undefined })
    const done = makeRecord({ inat: share({ status: 'shared', observationId: 5 }) })
    await db.records.bulkAdd([plain, done])
    const { client } = fakeClient()

    await new InatShareRunner(db, client).kick()

    expect(client.findObservationByUuid).not.toHaveBeenCalled()
    expect(client.createObservation).not.toHaveBeenCalled()
  })
})
