/**
 * Capture-flow persistence: the photo goes into IndexedDB the moment the
 * shutter fires (as a draft), so accidental back-navigation can never lose
 * it. Saving finalizes the draft into a queued record and kicks sync.
 */
import { db, type LocalPhoto, type LocalRecord, type SyncStep } from './schema'
import { STEP_ORDER } from '../sync/engine'

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
  species?: string
  focusScore: number | null
}

export async function finalizeRecord(input: FinalizeInput): Promise<LocalRecord> {
  const record: LocalRecord = {
    ...input,
    species: input.species?.trim() ?? '',
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

/** Join note texts, skipping blanks and exact repeats. */
export function joinNotes(...notes: string[]): string {
  const parts: string[] = []
  for (const n of notes.map((n) => n.trim())) {
    if (n && !parts.includes(n)) parts.push(n)
  }
  return parts.join('\n')
}

/**
 * Rescanning an already-recorded tag adds to that record instead of making a
 * second one: the draft's photos move onto it, notes are appended, and its
 * original capture time and location are kept. A species name, if given,
 * replaces the record's (a blank one keeps it). The record is requeued so the
 * new photos, notes and species upload.
 */
export async function appendToRecord(
  targetId: string,
  draftId: string,
  notes: string,
  species = '',
): Promise<void> {
  await db.transaction('rw', db.records, db.photos, async () => {
    const target = await db.records.get(targetId)
    if (!target) throw new Error('Record to add to no longer exists')
    await db.photos.where('recordId').equals(draftId).modify({ recordId: targetId })
    const name = species.trim()
    await db.records.update(targetId, {
      ...(name ? { species: name } : {}),
      notes: joinNotes(target.notes, notes),
      status: 'queued',
      syncStep: 'upsert-specimen',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    })
  })
}

/** The earlier of two sync steps. */
function earlierStep(a: SyncStep, b: SyncStep): SyncStep {
  return STEP_ORDER.indexOf(a) <= STEP_ORDER.indexOf(b) ? a : b
}

/**
 * Set a record's species name. The edit is saved locally first; if the
 * record has already been uploaded it is requeued from the specimen step so
 * the change reaches the server. A record mid-upload is caught by the sync
 * engine's stale-snapshot check.
 */
export async function setSpecies(id: string, species: string): Promise<void> {
  const value = species.trim()
  await db.transaction('rw', db.records, async () => {
    const record = await db.records.get(id)
    if (!record) throw new Error('Record no longer exists')
    if ((record.species ?? '') === value) return
    const changes: Partial<LocalRecord> = { species: value }
    if (record.status === 'synced') {
      Object.assign(changes, {
        status: 'queued',
        syncStep: 'upsert-specimen',
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      })
    } else if (record.status === 'queued' || record.status === 'error') {
      changes.syncStep = earlierStep(record.syncStep, 'upsert-specimen')
    }
    await db.records.update(id, changes)
  })
}

/** Distinct species names already used on this device, for suggestions. */
export async function knownSpecies(): Promise<string[]> {
  const names = new Set<string>()
  await db.records.each((r) => {
    const s = r.species?.trim()
    if (s) names.add(s)
  })
  return [...names].sort((a, b) => a.localeCompare(b))
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
