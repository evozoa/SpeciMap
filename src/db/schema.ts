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
  /**
   * Species name entered by the collector (free text). Optional because
   * records created before this field existed don't have it.
   */
  species?: string
  /**
   * The iNaturalist taxon `species` is linked to: picked from the lookup,
   * matched exactly, or confirmed by the collector. Null/absent = unverified.
   */
  taxon?: Taxon | null
  /**
   * A pending "did you mean" for an unverified name, found once online.
   * `for` is the species text it was looked up for; stale once that changes.
   * Local only (never synced).
   */
  taxonReview?: TaxonReview | null
  /** Present once the collector asks to share this record to iNaturalist. */
  inat?: InatShare
  focusScore: number | null
  status: SyncStatus
  syncStep: SyncStep
  attempts: number
  /** Epoch ms before which the engine must not retry (backoff). */
  nextAttemptAt: number
  lastError: string | null
  clientMeta: Record<string, unknown>
}

/** An iNaturalist taxon (also the shape of the on-device taxon cache). */
export interface Taxon {
  id: number
  name: string
  rank: string
  commonName?: string | null
  /** e.g. 'Actinopterygii', 'Plantae'; for display only. */
  iconic?: string | null
}

export interface TaxonReview {
  for: string
  /**
   * Best matches, best first; empty = iNaturalist has nothing close.
   * `matched` is the name iNaturalist matched (scientific, synonym or common).
   */
  candidates: (Taxon & { matched?: string })[]
  /** The collector chose to keep the name as typed. */
  kept?: boolean
}

/** A cached taxon, indexed by the lower-case words of its names. */
export interface CachedTaxon extends Taxon {
  terms: string[]
  usedAt: number
}

export type InatGeoprivacy = 'open' | 'obscured' | 'private'

/** Optional sharing of a record to iNaturalist (see src/inat/share.ts). */
export interface InatShare {
  status: 'queued' | 'sharing' | 'shared' | 'error'
  /** Client-generated observation UUID: lets a retry find a half-done share. */
  uuid: string
  geoprivacy: InatGeoprivacy
  observationId: number | null
  /** Local photo ids already attached to the observation. */
  sharedPhotoIds: string[]
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

export interface LocalPhoto {
  /** Client-generated UUID; the photo PK on the server. */
  id: string
  recordId: string
  /** Null for photos pulled from the server; displayed via `storagePath`. */
  blob: Blob | null
  /** Storage path of a server-only photo (records captured on another device). */
  storagePath?: string
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
  taxa!: EntityTable<CachedTaxon, 'id'>

  constructor(name = 'specimap') {
    super(name)
    this.version(1).stores({
      records: 'id, tagId, status, capturedAt, nextAttemptAt',
      photos: 'id, recordId, uploaded',
      tagCache: 'id',
      meta: 'key',
    })
    // v2: on-device cache of iNaturalist taxa for offline species lookup.
    this.version(2).stores({
      taxa: 'id, *terms, usedAt',
    })
  }
}

export const db = new SpeciMapDB()
