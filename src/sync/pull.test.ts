import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
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
  let db: SpeciMapDB

  /** Merge as a pull would: everything synced locally predates the fetch. */
  async function pull(specimens: RemoteSpecimen[]) {
    const syncedBeforeFetch = new Set(
      await db.records.where('status').equals('synced').primaryKeys(),
    )
    return mergeRemote(db, specimens, { collectorId: 'user-1', syncedBeforeFetch })
  }

  beforeEach(() => {
    db = new SpeciMapDB(`pull-${++dbCounter}`)
  })

  it('adds server records as synced, with path-only photos', async () => {
    const s = remote()
    expect((await pull([s])).added).toBe(1)

    const record = await db.records.get(s.id)
    expect(record).toMatchObject({ status: 'synced', syncStep: 'done', notes: '' })
    expect(record?.capturedAt).toBe('2026-09-20T12:00:00.000Z')
    const photos = await db.photos.where('recordId').equals(s.id).toArray()
    expect(photos).toHaveLength(1)
    expect(photos[0]).toMatchObject({ blob: null, storagePath: 'user-1/x/y.jpg', uploaded: 1 })
  })

  it('never touches a record with changes still to upload', async () => {
    const s = remote()
    await pull([s])
    await db.records.update(s.id, { status: 'queued', notes: 'local edit' })

    await pull([{ ...s, notes: 'server' }])
    expect(await db.records.get(s.id)).toMatchObject({ status: 'queued', notes: 'local edit' })
  })

  it('refreshes synced records from the server', async () => {
    const s = remote()
    await pull([s])
    await pull([{ ...s, notes: 'merged note' }])
    expect((await db.records.get(s.id))?.notes).toBe('merged note')
  })

  it('adds photos that reach the server after the record was pulled', async () => {
    const s = remote({ specimen_photos: [] })
    await pull([s])
    expect(await db.photos.count()).toBe(0)

    await pull([remote({ id: s.id })])
    expect(await db.photos.where('recordId').equals(s.id).count()).toBe(1)
  })

  it('follows a server-side merge: re-parents photos and drops the merged-away record', async () => {
    const keep = remote()
    const dup = remote({ captured_at: '2026-09-20T12:01:00+00:00' })
    await pull([keep, dup])
    // Give the duplicate's photo a local blob, as on the capturing phone.
    const dupPhoto = dup.specimen_photos[0]
    await db.photos.update(dupPhoto.id, { blob: new Blob(['x']) })

    const summary = await pull([
      { ...keep, specimen_photos: [...keep.specimen_photos, dupPhoto] },
    ])

    expect(summary.removed).toBe(1)
    expect(await db.records.get(dup.id)).toBeUndefined()
    const photos = await db.photos.where('recordId').equals(keep.id).toArray()
    expect(photos.map((p) => p.id).sort()).toEqual(
      [keep.specimen_photos[0].id, dupPhoto.id].sort(),
    )
    expect(photos.find((p) => p.id === dupPhoto.id)?.blob).not.toBeNull()
  })

  it('keeps records that finished uploading during the fetch', async () => {
    const syncedBeforeFetch = new Set<string>()
    const s = remote()
    await pull([s])
    // Synced after the snapshot, so absent from the fetched list.
    await mergeRemote(db, [], { collectorId: 'user-1', syncedBeforeFetch })
    expect(await db.records.get(s.id)).toBeDefined()
  })

  it("never removes another collector's records", async () => {
    const other = remote({ collector_id: 'user-2' })
    await pull([other])
    await pull([])
    expect(await db.records.get(other.id)).toBeDefined()
  })
})
