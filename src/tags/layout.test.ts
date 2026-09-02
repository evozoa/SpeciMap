import { describe, expect, it } from 'vitest'
import {
  PAGE_MARGIN_MM,
  PAGE_SIZES,
  TAG_GUTTER_MM,
  type PageSize,
  type TagFormat,
} from './dimensions'
import { fitCount, layoutSheet, type TagSlot } from './layout'

function overlaps(a: TagSlot, b: TagSlot): boolean {
  if (a.page !== b.page) return false
  return (
    a.xMm < b.xMm + b.wMm &&
    b.xMm < a.xMm + a.wMm &&
    a.yMm < b.yMm + b.hMm &&
    b.yMm < a.yMm + a.hMm
  )
}

describe('fitCount', () => {
  it('matches manual math', () => {
    // 100mm span, 18mm cell, 3mm gutter: 18+82/21 -> 1+3 = 4
    expect(fitCount(100, 18, 3)).toBe(4)
    expect(fitCount(17, 18, 3)).toBe(0)
    expect(fitCount(18, 18, 3)).toBe(1)
  })
})

describe('layoutSheet', () => {
  const cases: Array<[TagFormat, PageSize]> = [
    ['insert', 'letter'],
    ['insert', 'a4'],
    ['punch', 'letter'],
    ['punch', 'a4'],
  ]

  it.each(cases)('%s on %s: no overlaps, margins respected', (format, pageSize) => {
    const layout = layoutSheet(60, format, pageSize)
    const page = PAGE_SIZES[pageSize]
    for (const slot of layout.slots) {
      expect(slot.xMm).toBeGreaterThanOrEqual(PAGE_MARGIN_MM - 1e-9)
      expect(slot.yMm).toBeGreaterThanOrEqual(PAGE_MARGIN_MM - 1e-9)
      expect(slot.xMm + slot.wMm).toBeLessThanOrEqual(page.wMm - PAGE_MARGIN_MM + 1e-9)
      expect(slot.yMm + slot.hMm).toBeLessThanOrEqual(page.hMm - PAGE_MARGIN_MM + 1e-9)
    }
    for (let i = 0; i < layout.slots.length; i++) {
      for (let j = i + 1; j < layout.slots.length; j++) {
        expect(overlaps(layout.slots[i], layout.slots[j])).toBe(false)
      }
    }
  })

  it('gives a healthy per-page density', () => {
    // Sanity bounds from the plan: ~52 insert tags and ~24 punch tags per Letter.
    expect(layoutSheet(1, 'insert', 'letter').perPage).toBeGreaterThanOrEqual(40)
    expect(layoutSheet(1, 'punch', 'letter').perPage).toBeGreaterThanOrEqual(20)
  })

  it('paginates row-major', () => {
    const layout = layoutSheet(100, 'punch', 'letter')
    expect(layout.pageCount).toBe(Math.ceil(100 / layout.perPage))
    expect(layout.slots).toHaveLength(100)
    expect(layout.slots[layout.perPage].page).toBe(1)
    // Second slot is one column to the right of the first
    expect(layout.slots[1].xMm - layout.slots[0].xMm).toBeCloseTo(
      layout.slots[0].wMm + TAG_GUTTER_MM,
      6,
    )
    expect(layout.slots[1].yMm).toBeCloseTo(layout.slots[0].yMm, 6)
  })
})
