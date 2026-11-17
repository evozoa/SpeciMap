/**
 * Neutral tags: a SpeciMap QR code says only "this tag", not what it marks.
 * The rank -- collecting event, specimen or subsample -- is chosen the first
 * time the tag is scanned, and is fixed once something is saved against it.
 *
 * The app suggests the likely rank so the choice is usually one tap:
 *   - from the printed format (field sheet -> event, vial tag -> specimen,
 *     2 mL strip -> subsample), when this phone knows it;
 *   - from what was just done: a tag scanned soon after a specimen is
 *     probably a subsample of it.
 */
import { db as defaultDb, type SpeciMapDB } from '../db/schema'

export type TagRank = 'event' | 'specimen' | 'subsample' | 'box'

/** What a tag already is on this phone, or null if it's unused here. */
export async function tagRole(tagId: string, db: SpeciMapDB = defaultDb): Promise<TagRank | null> {
  if (await db.events.get(tagId)) return 'event'
  if (await db.subsamples.get(tagId)) return 'subsample'
  if (await db.boxes.get(tagId)) return 'box'
  const captures = await db.records.where('tagId').equals(tagId).toArray()
  if (captures.some((r) => r.status !== 'draft')) return 'specimen'
  return null
}

/** The rank a printed format is normally used for. */
export function rankForFormat(format: string | null | undefined): TagRank | null {
  switch (format) {
    case 'fieldsheet':
      return 'event'
    case 'insert_2ml':
      return 'subsample'
    case 'insert':
    case 'punch':
    case 'both':
      return 'specimen'
    default:
      return null
  }
}

/** A subsample scanned this soon after a specimen defaults to that parent. */
export const RECENT_SPECIMEN_MINUTES = 30

export interface LastSpecimen {
  tagId: string
  at: string
}

export async function rememberLastSpecimen(tagId: string, db: SpeciMapDB = defaultDb, now = new Date()) {
  await db.meta.put({ key: 'lastSpecimen', value: { tagId, at: now.toISOString() } satisfies LastSpecimen })
}

/** The specimen saved most recently on this phone, if within the window. */
export async function recentSpecimen(db: SpeciMapDB = defaultDb, now = Date.now()): Promise<string | null> {
  const last = (await db.meta.get('lastSpecimen'))?.value as LastSpecimen | undefined
  if (!last || now - Date.parse(last.at) > RECENT_SPECIMEN_MINUTES * 60_000) return null
  return last.tagId
}

export interface Suggestion {
  rank: TagRank | null
  /** For a suggested subsample: the specimen it probably came from. */
  parentTagId: string | null
}

/**
 * The suggested rank for an unused tag. The printed format wins; otherwise a
 * recent specimen suggests a subsample of it; otherwise no suggestion.
 */
export function suggestRank(format: string | null | undefined, recentSpecimenTag: string | null, tagId: string): Suggestion {
  const parent = recentSpecimenTag && recentSpecimenTag !== tagId ? recentSpecimenTag : null
  const byFormat = rankForFormat(format)
  if (byFormat) return { rank: byFormat, parentTagId: byFormat === 'subsample' ? parent : null }
  if (parent) return { rank: 'subsample', parentTagId: parent }
  return { rank: null, parentTagId: null }
}

/** The printed format of a tag, if this phone has seen it. */
export async function cachedFormat(tagId: string, db: SpeciMapDB = defaultDb): Promise<string | null> {
  return (await db.tagCache.get(tagId))?.format ?? null
}

/** Remember the format of tags printed (or looked up) on this phone. */
export async function cacheFormats(
  tags: { id: string; batchId: string | null; seq: number | null; format: string }[],
  db: SpeciMapDB = defaultDb,
) {
  await db.tagCache.bulkPut(tags)
}
