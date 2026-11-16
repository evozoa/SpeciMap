import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'

vi.mock('../lib/supabase', () => ({ supabase: {}, PHOTO_BUCKET: 'photos' }))

import { db, type LocalRecord } from '../db/schema'
import { blankEvent } from '../events/store'
import { buildPackage } from './package'
import { specimenView } from '../specimens/view'

const prefs = {
  institutionCode: 'AUM',
  collectionCode: 'Fishes',
  basisOfRecord: 'HumanObservation' as const,
  license: 'CC0-1.0' as const,
  recordedBy: 'A. Collector',
}

function rec(tagId: string, taxonId?: number): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId,
    collectorId: 'user-1',
    lat: 33.45,
    lng: -88.79,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-11-01T15:00:00.000Z',
    notes: '',
    species: taxonId ? 'Lepomis megalotis' : '',
    taxon: taxonId ? { id: taxonId, name: 'Lepomis megalotis', rank: 'species' } : null,
    focusScore: null,
    status: 'synced',
    syncStep: 'done',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
  }
}

describe('buildPackage', () => {
  it('zips the Darwin Core tables, photos named by tag, and a README', async () => {
    const a = rec('7Q4MK2XRC', 58635)
    const b = rec('EAANEGW67')
    await db.records.bulkAdd([a, b])
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    for (const r of [a, a, b]) {
      await db.photos.add({ id: crypto.randomUUID(), recordId: r.id, blob: new Blob([jpeg]), width: 4032, height: 3024, bytes: 7, uploaded: 1 })
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [{ id: 58635, name: 'Lepomis megalotis', rank: 'species', ancestors: [{ rank: 'family', name: 'Centrarchidae' }, { rank: 'genus', name: 'Lepomis' }] }],
          }),
        ),
      ),
    )

    await db.events.add({ ...blankEvent('FS000001X', 'user-1'), fieldNumber: 'MWS 26-014' })
    await db.records.update(a.id, { eventId: 'FS000001X' })
    await db.eventPhotos.add({ id: 'p1', eventId: 'FS000001X', blob: new Blob([jpeg]), width: 1, height: 1, bytes: 7, uploaded: 1 })
    const result = await buildPackage(
      [specimenView([{ ...a, eventId: 'FS000001X' }]), specimenView([b])],
      prefs,
    )
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))

    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'fieldnotes/FS000001X_1.jpg',
      'multimedia.csv',
      'occurrence.csv',
      'photos/7Q4MK2XRC_1.jpg',
      'photos/7Q4MK2XRC_2.jpg',
      'photos/EAANEGW67_1.jpg',
    ])
    expect(files['photos/EAANEGW67_1.jpg']).toEqual(jpeg)
    const occ = strFromU8(files['occurrence.csv']).replace(/^﻿/, '').split('\r\n')
    expect(occ).toHaveLength(4) // header, 2 rows, trailing newline
    expect(occ[1]).toContain('Centrarchidae,Lepomis')
    expect(occ[1]).toContain('MWS 26-014')
    expect(occ[1]).toContain('fieldnotes/FS000001X_1.jpg')
    expect(occ[1]).toContain('7Q4MK2XRC_1.jpg | 7Q4MK2XRC_2.jpg')
    expect(strFromU8(files['multimedia.csv']).split('\r\n')).toHaveLength(5)
    expect(result.warnings).toEqual([])
    vi.unstubAllGlobals()
  })

  it('still exports when iNaturalist is unreachable, with a warning', async () => {
    const a = rec('7Q4MK2XRC', 58635)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const result = await buildPackage([specimenView([a])], prefs, { withPhotos: false })
    expect(result.fileName).toMatch(/\.csv$/)
    expect(result.warnings[0]).toMatch(/Offline/)
    vi.unstubAllGlobals()
  })
})
