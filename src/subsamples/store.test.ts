import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB } from '../db/schema'
import { blankEvent } from '../events/store'
import { capture } from '../test/fixtures'
import { createSubsample, describeSubsample, updateSubsample } from './store'

let n = 0
const fresh = () => new SpeciMapDB(`subs-${++n}`)
const base = { tagId: 'TUBE00001', parentTagId: 'SPEC00001', createdBy: 'me', eventId: 'EVENT0001', sampleType: ' Fin clip ', preservation: '95% ethanol', remarks: '' }

describe('subsamples', () => {
  it('creates a subsample linked to its specimen and queues it', async () => {
    const db = fresh()
    const at = new Date('2026-11-17T15:00:00.000Z')
    await createSubsample(base, db, at)
    expect(await db.subsamples.get('TUBE00001')).toMatchObject({
      parentTagId: 'SPEC00001',
      eventId: 'EVENT0001',
      sampleType: 'Fin clip',
      collectedAt: at.toISOString(),
      status: 'queued',
    })
    expect(describeSubsample({ sampleType: 'Fin clip', preservation: '95% ethanol' })).toBe('Fin clip, 95% ethanol')
  })

  it('refuses a tag that already has another rank, or a bad parent', async () => {
    const db = fresh()
    await db.records.add(capture('SPEC00001'))
    await db.events.add(blankEvent('EVENT0001', 'me'))
    await expect(createSubsample({ ...base, tagId: 'SPEC00001', parentTagId: 'SPEC00002' }, db)).rejects.toThrow(/already a specimen/)
    await expect(createSubsample({ ...base, tagId: 'EVENT0001' }, db)).rejects.toThrow(/already a collecting event/)
    await expect(createSubsample({ ...base, parentTagId: 'TUBE00001' }, db)).rejects.toThrow(/itself/)
    await expect(createSubsample({ ...base, parentTagId: 'EVENT0001' }, db)).rejects.toThrow(/collecting event, not a specimen/)
    await createSubsample(base, db)
    await expect(createSubsample(base, db)).rejects.toThrow(/already a subsample/)
    await expect(createSubsample({ ...base, tagId: 'TUBE00002', parentTagId: 'TUBE00001' }, db)).rejects.toThrow(/subsample, not a specimen/)
  })

  it('re-queues a synced subsample when edited', async () => {
    const db = fresh()
    await createSubsample(base, db)
    await db.subsamples.update('TUBE00001', { status: 'synced' })
    await updateSubsample('TUBE00001', { preservation: 'RNAlater' }, db)
    expect(await db.subsamples.get('TUBE00001')).toMatchObject({ preservation: 'RNAlater', status: 'queued' })
  })
})
