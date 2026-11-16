import { describe, expect, it } from 'vitest'
import type { LocalRecord } from '../db/schema'
import type { ExportPrefs } from '../lib/prefs'
import { blankEvent } from '../events/store'
import { specimenView } from '../specimens/view'
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

let n = 0
function rec(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: `11111111-2222-3333-4444-55555555555${++n}`,
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
    identifiedAt: '2026-11-02T01:31:00.000Z',
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

const CST = () => 360 // getTimezoneOffset() minutes for UTC-6

describe('localIso', () => {
  it('writes local time with its offset, so evening dates stay on the right day', () => {
    expect(localIso('2026-11-02T01:30:00.000Z', 360)).toEqual({
      iso: '2026-11-01T19:30:00-06:00',
      y: 2026,
      m: 11,
      d: 1,
    })
    expect(localIso('2026-06-01T12:00:00.000Z', -330).iso).toBe('2026-06-01T17:30:00+05:30')
  })
})

describe('occurrenceRow', () => {
  it('maps a photo-vouchered specimen and its event to Darwin Core', () => {
    const photos = [0, 1].map((i) => ({
      fileName: photoFileName('7Q4MK2XRC', i),
      width: 4032,
      height: 3024,
      fullRes: true,
    }))
    const event = {
      ...blankEvent('FS000001X', 'user-1', new Date('2026-11-02T01:00:00.000Z')),
      eventEnd: '2026-11-02T03:00:00.000Z',
      fieldNumber: 'MWS 26-014',
      recordedBy: 'M. Collector | J. Helper',
      locality: 'Tibbee Creek at Hwy 50',
      waterBody: 'Tibbee Creek',
      county: 'Clay',
      stateProvince: 'Mississippi',
      countryCode: 'US',
      samplingProtocol: 'seine',
      habitat: 'riffle',
    }
    const specimen = specimenView([
      rec({
        eventId: 'FS000001X',
        inat: { status: 'shared', uuid: 'u', geoprivacy: 'obscured', observationId: 99, sharedPhotoIds: [], attempts: 0, nextAttemptAt: 0, lastError: null },
      }),
      rec({ capturedAt: '2026-11-02T01:40:00.000Z', notes: 'second phone' }),
    ])
    const row = occurrenceRow(
      {
        specimen,
        photos,
        event,
        fieldNotes: ['fieldnotes/FS000001X_1.jpg'],
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
      occurrenceID: 'https://specimap.org/specimen/7Q4MK2XRC',
      basisOfRecord: 'HumanObservation',
      institutionCode: 'AUM',
      catalogNumber: '',
      materialEntityID: 'SpeciMap:7Q4MK2XRC',
      otherCatalogNumbers: 'SpeciMap:7Q4MK2XRC',
      individualCount: '1',
      eventID: 'https://specimap.org/event/FS000001X',
      parentEventID: '',
      fieldNumber: 'MWS 26-014',
      recordedBy: 'M. Collector | J. Helper',
      eventDate: '2026-11-01T19:00:00-06:00/2026-11-01T21:00:00-06:00',
      day: '1',
      samplingProtocol: 'seine',
      fieldNotes: 'fieldnotes/FS000001X_1.jpg',
      countryCode: 'US',
      county: 'Clay',
      waterBody: 'Tibbee Creek',
      locality: 'Tibbee Creek at Hwy 50',
      decimalLatitude: '33.450123',
      decimalLongitude: '-88.790988',
      coordinateUncertaintyInMeters: '6',
      scientificName: 'Notropis texanus',
      taxonID: 'https://www.inaturalist.org/taxa/1545618',
      taxonRemarks: 'Matched to iNaturalist taxon Alburnops texanus',
      family: 'Leuciscidae',
      identifiedBy: 'A. Collector',
      dateIdentified: '2026-11-01T19:31:00-06:00',
      preparations: 'photograph',
      associatedMedia: '7Q4MK2XRC_1.jpg | 7Q4MK2XRC_2.jpg',
      associatedReferences: 'https://www.inaturalist.org/observations/99',
      occurrenceRemarks: 'riffle, seine haul 3 | second phone',
    })
    expect(Object.keys(row)).toEqual([...OCCURRENCE_COLUMNS])
  })

  it('handles specimens without an event, name, taxon, accuracy or photos', () => {
    const row = occurrenceRow(
      { specimen: specimenView([rec({ species: '', taxon: null, gpsAccuracyM: null, locationAdjusted: true })]), photos: [] },
      { ...prefs, basisOfRecord: 'PreservedSpecimen' },
      CST,
    )
    expect(row).toMatchObject({
      eventID: '',
      fieldNumber: '',
      recordedBy: 'A. Collector',
      eventDate: '2026-11-01T19:30:00-06:00',
      locality: '',
      scientificName: '',
      taxonID: '',
      taxonRemarks: '',
      identifiedBy: '',
      dateIdentified: '',
      coordinateUncertaintyInMeters: '',
      georeferenceRemarks: 'Position adjusted by hand on a map',
      preparations: '',
      associatedMedia: '',
    })
  })

  it('notes unmatched names and disagreeing identifications', () => {
    const row = occurrenceRow(
      {
        specimen: specimenView([
          rec({ species: 'Cyprinella sp.', taxon: null, identifiedAt: '2026-11-02T02:00:00.000Z' }),
          rec({ species: 'Cyprinella venusta', taxon: null, identifiedAt: '2026-11-02T01:00:00.000Z' }),
        ]),
        photos: [],
      },
      prefs,
      CST,
    )
    expect(row.scientificName).toBe('Cyprinella sp.')
    expect(row.taxonRemarks).toBe(
      'Name not matched to iNaturalist; Identifications disagree: Cyprinella sp. | Cyprinella venusta',
    )
  })
})

describe('multimediaRows', () => {
  it('lists each photo with license and resolution', () => {
    const rows = multimediaRows(
      {
        specimen: specimenView([rec()]),
        photos: [{ fileName: '7Q4MK2XRC_1.jpg', width: 2048, height: 1536, fullRes: false }],
      },
      prefs,
      CST,
    )
    expect(rows).toEqual([
      {
        occurrenceID: 'https://specimap.org/specimen/7Q4MK2XRC',
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
