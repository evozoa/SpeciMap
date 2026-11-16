/**
 * Collecting events (dwc:Event), started by scanning a field sheet's QR code.
 * Everything is local-first: an event is created and edited offline and
 * uploaded by the event sync runner (src/events/sync.ts).
 *
 * While an event is active, every new capture on this phone joins it.
 */
import { db as defaultDb, type LocalEvent, type SpeciMapDB } from '../db/schema'
import type { EncodedPhoto } from '../lib/image'

/** An event stays active this long after it was started, unless ended. */
export const ACTIVE_HOURS = 16

export interface ActiveEvent {
  id: string
  since: string
}

/**
 * The next field number for a collector: "<prefix> <yy>-<nnn>", one more
 * than the highest they've used this year with that prefix (e.g. MWS 26-015).
 * Without a prefix: "<yy>-<nnn>".
 */
export function nextFieldNumber(prefix: string, used: string[], when = new Date()): string {
  const yy = String(when.getFullYear()).slice(-2)
  const head = prefix.trim() ? `${prefix.trim()} ${yy}-` : `${yy}-`
  let max = 0
  for (const f of used) {
    if (!f.startsWith(head)) continue
    const n = parseInt(f.slice(head.length), 10)
    if (Number.isFinite(n)) max = Math.max(max, n)
  }
  return `${head}${String(max + 1).padStart(3, '0')}`
}

export function blankEvent(id: string, createdBy: string, now = new Date()): LocalEvent {
  return {
    id,
    tagId: id,
    parentEventId: null,
    createdBy,
    fieldNumber: '',
    recordedBy: '',
    eventDate: now.toISOString(),
    eventEnd: null,
    decimalLatitude: null,
    decimalLongitude: null,
    coordinateUncertaintyInMeters: null,
    locality: '',
    waterBody: '',
    county: '',
    stateProvince: '',
    countryCode: '',
    samplingProtocol: '',
    samplingEffort: '',
    habitat: '',
    eventRemarks: '',
    updatedAt: now.toISOString(),
    status: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }
}

export interface OpenSheetInput {
  tagId: string
  userId: string
  recordedBy: string
  fieldNumberPrefix: string
}

/**
 * Scanning a field sheet: opens its event, creating it the first time (with
 * the next field number), and makes it the active event.
 */
export async function openFieldSheet(
  input: OpenSheetInput,
  db: SpeciMapDB = defaultDb,
  now = new Date(),
): Promise<LocalEvent> {
  const event = await db.transaction('rw', db.events, async () => {
    const existing = await db.events.get(input.tagId)
    if (existing) return existing
    const mine = await db.events.filter((e) => e.createdBy === input.userId).toArray()
    const e: LocalEvent = {
      ...blankEvent(input.tagId, input.userId, now),
      recordedBy: input.recordedBy.trim(),
      fieldNumber: nextFieldNumber(input.fieldNumberPrefix, mine.map((m) => m.fieldNumber), now),
    }
    await db.events.add(e)
    return e
  })
  if (!event.eventEnd) await setActiveEvent(event.id, db, now)
  return event
}

/** Edit an event; it re-uploads (sync detects edits made mid-upload). */
export async function updateEvent(
  id: string,
  changes: Partial<LocalEvent>,
  db: SpeciMapDB = defaultDb,
): Promise<void> {
  await db.transaction('rw', db.events, async () => {
    const e = await db.events.get(id)
    if (!e) throw new Error('Event no longer exists')
    await db.events.update(id, {
      ...changes,
      updatedAt: new Date().toISOString(),
      ...(e.status === 'syncing' ? {} : { status: 'queued', attempts: 0, nextAttemptAt: 0, lastError: null }),
    })
  })
}

/** Fills in the event's coordinates from the first GPS fix, if not set. */
export async function setEventLocationIfMissing(
  id: string,
  fix: { lat: number; lng: number; accuracyM: number },
  db: SpeciMapDB = defaultDb,
): Promise<void> {
  const e = await db.events.get(id)
  if (!e || e.decimalLatitude != null) return
  await updateEvent(
    id,
    {
      decimalLatitude: fix.lat,
      decimalLongitude: fix.lng,
      coordinateUncertaintyInMeters: Math.round(fix.accuracyM),
    },
    db,
  )
}

export async function addEventPhoto(
  eventId: string,
  photo: EncodedPhoto,
  db: SpeciMapDB = defaultDb,
): Promise<void> {
  await db.eventPhotos.add({
    id: crypto.randomUUID(),
    eventId,
    blob: photo.blob,
    width: photo.width,
    height: photo.height,
    bytes: photo.blob.size,
    uploaded: 0,
  })
  await updateEvent(eventId, {}, db) // requeue so the photo uploads
}

// ---- Active event ----------------------------------------------------------

export async function setActiveEvent(id: string, db: SpeciMapDB = defaultDb, now = new Date()) {
  await db.meta.put({ key: 'activeEvent', value: { id, since: now.toISOString() } satisfies ActiveEvent })
}

/** The active event, unless it was ended or started too long ago. */
export async function getActiveEvent(db: SpeciMapDB = defaultDb, now = Date.now()): Promise<LocalEvent | null> {
  const active = (await db.meta.get('activeEvent'))?.value as ActiveEvent | undefined
  if (!active || now - Date.parse(active.since) > ACTIVE_HOURS * 3_600_000) return null
  const e = await db.events.get(active.id)
  return e && !e.eventEnd ? e : null
}

/** End an event: closes its time interval and stops new captures joining it. */
export async function endEvent(id: string, db: SpeciMapDB = defaultDb, now = new Date()) {
  await updateEvent(id, { eventEnd: now.toISOString() }, db)
  const active = (await db.meta.get('activeEvent'))?.value as ActiveEvent | undefined
  if (active?.id === id) await db.meta.delete('activeEvent')
}

/** Reopen an ended event (e.g. ended by mistake) and make it active. */
export async function resumeEvent(id: string, db: SpeciMapDB = defaultDb, now = new Date()) {
  await updateEvent(id, { eventEnd: null }, db)
  await setActiveEvent(id, db, now)
}
