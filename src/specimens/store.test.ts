import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { SpeciMapDB, type LocalRecord } from '../db/schema'
import {
  confirmSameSpecimen,
  moveCaptureToTag,
  pullSpecimens,
  pushSpecimens,
  setComposition,
  setIndividualCount,
  setKind,
  setParentLot,
  type RemoteMaterialEntity,
  type SpecimenTransport,
} from './store'

let n = 0
const fresh = () => new SpeciMapDB(`specimens-${++n}`)

function cap(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: crypto.randomUUID(),
    tagId: '7Q4MK2XRC',
    collectorId: 'me',
    lat: 1,
    lng: 2,
    gpsAccuracyM: 5,
    locationAdjusted: false,
    capturedAt: '2026-11-01T15:00:00.000Z',
    notes: '',
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

describe('specimen edits', () => {
  it('records the individual count and confirmed captures as pending changes', async () => {
    const db = fresh()
    await setIndividualCount('T1', 12.7, db)
    await confirmSameSpecimen('T1', ['a', 'b'], db)
    await confirmSameSpecimen('T1', ['b', 'c'], db)
    expect(await db.specimens.get('T1')).toEqual({
      tagId: 'T1',
      individualCount: 12,
      confirmedCaptureIds: ['a', 'b', 'c'],
      dirty: 1,
    })
    await setIndividualCount('T1', 0, db)
    expect((await db.specimens.get('T1'))?.individualCount).toBe(1)
  })
})

describe('moveCaptureToTag', () => {
  it('moves a reused-tag capture and re-uploads it from the tag step', async () => {
    const db = fresh()
    const r = cap()
    await db.records.add(r)
    // the module's own db is the default; pass ours explicitly
    await moveCaptureToTag(r.id, 'EAANEGW67', db)
    expect(await db.records.get(r.id)).toMatchObject({
      tagId: 'EAANEGW67',
      status: 'queued',
      syncStep: 'ensure-tag',
    })
  })
})

describe('specimen sync', () => {
  function transport(rows: RemoteMaterialEntity[]) {
    const known = new Set(rows.map((r) => r.tag_id))
    const t: SpecimenTransport = {
      update: vi.fn(async (s) => known.has(s.tagId)),
      fetchAll: vi.fn(async () => rows),
    }
    return t
  }

  it('pushes edits once the server has the specimen, keeping them pending until then', async () => {
    const db = fresh()
    await setIndividualCount('KNOWN', 5, db)
    await setIndividualCount('NOT_YET', 3, db)
    const t = transport([{ tag_id: 'KNOWN', individual_count: 1, confirmed_capture_ids: [] }])
    await pushSpecimens(t, db)
    expect(t.update).toHaveBeenCalledTimes(2)
    expect((await db.specimens.get('KNOWN'))?.dirty).toBe(0)
    expect((await db.specimens.get('NOT_YET'))?.dirty).toBe(1)
  })

  it('pulls server values but never overwrites pending local edits', async () => {
    const db = fresh()
    await setIndividualCount('MINE', 7, db)
    await pullSpecimens(
      transport([
        { tag_id: 'MINE', individual_count: 2, confirmed_capture_ids: [] },
        { tag_id: 'OTHER', individual_count: 4, confirmed_capture_ids: ['x'] },
      ]),
      db,
    )
    expect((await db.specimens.get('MINE'))?.individualCount).toBe(7)
    expect(await db.specimens.get('OTHER')).toEqual({
      tagId: 'OTHER',
      individualCount: 4,
      confirmedCaptureIds: ['x'],
      kind: 'specimen',
      composition: [],
      parentTagId: null,
      custody: undefined,
      dirty: 0,
    })
  })

  it('pulls custody and mixed-lot fields, and drops rows no longer visible', async () => {
    const db = fresh()
    await pullSpecimens(transport([{ tag_id: 'GONE', individual_count: 1, confirmed_capture_ids: [] }]), db)
    await pullSpecimens(
      transport([
        {
          tag_id: 'LOT',
          individual_count: 15,
          confirmed_capture_ids: [],
          kind: 'mixed_lot',
          composition: [{ name: 'Notropis texanus', count: 12, taxon_id: 1, taxon_name: 'Alburnops texanus', taxon_rank: 'species' }, { name: 'Lepomis', count: 3 }],
          catalog_number: 'AUM 12345',
          custodian_user: null,
          custodian_org: 'org-1',
          visibility: 'public',
          generalize_public: true,
        },
      ]),
      db,
    )
    expect(await db.specimens.get('GONE')).toBeUndefined()
    expect(await db.specimens.get('LOT')).toMatchObject({
      kind: 'mixed_lot',
      composition: [{ name: 'Notropis texanus', count: 12, taxon: { id: 1, name: 'Alburnops texanus' } }, { name: 'Lepomis', count: 3, taxon: null }],
      custody: { custodianOrg: 'org-1', visibility: 'public', catalogNumber: 'AUM 12345' },
    })
  })

  it('sets a mixed lot composition and its total count', async () => {
    const db = fresh()
    await setKind('LOT', 'mixed_lot', db)
    await setComposition('LOT', [{ name: ' Notropis texanus ', taxon: null, count: 12 }, { name: '', taxon: null, count: 5 }, { name: 'Lepomis', taxon: null, count: 3 }], db)
    expect(await db.specimens.get('LOT')).toMatchObject({ kind: 'mixed_lot', individualCount: 15, dirty: 1, composition: [{ name: 'Notropis texanus', count: 12 }, { name: 'Lepomis', count: 3 }] })
    await setParentLot('SORTED', 'LOT', db)
    expect((await db.specimens.get('SORTED'))?.parentTagId).toBe('LOT')
    expect(() => setParentLot('LOT', 'LOT', db)).toThrow(/itself/)
  })
})
