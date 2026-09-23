import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { db } from './schema'
import { appendToRecord, joinNotes } from './drafts'

describe('joinNotes', () => {
  it('skips blanks and repeats', () => {
    expect(joinNotes('', ' 15902 ', '15902', 'wing torn')).toBe('15902\nwing torn')
  })
})

describe('appendToRecord', () => {
  it('moves draft photos onto the record, appends notes, and requeues it', async () => {
    const target = crypto.randomUUID()
    const draft = crypto.randomUUID()
    await db.records.add({
      id: target,
      tagId: '7Q4MK2XRC',
      collectorId: 'user-1',
      lat: 1,
      lng: 2,
      gpsAccuracyM: 5,
      locationAdjusted: false,
      capturedAt: '2026-09-20T12:00:00.000Z',
      notes: 'first',
      focusScore: null,
      status: 'synced',
      syncStep: 'done',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      clientMeta: {},
    })
    await db.photos.add({
      id: crypto.randomUUID(),
      recordId: draft,
      blob: new Blob(['x']),
      width: 1,
      height: 1,
      bytes: 1,
      uploaded: 0,
    })

    await appendToRecord(target, draft, 'second')

    expect(await db.records.get(target)).toMatchObject({
      notes: 'first\nsecond',
      status: 'queued',
      syncStep: 'upsert-specimen',
      capturedAt: '2026-09-20T12:00:00.000Z',
      lat: 1,
    })
    expect(await db.photos.where('recordId').equals(target).count()).toBe(1)
    expect(await db.photos.where('recordId').equals(draft).count()).toBe(0)
  })
})
