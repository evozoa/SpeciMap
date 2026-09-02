/**
 * SyncTransport backed by Supabase. Every operation is idempotent:
 * - tags insert with ignoreDuplicates (ON CONFLICT DO NOTHING)
 * - specimen / photo rows upsert on their client-generated UUID PKs
 * - photo uploads overwrite a deterministic storage path
 */
import { PHOTO_BUCKET, supabase } from '../lib/supabase'
import type { LocalPhoto, LocalRecord } from '../db/schema'
import { TerminalSyncError, type SyncTransport } from './engine'

function photoPath(record: LocalRecord, photo: LocalPhoto): string {
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
