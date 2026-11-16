/**
 * Darwin Core mapping for museum submissions (photo vouchers or physical
 * specimens). Pure functions, so the column mapping is unit-tested.
 *
 * Output is two tables:
 *   - occurrence: one row per record (Darwin Core terms);
 *   - multimedia: one row per photo (GBIF Simple Multimedia terms), linked
 *     by occurrenceID, naming the image file in the package.
 *
 * The SpeciMap vial tag identifies the physical specimen: it is the
 * materialEntityID (and is repeated in otherCatalogNumbers). fieldNumber is
 * reserved for the collector's number for the dwc:Event, and catalogNumber
 * for the museum.
 */
import type { LocalRecord } from '../db/schema'
import { formatTagId } from '../lib/tagid'
import type { ExportPrefs, PhotoLicense } from '../lib/prefs'

export interface Classification {
  kingdom?: string
  phylum?: string
  class?: string
  order?: string
  family?: string
  genus?: string
}

export interface ExportPhoto {
  fileName: string
  width: number
  height: number
  fullRes: boolean
}

export interface ExportItem {
  record: LocalRecord
  photos: ExportPhoto[]
  classification?: Classification
}

export const OCCURRENCE_COLUMNS = [
  'occurrenceID',
  'basisOfRecord',
  'institutionCode',
  'collectionCode',
  'catalogNumber',
  'materialEntityID',
  'fieldNumber',
  'otherCatalogNumbers',
  'recordedBy',
  'eventDate',
  'year',
  'month',
  'day',
  'country',
  'stateProvince',
  'county',
  'locality',
  'decimalLatitude',
  'decimalLongitude',
  'geodeticDatum',
  'coordinateUncertaintyInMeters',
  'georeferenceProtocol',
  'georeferenceRemarks',
  'scientificName',
  'verbatimIdentification',
  'taxonRank',
  'taxonID',
  'taxonRemarks',
  'kingdom',
  'phylum',
  'class',
  'order',
  'family',
  'genus',
  'identifiedBy',
  'preparations',
  'associatedMedia',
  'associatedReferences',
  'occurrenceRemarks',
] as const

export const MULTIMEDIA_COLUMNS = [
  'occurrenceID',
  'type',
  'format',
  'identifier',
  'title',
  'description',
  'created',
  'creator',
  'license',
  'rightsHolder',
] as const

type Row<C extends readonly string[]> = Record<C[number], string>

export const LICENSE_URL: Record<PhotoLicense, string> = {
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-NC-4.0': 'https://creativecommons.org/licenses/by-nc/4.0/',
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0')

/**
 * ISO 8601 date-time with the UTC offset of `tzOffsetMin` (minutes, as from
 * Date#getTimezoneOffset). Field dates read naturally in local time; a bare
 * UTC time can put an evening collection on the next day.
 */
export function localIso(iso: string, tzOffsetMin: number): { iso: string; y: number; m: number; d: number } {
  const t = new Date(Date.parse(iso) - tzOffsetMin * 60_000)
  const y = t.getUTCFullYear()
  const m = t.getUTCMonth() + 1
  const d = t.getUTCDate()
  const sign = tzOffsetMin > 0 ? '-' : '+'
  const off = `${sign}${pad(Math.floor(Math.abs(tzOffsetMin) / 60))}:${pad(Math.abs(tzOffsetMin) % 60)}`
  const time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  return { iso: `${y}-${pad(m)}-${pad(d)}T${time}${off}`, y, m, d }
}

/** The device's UTC offset on the capture date (handles daylight time). */
export const offsetAt = (iso: string) => new Date(iso).getTimezoneOffset()

export function photoFileName(tagId: string, index: number): string {
  return `${tagId}_${index + 1}.jpg`
}

export function occurrenceRow(
  { record: r, photos, classification: c = {} }: ExportItem,
  prefs: ExportPrefs,
  tzOffsetMin = offsetAt(r.capturedAt),
): Row<typeof OCCURRENCE_COLUMNS> {
  const when = localIso(r.capturedAt, tzOffsetMin)
  const species = r.species?.trim() ?? ''
  const taxon = r.taxon ?? null
  const remarks: string[] = []
  if (taxon && taxon.name.toLowerCase() !== species.toLowerCase()) {
    remarks.push(`Matched to iNaturalist taxon ${taxon.name}`)
  }
  if (species && !taxon) remarks.push('Name not matched to iNaturalist')
  return {
    occurrenceID: `urn:uuid:${r.id}`,
    basisOfRecord: prefs.basisOfRecord,
    institutionCode: prefs.institutionCode.trim(),
    collectionCode: prefs.collectionCode.trim(),
    catalogNumber: '',
    materialEntityID: `SpeciMap:${r.tagId}`,
    fieldNumber: '',
    otherCatalogNumbers: `SpeciMap:${r.tagId}`,
    recordedBy: prefs.recordedBy.trim(),
    eventDate: when.iso,
    year: String(when.y),
    month: String(when.m),
    day: String(when.d),
    country: '',
    stateProvince: '',
    county: '',
    locality: '',
    decimalLatitude: r.lat.toFixed(6),
    decimalLongitude: r.lng.toFixed(6),
    geodeticDatum: 'WGS84',
    coordinateUncertaintyInMeters:
      r.gpsAccuracyM != null ? String(Math.max(1, Math.round(r.gpsAccuracyM))) : '',
    georeferenceProtocol: 'Phone GPS at time of capture (SpeciMap)',
    georeferenceRemarks: r.locationAdjusted ? 'Position adjusted by hand on a map' : '',
    scientificName: species,
    verbatimIdentification: species,
    taxonRank: taxon?.rank ?? '',
    taxonID: taxon ? `https://www.inaturalist.org/taxa/${taxon.id}` : '',
    taxonRemarks: remarks.join('; '),
    kingdom: c.kingdom ?? '',
    phylum: c.phylum ?? '',
    class: c.class ?? '',
    order: c.order ?? '',
    family: c.family ?? '',
    genus: c.genus ?? '',
    identifiedBy: species ? prefs.recordedBy.trim() : '',
    preparations: prefs.basisOfRecord === 'HumanObservation' ? 'photograph' : '',
    associatedMedia: photos.map((p) => p.fileName).join(' | '),
    associatedReferences: r.inat?.observationId
      ? `https://www.inaturalist.org/observations/${r.inat.observationId}`
      : '',
    occurrenceRemarks: r.notes.trim(),
  }
}

export function multimediaRows(
  { record: r, photos }: ExportItem,
  prefs: ExportPrefs,
  tzOffsetMin = offsetAt(r.capturedAt),
): Row<typeof MULTIMEDIA_COLUMNS>[] {
  const created = localIso(r.capturedAt, tzOffsetMin).iso
  const who = prefs.recordedBy.trim()
  return photos.map((p, i) => ({
    occurrenceID: `urn:uuid:${r.id}`,
    type: 'StillImage',
    format: 'image/jpeg',
    identifier: p.fileName,
    title: `${formatTagId(r.tagId)} photo ${i + 1}`,
    description: `${p.width} x ${p.height} px; ${
      p.fullRes ? 'camera original' : 'reduced to 2048 px long edge'
    }`,
    created,
    creator: who,
    license: LICENSE_URL[prefs.license],
    rightsHolder: prefs.license === 'CC0-1.0' ? '' : who,
  }))
}

/** RFC 4180 CSV (CRLF line ends; quotes only where needed). */
export function toCsv<C extends readonly string[]>(columns: C, rows: Row<C>[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [columns.join(','), ...rows.map((row) => columns.map((c: C[number]) => cell(row[c] ?? '')).join(','))]
  return lines.join('\r\n') + '\r\n'
}

/** Higher classification from iNaturalist taxon ancestry. */
export function classificationFrom(ancestors: { rank: string; name: string }[]): Classification {
  const out: Classification = {}
  for (const a of ancestors) {
    if (['kingdom', 'phylum', 'class', 'order', 'family', 'genus'].includes(a.rank)) {
      out[a.rank as keyof Classification] = a.name
    }
  }
  return out
}
