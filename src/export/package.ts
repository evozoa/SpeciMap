/**
 * Builds the museum submission package: a zip with the Darwin Core tables,
 * the photos named by tag ID, and a README explaining both.
 */
import { zip, strToU8, type AsyncZippable } from 'fflate'
import { db, type LocalEventPhoto, type LocalPhoto } from '../db/schema'
import type { SpecimenView } from '../specimens/view'
import { INAT_API } from '../inat/auth'
import { isFullRes } from '../lib/image'
import { loadPhotoBlob } from '../lib/photoUrl'
import type { ExportPrefs } from '../lib/prefs'
import {
  MULTIMEDIA_COLUMNS,
  LOCATION_CHECK_COLUMNS,
  OCCURRENCE_COLUMNS,
  SUBSAMPLE_COLUMNS,
  classificationFrom,
  fieldNotesFileName,
  locationCheckRow,
  multimediaRows,
  occurrenceRow,
  photoFileName,
  subsampleExportRow,
  toCsv,
  type Classification,
  type ExportItem,
} from './dwc'

const BOM = '﻿' // so Excel opens the CSV as UTF-8

/** Kingdom-to-genus for each taxon id; empty when iNaturalist is unreachable. */
export async function fetchClassifications(ids: number[]): Promise<Map<number, Classification>> {
  const out = new Map<number, Classification>()
  const unique = [...new Set(ids)]
  for (let i = 0; i < unique.length; i += 30) {
    const batch = unique.slice(i, i + 30)
    const res = await fetch(`${INAT_API}/taxa/${batch.join(',')}`)
    if (!res.ok) throw new Error(`iNaturalist taxa lookup failed (${res.status})`)
    const { results } = (await res.json()) as {
      results: { id: number; name: string; rank: string; ancestors?: { rank: string; name: string }[] }[]
    }
    for (const t of results) {
      out.set(t.id, classificationFrom([...(t.ancestors ?? []), { rank: t.rank, name: t.name }]))
    }
  }
  return out
}

export interface PackageResult {
  blob: Blob
  fileName: string
  warnings: string[]
}

/** A specimen's photos, in capture order. */
async function specimenPhotos(v: SpecimenView): Promise<LocalPhoto[]> {
  const order = new Map(v.captures.map((r, i) => [r.id, i]))
  const photos = await db.photos.where('recordId').anyOf([...order.keys()]).toArray()
  return photos.sort((a, b) => order.get(a.recordId)! - order.get(b.recordId)! || a.id.localeCompare(b.id))
}

/** The specimen's collecting event: that of its earliest capture made in one. */
export function eventIdOf(v: SpecimenView): string | undefined {
  return v.captures.find((r) => r.eventId)?.eventId
}

async function itemsFor(
  specimens: SpecimenView[],
  withPhotos: boolean,
  warnings: string[],
): Promise<{ items: ExportItem[]; fieldNotes: Map<string, LocalEventPhoto[]> }> {
  let classes = new Map<number, Classification>()
  const taxonIds = specimens.flatMap((v) => (v.taxon ? [v.taxon.id] : []))
  if (taxonIds.length) {
    try {
      classes = await fetchClassifications(taxonIds)
    } catch {
      warnings.push('Offline: kingdom-to-genus columns are blank. Export again when online to fill them.')
    }
  }
  const eventIds = [...new Set(specimens.map(eventIdOf).filter((id): id is string => !!id))]
  const events = new Map((await db.events.bulkGet(eventIds)).filter((e) => !!e).map((e) => [e!.id, e!]))
  const fieldNotes = new Map<string, LocalEventPhoto[]>()
  if (withPhotos) {
    for (const id of eventIds) {
      fieldNotes.set(id, (await db.eventPhotos.where('eventId').equals(id).toArray()).sort((a, b) => a.id.localeCompare(b.id)))
    }
  }
  const items: ExportItem[] = []
  for (const v of specimens) {
    const photos = withPhotos
      ? (await specimenPhotos(v)).map((p, i) => ({
          fileName: photoFileName(v.tagId, i),
          width: p.width,
          height: p.height,
          fullRes: isFullRes(p),
        }))
      : []
    const evId = eventIdOf(v)
    items.push({
      specimen: v,
      photos,
      classification: v.taxon ? classes.get(v.taxon.id) : undefined,
      event: evId ? events.get(evId) : undefined,
      fieldNotes: evId ? (fieldNotes.get(evId) ?? []).map((_, i) => fieldNotesFileName(evId, i)) : [],
    })
  }
  return { items, fieldNotes }
}

export function readme(prefs: ExportPrefs, count: number, photoCount: number): string {
  return `SpeciMap Darwin Core export
Created ${new Date().toISOString()} with SpeciMap (https://specimap.org)

${count} specimen(s), ${photoCount} image(s).

occurrence.csv   One row per specimen (Darwin Core terms), with the terms of
                 its collecting event (dwc:Event).
multimedia.csv   One row per specimen photo, linked by occurrenceID.
subsamples.csv   One row per subsample (e.g. a fin clip in a 2 mL tube),
                 linked to its specimen by materialEntityID and occurrenceID.
location_checks.csv  One row per later scan of a specimen's or subsample's
                 tag (e.g. on a museum shelf): when and where it was seen.
photos/          Specimen photos, named <vial tag>_<n>.jpg.
fieldnotes/      Photos of the completed field sheets (see fieldNotes).

Identifiers
  occurrenceID       https://specimap.org/specimen/<vial tag>
  materialEntityID   The QR tag on the specimen vial, as SpeciMap:<tag>
                     (printed on the tag as e.g. 7Q4M-K2XR-C). Repeated in
                     otherCatalogNumbers.
  materialSampleID   The QR tag on a subsample's tube, as SpeciMap:<tag>.
  eventID            https://specimap.org/event/<field sheet tag>
  parentEventID      Set when several collectors' field sheets were linked
                     into one collecting event.
  fieldNumber        The collector's field number for the event.
  catalogNumber      Blank: assigned by the museum. Please return a list of
                     materialEntityID -> catalogNumber so SpeciMap can
                     record it.

Notes
  basisOfRecord is ${prefs.basisOfRecord}${prefs.basisOfRecord === 'HumanObservation' ? ' (photo voucher; preparations = photograph)' : ''}.
  individualCount is >1 when one vial tag is on a lot.
  Coordinates are WGS84 from the phone GPS at the specimen's first capture;
  coordinateUncertaintyInMeters is the GPS accuracy reported by the phone.
  Locality, county, stateProvince and countryCode come from the event, as
  entered by the collector (blank for specimens recorded without an event).
  eventDate is local time with its UTC offset; an interval (start/end) when
  the event was ended in SpeciMap.
  scientificName is the collector's identification. taxonID links the
  matching iNaturalist taxon where one was confirmed; the higher
  classification (kingdom to genus) comes from iNaturalist. taxonRemarks
  notes unmatched names and disagreeing identifications.
  Photos are licensed ${prefs.license} (see multimedia.csv).
`
}

export async function buildPackage(
  specimens: SpecimenView[],
  prefs: ExportPrefs,
  { withPhotos = true, onProgress }: { withPhotos?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<PackageResult> {
  const warnings: string[] = []
  const { items, fieldNotes } = await itemsFor(specimens, withPhotos, warnings)
  const occurrence = toCsv(OCCURRENCE_COLUMNS, items.map((it) => occurrenceRow(it, prefs)))
  const multimedia = toCsv(MULTIMEDIA_COLUMNS, items.flatMap((it) => multimediaRows(it, prefs)))
  const stamp = new Date().toISOString().slice(0, 10)

  if (!withPhotos) {
    return {
      blob: new Blob([BOM + occurrence], { type: 'text/csv' }),
      fileName: `specimap-dwc-${stamp}.csv`,
      warnings,
    }
  }

  const subsamples = (await db.subsamples.where('parentTagId').anyOf(specimens.map((v) => v.tagId)).toArray()).sort(
    (a, b) => a.parentTagId.localeCompare(b.parentTagId) || a.collectedAt.localeCompare(b.collectedAt),
  )
  const files: AsyncZippable = {
    'occurrence.csv': strToU8(BOM + occurrence),
    'multimedia.csv': strToU8(BOM + multimedia),
    'subsamples.csv': strToU8(BOM + toCsv(SUBSAMPLE_COLUMNS, subsamples.map((s) => subsampleExportRow(s, prefs)))),
  }
  const checkedTags = [...specimens.map((v) => v.tagId), ...subsamples.map((s) => s.tagId)]
  const checks = (await db.scans.where('tagId').anyOf(checkedTags).toArray())
    .filter((s) => !s.deleted)
    .sort((a, b) => a.tagId.localeCompare(b.tagId) || a.scannedAt.localeCompare(b.scannedAt))
  if (checks.length) {
    files['location_checks.csv'] = strToU8(BOM + toCsv(LOCATION_CHECK_COLUMNS, checks.map((s) => locationCheckRow(s))))
  }
  const total =
    items.reduce((n, it) => n + it.photos.length, 0) +
    [...fieldNotes.values()].reduce((n, ps) => n + ps.length, 0)
  let done = 0
  for (const [evId, sheetPhotos] of fieldNotes) {
    for (const [i, p] of sheetPhotos.entries()) {
      const name = fieldNotesFileName(evId, i)
      try {
        files[name] = [new Uint8Array(await (await loadPhotoBlob(p as unknown as LocalPhoto)).arrayBuffer()), { level: 0 }]
      } catch (e) {
        warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
      onProgress?.(++done, total)
    }
  }
  for (const { specimen, photos } of items) {
    const local = await specimenPhotos(specimen)
    for (const [i, p] of local.entries()) {
      try {
        const bytes = new Uint8Array(await (await loadPhotoBlob(p)).arrayBuffer())
        files[`photos/${photos[i].fileName}`] = [bytes, { level: 0 }] // JPEGs don't compress
      } catch (e) {
        warnings.push(`${photos[i].fileName}: ${e instanceof Error ? e.message : String(e)}`)
      }
      onProgress?.(++done, total)
    }
  }
  files['README.txt'] = strToU8(readme(prefs, items.length, total))

  const data = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out))),
  )
  return {
    blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    fileName: `specimap-dwc-${stamp}.zip`,
    warnings,
  }
}
