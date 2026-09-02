/**
 * Pure sheet-layout math for tag PDFs. All positions in millimetres with the
 * origin at the sheet's top-left corner; pdf rendering converts to points
 * (bottom-left origin) at draw time.
 */
import {
  PAGE_MARGIN_MM,
  PAGE_SIZES,
  TAG_DIMS,
  TAG_GUTTER_MM,
  type PageSize,
  type TagFormat,
} from './dimensions'

export interface TagSlot {
  /** Index of the tag in the batch that occupies this slot. */
  tagIndex: number
  page: number
  /** Top-left corner, mm from sheet top-left. */
  xMm: number
  yMm: number
  wMm: number
  hMm: number
}

export interface SheetLayout {
  pageSize: PageSize
  format: TagFormat
  cols: number
  rows: number
  perPage: number
  pageCount: number
  slots: TagSlot[]
}

/** How many cells of size `cell` + gutter fit into `span`. */
export function fitCount(spanMm: number, cellMm: number, gutterMm: number): number {
  if (cellMm > spanMm) return 0
  return 1 + Math.floor((spanMm - cellMm) / (cellMm + gutterMm))
}

/**
 * Lay out `count` tags of the given format onto pages, row-major, centered
 * within the printable area.
 */
export function layoutSheet(
  count: number,
  format: TagFormat,
  pageSize: PageSize,
): SheetLayout {
  const page = PAGE_SIZES[pageSize]
  const tag = TAG_DIMS[format]
  const printableW = page.wMm - 2 * PAGE_MARGIN_MM
  const printableH = page.hMm - 2 * PAGE_MARGIN_MM
  const cols = fitCount(printableW, tag.w, TAG_GUTTER_MM)
  const rows = fitCount(printableH, tag.h, TAG_GUTTER_MM)
  if (cols === 0 || rows === 0) {
    throw new Error(`tag ${format} does not fit on ${pageSize}`)
  }
  const perPage = cols * rows
  const gridW = cols * tag.w + (cols - 1) * TAG_GUTTER_MM
  const gridH = rows * tag.h + (rows - 1) * TAG_GUTTER_MM
  const originX = PAGE_MARGIN_MM + (printableW - gridW) / 2
  const originY = PAGE_MARGIN_MM + (printableH - gridH) / 2

  const slots: TagSlot[] = []
  for (let i = 0; i < count; i++) {
    const pageIdx = Math.floor(i / perPage)
    const slot = i % perPage
    const row = Math.floor(slot / cols)
    const col = slot % cols
    slots.push({
      tagIndex: i,
      page: pageIdx,
      xMm: originX + col * (tag.w + TAG_GUTTER_MM),
      yMm: originY + row * (tag.h + TAG_GUTTER_MM),
      wMm: tag.w,
      hMm: tag.h,
    })
  }
  return {
    pageSize,
    format,
    cols,
    rows,
    perPage,
    pageCount: Math.max(1, Math.ceil(count / perPage)),
    slots,
  }
}
