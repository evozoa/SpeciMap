/** Location-check upload rows and the runner that syncs them (see ../sync/rows.ts). */
import type { LocalScan, SpeciMapDB } from '../db/schema'
import { RowSyncRunner, type RowSyncOptions } from '../sync/rows'

export interface RemoteScan {
  id: string
  tag_id: string
  scanned_by: string
  scanned_at: string
  lat: number | null
  lng: number | null
  gps_accuracy_m: number | null
  place: string | null
  updated_at: string
}

export interface ScanTransport {
  /** Upload a scan (registering its tag first), or delete it if removed. */
  upsert(s: LocalScan): Promise<void>
  fetchAll(): Promise<RemoteScan[]>
}

export function scanRow(s: LocalScan): RemoteScan {
  return {
    id: s.id,
    tag_id: s.tagId,
    scanned_by: s.scannedBy,
    scanned_at: s.scannedAt,
    lat: s.lat,
    lng: s.lng,
    gps_accuracy_m: s.gpsAccuracyM,
    place: s.place.trim() || null,
    updated_at: s.updatedAt,
  }
}

export function fromRemote(r: RemoteScan): LocalScan {
  return {
    id: r.id,
    tagId: r.tag_id,
    scannedBy: r.scanned_by,
    scannedAt: new Date(r.scanned_at).toISOString(),
    lat: r.lat,
    lng: r.lng,
    gpsAccuracyM: r.gps_accuracy_m,
    place: r.place ?? '',
    updatedAt: new Date(r.updated_at).toISOString(),
    status: 'synced',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }
}

export class ScanSyncRunner extends RowSyncRunner<LocalScan, RemoteScan> {
  constructor(db: SpeciMapDB, transport: ScanTransport, opts: RowSyncOptions = {}) {
    super(
      db,
      {
        table: (d) => d.scans,
        key: (s) => s.id,
        remoteKey: (r) => r.id,
        upsert: (s) => transport.upsert(s),
        fetchAll: () => transport.fetchAll(),
        fromRemote,
      },
      opts,
    )
  }
}
