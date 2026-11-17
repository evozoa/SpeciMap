import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SpeciMapDB, type LocalScan } from '../db/schema'
import { capture } from '../test/fixtures'
import { FIX_WINDOW_MS, lastKnown, locationHistory, logScan, offerFix, removeScan, setScanPlace } from './store'
import { ScanSyncRunner, scanRow, type ScanTransport } from './sync'

let n = 0
const fresh = () => new SpeciMapDB(`scans-${++n}`)
const at = new Date('2026-11-17T15:00:00.000Z')
const later = (ms: number) => new Date(at.getTime() + ms)

describe('location checks', () => {
  it('logs a scan at once and fills in the best GPS fix shortly after', async () => {
    const db = fresh()
    await logScan({ id: 's1', tagId: '7Q4MK2XRC', scannedBy: 'me' }, db, at)
    await logScan({ id: 's1', tagId: '7Q4MK2XRC', scannedBy: 'me' }, db, at) // strict-mode repeat
    expect(await db.scans.count()).toBe(1)
    expect(await db.scans.get('s1')).toMatchObject({ lat: null, status: 'queued' })

    expect(await offerFix('s1', { lat: 32.6, lng: -85.5, accuracyM: 40 }, db, later(5_000))).toBe(true)
    expect(await offerFix('s1', { lat: 32.7, lng: -85.6, accuracyM: 60 }, db, later(6_000))).toBe(false) // worse
    expect(await offerFix('s1', { lat: 32.61, lng: -85.51, accuracyM: 8 }, db, later(7_000))).toBe(true) // better
    expect(await offerFix('s1', { lat: 0, lng: 0, accuracyM: 1 }, db, later(FIX_WINDOW_MS + 1))).toBe(false) // too late
    expect(await db.scans.get('s1')).toMatchObject({ lat: 32.61, lng: -85.51, gpsAccuracyM: 8 })
  })

  it('drops an untouched scan on removal, and keeps a tombstone otherwise', async () => {
    const db = fresh()
    await logScan({ id: 's1', tagId: 'A', scannedBy: 'me' }, db, at)
    await removeScan('s1', db)
    expect(await db.scans.get('s1')).toBeUndefined()

    await logScan({ id: 's2', tagId: 'A', scannedBy: 'me' }, db, at)
    await db.scans.update('s2', { status: 'synced' })
    await removeScan('s2', db)
    expect(await db.scans.get('s2')).toMatchObject({ deleted: true, status: 'queued' })
  })

  it('builds the history: collection, captures, then checks', async () => {
    const first = capture('A', { capturedAt: '2026-06-01T15:00:00.000Z' })
    const second = capture('A', { capturedAt: '2026-06-01T15:10:00.000Z' })
    const scan = (id: string, scannedAt: string, extra: Partial<LocalScan> = {}): LocalScan => ({
      id, tagId: 'A', scannedBy: 'me', scannedAt, lat: null, lng: null, gpsAccuracyM: null, place: '', updatedAt: scannedAt,
      status: 'synced', attempts: 0, nextAttemptAt: 0, lastError: null, ...extra,
    })
    const history = locationHistory(
      [second, first, capture('A', { status: 'draft' })],
      [
        scan('s1', '2026-11-17T15:00:00.000Z', { place: 'Range 4, shelf B' }),
        scan('s2', '2026-11-18T15:00:00.000Z'), // no fix, no place
        scan('s3', '2026-11-19T15:00:00.000Z', { deleted: true, place: 'oops' }),
      ],
    )
    expect(history.map((e) => e.kind)).toEqual(['collected', 'capture', 'scan', 'scan'])
    expect(lastKnown(history)?.place).toBe('Range 4, shelf B')
  })
})

describe('ScanSyncRunner', () => {
  it('uploads checks, re-sends edits, and sends removals', async () => {
    const db = fresh()
    const sent: unknown[] = []
    const t: ScanTransport = {
      upsert: vi.fn(async (s) => void sent.push(s.deleted ? { delete: s.id } : scanRow(s))),
      fetchAll: vi.fn(async () => []),
    }
    const runner = new ScanSyncRunner(db, t)
    await logScan({ id: 's1', tagId: 'A', scannedBy: 'me' }, db, at)
    await runner.kick()
    expect(sent).toEqual([expect.objectContaining({ id: 's1', tag_id: 'A', lat: null, place: null })])
    await setScanPlace('s1', 'Freezer 2', db)
    await runner.kick()
    expect(sent[1]).toMatchObject({ place: 'Freezer 2' })
    await removeScan('s1', db)
    await runner.kick()
    expect(sent[2]).toEqual({ delete: 's1' })
    expect(await db.scans.get('s1')).toMatchObject({ deleted: true, status: 'synced' })
  })
})
