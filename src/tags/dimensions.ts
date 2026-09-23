/**
 * Physical dimensions for tags, 20mL scintillation vials and 2mL screw-cap
 * microcentrifuge tubes, in millimetres.
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

/**
 * 2.0mL screw-cap microcentrifuge tube (USA Scientific, skirted, clear
 * polypropylene). Typical industry dimensions — verify against real tubes.
 */
export const TUBE_2ML = {
  outerDiaMm: 10.8,
  /** Approximate inner diameter — verify. */
  innerDiaMm: 9,
  /** Usable interior depth above the conical bottom — verify. */
  innerDepthMm: 32,
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

/**
 * Narrow strip that drops inside a 2mL tube and is read through the clear
 * wall. Must be narrower than TUBE_2ML.innerDiaMm so it slides in.
 */
export const INSERT_2ML_TAG: TagFormatDims = {
  w: 8,
  h: 28,
}

/** Printed QR code. Version-3 (29 modules) at 15mm ≈ 0.51mm/module. */
export const QR = {
  sizeMm: 15,
  quietZoneModules: 4,
  /** QR error-correction level: Q = 25% damage tolerance. */
  errorCorrection: 'Q' as const,
}

/**
 * QR for the 2mL insert. The URL is uppercased so it encodes in QR
 * alphanumeric mode, and error correction drops to M (15%): together that
 * gives Version-2 (25 modules) at 6.5mm ≈ 0.26mm/module, leaving ~3 modules
 * of quiet zone across the 8mm strip.
 */
export const QR_2ML = {
  sizeMm: 6.5,
  errorCorrection: 'M' as const,
}

export type TagFormat = 'insert' | 'punch' | 'insert_2ml'
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
  insert_2ml: INSERT_2ML_TAG,
}

export const MM_TO_PT = 72 / 25.4
