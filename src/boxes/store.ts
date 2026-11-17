/**
 * Storage boxes: a tag on a box for 20 mL vials or 2 mL tubes, holding up to
 * 100 items in positions A1-J10 (rows A-J, columns 1-10). Items are placed by
 * scanning them while "packing" a box: each scan goes to the next free
 * position, or to a position chosen on the box page. Local-first like
 * everything else; placing an item also logs a location check for it.
 */
import { db as defaultDb, type LocalBox, type LocalPlacement, type SpeciMapDB } from '../db/schema'
import { formatTagId } from '../lib/tagid'
import { logScan, setScanPlace } from '../scans/store'

export const ROWS = 'ABCDEFGHIJ'.split('')
export const COLS = Array.from({ length: 10 }, (_, i) => i + 1)
/** All positions in packing order: A1, A2 … A10, B1 … J10. */
export const POSITIONS = ROWS.flatMap((r) => COLS.map((c) => `${r}${c}`))

export type ContainerKind = LocalBox['size']

export const SIZE_NAMES: Record<ContainerKind, string> = {
  '2ml': '2 mL tube box',
  '20ml': '20 mL vial box',
  carton: 'Cardboard box',
  rack: 'Freezer rack',
  shelf: 'Museum shelf',
}

export const KIND_DETAIL: Record<ContainerKind, string> = {
  '2ml': 'Tubes (e.g. tissue subsamples) at A1–J10.',
  '20ml': 'Scintillation vials at A1–J10.',
  carton: 'Jars of fixed specimens, numbered.',
  rack: 'Freezer rack of 2 mL and 20 mL boxes, numbered slots.',
  shelf: 'Shelf of cardboard boxes, vial boxes and racks, numbered.',
}

export const DEFAULT_CAPACITY: Record<ContainerKind, number> = { '2ml': 100, '20ml': 100, carton: 50, rack: 12, shelf: 50 }

/** Containers with a 10 x 10 grid; the rest number their positions. */
export const isGrid = (k: ContainerKind) => k === '2ml' || k === '20ml'

/** What each container holds: null = specimens and subsamples; else these containers. */
export const HOLDS: Record<ContainerKind, ContainerKind[] | null> = {
  '2ml': null,
  '20ml': null,
  carton: null,
  rack: ['2ml', '20ml'],
  shelf: ['2ml', '20ml', 'carton', 'rack'],
}

/** Can a container of kind `outer` hold this item (a container kind, or null for a specimen)? */
export function canHold(outer: ContainerKind, item: ContainerKind | null): boolean {
  const holds = HOLDS[outer]
  return holds === null ? item === null : item !== null && holds.includes(item)
}

/** A container's positions in packing order: A1…J10 in a grid, else 1…capacity. */
export function positionsFor(box: Pick<LocalBox, 'size' | 'capacity'>): string[] {
  return isGrid(box.size) ? POSITIONS : Array.from({ length: box.capacity }, (_, i) => String(i + 1))
}

const queued = { status: 'queued' as const, attempts: 0, nextAttemptAt: 0, lastError: null }

export async function createBox(
  input: { tagId: string; size: LocalBox['size']; label: string; createdBy: string; capacity?: number },
  db: SpeciMapDB = defaultDb,
  now = new Date(),
) {
  await db.transaction('rw', db.boxes, db.records, db.subsamples, db.events, async () => {
    if (await db.boxes.get(input.tagId)) throw new Error('This tag is already a box')
    if (await db.events.get(input.tagId)) throw new Error('This tag is already a collecting event')
    if (await db.subsamples.get(input.tagId)) throw new Error('This tag is already a subsample')
    const caps = await db.records.where('tagId').equals(input.tagId).toArray()
    if (caps.some((r) => r.status !== 'draft')) throw new Error('This tag is already a specimen')
    await db.boxes.add({
      tagId: input.tagId,
      size: input.size,
      label: input.label.trim(),
      capacity: Math.min(100, Math.max(1, input.capacity ?? DEFAULT_CAPACITY[input.size])),
      createdBy: input.createdBy,
      updatedAt: now.toISOString(),
      ...queued,
    })
  })
}

export async function updateBox(tagId: string, changes: Partial<Pick<LocalBox, 'label' | 'size'>>, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.boxes, async () => {
    const b = await db.boxes.get(tagId)
    if (!b) throw new Error('Box no longer exists')
    await db.boxes.update(tagId, { ...changes, updatedAt: new Date().toISOString(), ...(b.status === 'syncing' ? {} : queued) })
  })
}

/** What's in a box now, by position. */
export async function boxContents(boxTagId: string, db: SpeciMapDB = defaultDb): Promise<LocalPlacement[]> {
  const rows = await db.placements.where('boxTagId').equals(boxTagId).toArray()
  const order = (p: string) => (/^\d+$/.test(p) ? Number(p) : 1000 + POSITIONS.indexOf(p))
  return rows.filter((p) => !p.deleted).sort((a, b) => order(a.position) - order(b.position))
}

/** Where an item is stored, if anywhere. */
export async function placementOf(itemTagId: string, db: SpeciMapDB = defaultDb): Promise<LocalPlacement | null> {
  const p = await db.placements.get(itemTagId)
  return p && !p.deleted ? p : null
}

export function nextFreePosition(
  taken: Iterable<string>,
  capacity = 100,
  from?: string | null,
  positions: string[] = POSITIONS,
): string | null {
  const used = new Set(taken)
  if (used.size >= capacity) return null
  const start = from ? Math.max(0, positions.indexOf(from)) : 0
  for (let i = 0; i < positions.length; i++) {
    const pos = positions[(start + i) % positions.length]
    if (!used.has(pos)) return pos
  }
  return null
}

export interface Placed {
  position: string
  /** The location check logged for the item. */
  scanId: string
  /** Where it was before, if it moved. */
  previous: { boxTagId: string; position: string } | null
}

/**
 * Put an item in a box: at `position` if given and free, else the next free
 * one. Moving it from another box (or another position) is the same call.
 */
export async function placeItem(
  input: { itemTagId: string; boxTagId: string; position?: string | null; placedBy: string },
  db: SpeciMapDB = defaultDb,
  now = new Date(),
): Promise<Placed> {
  if (input.itemTagId === input.boxTagId) throw new Error('A box cannot go in itself')
  const placed = await db.transaction('rw', db.boxes, db.placements, async () => {
    const box = await db.boxes.get(input.boxTagId)
    if (!box) throw new Error('That box is not on this phone')
    const itemBox = await db.boxes.get(input.itemTagId)
    if (!canHold(box.size, itemBox?.size ?? null)) {
      const holds = HOLDS[box.size]
      throw new Error(
        holds ? `${SIZE_NAMES[box.size]} holds only: ${holds.map((k) => SIZE_NAMES[k]).join(', ')}` : 'Boxes hold specimens and subsamples, not other containers',
      )
    }
    const positions = positionsFor(box)
    const before = await db.placements.get(input.itemTagId)
    const current = before && !before.deleted ? before : null
    const others = (await boxContents(input.boxTagId, db)).filter((p) => p.itemTagId !== input.itemTagId)
    const taken = others.map((p) => p.position)
    let position = input.position ?? null
    if (position && !positions.includes(position)) throw new Error(`No position ${position} in this container (${SIZE_NAMES[box.size]})`)
    if (position && taken.includes(position)) {
      const who = others.find((p) => p.position === position)!.itemTagId
      throw new Error(`${position} already holds ${formatTagId(who)}`)
    }
    position ??= nextFreePosition(taken, box.capacity, null, positions)
    if (!position || others.length >= box.capacity) throw new Error(`It's full (${box.capacity})`)
    await db.placements.put({
      itemTagId: input.itemTagId,
      boxTagId: input.boxTagId,
      position,
      placedBy: input.placedBy,
      placedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(before?.status === 'syncing' ? { status: 'syncing' as const, attempts: 0, nextAttemptAt: 0, lastError: null } : queued),
    })
    return {
      position,
      previous: current ? { boxTagId: current.boxTagId, position: current.position } : null,
    }
  })
  // The item's location history shows where it went.
  const scanId = crypto.randomUUID()
  await logScan({ id: scanId, tagId: input.itemTagId, scannedBy: input.placedBy }, db, now)
  await setScanPlace(scanId, await describeStorage(input.itemTagId, db), db)
  return { ...placed, scanId }
}

/** Take an item out of its box (the removal uploads like any change). */
export async function removeFromBox(itemTagId: string, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.placements, async () => {
    const p = await db.placements.get(itemTagId)
    if (!p || p.deleted) return
    await db.placements.update(itemTagId, { deleted: true, updatedAt: new Date().toISOString(), ...(p.status === 'syncing' ? {} : queued) })
  })
}

/** "Box 7Q4M-K2XR-C, A3 · Freezer rack ABCD-…, slot 5": where an item is stored. */
export async function describeStorage(itemTagId: string, db: SpeciMapDB = defaultDb): Promise<string> {
  const parts: string[] = []
  let tag = itemTagId
  for (let depth = 0; depth < 4; depth++) {
    const p = await placementOf(tag, db)
    if (!p) break
    const c = await db.boxes.get(p.boxTagId)
    const kind = c ? SIZE_NAMES[c.size] : 'Container'
    const name = c?.label ? `${c.label} (${formatTagId(p.boxTagId)})` : `${kind} ${formatTagId(p.boxTagId)}`
    parts.push(`${name}, ${c && !isGrid(c.size) ? 'no. ' : ''}${p.position}`)
    tag = p.boxTagId
  }
  return parts.join(' · ')
}

// ---- Packing mode ---------------------------------------------------------

/** Packing stays on this long unless stopped. */
export const PACKING_HOURS = 12

export interface Packing {
  boxTagId: string
  /** The position the next scan goes to; null = next free. */
  target: string | null
  since: string
}

export async function startPacking(boxTagId: string, target: string | null = null, db: SpeciMapDB = defaultDb, now = new Date()) {
  await db.meta.put({ key: 'packing', value: { boxTagId, target, since: now.toISOString() } satisfies Packing })
}

export async function stopPacking(db: SpeciMapDB = defaultDb) {
  await db.meta.delete('packing')
}

export async function getPacking(db: SpeciMapDB = defaultDb, now = Date.now()): Promise<Packing | null> {
  const p = (await db.meta.get('packing'))?.value as Packing | undefined
  if (!p || now - Date.parse(p.since) > PACKING_HOURS * 3_600_000) return null
  if (!(await db.boxes.get(p.boxTagId))) return null
  return p
}
