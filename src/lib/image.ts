/**
 * Client-side photo re-encoding: JPEG, long edge capped, ~0.8 quality.
 * Keeps uploads reliable on field connections and respects the free-tier
 * storage budget (~300-600KB per photo instead of 3-8MB camera originals).
 *
 * Photo vouchers need the camera original instead (see `keepOriginal`):
 * those bytes are stored untouched, EXIF and all.
 */

export const MAX_LONG_EDGE = 2048
export const JPEG_QUALITY = 0.8

export interface EncodedPhoto {
  blob: Blob
  width: number
  height: number
}

export async function encodePhoto(
  source: CanvasImageSource & { width?: number; height?: number },
  srcWidth: number,
  srcHeight: number,
): Promise<EncodedPhoto> {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(srcWidth, srcHeight))
  const width = Math.round(srcWidth * scale)
  const height = Math.round(srcHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(source, 0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
  return { blob, width, height }
}

/** Re-encode a picked file (the no-getUserMedia fallback path). */
export async function encodePhotoFile(file: File): Promise<EncodedPhoto> {
  const bitmap = await createImageBitmap(file)
  try {
    return await encodePhoto(bitmap, bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

/** A camera original kept byte-for-byte (photo-voucher mode). */
export async function keepOriginal(blob: Blob): Promise<EncodedPhoto> {
  const bitmap = await createImageBitmap(blob)
  try {
    return { blob, width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

/** True for photos larger than the reduced size, i.e. kept as originals. */
export function isFullRes(p: { width: number; height: number }): boolean {
  return Math.max(p.width, p.height) > MAX_LONG_EDGE
}
