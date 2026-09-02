/**
 * Starts watchPosition as soon as the camera screen mounts (a cold GPS fix
 * can take 10-30s) and keeps the most accurate fix seen so far. The
 * draggable map pin is the human backstop for a bad or missing fix.
 */
import { useEffect, useState } from 'react'

export interface GeoFix {
  lat: number
  lng: number
  accuracyM: number
  timestamp: number
}

export interface GeoWatch {
  fix: GeoFix | null
  error: string | null
}

export function useGeoWatch(enabled: boolean): GeoWatch {
  const [fix, setFix] = useState<GeoFix | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled || !('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setError(null)
        const next: GeoFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          timestamp: pos.timestamp,
        }
        setFix((prev) =>
          prev && prev.accuracyM <= next.accuracyM ? prev : next,
        )
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return { fix, error }
}
