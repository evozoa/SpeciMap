/**
 * Local-first storage. These Dexie rows are the source of truth on-device:
 * capture always writes here first, and the sync engine mirrors rows up to
 * Supabase. Rows stay after syncing (status: 'synced') so the app works
 * fully offline.
 */
import Dexie, { type EntityTable } from 'dexie'

export type SyncStatus = 'draft' | 'queued' | 'syncing' | 'synced' | 'error'

/** Ordered, idempotent sync steps; a record resumes at its stored step. */
export type SyncStep =
  | 'ensure-tag'
  | 'upsert-specimen'
  | 'upload-photos'
  | 'upsert-photo-rows'
  | 'done'

export interface LocalRecord {
  /** Client-generated UUID; the specimen PK on the server too (idempotent sync). */
  id: string
  tagId: string
  collectorId: string
  lat: number
  lng: number
  gpsAccuracyM: number | null
  locationAdjusted: boolean
  /** ISO timestamp of capture (device clock). */
  capturedAt: string
  notes: string
  focusScore: number | null
  status: SyncStatus
  syncStep: SyncStep
  attempts: number
  /** Epoch ms before which the engine must not retry (backoff). */
  nextAttemptAt: number
  lastError: string | null
  clientMeta: Record<string, unknown>
}

export interface LocalPhoto {
  /** Client-generated UUID; the photo PK on the server. */
  id: string
  recordId: string
  blob: Blob
  width: number
  height: number
  bytes: number
  uploaded: 0 | 1
}

export interface CachedTag {
  id: string
  batchId: string | null
  seq: number | null
}

export interface MetaRow {
  key: string
  value: unknown
}

export class SpeciMapDB extends Dexie {
  records!: EntityTable<LocalRecord, 'id'>
  photos!: EntityTable<LocalPhoto, 'id'>
  tagCache!: EntityTable<CachedTag, 'id'>
  meta!: EntityTable<MetaRow, 'key'>

  constructor(name = 'specimap') {
    super(name)
    this.version(1).stores({
      records: 'id, tagId, status, capturedAt, nextAttemptAt',
      photos: 'id, recordId, uploaded',
      tagCache: 'id',
      meta: 'key',
    })
  }
}

export const db = new SpeciMapDB()
