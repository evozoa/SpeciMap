import { useLiveQuery } from 'dexie-react-hooks'
import { db, type InatGeoprivacy } from '../db/schema'
import {
  DEFAULT_PREFS,
  disconnectInat,
  inatConfigured,
  setInatPrefs,
  startInatConnect,
  type InatAccount,
  type InatPrefs,
} from './auth'

export const GEOPRIVACY_LABEL: Record<InatGeoprivacy, string> = {
  open: 'Open — exact location public',
  obscured: 'Obscured — public location blurred to ~20 km',
  private: 'Private — location hidden',
}

export function useInatAccount(): InatAccount | null | undefined {
  return useLiveQuery(
    async () => ((await db.meta.get('inatAccount'))?.value as InatAccount | undefined) ?? null,
    [],
  )
}

export function useInatPrefs(): InatPrefs {
  return useLiveQuery(
    async () => ({
      ...DEFAULT_PREFS,
      ...((await db.meta.get('inatPrefs'))?.value as Partial<InatPrefs> | undefined),
    }),
    [],
    DEFAULT_PREFS,
  )
}

export default function InatSettings() {
  const account = useInatAccount()
  const prefs = useInatPrefs()

  return (
    <section className="rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="font-semibold">iNaturalist (optional)</h2>
      <p className="mt-1 text-slate-400">
        Share records to iNaturalist as observations, with species, photos, time and
        location. SpeciMap stays the master copy; sharing is per record.
      </p>
      {!inatConfigured() ? (
        <p className="mt-2 text-amber-400">Not set up on this SpeciMap server yet.</p>
      ) : account ? (
        <>
          <p className="mt-3 text-slate-300">
            Connected{account.login ? ` as ${account.login}` : ''}.
          </p>
          <label className="mt-3 block text-slate-500" htmlFor="inat-geo">
            Location shown on iNaturalist
          </label>
          <select
            id="inat-geo"
            value={prefs.geoprivacy}
            onChange={(e) => void setInatPrefs({ geoprivacy: e.target.value as InatGeoprivacy })}
            className="mt-1 w-full rounded bg-slate-800 px-3 py-2"
          >
            {(Object.keys(GEOPRIVACY_LABEL) as InatGeoprivacy[]).map((g) => (
              <option key={g} value={g}>
                {GEOPRIVACY_LABEL[g]}
              </option>
            ))}
          </select>
          <button
            onClick={() => void disconnectInat()}
            className="mt-3 rounded bg-slate-700 px-3 py-1.5 font-semibold"
          >
            Disconnect
          </button>
        </>
      ) : (
        <button
          onClick={() => void startInatConnect()}
          disabled={!navigator.onLine}
          className="mt-3 rounded bg-emerald-600 px-3 py-1.5 font-semibold disabled:opacity-50"
        >
          Connect iNaturalist
        </button>
      )}
    </section>
  )
}
