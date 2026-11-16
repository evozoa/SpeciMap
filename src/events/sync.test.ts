import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SpeciMapDB, type LocalEvent } from '../db/schema'
import { blankEvent, updateEvent } from './store'
import { EventSyncRunner, eventRow, fromRemote, type EventTransport } from './sync'
import { TerminalSyncError } from '../sync/engine'

let n = 0
const fresh = () => new SpeciMapDB(`evsync-${++n}`)

function transport(): EventTransport & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  return {
    rows,
    upsertEvent: vi.fn(async (e: LocalEvent) => void rows.set(e.id, eventRow(e))),
    uploadPhoto: vi.fn(async () => {}),
    upsertPhotoRow: vi.fn(async () => {}),
    fetchAll: vi.fn(async () => []),
  }
}

describe('EventSyncRunner', () => {
  it('uploads the event and its field-sheet photos once', async () => {
    const db = fresh()
    await db.events.add({ ...blankEvent('E1', 'me'), fieldNumber: 'MWS 26-001' })
    await db.eventPhotos.add({ id: 'p1', eventId: 'E1', blob: new Blob(['x']), width: 1, height: 1, bytes: 1, uploaded: 0 })
    const t = transport()
    const runner = new EventSyncRunner(db, t)
    await runner.kick()
    await runner.kick()
    expect(t.upsertEvent).toHaveBeenCalledTimes(1)
    expect(t.uploadPhoto).toHaveBeenCalledTimes(1)
    expect((await db.events.get('E1'))?.status).toBe('synced')
    expect(t.rows.get('E1')).toMatchObject({ field_number: 'MWS 26-001', locality: null })
  })

  it('re-sends an event edited after upload, and backs off on failures', async () => {
    const db = fresh()
    await db.events.add(blankEvent('E1', 'me'))
    const t = transport()
    const runner = new EventSyncRunner(db, t, { baseDelayMs: 0 })
    await runner.kick()
    await updateEvent('E1', { locality: 'Tibbee Creek' }, db)
    t.upsertEvent = vi.fn(async () => {
      throw new Error('offline')
    })
    await runner.kick()
    expect(await db.events.get('E1')).toMatchObject({ status: 'queued', attempts: 1, lastError: 'offline' })
    t.upsertEvent = vi.fn(async () => {
      throw new TerminalSyncError('denied')
    })
    await runner.kick()
    expect((await db.events.get('E1'))?.status).toBe('error')
  })

  it('pulls events from other devices without overwriting local edits', async () => {
    const db = fresh()
    await db.events.add({ ...blankEvent('MINE', 'me'), locality: 'local edit' })
    const t = transport()
    const remote = (id: string, locality: string) => ({
      ...eventRow({ ...blankEvent(id, 'me'), locality }),
      event_photos: [{ id: `${id}-p`, storage_path: `me/events/${id}/p.jpg`, width: 1, height: 1, bytes: 1 }],
    })
    t.fetchAll = vi.fn(async () => [remote('MINE', 'server'), remote('OTHER', 'Hwy 50')])
    await new EventSyncRunner(db, t).pull()
    expect((await db.events.get('MINE'))?.locality).toBe('local edit')
    expect(await db.events.get('OTHER')).toMatchObject({ locality: 'Hwy 50', status: 'synced' })
    expect(await db.eventPhotos.get('OTHER-p')).toMatchObject({ uploaded: 1, blob: null })
  })

  it('round-trips through the server row shape', () => {
    const e = { ...blankEvent('E1', 'me'), fieldNumber: 'MWS 26-001', countryCode: 'US', decimalLatitude: 33.4, decimalLongitude: -88.8 }
    expect(fromRemote({ ...eventRow(e), event_photos: [] })).toEqual({ ...e, status: 'synced' })
  })
})
