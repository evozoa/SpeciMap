import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB } from '../db/schema'
import { mergeRemote, type RemoteSpecimen } from './pull'

let dbCounter = 0

function remote(overrides: Partial<RemoteSpecimen> = {}): RemoteSpecimen {
  return {
    id: crypto.randomUUID(),
    tag_id: '7Q4MK2XRC',
    collector_id: 'user-1',
    lat: 1.23,
    lng: 4.56,
    gps_accuracy_m: 8,
    location_adjusted: false,
    captured_at: '2026-09-20T12:00:00+00:00',
    notes: null,
    focus_score: 120,
    client_meta: null,
    specimen_photos: [
      {
        id: crypto.randomUUID(),
        storage_path: 'user-1/x/y.jpg',
        width: 1600,
        height: 1200,
        bytes: 1000,
      },
    ],
    ...overrides,
  }
}

describe('mergeRemote', () => {
  it('adds server records as synced, with path-only photos', async () => {
    const db = new SpeciMapDB(`pull-${++dbCounter}`)
    const s = remote()
    expect(await mergeRemote(db, [s])).toBe(1)

    const record = await db.records.get(s.id)
    expect(record).toMatchObject({ status: 'synced', syncStep: 'done', notes: '' })
    expect(record?.capturedAt).toBe('2026-09-20T12:00:00.000Z')
    const photos = await db.photos.where('recordId').equals(s.id).toArray()
    expect(photos).toHaveLength(1)
    expect(photos[0]).toMatchObject({ blob: null, storagePath: 'user-1/x/y.jpg', uploaded: 1 })
  })

  it('never overwrites a record already on this device', async () => {
    const db = new SpeciMapDB(`pull-${++dbCounter}`)
    const s = remote()
    await mergeRemote(db, [s])
    await db.records.update(s.id, { status: 'queued', notes: 'local edit' })

    expect(await mergeRemote(db, [{ ...s, notes: 'server' }])).toBe(0)
    expect(await db.records.get(s.id)).toMatchObject({ status: 'queued', notes: 'local edit' })
  })

  it('adds photos that reach the server after the record was pulled', async () => {
    const db = new SpeciMapDB(`pull-${++dbCounter}`)
    const s = remote({ specimen_photos: [] })
    await mergeRemote(db, [s])
    expect(await db.photos.count()).toBe(0)

    await mergeRemote(db, [remote({ id: s.id })])
    expect(await db.photos.where('recordId').equals(s.id).count()).toBe(1)
  })
})
