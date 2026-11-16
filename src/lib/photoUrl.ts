import { useEffect, useState } from 'react'
import type { LocalPhoto } from '../db/schema'
import { PHOTO_BUCKET, supabase } from './supabase'

/**
 * Displayable URL for a photo: an object URL for local blobs, or a signed
 * URL for server-only photos pulled from another device.
 */
export function usePhotoUrl(photo: LocalPhoto | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    setUrl(null)
    if (!photo) return
    if (photo.blob) {
      const objectUrl = URL.createObjectURL(photo.blob)
      setUrl(objectUrl)
      return () => URL.revokeObjectURL(objectUrl)
    }
    if (!photo.storagePath) return
    let cancelled = false
    void supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(photo.storagePath, 3600)
      .then(({ data }) => {
        if (!cancelled && data) setUrl(data.signedUrl)
      })
    return () => {
      cancelled = true
    }
  }, [photo])
  return url
}

/** A photo's bytes: the local blob, or downloaded from storage. */
export async function loadPhotoBlob(photo: LocalPhoto): Promise<Blob> {
  if (photo.blob) return photo.blob
  if (!photo.storagePath) throw new Error('Photo is missing')
  const { data, error } = await supabase.storage.from(PHOTO_BUCKET).download(photo.storagePath)
  if (error || !data) throw new Error(error?.message ?? 'Photo download failed')
  return data
}
