/**
 * Uploads collecting events and their field-sheet photos, and pulls events
 * made on the collector's other devices. Same guarantees as the capture
 * sync: idempotent upserts by ID, deterministic photo paths, backoff, and an
 * event edited mid-upload is sent again.
 */
import type { LocalEvent, LocalEventPhoto, SpeciMapDB } from '../db/schema'
import { TerminalSyncError } from '../sync/engine'

export interface RemoteEvent {
  id: string
  tag_id: string | null
  parent_event_id: string | null
  created_by: string
  field_number: string | null
  recorded_by: string | null
  event_date: string
  event_end: string | null
  decimal_latitude: number | null
  decimal_longitude: number | null
  coordinate_uncertainty_in_meters: number | null
  locality: string | null
  water_body: string | null
  county: string | null
  state_province: string | null
  country_code: string | null
  sampling_protocol: string | null
  sampling_effort: string | null
  habitat: string | null
  event_remarks: string | null
  updated_at: string
  event_photos: { id: string; storage_path: string; width: number | null; height: number | null; bytes: number | null }[]
}

export interface EventTransport {
  upsertEvent(e: LocalEvent): Promise<void>
  uploadPhoto(e: LocalEvent, p: LocalEventPhoto): Promise<void>
  upsertPhotoRow(e: LocalEvent, p: LocalEventPhoto): Promise<void>
  fetchAll(): Promise<RemoteEvent[]>
}

const text = (v: string | null) => v ?? ''

export function eventRow(e: LocalEvent) {
  const t = (v: string) => v.trim() || null
  return {
    id: e.id,
    tag_id: e.tagId,
    parent_event_id: e.parentEventId,
    created_by: e.createdBy,
    field_number: t(e.fieldNumber),
    recorded_by: t(e.recordedBy),
    event_date: e.eventDate,
    event_end: e.eventEnd,
    decimal_latitude: e.decimalLatitude,
    decimal_longitude: e.decimalLongitude,
    coordinate_uncertainty_in_meters: e.coordinateUncertaintyInMeters,
    locality: t(e.locality),
    water_body: t(e.waterBody),
    county: t(e.county),
    state_province: t(e.stateProvince),
    country_code: t(e.countryCode),
    sampling_protocol: t(e.samplingProtocol),
    sampling_effort: t(e.samplingEffort),
    habitat: t(e.habitat),
    event_remarks: t(e.eventRemarks),
    updated_at: e.updatedAt,
  }
}

export function fromRemote(r: RemoteEvent): LocalEvent {
  return {
    id: r.id,
    tagId: r.tag_id,
    parentEventId: r.parent_event_id,
    createdBy: r.created_by,
    fieldNumber: text(r.field_number),
    recordedBy: text(r.recorded_by),
    eventDate: new Date(r.event_date).toISOString(),
    eventEnd: r.event_end ? new Date(r.event_end).toISOString() : null,
    decimalLatitude: r.decimal_latitude,
    decimalLongitude: r.decimal_longitude,
    coordinateUncertaintyInMeters: r.coordinate_uncertainty_in_meters,
    locality: text(r.locality),
    waterBody: text(r.water_body),
    county: text(r.county),
    stateProvince: text(r.state_province),
    countryCode: text(r.country_code),
    samplingProtocol: text(r.sampling_protocol),
    samplingEffort: text(r.sampling_effort),
    habitat: text(r.habitat),
    eventRemarks: text(r.event_remarks),
    updatedAt: new Date(r.updated_at).toISOString(),
    status: 'synced',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
  }
}

export interface EventSyncOptions {
  baseDelayMs?: number
  maxDelayMs?: number
  now?: () => number
}

export class EventSyncRunner {
  private running: Promise<void> | null = null

  constructor(
    private db: SpeciMapDB,
    private transport: EventTransport,
    private opts: EventSyncOptions = {},
  ) {}

  kick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null
    })
    return this.running
  }

  /** Upload one event now (used before a capture that references it). */
  async pushOne(id: string): Promise<void> {
    const e = await this.db.events.get(id)
    if (e) await this.transport.upsertEvent(e)
  }

  private async pass(): Promise<void> {
    const now = this.opts.now ?? Date.now
    await this.db.events.where('status').equals('syncing').modify({ status: 'queued' })
    const due = await this.db.events
      .where('status')
      .equals('queued')
      .filter((e) => e.nextAttemptAt <= now())
      .toArray()
    for (const e of due) await this.syncOne(e)
  }

  private async syncOne(e: LocalEvent): Promise<void> {
    const now = this.opts.now ?? Date.now
    await this.db.events.update(e.id, { status: 'syncing' })
    try {
      await this.transport.upsertEvent(e)
      const photos = await this.db.eventPhotos.where('eventId').equals(e.id).toArray()
      for (const p of photos.filter((p) => !p.uploaded)) {
        await this.transport.uploadPhoto(e, p)
        await this.transport.upsertPhotoRow(e, p)
        await this.db.eventPhotos.update(p.id, { uploaded: 1 })
      }
      await this.db.transaction('rw', this.db.events, async () => {
        const fresh = await this.db.events.get(e.id)
        if (!fresh) return
        const edited = fresh.updatedAt !== e.updatedAt
        await this.db.events.update(e.id, {
          status: edited ? 'queued' : 'synced',
          attempts: 0,
          nextAttemptAt: 0,
          lastError: null,
        })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof TerminalSyncError) {
        await this.db.events.update(e.id, { status: 'error', lastError: message })
        return
      }
      const attempts = e.attempts + 1
      const base = this.opts.baseDelayMs ?? 60_000
      const cap = this.opts.maxDelayMs ?? 3_600_000
      await this.db.events.update(e.id, {
        status: 'queued',
        attempts,
        nextAttemptAt: now() + Math.min(base * 2 ** (attempts - 1), cap),
        lastError: message,
      })
    }
  }

  /** Adds events from other devices; refreshes ones with nothing to upload. */
  async pull(): Promise<void> {
    const remote = await this.transport.fetchAll()
    await this.db.transaction('rw', this.db.events, this.db.eventPhotos, async () => {
      const local = await this.db.events.bulkGet(remote.map((r) => r.id))
      await this.db.events.bulkPut(
        remote.filter((_, i) => !local[i] || local[i]!.status === 'synced').map(fromRemote),
      )
      const photos = remote.flatMap((r) => r.event_photos.map((p) => ({ eventId: r.id, p })))
      const have = await this.db.eventPhotos.bulkGet(photos.map(({ p }) => p.id))
      await this.db.eventPhotos.bulkAdd(
        photos
          .filter((_, i) => !have[i])
          .map(({ eventId, p }) => ({
            id: p.id,
            eventId,
            blob: null,
            storagePath: p.storage_path,
            width: p.width ?? 0,
            height: p.height ?? 0,
            bytes: p.bytes ?? 0,
            uploaded: 1 as const,
          })),
      )
    })
  }
}
