import { Link } from 'react-router-dom'
import type { LocalRecord } from '../db/schema'
import { requestInatShare } from '../db/drafts'
import { INAT_WEB, inatConfigured } from './auth'
import { GEOPRIVACY_LABEL, useInatAccount, useInatPrefs } from './InatSettings'
import { syncAll } from '../sync/triggers'

/** Share status and action for one record on the record page. */
export default function InatRecordPanel({ record }: { record: LocalRecord }) {
  const account = useInatAccount()
  const prefs = useInatPrefs()
  if (!inatConfigured()) return null
  const share = record.inat

  const request = () => {
    void requestInatShare(record.id, prefs.geoprivacy).then(() => {
      if (navigator.onLine) void syncAll()
    })
  }

  return (
    <div className="rounded-lg bg-slate-900 p-4 text-sm">
      <h2 className="text-slate-500">iNaturalist</h2>
      {!share && account && (
        <>
          <button
            onClick={request}
            className="mt-2 rounded bg-emerald-600 px-3 py-1.5 font-semibold"
          >
            Share to iNaturalist
          </button>
          <p className="mt-2 text-xs text-slate-500">{GEOPRIVACY_LABEL[prefs.geoprivacy]}</p>
        </>
      )}
      {!share && account === null && (
        <p className="mt-1 text-slate-400">
          Not shared.{' '}
          <Link to="/settings" className="text-emerald-400 underline">
            Connect iNaturalist
          </Link>{' '}
          to share it.
        </p>
      )}
      {share && (share.status === 'queued' || share.status === 'sharing') && (
        <p className="mt-1 text-amber-300">
          {share.status === 'sharing' ? 'Sharing…' : 'Waiting to share (sends when online).'}
          {share.lastError && (
            <span className="block text-xs text-slate-500">Last try: {share.lastError}</span>
          )}
        </p>
      )}
      {share?.status === 'error' && (
        <div className="mt-1">
          <p className="text-red-300">Sharing failed: {share.lastError}</p>
          <button
            onClick={request}
            className="mt-2 rounded bg-red-700 px-3 py-1.5 font-semibold"
          >
            Try again
          </button>
        </div>
      )}
      {share?.status === 'shared' && share.observationId && (
        <a
          href={`${INAT_WEB}/observations/${share.observationId}`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-emerald-400 underline"
        >
          View observation {share.observationId} on iNaturalist ↗
        </a>
      )}
    </div>
  )
}
