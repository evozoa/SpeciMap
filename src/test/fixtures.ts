/** Shared test data. */
import type { LocalRecord } from '../db/schema'

/** A saved capture of a tag, with overridable fields. */
export function capture(tagId: string, over: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId,
    collectorId: 'me',
    lat: 33.45,
    lng: -88.8,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-11-17T15:00:00.000Z',
    notes: '',
    focusScore: null,
    status: 'queued',
    syncStep: 'ensure-tag',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    ...over,
  }
}
