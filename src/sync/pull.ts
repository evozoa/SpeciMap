/**
 * Pull direction of sync: reconciles this device with the signed-in
 * collector's server records, so records captured on another device (e.g. the
 * phone) show up here, and server-side changes (merged duplicates) propagate.
 *
 * The server is authoritative only for records with nothing left to upload
 * (status 'synced'). Anything queued, syncing, or failed is never touched, so
 * unsynced captures and edits are safe.
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

export interface MergeSummary {
  added: number
  updated: number
  removed: number
}

function remoteFields(s: RemoteSpecimen) {
  return {
    tagId: s.tag_id,
    collectorId: s.collector_id,
    lat: s.lat,
    lng: s.lng,
    gpsAccuracyM: s.gps_accuracy_m,
    locationAdjusted: s.location_adjusted,
    capturedAt: new Date(s.captured_at).toISOString(),
    notes: s.notes ?? '',
    focusScore: s.focus_score,
    clientMeta: s.client_meta ?? {},
  }
}

export interface MergeScope {
  collectorId: string
  /**
   * Ids of records that were already synced before `specimens` was fetched.
   * Only these may be deleted as missing from the server: a record that
   * finished uploading mid-fetch is absent from the list but must be kept.
   */
  syncedBeforeFetch: ReadonlySet<string>
}

/**
 * Reconcile Dexie with the collector's complete server record set.
 * `specimens` must be every server record of `scope.collectorId`.
 */
export async function mergeRemote(
  db: SpeciMapDB,
  specimens: RemoteSpecimen[],
  scope: MergeScope,
): Promise<MergeSummary> {
  return db.transaction('rw', db.records, db.photos, async () => {
    const summary: MergeSummary = { added: 0, updated: 0, removed: 0 }
    const remoteIds = new Set(specimens.map((s) => s.id))
    const local = await db.records.bulkGet(specimens.map((s) => s.id))

    // Records: add missing ones, refresh synced ones from the server.
    const puts: LocalRecord[] = []
    for (const [i, s] of specimens.entries()) {
      const mine = local[i]
      if (!mine) {
        puts.push({
          id: s.id,
          ...remoteFields(s),
          status: 'synced',
          syncStep: 'done',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        })
        summary.added++
      } else if (mine.status === 'synced') {
        puts.push({ ...mine, ...remoteFields(s) })
        summary.updated++
      }
    }
    await db.records.bulkPut(puts)

    // Photos: add missing ones; move synced ones to the server's specimen
    // (a merge on the server can re-parent them).
    const remotePhotos = specimens.flatMap((s) =>
      s.specimen_photos.map((p) => ({ specimenId: s.id, p })),
    )
    const localPhotos = await db.photos.bulkGet(remotePhotos.map(({ p }) => p.id))
    const photoPuts: LocalPhoto[] = []
    for (const [i, { specimenId, p }] of remotePhotos.entries()) {
      const mine = localPhotos[i]
      if (!mine) {
        photoPuts.push({
          id: p.id,
          recordId: specimenId,
          blob: null,
          storagePath: p.storage_path,
          width: p.width ?? 0,
          height: p.height ?? 0,
          bytes: p.bytes ?? 0,
          uploaded: 1,
        })
      } else if (mine.recordId !== specimenId && mine.uploaded) {
        const owner = await db.records.get(mine.recordId)
        if (!owner || owner.status === 'synced') {
          photoPuts.push({ ...mine, recordId: specimenId, storagePath: p.storage_path })
        }
      }
    }
    await db.photos.bulkPut(photoPuts)

    // Synced records gone from the server (merged away) are removed here too.
    const gone = await db.records
      .where('status')
      .equals('synced')
      .filter(
        (r) =>
          r.collectorId === scope.collectorId &&
          scope.syncedBeforeFetch.has(r.id) &&
          !remoteIds.has(r.id),
      )
      .primaryKeys()
    if (gone.length) {
      await db.photos.where('recordId').anyOf(gone).delete()
      await db.records.bulkDelete(gone)
      summary.removed = gone.length
    }
    return summary
  })
}
