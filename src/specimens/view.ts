/**
 * A specimen (dwc:MaterialEntity) is every capture of one vial tag. Captures
 * from different phones, or different people, are never merged into one
 * row: they are grouped here, so nothing anyone recorded is lost.
 *
 * Rules (deterministic, so every device shows the same result whatever order
 * captures synced in):
 *   - date and location come from the earliest capture;
 *   - the identification is the most recent one (dwc:dateIdentified);
 *   - identifications that name different taxa are flagged, not chosen;
 *   - a capture far in time or space from the first is flagged as possible
 *     tag reuse (one tag on two fish) until someone reviews it.
 */
import type { LocalRecord, LocalSpecimen, SyncStatus, Taxon } from '../db/schema'

/** Captures further apart than this are unlikely to be the same fish. */
export const REUSE_HOURS = 12
export const REUSE_METRES = 1000

export interface SpecimenView {
  tagId: string
  /** Oldest first. */
  captures: LocalRecord[]
  first: LocalRecord
  /** The capture holding the current identification, if any has one. */
  identification: LocalRecord | null
  species: string
  taxon: Taxon | null
  /** Distinct names when captures' identifications disagree, else null. */
  disagreement: string[] | null
  /** Captures that may be a different fish carrying the same tag. */
  reuseSuspects: LocalRecord[]
  individualCount: number
  /** The least settled sync status of its captures. */
  status: SyncStatus
  /** Latest capture time, for sorting lists. */
  latestAt: string
}

export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/** True when two captures could plausibly be the same fish on one outing. */
export function plausiblySame(a: LocalRecord, b: LocalRecord): boolean {
  const hours = Math.abs(Date.parse(a.capturedAt) - Date.parse(b.capturedAt)) / 3_600_000
  return hours <= REUSE_HOURS && distanceMetres(a, b) <= REUSE_METRES
}

/** Same taxon if both are linked to it, else the same name (ignoring case). */
function identityKey(r: LocalRecord): string {
  return r.taxon ? `taxon:${r.taxon.id}` : `name:${(r.species ?? '').trim().toLowerCase()}`
}

const STATUS_RANK: Record<SyncStatus, number> = { error: 0, draft: 1, syncing: 2, queued: 3, synced: 4 }

const byTime = (a: LocalRecord, b: LocalRecord) =>
  a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id)

export function specimenView(captures: LocalRecord[], specimen?: LocalSpecimen): SpecimenView {
  const sorted = [...captures].sort(byTime)
  const first = sorted[0]
  const named = sorted.filter((r) => r.species?.trim())
  const identification =
    [...named].sort(
      (a, b) =>
        (b.identifiedAt ?? b.capturedAt).localeCompare(a.identifiedAt ?? a.capturedAt) ||
        b.id.localeCompare(a.id),
    )[0] ?? null

  const keys = new Map<string, string>()
  for (const r of named) if (!keys.has(identityKey(r))) keys.set(identityKey(r), r.species!.trim())
  const confirmed = new Set(specimen?.confirmedCaptureIds ?? [])

  return {
    tagId: first.tagId,
    captures: sorted,
    first,
    identification,
    species: identification?.species?.trim() ?? '',
    taxon: identification?.taxon ?? null,
    disagreement: keys.size > 1 ? [...keys.values()] : null,
    reuseSuspects: sorted
      .slice(1)
      .filter((r) => !confirmed.has(r.id) && !plausiblySame(first, r)),
    individualCount: specimen?.individualCount ?? 1,
    status: sorted.reduce<SyncStatus>(
      (worst, r) => (STATUS_RANK[r.status] < STATUS_RANK[worst] ? r.status : worst),
      'synced',
    ),
    latestAt: sorted[sorted.length - 1].capturedAt,
  }
}

/** Groups captures into specimens, most recently captured first. */
export function buildSpecimens(records: LocalRecord[], specimens: LocalSpecimen[] = []): SpecimenView[] {
  const byTag = new Map<string, LocalRecord[]>()
  for (const r of records) {
    if (r.status === 'draft') continue
    byTag.set(r.tagId, [...(byTag.get(r.tagId) ?? []), r])
  }
  const rows = new Map(specimens.map((s) => [s.tagId, s]))
  return [...byTag.values()]
    .map((captures) => specimenView(captures, rows.get(captures[0].tagId)))
    .sort((a, b) => b.latestAt.localeCompare(a.latestAt))
}
