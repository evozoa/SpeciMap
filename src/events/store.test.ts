import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB } from '../db/schema'
import { endEvent, getActiveEvent, nextFieldNumber, openFieldSheet, resumeEvent, ACTIVE_HOURS } from './store'

let n = 0
const fresh = () => new SpeciMapDB(`events-${++n}`)
const when = new Date('2026-11-16T15:00:00.000Z')

describe('nextFieldNumber', () => {
  it('continues the collector\'s sequence for the year', () => {
    expect(nextFieldNumber('MWS', ['MWS 26-001', 'MWS 26-014', 'MWS 25-090', 'other'], when)).toBe('MWS 26-015')
    expect(nextFieldNumber('MWS', [], when)).toBe('MWS 26-001')
    expect(nextFieldNumber('', ['26-007'], when)).toBe('26-008')
  })
})

describe('field sheets', () => {
  const input = { tagId: 'FS000001X', userId: 'me', recordedBy: ' A. Collector ', fieldNumberPrefix: 'MWS' }

  it('creates the event on first scan, numbers it, and makes it active', async () => {
    const db = fresh()
    const e = await openFieldSheet(input, db, when)
    expect(e).toMatchObject({ id: 'FS000001X', tagId: 'FS000001X', fieldNumber: 'MWS 26-001', recordedBy: 'A. Collector', status: 'queued' })
    expect((await getActiveEvent(db, when.getTime()))?.id).toBe('FS000001X')

    const second = await openFieldSheet({ ...input, tagId: 'FS000002X' }, db, when)
    expect(second.fieldNumber).toBe('MWS 26-002')
  })

  it('reopens an existing event instead of creating another', async () => {
    const db = fresh()
    await openFieldSheet(input, db, when)
    const again = await openFieldSheet(input, db, when)
    expect(again.fieldNumber).toBe('MWS 26-001')
    expect(await db.events.count()).toBe(1)
  })

  it('stops being active when ended or after too long', async () => {
    const db = fresh()
    await openFieldSheet(input, db, when)
    expect(await getActiveEvent(db, when.getTime() + (ACTIVE_HOURS + 1) * 3_600_000)).toBeNull()
    await endEvent('FS000001X', db, when)
    expect(await getActiveEvent(db, when.getTime())).toBeNull()
    expect((await db.events.get('FS000001X'))?.eventEnd).toBe(when.toISOString())
    await resumeEvent('FS000001X', db, when)
    expect((await getActiveEvent(db, when.getTime()))?.eventEnd).toBeNull()
  })
})
