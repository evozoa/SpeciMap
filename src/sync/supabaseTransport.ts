/**
 * SyncTransport backed by Supabase. Every operation is idempotent:
 * - tags insert with ignoreDuplicates (ON CONFLICT DO NOTHING)
 * - specimen / photo rows upsert on their client-generated UUID PKs
 * - photo uploads overwrite a deterministic storage path
 */
import { PHOTO_BUCKET, supabase } from '../lib/supabase'
import type { LocalPhoto, LocalRecord } from '../db/schema'
import { TerminalSyncError, type SyncTransport } from './engine'
import type { RemoteSpecimen } from './pull'
import { compositionRow, type RemoteMaterialEntity, type SpecimenTransport } from '../specimens/store'
import { db } from '../db/schema'
import { eventRow, type EventTransport, type RemoteEvent } from '../events/sync'
import { scanRow, type RemoteScan, type ScanTransport } from '../scans/sync'
import { subsampleRow, type RemoteSubsample, type SubsampleTransport } from '../subsamples/sync'

function photoPath(record: LocalRecord, photo: LocalPhoto): string {
  if (photo.storagePath) return photo.storagePath
  return `${record.collectorId}/${record.id}/${photo.id}.jpg`
}

/**
 * Postgres error codes that will not fix themselves by retrying:
 * 42501 = insufficient_privilege (RLS denial), 23503 = foreign key,
 * 23514 = check constraint, 22xxx = data exceptions.
 */
function classify(error: { message: string; code?: string }): Error {
  const code = error.code ?? ''
  if (code === '42501' || code.startsWith('23') || code.startsWith('22')) {
    return new TerminalSyncError(`${code}: ${error.message}`)
  }
  return new Error(error.message)
}

export const supabaseTransport: SyncTransport = {
  async ensureTag(tagId) {
    const { error } = await supabase
      .from('tags')
      .upsert({ id: tagId }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw classify(error)
  },

  async ensureEvent(eventId) {
    const e = await db.events.get(eventId)
    if (!e) return // pulled capture of an event this device doesn't have
    await eventTransport.upsertEvent(e)
  },

  async upsertSpecimen(record) {
    const { error } = await supabase.from('specimens').upsert(
      {
        id: record.id,
        tag_id: record.tagId,
        collector_id: record.collectorId,
        lat: record.lat,
        lng: record.lng,
        gps_accuracy_m: record.gpsAccuracyM,
        location_adjusted: record.locationAdjusted,
        captured_at: record.capturedAt,
        notes: record.notes || null,
        event_id: record.eventId ?? null,
        species: record.species?.trim() || null,
        identified_at: record.species?.trim() ? (record.identifiedAt ?? record.capturedAt) : null,
        taxon_id: record.taxon?.id ?? null,
        taxon_name: record.taxon?.name ?? null,
        taxon_rank: record.taxon?.rank ?? null,
        inat_observation_id: record.inat?.observationId ?? null,
        focus_score: record.focusScore,
        client_meta: record.clientMeta,
      },
      { onConflict: 'id' },
    )
    if (error) throw classify(error)
  },

  async uploadPhoto(record, photo) {
    if (!photo.blob) throw new TerminalSyncError('Photo has no local image data')
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(photoPath(record, photo), photo.blob, {
        contentType: 'image/jpeg',
        upsert: true,
      })
    if (error) throw classify(error)
  },

  async upsertPhotoRow(record, photo) {
    const { error } = await supabase.from('specimen_photos').upsert(
      {
        id: photo.id,
        specimen_id: record.id,
        storage_path: photoPath(record, photo),
        width: photo.width,
        height: photo.height,
        bytes: photo.bytes,
      },
      { onConflict: 'id' },
    )
    if (error) throw classify(error)
  },
}

const PAGE_SIZE = 1000

export const eventTransport: EventTransport = {
  async upsertEvent(e) {
    const { error } = await supabase.from('events').upsert(eventRow(e), { onConflict: 'id' })
    if (error) throw classify(error)
  },

  async uploadPhoto(e, p) {
    if (!p.blob) throw new TerminalSyncError('Photo has no local image data')
    const path = p.storagePath ?? `${e.createdBy}/events/${e.id}/${p.id}.jpg`
    const { error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, p.blob, { contentType: 'image/jpeg', upsert: true })
    if (error) throw classify(error)
  },

  async upsertPhotoRow(e, p) {
    const { error } = await supabase.from('event_photos').upsert(
      {
        id: p.id,
        event_id: e.id,
        storage_path: p.storagePath ?? `${e.createdBy}/events/${e.id}/${p.id}.jpg`,
        width: p.width,
        height: p.height,
        bytes: p.bytes,
      },
      { onConflict: 'id' },
    )
    if (error) throw classify(error)
  },

  async fetchAll() {
    const all: RemoteEvent[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('events')
        .select('*, event_photos (id, storage_path, width, height, bytes)')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      all.push(...(data as RemoteEvent[]))
      if (data.length < PAGE_SIZE) return all
    }
  },
}

export const subsampleTransport: SubsampleTransport = {
  async upsert(s) {
    // Both tags must exist server-side; offline-printed or unregistered tags
    // take the same orphan-tag path as captures.
    const { error: tagErr } = await supabase
      .from('tags')
      .upsert([{ id: s.tagId }, { id: s.parentTagId }], { onConflict: 'id', ignoreDuplicates: true })
    if (tagErr) throw classify(tagErr)
    if (s.eventId) {
      const e = await db.events.get(s.eventId)
      if (e) await eventTransport.upsertEvent(e)
    }
    const { error } = await supabase
      .from('material_samples')
      .upsert(subsampleRow(s), { onConflict: 'tag_id' })
    if (error) throw classify(error)
  },

  async fetchAll() {
    const all: RemoteSubsample[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('material_samples')
        .select(
          'tag_id, parent_tag_id, created_by, event_id, sample_type, preservation, remarks, collected_at, updated_at, catalog_number, custodian_user, custodian_org, visibility, generalize_public',
        )
        .order('tag_id')
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      all.push(...(data as RemoteSubsample[]))
      if (data.length < PAGE_SIZE) return all
    }
  },
}

export const scanTransport: ScanTransport = {
  async upsert(s) {
    if (s.deleted) {
      const { error } = await supabase.from('tag_scans').delete().eq('id', s.id)
      if (error) throw classify(error)
      return
    }
    const { error: tagErr } = await supabase
      .from('tags')
      .upsert({ id: s.tagId }, { onConflict: 'id', ignoreDuplicates: true })
    if (tagErr) throw classify(tagErr)
    const { error } = await supabase.from('tag_scans').upsert(scanRow(s), { onConflict: 'id' })
    if (error) throw classify(error)
  },

  async fetchAll() {
    const all: RemoteScan[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('tag_scans')
        .select('id, tag_id, scanned_by, scanned_at, lat, lng, gps_accuracy_m, place, updated_at')
        .order('id')
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      all.push(...(data as RemoteScan[]))
      if (data.length < PAGE_SIZE) return all
    }
  },
}

/** The printed format of a tag (from its batch), or null if unknown. */
export async function fetchTagFormat(tagId: string): Promise<{ batchId: string | null; seq: number | null; format: string | null } | null> {
  const { data, error } = await supabase
    .from('tags')
    .select('batch_id, seq, tag_batches (format)')
    .eq('id', tagId)
    .maybeSingle()
  if (error || !data) return null
  const batch = data.tag_batches as unknown as { format: string } | { format: string }[] | null
  const format = Array.isArray(batch) ? (batch[0]?.format ?? null) : (batch?.format ?? null)
  return { batchId: data.batch_id, seq: data.seq, format }
}

export const specimenTransport: SpecimenTransport = {
  async update(s) {
    const { data, error } = await supabase
      .from('material_entities')
      .update({
        individual_count: s.individualCount,
        confirmed_capture_ids: s.confirmedCaptureIds,
        kind: s.kind ?? 'specimen',
        composition: compositionRow(s.composition),
        parent_tag_id: s.parentTagId ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('tag_id', s.tagId)
      .select('tag_id')
    if (error) throw new Error(error.message)
    return (data?.length ?? 0) > 0
  },

  async fetchAll() {
    const all: RemoteMaterialEntity[] = []
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('material_entities')
        .select(
          'tag_id, individual_count, confirmed_capture_ids, kind, composition, parent_tag_id, catalog_number, custodian_user, custodian_org, visibility, generalize_public',
        )
        .order('tag_id')
        .range(from, from + PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      all.push(...(data as RemoteMaterialEntity[]))
      if (data.length < PAGE_SIZE) return all
    }
  },
}

/**
 * Fetch every specimen of the signed-in collector (RLS scopes to their own).
 * Paged, because the pull deletes synced local records missing from this
 * list: it must be complete, never a server-capped first page.
 */
export async function fetchRemoteSpecimens(): Promise<RemoteSpecimen[]> {
  const all: RemoteSpecimen[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('specimens')
      .select(
        'id, tag_id, collector_id, lat, lng, gps_accuracy_m, location_adjusted, captured_at, notes, species, identified_at, event_id, taxon_id, taxon_name, taxon_rank, inat_observation_id, focus_score, client_meta, specimen_photos (id, storage_path, width, height, bytes)',
      )
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data as RemoteSpecimen[]))
    if (data.length < PAGE_SIZE) return all
  }
}
