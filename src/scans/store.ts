/**
 * Location checks: each rescan of a specimen or subsample after collection
 * logs when and where it was seen. The scan is saved at once and its
 * coordinates are filled in when the phone gets a GPS fix, so a quick scan
 * on a museum shelf is never lost waiting for GPS.
 */
import { db as defaultDb, type LocalRecord, type LocalScan, type SpeciMapDB } from '../db/schema'

/** A fix this good stops the location from being refined further. */
export const GOOD_ENOUGH_M = 20
/** GPS fixes arriving later than this after the scan aren't used. */
export const FIX_WINDOW_MS = 2 * 60_000

export async function logScan(
  input: { id: string; tagId: string; scannedBy: string },
  db: SpeciMapDB = defaultDb,
  now = new Date(),
): Promise<void> {
  // put, not add: the same scan id may be logged twice (React strict mode).
  await db.transaction('rw', db.scans, async () => {
    if (await db.scans.get(input.id)) return
    await db.scans.add({
      ...input,
      scannedAt: now.toISOString(),
      lat: null,
      lng: null,
      gpsAccuracyM: null,
      place: '',
      updatedAt: now.toISOString(),
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    })
  })
}

function touched(s: LocalScan, now = new Date()): Partial<LocalScan> {
  return {
    updatedAt: now.toISOString(),
    ...(s.status === 'syncing' ? {} : { status: 'queued' as const, attempts: 0, nextAttemptAt: 0, lastError: null }),
  }
}

/**
 * Offer a GPS fix for a scan. Kept if it's the first or more accurate than
 * the one stored, and only shortly after the scan (so walking away with the
 * page open doesn't move it). Returns true if the scan changed.
 */
export async function offerFix(
  id: string,
  fix: { lat: number; lng: number; accuracyM: number },
  db: SpeciMapDB = defaultDb,
  now = new Date(),
): Promise<boolean> {
  return db.transaction('rw', db.scans, async () => {
    const s = await db.scans.get(id)
    if (!s || s.deleted) return false
    if (now.getTime() - Date.parse(s.scannedAt) > FIX_WINDOW_MS) return false
    if (s.gpsAccuracyM != null && s.gpsAccuracyM <= fix.accuracyM) return false
    await db.scans.update(id, {
      lat: fix.lat,
      lng: fix.lng,
      gpsAccuracyM: Math.round(fix.accuracyM),
      ...touched(s, now),
    })
    return true
  })
}

export async function setScanPlace(id: string, place: string, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.scans, async () => {
    const s = await db.scans.get(id)
    if (!s || s.place === place.trim()) return
    await db.scans.update(id, { place: place.trim(), ...touched(s) })
  })
}

/** Remove a scan logged by mistake (also from the server once uploaded). */
export async function removeScan(id: string, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.scans, async () => {
    const s = await db.scans.get(id)
    if (!s) return
    if (s.status === 'queued' && s.attempts === 0 && !s.lastError && s.updatedAt === s.scannedAt && s.lat == null) {
      // Never left the phone and never edited: just drop it.
      await db.scans.delete(id)
      return
    }
    await db.scans.update(id, { deleted: true, ...touched(s) })
  })
}

export interface HistoryEntry {
  kind: 'collected' | 'capture' | 'scan'
  id: string
  at: string
  lat: number | null
  lng: number | null
  accuracyM: number | null
  place: string
  by: string
}

/**
 * Where a tag has been, oldest first: its captures (the first is where it
 * was collected) and its location checks.
 */
export function locationHistory(captures: LocalRecord[], scans: LocalScan[]): HistoryEntry[] {
  const caps = captures
    .filter((r) => r.status !== 'draft')
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .map<HistoryEntry>((r, i) => ({
      kind: i === 0 ? 'collected' : 'capture',
      id: r.id,
      at: r.capturedAt,
      lat: r.lat,
      lng: r.lng,
      accuracyM: r.gpsAccuracyM,
      place: '',
      by: r.collectorId,
    }))
  const checks = scans
    .filter((s) => !s.deleted)
    .map<HistoryEntry>((s) => ({
      kind: 'scan',
      id: s.id,
      at: s.scannedAt,
      lat: s.lat,
      lng: s.lng,
      accuracyM: s.gpsAccuracyM,
      place: s.place,
      by: s.scannedBy,
    }))
  return [...caps, ...checks].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

/** The most recent entry with a place or coordinates: the last known location. */
export function lastKnown(history: HistoryEntry[]): HistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].lat != null || history[i].place) return history[i]
  }
  return null
}
