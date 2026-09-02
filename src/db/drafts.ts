/**
 * Capture-flow persistence: the photo goes into IndexedDB the moment the
 * shutter fires (as a draft), so accidental back-navigation can never lose
 * it. Saving finalizes the draft into a queued record and kicks sync.
 */
import { db, type LocalPhoto, type LocalRecord } from './schema'

export interface DraftPhotoInput {
  recordId: string
  blob: Blob
  width: number
  height: number
}

export async function addDraftPhoto(input: DraftPhotoInput): Promise<LocalPhoto> {
  const photo: LocalPhoto = {
    id: crypto.randomUUID(),
    recordId: input.recordId,
    blob: input.blob,
    width: input.width,
    height: input.height,
    bytes: input.blob.size,
    uploaded: 0,
  }
  await db.photos.add(photo)
  return photo
}

export interface FinalizeInput {
  id: string
  tagId: string
  collectorId: string
  lat: number
  lng: number
  gpsAccuracyM: number | null
  locationAdjusted: boolean
  capturedAt: string
  notes: string
  focusScore: number | null
}

export async function finalizeRecord(input: FinalizeInput): Promise<LocalRecord> {
  const record: LocalRecord = {
    ...input,
    status: 'queued',
    syncStep: 'ensure-tag',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {
      userAgent: navigator.userAgent,
      appVersion: __APP_VERSION__,
      online: navigator.onLine,
    },
  }
  await db.records.put(record)
  return record
}

export async function discardDraft(recordId: string): Promise<void> {
  await db.transaction('rw', db.records, db.photos, async () => {
    await db.photos.where('recordId').equals(recordId).delete()
    await db.records.delete(recordId)
  })
}

export async function pendingCount(): Promise<number> {
  return db.records.where('status').anyOf('queued', 'syncing', 'error').count()
}
