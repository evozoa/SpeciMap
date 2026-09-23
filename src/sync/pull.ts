/**
 * Pull direction of sync: mirrors the signed-in collector's server records
 * into Dexie so records captured on another device (e.g. the phone) show up
 * here too. Local rows always win — a record already on this device is never
 * overwritten, so unsynced edits and queued uploads are untouched.
 *
 * Pulled photos carry only their storage path; images are fetched on demand
 * through signed URLs rather than downloaded in bulk.
 */
import type { LocalPhoto, LocalRecord, SpeciMapDB } from '../db/schema'

export interface RemotePhoto {
  id: string
  storage_path: string
  width: number | null
  height: number | null
  bytes: number | null
}

export interface RemoteSpecimen {
  id: string
  tag_id: string
  collector_id: string
  lat: number
  lng: number
  gps_accuracy_m: number | null
  location_adjusted: boolean
  captured_at: string
  notes: string | null
  focus_score: number | null
  client_meta: Record<string, unknown> | null
  specimen_photos: RemotePhoto[]
}

/** Insert server specimens missing locally. Returns how many were added. */
export async function mergeRemote(
  db: SpeciMapDB,
  specimens: RemoteSpecimen[],
): Promise<number> {
  return db.transaction('rw', db.records, db.photos, async () => {
    const existing = await db.records.bulkGet(specimens.map((s) => s.id))
    const missing = specimens.filter((_, i) => !existing[i])

    const records: LocalRecord[] = missing.map((s) => ({
      id: s.id,
      tagId: s.tag_id,
      collectorId: s.collector_id,
      lat: s.lat,
      lng: s.lng,
      gpsAccuracyM: s.gps_accuracy_m,
      locationAdjusted: s.location_adjusted,
      capturedAt: new Date(s.captured_at).toISOString(),
      notes: s.notes ?? '',
      focusScore: s.focus_score,
      status: 'synced',
      syncStep: 'done',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      clientMeta: s.client_meta ?? {},
    }))
    const photos: LocalPhoto[] = missing.flatMap((s) =>
      s.specimen_photos.map((p) => ({
        id: p.id,
        recordId: s.id,
        blob: null,
        storagePath: p.storage_path,
        width: p.width ?? 0,
        height: p.height ?? 0,
        bytes: p.bytes ?? 0,
        uploaded: 1 as const,
      })),
    )

    await db.records.bulkPut(records)
    await db.photos.bulkPut(photos)
    return records.length
  })
}
