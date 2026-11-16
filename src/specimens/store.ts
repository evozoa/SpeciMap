/**
 * Specimen-level edits (dwc:MaterialEntity) and their sync.
 *
 * Specimen fields live in the server's material_entities table, one row per
 * vial tag, created by a trigger when the first capture of the tag uploads.
 * Local edits are marked dirty and pushed by `pushSpecimens`; an edit made
 * before the tag's first capture has uploaded waits for the next pass.
 */
import { db as defaultDb, type LocalRecord, type LocalSpecimen, type SpeciMapDB, type Taxon } from '../db/schema'
import { serverEdit, setSpecies } from '../db/drafts'

function blank(tagId: string): LocalSpecimen {
  return { tagId, individualCount: 1, confirmedCaptureIds: [], dirty: 0 }
}

async function editSpecimen(
  db: SpeciMapDB,
  tagId: string,
  change: (s: LocalSpecimen) => Partial<LocalSpecimen>,
): Promise<void> {
  await db.transaction('rw', db.specimens, async () => {
    const s = (await db.specimens.get(tagId)) ?? blank(tagId)
    await db.specimens.put({ ...s, ...change(s), dirty: 1 })
  })
}

export function setIndividualCount(tagId: string, count: number, db: SpeciMapDB = defaultDb) {
  const n = Math.max(1, Math.floor(count) || 1)
  return editSpecimen(db, tagId, () => ({ individualCount: n }))
}

/** The collector reviewed these captures: same specimen, not a reused tag. */
export function confirmSameSpecimen(tagId: string, captureIds: string[], db: SpeciMapDB = defaultDb) {
  return editSpecimen(db, tagId, (s) => ({
    confirmedCaptureIds: [...new Set([...s.confirmedCaptureIds, ...captureIds])],
  }))
}

/**
 * Identify a specimen: the name goes on each of the collector's own
 * captures of it, so they agree (others' identifications stay as theirs).
 */
export async function setSpecimenSpecies(
  captures: LocalRecord[],
  collectorId: string,
  species: string,
  taxon: Taxon | null,
): Promise<void> {
  for (const r of captures) {
    if (r.collectorId === collectorId) await setSpecies(r.id, species, taxon)
  }
}

/**
 * A capture was a different fish carrying a reused tag: move it (and its
 * photos) to the fish's new tag. The capture re-uploads from the tag step.
 */
export async function moveCaptureToTag(captureId: string, newTagId: string, db: SpeciMapDB = defaultDb) {
  await db.transaction('rw', db.records, async () => {
    const r = await db.records.get(captureId)
    if (!r) throw new Error('Capture no longer exists')
    if (r.tagId === newTagId) return
    await db.records.update(captureId, {
      ...serverEdit(r, { tagId: newTagId }),
      ...(r.status === 'syncing' ? {} : { syncStep: 'ensure-tag' as const }),
    })
  })
}

// ---- Sync ---------------------------------------------------------------

export interface RemoteMaterialEntity {
  tag_id: string
  individual_count: number
  confirmed_capture_ids: string[] | null
}

export interface SpecimenTransport {
  /** Returns false when the server has no row for the tag yet. */
  update(s: LocalSpecimen): Promise<boolean>
  fetchAll(): Promise<RemoteMaterialEntity[]>
}

/** Sends dirty specimen rows; a row stays dirty until the server has it. */
export async function pushSpecimens(t: SpecimenTransport, db: SpeciMapDB = defaultDb): Promise<void> {
  const dirty = await db.specimens.where('dirty').equals(1).toArray()
  for (const s of dirty) {
    if (!(await t.update(s))) continue
    await db.transaction('rw', db.specimens, async () => {
      const now = await db.specimens.get(s.tagId)
      // Only clear the flag if nothing changed while the request was out.
      if (now && JSON.stringify({ ...now, dirty: 0 }) === JSON.stringify({ ...s, dirty: 0 })) {
        await db.specimens.update(s.tagId, { dirty: 0 })
      }
    })
  }
}

/** Takes the server's specimen rows, except ones with local edits pending. */
export async function pullSpecimens(t: SpecimenTransport, db: SpeciMapDB = defaultDb): Promise<void> {
  const remote = await t.fetchAll()
  await db.transaction('rw', db.specimens, async () => {
    const local = await db.specimens.bulkGet(remote.map((r) => r.tag_id))
    await db.specimens.bulkPut(
      remote
        .filter((_, i) => !local[i]?.dirty)
        .map((r) => ({
          tagId: r.tag_id,
          individualCount: r.individual_count,
          confirmedCaptureIds: r.confirmed_capture_ids ?? [],
          dirty: 0 as const,
        })),
    )
  })
}
