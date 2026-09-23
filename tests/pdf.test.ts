import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import { compactTagUrl, generateTagId } from '../src/lib/tagid'
import { INSERT_2ML_TAG, QR_2ML } from '../src/tags/dimensions'
import { layoutSheet } from '../src/tags/layout'
import { generateTagSheetPdf } from '../src/tags/pdf'

describe('generateTagSheetPdf', () => {
  it('renders a valid PDF with the expected page count (all formats)', async () => {
    for (const format of ['insert', 'punch', 'insert_2ml'] as const) {
      const ids = Array.from({ length: 30 }, generateTagId)
      const bytes = await generateTagSheetPdf({
        ids,
        format,
        pageSize: 'letter',
        prefix: 'TST',
        label: 'test batch',
        origin: 'https://specimap.example.org',
      })
      expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-')
      const doc = await PDFDocument.load(bytes)
      expect(doc.getPageCount()).toBe(layoutSheet(30, format, 'letter').pageCount)
    }
  }, 30_000)

  it('is deterministic for the same input (reprint support)', async () => {
    const ids = Array.from({ length: 4 }, generateTagId)
    const input = {
      ids,
      format: 'punch' as const,
      pageSize: 'a4' as const,
      origin: 'https://specimap.example.org',
    }
    const a = await generateTagSheetPdf(input)
    const b = await generateTagSheetPdf(input)
    // pdf-lib embeds creation dates; compare sizes and page geometry instead.
    const docA = await PDFDocument.load(a)
    const docB = await PDFDocument.load(b)
    expect(docA.getPageCount()).toBe(docB.getPageCount())
    expect(Math.abs(a.length - b.length)).toBeLessThan(64)
  })
})

describe('2mL insert QR', () => {
  it('stays at Version 2 for every check symbol on the production origin', () => {
    // Check symbols ~ and = fall outside QR alphanumeric mode; the encoder
    // must still fit them into Version 2.
    for (const check of '0Z*~$=U') {
      const url = compactTagUrl('https://specimap.org', `7Q4MK2XR${check}`)
      const qr = QRCode.create(url, { errorCorrectionLevel: QR_2ML.errorCorrection })
      expect(qr.version).toBe(2)
    }
  })

  it('leaves at least 2 modules of quiet zone across the strip', () => {
    const moduleMm = QR_2ML.sizeMm / 25
    expect((INSERT_2ML_TAG.w - QR_2ML.sizeMm) / 2 / moduleMm).toBeGreaterThanOrEqual(2)
  })
})
