/**
 * Renders print-ready tag sheets with pdf-lib. All layout comes from
 * layout.ts / dimensions.ts in millimetres; this file only converts mm to
 * PDF points (origin bottom-left) and draws.
 *
 * Layout is deterministic: the same tag list always produces an identical
 * PDF, so /tags/:batchId can regenerate sheets for reprinting.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import QRCode from 'qrcode'
import { formatTagId, tagUrl } from '../lib/tagid'
import {
  MM_TO_PT,
  PAGE_SIZES,
  PUNCH_TAG,
  QR,
  type PageSize,
  type TagFormat,
} from './dimensions'
import { layoutSheet } from './layout'

export interface TagSheetInput {
  ids: string[]
  format: TagFormat
  pageSize: PageSize
  /** Cosmetic batch prefix printed small (e.g. "PS26"); the ID is the key. */
  prefix?: string
  label?: string
  origin: string
}

const CUT_LINE = rgb(0.6, 0.6, 0.6)
const INK = rgb(0, 0, 0)
const RULER_MM = 50

function mm(v: number): number {
  return v * MM_TO_PT
}

async function qrPng(doc: PDFDocument, url: string) {
  // margin: 0 — the blank tag area around the code provides the quiet zone.
  const dataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: QR.errorCorrection,
    margin: 0,
    scale: 12,
  })
  return doc.embedPng(dataUrl)
}

function drawCalibrationFooter(page: PDFPage, font: PDFFont) {
  const y = mm(6) // 6mm above the bottom edge
  const x0 = mm(15)
  page.drawLine({
    start: { x: x0, y },
    end: { x: x0 + mm(RULER_MM), y },
    thickness: 0.75,
    color: INK,
  })
  for (let i = 0; i <= RULER_MM; i += 10) {
    page.drawLine({
      start: { x: x0 + mm(i), y },
      end: { x: x0 + mm(i), y: y + mm(2) },
      thickness: 0.5,
      color: INK,
    })
  }
  page.drawText(
    `This ruler must measure exactly ${RULER_MM} mm — print at 100% / "Actual Size", never "Fit to page".`,
    { x: x0 + mm(RULER_MM) + mm(4), y: y - 1, size: 6, font, color: INK },
  )
}

export async function generateTagSheetPdf(input: TagSheetInput): Promise<Uint8Array> {
  const { ids, format, pageSize, prefix, label, origin } = input
  const doc = await PDFDocument.create()
  const mono = await doc.embedFont(StandardFonts.CourierBold)
  const sans = await doc.embedFont(StandardFonts.Helvetica)
  const page = PAGE_SIZES[pageSize]
  const layout = layoutSheet(ids.length, format, pageSize)

  const pages: PDFPage[] = []
  for (let p = 0; p < layout.pageCount; p++) {
    const pdfPage = doc.addPage([mm(page.wMm), mm(page.hMm)])
    drawCalibrationFooter(pdfPage, sans)
    if (label) {
      pdfPage.drawText(`SpeciMap — ${label} — sheet ${p + 1}/${layout.pageCount}`, {
        x: mm(15),
        y: mm(page.hMm) - mm(6),
        size: 6,
        font: sans,
        color: INK,
      })
    }
    pages.push(pdfPage)
  }

  for (const slot of layout.slots) {
    const id = ids[slot.tagIndex]
    const pdfPage = pages[slot.page]
    // Convert top-left mm coords to bottom-left pt coords.
    const x = mm(slot.xMm)
    const yTop = mm(page.hMm - slot.yMm)
    const w = mm(slot.wMm)
    const h = mm(slot.hMm)
    const yBottom = yTop - h

    // Hairline cut border.
    pdfPage.drawRectangle({
      x,
      y: yBottom,
      width: w,
      height: h,
      borderColor: CUT_LINE,
      borderWidth: 0.4,
    })

    const qrImage = await qrPng(doc, tagUrl(origin, id))
    const qrSize = mm(QR.sizeMm)
    const seqText = prefix
      ? `${prefix}-${String(slot.tagIndex + 1).padStart(3, '0')}`
      : `#${slot.tagIndex + 1}`

    if (format === 'insert') {
      // QR on the left, ID + sequence stacked on the right.
      pdfPage.drawImage(qrImage, {
        x: x + mm(1.5),
        y: yBottom + (h - qrSize) / 2,
        width: qrSize,
        height: qrSize,
      })
      const textX = x + mm(1.5) + qrSize + mm(2.5)
      pdfPage.drawText(formatTagId(id), {
        x: textX,
        y: yBottom + h / 2 + mm(0.8),
        size: 8,
        font: mono,
        color: INK,
      })
      pdfPage.drawText(seqText, {
        x: textX,
        y: yBottom + h / 2 - mm(3.2),
        size: 6,
        font: sans,
        color: INK,
      })
    } else {
      // Punch tag: hole guide at top, QR centered below, ID at the bottom.
      const holeDia = mm(PUNCH_TAG.holeDiaMm!)
      const holeCy = yTop - mm(PUNCH_TAG.holeCenterFromTopMm!)
      pdfPage.drawCircle({
        x: x + w / 2,
        y: holeCy,
        size: holeDia / 2,
        borderColor: INK,
        borderWidth: 0.8,
      })
      // Crosshair to aid centering a craft punch.
      pdfPage.drawLine({
        start: { x: x + w / 2 - mm(2), y: holeCy },
        end: { x: x + w / 2 + mm(2), y: holeCy },
        thickness: 0.4,
        color: INK,
      })
      pdfPage.drawLine({
        start: { x: x + w / 2, y: holeCy - mm(2) },
        end: { x: x + w / 2, y: holeCy + mm(2) },
        thickness: 0.4,
        color: INK,
      })
      const qrY = yBottom + mm(7)
      pdfPage.drawImage(qrImage, {
        x: x + (w - qrSize) / 2,
        y: qrY,
        width: qrSize,
        height: qrSize,
      })
      const idText = formatTagId(id)
      const idWidth = mono.widthOfTextAtSize(idText, 7)
      pdfPage.drawText(idText, {
        x: x + (w - idWidth) / 2,
        y: yBottom + mm(3),
        size: 7,
        font: mono,
        color: INK,
      })
      const seqWidth = sans.widthOfTextAtSize(seqText, 5)
      pdfPage.drawText(seqText, {
        x: x + (w - seqWidth) / 2,
        y: yBottom + mm(0.8),
        size: 5,
        font: sans,
        color: INK,
      })
    }
  }

  return doc.save()
}
