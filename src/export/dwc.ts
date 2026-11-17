/**
 * Darwin Core mapping for museum submissions (photo vouchers or physical
 * specimens). Pure functions, so the column mapping is unit-tested.
 *
 * Output is two tables:
 *   - occurrence: one row per specimen (all captures of one vial tag), with
 *     its collecting event's terms (eventID, fieldNumber, locality…);
 *   - multimedia: one row per photo (GBIF Simple Multimedia terms), linked
 *     by occurrenceID, naming the image file in the package.
 *
 * The vial tag identifies the physical specimen (materialEntityID, repeated
 * in otherCatalogNumbers). fieldNumber is the collector's number for the
 * event; catalogNumber is left for the museum.
 */
import type { LocalEvent, LocalScan, LocalSubsample } from '../db/schema'
import type { ExportPrefs, PhotoLicense } from '../lib/prefs'
import { formatTagId } from '../lib/tagid'
import type { SpecimenView } from '../specimens/view'

export const SITE = 'https://specimap.org'

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
  specimen: SpecimenView
  photos: ExportPhoto[]
  classification?: Classification
  event?: LocalEvent
  /** File names of the event's field-sheet photos in the package. */
  fieldNotes?: string[]
}

export const OCCURRENCE_COLUMNS = [
  'occurrenceID',
  'basisOfRecord',
  'institutionCode',
  'collectionCode',
  'catalogNumber',
  'materialEntityID',
  'otherCatalogNumbers',
  'individualCount',
  'eventID',
  'parentEventID',
  'fieldNumber',
  'recordedBy',
  'eventDate',
  'year',
  'month',
  'day',
  'samplingProtocol',
  'samplingEffort',
  'habitat',
  'eventRemarks',
  'fieldNotes',
  'countryCode',
  'stateProvince',
  'county',
  'waterBody',
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
  'dateIdentified',
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

/** One row per subsample, linked to its specimen (dwc:MaterialSample). */
export const SUBSAMPLE_COLUMNS = [
  'materialSampleID',
  'relationshipOfResource',
  'materialEntityID',
  'occurrenceID',
  'materialSampleType',
  'preparations',
  'eventID',
  'eventDate',
  'recordedBy',
  'materialSampleRemarks',
] as const

/** One row per location check (a rescan after collection). */
export const LOCATION_CHECK_COLUMNS = [
  'materialEntityID',
  'checkedAt',
  'decimalLatitude',
  'decimalLongitude',
  'coordinateUncertaintyInMeters',
  'verbatimLocality',
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

/** The device's UTC offset on a date (handles daylight time). */
export const offsetAt = (iso: string) => new Date(iso).getTimezoneOffset()

export const occurrenceId = (tagId: string) => `${SITE}/specimen/${tagId}`
export const eventId = (id: string) => `${SITE}/event/${id}`

export function photoFileName(tagId: string, index: number): string {
  return `${tagId}_${index + 1}.jpg`
}

export function fieldNotesFileName(eventIdValue: string, index: number): string {
  return `fieldnotes/${eventIdValue}_${index + 1}.jpg`
}

/** dwc:eventDate: the event's interval, or the capture time without one. */
function eventDateOf(item: ExportItem, tz: (iso: string) => number) {
  const { specimen: v, event: e } = item
  const start = e?.eventDate ?? v.first.capturedAt
  const s = localIso(start, tz(start))
  if (e?.eventEnd) return { ...s, iso: `${s.iso}/${localIso(e.eventEnd, tz(e.eventEnd)).iso}` }
  return s
}

export function occurrenceRow(
  item: ExportItem,
  prefs: ExportPrefs,
  tz: (iso: string) => number = offsetAt,
): Row<typeof OCCURRENCE_COLUMNS> {
  const { specimen: v, photos, classification: c = {}, event: e } = item
  const when = eventDateOf(item, tz)
  const species = v.species
  const taxon = v.taxon
  const first = v.first
  const remarks: string[] = []
  if (taxon && taxon.name.toLowerCase() !== species.toLowerCase()) {
    remarks.push(`Matched to iNaturalist taxon ${taxon.name}`)
  }
  if (species && !taxon) remarks.push('Name not matched to iNaturalist')
  if (v.disagreement) remarks.push(`Identifications disagree: ${v.disagreement.join(' | ')}`)
  const shared = v.captures.find((r) => r.inat?.observationId)?.inat?.observationId
  const identifiedAt = v.identification?.identifiedAt ?? v.identification?.capturedAt
  return {
    occurrenceID: occurrenceId(v.tagId),
    basisOfRecord: prefs.basisOfRecord,
    institutionCode: prefs.institutionCode.trim(),
    collectionCode: prefs.collectionCode.trim(),
    catalogNumber: '',
    materialEntityID: `SpeciMap:${v.tagId}`,
    otherCatalogNumbers: `SpeciMap:${v.tagId}`,
    individualCount: String(v.individualCount),
    eventID: e ? eventId(e.id) : '',
    parentEventID: e?.parentEventId ? eventId(e.parentEventId) : '',
    fieldNumber: e?.fieldNumber ?? '',
    recordedBy: e?.recordedBy || prefs.recordedBy.trim(),
    eventDate: when.iso,
    year: String(when.y),
    month: String(when.m),
    day: String(when.d),
    samplingProtocol: e?.samplingProtocol ?? '',
    samplingEffort: e?.samplingEffort ?? '',
    habitat: e?.habitat ?? '',
    eventRemarks: e?.eventRemarks ?? '',
    fieldNotes: (item.fieldNotes ?? []).join(' | '),
    countryCode: e?.countryCode ?? '',
    stateProvince: e?.stateProvince ?? '',
    county: e?.county ?? '',
    waterBody: e?.waterBody ?? '',
    locality: e?.locality ?? '',
    decimalLatitude: first.lat.toFixed(6),
    decimalLongitude: first.lng.toFixed(6),
    geodeticDatum: 'WGS84',
    coordinateUncertaintyInMeters:
      first.gpsAccuracyM != null ? String(Math.max(1, Math.round(first.gpsAccuracyM))) : '',
    georeferenceProtocol: 'Phone GPS at time of capture (SpeciMap)',
    georeferenceRemarks: first.locationAdjusted ? 'Position adjusted by hand on a map' : '',
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
    dateIdentified: species && identifiedAt ? localIso(identifiedAt, tz(identifiedAt)).iso : '',
    preparations: prefs.basisOfRecord === 'HumanObservation' ? 'photograph' : '',
    associatedMedia: photos.map((p) => p.fileName).join(' | '),
    associatedReferences: shared ? `https://www.inaturalist.org/observations/${shared}` : '',
    occurrenceRemarks: v.captures
      .map((r) => r.notes.trim())
      .filter((n, i, all) => n && all.indexOf(n) === i)
      .join(' | '),
  }
}

export function multimediaRows(
  item: ExportItem,
  prefs: ExportPrefs,
  tz: (iso: string) => number = offsetAt,
): Row<typeof MULTIMEDIA_COLUMNS>[] {
  const { specimen: v, photos } = item
  const created = localIso(v.first.capturedAt, tz(v.first.capturedAt)).iso
  const who = prefs.recordedBy.trim()
  return photos.map((p, i) => ({
    occurrenceID: occurrenceId(v.tagId),
    type: 'StillImage',
    format: 'image/jpeg',
    identifier: p.fileName,
    title: `${formatTagId(v.tagId)} photo ${i + 1}`,
    description: `${p.width} x ${p.height} px; ${
      p.fullRes ? 'camera original' : 'reduced to 2048 px long edge'
    }`,
    created,
    creator: who,
    license: LICENSE_URL[prefs.license],
    rightsHolder: prefs.license === 'CC0-1.0' ? '' : who,
  }))
}

export function subsampleExportRow(
  s: LocalSubsample,
  prefs: ExportPrefs,
  tz: (iso: string) => number = offsetAt,
): Row<typeof SUBSAMPLE_COLUMNS> {
  return {
    materialSampleID: `SpeciMap:${s.tagId}`,
    relationshipOfResource: 'subsample of',
    materialEntityID: `SpeciMap:${s.parentTagId}`,
    occurrenceID: occurrenceId(s.parentTagId),
    materialSampleType: s.sampleType,
    preparations: s.preservation,
    eventID: s.eventId ? eventId(s.eventId) : '',
    eventDate: localIso(s.collectedAt, tz(s.collectedAt)).iso,
    recordedBy: prefs.recordedBy.trim(),
    materialSampleRemarks: s.remarks,
  }
}

export function locationCheckRow(
  s: LocalScan,
  tz: (iso: string) => number = offsetAt,
): Row<typeof LOCATION_CHECK_COLUMNS> {
  return {
    materialEntityID: `SpeciMap:${s.tagId}`,
    checkedAt: localIso(s.scannedAt, tz(s.scannedAt)).iso,
    decimalLatitude: s.lat != null ? s.lat.toFixed(6) : '',
    decimalLongitude: s.lng != null ? s.lng.toFixed(6) : '',
    coordinateUncertaintyInMeters: s.gpsAccuracyM != null ? String(Math.max(1, Math.round(s.gpsAccuracyM))) : '',
    verbatimLocality: s.place,
  }
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
