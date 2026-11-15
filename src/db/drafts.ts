/**
 * Capture-flow persistence: the photo goes into IndexedDB the moment the
 * shutter fires (as a draft), so accidental back-navigation can never lose
 * it. Saving finalizes the draft into a queued record and kicks sync.
 */
import {
  db,
  type InatGeoprivacy,
  type LocalPhoto,
  type LocalRecord,
  type SyncStep,
} from './schema'
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
    // New photos on a shared record go to its iNaturalist observation too.
    const inat =
      target.inat?.status === 'shared' && target.inat.uuid
        ? { inat: { ...target.inat, status: 'queued' as const, nextAttemptAt: 0 } }
        : {}
    await db.records.update(targetId, {
      ...inat,
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
    await db.records.update(id, serverEdit(record, { species: value }))
  })
}

/**
 * Changes to a record field that is mirrored on the server, plus whatever
 * sync bookkeeping makes the change reach it: a synced record is requeued
 * from the specimen step; a queued or failed one is rewound to it; a record
 * mid-upload is left to the engine's stale-snapshot check. Call inside a
 * transaction that read `record`.
 */
export function serverEdit(
  record: LocalRecord,
  changes: Partial<LocalRecord>,
): Partial<LocalRecord> {
  if (record.status === 'synced') {
    return {
      ...changes,
      status: 'queued',
      syncStep: 'upsert-specimen',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    }
  }
  if (record.status === 'queued' || record.status === 'error') {
    return { ...changes, syncStep: earlierStep(record.syncStep, 'upsert-specimen') }
  }
  return changes
}

/** Ask for a record to be shared to iNaturalist (sent when online). */
export async function requestInatShare(
  id: string,
  geoprivacy: InatGeoprivacy,
): Promise<void> {
  await db.transaction('rw', db.records, async () => {
    const record = await db.records.get(id)
    if (!record) throw new Error('Record no longer exists')
    if (record.inat && record.inat.status !== 'error') return
    await db.records.update(id, {
      inat: {
        status: 'queued',
        uuid: record.inat?.uuid || crypto.randomUUID(),
        geoprivacy: record.inat?.geoprivacy ?? geoprivacy,
        observationId: record.inat?.observationId ?? null,
        sharedPhotoIds: record.inat?.sharedPhotoIds ?? [],
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      },
    })
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
