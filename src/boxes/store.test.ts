import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { SpeciMapDB } from '../db/schema'
import { capture } from '../test/fixtures'
import {
  POSITIONS,
  boxContents,
  canHold,
  createBox,
  describeStorage,
  getPacking,
  nextFreePosition,
  placeItem,
  positionsFor,
  removeFromBox,
  startPacking,
  stopPacking,
} from './store'

let n = 0
const fresh = () => new SpeciMapDB(`boxes-${++n}`)

describe('storage containers', () => {
  it('knows positions and what holds what', () => {
    expect(POSITIONS.slice(0, 3)).toEqual(['A1', 'A2', 'A3'])
    expect(POSITIONS).toHaveLength(100)
    expect(positionsFor({ size: 'rack', capacity: 12 })).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'])
    expect(nextFreePosition(['A1', 'A3'], 100)).toBe('A2')
    expect(nextFreePosition(['A1'], 1)).toBeNull()
    expect([canHold('2ml', null), canHold('2ml', '2ml'), canHold('rack', '2ml'), canHold('rack', 'carton'), canHold('shelf', 'rack'), canHold('shelf', null)]).toEqual([
      true, false, true, false, true, false,
    ])
  })

  it('packs items into the next free position, moves and removes them', async () => {
    const db = fresh()
    await db.records.add(capture('SPEC00001'))
    await createBox({ tagId: 'BOX000001', size: '2ml', label: 'Fin clips', createdBy: 'me' }, db)
    await createBox({ tagId: 'BOX000002', size: '2ml', label: '', createdBy: 'me', capacity: 2 }, db)
    const a = await placeItem({ itemTagId: 'TUBE00001', boxTagId: 'BOX000001', placedBy: 'me' }, db)
    const b = await placeItem({ itemTagId: 'TUBE00002', boxTagId: 'BOX000001', placedBy: 'me' }, db)
    const c = await placeItem({ itemTagId: 'TUBE00003', boxTagId: 'BOX000001', position: 'J10', placedBy: 'me' }, db)
    expect([a.position, b.position, c.position]).toEqual(['A1', 'A2', 'J10'])
    await expect(placeItem({ itemTagId: 'TUBE00004', boxTagId: 'BOX000001', position: 'A1', placedBy: 'me' }, db)).rejects.toThrow(/A1 already holds/)
    // The placement is logged in the item's location history.
    expect((await db.scans.get(a.scanId))?.place).toBe('Fin clips (BOX0-0000-1), A1')

    const moved = await placeItem({ itemTagId: 'TUBE00001', boxTagId: 'BOX000002', placedBy: 'me' }, db)
    expect(moved.previous).toEqual({ boxTagId: 'BOX000001', position: 'A1' })
    expect((await boxContents('BOX000001', db)).map((p) => p.itemTagId)).toEqual(['TUBE00002', 'TUBE00003'])
    await placeItem({ itemTagId: 'TUBE00004', boxTagId: 'BOX000002', placedBy: 'me' }, db)
    await expect(placeItem({ itemTagId: 'TUBE00005', boxTagId: 'BOX000002', placedBy: 'me' }, db)).rejects.toThrow(/full/)

    await removeFromBox('TUBE00002', db)
    expect((await boxContents('BOX000001', db)).map((p) => p.itemTagId)).toEqual(['TUBE00003'])
    expect(await db.placements.get('TUBE00002')).toMatchObject({ deleted: true, status: 'queued' })
  })

  it('nests boxes in racks on shelves, and refuses the wrong things', async () => {
    const db = fresh()
    await createBox({ tagId: 'BOX000001', size: '2ml', label: '', createdBy: 'me' }, db)
    await createBox({ tagId: 'RACK00001', size: 'rack', label: 'Freezer 2 rack A', createdBy: 'me' }, db)
    await createBox({ tagId: 'SH3F00001', size: 'shelf', label: '', createdBy: 'me' }, db)
    expect((await db.boxes.get('RACK00001'))?.capacity).toBe(12)
    await placeItem({ itemTagId: 'TUBE00001', boxTagId: 'BOX000001', placedBy: 'me' }, db)
    await placeItem({ itemTagId: 'BOX000001', boxTagId: 'RACK00001', position: '5', placedBy: 'me' }, db)
    await placeItem({ itemTagId: 'RACK00001', boxTagId: 'SH3F00001', placedBy: 'me' }, db)
    expect(await describeStorage('TUBE00001', db)).toBe('2 mL tube box BOX0-0000-1, A1 · Freezer 2 rack A (RACK-0000-1), no. 5 · Museum shelf SH3F-0000-1, no. 1')
    await expect(placeItem({ itemTagId: 'TUBE00002', boxTagId: 'RACK00001', placedBy: 'me' }, db)).rejects.toThrow(/Freezer rack holds only: 2 mL tube box, 20 mL vial box/)
    await expect(placeItem({ itemTagId: 'RACK00001', boxTagId: 'BOX000001', placedBy: 'me' }, db)).rejects.toThrow(/not other containers/)
    await expect(placeItem({ itemTagId: 'BOX000001', boxTagId: 'RACK00001', position: '13', placedBy: 'me' }, db)).rejects.toThrow(/No position 13/)
  })

  it('remembers the container being packed, for a while', async () => {
    const db = fresh()
    await createBox({ tagId: 'BOX000001', size: '20ml', label: '', createdBy: 'me' }, db)
    const at = new Date('2026-11-17T15:00:00Z')
    await startPacking('BOX000001', 'C4', db, at)
    expect(await getPacking(db, at.getTime() + 60_000)).toMatchObject({ boxTagId: 'BOX000001', target: 'C4' })
    expect(await getPacking(db, at.getTime() + 13 * 3_600_000)).toBeNull()
    await stopPacking(db)
    expect(await getPacking(db, at.getTime())).toBeNull()
  })

  it('refuses a tag that already has another rank', async () => {
    const db = fresh()
    await db.records.add(capture('SPEC00001'))
    await expect(createBox({ tagId: 'SPEC00001', size: '2ml', label: '', createdBy: 'me' }, db)).rejects.toThrow(/already a specimen/)
  })
})
