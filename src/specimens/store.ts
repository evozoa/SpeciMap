/**
 * Specimen-level edits (dwc:MaterialEntity) and their sync.
 *
 * Specimen fields live in the server's material_entities table, one row per
 * vial tag, created by a trigger when the first capture of the tag uploads.
 * Local edits are marked dirty and pushed by `pushSpecimens`; an edit made
 * before the tag's first capture has uploaded waits for the next pass.
 */
import { db as defaultDb, type Custody, type LocalRecord, type LocalSpecimen, type LotPart, type SpeciMapDB, type Taxon } from '../db/schema'
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

/** Make the tag a mixed lot (a jar of several species), or a plain specimen. */
export function setKind(tagId: string, kind: 'specimen' | 'mixed_lot', db: SpeciMapDB = defaultDb) {
  return editSpecimen(db, tagId, () => ({ kind }))
}

/** A mixed lot's contents; the individual count becomes their total. */
export function setComposition(tagId: string, parts: LotPart[], db: SpeciMapDB = defaultDb) {
  const clean = parts
    .map((p) => ({ name: p.name.trim(), taxon: p.taxon, count: Math.max(1, Math.floor(p.count) || 1) }))
    .filter((p) => p.name)
  const total = clean.reduce((n, p) => n + p.count, 0)
  return editSpecimen(db, tagId, () => ({ composition: clean, individualCount: Math.max(1, total) }))
}

/** Record the mixed lot this specimen was sorted out of (null to clear). */
export function setParentLot(tagId: string, parentTagId: string | null, db: SpeciMapDB = defaultDb) {
  if (parentTagId === tagId) throw new Error('A lot cannot be sorted out of itself')
  return editSpecimen(db, tagId, () => ({ parentTagId }))
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
  kind?: 'specimen' | 'mixed_lot'
  composition?: { name: string; taxon_id?: number | null; taxon_name?: string | null; taxon_rank?: string | null; count: number }[] | null
  parent_tag_id?: string | null
  catalog_number?: string | null
  custodian_user?: string | null
  custodian_org?: string | null
  visibility?: Custody['visibility']
  generalize_public?: boolean
}

/** A mixed lot's composition as stored on the server. */
export function compositionRow(parts: LotPart[] = []) {
  return parts.map((p) => ({
    name: p.name,
    count: p.count,
    taxon_id: p.taxon?.id ?? null,
    taxon_name: p.taxon?.name ?? null,
    taxon_rank: p.taxon?.rank ?? null,
  }))
}

export function custodyFrom(r: {
  custodian_user?: string | null
  custodian_org?: string | null
  visibility?: Custody['visibility']
  generalize_public?: boolean
  catalog_number?: string | null
}): Custody | undefined {
  if (r.visibility === undefined) return undefined
  return {
    custodianUser: r.custodian_user ?? null,
    custodianOrg: r.custodian_org ?? null,
    visibility: r.visibility,
    generalizePublic: r.generalize_public ?? true,
    catalogNumber: r.catalog_number ?? null,
  }
}

export function fromRemoteEntity(r: RemoteMaterialEntity): LocalSpecimen {
  return {
    tagId: r.tag_id,
    individualCount: r.individual_count,
    confirmedCaptureIds: r.confirmed_capture_ids ?? [],
    kind: r.kind ?? 'specimen',
    composition: (r.composition ?? []).map((p) => ({
      name: p.name,
      count: p.count,
      taxon: p.taxon_id ? { id: p.taxon_id, name: p.taxon_name ?? p.name, rank: p.taxon_rank ?? '' } : null,
    })),
    parentTagId: r.parent_tag_id ?? null,
    custody: custodyFrom(r),
    dirty: 0,
  }
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
    if (!(await t.update(s))) {
      // The server has the row (we pulled its custody) but refused the
      // edit: we no longer hold it. Drop the edit; the pull restores theirs.
      if (s.custody) await db.specimens.update(s.tagId, { dirty: 0 })
      continue
    }
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
    // Rows no longer visible on the server (and not edited here) go.
    const seen = new Set(remote.map((r) => r.tag_id))
    const gone = await db.specimens.filter((s) => !s.dirty && !seen.has(s.tagId)).primaryKeys()
    if (gone.length) await db.specimens.bulkDelete(gone)
    const local = await db.specimens.bulkGet(remote.map((r) => r.tag_id))
    await db.specimens.bulkPut(
      remote
        .filter((_, i) => !local[i]?.dirty)
        .map(fromRemoteEntity),
    )
  })
}
