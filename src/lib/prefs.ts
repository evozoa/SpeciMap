/**
 * Small per-device preferences stored in the Dexie `meta` table, so they
 * work offline and survive reloads.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/schema'

export interface CapturePrefs {
  /**
   * Keep camera originals instead of reducing photos to 2048 px. For photo
   * vouchers: larger files (3-8 MB each) and slower uploads.
   */
  fullRes: boolean
}

export type BasisOfRecord = 'HumanObservation' | 'PreservedSpecimen' | 'MaterialSample'
export type PhotoLicense = 'CC0-1.0' | 'CC-BY-4.0' | 'CC-BY-NC-4.0'

export interface ExportPrefs {
  institutionCode: string
  collectionCode: string
  basisOfRecord: BasisOfRecord
  license: PhotoLicense
  /** Collector name as it should appear in recordedBy / creator. */
  recordedBy: string
}

const DEFAULTS = {
  capturePrefs: { fullRes: false } as CapturePrefs,
  exportPrefs: {
    institutionCode: '',
    collectionCode: 'Fishes',
    basisOfRecord: 'HumanObservation',
    license: 'CC-BY-4.0',
    recordedBy: '',
  } as ExportPrefs,
}
type Key = keyof typeof DEFAULTS
type Value<K extends Key> = (typeof DEFAULTS)[K]

export async function getPrefs<K extends Key>(key: K): Promise<Value<K>> {
  const stored = (await db.meta.get(key))?.value as Partial<Value<K>> | undefined
  return { ...DEFAULTS[key], ...stored }
}

export async function setPrefs<K extends Key>(key: K, changes: Partial<Value<K>>): Promise<void> {
  await db.meta.put({ key, value: { ...(await getPrefs(key)), ...changes } })
}

export function usePrefs<K extends Key>(key: K): Value<K> {
  return useLiveQuery(() => getPrefs(key), [key], DEFAULTS[key])
}
