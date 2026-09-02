import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { generateTagId } from '../src/lib/tagid'
import { layoutSheet } from '../src/tags/layout'
import { generateTagSheetPdf } from '../src/tags/pdf'

describe('generateTagSheetPdf', () => {
  it('renders a valid PDF with the expected page count (both formats)', async () => {
    for (const format of ['insert', 'punch'] as const) {
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
