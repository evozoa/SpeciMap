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
        'id, tag_id, collector_id, lat, lng, gps_accuracy_m, location_adjusted, captured_at, notes, focus_score, client_meta, specimen_photos (id, storage_path, width, height, bytes)',
      )
      .order('id')
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    all.push(...(data as RemoteSpecimen[]))
    if (data.length < PAGE_SIZE) return all
  }
}
