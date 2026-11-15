import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { finishInatConnect } from './auth'
import { syncAll } from '../sync/triggers'

/** Return page for the iNaturalist sign-in (redirect URI /inat/callback). */
export default function InatCallback() {
  const [state, setState] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    let done = false
    void finishInatConnect(new URLSearchParams(window.location.search))
      .then((account) => {
        if (done) return
        setState({
          ok: true,
          message: `Connected to iNaturalist${account.login ? ` as ${account.login}` : ''}.`,
        })
        void syncAll() // send anything that was waiting to be shared
      })
      .catch((e: unknown) => {
        if (!done) setState({ ok: false, message: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      done = true
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col items-center justify-center gap-4 p-6 text-center">
      {!state && <p className="text-slate-400">Connecting to iNaturalist…</p>}
      {state && (
        <>
          <p className={state.ok ? 'text-emerald-300' : 'text-red-300'}>{state.message}</p>
          <Link to="/settings" className="text-emerald-400 underline">
            Back to Settings
          </Link>
        </>
      )}
    </div>
  )
}
