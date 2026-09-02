/**
 * Physical dimensions for tags and 20mL scintillation vials, in millimetres.
 *
 * !!! VERIFY AGAINST REAL VIALS before printing production batches (M4 fit
 * test). 22-400 neck-finish thread OD and cap-skirt clearance vary slightly
 * by manufacturer. All layout math derives from these constants — adjust
 * here only.
 */

export interface TagFormatDims {
  /** Tag width, mm. */
  w: number
  /** Tag height, mm. */
  h: number
  /** Punch hole diameter, mm (undefined = no hole). */
  holeDiaMm?: number
  /** Hole center distance from the top edge, mm. */
  holeCenterFromTopMm?: number
}

/** 20mL scintillation vial, typical dimensions. */
export const VIAL = {
  heightMm: 61,
  outerDiaMm: 28,
  neckFinish: '22-400',
  /** Thread major ("T") diameter for a 22-400 finish — verify. */
  threadMajorDiaMm: 22.4,
  /** Approximate inner diameter — verify. */
  innerDiaMm: 24,
} as const

/** Flat strip that drops inside the vial. */
export const INSERT_TAG: TagFormatDims = {
  w: 44,
  h: 18,
}

/** Square tag whose hole slips over the neck threads, held under the cap. */
export const PUNCH_TAG: TagFormatDims = {
  w: 38,
  h: 38,
  holeDiaMm: 22.5,
  holeCenterFromTopMm: 11,
}

/** Printed QR code. Version-3 (29 modules) at 15mm ≈ 0.51mm/module. */
export const QR = {
  sizeMm: 15,
  quietZoneModules: 4,
  /** QR error-correction level: Q = 25% damage tolerance. */
  errorCorrection: 'Q' as const,
}

export type TagFormat = 'insert' | 'punch'
export type PageSize = 'letter' | 'a4'

export const PAGE_SIZES: Record<PageSize, { wMm: number; hMm: number }> = {
  letter: { wMm: 215.9, hMm: 279.4 },
  a4: { wMm: 210, hMm: 297 },
}

/** Unprintable margin kept clear on every sheet edge. */
export const PAGE_MARGIN_MM = 10
/** Gap between adjacent tags (cutting allowance). */
export const TAG_GUTTER_MM = 3

export const TAG_DIMS: Record<TagFormat, TagFormatDims> = {
  insert: INSERT_TAG,
  punch: PUNCH_TAG,
}

export const MM_TO_PT = 72 / 25.4
