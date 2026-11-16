import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { generateFieldSheetPdf } from './fieldsheet'

describe('generateFieldSheetPdf', () => {
  it('renders one page per field sheet', async () => {
    const bytes = await generateFieldSheetPdf({
      ids: ['7Q4MK2XRC', 'EAANEGW67'],
      pageSize: 'letter',
      label: 'Tibbee Creek survey',
      origin: 'https://specimap.org',
    })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(2)
    if (process.env.FIELDSHEET_OUT) {
      const fs = await import('node:fs')
      fs.writeFileSync(process.env.FIELDSHEET_OUT, bytes)
    }
  })
})
