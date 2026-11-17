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

/**
 * One capture of a specimen: a collector's scan of a vial tag with photos,
 * GPS fix and identification. A specimen (dwc:MaterialEntity) is all the
 * captures of one tag; see LocalSpecimen and src/specimens/view.ts.
 * (Stored in the server's `specimens` table for historical reasons.)
 */
export interface LocalRecord {
  /** Client-generated UUID; the capture's PK on the server too (idempotent sync). */
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
  /** dwc:dateIdentified: when `species` was last set (ISO). */
  identifiedAt?: string
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
  /** dwc:eventID of the collecting event this capture was made during. */
  eventId?: string
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

/**
 * Specimen-level fields (dwc:MaterialEntity), keyed by the vial tag.
 * A row exists only once something was set or pulled; defaults otherwise.
 */
export interface LocalSpecimen {
  tagId: string
  /** dwc:individualCount; >1 when the tag is on a lot. */
  individualCount: number
  /** Captures confirmed to be this specimen (clears "possible tag reuse"). */
  confirmedCaptureIds: string[]
  /** 1 = changed here, not yet on the server. */
  dirty: 0 | 1
}

/**
 * A collecting event (dwc:Event). Field-sheet events use the sheet's QR tag
 * as `id` (dwc:eventID). Location terms are set on the event so they're
 * entered once per site, not once per specimen.
 */
export interface LocalEvent {
  id: string
  tagId: string | null
  parentEventId: string | null
  createdBy: string
  fieldNumber: string
  recordedBy: string
  /** Start (ISO); `eventEnd` closes the dwc:eventDate interval. */
  eventDate: string
  eventEnd: string | null
  decimalLatitude: number | null
  decimalLongitude: number | null
  coordinateUncertaintyInMeters: number | null
  locality: string
  waterBody: string
  county: string
  stateProvince: string
  countryCode: string
  samplingProtocol: string
  samplingEffort: string
  habitat: string
  eventRemarks: string
  /** Bumped on every local edit; lets sync detect edits made mid-upload. */
  updatedAt: string
  status: 'queued' | 'syncing' | 'synced' | 'error'
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

/** A photo of the completed field sheet (dwc:fieldNotes). */
export interface LocalEventPhoto {
  id: string
  eventId: string
  blob: Blob | null
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
  /** The printed format (e.g. 'insert_2ml', 'fieldsheet'); suggests a rank. */
  format?: string | null
}

/**
 * A subsample (dwc:MaterialSample) taken from a specimen, e.g. a fin clip in
 * a 2 mL tube, keyed by its own tag. Any tag can be a subsample: the rank is
 * chosen when the tag is first scanned (src/tags/rank.ts).
 */
export interface LocalSubsample {
  tagId: string
  /** The specimen's tag (its dwc:materialEntityID). */
  parentTagId: string
  createdBy: string
  eventId: string | null
  sampleType: string
  preservation: string
  remarks: string
  collectedAt: string
  updatedAt: string
  status: 'queued' | 'syncing' | 'synced' | 'error'
  attempts: number
  nextAttemptAt: number
  lastError: string | null
}

/**
 * A location check: a rescan of a specimen or subsample tag after it was
 * collected, logging where and when it was seen. Never a capture, so it
 * doesn't change the collection record or count as tag reuse.
 */
export interface LocalScan {
  id: string
  tagId: string
  scannedBy: string
  scannedAt: string
  /** Null until the phone gets a GPS fix (or if it never does). */
  lat: number | null
  lng: number | null
  gpsAccuracyM: number | null
  /** Typed by the collector, e.g. "Range 4, shelf B". */
  place: string
  /** Removed by the collector; kept until the removal reaches the server. */
  deleted?: boolean
  updatedAt: string
  status: 'queued' | 'syncing' | 'synced' | 'error'
  attempts: number
  nextAttemptAt: number
  lastError: string | null
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
  specimens!: EntityTable<LocalSpecimen, 'tagId'>
  events!: EntityTable<LocalEvent, 'id'>
  eventPhotos!: EntityTable<LocalEventPhoto, 'id'>
  subsamples!: EntityTable<LocalSubsample, 'tagId'>
  scans!: EntityTable<LocalScan, 'id'>

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
    // v3: specimen-level fields, one row per vial tag.
    this.version(3).stores({
      specimens: 'tagId, dirty',
    })
    // v4: collecting events (field sheets) and their photos.
    this.version(4).stores({
      events: 'id, eventDate, status',
      eventPhotos: 'id, eventId, uploaded',
      records: 'id, tagId, status, capturedAt, nextAttemptAt, eventId',
    })
    // v5: subsamples (any tag can be one; rank chosen on first scan).
    this.version(5).stores({
      subsamples: 'tagId, parentTagId, status',
    })
    // v6: location checks (rescans after collection).
    this.version(6).stores({
      scans: 'id, tagId, status, scannedAt',
    })
  }
}

export const db = new SpeciMapDB()
