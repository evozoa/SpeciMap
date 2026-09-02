import { useEffect, useMemo } from 'react'
import L from 'leaflet'
import { Circle, MapContainer, Marker, TileLayer, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// Vite bundling breaks Leaflet's default icon URL resolution.
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

const TILE_URL =
  (import.meta.env.VITE_TILE_URL as string | undefined) ??
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

export interface LatLng {
  lat: number
  lng: number
}

interface Props {
  value: LatLng
  accuracyM?: number | null
  onChange: (next: LatLng) => void
  /** Non-interactive display mode (record detail view). */
  readOnly?: boolean
  className?: string
}

function Recenter({ value }: { value: LatLng }) {
  const map = useMap()
  useEffect(() => {
    map.setView([value.lat, value.lng])
    // Only when the value identity changes from outside (e.g. better GPS fix).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.lat, value.lng])
  return null
}

/**
 * Draggable-pin location confirmation. Works offline too: with no cached
 * tiles the map is a gray canvas but the pin stays draggable and the
 * coordinates remain visible.
 */
export default function LocationPicker({
  value,
  accuracyM,
  onChange,
  readOnly,
  className,
}: Props) {
  const eventHandlers = useMemo(
    () => ({
      dragend(e: L.DragEndEvent) {
        const pos = (e.target as L.Marker).getLatLng()
        onChange({ lat: pos.lat, lng: pos.lng })
      },
    }),
    [onChange],
  )

  return (
    <div className={className}>
      <MapContainer
        center={[value.lat, value.lng]}
        zoom={17}
        className="h-full w-full"
        attributionControl={false}
      >
        <TileLayer url={TILE_URL} />
        {accuracyM != null && accuracyM > 0 && (
          <Circle
            center={[value.lat, value.lng]}
            radius={accuracyM}
            pathOptions={{ color: '#10b981', weight: 1, fillOpacity: 0.1 }}
          />
        )}
        <Marker
          position={[value.lat, value.lng]}
          draggable={!readOnly}
          eventHandlers={readOnly ? undefined : eventHandlers}
        />
        {readOnly && <Recenter value={value} />}
      </MapContainer>
    </div>
  )
}
