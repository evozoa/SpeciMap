import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { supabase } from '../lib/supabase'

export default function SettingsPage() {
  const { session } = useAuth()
  const [persisted, setPersisted] = useState<boolean | null>(null)

  useEffect(() => {
    if (navigator.storage?.persisted) {
      void navigator.storage.persisted().then(setPersisted)
    }
  }, [])

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-xl font-bold">Settings</h1>
      </header>

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Offline storage</h2>
        <p className="mt-1 text-slate-400">
          {persisted === true &&
            'Persistent storage is granted — queued records are protected from eviction.'}
          {persisted === false &&
            'Persistent storage is NOT granted. On iOS, add SpeciMap to your Home Screen to protect queued field data from being evicted.'}
          {persisted === null && 'Persistence status unknown on this browser.'}
        </p>
        {persisted === false && (
          <button
            onClick={() => void navigator.storage.persist().then(setPersisted)}
            className="mt-3 rounded bg-slate-700 px-3 py-1.5 font-semibold"
          >
            Request persistence
          </button>
        )}
      </section>

      <section className="rounded-lg bg-slate-900 p-4 text-sm">
        <h2 className="font-semibold">Account</h2>
        {session ? (
          <>
            <p className="mt-1 text-slate-400">
              Signed in as {session.user.email}
            </p>
            <button
              onClick={() => void supabase.auth.signOut()}
              className="mt-3 rounded bg-slate-700 px-3 py-1.5 font-semibold"
            >
              Sign out
            </button>
            <p className="mt-2 text-xs text-amber-400">
              Don't sign out with unsynced records — they need your account to
              upload.
            </p>
          </>
        ) : (
          <Link to="/auth" className="mt-2 inline-block text-emerald-400 underline">
            Sign in
          </Link>
        )}
      </section>

      <p className="text-center text-xs text-slate-600">
        SpeciMap {__APP_VERSION__} — free & open source (MIT)
      </p>
    </div>
  )
}
