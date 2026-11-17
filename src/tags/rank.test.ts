import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB } from '../db/schema'
import { capture } from '../test/fixtures'
import { blankEvent } from '../events/store'
import { createSubsample } from '../subsamples/store'
import {
  RECENT_SPECIMEN_MINUTES,
  cacheFormats,
  cachedFormat,
  rankForFormat,
  recentSpecimen,
  rememberLastSpecimen,
  suggestRank,
  tagRole,
} from './rank'

let n = 0
const fresh = () => new SpeciMapDB(`rank-${++n}`)


describe('tagRole', () => {
  it('reports what a tag already is, ignoring unsaved drafts', async () => {
    const db = fresh()
    await db.events.add(blankEvent('EVENT0001', 'me'))
    await db.records.bulkAdd([capture('SPEC00001'), capture('DRAFT0001', { status: 'draft' })])
    await createSubsample(
      { tagId: 'TUBE00001', parentTagId: 'SPEC00001', createdBy: 'me', eventId: null, sampleType: 'Fin clip', preservation: '', remarks: '' },
      db,
    )
    expect(await tagRole('EVENT0001', db)).toBe('event')
    expect(await tagRole('SPEC00001', db)).toBe('specimen')
    expect(await tagRole('TUBE00001', db)).toBe('subsample')
    expect(await tagRole('DRAFT0001', db)).toBeNull()
    expect(await tagRole('NEVER0001', db)).toBeNull()
  })
})

describe('suggestRank', () => {
  it('maps printed formats to their usual rank', () => {
    expect(rankForFormat('fieldsheet')).toBe('event')
    expect(rankForFormat('insert_2ml')).toBe('subsample')
    expect(rankForFormat('punch')).toBe('specimen')
    expect(rankForFormat(null)).toBeNull()
  })

  it('prefers the printed format, then a recent specimen', () => {
    expect(suggestRank('insert', 'SPEC00001', 'NEW000001')).toEqual({ rank: 'specimen', parentTagId: null })
    expect(suggestRank('insert_2ml', 'SPEC00001', 'NEW000001')).toEqual({ rank: 'subsample', parentTagId: 'SPEC00001' })
    expect(suggestRank(null, 'SPEC00001', 'NEW000001')).toEqual({ rank: 'subsample', parentTagId: 'SPEC00001' })
    expect(suggestRank(null, null, 'NEW000001')).toEqual({ rank: null, parentTagId: null })
    // A tag is never suggested as its own parent.
    expect(suggestRank(null, 'NEW000001', 'NEW000001')).toEqual({ rank: null, parentTagId: null })
  })

  it('remembers the last specimen for a while', async () => {
    const db = fresh()
    const at = new Date('2026-11-17T15:00:00.000Z')
    await rememberLastSpecimen('SPEC00001', db, at)
    expect(await recentSpecimen(db, at.getTime() + 60_000)).toBe('SPEC00001')
    expect(await recentSpecimen(db, at.getTime() + (RECENT_SPECIMEN_MINUTES + 1) * 60_000)).toBeNull()
  })

  it('caches formats of printed tags', async () => {
    const db = fresh()
    await cacheFormats([{ id: 'TUBE00001', batchId: 'b', seq: 1, format: 'insert_2ml' }], db)
    expect(await cachedFormat('TUBE00001', db)).toBe('insert_2ml')
    expect(await cachedFormat('OTHER0001', db)).toBeNull()
  })
})
