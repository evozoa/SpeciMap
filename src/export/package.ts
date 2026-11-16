/**
 * Builds the museum submission package: a zip with the Darwin Core tables,
 * the photos named by tag ID, and a README explaining both.
 */
import { zip, strToU8, type AsyncZippable } from 'fflate'
import { db, type LocalRecord } from '../db/schema'
import { INAT_API } from '../inat/auth'
import { isFullRes } from '../lib/image'
import { loadPhotoBlob } from '../lib/photoUrl'
import type { ExportPrefs } from '../lib/prefs'
import {
  MULTIMEDIA_COLUMNS,
  OCCURRENCE_COLUMNS,
  classificationFrom,
  multimediaRows,
  occurrenceRow,
  photoFileName,
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

async function itemsFor(
  records: LocalRecord[],
  withPhotos: boolean,
  warnings: string[],
): Promise<ExportItem[]> {
  let classes = new Map<number, Classification>()
  const taxonIds = records.flatMap((r) => (r.taxon ? [r.taxon.id] : []))
  if (taxonIds.length) {
    try {
      classes = await fetchClassifications(taxonIds)
    } catch {
      warnings.push('Offline: kingdom-to-genus columns are blank. Export again when online to fill them.')
    }
  }
  const items: ExportItem[] = []
  for (const record of records) {
    const photos = withPhotos
      ? (await db.photos.where('recordId').equals(record.id).sortBy('id')).map((p, i) => ({
          fileName: photoFileName(record.tagId, i),
          width: p.width,
          height: p.height,
          fullRes: isFullRes(p),
        }))
      : []
    items.push({
      record,
      photos,
      classification: record.taxon ? classes.get(record.taxon.id) : undefined,
    })
  }
  return items
}

export function readme(prefs: ExportPrefs, count: number, photoCount: number): string {
  return `SpeciMap Darwin Core export
Created ${new Date().toISOString()} with SpeciMap (https://specimap.org)

${count} record(s), ${photoCount} photo(s).

occurrence.csv   One row per specimen record (Darwin Core terms).
multimedia.csv   One row per photo, linked to occurrence.csv by occurrenceID.
photos/          The photos, named <tag ID>_<n>.jpg.

Identifiers
  occurrenceID   Permanent SpeciMap record ID (urn:uuid:...).
  fieldNumber    The QR tag ID on the specimen (e.g. 7Q4M-K2XR-C).
  catalogNumber  Blank: assigned by the museum. Please return a list of
                 fieldNumber -> catalogNumber so SpeciMap can record it.

Notes
  basisOfRecord is ${prefs.basisOfRecord}${prefs.basisOfRecord === 'HumanObservation' ? ' (photo voucher; preparations = photograph)' : ''}.
  Coordinates are WGS84 from the phone GPS; coordinateUncertaintyInMeters is
  the GPS accuracy reported by the phone.
  eventDate is local time with its UTC offset.
  country, stateProvince, county and locality are not recorded by SpeciMap
  and are left blank.
  scientificName is the collector's identification. taxonID links the
  matching iNaturalist taxon where one was confirmed; the higher
  classification (kingdom to genus) comes from iNaturalist.
  Photos are licensed ${prefs.license} (see multimedia.csv).
`
}

export async function buildPackage(
  records: LocalRecord[],
  prefs: ExportPrefs,
  { withPhotos = true, onProgress }: { withPhotos?: boolean; onProgress?: (done: number, total: number) => void } = {},
): Promise<PackageResult> {
  const warnings: string[] = []
  const items = await itemsFor(records, withPhotos, warnings)
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

  const files: AsyncZippable = {
    'occurrence.csv': strToU8(BOM + occurrence),
    'multimedia.csv': strToU8(BOM + multimedia),
  }
  const total = items.reduce((n, it) => n + it.photos.length, 0)
  let done = 0
  for (const { record, photos } of items) {
    const local = await db.photos.where('recordId').equals(record.id).sortBy('id')
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
