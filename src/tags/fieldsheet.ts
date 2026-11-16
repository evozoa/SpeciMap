/**
 * Pre-printed field sheets: one page per collecting event (dwc:Event). The
 * QR code opens /e/<tag ID>, which starts the event in SpeciMap; the printed
 * blanks are labelled with the Darwin Core terms they map to, so the paper
 * and the database line up.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import QRCode from 'qrcode'
import { eventUrl, formatTagId } from '../lib/tagid'
import { MM_TO_PT, PAGE_SIZES, type PageSize } from './dimensions'

export interface FieldSheetInput {
  ids: string[]
  pageSize: PageSize
  label?: string
  origin: string
}

const INK = rgb(0, 0, 0)
const GREY = rgb(0.45, 0.45, 0.45)
const LINE = rgb(0.6, 0.6, 0.6)
const mm = (v: number) => v * MM_TO_PT

interface Fonts {
  sans: PDFFont
  bold: PDFFont
  mono: PDFFont
}

/** A labelled write-in line: "Label (dwcTerm) ________". */
function blank(page: PDFPage, f: Fonts, hMm: number, x: number, yTop: number, w: number, label: string, term?: string) {
  const y = mm(hMm - yTop)
  page.drawText(label, { x: mm(x), y: y + mm(1.2), size: 8, font: f.bold, color: INK })
  if (term) {
    const lw = f.bold.widthOfTextAtSize(label, 8)
    page.drawText(term, { x: mm(x) + lw + 3, y: y + mm(1.2), size: 6, font: f.sans, color: GREY })
  }
  page.drawLine({ start: { x: mm(x), y: y - mm(5) }, end: { x: mm(x + w), y: y - mm(5) }, thickness: 0.5, color: LINE })
}

async function drawSheet(doc: PDFDocument, f: Fonts, id: string, input: FieldSheetInput, n: number) {
  const { wMm, hMm } = PAGE_SIZES[input.pageSize]
  const page = doc.addPage([mm(wMm), mm(hMm)])
  const left = 15
  const right = wMm - 15
  const width = right - left

  // Header: title, and the QR code with its printed eventID.
  page.drawText('SpeciMap field sheet', { x: mm(left), y: mm(hMm - 20), size: 16, font: f.bold, color: INK })
  page.drawText('Scan the QR code to start this event in SpeciMap, then scan vial tags.', {
    x: mm(left),
    y: mm(hMm - 26),
    size: 8,
    font: f.sans,
    color: GREY,
  })
  if (input.label) {
    page.drawText(input.label, { x: mm(left), y: mm(hMm - 31), size: 8, font: f.sans, color: GREY })
  }
  const qrMm = 32
  const png = await doc.embedPng(
    await QRCode.toDataURL(eventUrl(input.origin, id), { errorCorrectionLevel: 'Q', margin: 0, scale: 10 }),
  )
  page.drawImage(png, { x: mm(right - qrMm), y: mm(hMm - 12 - qrMm), width: mm(qrMm), height: mm(qrMm) })
  const idText = formatTagId(id)
  const idW = f.mono.widthOfTextAtSize(idText, 10)
  page.drawText(idText, { x: mm(right - qrMm / 2) - idW / 2, y: mm(hMm - 12 - qrMm - 5), size: 10, font: f.mono, color: INK })
  page.drawText('eventID', { x: mm(right - qrMm / 2) - f.sans.widthOfTextAtSize('eventID', 6) / 2, y: mm(hMm - 12 - qrMm - 9), size: 6, font: f.sans, color: GREY })

  // Event and location blanks, two columns.
  const half = (width - 6) / 2
  let y = 40
  const row = (a: [string, string?], b?: [string, string?], aw = half) => {
    blank(page, f, hMm, left, y, b ? aw : width - (y < 58 ? qrMm + 6 : 0), a[0], a[1])
    if (b) blank(page, f, hMm, left + aw + 6, y, width - aw - 6 - (y < 58 ? qrMm + 6 : 0), b[0], b[1])
    y += 11
  }
  row(['Field number', 'fieldNumber'], ['Date', 'eventDate'], 50)
  row(['Collectors', 'recordedBy'])
  row(['Start time'], ['End time'], half)
  row(['Locality', 'locality'])
  row(['Water body', 'waterBody'], ['County, State', 'county, stateProvince'])
  row(['Latitude', 'decimalLatitude'], ['Longitude', 'decimalLongitude'])
  row(['Method', 'samplingProtocol'], ['Effort', 'samplingEffort'])
  row(['Habitat', 'habitat'])
  row(['Water temp / conditions', 'eventRemarks'])
  blank(page, f, hMm, left, y, width, 'Notes', 'eventRemarks')
  y += 8
  page.drawLine({ start: { x: mm(left), y: mm(hMm - y) }, end: { x: mm(right), y: mm(hMm - y) }, thickness: 0.5, color: LINE })
  y += 8

  // Specimen log: one row per vial tag.
  const cols: [string, string, number][] = [
    ['Vial tag', 'materialEntityID', 34],
    ['Species', 'scientificName', 64],
    ['No.', 'individualCount', 14],
    ['Tissue tags', 'materialSampleID', 34],
    ['Notes', '', width - 34 - 64 - 14 - 34],
  ]
  page.drawText('Specimens', { x: mm(left), y: mm(hMm - y), size: 10, font: f.bold, color: INK })
  y += 5
  let x = left
  for (const [label, term, w] of cols) {
    page.drawText(label, { x: mm(x + 1), y: mm(hMm - y), size: 7, font: f.bold, color: INK })
    if (term) page.drawText(term, { x: mm(x + 1), y: mm(hMm - y - 3), size: 5, font: f.sans, color: GREY })
    x += w
  }
  y += 5
  const footer = 16
  const rowH = 7.5
  const rows = Math.floor((hMm - footer - y) / rowH)
  const tableTop = y
  for (let i = 0; i <= rows; i++) {
    const ly = mm(hMm - (tableTop + i * rowH))
    page.drawLine({ start: { x: mm(left), y: ly }, end: { x: mm(right), y: ly }, thickness: 0.4, color: LINE })
  }
  x = left
  for (const [, , w] of cols.slice(0, -1)) {
    x += w
    page.drawLine({
      start: { x: mm(x), y: mm(hMm - tableTop) },
      end: { x: mm(x), y: mm(hMm - (tableTop + rows * rowH)) },
      thickness: 0.4,
      color: LINE,
    })
  }

  page.drawText(`SpeciMap · specimap.org · sheet ${n}/${input.ids.length} · ${idText}`, {
    x: mm(left),
    y: mm(8),
    size: 6,
    font: f.sans,
    color: GREY,
  })
}

export async function generateFieldSheetPdf(input: FieldSheetInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const f: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.CourierBold),
  }
  for (const [i, id] of input.ids.entries()) await drawSheet(doc, f, id, input, i + 1)
  return doc.save()
}
