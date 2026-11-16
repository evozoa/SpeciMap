import { describe, expect, it } from 'vitest'
import type { LocalRecord } from '../db/schema'
import type { ExportPrefs } from '../lib/prefs'
import {
  MULTIMEDIA_COLUMNS,
  OCCURRENCE_COLUMNS,
  classificationFrom,
  localIso,
  multimediaRows,
  occurrenceRow,
  photoFileName,
  toCsv,
} from './dwc'

const prefs: ExportPrefs = {
  institutionCode: 'AUM',
  collectionCode: 'Fishes',
  basisOfRecord: 'HumanObservation',
  license: 'CC-BY-4.0',
  recordedBy: 'A. Collector',
}

function rec(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    tagId: '7Q4MK2XRC',
    collectorId: 'user-1',
    lat: 33.4501234,
    lng: -88.7909876,
    gpsAccuracyM: 6.4,
    locationAdjusted: false,
    // 7:30 pm CST on Nov 1 is already Nov 2 in UTC
    capturedAt: '2026-11-02T01:30:00.000Z',
    notes: 'riffle, seine haul 3',
    species: 'Notropis texanus',
    taxon: { id: 1545618, name: 'Alburnops texanus', rank: 'species' },
    focusScore: null,
    status: 'synced',
    syncStep: 'done',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    clientMeta: {},
    ...overrides,
  }
}

const CST = 360 // getTimezoneOffset() minutes for UTC-6

describe('localIso', () => {
  it('writes local time with its offset, so evening dates stay on the right day', () => {
    expect(localIso('2026-11-02T01:30:00.000Z', CST)).toEqual({
      iso: '2026-11-01T19:30:00-06:00',
      y: 2026,
      m: 11,
      d: 1,
    })
    expect(localIso('2026-06-01T12:00:00.000Z', -330).iso).toBe('2026-06-01T17:30:00+05:30')
  })
})

describe('occurrenceRow', () => {
  it('maps a photo voucher record to Darwin Core', () => {
    const photos = [0, 1].map((i) => ({
      fileName: photoFileName('7Q4MK2XRC', i),
      width: 4032,
      height: 3024,
      fullRes: true,
    }))
    const row = occurrenceRow(
      {
        record: rec({ inat: { status: 'shared', uuid: 'u', geoprivacy: 'obscured', observationId: 99, sharedPhotoIds: [], attempts: 0, nextAttemptAt: 0, lastError: null } }),
        photos,
        classification: classificationFrom([
          { rank: 'kingdom', name: 'Animalia' },
          { rank: 'family', name: 'Leuciscidae' },
          { rank: 'genus', name: 'Alburnops' },
        ]),
      },
      prefs,
      CST,
    )
    expect(row).toMatchObject({
      occurrenceID: 'urn:uuid:11111111-2222-3333-4444-555555555555',
      basisOfRecord: 'HumanObservation',
      institutionCode: 'AUM',
      catalogNumber: '',
      materialEntityID: 'SpeciMap:7Q4MK2XRC',
      fieldNumber: '',
      otherCatalogNumbers: 'SpeciMap:7Q4MK2XRC',
      eventDate: '2026-11-01T19:30:00-06:00',
      day: '1',
      decimalLatitude: '33.450123',
      decimalLongitude: '-88.790988',
      geodeticDatum: 'WGS84',
      coordinateUncertaintyInMeters: '6',
      scientificName: 'Notropis texanus',
      taxonID: 'https://www.inaturalist.org/taxa/1545618',
      taxonRemarks: 'Matched to iNaturalist taxon Alburnops texanus',
      kingdom: 'Animalia',
      family: 'Leuciscidae',
      genus: 'Alburnops',
      identifiedBy: 'A. Collector',
      preparations: 'photograph',
      associatedMedia: '7Q4MK2XRC_1.jpg | 7Q4MK2XRC_2.jpg',
      associatedReferences: 'https://www.inaturalist.org/observations/99',
      occurrenceRemarks: 'riffle, seine haul 3',
    })
    expect(Object.keys(row)).toEqual([...OCCURRENCE_COLUMNS])
  })

  it('handles records without a name, taxon, accuracy or photos', () => {
    const row = occurrenceRow(
      { record: rec({ species: '', taxon: null, gpsAccuracyM: null, locationAdjusted: true }), photos: [] },
      { ...prefs, basisOfRecord: 'PreservedSpecimen' },
      CST,
    )
    expect(row).toMatchObject({
      scientificName: '',
      taxonID: '',
      taxonRemarks: '',
      identifiedBy: '',
      coordinateUncertaintyInMeters: '',
      georeferenceRemarks: 'Position adjusted by hand on a map',
      preparations: '',
      associatedMedia: '',
    })
  })

  it('flags names that were never matched', () => {
    const row = occurrenceRow({ record: rec({ species: 'Cyprinella sp.', taxon: null }), photos: [] }, prefs, CST)
    expect(row.taxonRemarks).toBe('Name not matched to iNaturalist')
  })
})

describe('multimediaRows', () => {
  it('lists each photo with license and resolution', () => {
    const rows = multimediaRows(
      {
        record: rec(),
        photos: [{ fileName: '7Q4MK2XRC_1.jpg', width: 2048, height: 1536, fullRes: false }],
      },
      prefs,
      CST,
    )
    expect(rows).toEqual([
      {
        occurrenceID: 'urn:uuid:11111111-2222-3333-4444-555555555555',
        type: 'StillImage',
        format: 'image/jpeg',
        identifier: '7Q4MK2XRC_1.jpg',
        title: '7Q4M-K2XR-C photo 1',
        description: '2048 x 1536 px; reduced to 2048 px long edge',
        created: '2026-11-01T19:30:00-06:00',
        creator: 'A. Collector',
        license: 'https://creativecommons.org/licenses/by/4.0/',
        rightsHolder: 'A. Collector',
      },
    ])
    expect(Object.keys(rows[0])).toEqual([...MULTIMEDIA_COLUMNS])
  })
})

describe('toCsv', () => {
  it('quotes only cells that need it', () => {
    const csv = toCsv(['a', 'b'] as const, [
      { a: 'plain', b: 'has, comma' },
      { a: 'say "hi"', b: 'two\nlines' },
    ])
    expect(csv).toBe('a,b\r\nplain,"has, comma"\r\n"say ""hi""","two\nlines"\r\n')
  })
})
